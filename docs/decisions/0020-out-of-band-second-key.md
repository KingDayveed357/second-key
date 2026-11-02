# 0020: The second key is held by someone else

Status: **accepted** (2026-11-02), revision 2 after security review. Amends ADR-0017 (where the reviewer credential travels, how it is bound and revoked) and ADR-0019 (where the payer's rule lives, what "first payment" means, who may approve).

## 1. Problem (verified in code, 2026-11-02)

| # | Today | Where |
|---|---|---|
| P1 | The reviewer token is returned to the **payer**: `POST /v1/purchases/:id/hold-link` (shopper role) answers `{ path, token }` and `/pay` shows it as "Open Sarah's review". | `apps/api/src/app.ts`, `apps/web/app/(sk)/pay/payer.tsx` |
| P2 | `POST /v1/holds/:id/approve` accepts the payer's own bearer key. Only the web proxy hides that. ADR-0019 says the payer can't approve a rule-paused payment; nothing enforces it. | `packages/engine/src/holds.ts` `authorize` |
| P3 | No reviewer identity: a link decision is recorded as `shopper:<id>(link)`; deny reasons say "the shopper declined". | `holds.ts`, `apps/web/lib/sk.ts` |
| P4 | The "rule set in advance" is a field of each payment's intent. | `TransferPolicyV1.review_threshold_cents` |
| P5 | `payee.first_payment` is asserted by the caller; `false` switches the rule off. | `checks.ts` `reviewRule` |
| P6 | Tokens travel in the query string (`/holds/:id?t=…`, `GET /v1/holds/:id?t=…`). | ADR-0017 |
| P7 | Nothing delays loosening the rule or replacing the reviewer (R16). | — |

## 2. The invariant

> For a transfer whose payer has second-key protection, **approval requires a credential minted for the guardian assigned to that hold, delivered through the guardian's channel.** No route callable with the payer's credential (shopper role) can obtain that credential, read the guardian's channel, or approve the hold. Admin can't approve it either. Anyone entitled to it can cancel.

It is enforced in `resolveHold` inside the same row-locked transaction that applies the decision, not in the UI or the proxy.

**What the invariant does not claim.** Enrolment proves **possession of a channel**, not legal identity or relationship. A payer who enrols a channel they control has enrolled themselves. Second Key makes self-approval impossible for the payer's *application*; it can't stop a person who controls both channels. Production needs channels the platform verifies (a phone number verified against the guardian's own account); that is out of scope here and stated in the product.

## 3. Data model (migration `0006_second_key.sql`)

Shopper IDs are globally unique (`newId("shp")`, random), but every new table also carries `tenant_id`, and every query filters on it.

```
protection_profiles  (tenant_id, shopper_id) PK
  version int            -- +1 on every applied change
  threshold_cents int null   -- null = no threshold rule; 0 = every first payment
  guardian_id text null      -- the assigned ACTIVE guardian, or null
  protection_on bool         -- true once a guardian was first assigned; only a delayed removal turns it off
  updated_at

guardians  id PK, tenant_id, shopper_id, display_name,
  channel 'demo_inbox', address,     -- the channel address (for demo_inbox: the inbox address)
  status 'INVITED'|'ACTIVE'|'REMOVED'|'REVOKED', created_at, activated_at, ended_at, ended_reason

profile_changes  id PK, tenant_id, shopper_id,
  kind 'threshold'|'guardian'|'remove_guardian', value jsonb,
  requested_at, effective_at, applied_at, cancelled_at, cancel_reason

notifications  id PK, tenant_id, guardian_id, purchase_id null,
  kind 'invite'|'hold_review'|'authority_change'|'revoked', seq int,
  status 'PENDING'|'DELIVERED'|'FAILED'|'SUPERSEDED', attempts, next_attempt_at, last_error,
  delivered_at, created_at
  UNIQUE (purchase_id, kind, seq)

demo_inboxes  address PK, tenant_id, secret_hash, created_at

payee_history  (tenant_id, shopper_id, payee_key) PK, first_paid_at, purchase_id null, source 'captured'|'imported'|'backfill'

holds  + approver 'principal'|'guardian'|'legacy' (existing rows: 'legacy'),
       + guardian_id null, + reason_classes text[],
       + credential_hash null, credential_guardian_id null, credential_expires_at null, credential_seq int,
       + failed_attempts int, last_notified_at null
       (the old token_hash / token_expires_at stay for principal and legacy holds)

purchases + protection jsonb null   -- the screening snapshot (§6)
```

Only the SHA-256 of a credential or inbox secret is ever stored.

## 4. Who may approve: hold reason classes

Classification is deterministic code over the stored checks. No model output selects the approver.

| Class | From | Means | Resolution |
|---|---|---|---|
| `POLICY_REVIEW` | `transfer.review_rule` unknown | The payer's own rule applies | Approver decides |
| `EVIDENCE_CONCERN` | `ai.manipulation` unknown with a completed analysis; `CONTEXT` checks | Patterns found in the conversation | Approver decides; shown as observations, not findings of fraud |
| `ASSESSMENT_UNAVAILABLE` | an AI check unknown because the model failed, timed out or returned unusable output | We couldn't check | Fail closed: held. Shown as "a check couldn't run (technical), not a sign of fraud". Same approver as the payment's protection. An automatic re-assessment is deferred (§13) |
| `LISTING_OR_FACTS` | shopping checks (missing facts, price, injection, integrity) | Agent purchase needs its principal | Principal |

Approver at hold creation:

| Purchase | Payer's protection | Approver |
|---|---|---|
| transfer | `protection_on` | **guardian**, `guardian_id` = the profile's current guardian (may be null: nobody can approve until a guardian is effective; the payer can cancel; it auto-voids) |
| transfer | off | principal, and the UI says "no second key set up" (the honest pre-0020 behaviour) |
| shopping (agent purchase) | any | principal |

An agent-initiated **transfer** inherits the payer's profile, because screening reads the profile of the intent's shopper, whoever submits. The profile does **not** yet govern agent shopping; the product must not claim it does. An agent spending-authority model is future work.

## 5. Credential lifecycle

**One active credential per hold.** It lives in `holds.credential_*` and is bound to `(tenant, purchase, guardian, seq, expiry)`.

1. **Minted at the last hop of the channel**, never earlier, never stored in plaintext:
   - `demo_inbox`: minted when the inbox owner opens the message (`POST /v1/demo/inboxes/:address/messages/:id/open`, inbox secret required), returned once in that response.
   - A real SMS or email adapter (not built) would mint inside its delivery step and hand the plaintext only to the provider.
2. **Minting is a single `UPDATE … WHERE resolved_at IS NULL AND guardian_id = $guardian`**. It replaces any previous credential, so the old one stops working at that instant. It only succeeds for the message of the hold's latest, non-superseded notification.
3. **Expiry**: 30 minutes of server time, never past `auto_void_at` (ADR-0017's clock, unchanged).
4. **Accepted only when** the SHA-256 matches, `credential_guardian_id = holds.guardian_id`, that guardian is ACTIVE, the tenant matches and it has not expired. All of this is checked **inside the decision transaction** after `SELECT … FOR UPDATE` on the hold, so a concurrent revocation or re-notify serialises with it.
5. **One decision per hold**: the first decision resolves the hold; the same decision retried with the credential replays the record; the opposite gets 409 (unchanged). The credential is not cleared on resolution, so the reviewer can still see the outcome until it expires; it can't decide anything else, because it is bound to this hold.
6. **Attempt limit**: 10 wrong credentials on a hold clear the active credential (`failed_attempts`, persisted). The payer must remind, which delivers a fresh one to the guardian.
7. **Never in a URL query, a log or an audit payload.** Audit events record channel, masked address and `seq`, never the credential.

**Transport (amends ADR-0017).** Query-string tokens are removed: they leak into browser history, server access logs and `Referer`.

- Hold views and decisions take the credential in a **POST body** (`POST /v1/holds/:id/view`, `/verification`, `/approve`, `/deny`).
- A link sent over a real channel carries it in the **fragment**: `/holds/:id#k=…`. Fragments are never sent to the server or put in `Referer`. The page reads it, removes it with `history.replaceState`, and keeps it only in that tab's `sessionStorage` until the hold resolves.
- The demo inbox never puts the credential in a URL at all; Sarah's tab passes it in memory.
- `/holds` pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; the proxy already marks every response `no-store`.
- **Limit:** a fragment link stays in the history of the device that opened it until the page strips it, and anyone holding the unexpired link within 30 minutes can decide once. That is the same trust as the channel itself.

## 6. Profile semantics

**One change per request.** Each request is validated strictly; the server alone computes direction, `effective_at` and `version`.

| Request | Effect |
|---|---|
| `POST /v1/me/protection/threshold {threshold_cents}` (integer ≥ 0, or `null`) | Lower than the current value, or a value where there was none → **tighten**, applied now. Higher, or `null` → **loosen**, pending 48 h. The same value → 409 |
| `POST /v1/me/guardians {display_name, address}` | Creates an INVITED guardian and queues an invite. Grants nothing |
| (guardian accepts through their channel) | ACTIVE. Still grants nothing on its own |
| `POST /v1/me/protection/guardian {guardian_id}` | The guardian must be ACTIVE and the payer's own. The **first** guardian ever (`protection_on = false` and none before) → applied now: that is setup. Any later assignment (replacement, or re-filling after a revocation) → **pending 48 h** |
| `POST /v1/me/protection/guardian/remove` | Pending 48 h; then `guardian_id = null` and `protection_on = false` |
| `POST /v1/me/protection/guardian/revoke {reason}` | **Emergency, immediate** (§7) |
| `POST /v1/me/protection/changes/:id/cancel` | Cancels a pending change; never speeds one up |

- **Omitted fields** don't exist in this API: each endpoint changes one thing.
- **Pending changes.** At most one pending change per kind (`threshold`, `guardian`, `remove_guardian`); a second → 409 until the first is cancelled or applied. A pending guardian change and a pending removal can't coexist (409).
- **A tighten supersedes** a pending loosen of the same kind (it is cancelled, `cancel_reason = 'superseded by a stricter change'`).
- **At its effective time a change is re-validated** against the current state: a replacement whose guardian is no longer ACTIVE is cancelled. Due changes are applied in `requested_at` order, so they can't be reordered.
- **Delay**: 48 h (`SECONDKEY_LOOSEN_DELAY_HOURS`, minimum 24), always server time. Tests move an injected clock, never the delay.
- **The current guardian is notified** (`authority_change`) when a loosen is requested.
- **A pending loosen never weakens the active profile**: screening reads only applied state.
- **Limit:** the delay is friction and a detection window, not a defence against a fully compromised payer account.

**Threshold.** `effective = min` of the values present among `profile.threshold_cents` and the intent's `review_threshold_cents`; neither present → no threshold rule. The intent can only make it stricter, so an untrusted caller can't weaken the profile.

**Snapshot.** Before screening, the payer's due changes are applied in their own transaction. The screening transaction then reads the profile `FOR SHARE`, before its first audit append, computes the rule and writes `purchases.protection`. A change that falls due between the two is a loosen not yet applied, so the read can only be the stricter state.

```
{ profile_version, threshold_cents (effective), profile_threshold_cents, intent_threshold_cents,
  protection_on, guardian_id, payee_key, paid_before, rule_version: "review_rule@2" }
```

Old decisions are explained from this snapshot, never from the current profile.

**Approver at hold creation** (`verifyPurchase`, a later transaction) reads the profile `FOR SHARE`. Revocation, replacement and removal take `FOR UPDATE` on the profile **and** update the payer's open holds in the same transaction. Hold creation and authority changes are therefore serialised: a hold is either created before the change (and reassigned by it) or after it (and assigned the new state).

**Locking order**, everywhere: profile → purchase → hold → audit chain (`appendAudit`'s transaction-scoped advisory lock).

- Decisions take purchase → hold → audit.
- Anything that changes a payer's authority locks the profile, then all of that payer's open guardian holds (purchase and hold, in purchase-id order, `FOR UPDATE OF p, h`), and only then writes or appends audit.
- Opening an inbox message reads the guardian without a lock.

A first version appended audit before locking the open holds; a concurrency test (`guardian.db.test.ts`, revocation racing an approval) deadlocked on it (Postgres 40P01). The order above fixed it: 10 consecutive runs of both race tests passed.

## 7. Guardian lifecycle and pending holds (questions A, B)

Every hold snapshots `guardian_id` when it is created.

| Event | Effect on the guardian | Effect on open holds |
|---|---|---|
| Replacement takes effect (after 48 h) | Old guardian → REMOVED | Open holds with the old guardian: credential cleared, `guardian_id` = new guardian, a new `hold_review` notification queued; audited `hold.guardian_reassigned`. The old guardian's credentials are dead from that instant |
| Removal takes effect (after 48 h) | → REMOVED; profile off | Open holds keep `approver = guardian` with `guardian_id = null`: **nobody can approve**; the payer can cancel; they auto-void at 72 h. Never a fallback to the payer |
| **Emergency revocation** (payer, immediate, reason required and audited; an admin route is deferred) | → REVOKED; profile `guardian_id = null`, `protection_on` stays **true** | Credentials cleared at once; holds stay HELD with `guardian_id = null` until a new guardian is effective (which takes 48 h, §6) or the payer cancels. The revoked guardian is notified (`revoked`) |

Emergency revocation only removes authority. Re-granting authority is always delayed, so revocation can't be used to swap in a self-controlled channel faster than a normal replacement.

## 8. Notifications: a transactional outbox

1. The hold row and its `notifications` row (`kind = hold_review`, `seq = 1`) are inserted **in the transaction that creates the hold**, together with a pg-boss `notify` job (same database, same transaction).
2. The worker's notifier delivers. On success → DELIVERED. On failure → `attempts + 1`, `next_attempt_at = now + min(5 s · 2^attempts, 10 min)`, and FAILED after 8 attempts.
3. The sweep re-enqueues PENDING rows that are due, covering lost jobs. A job for a SUPERSEDED or DELIVERED row is a no-op. The job's singleton key is the notification id, so reprocessing delivers at most once per row.
4. **Remind** (`POST /v1/me/holds/:id/notify`, payer): locks the hold; refuses with 429 if the last notification is younger than 60 s; marks earlier `hold_review` rows SUPERSEDED, **clears the active credential**, inserts `seq = max + 1`. Concurrent reminders serialise on the hold row, so at most one notification, and at most one credential, is ever live.
5. **Failure** never grants authority: the hold stays HELD, the payer sees "We couldn't reach Sarah yet" with Remind and Cancel.
6. `demo_inbox` delivery is a database write (the message becomes visible to the inbox owner). It follows the same interface and states.

**The 72 h auto-void is a real void.** The hold-timeout job decides VOID and the executor calls PayPal's void on the authorization (verified in `executor.ts` `holdTimeout` → `decideVoid` → `executeVoid`). The UI may say "cancelled, nothing taken" only after PayPal confirms VOIDED.

## 9. First payment and recipient identity

- **`payee_key`** is what the money actually goes to: the lower-cased payout receiver email when the intent has one (`email:<addr>`), otherwise `id:<payee.id>`. The second form is integrator-asserted; that is documented, and it is what Render uses while payouts are off.
- **The spoofing case this closes**: re-using a known `payee.id` with a new email no longer counts as "paid before", because history is keyed by the email the payout would use.
- **`paid_before`** = a `payee_history` row exists for `(tenant, shopper, payee_key)`. `first_payment = asserted_first || !paid_before`, so asserting `false` can't weaken the rule.
- **History is written only when a transfer reaches CAPTURED**, in the same transaction as that transition (`ON CONFLICT DO NOTHING`, so duplicate captures add nothing). Authorized, voided, declined and failed payments establish nothing.
- **Imported history** is admin-only, audited (`payee_history.imported`). The demo's "Rose has paid Morgan & Sons before" is an import, labelled.
- **Backfill**: the migration inserts `source = backfill` rows for transfers already CAPTURED.

## 10. Demo: separate contexts, honestly labelled (question H)

- **Each visitor gets their own Rose.** `POST /api/sk/session` creates a demo payer (own shopper, own API key with `shopper` scope only) and stores the key in an httpOnly cookie. The shared demo shopper is no longer used by `/pay`. One visitor's guardian can never receive another visitor's holds, and the 48 h delay is real.
- **Sarah's phone is its own window.** `/guardian` creates a demo inbox (`POST /v1/demo/inboxes`), receives the address and a 192-bit inbox secret, and keeps the secret only in **that tab's `sessionStorage`**. It is never in a cookie, so other tabs of the same site don't send it. Rose enrols Sarah by the inbox **address**, which is public, like a phone number.
- **Inbox routes need the demo role plus the inbox secret** (`x-inbox-secret`, hash-compared) and are tenant-scoped. The shopper role has no route to them. Tests prove the payer's key, a missing secret, a wrong secret and another tenant are all refused.
- **Label everywhere** (`/pay`, `/guardian`, `/holds`): "Demo channel: this window stands in for Sarah's phone. In production the request goes by text or email from a provider, and that channel's security is what separates the two keys."
- **Limit:** both windows run on one computer; whoever controls both windows plays both people. The demo proves the **API boundary**, not channel independence.

## 11. Threat model

| # | Threat | Attack path | Protection after 0020 | Remaining weakness | Mitigation, phase |
|---|---|---|---|---|---|
| T1 | Compromised payer session | Attacker has the payer's key or session | Can't approve guardian holds, read the inbox or mint credentials (invariant, tests). Can request loosening, which is delayed 48 h with the guardian told | Can cancel the payer's payments; can enrol their own channel as a *first* guardian on an unprotected account | Step-up auth for profile changes, P3 |
| T2 | Coached payer | Scammer talks the payer through it | Payer can't approve; can only cancel or remind. Loosening and replacement are delayed and visible to the guardian | Splitting below the threshold; paying an already-known payee; using another app | Velocity rule (P2); honest boundary copy |
| T3 | Malicious payer self-approval | Calls `/approve` with their own key, or as admin | 403 in the engine, audited `hold.approve_refused` | Enrolling a self-controlled channel as guardian | Verified channels (production); stated limit |
| T4 | Malicious or compromised guardian | Approves a scam | Can approve only the exact purchase, payee and amount; never receives funds; payer can cancel; payer can revoke immediately | A colluding guardian can approve | Reviewer identity and quorum (P3) |
| T5 | Leaked credential | Fragment link forwarded, screenshot | 30 min, one decision, bound to guardian, purchase and tenant; re-notify kills it; 10-attempt limit | Within 30 min a leaked link decides once | Device binding (P3) |
| T6 | Replay | Re-send a decision | Same decision replays the recorded result; opposite gets 409; a consumed hold refuses | — | — |
| T7 | Cross-tenant | Use an id from another tenant | Every new query filters on tenant; credentials are bound to tenant; tests | — | — |
| T8 | Concurrent approve and cancel | Race | Row lock on purchase and hold; exactly one applies; tests | — | — |
| T9 | Notifier compromise or failure | Provider down or hostile | Failure leaves the hold HELD with no fallback; credentials only ever go to the guardian's channel | A hostile provider sees credentials in transit | Real provider with signed links (P3) |
| T10 | Database or secret exposure | Read DB | Only hashes of credentials, inbox secrets and API keys | An attacker writing to the DB bypasses everything | Infra hardening, out of scope |
| T11 | Prompt injection, adversarial evidence | Crafted conversation | Model output can only add `unknown`; it never selects the approver; failures are fail-closed and labelled technical | A model fooled into "low" removes an evidence hold, but the rule still applies | Policy over grounded evidence (separate work item) |
| T12 | Threshold splitting or alternate recipient | $499 × 4, or new payee ids | Threshold 0 is allowed; the rule counts first payments only | **Not prevented**: splitting under the threshold, or paying a known payee | Velocity and aggregate rule (P2); stated on `/how` |

## 12. Resolved questions

- **A. Removal or replacement with open holds:** §7. Reassigned on replacement, unassigned (cancel-only) on removal. Never the payer.
- **B. Compromised guardian:** emergency revocation, immediate, reason audited, holds unapprovable until a delayed replacement.
- **C. Multiple pending changes:** one per kind; conflicting combinations get 409; applied in request order; re-validated at effect; a tighten supersedes.
- **D. Multiple guardians:** one per payer in this milestone. A future quorum path adds a `guardians` many-to-one with `required_approvals`; `holds.guardian_id` becomes a set.
- **E. Guardian denial:** cancels that purchase only (its authorization is voided). It never blocks the payee or future payments.
- **F. Modified payments:** a purchase is bound to its frozen intent digest and cart digest. Approval re-reads PayPal and re-checks both (existing three-way match and stale-intent check). A changed amount or recipient is a new intent and a new purchase, screened again, needing a new decision. A credential is bound to one purchase id.
- **G. Token leakage:** §5.
- **H. Demo inbox isolation:** §10.
- **I. Admin:** can read evidence and audit, and can cancel (attributed `admin`). **Can't approve guardian holds.**
- **J. Lifecycle while Sarah reviews:** if the hold was cancelled or auto-voided first, her approval gets 409 "Already decided". If approval succeeds but capture fails, the decision and the money result are shown separately (existing NEEDS_RECONCILE and CAPTURE_DECLINED states). If PayPal's order changed, approval voids instead of capturing (existing re-check).
- **K. Account deletion:** no deletion path exists for shoppers or guardians. A guardian ends only by removal (delayed) or revocation (immediate, cancel-only). A **new** shopper identity starts with no protection; preventing that is the integrating platform's identity responsibility, stated as a limit.
- **L. Existing records:** existing holds become `approver = 'legacy'` and keep today's behaviour (principal or link). They all auto-void within 72 h of authorization, so no long-lived weak path remains. Existing intents keep their digests (`TransferPolicyV1` is unchanged). Captured transfers are backfilled into `payee_history`.
- **Open question 1 (agent purchases):** transfers by agents inherit the profile; agent shopping keeps principal approval; no claim beyond that.
- **Open question 2 (delay):** 48 h by default, a minimum of 24 h, server time, a test clock.
- **Open question 3 (cooling-off without a guardian):** deferred to P2. The hold engine's `approver` and `reason_classes` leave room for it.

## 13. Deferred

An admin route for emergency revocation; real SMS and email notifiers; an automatic re-assessment for `ASSESSMENT_UNAVAILABLE`; multiple guardians and quorum; agent spending authority; cooling-off without a guardian; velocity and splitting rules; verified channels and reviewer identity; step-up authentication for profile changes; device binding of credentials.

## 14. API changes

| Method and path | Role | Change |
|---|---|---|
| `GET /v1/me/protection` | shopper | New: profile, guardian (masked address), pending changes |
| `POST /v1/me/protection/threshold` | shopper | New |
| `POST /v1/me/guardians` | shopper | New: invite |
| `POST /v1/me/protection/guardian` · `/remove` · `/revoke` | shopper | New |
| `POST /v1/me/protection/changes/:id/cancel` | shopper | New |
| `POST /v1/me/holds/:id/notify` | shopper | New: remind; never returns a credential |
| `POST /v1/me/demo/transfers/:name` | shopper (demo enabled) | New: run a demo transfer for the calling payer |
| `POST /v1/demo/payers` | demo | New: a fresh demo payer and its shopper key (the web keeps it in an httpOnly cookie) |
| `POST /v1/demo/inboxes` | demo | New: `{address, secret}` |
| `GET /v1/demo/inboxes/:address/messages` | demo + `x-inbox-secret` | New |
| `POST /v1/demo/inboxes/:address/messages/:id/open` · `/accept` | demo + `x-inbox-secret` | New: mint a hold credential / accept an invite |
| `POST /v1/holds/:id/view` · `/verification` | credential in body | New (replaces `?t=`) |
| `GET /v1/holds/:id` · `/verification` | bearer only | **Changed:** `?t=` no longer accepted |
| `POST /v1/holds/:id/approve` | credential, or principal on principal holds | **Changed:** bearer approval of a guardian hold → 403 |
| `POST /v1/purchases/:id/hold-link` | shopper | **Changed:** principal and legacy holds only (the principal already holds approval authority); 409 for guardian holds. The returned path carries the credential in the fragment (`/holds/:id#k=…`) |

## 15. Tests that prove it

- Rose can't approve a guardian hold, by bearer or by link; admin can't either.
- Sarah's credential decides only the purchase it was minted for.
- A credential minted before a re-notify, a replacement or a revocation is refused afterwards.
- A replaced guardian can't approve new or reassigned holds; the new guardian receives a notification.
- Replacement concurrent with approval → exactly one outcome.
- A notification failure leaves the hold HELD, and the payer still can't approve.
- AI unavailable → HELD, classed `ASSESSMENT_UNAVAILABLE`, never PROCEED.
- A profile change after screening doesn't alter the snapshot or the stored decision.
- An intent with a higher threshold, no threshold or `first_payment: false` can't weaken the profile or history.
- Payee history: only captures count; duplicate captures add one row; a known id with a new email is a first payment; imports need admin.
- The inbox can't be read with the payer's key, without the secret, with a wrong secret, or from another tenant.
- The proxy allowlist forwards no shopper route that returns a hold credential.

## 16. Verification (2026-11-02)

- `pnpm typecheck` and `pnpm deps:check`: clean.
- `pnpm test`: all vitest and node tests pass (see the commit for counts). `apps/api/test/guardian.db.test.ts` (22 tests) covers §15.
- Existing tests changed only where the contract changed: credentials move from `?t=` to POST bodies; a benign transfer now needs recorded history (an audited import) instead of an asserted `first_payment: false`; the "(link)" decider label now names the account holder.
- Browser rehearsal on a **local stack with the repo's fake PayPal and fake model** (no sandbox credentials on this machine). Covered: setup, invite, Sarah accepting in her own window, a paused payment, refusals from Rose's tab (401/403/409, no credential in her view), Sarah declining, Desk attribution, a pending loosen. **Not yet re-run against the PayPal sandbox on Render.**
