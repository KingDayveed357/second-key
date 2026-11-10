import Link from "next/link";
import { ConstraintTemplates, TestVerification } from "../_ap2/kit";
import { Code, Shell } from "./code";
import { Conformance, Counters } from "./conformance";
import {
  AP2,
  AP2_RESPONSE,
  ENV,
  ERROR_SAMPLE,
  SETUP,
  STEP_INTENT,
  STEP_INTENT_RESPONSE,
  STEP_PURCHASE,
  STEP_PURCHASE_RESPONSE,
  STEP_RESULT,
  STEP_RESULT_RESPONSE,
  TRANSFER,
  TRANSFER_RESPONSE,
} from "../../../lib/dev-samples";

export const metadata = { title: "Developers · Second Key" };

const REPO = "https://github.com/KingDayveed357/second-key";
const BLOB = `${REPO}/blob/main`;

const TOC: { id: string; label: string; group?: string }[] = [
  { id: "start", label: "Overview", group: "Get started" },
  { id: "quickstart", label: "Quickstart" },
  { id: "transfers", label: "Protect a transfer" },
  { id: "ap2", label: "Verify AP2 mandates" },
  { id: "sandbox", label: "Sandbox scenarios", group: "Test" },
  { id: "try-ap2", label: "Try AP2 verification" },
  { id: "keys", label: "Keys and roles", group: "Reference" },
  { id: "decisions", label: "Decisions and states" },
  { id: "errors", label: "Errors" },
  { id: "idempotency", label: "Idempotency" },
  { id: "events", label: "Events" },
  { id: "limits", label: "Rate limits" },
  { id: "versioning", label: "Versioning" },
  { id: "guarantees", label: "Guarantees" },
  { id: "resources", label: "Resources" },
];

// The developer guide: what Second Key is to an integrator, a quickstart that ends in a real
// sandbox capture, the reference an integration needs, and the test tools. Every sample was run.
export default function Page() {
  return (
    <div className="sk-dev">
      <nav className="sk-dev-toc" aria-label="On this page">
        {TOC.map((t) => (
          <span key={t.id} className="sk-dev-toc-item">
            {t.group && <span className="sk-dev-toc-group">{t.group}</span>}
            <a href={`#${t.id}`}>{t.label}</a>
          </span>
        ))}
      </nav>

      <div className="sk-dev-main">
        {/* ---------------------------------------------------------------- overview */}
        <section id="start" className="sk-dev-hero">
          <span className="sk-section-title">Developers</span>
          <h1>Put a second key between your payment decision and PayPal.</h1>
          <p className="sk-lede">
            Wallets, marketplaces and agent platforms call Second Key with the payment they are about to make. It checks the payment against what the person authorized, has PayPal reserve the money, and completes it only when the checks pass or the right person approves.
          </p>
          <div className="sk-dev-env">
            <span>
              <strong>Sandbox only.</strong> Every call reaches the PayPal sandbox; the API refuses any other PayPal host.
            </span>
            <span className="mono">REST · JSON · Bearer keys · /v1 payments · /v2 AP2</span>
          </div>
          <div className="sk-dev-ctas">
            <a className="sk-btn primary" href="#quickstart">
              Quickstart: first capture in 10 minutes
            </a>
            <a className="sk-btn secondary" href="#try-ap2">
              Try AP2 verification, no setup
            </a>
            <a className="sk-btn quiet" href={`${BLOB}/docs/openapi.yaml`}>
              API reference (OpenAPI)
            </a>
          </div>

          <div className="sk-dev-paths">
            <a href="#quickstart">
              <strong>Protect payments</strong>
              <span>Wallets and platforms where people or agents pay. Intents, purchases, transfers, a trusted contact.</span>
              <code>/v1/intents · /v1/purchases</code>
            </a>
            <a href="#ap2">
              <strong>Verify AP2 mandates</strong>
              <span>Agent platforms and PSPs on Google&apos;s Agent Payments Protocol. Verification, a mandate ledger, settlement against PayPal&apos;s order, signed receipts.</span>
              <code>/v2/verifications · /v2/settlements</code>
            </a>
            <Link href="/desk">
              <strong>Operate</strong>
              <span>Risk and support teams. Every decision with its evidence, the rule, the person and PayPal&apos;s record.</span>
              <code>/v1/console/* · Protection Desk</code>
            </Link>
          </div>
        </section>

        {/* ---------------------------------------------------------------- how it works */}
        <section className="sk-dev-section" aria-labelledby="how">
          <h2 id="how">How an integration works</h2>
          <ol className="sk-dev-flow">
            <li>
              <strong>The person confirms an intent.</strong> Exactly this payee and amount, or, for an agent, this category, budget and retailers. Second Key freezes it and digests it.
            </li>
            <li>
              <strong>Your app or agent submits the payment</strong> against that intent, with an idempotency key. Rules run first; a rule failure is refused before PayPal is called.
            </li>
            <li>
              <strong>PayPal reserves; Second Key decides.</strong> Orders v2 with intent AUTHORIZE. Clean: capture. The payer&apos;s rule or the evidence: hold for the right person. PayPal&apos;s stored order differs from what was approved: void.
            </li>
            <li>
              <strong>Only the executor moves money.</strong> A separate worker with no inbound port captures or voids by consuming a single-use approval, and re-reads PayPal&apos;s order first. There is no capture endpoint to call.
            </li>
          </ol>
        </section>

        {/* ---------------------------------------------------------------- quickstart */}
        <section id="quickstart" className="sk-dev-section" aria-labelledby="quickstart-h">
          <span className="sk-section-title">Quickstart</span>
          <h2 id="quickstart-h">From an intent to a captured payment</h2>
          <p className="soft">
            Run Second Key locally against your PayPal sandbox app, then make an agent purchase: the person confirms what the agent may buy, the agent submits a cart, and you read the outcome from Second Key and from PayPal. About ten minutes.
          </p>

          <div className="sk-dev-step">
            <span className="sk-dev-step-n">1</span>
            <div>
              <h3>Run it locally</h3>
              <p className="small soft">
                Needs Node 24, pnpm 10 and a PayPal sandbox app with Vault enabled. An Anthropic key is optional; without one, every AI check fails closed and payments hold.
              </p>
              <Shell code={SETUP} />
              <p className="small soft">The seed creates a sandbox tenant, a payer with a saved PayPal wallet, and one key per role. Export the two you need:</p>
              <Shell code={ENV} title="Environment" />
            </div>
          </div>

          <div className="sk-dev-step">
            <span className="sk-dev-step-n">2</span>
            <div>
              <h3>The person confirms what the agent may buy</h3>
              <p className="small soft">
                Create the intent with the <code>shopper</code> key (or send <code>{`{ "text": "..." }`}</code> and Claude drafts the policy for the person to review), show it to them, then confirm. Confirmation freezes it: the agent can read it, never change it.
              </p>
              <Code samples={STEP_INTENT} response={STEP_INTENT_RESPONSE} responseLabel="Response · 200 (confirmed)" />
            </div>
          </div>

          <div className="sk-dev-step">
            <span className="sk-dev-step-n">3</span>
            <div>
              <h3>The agent submits its cart</h3>
              <p className="small soft">
                With the <code>agent</code> key and an <code>Idempotency-Key</code>. Send product ids only: Second Key fetches the product facts itself and never uses the agent&apos;s description. The answer comes back at once with the decision so far.
              </p>
              <Code samples={STEP_PURCHASE} response={STEP_PURCHASE_RESPONSE} responseLabel="Response" />
            </div>
          </div>

          <div className="sk-dev-step">
            <span className="sk-dev-step-n">4</span>
            <div>
              <h3>Read the outcome, from Second Key and from PayPal</h3>
              <p className="small soft">
                Poll the purchase until its state is final. Then read what PayPal itself recorded, and re-verify the purchase&apos;s audit trail. This run reached <code>CAPTURED</code> about 13 seconds after submission.
              </p>
              <Code samples={STEP_RESULT} response={STEP_RESULT_RESPONSE} responseLabel="GET /v1/purchases/:id/paypal · 200" />
            </div>
          </div>

          <p className="small soft">
            Next: change the cart to break the intent (<code>TRL-WHT-10</code> is the white shoe, <code>TRL-PRO-10</code> costs $480) and watch it refused before PayPal is called. The <a href="#sandbox">sandbox scenarios</a> list every case.
          </p>
        </section>

        {/* ---------------------------------------------------------------- transfers */}
        <section id="transfers" className="sk-dev-section" aria-labelledby="transfers-h">
          <span className="sk-section-title">Guide</span>
          <h2 id="transfers-h">Protect a transfer with a second key</h2>
          <p className="soft">
            A person paying someone. The intent names the payee and the amount, and carries the payer&apos;s own rule, set in advance: first payments to someone new above an amount get a second look. A held transfer is approved only by the payer&apos;s trusted contact, on their own device. The payer and your admins can cancel it but can&apos;t approve it.
          </p>
          <Code samples={TRANSFER} response={TRANSFER_RESPONSE} responseLabel="Response · the payer's rule paused it" />
          <dl className="sk-dev-dl">
            <dt>
              <code>GET /v1/me/protection</code>
            </dt>
            <dd>The payer&apos;s standing protection: threshold, trusted contact, pending changes.</dd>
            <dt>
              <code>POST /v1/me/protection/threshold</code> · <code>/guardian</code>
            </dt>
            <dd>Tightening applies at once. Loosening, or replacing the trusted contact, waits 48 hours and the current contact is told.</dd>
            <dt>
              <code>POST /v1/me/guardians</code>
            </dt>
            <dd>Invite a trusted contact; they accept through their own channel.</dd>
            <dt>
              <code>POST /v1/me/holds/:id/cancel</code> · <code>/notify</code>
            </dt>
            <dd>The payer cancels a held payment, or reminds the trusted contact.</dd>
            <dt>
              <code>POST /v1/holds/:id/approve</code> · <code>/deny</code>
            </dt>
            <dd>The reviewer decides, with a single-use credential sent in the request body, never in a URL. It expires after 30 minutes and locks after 10 wrong attempts.</dd>
          </dl>
        </section>

        {/* ---------------------------------------------------------------- AP2 */}
        <section id="ap2" className="sk-dev-section" aria-labelledby="ap2-h">
          <span className="sk-section-title">Guide</span>
          <h2 id="ap2-h">Verify AP2 mandates, then settle on PayPal</h2>
          <p className="soft">
            For platforms whose agents carry AP2 v0.2 mandates. Second Key acts as a delegated verifier, and checks four things:
          </p>
          <ul className="sk-dev-list">
            <li>the SD-JWT delegation chains;</li>
            <li>every standard constraint, plus two of its own: attributes such as size and colour, checked against product facts it fetches and signs, and a co-signer above an amount;</li>
            <li>a ledger across merchants, so a mandate can&apos;t be reused or overspent;</li>
            <li>then, before capture, that PayPal&apos;s stored order holds exactly the verified checkout.</li>
          </ul>
          <p className="soft">Every decision comes with an ES256 receipt you can verify against the published key set.</p>
          <Code samples={AP2} response={AP2_RESPONSE} responseLabel="Response (abridged)" />
          <p className="small soft">
            Needs a key with the <code>ap2:verify</code> scope. Receipts verify against <code>/.well-known/jwks.json</code>. Interop with Google&apos;s reference SDK is tested in both directions;{" "}
            <a href={`${BLOB}/docs/decisions/0023-ap2-delegated-verifier.md`}>ADR-0023</a> has the details and limits.
          </p>
        </section>

        {/* ---------------------------------------------------------------- sandbox */}
        <section id="sandbox" className="sk-dev-section" aria-labelledby="sandbox-h">
          <span className="sk-section-title">Test</span>
          <h2 id="sandbox-h">Sandbox scenarios</h2>
          <p className="soft">
            Named cases you can run against the sandbox, like test cards for card payments. Each one is a real payment through the same API an integrator uses, with an expected outcome. Run one, then compare the result with PayPal&apos;s own record and the audit trail. The cart swap is the case spend limits miss: the agent&apos;s cart is right, but the order PayPal receives isn&apos;t.
          </p>
          <Counters />
          <Conformance />
        </section>

        <section id="try-ap2" className="sk-dev-section" aria-labelledby="try-ap2-h">
          <span className="sk-section-title">Test · no account, no key</span>
          <h2 id="try-ap2-h">Try AP2 verification in your browser</h2>
          <TestVerification />
          <div id="templates">
            <ConstraintTemplates />
          </div>
          <p className="small soft">
            <strong>Mandate templates</strong> are starting points for the constraints you put in a user&apos;s AP2 mandate: exactly one item, a recurring purchase with a budget, or a second signer above an amount. Each says which checks enforce it: any AP2 verifier, or Second Key&apos;s own.
          </p>
        </section>

        {/* ---------------------------------------------------------------- reference */}
        <section id="keys" className="sk-dev-section" aria-labelledby="keys-h">
          <span className="sk-section-title">Reference</span>
          <h2 id="keys-h">Keys and roles</h2>
          <p className="soft">
            Send <code>Authorization: Bearer wk_…</code>. Each key belongs to one tenant and one role, so a key can do only its role&apos;s work. Keys are stored only as SHA-256 hashes and can be revoked. Keep them on your server, never in an app or browser.
          </p>
          <div className="sk-dev-table" role="region" aria-label="Roles" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Held by</th>
                  <th>Can</th>
                  <th>Can&apos;t</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>shopper</code>
                  </td>
                  <td>Your app, for one person</td>
                  <td>Create, confirm and revoke intents; read their purchases; set their protection; cancel their held payments</td>
                  <td>Submit a payment; approve a hold that waits for their trusted contact</td>
                </tr>
                <tr>
                  <td>
                    <code>agent:purchase</code>
                  </td>
                  <td>The agent or checkout</td>
                  <td>Read a confirmed intent; submit purchases; read its own purchases</td>
                  <td>Create or change an intent; see other agents&apos; purchases</td>
                </tr>
                <tr>
                  <td>
                    <code>ap2:verify</code>
                  </td>
                  <td>AP2 merchant, PSP or platform</td>
                  <td>Verify mandates; bind settlements; read both</td>
                  <td>Anything in /v1</td>
                </tr>
                <tr>
                  <td>
                    <code>ops</code>
                  </td>
                  <td>Risk and support teams</td>
                  <td>Read every purchase, hold and webhook in the tenant; work PayPal disputes</td>
                  <td>Approve, capture or cancel</td>
                </tr>
                <tr>
                  <td>
                    <code>admin</code>
                  </td>
                  <td>The platform</td>
                  <td>Everything above, plus audited imports</td>
                  <td>Approve a hold that waits for a trusted contact</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small soft">
            <strong>Getting keys:</strong> this is a hackathon build with no self-serve signup. Run it locally and <code>pnpm db:seed</code> issues sandbox keys. The hosted demo&apos;s API is reached only through this site, so you can&apos;t send it your own requests. There is no live mode: it is sandbox only by design.
          </p>
        </section>

        <section id="decisions" className="sk-dev-section" aria-labelledby="decisions-h">
          <h2 id="decisions-h">Decisions and states</h2>
          <div className="sk-dev-table" role="region" aria-label="Outcomes" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Means</th>
                  <th>PayPal</th>
                  <th>Final state</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>CAPTURE</code>
                  </td>
                  <td>Everything matches the intent</td>
                  <td>Authorized, verified, captured</td>
                  <td>
                    <code>CAPTURED</code>
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>REJECT</code>
                  </td>
                  <td>The payment breaks the intent</td>
                  <td>Never called</td>
                  <td>
                    <code>REJECTED</code>
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>HOLD</code>
                  </td>
                  <td>A rule or the evidence asks for a person</td>
                  <td>Authorized and reserved</td>
                  <td>
                    <code>HELD</code>, then <code>CAPTURED</code> or <code>VOIDED</code> (auto-void within 72 h)
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>VOID</code>
                  </td>
                  <td>PayPal&apos;s stored order isn&apos;t what was approved</td>
                  <td>Authorization voided</td>
                  <td>
                    <code>VOIDED</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small soft">
            Other states you may see on the way: <code>SCREENING</code>, <code>AUTHORIZING</code>, <code>VERIFYING</code>, <code>CAPTURE_APPROVED</code>, <code>CAPTURING</code>, <code>VOIDING</code>, and, rarely, <code>AUTH_FAILED</code>, <code>CAPTURE_DECLINED</code> or <code>NEEDS_RECONCILE</code> (re-read from PayPal automatically). <code>reasons</code> lists each failing or pausing check as <code>check_id: detail</code>.
          </p>
        </section>

        <section id="errors" className="sk-dev-section" aria-labelledby="errors-h">
          <h2 id="errors-h">Errors</h2>
          <p className="soft">
            Errors are <a href="https://www.rfc-editor.org/rfc/rfc9457">RFC 9457</a> problem documents with a <code>trace_id</code> to quote when you report one. They never include stack traces or SQL.
          </p>
          <div className="sk-dev-grid2">
            <Code samples={[{ lang: "curl", code: ERROR_SAMPLE }]} title="Example" />
            <div className="sk-dev-table" role="region" aria-label="Status codes" tabIndex={0}>
              <table>
                <tbody>
                  <tr><td><code>400</code></td><td>Malformed body, unknown field or wrong type</td></tr>
                  <tr><td><code>401</code></td><td>Missing or invalid key</td></tr>
                  <tr><td><code>403</code></td><td>The key&apos;s role can&apos;t do this</td></tr>
                  <tr><td><code>404</code></td><td>Not found in your tenant</td></tr>
                  <tr><td><code>409</code></td><td>Conflict: wrong state, or a concurrent request</td></tr>
                  <tr><td><code>413</code></td><td>Body too large</td></tr>
                  <tr><td><code>422</code></td><td>Valid JSON that breaks a rule (for example the idempotency key)</td></tr>
                  <tr><td><code>429</code></td><td>Slow down; see <code>Retry-After</code></td></tr>
                  <tr><td><code>502</code></td><td>PayPal or the catalog failed; safe to retry with the same key</td></tr>
                  <tr><td><code>503</code></td><td>A dependency isn&apos;t configured</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="idempotency" className="sk-dev-section" aria-labelledby="idem-h">
          <h2 id="idem-h">Idempotency</h2>
          <p className="soft">
            <code>POST /v1/purchases</code>, <code>/v2/verifications</code> and <code>/v2/settlements</code> require an <code>Idempotency-Key</code> header: 8 to 128 characters of <code>A-Z a-z 0-9 _ . : -</code> for purchases, 8 to 200 printable characters for AP2. Derive it from your own order or cart id, so a retry is the same purchase:
          </p>
          <ul className="sk-dev-list">
            <li>
              <strong>Same key, same body:</strong> the original result comes back with <code>200</code>, and nothing is charged twice.
            </li>
            <li>
              <strong>Same key, different body:</strong> <code>422</code>.
            </li>
            <li>
              <strong>Two requests racing with one key:</strong> one wins, and the other gets its result or a <code>409</code> to retry.
            </li>
          </ul>
          <p className="soft">
            Keys are kept for good, per tenant. Inside Second Key, every PayPal call carries a deterministic request id, so PayPal also deduplicates.
          </p>
        </section>

        <section id="events" className="sk-dev-section" aria-labelledby="events-h">
          <h2 id="events-h">Events</h2>
          <p className="soft">
            Second Key doesn&apos;t send webhooks to integrators yet: poll <code>GET /v1/purchases/:id</code> until the state is final, as in step 4. Holds can take up to 72 hours, so poll those slowly. Second Key itself receives PayPal&apos;s webhooks, verifies their signatures with PayPal, and re-reads the resource before acting on any of them. Signed outbound events are on the roadmap.
          </p>
        </section>

        <section id="limits" className="sk-dev-section" aria-labelledby="limits-h">
          <h2 id="limits-h">Rate limits</h2>
          <p className="soft">
            Routes that call the AI model have per-process budgets: 30 listing screens and 20 analyses a minute. Through this website, each visitor may make 12 such calls a minute. Beyond that you get <code>429</code> with <code>Retry-After</code>. The AI also has spend caps; when one is reached, AI checks fail closed and payments hold. Other routes have no rate limit in this build.
          </p>
        </section>

        <section id="versioning" className="sk-dev-section" aria-labelledby="versioning-h">
          <h2 id="versioning-h">Versioning</h2>
          <p className="soft">
            Versions are in the path: <code>/v1</code> for payments and <code>/v2</code> for AP2, which is versioned separately because it follows AP2 v0.2. The <a href={`${BLOB}/docs/openapi.yaml`}>OpenAPI contract</a> is version 0.3.0. Every change of behaviour is written up as a decision record (<a href={`${BLOB}/docs/decisions`}>ADR-0001 to 0023</a>). Request bodies are strict: an unknown field is refused, never silently ignored.
          </p>
        </section>

        <section id="guarantees" className="sk-dev-section" aria-labelledby="guarantees-h">
          <h2 id="guarantees-h">What Second Key guarantees, and what it doesn&apos;t</h2>
          <div className="sk-dev-grid2">
            <ul className="sk-dev-list">
              <li>Money moves only in the executor, by consuming a single-use approval bound to the exact order, amount, payee and cart. The rule is enforced by import rules and a route inventory test.</li>
              <li>AI can only add caution. It can pause a payment, never approve one, and code checks that every quote it cites really appears in the source.</li>
              <li>Product facts come from the catalog by id, never from the agent or the merchant.</li>
              <li>Every state change is written to a hash-chained audit log in the same transaction. Verify it at <code>GET /v1/verify/purchases/:id</code>.</li>
            </ul>
            <ul className="sk-dev-list soft">
              <li>It protects payments made through platforms that integrate it. It can&apos;t stop a payment made elsewhere.</li>
              <li>The AI can miss manipulation, so the rules and a person decide.</li>
              <li>Sandbox only: there are no live keys and no SLA.</li>
              <li>
                The full list is in the <a href={`${BLOB}/docs/threat-model.md`}>threat model</a>.
              </li>
            </ul>
          </div>
        </section>

        <section id="resources" className="sk-dev-section" aria-labelledby="resources-h">
          <h2 id="resources-h">Resources</h2>
          <div className="sk-dev-res">
            <a href={`${BLOB}/docs/openapi.yaml`}>
              <strong>API reference</strong>
              <span>OpenAPI 3.1: every route, schema and error</span>
            </a>
            <a href={`${BLOB}/postman/second-key.postman_collection.json`}>
              <strong>Postman collection</strong>
              <span>The sandbox scenarios with assertions on PayPal&apos;s own state, plus AP2</span>
            </a>
            <a href={`${BLOB}/docs/architecture.md`}>
              <strong>Architecture</strong>
              <span>Components, trust boundaries, both flows, the executor</span>
            </a>
            <a href={`${BLOB}/docs/threat-model.md`}>
              <strong>Threat model</strong>
              <span>What it defends against, and what it doesn&apos;t</span>
            </a>
            <a href={`${BLOB}/docs/decisions`}>
              <strong>Decision records</strong>
              <span>Why it works the way it does, ADR by ADR</span>
            </a>
            <a href={`${REPO}/issues`}>
              <strong>Support</strong>
              <span>Open a GitHub issue; include the trace_id</span>
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
