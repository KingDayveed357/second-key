// The single source of truth for which models Second Key may call and what they cost.
// Only models listed here can be used; anything else is a configuration error at startup.
//
// Source: Anthropic model table and Claude Haiku 5.5 migration notes in the Claude API reference
// (cached 2026-10-06), re-checked live through the Models API by `pnpm ai:smoke`. Update the
// pricing block when Anthropic changes rates, and bump PRICING_VERSION.

export const PRICING_VERSION = "anthropic-2026-10-06";

export interface ModelSpec {
  provider: "anthropic";
  id: string;
  /** USD per million tokens, for prompts at or below `longContextThreshold` tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Prompts above this many input tokens are billed at the long-context rates. */
  longContextThreshold: number;
  longInputPerMTok: number;
  longOutputPerMTok: number;
  /** Multipliers on the input rate. */
  cacheWrite5mMultiplier: number;
  cacheReadMultiplier: number;
  /** Shorter cache prefixes silently don't cache. */
  minCacheableTokens: number;
}

export const APPROVED_MODELS: Record<string, ModelSpec> = {
  "claude-haiku-5-5": {
    provider: "anthropic",
    id: "claude-haiku-5-5",
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longContextThreshold: 100_000,
    longInputPerMTok: 0.5,
    longOutputPerMTok: 2.5,
    cacheWrite5mMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    minCacheableTokens: 512,
  },
};

export const DEFAULT_MODEL = "claude-haiku-5-5";

export class ModelNotApproved extends Error {}

export function approvedModel(id: string): ModelSpec {
  const spec = APPROVED_MODELS[id];
  if (!spec) throw new ModelNotApproved(`model "${id}" is not approved for Second Key (allowed: ${Object.keys(APPROVED_MODELS).join(", ")})`);
  return spec;
}
