import type { Metadata } from "next";
import Link from "next/link";
import "../globals.css";

export const metadata: Metadata = {
  title: "Operator console · Second Key",
  description: "Second Key operator console: the ledger, held payments, evidence chains and disputes, on the PayPal sandbox.",
};

// The password-gated operator console (AG Studio), on its own chrome until it moves into the Desk.
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="console">
      <header className="top">
        <div className="wrap">
          <Link href="/" className="brand">Second Key · Operator console</Link>
          <nav>
            <Link href="/desk">Protection Desk</Link>
            <Link href="/developers">Developers</Link>
            <Link href="/">Overview</Link>
          </nav>
          <span className="sandbox">PayPal sandbox · no real money</span>
        </div>
      </header>
      <main>
        <div className="wrap">{children}</div>
      </main>
    </div>
  );
}
