// S4 sandbox spike: which legitimate PayPal flows can carry a "held" protected payment?
// SANDBOX ONLY (the transport refuses any other host). This is a spike outside the product path: it
// calls the executor's money-movement client directly to test semantics. In the product, capture and
// void stay in the isolated executor (Second Key ADR-0005).
//
//   npx tsx secondkey/spikes/s4/architectures.ts
// Writes secondkey/reports/s4-architectures.json. Never prints credentials.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { ROOT, loadDotEnv } from "@witness/config";
import { PayPalClient } from "@witness/paypal";
import { MoneyMovementClient } from "@witness/paypal/money-movement";
import { PayPalTransport } from "../../../packages/paypal/src/transport.ts";

loadDotEnv();
const creds = { baseUrl: process.env.PAYPAL_BASE_URL!, clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET! };
const api = new PayPalClient({ ...creds, role: "script" });
const money = new MoneyMovementClient(creds);
const payouts = new PayPalTransport({ ...creds, role: "script" });

const db = new pg.Client({ connectionString: process.env.SK_DATABASE_URL ?? "postgres://witness:witness-dev-only@127.0.0.1:54330/witness" });
await db.connect();
const keys = JSON.parse(readFileSync(join(ROOT, ".secondkey", "dev-keys.json"), "utf8"));
const vaultId = (await db.query("select vault_id from shoppers where id = $1", [keys.demo_shopper_id])).rows[0].vault_id as string;
await db.end();

const steps: Record<string, unknown>[] = [];
const log = (step: string, r: { ok?: boolean; status?: number; data?: any; debugId?: string | null } | Error, extra: Record<string, unknown> = {}) => {
  const e = r instanceof Error ? { error: r.message } : { http: r.status, ok: r.ok, debug_id: r.debugId ?? null, issue: r.data?.details?.[0]?.issue ?? r.data?.name ?? null };
  const row = { step, ...e, ...extra };
  steps.push(row);
  console.log(JSON.stringify(row));
};
const safe = async <T>(f: () => Promise<T>): Promise<T | Error> => {
  try {
    return await f();
  } catch (e) {
    return e as Error;
  }
};

const order = (amount: string, extra: Record<string, unknown> = {}) => ({
  intent: "AUTHORIZE",
  purchase_units: [{ reference_id: `sk-${randomUUID().slice(0, 8)}`, description: "Second Key protected payment (SANDBOX)", amount: { currency_code: "USD", value: amount }, ...extra }],
  payment_source: { paypal: { vault_id: vaultId } },
});
const authOf = (o: any) => o?.purchase_units?.[0]?.payments?.authorizations?.[0];

// ---- Architecture A: pay the recipient directly (third-party payee) --------------------------------
{
  const r = await safe(() => api.createOrder(order("50.00", { payee: { email_address: `sk-recipient-${Date.now()}@example.com` } }), randomUUID()));
  log("A.create_order_third_party_payee_unknown_email", r as any, { auth_status: r instanceof Error ? null : authOf((r as any).data)?.status ?? null });
}

// ---- Architecture B: authorize to the protection platform; hold; deny → void --------------------
const deny = { order_id: "", auth_id: "" };
{
  const r = await safe(() => api.createOrder(order("1800.00"), randomUUID()));
  const auth = r instanceof Error ? null : authOf(r.data);
  log("B1.create_and_authorize_1800", r as any, { order_id: r instanceof Error ? null : r.data?.id, order_status: r instanceof Error ? null : r.data?.status, auth_status: auth?.status ?? null });
  if (auth) {
    deny.order_id = (r as any).data.id;
    deny.auth_id = auth.id;
    const g = await api.getAuthorization(auth.id);
    log("B2.get_authorization_while_held", g, { auth_status: g.data?.status, amount: g.data?.amount?.value, expiration_time: g.data?.expiration_time ?? null });
    const o = await api.getOrder(deny.order_id);
    log("B3.get_order_no_capture", o, { order_status: o.data?.status, captures: o.data?.purchase_units?.[0]?.payments?.captures?.length ?? 0 });
    const voidId = randomUUID();
    const v1 = await safe(() => money.voidAuthorization(auth.id, voidId));
    log("B4.void_on_deny", v1 as any);
    const v2 = await safe(() => money.voidAuthorization(auth.id, voidId));
    log("B5.void_retry_same_request_id", v2 as any);
    const v3 = await safe(() => money.voidAuthorization(auth.id, randomUUID()));
    log("B6.void_again_new_request_id", v3 as any);
    const c = await safe(() => money.captureAuthorization(auth.id, { currency_code: "USD", value: "1800.00" }, randomUUID()));
    log("B7.capture_after_void_must_fail", c as any);
    const g2 = await api.getAuthorization(auth.id);
    log("B8.independent_get_after_deny", g2, { auth_status: g2.data?.status });
    const o2 = await api.getOrder(deny.order_id);
    log("B9.order_after_deny", o2, { order_status: o2.data?.status, captures: o2.data?.purchase_units?.[0]?.payments?.captures?.length ?? 0, auth_status: authOf(o2.data)?.status });
  }
}

// ---- Architecture B, approve path: capture, then pay the recipient with Payouts ------------------
{
  const r = await safe(() => api.createOrder(order("25.00"), randomUUID()));
  const auth = r instanceof Error ? null : authOf(r.data);
  log("B10.create_and_authorize_25", r as any, { auth_status: auth?.status ?? null });
  if (auth) {
    const c = await safe(() => money.captureAuthorization(auth.id, { currency_code: "USD", value: "25.00" }, randomUUID()));
    log("B11.capture_on_approve", c as any, { capture_status: c instanceof Error ? null : (c as any).data?.status, amount: c instanceof Error ? null : (c as any).data?.amount?.value });
    const batchId = `sk-${randomUUID()}`;
    const p = await safe(() =>
      payouts.send("POST", "/v1/payments/payouts", {
        body: {
          sender_batch_header: { sender_batch_id: batchId, email_subject: "Second Key sandbox payout", email_message: "SANDBOX test payout" },
          items: [{ recipient_type: "EMAIL", amount: { value: "20.00", currency: "USD" }, receiver: `sk-recipient-${Date.now()}@example.com`, note: "Second Key sandbox", sender_item_id: "item-1" }],
        },
        requestId: batchId,
        label: "create-payout",
        allowFail: true,
      }),
    );
    const batch = p instanceof Error ? null : (p as any).data?.batch_header?.payout_batch_id;
    log("B12.payout_to_recipient_email", p as any, { batch_status: p instanceof Error ? null : (p as any).data?.batch_header?.batch_status ?? null });
    if (batch) {
      await new Promise((res) => setTimeout(res, 6000));
      const g = await safe(() => payouts.send("GET", `/v1/payments/payouts/${batch}`, { label: "get-payout" }));
      log("B13.get_payout_batch", g as any, { batch_status: g instanceof Error ? null : (g as any).data?.batch_header?.batch_status, item_status: g instanceof Error ? null : (g as any).data?.items?.[0]?.transaction_status });
    }
  }
}

mkdirSync(join(ROOT, "secondkey", "reports"), { recursive: true });
writeFileSync(join(ROOT, "secondkey", "reports", "s4-architectures.json"), JSON.stringify({ ran_at: new Date().toISOString(), environment: "PayPal SANDBOX (api-m.sandbox.paypal.com)", payer: "vaulted sandbox buyer (Second Key demo shopper)", steps }, null, 2) + "\n");
console.log("written secondkey/reports/s4-architectures.json");
