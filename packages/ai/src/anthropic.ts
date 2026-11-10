// Anthropic provider: approved Haiku model only (models.ts), no server-side fallback, structured
// outputs (output_config.format with a Zod schema) re-validated locally, adaptive thinking with
// effort as the lever (Anthropic's guidance for Haiku 5.5), and a cache breakpoint on the static
// system prompt only. Purchase data is always in the user turn, never in the cached prefix.
//
// Retries: the SDK's own retry is disabled so every attempt is counted and budgeted here. Only
// transient failures (429, 5xx/overloaded, connection errors, timeouts) are retried, with bounded
// exponential backoff and full jitter, honouring retry-after. Auth errors, invalid requests,
// refusals, truncation and schema violations are never retried. Every failure is a value -> HOLD.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { BudgetExceeded, costOf, worstCaseCost, ZERO_USAGE, type TokenUsage, type UsageMeter } from "./cost.ts";
import { promptRef, type AiFailureReason, type AiResult, type ModelProvider, type PromptDef, type StructuredOptions } from "./llm.ts";
import { DEFAULT_MODEL, approvedModel, type ModelSpec } from "./models.ts";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  /** Haiku 5.5 defaults to "medium"; Second Key pins "low" (short structured classification). */
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  maxRetries?: number;
  meter?: UsageMeter;
  client?: Anthropic;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const isTransient = (e: unknown) =>
  e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;

export class AnthropicProvider implements ModelProvider {
  readonly provider = "anthropic";
  readonly model: string;
  readonly spec: ModelSpec;
  readonly #client: Anthropic;
  readonly #effort: NonNullable<AnthropicProviderOptions["effort"]>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #meter: UsageMeter | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(o: AnthropicProviderOptions = {}) {
    this.spec = approvedModel(o.model ?? DEFAULT_MODEL); // throws ModelNotApproved for anything else
    this.model = this.spec.id;
    if (!o.client && !o.apiKey) throw new Error("ANTHROPIC_API_KEY is required for the Anthropic provider");
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#client = o.client ?? new Anthropic({ apiKey: o.apiKey!, maxRetries: 0, timeout: this.#timeoutMs });
    this.#effort = o.effort ?? "low";
    this.#maxRetries = Math.max(0, Math.min(o.maxRetries ?? 2, 5));
    this.#meter = o.meter;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = o.random ?? Math.random;
  }

  #backoffMs(attempt: number, e: unknown): number {
    const header = (e as { headers?: { get?: (k: string) => string | null } })?.headers?.get?.("retry-after");
    const retryAfter = header ? Number(header) * 1000 : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 20_000);
    const cap = Math.min(8_000, 500 * 2 ** (attempt - 1));
    return Math.floor(this.#random() * cap);
  }

  async structured<S extends z.ZodType>(prompt: PromptDef, input: string, schema: S, opts: StructuredOptions = {}): Promise<AiResult<z.infer<S>>> {
    const started = Date.now();
    const maxTokens = opts.maxTokens ?? prompt.maxTokens;
    const worst = worstCaseCost(this.spec, { promptChars: prompt.system.length + input.length, maxTokens });
    let retries = 0;
    let usage: TokenUsage = { ...ZERO_USAGE };
    let costUsd = 0;
    let model: string | null = this.model;

    const meta = () => ({ provider: this.provider, model, promptVersion: promptRef(prompt), latencyMs: Date.now() - started, usage, costUsd, retries, cache: (usage.cache_read_input_tokens > 0 ? "hit" : usage.cache_creation_input_tokens > 0 ? "write" : "none") as "hit" | "write" | "none" });
    const finish = <T>(r: AiResult<T>): AiResult<T> => {
      this.#meter?.record({ prompt: promptRef(prompt), model: r.model ?? this.model, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), usage, cost_usd: costUsd, latency_ms: r.latencyMs, retries, cache: r.cache ?? "none" });
      return r;
    };
    const fail = (reason: AiFailureReason, detail: string): AiResult<z.infer<S>> => finish({ ok: false, reason, detail, ...meta() });

    for (;;) {
      if (opts.signal?.aborted) return fail("cancelled", "request cancelled");
      let release: () => void = () => {};
      try {
        if (this.#meter) release = this.#meter.reserve(worst);
      } catch (e) {
        if (e instanceof BudgetExceeded) return fail("budget", e.message);
        throw e;
      }
      try {
        const msg = await this.#client.messages.parse(
          {
            model: this.spec.id,
            max_tokens: maxTokens,
            system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: input }],
            output_config: { format: zodOutputFormat(schema), effort: this.#effort },
          },
          { timeout: this.#timeoutMs, maxRetries: 0, ...(opts.signal ? { signal: opts.signal } : {}) },
        );
        release();
        const u = msg.usage;
        usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 };
        costUsd = costOf(usage, this.spec);
        this.#meter?.charge(costUsd);
        model = msg.model;
        // No fallback is requested, so any other model answering is unexpected: never trust it.
        if (msg.model !== this.spec.id) return fail("error", `the API answered with ${msg.model}, not the approved ${this.spec.id}`);
        if (msg.stop_reason === "refusal") return fail("refusal", "the model declined to answer");
        if (msg.stop_reason === "max_tokens") return fail("truncated", `output hit max_tokens (${maxTokens})`);
        const checked = schema.safeParse(msg.parsed_output);
        if (msg.parsed_output == null || !checked.success) return fail("parse", "output did not match the schema");
        return finish({ ok: true, value: checked.data, ...meta() });
      } catch (e) {
        release();
        if (opts.signal?.aborted) return fail("cancelled", "request cancelled");
        if (isTransient(e) && retries < this.#maxRetries) {
          retries++;
          await this.#sleep(this.#backoffMs(retries, e));
          continue;
        }
        if (e instanceof Anthropic.APIConnectionTimeoutError) return fail("timeout", `no answer within ${this.#timeoutMs} ms`);
        if (e instanceof Anthropic.AuthenticationError) return fail("error", "authentication failed (check ANTHROPIC_API_KEY)");
        if (e instanceof Anthropic.PermissionDeniedError) return fail("error", "permission denied for this model or account");
        if (e instanceof Anthropic.APIError) return fail("error", `Anthropic API error ${e.status ?? "(connection)"}${isTransient(e) ? " after retries" : ""}`);
        return fail("error", (e as Error).name);
      }
    }
  }
}

/** Back-compat alias. */
export const AnthropicLlm = AnthropicProvider;
export type AnthropicLlmOptions = AnthropicProviderOptions;
