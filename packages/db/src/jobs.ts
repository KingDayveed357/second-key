// The job contract between the API and the worker. Jobs are enqueued with the caller's
// transaction (pg-boss `send(..., { db })`), so a state change and its follow-up job commit
// together or not at all.

import { PgBoss } from "pg-boss";
import type { Tx } from "./tx.ts";

export const QUEUES = {
  capture: "witness-capture",
  void: "witness-void",
  reconcile: "witness-reconcile",
  holdTimeout: "witness-hold-timeout",
  webhook: "witness-webhook",
  sweep: "witness-reconcile-sweep",
  payout: "witness-payout",
  payoutCheck: "witness-payout-check",
  /** Guardian notification outbox (ADR-0020): one job per notifications row. */
  notify: "witness-notify",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface PurchaseJob {
  tenantId: string;
  purchaseId: string;
  approvalId?: string;
}
export interface WebhookJob {
  eventId: string;
}
export interface NotifyJob {
  notificationId: string;
}

export function createBoss(connectionString: string, role: "api" | "worker"): PgBoss {
  // The API only sends jobs: it neither runs maintenance nor cron.
  return new PgBoss({ connectionString, max: 4, supervise: role === "worker", schedule: role === "worker" });
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, { retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 300 });
  }
}

export async function enqueue(
  boss: PgBoss,
  tx: Tx,
  queue: QueueName,
  data: PurchaseJob | WebhookJob | NotifyJob,
  opts: { startAfter?: Date; singletonKey?: string } = {},
): Promise<string | null> {
  return boss.send(queue, data as object, { ...opts, db: { executeSql: tx.executeSql } });
}
