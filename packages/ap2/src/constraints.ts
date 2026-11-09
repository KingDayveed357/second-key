// AP2 v0.2 standard constraints (docs/ap2/checkout_mandate.md, payment_mandate.md at the vendored
// commit). Each evaluator returns pass, fail or unresolved; an unknown constraint type is
// unresolved, which the spec requires to count as failing ("Any unknown Constraints MUST be treated
// as failing evaluation") and which maps to the `unresolved_constraint` receipt error.
//
// Where the reference SDK is looser than the spec, the spec wins, and the test names the case:
// - line items must be satisfied exactly (max flow = total required = total in cart); the SDK only
//   checks that the cart fits, so a cart missing a required item passes there;
// - a requirement whose acceptable_items were all withheld matches nothing; the SDK treats it as a
//   wildcard, so an agent could hide them and buy anything;
// - recurrence frequency is enforced (one presentation per UTC period); the SDK ignores it;
// - an absent execution_date means now, and now must be in the window.

import { canonicalize } from "./canonical.ts";
import type { AttestedProduct, CheckedCosignature } from "./extensions.ts";
import { isObject, type Json, type JsonObject } from "./sdjwt.ts";

export type ConstraintOutcome = "pass" | "fail" | "unresolved";

export interface ConstraintResult {
  type: string;
  result: ConstraintOutcome;
  detail?: string;
  hop?: number;
  /** An unresolved result that a co-signature would settle (x-secondkey.cosign.1). */
  needs?: "cosign";
}

/** Usage of one open mandate, from the ledger. */
export interface LedgerUsage {
  uses: number;
  /** Sum of conforming payment amounts, minor units, in `currency`. */
  totalMinor: number;
  currency?: string;
  /** Unix seconds of the last conforming presentation. */
  lastUsedAt?: number;
}

export interface CheckoutContext {
  /** The merchant-signed checkout payload (UCP Checkout). */
  checkout: JsonObject;
  /** Product facts Second Key fetched and attested itself, by product id (extensions.ts). */
  facts?: Record<string, AttestedProduct>;
}

export interface PaymentContext {
  closed: JsonObject;
  /** sd_hash of each hop of the checkout chain this payment is for. */
  checkoutReferences?: string[];
  usage?: LedgerUsage;
  /** Unix seconds. */
  now: number;
  /** Hash of the closed payment mandate's issuer JWT: what a co-signer signs. */
  closedReference?: string;
  /** Co-signatures presented with the payment, already checked against each enrolled key. */
  cosignatures?: CheckedCosignature[];
}

type Verdict = Omit<ConstraintResult, "type" | "hop">;
export type Evaluator<C> = (constraint: JsonObject, ctx: C) => Verdict;

const pass: Verdict = { result: "pass" };
const failed = (detail: string): Verdict => ({ result: "fail", detail });
const unresolved = (detail: string): Verdict => ({ result: "unresolved", detail });

const list = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const str = (v: Json | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
const int = (v: Json | undefined) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

/** The reference SDK's rule: by id when both have one, else by name and website (both present). */
export function merchantMatches(allowed: JsonObject, candidate: JsonObject): boolean {
  const a = str(allowed.id);
  const c = str(candidate.id);
  if (a && c) return a === c;
  return !!str(candidate.name) && !!str(candidate.website) && candidate.name === allowed.name && candidate.website === allowed.website;
}

// ── Line items: exact max-flow assignment ────────────────────────────────

export interface Requirement {
  /** Revealed acceptable item ids. Empty matches nothing. */
  acceptable: Set<string>;
  quantity: number;
}

/**
 * Max flow from requirements to cart items (spec graph): source -> requirement (its quantity) ->
 * matching item (unbounded) -> sink (cart quantity of that id). Edmonds-Karp on integers.
 */
export function lineItemsFlow(requirements: Requirement[], cart: Map<string, number>): { flow: number; required: number; inCart: number } {
  const skus = [...cart.keys()];
  const n = 2 + requirements.length + skus.length;
  const src = 0;
  const sink = n - 1;
  const cap: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  requirements.forEach((r, i) => {
    cap[src]![1 + i] = r.quantity;
    skus.forEach((s, j) => {
      if (r.acceptable.has(s)) cap[1 + i]![1 + requirements.length + j] = Number.MAX_SAFE_INTEGER;
    });
  });
  skus.forEach((s, j) => (cap[1 + requirements.length + j]![sink] = cart.get(s)!));

  let flow = 0;
  for (;;) {
    const parent = new Array<number>(n).fill(-1);
    parent[src] = src;
    const queue = [src];
    while (queue.length && parent[sink] === -1) {
      const u = queue.shift()!;
      for (let v = 0; v < n; v++) if (parent[v] === -1 && cap[u]![v]! > 0) (parent[v] = u), queue.push(v);
    }
    if (parent[sink] === -1) break;
    let push = Number.MAX_SAFE_INTEGER;
    for (let v = sink; v !== src; v = parent[v]!) push = Math.min(push, cap[parent[v]!]![v]!);
    for (let v = sink; v !== src; v = parent[v]!) {
      cap[parent[v]!]![v]! -= push;
      cap[v]![parent[v]!]! += push;
    }
    flow += push;
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return { flow, required: sum(requirements.map((r) => r.quantity)), inCart: sum([...cart.values()]) };
}

const lineItems: Evaluator<CheckoutContext> = (c, { checkout }) => {
  const reqs = list(c.items);
  if (!reqs.length) return failed("no line item requirements");
  const requirements: Requirement[] = [];
  for (const r of reqs) {
    const q = int(r.quantity);
    if (q === undefined || q <= 0) return failed(`requirement ${JSON.stringify(r.id ?? null)} has no positive quantity`);
    requirements.push({ acceptable: new Set(list(r.acceptable_items).map((i) => str(i.id)).filter((x) => x !== undefined)), quantity: q });
  }
  const cart = new Map<string, number>();
  for (const li of list(checkout.line_items)) {
    const id = isObject(li.item) ? str(li.item.id) : undefined;
    const q = int(li.quantity);
    if (!id || q === undefined || q < 0) return failed("a checkout line item has no item id or quantity");
    if (q > 0) cart.set(id, (cart.get(id) ?? 0) + q);
  }
  if (!cart.size) return failed("the checkout is empty");
  const f = lineItemsFlow(requirements, cart);
  if (f.flow === f.required && f.flow === f.inCart) return pass;
  const unmatched = [...cart.keys()].filter((id) => !requirements.some((r) => r.acceptable.has(id)));
  if (unmatched.length) return failed(`not allowed by the mandate: ${unmatched.join(", ")}`);
  if (f.inCart > f.flow) return failed(`the cart has ${f.inCart} units; the mandate allows ${f.flow} of them`);
  return failed(`the mandate requires ${f.required} units; the cart supplies ${f.flow}`);
};

const allowedMerchants: Evaluator<CheckoutContext> = (c, { checkout }) => {
  const m = checkout.merchant;
  if (!isObject(m)) return failed("the checkout names no merchant");
  return list(c.allowed).some((a) => merchantMatches(a, m)) ? pass : failed(`merchant ${JSON.stringify(m.name ?? m.id ?? null)} is not allowed`);
};

// ── Payment ───────────────────────────────────────────────────────────────

const amountOf = (closed: JsonObject) => {
  const a = closed.payment_amount;
  return isObject(a) && typeof a.currency === "string" && int(a.amount) !== undefined ? { amount: a.amount as number, currency: a.currency } : undefined;
};

const amountRange: Evaluator<PaymentContext> = (c, { closed }) => {
  const a = amountOf(closed);
  if (!a) return failed("payment_amount is missing");
  if (str(c.currency) && a.currency !== c.currency) return failed(`currency ${a.currency}, mandate allows ${String(c.currency)}`);
  if (int(c.min) !== undefined && a.amount < (c.min as number)) return failed(`amount ${a.amount} is below the minimum ${String(c.min)}`);
  if (int(c.max) !== undefined && a.amount > (c.max as number)) return failed(`amount ${a.amount} exceeds the maximum ${String(c.max)}`);
  return pass;
};

const allowedPayees: Evaluator<PaymentContext> = (c, { closed }) => {
  const p = closed.payee;
  if (!isObject(p)) return failed("payee is missing");
  return list(c.allowed).some((a) => merchantMatches(a, p)) ? pass : failed(`payee ${JSON.stringify(p.name ?? p.id ?? null)} is not allowed`);
};

const allowedInstruments: Evaluator<PaymentContext> = (c, { closed }) => {
  const i = closed.payment_instrument;
  if (!isObject(i) || !str(i.id)) return failed("payment_instrument is missing");
  return list(c.allowed).some((a) => a.id === i.id) ? pass : failed(`payment instrument ${String(i.id)} is not allowed`);
};

const allowedPisps: Evaluator<PaymentContext> = (c, { closed }) => {
  const p = closed.pisp;
  if (!isObject(p)) return failed("pisp is missing");
  const same = (a: JsonObject) => a.legal_name === p.legal_name && a.brand_name === p.brand_name && a.domain_name === p.domain_name;
  return list(c.allowed).some(same) ? pass : failed(`PISP ${JSON.stringify(p.domain_name ?? null)} is not allowed`);
};

const reference: Evaluator<PaymentContext> = (c, { checkoutReferences }) => {
  if (!checkoutReferences) return unresolved("payment.reference needs the checkout chain it refers to");
  return checkoutReferences.includes(c.conditional_transaction_id as string) ? pass : failed("the checkout chain does not contain the referenced Open Checkout Mandate");
};

/** Currencies whose minor unit is the major unit; the budget's major-unit `max` would be ambiguous. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

const budget: Evaluator<PaymentContext> = (c, { closed, usage }) => {
  const a = amountOf(closed);
  if (!a) return failed("payment_amount is missing");
  if (a.currency !== c.currency) return failed(`budget is in ${String(c.currency)}, payment in ${a.currency}`);
  if (typeof c.max !== "number" || c.max < 0) return failed("budget max is not a number");
  if (ZERO_DECIMAL.has(a.currency)) return unresolved(`budget in ${a.currency} is ambiguous: max is in major units`);
  if (!usage) return unresolved("budget needs the mandate ledger");
  if (usage.uses > 0 && usage.currency && usage.currency !== a.currency) return failed(`earlier payments were in ${usage.currency}`);
  // The spec's example ("max": 1000.00) and the reference SDK read max in major units.
  const maxMinor = Math.round(c.max * 100);
  const total = usage.totalMinor + a.amount;
  return total <= maxMinor ? pass : failed(`spend would reach ${total} of a ${maxMinor} budget`);
};

/** Start of the UTC period containing `t`, for one-presentation-per-period recurrence. */
export function periodStart(t: number, frequency: string): number | undefined {
  const d = new Date(t * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const monday = day - ((d.getUTCDay() + 6) % 7) * 86400;
  switch (frequency) {
    case "ON_DEMAND":
      return undefined;
    case "DAILY":
      return day;
    case "WEEKLY":
      return monday;
    case "BIWEEKLY": {
      // Two-week blocks counted from Monday 1970-01-05.
      const epochMonday = 4 * 86400;
      return monday - (Math.floor((monday - epochMonday) / 604800) % 2) * 604800;
    }
    case "MONTHLY":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    case "QUARTERLY":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCMonth() % 3), 1) / 1000;
    case "ANNUALLY":
      return Date.UTC(d.getUTCFullYear(), 0, 1) / 1000;
    default:
      return Number.NaN;
  }
}

const agentRecurrence: Evaluator<PaymentContext> = (c, { usage, now }) => {
  if (!usage) return unresolved("recurrence needs the mandate ledger");
  const max = int(c.max_occurrences);
  if (max !== undefined && usage.uses >= max) return failed(`already used ${usage.uses} of ${max} times`);
  const start = periodStart(now, String(c.frequency));
  if (Number.isNaN(start)) return failed(`unknown frequency ${JSON.stringify(c.frequency ?? null)}`);
  if (start !== undefined && usage.lastUsedAt !== undefined && usage.lastUsedAt >= start)
    return failed(`already used this ${String(c.frequency).toLowerCase()} period`);
  return pass;
};

const executionDate: Evaluator<PaymentContext> = (c, { closed, now }) => {
  const raw = closed.execution_date;
  const at = raw === undefined ? now * 1000 : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(at)) return failed("execution_date is not an ISO 8601 date");
  for (const [k, cmp] of [
    ["not_before", (b: number) => at >= b],
    ["not_after", (b: number) => at <= b],
  ] as const) {
    const bound = c[k];
    if (bound === undefined) continue;
    const b = typeof bound === "string" ? Date.parse(bound) : Number.NaN;
    if (Number.isNaN(b)) return unresolved(`${k} is not an ISO 8601 date`);
    if (!cmp(b)) return failed(`execution ${raw === undefined ? "now" : String(raw)} is outside the window (${k} ${String(bound)})`);
  }
  return pass;
};

const CHECKOUT: Record<string, Evaluator<CheckoutContext>> = {
  "checkout.line_items": lineItems,
  "checkout.allowed_merchants": allowedMerchants,
};
const PAYMENT: Record<string, Evaluator<PaymentContext>> = {
  "payment.amount_range": amountRange,
  "payment.allowed_payees": allowedPayees,
  "payment.allowed_payment_instruments": allowedInstruments,
  "payment.allowed_pisps": allowedPisps,
  "payment.reference": reference,
  "payment.budget": budget,
  "payment.agent_recurrence": agentRecurrence,
  "payment.execution_date": executionDate,
};

/** Extension point: a constraint type outside the AP2 namespace (ADR-0023 names ours `x-secondkey.*`). */
export function registerConstraint(kind: "checkout", type: string, e: Evaluator<CheckoutContext>): void;
export function registerConstraint(kind: "payment", type: string, e: Evaluator<PaymentContext>): void;
export function registerConstraint(kind: "checkout" | "payment", type: string, e: Evaluator<any>): void {
  if (/^(checkout|payment)\./.test(type)) throw new Error(`${type} is in the AP2 namespace`);
  (kind === "checkout" ? CHECKOUT : PAYMENT)[type] = e;
}

function run<C>(registry: Record<string, Evaluator<C>>, open: JsonObject, ctx: C, hop?: number): ConstraintResult[] {
  return list(open.constraints).map((c) => {
    const type = typeof c.type === "string" ? c.type : "(no type)";
    const e = Object.hasOwn(registry, type) ? registry[type] : undefined;
    const v = e ? e(c, ctx) : unresolved(`unknown constraint type ${type}`);
    return { type, ...v, ...(hop === undefined ? {} : { hop }) };
  });
}

export function evaluateCheckoutConstraints(open: JsonObject, ctx: CheckoutContext, hop?: number): ConstraintResult[] {
  return run(CHECKOUT, open, ctx, hop);
}

const PRESET = ["payee", "payment_amount", "payment_instrument", "pisp", "execution_date"] as const;

/**
 * Claims pre-set in the Open Payment Mandate must arrive unchanged in the closed one (spec
 * processing rule 2), followed by each constraint. Recurrence needs amount_range and budget.
 */
export function evaluatePaymentConstraints(open: JsonObject, ctx: PaymentContext, hop?: number): ConstraintResult[] {
  const out: ConstraintResult[] = [];
  const at = hop === undefined ? {} : { hop };
  for (const k of PRESET) {
    if (open[k] === undefined) continue;
    const same = k === "payee" && isObject(open[k]) && isObject(ctx.closed[k]) ? merchantMatches(open[k], ctx.closed[k]) : canonicalize(open[k]) === canonicalize(ctx.closed[k]);
    out.push({ type: `preset.${k}`, ...(same ? pass : failed(`${k} differs from the value set in the open mandate`)), ...at });
  }
  const types = list(open.constraints).map((c) => c.type);
  if (types.includes("payment.agent_recurrence"))
    for (const needed of ["payment.amount_range", "payment.budget"])
      if (!types.includes(needed)) out.push({ type: "payment.agent_recurrence", ...failed(`recurrence requires ${needed}`), ...at });
  return [...out, ...run(PAYMENT, open, ctx, hop)];
}
