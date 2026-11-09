import { describe, expect, test } from "vitest";
import { Channel3Catalog, FallbackCatalog, FixtureCatalog, colourOfDescription, colourOfTitle, normaliseChannel3 } from "../src/index.ts";
import search from "./fixtures/channel3-search.json" with { type: "json" };

// A trimmed live response from POST /v1/search, query "gold smartwatch" (9 Nov 2026).
const fakeFetch = (body: unknown, status = 200, seen?: { url?: string; init?: RequestInit }) =>
  (async (url: string, init?: RequestInit) => {
    if (seen) Object.assign(seen, { url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("colour from a title", () => {
  test.each([
    ["Timex iConnect Active+ Rose Gold-Tone Expansion Band", "Rose Gold"],
    ["Garmin Venu 3S GPS Smartwatch Gold Steel Bezel", "Gold"],
    ["Apple Watch SE Space Grey Aluminium", "Space Gray"],
    ["Garmin Venu 4 41mm Beige w Lunar Gold + Bone", undefined],
    ["PULSE Smartwatch", undefined],
    ["Round Goldtone Smartwatch with Floral Pattern Strap", "Gold"],
  ])("%s → %s", (title, colour) => expect(colourOfTitle(title)).toBe(colour));
});

describe("colour from a description", () => {
  test.each([
    ["The Samsung Galaxy Watch4 is a 40mm aluminum smartwatch in Gold, featuring LTE.", "Gold"],
    ["Colour: Navy. Machine washable.", "Navy"],
    ["Available in black. Pairs well with white sneakers.", "Black"],
    ["Comes in black or in white.", undefined],
    ["A lightweight shoe for road runners.", undefined],
  ])("%s → %s", (text, colour) => expect(colourOfDescription(text)).toBe(colour));
});

describe("Channel3 search", () => {
  test("sends the query and price filter, maps hits to facts and an image, and drops pricier ones", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const c = new Channel3Catalog({ apiKey: "k", fetchImpl: fakeFetch(search, 200, seen) });
    const hits = await c.search("gold smartwatch", { maxCents: 15000 });
    expect(seen.url).toBe("https://api.trychannel3.com/v1/search");
    expect(JSON.parse(String(seen.init?.body))).toMatchObject({ query: "gold smartwatch", filters: { price: { max_price: 150 } } });
    expect((seen.init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const ids = hits.map((h) => h.facts.product_id);
    expect(ids).not.toContain("qpUILDr"); // $206.99
    const tous = hits.find((h) => h.facts.product_id === "YhUzR77");
    expect(tous).toBeUndefined(); // $288
    const timex = hits.find((h) => h.facts.product_id === "Ps0xuwT")!;
    expect(timex.facts.attributes).toMatchObject({ color: "Rose Gold", color_source: "title" });
    expect(timex.image).toMatch(/^https:\/\/cdn\.trychannel3\.com\//);
    expect(timex.facts.source).toBe("channel3");
  });

  test("a variant colour wins over the title, and gets no title provenance", async () => {
    const c = new Channel3Catalog({ apiKey: "k", fetchImpl: fakeFetch(search) });
    const tous = (await c.search("gold smartwatch")).find((h) => h.facts.product_id === "YhUzR77")!;
    expect(tous.facts.attributes["color"]).toBe("Gold");
    expect(tous.facts.attributes["color_source"]).toBeUndefined();
  });

  test("a failing live search is an error, never fixtures in disguise", async () => {
    const c = new FallbackCatalog(new Channel3Catalog({ apiKey: "k", fetchImpl: fakeFetch({}, 500) }), new FixtureCatalog());
    await expect(c.search("shoes")).rejects.toThrow(/HTTP 500/);
  });

  test("the fixture catalog searches titles", async () => {
    const hits = await new FixtureCatalog().search("trail runner", { maxCents: 9000 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.facts.offers.some((o) => o.price_cents <= 9000))).toBe(true);
  });
});

describe("colour provenance", () => {
  const base = { id: "x1", title: "Escalante Racer 2", offers: [{ domain: "a.com", price: { price: 90, currency: "USD" }, availability: "InStock" }] };
  test("a repeated variant colour is one colour", () => {
    expect(normaliseChannel3({ ...base, variants: { selected: [{ name: "Color", label: "Black/Black" }] } }).attributes).toEqual({ color: "Black" });
    expect(normaliseChannel3({ ...base, variants: { selected: [{ name: "Color", label: "Black/White" }] } }).attributes).toEqual({ color: "Black/White" });
  });
  test("the description is used only when the title names no colour, and says so", () => {
    expect(normaliseChannel3({ ...base, description: "A racer in Gold." }).attributes).toEqual({ color: "Gold", color_source: "description" });
    expect(normaliseChannel3({ ...base, title: "Racer, Silver", description: "A racer in Gold." }).attributes).toEqual({ color: "Silver", color_source: "title" });
  });
});
