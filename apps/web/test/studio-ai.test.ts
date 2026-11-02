// Studio agent translation (AG Studio Responses-style turn <-> Anthropic Messages), offline.

import { describe, expect, test } from "vitest";
import { DEFAULT_MODEL } from "../../../packages/ai/src/models.ts";
import { STUDIO_MODEL, allowPublicTurn, costOf, fromAnthropic, publicStudioMeter, studioMeter, toAnthropic } from "../lib/server/studio-ai.ts";

describe("studio agent model", () => {
  test("uses the one approved model", () => {
    expect(STUDIO_MODEL).toBe(DEFAULT_MODEL);
    expect(toAnthropic({ input: [] }).model).toBe(DEFAULT_MODEL);
  });
});

describe("toAnthropic", () => {
  const turn = {
    instructions: "You are the lead agent.",
    input: [
      { id: "1", kind: "input", type: "message", role: "system", status: "completed", content: [{ type: "text", text: "Data: ledger, holds, blocked." }] },
      { id: "2", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: "Show blocked value by reason" }] },
      { id: "3", kind: "output", type: "function_call", callId: "call_1", name: "get_schema", arguments: '{"source":"blocked"}' },
      { id: "4", type: "function_call_output", callId: "call_1", output: '{"fields":["reason","value"]}', status: "completed" },
      { id: "5", kind: "output", type: "reasoning", summary: [] },
      { id: "6", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Building it." }] },
    ],
    tools: [
      { name: "get_schema", description: "Read a data source schema", parameters: { type: "object", properties: { source: { type: "string" } } } },
      { name: "create_widget", description: "Create a widget", parameters: { type: "object" } },
    ],
    toolChoice: "required" as const,
  };

  test("maps messages, tool calls and results in order; system inputs join the system prompt", () => {
    const b = toAnthropic(turn);
    expect(b.system![0]!.text).toContain("You are the lead agent.");
    expect(b.system![0]!.text).toContain("Data: ledger, holds, blocked.");
    expect(b.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(b.messages[1]!.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "get_schema", input: { source: "blocked" } });
    expect(b.messages[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_1", content: '{"fields":["reason","value"]}' });
    expect(b.messages[3]!.content[0]).toEqual({ type: "text", text: "Building it." });
  });

  test("tools become input_schema tools; the stable prefix is cached; tool choice maps", () => {
    const b = toAnthropic(turn) as any;
    expect(b.tools.map((t: any) => t.name)).toEqual(["get_schema", "create_widget"]);
    expect(b.tools[0].input_schema).toEqual(turn.tools[0]!.parameters);
    expect(b.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(b.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(b.tool_choice).toEqual({ type: "any" });
    expect((toAnthropic({ ...turn, toolChoice: { name: "create_widget" } }) as any).tool_choice).toEqual({ type: "tool", name: "create_widget" });
    expect((toAnthropic({ ...turn, toolChoice: "auto" }) as any).tool_choice).toBeUndefined();
  });

  test("conversation always starts with a user turn; consecutive same-role items merge", () => {
    const b = toAnthropic({ input: [{ type: "function_call", callId: "c", name: "x", arguments: "{}" }, { type: "function_call", callId: "d", name: "y", arguments: "not json" }] });
    expect(b.messages[0]!.role).toBe("user");
    expect(b.messages[1]!.content).toHaveLength(2);
    expect((b.messages[1]!.content[1] as any).input).toEqual({ _unparsed: "not json" });
  });

  test("a JSON response format is requested in the system prompt", () => {
    const b = toAnthropic({ input: [], responseFormat: { type: "json", name: "plan", schema: { type: "object" } } });
    expect(b.system![0]!.text).toMatch(/JSON schema named plan/);
  });
});

describe("fromAnthropic", () => {
  test("text and tool_use blocks become output items with usage", () => {
    const r = fromAnthropic({
      id: "msg_1",
      model: DEFAULT_MODEL,
      stop_reason: "tool_use",
      content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "toolu_1", name: "create_widget", input: { type: "bar-chart-grouped" } }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    });
    expect(r.status).toBe("completed");
    expect(r.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "On it." }] });
    expect(r.output[1]).toMatchObject({ type: "function_call", callId: "toolu_1", name: "create_widget", arguments: '{"type":"bar-chart-grouped"}' });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 20, cachedInputTokens: 900 });
  });

  test("truncation is reported as incomplete", () => {
    expect(fromAnthropic({ id: "m", stop_reason: "max_tokens", content: [] })).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
  });

  test("cost uses Haiku prices including cache reads and writes", () => {
    expect(costOf({ input_tokens: 1_000_000 })).toBeCloseTo(0.1);
    expect(costOf({ output_tokens: 1_000_000 })).toBeCloseTo(0.5);
    expect(costOf({ cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(0.135);
  });
});

describe("public Insights agent limits (ADR-0022)", () => {
  test("a separate, smaller budget than the operators'", () => {
    expect(publicStudioMeter).not.toBe(studioMeter);
    expect(publicStudioMeter.limit()).toBeLessThan(studioMeter.limit());
  });
  test("per-visitor turn limit, reset after a minute, independent per visitor", () => {
    const t0 = 5_000_000;
    let ok = 0;
    for (let i = 0; i < 40; i++) if (allowPublicTurn("9.9.9.9", t0)) ok++;
    expect(ok).toBe(30);
    expect(allowPublicTurn("8.8.8.8", t0)).toBe(true);
    expect(allowPublicTurn("9.9.9.9", t0 + 61_000)).toBe(true);
  });
});
