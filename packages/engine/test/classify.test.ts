// ADR-0020 §4: why a payment is held is classified from structured check facts, never from wording.
// A check that couldn't run is a technical failure (ASSESSMENT_UNAVAILABLE), never a finding.

import { describe, expect, test } from "vitest";
import { FakeLlm, checkManipulation, enforceRequired } from "@witness/ai";
import { classifyHold } from "../src/protection.ts";

const CONV = { context: "", lines: [{ speaker: "Caller", text: "I need it for bail right now." }] };
const row = (c: { id: string; kind?: string; unavailable?: boolean }) => ({ checkId: c.id, kind: c.kind ?? "deterministic", unavailable: c.unavailable === true });

describe("hold classification", () => {
  test("a required check that never ran is ASSESSMENT_UNAVAILABLE, not a conversation concern", () => {
    const [missing] = enforceRequired(["ai.manipulation"], []);
    expect(missing).toMatchObject({ id: "ai.manipulation", result: "unknown", unavailable: true });
    expect(classifyHold([row(missing!)])).toEqual(["ASSESSMENT_UNAVAILABLE"]);
  });

  test("a model failure is flagged unavailable; a real finding is not", async () => {
    const down = new FakeLlm();
    down.failAll("timeout");
    const failed = await checkManipulation(down, CONV);
    expect(failed).toMatchObject({ result: "unknown", unavailable: true });

    const found = await checkManipulation(
      new FakeLlm().on("manipulation", () => ({
        risk: "high",
        tactics: [{ tactic: "urgency", quote: "I need it for bail right now.", speaker: "Caller", why: "pressure" }],
        legitimate_explanation: "none plausible",
        confidence: 0.9,
        needs_independent_verification: true,
        recommended_action: "hold_and_verify",
      })),
      CONV,
    );
    expect(found.result).toBe("unknown");
    expect(found.unavailable).toBeUndefined();
    expect(classifyHold([row(failed)])).toEqual(["ASSESSMENT_UNAVAILABLE"]);
    expect(classifyHold([row(found)])).toEqual(["EVIDENCE_CONCERN"]);
  });

  test("wording doesn't classify: a finding that mentions 'unavailable' stays a finding", () => {
    expect(classifyHold([{ checkId: "ai.manipulation", kind: "ai", unavailable: false }])).toEqual(["EVIDENCE_CONCERN"]);
  });

  test("the payer's rule, listing checks and mixed reasons", () => {
    expect(classifyHold([row({ id: "transfer.review_rule" }), row({ id: "ai.manipulation", kind: "ai" }), row({ id: "size" })])).toEqual(["EVIDENCE_CONCERN", "LISTING_OR_FACTS", "POLICY_REVIEW"]);
  });
});
