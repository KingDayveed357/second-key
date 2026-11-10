// Disputes (ADR-0010) against the fake PayPal: attach only to this tenant's captures, submit the
// reviewer-approved text exactly once (multipart "input" part), sandbox steps labelled simulated,
// and every step in the audit chain. PayPal's live behaviour still needs a buyer-opened dispute.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey, verifyChain } from "@witness/db";
import { demoPolicy } from "@witness/engine";
import { PolicyV1 } from "@witness/core";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";
import { seedTenant } from "../../../test-support/seed.ts";

let h: Harness;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const bearer = (k: string) => ({ authorization: `Bearer ${keys[k]}` });
let purchaseId = "";
let captureId = "";
const EVIDENCE =
  "The shopper confirmed: trail-running shoes, size 10, under 90 USD, not white. Second Key verified the cart against that instruction and against PayPal's stored order before capturing exactly the approved amount.";

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  keys.ops = (await createApiKey(h.pool, h.tenantId, "ops:o1", ["ops"])).key;
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  keys.agent = (await createApiKey(h.pool, h.tenantId, "agent:a1", ["agent:purchase"])).key;
  const other = await seedTenant(h.pool, PolicyV1.parse(demoPolicy(new Date())));
  keys.otherOps = (await createApiKey(h.pool, other.tenantId, "ops:o2", ["ops"])).key;
  const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/normal", headers: bearer("demo") });
  purchaseId = r.json().purchase.id;
  await h.drain();
  const p = (await app.inject({ method: "GET", url: `/v1/purchases/${purchaseId}`, headers: bearer("ops") })).json();
  expect(p.state).toBe("CAPTURED");
  captureId = p.paypal.capture_id;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const attach = (id: string, k = "ops") => app.inject({ method: "POST", url: "/v1/console/disputes", headers: bearer(k), payload: { dispute_id: id } });
const submit = (id: string, text: string) => app.inject({ method: "POST", url: `/v1/console/disputes/${id}/submit`, headers: bearer("ops"), payload: { text } });

describe("disputes", () => {
  test("attach links a buyer-opened dispute to the Second Key capture it is against", async () => {
    const id = h.fake.openDispute(captureId);
    const r = await attach(id);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id, purchase_id: purchaseId, capture_id: captureId, allowed_actions: ["provide_evidence"], evidence_submitted_at: null });
    expect((await attach(id)).statusCode).toBe(201); // idempotent
    const list = (await app.inject({ method: "GET", url: "/v1/console/disputes", headers: bearer("ops") })).json().disputes;
    expect(list.filter((x: any) => x.id === id)).toHaveLength(1);
  });

  test("a dispute against a capture Second Key didn't make for this tenant is refused", async () => {
    h.fake.captures.set("CAP-FOREIGN", { id: "CAP-FOREIGN", authId: "AUTH-X", status: "COMPLETED", currency: "USD", value: "10.00" } as any);
    expect((await attach(h.fake.openDispute("CAP-FOREIGN"))).statusCode).toBe(422);
    expect((await attach(h.fake.openDispute(captureId), "otherOps")).statusCode).toBe(422);
    expect((await attach("bad id!")).statusCode).toBe(400);
  });

  test("only ops can use dispute routes; tenants are isolated", async () => {
    const id = h.fake.openDispute(captureId);
    await attach(id);
    expect((await app.inject({ method: "GET", url: "/v1/console/disputes", headers: bearer("demo") })).statusCode).toBe(403);
    expect((await attach(id, "agent")).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/console/disputes/${id}/refresh`, headers: bearer("otherOps") })).statusCode).toBe(404);
  });

  test("evidence is submitted exactly as approved, once, as a multipart 'input' part", async () => {
    const id = h.fake.openDispute(captureId);
    await attach(id);
    expect((await submit(id, "too short")).statusCode).toBe(400);
    expect((await submit(id, `${EVIDENCE} Order {{order_id}}.`)).statusCode).toBe(400);
    const ok = await submit(id, EVIDENCE);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ evidence_text: EVIDENCE, evidence_submitted_by: "ops:o1", status: "UNDER_REVIEW", allowed_actions: ["adjudicate"] });
    expect(h.fake.disputes.get(id)!.evidence).toEqual({ evidences: [{ evidence_type: "OTHER", notes: EVIDENCE }] });
    expect(h.fake.lastMultipart).toMatch(/Content-Disposition: form-data; name="input"/);
    expect((await submit(id, EVIDENCE)).statusCode).toBe(409);
    expect(h.fake.calls.filter((c) => c.path.endsWith(`${id}/provide-evidence`))).toHaveLength(1);
  });

  test("sandbox: require-evidence first, then evidence, then a SIMULATED seller-favour verdict, all audited", async () => {
    const id = h.fake.openDispute(captureId, { stage: "inquiry" });
    await attach(id);
    expect((await submit(id, EVIDENCE)).statusCode).toBe(409); // PayPal isn't accepting evidence yet
    const s1 = await app.inject({ method: "POST", url: `/v1/console/disputes/${id}/sandbox-step`, headers: bearer("ops") });
    expect(s1.json().step).toBe("require-evidence");
    expect((await submit(id, EVIDENCE)).statusCode).toBe(200);
    const s2 = await app.inject({ method: "POST", url: `/v1/console/disputes/${id}/sandbox-step`, headers: bearer("ops") });
    expect(s2.json()).toMatchObject({ step: "adjudicate (simulated verdict)", dispute: { status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", simulated_verdict: true } });
    expect((await app.inject({ method: "POST", url: `/v1/console/disputes/${id}/sandbox-step`, headers: bearer("ops") })).statusCode).toBe(409);

    const client = await h.pool.connect();
    try {
      const chain = await verifyChain(client, { purchaseId });
      expect(chain.valid).toBe(true);
      expect(chain.events.map((e) => e.event_type)).toEqual(expect.arrayContaining(["dispute.attached", "dispute.evidence_submitted", "dispute.sandbox_step"]));
    } finally {
      client.release();
    }
  });

  test("dispute routes still can't capture, void or refund", () => {
    expect(app.printRoutes({ commonPrefix: false })).not.toMatch(/capture|void|refund|reauthorize/i);
  });
});
