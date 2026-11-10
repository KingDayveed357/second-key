// Generates postman/second-key.postman_collection.json: every public endpoint plus the judge scenarios,
// each with assertions. Run it with Newman against a local or hosted API:
//   pnpm postman:build
//   npx newman run postman/second-key.postman_collection.json --env-var baseUrl=... --env-var agentKey=...
// Keys are collection variables left blank here; never commit filled values.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@witness/config";

type Auth = "agent" | "shopper" | "ops" | "demo" | null;
interface Req {
  name: string;
  method: "GET" | "POST";
  path: string;
  auth: Auth;
  body?: unknown;
  headers?: Record<string, string>;
  /** Postman test script lines (pm API). */
  test: string[];
  /** Optional pre-request script lines. */
  pre?: string[];
}

const wait = (ms: number) => [`setTimeout(() => {}, ${ms});`];
const status = (...codes: number[]) => `pm.test("status ${codes.join(" or ")}", () => pm.expect(pm.response.code).to.be.oneOf([${codes.join(", ")}]));`;
const save = (variable: string, expr: string) => `pm.collectionVariables.set("${variable}", ${expr});`;

const policy = {
  version: 1,
  category: "trail-running shoes",
  retailers: ["rei.com", "backcountry.com"],
  max_total_cents: 9000,
  currency: "USD",
  quantity: 1,
  hard: { excluded_colors: ["white"], size: "10" },
  substitution: "same_category_under_max",
  expires_at: "{{expiresAt}}",
};

const scenario = (name: string, expect: string[]): Req[] => [
  {
    name: `Run scenario: ${name}`,
    method: "POST",
    path: `/v1/demo/scenarios/${name}`,
    auth: "demo",
    test: [status(202), `const j = pm.response.json();`, `pm.test("has purchase", () => pm.expect(j.purchase.id).to.match(/^pur_/));`, save(`p_${name}`, "j.purchase.id"), save(`i_${name}`, "j.intent_id")],
  },
];
const settled = (name: string, states: string[]): Req => ({
  name: `Scenario ${name} reached ${states.join(" or ")}`,
  method: "GET",
  path: `/v1/purchases/{{p_${name}}}`,
  auth: "demo",
  pre: wait(8000),
  test: [status(200), `pm.test("state", () => pm.expect(pm.response.json().state).to.be.oneOf(${JSON.stringify(states)}));`],
});

const folders: { name: string; description?: string; items: Req[] }[] = [
  {
    name: "Health",
    items: [
      { name: "Liveness", method: "GET", path: "/healthz", auth: null, test: [status(200), `pm.test("ok", () => pm.expect(pm.response.json().ok).to.eql(true));`] },
      { name: "Readiness (database)", method: "GET", path: "/readyz", auth: null, test: [status(200)] },
    ],
  },
  {
    name: "Judge scenarios (real PayPal sandbox)",
    items: [
      { name: "List scenarios", method: "GET", path: "/v1/demo/scenarios", auth: null, test: [status(200), `pm.test("7 scenarios", () => pm.expect(pm.response.json().length).to.be.at.least(7));`] },
      ...scenario("normal", []),
      ...scenario("reject", []),
      ...scenario("over_budget", []),
      ...scenario("hold", []),
      ...scenario("overpriced", []),
      ...scenario("injection", []),
      ...scenario("cart_swap", []),
      settled("normal", ["CAPTURED"]),
      settled("reject", ["REJECTED"]),
      settled("over_budget", ["REJECTED"]),
      settled("hold", ["HELD"]),
      settled("overpriced", ["HELD"]),
      settled("injection", ["HELD"]),
      settled("cart_swap", ["VOIDED", "VOIDING"]),
      {
        name: "Fetch from PayPal: clean purchase captured exactly once",
        method: "GET",
        path: "/v1/purchases/{{p_normal}}/paypal",
        auth: "demo",
        test: [status(200), `const j = pm.response.json();`, `pm.test("one COMPLETED capture", () => { pm.expect(j.captures.length).to.eql(1); pm.expect(j.captures[0].status).to.eql("COMPLETED"); });`],
      },
      {
        name: "Fetch from PayPal: rejected purchase never reached PayPal",
        method: "GET",
        path: "/v1/purchases/{{p_reject}}/paypal",
        auth: "demo",
        test: [status(200), `pm.test("no order", () => pm.expect(pm.response.json().order).to.eql(null));`],
      },
      {
        name: "Fetch from PayPal: cart swap voided, nothing captured",
        method: "GET",
        path: "/v1/purchases/{{p_cart_swap}}/paypal",
        auth: "demo",
        test: [status(200), `const j = pm.response.json();`, `pm.test("no capture", () => pm.expect(j.captures.length).to.eql(0));`],
      },
      { name: "Evidence record for the clean purchase", method: "GET", path: "/v1/purchases/{{p_normal}}/evidence", auth: "demo", test: [status(200), `pm.test("PayPal calls recorded", () => pm.expect(pm.response.json().paypal_calls.length).to.be.at.least(2));`] },
      { name: "Public: verify one purchase's audit chain", method: "GET", path: "/v1/verify/purchases/{{p_normal}}", auth: null, test: [status(200), `pm.test("valid", () => pm.expect(pm.response.json().valid).to.eql(true));`] },
      { name: "Public: verify the whole audit chain", method: "GET", path: "/v1/verify/chain", auth: null, test: [status(200), `pm.test("valid", () => pm.expect(pm.response.json().valid).to.eql(true));`] },
    ],
  },
  {
    name: "Shopper: intents and the payer's own review",
    description:
      "A hold on the payer's own agent purchase is reviewed by the payer. The review credential is shown once, travels in the URL fragment or a POST body (never a query string), and decides once (ADR-0020). Holds that wait for a trusted contact refuse hold-link with 409: their credential goes only to the contact's own channel.",
    items: [
      { name: "Create a structured intent (draft)", method: "POST", path: "/v1/intents", auth: "shopper", body: { policy, source_text: "Trail-running shoes, size 10, under $90, not white" }, test: [status(201), `const j = pm.response.json();`, `pm.test("draft", () => pm.expect(j.status).to.eql("DRAFT"));`, save("intentId", "j.id")] },
      { name: "Agent can't read an unconfirmed intent", method: "GET", path: "/v1/intents/{{intentId}}/summary", auth: "agent", test: [status(404)] },
      { name: "Confirm the intent", method: "POST", path: "/v1/intents/{{intentId}}/confirm", auth: "shopper", test: [status(200), `pm.test("confirmed", () => pm.expect(pm.response.json().status).to.eql("CONFIRMED"));`] },
      { name: "Agent reads the confirmed intent", method: "GET", path: "/v1/intents/{{intentId}}/summary", auth: "agent", test: [status(200)] },
      { name: "Receipts", method: "GET", path: "/v1/me/purchases", auth: "shopper", test: [status(200), `pm.test("list", () => pm.expect(pm.response.json().purchases).to.be.an("array"));`] },
      {
        name: "One-time review credential for the held scenario (payer's own agent)",
        method: "POST",
        path: "/v1/purchases/{{p_hold}}/hold-link",
        auth: "shopper",
        test: [status(200), `pm.test("credential only in the fragment", () => pm.expect(pm.response.json().path).to.match(/#k=/));`, save("holdToken", "pm.response.json().token")],
      },
      { name: "View the hold with the credential in the body (no API key)", method: "POST", path: "/v1/holds/{{p_hold}}/view", auth: null, body: { token: "{{holdToken}}" }, test: [status(200), `pm.test("held", () => pm.expect(pm.response.json().state).to.eql("HELD"));`] },
      { name: "A credential in the URL is not accepted", method: "GET", path: "/v1/holds/{{p_hold}}?t={{holdToken}}", auth: null, test: [status(401)] },
      { name: "A wrong credential is refused", method: "POST", path: "/v1/holds/{{p_hold}}/approve", auth: null, body: { token: "x".repeat(43) }, test: [status(403)] },
      { name: "Deny the hold (releases the authorization)", method: "POST", path: "/v1/holds/{{p_hold}}/deny", auth: null, body: { token: "{{holdToken}}" }, test: [status(200), `pm.test("voiding", () => pm.expect(pm.response.json().state).to.be.oneOf(["VOIDING", "VOIDED"]));`] },
      { name: "It decides once", method: "POST", path: "/v1/holds/{{p_hold}}/approve", auth: null, body: { token: "{{holdToken}}" }, test: [status(409, 410)] },
      { name: "Revoke the intent", method: "POST", path: "/v1/intents/{{intentId}}/revoke", auth: "shopper", test: [status(200), `pm.test("revoked", () => pm.expect(pm.response.json().status).to.eql("REVOKED"));`] },
    ],
  },
  {
    name: "Agent: purchases and idempotency",
    items: [
      { name: "Create and confirm an intent for the agent", method: "POST", path: "/v1/intents", auth: "shopper", body: { policy, source_text: "agent purchase test" }, test: [status(201), save("agentIntent", "pm.response.json().id"), save("idemKey", "`postman-${Date.now()}`")] },
      { name: "Confirm it", method: "POST", path: "/v1/intents/{{agentIntent}}/confirm", auth: "shopper", test: [status(200)] },
      { name: "Submit a purchase", method: "POST", path: "/v1/purchases", auth: "agent", headers: { "idempotency-key": "{{idemKey}}" }, body: { intent_id: "{{agentIntent}}", retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] }, test: [status(202), save("agentPurchase", "pm.response.json().id"), `pm.test("agent view hides PayPal ids", () => pm.expect(pm.response.json().paypal).to.be.undefined);`] },
      { name: "Replay with the same key returns the same purchase", method: "POST", path: "/v1/purchases", auth: "agent", headers: { "idempotency-key": "{{idemKey}}" }, body: { intent_id: "{{agentIntent}}", retailer: "rei.com", lines: [{ product_id: "TRL-GRY-10", quantity: 1 }] }, test: [status(200), `pm.test("same id", () => pm.expect(pm.response.json().id).to.eql(pm.collectionVariables.get("agentPurchase")));`] },
      { name: "Same key, different body is refused", method: "POST", path: "/v1/purchases", auth: "agent", headers: { "idempotency-key": "{{idemKey}}" }, body: { intent_id: "{{agentIntent}}", retailer: "rei.com", lines: [{ product_id: "TRL-BLK-10", quantity: 1 }] }, test: [status(422)] },
      { name: "Agents can't create intents", method: "POST", path: "/v1/intents", auth: "agent", body: { text: "anything" }, test: [status(403)] },
      { name: "No key is refused", method: "POST", path: "/v1/purchases", auth: null, body: {}, test: [status(401)] },
    ],
  },
  {
    name: "Ops console (read-only)",
    items: [
      { name: "Ledger", method: "GET", path: "/v1/console/purchases?limit=50", auth: "ops", test: [status(200), `pm.test("rows", () => pm.expect(pm.response.json().purchases.length).to.be.at.least(1));`] },
      { name: "HOLD queue", method: "GET", path: "/v1/console/holds", auth: "ops", test: [status(200)] },
      { name: "Stats: zero captures without an approval", method: "GET", path: "/v1/console/stats", auth: "ops", test: [status(200), `pm.test("no unauthorized captures", () => pm.expect(pm.response.json().unauthorized_captures).to.eql(0));`] },
      { name: "Checks for one purchase", method: "GET", path: "/v1/console/purchases/{{p_reject}}/checks", auth: "ops", test: [status(200), `pm.test("colour failed", () => pm.expect(pm.response.json().checks.some((c) => c.check_id === "color" && c.result === "fail")).to.eql(true));`] },
      { name: "Webhook deliveries", method: "GET", path: "/v1/console/webhooks", auth: "ops", test: [status(200)] },
      { name: "Disputes", method: "GET", path: "/v1/console/disputes", auth: "ops", test: [status(200)] },
      { name: "Agents can't read the console", method: "GET", path: "/v1/console/stats", auth: "agent", test: [status(403)] },
    ],
  },
  {
    name: "Demo extras",
    items: [
      { name: "Aggregate counters", method: "GET", path: "/v1/demo/stats", auth: "demo", test: [status(200), `pm.test("no ids leak", () => pm.expect(pm.response.json().by_state).to.be.undefined);`] },
      {
        name: "Try to beat it: excluded colour is rejected without a model call",
        method: "POST",
        path: "/v1/demo/screen",
        auth: "demo",
        body: { title: "Ridgeline Trail Runner, Cloud White", category: "Shoes > Trail-running shoes", color: "Cloud White", size: "10", price: 84 },
        test: [status(200), `pm.test("REJECT", () => pm.expect(pm.response.json().outcome).to.eql("REJECT"));`],
      },
      { name: "Try to beat it: unknown fields are refused", method: "POST", path: "/v1/demo/screen", auth: "demo", body: { title: "x", price: 1, payee: "attacker" }, test: [status(400)] },
    ],
  },
  {
    name: "AP2 (delegated verifier)",
    description:
      "Second Key as an AP2 v0.2 delegated verifier (ADR-0023). Public, read-only requests; signing mandates needs a key, so use the Developers page's test verification for a full run.",
    items: [
      {
        name: "Receipt key set (JWKS)",
        method: "GET",
        path: "/.well-known/jwks.json",
        auth: null,
        test: [status(200), `pm.test("ES256 P-256 keys with kid, no private part", () => { const k = pm.response.json().keys; pm.expect(k.length).to.be.above(0); k.forEach((x) => { pm.expect(x.kty).to.eql("EC"); pm.expect(x.crv).to.eql("P-256"); pm.expect(x.kid).to.be.a("string"); pm.expect(x).to.not.have.property("d"); }); });`],
      },
      { name: "Demo setup: the agent and merchant public keys", method: "GET", path: "/v1/demo/ap2/setup", auth: null, test: [status(200), `pm.test("public keys only", () => pm.expect(JSON.stringify(pm.response.json())).to.not.include('"d":'));`] },
      {
        name: "AP2 verifications in this demo session (Desk feed)",
        method: "GET",
        path: "/v1/demo/ap2/incidents?limit=50",
        auth: "demo",
        test: [status(200), `pm.test("one row per verification, with each layer", () => pm.response.json().verifications.forEach((r) => pm.expect(r.layers).to.include.keys("signatures", "ap2", "facts", "ledger", "paypal")));`],
      },
      { name: "A verification without the ap2:verify scope is refused", method: "POST", path: "/v2/verifications", auth: null, headers: { "Idempotency-Key": "postman-no-scope-1" }, body: {}, test: [status(401, 403)] },
    ],
  },
  {
    name: "Cleanup: release held sandbox authorizations",
    items: (["overpriced", "injection"] as const).flatMap((n): Req[] => [
      { name: `Revoke the ${n} scenario's intent (voids its hold)`, method: "POST", path: `/v1/intents/{{i_${n}}}/revoke`, auth: "shopper", test: [status(200)] },
      { name: `${n}: authorization voided`, method: "GET", path: `/v1/purchases/{{p_${n}}}`, auth: "demo", pre: wait(6000), test: [status(200), `pm.test("voided", () => pm.expect(pm.response.json().state).to.be.oneOf(["VOIDED", "VOIDING"]));`] },
    ]),
  },
];

const item = (r: Req) => ({
  name: r.name,
  event: [
    ...(r.pre ? [{ listen: "prerequest", script: { type: "text/javascript", exec: r.pre } }] : []),
    { listen: "test", script: { type: "text/javascript", exec: r.test } },
  ],
  request: {
    method: r.method,
    header: [
      ...(r.auth ? [{ key: "Authorization", value: `Bearer {{${r.auth}Key}}` }] : []),
      ...(r.body !== undefined ? [{ key: "Content-Type", value: "application/json" }] : []),
      ...Object.entries(r.headers ?? {}).map(([key, value]) => ({ key, value })),
    ],
    ...(r.body !== undefined ? { body: { mode: "raw", raw: JSON.stringify(r.body, null, 2) } } : {}),
    url: `{{baseUrl}}${r.path}`,
  },
});

const collection = {
  info: {
    name: "Second Key API",
    description:
      "Second Key: payment control for people and AI agents, and an AP2 delegated verifier, on the PayPal sandbox. Set baseUrl and the four role keys (from `pnpm db:seed`). Scenario folders create real sandbox orders. Requests run in order; later requests use ids saved by earlier ones.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  event: [{ listen: "prerequest", script: { type: "text/javascript", exec: [`pm.collectionVariables.set("expiresAt", new Date(Date.now() + 7 * 86400000).toISOString());`] } }],
  variable: [
    { key: "baseUrl", value: "http://127.0.0.1:4000" },
    { key: "agentKey", value: "" },
    { key: "shopperKey", value: "" },
    { key: "opsKey", value: "" },
    { key: "demoKey", value: "" },
  ],
  item: folders.map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), item: f.items.map(item) })),
};

mkdirSync(join(ROOT, "postman"), { recursive: true });
writeFileSync(join(ROOT, "postman", "second-key.postman_collection.json"), JSON.stringify(collection, null, 2) + "\n");
console.log(`postman/second-key.postman_collection.json: ${folders.reduce((s, f) => s + f.items.length, 0)} requests in ${folders.length} folders`);
