// The AP2 agent demo's five runs, end to end on the fake PayPal, with Rose's open mandates signed by
// the same browser code the page uses (apps/web/lib/ap2-surface.ts, run here on Node's WebCrypto).
// Each run must be stopped by the party the demo says stops it, and only the first and cart-swap
// runs may reach PayPal.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CryptoKey } from "jose";
import { createApiKey } from "@witness/db";
import { loadReceiptSigner, verifyReceipt } from "@witness/ap2";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";
import { roseMandates, thumbprint, type Ap2Setup } from "../../web/lib/ap2-surface.ts";

let h: Harness;
let app: FastifyInstance;
let key: string;
let rose: { privateKey: CryptoKey; publicJwk: { kty: string; crv: string; x: string; y: string }; kid: string };
let setup: Ap2Setup;

const newDeviceKey = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
  return { privateKey: pair.privateKey, publicJwk, kid: await thumbprint(publicJwk) };
};

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: { ...h.d, receipts: await loadReceiptSigner("https://verifier.test") } });
  await app.ready();
  key = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  rose = await newDeviceKey();
  setup = (await app.inject({ method: "GET", url: "/v1/demo/ap2/setup" })).json();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const auth = () => ({ authorization: `Bearer ${key}` });
const enrol = (jwk: unknown) => app.inject({ method: "POST", url: "/v1/me/demo/ap2/surface", headers: auth(), payload: { jwk } as Record<string, unknown> });
const run = async (name: string, signer = rose) => {
  const m = await roseMandates(setup, signer.privateKey, signer.kid);
  return app.inject({ method: "POST", url: `/v1/me/demo/ap2/runs/${name}`, headers: auth(), payload: { open_checkout: m.openCheckout, open_payment: m.openPayment } });
};
const failed = (v: { constraints: { type: string; result: string }[] }) => v.constraints.filter((c) => c.result === "fail").map((c) => c.type);

describe("AP2 agent demo", () => {
  test("setup publishes the agent's and merchant's public keys and the products, and nothing private", () => {
    expect(setup.agent.jwk).toMatchObject({ kty: "EC", crv: "P-256", kid: "demo-agent-1" });
    expect(JSON.stringify(setup)).not.toMatch(/"d":/);
    expect(setup.products.map((p) => p.id)).toEqual(["TRL-GRY-10", "TRL-WHT-10", "TRL-BLK-10", "TRL-PRO-10"]);
  });

  test("a run needs Rose's enrolled device; only a public P-256 key can be enrolled", async () => {
    expect((await run("conforms")).statusCode).toBe(409);
    expect((await enrol({ kty: "RSA", n: "x", e: "AQAB" })).statusCode).toBe(422);
    expect((await enrol({ ...rose.publicJwk, d: "secret" })).statusCode).toBe(422);
    const r = await enrol(rose.publicJwk);
    expect(r.statusCode).toBe(201);
    expect(r.json().thumbprint).toBe(rose.kid);
  });

  test("conforms: verified, bound to a PayPal order, captured; the receipts verify", async () => {
    const r = await run("conforms");
    expect(r.statusCode).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ caught_by: "none", verification: { decision: "CONFORMS" }, settlement: { state: "MATCHED" } });
    await h.drain();
    const s = (await app.inject({ method: "GET", url: `/v1/me/demo/ap2/settlements/${v.settlement.settlement_id}`, headers: auth() })).json();
    expect(s.state).toBe("CAPTURED");
    const jwks = (await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json();
    expect(await verifyReceipt(v.verification.receipts.checkout, jwks)).toMatchObject({ result: "success" });
    expect(await verifyReceipt(s.receipts.payment, jwks)).toMatchObject({ status: "Success", psp_confirmation_id: s.capture_id });
  });

  test("steered: AP2's own constraints refuse the $480 shoe, and PayPal is never called", async () => {
    const orders = h.fake.orders.size;
    const v = (await run("steered")).json();
    expect(v).toMatchObject({ caught_by: "ap2_constraints", verification: { decision: "NONCONFORMING" }, settlement: null });
    expect(failed(v.verification)).toEqual(expect.arrayContaining(["checkout.line_items", "payment.amount_range"]));
    expect(h.fake.orders.size).toBe(orders);
  });

  test("AP2-valid but the wrong product: AP2's constraints pass; Second Key's attested facts refuse it", async () => {
    const v = (await run("wrong_product")).json();
    expect(v.caught_by).toBe("secondkey_facts");
    expect(v.verification.constraints.find((c: { type: string }) => c.type === "checkout.line_items").result).toBe("pass");
    expect(failed(v.verification)).toEqual(["x-secondkey.item_attributes.1"]);
    expect(v.settlement).toBeNull();
  });

  test("cart swap: the mandates conform, PayPal's order holds another shoe, and the authorization is voided", async () => {
    const v = (await run("cart_swap")).json();
    expect(v).toMatchObject({ caught_by: "paypal_order", verification: { decision: "CONFORMS" }, settlement: { state: "VOIDING" } });
    await h.drain();
    const s = (await app.inject({ method: "GET", url: `/v1/me/demo/ap2/settlements/${v.settlement.settlement_id}`, headers: auth() })).json();
    expect(s).toMatchObject({ state: "VOIDED", capture_id: null });
  });

  test("reused: the second use of the same open mandate is refused by the ledger", async () => {
    const v = (await run("reused")).json();
    expect(v.first.decision).toBe("CONFORMS");
    expect(v).toMatchObject({ caught_by: "secondkey_ledger", verification: { decision: "NONCONFORMING" } });
    expect(v.verification.findings.map((f: { code: string }) => f.code)).toContain("ledger.open_mandate_reused");
  });

  test("mandates signed by any key but Rose's enrolled device are refused at the signature", async () => {
    const v = (await run("conforms", await newDeviceKey())).json();
    expect(v).toMatchObject({ caught_by: "signatures", verification: { decision: "NONCONFORMING", error: "invalid_credential" } });
  });

  test("a run name the demo doesn't define is 404; unsigned bodies are 422", async () => {
    expect((await run("anything")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/me/demo/ap2/runs/conforms", headers: auth(), payload: {} })).statusCode).toBe(422);
  });
});

describe("public test verification (/developers)", () => {
  const throwaway = async () => newDeviceKey();
  const test_ = async (product?: string, signer?: Awaited<ReturnType<typeof newDeviceKey>>, sendKey?: Awaited<ReturnType<typeof newDeviceKey>>) => {
    const k = signer ?? (await throwaway());
    const m = await roseMandates(setup, k.privateKey, k.kid);
    return app.inject({ method: "POST", url: "/v1/demo/ap2/test-verification", payload: { open_checkout: m.openCheckout, open_payment: m.openPayment, jwk: (sendKey ?? k).publicJwk, ...(product ? { product } : {}) } });
  };
  const count = async () => (await h.pool.query("SELECT (SELECT count(*) FROM ap2_verifications) + (SELECT count(*) FROM ap2_open_mandates) + (SELECT count(*) FROM ap2_settlements) AS n")).rows[0].n;

  test("needs no account or key, verifies for real, signs receipts that verify with the JWKS, and stores nothing", async () => {
    const before = await count();
    const orders = h.fake.orders.size;
    const r = await test_();
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v).toMatchObject({ test: true, decision: "CONFORMS", product: { id: "TRL-GRY-10" } });
    const jwks = (await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json();
    for (const jwt of [v.receipts.checkout, v.receipts.payment]) expect(await verifyReceipt(jwt, jwks)).toMatchObject({ result: "success" });
    expect(v.facts_attestation).toEqual(expect.any(String));
    expect(await count()).toBe(before);
    expect(h.fake.orders.size).toBe(orders);
  });

  test("the product choice shows the refusals: wrong colour, and an item the mandate doesn't list", async () => {
    expect(failed((await test_("TRL-WHT-10")).json())).toEqual(["x-secondkey.item_attributes.1"]);
    expect(failed((await test_("TRL-PRO-10")).json())).toEqual(expect.arrayContaining(["checkout.line_items", "payment.amount_range"]));
  });

  test("a key other than the one that signed is refused; bad input is 422", async () => {
    expect((await test_(undefined, await throwaway(), await throwaway())).json()).toMatchObject({ decision: "NONCONFORMING", error: "invalid_credential" });
    expect((await test_("TRL-NOPE")).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/v1/demo/ap2/test-verification", payload: { open_checkout: "x", open_payment: "y" } })).statusCode).toBe(422);
  });
});
