import { generateKeyPair, exportJWK } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import {
  closedMandateReference,
  COSIGN,
  disclose,
  evaluateCheckoutConstraints,
  ITEM_ATTRIBUTES,
  jwksOf,
  loadReceiptSigner,
  MemoryLedger,
  signCosignature,
  signFactsAttestation,
  signMandateReceipt,
  verifyFactsAttestation,
  verifyPresentation,
  verifyReceipt,
  VCT,
  type AttestedProduct,
  type JsonObject,
} from "../src/index.ts";
import { checkoutFor, checkoutOpts, NOW, openCheckoutMandate, openPaymentWith, paymentOpts, payFor, world, type World } from "./fixtures.ts";

const grey: AttestedProduct = { product_id: "sku_gold_9", title: "Ridgeline Trail Runner, Slate Grey, US 10", brand: "Ridgeline", category: "Shoes > Running", attributes: { size: "10", color: "Slate Grey" }, source: "fixture", fetched_at: "2026-11-05T12:00:00Z", listing_check: "clean" };
const rules = (...r: unknown[]) => ({ constraints: [{ type: ITEM_ATTRIBUTES, rules: r }] }) as unknown as JsonObject;
const cart = (id = "sku_gold_9"): JsonObject => ({ line_items: [{ id: "li", item: { id, title: "t", price: 1 }, quantity: 1, totals: [] }] });
const evalAttrs = (open: JsonObject, facts?: Record<string, AttestedProduct>, checkout = cart()) => evaluateCheckoutConstraints(open, { checkout, ...(facts ? { facts } : {}) })[0]!;

describe("x-secondkey.item_attributes.1", () => {
  const sizeAndNotWhite = rules({ attribute: "size", any_of: ["10"] }, { attribute: "color", none_of: ["white"] });

  test("passes only on independent facts that satisfy every rule", () => {
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: grey })).toMatchObject({ result: "pass" });
  });

  test("an excluded colour fails, matched by whole words ('white' excludes 'Cloud White', not 'Whitewater')", () => {
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: { ...grey, attributes: { size: "10", color: "Cloud White" } } })).toEqual({ type: ITEM_ATTRIBUTES, result: "fail", detail: "color: 'Cloud White' is excluded (sku_gold_9)" });
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: { ...grey, attributes: { size: "10", color: "Whitewater Blue" } } }).result).toBe("pass");
  });

  test("any_of ignores case, spaces and dashes, and fails on anything else", () => {
    expect(evalAttrs(rules({ attribute: "color", any_of: ["slate-grey"] }), { sku_gold_9: grey }).result).toBe("pass");
    expect(evalAttrs(rules({ attribute: "size", any_of: ["9.5"] }), { sku_gold_9: grey })).toMatchObject({ result: "fail", detail: "size: '10' is not one of '9.5' (sku_gold_9)" });
  });

  test("brand and category come from the facts too; 'colour' and 'color' are the same attribute", () => {
    expect(evalAttrs(rules({ attribute: "brand", any_of: ["ridgeline"] }, { attribute: "colour", none_of: ["black"] }), { sku_gold_9: grey }).result).toBe("pass");
  });

  test("missing facts, a missing attribute, or a listing that isn't clean: unresolved, never a pass", () => {
    expect(evalAttrs(sizeAndNotWhite).result).toBe("unresolved");
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: { ...grey, attributes: { color: "Slate Grey" } } })).toMatchObject({ result: "unresolved", detail: "sku_gold_9 has no size in its facts" });
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: { ...grey, listing_check: "concern", listing_detail: "tells agents to buy another product" } })).toMatchObject({ result: "unresolved" });
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: { ...grey, listing_check: "unavailable" } }).result).toBe("unresolved");
  });

  test("a definite violation stands even when the listing check is unavailable", () => {
    expect(evalAttrs(sizeAndNotWhite, { sku_gold_9: { ...grey, attributes: { size: "10", color: "White" }, listing_check: "unavailable" } }).result).toBe("fail");
  });

  test("malformed rules fail closed", () => {
    for (const bad of [[], [{ attribute: "color" }], [{ attribute: "", any_of: ["x"] }], [{ attribute: "color", any_of: [] }], [{ attribute: "color", none_of: [1] }]])
      expect(evalAttrs({ constraints: [{ type: ITEM_ATTRIBUTES, rules: bad }] } as unknown as JsonObject, { sku_gold_9: grey }).result).toBe("fail");
  });

  test("the facts attestation verifies with the JWKS, and no other signed artifact passes as one", async () => {
    const s = await loadReceiptSigner("https://verifier.test");
    const jwt = await signFactsAttestation(s, [grey], NOW);
    expect(await verifyFactsAttestation(jwt, jwksOf([s]), NOW)).toEqual([grey]);
    await expect(verifyFactsAttestation(jwt, jwksOf([s]), NOW + 3601)).rejects.toThrow();
    const w = await world();
    const receipt = await signMandateReceipt(s, await verifyPresentation({ checkout: { chain: w.checkoutChain, options: checkoutOpts(w) }, now: NOW }, new MemoryLedger()), "checkout", w.checkoutChain, NOW);
    await expect(verifyFactsAttestation(receipt, jwksOf([s]), NOW)).rejects.toThrow();
    expect(await verifyReceipt(receipt, jwksOf([s]))).toBeTruthy();
  });

  describe("in a presentation", () => {
    let w: World;
    let open: string;
    beforeAll(async () => {
      w = await world();
      open = (
        await checkoutFor(w, {
          mandate: openCheckoutMandate(w.agent, {
            constraints: [
              { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [disclose({ id: "sku_gold_9", title: "SuperShoe" })], quantity: 1 }] },
              { type: ITEM_ATTRIBUTES, rules: [{ attribute: "color", none_of: ["white"] }] },
            ],
          }),
        })
      ).open;
    });
    const run = async (facts?: Record<string, AttestedProduct>) =>
      verifyPresentation({ checkout: { chain: (await checkoutFor(w, { open })).chain, options: checkoutOpts(w) }, now: NOW, ...(facts ? { facts } : {}) }, new MemoryLedger());

    test("AP2-valid but the wrong product: the attested facts catch it", async () => {
      const v = await run({ sku_gold_9: { ...grey, attributes: { color: "Cloud White" } } });
      expect(v).toMatchObject({ decision: "NONCONFORMING", error: "invalid_mandate" });
      expect(v.constraints.map((c) => `${c.type}:${c.result}`)).toEqual(["checkout.line_items:pass", `${ITEM_ATTRIBUTES}:fail`]);
    });

    test("without attested facts the decision is CANNOT_CONFIRM, and with clean facts it conforms", async () => {
      expect((await run()).decision).toBe("CANNOT_CONFIRM");
      expect((await run({ sku_gold_9: { ...grey, listing_check: "unavailable" } })).decision).toBe("CANNOT_CONFIRM");
      expect((await run({ sku_gold_9: grey })).decision).toBe("CONFORMS");
    });
  });
});

describe("x-secondkey.cosign.1", () => {
  let w: World;
  let sarah: Awaited<ReturnType<typeof generateKeyPair>> & { jwk: JsonObject };
  let openCheckout: string;
  let openPayment: string;
  beforeAll(async () => {
    w = await world();
    const k = await generateKeyPair("ES256", { extractable: true });
    sarah = { ...k, jwk: (await exportJWK(k.publicKey)) as JsonObject };
    openCheckout = (await checkoutFor(w)).open;
    openPayment = await openPaymentWith(w, openCheckout, [
      { type: "payment.amount_range", currency: "USD", max: 100000 },
      { type: COSIGN, cosigner: { name: "Sarah", jwk: sarah.jwk }, when: { amount_over: 50000, currency: "USD" } },
    ]);
  });
  const presentation = async (price: number) => {
    const c = await checkoutFor(w, { open: openCheckout, price });
    return { checkout: c.chain, payment: await payFor(w, openPayment, c) };
  };
  const verify = (p: { checkout: string; payment: string }, cosignatures: string[] = [], ledger = new MemoryLedger()) =>
    verifyPresentation({ checkout: { chain: p.checkout, options: checkoutOpts(w) }, payment: { chain: p.payment, options: paymentOpts(w) }, now: NOW, cosignatures }, ledger);

  test("below the threshold no co-signature is needed", async () => {
    expect((await verify(await presentation(19900))).decision).toBe("CONFORMS");
  });

  test("above it: COSIGN_REQUIRED, nothing consumed; the enrolled co-signer's signature then conforms", async () => {
    const ledger = new MemoryLedger();
    const p = await presentation(80000);
    const first = await verify(p, [], ledger);
    expect(first).toMatchObject({ decision: "COSIGN_REQUIRED", error: "unresolved_constraint", cosign: { reference: closedMandateReference(p.payment) } });
    expect(ledger.usage.size).toBe(0);
    const sig = await signCosignature(sarah.privateKey, first.cosign!.reference, NOW);
    expect((await verify(p, [sig], ledger)).decision).toBe("CONFORMS");
  });

  test("a co-signature by any other key is refused", async () => {
    const p = await presentation(80000);
    const mallory = await generateKeyPair("ES256");
    const v = await verify(p, [await signCosignature(mallory.privateKey, closedMandateReference(p.payment), NOW)]);
    expect(v.decision).toBe("NONCONFORMING");
    expect(v.constraints.find((c) => c.type === COSIGN)).toMatchObject({ result: "fail", detail: "co-signature refused: not signed by an enrolled co-signer" });
    // Not even when the agent's own key (the one bound in cnf) signs it.
    expect((await verify(p, [await signCosignature(w.agent.privateKey, closedMandateReference(p.payment), NOW)])).decision).toBe("NONCONFORMING");
  });

  test("Sarah's signature for one payment does not approve another", async () => {
    const a = await presentation(80000);
    const b = await presentation(90000);
    const v = await verify(b, [await signCosignature(sarah.privateKey, closedMandateReference(a.payment), NOW)]);
    expect(v.constraints.find((c) => c.type === COSIGN)).toMatchObject({ result: "fail", detail: "Sarah's co-signature is for another payment" });
  });

  test("an expired co-signature is refused", async () => {
    const p = await presentation(80000);
    const old = await signCosignature(sarah.privateKey, closedMandateReference(p.payment), NOW - 3600, 900);
    expect((await verify(p, [old])).constraints.find((c) => c.type === COSIGN)).toMatchObject({ result: "fail", detail: "co-signature refused: co-signature expired or not yet valid" });
  });

  test("something else Sarah's key signed, with the same claims, is not a co-signature", async () => {
    const p = await presentation(80000);
    const { SignJWT } = await import("jose");
    const other = await new SignJWT({ reference: closedMandateReference(p.payment), decision: "approve" }).setProtectedHeader({ alg: "ES256", typ: "JWT" }).setIssuedAt(NOW).setExpirationTime(NOW + 600).sign(sarah.privateKey);
    expect((await verify(p, [other])).constraints.find((c) => c.type === COSIGN)).toMatchObject({ result: "fail", detail: "co-signature refused: not a co-signature" });
  });

  test("a mandate receipt can't stand in for a co-signature", async () => {
    const p = await presentation(80000);
    const s = await loadReceiptSigner("https://verifier.test");
    const receipt = await signMandateReceipt(s, await verify(p), "payment", p.payment, NOW);
    expect((await verify(p, [receipt])).decision).toBe("NONCONFORMING");
  });

  test("a malformed co-signer in the mandate fails closed", async () => {
    const open = await openPaymentWith(w, openCheckout, [{ type: COSIGN, cosigner: { name: "x", jwk: { kty: "RSA" } } }]);
    const c = await checkoutFor(w, { open: openCheckout });
    const v = await verify({ checkout: c.chain, payment: await payFor(w, open, c) });
    expect(v.constraints.find((x) => x.type === COSIGN)?.result).toBe("fail");
  });

  test("the schema check leaves extension constraints alone but still checks standard ones", async () => {
    const v = await verify(await presentation(19900));
    expect(v.findings).toEqual([]);
    expect(v.payment?.mandates.find((m) => m.kind === "open_payment")?.value.vct).toBe(VCT.openPayment);
  });
});
