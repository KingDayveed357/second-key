# 0004: Witness creates the PayPal order from its verified cart, through a checkout adapter

> The product was called **Witness** when this was written and is now **Second Key**. The decision is unchanged unless a later ADR says otherwise.

Status: **Accepted** (Dave, Checkpoint 2, 2026-10-11) 

## Context

Someone has to create the PayPal order. If the MoR platform's own checkout creates it, that checkout also needs the PayPal secret, so two components could capture. If Witness creates it, a "cart swap" seems impossible by construction, and the Gate 3 story needs an honest framing.

## Options

1. Platform checkout creates orders; Witness only verifies and captures. Realistic, but the secret lives in two places.
2. **Witness creates orders** from the verified cart through a pluggable **checkout adapter** (verified lines → PayPal `purchase_units`). The three-way match compares the approval with PayPal's **stored** order.
3. Witness creates orders with no adapter seam.

## Decision (proposed)

Option 2. One credential holder (the Witness zone). The adapter is the realistic seam where real integrations go wrong (merchant order systems, SKU mapping, promotions). The demo's swap scenario installs a faulty adapter, honestly described as "simulating a buggy or compromised checkout integration".

## Consequences

- The cart-swap catch is a defence against adapter bugs, tampering, later `PATCH` calls, extra purchase units and payee changes. It is not a claim that PayPal changes orders.
- Exactly one purchase unit per Witness order; the match rejects more.
- Option 1 remains a future integration mode ("verify-only"), documented in the README.
