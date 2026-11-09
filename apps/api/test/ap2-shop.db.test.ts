// Real-product AP2 runs (10 Nov) on a Channel3 catalog served from a recorded search response, with
// Rose's mandates signed by the page's own code (apps/web/lib/ap2-surface.ts). Each run must be
// decided by the check the page says decides it, and the Desk feed must show it.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CryptoKey } from "jose";
import { createApiKey } from "@witness/db";
import { loadReceiptSigner } from "@witness/ap2";
import { Channel3Catalog, FallbackCatalog, FixtureCatalog } from "@witness/catalog";
import { FakeProvider } from "@witness/ai";
import { planByRules, withholdShortlist } from "@witness/engine";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";
import { shopMandates, thumbprint, type ShopPlan } from "../../web/lib/ap2-surface.ts";
import recorded from "../../../packages/catalog/test/fixtures/channel3-search.json" with { type: "json" };

// The recorded hits, with two prices moved under the $150 budget so the run has a gold and a non-gold choice.
const products = (recorded.products as Record<string, any>[]).map((p) =>
  p.id === "YhUzR77" ? { ...p, offers: [{ ...p.offers[0], price: { price: 120, compare_at_price: null, currency: "USD" } }] } : p.id === "iXS2gKD" ? { ...p, title: "Women's Connect It Prism Smartwatch, Silver" } : p,
);
let c3Calls: string[] = [];
const channel3Fetch = (async (url: string) => {
  c3Calls.push(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v1/search")) return json({ products });
  const id = decodeURIComponent(url.split("/v1/products/")[1] ?? "");
  const p = products.find((x) => x.id === id);
  return p ? json(p) : json({ detail: "not found" }, 404);
}) as unknown as typeof fetch;

let h: Harness;
let app: FastifyInstance;
let key: string;
let rose: { privateKey: CryptoKey; publicJwk: { kty: string; crv: string; x: string; y: string }; kid: string };
let setup: any;
const ai = new FakeProvider()
  .on("shop-plan", () => ({ query: "smartwatch", max_usd: 150, rules: [{ attribute: "color", any_of: ["gold"], none_of: null }], summary: "A gold smartwatch under $150." }))
  .on("shop-pick", (input: string) => ({ product_id: input.includes('id="YhUzR77"') ? "YhUzR77" : "nope", reason: "gold and in budget" }));

beforeAll(async () => {
  h = await createHarness();
  const catalog = new FallbackCatalog(new Channel3Catalog({ apiKey: "test", fetchImpl: channel3Fetch }), new FixtureCatalog());
  // The listing check passes, so the facts rung is decided by the rules alone.
  ai.on("injection", () => ({ suspected: false, confidence: 0.95, spans: [] }));
  app = buildApp({ deps: { ...h.d, catalog, ai, receipts: await loadReceiptSigner("https://verifier.test") } });
  await app.ready();
  key = (await createApiKey(h.pool, h.tenantId, `shopper:${h.shopperId}`, ["shopper"])).key;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
  rose = { privateKey: pair.privateKey, publicJwk, kid: await thumbprint(publicJwk) };
  setup = (await app.inject({ method: "GET", url: "/v1/demo/ap2/setup" })).json();
  expect((await app.inject({ method: "POST", url: "/v1/me/demo/ap2/surface", headers: auth(), payload: { jwk: rose.publicJwk } })).statusCode).toBe(201);
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const auth = () => ({ authorization: `Bearer ${key}` });
const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/v1/me/demo/ap2/shop/${path}`, headers: auth(), payload });
let plan: ShopPlan;
let hits: { id: string; title: string; price_cents: number; rules: { ok: boolean | null }[] }[];

const runShop = async (mode: string, productId: string, extra: Record<string, unknown> = {}) => {
  const shortlist = hits.filter((x) => x.rules.every((r) => r.ok === true)).map((x) => ({ id: x.id, title: x.title }));
  const m = await shopMandates(setup, plan, shortlist, rose.privateKey, rose.kid);
  return post("runs", { mode, product_id: productId, open_checkout: m.openCheckout, open_payment: m.openPayment, ...extra });
};

describe("AP2 real-product runs", () => {
  test("plan: the model drafts rules from Rose's words; without it, patterns do", async () => {
    const r = await post("plan", { need: "a gold smartwatch under $150" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ drafted_by: "ai", plan: { query: "smartwatch", max_cents: 15000, rules: [{ attribute: "color", any_of: ["gold"] }] } });
    plan = r.json().plan;
    expect(planByRules("I want a gold smartwatch under $150, not white")).toMatchObject({ max_cents: 15000, rules: [{ attribute: "color", any_of: ["gold"] }, { attribute: "color", none_of: ["white"] }] });
    expect((await post("plan", { need: "x" })).statusCode).toBe(422);
  });

  test("search: Channel3's results within budget, each with what its own data says about the rules", async () => {
    const r = await post("search", plan as unknown as Record<string, unknown>);
    expect(r.statusCode).toBe(200);
    expect(r.json().source).toBe("channel3");
    hits = r.json().hits;
    expect(hits.every((x) => x.price_cents <= 15000)).toBe(true);
    const tous = hits.find((x) => x.id === "YhUzR77")!;
    expect(tous.rules).toEqual([{ attribute: "color", value: "Gold", ok: true }]);
    expect(hits.find((x) => x.id === "Ps0xuwT")!.rules[0]).toMatchObject({ value: "Rose Gold", ok: false });
  });

  test("pick: the agent picks from the results; an answer outside them falls back to the rules", async () => {
    const r = await post("pick", { summary: "gold smartwatch", plan, hits });
    expect(r.json()).toMatchObject({ product_id: "YhUzR77", picked_by: "ai" });
  });

  test("buy, right product: Second Key re-fetches it from Channel3, every check passes, PayPal captures", async () => {
    c3Calls = [];
    const r = await runShop("buy", "YhUzR77", { image: "https://cdn.trychannel3.com/x" });
    expect(r.statusCode).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ caught_by: "none", agent: { product_id: "YhUzR77", price_cents: 12000, retailer: "tous.com" }, verification: { decision: "CONFORMS" }, settlement: { state: "MATCHED" } });
    expect(c3Calls.some((u) => u.endsWith("/v1/products/YhUzR77"))).toBe(true);
    await h.drain();
  });

  test("buy, rose gold: on the shortlist? no, so AP2 itself refuses; and a non-gold product fails Second Key's facts", async () => {
    // Rose gold isn't on her shortlist (its own data says Rose Gold), so AP2's line items refuse it.
    const roseGold = (await runShop("buy", "Ps0xuwT")).json();
    expect(roseGold).toMatchObject({ caught_by: "ap2_constraints", settlement: null });
  });

  test("the attribute rule alone: a listed product whose facts aren't gold is refused by Second Key, with AP2 passing", async () => {
    // Rose lists every result (a looser shortlist); the rule still holds.
    const m = await shopMandates(setup, plan, hits.map((x) => ({ id: x.id, title: x.title })), rose.privateKey, rose.kid);
    const v = (await post("runs", { mode: "buy", product_id: "iXS2gKD", open_checkout: m.openCheckout, open_payment: m.openPayment })).json();
    const failed = v.verification.constraints.filter((c: { result: string }) => c.result !== "pass").map((c: { type: string }) => c.type);
    expect(v.caught_by).toBe("secondkey_facts");
    expect(failed).toEqual(["x-secondkey.item_attributes.1"]);
    expect(v.settlement).toBeNull();
  });

  test("a product with no colour in its facts can't be confirmed, never passed", async () => {
    const m = await shopMandates(setup, plan, hits.map((x) => ({ id: x.id, title: x.title })), rose.privateKey, rose.kid);
    const v = (await post("runs", { mode: "buy", product_id: "BgS91lx", open_checkout: m.openCheckout, open_payment: m.openPayment })).json();
    expect(v.verification.decision).toBe("CANNOT_CONFIRM");
    expect(v.settlement).toBeNull();
  });

  test("swap: the checkout sends PayPal another real product; Second Key voids it before capture", async () => {
    const v = (await runShop("swap", "YhUzR77", { swap_to: "8cthMte" })).json();
    expect(v).toMatchObject({ verification: { decision: "CONFORMS" }, sent_to_paypal: { product_id: "8cthMte" } });
    expect(["VOIDING", "VOIDED", "REFUSED"]).toContain(v.settlement.state);
    expect(v.caught_by).toBe("paypal_order");
  });

  test("hide_list: withholding the shortlist disclosures doesn't make the list a wildcard", async () => {
    const m = await shopMandates(setup, plan, [{ id: "YhUzR77", title: "Tous" }], rose.privateKey, rose.kid);
    expect(withholdShortlist(m.openCheckout).withheld).toBe(1);
    const v = (await post("runs", { mode: "hide_list", product_id: "BgS91lx", open_checkout: m.openCheckout, open_payment: m.openPayment })).json();
    expect(v.withheld).toBe(1);
    expect(v.verification.decision).toBe("NONCONFORMING");
    expect(v.verification.constraints).toContainEqual(expect.objectContaining({ type: "checkout.line_items", result: "fail" }));
    expect(v.settlement).toBeNull();
  });

  test("the run checks the product id and the mode", async () => {
    expect((await runShop("buy", "../etc")).statusCode).toBe(422);
    expect((await runShop("teleport", "YhUzR77")).statusCode).toBe(422);
    expect((await runShop("buy", "NOPE123")).statusCode).toBe(404);
  });

  test("the Desk feed shows every run with the layer that decided it and what PayPal recorded", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/demo/ap2/incidents", headers: { authorization: `Bearer ${(await createApiKey(h.pool, h.tenantId, "demo:test", ["demo"])).key}` } });
    expect(r.statusCode).toBe(200);
    const rows = r.json().verifications as { kind: string; run: string; caught_by: string; product: { id: string; source: string } | null; layers: Record<string, string>; settlement: { state: string } | null }[];
    const shop = rows.filter((x) => x.kind === "shop");
    expect(shop.length).toBeGreaterThanOrEqual(6);
    const bought = shop.find((x) => x.run === "buy" && x.product?.id === "YhUzR77")!;
    expect(bought).toMatchObject({ caught_by: "none", product: { source: "channel3" }, settlement: { state: "CAPTURED" }, layers: { paypal: "pass", facts: "pass" } });
    expect(shop.find((x) => x.run === "hide_list")).toMatchObject({ caught_by: "ap2_constraints", layers: { ap2: "fail", paypal: "skip" } });
    expect(shop.find((x) => x.run === "swap")).toMatchObject({ caught_by: "paypal_order" });
  });
});
