// The reference agent's entire world: four HTTP tools. It has no PayPal credentials, no database
// and no Second Key internals (architecture rule "agent-is-an-outsider"). Whatever it tries, money
// only moves if Second Key's checks pass.

import { createHash } from "node:crypto";

export interface AgentEnv {
  witnessApi: string;
  agentKey: string;
  channel3Key?: string | undefined;
  fetchImpl?: typeof fetch;
}

const j = (v: unknown) => JSON.stringify(v, null, 2);

async function secondKey(env: AgentEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await (env.fetchImpl ?? fetch)(`${env.witnessApi}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.agentKey}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function getIntentSummary(env: AgentEnv, intentId: string): Promise<string> {
  const r = await secondKey(env, "GET", `/v1/intents/${encodeURIComponent(intentId)}/summary`);
  return r.status === 200 ? j(r.body) : `Error ${r.status}: ${r.body?.detail ?? r.body?.title ?? "unknown"}`;
}

/** Channel3 product search (POST /v1/search, verified live 2026-10-12). Returns a compact list. */
export async function searchProducts(env: AgentEnv, query: string): Promise<string> {
  if (!env.channel3Key) return "Product search is unavailable (no Channel3 key configured).";
  const res = await (env.fetchImpl ?? fetch)("https://api.trychannel3.com/v1/search", {
    method: "POST",
    headers: { "x-api-key": env.channel3Key, "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return `Search failed: HTTP ${res.status}`;
  const data = (await res.json()) as { products?: any[] };
  const items = (data.products ?? []).slice(0, 6).map((p) => ({
    product_id: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    category: p.category?.title ?? null,
    offers: (p.offers ?? []).slice(0, 4).map((o: any) => ({ retailer: o.domain, price: o.price?.price ?? o.price?.amount, currency: o.price?.currency, availability: o.availability })),
  }));
  return items.length ? j(items) : "No products found.";
}

/** Submit a purchase. The idempotency key is derived from the request, so a retry is the same purchase. */
export async function submitPurchase(env: AgentEnv, input: { intent_id: string; retailer: string; product_id: string; quantity: number; note?: string | undefined }): Promise<string> {
  const body = { intent_id: input.intent_id, retailer: input.retailer, lines: [{ product_id: input.product_id, quantity: input.quantity }], ...(input.note ? { agent_note: input.note.slice(0, 500) } : {}) };
  const key = "agent-" + createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  const r = await secondKey(env, "POST", "/v1/purchases", body, { "idempotency-key": key });
  if (r.status !== 200 && r.status !== 202) return `Second Key refused the request: ${r.status} ${r.body?.title ?? ""} ${r.body?.detail ?? ""}`.trim();
  return j({ purchase_id: r.body.id, state: r.body.state, outcome: r.body.outcome, reasons: r.body.reasons, amount: r.body.amount });
}

export async function getPurchaseStatus(env: AgentEnv, purchaseId: string): Promise<string> {
  const r = await secondKey(env, "GET", `/v1/purchases/${encodeURIComponent(purchaseId)}`);
  return r.status === 200 ? j({ state: r.body.state, outcome: r.body.outcome, reasons: r.body.reasons, amount: r.body.amount }) : `Error ${r.status}`;
}
