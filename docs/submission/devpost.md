# Devpost submission: Second Key

Draft for the PayPal AI Hackathon 2026 submission form. Every number links to evidence in the repo; nothing here is claimed that a judge can't check. Paste section by section.

---

**Project name:** Second Key

**Elevator pitch (≤ 200 characters):**
> Your agent was authorized. Was it right? Second Key checks an AI agent's purchase against what you meant, and what PayPal will charge, before any money moves.

**Demo:** https://witness-web.onrender.com (PayPal sandbox, synthetic people; no sign-in)
**Repository:** https://github.com/KingDayveed357/second-key (MIT)
**Video:** <YouTube link, under 3 minutes>

---

## Inspiration

Agentic payments are arriving with a solid answer to one question: *was this agent allowed to pay?* Google's AP2 has the user sign a mandate, the agent close it, and anyone verify the signatures. Two other questions stay open, though:
- **Did it buy what I meant?** AP2 can list item IDs and cap a price; it can't say "not white".
- **Is PayPal about to charge for exactly that?** A checkout can hand PayPal a different item at the same price.

We also kept meeting the human version of the same failure: someone being coached through a payment by a "grandson" or "the bank". An agent and a frightened person fail the same way: whoever is giving instructions isn't the person whose money it is.

## What it does

Second Key is a safety layer platforms build into their PayPal payment flow. It sits between the decision to pay and the money moving.

**For AI agents, on real AP2 mandates.** In the demo, your browser plays Rose's device. A WebCrypto key generated there signs her open mandates: a Ridgeline trail runner, size 10, not white, up to $90. A scripted agent closes them. Second Key then checks four things and settles:

1. **Signatures and delegation:** Rose's key, then only the agent key she named, then the merchant's checkout.
2. **AP2's own constraints:** listed items, merchant, amount, payee, and the payment bound to this checkout. Any AP2 verifier does this; ours passes Google's reference SDK interop.
3. **Second Key's facts:** "size 10, not white" checked against product facts Second Key fetches and signs itself, never the agent's or the merchant's description. AI only checks the listing for instructions aimed at agents, and can only make the answer stricter.
4. **The ledger:** one mandate, one use, with budgets and recurrence tracked across merchants.
5. **Then PayPal:** a conforming payment is bound to the PayPal order, which must hold exactly the verified checkout before the isolated executor captures it. Otherwise it's voided.

Five runs show five outcomes: one purchase completes, and each of the other four is stopped by a different check. That includes the one AP2 alone can't catch: the white shoe Rose's own list allows. Every decision comes with a signed receipt you can verify in the browser.

**For people under pressure.** Rose sets a rule while she's calm: first payments of $500+ to someone new need Sarah. When a payment matches, PayPal reserves the money and only Sarah, on her own device, can release it. Rose can cancel but can't approve, so neither can whoever is coaching her. If she shares the conversation, Claude Haiku quotes the pressure tactics, and code checks every quote appears verbatim.

**For operators and developers.**
- **The Protection Desk** (AG Grid and AG Studio) shows every intervention with its evidence chain verified.
- **`/developers`** has a one-click test verification that needs no account and no key, AP2 constraint templates as JSON, and a conformance suite run on the sandbox.

## How we built it

- **TypeScript monorepo:**
  - a Fastify API that screens, verifies and binds;
  - an **isolated worker**, the only code that can capture or void (enforced by import rules and a route-inventory test);
  - a Next.js web app whose proxy holds every key server-side;
  - Postgres with a hash-chained audit log, and pg-boss jobs written in the same transaction as the state they act on.
- **AP2:** our own SD-JWT and delegation-chain verifier (`jose`, ES256), validated against AP2's canonical JSON schemas and tested both ways against Google's reference SDK. Receipts are ES256 JWTs with a published JWKS.
- **PayPal:** Orders v2 with vaulted, buyer-not-present AUTHORIZE; capture and void with deterministic request IDs; Payouts; Webhooks; Disputes. Every outcome is read back from PayPal, and order status alone never counts as payment.
- **Claude Haiku:** evidence with code-verified quotes, listing and injection checks, and the Studio analyst. It never approves.
- **AG Grid and AG Studio** for the Desk, **Channel3** for independent product facts, **Render** for hosting.

## Challenges we ran into

- **Making AP2 claims we could defend.** We verified tokens from the spec's own examples and tested interop in both directions with Google's reference SDK. Along the way we found four places where that SDK differs from the spec. One is security-relevant and is reported to Google. We also found an upstream schema bug.
- **State without races:** budgets and single use across merchants. The ledger keys on what the issuer signed, so trimming disclosures can't reset it. A test holds one transaction open and proves the second waits.
- **A test harness that lied:** a dependency forced exit code 0, so failing database tests passed CI. We found it by deliberately breaking our own rules and watching a test fail while the run "passed".

## Accomplishments that we're proud of

- **AP2 on the real sandbox:** a settlement passed 4 of 4 scenarios, each checked against PayPal's own order ([evidence](../evidence/ap2-settlement-sandbox-run.md)).
- **Tests that bite:** 175 AP2 tests, and all 39 deliberate breaks of the verifier, ledger and settlement rules were caught.
- **The second key really is someone else's:** 24 API tests show the payer and admin can't approve, and a race between revocation and approval leaves exactly one outcome.
- **0 captures without a consumed approval,** computed from the database and shown live.

## What we learned

- Authorization and conformance are different guarantees, and both stop short of settlement: you need all three, and each is checked by a different party.
- Writing "AI only adds caution" into the architecture is what makes AI safe to use near money.

## What's next

- Tenant-pinned trust anchors and a KMS-held receipt key.
- A Second Key receipt as a capture precondition for PSPs that keep their own PayPal accounts.
- Proposing the attribute constraint and facts attestation to the FIDO payments working group.
- Production channels for the trusted contact.

## Built with

PayPal Orders v2 · PayPal Payments · PayPal Payouts · PayPal Webhooks · PayPal Disputes · AP2 · SD-JWT · jose · Anthropic Claude Haiku · AG Grid · AG Studio · Channel3 · Render · TypeScript · Node.js · Fastify · Next.js · React · PostgreSQL · pg-boss · Drizzle · Zod · Vitest

---

## Before submitting (checklist)

- [ ] **Google security report:** the reference-SDK issue has gone to g.co/vulnz before the repo is public. The details sit in `packages/ap2/interop/README.md`, `packages/ap2/test/constraint-cases.json` and `constraint-parity.test.ts`.
- [ ] **Repo:** public, with the MIT licence visible in its About section.
- [ ] **Video:** under 3 minutes, public on YouTube, with no unlicensed music or third-party trademarks.
- [ ] **Render:**
  - `SECONDKEY_RECEIPT_JWK` is set, so receipts keep verifying across restarts;
  - this branch is deployed, with migrations 0008–0010 applied;
  - the agent and developer pages have been run once on the live URL;
  - `SECONDKEY_DEMO_RECIPIENT_EMAIL` is set, so the video's pay shot shows the payout (without it, payouts are off).
- [ ] **Availability:** the hosted demo stays up through the end of judging (Dec 15), and the AG Studio licence covers it.
