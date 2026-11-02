// Offline fail-safe tests for the Second Key manipulation detector (no network): every model failure or untrustworthy
// output leads to human review, invented quotes are discarded, and policy can override a "low" verdict.
import { describe, expect, test } from "vitest";
import { FakeLlm, checkManipulation, enforceRequired, requiredAiChecks, screenPaymentAi, type AiFailureReason } from "@witness/ai";
import { MANIPULATION_PROMPT, TACTICS, assess, decide, explainDecision, locate, severityOf, type Conversation } from "../src/manipulation.ts";

const conv: Conversation = {
  context: "Rose is asked to send money.",
  lines: [
    { speaker: "Caller", text: "Grandma, I need $1,800 for bail right now." },
    { speaker: "Caller", text: "Please don't tell Mom about this." },
  ],
};
const reply = (o: Record<string, unknown>) => () => ({ risk: "high", tactics: [], legitimate_explanation: "none plausible", confidence: 0.9, needs_independent_verification: true, recommended_action: "hold_and_verify", ...o });

describe("detector fail-safes", () => {
  test.each(["timeout", "refusal", "truncated", "parse", "error", "budget", "unavailable"] as AiFailureReason[])("model failure '%s' → HOLD", async (reason) => {
    const ai = new FakeLlm().on("manipulation", reply({}));
    ai.failAll(reason);
    const a = await assess(ai, conv);
    expect(a.ok).toBe(false);
    expect(a.intervention).toBe("HOLD_FOR_TRUSTED_CONTACT");
  });

  test("malformed output (schema mismatch) → HOLD", async () => {
    const a = await assess(new FakeLlm().on("manipulation", () => ({ risk: "fine", tactics: "none" })), conv);
    expect(a.intervention).toBe("HOLD_FOR_TRUSTED_CONTACT");
  });

  test("confidence outside 0..1 → HOLD", async () => {
    const a = await assess(new FakeLlm().on("manipulation", reply({ risk: "low", confidence: 7, recommended_action: "proceed" })), conv);
    expect(a.intervention).toBe("HOLD_FOR_TRUSTED_CONTACT");
  });

  test("invented quotes are discarded and reported; real quotes keep the source speaker", async () => {
    const a = await assess(
      new FakeLlm().on("manipulation", reply({ risk: "medium", tactics: [
        { tactic: "secrecy", quote: "don't tell Mom about this", speaker: "Grandson", why: "isolation" },
        { tactic: "threat", quote: "or you'll never see me again", speaker: "Caller", why: "made up" },
      ] })),
      conv,
    );
    expect(a.grounded.map((g) => g.quote)).toEqual(["don't tell Mom about this"]);
    expect(a.grounded[0]!.speaker).toBe("Caller");
    expect(a.ungrounded_quotes).toEqual(["or you'll never see me again"]);
    expect(a.intervention).toBe("HOLD_FOR_TRUSTED_CONTACT");
  });

  test("medium risk with no verifiable evidence → verify, not proceed", async () => {
    const a = await assess(new FakeLlm().on("manipulation", reply({ risk: "medium", tactics: [{ tactic: "urgency", quote: "act now or else", speaker: "Caller", why: "x" }] })), conv);
    expect(a.grounded).toHaveLength(0);
    expect(a.intervention).toBe("VERIFY_BEFORE_PAYING");
  });

  test("a scrap of matching text is not evidence", () => {
    expect(locate(conv, "bail")).toBe(-1);
    expect(locate(conv, "$1,800 for bail right now")).toBe(0);
  });

  test("quoted evidence outranks the model's own label: one severe quoted tactic holds even when the model says 'low'", () => {
    const g = (tactic: "safe_account" | "remote_access" | "payment_instruction_change" | "instruction_to_ai") => ({ tactic, quote: "q", speaker: "s", model_speaker: "s", why: "w", line_index: 0 });
    const low = { risk: "low" as const, tactics: [], legitimate_explanation: "", confidence: 0.9, needs_independent_verification: false, recommended_action: "proceed" as const };
    for (const t of ["safe_account", "remote_access", "payment_instruction_change", "instruction_to_ai"] as const) expect(explainDecision(low, [g(t)])).toMatchObject({ intervention: "HOLD_FOR_TRUSTED_CONTACT", rule: "E1 severe pattern quoted" });
    expect(decide(null, [])).toBe("HOLD_FOR_TRUSTED_CONTACT");
  });

  test("the model's label alone, with nothing verifiable, asks for a check and says it isn't a finding", () => {
    const high = { risk: "high" as const, tactics: [], legitimate_explanation: "", confidence: 0.9, needs_independent_verification: true, recommended_action: "hold_and_verify" as const };
    const e = explainDecision(high, []);
    expect(e).toMatchObject({ intervention: "VERIFY_BEFORE_PAYING", rule: "E5 concern without evidence" });
    expect(e.reason).toMatch(/not a finding/);
  });

  test("one moderate quoted pattern: held if the model is concerned, not if it reads the conversation as innocent", () => {
    const g = { tactic: "urgency" as const, quote: "q", speaker: "s", model_speaker: "s", why: "w", line_index: 0 };
    const out = (risk: "low" | "medium") => ({ risk, tactics: [], legitimate_explanation: "", confidence: 0.8, needs_independent_verification: false, recommended_action: "proceed" as const });
    expect(explainDecision(out("medium"), [g]).intervention).toBe("HOLD_FOR_TRUSTED_CONTACT");
    expect(explainDecision(out("low"), [g])).toMatchObject({ intervention: "PROCEED", rule: "E4 one pattern, innocent reading" });
    // The same tactic quoted twice is still one pattern.
    expect(explainDecision(out("low"), [g, { ...g, quote: "q2" }]).intervention).toBe("PROCEED");
  });

  test("every tactic has a fixed severity, and the prompt in use names every tactic", () => {
    expect(TACTICS.filter((t) => severityOf(t) === "severe").sort()).toEqual(["instruction_to_ai", "payment_instruction_change", "remote_access", "safe_account", "threat", "unusual_payment_channel"]);
    expect(`${MANIPULATION_PROMPT.id}@${MANIPULATION_PROMPT.version}`).toBe("manipulation@v2");
    for (const t of TACTICS) expect(MANIPULATION_PROMPT.system).toContain(`- ${t}:`);
  });
});

describe("checkManipulation (the engine's screening check)", () => {
  test("grounded high risk → unknown (HOLD), detail carries only verified quotes", async () => {
    const ai = new FakeLlm().on("manipulation", reply({ tactics: [
      { tactic: "urgency", quote: "I need $1,800 for bail right now", speaker: "Caller", why: "deadline" },
      { tactic: "secrecy", quote: "wire it to the escrow agent tonight", speaker: "Caller", why: "invented" },
    ] }));
    const c = await checkManipulation(ai, conv);
    expect(c).toMatchObject({ id: "ai.manipulation", result: "unknown", kind: "ai" });
    expect(c.detail).toMatch(/hold for trusted contact/);
    expect(c.detail).toContain("I need $1,800 for bail right now");
    expect(c.detail).not.toContain("escrow agent");
  });

  test("never 'fail': the trusted contact decides, the model cannot reject on its own", async () => {
    for (const risk of ["high", "medium", "insufficient_information"]) {
      const c = await checkManipulation(new FakeLlm().on("manipulation", reply({ risk })), conv);
      expect(c.result).toBe("unknown");
    }
  });

  test("model unavailable → unknown (HOLD), never pass", async () => {
    const ai = new FakeLlm();
    ai.failAll("timeout");
    const c = await checkManipulation(ai, conv);
    expect(c).toMatchObject({ result: "unknown" });
    expect(c.detail).toMatch(/unavailable/);
  });

  test("confident low risk with no severe tactics → pass", async () => {
    const c = await checkManipulation(new FakeLlm().on("manipulation", reply({ risk: "low", confidence: 0.9, recommended_action: "proceed" })), conv);
    expect(c.result).toBe("pass");
  });
});

describe("required AI checks (ADR-0016 guard, ADR-0019 optional evidence)", () => {
  test("a supplied conversation must be analysed; shopping always needs the listing check", () => {
    expect(requiredAiChecks("transfer", false)).toEqual([]);
    expect(requiredAiChecks("transfer", true)).toEqual(["ai.manipulation"]);
    expect(requiredAiChecks("shopping", false)).toEqual(["ai.injection"]);
    expect(requiredAiChecks("shopping", true)).toEqual(["ai.injection", "ai.manipulation"]);
  });

  test("a missing required check is added as unknown (HOLD)", () => {
    const out = enforceRequired(["ai.manipulation"], []);
    expect(out).toEqual([expect.objectContaining({ id: "ai.manipulation", result: "unknown" })]);
    expect(enforceRequired(["ai.manipulation"], [{ id: "ai.manipulation", result: "pass", detail: "" }])).toHaveLength(1);
  });

  test("a transfer without a conversation makes no model call (its rules come from the payer's policy)", async () => {
    const ai = new FakeLlm().on("manipulation", reply({ risk: "low", recommended_action: "proceed" }));
    expect(await screenPaymentAi(ai, { kind: "transfer" })).toEqual([]);
    expect(ai.calls).toHaveLength(0);
  });

  test("a transfer calls only the manipulation prompt", async () => {
    const ai = new FakeLlm().on("manipulation", reply({ risk: "low", recommended_action: "proceed" }));
    const out = await screenPaymentAi(ai, { kind: "transfer" }, conv);
    expect(ai.calls.map((c) => c.prompt)).toEqual(["manipulation"]);
    expect(out.map((c) => c.id)).toEqual(["ai.manipulation"]);
  });
});

describe("explainDecision (the reason shown to people is the rule that ran)", () => {
  test("every risk level and evidence combination maps to the same intervention as decide()", () => {
    const g = (tactic: string) => ({ tactic, quote: "q", speaker: "s", model_speaker: "s", why: "w", line_index: 0 }) as never;
    const out = (risk: string) => ({ risk, tactics: [], legitimate_explanation: "", confidence: 0.5, needs_independent_verification: false, recommended_action: "proceed" }) as never;
    const cases: [unknown, unknown[]][] = [
      [null, []],
      [out("low"), [g("threat")]],
      [out("low"), [g("urgency"), g("secrecy")]],
      [out("medium"), [g("urgency")]],
      [out("low"), [g("urgency")]],
      [out("high"), []],
      [out("insufficient_information"), []],
      [out("low"), []],
    ];
    const rules = new Set<string>();
    for (const [o, gr] of cases) {
      const e = explainDecision(o as never, gr as never);
      expect(e.intervention).toBe(decide(o as never, gr as never));
      rules.add(e.rule);
    }
    expect([...rules].map((r) => r.slice(0, 2)).sort()).toEqual(["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"]);
  });
});
