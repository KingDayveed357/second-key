// POST /v2/settlements end to end on the fake PayPal: a CONFORMS verification is bound to one
// PayPal order that must hold exactly the merchant-signed checkout; the worker's executor
// re-checks it and captures (or voids), and the receipts that come back verify with our JWKS.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey, QUEUES, verifyChain } from "@witness/db";
import { handleJob } from "@witness/executor";
import { closedMandateReference, loadReceiptSigner, verifyReceipt, validateSchema } from "@witness/ap2";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";
import { checkoutFor, NOW, openPaymentWith, payFor, world, type World } from "../../../packages/ap2/test/fixtures.ts";

let h: Harness;
let app: FastifyInstance;
let w: World;
let key: string;
const ISS = "https://verifier.test";
let seq = 0;

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = new Date(NOW * 1000);
  w = await world();
  app = buildApp({ deps: { ...h.d, receipts: await loadReceiptSigner(ISS) } });
  await app.ready();
  key = (await createApiKey(h.pool, h.tenantId, "merchant:a", ["ap2:verify"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const post = (url: string, payload: unknown, idem = `idem-key-${++seq}`) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}`, "idempotency-key": idem }, payload: payload as Record<string, unknown> });
const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
const jwks = async () => (await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json();
const trust = () => ({ issuers: { keys: [{ ...w.issuer.jwk, kid: "issuer-1" }] }, merchants: { keys: [{ ...w.merchant.jwk, kid: "merchant-1" }] } });

/** A fresh conforming checkout + payment for `price` cents, verified; returns the verification and chains. */
async function conforming(price = 19900) {
  const c = await checkoutFor(w, { price });
  const open = await openPaymentWith(w, c.open, [{ type: "payment.amount_range", currency: "USD", max: 100000 }]);
  const pay = await payFor(w, open, c);
  const v = (await post("/v2/verifications", { checkout: { mandate: c.chain, aud: "merchant", nonce: "n-checkout" }, payment: { mandate: pay, aud: "credential-provider", nonce: "n-payment" }, trust: trust() })).json();
  expect(v).toMatchObject({ decision: "CONFORMS", settleable: true });
  return { v, checkout: c.chain, payment: pay };
}

/** An authorized PayPal order (vaulted, AUTHORIZE), as the platform would create it. */
async function order(items: { sku: string; cents: number; quantity?: number }[]) {
  const total = items.reduce((a, i) => a + i.cents * (i.quantity ?? 1), 0);
  const money = (c: number) => ({ currency_code: "USD", value: (c / 100).toFixed(2) });
  const r = await h.d.paypal.createOrder(
    {
      intent: "AUTHORIZE",
      payment_source: { paypal: { vault_id: "vault_test" } },
      purchase_units: [{ reference_id: "ap2", amount: { ...money(total), breakdown: { item_total: money(total) } }, items: items.map((i) => ({ name: i.sku, sku: i.sku, quantity: String(i.quantity ?? 1), unit_amount: money(i.cents) })) }],
    },
    `order-${++seq}`,
  );
  return r.data.id as string;
}

const settle = (verificationId: string, orderId: string, idem?: string) => post("/v2/settlements", { verification_id: verificationId, psp: "paypal", order_id: orderId }, idem);

describe("POST /v2/settlements", () => {
  test("an order holding exactly the verified checkout is captured, with receipts bound to the mandates and to PayPal", async () => {
    const { v, checkout, payment } = await conforming();
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    const bound = await settle(v.verification_id, orderId);
    expect(bound.statusCode, JSON.stringify(bound.json())).toBe(202);
    expect(bound.json()).toMatchObject({ state: "MATCHED", diffs: [], receipts: null, amount: { currency: "USD", value_minor: 19900 } });

    await h.drain();
    const s = (await get(`/v2/settlements/${bound.json().settlement_id}`)).json();
    expect(s.state).toBe("CAPTURED");
    expect([...h.fake.captures.values()].map((c) => [c.id, c.value])).toContainEqual([s.capture_id, "199.00"]);

    const set = await jwks();
    const cr = await verifyReceipt(s.receipts.checkout, set, ISS);
    const pr = await verifyReceipt(s.receipts.payment, set, ISS);
    expect(cr).toMatchObject({ status: "Success", order_id: orderId, reference: closedMandateReference(checkout) });
    expect(pr).toMatchObject({ status: "Success", payment_id: s.settlement_id, psp_confirmation_id: s.capture_id, reference: closedMandateReference(payment) });
    expect(validateSchema("checkout_receipt", cr)).toEqual([]);
    expect(validateSchema("payment_receipt", pr)).toEqual([]);
  });

  test("the cart swap: an order with another product at the same price is never captured; its authorization is voided", async () => {
    const { v } = await conforming();
    const orderId = await order([{ sku: "TRL-WHT-10", cents: 19900 }]);
    const bound = (await settle(v.verification_id, orderId)).json();
    expect(bound.state).toBe("VOIDING");
    expect(bound.diffs).toEqual(expect.arrayContaining(["missing: approved SKU sku_gold_9 is not in PayPal's order", "unapproved: PayPal's order contains SKU TRL-WHT-10, which Witness never approved"]));
    const captures = h.fake.captures.size;
    await h.drain();
    const s = (await get(`/v2/settlements/${bound.settlement_id}`)).json();
    expect(s.state).toBe("VOIDED");
    expect(h.fake.captures.size).toBe(captures);
    expect(h.fake.auths.get(s.authorization_id)!.status).toBe("VOIDED");
    expect(await verifyReceipt(s.receipts.payment, await jwks())).toMatchObject({ status: "Error", error: "settlement_order_mismatch" });
  });

  test("the order changing after binding is caught by the executor's last-moment re-check", async () => {
    const { v } = await conforming();
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    const bound = (await settle(v.verification_id, orderId)).json();
    expect(bound.state).toBe("MATCHED");
    h.fake.mutateOrder(orderId, (pu) => {
      pu.items[0].sku = "TRL-WHT-10";
    });
    const captures = h.fake.captures.size;
    await h.drain();
    const s = (await get(`/v2/settlements/${bound.settlement_id}`)).json();
    expect(s).toMatchObject({ state: "VOIDED", capture_id: null });
    expect(s.diffs.join(" ")).toContain("TRL-WHT-10");
    expect(h.fake.captures.size).toBe(captures);
  });

  test("an amount, extra charge or payee that differs is refused before anything is captured", async () => {
    const { v } = await conforming();
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900, quantity: 2 }]);
    expect((await settle(v.verification_id, orderId)).json().diffs).toContain("amount: approved 19900 cents, PayPal has 39800");
    const other = await conforming();
    const wrongPayee = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    h.fake.mutateOrder(wrongPayee, (pu) => {
      pu.payee = { merchant_id: "SOMEONEELSE1" };
    });
    expect((await settle(other.v.verification_id, wrongPayee)).json().diffs).toContain("payee: expected 7L6D422CPFA9Q, PayPal has SOMEONEELSE1");
  });

  test("single use: one settlement per verification and per order; the same request replays", async () => {
    const { v } = await conforming();
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    const first = await settle(v.verification_id, orderId, "settle-once");
    const replay = await settle(v.verification_id, orderId, "settle-once");
    expect([first.statusCode, replay.statusCode]).toEqual([202, 200]);
    expect(replay.json().settlement_id).toBe(first.json().settlement_id);
    expect((await settle(v.verification_id, await order([{ sku: "sku_gold_9", cents: 19900 }]))).statusCode).toBe(409);
    const another = await conforming();
    expect((await settle(another.v.verification_id, orderId)).statusCode).toBe(409);
    await h.drain();
  });

  test("only a fresh CONFORMS verification with a payment mandate can settle", async () => {
    const checkoutOnly = (await post("/v2/verifications", { checkout: { mandate: (await checkoutFor(w)).chain, aud: "merchant", nonce: "n-checkout" }, trust: trust() })).json();
    expect(checkoutOnly).toMatchObject({ decision: "CONFORMS", settleable: false });
    expect((await settle(checkoutOnly.verification_id, await order([{ sku: "sku_gold_9", cents: 19900 }]))).json().title).toBe("Nothing to settle");

    const wrong = await checkoutFor(w, { sku: "sku_white_9" });
    const refused = (await post("/v2/verifications", { checkout: { mandate: wrong.chain, aud: "merchant", nonce: "n-checkout" }, trust: trust() })).json();
    expect((await settle(refused.verification_id, await order([{ sku: "sku_white_9", cents: 19900 }]))).statusCode).toBe(409);

    const { v } = await conforming();
    h.clock.now = new Date(NOW * 1000 + 16 * 60_000);
    try {
      expect((await settle(v.verification_id, await order([{ sku: "sku_gold_9", cents: 19900 }]))).json().title).toBe("Verification expired");
    } finally {
      h.clock.now = new Date(NOW * 1000);
    }
    expect((await settle(v.verification_id, "NO-SUCH-ORDER")).statusCode).toBe(422);
    expect((await settle("ver_doesnotexist0", await order([{ sku: "sku_gold_9", cents: 19900 }]))).statusCode).toBe(404);
  });

  test("a capture whose response is lost is reconciled from PayPal's own state, without a second capture", async () => {
    const { v } = await conforming();
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    const id = (await settle(v.verification_id, orderId)).json().settlement_id;
    h.fake.failNext(/\/capture$/, "network-after");
    await h.drain();
    expect((await get(`/v2/settlements/${id}`)).json().state).toBe("NEEDS_RECONCILE");
    const before = h.fake.captures.size;
    await handleJob(h.d, QUEUES.ap2Reconcile, { settlementId: id });
    expect((await get(`/v2/settlements/${id}`)).json().state).toBe("CAPTURED");
    expect(h.fake.captures.size).toBe(before);
  });

  test("a capture that never reached PayPal is retried with the same request id and captured once", async () => {
    const { v } = await conforming();
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    const id = (await settle(v.verification_id, orderId)).json().settlement_id;
    h.fake.failNext(/\/capture$/, "network-before");
    await h.drain();
    const before = h.fake.captures.size;
    await handleJob(h.d, QUEUES.ap2Reconcile, { settlementId: id });
    const s = (await get(`/v2/settlements/${id}`)).json();
    expect(s.state).toBe("CAPTURED");
    expect(h.fake.captures.size).toBe(before + 1);
    const ids = h.fake.calls.filter((c) => c.path.endsWith("/capture") && c.path.includes(s.authorization_id)).map((c) => c.requestId);
    expect(new Set(ids).size).toBe(1);
  });

  test("a capture job for an already-consumed settlement does nothing", async () => {
    const { v } = await conforming();
    const id = (await settle(v.verification_id, await order([{ sku: "sku_gold_9", cents: 19900 }]))).json().settlement_id;
    await h.drain();
    const captures = h.fake.captures.size;
    expect(await handleJob(h.d, QUEUES.ap2Capture, { settlementId: id })).toMatch(/not MATCHED/);
    expect(h.fake.captures.size).toBe(captures);
  });

  test("settlement events are in the audit chain, and the chain verifies", async () => {
    const { rows } = await h.pool.query("SELECT event_type FROM audit_log WHERE event_type LIKE 'ap2.settlement_%'");
    expect(rows.map((r: { event_type: string }) => r.event_type)).toEqual(expect.arrayContaining(["ap2.settlement_bound", "ap2.settlement_captured", "ap2.settlement_voided"]));
    const client = await h.pool.connect();
    try {
      expect((await verifyChain(client)).valid).toBe(true);
    } finally {
      client.release();
    }
  });

  test("a closed payment mandate presented again after settlement is refused by the ledger", async () => {
    const { v, checkout, payment } = await conforming();
    await settle(v.verification_id, await order([{ sku: "sku_gold_9", cents: 19900 }]));
    await h.drain();
    const again = (await post("/v2/verifications", { checkout: { mandate: checkout, aud: "merchant", nonce: "n-checkout" }, payment: { mandate: payment, aud: "credential-provider", nonce: "n-payment" }, trust: trust() })).json();
    expect(again.decision).toBe("NONCONFORMING");
    expect(again.findings.map((f: { code: string }) => f.code)).toContain("ledger.closed_mandate_reused");
  });
});

describe("settlement edge cases", () => {
  test("an order already used by a Second Key purchase can't be bound", async () => {
    const orderId = await order([{ sku: "sku_gold_9", cents: 19900 }]);
    await h.pool.query("INSERT INTO intents (id, tenant_id, shopper_id, lineage_id, version, status, policy, policy_digest, confirmed_at) VALUES ('int_settle_test', $1, $2, 'int_settle_test', 1, 'CONFIRMED', '{}', 'x', now())", [h.tenantId, h.shopperId]);
    await h.pool.query(
      `INSERT INTO purchases (id, tenant_id, intent_id, intent_version, policy_digest, agent_principal, idempotency_key, request_hash, request, state, paypal_order_id)
       VALUES ('pur_settle_test', $1, 'int_settle_test', 1, 'x', 'agent', 'k', 'h', '{}', 'HELD', $2)`,
      [h.tenantId, orderId],
    );
    const { v } = await conforming();
    expect((await settle(v.verification_id, orderId)).json()).toMatchObject({ status: 409, title: "Already bound" });
  });

  test("a capture PayPal completes for another amount is not counted as captured", async () => {
    const { v } = await conforming();
    const id = (await settle(v.verification_id, await order([{ sku: "sku_gold_9", cents: 19900 }]))).json().settlement_id;
    h.fake.nextCaptureValue = "198.00";
    await h.drain();
    const s = (await get(`/v2/settlements/${id}`)).json();
    expect(s.state).toBe("NEEDS_RECONCILE");
    expect(s.receipts).toBeNull();
  });
});
