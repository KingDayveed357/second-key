import { Payer } from "./payer";

export const metadata = { title: "Payer demo · Second Key" };

export default function Page() {
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 720 }}>
        <span className="sk-section-title">Experience A · the payer</span>
        <h1 style={{ fontSize: "var(--text-2xl)" }}>Rose is about to send money.</h1>
        <p className="soft">This is what she sees. Every status on this page comes from the real engine and the PayPal sandbox; the people and conversations are synthetic.</p>
      </header>
      <Payer />
    </div>
  );
}
