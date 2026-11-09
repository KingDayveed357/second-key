import Link from "next/link";

export const metadata = { title: "About this demo · Second Key", description: "What is real, sandboxed, synthetic and simulated in the Second Key demo, the tools it is built on, and what it can't do." };

// The one place that says exactly what this demo is. Every other page shows the product and links here.
export default function About() {
  return (
    <article className="sk-doc">
      <header className="stack-sm">
        <span className="sk-section-title">About this demo</span>
        <h1>What&apos;s real here, and what isn&apos;t</h1>
        <p className="sk-lede">Second Key is working software. The money it controls is PayPal sandbox money, and the people and pages are made up.</p>
      </header>

      <section aria-labelledby="real">
        <h2 id="real">Real</h2>
        <ul>
          <li>The Second Key engine, API, executor and database: every decision on these pages is made by the same code an integrator would call.</li>
          <li>Every PayPal call: orders, authorizations, captures, voids and payouts are real requests to the PayPal <strong>sandbox</strong>, and every status shown is read back from PayPal.</li>
          <li>The AI analysis (Claude), on the text you see. Code checks that every quote it cites really appears in the source.</li>
          <li>The audit trail: hash-chained, and re-verified on the Protection Desk.</li>
          <li>AP2 mandate signing and verification, including the keys in your browser.</li>
        </ul>
      </section>

      <section aria-labelledby="synthetic">
        <h2 id="synthetic">Synthetic or simulated</h2>
        <ul>
          <li>Rose, Sarah, &ldquo;Danny&rdquo;, the callers and the contractor. Their calls and messages are prepared transcripts.</li>
          <li>The product pages and the shopping agent&apos;s choices. The agent is scripted so each run is repeatable.</li>
          <li>Sarah&apos;s phone: a separate browser window that holds its own key. In production the request goes by text or email through a provider, and that channel keeps the two keys apart. Here both windows run on one computer, so the demo proves the API boundary, not channel security.</li>
          <li>Recipients: one sandbox account receives every payout.</li>
          <li>Product facts come from labelled fixtures unless a Channel3 key is configured.</li>
        </ul>
      </section>

      <section aria-labelledby="transfers">
        <h2 id="transfers">How a transfer works here</h2>
        <p>A payment is platform-mediated: PayPal holds an authorization to the Second Key demo merchant, which is then voided or captured. On approval there are two separate PayPal steps, each confirmed: the capture, then a payout to the recipient. It is not a PayPal Friends &amp; Family payment, and Second Key can&apos;t cancel arbitrary PayPal transfers.</p>
      </section>

      <section aria-labelledby="limits">
        <h2 id="limits">What it can&apos;t do</h2>
        <ul>
          <li>The AI can miss manipulation. That is why it can only add a pause: the rules and a person decide, and PayPal&apos;s record is the outcome.</li>
          <li>It protects payments made through platforms that build it in. It doesn&apos;t stop someone paying through another app, or splitting a payment below their threshold.</li>
          <li>It doesn&apos;t listen to calls. People choose to share a conversation; the rule they set in advance works without one.</li>
        </ul>
      </section>

      <section aria-labelledby="tools">
        <h2 id="tools">Built on</h2>
        <dl className="sk-doc-tools">
          <div>
            <dt>PayPal Orders v2 and Payouts</dt>
            <dd>Authorize to reserve, void to stop, capture and pay out to complete.</dd>
          </div>
          <div>
            <dt>Claude (Anthropic)</dt>
            <dd>Finds manipulation and instructions aimed at agents, with quoted evidence.</dd>
          </div>
          <div>
            <dt>AG Grid and AG Studio</dt>
            <dd>The Protection Desk&apos;s incident queue, and Insights with a read-only analyst.</dd>
          </div>
          <div>
            <dt>Channel3</dt>
            <dd>Independent product facts by ID, so a check never relies on the page an agent read.</dd>
          </div>
          <div>
            <dt>Render</dt>
            <dd>The web app, API, worker and Postgres this demo runs on.</dd>
          </div>
          <div>
            <dt>Postman</dt>
            <dd>A public collection that asserts on PayPal&apos;s own state.</dd>
          </div>
        </dl>
      </section>

      <p className="small soft">
        Want to test the AI on your own words? <Link href="/try">Try the analysis</Link>. The code, decisions and threat model are on <a href="https://github.com/KingDayveed357/second-key">GitHub</a>.
      </p>
    </article>
  );
}
