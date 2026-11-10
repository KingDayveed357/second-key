import { Agent } from "./agent";
import { Challenge } from "./challenge";
import { MandateDemo } from "./mandates";
import { Replay } from "./replay";
import { RealShop } from "./shop";

export const metadata = { title: "Agents · Second Key" };

// One primary experience and one advanced one (10 Nov):
//   #real-products  the agent shops real products under Rose's signed mandate (the main demo);
//   #beat           try to beat Second Key: the visitor attacks everything except the mandate;
//   #replay         the scripted cases, collapsed: the poisoned page (#poisoned) and five AP2 runs (#ap2).
export default function Page() {
  return (
    <div className="sk-agent-page">
      <header className="sk-agent-head">
        <span className="sk-section-title">Agents</span>
        <h1>Rose&apos;s agent shops for her. Second Key makes sure it buys what she meant.</h1>
        <p className="soft">She signs what she wants on her own device. The agent can be wrong, rushed or manipulated; the money only moves when the purchase matches what she signed.</p>
        <nav className="sk-jump" aria-label="On this page">
          <a href="#real-products" className="primary">
            Try it with real products <span aria-hidden>↓</span>
          </a>
          <a href="#beat">
            Try to beat Second Key <span aria-hidden>↓</span>
          </a>
          <a href="#replay">
            Replay the cases <span aria-hidden>↓</span>
          </a>
        </nav>
      </header>

      <section id="real-products" className="sk-agent-section" aria-labelledby="shop-h">
        <header>
          <span className="sk-section-title">Real products · Channel3 · PayPal sandbox</span>
          <h2 id="shop-h">Try it with real products</h2>
          <p className="soft small">
            Say what Rose wants. The agent searches real products through Channel3, Rose&apos;s device signs what she approved, and every purchase the agent attempts is checked against it before PayPal captures anything.
          </p>
        </header>
        <RealShop />
      </section>

      <section id="beat" className="sk-agent-section" aria-labelledby="beat-h">
        <header>
          <span className="sk-section-title">Advanced</span>
          <h2 id="beat-h">Try to beat Second Key</h2>
          <p className="soft small">Rose&apos;s mandate is fixed. Everything else is yours: the page her agent reads, the purchase it proposes, and the messages it gets. Pick a prepared attack or write your own.</p>
        </header>
        <Challenge />
      </section>

      <section id="replay" className="sk-agent-section" aria-labelledby="replay-h">
        <header>
          <span className="sk-section-title">Scripted, repeatable</span>
          <h2 id="replay-h">Replay the cases</h2>
          <p className="soft small">The same protections on fixed trail-shoe pages, so each run comes out the same way every time.</p>
        </header>
        <Replay
          items={[
            { id: "poisoned", title: "A poisoned page: the purchase waits for Rose", meta: "Four runs · real PayPal sandbox", children: <Agent /> },
            { id: "ap2", title: "Five AP2 runs, each stopped by a different check", meta: "Signed on this device · real verifier", children: <MandateDemo /> },
          ]}
        />
      </section>
    </div>
  );
}
