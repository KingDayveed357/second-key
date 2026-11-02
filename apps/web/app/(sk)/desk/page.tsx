import { cookies } from "next/headers";
import { Suspense } from "react";
import { SESSION_COOKIE, consoleConfigured, validSession } from "../../../lib/server/session";
import { Workspace } from "./workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Protection Desk · Second Key" };

// The investigation workspace. Without a console session it is a public, read-only view of the
// current demo session (synthetic data, served with the demo key). Operators sign in for the full
// tenant history; the Desk itself never approves, captures or cancels a payment.
export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; signin?: string }> }) {
  const { error, signin } = await searchParams;
  const operator = consoleConfigured() && validSession((await cookies()).get(SESSION_COOKIE)?.value);
  const header = (
    <header className="stack-sm" style={{ maxWidth: 820 }}>
      <span className="sk-section-title">Protection Desk</span>
      <h1 style={{ fontSize: "var(--text-2xl)" }}>What needs attention, why it was flagged, and what PayPal says happened.</h1>
      <p className="soft small">Each row is a payment Second Key intervened on. The AI&apos;s assessment, the rule that decided, the person&apos;s decision and PayPal&apos;s state are separate columns, because they are separate facts.</p>
    </header>
  );

  if (!operator && (signin || error)) {
    return (
      <div className="stack-lg">
        {header}
        {consoleConfigured() ? (
          <form method="post" action="/api/console/login" className="sk-card stack" style={{ maxWidth: 400 }}>
            <input type="hidden" name="next" value="/desk" />
            <p className="small soft">Operator sign-in shows the full tenant history. Still read-only: the Desk can&apos;t approve, capture or cancel a payment.</p>
            <label className="stack-sm small">
              Password
              <input type="password" name="password" autoComplete="current-password" required style={{ minHeight: 44, padding: "0 12px", borderRadius: 10, border: "1px solid var(--line-strong)", font: "inherit", background: "var(--surface)", color: "var(--ink)" }} />
            </label>
            {error && <p className="small" style={{ color: "var(--brick)" }} role="alert">That password didn&apos;t match.</p>}
            <button className="sk-btn primary">Sign in</button>
            <a className="small" href="/desk">Back to the public view</a>
          </form>
        ) : (
          <div className="sk-card">Operator sign-in isn&apos;t configured on this deployment. <a href="/desk">Use the public view.</a></div>
        )}
      </div>
    );
  }

  return (
    <div className="stack-lg">
      {header}
      <Suspense>
        <Workspace mode={operator ? "operator" : "public"} licenseKey={process.env.AG_STUDIO_LICENSE_KEY ?? ""} />
      </Suspense>
    </div>
  );
}
