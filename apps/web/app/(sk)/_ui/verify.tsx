"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "../../../lib/client";
import { clock, moneyTruth, payoutTruth, type PayPalRead } from "../../../lib/sk";
import { Button, Live } from "./ui";

/**
 * PayPal's own record of the money, read live through the backend. `path` is the read endpoint the
 * viewer is allowed to use (/v1/purchases/:id/paypal, or POST /v1/holds/:id/verification with the
 * reviewer's credential in `body`: never in a URL). Re-reads whenever `refreshKey` changes, and on demand.
 */
export function PayPalCheck({
  path,
  amount,
  refreshKey,
  console: inConsole,
  transfer,
  body,
}: {
  path: string;
  /** Send as a POST with this body (the reviewer's credential). */
  body?: unknown;
  amount: string;
  refreshKey?: string;
  console?: boolean;
  /** For a transfer: who the recipient is and whether payouts are configured. */
  transfer?: { payee: string; configured: boolean };
}) {
  const [read, setRead] = useState<PayPalRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      setRead(await api<PayPalRead>(path, body === undefined ? { console: inConsole } : { method: "POST", body }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }, [path, inConsole, JSON.stringify(body ?? null)]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const t = moneyTruth(read, amount);
  const po = transfer && t.kind === "captured" ? payoutTruth(read, { ...transfer, amount }) : null;

  // After a capture, keep reading until PayPal reports the payout settled (bounded).
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!po || po.settled || polls >= 40) return;
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      void load();
    }, 3000);
    return () => clearTimeout(t);
  }, [po?.settled, po?.kind, polls, load]);
  return (
    <div className="sk-verify" aria-live="polite">
      <div className="head">
        <Live>PayPal sandbox, read live</Live>
        <Button variant="quiet" size="sm" onClick={load} busy={busy}>
          Check again
        </Button>
      </div>
      {err ? (
        <span className="soft">Couldn&apos;t reach PayPal ({err}). This doesn&apos;t change the payment; try again.</span>
      ) : !read && busy ? (
        <span className="soft">Checking with PayPal…</span>
      ) : (
        <strong style={{ fontWeight: 600 }}>{t.text}</strong>
      )}
      {t.reference && (
        <span className="xs muted">
          {po ? "Capture" : "Reference"} <span className="mono">{t.reference}</span>
          {read?.fetched_at ? ` · checked ${clock(read.fetched_at)}` : ""}
          {read?.debug_id ? <> · PayPal debug <span className="mono">{read.debug_id}</span></> : null}
        </span>
      )}
      {po && (
        <div className="stack-sm" style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 2 }}>
          <span className="sk-section-title">Then: paying the recipient</span>
          {po.settled ? <strong style={{ fontWeight: 600 }}>{po.text}</strong> : <span className="soft">{po.text}</span>}
          {po.reference && (
            <span className="xs muted">
              Payout <span className="mono">{po.reference}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
