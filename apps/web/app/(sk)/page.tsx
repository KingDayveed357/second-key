import Link from "next/link";
import { Demo, Live } from "./_ui/ui";

export const metadata = { title: "Second Key: a second key for payments made under pressure" };

// Leads with what triggers the pause (ADR-0019/0020): a rule the payer set in advance and a person they
// trust. The conversation is optional evidence that can add to the rule, never the trigger itself.
export default function Home() {
  return (
    <div className="stack-lg" style={{ gap: "var(--s8)" }}>
      <section className="sk-hero">
        <div className="stack" style={{ gap: "var(--s5)" }}>
          <span className="sk-section-title">Payment safety for payments made under pressure</span>
          <h1>
            When someone is pressuring you to pay, <em>someone you trust</em> holds the second key.
          </h1>
          <p className="sk-lede">
            You set a rule while you&apos;re calm, like a second look for first payments of $500 or more to someone new. When a payment matches it, Second Key pauses it. PayPal reserves the money, and only the person you trust can let it go ahead. You can&apos;t approve it yourself, so neither can someone coaching you.
          </p>
          <div className="row">
            <Link href="/pay" className="sk-btn primary">
              See it protect a payment
            </Link>
            <Link href="/desk" className="sk-btn secondary">
              Open the Protection Desk
            </Link>
          </div>
          <div className="row" style={{ gap: "var(--s4)" }}>
            <Live>Real engine and PayPal sandbox</Live>
            <Demo>Synthetic people and conversations</Demo>
          </div>
        </div>

        <figure className="sk-card stack" style={{ padding: "var(--s6)" }} aria-label="Example: a paused payment">
          <span className="sk-section-title">Rose&apos;s payment · synthetic</span>
          <p className="serif" style={{ fontSize: "1.6rem", lineHeight: 1.3, letterSpacing: "-0.01em" }}>
            $1,800 to J. Morgan, someone she has never paid.
          </p>
          <div className="small">
            <strong>Paused by her rule:</strong> first payments of $500 or more to someone new.
          </div>
          <hr className="sk-hr" />
          <span className="xs muted">She chose to share the call. Second Key quotes what it noticed, word for word:</span>
          <blockquote className="small" style={{ margin: 0 }}>
            “I need eighteen hundred dollars for bail <mark style={{ background: "var(--brass-soft)", color: "inherit", padding: "0 3px" }}>right now</mark>… <mark style={{ background: "var(--brass-soft)", color: "inherit", padding: "0 3px" }}>Promise you won&apos;t tell her.</mark>”
          </blockquote>
          <p className="small soft">The money stays reserved in PayPal, not sent. Sarah gets the request on her own phone and decides.</p>
        </figure>
      </section>

      <section className="stack" aria-labelledby="how">
        <h2 id="how" style={{ fontSize: "var(--text-xl)" }}>How it works</h2>
        <ol className="sk-steps" style={{ padding: 0, margin: 0 }}>
          <li>
            <h3>You set a rule and a second key</h3>
            <p>Once, while calm: a threshold for first payments to someone new, and a person you trust who accepts on their own phone. Loosening either later takes 48 hours, and they are told.</p>
          </li>
          <li>
            <h3>A matching payment pauses</h3>
            <p>PayPal reserves the money; nothing is taken. The rule is deterministic: no AI decides whether it applies.</p>
          </li>
          <li>
            <h3>Evidence, if you share it</h3>
            <p>Share the call or chat and AI points out pressure with the exact words, checked by code to really be there. It can add a pause, never lift one or approve a payment.</p>
          </li>
          <li>
            <h3>Only your trusted contact approves</h3>
            <p>They see the exact payee, amount and evidence, and decide. You can always cancel. The result is read back from PayPal and recorded in a tamper-evident audit trail.</p>
          </li>
        </ol>
      </section>

      <section className="sk-demos" aria-label="Live demos">
        <Link href="/pay" className="sk-card stack" style={{ textDecoration: "none" }}>
          <span className="sk-section-title">Live demo · people</span>
          <h3 style={{ fontSize: "var(--text-lg)" }}>Rose gets an urgent call from “Danny”</h3>
          <p className="small soft">Set up Rose&apos;s rule and Sarah&apos;s phone, send $1,800, and watch it wait for Sarah. Compare a contractor&apos;s invoice that goes straight through.</p>
          <span className="small" style={{ color: "var(--brand)", fontWeight: 600 }}>Open the payer demo →</span>
        </Link>
        <Link href="/agent" className="sk-card stack" style={{ textDecoration: "none" }}>
          <span className="sk-section-title">Live demo · AI agents</span>
          <h3 style={{ fontSize: "var(--text-lg)" }}>A shopping agent reads a booby-trapped product page</h3>
          <p className="small soft">Hidden text tells the agent to buy something else. The same engine pauses the purchase and asks the person it works for.</p>
          <span className="small" style={{ color: "var(--brand)", fontWeight: 600 }}>Open the agent demo →</span>
        </Link>
        <Link href="/developers" className="sk-card stack" style={{ textDecoration: "none" }}>
          <span className="sk-section-title">For developers</span>
          <h3 style={{ fontSize: "var(--text-lg)" }}>Run the conformance suite on the PayPal sandbox</h3>
          <p className="small soft">Eleven real sandbox payments, including the cart swap that spend limits miss, each checked against PayPal&apos;s own record.</p>
          <span className="small" style={{ color: "var(--brand)", fontWeight: 600 }}>Open the developer page →</span>
        </Link>
      </section>

      <section className="sk-card tint stack" aria-labelledby="honest">
        <h2 id="honest" style={{ fontSize: "var(--text-lg)" }}>What this demo is, exactly</h2>
        <ul className="small soft" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
          <li>Payments run through the real Second Key engine against the PayPal <strong>sandbox</strong>. Statuses marked “Live” are read from the backend or from PayPal.</li>
          <li>A transfer here is platform-mediated: PayPal holds an authorization to the Second Key demo merchant, which is then voided or captured. It is not a PayPal Friends &amp; Family payment, and Second Key can&apos;t cancel arbitrary PayPal transfers.</li>
          <li>On approval there are two separate, verified PayPal steps: the demo merchant captures the payment, then Second Key pays it out to the recipient&apos;s PayPal account. In the demo one sandbox account stands in for every recipient.</li>
          <li>People, calls and messages are synthetic. The trusted contact&apos;s phone is simulated by a separate window that holds its own key; in production the request goes by text or email from a provider.</li>
          <li>Second Key protects payments made through the platforms it is built into. It doesn&apos;t stop someone paying through another app, or splitting a payment below their threshold.</li>
        </ul>
      </section>
    </div>
  );
}
