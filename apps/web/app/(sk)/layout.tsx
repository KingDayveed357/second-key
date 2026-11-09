import Link from "next/link";
import "./sk.css";
import "./sk-shell.css";
import { Mark } from "./_ui/mark";
import { Nav } from "./_ui/ui";

const REPO = "https://github.com/KingDayveed357/second-key";

// Second Key chrome. What is real, sandboxed and synthetic is stated once, in the footer and in full
// on /about, rather than tagged on every component. The footer ends on the brand signature.
export default function SecondKeyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sk">
      <a className="sk-skip" href="#main">
        Skip to content
      </a>
      <header className="sk-top">
        <div className="inner">
          <Link href="/" className="sk-brand">
            <Mark title="Second Key" />
            Second Key
          </Link>
          <Nav />
        </div>
      </header>
      <main className="sk-main" id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="sk-footer">
        <div className="sk-footer-inner">
          <div className="sk-footer-top">
            <div className="sk-footer-brand">
              <Mark size={18} />
              <p className="statement">Manipulation shouldn&apos;t move money.</p>
              <p className="note">
                A working demo on the PayPal sandbox with synthetic people. No real money moves. <Link href="/about">What&apos;s real here</Link>
              </p>
            </div>
            <nav className="sk-footer-nav" aria-label="Footer">
              <div>
                <h2>See it work</h2>
                <ul>
                  <li>
                    <Link href="/pay">People</Link>
                  </li>
                  <li>
                    <Link href="/agent">Agents</Link>
                  </li>
                  <li>
                    <Link href="/try">Try the analysis</Link>
                  </li>
                </ul>
              </div>
              <div>
                <h2>Inspect it</h2>
                <ul>
                  <li>
                    <Link href="/desk">Protection Desk</Link>
                  </li>
                  <li>
                    <Link href="/developers">Developers</Link>
                  </li>
                  <li>
                    <Link href="/about">About this demo</Link>
                  </li>
                </ul>
              </div>
              <div>
                <h2>Source</h2>
                <ul>
                  <li>
                    <a href={REPO}>GitHub ↗</a>
                  </li>
                  <li>
                    <a href={`${REPO}/blob/main/docs/openapi.yaml`}>OpenAPI ↗</a>
                  </li>
                  <li>
                    <a href={`${REPO}/tree/main/docs/decisions`}>Decision records ↗</a>
                  </li>
                </ul>
              </div>
            </nav>
          </div>
          <div className="sk-footer-legal">
            <span>© 2026 Second Key</span>
            <span>Built for the PayPal AI Hackathon · PayPal sandbox only</span>
          </div>
        </div>
        {/* The brand signature, full width. Decorative: the header link already names the product. */}
        <div className="sk-footer-sign">
          <p className="sk-wordmark" aria-hidden="true">
            Second Key
          </p>
        </div>
      </footer>
    </div>
  );
}
