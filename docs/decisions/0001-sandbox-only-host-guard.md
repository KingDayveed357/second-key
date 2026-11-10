# 0001: Exact-host sandbox guard for every PayPal call

Status: Accepted (2026-10-11, during the spike audit) · Owner: Dave to confirm

## Context

The spikes move money through PayPal. The original guard, `BASE_URL.includes("sandbox")`, accepted the production host whenever "sandbox" appeared anywhere in the URL (for example `https://api-m.paypal.com/?sandbox`). An early validation probe (X5) demonstrated this. One mistyped environment variable could have sent requests to production.

## Options

1. Keep the substring check. It is simple and unsafe.
2. Use an allow-list of exact origins, parsed with `new URL()`: protocol `https:` and hostname `api-m.sandbox.paypal.com`.
3. Use a separate `PAYPAL_ENV=sandbox` flag. That adds a second variable that can still disagree with the URL.

## Decision

Option 2, in `spikes/lib/paypal.mjs`. It runs at module load, before any network call. The product service (Stage 3) keeps the same rule. A production origin will only be added behind an explicit, separately reviewed configuration, and never during the hackathon.

## Consequences

- A typo or a lookalike domain (`api-m.sandbox.paypal.com.evil.test`) or plain `http://` fails at startup. All three were verified.
- If PayPal ever changes the sandbox hostname, the guard has to be updated deliberately.
