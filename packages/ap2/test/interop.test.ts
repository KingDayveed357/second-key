// Mandates built by Google's AP2 reference SDK (Python), regenerated with interop/sdk_vectors.py.
// The SDK verified each chain itself before writing it, so a failure here is ours.

import { importJWK } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import v from "./vectors/python-sdk.json" with { type: "json" };
import { crossCheck, verifyMandate, type JsonObject, type VerifyKey } from "../src/index.ts";
import { editDisclosures } from "./fixtures.ts";

let issuer: VerifyKey;
let merchant: VerifyKey;
beforeAll(async () => {
  issuer = await importJWK(v.issuer_jwk, "ES256");
  merchant = await importJWK(v.merchant_jwk, "ES256");
});

const checkoutOpts = () => ({
  rootKey: (h: JsonObject) => (h.kid === v.issuer_jwk.kid ? issuer : undefined),
  merchantKey: (h: JsonObject) => (h.kid === v.merchant_jwk.kid ? merchant : undefined),
  aud: "merchant",
  nonce: "n-checkout",
  now: v.created,
});

describe("mandates built by the AP2 reference SDK", () => {
  test.each(["checkout_chain", "checkout_chain_issuer_jwt_hash", "checkout_three_hop"] as const)("%s verifies", async (name) => {
    const r = await verifyMandate(v[name], checkoutOpts());
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checkout).toMatchObject({ hash: v.checkout_hash, merchantSignature: "verified" });
  });

  test("the bindings are the ones the SDK chose", async () => {
    const tight = await verifyMandate(v.checkout_chain, checkoutOpts());
    const loose = await verifyMandate(v.checkout_chain_issuer_jwt_hash, checkoutOpts());
    const three = await verifyMandate(v.checkout_three_hop, checkoutOpts());
    expect(tight.hops[1]!.binding!.claim).toBe("sd_hash");
    expect(loose.hops[1]!.binding!.claim).toBe("issuer_jwt_hash");
    expect(three.hops.map((h) => h.typ)).toEqual(["example+sd-jwt", "kb+sd-jwt+kb", "kb+sd-jwt"]);
  });

  test("the payment chain verifies and cross-checks against the checkout", async () => {
    const checkout = await verifyMandate(v.checkout_chain, checkoutOpts());
    const payment = await verifyMandate(v.payment_chain, { ...checkoutOpts(), aud: "credential-provider", nonce: "n-payment" });
    expect(payment.findings).toEqual([]);
    expect(crossCheck(payment, checkout)).toEqual([]);
  });

  test("tampering with an SDK-built chain is still caught", async () => {
    const reordered = editDisclosures(v.checkout_chain, 0, (ds) => [...ds].reverse());
    expect((await verifyMandate(reordered, checkoutOpts())).findings.map((f) => f.code)).toEqual(["binding_mismatch"]);
    expect((await verifyMandate(v.checkout_chain, { ...checkoutOpts(), nonce: "replayed" })).findings.map((f) => f.code)).toEqual(["nonce_mismatch"]);
  });
});
