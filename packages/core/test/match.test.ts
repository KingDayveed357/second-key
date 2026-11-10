import { describe, expect, test } from "vitest";
import { authorizationDiffs, captureMatches, cartDigest, threeWayMatch, type MatchExpectation } from "../src/index.ts";

const PAYEE = "7L6D422CPFA9Q";
const exp: MatchExpectation = {
  order_id: "ORDER-1",
  currency: "USD",
  amount_cents: 8400,
  payee_merchant_id: PAYEE,
  items: [{ sku: "TRL-GRY-10", quantity: 1, unit_cents: 8400 }],
};

// Shaped like GET /v2/checkout/orders/{id} (see spikes/out evidence from Stage 1).
function order(over: { items?: unknown[]; amount?: string; currency?: string; payee?: string; breakdown?: Record<string, unknown>; units?: number; id?: string; auth?: Record<string, unknown> | null } = {}) {
  const currency = over.currency ?? "USD";
  const amount = over.amount ?? "84.00";
  const unit = {
    reference_id: "pur_1",
    payee: { merchant_id: over.payee ?? PAYEE, email_address: "sb-x@business.example.com" },
    amount: { currency_code: currency, value: amount, breakdown: over.breakdown ?? { item_total: { currency_code: currency, value: amount } } },
    items: over.items ?? [{ name: "Ridgeline Trail Runner", sku: "TRL-GRY-10", quantity: "1", unit_amount: { currency_code: currency, value: "84.00" } }],
    payments:
      over.auth === null
        ? undefined
        : { authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currency_code: currency, value: amount }, ...over.auth }] },
  };
  return { id: over.id ?? "ORDER-1", status: "COMPLETED", purchase_units: Array.from({ length: over.units ?? 1 }, () => unit) };
}

describe("three-way match", () => {
  test("exact match has no differences", () => {
    expect(threeWayMatch(exp, order())).toEqual([]);
    expect(authorizationDiffs(exp, order(), "AUTH-1")).toEqual([]);
  });

  test("cart swap at the same price is caught (Gate 3)", () => {
    const d = threeWayMatch(exp, order({ items: [{ name: "White", sku: "TRL-WHT-10", quantity: "1", unit_amount: { currency_code: "USD", value: "84.00" } }] }));
    expect(d).toEqual([
      "missing: approved SKU TRL-GRY-10 is not in PayPal's order",
      "unapproved: PayPal's order contains SKU TRL-WHT-10, which Second Key never approved",
    ]);
  });

  test("T6: a changed payee is caught", () => {
    expect(threeWayMatch(exp, order({ payee: "OTHERMERCHANT" }))).toContain("payee: expected 7L6D422CPFA9Q, PayPal has OTHERMERCHANT");
  });

  test("T6: amount, quantity and currency changes are caught", () => {
    expect(threeWayMatch(exp, order({ amount: "89.00" })).join()).toMatch(/amount/);
    expect(threeWayMatch(exp, order({ items: [{ sku: "TRL-GRY-10", quantity: "2", unit_amount: { currency_code: "USD", value: "84.00" } }] })).join()).toMatch(/quantity of TRL-GRY-10/);
    expect(threeWayMatch(exp, order({ currency: "EUR" })).join()).toMatch(/currency/);
  });

  test("X4: an extra purchase unit is caught", () => {
    expect(threeWayMatch(exp, order({ units: 2 }))).toContain("purchase_units: expected exactly 1, PayPal has 2");
  });

  test("hidden shipping or tax is caught even when items match", () => {
    const d = threeWayMatch(exp, order({ breakdown: { item_total: { currency_code: "USD", value: "84.00" }, shipping: { currency_code: "USD", value: "5.00" } } }));
    expect(d.join()).toMatch(/unapproved shipping/);
  });

  test("items without SKUs or with odd quantities are differences, never passes", () => {
    expect(threeWayMatch(exp, order({ items: [{ name: "x", quantity: "1", unit_amount: { currency_code: "USD", value: "84.00" } }] })).join()).toMatch(/without SKU/);
    expect(threeWayMatch(exp, order({ items: [{ sku: "TRL-GRY-10", quantity: "1.0", unit_amount: { currency_code: "USD", value: "84.00" } }] })).join()).toMatch(/unparseable/);
  });

  test("a different order ID is a difference", () => {
    expect(threeWayMatch(exp, order({ id: "ORDER-2" })).join()).toMatch(/order id/);
  });

  test("garbage input is a difference, not an exception", () => {
    expect(threeWayMatch(exp, { nope: true })).toEqual(["order: PayPal response did not have the expected shape"]);
    expect(threeWayMatch(exp, null)).toHaveLength(1);
  });

  test("authorization must exist, be CREATED and hold the approved amount", () => {
    expect(authorizationDiffs(exp, order({ auth: null }))).toHaveLength(1);
    expect(authorizationDiffs(exp, order({ auth: { status: "VOIDED" } })).join()).toMatch(/status: VOIDED/);
    expect(authorizationDiffs(exp, order({ auth: { amount: { currency_code: "USD", value: "96.60" } } })).join()).toMatch(/authorization amount/);
    expect(authorizationDiffs(exp, order(), "AUTH-OTHER").join()).toMatch(/authorization id/);
  });
});

describe("cart digest", () => {
  test("ignores line order and names; changes with SKU, quantity or price", () => {
    const a = cartDigest("USD", [
      { sku: "A", quantity: 1, unit_cents: 100 },
      { sku: "B", quantity: 2, unit_cents: 200 },
    ]);
    const b = cartDigest("USD", [
      { sku: "B", quantity: 2, unit_cents: 200 },
      { sku: "A", quantity: 1, unit_cents: 100 },
    ]);
    expect(a).toBe(b);
    expect(cartDigest("USD", [{ sku: "A", quantity: 1, unit_cents: 101 }, { sku: "B", quantity: 2, unit_cents: 200 }])).not.toBe(a);
    expect(cartDigest("EUR", [{ sku: "A", quantity: 1, unit_cents: 100 }, { sku: "B", quantity: 2, unit_cents: 200 }])).not.toBe(a);
  });
});

describe("captureMatches: payment success needs PayPal's capture, COMPLETED, for exactly the approved amount", () => {
  test.each([
    ["COMPLETED, exact amount and currency", { status: "COMPLETED", amount: { value: "84.00", currency_code: "USD" } }, true],
    ["COMPLETED, different amount", { status: "COMPLETED", amount: { value: "8.40", currency_code: "USD" } }, false],
    ["COMPLETED, different currency", { status: "COMPLETED", amount: { value: "84.00", currency_code: "EUR" } }, false],
    ["COMPLETED, no amount in the response", { status: "COMPLETED" }, false],
    ["PENDING, exact amount", { status: "PENDING", amount: { value: "84.00", currency_code: "USD" } }, false],
    ["malformed amount", { status: "COMPLETED", amount: { value: "84.0.0", currency_code: "USD" } }, false],
    ["nothing", undefined, false],
  ])("%s → %s", (_n, c, ok) => {
    expect(captureMatches(c, 8400, "USD")).toBe(ok);
  });
});
