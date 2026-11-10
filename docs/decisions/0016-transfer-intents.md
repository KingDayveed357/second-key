# 0016: Explicit shopping and transfer intents on one screening pipeline

> The product was called **Witness** when this was written and is now **Second Key**. The decision is unchanged unless a later ADR says otherwise.

Status: accepted for the hardening milestone (2026-10-17). Supersedes the sprint stopgap.

## Problem: where a transfer was treated as a product

In the feasibility sprint a Second Key transfer travelled through the shopping path disguised as a product.

1. **`packages/catalog/src/fixtures.ts`**: the transfer was a catalog fixture, `XFER-NEW-PAYEE`, with a "retailer" `secondkey.test`. Its amount ($1,800) was the fixture's *offer price*, and the payee was a product attribute. The payer never chose the amount. Witness read it from a catalog.
2. **`packages/core/src/checks.ts` `resolveCart`**: the "cart" was resolved from catalog facts and an offer, then screened by `screenCart`. That function applies shopping rules (retailer allowlist, quantity, size/colour/brand, market price) that mean nothing for a transfer.
3. **`packages/ai/src/components.ts` `aiScreen`**: listing integrity ("exactly one complete unit of one specific product") held a benign transfer. The stopgap skipped listing checks when `category` started with `Transfers >`. That is a string match on catalog data deciding which safety checks run. A catalog entry could switch checks off, which is exactly the kind of bypass this ADR removes.
4. **`packages/engine/src/scenarios.ts` `transferPolicy`**: a shopping policy (`products`, `retailers`, `substitution`) was pretending to be a transfer.

## Decision

The intent's **type** decides which intent-specific checks run. Two kinds of check are **shared** and cannot be skipped by either type: deterministic intent and payment policy, and AI manipulation screening. The structure after screening (authorize → HOLD → reviewer → executor → audit) is unchanged.

### Types (`packages/core`)

- `PolicyV1` stays the shopping policy, unchanged. It gains an optional `kind: "shopping"` that is never defaulted, so existing intents and their policy digests stay byte-identical.
- New `TransferPolicyV1`:
  ```
  {
    version: 1, kind: "transfer",
    payee: { id, name, first_payment },
    amount_cents, currency, expires_at,
    max_payments: 1, purpose?
  }
  ```
  The payer confirms the exact amount and payee. Nothing comes from a catalog.
- `IntentPolicy = PolicyV1 | TransferPolicyV1`, parsed by `parseIntentPolicy()`, which dispatches on `kind`.
- New `TransferRequest`:
  ```
  { kind: "transfer", intent_id, payee_id, amount_cents, currency, conversation }
  ```
  Here **`conversation` is required**: a transfer cannot be submitted without the context that is screened. If a channel has none, it must say so ("no conversation available"), and the detector answers `insufficient_information` → VERIFY → HOLD.
- `PaymentRequest = PurchaseRequest | TransferRequest`. A body without `kind` is a shopping request, as before. `PurchaseRequest.conversation` stays optional, because a scammer can also demand gift cards bought through a shop.

### Screening (`packages/core` + `packages/ai`)

| Check | Shopping | Transfer | Kind |
|---|---|---|---|
| `intent.kind` (request kind = intent kind) | ✔ | ✔ | shared, deterministic: mismatch is **fail** |
| `intent.not_expired`, `intent.purchases_left`, `currency` | ✔ | ✔ | shared, deterministic (`screenIntent`) |
| Amount cap: `max_total` / `transfer.amount` (exact) | ✔ | ✔ | deterministic |
| `transfer.payee` (request payee = confirmed payee) | | ✔ | deterministic |
| Retailer, quantity, product, category, size, colour, brand, market price | ✔ | | deterministic, shopping only |
| `ai.injection` over listing text, listing verification | ✔ | | AI, shopping only (no listing exists for a transfer) |
| `ai.manipulation` | when a conversation is supplied | **always** | shared AI; `unknown` or `pass`, never `fail` |

**Bypass guard.** `requiredAiChecks(kind, hasConversation)` lists the AI checks that must be present. `enforceRequired()` adds an `unknown` check for any missing one (→ HOLD). So a future change that forgets to run the manipulation check for a transfer holds the payment instead of silently passing it. Regression tests cover this guard.

**Transfer "cart".** For a transfer the engine *derives* a one-line cart from the confirmed policy:

- SKU `transfer:<payee.id>`;
- name "Transfer to <name> (simulated, platform-held)";
- the confirmed amount.

The PayPal order, the three-way match, the cart digest and the executor are therefore unchanged. The executor still captures only after a match and an approval, and it never reads model output.

### What the model can and cannot do

The model can only add `unknown` (HOLD) checks, or `pass` checks that don't override anything: no transfer check defers to AI. It cannot:

- capture, approve or release funds;
- change the amount or payee;
- settle a deterministic failure.

Malformed output, timeouts, refusals and missing checks all become `unknown`. Approval comes only from a human decision (or a clean screen), and capture comes only from the executor.

## Trade-offs

- **The cart representation is reused for transfers.** It is cheap and keeps the executor and three-way match untouched. The cost: transfer data sits in `purchases.cart`, and the table is still named `purchases`. A rename to `payments` is deferred, since it touches DB, API and UI for no safety gain now.
- **Transfers use the `/v1/purchases` endpoint and `agent:purchase` scope.** A separate `/v1/transfers` and a `payer` scope would be cleaner for a real product. That is deferred, but the request is already a distinct, validated type, so splitting the route later doesn't change the engine.
- **The PayPal item category stays `PHYSICAL_GOODS`** for transfers in the platform-held sandbox flow. It is cosmetic for the sandbox; revisit with the real payment flow (see `docs/secondkey/06-paypal-flows.md`).

## Migration

- **No DB migration.** Policies and requests are JSON columns.
- **Existing shopping intents** have no `kind`, so they parse as shopping. Digests are unchanged because the parser never adds `kind`.
- **Existing purchase rows** keep working: `request` without `kind` is a shopping request.
- **The sprint fixture `XFER-NEW-PAYEE` and the category-string stopgap are removed.** Old local sandbox rows that reference the fixture are history only; nothing re-screens them.
