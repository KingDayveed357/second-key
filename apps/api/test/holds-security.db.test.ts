// Trusted-contact link security (ADR-0017). Two clocks: the hold lasts until auto-void (72 h);
// a reviewer link lasts 30 minutes and is re-issuable. A link is bound to one purchase, decides
// once, retries of the same decision are idempotent, and no decision moves money directly: approve
// re-checks PayPal and leaves capture to the executor; deny only voids.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey } from "@witness/db";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const bearer = (k: string) => ({ authorization: `Bearer ${keys[k]}` });
const MIN = 60_000;

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  keys.shopper = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  keys.agent = (await createApiKey(h.pool, h.tenantId, "agent:x", ["agent:purchase"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const held = async () => {
  const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/hold", headers: bearer("demo") });
  expect(r.json().purchase.state).toBe("HELD");
  return r.json().purchase.id as string;
};
const link = async (id: string) => (await app.inject({ method: "POST", url: `/v1/purchases/${id}/hold-link`, headers: bearer("shopper") })).json() as { token: string; expires_at: string };
const view = (id: string, t: string) => app.inject({ method: "POST", url: `/v1/holds/${id}/view`, payload: { token: t } });
const decide = (id: string, d: "approve" | "deny", body: unknown) => app.inject({ method: "POST", url: `/v1/holds/${id}/${d}`, payload: body as Record<string, unknown> });
const tick = (ms: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + ms);
};

describe("one authoritative link lifetime", () => {
  test("link lasts 30 minutes (not the 72 h hold); the view reports both clocks", async () => {
    const id = await held();
    const l = await link(id);
    const v = (await view(id, l.token)).json();
    expect(Date.parse(l.expires_at) - h.clock.now.getTime()).toBe(30 * MIN);
    expect(v.link_expires_at).toBe(l.expires_at);
    expect(Date.parse(v.auto_void_at) - Date.parse(l.expires_at)).toBeGreaterThan(70 * 60 * MIN);
  });

  test("an expired link is refused for viewing and deciding; the hold stays; a new link works", async () => {
    const id = await held();
    const l = await link(id);
    tick(30 * MIN);
    expect((await view(id, l.token)).statusCode).toBe(410);
    expect((await decide(id, "deny", { token: l.token })).statusCode).toBe(410);
    const fresh = await link(id);
    expect((await view(id, fresh.token)).json().state).toBe("HELD");
    expect((await decide(id, "deny", { token: fresh.token })).json().state).toBe("VOIDING");
  });

  test("a link never outlives the hold", async () => {
    const saved = h.d.holdMs;
    h.d.holdMs = 10 * MIN;
    const id = await held();
    h.d.holdMs = saved;
    const l = await link(id);
    expect(l.expires_at).toBe((await view(id, l.token)).json().auto_void_at);
  });
});

describe("reuse, retries and races", () => {
  test("same decision retried → the recorded result (replayed); the opposite decision → 409; the spent link shows the outcome", async () => {
    const id = await held();
    const { token } = await link(id);
    const first = await decide(id, "deny", { token });
    expect(first.json()).toMatchObject({ state: "VOIDING", resolution: "DENIED" });
    expect(first.json().replayed).toBeUndefined();
    const retry = await decide(id, "deny", { token });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ resolution: "DENIED", replayed: true });
    expect((await decide(id, "approve", { token })).statusCode).toBe(409);
    await h.drain();
    expect((await view(id, token)).json()).toMatchObject({ state: "VOIDED", resolution: "DENIED" });
    expect(h.fake.count("POST", new RegExp(`/authorizations/.+/void`))).toBeGreaterThan(0);
  });

  test("a re-issued link replaces the old one", async () => {
    const id = await held();
    const old = await link(id);
    await link(id);
    expect((await decide(id, "approve", { token: old.token })).statusCode).toBe(403);
  });

  test("concurrent approve and deny: exactly one decision; the loser gets 409, never a 200", async () => {
    const id = await held();
    const { token } = await link(id);
    const [a, d] = await Promise.all([decide(id, "approve", { token }), decide(id, "deny", { token })]);
    expect([a.statusCode, d.statusCode].sort()).toEqual([200, 409]);
    await h.drain();
    const final = (await view(id, token)).json().state;
    expect(final).toBe(a.statusCode === 200 ? "CAPTURED" : "VOIDED");
  });

  test("a double tap (two concurrent denies) voids once", async () => {
    const id = await held();
    const { token } = await link(id);
    const before = h.fake.count("POST", /\/void$/);
    const rs = await Promise.all([decide(id, "deny", { token }), decide(id, "deny", { token })]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(rs.filter((r) => r.json().replayed).length).toBe(1);
    await h.drain();
    expect(h.fake.count("POST", /\/void$/) - before).toBe(1);
  });
});

describe("binding and refusal", () => {
  test("a token for one purchase can't act on another", async () => {
    const a = await held();
    const b = await held();
    const la = await link(a);
    expect((await decide(b, "deny", { token: la.token })).statusCode).toBe(410); // b has no link yet
    await link(b);
    expect((await decide(b, "deny", { token: la.token })).statusCode).toBe(403);
    expect((await view(b, la.token)).statusCode).toBe(403);
    expect((await view(a, la.token)).json().state).toBe("HELD");
  });

  test("unauthorized and malformed requests are refused cleanly", async () => {
    const id = await held();
    await link(id);
    expect((await decide(id, "deny", {})).statusCode).toBe(401);
    expect((await decide(id, "deny", { token: "short" })).statusCode).toBe(401);
    expect((await decide(id, "deny", { token: "x".repeat(129) })).statusCode).toBe(401);
    expect((await decide(id, "deny", { token: 12345678901234567890 })).statusCode).toBe(401);
    expect((await decide(id, "deny", { token: ["a".repeat(32)] })).statusCode).toBe(401);
    // ADR-0020: credentials in a URL are never accepted, valid or not.
    expect((await app.inject({ method: "GET", url: `/v1/holds/${id}?t=${"a".repeat(32)}&t=${"b".repeat(32)}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/deny`, headers: { "content-type": "application/json" }, payload: "{not json" })).statusCode).toBe(400);
    expect((await decide("pur_doesnotexist", "deny", { token: "a".repeat(32) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, headers: bearer("agent") })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/v1/purchases/${id}/hold-link`, headers: bearer("agent") })).statusCode).toBe(403);
    // Nothing above changed the hold.
    expect((await app.inject({ method: "GET", url: `/v1/holds/${id}`, headers: bearer("shopper") })).json().state).toBe("HELD");
  });

  test("approve never captures by itself: it re-checks PayPal, records an approval, and the executor captures the held amount", async () => {
    const id = await held();
    const { token } = await link(id);
    const captures = h.fake.count("POST", /\/capture$/);
    const r = await decide(id, "approve", { token });
    expect(r.json().state).toBe("CAPTURE_APPROVED");
    expect(h.fake.count("GET", /\/v2\/checkout\/orders\//)).toBeGreaterThan(0);
    expect(h.fake.count("POST", /\/capture$/)).toBe(captures);
    await h.drain();
    expect(h.fake.count("POST", /\/capture$/)).toBe(captures + 1);
    const cap = [...h.fake.captures.values()].at(-1)!;
    expect(cap.value).toBe(r.json().amount.value);
  });

  test("a hold resolved some other way (intent revoked) can't then be approved by link", async () => {
    const id = await held();
    const { token } = await link(id);
    const intentId = (await app.inject({ method: "GET", url: `/v1/purchases/${id}`, headers: bearer("shopper") })).json().intent_id;
    await app.inject({ method: "POST", url: `/v1/intents/${intentId}/revoke`, headers: bearer("shopper") });
    const r = await decide(id, "approve", { token });
    expect(r.statusCode).toBe(409);
    await h.drain();
    expect((await view(id, token)).json().state).toBe("VOIDED");
  });
});
