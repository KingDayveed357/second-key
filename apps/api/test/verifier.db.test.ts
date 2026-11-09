// POST /v2/verifications against real Postgres: the ledger is global and atomic, receipts verify
// with the published JWKS, Idempotency-Key replays without double-counting, and every decision is
// in the audit chain.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { newId } from "@witness/core";
import { createApiKey, verifyChain } from "@witness/db";
import * as AP2 from "@witness/ap2";
import { disclose, loadReceiptSigner, MemoryLedger, presentHop, verifyReceipt } from "@witness/ap2";
import { exportJWK, generateKeyPair } from "jose";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";
import { PAYEE } from "../../../test-support/seed.ts";
import { checkoutFor, MERCHANT, NOW, openPaymentWith, OTHER_MERCHANT, payFor, world, type World } from "../../../packages/ap2/test/fixtures.ts";

let h: Harness;
let app: FastifyInstance;
let w: World;
const keys: Record<string, string> = {};
const ISS = "https://verifier.test";

beforeAll(async () => {
  h = await createHarness();
  w = await world();
  app = buildApp({ deps: { ...h.d, receipts: await loadReceiptSigner(ISS), now: () => new Date(NOW * 1000) } });
  await app.ready();
  keys.a = (await createApiKey(h.pool, h.tenantId, "merchant:a", ["ap2:verify"])).key;
  const other = newId("ten");
  await h.pool.query("INSERT INTO tenants (id, name, paypal_merchant_id) VALUES ($1, 'Second merchant', $2)", [other, PAYEE]);
  keys.b = (await createApiKey(h.pool, other, "merchant:b", ["ap2:verify"])).key;
  keys.ops = (await createApiKey(h.pool, h.tenantId, "ops", ["ops"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const trust = () => ({ issuers: { keys: [{ ...w.issuer.jwk, kid: "issuer-1" }] }, merchants: { keys: [{ ...w.merchant.jwk, kid: "merchant-1" }] } });
const body = (checkout: string, payment?: string, nonce = "n-checkout") => ({
  checkout: { mandate: checkout, aud: "merchant", nonce },
  ...(payment ? { payment: { mandate: payment, aud: "credential-provider", nonce: "n-payment" } } : {}),
  trust: trust(),
});
let seq = 0;
const verify = (payload: unknown, key = keys.a!, idem = `idem-${++seq}-${Date.now()}`) =>
  app.inject({ method: "POST", url: "/v2/verifications", headers: { authorization: `Bearer ${key}`, "idempotency-key": idem }, payload: payload as Record<string, unknown> });
const jwks = async () => (await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json();

describe("POST /v2/verifications", () => {
  test("a conforming presentation: decision, constraints, ledger and receipts that verify with the JWKS", async () => {
    const r = await verify(body(w.checkoutChain, w.paymentChain));
    expect(r.statusCode).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ decision: "CONFORMS", findings: [], checkout_hash: w.checkoutHash, merchant_signature: "verified" });
    expect(v.constraints.every((c: { result: string }) => c.result === "pass")).toBe(true);
    expect(v.ledger.map((e: { kind: string; uses_before: number }) => [e.kind, e.uses_before])).toEqual([
      ["open_checkout", 0],
      ["open_payment", 0],
    ]);
    const set = await jwks();
    expect(set.keys[0]).toMatchObject({ kid: v.receipts.kid, alg: "ES256", use: "sig" });
    expect(set.keys[0].d).toBeUndefined();
    for (const jwt of [v.receipts.checkout, v.receipts.payment]) expect(await verifyReceipt(jwt, set, ISS)).toMatchObject({ result: "success", "x-secondkey": { decision: "CONFORMS" } });
    expect(v.trusted_keys.issuers).toHaveLength(1);

    // The same open checkout, closed again for a second order: refused, with a signed error receipt.
    const again = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-again-1", iat: NOW });
    const second = (await verify(body(again, undefined, "n-again-1"))).json();
    expect(second).toMatchObject({ decision: "NONCONFORMING", error: "invalid_mandate" });
    expect(second.findings.map((f: { code: string }) => f.code)).toEqual(["ledger.open_mandate_reused"]);
    expect(await verifyReceipt(second.receipts.checkout, set)).toMatchObject({ result: "error", error: "invalid_mandate" });
  });

  test("Idempotency-Key: the same request replays the stored answer and counts once; a different request is refused", async () => {
    const c = await checkoutFor(w);
    const first = await verify(body(c.chain), keys.a, "idem-replay-1");
    const replay = await verify(body(c.chain), keys.a, "idem-replay-1");
    expect([first.statusCode, replay.statusCode]).toEqual([201, 200]);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().verification_id).toBe(first.json().verification_id);
    expect(replay.json().decision).toBe("CONFORMS");
    const other = await checkoutFor(w);
    expect((await verify(body(other.chain), keys.a, "idem-replay-1")).statusCode).toBe(422);
    const { rows } = await h.pool.query("SELECT uses FROM ap2_open_mandates WHERE ref = $1", [first.json().ledger[0].open_mandate]);
    expect(rows[0].uses).toBe(1);
  });

  test("the budget is global: a second merchant (tenant) spends from the same open payment mandate", async () => {
    const openCheckout = (await checkoutFor(w)).open;
    const open = await openPaymentWith(w, openCheckout, [
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 10 },
      { type: "payment.amount_range", currency: "USD", max: 40000 },
      { type: "payment.budget", max: 500, currency: "USD" },
      { type: "payment.allowed_payees", allowed: [disclose(MERCHANT), disclose(OTHER_MERCHANT)] },
    ]);
    const a = await checkoutFor(w, { open: openCheckout, price: 30000 });
    const b = await checkoutFor(w, { open: openCheckout, price: 25000, merchant: OTHER_MERCHANT });
    const atA = (await verify(body(a.chain, await payFor(w, open, a)), keys.a)).json();
    expect(atA.decision).toBe("CONFORMS");
    expect(atA.ledger.find((e: { kind: string }) => e.kind === "open_payment").budget_remaining_minor).toBe(20000);
    const atB = (await verify(body(b.chain, await payFor(w, open, b)), keys.b)).json();
    expect(atB.decision).toBe("NONCONFORMING");
    expect(atB.constraints.filter((c: { result: string }) => c.result === "fail").map((c: { type: string }) => c.type)).toEqual(["payment.budget"]);
  });

  test("concurrent presentations against one budget: exactly one conforms", async () => {
    const openCheckout = (await checkoutFor(w)).open;
    const open = await openPaymentWith(w, openCheckout, [
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
      { type: "payment.amount_range", currency: "USD", max: 40000 },
      { type: "payment.budget", max: 400, currency: "USD" },
    ]);
    const cs = await Promise.all(Array.from({ length: 4 }, () => checkoutFor(w, { open: openCheckout, price: 30000 })));
    const pays = await Promise.all(cs.map((c) => payFor(w, open, c)));
    const rs = await Promise.all(cs.map((c, i) => verify(body(c.chain, pays[i]), i % 2 ? keys.a : keys.b)));
    expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    expect(rs.map((r) => r.json().decision).filter((d) => d === "CONFORMS")).toHaveLength(1);
  });

  test("an issuer the caller doesn't trust is invalid_credential, and is still answered with a signed receipt", async () => {
    const c = await checkoutFor(w);
    const stranger = { ...body(c.chain), trust: { issuers: { keys: [{ ...w.agent.jwk, kid: "issuer-1" }] } } };
    const v = (await verify(stranger)).json();
    expect(v).toMatchObject({ decision: "NONCONFORMING", error: "invalid_credential" });
    expect(v.findings[0].code).toBe("bad_signature");
    expect(await verifyReceipt(v.receipts.checkout, await jwks())).toMatchObject({ result: "error", error: "invalid_credential" });
  });

  test("requests: auth, scope, Idempotency-Key and body are checked first", async () => {
    expect((await app.inject({ method: "POST", url: "/v2/verifications", payload: body(w.checkoutChain) })).statusCode).toBe(401);
    expect((await verify(body(w.checkoutChain), keys.ops)).statusCode).toBe(403);
    const noKey = await app.inject({ method: "POST", url: "/v2/verifications", headers: { authorization: `Bearer ${keys.a}` }, payload: body(w.checkoutChain) });
    expect(noKey.statusCode).toBe(422);
    expect((await verify({ checkout: { mandate: w.checkoutChain, aud: "merchant" }, trust: trust() })).statusCode).toBe(422);
    expect((await verify({ ...body(w.checkoutChain), trust: { issuers: { keys: [{ kty: "RSA", n: "x", e: "AQAB" }] } } })).statusCode).toBe(422);
  });

  test("a verification is visible to its own tenant only, and every decision is in the audit chain", async () => {
    const c = await checkoutFor(w);
    const v = (await verify(body(c.chain), keys.a)).json();
    const get = (key: string) => app.inject({ method: "GET", url: `/v2/verifications/${v.verification_id}`, headers: { authorization: `Bearer ${key}` } });
    expect((await get(keys.a!)).json().verification_id).toBe(v.verification_id);
    expect((await get(keys.b!)).statusCode).toBe(404);
    const { rows } = await h.pool.query("SELECT payload FROM audit_log WHERE event_type = 'ap2.verified' AND payload->>'verification_id' = $1", [v.verification_id]);
    expect(rows[0].payload).toMatchObject({ decision: "CONFORMS", checkout_hash: c.hash });
    const client = await h.pool.connect();
    try {
      expect((await verifyChain(client)).valid).toBe(true);
    } finally {
      client.release();
    }
  });

  test("the in-memory and Postgres ledgers agree on the same sequence", async () => {
    const mem = new MemoryLedger();
    const { verifyPresentation } = await import("@witness/ap2");
    const openCheckout = (await checkoutFor(w)).open;
    const open = await openPaymentWith(w, openCheckout, [
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 2 },
      { type: "payment.amount_range", currency: "USD", max: 40000 },
      { type: "payment.budget", max: 1000, currency: "USD" },
    ]);
    const memDecisions: string[] = [];
    const pgDecisions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await checkoutFor(w, { open: openCheckout, price: 10000 });
      const pay = await payFor(w, open, c);
      const rootKey = () => w.issuer.publicKey;
      memDecisions.push(
        (await verifyPresentation({ checkout: { chain: c.chain, options: { rootKey, aud: "merchant", nonce: "n-checkout" } }, payment: { chain: pay, options: { rootKey, aud: "credential-provider", nonce: "n-payment" } }, now: NOW }, mem)).decision,
      );
      pgDecisions.push((await verify(body(c.chain, pay))).json().decision);
    }
    expect(pgDecisions).toEqual(memDecisions);
    expect(pgDecisions).toEqual(["CONFORMS", "CONFORMS", "NONCONFORMING"]);
  });
});

describe("txLedger locking", () => {
  test("a second transaction on the same open mandate waits for the first and sees its write", async () => {
    const { withTx } = await import("@witness/db");
    const { txLedger } = await import("@witness/engine");
    const ref = `open-${newId("t")}`;
    const verification = async (tx: { client: { query: (q: string, v: unknown[]) => Promise<unknown> } }) => {
      const id = newId("ver");
      await tx.client.query("INSERT INTO ap2_verifications (id, tenant_id, idempotency_key, request_hash, decision, response) VALUES ($1, $2, $1, 'h', 'CONFORMS', '{}')", [id, h.tenantId]);
      return id;
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstInside!: () => void;
    const firstIsInside = new Promise<void>((r) => (firstInside = r));
    const seenBySecond: number[] = [];

    const first = withTx(h.pool, async (tx) =>
      txLedger(tx, await verification(tx)).transact({ open: [ref], closed: [] }, async () => {
        firstInside();
        await held;
        return { value: null, record: { closed: [], opens: [{ ref, amountMinor: 100, currency: "USD" }], at: NOW } };
      }),
    );
    await firstIsInside;
    const second = withTx(h.pool, async (tx) =>
      txLedger(tx, await verification(tx)).transact({ open: [ref], closed: [] }, async ({ usage }) => {
        seenBySecond.push(usage.get(ref)?.uses ?? 0);
        return { value: null };
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const whileHeld = [...seenBySecond];
    release();
    await Promise.all([first, second]);
    expect(whileHeld).toEqual([]); // the second was blocked behind the first transaction's lock
    expect(seenBySecond).toEqual([1]);
  });
});

describe("Second Key's extension constraints through the API", () => {
  const { ITEM_ATTRIBUTES, COSIGN, closedMandateReference, signCosignature, verifyFactsAttestation, digest } = AP2;
  const shoeMandate = (w: World) => ({
    vct: "mandate.checkout.open.1",
    constraints: [
      { type: "checkout.line_items", items: [{ id: "shoe", acceptable_items: ["TRL-GRY-10", "TRL-WHT-10", "TRL-INJECT"].map((id) => disclose({ id, title: id })), quantity: 1 }] },
      { type: ITEM_ATTRIBUTES, rules: [{ attribute: "size", any_of: ["10"] }, { attribute: "color", none_of: ["white"] }] },
    ],
    cnf: { jwk: w.agent.jwk },
  });
  const shoe = async (sku: string, target = app) => {
    const c = await checkoutFor(w, { sku, mandate: shoeMandate(w) });
    return (await target.inject({ method: "POST", url: "/v2/verifications", headers: { authorization: `Bearer ${keys.a}`, "idempotency-key": `shoe-${sku}-${Math.random()}` }, payload: body(c.chain) })).json();
  };

  test("the white shoe: AP2-valid, but Second Key's own facts say Cloud White, so it is refused", async () => {
    const v = await shoe("TRL-WHT-10");
    expect(v.decision).toBe("NONCONFORMING");
    expect(v.constraints.find((c: { type: string }) => c.type === ITEM_ATTRIBUTES)).toMatchObject({ result: "fail", detail: "color: 'Cloud White' is excluded (TRL-WHT-10)" });
    const facts = await verifyFactsAttestation(v.facts_attestation, await jwks(), NOW);
    expect(facts[0]).toMatchObject({ product_id: "TRL-WHT-10", attributes: { color: "Cloud White" }, source: "fixture", listing_check: "clean" });
    expect((await verifyReceipt(v.receipts.checkout, await jwks()))["x-secondkey"]).toMatchObject({ facts_attestation: digest(v.facts_attestation) });
  });

  test("the grey shoe conforms; a listing that addresses agents can't be confirmed", async () => {
    expect((await shoe("TRL-GRY-10")).decision).toBe("CONFORMS");
    const injected = await shoe("TRL-INJECT");
    expect(injected.decision).toBe("CANNOT_CONFIRM");
    expect(injected.constraints.find((c: { type: string }) => c.type === ITEM_ATTRIBUTES).detail).toMatch(/raised a concern/);
  });

  test("with no AI available, the grey shoe is CANNOT_CONFIRM, never a pass", async () => {
    const noAi = buildApp({ deps: { ...h.d, ai: undefined, receipts: await loadReceiptSigner(ISS), now: () => new Date(NOW * 1000) } });
    await noAi.ready();
    try {
      const v = await shoe("TRL-GRY-10", noAi);
      expect(v.decision).toBe("CANNOT_CONFIRM");
      expect(v.constraints.find((c: { type: string }) => c.type === ITEM_ATTRIBUTES).detail).toMatch(/was unavailable/);
    } finally {
      await noAi.close();
    }
  });

  test("co-signature: COSIGN_REQUIRED names what to sign; the enrolled key's signature then conforms", async () => {
    const sarah = await generateKeyPair("ES256", { extractable: true });
    const openCheckout = (await checkoutFor(w)).open;
    const open = await openPaymentWith(w, openCheckout, [
      { type: "payment.amount_range", currency: "USD", max: 100000 },
      { type: COSIGN, cosigner: { name: "Sarah", jwk: await exportJWK(sarah.publicKey) }, when: { amount_over: 50000, currency: "USD" } },
    ]);
    const c = await checkoutFor(w, { open: openCheckout, price: 80000 });
    const pay = await payFor(w, open, c);
    const first = (await verify(body(c.chain, pay))).json();
    expect(first).toMatchObject({ decision: "COSIGN_REQUIRED", error: "unresolved_constraint", cosign: { reference: closedMandateReference(pay) } });
    const signed = body(c.chain, pay);
    (signed.payment as Record<string, unknown>).cosignatures = [await signCosignature(sarah.privateKey, first.cosign.reference, NOW)];
    expect((await verify(signed)).json().decision).toBe("CONFORMS");
  });
});
