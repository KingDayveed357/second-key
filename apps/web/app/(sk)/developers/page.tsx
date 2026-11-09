import Link from "next/link";
import { ConstraintTemplates, TestVerification } from "../_ap2/kit";
import { Conformance, Counters } from "./conformance";

export const metadata = { title: "Developers · Second Key" };

const REPO = "https://github.com/KingDayveed357/second-key/blob/main";

// For integrators and engineers: how Second Key sits in a payment flow, the conformance suite that
// exercises it on the PayPal sandbox, and where the contracts and decisions are written down.
export default function Page() {
  return (
    <div className="stack-lg" style={{ gap: "var(--s8)" }}>
      <section className="stack" style={{ maxWidth: 760 }}>
        <span className="sk-section-title">For developers</span>
        <h1 style={{ fontSize: "var(--text-2xl)" }}>Put a second key between your payment decision and PayPal.</h1>
        <p className="sk-lede">
          Your wallet, marketplace or agent platform sends Second Key the payment it is about to make. Second Key checks it against what the person authorized, has PayPal reserve the money, and completes it only when the checks pass or the right person approves.
        </p>
      </section>

      <section className="stack" aria-labelledby="flow">
        <h2 id="flow" style={{ fontSize: "var(--text-xl)" }}>The integration, in four calls</h2>
        <ol className="sk-steps" style={{ padding: 0, margin: 0 }}>
          <li>
            <h3>The payer confirms an intent</h3>
            <p>
              <code>POST /v1/intents</code>, then <code>/confirm</code>: exactly this payee and amount (or, for an agent, these products, this budget). Frozen and digested.
            </p>
          </li>
          <li>
            <h3>Your app or agent submits the payment</h3>
            <p>
              <code>POST /v1/purchases</code> with an <code>Idempotency-Key</code>. Rules run first; a rule failure refuses before PayPal is called.
            </p>
          </li>
          <li>
            <h3>PayPal reserves; Second Key decides</h3>
            <p>Orders v2 with intent AUTHORIZE. Clean → capture. The payer&apos;s rule or the evidence → held for their trusted contact. Any mismatch with PayPal&apos;s stored order → void.</p>
          </li>
          <li>
            <h3>Only the executor moves money</h3>
            <p>An isolated worker captures or voids by consuming a single-use approval, re-checks PayPal&apos;s order first, and pays out after a verified capture.</p>
          </li>
        </ol>
      </section>

      <div className="stack" aria-label="AP2 tools">
        <div className="stack-sm" style={{ maxWidth: 760 }}>
          <span className="sk-section-title">Agents on AP2</span>
          <p className="small soft">
            For agent platforms that speak AP2: verify a signed mandate without an account or a key, then start from a constraint template. <a href="#test-verification">Run a test verification</a> · <a href="#templates">Constraint templates</a>
          </p>
        </div>
        <TestVerification />
        <ConstraintTemplates />
      </div>

      <section className="stack" aria-labelledby="suite">
        <div className="stack-sm">
          <h2 id="suite" style={{ fontSize: "var(--text-xl)" }}>Conformance suite</h2>
          <p className="small soft" style={{ maxWidth: 760 }}>
            Each case is a real payment on the PayPal sandbox, through the same API an integrator uses. Run one, then check its outcome against PayPal&apos;s own record and its hash-chained audit trail. The cart swap is the case spend limits miss: the agent&apos;s cart is right, but the order PayPal receives isn&apos;t.
          </p>
        </div>
        <Counters />
        <Conformance />
      </section>

      <section className="sk-card tint stack" aria-labelledby="refs">
        <h2 id="refs" style={{ fontSize: "var(--text-lg)" }}>References</h2>
        <ul className="small" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
          <li>
            <a href={`${REPO}/docs/openapi.yaml`}>OpenAPI contract</a> and the <a href={`${REPO}/postman/witness.postman_collection.json`}>Postman collection</a> (assertions on PayPal&apos;s own state).
          </li>
          <li>
            <a href={`${REPO}/docs/architecture.md`}>Architecture</a>, <a href={`${REPO}/docs/threat-model.md`}>threat model</a> and <a href={`${REPO}/docs/decisions`}>decision records</a>, including <a href={`${REPO}/docs/decisions/0020-out-of-band-second-key.md`}>ADR-0020: the second key is held by someone else</a>.
          </li>
          <li>
            <Link href="/try">Test the evidence analysis on your own text</Link>: what the AI observed, with the exact words, kept separate from what the fixed policy does.
          </li>
          <li>
            <Link href="/desk">Protection Desk</Link>: every intervention, the rule that decided it, the person who decided it and PayPal&apos;s state, side by side.
          </li>
        </ul>
      </section>
    </div>
  );
}
