// Queue -> handler mapping, used by the worker process (and by tests to drain jobs deterministically).

import { and, eq, inArray, lt } from "drizzle-orm";
import { OPEN_AUTHORIZATION_STATES } from "@witness/core";
import { QUEUES, dbOf, enqueue, schema, withTx, type NotifyJob, type PurchaseJob, type QueueName, type SettlementJob, type WebhookJob } from "@witness/db";
import { applyAllDueChanges, deliverNotification, logOf, nowOf, sweepNotifications } from "@witness/engine";
import { executeCapture, executeVoid, holdTimeout, reconcile, type ExecutorDeps } from "./executor.ts";
import { checkPayout, executePayout, sweepPayouts, type PayoutJob } from "./payout.ts";
import { executeAp2Capture, executeAp2Void, reconcileAp2 } from "./settlement.ts";

const { purchases, webhookEvents } = schema;

/** Map a verified webhook to a purchase and reconcile it. The payload is a hint; PayPal's re-fetched state decides. */
export async function processWebhook(d: ExecutorDeps, job: WebhookJob): Promise<string> {
  const db = dbOf(d.pool);
  const ev = (await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, job.eventId)).limit(1))[0];
  if (!ev) return "event not found";
  if (ev.processedAt) return "already processed";
  const resource = (ev.payload as any)?.resource ?? {};
  const related = resource?.supplementary_data?.related_ids ?? {};
  const candidates = [ev.resourceId, resource.id, related.order_id, related.authorization_id].filter((x): x is string => typeof x === "string");

  let purchase: typeof purchases.$inferSelect | undefined;
  for (const id of candidates) {
    purchase = (await db.select().from(purchases).where(eq(purchases.paypalOrderId, id)).limit(1))[0];
    purchase ??= (await db.select().from(purchases).where(eq(purchases.paypalAuthorizationId, id)).limit(1))[0];
    purchase ??= (await db.select().from(purchases).where(eq(purchases.paypalCaptureId, id)).limit(1))[0];
    if (purchase) break;
  }

  let outcome = "no matching purchase";
  if (purchase) outcome = await reconcile(d, { tenantId: purchase.tenantId, purchaseId: purchase.id });
  await db.update(webhookEvents).set({ processedAt: nowOf(d), outcome }).where(eq(webhookEvents.eventId, ev.eventId));
  return outcome;
}

/** Periodic safety net: re-examine purchases stuck in an open state (covers missed webhooks and crashes). */
export async function sweep(d: ExecutorDeps, olderThanMs = 60_000): Promise<number> {
  const cutoff = new Date(nowOf(d).getTime() - olderThanMs);
  const stuck = await dbOf(d.pool)
    .select({ id: purchases.id, tenantId: purchases.tenantId })
    .from(purchases)
    .where(and(inArray(purchases.state, [...OPEN_AUTHORIZATION_STATES, "CAPTURE_PENDING"]), lt(purchases.updatedAt, cutoff)))
    .limit(200);
  for (const p of stuck) {
    await withTx(d.pool, (tx) => enqueue(d.boss, tx, QUEUES.reconcile, { tenantId: p.tenantId, purchaseId: p.id }, { singletonKey: `reconcile:${p.id}` }));
  }
  return stuck.length;
}

export async function handleJob(d: ExecutorDeps, queue: QueueName, data: unknown): Promise<string> {
  const log = logOf(d);
  let result: string;
  switch (queue) {
    case QUEUES.capture:
      result = await executeCapture(d, data as PurchaseJob);
      break;
    case QUEUES.void:
      result = await executeVoid(d, data as PurchaseJob);
      break;
    case QUEUES.payout:
      result = await executePayout(d, data as PayoutJob);
      break;
    case QUEUES.payoutCheck:
      result = await checkPayout(d, data as PayoutJob);
      break;
    case QUEUES.reconcile:
      result = await reconcile(d, data as PurchaseJob);
      break;
    case QUEUES.holdTimeout:
      result = await holdTimeout(d, data as PurchaseJob);
      break;
    case QUEUES.webhook:
      result = await processWebhook(d, data as WebhookJob);
      break;
    case QUEUES.notify:
      result = await deliverNotification(d, (data as NotifyJob).notificationId);
      break;
    case QUEUES.ap2Capture:
      result = await executeAp2Capture(d, data as SettlementJob);
      break;
    case QUEUES.ap2Void:
      result = await executeAp2Void(d, data as SettlementJob);
      break;
    case QUEUES.ap2Reconcile:
      result = await reconcileAp2(d, data as SettlementJob);
      break;
    case QUEUES.sweep:
      result = `swept ${await sweep(d)}; payouts ${await sweepPayouts(d)}; notifications ${await sweepNotifications(d)}; profile changes ${await applyAllDueChanges(d)}`;
      break;
    default:
      throw new Error(`unknown queue ${queue}`);
  }
  log.info("job done", { queue, ...(data as object), result });
  return result;
}
