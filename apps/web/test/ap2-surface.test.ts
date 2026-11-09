// The browser's mandate issuer must produce exactly what @witness/ap2 verifies: signatures,
// disclosures, AP2's canonical schemas, and the payment -> checkout reference.

import { describe, expect, test } from "vitest";
import type { CryptoKey } from "jose";
import { parseSdJwt, sdHash, verifyMandate, type JsonObject } from "@witness/ap2";
import { roseMandates, sha256b64url, thumbprint, type Ap2Setup } from "../lib/ap2-surface.ts";

const setup: Ap2Setup = {
  agent: { jwk: { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" } },
  merchant: { id: "demo-trail-shop", name: "Demo Trail Shop", website: "https://shop.secondkey.example" },
  products: [
    { id: "TRL-GRY-10", title: "Ridgeline Trail Runner, Slate Grey, US 10", price_cents: 8400, color: "Slate Grey" },
    { id: "TRL-WHT-10", title: "Ridgeline Trail Runner, Cloud White, US 10", price_cents: 8400, color: "Cloud White" },
    { id: "TRL-PRO-10", title: "Summit Pro Carbon Trail, Graphite, US 10", price_cents: 48000, color: "Graphite" },
  ],
};

describe("Rose's device issues AP2 open mandates", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = await thumbprint({ kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! });
  const m = await roseMandates(setup, pair.privateKey, kid, 1_800_000_000);
  const opts = { rootKey: (h: JsonObject) => (h.kid === kid ? pair.publicKey : undefined), now: 1_800_000_000 };

  test("both verify under her device key and match AP2's canonical schemas", async () => {
    for (const t of [m.openCheckout, m.openPayment]) expect((await verifyMandate(t, opts)).findings).toEqual([]);
  });

  test("the open checkout lists the Ridgeline family only, and carries 'not white' as Second Key's constraint", async () => {
    const v = await verifyMandate(m.openCheckout, opts);
    const c = v.mandates[0]!.value.constraints as JsonObject[];
    expect(((c[0]!.items as JsonObject[])[0]!.acceptable_items as JsonObject[]).map((i) => i.id)).toEqual(["TRL-GRY-10", "TRL-WHT-10"]);
    expect(c[2]).toEqual({ type: "x-secondkey.item_attributes.1", rules: [{ attribute: "size", any_of: ["10"] }, { attribute: "color", none_of: ["white"] }] });
    expect(v.mandates[0]!.value.cnf).toEqual({ jwk: setup.agent.jwk });
  });

  test("the payment mandate names the open checkout by its sd_hash, as the verifier computes it", async () => {
    const v = await verifyMandate(m.openPayment, opts);
    const ref = (v.mandates[0]!.value.constraints as JsonObject[]).find((c) => c.type === "payment.reference")!;
    expect(ref.conditional_transaction_id).toBe(sdHash(parseSdJwt(m.openCheckout)));
  });

  test("digests and thumbprints match the server's byte conventions", async () => {
    expect(await sha256b64url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});
