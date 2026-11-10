// The Second Key capture gate: deterministic policy checks, a cart digest that binds
// an approval to one exact cart, and the three-way match against PayPal's order.
// No AI here on purpose: the money boundary must work even if every model is wrong.

import { createHash } from "node:crypto";

const cents = (v) => Math.round(Number(v) * 100);

/** Decisions are named after the PayPal action they cause. */
export const Decision = Object.freeze({ CAPTURE: "CAPTURE", HOLD: "HOLD", VOID: "VOID" });

/**
 * Deterministic checks of a cart against a structured policy.
 * Any failure -> VOID. Any missing attribute the policy depends on -> HOLD.
 */
export function evaluateCart(policy, cart) {
  const checks = [];
  const add = (id, result, detail) => checks.push({ id, result, detail });

  if (cart.currency !== policy.currency) {
    add("currency", "fail", `cart is ${cart.currency}, policy requires ${policy.currency}`);
  } else {
    add("currency", "pass", cart.currency);
  }

  const total = cart.items.reduce((s, i) => s + cents(i.unit_amount) * i.quantity, 0);
  if (policy.max_total !== undefined) {
    const max = cents(policy.max_total);
    add("max_total", total <= max ? "pass" : "fail", `${(total / 100).toFixed(2)} vs max ${(max / 100).toFixed(2)}`);
  }

  if (policy.quantity !== undefined) {
    const qty = cart.items.reduce((s, i) => s + i.quantity, 0);
    add("quantity", qty === policy.quantity ? "pass" : "fail", `${qty} vs required ${policy.quantity}`);
  }

  for (const item of cart.items) {
    const attrs = item.attributes ?? {};

    if (policy.size !== undefined) {
      if (attrs.size === undefined) add(`size:${item.sku}`, "unknown", "listing has no size attribute");
      else add(`size:${item.sku}`, String(attrs.size) === String(policy.size) ? "pass" : "fail", `${attrs.size} vs ${policy.size}`);
    }

    if (policy.excluded_colors?.length) {
      if (attrs.color === undefined) {
        add(`color:${item.sku}`, "unknown", "listing has no color attribute");
      } else {
        const bad = policy.excluded_colors.some((c) => attrs.color.toLowerCase().includes(c.toLowerCase()));
        add(`color:${item.sku}`, bad ? "fail" : "pass", `${attrs.color} vs excluded ${policy.excluded_colors.join(", ")}`);
      }
    }

    if (policy.category !== undefined) {
      if (attrs.category === undefined) add(`category:${item.sku}`, "unknown", "listing has no category");
      else add(`category:${item.sku}`, attrs.category === policy.category ? "pass" : "fail", `${attrs.category} vs ${policy.category}`);
    }
  }

  const decision = checks.some((c) => c.result === "fail")
    ? Decision.VOID
    : checks.some((c) => c.result === "unknown")
      ? policy.on_ambiguity === "void" ? Decision.VOID : Decision.HOLD
      : Decision.CAPTURE;

  return { decision, checks, total: (total / 100).toFixed(2) };
}

/** Canonical form of the money-relevant parts of a cart: SKU, quantity, unit price, currency. */
export function canonicalCart(cart) {
  return {
    currency: cart.currency,
    items: cart.items
      .map((i) => ({ sku: i.sku, quantity: Number(i.quantity), unit_amount: cents(i.unit_amount) }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
  };
}

export function cartDigest(cart) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonicalCart(cart))).digest("hex");
}

/** Rebuild the cart from PayPal's own record of the order. This is the ground truth. */
export function cartFromPayPalOrder(order) {
  const pu = order.purchase_units?.[0] ?? {};
  return {
    currency: pu.amount?.currency_code,
    amount: pu.amount?.value,
    items: (pu.items ?? []).map((i) => ({
      sku: i.sku ?? `(no sku) ${i.name}`,
      name: i.name,
      quantity: Number(i.quantity),
      unit_amount: i.unit_amount?.value,
    })),
  };
}

/**
 * Three-way match: what Second Key approved vs what PayPal actually authorized.
 * Returns a list of human-readable differences; empty means an exact match.
 */
export function threeWayMatch(approval, paypalOrder) {
  const actual = cartFromPayPalOrder(paypalOrder);
  const diffs = [];
  const approved = new Map(canonicalCart(approval.cart).items.map((i) => [i.sku, i]));
  const authorized = new Map(canonicalCart(actual).items.map((i) => [i.sku, i]));

  if (actual.currency !== approval.cart.currency) diffs.push(`currency: approved ${approval.cart.currency}, PayPal has ${actual.currency}`);
  if (cents(actual.amount) !== cents(approval.amount)) diffs.push(`amount: approved ${approval.amount}, PayPal authorized ${actual.amount}`);

  for (const [sku, a] of approved) {
    const p = authorized.get(sku);
    if (!p) diffs.push(`missing: approved SKU ${sku} is not in PayPal's order`);
    else {
      if (p.quantity !== a.quantity) diffs.push(`quantity of ${sku}: approved ${a.quantity}, PayPal has ${p.quantity}`);
      if (p.unit_amount !== a.unit_amount) diffs.push(`price of ${sku}: approved ${a.unit_amount / 100}, PayPal has ${p.unit_amount / 100}`);
    }
  }
  for (const sku of authorized.keys()) {
    if (!approved.has(sku)) diffs.push(`unapproved: PayPal's order contains SKU ${sku}, which Second Key never approved`);
  }
  if (cartDigest(actual) !== approval.cartDigest && diffs.length === 0) diffs.push("cart digest differs");
  return diffs;
}

/** An approval binds a decision to one exact cart, amount and policy version. */
export function approve(policy, cart, evaluation) {
  if (evaluation.decision !== Decision.CAPTURE) {
    throw new Error(`Cannot issue an approval for a ${evaluation.decision} decision.`);
  }
  return Object.freeze({
    policyVersion: policy.version ?? 1,
    cart: structuredClone(cart),
    cartDigest: cartDigest(cart),
    amount: evaluation.total,
    currency: cart.currency,
    issuedAt: new Date().toISOString(),
  });
}

/**
 * The invariant: nothing captures unless an approval exists for the exact cart and
 * amount PayPal authorized. Returns the capture amount, or throws.
 */
export function assertCapturable(approval, paypalOrder) {
  if (!approval) throw new GateRefusal(["no Second Key approval exists for this order"]);
  const diffs = threeWayMatch(approval, paypalOrder);
  if (diffs.length) throw new GateRefusal(diffs);
  return { currency_code: approval.currency, value: approval.amount };
}

export class GateRefusal extends Error {
  constructor(reasons) {
    super(`Capture refused: ${reasons.join("; ")}`);
    this.reasons = reasons;
  }
}
