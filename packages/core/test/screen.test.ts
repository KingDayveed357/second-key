import { describe, expect, test } from "vitest";
import { PolicyV1, resolveCart, screenCart, screenOutcome, type Check } from "../src/index.ts";
import { CTX, PINNED, POLICY, factsMap, req } from "./fixtures.ts";

function screen(policy: PolicyV1, productId: string, over: Parameters<typeof req>[1] = {}, ctx = CTX) {
  const r = req(productId, over);
  const ids = r.lines.map((l) => l.product_id);
  const { cart, checks } = resolveCart(r, factsMap(...ids.filter((id) => id !== "UNKNOWN")));
  const all: Check[] = cart ? [...checks, ...screenCart(policy, cart, ctx)] : checks;
  return { outcome: screenOutcome(all), checks: all, cart };
}
const failed = (checks: Check[]) => checks.filter((c) => c.result === "fail").map((c) => c.id);

describe("screening outcomes", () => {
  test("compliant cart proceeds", () => {
    const r = screen(POLICY, "TRL-GRY-10");
    expect(r.outcome).toBe("PROCEED");
    expect(r.cart?.total_cents).toBe(8400);
  });

  test("excluded colour with a marketing name is rejected", () => {
    const r = screen(POLICY, "TRL-WHT-10");
    expect(r.outcome).toBe("REJECT");
    expect(failed(r.checks)).toContain("color");
  });

  test("over budget is rejected", () => {
    expect(failed(screen(POLICY, "TRL-PRO-10").checks)).toContain("max_total");
  });

  test("a non-literal category match defers to the semantic check (never a silent pass)", () => {
    const r = screen(POLICY, "RD-BLU-10");
    expect(r.outcome).toBe("HOLD");
    expect(r.checks.find((c) => c.id === "category")).toMatchObject({ result: "unknown", defers_to: "ai.soft:category" });
  });

  test("missing size attribute holds, never proceeds", () => {
    expect(screen(POLICY, "TRL-NOSIZE").outcome).toBe("HOLD");
  });

  test("overpriced but within budget holds (market median check)", () => {
    const r = screen(POLICY, "TRL-PRICEY");
    expect(r.outcome).toBe("HOLD");
    expect(r.checks.find((c) => c.id === "market_price")?.result).toBe("unknown");
  });

  test("expired intent is rejected", () => {
    expect(failed(screen(POLICY, "TRL-GRY-10", {}, { ...CTX, now: new Date("2027-01-01T00:00:00Z") }).checks)).toContain("intent.not_expired");
  });

  test("intent with no purchases left is rejected (replay of the intent)", () => {
    expect(failed(screen(POLICY, "TRL-GRY-10", {}, { ...CTX, purchasesUsed: 1 }).checks)).toContain("intent.purchases_left");
  });

  test("unknown product facts are rejected before PayPal", () => {
    expect(failed(screen(POLICY, "UNKNOWN").checks)).toEqual(["facts.available"]);
  });
});

describe("early spike-validation findings", () => {
  test("T3: merchant substitution is rejected (retailer not allowed)", () => {
    const policy = PolicyV1.parse({ ...POLICY, retailers: ["backcountry.com"] });
    expect(failed(screen(policy, "TRL-GRY-10").checks)).toContain("retailer");
  });

  test("T3: a retailer without an offer for the product is rejected", () => {
    expect(failed(screen(POLICY, "TRL-WHT-10", { retailer: "backcountry.com" }).checks)).toContain("offer.available");
  });

  test("T3: unknown policy fields are an error, not silently ignored", () => {
    expect(() => PolicyV1.parse({ ...POLICY, merchant: "MERCHANT-A" })).toThrow();
  });

  test("T4a: product substitution with substitution=deny is rejected", () => {
    expect(failed(screen(PINNED, "TRL-BLK-10").checks)).toContain("product.allowed");
  });

  test("T4a: product substitution with substitution=hold asks the human", () => {
    const policy = PolicyV1.parse({ ...PINNED, substitution: "hold" });
    expect(screen(policy, "TRL-BLK-10").outcome).toBe("HOLD");
  });

  test("T4a: same-category substitution under the cap is allowed when the policy says so", () => {
    const policy = PolicyV1.parse({ ...PINNED, substitution: "same_category_under_max" });
    expect(screen(policy, "TRL-BLK-10").outcome).toBe("PROCEED");
  });

  test("T5: currency other than the policy currency is rejected", () => {
    const policy = PolicyV1.parse({ ...POLICY, currency: "EUR" });
    expect(failed(screen(policy, "TRL-GRY-10").checks)).toContain("currency");
  });

  test("X1: negative or zero quantities cannot even be expressed", async () => {
    const { PurchaseRequest } = await import("../src/index.ts");
    expect(PurchaseRequest.safeParse(req("TRL-GRY-10", { lines: [{ product_id: "TRL-GRY-10", quantity: -1 }] })).success).toBe(false);
    expect(PurchaseRequest.safeParse(req("TRL-GRY-10", { lines: [{ product_id: "TRL-GRY-10", quantity: 0 }] })).success).toBe(false);
    expect(PurchaseRequest.safeParse(req("TRL-GRY-10", { lines: [{ product_id: "TRL-GRY-10", quantity: 1.5 }] })).success).toBe(false);
  });

  test("X1: the negative-quantity trick from the audit (2 x A + -1 x B) is impossible", async () => {
    const { PurchaseRequest } = await import("../src/index.ts");
    const trick = req("TRL-BLK-10", {
      lines: [
        { product_id: "TRL-BLK-10", quantity: 2 },
        { product_id: "TRL-GRY-10", quantity: -1 },
      ],
    });
    expect(PurchaseRequest.safeParse(trick).success).toBe(false);
  });

  test("extra quantity is rejected", () => {
    const r = screen(PolicyV1.parse({ ...POLICY, max_total_cents: 50000 }), "TRL-GRY-10", { lines: [{ product_id: "TRL-GRY-10", quantity: 2 }] });
    expect(failed(r.checks)).toContain("quantity");
  });

  test("duplicate lines are rejected", () => {
    const r = screen(POLICY, "TRL-GRY-10", {
      lines: [
        { product_id: "TRL-GRY-10", quantity: 1 },
        { product_id: "TRL-GRY-10", quantity: 1 },
      ],
    });
    expect(failed(r.checks)).toContain("cart.duplicate_line");
  });

  test("several violations are all reported", () => {
    const policy = PolicyV1.parse({ ...POLICY, max_total_cents: 8000 });
    expect(new Set(failed(screen(policy, "TRL-WHT-10").checks))).toEqual(new Set(["max_total", "color"]));
  });
});

describe("policy schema", () => {
  test("requires products or a category", () => {
    const { category, ...rest } = POLICY;
    expect(PolicyV1.safeParse(rest).success).toBe(false);
  });

  test("normalises retailer domains", () => {
    expect(PolicyV1.parse({ ...POLICY, retailers: [" REI.com "] }).retailers).toEqual(["rei.com"]);
  });

  test("rejects non-domain retailers", () => {
    expect(PolicyV1.safeParse({ ...POLICY, retailers: ["MERCHANT-A"] }).success).toBe(false);
  });
});
