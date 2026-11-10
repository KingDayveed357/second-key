// The three-way match: what Second Key approved vs what PayPal actually stored for the order.
// Every purchase unit, the payee, the amount and its breakdown, and every item are compared.
// An empty result means an exact match. Anything unparseable is a difference, never a pass.

import { z } from "zod";
import { MoneyError, toCents } from "./money.ts";
import type { CartItemKey } from "./digest.ts";

export interface MatchExpectation {
  order_id: string;
  currency: string;
  amount_cents: number;
  payee_merchant_id: string;
  items: CartItemKey[];
}

const Money = z.object({ currency_code: z.string(), value: z.string() });

const PayPalOrder = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z.array(
    z.object({
      payee: z.object({ merchant_id: z.string().optional() }).loose().optional(),
      // Optional because create-order returns a minimal representation (reference_id + payments
      // only; Stage 1 evidence). The match itself always runs on a full GET, and treats a missing
      // amount as a difference.
      amount: Money.extend({
        breakdown: z.record(z.string(), Money).optional(),
      })
        .loose()
        .optional(),
      items: z
        .array(
          z
            .object({
              name: z.string().optional(),
              sku: z.string().optional(),
              quantity: z.string(),
              unit_amount: Money,
            })
            .loose(),
        )
        .optional(),
      payments: z
        .object({
          authorizations: z.array(z.object({ id: z.string(), status: z.string(), amount: Money }).loose()).optional(),
          captures: z.array(z.object({ id: z.string(), status: z.string(), amount: Money }).loose()).optional(),
        })
        .loose()
        .optional(),
    }).loose(),
  ),
}).loose();
export type PayPalOrder = z.infer<typeof PayPalOrder>;

export function parsePayPalOrder(raw: unknown): PayPalOrder | null {
  const r = PayPalOrder.safeParse(raw);
  return r.success ? r.data : null;
}

const cents = (v: string, diffs: string[], what: string): number | null => {
  try {
    return toCents(v);
  } catch (e) {
    if (e instanceof MoneyError) {
      diffs.push(`${what}: unparseable amount ${JSON.stringify(v)}`);
      return null;
    }
    throw e;
  }
};

const EXTRA_CHARGES = ["shipping", "handling", "tax_total", "insurance", "shipping_discount", "discount"];

export function threeWayMatch(exp: MatchExpectation, raw: unknown): string[] {
  const order = parsePayPalOrder(raw);
  if (!order) return ["order: PayPal response did not have the expected shape"];
  const diffs: string[] = [];

  if (order.id !== exp.order_id) diffs.push(`order id: expected ${exp.order_id}, PayPal returned ${order.id}`);
  if (order.purchase_units.length !== 1) {
    diffs.push(`purchase_units: expected exactly 1, PayPal has ${order.purchase_units.length}`);
  }
  const pu = order.purchase_units[0];
  if (!pu) return diffs;

  const payee = pu.payee?.merchant_id;
  if (payee !== exp.payee_merchant_id) diffs.push(`payee: expected ${exp.payee_merchant_id}, PayPal has ${payee ?? "(none)"}`);

  if (!pu.amount) {
    diffs.push("amount: missing from PayPal's order (minimal representation?)");
    return diffs;
  }
  if (pu.amount.currency_code !== exp.currency) diffs.push(`currency: approved ${exp.currency}, PayPal has ${pu.amount.currency_code}`);
  const amount = cents(pu.amount.value, diffs, "amount");
  if (amount !== null && amount !== exp.amount_cents) diffs.push(`amount: approved ${exp.amount_cents} cents, PayPal has ${amount}`);

  const breakdown = pu.amount.breakdown ?? {};
  for (const key of EXTRA_CHARGES) {
    const m = breakdown[key];
    if (m && cents(m.value, diffs, `breakdown.${key}`) !== 0) diffs.push(`unapproved ${key}: ${m.value} ${m.currency_code}`);
  }
  const itemTotal = breakdown["item_total"];
  if (itemTotal) {
    const t = cents(itemTotal.value, diffs, "item_total");
    if (t !== null && t !== exp.amount_cents) diffs.push(`item_total: approved ${exp.amount_cents} cents, PayPal has ${t}`);
  }

  const approved = new Map(exp.items.map((i) => [i.sku, i]));
  const actual = new Map<string, CartItemKey>();
  for (const it of pu.items ?? []) {
    if (!it.sku) {
      diffs.push(`item without SKU in PayPal's order: ${it.name ?? "(unnamed)"}`);
      continue;
    }
    if (actual.has(it.sku)) diffs.push(`duplicate SKU line in PayPal's order: ${it.sku}`);
    if (it.unit_amount.currency_code !== exp.currency) diffs.push(`currency of ${it.sku}: ${it.unit_amount.currency_code}`);
    const qty = /^[1-9]\d{0,2}$/.test(it.quantity) ? Number(it.quantity) : NaN;
    if (Number.isNaN(qty)) diffs.push(`quantity of ${it.sku}: unparseable ${JSON.stringify(it.quantity)}`);
    const unit = cents(it.unit_amount.value, diffs, `unit price of ${it.sku}`);
    actual.set(it.sku, { sku: it.sku, quantity: qty, unit_cents: unit ?? -1 });
  }

  for (const [sku, a] of approved) {
    const p = actual.get(sku);
    if (!p) diffs.push(`missing: approved SKU ${sku} is not in PayPal's order`);
    else {
      if (p.quantity !== a.quantity) diffs.push(`quantity of ${sku}: approved ${a.quantity}, PayPal has ${p.quantity}`);
      if (p.unit_cents !== a.unit_cents) diffs.push(`price of ${sku}: approved ${a.unit_cents} cents, PayPal has ${p.unit_cents}`);
    }
  }
  for (const sku of actual.keys()) {
    if (!approved.has(sku)) diffs.push(`unapproved: PayPal's order contains SKU ${sku}, which Second Key never approved`);
  }
  return diffs;
}

export interface AuthorizationView {
  id: string;
  status: string;
  amount_cents: number | null;
  currency: string;
}

/** The single authorization on the single purchase unit, or null. */
export function authorizationOf(raw: unknown): AuthorizationView | null {
  const order = parsePayPalOrder(raw);
  const auths = order?.purchase_units[0]?.payments?.authorizations ?? [];
  if (!order || order.purchase_units.length !== 1 || auths.length !== 1) return null;
  const a = auths[0]!;
  let amount_cents: number | null = null;
  try {
    amount_cents = toCents(a.amount.value);
  } catch {
    amount_cents = null;
  }
  return { id: a.id, status: a.status, amount_cents, currency: a.amount.currency_code };
}

export interface CaptureView {
  id: string;
  status: string;
  amount_cents: number | null;
  currency: string;
}

export function capturesOf(raw: unknown): CaptureView[] {
  const order = parsePayPalOrder(raw);
  return (order?.purchase_units[0]?.payments?.captures ?? []).map((c) => {
    let amount_cents: number | null = null;
    try {
      amount_cents = toCents(c.amount.value);
    } catch {
      amount_cents = null;
    }
    return { id: c.id, status: c.status, amount_cents, currency: c.amount.currency_code };
  });
}

/**
 * A capture counts as the approved payment only if PayPal reports it COMPLETED for exactly the
 * approved amount and currency. Order status alone is never treated as payment success.
 */
export function captureMatches(c: { status?: unknown; amount?: { value?: unknown; currency_code?: unknown } | undefined } | undefined, amountCents: number, currency: string): boolean {
  if (!c || c.status !== "COMPLETED" || typeof c.amount?.value !== "string") return false;
  try {
    return toCents(c.amount.value) === amountCents && c.amount.currency_code === currency;
  } catch {
    return false;
  }
}

/** The authorization must exist, be live (CREATED) and hold exactly the approved amount. */
export function authorizationDiffs(exp: MatchExpectation, raw: unknown, authorizationId?: string): string[] {
  const a = authorizationOf(raw);
  if (!a) return ["authorization: expected exactly one authorization on the order"];
  const diffs: string[] = [];
  if (authorizationId && a.id !== authorizationId) diffs.push(`authorization id: expected ${authorizationId}, PayPal has ${a.id}`);
  if (a.status !== "CREATED") diffs.push(`authorization status: ${a.status}, expected CREATED`);
  if (a.currency !== exp.currency) diffs.push(`authorization currency: ${a.currency}`);
  if (a.amount_cents !== exp.amount_cents) diffs.push(`authorization amount: ${a.amount_cents} cents, approved ${exp.amount_cents}`);
  return diffs;
}
