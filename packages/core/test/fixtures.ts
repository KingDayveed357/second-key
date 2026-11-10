// Shared test data: the trail-shoe intent used throughout the docs and products sold at two retailers.

import { PolicyV1, type ProductFacts, type PurchaseRequest } from "../src/index.ts";

const at = "2026-10-11T12:00:00.000Z";

const shoe = (product_id: string, title: string, color: string, prices: Record<string, number>, extra: Partial<ProductFacts> = {}): ProductFacts => ({
  product_id,
  title,
  brand: "Ridgeline",
  category: "Shoes > Running > Trail-running shoes",
  attributes: { size: "10", color },
  offers: Object.entries(prices).map(([retailer, price]) => ({
    retailer,
    price_cents: price,
    currency: "USD" as const,
    availability: "InStock" as const,
    condition: "new" as const,
  })),
  source: "fixture",
  fetched_at: at,
  ...extra,
});

export const FACTS: Record<string, ProductFacts> = {
  "TRL-GRY-10": shoe("TRL-GRY-10", "Ridgeline Trail Runner, Slate Grey, US 10", "Slate Grey", { "rei.com": 8400, "backcountry.com": 8600 }),
  "TRL-WHT-10": shoe("TRL-WHT-10", "Ridgeline Trail Runner, Cloud White, US 10", "Cloud White", { "rei.com": 8400 }),
  "TRL-BLK-10": shoe("TRL-BLK-10", "Ridgeline Trail Runner, Black, US 10", "Black", { "rei.com": 7900 }),
  "TRL-PRO-10": shoe("TRL-PRO-10", "Summit Pro Carbon Trail, Graphite, US 10", "Graphite", { "rei.com": 48000 }),
  "TRL-NOSIZE": shoe("TRL-NOSIZE", "Ridgeline Trail Runner, Moss", "Moss", { "rei.com": 8000 }, { attributes: { color: "Moss" } }),
  "TRL-PRICEY": shoe("TRL-PRICEY", "Ridgeline Trail Runner, Slate Grey (reseller)", "Slate Grey", { "rei.com": 8900, "backcountry.com": 4500, "trailshop.com": 4600 }),
  "RD-BLU-10": shoe("RD-BLU-10", "Metro Road Runner, Blue, US 10", "Blue", { "rei.com": 7000 }, { category: "Shoes > Running > Road-running shoes" }),
};

export const factsMap = (...ids: string[]) => new Map(ids.map((id) => [id, FACTS[id]!]));

// "Trail-running shoes, size 10, under $90, not white, from REI or Backcountry."
export const POLICY = PolicyV1.parse({
  version: 1,
  category: "trail-running shoes",
  retailers: ["rei.com", "backcountry.com"],
  max_total_cents: 9000,
  currency: "USD",
  quantity: 1,
  hard: { excluded_colors: ["white"], size: "10" },
  substitution: "same_category_under_max",
  expires_at: "2026-12-31T23:59:59Z",
});

// Same intent pinned to one product.
export const PINNED = PolicyV1.parse({ ...POLICY, products: ["TRL-GRY-10"], substitution: "deny" });

export const req = (product_id: string, over: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  intent_id: "int_test",
  retailer: "rei.com",
  lines: [{ product_id, quantity: 1 }],
  ...over,
});

export const CTX = { now: new Date(at), purchasesUsed: 0 };
