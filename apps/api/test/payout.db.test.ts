// Second Key recipient payout: the executor pays the confirmed recipient only after a verified
// capture of a transfer; never for a denied transfer, a shopping purchase or without a confirmed
// email; never twice; and an unknown outcome is retried with the same request ID.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { QUEUES, createApiKey } from "@witness/db";
import { handleJob } from "@witness/executor";
import { importPayee } from "@witness/engine";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

const RECIPIENT = "sb-recipient01@personal.example.com";
let h: Harness;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const bearer = (k: string) => ({ authorization: `Bearer ${keys[k]}` });

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  keys.shopper = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  keys.ops = (await createApiKey(h.pool, h.tenantId, "ops:po", ["ops"])).key;
  // ADR-0020: "paid before" comes from recorded history, never from the intent's assertion.
  for (const email of [undefined, RECIPIENT]) await importPayee(h.d, h.tenantId, h.shopperId, { id: "payee_morgan_sons", ...(email ? { email } : {}) }, "test:seed");
});
afterAll(async () => {
  await app.close();
  await h.close();
});
beforeEach(() => {
  h.d.demoRecipientEmail = RECIPIENT;
  h.fake.nextPayoutItemStatus = "SUCCESS";
});

const scenario = async (name: string) => (await app.inject({ method: "POST", url: `/v1/demo/scenarios/${name}`, headers: bearer("demo") })).json().purchase.id as string;
const link = async (id: string) => (await app.inject({ method: "POST", url: `/v1/purchases/${id}/hold-link`, headers: bearer("shopper") })).json().token as string;
const evidence = async (id: string) => (await app.inject({ method: "GET", url: `/v1/purchases/${id}/evidence`, headers: bearer("ops") })).json();
const check = (id: string) => handleJob(h.d, QUEUES.payoutCheck, { tenantId: h.tenantId, purchaseId: id });
const payout = (id: string) => handleJob(h.d, QUEUES.payout, { tenantId: h.tenantId, purchaseId: id });
const batchesFor = (value: string) => [...h.fake.payouts.values()].filter((p) => p.value === value && p.receiver === RECIPIENT);

async function approvedScam() {
  const id = await scenario("scam_transfer");
  const token = await link(id);
  await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, payload: { token } });
  await h.drain();
  return { id, token };
}

describe("recipient payout after a verified capture", () => {
  test("approved transfer: captured, then paid once to the confirmed recipient; PayPal's record shows SUCCESS", async () => {
    const before = h.fake.payouts.size;
    const { id, token } = await approvedScam();
    let ev = await evidence(id);
    expect(ev.purchase.state).toBe("CAPTURED");
    expect(ev.payout).toMatchObject({ status: "PENDING", amount: { value: "1800.00" }, receiver: "sb•••01@personal.example.com" });
    expect(h.fake.payouts.size).toBe(before + 1);
    const batch = [...h.fake.payouts.values()].at(-1)!;
    expect(batch).toMatchObject({ receiver: RECIPIENT, value: "1800.00", currency: "USD", senderBatchId: `sk-${id}` });

    expect(await check(id)).toBe("payout SUCCESS");
    ev = await evidence(id);
    expect(ev.payout.status).toBe("SUCCESS");
    expect(ev.purchase.state).toBe("CAPTURED"); // the purchase's own state is untouched
    expect(ev.chain.events.map((e: { event_type: string }) => e.event_type)).toEqual(expect.arrayContaining(["purchase.captured", "payout.requested", "payout.accepted", "payout.succeeded"]));
    expect(ev.paypal_calls.map((c: { op: string }) => c.op)).toContain("payout");

    // The reviewer sees it; the live read asks PayPal.
    const view = (await app.inject({ method: "POST", url: `/v1/holds/${id}/view`, payload: { token } })).json();
    expect(view).toMatchObject({ payout_configured: true, payout: { status: "SUCCESS" }, payee: { email: "sb•••01@personal.example.com" } });
    const live = (await app.inject({ method: "POST", url: `/v1/holds/${id}/verification`, payload: { token } })).json();
    expect(live.payout).toMatchObject({ item_status: "SUCCESS", batch_id: batch.id });
    expect((await app.inject({ method: "GET", url: `/v1/purchases/${id}/paypal`, headers: bearer("ops") })).json().payout.item_status).toBe("SUCCESS");
  });

  test("a clean transfer (no review needed) is paid out too", async () => {
    const id = await scenario("benign_transfer");
    await h.drain();
    expect((await evidence(id)).payout.status).toBe("PENDING");
  });

  test("never twice: re-running the payout job is a no-op", async () => {
    const { id } = await approvedScam();
    const n = h.fake.payouts.size;
    expect(await payout(id)).toMatch(/already/);
    expect(h.fake.payouts.size).toBe(n);
  });

  test("no payout for a denied transfer, a shopping purchase, or without a confirmed recipient email", async () => {
    const n = h.fake.payouts.size;
    const denied = await scenario("scam_transfer");
    await app.inject({ method: "POST", url: `/v1/holds/${denied}/deny`, payload: { token: await link(denied) } });
    await h.drain();
    expect((await evidence(denied)).purchase.state).toBe("VOIDED");
    expect((await evidence(denied)).payout).toBeNull();
    expect(await payout(denied)).toMatch(/only follow a verified capture/);

    const shop = await scenario("normal");
    await h.drain();
    expect((await evidence(shop)).purchase.state).toBe("CAPTURED");
    expect(await payout(shop)).toMatch(/no confirmed recipient/);

    h.d.demoRecipientEmail = undefined;
    const noEmail = await scenario("benign_transfer");
    await h.drain();
    const ev = await evidence(noEmail);
    expect(ev.purchase.state).toBe("CAPTURED");
    expect(ev.payout).toBeNull();
    expect(h.fake.payouts.size).toBe(n);
  });

  test("a timeout after PayPal accepted it: UNKNOWN, then the retry with the same request ID returns the same batch", async () => {
    h.fake.failNext(/^POST \/v1\/payments\/payouts$/, "network-after");
    const id = await scenario("benign_transfer");
    await h.drain();
    expect((await evidence(id)).payout.status).toBe("UNKNOWN");
    const n = h.fake.payouts.size;
    expect(await payout(id)).toMatch(/payout accepted/);
    expect(h.fake.payouts.size).toBe(n); // no second batch
    const calls = h.fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/payments/payouts").slice(-2);
    expect(calls[0]!.requestId).toBe(calls[1]!.requestId);
    expect((await evidence(id)).payout.status).toBe("PENDING");
  });

  test("a PayPal 5xx is treated as unknown (retried), not as a failure", async () => {
    h.fake.failNext(/^POST \/v1\/payments\/payouts$/, "http-500");
    const id = await scenario("benign_transfer");
    await h.drain();
    expect((await evidence(id)).payout.status).toBe("UNKNOWN");
    expect(await payout(id)).toMatch(/payout accepted/);
  });

  test("a payout PayPal fails is recorded as FAILED; the capture stays CAPTURED", async () => {
    h.fake.nextPayoutItemStatus = "FAILED";
    const id = await scenario("benign_transfer");
    await h.drain();
    expect(await check(id)).toBe("payout FAILED");
    const ev = await evidence(id);
    expect(ev).toMatchObject({ purchase: { state: "CAPTURED" }, payout: { status: "FAILED" } });
    expect(ev.chain.events.map((e: { event_type: string }) => e.event_type)).toContain("payout.failed");
  });

  test("scenario list says whether payouts are on and masks the recipient", async () => {
    const list = (await app.inject({ method: "GET", url: "/v1/demo/scenarios" })).json();
    expect(list.find((s: { name: string }) => s.name === "scam_transfer").transfer).toMatchObject({ payout_configured: true, payee: { email: "sb•••01@personal.example.com" } });
    expect(batchesFor("1800.00").length).toBeGreaterThan(0);
  });
});
