// Product facts as Second Key fetched them from the catalog source. Never the agent's description.

import { z } from "zod";
import { CURRENCIES } from "./money.ts";

export const Offer = z.strictObject({
  retailer: z.string().min(1),
  price_cents: z.number().int().nonnegative(),
  currency: z.enum(CURRENCIES),
  availability: z.enum(["InStock", "OutOfStock", "Unknown"]),
  condition: z.enum(["new", "used", "refurbished", "unknown"]).default("unknown"),
});
export type Offer = z.infer<typeof Offer>;

export const ProductFacts = z.strictObject({
  product_id: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  brand: z.string().max(120).optional(),
  category: z.string().max(200).optional(),
  attributes: z.record(z.string(), z.string()).default({}),
  description: z.string().max(10_000).optional(),
  offers: z.array(Offer).default([]),
  source: z.enum(["channel3", "fixture", "judge"]), // judge: a listing typed on the demo page, screened only (never purchased)
  fetched_at: z.iso.datetime({ offset: true }),
});
export type ProductFacts = z.infer<typeof ProductFacts>;
