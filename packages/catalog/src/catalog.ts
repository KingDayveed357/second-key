// Catalog sources. Second Key always fetches facts itself by canonical product ID; it never uses the
// agent's description of a product.
//
// Channel3: GET https://api.trychannel3.com/v1/products/{id} with header x-api-key (Verified in
// docs.trychannel3.com/guides/product-detail; the endpoint is free). Offer fields `domain`,
// `price.amount`, `price.currency`, `availability`, `condition` are Verified (guides/offer).
// The live response shape was verified on 2026-10-12 (see normaliseChannel3). Anything the normaliser
// can't map confidently is dropped: a missing attribute becomes HOLD in screening, never a pass.

import { CURRENCIES, numberToCents, ProductFacts, type Offer } from "@witness/core";
import { fixtureFacts } from "./fixtures.ts";

export interface CatalogResult {
  facts: Map<string, ProductFacts>;
  errors: { product_id: string; error: string }[];
}

/** A search hit: the facts as the search returned them, plus what a shopper needs to see it. */
export interface SearchHit {
  facts: ProductFacts;
  image?: string;
}

export interface SearchOptions {
  /** Only offers at or under this price (USD cents). */
  maxCents?: number;
  limit?: number;
}

export interface CatalogSource {
  readonly name: string;
  getProducts(ids: string[]): Promise<CatalogResult>;
  /** Product search. What a search returns is what an agent sees; verification re-fetches by id. */
  search?(query: string, o?: SearchOptions): Promise<SearchHit[]>;
}

const within = (f: ProductFacts, max?: number) => max === undefined || f.offers.some((o) => o.currency === "USD" && o.price_cents <= max);

export class FixtureCatalog implements CatalogSource {
  readonly name = "fixture";
  async search(query: string, o: SearchOptions = {}): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    return [...fixtureFacts().values()]
      .filter((f) => terms.some((t) => `${f.title} ${f.category ?? ""}`.toLowerCase().includes(t)) && within(f, o.maxCents))
      .slice(0, o.limit ?? 12)
      .map((facts) => ({ facts }));
  }
  async getProducts(ids: string[]): Promise<CatalogResult> {
    const all = fixtureFacts();
    const facts = new Map<string, ProductFacts>();
    const errors: CatalogResult["errors"] = [];
    for (const id of ids) {
      const f = all.get(id);
      if (f) facts.set(id, f);
      else errors.push({ product_id: id, error: "not in fixture catalog" });
    }
    return { facts, errors };
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const nameOf = (v: unknown): string | undefined => str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>)["name"]) : undefined);

/**
 * Map a Channel3 product object to ProductFacts, or throw if the essentials are missing.
 *
 * Shape verified against a live response on 2026-10-12 (test/fixtures/channel3-product.json).
 * It differs from the docs in places: the offer price is `price.price` (docs show `price.amount`),
 * brands are a `brands[]` array, category is an object with a `path`, and attributes live in
 * `structured_attributes` (arrays) and `variants.selected`. Variant "Color" labels can be style
 * codes (e.g. "FV2338-201"), so only plain-word labels are taken as colours: otherwise colour stays
 * unknown and an excluded-colour policy holds instead of passing.
 */
export function normaliseChannel3(raw: unknown, now = new Date()): ProductFacts {
  if (!raw || typeof raw !== "object") throw new Error("Channel3 product is not an object");
  const p = raw as Record<string, unknown>;
  const offers: Offer[] = [];
  for (const o of Array.isArray(p["offers"]) ? (p["offers"] as Record<string, unknown>[]) : []) {
    const price = o["price"] as Record<string, unknown> | undefined;
    const currency = str(price?.["currency"]);
    const amount = price?.["price"] ?? price?.["amount"];
    const retailer = str(o["domain"])?.toLowerCase();
    if (!retailer || typeof amount !== "number" || !currency || !(CURRENCIES as readonly string[]).includes(currency)) continue;
    let price_cents: number;
    try {
      price_cents = numberToCents(amount);
    } catch {
      continue;
    }
    const availability = o["availability"] === "InStock" ? "InStock" : o["availability"] === "OutOfStock" ? "OutOfStock" : "Unknown";
    const cond = str(o["condition"]);
    const condition = cond === "new" || cond === "used" || cond === "refurbished" ? cond : "unknown";
    offers.push({ retailer, price_cents, currency: currency as Offer["currency"], availability, condition });
  }

  const attributes: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const val = Array.isArray(v) ? v.map(str).filter(Boolean).join(", ") : str(v);
    if (val) attributes[k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] = val;
  };
  for (const key of ["attributes", "structured_attributes"]) {
    const obj = p[key];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) put(k, v);
  }
  if (Array.isArray(p["materials"])) put("material", p["materials"]);
  const selected = (p["variants"] as { selected?: { name?: unknown; label?: unknown }[] } | undefined)?.selected;
  for (const sel of Array.isArray(selected) ? selected : []) {
    const name = str(sel.name)?.toLowerCase();
    const label = str(sel.label);
    if (!name || !label) continue;
    if (name === "color" || name === "colour") {
      // "Black/Black" is black; "Black/White" stays as it is (several colours).
      const parts = label.split("/").map((x) => x.trim());
      const one = parts.every((x) => x.toLowerCase() === parts[0]!.toLowerCase()) ? parts[0]! : label;
      if (/^[A-Za-z][A-Za-z /&-]{1,40}$/.test(one)) attributes["color"] = one;
    } else put(name, label);
  }
  // Most listings carry no colour field. Take it from the title only when the title names exactly
  // one colour; otherwise leave it missing, which an attribute rule treats as unresolved.
  if (!attributes["color"]) {
    const fromTitle = colourOfTitle(str(p["title"]) ?? "");
    const fromText = fromTitle ? undefined : colourOfDescription(str(p["description"]) ?? "");
    if (fromTitle ?? fromText) {
      attributes["color"] = (fromTitle ?? fromText)!;
      attributes["color_source"] = fromTitle ? "title" : "description";
    }
  }

  const brands = Array.isArray(p["brands"]) ? (p["brands"] as unknown[]) : [];
  const brand = nameOf(brands[0]) ?? nameOf(p["brand"]);
  const cat = p["category"];
  let category: string | undefined = str(cat);
  if (!category && cat && typeof cat === "object") {
    const path = (cat as { path?: { title?: unknown }[] }).path;
    category = Array.isArray(path) && path.length ? path.map((x) => str(x.title)).filter(Boolean).join(" > ") : str((cat as { title?: unknown }).title);
  }
  const features = Array.isArray(p["key_features"]) ? (p["key_features"] as unknown[]).map(str).filter(Boolean) : [];
  const description = [str(p["description"]), ...features].filter(Boolean).join("\n").slice(0, 10_000) || undefined;

  return ProductFacts.parse({
    product_id: str(p["id"]),
    title: str(p["title"]),
    brand,
    category,
    attributes,
    description,
    offers,
    source: "channel3",
    fetched_at: now.toISOString(),
  });
}

// Colour families, longest first so "rose gold" wins over "gold" and "off white" over "white".
const COLOURS = [
  "rose gold", "rose goldtone", "goldtone", "gold tone", "silvertone", "silver tone", "space gray", "space grey", "off white", "navy blue", "light blue", "dark blue", "dark green",
  "gold", "silver", "black", "white", "grey", "gray", "blue", "red", "green", "pink", "purple", "yellow", "orange",
  "brown", "beige", "navy", "teal", "ivory", "cream", "bronze", "copper", "graphite", "champagne", "burgundy", "tan", "khaki",
].sort((a, b) => b.length - a.length);
const CANONICAL: Record<string, string> = { "space grey": "space gray", grey: "gray", "rose goldtone": "rose gold", goldtone: "gold", "gold tone": "gold", silvertone: "silver", "silver tone": "silver" };

/** The one colour a title names, title-cased; undefined when it names none or several. */
export function colourOfTitle(title: string): string | undefined {
  let t = ` ${title.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const found = new Set<string>();
  for (const c of COLOURS) {
    if (t.includes(` ${c} `)) {
      found.add(CANONICAL[c] ?? c);
      t = t.split(` ${c} `).join("  ");
    }
  }
  if (found.size !== 1) return undefined;
  return [...found][0]!.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * The colour a description states as the product's own ("… a 40mm smartwatch in Gold", "Colour: Navy"),
 * only when every such statement names the same colour. Colours merely mentioned don't count.
 */
export function colourOfDescription(text: string): string | undefined {
  const found = new Set<string>();
  const re = /\b(?:in|colou?r(?:way)?\s*:?|finish(?:ed)? in)\s+((?:[a-z]+[\s-]){0,1}[a-z]+)\b/gi;
  for (const m of text.matchAll(re)) {
    const c = colourOfTitle(m[1]!);
    if (c) found.add(c);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

const mainImage = (p: Record<string, unknown>): string | undefined => {
  const imgs = Array.isArray(p["images"]) ? (p["images"] as Record<string, unknown>[]) : [];
  const img = imgs.find((i) => i["is_main_image"]) ?? imgs[0];
  const url = str(img?.["cleaned_url"]) ?? str(img?.["url"]);
  return url && url.startsWith("https://") ? url : undefined;
};

export class Channel3Catalog implements CatalogSource {
  readonly name = "channel3";
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(o: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
    if (!o.apiKey) throw new Error("CHANNEL3_API_KEY is required for the Channel3 catalog");
    this.#key = o.apiKey;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#base = o.baseUrl ?? "https://api.trychannel3.com";
  }

  /** POST /v1/search (verified live 2026-10-12 and 2026-11-09). Unmappable hits are skipped. */
  async search(query: string, o: SearchOptions = {}): Promise<SearchHit[]> {
    const res = await this.#fetch(`${this.#base}/v1/search`, {
      method: "POST",
      headers: { "x-api-key": this.#key, "content-type": "application/json" },
      body: JSON.stringify({ query, limit: Math.min(30, o.limit ?? 20), ...(o.maxCents !== undefined ? { filters: { price: { max_price: o.maxCents / 100 } } } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`channel3 search: HTTP ${res.status}`);
    const body = (await res.json()) as { products?: unknown[] };
    const hits: SearchHit[] = [];
    for (const raw of body.products ?? []) {
      try {
        const facts = normaliseChannel3(raw);
        if (!within(facts, o.maxCents)) continue;
        const image = mainImage(raw as Record<string, unknown>);
        hits.push({ facts, ...(image ? { image } : {}) });
      } catch {
        /* a hit without the essentials can't be bought or checked */
      }
    }
    return hits;
  }

  async getProducts(ids: string[]): Promise<CatalogResult> {
    const facts = new Map<string, ProductFacts>();
    const errors: CatalogResult["errors"] = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await this.#fetch(`${this.#base}/v1/products/${encodeURIComponent(id)}`, {
            headers: { "x-api-key": this.#key },
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          facts.set(id, normaliseChannel3(await res.json()));
        } catch (e) {
          errors.push({ product_id: id, error: `channel3: ${(e as Error).message}` });
        }
      }),
    );
    return { facts, errors };
  }
}

/** Live source first; fixture only for products the live source couldn't return. */
export class FallbackCatalog implements CatalogSource {
  readonly name: string;
  readonly primary: CatalogSource;
  readonly fallback: CatalogSource;
  constructor(primary: CatalogSource, fallback: CatalogSource) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}+${fallback.name}`;
  }
  /** The live source's search only: a failing live search is an error, never silently fixtures. */
  async search(query: string, o?: SearchOptions): Promise<SearchHit[]> {
    if (!this.primary.search) throw new Error(`${this.primary.name} has no search`);
    return this.primary.search(query, o);
  }

  async getProducts(ids: string[]): Promise<CatalogResult> {
    const first = await this.primary.getProducts(ids);
    const missing = ids.filter((id) => !first.facts.has(id));
    if (!missing.length) return first;
    const second = await this.fallback.getProducts(missing);
    for (const [k, v] of second.facts) first.facts.set(k, v);
    // One error per product still missing, naming why each source failed.
    const why = (list: CatalogResult["errors"], id: string) => list.find((e) => e.product_id === id)?.error ?? "missing";
    const errors = missing.filter((id) => !second.facts.has(id)).map((id) => ({ product_id: id, error: `${why(first.errors, id)}; ${why(second.errors, id)}` }));
    return { facts: first.facts, errors };
  }
}

export function catalogFromEnv(env: { CHANNEL3_API_KEY?: string | undefined }): CatalogSource {
  return env.CHANNEL3_API_KEY ? new FallbackCatalog(new Channel3Catalog({ apiKey: env.CHANNEL3_API_KEY }), new FixtureCatalog()) : new FixtureCatalog();
}
