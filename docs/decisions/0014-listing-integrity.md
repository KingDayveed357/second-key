# 0014: Listing integrity: look for listing text that contradicts the confirmed purchase

Status: **Implemented for Checkpoint 4 review** (remediation directed by Dave, 2026-10-12). Awaiting Dave's acceptance.

## Context

The adversarial suite adv-v1 captured 10 of 17 bad carts on every run. The AI was asked only two things: whether the listing addresses agents, and whether the listing meets the shopper's explicit preferences. The deterministic checks compare merchant-supplied fields by string. So nothing caught listing text that contradicted a passed check, such as:
- a fee added after checkout;
- a subscription;
- a kids' size;
- a single shoe or a three-pack;
- a replica labelled with the brand;
- "crimson" when red was excluded;
- a category field that lies.

A fresh suite, adv-v2, was written and run **before** this change: 45 of 69 prohibited runs were captured.

## Decision

1. **One structured call, not two.** The existing semantic call (now `semantic@v3`) returns two lists: preference verdicts, as before, and one `integrity` answer per (requirement, product). No extra request per purchase.
2. **Requirements come from the confirmed policy, in code.** Each is phrased as "nothing in the listing indicates ...":
   - `item`: exactly the confirmed quantity of one complete, specific product;
   - `charges`: no fees, deposits, mandatory add-ons or recurring charges;
   - `consistency`: no part of the listing contradicts another;
   - `category`: genuinely the category, judged from the whole listing (asked even when the category label matches literally);
   - `size`: the confirmed size in the adult sizing system, with no substitution;
   - `brand`: nothing signals a copy, replica, "compatible", grey-market or another maker;
   - `colour`: not an excluded colour, including shades and marketing names.

   `item`, `charges` and `consistency` always apply; the others apply when the policy sets them.
3. **Answers:**
   - `consistent`: no contradicting text found;
   - `conflict`: contradicting text, quoted;
   - `unclear`: text that points both ways, quoted.

   Absence of information is `consistent`. Missing mandatory fields are already a deterministic HOLD (no size, colour, brand or category means `unknown`).
4. **Evidence is validated against the listing Second Key fetched.** A quote counts only if it is copied from the field the model names (`title`, `brand`, `category`, `description` or `attributes.<key>`), and is at least 12 characters or that field's entire value. A matching scrap of text or a high confidence alone is not proof. The same rule now applies to preference verdicts, which closes ADR-0012's "short quote" residual risk.
5. **Mapping (stricter only):**

| Answer | Result |
|---|---|
| `conflict`, evidence valid, confidence ≥ 0.8, hard requirement (item, category, size, brand, colour) | **REJECT** (before PayPal) |
| `conflict`, evidence valid, confidence ≥ 0.8, `charges` or `consistency` | **HOLD** (the shopper decides) |
| `conflict` with unverifiable evidence or low confidence; any `unclear` | **HOLD** |
| missing answer, out-of-range confidence, malformed output, any provider failure | **HOLD** |
| `consistent` (any confidence) | no effect |

   `consistent` adds no hold and settles nothing. Deferred category checks are settled only by a grounded preference verdict (ADR-0012), never by an integrity answer, so integrity can't weaken any check. The confidence of a `consistent` answer is therefore not used. Holding on low-confidence `consistent` answers held 4 of 4 clean smoke cases on the first live run: the model expresses "I can't confirm" as low confidence on silent listings.
6. **Authenticity is not claimed.** Brand still rests on the deterministic brand field plus the absence of contradicting signals. A merchant's own "100% authentic" is not evidence, and Second Key never states that a product is authentic.

## Payment boundary (unchanged, plus one hardening)

- The model still receives no PayPal credentials and has no capture or void path. Only the executor moves money, after a single-use approval and a fresh three-way match on PayPal's stored order.
- **New:** a capture is recorded as CAPTURED only if PayPal's capture response is COMPLETED **for exactly the approved amount and currency**. The reconciler applies the same rule to the order's stored captures. A completed capture for any other amount stays in NEEDS_RECONCILE for operator review and is never retried. Order status alone is never treated as payment success.

## Results (live Haiku, 2026-10-12)

| Suite | Before | After |
|---|---|---|
| suite1-v2 benchmark (76 × 3) | 0 false captures; clean HOLD 0% | **0 false captures** of 165 prohibited runs; clean HOLD **7.1%** (3/42, target < 15%); 75/76 passing |
| adv-v2 (29 × 3) | **45/69** prohibited runs captured | **0/69** |
| adv-v1 (19 × 3, frozen) | **30/51** captured | **0/51** |
| Sandbox judge scenarios (7) | 7/7 | **7/7** |

## Consequences and limits

- **Cost and latency:** every cart that passes deterministic screening now makes the semantic call. The full benchmark went from 276 to 354 calls and from $0.0155 to $0.0650 (about $0.0003 per screened cart). p95 screening latency went from 4.1 s to 5.3 s (5.3–6.5 s across the three suites), under the 8 s target.
- **More REJECTs where HOLD was expected.** Several adversarial cases expected to HOLD now REJECT (still safe). A rejected cart can be re-requested by the shopper.
- **Agreement:** 97.4% on the benchmark; 93.1% (adv-v2) and 94.7% (adv-v1) on the adversarial suites. Every disagreement is between HOLD and REJECT; no run disagreed about capturing.
- **New friction:** clean-08 now holds (the model reads "Waterproof, 20,000 mm" as not settling "fully waterproof").
- **Open, not fixed:** the preference verdict wrongly treats "Rated to 15°F" as violating "rated to 20°F or colder" (adv-v2 control v2-ctl-01, false reject). It was found by adv-v2 before the remediation and deliberately not tuned, so adv-v2 stays untuned.
- **Not independent:** adv-v2 was written by the same team, before the change, but around the same attack classes the remediation targets. It measures generalisation to new products and wording within known classes, not to unknown classes. Independent red-teaming is still needed.
- The model judges colour shades and size systems. It can be wrong in either direction; wrong in the unsafe direction means the deterministic checks were the only defence, as before this change.
