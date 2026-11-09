import { CompactSign } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import {
  applyDisclosures,
  crossCheck,
  digest,
  disclose,
  issueSdJwt,
  joinChain,
  parseSdJwt,
  presentHop,
  sdHash,
  verifyChain,
  verifyMandate,
  verifyPresentation,
  MemoryLedger,
  VCT,
  type JsonObject,
} from "../src/index.ts";
import {
  checkoutOpts,
  checkoutPayload,
  decodeDisclosure,
  editDisclosures,
  editPayload,
  encodeDisclosure,
  keyPair,
  NOW,
  openCheckoutMandate,
  paymentOpts,
  signCheckout,
  world,
  type World,
} from "./fixtures.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);
const rejects = async (chain: string, opts: Parameters<typeof verifyChain>[1], code: string) =>
  expect(verifyChain(chain, opts)).rejects.toMatchObject({ code });

describe("a well-formed chain", () => {
  test("checkout and payment chains verify, and point at each other", async () => {
    const checkout = await verifyMandate(w.checkoutChain, checkoutOpts(w));
    const payment = await verifyMandate(w.paymentChain, paymentOpts(w));
    expect(checkout).toMatchObject({ ok: true, replayChecked: true, checkout: { hash: w.checkoutHash, merchantSignature: "verified" } });
    expect(checkout.mandates.map((m) => m.kind)).toEqual(["open_checkout", "checkout"]);
    expect(checkout.hops[1]!.binding).toEqual({ claim: "sd_hash", value: sdHash(parseSdJwt(w.openCheckout)) });
    expect(payment).toMatchObject({ ok: true });
    expect(payment.mandates.map((m) => m.kind)).toEqual(["open_payment", "payment"]);
    expect(crossCheck(payment, checkout)).toEqual([]);
  });

  test("undisclosed array elements are dropped and disclosed ones resolved", async () => {
    const [open] = await verifyChain(w.checkoutChain, checkoutOpts(w));
    const allowed = (open!.items[0]!.constraints as JsonObject[])[1]!.allowed;
    expect(allowed).toEqual([{ id: "merchant_1", name: "Demo Merchant", website: "https://demo-merchant.example" }]);
    const withoutMerchant = editDisclosures(w.openCheckout + "~~", 0, (ds) => ds.filter((d) => !JSON.stringify(decodeDisclosure(d)).includes("merchant_1")));
    const [hop] = await verifyChain(withoutMerchant.slice(0, -2), checkoutOpts(w));
    expect((hop!.items[0]!.constraints as JsonObject[])[1]!.allowed).toEqual([]);
  });

  test("an open mandate can be re-delegated to a sub-agent before it is closed", async () => {
    const sub = await keyPair();
    const reDelegated = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: openCheckoutMandate(sub), aud: "sub-agent", nonce: "n-sub", iat: NOW });
    const closed = await presentHop({ chain: reDelegated, key: sub.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout", iat: NOW });
    const r = await verifyMandate(closed, checkoutOpts(w));
    expect(r.ok).toBe(true);
    expect(r.hops.map((h) => h.typ)).toEqual(["example+sd-jwt", "kb+sd-jwt+kb", "kb+sd-jwt"]);
    // The sub-agent's hop must be signed by the sub-agent's key, not the first agent's.
    const forged = await presentHop({ chain: reDelegated, key: w.agent.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout", iat: NOW });
    await rejects(forged, checkoutOpts(w), "bad_signature");
  });

  test("issuer_jwt_hash lets a later holder drop the previous hop's disclosures; sd_hash does not", async () => {
    const loose = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout", hashMode: "issuer_jwt_hash", iat: NOW });
    const dropMerchant = (c: string) => editDisclosures(c, 0, (ds) => ds.filter((d) => !JSON.stringify(decodeDisclosure(d)).includes("merchant_1")));
    expect((await verifyMandate(dropMerchant(loose), checkoutOpts(w))).ok).toBe(true);
    await rejects(dropMerchant(w.checkoutChain), checkoutOpts(w), "binding_mismatch");
  });
});

describe("keys and signatures", () => {
  test("an unknown root issuer is refused", async () => {
    await rejects(w.checkoutChain, { ...checkoutOpts(w), rootKey: () => undefined }, "root_key_unavailable");
  });

  test("a root signed by another key is refused", async () => {
    const other = await keyPair();
    await rejects(w.checkoutChain, { ...checkoutOpts(w), rootKey: () => other.publicKey }, "bad_signature");
  });

  test("a closed mandate signed by anyone but the agent bound in cnf is refused", async () => {
    const thief = await keyPair();
    const forged = await presentHop({ chain: w.openCheckout, key: thief.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout", iat: NOW });
    await rejects(forged, checkoutOpts(w), "bad_signature");
  });

  test("tampering with any signed claim of any hop breaks its signature", async () => {
    for (const [hop, keys] of [
      [0, ["delegate_payload", "_sd_alg"]],
      [1, ["delegate_payload", "iat", "aud", "nonce", "sd_hash", "_sd_alg"]],
    ] as const) {
      for (const k of keys) {
        const tampered = editPayload(w.checkoutChain, hop, (p) => {
          p[k] = k === "delegate_payload" ? [{ "...": digest("forged") }] : k === "_sd_alg" ? "sha-256 " : k === "iat" ? NOW - 1 : "forged";
        });
        await expect(verifyChain(tampered, checkoutOpts(w)), `hop ${hop} ${k}`).rejects.toMatchObject({ code: expect.stringMatching(/bad_signature|unsupported_sd_alg/) });
      }
    }
  });

  test("alg other than ES256, including none, is refused", async () => {
    for (const alg of ["none", "HS256", "ES384"]) {
      const [jwt, ...rest] = w.openCheckout.split("~") as [string, ...string[]];
      const [, p, s] = jwt.split(".");
      const header = Buffer.from(JSON.stringify({ alg, kid: "issuer-1" })).toString("base64url");
      await rejects([`${header}.${p}.${s}`, ...rest].join("~"), checkoutOpts(w), "unsupported_alg");
    }
  });

  test("a cnf that publishes the private key, or is not P-256, is refused", async () => {
    const priv = await issueSdJwt({
      key: w.issuer.privateKey,
      kid: "issuer-1",
      claims: { delegate_payload: [disclose(openCheckoutMandate(w.agent, { cnf: { jwk: { ...w.agent.jwk, d: "AAAA" } } }))] },
    });
    const c1 = await presentHop({ chain: priv, key: w.agent.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout", iat: NOW });
    await rejects(c1, checkoutOpts(w), "cnf_invalid");
    const rsa = await issueSdJwt({
      key: w.issuer.privateKey,
      kid: "issuer-1",
      claims: { delegate_payload: [disclose(openCheckoutMandate(w.agent, { cnf: { jwk: { kty: "RSA", n: "AQAB", e: "AQAB" } } }))] },
    });
    const c2 = await presentHop({ chain: rsa, key: w.agent.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout", iat: NOW });
    await rejects(c2, checkoutOpts(w), "cnf_invalid");
  });
});

describe("disclosures", () => {
  test("changing any disclosure of any hop is detected", async () => {
    for (const hop of [0, 1]) {
      const count = w.checkoutChain.split("~~")[hop]!.split("~").filter((d, i) => i > 0 && d).length;
      for (let i = 0; i < count; i++) {
        const tampered = editDisclosures(w.checkoutChain, hop, (ds) =>
          ds.map((d, j) => {
            if (j !== i) return d;
            const arr = decodeDisclosure(d);
            arr[0] = "another-salt-value";
            return encodeDisclosure(arr);
          }),
        );
        await expect(verifyChain(tampered, checkoutOpts(w)), `hop ${hop} disclosure ${i}`).rejects.toMatchObject({ code: "disclosure_unreferenced" });
      }
    }
  });

  test("swapping the merchant inside a disclosure is detected", async () => {
    const tampered = editDisclosures(w.checkoutChain, 0, (ds) =>
      ds.map((d) => {
        const arr = decodeDisclosure(d);
        return JSON.stringify(arr).includes("merchant_1") && arr.length === 2 ? encodeDisclosure([arr[0], { id: "merchant_evil", name: "Evil" }]) : d;
      }),
    );
    await rejects(tampered, checkoutOpts(w), "disclosure_unreferenced");
  });

  test("reordering the previous hop's disclosures breaks the sd_hash binding", async () => {
    await rejects(editDisclosures(w.checkoutChain, 0, (ds) => [...ds].reverse()), checkoutOpts(w), "binding_mismatch");
  });

  test("a repeated disclosure is refused", async () => {
    await rejects(editDisclosures(w.checkoutChain, 1, (ds) => [...ds, ds[0]!]), checkoutOpts(w), "disclosure_duplicate");
  });

  test("RFC 9901 processing rules", () => {
    const d = (arr: unknown[]) => encodeDisclosure(arr);
    const prop = d(["salt-1", "name", "Ann"]);
    const el = d(["salt-2", { a: 1 }]);
    expect(applyDisclosures({ _sd: [digest(prop)], list: [{ "...": digest(el) }, { "...": digest("undisclosed") }] }, [prop, el], "sha-256")).toEqual({ name: "Ann", list: [{ a: 1 }] });
    const reused = () => applyDisclosures({ list: [{ "...": digest(el) }, { "...": digest(el) }] }, [el], "sha-256");
    expect(reused).toThrow(expect.objectContaining({ code: "digest_reused" }));
    const collision = () => applyDisclosures({ name: "Bob", _sd: [digest(prop)] }, [prop], "sha-256");
    expect(collision).toThrow(expect.objectContaining({ code: "claim_collision" }));
    const sdName = d(["salt-3", "_sd", ["x"]]);
    expect(() => applyDisclosures({ _sd: [digest(sdName)] }, [sdName], "sha-256")).toThrow(expect.objectContaining({ code: "malformed_disclosure" }));
    const wrongShape = () => applyDisclosures({ _sd: [digest(el)] }, [el], "sha-256");
    expect(wrongShape).toThrow(expect.objectContaining({ code: "malformed_disclosure" }));
    const extraKeys = () => applyDisclosures({ list: [{ "...": digest(el), b: 2 }] }, [el], "sha-256");
    expect(extraKeys).toThrow(expect.objectContaining({ code: "malformed_token" }));
  });

  test("a trailing KB-JWT is not part of AP2 and is refused", async () => {
    await rejects(w.checkoutChain + "eyJh.eyJh.c2ln", checkoutOpts(w), "kb_jwt_unsupported");
  });
});

describe("hop rules", () => {
  async function hop(claims: Record<string, unknown>, typ = "kb+sd-jwt", key = w.agent.privateKey) {
    const t = await issueSdJwt({ key, typ, claims: { iat: NOW, aud: "merchant", nonce: "n-checkout", ...claims } });
    return joinChain([w.openCheckout, t]);
  }
  const closed = () => [disclose(w.closedCheckout)];
  const bind = () => sdHash(parseSdJwt(w.openCheckout));

  test("exactly one binding claim", async () => {
    await rejects(await hop({ delegate_payload: closed() }), checkoutOpts(w), "binding_missing");
    await rejects(await hop({ delegate_payload: closed(), sd_hash: bind(), issuer_jwt_hash: "x" }), checkoutOpts(w), "binding_missing");
    await rejects(await hop({ delegate_payload: closed(), sd_hash: digest("other") }), checkoutOpts(w), "binding_mismatch");
  });

  test("typ decides whether a hop may delegate further", async () => {
    await rejects(await hop({ delegate_payload: [disclose(openCheckoutMandate(w.agent))], sd_hash: bind() }, "kb+sd-jwt"), checkoutOpts(w), "cnf_forbidden");
    await rejects(await hop({ delegate_payload: closed(), sd_hash: bind() }, "kb+sd-jwt+kb"), checkoutOpts(w), "cnf_missing");
    await rejects(await hop({ delegate_payload: closed(), sd_hash: bind() }, "example+sd-jwt"), checkoutOpts(w), "typ_invalid");
  });

  test("every KB hop carries iat", async () => {
    const t = await issueSdJwt({ key: w.agent.privateKey, typ: "kb+sd-jwt", claims: { delegate_payload: closed(), aud: "merchant", nonce: "n-checkout", sd_hash: bind() } });
    await rejects(joinChain([w.openCheckout, t]), checkoutOpts(w), "iat_missing");
  });

  test("the root cannot be a KB-SD-JWT", async () => {
    const t = await issueSdJwt({ key: w.issuer.privateKey, kid: "issuer-1", typ: "kb+sd-jwt", claims: { delegate_payload: [disclose(openCheckoutMandate(w.agent))] } });
    await rejects(t, checkoutOpts(w), "typ_invalid");
  });

  test("intermediate hops carry exactly one mandate", async () => {
    const root = await issueSdJwt({ key: w.issuer.privateKey, kid: "issuer-1", claims: { delegate_payload: [disclose(openCheckoutMandate(w.agent)), disclose(openCheckoutMandate(w.agent))] } });
    await rejects(root, checkoutOpts(w), "delegate_payload_invalid");
  });

  test("audience and nonce are checked on the last hop", async () => {
    await rejects(w.checkoutChain, { ...checkoutOpts(w), aud: "another-merchant" }, "aud_mismatch");
    await rejects(w.checkoutChain, { ...checkoutOpts(w), nonce: "replayed" }, "nonce_mismatch");
    const r = await verifyMandate(w.checkoutChain, { ...checkoutOpts(w), aud: undefined, nonce: undefined });
    expect(r).toMatchObject({ ok: true, replayChecked: false });
  });

  test("time: exp and iat, with five minutes of skew", async () => {
    const exp = NOW + 3600;
    await expect(verifyChain(w.checkoutChain, { ...checkoutOpts(w), now: exp + 300 })).resolves.toHaveLength(2);
    await rejects(w.checkoutChain, { ...checkoutOpts(w), now: exp + 301 }, "expired");
    await rejects(w.checkoutChain, { ...checkoutOpts(w), now: NOW - 301 }, "not_yet_valid");
  });
});

describe("mandate checks", () => {
  test("checkout_hash must be the hash of checkout_jwt", async () => {
    const chain = await presentHop({
      chain: w.openCheckout,
      key: w.agent.privateKey,
      mandate: { ...w.closedCheckout, checkout_hash: digest(await signCheckout(w.merchant.privateKey, checkoutPayload(29900))) },
      aud: "merchant",
      nonce: "n-checkout",
      iat: NOW,
    });
    expect(codes(await verifyMandate(chain, checkoutOpts(w)))).toEqual(["checkout_hash_mismatch"]);
  });

  test("checkout_jwt must be signed by the merchant", async () => {
    const other = await keyPair();
    const jwt = await signCheckout(other.privateKey);
    const chain = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: { vct: VCT.checkout, checkout_jwt: disclose(jwt), checkout_hash: digest(jwt) }, aud: "merchant", nonce: "n-checkout", iat: NOW });
    const r = await verifyMandate(chain, checkoutOpts(w));
    expect(codes(r)).toEqual(["merchant_signature_invalid"]);
    expect((await verifyMandate(chain, { ...checkoutOpts(w), merchantKey: undefined })).checkout?.merchantSignature).toBe("not_checked");
  });

  test("the checkout itself must match the UCP schema", async () => {
    const bad = await new CompactSign(new TextEncoder().encode(JSON.stringify({ id: "chk_1" }))).setProtectedHeader({ alg: "ES256", kid: "merchant-1" }).sign(w.merchant.privateKey);
    const chain = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: { vct: VCT.checkout, checkout_jwt: disclose(bad), checkout_hash: digest(bad) }, aud: "merchant", nonce: "n-checkout", iat: NOW });
    expect(codes(await verifyMandate(chain, checkoutOpts(w)))).toContain("checkout_schema_invalid");
  });

  test("mandates must match their canonical schema and type", async () => {
    const { payee: _payee, ...noPayee } = w.closedPayment;
    const missing = await presentHop({ chain: w.openPayment, key: w.agent.privateKey, mandate: noPayee, aud: "credential-provider", nonce: "n-payment", iat: NOW });
    expect(codes(await verifyMandate(missing, paymentOpts(w)))).toEqual(["schema_invalid"]);
    const unknown = await presentHop({ chain: w.openPayment, key: w.agent.privateKey, mandate: { ...w.closedPayment, vct: "mandate.payment.2" }, aud: "credential-provider", nonce: "n-payment", iat: NOW });
    expect(codes(await verifyMandate(unknown, paymentOpts(w)))).toEqual(["unknown_vct"]);
  });

  test("an open checkout cannot be closed by a payment mandate", async () => {
    const chain = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: w.closedPayment, aud: "merchant", nonce: "n-checkout", iat: NOW });
    expect(codes(await verifyMandate(chain, checkoutOpts(w)))).toEqual(["chain_shape"]);
  });

  test("a payment for another checkout, or naming another open checkout, is caught", async () => {
    const checkout = await verifyMandate(w.checkoutChain, checkoutOpts(w));
    const elsewhere = await presentHop({ chain: w.openPayment, key: w.agent.privateKey, mandate: { ...w.closedPayment, transaction_id: digest("another checkout") }, aud: "credential-provider", nonce: "n-payment", iat: NOW });
    expect(crossCheck(await verifyMandate(elsewhere, paymentOpts(w)), checkout).map((f) => f.code)).toEqual(["transaction_id_mismatch"]);

    const otherOpen = await issueSdJwt({
      key: w.issuer.privateKey,
      kid: "issuer-1",
      claims: { delegate_payload: [disclose({ ...w.openPaymentMandate, constraints: [...w.openPaymentMandate.constraints.slice(0, 2), { type: "payment.reference", conditional_transaction_id: digest("x") }] })] },
    });
    const misref = await presentHop({ chain: otherOpen, key: w.agent.privateKey, mandate: w.closedPayment, aud: "credential-provider", nonce: "n-payment", iat: NOW });
    // Hash links hold; naming another open checkout is the payment.reference constraint's job.
    expect(crossCheck(await verifyMandate(misref, paymentOpts(w)), checkout)).toEqual([]);
    const v = await verifyPresentation({ checkout: { chain: w.checkoutChain, options: checkoutOpts(w) }, payment: { chain: misref, options: paymentOpts(w) }, now: NOW }, new MemoryLedger());
    expect(v.constraints.find((c) => c.type === "payment.reference")?.result).toBe("fail");
  });
});
