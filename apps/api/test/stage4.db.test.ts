// Stage 4 API flows: free-text intents, agent intent summary, and the HOLD lifecycle over HTTP.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey } from "@witness/db";
import { demoPolicy } from "@witness/engine";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const bearer = (k: string) => ({ authorization: `Bearer ${keys[k]}` });

beforeAll(async () => {
  h = await createHarness();
  h.d.defaultRetailers = ["rei.com", "backcountry.com"];
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  keys.agent = (await createApiKey(h.pool, h.tenantId, "agent:a1", ["agent:purchase"])).key;
  keys.shopper = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe("free-text intents", () => {
  test("text compiles to a DRAFT the shopper confirms; gaps block confirmation", async () => {
    const draft = await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { text: "Trail running shoes, size 10, under $90, not white, from rei.com" } });
    expect(draft.statusCode).toBe(201);
    const d = draft.json();
    expect(d).toMatchObject({ status: "DRAFT", complete: true, policy: { max_total_cents: 9000, retailers: ["rei.com"], hard: { size: "10", excluded_colors: ["white"] } } });
    expect(d.compiler).toMatchObject({ model: "fake", prompt_version: "intent@v1" });
    const ok = await app.inject({ method: "POST", url: `/v1/intents/${d.id}/confirm`, headers: bearer("shopper") });
    expect(ok.json().status).toBe("CONFIRMED");

    // No budget stated: the draft is incomplete and confirming it as-is is refused.
    const gap = await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { text: "some trail shoes please" } });
    expect(gap.json()).toMatchObject({ complete: false });
    expect(gap.json().ambiguities.map((a: { field: string }) => a.field)).toEqual(expect.arrayContaining(["max_total_cents", "retailers"]));
    expect((await app.inject({ method: "POST", url: `/v1/intents/${gap.json().id}/confirm`, headers: bearer("shopper") })).statusCode).toBe(422);
    // The shopper fills the gap and confirms.
    const filled = { ...gap.json().policy, max_total_cents: 9000 };
    expect((await app.inject({ method: "POST", url: `/v1/intents/${gap.json().id}/confirm`, headers: bearer("shopper"), payload: { policy: filled } })).json().status).toBe("CONFIRMED");
  });

  test("if the model can't compile, the shopper is told to send a structured policy", async () => {
    const saved = h.d.ai;
    const { UnavailableLlm } = await import("@witness/ai");
    h.d.ai = new UnavailableLlm();
    const r = await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { text: "trail shoes under $90" } });
    h.d.ai = saved;
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/structured policy/);
  });

  test("agents can read a confirmed intent's summary but not drafts, and still can't create intents", async () => {
    const c = await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("shopper"), payload: { policy: demoPolicy(new Date()), source_text: "trail shoes under $90" } });
    expect((await app.inject({ method: "GET", url: `/v1/intents/${c.json().id}/summary`, headers: bearer("agent") })).statusCode).toBe(404);
    await app.inject({ method: "POST", url: `/v1/intents/${c.json().id}/confirm`, headers: bearer("shopper") });
    const s = await app.inject({ method: "GET", url: `/v1/intents/${c.json().id}/summary`, headers: bearer("agent") });
    expect(s.json()).toMatchObject({ status: "CONFIRMED", source_text: "trail shoes under $90" });
    expect((await app.inject({ method: "POST", url: "/v1/intents", headers: bearer("agent"), payload: { text: "x" } })).statusCode).toBe(403);
  });
});

describe("HOLD lifecycle over HTTP", () => {
  const heldPurchase = async () => {
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/hold", headers: bearer("demo") });
    expect(r.json().purchase.state).toBe("HELD");
    return r.json().purchase.id as string;
  };
  const link = async (id: string) => (await app.inject({ method: "POST", url: `/v1/purchases/${id}/hold-link`, headers: bearer("shopper") })).json();

  test("phone link: view, approve, then the executor captures", async () => {
    const id = await heldPurchase();
    const { token, path } = await link(id);
    expect(path).toBe(`/holds/${id}#k=${token}`);
    const view = await app.inject({ method: "POST", url: `/v1/holds/${id}/view`, payload: { token } });
    expect(view.json()).toMatchObject({ state: "HELD", amount: { value: "80.00" }, items: [{ product_id: "TRL-NOSIZE" }] });
    expect(view.json().reasons.join()).toMatch(/no size/);

    const ok = await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, payload: { token } });
    expect(ok.json()).toMatchObject({ state: "CAPTURE_APPROVED", resolution: "APPROVED" });
    await h.drain();
    const after = await app.inject({ method: "GET", url: `/v1/holds/${id}`, headers: bearer("shopper") });
    expect(after.json().state).toBe("CAPTURED");
  });

  test("a link works once; forged or missing tokens are refused", async () => {
    const id = await heldPurchase();
    const { token } = await link(id);
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, payload: { token: "x".repeat(32) } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/deny`, payload: { token } })).json().state).toBe("VOIDING");
    // The link already decided: the opposite decision is a conflict (ADR-0017).
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, payload: { token } })).statusCode).toBe(409);
    await h.drain();
    expect(h.fake.auths.get([...h.fake.auths.keys()].at(-1)!)!.status).toBe("VOIDED");
  });

  test("concurrent approve and deny: exactly one takes effect; the other is refused (409/410), never a misleading 200", async () => {
    const id = await heldPurchase();
    const { token } = await link(id);
    const [a, d] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, payload: { token } }),
      app.inject({ method: "POST", url: `/v1/holds/${id}/deny`, payload: { token } }),
    ]);
    // The winner gets 200. The loser never does: 409 if it raced past the token check (new guard),
    // 410 if the winner had already consumed the token.
    expect([a.statusCode, d.statusCode].filter((c) => c === 200)).toHaveLength(1);
    const loser = a.statusCode === 200 ? d : a;
    expect([409, 410]).toContain(loser.statusCode);
    await h.drain();
    const final = (await app.inject({ method: "GET", url: `/v1/holds/${id}`, headers: bearer("shopper") })).json().state;
    expect(final).toBe(a.statusCode === 200 ? "CAPTURED" : "VOIDED");
  });

  test("the signed-in shopper can decide without a link", async () => {
    const id = await heldPurchase();
    const r = await app.inject({ method: "POST", url: `/v1/holds/${id}/deny`, headers: bearer("shopper") });
    expect(r.json().state).toBe("VOIDING");
  });

  test("approving a hold whose PayPal order changed meanwhile voids instead of capturing", async () => {
    const id = await heldPurchase();
    const orderId = [...h.fake.orders.keys()].at(-1)!;
    h.fake.mutateOrder(orderId, (pu) => {
      pu.items[0].sku = "TRL-PRO-10";
    });
    const r = await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, headers: bearer("shopper") });
    expect(r.json().state).toBe("VOIDING");
    expect(r.json().reasons.join()).toMatch(/TRL-PRO-10/);
  });

  test("an agent can't approve holds", async () => {
    const id = await heldPurchase();
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/approve`, headers: bearer("agent") })).statusCode).toBe(401);
  });

  test("prompt-injection scenario holds over HTTP", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/injection", headers: bearer("demo") });
    expect(r.json().purchase).toMatchObject({ state: "HELD", outcome: "HOLD" });
  });
});

describe("dispute evidence draft", () => {
  const captured = async () => {
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/normal", headers: bearer("demo") });
    await h.drain();
    return r.json().purchase.id as string;
  };

  test("AI narrative with code-inserted amounts and IDs", async () => {
    const opsKey = (await createApiKey(h.pool, h.tenantId, "ops:ev", ["ops"])).key;
    const id = await captured();
    const { FakeLlm } = await import("@witness/ai");
    const saved = h.d.ai;
    h.d.ai = new FakeLlm().on("evidence", () => ({ narrative: "The shopper asked for {{intent_text}}. Second Key captured {{amount}} {{currency}} on order {{order_id}} after the checks passed.", cited_fields: ["checks"] }));
    const r = await app.inject({ method: "POST", url: `/v1/purchases/${id}/dispute-evidence/draft`, headers: { authorization: `Bearer ${opsKey}` } });
    h.d.ai = saved;
    expect(r.json().source).toBe("ai");
    expect(r.json().text).toMatch(/captured 84\.00 USD on order ORD/);
  });

  test("falls back to the template when the AI draft breaks a rule", async () => {
    const opsKey = (await createApiKey(h.pool, h.tenantId, "ops:ev2", ["ops"])).key;
    const id = await captured();
    const { FakeLlm } = await import("@witness/ai");
    const saved = h.d.ai;
    h.d.ai = new FakeLlm().on("evidence", () => ({ narrative: "The shopper signed off on 84 dollars.", cited_fields: [] }));
    const r = await app.inject({ method: "POST", url: `/v1/purchases/${id}/dispute-evidence/draft`, headers: { authorization: `Bearer ${opsKey}` } });
    h.d.ai = saved;
    expect(r.json()).toMatchObject({ source: "template" });
    expect(r.json().text).toMatch(/not cryptographically signed/);
    expect(r.json().text).toMatch(/exactly 84\.00 USD/);
  });

  test("only captured purchases get evidence", async () => {
    const opsKey = (await createApiKey(h.pool, h.tenantId, "ops:ev3", ["ops"])).key;
    const r = await app.inject({ method: "POST", url: "/v1/demo/scenarios/reject", headers: bearer("demo") });
    const e = await app.inject({ method: "POST", url: `/v1/purchases/${r.json().purchase.id}/dispute-evidence/draft`, headers: { authorization: `Bearer ${opsKey}` } });
    expect(e.statusCode).toBe(409);
  });
});
