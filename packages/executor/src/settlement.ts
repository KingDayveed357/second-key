// AP2 settlements in the executor: capture, void and reconcile one ap2_settlements row (migration
// 0009). The row is the single-use capability: `consumeSettlement` moves it MATCHED -> CAPTURING in
// one UPDATE, and only a value it returned can be captured (brand + WeakSet, as with approvals).
// PayPal's order is re-checked immediately before the capture, every money call is journaled
// before it is sent, and a deterministic PayPal-Request-Id makes any retry the same call.

import { authorizationDiffs, authorizationOf, captureMatches, capturesOf, fromCents, paypalRequestId, threeWayMatch } from "@witness/core";
import { QUEUES, appendAudit, enqueue, withTx, type SettlementJob, type Tx } from "@witness/db";
import { nowOf, type SettlementExpectation, type SettlementState } from "@witness/engine";
import { PayPalHttpError, PayPalNetworkError } from "@witness/paypal";
import type { ExecutorDeps } from "./executor.ts";

declare const brand: unique symbol;

interface SettlementRecord {
  id: string;
  tenant_id: string;
  paypal_order_id: string;
  paypal_authorization_id: string | null;
  payee_merchant_id: string;
  amount_minor: string;
  currency: string;
  expectation: SettlementExpectation;
  state: SettlementState;
}
export type ConsumedSettlement = Readonly<SettlementRecord> & { readonly [brand]: true };

const issued = new WeakSet<object>();
const COLS = "id, tenant_id, paypal_order_id, paypal_authorization_id, payee_merchant_id, amount_minor::text, currency, expectation, state";
const MAX_CAPTURE_ATTEMPTS = 3;
const RECONCILE_DELAY_MS = 30_000;

const brandIt = (r: SettlementRecord) => {
  const c = Object.freeze({ ...r }) as ConsumedSettlement;
  issued.add(c);
  return c;
};

/** MATCHED -> CAPTURING, once. Null when it was already consumed or never matched. */
export async function consumeSettlement(tx: Tx, id: string): Promise<ConsumedSettlement | null> {
  const { rows } = await tx.client.query<SettlementRecord>(
    `UPDATE ap2_settlements SET state = 'CAPTURING', consumed_at = now(), updated_at = now() WHERE id = $1 AND state = 'MATCHED' AND paypal_authorization_id IS NOT NULL RETURNING ${COLS}`,
    [id],
  );
  return rows[0] ? brandIt(rows[0]) : null;
}

async function lock(tx: Tx, id: string): Promise<SettlementRecord & { consumed: boolean } | undefined> {
  const { rows } = await tx.client.query<SettlementRecord & { consumed: boolean }>(`SELECT ${COLS}, consumed_at IS NOT NULL AS consumed FROM ap2_settlements WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0];
}

async function move(tx: Tx, s: { id: string; tenant_id: string }, from: SettlementState, to: SettlementState, payload: Record<string, unknown>, patch: { diffs?: string[]; captureId?: string; networkReference?: string } = {}) {
  const final = ["CAPTURED", "CAPTURE_DECLINED", "VOIDED"].includes(to);
  const r = await tx.client.query(
    `UPDATE ap2_settlements SET state = $3, updated_at = now(),
            diffs = coalesce($4::jsonb, diffs), paypal_capture_id = coalesce($5, paypal_capture_id), network_reference = coalesce($6, network_reference),
            settled_at = CASE WHEN $7 THEN now() ELSE settled_at END
      WHERE id = $1 AND state = $2`,
    [s.id, from, to, patch.diffs ? JSON.stringify(patch.diffs) : null, patch.captureId ?? null, patch.networkReference ?? null, final],
  );
  if (r.rowCount !== 1) throw new Error(`settlement ${s.id} is not ${from}`);
  await appendAudit(tx, { tenantId: s.tenant_id, purchaseId: null, eventType: `ap2.settlement_${to.toLowerCase()}`, payload: { settlement_id: s.id, from, ...payload } });
}

async function journal(tx: Tx, id: string, op: "capture" | "void", requestId: string): Promise<number> {
  const { rows } = await tx.client.query<{ id: string }>("INSERT INTO ap2_settlement_calls (settlement_id, op, request_id, status) VALUES ($1, $2, $3, 'PENDING') RETURNING id", [id, op, requestId]);
  return Number(rows[0]!.id);
}

async function journalDone(tx: Tx, callId: number, r: { status: "SUCCEEDED" | "FAILED" | "UNKNOWN"; httpStatus?: number; debugId?: string | null; response?: unknown; error?: string }) {
  await tx.client.query("UPDATE ap2_settlement_calls SET status = $2, http_status = $3, debug_id = $4, response = $5, error = $6, updated_at = now() WHERE id = $1", [
    callId,
    r.status,
    r.httpStatus ?? null,
    r.debugId ?? null,
    r.response === undefined ? null : JSON.stringify(r.response),
    r.error ?? null,
  ]);
}

const reconcileLater = (d: ExecutorDeps, tx: Tx, id: string, delayMs = RECONCILE_DELAY_MS) =>
  enqueue(d.boss, tx, QUEUES.ap2Reconcile, { settlementId: id }, { startAfter: new Date(nowOf(d).getTime() + delayMs), singletonKey: `ap2-reconcile:${id}` });

const expectationOf = (s: SettlementRecord) => ({
  order_id: s.paypal_order_id,
  payee_merchant_id: s.payee_merchant_id,
  currency: s.currency,
  amount_cents: Number(s.amount_minor),
  items: s.expectation.items,
});

/** Last-moment check: PayPal's order and authorization still hold exactly what was verified. */
async function recheck(d: ExecutorDeps, s: SettlementRecord): Promise<{ diffs: string[] } | { unknown: string }> {
  try {
    const order = (await d.paypal.getOrder(s.paypal_order_id)).data;
    const exp = expectationOf(s);
    return { diffs: [...threeWayMatch(exp, order), ...authorizationDiffs(exp, order, s.paypal_authorization_id ?? undefined)] };
  } catch (e) {
    if (e instanceof PayPalNetworkError || e instanceof PayPalHttpError) return { unknown: (e as Error).message };
    throw e;
  }
}

async function sendCapture(d: ExecutorDeps, s: ConsumedSettlement) {
  if (!issued.has(s)) throw new Error("capture refused: settlement was not obtained through consumeSettlement()");
  return d.money.captureAuthorization(s.paypal_authorization_id!, { currency_code: s.currency, value: fromCents(Number(s.amount_minor)) }, paypalRequestId(s.id, "capture"));
}

async function captureAndApply(d: ExecutorDeps, s: ConsumedSettlement, callId: number): Promise<string> {
  let res: Awaited<ReturnType<typeof sendCapture>> | Error;
  try {
    res = await sendCapture(d, s);
  } catch (e) {
    if (!(e instanceof PayPalNetworkError)) throw e;
    res = e;
  }
  return withTx(d.pool, async (tx) => {
    const row = await lock(tx, s.id);
    if (!row || row.state !== "CAPTURING") return `settlement is ${row?.state ?? "missing"}`;
    if (res instanceof Error) {
      await journalDone(tx, callId, { status: "UNKNOWN", error: res.message });
      await move(tx, s, "CAPTURING", "NEEDS_RECONCILE", { reason: "capture outcome unknown", error: res.message });
      await reconcileLater(d, tx, s.id);
      return "capture outcome unknown; reconciling";
    }
    if (!res.ok) {
      const issue = res.data?.details?.[0]?.issue ?? res.data?.name ?? `HTTP ${res.status}`;
      await journalDone(tx, callId, { status: "FAILED", httpStatus: res.status, debugId: res.debugId, response: res.data, error: issue });
      // PayPal refused: its own state decides what happened.
      await move(tx, s, "CAPTURING", "NEEDS_RECONCILE", { reason: "capture refused", issue });
      await reconcileLater(d, tx, s.id, 1_000);
      return `capture refused (${issue}); reconciling`;
    }
    await journalDone(tx, callId, { status: "SUCCEEDED", httpStatus: res.status, debugId: res.debugId, response: res.data });
    const status: string = res.data?.status;
    const exact = captureMatches(res.data, Number(s.amount_minor), s.currency);
    const networkReference: string | undefined = res.data?.network_transaction_reference?.id;
    const to: SettlementState = status === "COMPLETED" && exact ? "CAPTURED" : status === "DECLINED" || status === "FAILED" ? "CAPTURE_DECLINED" : "NEEDS_RECONCILE";
    await move(tx, s, "CAPTURING", to, { capture_id: res.data?.id, capture_status: status, exact }, { captureId: res.data?.id, ...(networkReference ? { networkReference } : {}) });
    if (to === "NEEDS_RECONCILE") await reconcileLater(d, tx, s.id);
    return `capture ${status}${to === "CAPTURED" ? "" : `; ${to}`}`;
  });
}

/** Job: capture a MATCHED settlement. */
export async function executeAp2Capture(d: ExecutorDeps, job: SettlementJob): Promise<string> {
  const prep = await withTx(d.pool, async (tx) => {
    const s = await consumeSettlement(tx, job.settlementId);
    if (!s) return { skip: "settlement not MATCHED (already handled)" };
    const callId = await journal(tx, s.id, "capture", paypalRequestId(s.id, "capture"));
    return { s, callId };
  });
  if ("skip" in prep) return prep.skip!;
  const { s, callId } = prep;

  const check = await recheck(d, s);
  if ("unknown" in check || check.diffs.length) {
    return withTx(d.pool, async (tx) => {
      await journalDone(tx, callId, { status: "FAILED", error: "not sent: pre-capture re-check " + ("unknown" in check ? `could not read PayPal (${check.unknown})` : "found differences") });
      if ("unknown" in check) {
        // Not sent, so nothing is unknown about the money: retry the whole job later.
        await tx.client.query("UPDATE ap2_settlements SET state = 'MATCHED', consumed_at = NULL, updated_at = now() WHERE id = $1 AND state = 'CAPTURING'", [s.id]);
        await enqueue(d.boss, tx, QUEUES.ap2Capture, { settlementId: s.id }, { startAfter: new Date(nowOf(d).getTime() + RECONCILE_DELAY_MS) });
        return "recheck unavailable; capture retried later";
      }
      await move(tx, s, "CAPTURING", "VOIDING", { reason: "pre-capture re-check found differences" }, { diffs: check.diffs });
      await enqueue(d.boss, tx, QUEUES.ap2Void, { settlementId: s.id }, { singletonKey: `ap2-void:${s.id}` });
      return "recheck failed; voiding";
    });
  }
  return captureAndApply(d, s, callId);
}

/** Job: void a settlement whose order does not hold what was verified. Confirmed with a GET. */
export async function executeAp2Void(d: ExecutorDeps, job: SettlementJob): Promise<string> {
  const prep = await withTx(d.pool, async (tx) => {
    const s = await lock(tx, job.settlementId);
    if (!s || s.state !== "VOIDING" || !s.paypal_authorization_id) return { skip: `settlement is ${s?.state ?? "missing"}` };
    return { s, callId: await journal(tx, s.id, "void", paypalRequestId(s.id, "void")) };
  });
  if ("skip" in prep) return prep.skip!;
  const { s, callId } = prep;
  let res: Awaited<ReturnType<ExecutorDeps["money"]["voidAuthorization"]>> | null = null;
  let netErr: Error | null = null;
  try {
    res = await d.money.voidAuthorization(s.paypal_authorization_id!, paypalRequestId(s.id, "void"));
  } catch (e) {
    if (!(e instanceof PayPalNetworkError)) throw e;
    netErr = e;
  }
  let status: string | null = null;
  try {
    status = (await d.paypal.getAuthorization(s.paypal_authorization_id!)).data?.status ?? null;
  } catch {
    status = null;
  }
  return withTx(d.pool, async (tx) => {
    const row = await lock(tx, s.id);
    if (!row || row.state !== "VOIDING") return `settlement is ${row?.state ?? "missing"}`;
    await journalDone(tx, callId, netErr ? { status: "UNKNOWN", error: netErr.message } : { status: res!.ok ? "SUCCEEDED" : "FAILED", httpStatus: res!.status, debugId: res!.debugId, response: res!.data });
    if (status === "VOIDED") {
      await move(tx, row, "VOIDING", "VOIDED", { authorization_status: status });
      return "voided";
    }
    await move(tx, row, "VOIDING", "NEEDS_RECONCILE", { reason: "void not confirmed", authorization_status: status });
    await reconcileLater(d, tx, s.id);
    return `void not confirmed (${status ?? "unreadable"}); reconciling`;
  });
}

/**
 * Job: settle a NEEDS_RECONCILE row from PayPal's own state. A completed capture for the exact
 * amount is CAPTURED; a voided authorization is VOIDED; a consumed settlement whose authorization
 * is still open is captured again with the same request id (PayPal answers a repeat with the
 * original capture), at most three times; a row that never consumed anything is voided.
 */
export async function reconcileAp2(d: ExecutorDeps, job: SettlementJob): Promise<string> {
  const s0 = (await d.pool.query<SettlementRecord & { consumed: boolean }>(`SELECT ${COLS}, consumed_at IS NOT NULL AS consumed FROM ap2_settlements WHERE id = $1`, [job.settlementId])).rows[0];
  if (!s0 || s0.state !== "NEEDS_RECONCILE") return `settlement is ${s0?.state ?? "missing"}`;
  let order: unknown;
  try {
    order = (await d.paypal.getOrder(s0.paypal_order_id)).data;
  } catch (e) {
    if (!(e instanceof PayPalNetworkError || e instanceof PayPalHttpError)) throw e;
    await withTx(d.pool, (tx) => reconcileLater(d, tx, s0.id));
    return "PayPal unreadable; retrying";
  }
  const capture = capturesOf(order).find((c) => c.status === "COMPLETED" && c.amount_cents === Number(s0.amount_minor) && c.currency === s0.currency);
  const auth = authorizationOf(order);

  const resolved = await withTx(d.pool, async (tx) => {
    const s = await lock(tx, s0.id);
    if (!s || s.state !== "NEEDS_RECONCILE") return `settlement is ${s?.state ?? "missing"}`;
    if (capture) {
      await move(tx, s, "NEEDS_RECONCILE", "CAPTURED", { capture_id: capture.id, via: "reconcile" }, { captureId: capture.id });
      return "captured (reconciled)";
    }
    if (auth?.status === "VOIDED") {
      await move(tx, s, "NEEDS_RECONCILE", "VOIDED", { via: "reconcile" });
      return "voided (reconciled)";
    }
    if (auth?.status !== "CREATED") return `authorization is ${auth?.status ?? "unreadable"}; left for review`;
    const { rows } = await tx.client.query<{ n: string }>("SELECT count(*)::text AS n FROM ap2_settlement_calls WHERE settlement_id = $1 AND op = 'capture' AND status <> 'FAILED'", [s.id]);
    const attempts = Number(rows[0]!.n);
    if (!s.consumed || attempts >= MAX_CAPTURE_ATTEMPTS) {
      await move(tx, s, "NEEDS_RECONCILE", "VOIDING", { reason: s.consumed ? `capture not confirmed after ${attempts} attempts` : "never consumed" });
      await enqueue(d.boss, tx, QUEUES.ap2Void, { settlementId: s.id }, { singletonKey: `ap2-void:${s.id}` });
      return "voiding";
    }
    await move(tx, s, "NEEDS_RECONCILE", "CAPTURING", { reason: "retrying the same capture", attempt: attempts + 1 });
    return { retry: brandIt(s), callId: await journal(tx, s.id, "capture", paypalRequestId(s.id, "capture")) };
  });
  if (typeof resolved === "string") return resolved;
  return captureAndApply(d, resolved.retry, resolved.callId);
}
