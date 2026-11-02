// Second Key recipient payout: the executor pays the recipient after a verified capture.
//
// Rules:
//   - only a transfer, only in CAPTURED (the capture matched the approved amount exactly), and only to
//     the email the payer confirmed in the intent: never to anything from a request or a model;
//   - one payout per purchase (primary key), a deterministic sender_batch_id and PayPal-Request-Id,
//     so a retry after a timeout returns the original batch and can never pay twice;
//   - the purchase stays CAPTURED; the payout's own status is read back from PayPal until it settles.

import { and, eq } from "drizzle-orm";
import { fromCents, paypalRequestId } from "@witness/core";
import { QUEUES, appendAudit, dbOf, enqueue, journalFinish, journalStart, schema, withTx, type PurchaseRow, type Tx } from "@witness/db";
import { logOf, nowOf, recordPaidPayee } from "@witness/engine";
import { PayPalHttpError, PayPalNetworkError } from "@witness/paypal";
import type { ExecutorDeps } from "./executor.ts";

const { payouts, purchases, intents } = schema;

export interface PayoutJob {
  tenantId: string;
  purchaseId: string;
}

/** Final from Second Key's point of view: stop polling. UNCLAIMED means no PayPal account yet (PayPal returns it after 30 days). */
const SETTLED = new Set(["SUCCESS", "UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"]);
const MAX_CHECKS = 20;
/** A payout journaled but unanswered for this long is retried with the same request ID. */
const STALE_SENDING_MS = 2 * 60_000;

const checkDelay = (n: number) => Math.min(5_000 * 2 ** n, 5 * 60_000);

/** The confirmed recipient email for a transfer purchase, or null (shopping, or no email confirmed). */
export async function payoutReceiver(tx: Tx, p: PurchaseRow): Promise<string | null> {
  if ((p.request as { kind?: string } | null)?.kind !== "transfer") return null;
  const intent = (await tx.db.select().from(intents).where(eq(intents.id, p.intentId)).limit(1))[0];
  const policy = intent?.policy as { kind?: string; payee?: { email?: string } } | undefined;
  return policy?.kind === "transfer" && typeof policy.payee?.email === "string" ? policy.payee.email : null;
}

/**
 * Called in the same transaction that moves a purchase to CAPTURED. A captured transfer also records the
 * payee in the payer's history (ADR-0020): only a verified capture establishes "paid before".
 */
export async function schedulePayout(d: ExecutorDeps, tx: Tx, p: PurchaseRow): Promise<boolean> {
  await recordPaidPayee(tx, p, nowOf(d));
  if (!(await payoutReceiver(tx, p))) return false;
  await enqueue(d.boss, tx, QUEUES.payout, { tenantId: p.tenantId, purchaseId: p.id }, { singletonKey: `payout:${p.id}` });
  return true;
}

/** Job: create the payout (idempotent). */
export async function executePayout(d: ExecutorDeps, job: PayoutJob): Promise<string> {
  const requestId = paypalRequestId(job.purchaseId, "payout");
  const prep = await withTx(d.pool, async (tx) => {
    const p = (await tx.db.select().from(purchases).where(and(eq(purchases.id, job.purchaseId), eq(purchases.tenantId, job.tenantId))).for("update").limit(1))[0];
    if (!p) return { skip: "purchase not found" };
    if (p.state !== "CAPTURED" || p.amountCents == null || !p.currency) return { skip: `purchase is ${p.state}; payouts only follow a verified capture` };
    const receiver = await payoutReceiver(tx, p);
    if (!receiver) return { skip: "no confirmed recipient email; nothing to pay out" };

    const existing = (await tx.db.select().from(payouts).where(eq(payouts.purchaseId, p.id)).for("update").limit(1))[0];
    if (existing) {
      const stale = existing.status === "SENDING" && nowOf(d).getTime() - existing.updatedAt.getTime() > STALE_SENDING_MS;
      if (existing.status !== "UNKNOWN" && !stale) return { skip: `payout already ${existing.status}` };
      await tx.db.update(payouts).set({ status: "SENDING", updatedAt: nowOf(d) }).where(eq(payouts.purchaseId, p.id));
    } else {
      await tx.db.insert(payouts).values({ purchaseId: p.id, tenantId: p.tenantId, receiver, amountCents: p.amountCents, currency: p.currency, senderBatchId: `sk-${p.id}`, requestId, status: "SENDING" });
      await appendAudit(tx, { tenantId: p.tenantId, purchaseId: p.id, eventType: "payout.requested", payload: { amount_cents: p.amountCents, currency: p.currency, request_id: requestId } });
    }
    const journalId = await journalStart(tx, { purchaseId: p.id, op: "payout", requestId, request: { sender_batch_id: `sk-${p.id}`, amount_cents: p.amountCents, currency: p.currency } });
    return { p, receiver, journalId };
  });
  if ("skip" in prep) return prep.skip!;
  const { p, receiver, journalId } = prep;

  let res: Awaited<ReturnType<ExecutorDeps["money"]["createPayout"]>> | Error;
  try {
    res = await d.money.createPayout(
      { senderBatchId: `sk-${p.id}`, senderItemId: p.id, receiver, amount: { currency: p.currency!, value: fromCents(p.amountCents!) }, note: "Second Key sandbox transfer, approved and captured" },
      requestId,
    );
  } catch (e) {
    if (!(e instanceof PayPalNetworkError)) throw e;
    res = e;
  }

  // A 5xx is not a refusal: PayPal may have created the batch. Same handling as a timeout.
  if (!(res instanceof Error) && res.status >= 500) res = new Error(`PayPal HTTP ${res.status} (debug ${res.debugId ?? "?"})`);

  return withTx(d.pool, async (tx) => {
    if (res instanceof Error) {
      // The batch may or may not exist: retry later with the SAME request ID (PayPal returns the original).
      await journalFinish(tx.db, journalId, { status: "UNKNOWN", error: res.message });
      await tx.db.update(payouts).set({ status: "UNKNOWN", lastError: res.message.slice(0, 300), updatedAt: nowOf(d) }).where(eq(payouts.purchaseId, p.id));
      await appendAudit(tx, { tenantId: p.tenantId, purchaseId: p.id, eventType: "payout.outcome_unknown", payload: { error: res.message.slice(0, 200) } });
      await enqueue(d.boss, tx, QUEUES.payout, job, { startAfter: new Date(nowOf(d).getTime() + 30_000), singletonKey: `payout:${p.id}` });
      return "payout outcome unknown; retrying with the same request ID";
    }
    if (!res.ok) {
      const issue = res.data?.details?.[0]?.issue ?? res.data?.name ?? `HTTP ${res.status}`;
      await journalFinish(tx.db, journalId, { status: "FAILED", httpStatus: res.status, debugId: res.debugId, response: res.data, error: issue });
      await tx.db.update(payouts).set({ status: "FAILED", lastError: String(issue).slice(0, 300), updatedAt: nowOf(d) }).where(eq(payouts.purchaseId, p.id));
      await appendAudit(tx, { tenantId: p.tenantId, purchaseId: p.id, eventType: "payout.failed", payload: { issue, http_status: res.status, debug_id: res.debugId } });
      return `payout refused: ${issue}`;
    }
    const batchId: string | undefined = res.data?.batch_header?.payout_batch_id;
    await journalFinish(tx.db, journalId, { status: "SUCCEEDED", httpStatus: res.status, debugId: res.debugId, response: res.data });
    await tx.db.update(payouts).set({ status: "PENDING", batchId: batchId ?? null, lastError: null, updatedAt: nowOf(d) }).where(eq(payouts.purchaseId, p.id));
    await appendAudit(tx, { tenantId: p.tenantId, purchaseId: p.id, eventType: "payout.accepted", payload: { batch_id: batchId, batch_status: res.data?.batch_header?.batch_status, debug_id: res.debugId } });
    await enqueue(d.boss, tx, QUEUES.payoutCheck, job, { startAfter: new Date(nowOf(d).getTime() + checkDelay(0)), singletonKey: `payout-check:${p.id}` });
    return `payout accepted (batch ${batchId})`;
  });
}

/** Job: read the payout back from PayPal until its item settles. */
export async function checkPayout(d: ExecutorDeps, job: PayoutJob): Promise<string> {
  const row = (await dbOf(d.pool).select().from(payouts).where(and(eq(payouts.purchaseId, job.purchaseId), eq(payouts.tenantId, job.tenantId))).limit(1))[0];
  if (!row) return "no payout";
  if (!row.batchId) return `payout has no batch yet (${row.status})`;
  if (SETTLED.has(row.status)) return `payout already ${row.status}`;

  let item: { payout_item_id?: string; transaction_status?: string; errors?: { name?: string } } | undefined;
  try {
    const r = await d.paypal.getPayoutBatch(row.batchId);
    item = r.data?.items?.[0];
  } catch (e) {
    if (!(e instanceof PayPalNetworkError || e instanceof PayPalHttpError)) throw e;
    logOf(d).warn("payout check failed; will retry", { purchaseId: row.purchaseId, error: (e as Error).message });
  }

  return withTx(d.pool, async (tx) => {
    const status = item?.transaction_status;
    const n = row.checks + 1;
    if (status && status !== row.status) {
      await tx.db
        .update(payouts)
        .set({ status: status as (typeof schema.PAYOUT_STATUSES)[number], itemId: item?.payout_item_id ?? row.itemId, lastError: item?.errors?.name ?? null, checks: n, updatedAt: nowOf(d) })
        .where(eq(payouts.purchaseId, row.purchaseId));
      const event = status === "SUCCESS" ? "payout.succeeded" : status === "UNCLAIMED" ? "payout.unclaimed" : SETTLED.has(status) ? "payout.failed" : "payout.status";
      await appendAudit(tx, { tenantId: row.tenantId, purchaseId: row.purchaseId, eventType: event, payload: { batch_id: row.batchId, item_id: item?.payout_item_id, transaction_status: status, error: item?.errors?.name ?? null } });
    } else {
      await tx.db.update(payouts).set({ checks: n, updatedAt: nowOf(d) }).where(eq(payouts.purchaseId, row.purchaseId));
    }
    if (status && SETTLED.has(status)) return `payout ${status}`;
    if (n >= MAX_CHECKS) return `payout still ${status ?? row.status} after ${n} checks; the sweep will look again`;
    await enqueue(d.boss, tx, QUEUES.payoutCheck, job, { startAfter: new Date(nowOf(d).getTime() + checkDelay(n)), singletonKey: `payout-check:${row.purchaseId}` });
    return `payout ${status ?? row.status}; checking again`;
  });
}

/** Sweep helper: captured transfers that should have a payout but don't, and payouts still unsettled. */
export async function sweepPayouts(d: ExecutorDeps): Promise<number> {
  const { rows } = await d.pool.query(
    `SELECT p.id, p.tenant_id, po.status
       FROM purchases p
       JOIN intents i ON i.id = p.intent_id
       LEFT JOIN payouts po ON po.purchase_id = p.id
      WHERE p.state = 'CAPTURED' AND p.request->>'kind' = 'transfer' AND i.policy->'payee'->>'email' IS NOT NULL
        AND (po.purchase_id IS NULL OR po.status IN ('UNKNOWN', 'SENDING', 'PENDING', 'ONHOLD'))
        AND p.updated_at < now() - interval '1 minute'
      LIMIT 100`,
  );
  for (const r of rows) {
    const queue = r.status === "PENDING" || r.status === "ONHOLD" ? QUEUES.payoutCheck : QUEUES.payout;
    await withTx(d.pool, (tx) => enqueue(d.boss, tx, queue, { tenantId: r.tenant_id, purchaseId: r.id }, { singletonKey: `${queue === QUEUES.payout ? "payout" : "payout-check"}:${r.id}` }));
  }
  return rows.length;
}
