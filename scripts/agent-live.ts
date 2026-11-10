// LIVE reference-agent run against a local Second Key API (real Haiku, real Channel3, PayPal sandbox).
// 1. Shopper text -> live intent compiler -> shopper confirms (filling any gaps explicitly).
// 2. The reference agent shops via Second Key's API only.
// 3. Cleanup: revoke the intent so any held authorization is voided. Reports PayPal's own state.
// Agent spend cap: WITNESS_AGENT_MAX_SPEND_USD (default $0.05).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadDotEnv } from "@witness/config";
import { runAgent } from "../apps/agent/src/agent.ts";

loadDotEnv();
const BASE = process.env.WITNESS_API ?? "http://127.0.0.1:4000";
const keys = JSON.parse(readFileSync(process.env.WITNESS_KEYS_FILE ?? join(ROOT, ".secondkey", "dev-keys.json"), "utf8"));
const call = async (method: string, path: string, key: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};

const text = process.argv[2] ?? "Trail running shoes, men's size 10, under $180, from nike.com";
const draft = await call("POST", "/v1/intents", keys.shopper, { text });
console.log(`intent draft: HTTP ${draft.status}, complete=${draft.json?.complete}, ambiguities=${JSON.stringify(draft.json?.ambiguities?.map((a: { field: string }) => a.field))}, compiler=${JSON.stringify(draft.json?.compiler)}`);
console.log(`policy: ${JSON.stringify(draft.json?.policy)}`);
if (draft.status !== 201) process.exit(1);
// The shopper confirms; if the compiler left gaps, fill them explicitly (as the shopper page will).
const policy = draft.json.complete ? undefined : { ...draft.json.policy, retailers: draft.json.policy.retailers?.length ? draft.json.policy.retailers : ["nike.com"], max_total_cents: draft.json.policy.max_total_cents ?? 18000, currency: draft.json.policy.currency ?? "USD" };
const confirmed = await call("POST", `/v1/intents/${draft.json.id}/confirm`, keys.shopper, policy ? { policy } : undefined);
console.log(`confirm: HTTP ${confirmed.status} ${confirmed.json?.status ?? confirmed.json?.detail}`);
if (confirmed.status !== 200) process.exit(1);

const run = await runAgent({
  env: { witnessApi: BASE, agentKey: keys.agent, channel3Key: process.env.CHANNEL3_API_KEY },
  intentId: draft.json.id,
  apiKey: process.env.ANTHROPIC_API_KEY!,
  maxSpendUsd: Number(process.env.WITNESS_AGENT_MAX_SPEND_USD ?? 0.05),
});
console.log(`\nAGENT SAID:\n${run.text}\n`);
console.log(`agent: turns=${run.turns} usage=${JSON.stringify(run.usage)} estimated_cost_usd=${run.estimated_cost_usd} stopped_for_budget=${run.stopped_for_budget}`);

// What did Second Key actually do? (ops view of the purchases on this intent)
const ledger = await call("GET", `/v1/intents/${draft.json.id}`, keys.shopper);
void ledger;
await call("POST", `/v1/intents/${draft.json.id}/revoke`, keys.shopper);
console.log("intent revoked (any held authorization is being voided)");
