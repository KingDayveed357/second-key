"use client";

// Browser half of the Studio agent: an AG Studio LLM adapter that sends each turn to this site's
// /api/studio-ai route (which holds the key and calls Haiku) and replays the result as Studio events.
import { createAiHarness, directLlmRunner, type AgLlmAdapter, type AgLlmRequest, type AgLlmResponse } from "ag-studio";

export function witnessAdapter(): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options) {
      const complete: Promise<AgLlmResponse> = fetch("/api/studio-ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: request.input, instructions: request.instructions, tools: request.tools, toolChoice: request.toolChoice, responseFormat: request.responseFormat }),
        ...(options?.signal ? { signal: options.signal } : {}),
      }).then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          return { id: `err_${Date.now()}`, createdAt: Math.floor(Date.now() / 1000), status: "failed", output: [], error: { code: String(r.status), message: body?.detail ?? body?.title ?? "Studio agent unavailable" } } as AgLlmResponse;
        }
        return body as AgLlmResponse;
      });
      async function* events() {
        const res = await complete;
        if (res.error) {
          yield { type: "RUN_ERROR" as const, message: res.error.message, code: res.error.code };
          return;
        }
        for (const item of res.output as any[]) {
          if (item.type === "message") {
            const text = (item.content ?? []).map((c: any) => c.text ?? "").join("");
            yield { type: "TEXT_MESSAGE_START" as const, messageId: item.id, role: "assistant" as const };
            if (text) yield { type: "TEXT_MESSAGE_CONTENT" as const, messageId: item.id, delta: text };
            yield { type: "TEXT_MESSAGE_END" as const, messageId: item.id };
          } else if (item.type === "function_call") {
            yield { type: "TOOL_CALL_START" as const, toolCallId: item.callId, toolCallName: item.name };
            yield { type: "TOOL_CALL_ARGS" as const, toolCallId: item.callId, delta: item.arguments };
            yield { type: "TOOL_CALL_END" as const, toolCallId: item.callId };
          }
        }
      }
      return { stream: { [Symbol.asyncIterator]: () => events() }, complete };
    },
  };
}

export const PROMPT_STARTERS = [
  { label: "Blocked value by reason", prompt: "Build a widget showing the total value blocked, by reason, from the blocked data source." },
  { label: "Decisions by state", prompt: "Show how many purchases ended in each state, as a chart." },
  { label: "Why were purchases blocked?", prompt: "Which checks blocked the most value, and how much did each block?" },
  { label: "What is held right now?", prompt: "Which purchases are held for the shopper, and when does each auto-void?" },
];

// ---- custom agents on top of Studio's built-in ones (Studio Agent Framework) ------------------
// A Second Key lead fronts the chat. It delegates questions about payment decisions to a Second Key
// analyst (a custom agent that queries the ledger and knows what Second Key's checks mean), and
// delegates building or editing widgets to Studio's built-in page, widget, data and planning agents.
// Every agent runs on Haiku through the same server route.

const WITNESS_CONTEXT = `Second Key screens AI shopping agents' carts before PayPal moves money. Data sources:
- ledger: one row per purchase. state is CAPTURED (paid), REJECTED (blocked before PayPal), VOIDED (authorization released), HELD (waiting for the shopper) or in progress. amount is USD. reason is the first check that did not pass.
- holds: purchases waiting for the shopper, with the time Second Key auto-voids them.
- blocked: value and count of rejected or voided purchases by reason.
"Blocked value" means REJECTED plus VOIDED amounts. Second Key never captures without a consumed single-use approval. You only read this data; you cannot approve, capture, void or change anything.`;


/**
 * A lead agent and a domain analyst (custom agents) over Studio's built-in page, widget, data and planning
 * agents. The analyst only reads (viewSchema, executeQuery); nothing here can change a payment.
 */
function makeHarness(o: { prefix: string; name: string; context: string; analystFocus: string; analystDescription: string; starters: { label: string; prompt: string }[] }) {
  return ({ api }: { api: any }) =>
    createAiHarness(api, ({ tools, builtIn }: any) => {
      const adapter = witnessAdapter();
      const builtins = (["data", "page", "widget", "planning"] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter }));
      const analyst = directLlmRunner({
        id: `${o.prefix}-analyst`,
        name: `${o.name} analyst`,
        adapter,
        description: o.analystDescription,
        schema: builtIn.data.schema,
        instructions: () => `${o.context}\n${o.analystFocus}`,
        tools: () => [tools.studio.viewSchema(), tools.studio.executeQuery()],
      } as any);
      const lead = directLlmRunner({
        id: `${o.prefix}-lead`,
        name: o.name,
        adapter,
        description: `Front agent for the ${o.name} dashboard.`,
        schema: (s: any) => s.undefined(),
        instructions: () =>
          `${o.context}\nYou coordinate. Delegate questions about decisions, reasons or amounts to ${o.prefix}-analyst. Delegate creating or changing widgets and pages to the page agent (it adds widgets) and the widget agent (it configures them). Keep replies short.`,
        tools: () => [tools.studio.viewSchema(), tools.delegateTo([`${o.prefix}-analyst`, "page", "widget", "data", "planning"])],
      } as any);
      return { agents: [lead, analyst, ...builtins], primary: `${o.prefix}-lead`, promptStarters: o.starters };
    });
}

export const witnessHarness = makeHarness({
  prefix: "operator",
  name: "Second Key (operator)",
  context: WITNESS_CONTEXT,
  analystDescription:
    "Answers questions about Second Key payment decisions from the ledger: why purchases were rejected, held or voided, how much value each check blocked, and what is waiting for shoppers. Use for any question about decisions, reasons or amounts.",
  analystFocus: "Answer with numbers from queries, in two to four short sentences. Name the check (for example colour, size, market price, prompt injection, PayPal order match) in plain words.",
  starters: PROMPT_STARTERS,
});

// ---- the Protection Desk's Insights (public, read-only; ADR-0022) --------------------------------

const SECOND_KEY_CONTEXT = `Second Key pauses payments made under pressure: a payer's own rule, or quoted evidence of manipulation, holds a payment; only the payer's trusted contact can approve it; PayPal confirms the outcome. Data source "incidents" has one row per payment Second Key screened:
- workflow: Transfer (a person paying) or Agent purchase (an AI agent buying for a person).
- amount (USD) and counterparty (who was being paid, or what was being bought).
- pattern: the strongest pressure pattern the AI OBSERVED with quoted evidence, or "None found". evidence: how many quoted lines.
- policy: what the deterministic RULES decided (Review required, Refused by rule, Order mismatch: cancelled, Allowed).
- review: what the PERSON decided (Not needed, Awaiting, Approved, Denied, Cancelled by payer, Auto-released, Intent revoked); decided_by: who.
- authorization and capture: what PAYPAL recorded. resolution: Needs attention, In progress or Resolved.
Keep these four facts separate: an AI observation is not a finding, a rule is not a person's decision, and a decision is not money moving until PayPal says so. "Stopped" means Refused by rule plus Order mismatch: cancelled plus Denied/Cancelled/Auto-released amounts. Data source "mandates" has one row per AI agent purchase verified under an AP2 mandate (Google's Agent Payments Protocol): product (catalog Channel3 = a real product, Scripted = a fixed demo product), retailer, amount, run, then the layers in order: ap2_layer (AP2's own constraints: listed item, amount, merchant, payee), facts_layer (Second Key's rules, such as colour, checked on product facts it fetched and signed), paypal_layer (PayPal's stored order must match the verified checkout), and stopped_by (the layer that stopped it, or "Nothing: bought"). ap2_alone = 1 when AP2's own checks passed but Second Key or PayPal's order stopped the purchase. captured = USD captured on PayPal.
This is synthetic demo data on the PayPal sandbox. You only read it; you cannot approve, cancel or change anything.`;

export const secondKeyHarness = makeHarness({
  prefix: "secondkey",
  name: "Second Key",
  context: SECOND_KEY_CONTEXT,
  analystDescription:
    "Answers questions about Second Key incidents: what the AI observed, what the rules decided, who decided paused payments, what PayPal recorded, and how much money was stopped or is still waiting. Use for any question about incidents, decisions, patterns or amounts, and about AI agent purchases under AP2 mandates (data source \"mandates\").",
  analystFocus: "Answer with numbers from queries, in two to four short sentences. Say which of the four facts (AI observation, rule, person, PayPal) your answer is about.",
  starters: [
    { label: "Who decided the paused payments?", prompt: "Of the payments that were held for review, how many did each person or outcome decide? Show it as a chart." },
    { label: "Which pressure patterns appear most?", prompt: "Which pressure patterns did the AI observe most often, and in how much money?" },
    { label: "Money stopped, by workflow", prompt: "How much money did Second Key stop for transfers versus agent purchases?" },
    { label: "What is waiting for a person?", prompt: "Which payments are still waiting for a person to decide?" },
    { label: "What did AP2 alone miss?", prompt: "Of the agent purchases under AP2 mandates, how many would AP2 alone have allowed, and which layer stopped each? Show it as a chart." },
  ],
});
