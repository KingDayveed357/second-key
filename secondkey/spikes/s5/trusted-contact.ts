// S5 live test of the trusted-contact (one-time hold link) flow against a LOCAL Second Key API + worker
// on the PayPal SANDBOX. Exercises: auth failures, link re-issue, concurrent conflicting decisions,
// replay, independent PayPal verification and the audit trail. Never prints keys or tokens.
//   npx tsx secondkey/spikes/s5/trusted-contact.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@witness/config";

const BASE = process.env.WITNESS_API ?? "http://127.0.0.1:4000";
const keys = JSON.parse(readFileSync(join(ROOT, ".secondkey", "dev-keys.json"), "utf8"));
const results: Record<string, unknown>[] = [];
const rec = (name: string, pass: boolean, detail: Record<string, unknown> = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
async function call(method: string, path: string, key?: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}
async function until(id: string, ok: (s: string) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const p = (await call("GET", `/v1/purchases/${id}`, keys.ops)).json;
    if (ok(p.state) || Date.now() > end) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function heldPurchase() {
  const r = await call("POST", "/v1/demo/scenarios/hold", keys.demo);
  if (r.status !== 202) throw new Error(`scenario: HTTP ${r.status}`);
  const p = await until(r.json.purchase.id, (s) => s === "HELD");
  if (p.state !== "HELD") throw new Error(`expected HELD, got ${p.state}`);
  return p.id as string;
}

// ---- run 1: access control, re-issue, concurrent decisions, replay -------------------------------
{
  const id = await heldPurchase();
  rec("held purchase with a live authorization", true, { purchase: id });
  const pp0 = (await call("GET", `/v1/purchases/${id}/paypal`, keys.ops)).json;
  rec("PayPal shows authorization CREATED and no capture while held", pp0.authorizations?.[0]?.status === "CREATED" && pp0.captures?.length === 0, { auth: pp0.authorizations?.[0]?.status, captures: pp0.captures?.length });

  rec("no token → 401", (await call("GET", `/v1/holds/${id}`)).status === 401);
  rec("any token before a link was issued → 410", (await call("GET", `/v1/holds/${id}?t=${"x".repeat(32)}`)).status === 410);
  rec("agent key cannot issue a hold link", (await call("POST", `/v1/purchases/${id}/hold-link`, keys.agent)).status === 403);

  const l1 = (await call("POST", `/v1/purchases/${id}/hold-link`, keys.shopper)).json;
  const l2 = (await call("POST", `/v1/purchases/${id}/hold-link`, keys.shopper)).json;
  rec("token is long and random (≥ 32 base64url chars)", typeof l2.token === "string" && l2.token.length >= 32, { length: l2.token?.length, expires_at: l2.expires_at });
  rec("wrong token once a link exists → 403", (await call("GET", `/v1/holds/${id}?t=${"x".repeat(32)}`)).status === 403);
  rec("re-issuing a link invalidates the previous one", (await call("GET", `/v1/holds/${id}?t=${l1.token}`)).status === 403);
  const view = await call("GET", `/v1/holds/${id}?t=${l2.token}`);
  rec("reviewer view shows amount, items, reasons and auto-void time", view.status === 200 && !!view.json.amount && view.json.items?.length > 0 && view.json.reasons?.length > 0 && !!view.json.auto_void_at, { amount: view.json.amount, reasons: view.json.reasons });
  const linkTtlHours = (Date.parse(l2.expires_at) - Date.now()) / 3600_000;
  rec("link expiry (finding: equals auto-void time)", true, { link_valid_for_hours: Math.round(linkTtlHours) });

  const [a, d] = await Promise.all([call("POST", `/v1/holds/${id}/approve`, undefined, { token: l2.token }), call("POST", `/v1/holds/${id}/deny`, undefined, { token: l2.token })]);
  const outcomes = [a.json?.state, d.json?.state];
  rec("concurrent approve + deny: exactly one 200, the other refused (409/410)", [a.status, d.status].filter((x) => x === 200).length === 1 && [a.status, d.status].some((x) => x === 409 || x === 410), { approve: { status: a.status, state: a.json?.state ?? a.json?.title }, deny: { status: d.status, state: d.json?.state ?? d.json?.title } });
  const decisions = await until(id, (s) => ["VOIDED", "CAPTURED", "CAPTURE_DECLINED", "NEEDS_RECONCILE"].includes(s), 90_000);
  const pp1 = (await call("GET", `/v1/purchases/${id}/paypal`, keys.ops)).json;
  const authS = pp1.authorizations?.[0]?.status;
  const consistent = (decisions.state === "VOIDED" && authS === "VOIDED" && pp1.captures.length === 0) || (decisions.state === "CAPTURED" && pp1.captures.length === 1 && pp1.captures[0].status === "COMPLETED");
  rec("final Second Key state matches PayPal's own record", consistent, { witness: decisions.state, paypal_auth: authS, paypal_captures: pp1.captures.map((c: any) => `${c.status} ${c.amount?.value}`) });
  rec("replayed token after the decision → refused", [403, 409, 410].includes((await call("POST", `/v1/holds/${id}/approve`, undefined, { token: l2.token })).status));
  const chain = (await call("GET", `/v1/verify/purchases/${id}`)).json;
  rec("audit chain valid and records the decision", chain.valid && chain.events.some((e: any) => /void_decided|approved|capture/.test(e.event_type)), { events: chain.events.map((e: any) => e.event_type) });
}

// ---- run 2: clean deny (the demo path) ----------------------------------------------------------
{
  const id = await heldPurchase();
  const l = (await call("POST", `/v1/purchases/${id}/hold-link`, keys.shopper)).json;
  const t0 = Date.now();
  const d = await call("POST", `/v1/holds/${id}/deny`, undefined, { token: l.token });
  rec("deny accepted; response says VOIDING, not VOIDED (decision ≠ completed PayPal action)", d.status === 200 && d.json.state === "VOIDING", { state: d.json?.state });
  const p = await until(id, (s) => s === "VOIDED");
  const pp = (await call("GET", `/v1/purchases/${id}/paypal`, keys.ops)).json;
  rec("deny → PayPal authorization VOIDED, $0 captured (independent GET)", p.state === "VOIDED" && pp.authorizations?.[0]?.status === "VOIDED" && pp.captures.length === 0, { auth: pp.authorizations?.[0]?.id, status: pp.authorizations?.[0]?.status, seconds_to_voided: Math.round((Date.now() - t0) / 1000) });
}

mkdirSync(join(ROOT, "secondkey", "reports"), { recursive: true });
writeFileSync(join(ROOT, "secondkey", "reports", "s5-trusted-contact.json"), JSON.stringify({ ran_at: new Date().toISOString(), api: BASE, environment: "local API + worker, PayPal SANDBOX", results }, null, 2) + "\n");
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `${failed} FAILED` : "all S5 checks passed");
