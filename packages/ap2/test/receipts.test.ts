import { exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import {
  closedMandateReference,
  jwksOf,
  loadReceiptSigner,
  mandateReference,
  MemoryLedger,
  receiptBinds,
  signCheckoutReceipt,
  signMandateReceipt,
  signPaymentReceipt,
  verifyPresentation,
  verifyReceipt,
  type ReceiptSigner,
} from "../src/index.ts";
import { checkoutFor, checkoutOpts, NOW, paymentOpts, world, type World } from "./fixtures.ts";

const ISS = "https://verifier.secondkey.example";
let w: World;
let signer: ReceiptSigner;
beforeAll(async () => {
  w = await world();
  signer = await loadReceiptSigner(ISS);
});

const present = (checkout: string, payment?: string) =>
  verifyPresentation({ checkout: { chain: checkout, options: checkoutOpts(w) }, ...(payment ? { payment: { chain: payment, options: paymentOpts(w) } } : {}), now: NOW }, new MemoryLedger());

describe("mandate receipts", () => {
  test("a conforming presentation gets a success receipt that verifies with the JWKS and binds the chain", async () => {
    const v = await present(w.checkoutChain, w.paymentChain);
    const jwt = await signMandateReceipt(signer, v, "checkout", w.checkoutChain, NOW);
    const r = await verifyReceipt(jwt, jwksOf([signer]), ISS);
    expect(r).toMatchObject({ iss: ISS, iat: NOW, result: "success", reference: mandateReference(w.checkoutChain), "x-secondkey": { decision: "CONFORMS", checkout_hash: w.checkoutHash } });
    expect(receiptBinds(r, w.checkoutChain)).toBe(true);
    expect(receiptBinds(r, w.paymentChain)).toBe(false);
  });

  test("a refusal still gets a signed receipt, with the spec's error code and the failed constraint", async () => {
    const c = await checkoutFor(w, { sku: "sku_white_9" });
    const jwt = await signMandateReceipt(signer, await present(c.chain), "checkout", c.chain, NOW);
    const r = await verifyReceipt(jwt, jwksOf([signer]));
    expect(r).toMatchObject({ result: "error", error: "invalid_mandate", "x-secondkey": { decision: "NONCONFORMING" } });
    expect(String(r.error_description)).toContain("checkout.line_items: not allowed by the mandate: sku_white_9");
  });

  test("a receipt does not verify under another key, or after any change", async () => {
    const jwt = await signMandateReceipt(signer, await present(w.checkoutChain), "checkout", w.checkoutChain, NOW);
    const other = await loadReceiptSigner(ISS);
    await expect(verifyReceipt(jwt, jwksOf([other]))).rejects.toThrow();
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.reference = mandateReference(w.paymentChain);
    claims["x-secondkey"].decision = "CANNOT_CONFIRM";
    await expect(verifyReceipt(`${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`, jwksOf([signer]))).rejects.toThrow();
    await expect(verifyReceipt(jwt, jwksOf([signer]), "https://someone-else.example")).rejects.toThrow();
  });
});

describe("checkout and payment receipts (canonical schemas)", () => {
  test("success and error forms validate, sign and verify", async () => {
    const reference = closedMandateReference(w.checkoutChain);
    const ok = await verifyReceipt(await signCheckoutReceipt(signer, { status: "Success", reference, iat: NOW, order_id: "5O190127TN364715T" }), jwksOf([signer]));
    expect(ok).toMatchObject({ status: "Success", order_id: "5O190127TN364715T", reference });
    expect(receiptBinds(ok, w.checkoutChain)).toBe(true);
    const err = await signPaymentReceipt(signer, { status: "Error", reference: closedMandateReference(w.paymentChain), iat: NOW, payment_id: "pay_1", error: "invalid_mandate", error_description: "budget exceeded" });
    expect(await verifyReceipt(err, jwksOf([signer]))).toMatchObject({ status: "Error", payment_id: "pay_1" });
  });

  test("a receipt the schema forbids is never signed", async () => {
    const reference = closedMandateReference(w.paymentChain);
    // Success without the PSP and network confirmation ids the schema requires.
    await expect(signPaymentReceipt(signer, { status: "Success", reference, iat: NOW, payment_id: "pay_1" } as never)).rejects.toThrow(/payment receipt is invalid/);
    await expect(signCheckoutReceipt(signer, { status: "Success", reference, iat: NOW } as never)).rejects.toThrow(/checkout receipt is invalid/);
  });
});

describe("receipt keys", () => {
  test("a configured key keeps its kid; the JWKS holds only public parts", async () => {
    const priv = { ...(await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey)), kid: "receipts-2026-11" };
    const s = await loadReceiptSigner(ISS, JSON.stringify(priv));
    expect(s).toMatchObject({ kid: "receipts-2026-11", ephemeral: false });
    const jwks = jwksOf([s]);
    expect(jwks.keys[0]).toEqual({ kty: "EC", crv: "P-256", x: priv.x, y: priv.y, kid: "receipts-2026-11", alg: "ES256", use: "sig" });
    expect(JSON.stringify(jwks)).not.toContain(priv.d!);
  });

  test("without a configured key the signer says it is ephemeral", async () => {
    expect((await loadReceiptSigner(ISS)).ephemeral).toBe(true);
    expect((await loadReceiptSigner(ISS)).kid).toMatch(/^ephemeral-/);
  });

  test("a public or non-P-256 key is refused", async () => {
    const pub = await exportJWK((await generateKeyPair("ES256", { extractable: true })).publicKey);
    await expect(loadReceiptSigner(ISS, JSON.stringify(pub))).rejects.toThrow(/private EC P-256/);
    const rsa = await exportJWK((await generateKeyPair("RS256", { extractable: true })).privateKey);
    await expect(loadReceiptSigner(ISS, JSON.stringify(rsa))).rejects.toThrow(/private EC P-256/);
  });
});
