// Stage 3 acceptance against the REAL PayPal sandbox, through the public Second Key API.
// Requires the API + worker running (pnpm api / pnpm worker) and .secondkey/dev-keys.json from seed.
// Every scenario asserts PayPal's own final state (GET via /v1/purchases/:id/paypal), not Second Key's.
// Writes docs/evidence/stage3-sandbox-run.md. Never prints API keys.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@witness/config";

const BASE = process.env.WITNESS_API ?? "https://witness-api-kee6.onrender.com";
const keys = JSON.parse(readFileSync(process.env.WITNESS_KEYS_FILE ?? join(ROOT, ".secondkey", "dev-keys.json"), "utf8"));
const TERMINAL = new Set(["REJECTED", "AUTH_FAILED", "CAPTURED", "VOIDED", "CAPTURE_DECLINED", "HELD"]);

async function call(method: string, path: string, key: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function settle(id: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const p = (await call("GET", `/v1/purchases/${id}`, keys.ops)).json;
    if (TERMINAL.has(p.state) || Date.now() > end) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const paypalState = async (id: string) => (await call("GET", `/v1/purchases/${id}/paypal`, keys.ops)).json;
const evidence = async (id: string) => (await call("GET", `/v1/purchases/${id}/evidence`, keys.ops)).json;

interface Row {
  id: string;
  scenario: string;
  expected: string;
  witness_state: string;
  paypal: string;
  pass: boolean;
  ids: string;
  note: string;
}
const rows: Row[] = [];

function record(id: string, scenario: string, expected: string, p: any, pp: any, pass: boolean, note = "") {
  const auth = pp?.authorizations?.[0];
  const cap = pp?.captures?.[0];
  const ppText = !pp?.order ? "no order exists" : `order ${pp.order.status}; auth ${auth?.status ?? "-"}; captures ${pp.captures.length ? pp.captures.map((c: any) => `${c.status} ${c.amount.value}`).join(", ") : "none"}`;
  rows.push({ id, scenario, expected, witness_state: p.state, paypal: ppText, pass, ids: [pp?.order?.id, auth?.id, cap?.id].filter(Boolean).join(" / ") || "-", note });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${scenario}: Second Key ${p.state}; PayPal ${ppText}`);
}

async function scenario(name: string) {
  const r = await call("POST", `/v1/demo/scenarios/${name}`, keys.demo);
  if (r.status !== 202) throw new Error(`${name}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return { purchase: await settle(r.json.purchase.id), intentId: r.json.intent_id as string };
}

// S1 clean purchase
{
  const { purchase: p } = await scenario("normal");
  const pp = await paypalState(p.id);
  const ok = p.state === "CAPTURED" && pp.captures.length === 1 && pp.captures[0].status === "COMPLETED" && pp.captures[0].amount.value === "84.00" && pp.authorizations[0].status === "CAPTURED";
  record("S1", "Clean purchase", "CAPTURED; one 84.00 capture", p, pp, ok);
}

// S2 violation: never reaches PayPal
{
  const { purchase: p } = await scenario("reject");
  const pp = await paypalState(p.id);
  const ev = await evidence(p.id);
  record("S2", "Excluded colour", "REJECTED; no PayPal order", p, pp, p.state === "REJECTED" && pp.order === null && ev.paypal_calls.length === 0, p.reasons.join("; "));
}

// S5 cart swap
{
  const { purchase: p } = await scenario("cart_swap");
  const pp = await paypalState(p.id);
  const ok = p.state === "VOIDED" && pp.authorizations[0].status === "VOIDED" && pp.captures.length === 0 && pp.order.items[0].sku === "TRL-WHT-10";
  record("S5", "Cart swap (faulty checkout adapter)", "VOIDED; $0 captured", p, pp, ok, p.reasons.join("; "));
}

// S7 idempotency through /v1/purchases
{
  const c = await call("POST", "/v1/intents", keys.shopper, {
    source_text: "Trail-running shoes, size 10, under $90, not white, from REI or Backcountry.",
    policy: {
      version: 1,
      category: "trail-running shoes",
      retailers: ["rei.com", "backcountry.com"],
      max_total_cents: 9000,
      currency: "USD",
      quantity: 1,
      hard: { excluded_colors: ["white"], size: "10" },
      substitution: "same_category_under_max",
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
  });
  await call("POST", `/v1/intents/${c.json.id}/confirm`, keys.shopper);
  const key = `s7-${Date.now()}`;
  const body = { intent_id: c.json.id, retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] };
  const first = await call("POST", "/v1/purchases", keys.agent, body, { "idempotency-key": key });
  const second = await call("POST", "/v1/purchases", keys.agent, body, { "idempotency-key": key });
  const conflict = await call("POST", "/v1/purchases", keys.agent, { ...body, lines: [{ product_id: "TRL-BLK-10", quantity: 1 }] }, { "idempotency-key": key });
  const p = await settle(first.json.id);
  const ev = await evidence(p.id);
  const pp = await paypalState(p.id);
  const creates = ev.paypal_calls.filter((x: any) => x.op === "create-order").length;
  const ok = first.status === 202 && second.status === 200 && second.json.id === first.json.id && conflict.status === 422 && creates === 1 && p.state === "CAPTURED";
  record("S7", "Idempotency-Key replay", "same purchase, one order; different body 422", p, pp, ok, `HTTP ${first.status}, ${second.status}, ${conflict.status}; create-order calls: ${creates}`);
}

// HOLD scenarios: funds genuinely authorized while held; then the shopper revokes -> void (cleanup).
// "suspicious" (overpriced vs market) and "injection" (AI classifier) exercise the AI path.
for (const [id, name, title] of [
  ["HOLD", "hold", "Missing size -> HOLD (funds held), shopper revokes"],
  ["SUSPICIOUS", "overpriced", "Nearly 2x market price -> HOLD, shopper revokes"],
  ["INJECTION", "injection", "Listing text addresses AI agents -> HOLD, shopper revokes"],
] as const) {
  const { purchase: p, intentId } = await scenario(name);
  const held = await paypalState(p.id);
  const heldOk = p.state === "HELD" && held.authorizations?.[0]?.status === "CREATED" && held.captures?.length === 0;
  await call("POST", `/v1/intents/${intentId}/revoke`, keys.shopper);
  const after = await settle(p.id);
  const pp = await paypalState(p.id);
  record(id, title, "HELD with auth CREATED, then VOIDED", after, pp, heldOk && after.state === "VOIDED" && pp.authorizations?.[0]?.status === "VOIDED", `while held: ${p.state}, auth ${held.authorizations?.[0]?.status ?? "-"}; reasons: ${p.reasons.join("; ").slice(0, 200)}`);
}

// Webhooks: PayPal delivers asynchronously, so give it a moment, then report what arrived.
await new Promise((r) => setTimeout(r, Number(process.env.WEBHOOK_WAIT_MS ?? 20_000)));
const wh = (await call("GET", "/v1/console/webhooks", keys.ops)).json;
const verifiedEvents = (wh?.events ?? []).filter((e: any) => e.verified);
const webhookLine = !wh?.configured
  ? "Webhooks: not configured on this API (PAYPAL_WEBHOOK_ID unset)."
  : `Webhooks: ${verifiedEvents.length} verified event(s) received (${[...new Set(verifiedEvents.map((e: any) => e.event_type))].join(", ") || "none yet"}); ${(wh.events ?? []).length - verifiedEvents.length} rejected.`;
console.log(webhookLine);

const chain = (await call("GET", "/v1/verify/chain", keys.ops)).json;
console.log(`audit chain: ${chain.valid ? "valid" : "INVALID"} (${chain.count} events, head ${chain.head_hash.slice(0, 23)}...)`);

const md = [
  "# Stage 3: sandbox acceptance run",
  "",
  `Run: ${new Date().toISOString()} · API ${BASE} · real PayPal sandbox (api-m.sandbox.paypal.com) · generated by \`scripts/sandbox-acceptance.ts\``,
  "",
  "Each row's PayPal column is PayPal's own state, fetched live after the run (`GET /v2/checkout/orders/{id}` via `/v1/purchases/:id/paypal`).",
  "",
  "| # | Scenario | Expected | Second Key | PayPal (live GET) | Order / Auth / Capture | Result | Notes |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.scenario} | ${r.expected} | ${r.witness_state} | ${r.paypal} | ${r.ids} | ${r.pass ? "**PASS**" : "**FAIL**"} | ${r.note.replace(/\|/g, "/")} |`),
  "",
  webhookLine,
  "",
  `Audit chain after the run: **${chain.valid ? "valid" : "INVALID"}**, ${chain.count} events, head \`${chain.head_hash}\`.`,
  "",
];
mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
writeFileSync(join(ROOT, "docs", "evidence", process.env.EVIDENCE_FILE ?? "stage3-sandbox-run.md"), md.join("\n"));
const failed = rows.filter((r) => !r.pass).length;
console.log(failed ? `${failed} FAILED` : "all scenarios passed");
process.exit(failed ? 1 : 0);
