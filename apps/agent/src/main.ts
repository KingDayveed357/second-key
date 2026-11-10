// CLI: pnpm --filter @witness/agent start -- --intent int_... ["optional instruction to the agent"]
// Env: WITNESS_API, WITNESS_AGENT_KEY (or WITNESS_KEYS_FILE with an "agent" key), ANTHROPIC_API_KEY,
// CHANNEL3_API_KEY. The agent never sees PayPal credentials.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const args = process.argv.slice(2);
const i = args.indexOf("--intent");
const intentId = i >= 0 ? args[i + 1] : undefined;
const instruction = args.filter((_, k) => k !== i && k !== i + 1).join(" ") || undefined;
const keysFile = process.env.WITNESS_KEYS_FILE ?? join(root, ".secondkey", "dev-keys.json");
const agentKey = process.env.WITNESS_AGENT_KEY ?? (existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, "utf8")).agent : undefined);

const missing = [!intentId && "--intent <id>", !agentKey && "WITNESS_AGENT_KEY or WITNESS_KEYS_FILE", !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY"].filter(Boolean);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}`);
  process.exit(1);
}

const r = await runAgent({
  env: { witnessApi: process.env.WITNESS_API ?? "http://127.0.0.1:4000", agentKey: agentKey!, channel3Key: process.env.CHANNEL3_API_KEY },
  intentId: intentId!,
  ...(process.env.WITNESS_AGENT_MAX_SPEND_USD ? { maxSpendUsd: Number(process.env.WITNESS_AGENT_MAX_SPEND_USD) } : {}),
  ...(instruction ? { instruction } : {}),
});
console.log(r.text);
console.log(JSON.stringify({ turns: r.turns, usage: r.usage, estimated_cost_usd: r.estimated_cost_usd, stopped_for_budget: r.stopped_for_budget }));
