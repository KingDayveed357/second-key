// Second Key protection (ADR-0020): the payer's standing profile, enrolled guardians, the notification
// outbox and the guardian's hold credential.
//
// The rules this module enforces:
//   - the profile changes only through here: tightening applies at once, loosening after a delay that
//     is measured in server time and can't be shortened by anything in a request;
//   - a guardian is reached only through their channel; nothing here returns a guardian credential or a
//     guardian message to the payer's credential;
//   - a credential is minted at the channel's last hop, stored only as SHA-256, bound to one hold and one
//     guardian, and replaced (so the old one dies) by every re-mint, re-notify, replacement or revocation;
//   - revocation removes authority immediately; granting authority after a guardian has existed is delayed.
//
// Lock order, everywhere: profile -> purchase -> hold -> audit chain (appendAudit's advisory lock).
// Decisions (holds.ts) take purchase -> hold -> audit. Anything that changes a payer's authority locks
// the profile, then all of that payer's open guardian holds (purchase, hold, in id order), and only then
// writes or appends audit. Screening reads the profile before its first audit append. Taking the audit
// lock before a row lock is what deadlocks, so nothing here does.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { newId, payeeKey, type PayerContext, type TransferPolicyV1 } from "@witness/core";
import { QUEUES, appendAudit, createApiKey, dbOf, enqueue, schema, withTx, type Tx } from "@witness/db";
import { nowOf, type EngineDeps } from "./deps.ts";

const { protectionProfiles, guardians, profileChanges, notifications, demoInboxes, payeeHistory, holds, purchases, intents, shoppers } = schema;

export type ProfileRow = typeof protectionProfiles.$inferSelect;
export type GuardianRow = typeof guardians.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;

export type ProtectionResult<T> = { kind: "ok"; value: T } | { kind: "error"; status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429; title: string; detail?: string };
const ok = <T>(value: T): ProtectionResult<T> => ({ kind: "ok", value });
const bad = (status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429, title: string, detail?: string): ProtectionResult<never> => ({ kind: "error", status, title, ...(detail ? { detail } : {}) });

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function sameHash(candidate: string, storedHex: string | null | undefined): boolean {
  if (!storedHex) return false;
  const a = Buffer.from(sha(candidate), "hex");
  const b = Buffer.from(storedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Loosening delay: 48 h by default; configurable, never below 24 h (ADR-0020 §6). */
export const DEFAULT_LOOSEN_DELAY_MS = 48 * 3600_000;
const MIN_LOOSEN_DELAY_MS = 24 * 3600_000;
const loosenDelayOf = (d: EngineDeps) => Math.max(d.loosenDelayMs ?? DEFAULT_LOOSEN_DELAY_MS, MIN_LOOSEN_DELAY_MS);

/** Credential lifetime (ADR-0017's link clock), never past the hold's auto-void. */
const DEFAULT_CREDENTIAL_MS = 30 * 60_000;
/** Wrong credentials before the live one is cleared (a reminder delivers a fresh one). */
export const MAX_FAILED_ATTEMPTS = 10;
/** Minimum spacing of reminders for one hold. */
export const REMIND_SPACING_MS = 60_000;
/** Notification delivery: bounded exponential backoff. */
export const MAX_DELIVERY_ATTEMPTS = 8;
export const backoffMs = (attempts: number) => Math.min(5_000 * 2 ** attempts, 10 * 60_000);

const DEMO_ADDRESS = /^SK-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const maskAddress = (a: string) => `•••• ${a.slice(-4)}`;

// ---- notifier ------------------------------------------------------------------------------

/**
 * Delivers one outbox row through the guardian's channel. Throws on failure (the outbox retries).
 * A real SMS or email adapter would mint the hold credential inside `deliver` and hand the plaintext only
 * to the provider. The demo inbox needs no credential at delivery: it is minted when the inbox owner opens
 * the message (openInboxMessage), so no plaintext credential is ever stored.
 */
export interface Notifier {
  deliver(d: EngineDeps, n: NotificationRow, g: GuardianRow): Promise<void>;
}

/** Demo channel: "delivery" makes the message visible to whoever holds the inbox secret. */
export const demoInboxNotifier: Notifier = {
  async deliver(d, n, g) {
    if (g.channel !== "demo_inbox") throw new Error(`demo notifier can't deliver to ${g.channel}`);
    const inbox = (await dbOf(d.pool).select().from(demoInboxes).where(and(eq(demoInboxes.address, g.address), eq(demoInboxes.tenantId, n.tenantId))).limit(1))[0];
    if (!inbox) throw new Error("no demo inbox at this address");
  },
};
const notifierOf = (d: EngineDeps) => d.notifier ?? demoInboxNotifier;

// ---- profile reads -------------------------------------------------------------------------

async function lockProfile(tx: Tx, tenantId: string, shopperId: string, mode: "update" | "share"): Promise<ProfileRow | null> {
  return (
    (await tx.db
      .select()
      .from(protectionProfiles)
      .where(and(eq(protectionProfiles.tenantId, tenantId), eq(protectionProfiles.shopperId, shopperId)))
      .for(mode)
      .limit(1))[0] ?? null
  );
}

async function ensureProfile(tx: Tx, tenantId: string, shopperId: string): Promise<ProfileRow> {
  await tx.db.insert(protectionProfiles).values({ tenantId, shopperId }).onConflictDoNothing();
  return (await lockProfile(tx, tenantId, shopperId, "update"))!;
}

/**
 * Open (unresolved) guardian holds of one payer, with their purchase and hold rows locked in purchase id
 * order: the same order a decision takes (purchase, then hold). Called right after the profile lock,
 * before any write, so an authority change and a decision can't deadlock.
 */
async function openGuardianHolds(tx: Tx, tenantId: string, shopperId: string) {
  const r = await tx.client.query<{ purchase_id: string; guardian_id: string | null }>(
    `SELECT h.purchase_id, h.guardian_id FROM purchases p
       JOIN intents i ON i.id = p.intent_id
       JOIN holds h ON h.purchase_id = p.id
      WHERE p.tenant_id = $1 AND i.shopper_id = $2 AND h.approver = 'guardian' AND h.resolved_at IS NULL
      ORDER BY p.id
      FOR UPDATE OF p, h`,
    [tenantId, shopperId],
  );
  return r.rows;
}

const clearCredential = { credentialHash: null, credentialGuardianId: null, credentialExpiresAt: null, credentialSeq: null, failedAttempts: 0 } as const;

/** Apply every due change in request order (profile row must be locked FOR UPDATE by the caller). */
async function applyDue(d: EngineDeps, tx: Tx, profile: ProfileRow): Promise<ProfileRow> {
  const now = nowOf(d);
  const due = await tx.db
    .select()
    .from(profileChanges)
    .where(and(eq(profileChanges.tenantId, profile.tenantId), eq(profileChanges.shopperId, profile.shopperId), isNull(profileChanges.appliedAt), isNull(profileChanges.cancelledAt), lte(profileChanges.effectiveAt, now)))
    .orderBy(asc(profileChanges.requestedAt));
  let p = profile;
  for (const c of due) p = await applyChange(d, tx, p, c);
  return p;
}

async function cancelChange(tx: Tx, c: typeof profileChanges.$inferSelect, now: Date, reason: string) {
  await tx.db.update(profileChanges).set({ cancelledAt: now, cancelReason: reason }).where(eq(profileChanges.id, c.id));
  await appendAudit(tx, { tenantId: c.tenantId, purchaseId: null, eventType: "profile.change_cancelled", payload: { change_id: c.id, shopper_id: c.shopperId, kind: c.kind, reason } });
}

async function applyChange(d: EngineDeps, tx: Tx, p: ProfileRow, c: typeof profileChanges.$inferSelect): Promise<ProfileRow> {
  const now = nowOf(d);
  const value = c.value as { threshold_cents?: number | null; guardian_id?: string };
  let patch: Partial<ProfileRow> = {};
  if (c.kind === "threshold") {
    patch = { thresholdCents: value.threshold_cents ?? null };
  } else if (c.kind === "guardian") {
    const g = (await tx.db.select().from(guardians).where(and(eq(guardians.id, value.guardian_id!), eq(guardians.tenantId, p.tenantId), eq(guardians.shopperId, p.shopperId))).for("update").limit(1))[0];
    if (!g || g.status !== "ACTIVE") {
      await cancelChange(tx, c, now, "the new guardian is no longer active");
      return p;
    }
    if (p.guardianId && p.guardianId !== g.id) await endGuardian(tx, p.guardianId, "REMOVED", "replaced", now);
    patch = { guardianId: g.id, protectionOn: true };
  } else {
    if (p.guardianId) await endGuardian(tx, p.guardianId, "REMOVED", "removed by the payer", now);
    patch = { guardianId: null, protectionOn: false };
  }
  const [next] = await tx.db
    .update(protectionProfiles)
    .set({ ...patch, version: p.version + 1, updatedAt: now })
    .where(and(eq(protectionProfiles.tenantId, p.tenantId), eq(protectionProfiles.shopperId, p.shopperId)))
    .returning();
  await tx.db.update(profileChanges).set({ appliedAt: now }).where(eq(profileChanges.id, c.id));
  await appendAudit(tx, { tenantId: p.tenantId, purchaseId: null, eventType: "profile.change_applied", payload: { change_id: c.id, shopper_id: p.shopperId, kind: c.kind, version: next!.version, requested_at: c.requestedAt.toISOString() } });

  // Authority over open holds moves only here, after the delay: never through a request.
  if (c.kind === "guardian" || c.kind === "remove_guardian") {
    for (const h of await openGuardianHolds(tx, p.tenantId, p.shopperId)) {
      await tx.db.update(holds).set({ ...clearCredential, guardianId: next!.guardianId }).where(eq(holds.purchaseId, h.purchase_id));
      await appendAudit(tx, { tenantId: p.tenantId, purchaseId: h.purchase_id, eventType: "hold.guardian_reassigned", payload: { from: h.guardian_id, to: next!.guardianId, change_id: c.id } });
      if (next!.guardianId) await queueHoldReview(d, tx, p.tenantId, h.purchase_id, next!.guardianId);
    }
  }
  return next!;
}

async function endGuardian(tx: Tx, guardianId: string, status: "REMOVED" | "REVOKED", reason: string, now: Date) {
  await tx.db.update(guardians).set({ status, endedAt: now, endedReason: reason }).where(eq(guardians.id, guardianId));
  // Every live credential of this guardian dies with their authority.
  await tx.db.update(holds).set(clearCredential).where(eq(holds.credentialGuardianId, guardianId));
}

/** Apply due changes for every payer that has one (worker sweep). */
export async function applyAllDueChanges(d: EngineDeps): Promise<number> {
  const due = await dbOf(d.pool)
    .selectDistinct({ tenantId: profileChanges.tenantId, shopperId: profileChanges.shopperId })
    .from(profileChanges)
    .where(and(isNull(profileChanges.appliedAt), isNull(profileChanges.cancelledAt), lte(profileChanges.effectiveAt, nowOf(d))))
    .limit(200);
  for (const x of due) {
    await withTx(d.pool, async (tx) => {
      const p = await lockProfile(tx, x.tenantId, x.shopperId, "update");
      if (!p) return;
      await openGuardianHolds(tx, x.tenantId, x.shopperId);
      await applyDue(d, tx, p);
    });
  }
  return due.length;
}

// ---- screening and hold creation --------------------------------------------------------------

export interface ProtectionSnapshot {
  rule_version: "review_rule@2";
  profile_version: number | null;
  profile_threshold_cents: number | null;
  intent_threshold_cents: number | null;
  protection_on: boolean;
  guardian_id: string | null;
  payee_key: string;
  paid_before: boolean;
}

/** Apply this payer's due profile changes in their own transaction (before a payment is screened). */
export async function applyDueChangesFor(d: EngineDeps, tenantId: string, shopperId: string): Promise<void> {
  await withTx(d.pool, async (tx) => {
    const p = await lockProfile(tx, tenantId, shopperId, "update");
    if (!p) return;
    await openGuardianHolds(tx, tenantId, shopperId);
    await applyDue(d, tx, p);
  });
}

/**
 * Called inside the screening transaction for a transfer, before its first audit append: reads the
 * profile FOR SHARE (one consistent version; a concurrent change waits for, or is seen by, this read)
 * and payment history, and returns the payer context plus the snapshot to store on the purchase.
 * Due changes were applied just before (applyDueChangesFor); one that falls due in between is a loosen
 * not yet applied, so the read can only be the stricter state.
 */
export async function screeningProtection(tx: Tx, tenantId: string, shopperId: string, policy: TransferPolicyV1): Promise<{ payer: PayerContext; snapshot: ProtectionSnapshot }> {
  const profile = await lockProfile(tx, tenantId, shopperId, "share");
  const key = payeeKey(policy.payee);
  const paid = (await tx.db.select({ k: payeeHistory.payeeKey }).from(payeeHistory).where(and(eq(payeeHistory.tenantId, tenantId), eq(payeeHistory.shopperId, shopperId), eq(payeeHistory.payeeKey, key))).limit(1)).length > 0;
  return {
    payer: { profileThresholdCents: profile?.thresholdCents ?? null, paidBefore: paid },
    snapshot: {
      rule_version: "review_rule@2",
      profile_version: profile?.version ?? null,
      profile_threshold_cents: profile?.thresholdCents ?? null,
      intent_threshold_cents: policy.review_threshold_cents ?? null,
      protection_on: profile?.protectionOn ?? false,
      guardian_id: profile?.guardianId ?? null,
      payee_key: key,
      paid_before: paid,
    },
  };
}

export type ReasonClass = "POLICY_REVIEW" | "EVIDENCE_CONCERN" | "ASSESSMENT_UNAVAILABLE" | "LISTING_OR_FACTS";

/** Deterministic classification of why a payment is held (ADR-0020 §4). No model output picks the approver. */
export function classifyHold(unknowns: { checkId: string; kind: string; unavailable: boolean }[]): ReasonClass[] {
  const out = new Set<ReasonClass>();
  for (const c of unknowns) {
    if (c.checkId === "transfer.review_rule") out.add("POLICY_REVIEW");
    else if (c.unavailable) out.add("ASSESSMENT_UNAVAILABLE");
    else if (c.checkId === "ai.manipulation") out.add("EVIDENCE_CONCERN");
    else out.add("LISTING_OR_FACTS");
  }
  return [...out].sort();
}

/**
 * Who may approve a hold, decided when it is created. Reads the profile FOR SHARE, so it serialises with
 * revocation and replacement (which take FOR UPDATE and then update open holds).
 */
export async function holdAuthority(tx: Tx, tenantId: string, shopperId: string, isTransfer: boolean): Promise<{ approver: "principal" | "guardian"; guardianId: string | null }> {
  if (!isTransfer) return { approver: "principal", guardianId: null };
  const profile = await lockProfile(tx, tenantId, shopperId, "share");
  if (!profile?.protectionOn) return { approver: "principal", guardianId: null };
  return { approver: "guardian", guardianId: profile.guardianId };
}

// ---- notifications (outbox) ---------------------------------------------------------------------

async function insertNotification(d: EngineDeps, tx: Tx, n: { tenantId: string; guardianId: string; purchaseId?: string | null; kind: NotificationRow["kind"]; seq?: number; body: Record<string, unknown> }) {
  const id = newId("ntf");
  await tx.db.insert(notifications).values({ id, tenantId: n.tenantId, guardianId: n.guardianId, purchaseId: n.purchaseId ?? null, kind: n.kind, seq: n.seq ?? 1, body: n.body, status: "PENDING", nextAttemptAt: nowOf(d) });
  await enqueue(d.boss, tx, QUEUES.notify, { notificationId: id }, { singletonKey: `notify:${id}:0` });
  await appendAudit(tx, { tenantId: n.tenantId, purchaseId: n.purchaseId ?? null, eventType: "notification.queued", payload: { notification_id: id, guardian_id: n.guardianId, kind: n.kind, seq: n.seq ?? 1 } });
  return id;
}

/** The message a guardian sees about a hold: who, to whom, how much. Never a credential. */
async function holdReviewBody(tx: Tx, purchaseId: string) {
  const r = await tx.client.query<{ amount_cents: number | null; currency: string | null; policy: TransferPolicyV1; payer: string | null }>(
    `SELECT p.amount_cents, p.currency, i.policy, s.display_name AS payer
       FROM purchases p JOIN intents i ON i.id = p.intent_id LEFT JOIN shoppers s ON s.id = i.shopper_id WHERE p.id = $1`,
    [purchaseId],
  );
  const x = r.rows[0]!;
  return { payer_name: x.payer, payee_name: x.policy?.payee?.name ?? null, amount_cents: x.amount_cents, currency: x.currency, purpose: x.policy?.purpose ?? null };
}

/**
 * Queue the next hold_review message for a hold: supersede earlier ones and clear the live credential,
 * so at most one message, and at most one credential, is ever live. Caller holds the hold row lock.
 */
async function queueHoldReview(d: EngineDeps, tx: Tx, tenantId: string, purchaseId: string, guardianId: string): Promise<string> {
  const last = (await tx.db.select({ seq: notifications.seq }).from(notifications).where(and(eq(notifications.purchaseId, purchaseId), eq(notifications.kind, "hold_review"))).orderBy(desc(notifications.seq)).limit(1))[0];
  await tx.db
    .update(notifications)
    .set({ status: "SUPERSEDED" })
    .where(and(eq(notifications.purchaseId, purchaseId), eq(notifications.kind, "hold_review"), inArray(notifications.status, ["PENDING", "DELIVERED", "FAILED"])));
  await tx.db.update(holds).set({ ...clearCredential, lastNotifiedAt: nowOf(d) }).where(eq(holds.purchaseId, purchaseId));
  return insertNotification(d, tx, { tenantId, guardianId, purchaseId, kind: "hold_review", seq: (last?.seq ?? 0) + 1, body: await holdReviewBody(tx, purchaseId) });
}

/** Called in the transaction that creates a guardian hold. */
export async function notifyNewHold(d: EngineDeps, tx: Tx, tenantId: string, purchaseId: string, guardianId: string | null) {
  if (guardianId) await queueHoldReview(d, tx, tenantId, purchaseId, guardianId);
}

/** Worker job: deliver one outbox row. At most one delivery per row; failures back off, then FAILED. */
export async function deliverNotification(d: EngineDeps, notificationId: string): Promise<string> {
  const db = dbOf(d.pool);
  const n = (await db.select().from(notifications).where(eq(notifications.id, notificationId)).limit(1))[0];
  if (!n) return "notification not found";
  if (n.status !== "PENDING") return `notification is ${n.status}`;
  if (n.nextAttemptAt.getTime() > nowOf(d).getTime()) return "not due yet";
  const g = (await db.select().from(guardians).where(and(eq(guardians.id, n.guardianId), eq(guardians.tenantId, n.tenantId))).limit(1))[0];
  let error: string | null = g ? null : "guardian not found";
  if (g) {
    try {
      await notifierOf(d).deliver(d, n, g);
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
  }
  return withTx(d.pool, async (tx) => {
    const cur = (await tx.db.select().from(notifications).where(eq(notifications.id, n.id)).for("update").limit(1))[0]!;
    if (cur.status !== "PENDING") return `notification became ${cur.status}`;
    const now = nowOf(d);
    if (!error) {
      await tx.db.update(notifications).set({ status: "DELIVERED", deliveredAt: now, attempts: cur.attempts + 1, lastError: null }).where(eq(notifications.id, n.id));
      await appendAudit(tx, { tenantId: n.tenantId, purchaseId: n.purchaseId, eventType: "notification.delivered", payload: { notification_id: n.id, kind: n.kind, seq: n.seq, channel: g!.channel, address: maskAddress(g!.address) } });
      return "delivered";
    }
    const attempts = cur.attempts + 1;
    const failed = attempts >= MAX_DELIVERY_ATTEMPTS;
    const next = new Date(now.getTime() + backoffMs(attempts));
    await tx.db.update(notifications).set({ attempts, lastError: error, status: failed ? "FAILED" : "PENDING", nextAttemptAt: next }).where(eq(notifications.id, n.id));
    await appendAudit(tx, { tenantId: n.tenantId, purchaseId: n.purchaseId, eventType: failed ? "notification.failed" : "notification.retry_scheduled", payload: { notification_id: n.id, kind: n.kind, attempts, error } });
    if (!failed) await enqueue(d.boss, tx, QUEUES.notify, { notificationId: n.id }, { startAfter: next, singletonKey: `notify:${n.id}:${attempts}` });
    return failed ? `failed after ${attempts} attempts: ${error}` : `retry ${attempts} scheduled: ${error}`;
  });
}

/** Sweep: re-enqueue due PENDING rows (covers a lost job). */
export async function sweepNotifications(d: EngineDeps): Promise<number> {
  const due = await dbOf(d.pool)
    .select({ id: notifications.id, attempts: notifications.attempts })
    .from(notifications)
    .where(and(eq(notifications.status, "PENDING"), lte(notifications.nextAttemptAt, nowOf(d))))
    .limit(200);
  for (const n of due) await withTx(d.pool, (tx) => enqueue(d.boss, tx, QUEUES.notify, { notificationId: n.id }, { singletonKey: `notify:${n.id}:${n.attempts}` }));
  return due.length;
}

/** Payer: "Remind Sarah". Never returns a credential; at most one reminder per minute per hold. */
export async function remindGuardian(d: EngineDeps, tenantId: string, shopperId: string, purchaseId: string): Promise<ProtectionResult<{ sent_to: string; seq: number }>> {
  return withTx(d.pool, async (tx) => {
    const r = await tx.client.query<{ shopper_id: string; state: string }>(`SELECT i.shopper_id, p.state FROM purchases p JOIN intents i ON i.id = p.intent_id WHERE p.id = $1 AND p.tenant_id = $2`, [purchaseId, tenantId]);
    if (r.rows[0]?.shopper_id !== shopperId) return bad(404, "Hold not found");
    const h = (await tx.db.select().from(holds).where(eq(holds.purchaseId, purchaseId)).for("update").limit(1))[0];
    if (!h) return bad(404, "Hold not found");
    if (h.approver !== "guardian") return bad(409, "This payment has no trusted contact to remind");
    if (h.resolvedAt || r.rows[0]!.state !== "HELD") return bad(409, "Already decided");
    if (!h.guardianId) return bad(409, "No trusted contact is assigned", "Your trusted contact was removed or revoked. A replacement takes effect after the delay; you can cancel this payment.");
    if (h.lastNotifiedAt && nowOf(d).getTime() - h.lastNotifiedAt.getTime() < REMIND_SPACING_MS) return bad(429, "Already sent", "Wait a minute before reminding again");
    const g = (await tx.db.select().from(guardians).where(eq(guardians.id, h.guardianId)).limit(1))[0]!;
    await queueHoldReview(d, tx, tenantId, purchaseId, h.guardianId);
    const seq = (await tx.db.select({ seq: notifications.seq }).from(notifications).where(and(eq(notifications.purchaseId, purchaseId), eq(notifications.kind, "hold_review"))).orderBy(desc(notifications.seq)).limit(1))[0]!.seq;
    await appendAudit(tx, { tenantId, purchaseId, eventType: "hold.reminder_requested", payload: { by: `payer:${shopperId}`, guardian_id: g.id, seq } });
    return ok({ sent_to: `${g.displayName} · ${maskAddress(g.address)}`, seq });
  });
}

// ---- guardian credential -----------------------------------------------------------------------

/** Mint the hold's one live credential for this guardian (replacing any previous one). Caller locks the hold. */
async function mintCredential(d: EngineDeps, tx: Tx, tenantId: string, h: typeof holds.$inferSelect, guardianId: string, seq: number): Promise<{ token: string; expires_at: string }> {
  const token = randomBytes(24).toString("base64url");
  const now = nowOf(d);
  const expires = new Date(Math.min(now.getTime() + (d.holdLinkMs ?? DEFAULT_CREDENTIAL_MS), h.autoVoidAt.getTime()));
  await tx.db.update(holds).set({ credentialHash: sha(token), credentialGuardianId: guardianId, credentialExpiresAt: expires, credentialSeq: seq, failedAttempts: 0 }).where(eq(holds.purchaseId, h.purchaseId));
  await appendAudit(tx, { tenantId, purchaseId: h.purchaseId, eventType: "hold.credential_issued", payload: { guardian_id: guardianId, seq, expires_at: expires.toISOString() } });
  return { token, expires_at: expires.toISOString() };
}

export type CredentialCheck = { kind: "ok"; guardianId: string } | { kind: "error"; status: 403 | 410; title: string; detail?: string };

/**
 * Is `token` the live credential of the guardian assigned to this hold? The caller must hold the hold row
 * lock (decisions) or accept a read that is re-checked under the lock before anything is applied.
 */
export function checkCredential(h: typeof holds.$inferSelect, g: GuardianRow | null, token: string, now: Date): CredentialCheck {
  if (!h.credentialHash || !h.credentialGuardianId) return { kind: "error", status: 410, title: "This request is no longer valid", detail: "Ask for a new request; the payment stays held" };
  if (!sameHash(token, h.credentialHash)) return { kind: "error", status: 403, title: "Invalid link" };
  if (!h.guardianId || h.credentialGuardianId !== h.guardianId || !g || g.id !== h.guardianId || g.status !== "ACTIVE") return { kind: "error", status: 410, title: "This request is no longer valid", detail: "The trusted contact for this payment changed" };
  if (!h.credentialExpiresAt || h.credentialExpiresAt.getTime() <= now.getTime()) return { kind: "error", status: 410, title: "This link has expired", detail: "Ask for a new request; the payment stays held" };
  return { kind: "ok", guardianId: g.id };
}

/** Count a wrong credential; at the limit, the live credential is cleared (a reminder sends a fresh one). */
export async function recordFailedCredential(d: EngineDeps, tenantId: string, purchaseId: string): Promise<void> {
  await withTx(d.pool, async (tx) => {
    const h = (await tx.db.select().from(holds).where(eq(holds.purchaseId, purchaseId)).for("update").limit(1))[0];
    if (!h || h.approver !== "guardian") return;
    const n = h.failedAttempts + 1;
    await tx.db.update(holds).set(n >= MAX_FAILED_ATTEMPTS ? { ...clearCredential, failedAttempts: n } : { failedAttempts: n }).where(eq(holds.purchaseId, purchaseId));
    if (n === MAX_FAILED_ATTEMPTS) await appendAudit(tx, { tenantId, purchaseId, eventType: "hold.credential_locked", payload: { failed_attempts: n } });
  });
}

// ---- demo inbox (stands in for the guardian's phone) ------------------------------------------

export async function createDemoInbox(d: EngineDeps, tenantId: string): Promise<{ address: string; secret: string }> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n: number) => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
  const address = `SK-${pick(4)}-${pick(4)}`;
  const secret = randomBytes(24).toString("base64url");
  await dbOf(d.pool).insert(demoInboxes).values({ address, tenantId, secretHash: sha(secret) });
  return { address, secret };
}

async function inboxAuth(d: EngineDeps, tenantId: string, address: string, secret: unknown): Promise<ProtectionResult<true>> {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 128) return bad(401, "Inbox secret required");
  const inbox = (await dbOf(d.pool).select().from(demoInboxes).where(and(eq(demoInboxes.address, address), eq(demoInboxes.tenantId, tenantId))).limit(1))[0];
  if (!inbox) return bad(404, "Inbox not found");
  if (!sameHash(secret, inbox.secretHash)) return bad(403, "Wrong inbox secret");
  return ok(true);
}

export interface InboxMessage {
  id: string;
  kind: NotificationRow["kind"];
  at: string;
  guardian: { id: string; name: string; status: string };
  purchase_id: string | null;
  body: Record<string, unknown>;
  /** hold_review: this is the hold's current request and it can still be decided. invite: can be accepted. */
  actionable: boolean;
}

export async function listInbox(d: EngineDeps, tenantId: string, address: string, secret: unknown): Promise<ProtectionResult<{ address: string; messages: InboxMessage[] }>> {
  const a = await inboxAuth(d, tenantId, address, secret);
  if (a.kind === "error") return a;
  const r = await d.pool.query(
    `SELECT n.id, n.kind, n.delivered_at, n.purchase_id, n.body, n.seq, n.status, g.id AS gid, g.display_name, g.status AS gstatus,
            h.resolved_at, h.guardian_id AS hold_guardian, p.state,
            (SELECT max(n2.seq) FROM notifications n2 WHERE n2.purchase_id = n.purchase_id AND n2.kind = 'hold_review') AS latest
       FROM notifications n
       JOIN guardians g ON g.id = n.guardian_id AND g.tenant_id = n.tenant_id
       LEFT JOIN holds h ON h.purchase_id = n.purchase_id
       LEFT JOIN purchases p ON p.id = n.purchase_id
      WHERE n.tenant_id = $1 AND g.channel = 'demo_inbox' AND g.address = $2 AND n.status IN ('DELIVERED', 'SUPERSEDED') AND n.delivered_at IS NOT NULL
      ORDER BY n.delivered_at DESC LIMIT 50`,
    [tenantId, address],
  );
  return ok({
    address,
    messages: r.rows.map((x: any) => ({
      id: x.id,
      kind: x.kind,
      at: new Date(x.delivered_at).toISOString(),
      guardian: { id: x.gid, name: x.display_name, status: x.gstatus },
      purchase_id: x.purchase_id,
      body: x.body,
      actionable:
        x.kind === "invite"
          ? x.gstatus === "INVITED"
          : x.kind === "hold_review" && x.status === "DELIVERED" && x.seq === x.latest && !x.resolved_at && x.state === "HELD" && x.hold_guardian === x.gid && x.gstatus === "ACTIVE",
    })),
  });
}

async function inboxMessage(tx: Tx, tenantId: string, address: string, notificationId: string) {
  const n = (await tx.db.select().from(notifications).where(and(eq(notifications.id, notificationId), eq(notifications.tenantId, tenantId))).limit(1))[0];
  if (!n) return null;
  // No lock on the guardian: a revocation locks this hold before ending the guardian, so it either
  // waits for this mint (and then kills the credential) or happened first (and status says so).
  const g = (await tx.db.select().from(guardians).where(and(eq(guardians.id, n.guardianId), eq(guardians.tenantId, tenantId))).limit(1))[0];
  if (!g || g.channel !== "demo_inbox" || g.address !== address) return null;
  return { n, g };
}

/** The inbox owner opens a review request: mint the hold's credential and return it once. */
export async function openInboxMessage(d: EngineDeps, tenantId: string, address: string, secret: unknown, notificationId: string): Promise<ProtectionResult<{ purchase_id: string; token: string; expires_at: string }>> {
  const a = await inboxAuth(d, tenantId, address, secret);
  if (a.kind === "error") return a;
  return withTx(d.pool, async (tx) => {
    const m = await inboxMessage(tx, tenantId, address, notificationId);
    if (!m || m.n.kind !== "hold_review" || !m.n.purchaseId) return bad(404, "Message not found");
    if (m.n.status !== "DELIVERED") return bad(410, "This request was replaced by a newer one");
    if (m.g.status !== "ACTIVE") return bad(410, "You are no longer this person's trusted contact");
    const p = (await tx.db.select().from(purchases).where(and(eq(purchases.id, m.n.purchaseId), eq(purchases.tenantId, tenantId))).for("update").limit(1))[0];
    const h = (await tx.db.select().from(holds).where(eq(holds.purchaseId, m.n.purchaseId)).for("update").limit(1))[0];
    if (!p || !h) return bad(404, "Message not found");
    if (h.resolvedAt || p.state !== "HELD") return bad(409, "Already decided", `The payment is ${p.state}`);
    if (h.approver !== "guardian" || h.guardianId !== m.g.id) return bad(410, "You are no longer the trusted contact for this payment");
    return ok({ purchase_id: p.id, ...(await mintCredential(d, tx, tenantId, h, m.g.id, m.n.seq)) });
  });
}

/** The invited guardian accepts through their channel. Activation alone grants nothing. */
export async function acceptInvite(d: EngineDeps, tenantId: string, address: string, secret: unknown, notificationId: string): Promise<ProtectionResult<{ guardian_id: string; status: string }>> {
  const a = await inboxAuth(d, tenantId, address, secret);
  if (a.kind === "error") return a;
  return withTx(d.pool, async (tx) => {
    const m = await inboxMessage(tx, tenantId, address, notificationId);
    if (!m || m.n.kind !== "invite") return bad(404, "Message not found");
    await tx.db.select({ id: guardians.id }).from(guardians).where(eq(guardians.id, m.g.id)).for("update");
    if (m.g.status === "ACTIVE") return ok({ guardian_id: m.g.id, status: "ACTIVE" });
    if (m.g.status !== "INVITED") return bad(410, "This invitation is no longer valid");
    await tx.db.update(guardians).set({ status: "ACTIVE", activatedAt: nowOf(d) }).where(eq(guardians.id, m.g.id));
    await appendAudit(tx, { tenantId, purchaseId: null, eventType: "guardian.activated", payload: { guardian_id: m.g.id, shopper_id: m.g.shopperId, channel: m.g.channel, address: maskAddress(m.g.address) } });
    return ok({ guardian_id: m.g.id, status: "ACTIVE" });
  });
}

// ---- profile view and changes (payer) -----------------------------------------------------------

export interface ProtectionView {
  version: number;
  threshold_cents: number | null;
  protection_on: boolean;
  guardian: { id: string; name: string; address: string; status: string } | null;
  guardians: { id: string; name: string; address: string; status: string }[];
  pending: { id: string; kind: string; value: unknown; requested_at: string; effective_at: string }[];
}

const guardianView = (g: GuardianRow) => ({ id: g.id, name: g.displayName, address: maskAddress(g.address), status: g.status });

async function viewOf(tx: Tx, p: ProfileRow): Promise<ProtectionView> {
  const gs = await tx.db.select().from(guardians).where(and(eq(guardians.tenantId, p.tenantId), eq(guardians.shopperId, p.shopperId))).orderBy(asc(guardians.createdAt));
  const pending = await tx.db
    .select()
    .from(profileChanges)
    .where(and(eq(profileChanges.tenantId, p.tenantId), eq(profileChanges.shopperId, p.shopperId), isNull(profileChanges.appliedAt), isNull(profileChanges.cancelledAt)))
    .orderBy(asc(profileChanges.requestedAt));
  const current = gs.find((g) => g.id === p.guardianId);
  return {
    version: p.version,
    threshold_cents: p.thresholdCents,
    protection_on: p.protectionOn,
    guardian: current ? guardianView(current) : null,
    guardians: gs.map(guardianView),
    pending: pending.map((c) => ({ id: c.id, kind: c.kind, value: c.value, requested_at: c.requestedAt.toISOString(), effective_at: c.effectiveAt.toISOString() })),
  };
}

async function inProfile<T>(d: EngineDeps, tenantId: string, shopperId: string, fn: (tx: Tx, p: ProfileRow) => Promise<ProtectionResult<T>>): Promise<ProtectionResult<T>> {
  return withTx(d.pool, async (tx) => {
    const shopper = (await tx.db.select().from(shoppers).where(and(eq(shoppers.id, shopperId), eq(shoppers.tenantId, tenantId))).limit(1))[0];
    if (!shopper) return bad(404, "Payer not found");
    const locked = await ensureProfile(tx, tenantId, shopperId);
    await openGuardianHolds(tx, tenantId, shopperId);
    return fn(tx, await applyDue(d, tx, locked));
  });
}

export const getProtection = (d: EngineDeps, tenantId: string, shopperId: string) => inProfile(d, tenantId, shopperId, async (tx, p) => ok(await viewOf(tx, p)));

async function pendingOf(tx: Tx, p: ProfileRow, kind: "threshold" | "guardian" | "remove_guardian") {
  return (
    await tx.db
      .select()
      .from(profileChanges)
      .where(and(eq(profileChanges.tenantId, p.tenantId), eq(profileChanges.shopperId, p.shopperId), eq(profileChanges.kind, kind), isNull(profileChanges.appliedAt), isNull(profileChanges.cancelledAt)))
      .limit(1)
  )[0];
}

/** Tell the current guardian their authority is scheduled to change. */
async function tellGuardian(d: EngineDeps, tx: Tx, p: ProfileRow, summary: string, effectiveAt: Date) {
  if (p.guardianId) await insertNotification(d, tx, { tenantId: p.tenantId, guardianId: p.guardianId, kind: "authority_change", body: { summary, effective_at: effectiveAt.toISOString() } });
}

async function schedule(d: EngineDeps, tx: Tx, p: ProfileRow, kind: "threshold" | "guardian" | "remove_guardian", value: Record<string, unknown>, summary: string) {
  const now = nowOf(d);
  const effective = new Date(now.getTime() + loosenDelayOf(d));
  const id = newId("pch");
  await tx.db.insert(profileChanges).values({ id, tenantId: p.tenantId, shopperId: p.shopperId, kind, value, requestedAt: now, effectiveAt: effective });
  await appendAudit(tx, { tenantId: p.tenantId, purchaseId: null, eventType: "profile.loosen_requested", payload: { change_id: id, shopper_id: p.shopperId, kind, value, effective_at: effective.toISOString() } });
  await tellGuardian(d, tx, p, summary, effective);
  return id;
}

async function bump(d: EngineDeps, tx: Tx, p: ProfileRow, patch: Partial<ProfileRow>, event: string, payload: Record<string, unknown>) {
  const [next] = await tx.db
    .update(protectionProfiles)
    .set({ ...patch, version: p.version + 1, updatedAt: nowOf(d) })
    .where(and(eq(protectionProfiles.tenantId, p.tenantId), eq(protectionProfiles.shopperId, p.shopperId)))
    .returning();
  await appendAudit(tx, { tenantId: p.tenantId, purchaseId: null, eventType: event, payload: { shopper_id: p.shopperId, version: next!.version, ...payload } });
  return next!;
}

const usdLike = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Set the threshold. Lower (or a first value) applies now; higher or none is delayed. */
export function setThreshold(d: EngineDeps, tenantId: string, shopperId: string, body: unknown): Promise<ProtectionResult<ProtectionView>> {
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  const v = (body as { threshold_cents?: unknown } | null)?.threshold_cents;
  if (keys.length !== 1 || keys[0] !== "threshold_cents" || !(v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000)))
    return Promise.resolve(bad(422, "Invalid threshold", "Send exactly { threshold_cents }: a whole number of cents from 0 to 10,000,000, or null for none"));
  const value = v as number | null;
  return inProfile(d, tenantId, shopperId, async (tx, p) => {
    const cur = p.thresholdCents;
    if (value === cur) return bad(409, "No change", "That is already your threshold");
    const tighten = value !== null && (cur === null || value < cur);
    if (tighten) {
      const pending = await pendingOf(tx, p, "threshold");
      if (pending) await cancelChange(tx, pending, nowOf(d), "superseded by a stricter change");
      return ok(await viewOf(tx, await bump(d, tx, p, { thresholdCents: value }, "profile.tightened", { kind: "threshold", from: cur, to: value })));
    }
    if (await pendingOf(tx, p, "threshold")) return bad(409, "A threshold change is already pending", "Cancel it first");
    await schedule(d, tx, p, "threshold", { threshold_cents: value }, value === null ? "Your contact asked to turn off the first-payment rule" : `Your contact asked to raise their first-payment rule to ${usdLike(value)}`);
    return ok(await viewOf(tx, p));
  });
}

/** Invite a guardian by channel address. Grants nothing until accepted AND assigned. */
export function inviteGuardian(d: EngineDeps, tenantId: string, shopperId: string, body: unknown): Promise<ProtectionResult<ProtectionView>> {
  const b = (body ?? {}) as { display_name?: unknown; address?: unknown };
  const keys = body && typeof body === "object" ? Object.keys(body).sort() : [];
  const name = typeof b.display_name === "string" ? b.display_name.trim() : "";
  const address = typeof b.address === "string" ? b.address.trim().toUpperCase() : "";
  if (keys.join(",") !== "address,display_name" || name.length < 1 || name.length > 40 || !DEMO_ADDRESS.test(address))
    return Promise.resolve(bad(422, "Invalid invitation", "Send { display_name (1-40 characters), address (a demo inbox address like SK-ABCD-EFGH) }"));
  return inProfile(d, tenantId, shopperId, async (tx, p) => {
    const mine = await tx.db.select().from(guardians).where(and(eq(guardians.tenantId, tenantId), eq(guardians.shopperId, shopperId), inArray(guardians.status, ["INVITED", "ACTIVE"])));
    if (mine.some((g) => g.address === address)) return bad(409, "Already invited", "This address is already invited or active");
    if (mine.length >= 3) return bad(409, "Too many open invitations");
    const payer = (await tx.db.select().from(shoppers).where(eq(shoppers.id, shopperId)).limit(1))[0]!;
    const id = newId("gdn");
    await tx.db.insert(guardians).values({ id, tenantId, shopperId, displayName: name, channel: "demo_inbox", address, status: "INVITED" });
    await appendAudit(tx, { tenantId, purchaseId: null, eventType: "guardian.invited", payload: { guardian_id: id, shopper_id: shopperId, channel: "demo_inbox", address: maskAddress(address) } });
    await insertNotification(d, tx, { tenantId, guardianId: id, kind: "invite", body: { payer_name: payer.displayName, guardian_name: name } });
    return ok(await viewOf(tx, p));
  });
}

/** Make an ACTIVE guardian the second key. The first ever applies now (setup); any later one is delayed. */
export function setGuardian(d: EngineDeps, tenantId: string, shopperId: string, body: unknown): Promise<ProtectionResult<ProtectionView>> {
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  const gid = (body as { guardian_id?: unknown } | null)?.guardian_id;
  if (keys.length !== 1 || typeof gid !== "string") return Promise.resolve(bad(422, "Invalid request", "Send exactly { guardian_id }"));
  return inProfile(d, tenantId, shopperId, async (tx, p) => {
    const g = (await tx.db.select().from(guardians).where(and(eq(guardians.id, gid), eq(guardians.tenantId, tenantId), eq(guardians.shopperId, shopperId))).limit(1))[0];
    if (!g) return bad(404, "Guardian not found");
    if (g.status !== "ACTIVE") return bad(409, "This person hasn't accepted yet", "They accept through their own phone");
    if (p.guardianId === g.id) return bad(409, "No change", `${g.displayName} is already your trusted contact`);
    if ((await pendingOf(tx, p, "guardian")) || (await pendingOf(tx, p, "remove_guardian"))) return bad(409, "A change to your trusted contact is already pending", "Cancel it first");
    if (!p.protectionOn) {
      return ok(await viewOf(tx, await bump(d, tx, p, { guardianId: g.id, protectionOn: true }, "profile.tightened", { kind: "guardian", guardian_id: g.id })));
    }
    await schedule(d, tx, p, "guardian", { guardian_id: g.id }, `Your contact asked to replace you as their trusted contact`);
    return ok(await viewOf(tx, p));
  });
}

/** Turn second-key protection off, after the delay. */
export function removeGuardian(d: EngineDeps, tenantId: string, shopperId: string): Promise<ProtectionResult<ProtectionView>> {
  return inProfile(d, tenantId, shopperId, async (tx, p) => {
    if (!p.protectionOn) return bad(409, "Second key is not on");
    if ((await pendingOf(tx, p, "guardian")) || (await pendingOf(tx, p, "remove_guardian"))) return bad(409, "A change to your trusted contact is already pending", "Cancel it first");
    await schedule(d, tx, p, "remove_guardian", {}, "Your contact asked to turn off their second key");
    return ok(await viewOf(tx, p));
  });
}

/**
 * Emergency revocation: the guardian's authority (and every live credential) ends now. Protection stays on,
 * so open and new holds wait for a replacement (which is delayed) or the payer's cancel. Never a fallback.
 */
export function revokeGuardian(d: EngineDeps, tenantId: string, shopperId: string, body: unknown): Promise<ProtectionResult<ProtectionView>> {
  const reason = typeof (body as { reason?: unknown } | null)?.reason === "string" ? (body as { reason: string }).reason.trim() : "";
  if (reason.length < 3 || reason.length > 200) return Promise.resolve(bad(422, "A reason is required", "3 to 200 characters"));
  return inProfile(d, tenantId, shopperId, async (tx, p) => {
    if (!p.guardianId) return bad(409, "No trusted contact to revoke");
    const gid = p.guardianId;
    const now = nowOf(d);
    await endGuardian(tx, gid, "REVOKED", reason, now);
    const next = await bump(d, tx, p, { guardianId: null }, "guardian.revoked", { guardian_id: gid, reason });
    for (const h of await openGuardianHolds(tx, tenantId, shopperId)) {
      if (h.guardian_id !== gid) continue;
      await tx.db.update(holds).set({ ...clearCredential, guardianId: null }).where(eq(holds.purchaseId, h.purchase_id));
      await appendAudit(tx, { tenantId, purchaseId: h.purchase_id, eventType: "hold.guardian_reassigned", payload: { from: gid, to: null, reason: "guardian revoked" } });
    }
    await insertNotification(d, tx, { tenantId, guardianId: gid, kind: "revoked", body: { summary: "You are no longer this person's trusted contact." } });
    return ok(await viewOf(tx, next));
  });
}

export function cancelProfileChange(d: EngineDeps, tenantId: string, shopperId: string, changeId: string): Promise<ProtectionResult<ProtectionView>> {
  return inProfile(d, tenantId, shopperId, async (tx, p) => {
    const c = (await tx.db.select().from(profileChanges).where(and(eq(profileChanges.id, changeId), eq(profileChanges.tenantId, tenantId), eq(profileChanges.shopperId, shopperId))).for("update").limit(1))[0];
    if (!c || c.appliedAt || c.cancelledAt) return bad(404, "No pending change with that id");
    await cancelChange(tx, c, nowOf(d), "cancelled by the payer");
    return ok(await viewOf(tx, p));
  });
}

// ---- payment history -------------------------------------------------------------------------

/** Called in the transaction that moves a transfer to CAPTURED. Duplicate captures add nothing. */
export async function recordPaidPayee(tx: Tx, p: { id: string; tenantId: string; intentId: string; request: unknown }, at: Date): Promise<void> {
  if ((p.request as { kind?: string } | null)?.kind !== "transfer") return;
  const i = (await tx.db.select().from(intents).where(eq(intents.id, p.intentId)).limit(1))[0];
  const policy = i?.policy as TransferPolicyV1 | undefined;
  if (!i || policy?.kind !== "transfer") return;
  await tx.db.insert(payeeHistory).values({ tenantId: p.tenantId, shopperId: i.shopperId, payeeKey: payeeKey(policy.payee), firstPaidAt: at, purchaseId: p.id, source: "captured" }).onConflictDoNothing();
}

/** Admin (or the demo seeding a demo payer): import a payee the payer is known to have paid. Audited. */
export async function importPayee(d: EngineDeps, tenantId: string, shopperId: string, payee: { id: string; email?: string }, by: string): Promise<void> {
  await withTx(d.pool, async (tx) => {
    const key = payeeKey(payee);
    const inserted = await tx.db.insert(payeeHistory).values({ tenantId, shopperId, payeeKey: key, firstPaidAt: nowOf(d), source: "imported" }).onConflictDoNothing().returning();
    if (inserted.length) await appendAudit(tx, { tenantId, purchaseId: null, eventType: "payee_history.imported", payload: { shopper_id: shopperId, payee_key: key, by } });
  });
}

// ---- demo payer ----------------------------------------------------------------------------------

/**
 * A fresh demo payer per visitor, so one visitor's guardian never receives another's payments and the
 * delay is real. Copies the demo shopper's sandbox vault. Returns a key with the shopper scope only.
 */
export async function createDemoPayer(d: EngineDeps, tenantId: string, templateShopperId: string, knownPayees: { id: string; email?: string }[]): Promise<{ shopper_id: string; key: string }> {
  const t = (await dbOf(d.pool).select().from(shoppers).where(and(eq(shoppers.id, templateShopperId), eq(shoppers.tenantId, tenantId))).limit(1))[0];
  if (!t?.vaultId) throw new Error("demo shopper has no vault");
  const id = newId("shp");
  await dbOf(d.pool).insert(shoppers).values({ id, tenantId, displayName: "Rose", vaultId: t.vaultId });
  const { key } = await createApiKey(d.pool, tenantId, `shopper:${id}`, ["shopper"]);
  for (const p of knownPayees) await importPayee(d, tenantId, id, p, "demo:seed");
  await withTx(d.pool, (tx) => appendAudit(tx, { tenantId, purchaseId: null, eventType: "demo.payer_created", payload: { shopper_id: id } }));
  return { shopper_id: id, key };
}

