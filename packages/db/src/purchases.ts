// Purchase persistence. Every state change goes through `transition`, which checks the
// state-machine table, applies an optimistic lock on the current state, and appends the
// audit event in the same transaction.

import { and, eq, sql } from "drizzle-orm";
import { assertTransition, type Check, type Outcome, type PurchaseState } from "@witness/core";
import { appendAudit } from "./audit.ts";
import { checks, decisions, paypalCalls, purchases } from "./schema.ts";
import type { Db, Tx } from "./tx.ts";

export type PurchaseRow = typeof purchases.$inferSelect;

export class StaleTransition extends Error {}

export type PurchasePatch = Partial<
  Pick<
    typeof purchases.$inferInsert,
    | "outcome"
    | "reasons"
    | "retailer"
    | "cart"
    | "cartDigest"
    | "facts"
    | "amountCents"
    | "currency"
    | "paypalOrderId"
    | "paypalAuthorizationId"
    | "paypalCaptureId"
    | "authorizedAt"
  >
>;

export interface TransitionArgs {
  tenantId: string;
  purchaseId: string;
  from: PurchaseState;
  to: PurchaseState;
  patch?: PurchasePatch;
  event: string;
  payload?: Record<string, unknown>;
}

export async function transition(tx: Tx, a: TransitionArgs): Promise<PurchaseRow> {
  assertTransition(a.from, a.to);
  const rows = await tx.db
    .update(purchases)
    .set({ ...a.patch, state: a.to, version: sql`${purchases.version} + 1`, updatedAt: new Date() })
    .where(and(eq(purchases.id, a.purchaseId), eq(purchases.tenantId, a.tenantId), eq(purchases.state, a.from)))
    .returning();
  if (rows.length !== 1) {
    throw new StaleTransition(`purchase ${a.purchaseId} is no longer ${a.from} (wanted ${a.to})`);
  }
  await appendAudit(tx, {
    tenantId: a.tenantId,
    purchaseId: a.purchaseId,
    eventType: a.event,
    payload: { from: a.from, to: a.to, ...a.payload },
  });
  return rows[0]!;
}

export async function getPurchase(db: Db, tenantId: string, id: string): Promise<PurchaseRow | null> {
  const rows = await db.select().from(purchases).where(and(eq(purchases.id, id), eq(purchases.tenantId, tenantId))).limit(1);
  return rows[0] ?? null;
}

/** Worker-side read (jobs carry tenantId, so this still scopes by tenant). Locks the row. */
export async function lockPurchase(tx: Tx, tenantId: string, id: string): Promise<PurchaseRow | null> {
  const rows = await tx.db
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, id), eq(purchases.tenantId, tenantId)))
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

export async function recordChecks(tx: Tx, purchaseId: string, phase: "SCREEN" | "VERIFY" | "RECHECK" | "CONTEXT", list: Check[]): Promise<void> {
  if (!list.length) return;
  await tx.db.insert(checks).values(
    list.map((c) => ({ purchaseId, phase, checkId: c.id, kind: c.kind ?? ("deterministic" as const), result: c.result, detail: c.detail, line: c.line ?? null, model: c.model ?? null, promptVersion: c.prompt_version ?? null, evidence: c.evidence?.length ? c.evidence : null, unavailable: c.unavailable === true })),
  );
}

export async function recordDecision(tx: Tx, purchaseId: string, outcome: Outcome, reasons: string[], decidedBy: string): Promise<void> {
  await tx.db.insert(decisions).values({ purchaseId, outcome, reasons, decidedBy });
}

export type JournalOp = "create-order" | "capture" | "void" | "payout";

/** Write the intent to call PayPal before calling it, so a crash mid-call can be reconciled. */
export async function journalStart(tx: Tx, a: { purchaseId: string; op: JournalOp; requestId: string; request?: unknown }): Promise<number> {
  const rows = await tx.db
    .insert(paypalCalls)
    .values({ purchaseId: a.purchaseId, op: a.op, requestId: a.requestId, status: "PENDING", request: a.request ?? null })
    .returning({ id: paypalCalls.id });
  return rows[0]!.id;
}

export async function journalFinish(
  db: Db,
  id: number,
  r: { status: "SUCCEEDED" | "FAILED" | "UNKNOWN"; httpStatus?: number | null; debugId?: string | null; response?: unknown; error?: string | null },
): Promise<void> {
  await db
    .update(paypalCalls)
    .set({ status: r.status, httpStatus: r.httpStatus ?? null, debugId: r.debugId ?? null, response: r.response ?? null, error: r.error ?? null, updatedAt: new Date() })
    .where(eq(paypalCalls.id, id));
}
