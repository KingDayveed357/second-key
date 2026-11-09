# 0023: Second Key as an AP2 delegated verifier

Status: accepted (2026-11-10). Builds on ADR-0005 (capture isolation), ADR-0020 (the second key), ADR-0021 (policy over grounded evidence). Strategy: [docs/strategy/2026-11-02-frontier-infrastructure.md](../strategy/2026-11-02-frontier-infrastructure.md).

## Problem

AP2 (Agent Payments Protocol v0.2) lets an agent prove it was **authorized** to pay: the user signs an open mandate, the agent closes it, and verifiers check signatures and constraints. Three things are left open:

1. **Descriptive intent.** AP2 can list acceptable items by id and cap an amount. It can't say "size 10, not white", and its item titles are informational.
2. **State.** Budgets, recurrence and "use this mandate once" need memory across presentations and merchants. The spec says verifiers must track them; it doesn't say who.
3. **Settlement.** A conforming mandate says nothing about the order the PSP actually holds. A checkout can send PayPal a different item at the same price.

## Decision

Second Key implements AP2 as a **delegated verifier** for the merchant and processor roles (the spec lets roles delegate verification to a technology provider), and adds what the three gaps need. It is not a shopping agent, a credential provider or a trusted surface for real cards.

1. **`packages/ap2`: a pure verifier.** No database, network or files (architecture rule `ap2-is-pure`).
   - SD-JWT (RFC 9901) as AP2 uses it; delegate chains joined by `~~`; KB-SD-JWT hops bound by `sd_hash` or `issuer_jwt_hash`; ES256 only.
   - Validation against AP2's canonical JSON schemas, vendored unchanged from the reference repository at commit `e1ea56d` ([schemas/VERSION.md](../../packages/ap2/schemas/VERSION.md)).
   - All standard constraints. Line items use the spec's exact max-flow rule. An unknown constraint is unresolved, never a pass, as the spec requires.
   - Every rejection has a stable code. Outcomes use the spec's receipt errors: `invalid_credential`, `invalid_mandate`, `unresolved_constraint`.
2. **Two extension constraints**, named `x-secondkey.*` as the spec recommends for new types.
   - `x-secondkey.item_attributes.1`: attribute rules (`any_of`, `none_of`) checked against product facts **Second Key fetches itself and signs** (a facts attestation). A missing fact, a listing that addresses AI agents, or an unavailable listing check is `CANNOT_CONFIRM`, never a pass. AI can only make the result stricter.
   - `x-secondkey.cosign.1`: above a threshold, the closed payment needs a signature from an enrolled co-signer's key over that exact payment. Without one the decision is `COSIGN_REQUIRED`; any other key, another payment's signature or an expired one is refused.
3. **A global mandate ledger** (migration 0008).
   - **Keys** are hashes of issuer-signed JWTs, not `sd_hash`. A holder can present the same mandate with fewer disclosures, which changes `sd_hash` but never the issuer JWT, so trimming disclosures can't reset a budget.
   - **Use rules:** open mandates are single-use unless recurrence governs them; closed mandates can't be replayed. Budget and recurrence count across merchants, because the ledger is not per tenant.
   - **Atomicity:** the ledger runs inside the request's transaction under per-key advisory locks; a test holds one transaction open and proves the second waits.
4. **Settlement binding** (migration 0009).
   - `POST /v2/settlements` binds a fresh (15-minute) conforming verification to one PayPal order.
   - The order is re-read and must hold exactly the merchant-signed checkout, with a live authorization for the total. A match is queued for capture; a mismatch is voided.
   - The worker's executor treats the settlement row as a single-use capability and re-checks the order immediately before capturing. Every money call is journaled first.
5. **Signed receipts** (ES256, kid-addressed, `GET /.well-known/jwks.json`).
   - A Mandate Receipt for every decision, refusals included.
   - AP2 Checkout and Payment Receipts once settlement is final, validated against their schemas before signing.
   - The API holds the receipt key; the worker never does.
6. **Interop is measured, not claimed** ([interop/README.md](../../packages/ap2/interop/README.md)).
   - The spec's example tokens recompute.
   - Chains built by Google's reference SDK verify here, and ours, receipts included, verify there.
   - 15 shared constraint cases: 11 agree, 4 differ where we follow the spec text.

## What we found

- **Four reference-SDK divergences from the spec**, listed in the interop README. One is security-relevant: through the SDK's own create, present and verify path, a holder that withholds the acceptable-items disclosures can close a mandate for a product it doesn't list. It is reported to Google's vulnerability programme ([g.co/vulnz](https://g.co/vulnz)), as AP2's SECURITY.md asks, before this repository is published.
- **An upstream schema bug:** `receipt_status.json`'s `$id` breaks the receipt schemas' `$ref`. Worked around by registering schemas under their path ([schemas/VERSION.md](../../packages/ap2/schemas/VERSION.md)).
- **The canonical schemas are stricter than the SDK's models:** every Open Payment Mandate must contain `payment.reference`. A recurring payment therefore closes the open checkout it references once per occurrence, which the ledger allows only in that pairing.
- **PayPal wallet captures carry no network reference**, so a Payment Receipt's required `network_confirmation_id` reads `not_provided_by_psp`. This was observed on the sandbox, not assumed.

## Trade-offs and limits

- **Trust anchors per request.** A caller sends the issuer and merchant keys it trusts with each verification, and each receipt records the key thumbprints relied on. Tenant-pinned keys are future work.
- **Receipt key.** Without `SECONDKEY_RECEIPT_JWK` the API signs with a per-process key, and receipts stop verifying after a restart; the API warns at startup. In production the key belongs in a KMS.
- **No x5c.** Root keys resolve by `kid` only.
- **A refused settlement still consumes the mandate.** Mandates are recorded as used when they conform, so if settlement is then refused the agent must present fresh ones. That's deliberate and conservative.
- **Who settles.** Settlement assumes the PayPal order is on Second Key's PayPal app (the merchant-of-record model of ADR-0004). A PSP or merchant using its own PayPal account would need Second Key's receipt as a capture precondition instead; that's documented, not built.
- **"AP2-compatible" means:** verifies chains built by the reference SDK, and builds chains it accepts, for the shapes tested. It is not a certification.
- **The demo's parties are synthetic.** In the agent demo, Rose's browser key is real WebCrypto and the verifier, ledger, settlement and PayPal calls are real. The shopping agent and the merchant are scripted server-side parties, and the page labels them so.

## Evidence

- **Tests:** 175 AP2 tests, 137 unit and 38 against Postgres. All 39 deliberate breaks of the verifier, constraint, extension, ledger, receipt, lock and settlement rules were caught.
- **PayPal sandbox:** 4/4 settlement scenarios, each checked against PayPal's own order ([evidence](../evidence/ap2-settlement-sandbox-run.md)).
- **Browser rehearsal:** five agent runs on the real sandbox with the real Haiku listing check, each stopped at the expected check, and receipts verified in the browser. The test verification on `/developers` works with no account and no key.
