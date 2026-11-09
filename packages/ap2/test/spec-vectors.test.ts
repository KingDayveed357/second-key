// The encoded example tokens published in the AP2 v0.2 docs (provenance in the fixture).
// Their root issuer key is not published, so root signatures are out of reach; everything else
// (disclosures, KB-hop signatures under the open mandate's cnf key, bindings, hash links,
// schemas) is checked here against bytes we did not produce.

import { importJWK } from "jose";
import { describe, expect, test } from "vitest";
import vectors from "./vectors/spec-examples.json" with { type: "json" };
import {
  applyDisclosures,
  checkBinding,
  cnfJwkOf,
  digest,
  openHop,
  parseSdJwt,
  sdAlgOf,
  sdHash,
  splitChain,
  validateSchema,
  VCT,
  type JsonObject,
  type ParsedSdJwt,
} from "../src/index.ts";

const resolve = (t: ParsedSdJwt) => applyDisclosures(t.payload, t.disclosures, sdAlgOf(t.payload));
const itemOf = (t: ParsedSdJwt) => (resolve(t).delegate_payload as JsonObject[])[0]!;
const TOKENS = ["open_checkout", "closed_checkout", "checkout_chain", "open_payment", "closed_payment", "payment_chain"] as const;

describe("AP2 v0.2 spec examples", () => {
  test("every example parses and every disclosure is referenced exactly once", () => {
    for (const name of TOKENS) for (const hop of splitChain(vectors[name])) expect(() => resolve(hop)).not.toThrow();
  });

  test("each mandate has the expected type and matches the canonical schema", () => {
    const cases = [
      ["open_checkout", VCT.openCheckout, "open_checkout_mandate"],
      ["closed_checkout", VCT.checkout, "checkout_mandate"],
      ["open_payment", VCT.openPayment, "open_payment_mandate"],
      ["closed_payment", VCT.payment, "payment_mandate"],
    ] as const;
    for (const [name, vct, schema] of cases) {
      const item = itemOf(parseSdJwt(vectors[name]));
      expect(item.vct).toBe(vct);
      expect(validateSchema(schema, item)).toEqual([]);
    }
  });

  test.each(["checkout_chain", "payment_chain"] as const)("%s: the KB hop verifies under the open mandate's cnf key and binds by sd_hash", async (name) => {
    const [open, closed] = splitChain(vectors[name]) as [ParsedSdJwt, ParsedSdJwt];
    const claims = resolve(open);
    const jwk = cnfJwkOf({ claims, items: claims.delegate_payload as JsonObject[] })!;
    const hop = await openHop(closed, await importJWK(jwk, "ES256"), 1, false);
    expect(checkBinding(hop.claims, open, 1)).toEqual({ claim: "sd_hash", value: closed.payload.sd_hash });
    expect(hop.items).toHaveLength(1);
  });

  test("a KB hop does not verify under any other key", async () => {
    const [, closed] = splitChain(vectors.checkout_chain) as [ParsedSdJwt, ParsedSdJwt];
    const other = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" };
    await expect(openHop(closed, await importJWK(other, "ES256"), 1, false)).rejects.toMatchObject({ code: "bad_signature" });
  });

  test("checkout_hash recomputes from checkout_jwt, and the payment chain points at this checkout", () => {
    const closedCheckoutHop = splitChain(vectors.checkout_chain)[1]!;
    const closedCheckout = itemOf(closedCheckoutHop);
    const hash = digest(closedCheckout.checkout_jwt as string, sdAlgOf(closedCheckoutHop.payload));
    expect(hash).toBe(closedCheckout.checkout_hash);

    const [openPaymentHop, closedPaymentHop] = splitChain(vectors.payment_chain) as [ParsedSdJwt, ParsedSdJwt];
    expect(itemOf(closedPaymentHop).transaction_id).toBe(hash);
    const ref = (itemOf(openPaymentHop).constraints as JsonObject[]).find((c) => c.type === "payment.reference")!;
    expect(ref.conditional_transaction_id).toBe(sdHash(splitChain(vectors.checkout_chain)[0]!));
  });

  test("the standalone closed tokens are the chain's KB hops", () => {
    expect(splitChain(vectors.checkout_chain)[1]!.canonical).toBe(vectors.closed_checkout);
    expect(splitChain(vectors.payment_chain)[1]!.canonical).toBe(vectors.closed_payment);
  });
});
