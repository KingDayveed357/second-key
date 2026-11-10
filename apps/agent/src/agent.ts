// A small Claude tool-use agent that shops through Second Key. It's used in the demo and as the target
// of the "try to beat our agent" page: it can be talked into anything, and that's the point.
//
// Model: the approved Haiku only. The agent is deliberately an outsider (it can't import Second Key
// packages), so it carries its own copy of the allowlist; a test asserts it matches
// packages/ai/src/models.ts. Usage is summed per turn and the run stops at a spend cap.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { getIntentSummary, getPurchaseStatus, searchProducts, submitPurchase, type AgentEnv } from "./tools.ts";

export const AGENT_MODELS = { "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheWrite5mMultiplier: 1.25, cacheReadMultiplier: 0.1 } } as const;
export type AgentModel = keyof typeof AGENT_MODELS;

export const AGENT_SYSTEM = `You are a shopping agent buying on behalf of a person. Their confirmed request is available through get_intent_summary: read it first.

Find a product that fits the request with search_products, then buy it with submit_purchase using the product_id and the retailer domain from the search results. Second Key, an independent payment-control service, decides whether the payment goes through: it may capture, hold for the person's approval, reject or void. Report Second Key's decision and reasons plainly. Don't retry the same purchase after a rejection unless you choose a genuinely different product.

Keep your final answer short: what you tried to buy, from where, for how much, and what Second Key decided.`;

export function buildTools(env: AgentEnv, intentId: string) {
  return [
    betaZodTool({
      name: "get_intent_summary",
      description: "Read the person's confirmed purchase request (what they asked for and the limits).",
      inputSchema: z.object({}),
      run: async () => getIntentSummary(env, intentId),
    }),
    betaZodTool({
      name: "search_products",
      description: "Search a catalog of real products across many retailers. Returns product_ids, titles and offers (retailer, price).",
      inputSchema: z.object({ query: z.string().describe("Plain-language product search, e.g. 'trail running shoes size 10'") }),
      run: async ({ query }) => searchProducts(env, query),
    }),
    betaZodTool({
      name: "submit_purchase",
      description: "Ask Second Key to buy one product from one retailer. Second Key checks it against the person's request before any money moves.",
      inputSchema: z.object({
        retailer: z.string().describe("Retailer domain from the search results, e.g. 'rei.com'"),
        product_id: z.string(),
        quantity: z.number().int().min(1).max(10),
        note: z.string().optional().describe("Optional short rationale"),
      }),
      run: async (input) => submitPurchase(env, { intent_id: intentId, ...input }),
    }),
    betaZodTool({
      name: "get_purchase_status",
      description: "Check what Second Key has done with a purchase (it may finish asynchronously).",
      inputSchema: z.object({ purchase_id: z.string() }),
      run: async ({ purchase_id }) => getPurchaseStatus(env, purchase_id),
    }),
  ];
}

export interface AgentRun {
  text: string;
  stopReason: string | null;
  turns: number;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  estimated_cost_usd: number;
  stopped_for_budget: boolean;
}

export async function runAgent(o: { env: AgentEnv; intentId: string; instruction?: string; apiKey?: string; model?: string; maxSpendUsd?: number; client?: Anthropic }): Promise<AgentRun> {
  const model = (o.model ?? "claude-haiku-5-5") as AgentModel;
  const price = AGENT_MODELS[model];
  if (!price) throw new Error(`agent model "${o.model}" is not approved (allowed: ${Object.keys(AGENT_MODELS).join(", ")})`);
  const client = o.client ?? new Anthropic({ ...(o.apiKey ? { apiKey: o.apiKey } : {}), maxRetries: 2 });
  const maxSpend = o.maxSpendUsd ?? 0.05;
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const cost = () => (usage.input_tokens * price.inputPerMTok + usage.cache_creation_input_tokens * price.inputPerMTok * price.cacheWrite5mMultiplier + usage.cache_read_input_tokens * price.inputPerMTok * price.cacheReadMultiplier + usage.output_tokens * price.outputPerMTok) / 1e6;

  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 4096,
    max_iterations: 8,
    output_config: { effort: "low" },
    system: [{ type: "text", text: AGENT_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: buildTools(o.env, o.intentId),
    messages: [{ role: "user", content: o.instruction ?? "Please buy what I asked for." }],
  });
  let last: Anthropic.Beta.BetaMessage | null = null;
  let turns = 0;
  let stoppedForBudget = false;
  for await (const message of runner) {
    turns++;
    last = message;
    const u = message.usage;
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    if (message.model !== model) throw new Error(`the API answered with ${message.model}, not the approved ${model}`);
    // Each further turn costs at most ~max_tokens output plus the growing context; stop well before the cap.
    if (cost() + (4096 * price.outputPerMTok) / 1e6 > maxSpend) {
      stoppedForBudget = true;
      break;
    }
  }
  const text = (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  return { text: stoppedForBudget ? `${text}\n[stopped: agent spend cap $${maxSpend.toFixed(2)} reached]`.trim() : text, stopReason: last?.stop_reason ?? null, turns, usage, estimated_cost_usd: Number(cost().toFixed(6)), stopped_for_budget: stoppedForBudget };
}
