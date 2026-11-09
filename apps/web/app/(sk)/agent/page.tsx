import { Agent } from "./agent";
import { MandateDemo } from "./mandates";

export const metadata = { title: "Agent demo · Second Key" };

export default function Page() {
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 760 }}>
        <span className="sk-section-title">The same safety, for AI agents · on AP2 mandates</span>
        <h1 style={{ fontSize: "var(--text-2xl)" }}>Your agent was authorized. Was it right?</h1>
        <p className="soft">
          Rose signs an AP2 mandate on her own device: what her agent may buy, from whom, for how much. AP2 proves the agent was allowed to pay. Second Key proves it bought what she meant, and that PayPal charged exactly that. Five runs: one goes through; each of the others is stopped by a different check.
        </p>
      </header>
      <MandateDemo />
      <section className="stack-lg" aria-labelledby="no-ap2" style={{ marginTop: "var(--s8)" }}>
        <header className="stack-sm" style={{ maxWidth: 760 }}>
          <span className="sk-section-title">Without AP2</span>
          <h2 id="no-ap2" style={{ fontSize: "var(--text-xl)" }}>
            An agent that doesn&apos;t speak AP2 gets the same protection
          </h2>
          <p className="soft small">Here Rose confirms her request in Second Key directly instead of signing a mandate. Second Key checks the cart against it using product facts it fetches itself, and checks PayPal&apos;s stored order before any capture.</p>
        </header>
        <Agent />
      </section>
    </div>
  );
}
