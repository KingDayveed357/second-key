# Reproducible end-to-end verification

## Procedure

**Prerequisites.**

- `.env` holds the sandbox credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL` = sandbox, `ANTHROPIC_API_KEY`). They are read from the environment only and never printed. The scripts refuse any non-sandbox PayPal host.
- `.secondkey/dev-keys.json` holds local API keys (gitignored).
- Windows, for the System.Speech transcription step.

**Steps.**

1. Start Postgres (`pnpm db:dev`, or the embedded instance on port 54330), then `pnpm api` and `pnpm worker` in two terminals. Wait for `GET /readyz` to return `{"ok":true}`.
2. Run the automated suites, which need no network:
   ```bash
   pnpm -s typecheck && pnpm -s deps:check && npx vitest run && node --test "test/*.test.mjs"
   ```
3. Run the live sandbox acceptance test:
   ```bash
   npx tsx secondkey/spikes/e2e/acceptance.ts
   ```
   It writes `secondkey/reports/e2e-acceptance.json`.
4. Optional live probes:
   - `npx tsx secondkey/spikes/s4/flows.ts`, with `SK_RECIPIENT_EMAIL` set, for the payment flows;
   - `npx tsx secondkey/spikes/s3/ondevice-probe.ts` for audio.

**What the live test asserts.** Each assertion is a recorded PASS or FAIL with sanitised evidence: statuses, amounts, IDs and PayPal debug IDs; no credentials, tokens or raw keys.

| # | Required by the brief | Assertions |
|---|---|---|
| 1 | Suspicious human payment request | Synthetic call audio → on-device transcription (System.Speech) → `kind: "transfer"` request → `ai.manipulation` = unknown with quotes verbatim from the transcript → HELD |
| 2 | Trusted-contact denial | One-time link (30 min, separate from the 72 h hold) → reviewer view shows amount, payee and quoted reasons → deny → `VOIDING` |
| 3 | Independently verified PayPal state | While held: authorization CREATED, 0 captures. After deny: **direct** `GET /v2/payments/authorizations/{id}` with the script's own PayPal token (not via Second Key) = VOIDED; Second Key's proxy agrees. Order status is recorded but never used as proof |
| 4 | Benign payment / invoice | Manipulation check `pass` → **direct** GETs: authorization CAPTURED, capture COMPLETED, $1,800.00, exactly one capture |
| 5 | AI shopping agent + malicious product instructions | `ai.injection` unknown → HELD → same link/deny/void path → direct GET VOIDED. Checkout swaps the item → three-way match → executor voids, never captures |
| 6 | Failure handling and retry | Same Idempotency-Key → same payment, no second PayPal order. Retried deny → `replayed: true`. Opposite decision → 409. Audit hash chain valid. Model outage, invalid model output, expired links, races and kind-mismatch bypasses are covered by the DB tests (they can't be forced reliably against live services) |

## Results (2026-10-17, local API + worker, PayPal sandbox)

**Live acceptance: 28/28 PASS** (`secondkey/reports/e2e-acceptance.json`).

| Flow | Key evidence |
|---|---|
| Human (scam call) | 12 ASR segments, 3.5 s. Quotes 4/4 grounded. HELD. Link 30 min. Authorization `659008602B829874E` VOIDED by direct GET (debug `f8810625e24fc`), 9 s after deny. Retry replayed. Approve-after-deny 409. Audit: submitted → screened → authorized → held → void_decided → voided |
| Benign invoice | Manipulation `pass`. Direct GETs: authorization CAPTURED, capture COMPLETED 1800.00 (debug `f61074948ddde`, `f4818239c8a20`). Order status COMPLETED recorded but not used as proof |
| Agent injection | `ai.injection` unknown → HELD → deny → authorization `5KJ66611DL165094B` VOIDED (direct GET, debug `f79295592240b`) |
| Agent cart swap | Three-way match failed → executor void → VOIDED, no capture |

**Automated suites (2026-10-17):** typecheck OK, architecture rules OK, vitest **407/407** (32 files: unit + DB), node tests **16/16**. DB tests include `secondkey.db.test.ts` (17: transfers, bypass attempts, shopping + shared check) and `holds-security.db.test.ts` (11).

**Cost of the live run:** 3 Haiku manipulation and injection calls (well under $0.01). The PayPal sandbox is free.
