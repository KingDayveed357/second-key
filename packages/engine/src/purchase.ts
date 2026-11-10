// The decision engine: screen -> (REJECT | create+authorize order) -> verify -> HOLD | CAPTURE_APPROVED | VOIDING.
// It writes approvals; it never captures or voids (that is the executor, in the worker).

import { and, eq, notInArray } from "drizzle-orm";
import {
  authorizationDiffs,
  authorizationOf,
  canonicalJson,
  cartDigest,
  expectationFor,
  expectedItems,
  fromCents,
  newId,
  parseIntentPolicy,
  parsePaymentRequest,
  paypalRequestId,
  screenOutcome,
  screenPayment,
  sha256Hex,
  threeWayMatch,
  type Check,
  type PurchaseState,
  type ResolvedCart,
} from "@witness/core";
import {
  QUEUES,
  appendAudit,
  dbOf,
  enqueue,
  journalFinish,
  journalStart,
  recordChecks,
  recordDecision,
  schema,
  transition,
  withTx,
  type PurchasePatch,
  type PurchaseRow,
  type Tx,
} from "@witness/db";
import { UnavailableLlm, screenPaymentAi, settleDeferred, type AiSubject } from "@witness/ai";
import { PayPalHttpError, PayPalNetworkError } from "@witness/paypal";
import { DEFAULT_ADAPTERS, logOf, nowOf, type EngineDeps, type Principal } from "./deps.ts";
import { applyDueChangesFor, classifyHold, holdAuthority, notifyNewHold, screeningProtection } from "./protection.ts";

const { purchases, intents, shoppers, tenants, approvals, holds, checks: checksT, paypalCalls } = schema;

/** States that no longer count against an intent's max_purchases. */
const DEAD_STATES: PurchaseState[] = ["REJECTED", "AUTH_FAILED", "VOIDED", "CAPTURE_DECLINED"];

export interface PurchaseView {
  id: string;
  state: string;
  outcome: string | null;
  reasons: string[];
  intent_id: string;
  retailer: string | null;
  amount: { currency_code: string; value: string } | null;
  paypal: { order_id: string | null; authorization_id: string | null; capture_id: string | null };
  created_at: string;
  updated_at: string;
}

export function purchaseView(p: PurchaseRow): PurchaseView {
  return {
    id: p.id,
    state: p.state,
    outcome: p.outcome,
    reasons: p.reasons ?? [],
    intent_id: p.intentId,
    retailer: p.retailer,
    amount: p.amountCents != null && p.currency ? { currency_code: p.currency, value: fromCents(p.amountCents) } : null,
    paypal: { order_id: p.paypalOrderId, authorization_id: p.paypalAuthorizationId, capture_id: p.paypalCaptureId },
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

/** What an agent may see: status and reasons, no PayPal identifiers. */
export function agentView(p: PurchaseRow) {
  const { paypal: _paypal, ...rest } = purchaseView(p);
  return rest;
}

export type SubmitResult =
  | { kind: "ok"; replay: boolean; purchase: PurchaseRow }
  | { kind: "error"; status: 400 | 404 | 409 | 422; title: string; detail: string };

const err = (status: 400 | 404 | 409 | 422, title: string, detail: string): SubmitResult => ({ kind: "error", status, title, detail });

/** SCREENING -> REJECTED with every failing check as a reason. No PayPal call has been made. */
async function rejectScreened(tx: Tx, tenantId: string, purchaseId: string, all: Check[], patch: PurchasePatch) {
  const reasons = all.filter((c) => c.result === "fail").map((c) => `${c.id}: ${c.detail}`);
  await recordDecision(tx, purchaseId, "REJECT", reasons, "engine");
  await transition(tx, { tenantId, purchaseId, from: "SCREENING", to: "REJECTED", event: "purchase.rejected", payload: { reasons, paypal_called: false }, patch: { ...patch, outcome: "REJECT", reasons } });
}

async function readPurchase(d: EngineDeps, tenantId: string, id: string): Promise<PurchaseRow> {
  const rows = await dbOf(d.pool).select().from(purchases).where(and(eq(purchases.id, id), eq(purchases.tenantId, tenantId))).limit(1);
  if (!rows[0]) throw new Error(`purchase ${id} not found`);
  return rows[0];
}

export async function submitPurchase(d: EngineDeps, who: Principal, idempotencyKey: string, body: unknown, opts: { adapter?: string } = {}): Promise<SubmitResult> {
  const parsed = parsePaymentRequest(body);
  if (!parsed.success) return err(422, "Invalid purchase request", parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  const req = parsed.data;
  const adapterName = opts.adapter ?? "standard";
  const adapters = d.adapters ?? DEFAULT_ADAPTERS;
  if (!adapters[adapterName]) return err(400, "Unknown checkout adapter", adapterName);
  if (!/^[\w.:-]{8,128}$/.test(idempotencyKey)) return err(422, "Invalid Idempotency-Key", "8-128 characters of [A-Za-z0-9_.:-]");

  const requestHash = "sha256:" + sha256Hex(canonicalJson({ body: req, adapter: adapterName }));
  const db = dbOf(d.pool);
  const findExisting = async () =>
    (
      await db
        .select()
        .from(purchases)
        .where(and(eq(purchases.tenantId, who.tenantId), eq(purchases.agentPrincipal, who.principal), eq(purchases.idempotencyKey, idempotencyKey)))
        .limit(1)
    )[0];
  const replay = (p: PurchaseRow): SubmitResult =>
    p.requestHash === requestHash ? { kind: "ok", replay: true, purchase: p } : err(422, "Idempotency-Key reused", "This Idempotency-Key was already used with a different request body.");

  const existing = await findExisting();
  if (existing) return replay(existing);

  // Facts are fetched by Second Key, from the catalog, by canonical ID: never from the agent. A
  // transfer has no catalog facts: its cart is derived from the intent the payer confirmed.
  const ids = req.kind === "transfer" ? [] : [...new Set(req.lines.map((l) => l.product_id))];
  const catalog = ids.length ? await d.catalog.getProducts(ids) : { facts: new Map() };
  const now = nowOf(d);

  // ADR-0020: apply the payer's due profile changes first, in their own transaction (lock order).
  if (req.kind === "transfer") {
    const owner = (await db.select({ shopperId: intents.shopperId }).from(intents).where(and(eq(intents.id, req.intent_id), eq(intents.tenantId, who.tenantId))).limit(1))[0];
    if (owner) await applyDueChangesFor(d, who.tenantId, owner.shopperId);
  }

  const step = await withTx(d.pool, async (tx) => {
    const intent = (
      await tx.db
        .select()
        .from(intents)
        .where(and(eq(intents.id, req.intent_id), eq(intents.tenantId, who.tenantId)))
        .for("update")
        .limit(1)
    )[0];
    if (!intent) return err(404, "Intent not found", req.intent_id);
    if (intent.status !== "CONFIRMED") return err(409, "Intent is not confirmed", `intent ${intent.id} is ${intent.status}`);
    const policy = parseIntentPolicy(intent.policy);
    if (!policy.success) return err(409, "Intent policy is invalid", `intent ${intent.id} can't be used`);

    // ADR-0020: a transfer is screened against the payer's standing profile and real payment history,
    // read here, before this transaction's first audit append (lock order), and snapshotted below.
    const protection = policy.data.kind === "transfer" ? await screeningProtection(tx, who.tenantId, intent.shopperId, policy.data) : null;

    const used = await tx.db
      .select({ id: purchases.id })
      .from(purchases)
      .where(and(eq(purchases.intentId, intent.id), notInArray(purchases.state, DEAD_STATES)));
    const shopper = (await tx.db.select().from(shoppers).where(eq(shoppers.id, intent.shopperId)).limit(1))[0];

    const purchaseId = newId("pur");
    const inserted = await tx.db
      .insert(purchases)
      .values({
        id: purchaseId,
        tenantId: who.tenantId,
        intentId: intent.id,
        intentVersion: intent.version,
        policyDigest: intent.policyDigest!,
        agentPrincipal: who.principal,
        idempotencyKey,
        requestHash,
        request: req,
        adapter: adapterName,
        state: "SCREENING",
      })
      .onConflictDoNothing()
      .returning({ id: purchases.id });
    if (!inserted.length) return { race: true as const };

    await appendAudit(tx, {
      tenantId: who.tenantId,
      purchaseId,
      eventType: "purchase.submitted",
      payload:
        req.kind === "transfer"
          ? { intent_id: intent.id, intent_version: intent.version, policy_digest: intent.policyDigest, agent: who.principal, kind: "transfer", payee_id: req.payee_id, amount_cents: req.amount_cents, currency: req.currency, adapter: adapterName }
          : { intent_id: intent.id, intent_version: intent.version, policy_digest: intent.policyDigest, agent: who.principal, retailer: req.retailer, lines: req.lines, adapter: adapterName },
    });

    if (protection) await tx.db.update(purchases).set({ protection: protection.snapshot }).where(eq(purchases.id, purchaseId));
    const screened = screenPayment(policy.data, req, catalog.facts, { now, purchasesUsed: used.length, ...(protection ? { payer: protection.payer } : {}) });
    const cart = screened.cart;
    const all: Check[] = [...screened.checks];
    if (!shopper?.vaultId) all.push({ id: "shopper.vault", result: "fail", detail: "shopper has no saved PayPal wallet" });

    const facts = Object.fromEntries(catalog.facts);
    const rejected = screenOutcome(all) === "REJECT" || !cart;
    // Checks deferred to an AI judgement are recorded once settled (phase 3), so the stored checks
    // always reflect the effective decision.
    await recordChecks(tx, purchaseId, "SCREEN", rejected ? all : all.filter((c) => !c.defers_to));
    if (rejected) {
      await rejectScreened(tx, who.tenantId, purchaseId, all, { retailer: cart?.retailer ?? (req.kind === "transfer" ? null : req.retailer), facts, cart: cart ?? null, amountCents: cart?.total_cents ?? null, currency: cart?.currency ?? null });
      return { purchaseId, next: false as const };
    }
    // Deterministic screen passed. Keep the purchase in SCREENING (it already counts against the
    // intent's max_purchases) and release the intent lock before the slow AI calls.
    const digest = cartDigest(cart.currency, expectedItems(cart));
    await tx.db
      .update(purchases)
      .set({ retailer: cart.retailer, facts, cart, cartDigest: digest, amountCents: cart.total_cents, currency: cart.currency, updatedAt: new Date() })
      .where(eq(purchases.id, purchaseId));
    const subject: AiSubject = policy.data.kind === "transfer" ? { kind: "transfer" } : { kind: "shopping", policy: policy.data, cart, facts: catalog.facts, deterministic: all };
    return { purchaseId, next: true as const, subject, deterministic: all, digest };
  });

  if ("kind" in step) return step;
  if ("race" in step) {
    const p = await findExisting();
    return p ? replay(p) : err(409, "Concurrent submission", "retry with the same Idempotency-Key");
  }
  if (step.next) {
    // AI checks run outside any transaction. They can only make the decision stricter, and any
    // failure (including no provider configured) is "unknown", which becomes HOLD.
    const aiChecks = await screenPaymentAi(d.ai ?? new UnavailableLlm(), step.subject, req.conversation);
    const proceed = await withTx(d.pool, async (tx) => {
      const locked = (await tx.db.select().from(purchases).where(eq(purchases.id, step.purchaseId)).for("update").limit(1))[0];
      if (!locked || locked.state !== "SCREENING") return false;
      const effective = settleDeferred(step.deterministic, aiChecks);
      const deferred = step.deterministic
        .filter((x) => x.defers_to)
        .map((x) => {
          if (effective.includes(x)) return x;
          const by = aiChecks.find((y) => y.id === x.defers_to && y.line === x.line);
          return { ...x, result: "pass" as const, detail: `${x.detail}; settled by ${x.defers_to}: ${by?.detail ?? ""}` };
        });
      await recordChecks(tx, step.purchaseId, "SCREEN", [...deferred, ...aiChecks]);
      const all = [...effective, ...aiChecks];
      const outcome = screenOutcome(all);
      if (outcome === "REJECT") {
        await rejectScreened(tx, who.tenantId, step.purchaseId, all, {});
        return false;
      }
      await transition(tx, {
        tenantId: who.tenantId,
        purchaseId: step.purchaseId,
        from: "SCREENING",
        to: "AUTHORIZING",
        event: "purchase.screened",
        payload: { screen_outcome: outcome, cart_digest: step.digest, ai_checks: aiChecks.map((c) => ({ id: c.id, result: c.result, model: c.model ?? null, prompt_version: c.prompt_version ?? null })) },
      });
      return true;
    });
    if (proceed) {
      await authorizePurchase(d, who.tenantId, step.purchaseId);
      await verifyPurchase(d, who.tenantId, step.purchaseId);
    }
  }
  return { kind: "ok", replay: false, purchase: await readPurchase(d, who.tenantId, step.purchaseId) };
}

async function scheduleReconcile(d: EngineDeps, tenantId: string, purchaseId: string, delayMs = 30_000) {
  await withTx(d.pool, (tx) =>
    enqueue(d.boss, tx, QUEUES.reconcile, { tenantId, purchaseId }, { startAfter: new Date(nowOf(d).getTime() + delayMs), singletonKey: `reconcile:${purchaseId}` }),
  );
}

/**
 * AUTHORIZING -> VERIFYING | AUTH_FAILED. Idempotent: the PayPal-Request-Id is derived from the
 * purchase, and a retry re-sends the exact journaled body, so PayPal returns the same order.
 */
export async function authorizePurchase(d: EngineDeps, tenantId: string, purchaseId: string): Promise<void> {
  const log = logOf(d);
  const p = await readPurchase(d, tenantId, purchaseId);
  if (p.state !== "AUTHORIZING") return;
  const requestId = paypalRequestId(purchaseId, "create-order");

  const prepared = await withTx(d.pool, async (tx) => {
    const prior = (
      await tx.db
        .select()
        .from(paypalCalls)
        .where(and(eq(paypalCalls.purchaseId, purchaseId), eq(paypalCalls.op, "create-order")))
        .limit(1)
    )[0];
    if (prior) return { journalId: prior.id, body: prior.request as Record<string, unknown> };
    const intent = (await tx.db.select().from(intents).where(eq(intents.id, p.intentId)).limit(1))[0]!;
    const shopper = (await tx.db.select().from(shoppers).where(eq(shoppers.id, intent.shopperId)).limit(1))[0]!;
    const adapter = (d.adapters ?? DEFAULT_ADAPTERS)[p.adapter]!;
    const body = adapter.buildOrder(p.cart as ResolvedCart, { purchaseId, policyDigest: p.policyDigest, vaultId: shopper.vaultId! });
    const journalId = await journalStart(tx, { purchaseId, op: "create-order", requestId, request: body });
    return { journalId, body };
  });

  let res;
  try {
    res = await d.paypal.createOrder(prepared.body, requestId);
  } catch (e) {
    if (e instanceof PayPalNetworkError) {
      log.warn("create-order outcome unknown; will reconcile", { purchaseId, error: e.message });
      await journalFinish(dbOf(d.pool), prepared.journalId, { status: "UNKNOWN", error: e.message });
      await scheduleReconcile(d, tenantId, purchaseId);
      return;
    }
    if (e instanceof PayPalHttpError) {
      await withTx(d.pool, async (tx) => {
        await journalFinish(tx.db, prepared.journalId, { status: "FAILED", httpStatus: e.status, debugId: e.debugId, response: e.data, error: e.issue });
        const reasons = [`paypal: ${e.issue} (HTTP ${e.status}, debug ${e.debugId})`];
        await transition(tx, { tenantId, purchaseId, from: "AUTHORIZING", to: "AUTH_FAILED", event: "purchase.auth_failed", payload: { reasons }, patch: { reasons } });
      });
      return;
    }
    throw e;
  }

  const auth = authorizationOf(res.data);
  await withTx(d.pool, async (tx) => {
    await journalFinish(tx.db, prepared.journalId, { status: "SUCCEEDED", httpStatus: res.status, debugId: res.debugId, response: res.data });
    if (!auth || auth.status !== "CREATED") {
      const reasons = [auth ? `authorization ${auth.id} is ${auth.status}` : `order ${res.data?.id} is ${res.data?.status}: no authorization (buyer action required?)`];
      await transition(tx, { tenantId, purchaseId, from: "AUTHORIZING", to: "AUTH_FAILED", event: "purchase.auth_failed", payload: { reasons, order_id: res.data?.id }, patch: { reasons, paypalOrderId: res.data?.id ?? null } });
      return;
    }
    await transition(tx, {
      tenantId,
      purchaseId,
      from: "AUTHORIZING",
      to: "VERIFYING",
      event: "purchase.authorized",
      payload: { order_id: res.data.id, authorization_id: auth.id, amount_cents: auth.amount_cents, debug_id: res.debugId },
      patch: { paypalOrderId: res.data.id, paypalAuthorizationId: auth.id, authorizedAt: nowOf(d) },
    });
  });
}

/** VERIFYING -> VOIDING (mismatch) | HELD (needs a human) | CAPTURE_APPROVED (approval + capture job). */
export async function verifyPurchase(d: EngineDeps, tenantId: string, purchaseId: string): Promise<void> {
  const log = logOf(d);
  const p = await readPurchase(d, tenantId, purchaseId);
  if (p.state !== "VERIFYING") return;
  const db = dbOf(d.pool);
  const tenant = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0]!;

  let order: unknown;
  try {
    order = (await d.paypal.getOrder(p.paypalOrderId!)).data;
  } catch (e) {
    if (e instanceof PayPalNetworkError || e instanceof PayPalHttpError) {
      log.warn("verify: could not read PayPal order; will reconcile", { purchaseId, error: (e as Error).message });
      await scheduleReconcile(d, tenantId, purchaseId);
      return;
    }
    throw e;
  }

  const cart = p.cart as ResolvedCart;
  const exp = expectationFor(cart, p.paypalOrderId!, tenant.paypalMerchantId);
  const diffs = [...threeWayMatch(exp, order), ...authorizationDiffs(exp, order, p.paypalAuthorizationId!)];
  const now = nowOf(d);

  await withTx(d.pool, async (tx) => {
    const locked = (await tx.db.select().from(purchases).where(eq(purchases.id, purchaseId)).for("update").limit(1))[0];
    if (!locked || locked.state !== "VERIFYING") return;

    await recordChecks(
      tx,
      purchaseId,
      "VERIFY",
      diffs.length ? diffs.map((detail) => ({ id: "three_way_match", result: "fail" as const, detail })) : [{ id: "three_way_match", result: "pass", detail: "PayPal's stored order matches the verified cart, amount, currency and payee exactly" }],
    );

    if (diffs.length) {
      await recordDecision(tx, purchaseId, "VOID", diffs, "engine");
      await transition(tx, { tenantId, purchaseId, from: "VERIFYING", to: "VOIDING", event: "purchase.void_decided", payload: { reasons: diffs }, patch: { outcome: "VOID", reasons: diffs } });
      await enqueue(d.boss, tx, QUEUES.void, { tenantId, purchaseId }, { singletonKey: `void:${purchaseId}` });
      return;
    }

    const intent = (await tx.db.select().from(intents).where(eq(intents.id, p.intentId)).limit(1))[0]!;
    if (intent.status !== "CONFIRMED" || intent.policyDigest !== p.policyDigest) {
      const reasons = [`intent ${intent.id} is ${intent.status}; the purchase was screened against a policy that is no longer in force`];
      await recordDecision(tx, purchaseId, "VOID", reasons, "engine");
      await transition(tx, { tenantId, purchaseId, from: "VERIFYING", to: "VOIDING", event: "purchase.void_decided", payload: { reasons }, patch: { outcome: "VOID", reasons } });
      await enqueue(d.boss, tx, QUEUES.void, { tenantId, purchaseId }, { singletonKey: `void:${purchaseId}` });
      return;
    }

    const unknowns = await tx.db
      .select()
      .from(checksT)
      .where(and(eq(checksT.purchaseId, purchaseId), eq(checksT.phase, "SCREEN"), eq(checksT.result, "unknown")));
    if (unknowns.length) {
      const reasons = unknowns.map((c) => `${c.checkId}: ${c.detail}`);
      const autoVoidAt = new Date((locked.authorizedAt ?? now).getTime() + (d.holdMs ?? 72 * 3600_000));
      // ADR-0020: who may approve is decided here, deterministically, and never by a model.
      const reasonClasses = classifyHold(unknowns);
      const isTransfer = (locked.request as { kind?: string } | null)?.kind === "transfer";
      const authority = await holdAuthority(tx, tenantId, intent.shopperId, isTransfer);
      await recordDecision(tx, purchaseId, "HOLD", reasons, "engine");
      await transition(tx, {
        tenantId,
        purchaseId,
        from: "VERIFYING",
        to: "HELD",
        event: "purchase.held",
        payload: { reasons, auto_void_at: autoVoidAt.toISOString(), approver: authority.approver, guardian_id: authority.guardianId, reason_classes: reasonClasses },
        patch: { outcome: "HOLD", reasons },
      });
      await tx.db.insert(holds).values({ purchaseId, autoVoidAt, approver: authority.approver, guardianId: authority.guardianId, reasonClasses });
      if (authority.approver === "guardian") await notifyNewHold(d, tx, tenantId, purchaseId, authority.guardianId);
      await enqueue(d.boss, tx, QUEUES.holdTimeout, { tenantId, purchaseId }, { startAfter: autoVoidAt, singletonKey: `hold:${purchaseId}` });
      return;
    }

    await issueApproval(d, tx, locked, tenant.paypalMerchantId, "VERIFYING", "engine");
  });
}

/** Write the single-use capability and queue the executor. Shared by verify and HOLD approval. */
export async function issueApproval(
  d: EngineDeps,
  tx: Tx,
  p: PurchaseRow,
  payee: string,
  from: "VERIFYING" | "HELD",
  decidedBy: string,
): Promise<string> {
  const approvalId = newId("apr");
  const expiresAt = new Date(nowOf(d).getTime() + (d.approvalTtlMs ?? 10 * 60_000));
  await tx.db.insert(approvals).values({
    id: approvalId,
    purchaseId: p.id,
    tenantId: p.tenantId,
    paypalOrderId: p.paypalOrderId!,
    paypalAuthorizationId: p.paypalAuthorizationId!,
    payeeMerchantId: payee,
    amountCents: p.amountCents!,
    currency: p.currency!,
    cartDigest: p.cartDigest!,
    policyDigest: p.policyDigest,
    intentVersion: p.intentVersion,
    requestId: paypalRequestId(approvalId, "capture"),
    expiresAt,
  });
  await recordDecision(tx, p.id, "CAPTURE", [], decidedBy);
  await transition(tx, {
    tenantId: p.tenantId,
    purchaseId: p.id,
    from,
    to: "CAPTURE_APPROVED",
    event: "purchase.capture_approved",
    payload: { approval_id: approvalId, expires_at: expiresAt.toISOString(), amount_cents: p.amountCents, cart_digest: p.cartDigest, decided_by: decidedBy },
    patch: { outcome: "CAPTURE", reasons: [] },
  });
  await enqueue(d.boss, tx, QUEUES.capture, { tenantId: p.tenantId, purchaseId: p.id, approvalId }, { singletonKey: `capture:${p.id}` });
  return approvalId;
}
