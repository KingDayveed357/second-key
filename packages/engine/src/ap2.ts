// Second Key as an AP2 delegated verifier (strategy doc §5): a merchant or processor sends the
// presented mandate chains with the aud/nonce it expects and the keys it trusts; Second Key
// verifies them, evaluates every constraint against the global mandate ledger, signs receipts and
// records the decision, all in one transaction. The trust anchors come with each request for now,
// and every receipt names the key thumbprints it relied on.

import { createHash } from "node:crypto";
import { calculateJwkThumbprint, importJWK, type JWK } from "jose";
import { z } from "zod";
import { canonicalJson, newId } from "@witness/core";
import { appendAudit, withTx, type Tx } from "@witness/db";
import { checkInjection } from "@witness/ai";
import {
  closedMandateReference,
  ITEM_ATTRIBUTES,
  signFactsAttestation,
  signMandateReceipt,
  verifyMandate,
  verifyPresentation,
  type AttestedProduct,
  type JsonObject,
  type Ledger,
  type LedgerUsage,
  type PresentationVerification,
  type RootKeyResolver,
} from "@witness/ap2";
import type { EngineDeps, Principal } from "./deps.ts";

const Jwk = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1), kid: z.string().max(200).optional() }).passthrough();
const Jwks = z.object({ keys: z.array(Jwk).min(1).max(20) });
const Presented = z.object({
  mandate: z.string().min(1).max(32_768),
  /** What the presenter must have bound the last hop to: replay protection is not optional here. */
  aud: z.string().min(1).max(512),
  nonce: z.string().min(8).max(512),
});

export const VerificationRequest = z.object({
  checkout: Presented,
  payment: Presented.extend({ cosignatures: z.array(z.string().min(1).max(4096)).max(5).optional() }).optional(),
  trust: z.object({ issuers: Jwks, merchants: Jwks.optional() }),
});
export type VerificationRequest = z.infer<typeof VerificationRequest>;

const LEDGER_LOCK = 0x41_50_32_00; // "AP2\0", the two-key advisory lock space for ledger keys

/** The ledger inside a caller's transaction: per-key advisory locks, taken in sorted order. */
export function txLedger(tx: Tx, verificationId: string): Ledger {
  const q = (text: string, values: unknown[]) => tx.client.query(text, values);
  return {
    async transact(keys, fn) {
      for (const k of [...new Set([...keys.open, ...keys.closed])].sort()) await q("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LEDGER_LOCK, k]);
      const opens = await q("SELECT ref, uses, total_minor::text AS total, currency, extract(epoch FROM last_used_at)::bigint AS last FROM ap2_open_mandates WHERE ref = ANY($1)", [keys.open]);
      const usage = new Map<string, LedgerUsage>(
        opens.rows.map((r: { ref: string; uses: number; total: string; currency: string | null; last: string }) => [
          r.ref,
          { uses: r.uses, totalMinor: Number(r.total), ...(r.currency ? { currency: r.currency } : {}), lastUsedAt: Number(r.last) },
        ]),
      );
      const closed = await q("SELECT closed_ref FROM ap2_presentations WHERE closed_ref = ANY($1)", [keys.closed]);
      const { value, record } = await fn({ usage, closedSeen: new Set(closed.rows.map((r: { closed_ref: string }) => r.closed_ref)) });
      if (record) {
        for (const c of record.closed) await q("INSERT INTO ap2_presentations (closed_ref, verification_id) VALUES ($1, $2)", [c, verificationId]);
        for (const o of record.opens) {
          await q(
            `INSERT INTO ap2_open_mandates (ref, uses, total_minor, currency, last_used_at) VALUES ($1, 1, $2, $3, to_timestamp($4))
             ON CONFLICT (ref) DO UPDATE SET uses = ap2_open_mandates.uses + 1, total_minor = ap2_open_mandates.total_minor + EXCLUDED.total_minor,
               currency = coalesce(ap2_open_mandates.currency, EXCLUDED.currency), last_used_at = EXCLUDED.last_used_at`,
            [o.ref, o.amountMinor ?? 0, o.currency ?? null, record.at],
          );
          await q("INSERT INTO ap2_presentation_opens (verification_id, open_ref, amount_minor, currency) VALUES ($1, $2, $3, $4)", [verificationId, o.ref, o.amountMinor ?? null, o.currency ?? null]);
        }
      }
      return value;
    },
  };
}

/** Resolve a signing key by `kid`, or the only key when the token names none. Public keys only. */
function resolverOf(jwks: { keys: JWK[] } | undefined): RootKeyResolver {
  return async (header: JsonObject) => {
    const keys = jwks?.keys ?? [];
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const jwk = kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined;
    if (!jwk || "d" in jwk) return undefined;
    return importJWK({ kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! }, "ES256");
  };
}

export interface VerificationResponse {
  verification_id: string;
  decision: PresentationVerification["decision"];
  error?: string;
  findings: { code: string; message: string; chain: "checkout" | "payment" | "both"; hop?: number }[];
  constraints: PresentationVerification["constraints"];
  checkout_hash: string | null;
  /** Signed product facts Second Key fetched itself, when an x-secondkey.item_attributes.1 rule needed them. */
  facts_attestation: string | null;
  /** With COSIGN_REQUIRED: what the enrolled co-signer must sign. */
  cosign: { reference: string } | null;
  /** A CONFORMS verification with a payment mandate may be bound to one PayPal order (POST /v2/settlements). */
  settleable: boolean;
  merchant_signature: "verified" | "invalid" | "not_checked" | null;
  ledger: { open_mandate: string; kind: string; uses_before: number; budget_remaining_minor?: number }[];
  receipts: { checkout: string; payment: string | null; kid: string; jwks_uri: "/.well-known/jwks.json" };
  trusted_keys: { issuers: string[]; merchants: string[] };
  created_at: string;
}

type Result = { kind: "ok"; body: VerificationResponse; replay: boolean } | { kind: "error"; status: number; title: string; detail?: string };

const requestHash = (body: unknown) => createHash("sha256").update(canonicalJson(body)).digest("hex");

export async function verifyAp2(d: EngineDeps, who: Principal, idempotencyKey: string, raw: unknown): Promise<Result> {
  const signer = d.receipts;
  if (!signer) return { kind: "error", status: 503, title: "Receipt signing is not configured" };
  const parsed = VerificationRequest.safeParse(raw);
  if (!parsed.success) return { kind: "error", status: 422, title: "Invalid verification request", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const req = parsed.data;
  const hash = requestHash(req);

  const stored = async (): Promise<Result | null> => {
    const r = await d.pool.query<{ request_hash: string; response: VerificationResponse }>("SELECT request_hash, response FROM ap2_verifications WHERE tenant_id = $1 AND idempotency_key = $2", [who.tenantId, idempotencyKey]);
    const row = r.rows[0];
    if (!row) return null;
    if (row.request_hash !== hash) return { kind: "error", status: 422, title: "Idempotency-Key reuse", detail: "this key was used with a different request" };
    return { kind: "ok", body: row.response, replay: true };
  };
  const prior = await stored();
  if (prior) return prior;

  const id = newId("ver");
  const nowDate = d.now?.() ?? new Date();
  const now = Math.floor(nowDate.getTime() / 1000);
  const checkoutOptions = { rootKey: resolverOf(req.trust.issuers as { keys: JWK[] }), merchantKey: resolverOf(req.trust.merchants as { keys: JWK[] } | undefined), aud: req.checkout.aud, nonce: req.checkout.nonce, now };
  // Facts are fetched before the transaction (network calls never hold ledger locks), and only when a
  // verified open checkout mandate asks for them.
  const pre = await verifyMandate(req.checkout.mandate, checkoutOptions);
  const wantsFacts = pre.mandates.some((m) => m.kind === "open_checkout" && Array.isArray(m.value.constraints) && m.value.constraints.some((c) => (c as JsonObject).type === ITEM_ATTRIBUTES));
  const ids = [...new Set((Array.isArray(pre.checkout?.payload.line_items) ? pre.checkout.payload.line_items : []).map((li) => ((li as JsonObject).item as JsonObject | undefined)?.id).filter((x): x is string => typeof x === "string"))];
  const facts = wantsFacts && ids.length ? await attestFacts(d, ids, nowDate) : undefined;
  const factsJwt = facts && Object.keys(facts).length ? await signFactsAttestation(signer, Object.values(facts), now) : undefined;
  const thumbs = async (k?: { keys: JWK[] }) => Promise.all((k?.keys ?? []).map((j) => calculateJwkThumbprint({ kty: "EC", crv: "P-256", x: j.x!, y: j.y! })));

  try {
    return await withTx(d.pool, async (tx) => {
      const v = await verifyPresentation(
        {
          checkout: { chain: req.checkout.mandate, options: checkoutOptions },
          ...(req.payment ? { payment: { chain: req.payment.mandate, options: { rootKey: resolverOf(req.trust.issuers as { keys: JWK[] }), aud: req.payment.aud, nonce: req.payment.nonce } } } : {}),
          now,
          ...(facts ? { facts } : {}),
          cosignatures: req.payment?.cosignatures ?? [],
        },
        txLedger(tx, id),
      );
      const settlement = v.decision === "CONFORMS" && req.payment && v.checkout.checkout ? settlementOf(v.checkout.checkout.payload, req.checkout.mandate, req.payment.mandate) : null;
      // Cross-chain and ledger findings belong to the presentation as a whole.
      const chainOf = (f: (typeof v.findings)[number]) => (v.checkout.findings.includes(f) ? "checkout" : v.payment?.findings.includes(f) ? "payment" : "both");
      const body: VerificationResponse = {
        verification_id: id,
        decision: v.decision,
        ...(v.error ? { error: v.error } : {}),
        findings: v.findings.map((f) => ({ code: f.code, message: f.message, chain: chainOf(f), ...(f.hop === undefined ? {} : { hop: f.hop }) })),
        constraints: v.constraints,
        checkout_hash: v.checkout.checkout?.hash ?? null,
        facts_attestation: factsJwt ?? null,
        cosign: v.cosign ?? null,
        settleable: settlement !== null,
        merchant_signature: v.checkout.checkout?.merchantSignature ?? null,
        ledger: v.ledger.map((e) => ({ open_mandate: e.ref, kind: e.kind, uses_before: e.usesBefore, ...(e.budgetRemainingMinor === undefined ? {} : { budget_remaining_minor: e.budgetRemainingMinor }) })),
        receipts: {
          checkout: await signMandateReceipt(signer, v, "checkout", req.checkout.mandate, now, factsJwt),
          payment: req.payment ? await signMandateReceipt(signer, v, "payment", req.payment.mandate, now, factsJwt) : null,
          kid: signer.kid,
          jwks_uri: "/.well-known/jwks.json",
        },
        trusted_keys: { issuers: await thumbs(req.trust.issuers as { keys: JWK[] }), merchants: await thumbs(req.trust.merchants as { keys: JWK[] } | undefined) },
        created_at: nowDate.toISOString(),
      };
      await tx.client.query("INSERT INTO ap2_verifications (id, tenant_id, idempotency_key, request_hash, decision, response, settlement, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
        id,
        who.tenantId,
        idempotencyKey,
        hash,
        v.decision,
        JSON.stringify(body),
        settlement ? JSON.stringify(settlement) : null,
        nowDate,
      ]);
      await appendAudit(tx, {
        tenantId: who.tenantId,
        purchaseId: null,
        eventType: "ap2.verified",
        payload: { verification_id: id, decision: v.decision, error: v.error ?? null, findings: v.findings.map((f) => f.code), failed: v.constraints.filter((c) => c.result !== "pass").map((c) => c.type), checkout_hash: body.checkout_hash, open_mandates: body.ledger.map((e) => e.open_mandate), principal: who.principal },
      });
      return { kind: "ok" as const, body, replay: false };
    });
  } catch (e) {
    // A concurrent request with the same Idempotency-Key committed first: answer with its result.
    if ((e as { code?: string }).code === "23505") {
      const again = await stored();
      if (again) return again;
    }
    throw e;
  }
}

export interface SettlementExpectation {
  currency: string;
  amount_cents: number;
  items: { sku: string; quantity: number; unit_cents: number }[];
  /** Closed-mandate references the Checkout and Payment Receipts bind to. */
  references: { checkout: string; payment: string };
}

/** What PayPal's order must hold: the merchant-signed checkout, line by line. Null if it can't be stated exactly. */
export function settlementOf(checkout: JsonObject, checkoutChain: string, paymentChain: string): SettlementExpectation | null {
  const total = Array.isArray(checkout.totals) ? (checkout.totals as JsonObject[]).find((t) => t?.type === "total")?.amount : undefined;
  if (typeof checkout.currency !== "string" || typeof total !== "number" || !Number.isInteger(total)) return null;
  const items = new Map<string, { sku: string; quantity: number; unit_cents: number }>();
  for (const li of Array.isArray(checkout.line_items) ? (checkout.line_items as JsonObject[]) : []) {
    const item = li?.item as JsonObject | undefined;
    const sku = item?.id;
    const price = item?.price;
    const q = li?.quantity;
    if (typeof sku !== "string" || typeof price !== "number" || !Number.isInteger(price) || typeof q !== "number" || !Number.isInteger(q) || q <= 0) return null;
    const seen = items.get(sku);
    if (seen && seen.unit_cents !== price) return null;
    items.set(sku, { sku, quantity: (seen?.quantity ?? 0) + q, unit_cents: price });
  }
  if (!items.size) return null;
  return { currency: checkout.currency, amount_cents: total, items: [...items.values()], references: { checkout: closedMandateReference(checkoutChain), payment: closedMandateReference(paymentChain) } };
}

/**
 * Facts for x-secondkey.item_attributes.1, from Second Key's own catalog fetch by product id, never
 * from the merchant's checkout or the agent. The listing check (AI) can only mark a product
 * "concern" or "unavailable", which leaves the attribute rules unresolved; it never makes one pass.
 * A product the catalog doesn't know is simply absent, which is unresolved too.
 */
export async function attestFacts(d: EngineDeps, ids: string[], now: Date): Promise<Record<string, AttestedProduct>> {
  let found: Awaited<ReturnType<EngineDeps["catalog"]["getProducts"]>>;
  try {
    found = await d.catalog.getProducts(ids);
  } catch (e) {
    d.log?.warn("ap2 facts: catalog unavailable", { error: (e as Error).message });
    return {};
  }
  const products = [...found.facts.values()];
  let listing: AttestedProduct["listing_check"] = "unavailable";
  let detail: string | undefined = "no listing check is configured";
  if (d.ai && products.length) {
    const c = await checkInjection(d.ai, products);
    listing = c.result === "pass" ? "clean" : c.unavailable ? "unavailable" : "concern";
    detail = c.result === "pass" ? undefined : c.detail;
  }
  const out: Record<string, AttestedProduct> = {};
  for (const f of products)
    out[f.product_id] = {
      product_id: f.product_id,
      title: f.title,
      ...(f.brand ? { brand: f.brand } : {}),
      ...(f.category ? { category: f.category } : {}),
      attributes: f.attributes,
      source: f.source,
      fetched_at: f.fetched_at ?? now.toISOString(),
      listing_check: listing,
      ...(detail ? { listing_detail: detail.slice(0, 300) } : {}),
    };
  return out;
}

export async function getAp2Verification(d: EngineDeps, who: Principal, id: string): Promise<VerificationResponse | null> {
  const r = await d.pool.query<{ response: VerificationResponse }>("SELECT response FROM ap2_verifications WHERE tenant_id = $1 AND id = $2", [who.tenantId, id]);
  return r.rows[0]?.response ?? null;
}
