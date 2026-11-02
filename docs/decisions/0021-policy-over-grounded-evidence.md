# 0021: The conversation check decides on quoted evidence, not on the model's label

Status: accepted (2026-11-02). Amends the decision rules in `packages/ai/src/manipulation.ts` (R0–R6) and the manipulation prompt (v1 → v2).

## Problem

- **The "deterministic" policy ran on the model's opinion.** R1 held any payment the model called `high`, whether or not a single quote was found in the text. R6 let a `low` verdict through even with one severe tactic quoted ("move it to a protected account"). The quotes were checked by code, but they didn't decide anything.
- **The taxonomy had no name for the most common invoice fraud.** A message changing the payee or account was reported as "Identity can't be confirmed" (observed live on `/try`, 2026-11-02). Text addressed to the AI had no tactic either.
- **People read boilerplate, not the reason.** The UI showed fixed copy per tactic ("Gift cards, crypto or wire transfers…") even when the model had written a specific reason, and a weak quote ("Love you x") read as strong evidence.
- **In the demo, the AI never changed an outcome.** The payer's rule alone paused the scam call, so "what is the AI for?" had no visible answer.

## Decision

**1. Fixed severity per tactic.** Severe tactics ask for something hard to undo, or hand control to someone else: `safe_account`, `remote_access`, `unusual_payment_channel`, `threat`, `payment_instruction_change`, `instruction_to_ai`. All others are moderate.

**2. Rules over grounded quotes** (only quotes code found in the text count):

| Rule | When | Outcome |
|---|---|---|
| E0 | No usable answer from the model | HOLD (technical failure, not a finding) |
| E1 | A severe tactic is quoted | HOLD, whatever the model's label |
| E2 | Two or more different tactics are quoted | HOLD |
| E3 | One moderate tactic is quoted and the model rates the risk medium or high | HOLD |
| E4 | One moderate tactic is quoted and the model reads the conversation as legitimate | PROCEED (the quote is still shown) |
| E5 | The model is concerned, but nothing it quoted is in the text | VERIFY (holds; labelled "not a finding") |
| E6 | The model says there isn't enough to judge | VERIFY (holds) |
| E7 | Nothing quoted, model sees nothing | PROCEED |

The model's label is only a tie-breaker. It can never lift a pause that quoted evidence requires, and on its own it can only ask for a check. Every decision records its rule id: in the check detail, on `/try`, and on the Desk. Compared with R0–R6, E1 is stricter (one severe quote holds, where R5 needed two). E5 still holds, but no longer calls an unverifiable opinion "high risk". E4 lets one mild, innocently read pattern through, such as a real emergency with a deadline.

**3. Prompt `manipulation@v2`** ([prompts/manipulation.v2.md](../../packages/ai/prompts/manipulation.v2.md)):
- adds `payment_instruction_change` and `instruction_to_ai`;
- asks for a reason specific to this conversation, not generic advice;
- says an invitation to verify only reassures when it points somewhere the person already trusts;
- says ordinary affection is not emotional manipulation.

v1 stays available for the S1 baseline (`--tag v1`).

**4. The reason shown is the model's, labelled as such.** Each finding shows the model's own sentence first, with the general tip under it.

**5. A scenario only the evidence catches.** "The bank's fraud team" asks Rose for $450 to a "protected account" and to install an app. That is below her $500 rule, so the rule passes. The shared call pauses it (E1: safe account, remote access), and Sarah decides. Without the conversation it goes through: the honest boundary of a rule-plus-evidence design, tested and stated.

The payer's age is also removed from the model's context in the demo scenarios. The model judges the conversation, not the person.

## Not yet verified

- **The live model has not been re-evaluated on v2.** There is no Anthropic key on the machine where this was built. Before submission, run the S1 set on both prompts and publish both results, including any new false positives on the benign set:
  - `npx tsx secondkey/spikes/s1/run.ts --tag v2 --split holdout`
  - `npx tsx secondkey/spikes/s1/run.ts --tag v2 --set hard`
- The rule set is tested with the fake model (`packages/ai/test/manipulation.test.ts`, `apps/api/test/guardian.db.test.ts`). Those tests check the policy, not detection quality.
