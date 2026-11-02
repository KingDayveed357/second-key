import { Agent } from "./agent";

export const metadata = { title: "Agent demo · Second Key" };

export default function Page() {
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 720 }}>
        <span className="sk-section-title">The same safety, for AI agents</span>
        <h1 style={{ fontSize: "var(--text-2xl)" }}>An AI agent can be fooled. The money can&apos;t.</h1>
        <p className="soft">Rose&apos;s shopping agent spends within what she confirmed. Second Key checks the cart against her request using product facts it fetches itself, and checks the order PayPal actually stored before any capture. A steered agent, a page giving orders, and a swapped checkout are each caught at a different step.</p>
      </header>
      <Agent />
    </div>
  );
}
