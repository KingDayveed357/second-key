# 0002: Build the human-not-present design

> The product was called **Witness** when this was written and is now **Second Key**. The decision is unchanged unless a later ADR says otherwise.

Status: **Accepted** (Dave, "proceed", 2026-10-11) · Context: Checkpoint 1

## Context

BRIEF's decision rule depended on Gate 2 (authorization with a saved wallet, buyer absent). Stage 1 passed Gates 0–3. Gates 2 and 3 passed twice, including a cart swap with no buyer present (`docs/spike-results.md`). Gate 4 was blocked by the spike's method (the dispute-create API isn't documented), not by a gap in the design.

## Options

1. Human-not-present: authorize with `vault_id`; Witness decides capture/hold/void.
2. Buyer approval on every order (the fallback if Gate 2 had failed).
3. Both, with human-present as an optional path.

## Decision

Option 1 as the core. The human-present path (spike 02's flow) stays available as an optional judge path if time allows (cut list).

## Consequences

- Judges never need to log in to PayPal; the demo shopper's vault is pre-saved.
- Production needs PayPal vault eligibility review (stated honest limit).
- Gate 4 continues through a buyer-opened sandbox dispute (ADR-0010).
