// Contract tests against real (sanitized) sandbox responses recorded in Stage 1.
// They prove the core parser and three-way match work on PayPal's actual shapes.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { authorizationDiffs, authorizationOf, capturesOf, threeWayMatch } from "@witness/core";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { status: number; data: any };
const PAYEE = "7L6D422CPFA9Q";

describe("recorded sandbox responses", () => {
  test("vault order: created and authorized in one call, with no buyer action (Gate 2)", () => {
    const { status, data } = fx("create-order-vault-authorized.json");
    expect(status).toBe(201);
    expect(data.status).toBe("COMPLETED");
    const auth = authorizationOf(data);
    expect(auth).toMatchObject({ id: "12H434938Y5759253", status: "CREATED", amount_cents: 8400, currency: "USD" });
  });

  test("the order status reads COMPLETED although no money has moved: only the authorization counts", () => {
    const { data } = fx("create-order-vault-authorized.json");
    expect(data.status).toBe("COMPLETED");
    expect(capturesOf(data)).toEqual([]);
  });

  test("non-vault order needs the buyer: PAYER_ACTION_REQUIRED, no authorization", () => {
    const { data } = fx("create-order-payer-action.json");
    expect(data.status).toBe("PAYER_ACTION_REQUIRED");
    expect(authorizationOf(data)).toBeNull();
  });

  test("an order that matches the approval has zero differences", () => {
    const { data } = fx("get-order-captured-flow.json");
    const exp = { order_id: data.id, currency: "USD", amount_cents: 8400, payee_merchant_id: PAYEE, items: [{ sku: "TRL-GRY-10", quantity: 1, unit_cents: 8400 }] };
    expect(threeWayMatch(exp, data)).toEqual([]);
    expect(authorizationDiffs(exp, data)).toEqual([]);
  });

  test("the recorded Gate 3 swap is caught on PayPal's own record", () => {
    const { data } = fx("get-order-swapped.json");
    const exp = { order_id: data.id, currency: "USD", amount_cents: 8400, payee_merchant_id: PAYEE, items: [{ sku: "TRL-GRY-10", quantity: 1, unit_cents: 8400 }] };
    expect(threeWayMatch(exp, data)).toEqual([
      "missing: approved SKU TRL-GRY-10 is not in PayPal's order",
      "unapproved: PayPal's order contains SKU TRL-WHT-10, which Second Key never approved",
    ]);
  });

  test("capture response and the 422 on a voided authorization have the shapes the executor expects", () => {
    const cap = fx("capture-completed.json");
    expect(cap.status).toBe(201);
    expect(cap.data).toMatchObject({ id: "536404883W4495032", status: "COMPLETED" });
    const voided = fx("capture-on-voided-422.json");
    expect(voided.status).toBe(422);
    expect(voided.data.details[0].issue).toBe("AUTHORIZATION_VOIDED");
  });
});

describe("minimal representations", () => {
  test("matching against a minimal create-order response is a difference, never a pass", () => {
    const { data } = fx("create-order-vault-authorized.json");
    const exp = { order_id: data.id, currency: "USD", amount_cents: 8400, payee_merchant_id: PAYEE, items: [{ sku: "TRL-GRY-10", quantity: 1, unit_cents: 8400 }] };
    expect(threeWayMatch(exp, data).join()).toMatch(/payee|amount: missing/);
  });
});
