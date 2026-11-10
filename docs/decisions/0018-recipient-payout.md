# 0018: Paying the recipient after a verified capture

Status: accepted (2026-10-17).

## Context

Approving a Second Key transfer captured the payment to the platform's sandbox merchant, and the recipient got nothing. PayPal won't let a non-partner platform void a payment made directly to a third party (see [paypal-flows.md](../paypal-flows.md), A2). The supported way to reach the recipient is therefore a **second, separate movement**: a PayPal Payout from the platform, after the capture.

## Decision

The **executor** (the only component with money-moving credentials) pays the recipient. Strict conditions:

1. **Who.** The payout goes only to the recipient email the payer **confirmed in the transfer intent** (`TransferPolicyV1.payee.email`). Never anything from the request, the conversation or a model.
2. **When.** Only for a transfer, and only after the purchase is `CAPTURED`. That state means PayPal captured exactly the approved amount. A deny, a void, a decline, a pending or unverified capture, or any shopping purchase never pays out.
3. **Once.** One `payouts` row per purchase (primary key). The `sender_batch_id` is `sk-<purchase>`, and the PayPal-Request-Id is derived from the purchase. A timeout or 5xx is recorded as `UNKNOWN` and retried with the **same** request ID, so PayPal returns the original batch rather than creating a second one.
4. **Separate truth.** The purchase stays `CAPTURED`. The payout has its own status (`PENDING`, `SUCCESS`, `UNCLAIMED`, `FAILED` …), read back from PayPal (`GET /v1/payments/payouts/{batch}`) by a bounded check job, plus the periodic sweep. Audit events: `payout.requested`, `payout.accepted`, `payout.succeeded` / `payout.unclaimed` / `payout.failed`, `payout.outcome_unknown`.
5. **Executor-only at the transport level.** `POST /v1/payments/payouts` is now a money path in the transport guard: the API and script roles can't call it. Reading a batch stays available to the API, so screens can show PayPal's own record.
6. **Honest screens.** A completed capture is shown as "PayPal shows $X captured". Only a `SUCCESS` payout item is shown as "paid out to <recipient>". The recipient email is always masked on screen (`sb•••29@…`).

## Demo configuration

`SECONDKEY_DEMO_RECIPIENT_EMAIL` (API): one PayPal sandbox personal account that stands in for every demo recipient. When it is set, demo transfer intents carry it as the confirmed payee email. When it is unset, no payouts happen and the screens say "Paying the recipient isn't set up in this deployment". It is not a secret, but it is kept out of the repository and out of reports.

## Consequences

- The platform pays the full amount out and absorbs PayPal's capture fee. That is fine for a sandbox demo; production pricing would need a decision.
- The Payouts API must be enabled on the PayPal app (it is in the sandbox), and the platform's balance must cover the payout. An insufficient balance shows as a failed payout, while the capture remains.
- The sprint spike `secondkey/spikes/s4/architectures.ts` created payouts with the script role. The transport guard now refuses that. Re-running it needs the executor client; the result it recorded stands.
- Migration `0004` adds `payouts` and allows `payout` in the PayPal call journal. It is additive.
