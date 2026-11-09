import { GuardianPhone } from "./phone";

export const metadata = { title: "Sarah's phone · Second Key" };

// The trusted contact's phone, simulated (ADR-0020 §10): its own window, its own inbox secret.
export default function Page() {
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 440, margin: "0 auto", width: "100%" }}>
        <span className="sk-section-title">The trusted contact</span>
      </header>
      <GuardianPhone />
    </div>
  );
}
