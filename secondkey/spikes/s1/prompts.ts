// Prompt versions evaluated in S1. v1 is the baseline; any revision is added here with the hypothesis
// that motivated it, and is judged on the holdout split it was not tuned on.
import type { PromptDef } from "@witness/ai";
import { MANIPULATION_V1, MANIPULATION_V2 } from "../detector.ts";

export const PROMPTS_BY_TAG: Record<string, PromptDef> = {
  v1: MANIPULATION_V1,
  // v2 hypothesis: naming payment_instruction_change and instruction_to_ai, and asking for a reason
  // specific to the conversation, catches payee-redirect scams and text aimed at the AI without new
  // false positives on the benign set (ADR-0021).
  v2: MANIPULATION_V2,
};
