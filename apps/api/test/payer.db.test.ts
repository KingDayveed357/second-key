// Policy v2 (ADR-0019): the payer's own rule pauses a payment with no evidence at all; evidence is
// optional and can be shared after the pause, but nothing shared (and nothing the model says)
// unpauses a payment; the payer can flag a finding as wrong and can always cancel.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey } from "@witness/db";
import { importPayee } from "@witness/engine";
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
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  keys.shopper = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  keys.stranger = (await createApiKey(h.pool, h.tenantId, "shopper:shp_someone_else", ["shopper"])).key;
  keys.ops = (await createApiKey(h.pool, h.tenantId, "ops:p", ["ops"])).key;
  // ADR-0020: "paid before" comes from recorded history, never from the intent's assertion.
  await importPayee(h.d, h.tenantId, h.shopperId, { id: "payee_morgan_sons" }, "test:seed");
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const SCAM = { context: "Phone call before paying.", lines: [{ speaker: "Caller", text: "I need it for bail right now." }, { speaker: "Caller", text: "And don't tell Mom about this." }] };
const CLEAN = { context: "", lines: [{ speaker: "Mike", text: "Invoice attached, pay when you can." }] };

const run = async (name: string, evidence: boolean) => (await app.inject({ method: "POST", url: `/v1/demo/scenarios/${name}${evidence ? "" : "?evidence=none"}`, headers: bearer("demo") })).json().purchase;
const link = async (id: string) => (await app.inject({ method: "POST", url: `/v1/purchases/${id}/hold-link`, headers: bearer("shopper") })).json().token as string;
const view = async (id: string) => (await app.inject({ method: "GET", url: `/v1/holds/${id}`, headers: bearer("shopper") })).json();
const evidence = async (id: string) => (await app.inject({ method: "GET", url: `/v1/purchases/${id}/evidence`, headers: bearer("ops") })).json();
const share = (id: string, conversation: unknown, key = "shopper") => app.inject({ method: "POST", url: `/v1/me/purchases/${id}/context`, headers: bearer(key), payload: { conversation } });

describe("the payer's rule pauses without any evidence", () => {
  test("first payment of $1,800 to someone new, rule $500, nothing shared → HELD by the rule; no model call", async () => {
    const calls = (h.d.ai as FakeLlm).calls.length;
    const p = await run("scam_transfer", false);
    expect(p.state).toBe("HELD");
    expect((h.d.ai as FakeLlm).calls.length).toBe(calls);
    const ev = await evidence(p.id);
    expect(ev.checks.find((c: { check_id: string }) => c.check_id === "transfer.review_rule")).toMatchObject({ result: "unknown", kind: "deterministic" });
    expect(ev.checks.find((c: { check_id: string }) => c.check_id === "ai.manipulation")).toBeUndefined();
    expect(ev.request).toMatchObject({ conversation: null, conversation_source: null });
    const v = await view(p.id);
    expect(v.concerns.map((c: { check_id: string }) => c.check_id)).toEqual(["transfer.review_rule"]);
    expect(v.concerns[0].detail).toMatch(/second look for first payments of \$500\.00 or more/);
  });

  test("a payee paid before isn't caught by the rule: the clean invoice completes without evidence", async () => {
    const p = await run("benign_transfer", false);
    await h.drain();
    const ev = await evidence(p.id);
    expect(ev.purchase.state).toBe("CAPTURED");
    expect(ev.checks.find((c: { check_id: string }) => c.check_id === "transfer.review_rule")).toMatchObject({ result: "pass" });
  });

  test("evidence shared with the payment still runs (rule + AI): both are recorded", async () => {
    const p = await run("scam_transfer", true);
    expect(p.state).toBe("HELD");
    const ids = (await evidence(p.id)).checks.map((c: { check_id: string }) => c.check_id);
    expect(ids).toEqual(expect.arrayContaining(["transfer.review_rule", "ai.manipulation"]));
  });
});

describe("sharing context after the pause", () => {
  test("adds analysed evidence the reviewer sees, and never changes the payment's state", async () => {
    const p = await run("scam_transfer", false);
    const r = await share(p.id, SCAM);
    expect(r.statusCode).toBe(200);
    expect(r.json().check).toMatchObject({ id: "ai.manipulation", result: "unknown" });
    const v = await view(p.id);
    expect(v).toMatchObject({ state: "HELD", conversation_source: "shared_after_pause", context_check: { result: "unknown" } });
    expect(v.conversation.lines).toHaveLength(2);
    const ai = v.concerns.find((c: { check_id: string }) => c.check_id === "ai.manipulation");
    expect(ai.evidence[0].quote).toEqual(expect.any(String));
    expect((await evidence(p.id)).chain.events.map((e: { event_type: string }) => e.event_type)).toEqual(expect.arrayContaining(["context.shared", "context.analysed"]));
  });

  test("a clean conversation doesn't unpause: the payer's rule still asks for a second look", async () => {
    const p = await run("scam_transfer", false);
    expect((await share(p.id, CLEAN)).json().check.result).toBe("pass");
    expect((await view(p.id)).state).toBe("HELD");
  });

  test("once only; only while paused; only the payer; well-formed only", async () => {
    const p = await run("scam_transfer", false);
    expect((await share(p.id, { lines: [] })).statusCode).toBe(400);
    expect((await share(p.id, SCAM, "stranger")).statusCode).toBe(404);
    expect((await share(p.id, SCAM)).statusCode).toBe(200);
    expect((await share(p.id, SCAM)).statusCode).toBe(409);
    const withEvidence = await run("scam_transfer", true);
    expect((await share(withEvidence.id, SCAM)).statusCode).toBe(409); // already submitted with the payment
    const done = await run("benign_transfer", false);
    await h.drain();
    expect((await share(done.id, SCAM)).statusCode).toBe(409);
  });

  test("the model failing on shared context changes nothing (recorded as unavailable, still paused)", async () => {
    const p = await run("scam_transfer", false);
    const saved = h.d.ai;
    const down = new FakeLlm();
    down.failAll("timeout");
    h.d.ai = down;
    const r = await share(p.id, SCAM);
    h.d.ai = saved;
    expect(r.json().check).toMatchObject({ result: "unknown" });
    expect(r.json().check.detail).toMatch(/unavailable/);
    expect((await view(p.id)).state).toBe("HELD");
  });
});

describe("the payer's own controls", () => {
  test("'this finding is wrong' is recorded and shown to the reviewer; it doesn't change the decision", async () => {
    const p = await run("scam_transfer", true);
    const r = await app.inject({ method: "POST", url: `/v1/me/purchases/${p.id}/feedback`, headers: bearer("shopper"), payload: { quote: "I need it for bail", note: "Danny really is in trouble; I called his school." } });
    expect(r.statusCode).toBe(200);
    const token = await link(p.id);
    const v = (await app.inject({ method: "POST", url: `/v1/holds/${p.id}/view`, payload: { token } })).json();
    expect(v.state).toBe("HELD");
    expect(v.feedback).toEqual([expect.objectContaining({ quote: "I need it for bail", note: expect.stringContaining("called his school") })]);
    expect((await evidence(p.id)).feedback).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/v1/me/purchases/${p.id}/feedback`, headers: bearer("shopper"), payload: { quote: "", note: "x" } })).statusCode).toBe(400);
  });

  test("the payer can always cancel: VOIDED at PayPal, decided by the account holder (not a link)", async () => {
    const p = await run("scam_transfer", false);
    const r = await app.inject({ method: "POST", url: `/v1/me/holds/${p.id}/cancel`, headers: bearer("shopper") });
    expect(r.json().state).toBe("VOIDING");
    await h.drain();
    const ev = await evidence(p.id);
    expect(ev.purchase.state).toBe("VOIDED");
    expect(ev.decisions.at(-1)).toMatchObject({ outcome: "VOID", decided_by: `shopper:${h.shopperId}` });
    expect((await app.inject({ method: "POST", url: `/v1/me/holds/${p.id}/cancel`, headers: bearer("stranger") })).statusCode).toBe(404);
  });

  test("payer cancels while the reviewer approves: exactly one takes effect", async () => {
    const p = await run("scam_transfer", false);
    const token = await link(p.id);
    const [cancel, approve] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/me/holds/${p.id}/cancel`, headers: bearer("shopper") }),
      app.inject({ method: "POST", url: `/v1/holds/${p.id}/approve`, payload: { token } }),
    ]);
    expect([cancel.statusCode, approve.statusCode].sort()).toEqual([200, 409]);
    await h.drain();
    const s = (await evidence(p.id)).purchase.state;
    expect(s).toBe(cancel.statusCode === 200 ? "VOIDED" : "CAPTURED");
  });
});
