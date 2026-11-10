# 0010: Disputes: buyer-opened in the sandbox, evidence submitted by Second Key

Status: **Accepted** (Dave, Checkpoint 2, 2026-10-11) 

## Context

Spike 05 created disputes with an undocumented `POST /v1/customer/disputes` plus a `PayPal-Auth-Assertion` header impersonating the buyer, and got 400 "No permissions to set target_client_id". The current Disputes v1 schema exposes only `GET` on that path (**Verified**). The merchant-side actions are documented, including the sandbox-only `require-evidence` and `adjudicate` (**Verified**).

## Options

1. Keep trying the undocumented create endpoint. It needs partner permissions we deliberately don't use.
2. **The buyer opens disputes in the sandbox UI** (once per demo seed), and Second Key handles everything merchant-side via the documented API.
3. Drop disputes; export evidence as a static file.

## Decision (proposed)

Option 2. The demo seeds one captured purchase with a buyer-opened dispute. The `CUSTOMER.DISPUTE.CREATED` webhook (or the reconciler) links it to the purchase; Second Key drafts evidence; the reviewer approves; Second Key calls provide-evidence; the sandbox `adjudicate` call is labelled "simulated verdict" on screen.

If Gate 4 can't complete (for example, provide-evidence fails), fall back to option 3, as the original brief's decision rule said.

## Consequences

- Needs a human step per demo seed: Dave, logged in as the sandbox buyer.
- How long sandbox dispute actions take to appear is **Unknown**, so the seed is prepared ahead of recording.
