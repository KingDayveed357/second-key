// Server side of the Studio agent (AG Studio Agent Framework, "swapped-in model"). AG Studio's
// built-in agents speak a Responses-style protocol; this translates one turn to Anthropic's
// Messages API with the approved Haiku model and back. The key stays on the server; the console
// session gates access; a per-process spend cap bounds cost. The agent sees only the console's
// ledger data that AG Studio passes in. It has no route to Second Key's API or to PayPal.
import "server-only";

/** Must equal DEFAULT_MODEL in packages/ai/src/models.ts (asserted by a test). */
export const STUDIO_MODEL = "claude-haiku-5-5";
// Haiku 5.5 prices per MTok (packages/ai/src/models.ts, pricing version anthropic-2026-10-06).
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };

type Item = Record<string, any>;
export interface StudioTurn {
  input: Item[];
  instructions?: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: { type: "text" } | { type: "json"; name: string; schema: unknown };
}

type Block = Record<string, unknown>;
interface Msg {
  role: "user" | "assistant";
  content: Block[];
}

/** Responses-style conversation -> Anthropic messages. Consecutive same-role turns are merged. */
export function toAnthropic(turn: StudioTurn, maxTokens = 4096) {
  const system: string[] = [];
  if (turn.instructions) system.push(turn.instructions);
  const messages: Msg[] = [];
  const push = (role: Msg["role"], block: Block) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const it of turn.input ?? []) {
    if (it.type === "message" && it.kind === "input") {
      const text = (it.content ?? []).filter((c: Item) => c.type === "text").map((c: Item) => c.text).join("\n");
      if (!text) continue;
      if (it.role === "system") system.push(text);
      else push("user", { type: "text", text });
    } else if (it.type === "message" && it.role === "assistant") {
      const text = (it.content ?? []).map((c: Item) => (c.type === "text" ? c.text : c.type === "refusal" ? c.refusal : "")).join("");
      if (text) push("assistant", { type: "text", text });
    } else if (it.type === "function_call") {
      let input: unknown = {};
      try {
        input = it.arguments ? JSON.parse(it.arguments) : {};
      } catch {
        input = { _unparsed: String(it.arguments).slice(0, 2000) };
      }
      push("assistant", { type: "tool_use", id: it.callId, name: it.name, input });
    } else if (it.type === "function_call_output") {
      push("user", { type: "tool_result", tool_use_id: it.callId, content: String(it.output ?? "") });
    }
    // reasoning items are not replayed
  }
  if (!messages.length || messages[0]!.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });

  if (turn.responseFormat?.type === "json") {
    system.push(`Respond with only a JSON value (no prose, no code fences) that matches this JSON schema named ${turn.responseFormat.name}: ${JSON.stringify(turn.responseFormat.schema)}`);
  }
  const tools = (turn.tools ?? []).map((t) => ({ name: t.name, description: t.description.slice(0, 4000), input_schema: t.parameters }));
  // Cache the large, stable prefix (tools + instructions) across the agents' many turns.
  if (tools.length) (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
  const tc = turn.toolChoice;
  const tool_choice = !tools.length || !tc || tc === "auto" ? undefined : tc === "none" ? { type: "none" } : tc === "required" ? { type: "any" } : { type: "tool", name: tc.name };
  return {
    model: STUDIO_MODEL,
    max_tokens: maxTokens,
    system: system.length ? [{ type: "text", text: system.join("\n\n"), cache_control: { type: "ephemeral" } }] : undefined,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    output_config: { effort: "low" },
  };
}

/** Anthropic response -> Responses-style output items. */
export function fromAnthropic(res: Record<string, any>) {
  const output: Item[] = [];
  const texts = (res.content ?? []).filter((b: Item) => b.type === "text").map((b: Item) => b.text).join("");
  if (texts) output.push({ id: `msg_${res.id}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: texts, annotations: [] }] });
  for (const b of res.content ?? []) {
    if (b.type === "tool_use") output.push({ id: `fc_${b.id}`, kind: "output", type: "function_call", callId: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: "completed" });
  }
  const u = res.usage ?? {};
  return {
    id: String(res.id ?? `resp_${Date.now()}`),
    createdAt: Math.floor(Date.now() / 1000),
    status: res.stop_reason === "max_tokens" ? "incomplete" : "completed",
    ...(res.stop_reason === "max_tokens" ? { incompleteDetails: { reason: "max_output_tokens" } } : {}),
    output,
    usage: { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cachedInputTokens: u.cache_read_input_tokens ?? 0 },
    model: res.model,
  };
}

export const costOf = (u: Record<string, number | undefined>) =>
  ((u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) / 1_000_000;

/** Per-process spend meter for the Studio agent with a console session (default $0.50, WITNESS_STUDIO_AI_MAX_SPEND_USD). */
export const studioMeter = {
  spent: 0,
  calls: 0,
  limit: () => Number(process.env.WITNESS_STUDIO_AI_MAX_SPEND_USD ?? 0.5),
};

/**
 * The public Desk's Insights agent (ADR-0022): its own, smaller budget, so public traffic can never use
 * the operators' budget (default $0.25, WITNESS_STUDIO_AI_PUBLIC_MAX_SPEND_USD). Set
 * WITNESS_STUDIO_AI_PUBLIC=0 to require a console session again.
 */
export const publicStudioMeter = {
  spent: 0,
  calls: 0,
  limit: () => Number(process.env.WITNESS_STUDIO_AI_PUBLIC_MAX_SPEND_USD ?? 0.25),
};
export const publicStudioEnabled = () => process.env.WITNESS_STUDIO_AI_PUBLIC !== "0";

/** Per-visitor limit for the public agent: one prompt fans out into several turns, so it counts turns. */
const PUBLIC_TURNS_PER_MINUTE = Number(process.env.WITNESS_STUDIO_AI_PUBLIC_PER_MINUTE ?? 30);
const visitors = new Map<string, { start: number; n: number }>();
export function allowPublicTurn(client: string, now = Date.now()): boolean {
  const v = visitors.get(client);
  if (!v || now - v.start >= 60_000) {
    if (visitors.size > 10_000) visitors.clear();
    visitors.set(client, { start: now, n: 1 });
    return true;
  }
  return ++v.n <= PUBLIC_TURNS_PER_MINUTE;
}
