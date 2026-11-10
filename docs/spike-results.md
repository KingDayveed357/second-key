# Stage 1: Spike results (PayPal sandbox)

Date: 2026-10-11 · App: standard REST app (Merchant), US Business payee `7L6D422CPFA9Q`, US Personal buyer · Host checked: `https://api-m.sandbox.paypal.com` (exact-host guard in `spikes/lib/paypal.mjs`)

Evidence: every request and response is in `spikes/out/` (gitignored, kept locally). File names below are relative to that folder. Authorization headers are redacted in every file.

Labels: **Verified** = PayPal's response or official docs (linked) · **Inference** = my reading, not tested · **Unknown** = needs a test.

## Summary

| Gate | Question | Result | Runs |
|---|---|---|---|
| 0 | Credentials and scopes | **PASS** | 1 |
| 1 | Authorize → capture, authorize → void; a voided authorization can't be captured | **PASS** | 1 (buyer-present) |
| 2 | Authorize with a saved wallet, buyer **not** present | **PASS** | 2 (14:15Z, 15:17Z) |
| 3 | Same-price SKU swap caught on PayPal's own order, then voided | **PASS** | 2 (one buyer-approved at 14:36Z; one vault, no buyer, at 15:17Z) |
| 4 | Dispute opened, evidence submitted, settled | **BLOCKED: wrong method in the spike** | create failed; no dispute exists |

**Recommendation: GO on the human-not-present design**, with Gate 4 finished through the sandbox UI path below. Gate 4 is 25 seconds of the demo and doesn't change the core design.

---

## Gate 0: credentials and scopes: PASS

`npm run spike:auth`, 2026-10-11 ~15:17Z. Token issued; 33 scopes. Present: `payments/payment/authcapture`, `vault/payment-tokens/readwrite`, `disputes/create`, `disputes/read-seller`, `disputes/update-seller`. Spike 01 doesn't write an evidence file; the console output is the evidence.

## Gate 1: capture and void on real authorizations: PASS

Run 2026-10-11 14:08–14:13Z (buyer approved both orders in the browser, ~4.5 minutes).

| Step | Result | Evidence |
|---|---|---|
| Create order A (`TRL-GRY-10`, 84.00) and order B (`TRL-WHT-10`, 84.00), intent AUTHORIZE | `PAYER_ACTION_REQUIRED` · A `9FM862648T1632338`, B `928622816P5780227` | `…14-08-15-881Z-01-create-order-A.json`, `…-02-create-order-B.json` |
| Buyer approves → poll | `APPROVED` | `…14-12-51-244Z-79-poll-order.json` |
| Authorize A and B | Order `COMPLETED`; authorizations `07J946567W830432K` and `2MM1568141057045P` are `CREATED`, 84.00 USD; `expiration_time` = created + 29 days; seller protection `ELIGIBLE` | `…-80-authorize-order.json`, `…-81-…` |
| Re-read order A before capture | Items `[TRL-GRY-10 ×1 @84.00]`; `custom_id` = intent digest; payee `7L6D422CPFA9Q` | `…-82-get-order-A.json` |
| Capture A, explicit `{84.00 USD, final_capture: true}`, with `PayPal-Request-Id` | 201 · capture `536404883W4495032` `COMPLETED`; PayPal fee 3.42 | `…-83-capture-authorization.json`, `…-84-get-capture.json` |
| Void B | 204 → authorization `VOIDED` | `…-85-…`, `…-86-get-authorization.json` |
| Capture the voided B | **422 `AUTHORIZATION_VOIDED`** (debug `f7222525e546c`) | `…-87-capture-authorization.json` |

Note: the *order* reads `COMPLETED` straight after `/authorize`, before any money moves. Second Key must read the **authorization and capture** statuses, never the order status, to decide whether funds were captured. **Verified** by the responses above.

## Gate 2: authorization with the buyer not present: PASS

1. Saved the wallet once: setup token `5JG624745U232272X` (`PAYER_ACTION_REQUIRED` → buyer approved → payment token created, Vault customer id returned). Files `…14-14-12-287Z-01-create-setup-token.json`, `…-27-create-payment-token.json`.
2. Order with `payment_source.paypal.vault_id` only, intent AUTHORIZE, **no buyer action**: 201, order `1M060119S54869011` `COMPLETED`, authorization `12H434938Y5759253` `CREATED` 84.00 USD, payer account `VERIFIED`. It was authorized in one call, with no separate `/authorize` step. Debug `f381589ba7f41`. File `…14-15-43-943Z-28-vault-authorize-order.json`. Voided afterwards (confirmed `VOIDED`).
3. **Repeat run** with the saved wallet at 15:17Z: order `0LH226535G4030535`, authorization `5BC78283U2232712K` `CREATED`, then voided (confirmed `VOIDED`). File `…15-17-08-873Z-01-vault-authorize-order.json`.

Limit we state openly: in production, vaulting needs a merchant eligibility review (a stated limit). **Unknown:** how long that review takes and what it requires. That question is for PayPal, not the hackathon.

## Gate 3: cart swap caught on PayPal's record: PASS

Second Key approved `TRL-GRY-10` at 84.00. The order PayPal received holds `TRL-WHT-10` at 84.00, so price, budget and total all pass.

| Run | Order / authorization | Three-way match result | After |
|---|---|---|---|
| 14:36Z (buyer approved) | `2P115248LH079143S` / `59W13946J8778544P` | missing `TRL-GRY-10`, unapproved `TRL-WHT-10` | `VOIDED`, $0 captured |
| 15:17Z (`--vault`, no buyer) | `7VY11072B9449012S` / `2R721902S6265864M` | same two differences | `VOIDED`, $0 captured |

Files `…14-36-09-925Z-02-get-swapped-order.json`, `…15-17-17-536Z-02-get-swapped-order.json`, `…-04-get-authorization.json`.

Honest framing: the swap is staged, because the spike itself creates the wrong order. The check is real: it reads PayPal's stored order, not a local copy.

## Gate 4: dispute: BLOCKED (diagnosed)

`npm run spike:dispute -- create`, 14:38Z → **400 `invalid_request`: "No permissions to set target_client_id"**, debug `f81399806119f`. File `…14-38-24-411Z-01-create-dispute.json`. `list` at 15:17Z: no disputes.

Diagnosis:
- **Verified:** the current Disputes v1 schema exposes only `GET` on `/v1/customer/disputes`; **there is no create operation** ([schema](https://developer.paypal.com/api/customer-disputes/v1/schema.json), [reference](https://developer.paypal.com/api/customer-disputes/v1/)). The spike calls an undocumented endpoint with a `PayPal-Auth-Assertion` header that impersonates the buyer.
- **Inference:** the error comes from that assertion. Acting on behalf of another account needs partner/third-party permissions, which we are deliberately not using. So this is the spike's method, not an API gap for merchants. The merchant-side actions we need are documented: provide-evidence, plus the sandbox-only `require-evidence` and `adjudicate` ("Merchants can make this call in the sandbox to complete end-to-end dispute resolution testing").

**To finish Gate 4 (needs you, about 5 minutes):** log in at https://www.sandbox.paypal.com as the **sandbox Personal buyer** → Activity → the $84.00 "Second Key Demo Store" payment (capture `536404883W4495032`) → report a problem → item not received. Then tell me, and I'll run `spike:dispute -- list` and `next <id>` until it resolves. The evidence text no longer claims the intent is "signed" (fixed in `05-dispute.mjs`).

**Unknown, needs a test:** how long sandbox dispute actions take to appear.

---

## Facts verified for the design

| Fact | Status | Source |
|---|---|---|
| Honour period 3 days; authorization valid 29 days; can be reauthorized once, days 4–29; a reauthorization gets a new 3-day honour period | **Verified** | Payments v2 schema, reauthorize ([schema](https://developer.paypal.com/api/payments/v2/schema.json)); `expiration_time` = +29 days in our responses |
| Default capture overage limit **115%** of the order amount (lower where PSD2 rules apply) | **Verified** | Payments v2 schema, error catalogue |
| `final_capture: true` → no further captures on that authorization | **Verified** | Payments v2 schema, error catalogue |
| Reusing the same `PayPal-Request-Id` on capture returns the existing capture (200) instead of capturing again | **Verified by test** (Stage 3, 2026-10-11): HTTP 200 with the original capture ID, still one capture. How long PayPal keeps the key is **Unknown** | Payments v2 schema; `docs/evidence/stage3-sandbox-faults.md` PP-1 |
| A second capture with a new request ID on a `final_capture` authorization is refused | **Verified by test**: 422 `AUTHORIZATION_ALREADY_CAPTURED` | `docs/evidence/stage3-sandbox-faults.md` PP-2 |
| create-order returns a **minimal** representation (purchase unit has only `reference_id` + `payments`; no amount, items or payee) | **Verified** (Stage 1 response) | Contract test `packages/paypal/test/contract.test.ts`; verification always re-GETs the order |
| `custom_id` max **255** chars (the spike truncates to 127, which is safe but stricter than needed) | **Verified** | Orders v2 schema `purchase_unit_request.custom_id` |
| Up to 10 purchase units per order | **Verified** | Orders v2 schema |
| Webhook event types available: `CHECKOUT.ORDER.APPROVED/COMPLETED/VOIDED`, `PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/PENDING/DECLINED/DENIED/REFUNDED/REVERSED`, `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`, `VAULT.PAYMENT-TOKEN.*` | **Verified** (`GET /v1/notifications/webhooks-event-types`) | `…15-17-29-551Z-02-list-webhook-event-types.json` |
| **Which events actually fire for each step** | **Verified on the Render deploy** (2026-10-12): a vault-authorized order sends `PAYMENT.AUTHORIZATION.CREATED`; capture sends `PAYMENT.CAPTURE.COMPLETED`; void sends `PAYMENT.AUTHORIZATION.VOIDED`. **No `CHECKOUT.ORDER.*` events arrived for vault orders** within 45 s (the buyer never approves in a browser, so plausibly none are sent; Inference). All 7 deliveries passed signature verification; 0 rejected | `docs/evidence/render-sandbox-run.md` |
| Webhook timing and ordering | **Partly known**: deliveries arrived within the 45 s window (7 of an expected 8; the 8th was likely still in flight). Order is not guaranteed by PayPal, which is why Second Key re-fetches state instead of trusting event order | same |
| Sandbox dispute timings | **Unknown, needs a test** | Gate 4 |

## Changes made in Stage 1

- `spikes/05-dispute.mjs`: evidence text says "recorded … not cryptographically signed" instead of "signed".
- `.env.example`: removed real credentials that had been pasted into the template (`.env` has the same values and was untouched).
- No product code was written.
