import { describe, expect, test } from "vitest";
import {
  evaluateCheckoutConstraints,
  evaluatePaymentConstraints,
  lineItemsFlow,
  merchantMatches,
  periodStart,
  registerConstraint,
  type JsonObject,
  type Requirement,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 5, 12) / 1000; // Thu 5 Nov 2026, 12:00 UTC

const checkout = (items: [string, number][], merchant: JsonObject = { id: "m1", name: "Shop" }): JsonObject => ({
  merchant,
  line_items: items.map(([id, quantity], i) => ({ id: `li_${i}`, item: { id, title: id, price: 100 }, quantity, totals: [] })),
});
const lineItems = (...reqs: [string[], number][]) => ({
  constraints: [{ type: "checkout.line_items", items: reqs.map(([ids, quantity], i) => ({ id: `r${i}`, acceptable_items: ids.map((id) => ({ id, title: id })), quantity })) }],
});
const results = (r: { type: string; result: string }[]) => r.map((x) => `${x.type}:${x.result}`);
const lineResult = (open: JsonObject, items: [string, number][]) => evaluateCheckoutConstraints(open, { checkout: checkout(items) })[0]!.result;

describe("checkout.line_items", () => {
  // The spec's own example: one shoe (red or blue) and one pair of socks.
  const spec = lineItems([["BAB1234", "FAF1234"], 1], [["QRT1234"], 1]);

  test.each([
    [[["BAB1234", 1], ["QRT1234", 1]], "pass"],
    [[["FAF1234", 1], ["QRT1234", 1]], "pass"],
    [[["BAB1234", 1], ["FAF1234", 1]], "fail"],
    [[["BAB1234", 1]], "fail"],
    [[["FAF1234", 1]], "fail"],
    [[["QRT1234", 1]], "fail"],
  ] as [[string, number][], string][])("spec example %j -> %s", (items, expected) => {
    expect(lineResult(spec, items)).toBe(expected);
  });

  test("a cart missing a required item fails (the reference SDK lets it pass)", () => {
    expect(lineResult(spec, [["BAB1234", 1]])).toBe("fail");
  });

  test("withheld acceptable_items match nothing (the reference SDK treats them as a wildcard)", () => {
    expect(lineResult(lineItems([[], 1]), [["anything", 1]])).toBe("fail");
  });

  test("quantities: exact, split across lines, too many, too few", () => {
    const two = lineItems([["A"], 2]);
    expect(lineResult(two, [["A", 2]])).toBe("pass");
    expect(lineResult(two, [["A", 1], ["A", 1]])).toBe("pass");
    expect(lineResult(two, [["A", 3]])).toBe("fail");
    expect(lineResult(two, [["A", 1]])).toBe("fail");
    expect(lineResult(two, [])).toBe("fail");
  });

  test("an assignment a greedy pass would miss", () => {
    // r0 accepts A or B, r1 accepts only A. Greedy A->r0 strands r1; the flow finds B->r0, A->r1.
    expect(lineResult(lineItems([["A", "B"], 1], [["A"], 1]), [["A", 1], ["B", 1]])).toBe("pass");
  });

  test("property: max flow agrees with brute-force assignment on random small instances", () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const SKUS = ["A", "B", "C"];
    const feasible = (reqs: Requirement[], cart: Map<string, number>): boolean => {
      // Assign each cart unit to a requirement with room; succeed when every unit is placed and every requirement is full.
      const units = [...cart].flatMap(([s, q]) => Array<string>(q).fill(s));
      const room = reqs.map((r) => r.quantity);
      const go = (i: number): boolean => {
        if (i === units.length) return room.every((x) => x === 0);
        for (let j = 0; j < reqs.length; j++)
          if (room[j]! > 0 && reqs[j]!.acceptable.has(units[i]!)) {
            room[j]!--;
            if (go(i + 1)) return true;
            room[j]!++;
          }
        return false;
      };
      return go(0);
    };
    for (let t = 0; t < 600; t++) {
      const reqs: Requirement[] = Array.from({ length: 1 + rnd(3) }, () => ({ acceptable: new Set(SKUS.filter(() => rnd(2) === 1)), quantity: 1 + rnd(3) }));
      const cart = new Map<string, number>();
      for (const s of SKUS) if (rnd(2)) cart.set(s, 1 + rnd(3));
      const f = lineItemsFlow(reqs, cart);
      expect(f.flow === f.required && f.flow === f.inCart, JSON.stringify({ reqs: reqs.map((r) => [[...r.acceptable], r.quantity]), cart: [...cart] })).toBe(feasible(reqs, cart));
    }
  });

  test("large quantities stay exact and fast", () => {
    const f = lineItemsFlow([{ acceptable: new Set(["A"]), quantity: 1_000_000 }], new Map([["A", 1_000_000]]));
    expect(f).toEqual({ flow: 1_000_000, required: 1_000_000, inCart: 1_000_000 });
  });
});

describe("checkout.allowed_merchants and merchant matching", () => {
  test("by id when both have one, else name and website", () => {
    expect(merchantMatches({ id: "m1", name: "x" }, { id: "m1", name: "y" })).toBe(true);
    expect(merchantMatches({ id: "m1" }, { id: "m2", name: "Shop" })).toBe(false);
    expect(merchantMatches({ name: "Shop", website: "https://s" }, { name: "Shop", website: "https://s" })).toBe(true);
    expect(merchantMatches({ name: "Shop" }, { name: "Shop" })).toBe(false);
  });

  test("the checkout merchant must be allowed", () => {
    const open = { constraints: [{ type: "checkout.allowed_merchants", allowed: [{ id: "m1", name: "Shop" }] }] };
    expect(evaluateCheckoutConstraints(open, { checkout: checkout([["A", 1]]) })[0]!.result).toBe("pass");
    expect(evaluateCheckoutConstraints(open, { checkout: checkout([["A", 1]], { id: "evil", name: "Shop" }) })[0]!.result).toBe("fail");
    expect(evaluateCheckoutConstraints({ constraints: [{ type: "checkout.allowed_merchants", allowed: [] }] }, { checkout: checkout([["A", 1]]) })[0]!.result).toBe("fail");
  });
});

describe("payment constraints", () => {
  const closed = (o: JsonObject = {}): JsonObject => ({
    payee: { id: "m1", name: "Shop" },
    payment_amount: { amount: 19900, currency: "USD" },
    payment_instrument: { id: "pi_1", type: "paypal" },
    ...o,
  });
  const evalP = (constraints: unknown[], o: { closed?: JsonObject; usage?: { uses: number; totalMinor: number; lastUsedAt?: number }; refs?: string[]; now?: number; open?: JsonObject } = {}) =>
    evaluatePaymentConstraints({ constraints, ...o.open } as JsonObject, { closed: o.closed ?? closed(), usage: o.usage, checkoutReferences: o.refs, now: o.now ?? NOW } as never);

  test("amount_range: currency, min, max", () => {
    const r = { type: "payment.amount_range", currency: "USD", max: 20000, min: 100 };
    expect(results(evalP([r]))).toEqual(["payment.amount_range:pass"]);
    expect(results(evalP([r], { closed: closed({ payment_amount: { amount: 20001, currency: "USD" } }) }))).toEqual(["payment.amount_range:fail"]);
    expect(results(evalP([r], { closed: closed({ payment_amount: { amount: 99, currency: "USD" } }) }))).toEqual(["payment.amount_range:fail"]);
    expect(results(evalP([r], { closed: closed({ payment_amount: { amount: 19900, currency: "EUR" } }) }))).toEqual(["payment.amount_range:fail"]);
  });

  test("allowed payees, instruments and PISPs", () => {
    expect(evalP([{ type: "payment.allowed_payees", allowed: [{ id: "m2", name: "Other" }] }])[0]!.result).toBe("fail");
    expect(evalP([{ type: "payment.allowed_payment_instruments", allowed: [{ id: "pi_1", type: "paypal" }] }])[0]!.result).toBe("pass");
    expect(evalP([{ type: "payment.allowed_payment_instruments", allowed: [{ id: "pi_2", type: "card" }] }])[0]!.result).toBe("fail");
    const pisp = { legal_name: "P Ltd", brand_name: "P", domain_name: "p.example" };
    expect(evalP([{ type: "payment.allowed_pisps", allowed: [pisp] }], { closed: closed({ pisp }) })[0]!.result).toBe("pass");
    expect(evalP([{ type: "payment.allowed_pisps", allowed: [pisp] }])[0]!.result).toBe("fail");
  });

  test("reference: needs the checkout chain, and must be in it", () => {
    const r = { type: "payment.reference", conditional_transaction_id: "ref-1" };
    expect(evalP([r])[0]!.result).toBe("unresolved");
    expect(evalP([r], { refs: ["x", "ref-1"] })[0]!.result).toBe("pass");
    expect(evalP([r], { refs: ["x"] })[0]!.result).toBe("fail");
  });

  test("budget: major units, cumulative, currency-bound, needs the ledger", () => {
    const b = { type: "payment.budget", max: 500, currency: "USD" };
    expect(evalP([b])[0]!.result).toBe("unresolved");
    expect(evalP([b], { usage: { uses: 1, totalMinor: 30100 } })[0]!.result).toBe("pass"); // 301 + 199 = 500
    expect(evalP([b], { usage: { uses: 1, totalMinor: 30101 } })[0]!.result).toBe("fail");
    expect(evalP([{ ...b, currency: "EUR" }], { usage: { uses: 0, totalMinor: 0 } })[0]!.result).toBe("fail");
    // 0.29 * 100 is 28.999…; the budget is 29 cents, not 28.
    expect(evalP([{ ...b, max: 0.29 }], { closed: closed({ payment_amount: { amount: 29, currency: "USD" } }), usage: { uses: 0, totalMinor: 0 } })[0]!.result).toBe("pass");
    expect(evalP([{ ...b, currency: "JPY" }], { closed: closed({ payment_amount: { amount: 100, currency: "JPY" } }), usage: { uses: 0, totalMinor: 0 } })[0]!.result).toBe("unresolved");
  });

  test("recurrence: occurrences, one per period, and it requires amount_range and budget", () => {
    const rec = { type: "payment.agent_recurrence", frequency: "MONTHLY", max_occurrences: 3 };
    const full = [rec, { type: "payment.amount_range", currency: "USD", max: 20000 }, { type: "payment.budget", max: 1000, currency: "USD" }];
    const lastMonth = Date.UTC(2026, 9, 20) / 1000;
    const earlierThisMonth = Date.UTC(2026, 10, 1, 9) / 1000;
    expect(evalP(full, { usage: { uses: 2, totalMinor: 0, lastUsedAt: lastMonth } }).every((r) => r.result === "pass")).toBe(true);
    expect(evalP(full, { usage: { uses: 3, totalMinor: 0, lastUsedAt: lastMonth } })[0]!.result).toBe("fail");
    expect(evalP(full, { usage: { uses: 1, totalMinor: 0, lastUsedAt: earlierThisMonth } })[0]!.result).toBe("fail");
    expect(results(evalP([rec], { usage: { uses: 0, totalMinor: 0 } }))).toEqual(["payment.agent_recurrence:fail", "payment.agent_recurrence:fail", "payment.agent_recurrence:pass"]);
  });

  test("UTC periods", () => {
    expect(periodStart(NOW, "DAILY")).toBe(Date.UTC(2026, 10, 5) / 1000);
    expect(periodStart(NOW, "WEEKLY")).toBe(Date.UTC(2026, 10, 2) / 1000); // Monday
    expect(periodStart(NOW, "MONTHLY")).toBe(Date.UTC(2026, 10, 1) / 1000);
    expect(periodStart(NOW, "QUARTERLY")).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(periodStart(NOW, "ANNUALLY")).toBe(Date.UTC(2026, 0, 1) / 1000);
    const bi = periodStart(NOW, "BIWEEKLY")!;
    expect([Date.UTC(2026, 10, 2) / 1000, Date.UTC(2026, 9, 26) / 1000]).toContain(bi);
    expect(periodStart(bi + 13 * 86400, "BIWEEKLY")).toBe(bi);
    expect(periodStart(bi + 14 * 86400, "BIWEEKLY")).toBe(bi + 14 * 86400);
    expect(periodStart(NOW, "ON_DEMAND")).toBeUndefined();
  });

  test("execution_date: absent means now", () => {
    const window = { type: "payment.execution_date", not_before: "2026-11-01", not_after: "2026-11-30" };
    expect(evalP([window])[0]!.result).toBe("pass");
    expect(evalP([window], { now: Date.UTC(2026, 11, 2) / 1000 })[0]!.result).toBe("fail");
    expect(evalP([window], { closed: closed({ execution_date: "2026-12-01" }) })[0]!.result).toBe("fail");
    expect(evalP([window], { closed: closed({ execution_date: "soon" }) })[0]!.result).toBe("fail");
  });

  test("claims pre-set in the open mandate must arrive unchanged", () => {
    const open = { payment_amount: { amount: 19900, currency: "USD" }, payee: { id: "m1", name: "Shop" } };
    expect(results(evalP([], { open }))).toEqual(["preset.payee:pass", "preset.payment_amount:pass"]);
    expect(results(evalP([], { open, closed: closed({ payment_amount: { currency: "USD", amount: 19901 } }) }))).toEqual(["preset.payee:pass", "preset.payment_amount:fail"]);
    expect(results(evalP([], { open, closed: closed({ payee: { id: "m9", name: "Shop" } }) }))[0]).toBe("preset.payee:fail");
  });
});

describe("unknown and extension constraints", () => {
  test("an unknown constraint is unresolved, never a pass", () => {
    expect(results(evaluateCheckoutConstraints({ constraints: [{ type: "com.example.mystery" }] }, { checkout: checkout([["A", 1]]) }))).toEqual(["com.example.mystery:unresolved"]);
    expect(results(evaluateCheckoutConstraints({ constraints: [{ type: "constructor" }] }, { checkout: checkout([["A", 1]]) }))).toEqual(["constructor:unresolved"]);
  });

  test("extensions register outside the AP2 namespace only", () => {
    expect(() => registerConstraint("checkout", "checkout.line_items", () => ({ result: "pass" }))).toThrow();
    registerConstraint("checkout", "x-test.always.1", () => ({ result: "pass" }));
    expect(results(evaluateCheckoutConstraints({ constraints: [{ type: "x-test.always.1" }] }, { checkout: checkout([]) }))).toEqual(["x-test.always.1:pass"]);
  });
});
