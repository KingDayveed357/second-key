// Code samples for /developers. Every request and response here was run against the API on
// 10 Nov 2026 (local stack, PayPal sandbox); ids and timestamps are from that run.

export interface Sample {
  lang: "curl" | "Node" | "Python";
  code: string;
}

export const SETUP = `git clone https://github.com/KingDayveed357/second-key && cd second-key
pnpm install
cp .env.example .env            # PayPal sandbox app credentials (Vault enabled)
pnpm db:dev                     # embedded Postgres; leave it running
pnpm db:migrate && pnpm db:seed # sandbox keys -> .secondkey/dev-keys.json
pnpm api                        # http://127.0.0.1:4000
pnpm worker                     # the only process that moves money`;

export const ENV = `export SK=http://127.0.0.1:4000
export SK_SHOPPER_KEY=wk_...   # "shopper" in .secondkey/dev-keys.json
export SK_AGENT_KEY=wk_...     # "agent"`;

const POLICY_JSON = `{
    "version": 1,
    "category": "trail-running shoes",
    "retailers": ["rei.com", "backcountry.com"],
    "max_total_cents": 9000,
    "currency": "USD",
    "quantity": 1,
    "hard": { "size": "10", "excluded_colors": ["white"] },
    "substitution": "same_category_under_max",
    "expires_at": "2026-11-17T00:00:00Z"
  }`;

export const STEP_INTENT: Sample[] = [
  {
    lang: "curl",
    code: `curl -s $SK/v1/intents \\
  -H "Authorization: Bearer $SK_SHOPPER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "source_text": "Trail-running shoes, size 10, under $90, not white",
  "policy": ${POLICY_JSON}
}'

# The person reviews it in your app, then you confirm it:
curl -s -X POST $SK/v1/intents/int_SN6HRr14lVI0xBIV/confirm \\
  -H "Authorization: Bearer $SK_SHOPPER_KEY" -H "Content-Type: application/json" -d '{}'`,
  },
  {
    lang: "Node",
    code: `const sk = (path, key, body, headers = {}) =>
  fetch(process.env.SK + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: \`Bearer \${key}\`, "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

const intent = await sk("/v1/intents", process.env.SK_SHOPPER_KEY, {
  source_text: "Trail-running shoes, size 10, under $90, not white",
  policy: {
    version: 1, category: "trail-running shoes", retailers: ["rei.com", "backcountry.com"],
    max_total_cents: 9000, currency: "USD", quantity: 1,
    hard: { size: "10", excluded_colors: ["white"] },
    substitution: "same_category_under_max", expires_at: "2026-11-17T00:00:00Z",
  },
});
// The person reviews it in your app, then:
const confirmed = await sk(\`/v1/intents/\${intent.id}/confirm\`, process.env.SK_SHOPPER_KEY, {});`,
  },
  {
    lang: "Python",
    code: `import os, requests
SK = os.environ["SK"]
shopper = {"Authorization": f"Bearer {os.environ['SK_SHOPPER_KEY']}"}

intent = requests.post(f"{SK}/v1/intents", headers=shopper, json={
    "source_text": "Trail-running shoes, size 10, under $90, not white",
    "policy": {
        "version": 1, "category": "trail-running shoes", "retailers": ["rei.com", "backcountry.com"],
        "max_total_cents": 9000, "currency": "USD", "quantity": 1,
        "hard": {"size": "10", "excluded_colors": ["white"]},
        "substitution": "same_category_under_max", "expires_at": "2026-11-17T00:00:00Z",
    },
}).json()
# The person reviews it in your app, then:
confirmed = requests.post(f"{SK}/v1/intents/{intent['id']}/confirm", headers=shopper, json={}).json()`,
  },
];

export const STEP_INTENT_RESPONSE = `{
  "id": "int_SN6HRr14lVI0xBIV",
  "version": 1,
  "status": "CONFIRMED",
  "policy": { "category": "trail-running shoes", "max_total_cents": 9000, "...": "..." },
  "complete": true,
  "policy_digest": "sha256:1b937792ef8378b3ce7518ae5e24b9fe60d414e498f4962947ad57f6d8cd2a6c",
  "ambiguities": [],
  "confirmed_at": "2026-11-10T03:49:05.737Z"
}`;

export const STEP_PURCHASE: Sample[] = [
  {
    lang: "curl",
    code: `curl -s $SK/v1/purchases \\
  -H "Authorization: Bearer $SK_AGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-7f3a9c21" \\
  -d '{
  "intent_id": "int_SN6HRr14lVI0xBIV",
  "retailer": "rei.com",
  "lines": [{ "product_id": "TRL-GRY-10", "quantity": 1 }]
}'`,
  },
  {
    lang: "Node",
    code: `// Derive the key from the request so a retry is the same purchase, never a second one.
const purchase = await sk("/v1/purchases", process.env.SK_AGENT_KEY, {
  intent_id: confirmed.id,
  retailer: "rei.com",
  lines: [{ product_id: "TRL-GRY-10", quantity: 1 }],
}, { "Idempotency-Key": \`order-\${cartId}\` });`,
  },
  {
    lang: "Python",
    code: `agent = {"Authorization": f"Bearer {os.environ['SK_AGENT_KEY']}",
         "Idempotency-Key": f"order-{cart_id}"}  # same cart, same key: a retry is safe

purchase = requests.post(f"{SK}/v1/purchases", headers=agent, json={
    "intent_id": confirmed["id"],
    "retailer": "rei.com",
    "lines": [{"product_id": "TRL-GRY-10", "quantity": 1}],
}).json()`,
  },
];

export const STEP_PURCHASE_RESPONSE = `HTTP/1.1 202 Accepted
{
  "id": "pur_YKv0a0drZieikLZb",
  "state": "CAPTURE_APPROVED",
  "outcome": "CAPTURE",
  "reasons": [],
  "intent_id": "int_SN6HRr14lVI0xBIV",
  "retailer": "rei.com",
  "amount": { "currency_code": "USD", "value": "84.00" }
}`;

export const STEP_RESULT: Sample[] = [
  {
    lang: "curl",
    code: `# Poll until the state is final (CAPTURED, REJECTED, HELD resolved, VOIDED)
curl -s $SK/v1/purchases/pur_YKv0a0drZieikLZb -H "Authorization: Bearer $SK_AGENT_KEY"

# What PayPal itself holds for it: order, authorization, capture
curl -s $SK/v1/purchases/pur_YKv0a0drZieikLZb/paypal -H "Authorization: Bearer $SK_SHOPPER_KEY"

# Re-verify its hash-chained audit trail (public)
curl -s $SK/v1/verify/purchases/pur_YKv0a0drZieikLZb`,
  },
  {
    lang: "Node",
    code: `const FINAL = ["CAPTURED", "REJECTED", "VOIDED", "CAPTURE_DECLINED"];
let p = purchase;
while (!FINAL.includes(p.state) && p.state !== "HELD") {
  await new Promise((r) => setTimeout(r, 1500));
  p = await sk(\`/v1/purchases/\${p.id}\`, process.env.SK_AGENT_KEY);
}
const paypal = await sk(\`/v1/purchases/\${p.id}/paypal\`, process.env.SK_SHOPPER_KEY);`,
  },
  {
    lang: "Python",
    code: `import time
FINAL = {"CAPTURED", "REJECTED", "VOIDED", "CAPTURE_DECLINED"}
p = purchase
while p["state"] not in FINAL and p["state"] != "HELD":
    time.sleep(1.5)
    p = requests.get(f"{SK}/v1/purchases/{p['id']}", headers=agent).json()
paypal = requests.get(f"{SK}/v1/purchases/{p['id']}/paypal", headers=shopper).json()`,
  },
];

export const STEP_RESULT_RESPONSE = `{
  "order": {
    "id": "4D855638VP030945N",
    "status": "COMPLETED",
    "payee": "7L6D422CPFA9Q",
    "items": [{ "sku": "TRL-GRY-10", "quantity": "1", "unit_amount": { "currency_code": "USD", "value": "84.00" } }]
  },
  "authorizations": [{ "id": "69J2628948039703G", "status": "CAPTURED" }],
  "captures": [{ "id": "02M58451ST820323C", "status": "COMPLETED", "amount": { "currency_code": "USD", "value": "84.00" } }],
  "debug_id": "f2558692072d0"
}`;

export const TRANSFER: Sample[] = [
  {
    lang: "curl",
    code: `# 1. The payer confirms exactly this payee and amount (their own rule: a second look
#    for first payments of $500 or more)
curl -s $SK/v1/intents -H "Authorization: Bearer $SK_SHOPPER_KEY" -H "Content-Type: application/json" -d '{
  "policy": {
    "version": 1, "kind": "transfer",
    "payee": { "id": "payee_jmorgan", "name": "J. Morgan", "first_payment": true },
    "amount_cents": 180000, "currency": "USD", "purpose": "Bail for Danny",
    "review_threshold_cents": 50000, "expires_at": "2026-11-17T00:00:00Z"
  }
}'
curl -s -X POST $SK/v1/intents/int_ks2C-c8-jVVvz8mv/confirm -H "Authorization: Bearer $SK_SHOPPER_KEY" -H "Content-Type: application/json" -d '{}'

# 2. Your app submits it
curl -s $SK/v1/purchases -H "Authorization: Bearer $SK_AGENT_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: transfer-81c2d7e4" -d '{
  "kind": "transfer", "intent_id": "int_ks2C-c8-jVVvz8mv",
  "payee_id": "payee_jmorgan", "amount_cents": 180000, "currency": "USD"
}'`,
  },
];

export const TRANSFER_RESPONSE = `HTTP/1.1 202 Accepted
{
  "id": "pur_O82hwTYXSmplmpsy",
  "state": "HELD",
  "outcome": "HOLD",
  "reasons": [
    "transfer.review_rule: the payer's rule: a second look for first payments of $500.00 or more to someone new (this is $1,800.00 to J. Morgan, a first payment)"
  ],
  "amount": { "currency_code": "USD", "value": "1800.00" }
}`;

export const AP2: Sample[] = [
  {
    lang: "curl",
    code: `# The agent presents its AP2 chains; you say which issuer and merchant keys you trust.
curl -s $SK/v2/verifications \\
  -H "Authorization: Bearer $SK_AP2_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: verify-0b7e5a1f" \\
  -d '{
  "checkout": { "mandate": "<open checkout SD-JWT>~~<closed checkout KB-SD-JWT>", "aud": "your-merchant-id", "nonce": "n-7f3a9c21aa" },
  "payment":  { "mandate": "<open payment SD-JWT>~~<closed payment KB-SD-JWT>",  "aud": "your-psp-id",      "nonce": "n-2c81d07e55" },
  "trust": { "issuers": { "keys": [ { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "kid": "user-device-1" } ] },
             "merchants": { "keys": [ { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "kid": "merchant-1" } ] } }
}'

# CONFORMS and settleable? Bind it to the PayPal order you created (within 15 minutes):
curl -s $SK/v2/settlements -H "Authorization: Bearer $SK_AP2_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: settle-0b7e5a1f" -d '{ "verification_id": "ver_...", "psp": "paypal", "order_id": "5O190127TN364715T" }'`,
  },
];

export const AP2_RESPONSE = `{
  "verification_id": "ver_TLUJI09l0lQSbwxg",
  "decision": "CONFORMS",              // or NONCONFORMING, CANNOT_CONFIRM, COSIGN_REQUIRED
  "findings": [],
  "constraints": [
    { "type": "checkout.line_items", "result": "pass" },
    { "type": "payment.amount_range", "result": "pass" },
    { "type": "x-secondkey.item_attributes.1", "result": "pass" }
  ],
  "settleable": true,
  "facts_attestation": "eyJhbGciOiJFUzI1NiIs...",
  "ledger": [{ "open_mandate": "…", "kind": "checkout", "uses_before": 0 }],
  "receipts": { "checkout": "eyJ…", "payment": "eyJ…", "kid": "<receipt key id>", "jwks_uri": "/.well-known/jwks.json" }
}`;

export const ERROR_SAMPLE = `HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json

{
  "type": "about:blank",
  "title": "Idempotency-Key header required",
  "status": 422,
  "trace_id": "req_yp5yc1rd2t"
}`;
