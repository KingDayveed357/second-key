// Integrated acceptance test (Deliverable 7) against a LOCAL Second Key API + worker on the PayPal
// SANDBOX. Every payment action goes through the shared Second Key engine: screening (deterministic +
// AI checks) → PayPal authorization → HOLD → one-time trusted-contact link → executor void/capture →
// independent PayPal GET → hash-chained audit. Never prints keys or tokens.
//
//   H. Human: disclosed synthetic call audio → offline transcription (live, this run) → manipulation
//      check over the transcript → HOLD → trusted contact denies → VOIDED, verified at PayPal.
//   B. Benign control: an agreed contractor invoice through the same path → no hold → CAPTURED.
//   A. AI agent: listing text tells the shopping agent to buy something else → same HOLD/link/void
//      path; and a checkout that swaps the item → the executor's three-way match voids it.
//
// The "transfer" is SIMULATED: the payer pays the platform's sandbox merchant (an authorization held
// by the platform); it is not a PayPal P2P payment. Windows only (System.Speech).
//   npx tsx secondkey/spikes/e2e/acceptance.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, loadDotEnv } from "@witness/config";
import { transferPolicy, transferRequest } from "@witness/engine";

const BASE = process.env.WITNESS_API ?? "http://127.0.0.1:4000";
const keys = JSON.parse(readFileSync(join(ROOT, process.env.WITNESS_KEYS_FILE ?? ".secondkey/dev-keys.json"), "utf8"));
const results: Record<string, unknown>[] = [];
const rec = (flow: string, name: string, pass: boolean, detail: Record<string, unknown> = {}) => {
  results.push({ flow, name, pass, ...detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${flow}] ${name} ${JSON.stringify(detail)}`);
};
async function call(method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}
const TERMINAL = ["HELD", "VOIDED", "CAPTURED", "REJECTED", "CAPTURE_DECLINED", "NEEDS_RECONCILE", "FAILED"];
async function until(id: string, ok: (s: string) => boolean, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const p = (await call("GET", `/v1/purchases/${id}`, keys.ops)).json;
    if (ok(p.state) || Date.now() > end) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const checkOf = async (p: any, id: string) => {
  const ev = (await call("GET", `/v1/purchases/${p.id}/evidence`, keys.ops)).json;
  const c = (ev.checks ?? []).find((x: any) => x.check_id === id);
  return c ? { result: c.result, detail: c.detail as string, kind: c.kind } : undefined;
};
const paypal = async (id: string) => (await call("GET", `/v1/purchases/${id}/paypal`, keys.ops)).json;

// Direct PayPal reads with this script's own sandbox token: independent of the Second Key API and DB.
loadDotEnv();
const PP = process.env.PAYPAL_BASE_URL!.replace(/\/$/, "");
if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(PP)) throw new Error("sandbox only");
let ppToken = "";
async function paypalDirect(path: string) {
  if (!ppToken) {
    const r = await fetch(`${PP}/v1/oauth2/token`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    ppToken = ((await r.json()) as { access_token: string }).access_token;
  }
  const r = await fetch(`${PP}${path}`, { headers: { authorization: `Bearer ${ppToken}` } });
  return { status: r.status, debug_id: r.headers.get("paypal-debug-id"), data: (await r.json()) as any };
}
const authorizationId = async (id: string) => (await call("GET", `/v1/purchases/${id}`, keys.ops)).json.paypal?.authorization_id as string;

async function denyAndVerify(flow: string, id: string) {
  const link = await call("POST", `/v1/purchases/${id}/hold-link`, keys.shopper);
  const view = await call("GET", `/v1/holds/${id}?t=${link.json.token}`);
  rec(flow, "trusted contact's view shows amount, item and the reasons (with quotes where present)", view.status === 200 && view.json.reasons?.length > 0, { amount: view.json.amount, items: view.json.items?.map((i: any) => i.name ?? i.title), reasons: view.json.reasons });
  const linkMin = Math.round((Date.parse(link.json.expires_at) - Date.now()) / 60_000);
  rec(flow, "reviewer link lasts ~30 min (ADR-0017), separate from the 72 h hold", linkMin >= 28 && linkMin <= 30 && Date.parse(view.json.auto_void_at) - Date.parse(link.json.expires_at) > 70 * 3600_000, { link_minutes: linkMin, auto_void_at: view.json.auto_void_at });
  const pp0 = await paypal(id);
  rec(flow, "while held: PayPal authorization CREATED, nothing captured (independent GET)", pp0.authorizations?.[0]?.status === "CREATED" && pp0.captures?.length === 0, { order: pp0.order?.status, auth: pp0.authorizations?.[0]?.status, captures: pp0.captures?.length });
  const t0 = Date.now();
  const d = await call("POST", `/v1/holds/${id}/deny`, undefined, { token: link.json.token });
  rec(flow, "trusted contact denies → response VOIDING (a decision, not yet a PayPal result)", d.status === 200 && d.json.state === "VOIDING", { state: d.json?.state });
  const p = await until(id, (s) => s === "VOIDED" || s === "NEEDS_RECONCILE");
  const pp = await paypal(id);
  const direct = await paypalDirect(`/v2/payments/authorizations/${await authorizationId(id)}`);
  rec(flow, "direct PayPal GET /v2/payments/authorizations/{id} (own token, not via Second Key): VOIDED", direct.status === 200 && direct.data?.status === "VOIDED", { status: direct.data?.status, amount: direct.data?.amount?.value, debug_id: direct.debug_id });
  rec(flow, "PayPal authorization VOIDED, $0 captured (independent GET)", p.state === "VOIDED" && pp.authorizations?.[0]?.status === "VOIDED" && pp.captures.length === 0, { authorization: pp.authorizations?.[0]?.id, status: pp.authorizations?.[0]?.status, seconds: Math.round((Date.now() - t0) / 1000) });
  const dup = await call("POST", `/v1/holds/${id}/deny`, undefined, { token: link.json.token });
  rec(flow, "retried deny returns the recorded decision (replayed), no second void", dup.status === 200 && dup.json?.replayed === true, { status: dup.status, replayed: dup.json?.replayed ?? null });
  rec(flow, "opposite decision on the spent link refused (409)", (await call("POST", `/v1/holds/${id}/approve`, undefined, { token: link.json.token })).status === 409);
  const chain = (await call("GET", `/v1/verify/purchases/${id}`)).json;
  rec(flow, "audit chain valid and records the decision and the void", chain.valid && chain.events.some((e: any) => e.event_type.includes("void")), { events: chain.events.map((e: any) => e.event_type) });
}

async function transferIntent() {
  const created = await call("POST", "/v1/intents", keys.shopper, { policy: transferPolicy(new Date()), source_text: "Send $1,800 to J. Morgan (simulated transfer, sandbox)." });
  if (created.status !== 201) throw new Error(`intent: HTTP ${created.status} ${created.json?.detail ?? ""}`);
  const confirmed = await call("POST", `/v1/intents/${created.json.id}/confirm`, keys.shopper, {});
  if (confirmed.status !== 200) throw new Error(`confirm: HTTP ${confirmed.status}`);
  return created.json.id as string;
}

// ---- H: human protection, from audio --------------------------------------------------------------
{
  const F = "human";
  const s0 = Date.now();
  const raw = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "secondkey", "spikes", "s3", "local-recognizer.ps1")], { encoding: "utf8" });
  const asr = JSON.parse(raw.replace(/^﻿/, "")) as { total_ms: number; segments: { text: string }[]; transcript: string };
  const segments = Array.isArray(asr.segments) ? asr.segments : [asr.segments];
  rec(F, "1. audio ingested and transcribed on-device (System.Speech, disclosed synthetic call)", segments.length > 0, { segments: segments.length, asr_ms: asr.total_ms, wall_ms: Date.now() - s0, transcript: asr.transcript });

  // Dictation does not separate speakers, so every line is attributed to the call, not a person.
  const conversation = {
    context: "Phone call on the payer's device, transcribed automatically (speakers not separated). The payer is about to send $1,800 to a new payee.",
    lines: segments.map((s) => ({ speaker: "Call audio (speaker not identified)", text: s.text })),
  };
  const intent = await transferIntent();
  const idem = `e2e-human-${randomBytes(6).toString("hex")}`;
  const sub = await call("POST", "/v1/purchases", keys.agent, transferRequest(intent, conversation), { "idempotency-key": idem });
  rec(F, "transfer request (kind=transfer, ADR-0016) submitted through the shared engine", sub.status === 202, { status: sub.status, purchase: sub.json?.id });
  const again = await call("POST", "/v1/purchases", keys.agent, transferRequest(intent, conversation), { "idempotency-key": idem });
  rec(F, "retry with the same Idempotency-Key replays the same payment (no second PayPal order)", again.status === 200 && again.json?.id === sub.json?.id, { status: again.status });
  const p = await until(sub.json.id, (s) => TERMINAL.includes(s));
  const m = await checkOf(p, "ai.manipulation");
  const quotes = [...(m?.detail ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  const grounded = quotes.filter((q) => conversation.lines.some((l) => l.text.toLowerCase().includes(q.toLowerCase())));
  rec(F, "2. evidence extracted: quotes in the check are verbatim from the transcript", quotes.length > 0 && grounded.length === quotes.length, { quotes, grounded: `${grounded.length}/${quotes.length}` });
  rec(F, "3. risk assessed → HOLD for trusted contact (check unknown, purchase HELD)", p.state === "HELD" && m?.result === "unknown" && /hold for trusted contact/.test(m.detail), { state: p.state, check: m });
  await denyAndVerify(F, p.id);
}

// ---- B: benign control through the same path --------------------------------------------------------
{
  const F = "benign";
  const r = await call("POST", "/v1/demo/scenarios/benign_transfer", keys.demo);
  const p = await until(r.json.purchase.id, (s) => TERMINAL.includes(s));
  const m = await checkOf(p, "ai.manipulation");
  rec(F, "agreed invoice: manipulation check passes, no hold", m?.result === "pass", { check: m });
  const pp = await paypal(p.id);
  // Proof is the authorization and capture records, not the order status (which says COMPLETED even uncaptured).
  const capId = pp.captures?.[0]?.id;
  const dc = capId ? await paypalDirect(`/v2/payments/captures/${capId}`) : null;
  const da = await paypalDirect(`/v2/payments/authorizations/${await authorizationId(p.id)}`);
  rec(F, "direct PayPal GETs (own token): authorization CAPTURED, capture COMPLETED 1800.00", da.data?.status === "CAPTURED" && dc?.data?.status === "COMPLETED" && dc?.data?.amount?.value === "1800.00", { authorization: da.data?.status, capture: dc?.data?.status, amount: dc?.data?.amount?.value, debug_ids: [da.debug_id, dc?.debug_id] });
  rec(F, "captured once for the confirmed amount: authorization CAPTURED + one capture COMPLETED $1,800 (independent GET)", p.state === "CAPTURED" && pp.authorizations?.[0]?.status === "CAPTURED" && pp.captures?.length === 1 && pp.captures[0].status === "COMPLETED" && pp.captures[0].amount?.value === "1800.00", { state: p.state, order_status_not_used_as_proof: pp.order?.status, authorization: pp.authorizations?.[0]?.status, captures: pp.captures?.map((c: any) => `${c.status} ${c.amount?.value}`) });
  // Then the payout to the recipient: its own record, followed until PayPal settles it, read directly.
  let po: any = null;
  for (let i = 0; i < 40; i++) {
    po = (await call("GET", `/v1/purchases/${p.id}/evidence`, keys.ops)).json.payout;
    if (po && !["SENDING", "UNKNOWN", "PENDING", "ONHOLD"].includes(po.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const directBatch = po?.batch_id ? await paypalDirect(`/v1/payments/payouts/${po.batch_id}`) : null;
  const item = directBatch?.data?.items?.[0];
  rec(F, "recipient payout: one batch for $1,800.00, item SUCCESS (direct PayPal GET /v1/payments/payouts/{id}); purchase stays CAPTURED", po?.status === "SUCCESS" && item?.transaction_status === "SUCCESS" && item?.payout_item?.amount?.value === "1800.00" && p.state === "CAPTURED", { stored: po?.status ?? null, paypal_item_status: item?.transaction_status ?? null, amount: item?.payout_item?.amount?.value ?? null, receiver: po?.receiver ?? null, batch_id: po?.batch_id ?? null, debug_id: directBatch?.debug_id ?? null });
}

// ---- A: AI agent, same engine ---------------------------------------------------------------------
{
  const F = "agent";
  const r = await call("POST", "/v1/demo/scenarios/injection", keys.demo);
  const p = await until(r.json.purchase.id, (s) => TERMINAL.includes(s));
  const inj = await checkOf(p, "ai.injection");
  rec(F, "instruction embedded in listing text → ai.injection unknown → HELD (same screen → HOLD rule)", p.state === "HELD" && inj?.result === "unknown", { state: p.state, check: inj });
  await denyAndVerify(F, p.id);
  const s = await call("POST", "/v1/demo/scenarios/cart_swap", keys.demo);
  const q = await until(s.json.purchase.id, (x) => ["VOIDED", "CAPTURED", "NEEDS_RECONCILE"].includes(x));
  const pq = await paypal(q.id);
  rec(F, "checkout swaps the item → three-way match fails → executor voids, never captures", q.state === "VOIDED" && pq.authorizations?.[0]?.status === "VOIDED" && pq.captures.length === 0, { state: q.state, auth: pq.authorizations?.[0]?.status });
}

mkdirSync(join(ROOT, "secondkey", "reports"), { recursive: true });
writeFileSync(join(ROOT, "secondkey", "reports", "e2e-acceptance.json"), JSON.stringify({ ran_at: new Date().toISOString(), api: BASE, environment: "local API + worker, PayPal SANDBOX, simulated transfer (platform-held authorization)", results }, null, 2) + "\n");
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `${failed} FAILED` : "all acceptance checks passed");
