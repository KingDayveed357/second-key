// Second Key worker: the only process that can move money. It has no HTTP server; work arrives only
// as database-backed jobs (pg-boss). Runs the executor, webhook processing, HOLD timeouts and the
// reconciliation sweep.

import { catalogFromEnv } from "@witness/catalog";
import { WorkerConfig, loadDotEnv, parseConfig } from "@witness/config";
import { QUEUES, createBoss, createPool, ensureQueues, migrate, type QueueName } from "@witness/db";
import { createMoneyMovementClient, handleJob, type ExecutorDeps } from "@witness/executor";
import { PayPalClient } from "@witness/paypal";

loadDotEnv();
const cfg = parseConfig(WorkerConfig);
const pool = createPool(cfg.DATABASE_URL);
await migrate(pool);
const boss = createBoss(cfg.DATABASE_URL, "worker");
boss.on("error", (e) => console.error("pg-boss:", e.message));
await boss.start();
await ensureQueues(boss);

const creds = { baseUrl: cfg.PAYPAL_BASE_URL, clientId: cfg.PAYPAL_CLIENT_ID, clientSecret: cfg.PAYPAL_CLIENT_SECRET };
const log = (level: "info" | "warn" | "error") => (msg: string, data?: Record<string, unknown>) =>
  console[level === "info" ? "log" : level](JSON.stringify({ level, msg, ...data, at: new Date().toISOString() }));

const d: ExecutorDeps = {
  pool,
  boss,
  paypal: new PayPalClient({ ...creds, role: "script" }),
  money: createMoneyMovementClient(creds),
  catalog: catalogFromEnv(cfg),
  log: { info: log("info"), warn: log("warn"), error: log("error") },
};

for (const queue of Object.values(QUEUES) as QueueName[]) {
  await boss.work<object>(queue, { batchSize: cfg.WORKER_CONCURRENCY, pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await handleJob(d, queue, job.data);
  });
}
await boss.schedule(QUEUES.sweep, "*/5 * * * *", {});
d.log!.info("worker started", { queues: Object.values(QUEUES) });

const close = async () => {
  await boss.stop({ graceful: true, timeout: 20_000 });
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
