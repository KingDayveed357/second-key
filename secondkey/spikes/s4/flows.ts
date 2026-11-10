// Milestone B: which supported PayPal sandbox flows can pay the intended RECIPIENT while Second Key
// holds the decision? SANDBOX ONLY (refuses any other host). Never prints credentials or tokens.
//
//   F1 partner referrals: is this REST app enabled as a PayPal partner (needed for multiparty)?
//   F2 AUTHORIZE with disbursement_mode DELAYED (platform's own merchant as payee)
//   F3 AUTHORIZE with a third-party payee = the recipient's personal sandbox account → void; capture
//   F4 F3 with disbursement_mode DELAYED
//   F5 Payouts to the recipient, followed until the item settles
//   F6 PayPal-Auth-Assertion for a non-consenting account (acting on someone else's behalf)
//
// Recipient: SK_RECIPIENT_EMAIL (a personal sandbox account; an email, not a secret). F3/F4 are
// skipped without it. Payer: the vaulted sandbox buyer from the local DB.
//   SK_RECIPIENT_EMAIL=... npx tsx secondkey/spikes/s4/flows.ts

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { ROOT, loadDotEnv } from "@witness/config";

loadDotEnv();
const BASE = process.env.PAYPAL_BASE_URL!;
if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com\/?$/.test(BASE)) throw new Error("sandbox only");
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID!;
const recipient = process.env.SK_RECIPIENT_EMAIL ?? null;

const db = new pg.Client({ connectionString: process.env.SK_DATABASE_URL ?? "postgres://witness:witness-dev-only@127.0.0.1:54330/witness" });
await db.connect();
const keys = JSON.parse(readFileSync(join(ROOT, ".secondkey", "dev-keys.json"), "utf8"));
const vaultId = (await db.query("select vault_id from shoppers where id = $1", [keys.demo_shopper_id])).rows[0].vault_id as string;
await db.end();

let token = "";
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  if (!token) {
    const r = await fetch(`${BASE.replace(/\/$/, "")}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    token = ((await r.json()) as { access_token: string }).access_token;
  }
  const r = await fetch(`${BASE.replace(/\/$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "paypal-request-id": randomUUID(), prefer: "return=representation", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: r.status, debug_id: r.headers.get("paypal-debug-id"), data };
}

const steps: Record<string, unknown>[] = [];
const issue = (d: any) => d?.details?.[0]?.issue ?? d?.name ?? d?.error ?? null;
function log(step: string, r: { status: number; debug_id: string | null; data: any }, extra: Record<string, unknown> = {}) {
  const row = { step, http: r.status, debug_id: r.debug_id, issue: r.status >= 400 ? issue(r.data) : null, message: r.status >= 400 ? String(r.data?.message ?? r.data?.error_description ?? "").slice(0, 200) : null, ...extra };
  steps.push(row);
  console.log(JSON.stringify(row));
}
const order = (amount: string, pu: Record<string, unknown> = {}) => ({
  intent: "AUTHORIZE",
  purchase_units: [{ reference_id: `sk-${randomUUID().slice(0, 8)}`, description: "Second Key flow probe (SANDBOX)", amount: { currency_code: "USD", value: amount }, ...pu }],
  payment_source: { paypal: { vault_id: vaultId } },
});
const authOf = (o: any) => o?.purchase_units?.[0]?.payments?.authorizations?.[0];
const payeeOf = (o: any) => o?.purchase_units?.[0]?.payee ?? null;

// F1 ---------------------------------------------------------------------------------------------
{
  const r = await call("POST", "/v2/customer/partner-referrals", {
    tracking_id: `sk-${randomUUID().slice(0, 12)}`,
    operations: [{ operation: "API_INTEGRATION", api_integration_preference: { rest_api_integration: { integration_method: "PAYPAL", integration_type: "THIRD_PARTY", third_party_details: { features: ["PAYMENT", "REFUND", "DELAY_FUNDS_DISBURSEMENT"] } } } }],
    products: ["EXPRESS_CHECKOUT"],
    legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
  });
  log("F1.partner_referral_with_delay_disbursement", r, { onboarding_link_returned: Boolean(r.data?.links?.some((l: any) => l.rel === "action_url")) });
}

// F2 ---------------------------------------------------------------------------------------------
let f2Order: any = null;
{
  const r = await call("POST", "/v2/checkout/orders", order("10.00", { payment_instruction: { disbursement_mode: "DELAYED" } }));
  f2Order = r.data;
  log("F2.authorize_delayed_disbursement_own_merchant", r, { order_status: r.data?.status ?? null, auth_status: authOf(r.data)?.status ?? null });
  const a = authOf(r.data);
  if (a) log("F2.void", await call("POST", `/v2/payments/authorizations/${a.id}/void`));
}

// F3/F4 ------------------------------------------------------------------------------------------
for (const delayed of [false, true]) {
  const tag = delayed ? "F4" : "F3";
  if (!recipient) {
    steps.push({ step: `${tag}.skipped`, reason: "SK_RECIPIENT_EMAIL not set" });
    continue;
  }
  const pu = { payee: { email_address: recipient }, ...(delayed ? { payment_instruction: { disbursement_mode: "DELAYED" } } : {}) };
  // hold then deny
  const r1 = await call("POST", "/v2/checkout/orders", order("20.00", pu));
  const a1 = authOf(r1.data);
  log(`${tag}.authorize_to_recipient`, r1, { order_status: r1.data?.status ?? null, auth_status: a1?.status ?? null, payee_merchant_id_set: Boolean(payeeOf(r1.data)?.merchant_id) });
  if (a1) {
    log(`${tag}.get_authorization`, await call("GET", `/v2/payments/authorizations/${a1.id}`), {});
    const v = await call("POST", `/v2/payments/authorizations/${a1.id}/void`);
    log(`${tag}.void_on_deny`, v);
    const g = await call("GET", `/v2/payments/authorizations/${a1.id}`);
    log(`${tag}.get_after_void`, g, { auth_status: g.data?.status ?? null });
  }
  // hold then approve
  const r2 = await call("POST", "/v2/checkout/orders", order("21.00", pu));
  const a2 = authOf(r2.data);
  log(`${tag}.authorize_to_recipient_2`, r2, { auth_status: a2?.status ?? null });
  if (a2) {
    const c = await call("POST", `/v2/payments/authorizations/${a2.id}/capture`, { final_capture: true });
    log(`${tag}.capture_on_approve`, c, { capture_status: c.data?.status ?? null, disbursement_mode: c.data?.disbursement_mode ?? null });
    if (c.data?.id) {
      const gc = await call("GET", `/v2/payments/captures/${c.data.id}`);
      const b = gc.data?.seller_receivable_breakdown;
      log(`${tag}.get_capture`, gc, { capture_status: gc.data?.status ?? null, payee_email_matches_recipient: gc.data?.payee?.email_address === recipient, payee_present: Boolean(gc.data?.payee), net_to_payee: b?.net_amount?.value ?? null, paypal_fee: b?.paypal_fee?.value ?? null });
      if (delayed) {
        const rp = await call("POST", "/v1/payments/referenced-payouts-items", { reference_id: c.data.id, reference_type: "TRANSACTION_ID" });
        log(`${tag}.referenced_payout_release`, rp, { item_status: rp.data?.processing_state?.status ?? null });
      }
    }
  }
}

// F5 ---------------------------------------------------------------------------------------------
{
  const to = recipient ?? "sb-edcbv53298348@personal.example.com"; // fallback: the existing personal sandbox buyer
  const r = await call("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: `sk-${randomUUID().slice(0, 12)}`, email_subject: "Second Key sandbox payout probe" },
    items: [{ recipient_type: "EMAIL", receiver: to, amount: { currency: "USD", value: "1.00" }, note: "SANDBOX probe", sender_item_id: "sk-probe-1" }],
  });
  const batch = r.data?.batch_header?.payout_batch_id;
  log("F5.payout_create", r, { recipient: recipient ? "SK_RECIPIENT_EMAIL" : "existing personal sandbox buyer", batch_status: r.data?.batch_header?.batch_status ?? null });
  if (batch) {
    let last: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      last = await call("GET", `/v1/payments/payouts/${batch}`);
      const item = last.data?.items?.[0]?.transaction_status;
      if (item && !["PENDING", "NEW", "ONHOLD"].includes(item)) break;
    }
    log("F5.payout_settled", last, { batch_status: last?.data?.batch_header?.batch_status ?? null, item_status: last?.data?.items?.[0]?.transaction_status ?? null, seconds_waited_max: 60 });
  }
}

// F6 ---------------------------------------------------------------------------------------------
{
  const payerId = f2Order?.payer?.payer_id ?? f2Order?.payment_source?.paypal?.account_id ?? null;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const assertion = `${b64({ alg: "none" })}.${b64({ iss: CLIENT_ID, payer_id: payerId })}.`;
  const r = await call("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }, { "PayPal-Auth-Assertion": assertion });
  log("F6.act_on_behalf_of_unconsented_account", r, { asserted_account: payerId ? "the personal sandbox buyer" : "unknown" });
}

mkdirSync(join(ROOT, "secondkey", "reports"), { recursive: true });
writeFileSync(join(ROOT, "secondkey", "reports", "s4-flows.json"), JSON.stringify({ ran_at: new Date().toISOString(), environment: "PayPal SANDBOX", recipient: recipient ? "personal sandbox account (SK_RECIPIENT_EMAIL)" : null, steps }, null, 2) + "\n");
console.log("written secondkey/reports/s4-flows.json");
