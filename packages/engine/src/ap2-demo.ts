// The AP2 agent demo (8 Nov). Rose's own browser is the Trusted Surface: it holds her device key
// and signs the open mandates. This module plays the other parties, each with its own key: the
// demo shopping agent (bound in Rose's cnf, it closes the mandates) and the demo merchant (it signs
// the checkout). Then the real pipeline runs: POST /v2/verifications' engine, a vaulted PayPal
// sandbox order, settlement binding, and the executor in the worker. Which run does what is
// scripted and labelled as such; every verdict comes from the verifier and PayPal.

import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, CompactSign, type CryptoKey, type JWK } from "jose";
import { fixtureFacts } from "@witness/catalog";
import { newId, standardAdapter, swapAdapter, type ResolvedCart } from "@witness/core";
import { digest, disclose, ecThumbprint, MemoryLedger, presentHop, signFactsAttestation, signMandateReceipt, verifyPresentation, VCT } from "@witness/ap2";
import { attestFacts, verifyAp2, type VerificationResponse } from "./ap2.ts";
import { bindSettlement, getSettlement, type SettlementView } from "./settlement.ts";
import type { EngineDeps, Principal } from "./deps.ts";

export const AP2_DEMO_MERCHANT = { id: "demo-trail-shop", name: "Demo Trail Shop", website: "https://shop.secondkey.example" };
export const AP2_DEMO_AUD = { checkout: "demo-trail-shop", payment: "secondkey-demo-psp" } as const;

/** The products the demo agent can put in the cart (synthetic, from the fixture catalog). */
export const AP2_DEMO_PRODUCTS = ["TRL-GRY-10", "TRL-WHT-10", "TRL-BLK-10", "TRL-PRO-10"] as const;

export type Ap2DemoRun = "conforms" | "steered" | "wrong_product" | "cart_swap" | "reused";

const RUNS: Record<Ap2DemoRun, { product: string; narration: string }> = {
  conforms: { product: "TRL-GRY-10", narration: "The agent picks the grey Ridgeline in size 10 from an ordinary page." },
  steered: { product: "TRL-PRO-10", narration: "A page tells the agent the $480 Summit Pro Carbon was pre-approved, and the agent believes it." },
  wrong_product: { product: "TRL-WHT-10", narration: "The agent picks the white Ridgeline. It is one of the three items Rose's mandate lists, so AP2's own checks accept it." },
  cart_swap: { product: "TRL-GRY-10", narration: "The agent's cart is right, but the merchant's checkout sends PayPal an order for the white shoe at the same price." },
  reused: { product: "TRL-GRY-10", narration: "The agent buys the shoe, then tries to use Rose's same open mandate for a second pair." },
};

interface Parties {
  agent: { privateKey: CryptoKey; jwk: JWK };
  merchant: { privateKey: CryptoKey; jwk: JWK };
}
let parties: Promise<Parties> | undefined;
/** The demo agent's and merchant's keys live for the process; Rose's setup is fetched per run. */
function demoParties(): Promise<Parties> {
  parties ??= (async () => {
    const [a, m] = [await generateKeyPair("ES256", { extractable: true }), await generateKeyPair("ES256", { extractable: true })];
    return {
      agent: { privateKey: a.privateKey, jwk: { ...(await exportJWK(a.publicKey)), kid: "demo-agent-1" } },
      merchant: { privateKey: m.privateKey, jwk: { ...(await exportJWK(m.publicKey)), kid: "demo-merchant-1" } },
    };
  })();
  return parties;
}

export async function ap2DemoSetup() {
  const p = await demoParties();
  const facts = fixtureFacts();
  return {
    agent: { jwk: p.agent.jwk, note: "The demo shopping agent's key. Rose's mandates bind it in cnf, so only this agent can close them." },
    merchant: { ...AP2_DEMO_MERCHANT, jwk: p.merchant.jwk },
    audiences: AP2_DEMO_AUD,
    products: AP2_DEMO_PRODUCTS.map((id) => {
      const f = facts.get(id)!;
      return { id, title: f.title, price_cents: f.offers[0]!.price_cents, color: f.attributes.color ?? null };
    }),
  };
}

type Err = { kind: "error"; status: number; title: string; detail?: string };
const err = (status: number, title: string, detail?: string): Err => ({ kind: "error", status, title, ...(detail ? { detail } : {}) });

const P256 = (j: unknown): j is { kty: "EC"; crv: "P-256"; x: string; y: string } =>
  !!j && typeof j === "object" && (j as JWK).kty === "EC" && (j as JWK).crv === "P-256" && typeof (j as JWK).x === "string" && typeof (j as JWK).y === "string" && !("d" in (j as object));

/** Enrol Rose's device key: her own browser generated it and keeps the private half. */
export async function enrolTrustedSurface(d: EngineDeps, tenantId: string, shopperId: string, body: unknown): Promise<{ kind: "ok"; thumbprint: string } | Err> {
  const jwk = (body as { jwk?: unknown } | null)?.jwk;
  if (!P256(jwk)) return err(422, "A public EC P-256 JWK is required");
  const pub = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const thumbprint = ecThumbprint(pub);
  await d.pool.query(
    `INSERT INTO ap2_trusted_surfaces (shopper_id, tenant_id, jwk, thumbprint) VALUES ($1, $2, $3, $4)
     ON CONFLICT (shopper_id) DO UPDATE SET jwk = EXCLUDED.jwk, thumbprint = EXCLUDED.thumbprint, enrolled_at = now()`,
    [shopperId, tenantId, JSON.stringify({ ...pub, kid: thumbprint }), thumbprint],
  );
  return { kind: "ok", thumbprint };
}

/**
 * The other parties' half of a run: the merchant signs a checkout for one product, and the agent
 * (the key bound in Rose's cnf) closes her two open mandates against it.
 */
async function closeForDemo(p: Parties, signed: { openCheckout: string; openPayment: string }, facts: { product_id: string; title: string }, price: number, now: number) {
  const checkout = {
    id: newId("chk"),
    merchant: AP2_DEMO_MERCHANT,
    line_items: [{ id: "li_1", item: { id: facts.product_id, title: facts.title, price }, quantity: 1, totals: [{ type: "total", amount: price }] }],
    status: "ready_for_complete",
    currency: "USD",
    totals: [
      { type: "subtotal", amount: price },
      { type: "total", amount: price },
    ],
    links: [{ type: "terms_of_service", url: `${AP2_DEMO_MERCHANT.website}/terms` }],
  };
  const jwt = await new CompactSign(new TextEncoder().encode(JSON.stringify(checkout))).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: p.merchant.jwk.kid! }).sign(p.merchant.privateKey);
  const hash = digest(jwt);
  const nonces = { checkout: randomBytes(16).toString("base64url"), payment: randomBytes(16).toString("base64url") };
  const checkoutChain = await presentHop({ chain: signed.openCheckout, key: p.agent.privateKey, mandate: { vct: VCT.checkout, checkout_jwt: disclose(jwt), checkout_hash: hash }, aud: AP2_DEMO_AUD.checkout, nonce: nonces.checkout, iat: now });
  const paymentChain = await presentHop({
    chain: signed.openPayment,
    key: p.agent.privateKey,
    mandate: { vct: VCT.payment, transaction_id: hash, payee: AP2_DEMO_MERCHANT, payment_amount: { amount: price, currency: "USD" }, payment_instrument: { id: "rose-paypal-wallet", type: "paypal", description: "Rose's PayPal (sandbox)" } },
    aud: AP2_DEMO_AUD.payment,
    nonce: nonces.payment,
    iat: now,
  });
  return { checkoutChain, paymentChain, nonces };
}

/** Which party's check stopped the run (or "none" when it completed). */
export type CaughtBy = "none" | "ap2_constraints" | "secondkey_facts" | "secondkey_ledger" | "paypal_order" | "signatures" | "cannot_confirm";

export interface Ap2DemoRunView {
  run: Ap2DemoRun;
  agent: { product_id: string; title: string; price_cents: number; narration: string };
  /** run "reused": the first, legitimate use of the same open mandate. */
  first?: VerificationResponse;
  verification: VerificationResponse;
  settlement: SettlementView | null;
  caught_by: CaughtBy;
}

function caughtBy(v: VerificationResponse): CaughtBy {
  if (v.decision === "CONFORMS") return "none";
  if (v.error === "invalid_credential") return "signatures";
  if (v.findings.some((f) => f.code.startsWith("ledger."))) return "secondkey_ledger";
  const failed = v.constraints.filter((c) => c.result === "fail");
  if (failed.some((c) => /^(checkout|payment)\./.test(c.type)) || v.findings.length) return "ap2_constraints";
  if (failed.some((c) => c.type.startsWith("x-secondkey."))) return "secondkey_facts";
  return "cannot_confirm";
}

const strings = (b: unknown) => {
  const o = b as { open_checkout?: unknown; open_payment?: unknown } | null;
  return typeof o?.open_checkout === "string" && typeof o.open_payment === "string" && o.open_checkout.length < 32_768 && o.open_payment.length < 32_768
    ? { openCheckout: o.open_checkout, openPayment: o.open_payment }
    : null;
};

export async function runAp2Demo(d: EngineDeps, tenantId: string, shopperId: string, run: string, body: unknown): Promise<{ kind: "ok"; value: Ap2DemoRunView } | Err> {
  if (!(run in RUNS)) return err(404, "Unknown run", run);
  const name = run as Ap2DemoRun;
  const signed = strings(body);
  if (!signed) return err(422, "open_checkout and open_payment (signed on Rose's device) are required");
  const surface = (await d.pool.query<{ jwk: JWK }>("SELECT jwk FROM ap2_trusted_surfaces WHERE shopper_id = $1 AND tenant_id = $2", [shopperId, tenantId])).rows[0];
  if (!surface) return err(409, "Rose's device isn't enrolled", "enrol the device key first: POST /v1/me/demo/ap2/surface");
  const shopper = (await d.pool.query<{ vault_id: string | null }>("SELECT vault_id FROM shoppers WHERE id = $1 AND tenant_id = $2", [shopperId, tenantId])).rows[0];
  if (!shopper?.vault_id) return err(409, "This demo payer has no saved PayPal wallet");

  const p = await demoParties();
  const who: Principal = { tenantId, principal: `agent:ap2-demo-${shopperId}`, scopes: ["ap2:verify"] };
  const facts = fixtureFacts().get(RUNS[name].product)!;
  const price = facts.offers[0]!.price_cents;
  const now = Math.floor((d.now?.() ?? new Date()).getTime() / 1000);

  /** The merchant signs the checkout; the agent closes both of Rose's mandates against it. */
  async function present() {
    const { checkoutChain, paymentChain, nonces } = await closeForDemo(p, signed!, facts, price, now);
    const r = await verifyAp2(d, who, `ap2-demo-${newId("run")}`, {
      checkout: { mandate: checkoutChain, aud: AP2_DEMO_AUD.checkout, nonce: nonces.checkout },
      payment: { mandate: paymentChain, aud: AP2_DEMO_AUD.payment, nonce: nonces.payment },
      trust: { issuers: { keys: [surface!.jwk] }, merchants: { keys: [p.merchant.jwk] } },
    });
    if (r.kind === "error") throw new Error(`${r.title}${r.detail ? `: ${r.detail}` : ""}`);
    return r.body;
  }

  let first: VerificationResponse | undefined;
  if (name === "reused") first = await present();
  const verification = await present();

  let settlement: SettlementView | null = null;
  if (verification.decision === "CONFORMS") {
    // The merchant's checkout creates the PayPal order; in the cart-swap run it sends the wrong item.
    const cart = { currency: "USD", lines: [{ product_id: facts.product_id, name: facts.title, quantity: 1, unit_cents: price }] } as unknown as ResolvedCart;
    const adapter = name === "cart_swap" ? swapAdapter({ sku: "TRL-WHT-10", name: "Ridgeline Trail Runner, Cloud White, US 10" }) : standardAdapter;
    const ref = newId("ap2");
    const created = await d.paypal.createOrder(adapter.buildOrder(cart, { purchaseId: ref, policyDigest: "sha256:ap2-demo", vaultId: shopper.vault_id }), `ap2-demo-order:${ref}`);
    if (!created.ok) return err(502, "PayPal didn't create the order", `HTTP ${created.status}`);
    const bound = await bindSettlement(d, who, `ap2-demo-${ref}`, { verification_id: verification.verification_id, psp: "paypal", order_id: created.data.id });
    if (bound.kind === "error") return err(bound.status, bound.title, bound.detail);
    settlement = bound.body;
  }

  return {
    kind: "ok",
    value: {
      run: name,
      agent: { product_id: facts.product_id, title: facts.title, price_cents: price, narration: RUNS[name].narration },
      ...(first ? { first } : {}),
      verification,
      settlement,
      caught_by: settlement && settlement.state !== "MATCHED" && settlement.state !== "CAPTURED" ? "paypal_order" : caughtBy(verification),
    },
  };
}

export async function ap2DemoSettlement(d: EngineDeps, tenantId: string, shopperId: string, id: string): Promise<SettlementView | null> {
  return getSettlement(d, { tenantId, principal: `agent:ap2-demo-${shopperId}`, scopes: ["ap2:verify"] }, id);
}

/**
 * "Run a test verification" (/developers): anyone can check the whole verification path from a
 * browser, with no account and no API key. The browser signs sample open mandates with a throwaway
 * key and sends its public half; the demo agent and merchant close them for the chosen product;
 * Second Key verifies them with the real verifier, attests the facts and signs real receipts. Nothing
 * is stored: the ledger is fresh for each test and PayPal is never called.
 */
export async function ap2TestVerification(d: EngineDeps, body: unknown) {
  if (!d.receipts) return err(503, "Receipt signing is not configured");
  const signed = strings(body);
  const b = (body ?? {}) as { jwk?: unknown; product?: unknown };
  if (!signed) return err(422, "open_checkout and open_payment (signed in the browser) are required");
  if (!P256(b.jwk)) return err(422, "jwk: the public EC P-256 key that signed them is required");
  const product = typeof b.product === "string" ? b.product : "TRL-GRY-10";
  if (!(AP2_DEMO_PRODUCTS as readonly string[]).includes(product)) return err(422, `product must be one of ${AP2_DEMO_PRODUCTS.join(", ")}`);

  const p = await demoParties();
  const facts = fixtureFacts().get(product)!;
  const price = facts.offers[0]!.price_cents;
  const nowDate = d.now?.() ?? new Date();
  const now = Math.floor(nowDate.getTime() / 1000);
  const { checkoutChain, paymentChain, nonces } = await closeForDemo(p, signed, facts, price, now);
  const attested = await attestFacts(d, [product], nowDate);
  const factsJwt = Object.keys(attested).length ? await signFactsAttestation(d.receipts, Object.values(attested), now) : undefined;
  const surfaceKey = await importJWK({ kty: "EC", crv: "P-256", x: b.jwk.x, y: b.jwk.y }, "ES256");
  const v = await verifyPresentation(
    {
      checkout: { chain: checkoutChain, options: { rootKey: () => surfaceKey, merchantKey: async (h) => (h.kid === p.merchant.jwk.kid ? importJWK(p.merchant.jwk, "ES256") : undefined), aud: AP2_DEMO_AUD.checkout, nonce: nonces.checkout } },
      payment: { chain: paymentChain, options: { rootKey: () => surfaceKey, aud: AP2_DEMO_AUD.payment, nonce: nonces.payment } },
      now,
      facts: attested,
    },
    new MemoryLedger(),
  );
  return {
    kind: "ok" as const,
    value: {
      test: true,
      note: "Nothing was stored and PayPal wasn't called; the ledger is fresh for every test, so reuse isn't checked here.",
      product: { id: product, title: facts.title, price_cents: price },
      decision: v.decision,
      ...(v.error ? { error: v.error } : {}),
      findings: v.findings.map((f) => ({ code: f.code, message: f.message })),
      constraints: v.constraints,
      facts_attestation: factsJwt ?? null,
      receipts: {
        checkout: await signMandateReceipt(d.receipts, v, "checkout", checkoutChain, now, factsJwt),
        payment: await signMandateReceipt(d.receipts, v, "payment", paymentChain, now, factsJwt),
      },
      presented: { checkout: checkoutChain, payment: paymentChain },
      jwks_uri: "/.well-known/jwks.json",
    },
  };
}
