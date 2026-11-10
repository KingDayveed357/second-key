// The agent can't import Second Key packages (architecture rule), so it keeps its own allowlist.
// This test (tests may cross boundaries) keeps the two in sync.

import { expect, test } from "vitest";
import { APPROVED_MODELS } from "@witness/ai";
import { AGENT_MODELS, runAgent } from "../src/agent.ts";

test("the agent's model allowlist and prices match packages/ai", () => {
  expect(Object.keys(AGENT_MODELS)).toEqual(Object.keys(APPROVED_MODELS));
  for (const [id, p] of Object.entries(AGENT_MODELS)) {
    const spec = APPROVED_MODELS[id]!;
    expect(p).toEqual({ inputPerMTok: spec.inputPerMTok, outputPerMTok: spec.outputPerMTok, cacheWrite5mMultiplier: spec.cacheWrite5mMultiplier, cacheReadMultiplier: spec.cacheReadMultiplier });
  }
});

test("the agent refuses unapproved models before any request", async () => {
  await expect(runAgent({ env: { witnessApi: "http://x", agentKey: "k" }, intentId: "i", model: "claude-opus-5-5", apiKey: "not-used" })).rejects.toThrow(/not approved/);
});
