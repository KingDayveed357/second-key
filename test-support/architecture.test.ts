// The architecture checker must actually fail on violations (a rule that can't fail is useless).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkFiles, checkRepo, importsOf } from "../scripts/architecture-rules.ts";

const root = mkdtempSync(join(tmpdir(), "witness-arch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function probe(rel: string, source: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, source);
  return checkFiles(root, [abs]);
}

describe("architecture rules", () => {
  test("the real repository passes", () => {
    expect(checkRepo(join(import.meta.dirname, ".."))).toEqual([]);
  });

  test("the API importing the money-movement client fails", () => {
    expect(probe("apps/api/src/bad.ts", `import { MoneyMovementClient } from "@witness/paypal/money-movement";`).map((v) => v.rule)).toEqual(["money-movement-only-in-executor"]);
  });

  test("a dynamic or re-exported import is caught too", () => {
    expect(probe("apps/api/src/bad2.ts", `const m = await import("@witness/paypal/money-movement");`)).toHaveLength(1);
    expect(probe("packages/catalog/src/bad3.ts", `export { MoneyMovementClient } from "@witness/paypal/money-movement";`)).toHaveLength(1);
  });

  test("the API importing the executor fails; the worker may", () => {
    expect(probe("apps/api/src/bad4.ts", `import { consumeApproval } from "@witness/executor";`).map((v) => v.rule)).toEqual(["executor-only-in-worker"]);
    expect(probe("apps/worker/src/ok.ts", `import { consumeApproval } from "@witness/executor";`)).toEqual([]);
  });

  test("the executor may import money movement", () => {
    expect(probe("packages/executor/src/ok.ts", `import { MoneyMovementClient } from "@witness/paypal/money-movement";`)).toEqual([]);
  });

  test("core importing the database or network fails", () => {
    expect(probe("packages/core/src/bad5.ts", `import pg from "pg";`)).toHaveLength(1);
    expect(probe("packages/core/src/bad6.ts", `import { withTx } from "@witness/db";`)).toHaveLength(1);
  });

  test("the AP2 verifier importing the database, network or other Witness code fails", () => {
    expect(probe("packages/ap2/src/bad12.ts", `import { withTx } from "@witness/db";`).map((v) => v.rule)).toEqual(["ap2-is-pure"]);
    expect(probe("packages/ap2/src/bad13.ts", `import { request } from "node:https";`)).toHaveLength(1);
  });

  test("the web app importing PayPal or the DB fails", () => {
    expect(probe("apps/web/src/bad7.ts", `import { PayPalClient } from "@witness/paypal";`)).toHaveLength(1);
  });

  test("the AI package can never reach PayPal, the database or the executor", () => {
    expect(probe("packages/ai/src/bad8.ts", `import { PayPalClient } from "@witness/paypal";`).map((v) => v.rule)).toEqual(["ai-has-no-money-access"]);
    expect(probe("packages/ai/src/bad9.ts", `import { withTx } from "@witness/db";`)).toHaveLength(1);
  });

  test("the reference agent can't import any Witness internals (HTTP only)", () => {
    expect(probe("apps/agent/src/bad10.ts", `import { submitPurchase } from "@witness/engine";`).map((v) => v.rule)).toEqual(["agent-is-an-outsider"]);
    expect(probe("apps/agent/src/bad11.ts", `import { PayPalClient } from "@witness/paypal";`).map((v) => v.rule)).toContain("agent-is-an-outsider");
  });

  test("commented-out imports are ignored", () => {
    expect(importsOf(`// import x from "@witness/paypal/money-movement";\n/* import y from "@witness/executor" */\nimport z from "zod";`)).toEqual(["zod"]);
  });
});
