import { Agent } from "./agent";
import { MandateDemo } from "./mandates";
import { RealShop } from "./shop";

export const metadata = { title: "Agents · Second Key" };

// Two ways an agent's purchase is checked. First the story a judge needs: Rose's agent meets a page that
// tries to redirect it, and the purchase waits for Rose. Then the same protection for agents that carry
// an AP2 mandate (#ap2: the video script's AP2 shots start at that heading).
export default function Page() {
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 760 }}>
        <span className="sk-section-title">Agents</span>
        <h1 style={{ fontSize: "var(--text-2xl)" }}>Rose&apos;s agent was told what to buy. Then a page told it something else.</h1>
        <p className="soft">
          Rose asked her shopping agent for trail shoes within clear limits. Run it on an ordinary page, then on a poisoned one, and compare what Rose asked for, what the page said, what the agent did and what Second Key decided.
        </p>
      </header>
      <Agent />
      <section id="ap2" className="stack-lg" aria-labelledby="ap2-h" style={{ marginTop: "var(--s8)" }}>
        <header className="stack-sm" style={{ maxWidth: 760 }}>
          <span className="sk-section-title">Agents with an AP2 mandate</span>
          <h2 id="ap2-h" style={{ fontSize: "var(--text-xl)" }}>
            AP2 proves the agent was allowed to pay. Second Key proves it bought what Rose meant.
          </h2>
          <p className="soft small">Rose signs an AP2 mandate on her own device. Five runs: one goes through; each of the others is stopped by a different check.</p>
        </header>
        <MandateDemo />
        <RealShop />
      </section>
    </div>
  );
}
