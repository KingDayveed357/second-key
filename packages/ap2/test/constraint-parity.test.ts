// The same constraint cases through @witness/ap2 and through Google's reference SDK
// (interop/sdk_vectors.py constraints). Where the SDK differs, the case names the spec text we follow.

import { beforeAll, describe, expect, test } from "vitest";
import cases from "./constraint-cases.json" with { type: "json" };
import sdk from "./vectors/python-sdk-constraints.json" with { type: "json" };
import { disclose, evaluateCheckoutConstraints, evaluatePaymentConstraints, issueSdJwt, MemoryLedger, presentHop, verifyPresentation, VCT, digest, type JsonObject } from "../src/index.ts";
import { checkoutOpts, checkoutPayload, NOW, signCheckout, world, type World } from "./fixtures.ts";

type Case = (typeof cases.cases)[number] & { checkout?: JsonObject; closed?: JsonObject; usage?: { uses: number; totalMinor: number; lastUsedAt?: number }; open_checkout_hash?: string; divergence?: string };
const SDK = sdk as Record<string, { result: string; violations: string[] }>;

const ours = (c: Case) => {
  const r =
    c.kind === "checkout"
      ? evaluateCheckoutConstraints(c.open as JsonObject, { checkout: c.checkout! })
      : evaluatePaymentConstraints(c.open as JsonObject, { closed: c.closed!, usage: c.usage, checkoutReferences: c.open_checkout_hash ? [c.open_checkout_hash] : undefined, now: cases.now } as never);
  return r.some((x) => x.result === "fail") ? "fail" : r.some((x) => x.result === "unresolved") ? "unresolved" : "pass";
};

describe("constraint parity with the reference SDK", () => {
  test.each((cases.cases as Case[]).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(ours(c)).toBe(c.ours);
    if (c.divergence) expect(SDK[c.name]!.result, c.divergence).not.toBe(c.ours);
    else expect(SDK[c.name]!.result).toBe(c.ours);
  });

  test("the SDK agrees on every case not documented as a divergence (4 of 15 diverge)", () => {
    expect((cases.cases as Case[]).filter((c) => c.divergence).length).toBe(4);
  });
});

describe("withholding acceptable_items, end to end", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  test("the reference SDK accepts a closed checkout for a product the user never authorised", () => {
    expect(SDK["e2e: holder withholds acceptable_items, buys another SKU"]).toMatchObject({ result: "pass", violations: [], disclosures_dropped: 1 });
  });

  test("we refuse the same move", async () => {
    const open = await issueSdJwt({
      key: w.issuer.privateKey,
      kid: "issuer-1",
      claims: {
        delegate_payload: [
          disclose({ vct: VCT.openCheckout, constraints: [{ type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [disclose({ id: "sku_gold_9", title: "SuperShoe Gold" })], quantity: 1 }] }], cnf: { jwk: w.agent.jwk } }),
        ],
      },
    });
    const [jwt, ...ds] = open.split("~").filter(Boolean);
    const withheld = [jwt, ...ds.filter((d) => !Buffer.from(d, "base64url").toString().includes("sku_gold_9")), ""].join("~");
    const payload = checkoutPayload(25000);
    ((payload.line_items as JsonObject[])[0]!.item as JsonObject).id = "sku_white_9";
    const checkoutJwt = await signCheckout(w.merchant.privateKey, payload);
    const chain = await presentHop({ chain: withheld, key: w.agent.privateKey, mandate: { vct: VCT.checkout, checkout_jwt: disclose(checkoutJwt), checkout_hash: digest(checkoutJwt) }, aud: "merchant", nonce: "n-checkout", iat: NOW });
    const v = await verifyPresentation({ checkout: { chain, options: checkoutOpts(w) }, now: NOW }, new MemoryLedger());
    expect(v.decision).toBe("NONCONFORMING");
    expect(v.constraints).toEqual([{ type: "checkout.line_items", result: "fail", detail: "not allowed by the mandate: sku_white_9", hop: 0 }]);
  });
});
