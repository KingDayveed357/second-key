// Every exported template must be a valid starting point: its standard constraints match AP2's
// canonical schemas, and its Second Key constraints are well-formed for our evaluators.

import { describe, expect, test } from "vitest";
import { evaluateCheckoutConstraints, evaluatePaymentConstraints, validateSchema, type JsonObject } from "@witness/ap2";
import { TEMPLATES, templateFile } from "../lib/ap2-templates.ts";

const standardOnly = (cs: unknown[]) => (cs as JsonObject[]).filter((c) => /^(checkout|payment)\./.test(String(c.type)));
const cnf = { jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } };

describe("constraint templates", () => {
  test.each(TEMPLATES.map((t) => [t.id, t] as const))("%s matches AP2's canonical schemas", (_id, t) => {
    expect(validateSchema("open_checkout_mandate", { ...t.open_checkout, constraints: standardOnly(t.open_checkout.constraints), cnf })).toEqual([]);
    expect(validateSchema("open_payment_mandate", { ...t.open_payment, constraints: standardOnly(t.open_payment.constraints), cnf })).toEqual([]);
  });

  test.each(TEMPLATES.map((t) => [t.id, t] as const))("%s: every constraint type is one an evaluator knows, none malformed", (_id, t) => {
    const checkout = evaluateCheckoutConstraints(t.open_checkout as unknown as JsonObject, { checkout: { line_items: [{ item: { id: "<sku>" }, quantity: 1 }], merchant: { id: "<merchant id>" } }, facts: {} });
    const payment = evaluatePaymentConstraints(t.open_payment as unknown as JsonObject, {
      closed: { payee: { id: "<merchant id>" }, payment_amount: { amount: 100, currency: "USD" }, payment_instrument: { id: "pi" } },
      usage: { uses: 0, totalMinor: 0 },
      checkoutReferences: [],
      now: 1_800_000_000,
    });
    for (const r of [...checkout, ...payment]) {
      expect(r.detail ?? "", `${r.type}`).not.toMatch(/unknown constraint type|malformed/);
    }
  });

  test("the downloaded file is JSON with both mandates and the notes", () => {
    for (const t of TEMPLATES) expect(JSON.parse(templateFile(t))).toMatchObject({ template: t.id, open_checkout: t.open_checkout, open_payment: t.open_payment, notes: t.notes });
  });
});
