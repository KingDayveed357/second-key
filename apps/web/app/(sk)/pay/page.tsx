import { Payer } from "./payer";

export const metadata = { title: "People · Second Key" };

export default function Page() {
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 720 }}>
        <span className="sk-section-title">People</span>
        <h1 style={{ fontSize: "var(--text-2xl)" }}>Rose is about to send money.</h1>
        <p className="soft">Choose what prompted the payment, then send it from Rose&apos;s phone. If it pauses, Rose can cancel it but can&apos;t approve it. Only Sarah can, on her own phone.</p>
      </header>
      <Payer />
    </div>
  );
}
