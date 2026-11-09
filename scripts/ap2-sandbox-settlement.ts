// AP2 settlement on the real PayPal sandbox: verification -> POST /v2/settlements -> executor ->
// receipts, with PayPal's own state read back live after every scenario. Writes
// docs/evidence/ap2-settlement-sandbox-run.md.
//
//   pnpm db:dev                                   # another terminal
//   pnpm tsx scripts/ap2-sandbox-settlement.ts
//
// Needs in .env: DATABASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox app), PAYPAL_MERCHANT_ID
// (that app's sandbox merchant id) and WITNESS_DEMO_VAULT_ID (a vaulted sandbox buyer; or
// spikes/out/vault.json from spike 03). One process plays API and worker here; in production the
// executor runs only in the worker. The PayPal host is pinned to the sandbox by the transport.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureCatalog } from "@witness/catalog";
import { ROOT, loadDotEnv } from "@witness/config";
import { newId, standardAdapter, swapAdapter, type ResolvedCart } from "@witness/core";
import { QUEUES, createApiKey, createBoss, createPool, ensureQueues, migrate, type QueueName } from "@witness/db";
import { handleJob, createMoneyMovementClient, type ExecutorDeps } from "@witness/executor";
import { PayPalClient } from "@witness/paypal";
import { closedMandateReference, loadReceiptSigner, validateSchema, verifyReceipt } from "@witness/ap2";
import { buildApp } from "../apps/api/src/app.ts";
import { checkoutFor, NOW, openPaymentWith, payFor, world } from "../packages/ap2/test/fixtures.ts";

loadDotEnv();
const env = process.env;
const vaultFile = join(ROOT, "spikes", "out", "vault.json");
const vaultId = env.WITNESS_DEMO_VAULT_ID ?? (existsSync(vaultFile) ? (JSON.parse(readFileSync(vaultFile, "utf8")) as { vaultId?: string }).vaultId : undefined);
const missing = ["DATABASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MERCHANT_ID"].filter((k) => !env[k]?.trim());
if (!vaultId) missing.push("WITNESS_DEMO_VAULT_ID (or spikes/out/vault.json)");
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(2);
}

const baseUrl = env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
const creds = { baseUrl, clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET! };
const pool = createPool(env.DATABASE_URL!);
await migrate(pool);
const boss = createBoss(env.DATABASE_URL!, "api");
boss.on("error", (e) => console.error("pg-boss:", e.message));
await boss.start();
await ensureQueues(boss);

// The mandates are dated by the shared fixtures' clock; settlement windows use the same clock.
const clock = () => new Date(NOW * 1000);
const tenantId = newId("ten");
await pool.query("INSERT INTO tenants (id, name, paypal_merchant_id) VALUES ($1, 'AP2 sandbox run', $2)", [tenantId, env.PAYPAL_MERCHANT_ID]);
const key = (await createApiKey(pool, tenantId, "merchant:ap2-sandbox", ["ap2:verify"])).key;
const d: ExecutorDeps = {
  pool,
  boss,
  paypal: new PayPalClient({ ...creds, role: "api" }),
  money: createMoneyMovementClient(creds),
  catalog: new FixtureCatalog(),
  receipts: await loadReceiptSigner("https://witness-api.onrender.com"),
  now: clock,
};
const app = buildApp({ deps: d });
await app.ready();
const w = await world();

let seq = 0;
const post = async (url: string, payload: unknown, idem = `sandbox-${Date.now()}-${++seq}`) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}`, "idempotency-key": idem }, payload: payload as Record<string, unknown> });
const get = async (url: string) => (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } })).json();
const trust = { issuers: { keys: [{ ...w.issuer.jwk, kid: "issuer-1" }] }, merchants: { keys: [{ ...w.merchant.jwk, kid: "merchant-1" }] } };
const jwks = (await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json();

async function drain() {
  for (let round = 0; round < 10; round++) {
    let any = false;
    for (const q of [QUEUES.ap2Capture, QUEUES.ap2Void] as QueueName[]) {
      for (const j of await boss.fetch<object>(q, { batchSize: 10 })) {
        any = true;
        console.log(`  ${q}: ${await handleJob(d, q, j.data)}`);
        await boss.complete(q, j.id);
      }
    }
    if (!any) return;
  }
}

async function conforming(price: number) {
  const c = await checkoutFor(w, { price });
  const open = await openPaymentWith(w, c.open, [{ type: "payment.amount_range", currency: "USD", max: 100000 }]);
  const pay = await payFor(w, open, c);
  const v = (await post("/v2/verifications", { checkout: { mandate: c.chain, aud: "merchant", nonce: "n-checkout" }, payment: { mandate: pay, aud: "credential-provider", nonce: "n-payment" }, trust })).json();
  if (v.decision !== "CONFORMS") throw new Error(`verification did not conform: ${JSON.stringify(v.findings)}`);
  return { v, checkout: c.chain, payment: pay };
}

/** A vaulted AUTHORIZE order on the sandbox, built by the same adapters the purchase path uses. */
async function sandboxOrder(lines: { sku: string; quantity: number; unit_cents: number }[], swap = false) {
  const cart = { currency: "USD", lines: lines.map((l) => ({ product_id: l.sku, name: `AP2 sandbox ${l.sku}`, quantity: l.quantity, unit_cents: l.unit_cents })) } as unknown as ResolvedCart;
  const adapter = swap ? swapAdapter({ sku: "TRL-WHT-10", name: "Ridgeline Trail Runner, Cloud White, US 10" }) : standardAdapter;
  const ref = newId("ap2");
  const r = await d.paypal.createOrder(adapter.buildOrder(cart, { purchaseId: ref, policyDigest: "sha256:ap2-sandbox", vaultId: vaultId! }), crypto.randomUUID());
  if (!r.ok) throw new Error(`create-order failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.id as string;
}

async function live(orderId: string) {
  const o = (await d.paypal.getOrder(orderId)).data;
  const pu = o.purchase_units?.[0] ?? {};
  const auth = pu.payments?.authorizations?.[0];
  const caps = (pu.payments?.captures ?? []).map((c: { status: string; amount: { value: string } }) => `${c.status} ${c.amount.value}`);
  return { text: `order ${o.status}; auth ${auth?.status ?? "none"}; captures ${caps.length ? caps.join(", ") : "none"}`, auth: auth?.status as string | undefined, captures: caps as string[] };
}

type Row = { id: string; name: string; expected: string; got: string; paypal: string; ids: string; pass: boolean; notes: string };
const rows: Row[] = [];

async function scenario(id: string, name: string, expected: string, run: () => Promise<Omit<Row, "id" | "name" | "expected">>) {
  console.log(`${id} ${name}`);
  try {
    rows.push({ id, name, expected, ...(await run()) });
  } catch (e) {
    rows.push({ id, name, expected, got: "error", paypal: "-", ids: "-", pass: false, notes: (e as Error).message.slice(0, 300) });
  }
  console.log(`  -> ${rows.at(-1)!.pass ? "PASS" : "FAIL"} ${rows.at(-1)!.notes}`);
}

let networkReference = "not observed";

await scenario("A1", "Order holds exactly the verified checkout", "CAPTURED; one 199.00 capture; receipts verify", async () => {
  const { v, checkout, payment } = await conforming(19900);
  const orderId = await sandboxOrder([{ sku: "sku_gold_9", quantity: 1, unit_cents: 19900 }]);
  const bound = (await post("/v2/settlements", { verification_id: v.verification_id, psp: "paypal", order_id: orderId })).json();
  await drain();
  const s = await get(`/v2/settlements/${bound.settlement_id}`);
  const p = await live(orderId);
  const call = (await pool.query("SELECT response FROM ap2_settlement_calls WHERE settlement_id = $1 AND op = 'capture' AND status = 'SUCCEEDED'", [s.settlement_id])).rows[0];
  networkReference = call?.response?.network_transaction_reference?.id ? `present (${call.response.network_transaction_reference.network ?? "network"})` : "absent in PayPal's capture response";
  const cr = s.receipts ? await verifyReceipt(s.receipts.checkout, jwks) : null;
  const pr = s.receipts ? await verifyReceipt(s.receipts.payment, jwks) : null;
  const receiptsOk =
    !!cr && !!pr && cr.order_id === orderId && pr.psp_confirmation_id === s.capture_id && cr.reference === closedMandateReference(checkout) && pr.reference === closedMandateReference(payment) && !validateSchema("checkout_receipt", cr).length && !validateSchema("payment_receipt", pr).length;
  return {
    got: s.state,
    paypal: p.text,
    ids: `${orderId} / ${s.authorization_id} / ${s.capture_id ?? "-"}`,
    pass: s.state === "CAPTURED" && p.captures.length === 1 && p.captures[0] === "COMPLETED 199.00" && receiptsOk,
    notes: `receipts ${receiptsOk ? "verify with the JWKS and match the schemas" : "DID NOT verify"}; network reference ${networkReference}`,
  };
});

await scenario("A2", "Cart swap: another product at the same price", "VOIDED; $0 captured", async () => {
  const { v } = await conforming(19900);
  const orderId = await sandboxOrder([{ sku: "sku_gold_9", quantity: 1, unit_cents: 19900 }], true);
  const bound = (await post("/v2/settlements", { verification_id: v.verification_id, psp: "paypal", order_id: orderId })).json();
  await drain();
  const s = await get(`/v2/settlements/${bound.settlement_id}`);
  const p = await live(orderId);
  const err = s.receipts ? await verifyReceipt(s.receipts.payment, jwks) : null;
  return { got: s.state, paypal: p.text, ids: `${orderId} / ${s.authorization_id}`, pass: s.state === "VOIDED" && p.auth === "VOIDED" && !p.captures.length && err?.status === "Error", notes: s.diffs.join("; ") };
});

await scenario("A3", "Order for twice the verified quantity", "VOIDED; $0 captured", async () => {
  const { v } = await conforming(19900);
  const orderId = await sandboxOrder([{ sku: "sku_gold_9", quantity: 2, unit_cents: 19900 }]);
  const bound = (await post("/v2/settlements", { verification_id: v.verification_id, psp: "paypal", order_id: orderId })).json();
  await drain();
  const s = await get(`/v2/settlements/${bound.settlement_id}`);
  const p = await live(orderId);
  return { got: s.state, paypal: p.text, ids: `${orderId} / ${s.authorization_id}`, pass: s.state === "VOIDED" && p.auth === "VOIDED" && !p.captures.length, notes: s.diffs.join("; ") };
});

await scenario("A4", "Idempotency-Key replay; second order for the same verification", "same settlement (200); 409; one capture", async () => {
  const { v } = await conforming(19900);
  const orderId = await sandboxOrder([{ sku: "sku_gold_9", quantity: 1, unit_cents: 19900 }]);
  const body = { verification_id: v.verification_id, psp: "paypal", order_id: orderId };
  const idem = `replay-${Date.now()}`;
  const first = await post("/v2/settlements", body, idem);
  const replay = await post("/v2/settlements", body, idem);
  const refusedOrder = await sandboxOrder([{ sku: "sku_gold_9", quantity: 1, unit_cents: 19900 }]);
  const second = await post("/v2/settlements", { ...body, order_id: refusedOrder });
  await drain();
  // The refused order was never bound, so nothing in Second Key will void it: release its hold here.
  const refusedAuth = (await d.paypal.getOrder(refusedOrder)).data.purchase_units?.[0]?.payments?.authorizations?.[0]?.id as string | undefined;
  if (refusedAuth) await d.money.voidAuthorization(refusedAuth, crypto.randomUUID());
  const refused = await live(refusedOrder);
  const s = await get(`/v2/settlements/${first.json().settlement_id}`);
  const p = await live(orderId);
  const pass = first.statusCode === 202 && replay.statusCode === 200 && replay.json().settlement_id === s.settlement_id && second.statusCode === 409 && s.state === "CAPTURED" && p.captures.length === 1 && refused.auth === "VOIDED";
  return { got: s.state, paypal: p.text, ids: `${orderId} / ${s.authorization_id} / ${s.capture_id ?? "-"}`, pass, notes: `HTTP ${first.statusCode}, ${replay.statusCode}, ${second.statusCode}; refused order ${refusedOrder}: ${refused.text}` };
});

const chain = (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE event_type LIKE 'ap2.%'")).rows[0].n as number;
const at = new Date().toISOString();
const md = `# AP2 settlement: sandbox run

Run: ${at} · real PayPal sandbox (${new URL(baseUrl).host}) · generated by \`scripts/ap2-sandbox-settlement.ts\` · one process playing API and worker

Each row's PayPal column is PayPal's own state, read live after the scenario (\`GET /v2/checkout/orders/{id}\`). Mandates are built
by \`@witness/ap2\` with test keys; the PayPal orders are vaulted AUTHORIZE orders built by the purchase path's own adapters.

| # | Scenario | Expected | Second Key | PayPal (live GET) | Order / Auth / Capture | Result | Notes |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.name} | ${r.expected} | ${r.got} | ${r.paypal} | ${r.ids} | **${r.pass ? "PASS" : "FAIL"}** | ${r.notes.replace(/\|/g, "\\|")} |`).join("\n")}

PayPal network transaction reference on the capture: ${networkReference}. ${networkReference.startsWith("absent") ? "The Payment Receipt's required `network_confirmation_id` therefore reads `not_provided_by_psp`." : ""}

AP2 audit events written during the run: ${chain}.
`;
writeFileSync(join(ROOT, "docs", "evidence", "ap2-settlement-sandbox-run.md"), md);
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed -> docs/evidence/ap2-settlement-sandbox-run.md`);

await app.close();
await boss.stop({ graceful: false, close: true }).catch(() => {});
await pool.end();
process.exit(rows.every((r) => r.pass) ? 0 : 1);
