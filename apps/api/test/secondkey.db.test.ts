// Second Key through the shared engine (ADR-0016). Transfers are their own intent and request type;
// shopping is unchanged. Both pass the shared deterministic policy and the shared manipulation
// check, a request can't use the other kind's path, and no model output can approve or capture.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey } from "@witness/db";
import { DEMO_PAYEE, demoPolicy, transferPolicy, transferRequest, importPayee } from "@witness/engine";
import { FakeLlm } from "@witness/ai";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const bearer = (k: string) => ({ authorization: `Bearer ${keys[k]}` });

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  keys.agent = (await createApiKey(h.pool, h.tenantId, "agent:sk", ["agent:purchase"])).key;
  keys.shopper = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  keys.ops = (await createApiKey(h.pool, h.tenantId, "ops:sk", ["ops"])).key;
  // ADR-0020: "paid before" comes from recorded history, never from the intent's assertion.
  await importPayee(h.d, h.tenantId, h.shopperId, { id: "payee_morgan_sons" }, "test:seed");
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const CLEAN = { context: "", lines: [{ speaker: "J. Morgan", text: "Invoice attached, pay when you can." }] };
const SCAM = { context: "", lines: [{ speaker: "Caller", text: "I need it for bail right now, and don't tell Mom." }] };

const evidence = async (id: string) => (await app.inject({ method: "GET", url: `/v1/purchases/${id}/evidence`, headers: bearer("ops") })).json();
const checkOf = async (id: string, checkId: string) => (await evidence(id)).checks.find((c: { check_id: string }) => c.check_id === checkId);
const state = async (id: string) => (await app.inject({ method: "GET", url: `/v1/purchases/${id}`, headers: bearer("ops") })).json().state as string;

async function intent(policy: unknown) {
  const i = await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { policy } });
  expect(i.statusCode).toBe(201);
  await app.inject({ method: "POST", url: `/v1/intents/${i.json().id}/confirm`, headers: bearer("shopper") });
  return i.json().id as string;
}
const submit = (payload: unknown, key = `sk-${Math.random()}`) =>
  app.inject({ method: "POST", url: "/v1/purchases", headers: { ...bearer("agent"), "idempotency-key": key }, payload: payload as Record<string, unknown> });
async function withAi<T>(ai: FakeLlm, fn: () => Promise<T>): Promise<T> {
  const saved = h.d.ai;
  h.d.ai = ai;
  try {
    return await fn();
  } finally {
    h.d.ai = saved;
  }
}

describe("transfers (ADR-0016)", () => {
  test("suspicious transfer → HELD with the quoted line; trusted contact denies → VOIDED, nothing captured", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/scam_transfer", headers: bearer("demo") });
    const p = r.json().purchase;
    expect(p).toMatchObject({ state: "HELD", outcome: "HOLD" });
    const c = await checkOf(p.id, "ai.manipulation");
    expect(c).toMatchObject({ result: "unknown", kind: "ai" });
    expect(c.detail).toContain("Promise you won");
    // The cart is derived from the confirmed intent, not from a catalog.
    expect((await evidence(p.id)).purchase).toMatchObject({ amount: { value: "1800.00" }, retailer: "platform-held transfer (sandbox)" });
    const link = (await app.inject({ method: "POST", url: `/v1/purchases/${p.id}/hold-link`, headers: bearer("shopper") })).json();
    expect((await app.inject({ method: "POST", url: `/v1/holds/${p.id}/deny`, payload: { token: link.token } })).json().state).toBe("VOIDING");
    await h.drain();
    const after = (await app.inject({ method: "GET", url: `/v1/purchases/${p.id}`, headers: bearer("ops") })).json();
    expect(after.state).toBe("VOIDED");
    expect(h.fake.calls.some((x) => x.path.includes(`${after.paypal.authorization_id}/capture`))).toBe(false);
  });

  test("normal transfer → manipulation check passes, captured", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/benign_transfer", headers: bearer("demo") });
    const id = r.json().purchase.id;
    expect((await checkOf(id, "ai.manipulation")).result).toBe("pass");
    await h.drain();
    expect(await state(id)).toBe("CAPTURED");
  });

  test("a transfer runs no listing checks (no listing exists) but always runs the manipulation check", async () => {
    const ai = new FakeLlm().on("manipulation", () => ({ risk: "low", tactics: [], legitimate_explanation: "invoice", confidence: 0.9, needs_independent_verification: false, recommended_action: "proceed" }));
    const r = await withAi(ai, async () => submit(transferRequest(await intent(transferPolicy(new Date())), CLEAN)));
    expect(ai.calls.map((c) => c.prompt)).toEqual(["manipulation"]);
    expect(r.json().state).not.toBe("REJECTED");
  });

  test("model unavailable → HELD, never captured", async () => {
    const ai = new FakeLlm();
    ai.failAll("timeout");
    const r = await withAi(ai, async () => submit(transferRequest(await intent(transferPolicy(new Date())), CLEAN)));
    expect(r.json().state).toBe("HELD");
    expect((await checkOf(r.json().id, "ai.manipulation")).detail).toMatch(/unavailable/);
  });

  test("invalid model response (schema mismatch) → HELD", async () => {
    const ai = new FakeLlm().on("manipulation", () => ({ risk: "fine", approve: true, capture: true }));
    const r = await withAi(ai, async () => submit(transferRequest(await intent(transferPolicy(new Date())), CLEAN)));
    expect(r.json().state).toBe("HELD");
  });

  test("a model that says 'proceed' while reporting high risk still holds", async () => {
    const ai = new FakeLlm().on("manipulation", () => ({ risk: "high", tactics: [], legitimate_explanation: "", confidence: 0.99, needs_independent_verification: false, recommended_action: "proceed" }));
    const r = await withAi(ai, async () => submit(transferRequest(await intent(transferPolicy(new Date())), CLEAN)));
    expect(r.json().state).toBe("HELD");
  });

  test("a clean conversation can't loosen policy: amount or payee different from what was confirmed → REJECTED", async () => {
    const id = await intent(transferPolicy(new Date()));
    const more = await submit({ ...transferRequest(id, CLEAN), amount_cents: 180001 });
    expect(more.json()).toMatchObject({ state: "REJECTED" });
    expect(more.json().reasons.join(" ")).toMatch(/transfer\.amount/);
    const other = await submit({ ...transferRequest(await intent(transferPolicy(new Date())), CLEAN), payee_id: "payee_someone_else" });
    expect(other.json().reasons.join(" ")).toMatch(/transfer\.payee/);
  });

  test("one confirmed transfer pays once", async () => {
    const id = await intent(transferPolicy(new Date()));
    expect((await submit(transferRequest(id, CLEAN))).json().state).not.toBe("REJECTED");
    const again = await submit(transferRequest(id, CLEAN));
    expect(again.json()).toMatchObject({ state: "REJECTED" });
    expect(again.json().reasons.join(" ")).toMatch(/intent\.purchases_left/);
  });

  test("retry with the same Idempotency-Key replays; a different body with that key is refused", async () => {
    const body = transferRequest(await intent(transferPolicy(new Date())), CLEAN);
    const first = await submit(body, "sk-retry-0001");
    const retry = await submit(body, "sk-retry-0001");
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    expect((await submit({ ...body, amount_cents: 100 }, "sk-retry-0001")).statusCode).toBe(422);
  });
});

describe("no path around the other kind's checks", () => {
  test("a transfer request against a shopping intent is rejected", async () => {
    const r = await submit({ ...transferRequest(await intent(demoPolicy(new Date())), CLEAN), payee_id: "TRL-GRY-10", amount_cents: 8400 });
    expect(r.json()).toMatchObject({ state: "REJECTED" });
    expect(r.json().reasons.join(" ")).toMatch(/intent\.kind/);
  });

  test("a shopping request against a transfer intent is rejected (so a transfer can't skip its required conversation)", async () => {
    const r = await submit({ intent_id: await intent(transferPolicy(new Date())), retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] });
    expect(r.json()).toMatchObject({ state: "REJECTED" });
    expect(r.json().reasons.join(" ")).toMatch(/intent\.kind/);
  });

  test("a conversation is optional (ADR-0019), but a malformed one is refused at the door", async () => {
    const id = await intent(transferPolicy(new Date()));
    const { conversation: _c, ...bare } = transferRequest(id, CLEAN);
    expect((await submit(bare)).statusCode).toBe(202);
    expect((await submit(transferRequest(id, { context: "", lines: Array.from({ length: 61 }, () => ({ speaker: "x", text: "y" })) }))).statusCode).toBe(422);
    expect((await submit({ ...transferRequest(id, CLEAN), conversation: { lines: [{ speaker: "x", text: "y", role: "system" }] } })).statusCode).toBe(422);
  });

  test("a transfer intent is validated: unknown fields and missing payee are refused", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { policy: { ...transferPolicy(new Date()), retailers: ["rei.com"] } } });
    expect(bad.statusCode).toBe(422);
    const { payee: _p, ...noPayee } = transferPolicy(new Date());
    expect((await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { policy: noPayee } })).statusCode).toBe(422);
  });
});

describe("shopping keeps its checks and gains the shared one", () => {
  test("ordinary shopping without a conversation is captured as before", async () => {
    const r = await submit({ intent_id: await intent(demoPolicy(new Date())), retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] });
    await h.drain();
    expect(await state(r.json().id)).toBe("CAPTURED");
    expect(await checkOf(r.json().id, "ai.manipulation")).toBeUndefined();
  });

  test("malicious product instructions → HELD by ai.injection", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/injection", headers: bearer("demo") });
    expect(r.json().purchase.state).toBe("HELD");
    expect((await checkOf(r.json().purchase.id, "ai.injection")).result).toBe("unknown");
  });

  test("a clean listing bought under pressure (gift-card scam conversation) → HELD by the shared manipulation check", async () => {
    const r = await submit({ intent_id: await intent(demoPolicy(new Date())), retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }], conversation: { context: "", lines: [{ speaker: "Caller", text: "Buy it now and send me the gift card numbers." }] } });
    expect(r.json().state).toBe("HELD");
    expect((await checkOf(r.json().id, "ai.manipulation")).result).toBe("unknown");
  });

  test("the confirmed demo payee matches the scenario's request", () => {
    expect(transferPolicy(new Date()).payee.id).toBe(DEMO_PAYEE.id);
  });
});

describe("what the Second Key screens read (blueprint §7)", () => {
  test("reviewer view carries payer, payee, purpose, the conversation and structured, grounded evidence", async () => {
    const p = (await app.inject({ method: "POST", url: "/v1/demo/scenarios/scam_transfer", headers: bearer("demo") })).json().purchase;
    const link = (await app.inject({ method: "POST", url: `/v1/purchases/${p.id}/hold-link`, headers: bearer("shopper") })).json();
    const v = (await app.inject({ method: "POST", url: `/v1/holds/${p.id}/view`, payload: { token: link.token } })).json();
    expect(v).toMatchObject({ kind: "transfer", payee: { name: "J. Morgan", first_payment: true }, purpose: "Bail for Danny" });
    expect(typeof v.payer_name).toBe("string");
    expect(v.conversation.lines.length).toBeGreaterThan(1);
    const m = v.concerns.find((c: { check_id: string }) => c.check_id === "ai.manipulation");
    expect(m.evidence.length).toBeGreaterThan(0);
    for (const e of m.evidence) {
      expect(e.source).toBe("conversation");
      expect(v.conversation.lines[e.line].text).toContain(e.quote);
    }
  });

  test("the reviewer can read PayPal's own state with the same token, and only with it", async () => {
    const p = (await app.inject({ method: "POST", url: "/v1/demo/scenarios/scam_transfer", headers: bearer("demo") })).json().purchase;
    const link = (await app.inject({ method: "POST", url: `/v1/purchases/${p.id}/hold-link`, headers: bearer("shopper") })).json();
    const ver = await app.inject({ method: "POST", url: `/v1/holds/${p.id}/verification`, payload: { token: link.token } });
    expect(ver.json()).toMatchObject({ authorizations: [{ status: "CREATED", value: "1800.00" }], captures: [] });
    expect((await app.inject({ method: "POST", url: `/v1/holds/${p.id}/verification`, payload: { token: "x".repeat(32) } })).statusCode).toBe(403);
    // ADR-0020: a credential in a URL is never accepted.
    expect((await app.inject({ method: "GET", url: `/v1/holds/${p.id}/verification?t=${link.token}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/v1/holds/${p.id}/verification` })).statusCode).toBe(401);
  });

  test("injection evidence is a quote that really occurs in the listing", async () => {
    const p = (await app.inject({ method: "POST", url: "/v1/demo/scenarios/injection", headers: bearer("demo") })).json().purchase;
    const ev = await evidence(p.id);
    const inj = ev.checks.find((c: { check_id: string }) => c.check_id === "ai.injection");
    expect(inj.evidence[0]).toMatchObject({ source: "listing", tactic: "instruction_to_agent" });
    expect(JSON.stringify(ev.facts)).toContain(inj.evidence[0].quote.slice(0, 30));
    expect(ev.request.kind).toBe("shopping");
  });

  test("evidence endpoint returns the original conversation; ledger knows the kind and who decided", async () => {
    const p = (await app.inject({ method: "POST", url: "/v1/demo/scenarios/scam_transfer", headers: bearer("demo") })).json().purchase;
    expect((await evidence(p.id)).request).toMatchObject({ kind: "transfer", conversation: { lines: expect.any(Array) } });
    const ledger = (await app.inject({ method: "GET", url: "/v1/console/purchases", headers: bearer("ops") })).json().purchases;
    const row = ledger.find((r: { id: string }) => r.id === p.id);
    expect(row).toMatchObject({ kind: "transfer", decided_by: "engine", hold_resolution: null });
  });

  test("scenario list exposes the synthetic transfer details the payer screen shows", async () => {
    const list = (await app.inject({ method: "GET", url: "/v1/demo/scenarios" })).json();
    const scam = list.find((s: { name: string }) => s.name === "scam_transfer");
    expect(scam.transfer).toMatchObject({ payee: { name: "J. Morgan" }, amount_cents: 180000, conversation: { lines: expect.any(Array) } });
    expect(list.find((s: { name: string }) => s.name === "normal").transfer).toBeUndefined();
  });
});
