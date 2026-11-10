# Second Key threat model

Status: **current** · updated 2026-11-10 · Scope: the system in `docs/architecture.md`, PayPal sandbox only.

## Assets

| Asset | Why it matters |
|---|---|
| A1 Payer funds (authorizations, captures, payouts) | The thing being protected |
| A2 PayPal client secret | Whoever holds it can move money outside Second Key |
| A3 Confirmed intents (policy + digest) | Define what may be bought, or whom to pay and how much |
| A4 Approvals | Single-use capabilities to capture |
| A5 Audit chain and evidence | Basis for dispute defence and public verification |
| A6 Payer vault id | Lets PayPal authorize without the buyer present |
| A7 Model, Channel3 and AG Studio keys; role keys held by the web server | Cost and data exposure |
| A8 Protection profile and the trusted contact's authority | Decide who may release a paused transfer |
| A9 Hold credentials | Release one held payment |
| A10 AP2 mandate ledger and receipt signing key | Single use and budgets across merchants; what receipts prove |

## Actors

| Actor | Capability assumed |
|---|---|
| Malicious or confused **agent** | Holds an agent key; can send any cart, replay requests, present AP2 mandates with disclosures withheld, and read its own purchases |
| **Prompt injector** | Controls third-party text the system reads (titles, descriptions, merchant pages) and messages sent to an agent |
| **Scammer coaching the payer** | Talks the payer into paying, and into approving or loosening their own protection |
| Faulty or compromised **checkout adapter** | Can change the lines sent to PayPal |
| **Network attacker / forger** | Can send arbitrary HTTP to public endpoints, including fake webhooks and guessed credentials |
| **Judge or public visitor** | Uses the website's demo routes at high volume, with hostile input |
| **Operator with the PayPal secret** | Out of scope: can bypass Second Key entirely (stated limit) |
| **Compromised verifier model** | The model returns wrong or adversarial output |

## Threats and controls

| # | Threat | Asset | Control | Residual risk / test |
|---|---|---|---|---|
| T1 | **Prompt injection** in product text or messages makes the agent pick a different item, or tells the verifier to approve | A1 | Injection and pressure checks on all third-party text; **no AI output can set amount, product, merchant or quantity**; AI can only add a HOLD; deterministic checks run whatever the AI says; quotes are checked by code against the source | A fooled model can at most fail to add a pause; hard limits still hold. Eval suite; "Try to beat Second Key" presets (`docs/submission/adversarial-scenarios.md`) |
| T2 | **Cart swap**: the PayPal order differs from the approved cart | A1 | Three-way match against `GET /v2/checkout/orders/{id}` before the approval is issued, and again right before capture | Sandbox scenario; AP2 settlement 4/4 |
| T3 | **Replay** of a purchase request or an approval | A1, A4 | Idempotency-Key; approval bound to order, authorization and payee; atomic `used_at`; `final_capture: true`; intent `max_purchases` | Unit test: a second consume returns nothing |
| T4 | **Forged approval** | A4 | Approvals exist only as DB rows inserted by the decision engine; the executor reads by id; no route accepts approval fields | Route-inventory test |
| T5 | **Direct capture bypass** inside our code | A1 | Executor isolated in the worker (no port), branded `ConsumedApproval`, CI import rule, no capture/void/payout routes | CI fails on a forbidden import |
| T6 | **Forged webhook** | A1, A5 | `verify-webhook-signature` before storing; even verified events only trigger a re-fetch | A forged event can at most cause an extra GET |
| T7 | **Duplicate or out-of-order webhooks** | A5 | Unique event id; state from the fetched PayPal state; backward transitions are no-ops | Shuffled replay test |
| T8 | **Over-capture** | A1 | Explicit capture amount = the approval; one purchase unit per order | The executor refuses if the re-read amount differs |
| T9 | **Stale intent** | A3 | The approval stores intent version and `policy_digest`; revoke voids open holds | Revoke between approve and consume → no capture |
| T10 | **Agent edits its own policy** | A3 | Agent keys can't create or confirm intents; intents are immutable after confirm | Agent key → 403 on intent routes |
| T11 | **Cross-tenant access** | All | Every query scoped by `tenant_id` from the key; payee check against the tenant | Tenant-isolation tests |
| T12 | **Hold credential theft or guessing** | A9 | 192-bit credential, minted at the channel's last hop, stored only as SHA-256, bound to one hold and one reviewer; never in a URL query (POST body, or URL fragment for the payer's own holds); 30-minute life; replaced by a reminder; locks after 10 wrong attempts; decides once; approve re-runs the three-way match and only records an approval (ADR-0020) | `holds-security` and `guardian` DB tests |
| T13 | **The coached payer approves their own paused transfer** | A1, A8 | The reviewer is fixed when the hold is created. A `guardian` hold can be approved only with the trusted contact's credential; payer or admin approval is 403 and audited; the payer can only cancel | Second Key's core claim; 24 guardian API tests |
| T14 | **The coached payer loosens their protection or swaps the trusted contact** | A8 | Tightening applies at once; loosening, removing or replacing the contact waits 48 hours (server time) and the current contact is told; each screened transfer snapshots the profile version and threshold | A payer who plans 48 h ahead can loosen it; the contact is warned |
| T15 | **A notification failure grants approval elsewhere** | A8, A9 | Transactional outbox with bounded retries; a failed delivery never transfers authority; the payer can only remind | Notification-failure test |
| T16 | **Payee spoofing** (a known payee id with a new payout email) | A1 | Payee identity includes the payout email; history only from CAPTURED transfers or audited imports; the intent can only make it stricter | Payee-spoofing test |
| T17 | **Lookalike text** ("Whіte" with a Cyrillic letter, a lookalike merchant domain) | A1 | Text normalised (NFKC); a colour or size mixing alphabets is unconfirmable (HOLD); merchants match exactly | `packages/core/test/script.test.ts`; adversarial presets |
| T18 | **AP2: withheld disclosures widen a mandate** | A1, A10 | A requirement whose acceptable items are all withheld matches nothing (the spec text); Second Key's attribute rules aren't selectively disclosable | Constraint-parity tests; the "agent hides the list" run. Google's reference SDK treats the empty list as a wildcard (being reported) |
| T19 | **AP2: mandate reuse or budget reset across merchants** | A10 | A global ledger keyed on issuer-signed JWT hashes (trimming disclosures can't reset it), advisory locks, single use unless recurrence governs | Lock test that holds one transaction open |
| T20 | **AP2: the product doesn't match what the user meant** | A1 | `x-secondkey.item_attributes.1` checked against facts Second Key fetches from the catalog by id and signs; a missing or ambiguous fact is CANNOT_CONFIRM, never a pass | Real-product runs on Channel3 data |
| T21 | **Receipt forgery** | A10 | ES256 receipts with a published JWKS; the API holds the key, the worker never does | Without `SECONDKEY_RECEIPT_JWK` the key is per process and old receipts stop verifying after a restart (the API warns) |
| T22 | **Secret leakage** in logs, evidence or the repo | A2, A7 | Logger redaction plus a test; `.env` gitignored; role keys only in the web server; the browser never sees a key | Secret scan |
| T23 | **Compromised verifier model** | A1 | Zod-validated outputs; any parse failure, refusal, timeout or low confidence → HOLD, never CAPTURE; the model sees no secrets and has no tools | Fault-injected responses → 100% HOLD or REJECT |
| T24 | **Demo abuse and hostile input** (floods, oversized or malformed bodies, markup and SQL strings) | A1, A7 | Strict schemas (unknown fields refused), body limits, per-process and per-visitor rate limits, model spend caps, parameterised SQL, React text escaping; demo routes act only on demo payers' sandbox wallets | Screening security tests (`apps/api/test/console.db.test.ts`) |
| T25 | **Audit tampering** | A5 | Hash chain; a trigger blocks UPDATE and DELETE; public `/verify` recomputes | A DB superuser could rewrite the chain; publishing the head externally is not built |
| T26 | **Production host misconfiguration** | A1 | Exact-host sandbox guard (ADR-0001) in `packages/paypal` | Unit test |
| T27 | **Timeouts and partial failure** cause a double capture or a lost record | A1, A5 | Journal before the call; deterministic request ids; reconciler | Failure drills |

## Out of scope

- An operator holding the PayPal secret (Second Key protects against the agent and the manipulated payer, not the credential holder).
- Payments made outside a platform that integrates Second Key, or split below a threshold.
- The demo's trusted-contact channel: both windows run on one computer, so the demo proves the API boundary, not channel security. Production needs a real out-of-band channel (SMS, email, an app).
- Real money, production deployment and PCI scope (no card data; PayPal wallet only).
- PayPal's own adjudication of disputes. Sandbox verdicts are chosen by us.
