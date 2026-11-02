import { cookies } from "next/headers";
import { SESSION_COOKIE, consoleConfigured, validSession } from "../../../lib/server/session";
import { ConsoleShell } from "../../_components/console-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Operator console · Second Key" };

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!consoleConfigured()) {
    return (
      <div className="card">
        <h1>Ops console</h1>
        <p className="muted">The console is not configured on this deployment (WITNESS_CONSOLE_PASSWORD and WITNESS_SESSION_SECRET are required). It stays closed rather than open.</p>
      </div>
    );
  }
  if (!validSession((await cookies()).get(SESSION_COOKIE)?.value)) {
    const { error } = await searchParams;
    return (
      <form method="post" action="/api/console/login" className="card stack" style={{ maxWidth: 380 }}>
        <h1>Ops console</h1>
        <p className="muted small">For platform reviewers: the ledger, the HOLD queue, evidence chains and disputes. Read-only: the console cannot approve on a shopper&apos;s behalf, capture or void.</p>
        <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
        {error && <p className="error small">Wrong password.</p>}
        <button className="primary">Sign in</button>
      </form>
    );
  }
  return <ConsoleShell licenseKey={process.env.AG_STUDIO_LICENSE_KEY ?? ""} />;
}
