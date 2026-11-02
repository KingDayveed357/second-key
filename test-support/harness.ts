// Full pipeline harness: real Postgres + real pg-boss + engine + executor, with a fake PayPal.
// Jobs are drained deterministically instead of by background workers.

import type pg from "pg";
import { PgBoss } from "pg-boss";
import { FixtureCatalog } from "@witness/catalog";
import { newId } from "@witness/core";
import { QUEUES, createBoss, ensureQueues, type QueueName } from "@witness/db";
import type { Principal } from "@witness/engine";
import { handleJob, type ExecutorDeps } from "@witness/executor";
import { PayPalClient } from "@witness/paypal";
import { MoneyMovementClient } from "@witness/paypal/money-movement";
import { freshDatabase } from "./db.ts";
import { harnessAi } from "./fake-ai.ts";
import { FakePayPal } from "./fake-paypal.ts";
import { PAYEE } from "./seed.ts";

export interface Harness {
  pool: pg.Pool;
  url: string;
  boss: PgBoss;
  fake: FakePayPal;
  d: ExecutorDeps;
  tenantId: string;
  shopperId: string;
  agent: Principal;
  clock: { now: Date };
  drain(): Promise<string[]>;
  close(): Promise<void>;
}

export async function createHarness(over: Partial<ExecutorDeps> = {}): Promise<Harness> {
  const { pool, url, drop } = await freshDatabase();
  const boss = createBoss(url, "api");
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss);
  const fake = new FakePayPal(PAYEE);
  const creds = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "test-id", clientSecret: "test-secret", fetchImpl: fake.fetch };
  const clock = { now: new Date() };

  const tenantId = newId("ten");
  const shopperId = newId("shp");
  await pool.query("INSERT INTO tenants (id, name, paypal_merchant_id) VALUES ($1, 'Harness MoR', $2)", [tenantId, PAYEE]);
  await pool.query("INSERT INTO shoppers (id, tenant_id, display_name, vault_id) VALUES ($1, $2, 'Harness Shopper', 'vault_harness')", [shopperId, tenantId]);

  const d: ExecutorDeps = {
    pool,
    boss,
    paypal: new PayPalClient(creds),
    money: new MoneyMovementClient(creds),
    catalog: new FixtureCatalog(),
    ai: harnessAi(),
    now: () => clock.now,
    ...over,
  };

  return {
    pool,
    url,
    boss,
    fake,
    d,
    tenantId,
    shopperId,
    agent: { tenantId, principal: "agent:harness", scopes: ["agent:purchase"] },
    clock,
    async drain() {
      const results: string[] = [];
      for (let round = 0; round < 25; round++) {
        let any = false;
        for (const q of [QUEUES.capture, QUEUES.void, QUEUES.holdTimeout, QUEUES.webhook, QUEUES.payout, QUEUES.notify] as QueueName[]) {
          const jobs = await boss.fetch<object>(q, { batchSize: 10 });
          for (const j of jobs) {
            any = true;
            results.push(`${q}: ${await handleJob(d, q, j.data)}`);
            await boss.complete(q, j.id);
          }
        }
        if (!any) break;
      }
      return results;
    },
    async close() {
      await boss.stop({ graceful: false, close: true }).catch(() => {});
      await drop();
    },
  };
}
