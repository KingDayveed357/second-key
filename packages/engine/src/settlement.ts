// AP2 settlement binding (strategy doc §5): POST /v2/settlements ties a CONFORMS verification to one
// PayPal order. The order is re-read from PayPal and must hold exactly the merchant-signed checkout
// that conformed: payee, currency, total, every item, and a live authorization for that total. A
// match is queued for capture, a mismatch for void; the executor re-checks the order again right
// before capturing. Nothing here moves money. Receipts are signed when a settlement is read, by
// the API's receipt key, so the worker never holds it.

import { createHash } from "node:crypto";
import { z } from "zod";
import { authorizationDiffs, authorizationOf, canonicalJson, newId, threeWayMatch } from "@witness/core";
import { QUEUES, appendAudit, enqueue, withTx } from "@witness/db";
import { signCheckoutReceipt, signPaymentReceipt } from "@witness/ap2";
import { PayPalHttpError, PayPalNetworkError } from "@witness/paypal";
import type { SettlementExpectation } from "./ap2.ts";
import { nowOf, type EngineDeps, type Principal } from "./deps.ts";

/** A verification may be settled for this long; after that the agent must present again. */
export const SETTLEMENT_WINDOW_MS = 15 * 60_000;

export const SettlementRequest = z.strictObject({
  verification_id: z.string().regex(/^ver_[A-Za-z0-9_-]{8,40}$/),
  psp: z.literal("paypal"),
  order_id: z.string().regex(/^[A-Za-z0-9-]{4,64}$/),
});

export type SettlementState = "MATCHED" | "REFUSED" | "CAPTURING" | "CAPTURED" | "CAPTURE_DECLINED" | "NEEDS_RECONCILE" | "VOIDING" | "VOIDED";

interface Row {
  id: string;
  verification_id: string;
  paypal_order_id: string;
  paypal_authorization_id: string | null;
  amount_minor: string;
  currency: string;
  expectation: SettlementExpectation;
  state: SettlementState;
  diffs: string[];
  paypal_capture_id: string | null;
  network_reference: string | null;
  request_hash: string;
  settled_at: Date | null;
  updated_at: Date;
  created_at: Date;
}

export interface SettlementView {
  settlement_id: string;
  verification_id: string;
  psp: "paypal";
  order_id: string;
  authorization_id: string | null;
  state: SettlementState;
  /** Why PayPal's order does not hold what was verified (empty when it does). */
  diffs: string[];
  amount: { currency: string; value_minor: number };
  capture_id: string | null;
  /** Final states only: AP2 Checkout and Payment Receipts, verifiable with /.well-known/jwks.json. */
  receipts: { checkout: string; payment: string } | null;
  created_at: string;
}

type Result = { kind: "ok"; body: SettlementView; replay: boolean; status: number } | { kind: "error"; status: number; title: string; detail?: string };
const err = (status: number, title: string, detail?: string): Result => ({ kind: "error", status, title, ...(detail ? { detail } : {}) });

const FINAL: SettlementState[] = ["CAPTURED", "CAPTURE_DECLINED", "VOIDED", "REFUSED"];

async function viewOf(d: EngineDeps, r: Row): Promise<SettlementView> {
  let receipts: SettlementView["receipts"] = null;
  if (d.receipts && FINAL.includes(r.state)) {
    const iat = Math.floor((r.settled_at ?? r.updated_at).getTime() / 1000);
    const refs = r.expectation.references;
    if (r.state === "CAPTURED") {
      receipts = {
        checkout: await signCheckoutReceipt(d.receipts, { status: "Success", reference: refs.checkout, iat, order_id: r.paypal_order_id }),
        payment: await signPaymentReceipt(d.receipts, {
          status: "Success",
          reference: refs.payment,
          iat,
          payment_id: r.id,
          psp_confirmation_id: r.paypal_capture_id!,
          // PayPal exposes a network transaction reference for some card captures only; the schema requires the field.
          network_confirmation_id: r.network_reference ?? "not_provided_by_psp",
        }),
      };
    } else {
      const error = r.state === "CAPTURE_DECLINED" ? "payment_declined" : "settlement_order_mismatch";
      const error_description = (r.diffs.length ? r.diffs.join("; ") : r.state === "CAPTURE_DECLINED" ? "PayPal declined the capture" : "the authorization was voided").slice(0, 1000);
      receipts = {
        checkout: await signCheckoutReceipt(d.receipts, { status: "Error", reference: refs.checkout, iat, error, error_description }),
        payment: await signPaymentReceipt(d.receipts, { status: "Error", reference: refs.payment, iat, payment_id: r.id, error, error_description }),
      };
    }
  }
  return {
    settlement_id: r.id,
    verification_id: r.verification_id,
    psp: "paypal",
    order_id: r.paypal_order_id,
    authorization_id: r.paypal_authorization_id,
    state: r.state,
    diffs: r.diffs,
    amount: { currency: r.currency, value_minor: Number(r.amount_minor) },
    capture_id: r.paypal_capture_id,
    receipts,
    created_at: r.created_at.toISOString(),
  };
}

const SELECT = `SELECT id, verification_id, paypal_order_id, paypal_authorization_id, amount_minor::text, currency, expectation, state, diffs, paypal_capture_id,
                       network_reference, request_hash, settled_at, updated_at, created_at FROM ap2_settlements`;

export async function bindSettlement(d: EngineDeps, who: Principal, idempotencyKey: string, raw: unknown): Promise<Result> {
  const parsed = SettlementRequest.safeParse(raw);
  if (!parsed.success) return err(422, "Invalid settlement request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const req = parsed.data;
  const hash = createHash("sha256").update(canonicalJson(req)).digest("hex");

  const prior = (await d.pool.query<Row>(`${SELECT} WHERE tenant_id = $1 AND idempotency_key = $2`, [who.tenantId, idempotencyKey])).rows[0];
  if (prior) return prior.request_hash === hash ? { kind: "ok", body: await viewOf(d, prior), replay: true, status: 200 } : err(422, "Idempotency-Key reuse", "this key was used with a different request");

  const ver = (
    await d.pool.query<{ decision: string; settlement: SettlementExpectation | null; created_at: Date }>("SELECT decision, settlement, created_at FROM ap2_verifications WHERE tenant_id = $1 AND id = $2", [who.tenantId, req.verification_id])
  ).rows[0];
  if (!ver) return err(404, "Verification not found");
  if (ver.decision !== "CONFORMS") return err(409, "Verification did not conform", `decision was ${ver.decision}`);
  if (!ver.settlement) return err(409, "Nothing to settle", "the verification had no payment mandate, or its checkout can't be stated exactly");
  if (nowOf(d).getTime() - ver.created_at.getTime() > SETTLEMENT_WINDOW_MS) return err(409, "Verification expired", "settle within 15 minutes of verifying; present the mandates again");
  const taken = await d.pool.query("SELECT 1 FROM purchases WHERE paypal_order_id = $1 UNION ALL SELECT 1 FROM ap2_settlements WHERE paypal_order_id = $1 OR verification_id = $2", [req.order_id, req.verification_id]);
  if (taken.rowCount) return err(409, "Already bound", "this order or this verification is already bound to a payment");
  const tenant = (await d.pool.query<{ paypal_merchant_id: string }>("SELECT paypal_merchant_id FROM tenants WHERE id = $1", [who.tenantId])).rows[0]!;

  let order: unknown;
  try {
    order = (await d.paypal.getOrder(req.order_id)).data;
  } catch (e) {
    if (e instanceof PayPalHttpError && e.status === 404) return err(422, "Order not found at PayPal");
    if (e instanceof PayPalNetworkError || e instanceof PayPalHttpError) return err(502, "PayPal unavailable", (e as Error).message);
    throw e;
  }

  const exp = { order_id: req.order_id, payee_merchant_id: tenant.paypal_merchant_id, currency: ver.settlement.currency, amount_cents: ver.settlement.amount_cents, items: ver.settlement.items };
  const diffs = [...threeWayMatch(exp, order), ...authorizationDiffs(exp, order)];
  const auth = authorizationOf(order);
  // A live authorization that doesn't hold what was verified is voided; with none, there is nothing to undo.
  const state: SettlementState = !diffs.length ? "MATCHED" : auth?.status === "CREATED" ? "VOIDING" : "REFUSED";
  const id = newId("stl");

  try {
    const row = await withTx(d.pool, async (tx) => {
      const r = await tx.client.query<Row>(
        `INSERT INTO ap2_settlements (id, tenant_id, verification_id, idempotency_key, request_hash, paypal_order_id, paypal_authorization_id, payee_merchant_id, amount_minor, currency, expectation, state, diffs, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $12 = 'REFUSED' THEN now() END)
         RETURNING id, verification_id, paypal_order_id, paypal_authorization_id, amount_minor::text, currency, expectation, state, diffs, paypal_capture_id, network_reference, request_hash, settled_at, updated_at, created_at`,
        [id, who.tenantId, req.verification_id, idempotencyKey, hash, req.order_id, auth?.id ?? null, tenant.paypal_merchant_id, ver.settlement!.amount_cents, ver.settlement!.currency, JSON.stringify(ver.settlement), state, JSON.stringify(diffs)],
      );
      await appendAudit(tx, { tenantId: who.tenantId, purchaseId: null, eventType: "ap2.settlement_bound", payload: { settlement_id: id, verification_id: req.verification_id, order_id: req.order_id, state, diffs, principal: who.principal } });
      if (state === "MATCHED") await enqueue(d.boss, tx, QUEUES.ap2Capture, { settlementId: id }, { singletonKey: `ap2-capture:${id}` });
      if (state === "VOIDING") await enqueue(d.boss, tx, QUEUES.ap2Void, { settlementId: id }, { singletonKey: `ap2-void:${id}` });
      return r.rows[0]!;
    });
    return { kind: "ok", body: await viewOf(d, row), replay: false, status: 202 };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return err(409, "Already bound", "this order or this verification is already bound to a payment");
    throw e;
  }
}

export async function getSettlement(d: EngineDeps, who: Principal, id: string): Promise<SettlementView | null> {
  const r = (await d.pool.query<Row>(`${SELECT} WHERE tenant_id = $1 AND id = $2`, [who.tenantId, id])).rows[0];
  return r ? viewOf(d, r) : null;
}
