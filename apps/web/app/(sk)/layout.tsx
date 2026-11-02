import Link from "next/link";
import "./sk.css";
import { Mark } from "./_ui/mark";
import { Demo, Live, Nav } from "./_ui/ui";

// Second Key chrome. The legend in the footer is the product's honesty contract: anything marked
// "Live sandbox" was read from the real backend or PayPal sandbox; "Demo data" is synthetic.
export default function SecondKeyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sk">
      <header className="sk-top">
        <div className="inner">
          <Link href="/" className="sk-brand">
            <Mark title="Second Key" />
            Second Key
          </Link>
          <Nav />
        </div>
      </header>
      <main className="sk-main" id="main">
        {children}
      </main>
      <footer className="sk-foot">
        <Live />
        <Demo>Demo data: synthetic people, conversations and the trusted contact&apos;s phone</Demo>
        <span>PayPal sandbox only. No real money moves.</span>
        <Link href="/try" style={{ marginLeft: "auto" }}>
          Test the analysis on your own text
        </Link>
      </footer>
    </div>
  );
}
