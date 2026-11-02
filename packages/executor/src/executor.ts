// The executor: the only code that captures or voids. It runs only in the worker (no HTTP port),
// consumes single-use approvals, re-checks PayPal's order immediately before capturing, journals
// every money call before making it, and reconciles anything whose outcome is unknown.

import { and, desc, eq, inArray } from "drizzle-orm";
import { authorizationDiffs, authorizationOf, captureMatches, capturesOf, expectationFor, fromCents, paypalRequestId, threeWayMatch, type PurchaseState, type ResolvedCart } from "@witness/core";
import {
  QUEUES,
  dbOf,
  enqueue,
  journalFinish,
  journalStart,
  lockPurchase,
  recordChecks,
  recordDecision,
  schema,
  transition,
  withTx,
  type PurchaseJob,
  type PurchasePatch,
  type PurchaseRow,
  type Tx,
} from "@witness/db";
import { authorizePurchase, logOf, nowOf, verifyPurchase, type EngineDeps } from "@witness/engine";
import { PayPalHttpError, PayPalNetworkError } from "@witness/paypal";
import type { MoneyMovementClient } from "@witness/paypal/money-movement";
import { assertConsumed, consumeApproval, reloadConsumedApproval, type ConsumedApproval } from "./approvals.ts";
import { schedulePayout } from "./payout.ts";

const { intents, paypalCalls, holds, purchases } = schema;

export type ExecutorDeps = EngineDeps & { money: MoneyMovementClient };

const RECONCILE_DELAY_MS = 30_000;
const MAX_CAPTURE_ATTEMPTS = 3;
/** A capture journaled but not resolved for this long is treated as interrupted. */
const STALE_CAPTURING_MS = 2 * 60_000;

async function scheduleReconcile(d: ExecutorDeps, tx: Tx, job: PurchaseJob, delayMs = RECONCILE_DELAY_MS) {
  await enqueue(d.boss, tx, QUEUES.reconcile, { tenantId: job.tenantId, purchaseId: job.purchaseId }, {
    startAfter: new Date(nowOf(d).getTime() + delayMs),
    singletonKey: `reconcile:${job.purchaseId}`,
  });
}

async function decideVoid(d: ExecutorDeps, tx: Tx, p: PurchaseRow, from: PurchaseState, reasons: string[], decidedBy: string) {
  await recordDecision(tx, p.id, "VOID", reasons, decidedBy);
  await transition(tx, { tenantId: p.tenantId, purchaseId: p.id, from, to: "VOIDING", event: "purchase.void_decided", payload: { reasons, decided_by: decidedBy }, patch: { outcome: "VOID", reasons } });
  await enqueue(d.boss, tx, QUEUES.void, { tenantId: p.tenantId, purchaseId: p.id }, { singletonKey: `void:${p.id}` });
}

/** The last-moment check: PayPal's order and authorization must still match the approval exactly. */
async function recheck(d: ExecutorDeps, p: PurchaseRow, a: ConsumedApproval): Promise<{ diffs: string[] } | { unknown: string }> {
  try {
    const order = (await d.paypal.getOrder(a.paypal_order_id)).data;
    const exp = { ...expectationFor(p.cart as ResolvedCart, a.paypal_order_id, a.payee_merchant_id), amount_cents: a.amount_cents, currency: a.currency };
    return { diffs: [...threeWayMatch(exp, order), ...authorizationDiffs(exp, order, a.paypal_authorization_id)] };
  } catch (e) {
    if (e instanceof PayPalNetworkError || e instanceof PayPalHttpError) return { unknown: (e as Error).message };
    throw e;
  }
}

/** Send the capture for an approval that was obtained through consumeApproval (brand + WeakSet). */
async function sendCapture(d: ExecutorDeps, a: ConsumedApproval) {
  assertConsumed(a);
  return d.money.captureAuthorization(a.paypal_authorization_id, { currency_code: a.currency, value: fromCents(a.amount_cents) }, a.request_id);
}

/** Apply a capture response. Shared by first attempt and reconciliation retries. */
async function applyCaptureResult(d: ExecutorDeps, job: PurchaseJob, journalId: number, outcome: Awaited<ReturnType<typeof sendCapture>> | Error) {
  await withTx(d.pool, async (tx) => {
    const p = await lockPurchase(tx, job.tenantId, job.purchaseId);
    if (!p || p.state !== "CAPTURING") return;
    if (outcome instanceof Error) {
      await journalFinish(tx.db, journalId, { status: "UNKNOWN", error: outcome.message });
      await transition(tx, { tenantId: p.tenantId, purchaseId: p.id, from: "CAPTURING", to: "NEEDS_RECONCILE", event: "capture.outcome_unknown", payload: { error: outcome.message } });
      await scheduleReconcile(d, tx, job);
      return;
    }
    const r = outcome;
    if (!r.ok) {
      const issue = r.data?.details?.[0]?.issue ?? r.data?.name ?? `HTTP ${r.status}`;
      await journalFinish(tx.db, journalId, { status: "FAILED", httpStatus: r.status, debugId: r.debugId, response: r.data, error: issue });
      // PayPal refused. Its own state decides what happened, so reconcile rather than guess.
      await transition(tx, { tenantId: p.tenantId, purchaseId: p.id, from: "CAPTURING", to: "NEEDS_RECONCILE", event: "capture.refused", payload: { issue, http_status: r.status, debug_id: r.debugId } });
      await scheduleReconcile(d, tx, job, 1_000);
      return;
    }
    await journalFinish(tx.db, journalId, { status: "SUCCEEDED", httpStatus: r.status, debugId: r.debugId, response: r.data });
    const status: string = r.data?.status;
    const captureId: string | undefined = r.data?.id;
    // COMPLETED alone is not enough: the capture must be for exactly the approved amount.
    const exact = captureMatches(r.data, p.amountCents!, p.currency!);
    const to: PurchaseState = status === "COMPLETED" ? (exact ? "CAPTURED" : "NEEDS_RECONCILE") : status === "PENDING" ? "CAPTURE_PENDING" : status === "DECLINED" || status === "FAILED" ? "CAPTURE_DECLINED" : "NEEDS_RECONCILE";
    await transition(tx, {
      tenantId: p.tenantId,
      purchaseId: p.id,
      from: "CAPTURING",
      to,
      event: to === "CAPTURED" ? "purchase.captured" : status === "COMPLETED" ? "capture.amount_unverified" : `capture.${String(status).toLowerCase()}`,
      payload: { capture_id: captureId, capture_status: status, amount_cents: p.amountCents, debug_id: r.debugId },
      patch: captureId ? { paypalCaptureId: captureId } : {},
    });
    if (to === "NEEDS_RECONCILE") await scheduleReconcile(d, tx, job);
    // Second Key: a verified capture of a transfer is paid on to the confirmed recipient.
    if (to === "CAPTURED") await schedulePayout(d, tx, p);
  });
}

/** Job: capture(approvalId). */
export async function executeCapture(d: ExecutorDeps, job: PurchaseJob): Promise<string> {
  if (!job.approvalId) throw new Error("capture job without approvalId");
  const prep = await withTx(d.pool, async (tx) => {
    const p = await lockPurchase(tx, job.tenantId, job.purchaseId);
    if (!p) return { skip: "purchase not found" };
    if (p.state !== "CAPTURE_APPROVED") return { skip: `purchase is ${p.state}` }; // already handled: idempotent no-op

    const a = await consumeApproval(tx, { approvalId: job.approvalId!, tenantId: job.tenantId, purchaseId: job.purchaseId });
    if (!a) {
      await decideVoid(d, tx, p, "CAPTURE_APPROVED", ["approval expired or already used before the executor ran"], "executor");
      return { skip: "approval unusable; voiding" };
    }
    const bound =
      a.paypal_order_id === p.paypalOrderId &&
      a.paypal_authorization_id === p.paypalAuthorizationId &&
      a.cart_digest === p.cartDigest &&
      a.policy_digest === p.policyDigest &&
      a.amount_cents === p.amountCents &&
      a.currency === p.currency;
    const intent = (await tx.db.select().from(intents).where(eq(intents.id, p.intentId)).limit(1))[0];
    const live = intent?.status === "CONFIRMED" && intent.policyDigest === a.policy_digest && intent.version === a.intent_version;
    if (!bound || !live) {
      const reasons = [!bound ? "approval is not bound to this purchase's order, authorization, cart and amount" : `intent is ${intent?.status ?? "missing"}; approval is stale`];
      await decideVoid(d, tx, p, "CAPTURE_APPROVED", reasons, "executor");
      return { skip: reasons[0]! };
    }
    await transition(tx, { tenantId: p.tenantId, purchaseId: p.id, from: "CAPTURE_APPROVED", to: "CAPTURING", event: "capture.started", payload: { approval_id: a.id, request_id: a.request_id } });
    const journalId = await journalStart(tx, { purchaseId: p.id, op: "capture", requestId: a.request_id, request: { authorization_id: a.paypal_authorization_id, amount_cents: a.amount_cents, currency: a.currency, final_capture: true } });
    return { p, a, journalId };
  });
  if ("skip" in prep) return prep.skip!;
  return captureWithRecheck(d, job, prep.p, prep.a, prep.journalId);
}

async function captureWithRecheck(d: ExecutorDeps, job: PurchaseJob, p: PurchaseRow, a: ConsumedApproval, journalId: number): Promise<string> {
  const check = await recheck(d, p, a);
  if ("unknown" in check) {
    await applyCaptureResult(d, job, journalId, new Error(`pre-capture re-check could not read PayPal: ${check.unknown}`));
    return "recheck unavailable; reconciling";
  }
  if (check.diffs.length) {
    await withTx(d.pool, async (tx) => {
      const locked = await lockPurchase(tx, job.tenantId, job.purchaseId);
      if (!locked || locked.state !== "CAPTURING") return;
      await journalFinish(tx.db, journalId, { status: "FAILED", error: "not sent: pre-capture re-check found differences" });
      await recordChecks(tx, p.id, "RECHECK", check.diffs.map((detail) => ({ id: "three_way_match", result: "fail" as const, detail })));
      await decideVoid(d, tx, locked, "CAPTURING", check.diffs, "executor:recheck");
    });
    return "recheck failed; voiding";
  }
  let res: Awaited<ReturnType<typeof sendCapture>> | Error;
  try {
    res = await sendCapture(d, a);
  } catch (e) {
    if (!(e instanceof PayPalNetworkError)) throw e;
    res = e;
  }
  await applyCaptureResult(d, job, journalId, res);
  return res instanceof Error ? "capture outcome unknown; reconciling" : `capture HTTP ${res.status}`;
}

/** Job: void. Idempotent (deterministic request ID); confirms the result with a GET. */
export async function executeVoid(d: ExecutorDeps, job: PurchaseJob): Promise<string> {
  const prep = await withTx(d.pool, async (tx) => {
    const p = await lockPurchase(tx, job.tenantId, job.purchaseId);
    if (!p) return { skip: "purchase not found" };
    if (p.state !== "VOIDING") return { skip: `purchase is ${p.state}` };
    const requestId = paypalRequestId(p.id, "void");
    const journalId = await journalStart(tx, { purchaseId: p.id, op: "void", requestId, request: { authorization_id: p.paypalAuthorizationId } });
    return { p, requestId, journalId };
  });
  if ("skip" in prep) return prep.skip!;
  const { p, requestId, journalId } = prep;

  let res: Awaited<ReturnType<MoneyMovementClient["voidAuthorization"]>> | null = null;
  let netErr: Error | null = null;
  try {
    res = await d.money.voidAuthorization(p.paypalAuthorizationId!, requestId);
  } catch (e) {
    if (!(e instanceof PayPalNetworkError)) throw e;
    netErr = e;
  }

  // Whatever the response, PayPal's authorization status is the truth.
  let authStatus: string | null = null;
  try {
    authStatus = (await d.paypal.getAuthorization(p.paypalAuthorizationId!)).data?.status ?? null;
  } catch {
    authStatus = null;
  }

  await withTx(d.pool, async (tx) => {
    const locked = await lockPurchase(tx, job.tenantId, job.purchaseId);
    if (!locked || locked.state !== "VOIDING") return;
    await journalFinish(tx.db, journalId, {
      status: authStatus === "VOIDED" ? "SUCCEEDED" : netErr ? "UNKNOWN" : res?.ok ? "SUCCEEDED" : "FAILED",
      httpStatus: res?.status ?? null,
      debugId: res?.debugId ?? null,
      response: res?.data ?? null,
      error: netErr?.message ?? (res && !res.ok ? (res.data?.details?.[0]?.issue ?? `HTTP ${res.status}`) : null),
    });
    if (authStatus === "VOIDED") {
      await transition(tx, { tenantId: locked.tenantId, purchaseId: locked.id, from: "VOIDING", to: "VOIDED", event: "purchase.voided", payload: { authorization_id: locked.paypalAuthorizationId, captured_cents: 0, debug_id: res?.debugId ?? null } });
      await tx.db.update(holds).set({ resolvedAt: nowOf(d) }).where(and(eq(holds.purchaseId, locked.id)));
      return;
    }
    if (authStatus === "CAPTURED" || authStatus === "PARTIALLY_CAPTURED") {
      logOf(d).error("void requested but PayPal shows the authorization captured", { purchaseId: locked.id, authStatus });
    }
    await transition(tx, { tenantId: locked.tenantId, purchaseId: locked.id, from: "VOIDING", to: "NEEDS_RECONCILE", event: "void.unconfirmed", payload: { authorization_status: authStatus, error: netErr?.message ?? null } });
    await scheduleReconcile(d, tx, job);
  });
  return authStatus === "VOIDED" ? "voided" : `void unconfirmed (authorization ${authStatus ?? "unreadable"})`;
}

/** Job: HOLD timeout. Auto-void a purchase the shopper never decided on. */
export async function holdTimeout(d: ExecutorDeps, job: PurchaseJob): Promise<string> {
  return withTx(d.pool, async (tx) => {
    const p = await lockPurchase(tx, job.tenantId, job.purchaseId);
    if (!p || p.state !== "HELD") return `purchase is ${p?.state ?? "missing"}`;
    const hold = (await tx.db.select().from(holds).where(eq(holds.purchaseId, p.id)).limit(1))[0];
    if (hold && hold.autoVoidAt.getTime() > nowOf(d).getTime()) return "not due yet";
    await tx.db.update(holds).set({ resolvedAt: nowOf(d), resolution: "TIMEOUT" }).where(eq(holds.purchaseId, p.id));
    await decideVoid(d, tx, p, "HELD", [hold?.approver === "guardian" ? "nobody approved the payment before the auto-void deadline" : "the shopper did not approve the HOLD before the auto-void deadline"], "timeout");
    return "auto-voided";
  });
}

/**
 * Job: reconcile. Reads PayPal's own state and moves the purchase to match it. Safe to run any
 * number of times; this is what makes "PayPal succeeded but Witness didn't record it" recoverable.
 */
export async function reconcile(d: ExecutorDeps, job: PurchaseJob): Promise<string> {
  const p = (await dbOf(d.pool).select().from(purchases).where(and(eq(purchases.id, job.purchaseId), eq(purchases.tenantId, job.tenantId))).limit(1))[0];
  if (!p) return "purchase not found";

  switch (p.state) {
    case "AUTHORIZING":
      await authorizePurchase(d, p.tenantId, p.id);
      await verifyPurchase(d, p.tenantId, p.id);
      return "re-ran authorize/verify";
    case "VERIFYING":
      await verifyPurchase(d, p.tenantId, p.id);
      return "re-ran verify";
    case "VOIDING":
      return executeVoid(d, job);
    case "HELD":
      return holdTimeout(d, job);
    case "CAPTURE_APPROVED": {
      const a = (await dbOf(d.pool).select().from(schema.approvals).where(eq(schema.approvals.purchaseId, p.id)).limit(1))[0];
      return a ? executeCapture(d, { ...job, approvalId: a.id }) : "no approval found";
    }
    case "CAPTURE_PENDING":
    case "CAPTURING":
    case "NEEDS_RECONCILE":
      return reconcileMoney(d, job, p);
    default:
      return `nothing to reconcile in ${p.state}`;
  }
}

async function reconcileMoney(d: ExecutorDeps, job: PurchaseJob, p: PurchaseRow): Promise<string> {
  let order: unknown;
  try {
    order = (await d.paypal.getOrder(p.paypalOrderId!)).data;
  } catch (e) {
    await withTx(d.pool, (tx) => scheduleReconcile(d, tx, job, 60_000));
    return `PayPal unreadable (${(e as Error).message}); retrying later`;
  }
  const captures = capturesOf(order);
  const auth = authorizationOf(order);
  const completedAny = captures.find((c) => c.status === "COMPLETED");
  const completed = captures.find((c) => c.status === "COMPLETED" && c.amount_cents === p.amountCents && c.currency === p.currency);
  const pending = captures.find((c) => c.status === "PENDING");
  const declined = captures.find((c) => c.status === "DECLINED" || c.status === "FAILED");

  const lastMoneyCall = (
    await dbOf(d.pool)
      .select()
      .from(paypalCalls)
      .where(and(eq(paypalCalls.purchaseId, p.id), inArray(paypalCalls.op, ["capture", "void"])))
      .orderBy(desc(paypalCalls.id))
      .limit(1)
  )[0];

  type Plan = { to: PurchaseState; event: string; patch?: PurchasePatch; followUp?: boolean } | { retry: "capture" | "void" } | { wait: string };
  let plan: Plan;
  if (completed) plan = { to: "CAPTURED", event: "purchase.captured", patch: { paypalCaptureId: completed.id } };
  // Money moved, but not the approved amount: never call that CAPTURED, never retry; an operator decides.
  else if (completedAny) plan = { wait: `completed capture ${completedAny.id} is ${completedAny.amount_cents} ${completedAny.currency}, not the approved ${p.amountCents} ${p.currency}; operator review` };
  else if (pending) plan = p.state === "CAPTURE_PENDING" ? { wait: "capture still pending" } : { to: "CAPTURE_PENDING", event: "capture.pending", patch: { paypalCaptureId: pending.id } };
  else if (declined) plan = { to: "CAPTURE_DECLINED", event: "capture.declined", patch: { paypalCaptureId: declined.id } };
  else if (auth?.status === "VOIDED") plan = p.state === "NEEDS_RECONCILE" ? { to: "VOIDED", event: "purchase.voided" } : { wait: `authorization voided while ${p.state}` };
  else if (auth?.status === "CREATED" && p.state === "NEEDS_RECONCILE") plan = { retry: lastMoneyCall?.op === "void" ? "void" : "capture" };
  else if (auth?.status === "CREATED" && p.state === "CAPTURING" && nowOf(d).getTime() - p.updatedAt.getTime() > STALE_CAPTURING_MS)
    plan = { to: "NEEDS_RECONCILE", event: "capture.stalled", followUp: true };
  else plan = { wait: `authorization ${auth?.status ?? "unknown"} in state ${p.state}` };

  if ("wait" in plan) {
    await withTx(d.pool, (tx) => scheduleReconcile(d, tx, job, 60_000));
    return plan.wait;
  }

  if ("retry" in plan && plan.retry === "void") {
    await withTx(d.pool, async (tx) => {
      const locked = await lockPurchase(tx, job.tenantId, job.purchaseId);
      if (locked?.state === "NEEDS_RECONCILE") {
        await transition(tx, { tenantId: locked.tenantId, purchaseId: locked.id, from: "NEEDS_RECONCILE", to: "VOIDING", event: "void.retry" });
      }
    });
    return executeVoid(d, job);
  }

  if ("retry" in plan) {
    // The approval was already consumed by the first attempt; retry with the SAME request ID so
    // PayPal returns the existing capture if the first one actually went through.
    const prep = await withTx(d.pool, async (tx) => {
      const locked = await lockPurchase(tx, job.tenantId, job.purchaseId);
      if (!locked || locked.state !== "NEEDS_RECONCILE") return { skip: "state moved" };
      const attempts = (await tx.db.select().from(paypalCalls).where(and(eq(paypalCalls.purchaseId, locked.id), eq(paypalCalls.op, "capture")))).length;
      if (attempts >= MAX_CAPTURE_ATTEMPTS) {
        logOf(d).error("capture retries exhausted; needs a human", { purchaseId: locked.id, attempts });
        return { skip: `capture retries exhausted (${attempts})` };
      }
      const a = await reloadConsumedApproval(tx, { tenantId: job.tenantId, purchaseId: job.purchaseId });
      if (!a) return { skip: "no consumed approval" };
      await transition(tx, { tenantId: locked.tenantId, purchaseId: locked.id, from: "NEEDS_RECONCILE", to: "CAPTURING", event: "capture.retry", payload: { attempt: attempts + 1, request_id: a.request_id } });
      const journalId = await journalStart(tx, { purchaseId: locked.id, op: "capture", requestId: a.request_id, request: { authorization_id: a.paypal_authorization_id, amount_cents: a.amount_cents, retry: attempts + 1 } });
      return { locked, a, journalId };
    });
    if ("skip" in prep) return prep.skip!;
    return captureWithRecheck(d, job, prep.locked, prep.a, prep.journalId);
  }

  await withTx(d.pool, async (tx) => {
    const locked = await lockPurchase(tx, job.tenantId, job.purchaseId);
    if (!locked || locked.state !== p.state) return;
    await transition(tx, { tenantId: locked.tenantId, purchaseId: locked.id, from: locked.state as PurchaseState, to: plan.to, event: plan.event, payload: { reconciled: true }, patch: plan.patch ?? {} });
    if (plan.followUp) await scheduleReconcile(d, tx, job, 1_000);
    if (plan.to === "CAPTURED") await schedulePayout(d, tx, locked);
  });
  return `reconciled to ${plan.to}`;
}
