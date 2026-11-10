# 0003: Screen the cart before creating the PayPal order (REJECT outcome)

Status: **Accepted** (Dave, Checkpoint 2, 2026-10-11) 

## Context

With a saved wallet, PayPal authorizes in the **same call** that creates the order (Gate 2 evidence: order `COMPLETED`, authorization `CREATED`, no separate `/authorize`). If Second Key creates the order first and checks afterwards, every policy violation places a hold on the shopper's funds that is then voided. The shopper may see that hold (a stated limit). The brief's decision table has three outcomes, all after authorization.

## Options

1. Keep the brief: authorize, then decide CAPTURE/HOLD/VOID.
2. **Add a pre-authorization screen.** Deterministic violations (and high-confidence AI violations) → **REJECT**: no order, no hold, $0. Anything that passes, or needs a human, is authorized; then VERIFY → CAPTURE/HOLD/VOID.
3. Screen only, with no post-authorization match. (Loses the cart-swap catch, which is the product's most distinctive feature.)

## Decision (proposed)

Option 2.

## Consequences

- "$0 moved, no hold" becomes literally true for policy violations. That's a cleaner honest-limits story and a sharper cold open.
- Four outcomes instead of three. The UI labels REJECT as "Blocked: never sent to PayPal", and the decision table gains a row.
- HOLD still authorizes on purpose: the hold *is* the feature (funds genuinely reserved while the shopper decides).
- The three-way match still runs on every authorized order, so swaps are caught.
