// End-to-end money pipeline on real Postgres + pg-boss with a stateful fake PayPal.
// Covers the Stage 3 acceptance scenarios S1, S2, S5, S7, S8, S11 (evals.md) and the
// Early spike-validation failures that need the whole system (T6-T10).

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, verifyChain, dbOf, withTx } from "@witness/db";
import { confirmIntent, createIntent, demoPolicy, revokeIntent, runScenario, submitPurchase } from "@witness/engine";
import { consumeApproval, executeCapture, reconcile, holdTimeout } from "../src/index.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => h.close());

const state = async (id: string) => (await dbOf(h.pool).select().from(schema.purchases).where(eq(schema.purchases.id, id)).limit(1))[0]!;
const ORDERS = /^\/v2\/checkout\/orders$/;
const CAPTURES = /\/capture$/;

async function confirmedIntent(policy: Record<string, unknown> = {}) {
  const c = await createIntent(h.d, h.tenantId, h.shopperId, { policy: { ...demoPolicy(h.clock.now), ...policy } });
  if (c.kind !== "ok") throw new Error(c.detail);
  const k = await confirmIntent(h.d, h.tenantId, h.shopperId, c.intent.id);
  if (k.kind !== "ok") throw new Error(k.detail);
  return k.intent.id;
}

async function buy(intentId: string, product = "TRL-GRY-10", key = `key-${Math.random().toString(36).slice(2)}`, adapter?: string) {
  const r = await submitPurchase(h.d, h.agent, key, { intent_id: intentId, retailer: "rei.com", lines: [{ product_id: product, quantity: 1 }] }, adapter ? { adapter } : {});
  if (r.kind !== "ok") throw new Error(`${r.status} ${r.title}: ${r.detail}`);
  return r.purchase;
}

describe("S1 clean purchase", () => {
  test("screen -> authorize -> verify -> approval -> capture, with real PayPal state and a valid audit chain", async () => {
    const p = await buy(await confirmedIntent());
    expect(p.state).toBe("CAPTURE_APPROVED");
    expect(p.paypalAuthorizationId).toMatch(/^AUTH/);

    await h.drain();
    const done = await state(p.id);
    expect(done.state).toBe("CAPTURED");
    expect(done.paypalCaptureId).toMatch(/^CAP/);

    // PayPal's own state: one capture of exactly the approved amount, authorization final.
    const caps = [...h.fake.captures.values()];
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ value: "84.00", currency: "USD", status: "COMPLETED" });
    expect(h.fake.auths.get(done.paypalAuthorizationId!)!.status).toBe("CAPTURED");

    // Every money call journaled and succeeded; chain valid and contains the full story.
    const calls = await dbOf(h.pool).select().from(schema.paypalCalls).where(eq(schema.paypalCalls.purchaseId, p.id));
    expect(calls.map((c) => [c.op, c.status])).toEqual([
      ["create-order", "SUCCEEDED"],
      ["capture", "SUCCEEDED"],
    ]);
    const c = await h.pool.connect();
    try {
      const proof = await verifyChain(c, { purchaseId: p.id });
      expect(proof.valid).toBe(true);
      expect(proof.events.map((e) => e.event_type)).toEqual(["purchase.submitted", "purchase.screened", "purchase.authorized", "purchase.capture_approved", "capture.started", "purchase.captured"]);
    } finally {
      c.release();
    }
  });
});

describe("S2 violation", () => {
  test("REJECT happens before PayPal: no order, no hold, no journal row", async () => {
    const p = await buy(await confirmedIntent(), "TRL-WHT-10");
    expect(p.state).toBe("REJECTED");
    expect(p.reasons.join()).toMatch(/color/);
    expect(h.fake.count("POST", ORDERS)).toBe(0);
    expect(await dbOf(h.pool).select().from(schema.paypalCalls).where(eq(schema.paypalCalls.purchaseId, p.id))).toEqual([]);
  });
});

describe("S5 cart swap", () => {
  test("a faulty checkout adapter is caught on PayPal's stored order and voided: $0 captured", async () => {
    const p = await buy(await confirmedIntent(), "TRL-GRY-10", undefined, "faulty:swap");
    expect(p.state).toBe("VOIDING");
    expect(p.reasons).toEqual([
      "missing: approved SKU TRL-GRY-10 is not in PayPal's order",
      "unapproved: PayPal's order contains SKU TRL-WHT-10, which Second Key never approved",
    ]);
    await h.drain();
    expect((await state(p.id)).state).toBe("VOIDED");
    expect(h.fake.auths.get(p.paypalAuthorizationId!)!.status).toBe("VOIDED");
    expect(h.fake.count("POST", CAPTURES)).toBe(0);
  });

  test("the scenario runner gives the same result through the public path", async () => {
    const r = await runScenario(h.d, h.agent, h.shopperId, "cart_swap");
    expect(r?.result.kind === "ok" && r.result.purchase.state).toBe("VOIDING");
  });
});

describe("S7 idempotency", () => {
  test("replaying the same Idempotency-Key returns the same purchase and creates one order", async () => {
    const intent = await confirmedIntent();
    const a = await buy(intent, "TRL-GRY-10", "replay-key-0001");
    const b = await buy(intent, "TRL-GRY-10", "replay-key-0001");
    expect(b.id).toBe(a.id);
    expect(h.fake.count("POST", ORDERS)).toBe(1);
  });

  test("the same key with a different body is refused", async () => {
    const intent = await confirmedIntent();
    await buy(intent, "TRL-GRY-10", "replay-key-0002");
    const r = await submitPurchase(h.d, h.agent, "replay-key-0002", { intent_id: intent, retailer: "rei.com", lines: [{ product_id: "TRL-BLK-10", quantity: 1 }] });
    expect(r.kind === "error" && r.status).toBe(422);
  });
});

describe("S8 single-use approvals", () => {
  test("running the capture job twice captures once; a consumed approval cannot be consumed again", async () => {
    const p = await buy(await confirmedIntent());
    const approval = (await dbOf(h.pool).select().from(schema.approvals).where(eq(schema.approvals.purchaseId, p.id)))[0]!;
    const job = { tenantId: h.tenantId, purchaseId: p.id, approvalId: approval.id };
    await executeCapture(h.d, job);
    expect(await executeCapture(h.d, job)).toBe("purchase is CAPTURED");
    expect(await withTx(h.pool, (tx) => consumeApproval(tx, { approvalId: approval.id, tenantId: h.tenantId, purchaseId: p.id }))).toBeNull();
    expect(h.fake.count("POST", CAPTURES)).toBe(1);
  });

  test("T7: one intent with max_purchases=1 cannot buy twice", async () => {
    const intent = await confirmedIntent();
    await buy(intent);
    await h.drain();
    const second = await buy(intent);
    expect(second.state).toBe("REJECTED");
    expect(second.reasons.join()).toMatch(/purchases_left/);
  });

  test("an expired approval is never used: the executor voids instead", async () => {
    const h2 = await createHarness({ approvalTtlMs: -1 });
    try {
      const c = await createIntent(h2.d, h2.tenantId, h2.shopperId, { policy: demoPolicy(new Date()) });
      if (c.kind !== "ok") throw new Error(c.detail);
      await confirmIntent(h2.d, h2.tenantId, h2.shopperId, c.intent.id);
      const r = await submitPurchase(h2.d, h2.agent, "expired-key-1", { intent_id: c.intent.id, retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] });
      if (r.kind !== "ok") throw new Error(r.detail);
      await h2.drain();
      const final = (await dbOf(h2.pool).select().from(schema.purchases).where(eq(schema.purchases.id, r.purchase.id)))[0]!;
      expect(final.state).toBe("VOIDED");
      expect(h2.fake.count("POST", CAPTURES)).toBe(0);
    } finally {
      await h2.close();
    }
  });
});

describe("S11 failures and reconciliation", () => {
  test("PayPal captured but the response was lost: reconcile records it, with no second capture", async () => {
    const p = await buy(await confirmedIntent());
    h.fake.failNext(/POST .*\/capture$/, "network-after");
    await h.drain();
    expect((await state(p.id)).state).toBe("NEEDS_RECONCILE");
    expect(await reconcile(h.d, { tenantId: h.tenantId, purchaseId: p.id })).toBe("reconciled to CAPTURED");
    const final = await state(p.id);
    expect(final.state).toBe("CAPTURED");
    expect(h.fake.captures.size).toBe(1);
  });

  test("the capture request never reached PayPal: reconcile retries with the SAME request ID", async () => {
    const p = await buy(await confirmedIntent());
    h.fake.failNext(/POST .*\/capture$/, "network-before");
    await h.drain();
    expect((await state(p.id)).state).toBe("NEEDS_RECONCILE");
    await reconcile(h.d, { tenantId: h.tenantId, purchaseId: p.id });
    expect((await state(p.id)).state).toBe("CAPTURED");
    const ids = h.fake.calls.filter((c) => CAPTURES.test(c.path)).map((c) => c.requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(h.fake.captures.size).toBe(1);
  });

  test("create-order lost after PayPal created it: reconcile re-sends the same request and gets the same order", async () => {
    const intent = await confirmedIntent();
    h.fake.failNext(/POST \/v2\/checkout\/orders$/, "network-after");
    const p = await buy(intent);
    expect(p.state).toBe("AUTHORIZING");
    await reconcile(h.d, { tenantId: h.tenantId, purchaseId: p.id });
    const after = await state(p.id);
    expect(after.state).toBe("CAPTURE_APPROVED");
    expect(h.fake.orders.size).toBe(1);
  });

  test("a PENDING capture settles to CAPTURED on reconcile", async () => {
    const p = await buy(await confirmedIntent());
    h.fake.nextCaptureStatus = "PENDING";
    await h.drain();
    expect((await state(p.id)).state).toBe("CAPTURE_PENDING");
    [...h.fake.captures.values()][0]!.status = "COMPLETED";
    await reconcile(h.d, { tenantId: h.tenantId, purchaseId: p.id });
    expect((await state(p.id)).state).toBe("CAPTURED");
  });

  test("a COMPLETED capture for a different amount is never recorded as CAPTURED, and is never retried", async () => {
    const p = await buy(await confirmedIntent());
    h.fake.nextCaptureValue = "1.00";
    await h.drain();
    expect((await state(p.id)).state).toBe("NEEDS_RECONCILE");
    const result = await reconcile(h.d, { tenantId: h.tenantId, purchaseId: p.id });
    expect(result).toMatch(/operator review/);
    expect((await state(p.id)).state).toBe("NEEDS_RECONCILE");
    expect(h.fake.count("POST", CAPTURES)).toBe(1);
  });
});

describe("binding and staleness (validation T6, T9, X3)", () => {
  test("T6: PayPal's order changed after approval -> the pre-capture re-check voids", async () => {
    const p = await buy(await confirmedIntent());
    h.fake.mutateOrder(p.paypalOrderId!, (pu) => {
      pu.items[0].sku = "TRL-WHT-10";
    });
    const results = await h.drain();
    expect(results.join()).toMatch(/recheck failed; voiding/);
    expect((await state(p.id)).state).toBe("VOIDED");
    expect(h.fake.count("POST", CAPTURES)).toBe(0);
  });

  test("T6: a changed payee is caught too", async () => {
    const p = await buy(await confirmedIntent());
    h.fake.mutateOrder(p.paypalOrderId!, (pu) => {
      pu.payee.merchant_id = "SOMEONEELSE";
    });
    await h.drain();
    expect((await state(p.id)).state).toBe("VOIDED");
  });

  test("X3: intent revoked between approval and capture -> the approval is stale, executor voids", async () => {
    const intent = await confirmedIntent();
    const p = await buy(intent);
    await revokeIntent(h.d, h.tenantId, h.shopperId, intent);
    await h.drain();
    expect((await state(p.id)).state).toBe("VOIDED");
    expect(h.fake.count("POST", CAPTURES)).toBe(0);
  });

  test("T10: another tenant's agent cannot purchase against this tenant's intent", async () => {
    const intent = await confirmedIntent();
    const r = await submitPurchase(h.d, { tenantId: "ten_other", principal: "agent:intruder", scopes: ["agent:purchase"] }, "intruder-key-1", { intent_id: intent, retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] });
    expect(r.kind === "error" && r.status).toBe(404);
    expect(h.fake.count("POST", ORDERS)).toBe(0);
  });
});

describe("HOLD", () => {
  test("missing fact -> real authorization held -> auto-void at the deadline", async () => {
    const p = await buy(await confirmedIntent(), "TRL-NOSIZE");
    expect(p.state).toBe("HELD");
    expect(h.fake.auths.get(p.paypalAuthorizationId!)!.status).toBe("CREATED"); // funds genuinely held
    expect(await holdTimeout(h.d, { tenantId: h.tenantId, purchaseId: p.id })).toBe("not due yet");
    h.clock.now = new Date(h.clock.now.getTime() + 73 * 3600_000);
    expect(await holdTimeout(h.d, { tenantId: h.tenantId, purchaseId: p.id })).toBe("auto-voided");
    await h.drain();
    expect((await state(p.id)).state).toBe("VOIDED");
    expect(h.fake.auths.get(p.paypalAuthorizationId!)!.status).toBe("VOIDED");
  });

  test("revoking the intent voids a held purchase", async () => {
    const intent = await confirmedIntent();
    const p = await buy(intent, "TRL-NOSIZE");
    await revokeIntent(h.d, h.tenantId, h.shopperId, intent);
    await h.drain();
    expect((await state(p.id)).state).toBe("VOIDED");
    const hold = (await dbOf(h.pool).select().from(schema.holds).where(and(eq(schema.holds.purchaseId, p.id))))[0]!;
    expect(hold.resolution).toBe("REVOKED");
  });
});

describe("concurrency", () => {
  test("two simultaneous purchases on a single-use intent: exactly one proceeds", async () => {
    const intent = await confirmedIntent();
    const [a, b] = await Promise.all([buy(intent, "TRL-GRY-10", "concurrent-a1"), buy(intent, "TRL-BLK-10", "concurrent-b1")]);
    const states = [a.state, b.state].sort();
    expect(states).toEqual(["CAPTURE_APPROVED", "REJECTED"]);
    expect(h.fake.count("POST", ORDERS)).toBe(1);
  });
});
