// Vitest global setup for the "db" project: one real Postgres (embedded binary) per test run.
// Each test file creates its own fresh database from it (test-support/db.ts).

import EmbeddedPostgres from "embedded-postgres";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const PORT = 54_329;
const DIR = join(process.cwd(), ".pgdata", "test");

export default async function setup(project: TestProject) {
  rmSync(DIR, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: "witness",
    password: "witness-test-only",
    persistent: false,
    // Match production (Render Postgres is UTF-8); Windows initdb would otherwise pick WIN1252.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  project.provide("pgAdminUrl", `postgres://witness:witness-test-only@127.0.0.1:${PORT}/postgres`);
  return async () => {
    // embedded-postgres registers async-exit-hook, whose beforeExit handler calls process.exit(0) and
    // so overwrote vitest's failure exit code: a failing db test used to exit 0. Unhook it before
    // stopping, so a stop that hangs on a leaked connection can't bring the override back. Its exit
    // handler goes too: it would call the async shutdown without a callback, and we stop the cluster here.
    const require = createRequire(createRequire(import.meta.url).resolve("embedded-postgres"));
    const hook = require("async-exit-hook") as { unhookEvent(e: string): void };
    hook.unhookEvent("beforeExit");
    hook.unhookEvent("exit");
    // On Windows, deleting the stopped cluster's directory sometimes fails with EBUSY. That is cleanup,
    // not a test result (setup wipes the directory anyway), so it must not fail the run.
    try {
      await pg.stop();
    } catch (e) {
      console.warn(`embedded Postgres cleanup: ${(e as Error).message}`);
    }
  };
}
