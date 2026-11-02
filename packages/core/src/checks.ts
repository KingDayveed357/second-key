// Deterministic screening: a cart against a confirmed policy, using facts Witness fetched itself.
// Any fail -> REJECT (no PayPal call). Any unknown -> HOLD. Otherwise PROCEED to authorize.

import { z } from "zod";
import type { ProductFacts } from "./facts.ts";
import { Domain, type IntentPolicy, type PolicyV1, type TransferPolicyV1 } from "./policy.ts";
import type { Currency } from "./money.ts";

export type CheckResult = "pass" | "fail" | "unknown";

/**
 * One piece of grounded evidence behind an AI check: a quote verified (by code, not the model) to
 * appear in the named source. `line` indexes the conversation's lines when the source is one.
 */
export interface EvidenceItem {
  tactic: string;
  quote: string;
  source: "conversation" | "listing";
  speaker?: string;
  line?: number;
  why?: string;
}

export interface Check {
  id: string;
  result: CheckResult;
  detail: string;
  line?: string;
  /** Deterministic unless set. AI checks also record which model and prompt version produced them. */
  kind?: "deterministic" | "ai";
  model?: string;
  prompt_version?: string;
  /**
   * An "unknown" deterministic check that an AI check may settle (e.g. category: retailer taxonomies
   * rarely match the shopper's words literally). Settled only by a definitive, grounded AI verdict.
   */
  defers_to?: string;
  /** Grounded quotes behind an AI check (Second Key). */
  evidence?: EvidenceItem[];
}

/** Untrusted conversation the payer was in when asked to pay (Second Key). */
export const ConversationInput = z.strictObject({
  context: z.string().max(500).default(""),
  lines: z.array(z.strictObject({ speaker: z.string().min(1).max(80), text: z.string().min(1).max(1000) })).min(1).max(60),
});

export const PurchaseRequest = z.strictObject({
  kind: z.literal("shopping").optional(),
  intent_id: z.string().min(1).max(64),
  retailer: Domain,
  lines: z
    .array(
      z.strictObject({
        product_id: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .min(1)
    .max(10),
  /** Untrusted free text from the agent. Stored, never used to decide. */
  agent_note: z.string().max(500).optional(),
  /**
   * Optional for shopping (a scammer may demand gift cards). Screened for manipulation; it can
   * only hold the payment for a trusted contact, never approve it.
   */
  conversation: ConversationInput.optional(),
});
export type PurchaseRequest = z.infer<typeof PurchaseRequest>;

/**
 * A transfer against a transfer intent (ADR-0016). Payee and amount restate what the payer
 * confirmed and must match it exactly. The conversation is OPTIONAL (ADR-0019): sharing it is the
 * payer's choice; the payer's own review rule applies either way, and when it is shared it is screened.
 */
export const TransferRequest = z.strictObject({
  kind: z.literal("transfer"),
  intent_id: z.string().min(1).max(64),
  payee_id: z.string().min(1).max(64),
  amount_cents: z.number().int().positive().max(10_000_000),
  currency: z.string().length(3),
  conversation: ConversationInput.optional(),
});
export type TransferRequest = z.infer<typeof TransferRequest>;
export type PaymentRequest = PurchaseRequest | TransferRequest;

/** Parse a payment request by its kind; no `kind` means a shopping request. */
export function parsePaymentRequest(input: unknown) {
  const kind = input && typeof input === "object" ? (input as { kind?: unknown }).kind : undefined;
  return kind === "transfer" ? TransferRequest.safeParse(input) : PurchaseRequest.safeParse(input);
}

export interface CartLine {
  product_id: string;
  name: string;
  unit_cents: number;
  quantity: number;
  brand?: string | undefined;
  category?: string | undefined;
  attributes: Record<string, string>;
  /** Median in-stock price for this product across all retailers, when there are at least two offers. */
  market_median_cents?: number | undefined;
}

export interface ResolvedCart {
  retailer: string;
  currency: Currency;
  lines: CartLine[];
  total_cents: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** Price each line from the chosen retailer's offer. Problems become failing checks. */
export function resolveCart(req: PurchaseRequest, facts: Map<string, ProductFacts>): { cart: ResolvedCart | null; checks: Check[] } {
  const checks: Check[] = [];
  const lines: CartLine[] = [];
  const seen = new Set<string>();
  let currency: Currency | undefined;

  for (const line of req.lines) {
    if (seen.has(line.product_id)) {
      checks.push({ id: "cart.duplicate_line", result: "fail", detail: `product ${line.product_id} appears twice`, line: line.product_id });
      continue;
    }
    seen.add(line.product_id);

    const f = facts.get(line.product_id);
    if (!f) {
      checks.push({ id: "facts.available", result: "fail", detail: `no catalog facts for ${line.product_id}`, line: line.product_id });
      continue;
    }
    const offer = f.offers.find((o) => o.retailer === req.retailer && o.availability === "InStock" && o.condition !== "used");
    if (!offer) {
      checks.push({ id: "offer.available", result: "fail", detail: `${req.retailer} has no new, in-stock offer for ${line.product_id}`, line: line.product_id });
      continue;
    }
    if (currency && offer.currency !== currency) {
      checks.push({ id: "cart.single_currency", result: "fail", detail: `mixed currencies ${currency} and ${offer.currency}`, line: line.product_id });
      continue;
    }
    currency = offer.currency;

    const sameCurrencyInStock = f.offers.filter((o) => o.availability === "InStock" && o.currency === offer.currency).map((o) => o.price_cents);
    lines.push({
      product_id: f.product_id,
      name: f.title,
      unit_cents: offer.price_cents,
      quantity: line.quantity,
      brand: f.brand,
      category: f.category,
      attributes: f.attributes,
      market_median_cents: sameCurrencyInStock.length >= 2 ? median(sameCurrencyInStock) : undefined,
    });
  }

  if (checks.length || !currency || lines.length === 0) return { cart: null, checks };
  const total_cents = lines.reduce((s, l) => s + l.unit_cents * l.quantity, 0);
  return { cart: { retailer: req.retailer, currency, lines, total_cents }, checks };
}

export interface ScreenContext {
  now: Date;
  /** Purchases already made (or in flight) against this intent version. */
  purchasesUsed: number;
  /** Price above this multiple of the market median -> HOLD. */
  overpricedRatio?: number;
  /**
   * The payer's standing protection and payment history (ADR-0020), read by the engine under a lock.
   * Absent means no profile and no history lookup (pre-0020 behaviour: the intent alone decides).
   */
  payer?: PayerContext;
}

export interface PayerContext {
  /** The standing profile's threshold, or null for no threshold rule. */
  profileThresholdCents: number | null;
  /** True when a captured transfer (or an audited import) to this payee exists for this payer. */
  paidBefore: boolean;
}

/**
 * The recipient identity for payment history. It includes what the money actually goes to: the payout
 * email when the payer confirmed one, together with the integrator's id. A known id with a new email,
 * or a known email under a new id, is therefore a NEW payee (stricter, never weaker). Without an email
 * the identity is the integrator's id alone, which is integrator-asserted (ADR-0020 §9).
 */
export function payeeKey(payee: { id: string; email?: string | undefined }): string {
  return payee.email ? `email:${payee.email.trim().toLowerCase()}#id:${payee.id}` : `id:${payee.id}`;
}

/** Stricter wins: the lowest threshold present, or null when neither the profile nor the intent sets one. */
export function effectiveThreshold(profile: number | null | undefined, intent: number | null | undefined): number | null {
  const present = [profile, intent].filter((x): x is number => typeof x === "number");
  return present.length ? Math.min(...present) : null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Checks every intent kind shares: still valid, uses left, and the payment's currency. */
export function screenIntent(intent: { expires_at: string; max_uses: number; currency: string }, currency: string, ctx: ScreenContext): Check[] {
  return [
    { id: "intent.not_expired", result: ctx.now.getTime() <= Date.parse(intent.expires_at) ? "pass" : "fail", detail: `expires ${intent.expires_at}` },
    { id: "intent.purchases_left", result: ctx.purchasesUsed < intent.max_uses ? "pass" : "fail", detail: `${ctx.purchasesUsed} of ${intent.max_uses} used` },
    { id: "currency", result: currency === intent.currency ? "pass" : "fail", detail: `payment ${currency}, intent ${intent.currency}` },
  ];
}

/**
 * All deterministic screening for a payment, either kind (ADR-0016). A request whose kind doesn't
 * match the intent's fails here, so neither path can be used to dodge the other's checks.
 */
export function screenPayment(policy: IntentPolicy, req: PaymentRequest, facts: Map<string, ProductFacts>, ctx: ScreenContext): { cart: ResolvedCart | null; checks: Check[] } {
  if (policy.kind === "transfer" && req.kind === "transfer") return screenTransfer(policy, req, ctx);
  if (policy.kind !== "transfer" && req.kind !== "transfer") {
    const { cart, checks } = resolveCart(req, facts);
    return { cart, checks: cart ? [...checks, ...screenCart(policy, cart, ctx)] : checks };
  }
  const want = policy.kind === "transfer" ? "transfer" : "shopping";
  const got = req.kind === "transfer" ? "transfer" : "shopping";
  return { cart: null, checks: [{ id: "intent.kind", result: "fail", detail: `a ${got} request can't be paid against a ${want} intent` }] };
}

const usdLike = (cents: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

/**
 * The payer's own rule (ADR-0019), deterministic: a first payment to someone new at or above the
 * threshold is held for a second look. "unknown" → HOLD; it never fails a payment and never needs AI.
 */
export function reviewRule(policy: TransferPolicyV1, payer?: PayerContext): Check | null {
  // ADR-0020: the standing profile is authoritative; the intent can only make the rule stricter.
  const t = effectiveThreshold(payer?.profileThresholdCents, policy.review_threshold_cents);
  if (t === null) return null;
  const first = policy.payee.first_payment || (payer ? !payer.paidBefore : false);
  const triggered = first && policy.amount_cents >= t;
  return {
    id: "transfer.review_rule",
    result: triggered ? "unknown" : "pass",
    detail: triggered
      ? `the payer's rule: a second look for first payments of ${usdLike(t, policy.currency)} or more to someone new (this is ${usdLike(policy.amount_cents, policy.currency)} to ${policy.payee.name}, a first payment)`
      : `the payer's rule (first payments of ${usdLike(t, policy.currency)} or more to someone new) doesn't apply: ${first ? "below the threshold" : "paid before"}`,
  };
}

export const TRANSFER_RETAILER = "platform-held transfer (sandbox)";

/**
 * Deterministic screening for a transfer (ADR-0016). The cart is derived from the confirmed
 * intent, never from the request, so a request can only fail to match it, not change it.
 */
export function screenTransfer(policy: TransferPolicyV1, req: TransferRequest, ctx: ScreenContext): { cart: ResolvedCart; checks: Check[] } {
  const checks = screenIntent({ expires_at: policy.expires_at, max_uses: policy.max_payments, currency: policy.currency }, req.currency, ctx);
  checks.push({
    id: "transfer.payee",
    result: req.payee_id === policy.payee.id ? "pass" : "fail",
    detail: `request payee ${req.payee_id}, confirmed payee ${policy.payee.id} (${policy.payee.name}${policy.payee.first_payment ? ", first payment" : ""})`,
  });
  checks.push({
    id: "transfer.amount",
    result: req.amount_cents === policy.amount_cents ? "pass" : "fail",
    detail: `request ${req.amount_cents} cents, confirmed ${policy.amount_cents} cents`,
  });
  const rule = reviewRule(policy, ctx.payer);
  if (rule) checks.push(rule);
  const line: CartLine = {
    product_id: `transfer:${policy.payee.id}`,
    name: `Transfer to ${policy.payee.name} (simulated, platform-held)`,
    unit_cents: policy.amount_cents,
    quantity: 1,
    category: "transfer",
    attributes: { payee_id: policy.payee.id, payee_name: policy.payee.name, first_payment: String(policy.payee.first_payment) },
  };
  return { cart: { retailer: TRANSFER_RETAILER, currency: policy.currency, lines: [line], total_cents: policy.amount_cents }, checks };
}

export function screenCart(policy: PolicyV1, cart: ResolvedCart, ctx: ScreenContext): Check[] {
  const checks: Check[] = [];
  const add = (id: string, result: CheckResult, detail: string, line?: string) => checks.push(line ? { id, result, detail, line } : { id, result, detail });

  checks.push(...screenIntent({ expires_at: policy.expires_at, max_uses: policy.max_purchases, currency: policy.currency }, cart.currency, ctx));
  add("retailer", policy.retailers.includes(cart.retailer) ? "pass" : "fail", `${cart.retailer} vs allowed ${policy.retailers.join(", ")}`);
  add("max_total", cart.total_cents <= policy.max_total_cents ? "pass" : "fail", `${cart.total_cents} vs max ${policy.max_total_cents} cents`);

  const qty = cart.lines.reduce((s, l) => s + l.quantity, 0);
  add("quantity", qty === policy.quantity ? "pass" : "fail", `${qty} vs required ${policy.quantity}`);

  const ratio = ctx.overpricedRatio ?? 1.5;
  for (const l of cart.lines) {
    const id = l.product_id;
    const categoryMatches = policy.category !== undefined && l.category !== undefined && norm(l.category).includes(norm(policy.category));

    if (policy.products) {
      if (policy.products.includes(id)) add("product.allowed", "pass", `${id} is an allowed product`, id);
      else if (policy.substitution === "deny") add("product.allowed", "fail", `${id} is not an allowed product; substitution denied`, id);
      else if (policy.substitution === "hold") add("product.allowed", "unknown", `${id} is a substitute; policy says ask`, id);
      else if (categoryMatches) add("product.allowed", "pass", `${id} substitute in category ${l.category}`, id);
      else checks.push({ id: "product.allowed", result: "unknown", detail: `${id} is a substitute; whether it is a ${policy.category} is judged semantically`, line: id, defers_to: "ai.soft:category" });
    }

    if (policy.category !== undefined) {
      if (l.category === undefined) add("category", "unknown", "listing has no category", id);
      else if (categoryMatches) add("category", "pass", `${l.category} vs ${policy.category}`, id);
      else checks.push({ id: "category", result: "unknown", detail: `listing category "${l.category}" doesn't literally say "${policy.category}"; judged semantically`, line: id, defers_to: "ai.soft:category" });
    }

    if (policy.hard.size !== undefined) {
      const size = l.attributes["size"];
      if (size === undefined) add("size", "unknown", "listing has no size", id);
      else add("size", norm(size) === norm(policy.hard.size) ? "pass" : "fail", `${size} vs ${policy.hard.size}`, id);
    }

    if (policy.hard.excluded_colors.length) {
      const color = l.attributes["color"];
      if (color === undefined) add("color", "unknown", "listing has no color", id);
      else {
        const bad = policy.hard.excluded_colors.some((c) => norm(color).includes(norm(c)));
        add("color", bad ? "fail" : "pass", `${color} vs excluded ${policy.hard.excluded_colors.join(", ")}`, id);
      }
    }

    if (policy.hard.brand !== undefined) {
      if (l.brand === undefined) add("brand", "unknown", "listing has no brand", id);
      else add("brand", norm(l.brand) === norm(policy.hard.brand) ? "pass" : "fail", `${l.brand} vs ${policy.hard.brand}`, id);
    }

    if (l.market_median_cents !== undefined) {
      const over = l.unit_cents > Math.round(l.market_median_cents * ratio);
      add("market_price", over ? "unknown" : "pass", `${l.unit_cents} vs market median ${l.market_median_cents} cents`, id);
    }
  }
  return checks;
}

export type ScreenOutcome = "REJECT" | "HOLD" | "PROCEED";

export function screenOutcome(checks: Check[]): ScreenOutcome {
  if (checks.some((c) => c.result === "fail")) return "REJECT";
  if (checks.some((c) => c.result === "unknown")) return "HOLD";
  return "PROCEED";
}
