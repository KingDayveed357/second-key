"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "../../../lib/client";
import { clock, moneyTruth, payoutTruth, type PayPalRead } from "../../../lib/sk";
import { Button, Pill } from "./ui";

type Tone = "held" | "ok" | "bad" | "neutral" | "pending";
/** PayPal's own status words, glossed. The raw word is always shown beside the gloss. */
const AUTH: Record<string, [string, Tone]> = { CREATED: ["Reserved", "held"], CAPTURED: ["Captured", "ok"], PARTIALLY_CAPTURED: ["Partly captured", "ok"], VOIDED: ["Voided", "neutral"], EXPIRED: ["Expired", "neutral"], DENIED: ["Denied", "bad"], PENDING: ["Pending", "pending"] };
const CAPTURE: Record<string, [string, Tone]> = { COMPLETED: ["Captured", "ok"], PENDING: ["Pending", "pending"], DECLINED: ["Declined", "bad"], FAILED: ["Failed", "bad"], REFUNDED: ["Refunded", "neutral"], PARTIALLY_REFUNDED: ["Partly refunded", "neutral"] };
const gloss = (map: Record<string, [string, Tone]>, s: string): [string, Tone] => map[s] ?? [s.toLowerCase().replace(/_/g, " "), "neutral"];

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
  const order = read?.order?.status ?? read?.order_status ?? null;
  const auth = read?.authorizations?.[0];
  const cap = read?.captures?.[0];
  const op = (label: string, status: string | null | undefined, id: string | null | undefined, map: Record<string, [string, Tone]>, none: string) => {
    const [text, tone] = status ? gloss(map, status) : [none, "neutral" as Tone];
    return (
      <div>
        <dt>{label}</dt>
        <dd className="idcell">{status ? <span className="id">{status}{id ? ` · ${id}` : ""}</span> : <span className="none">{none}</span>}</dd>
        <dd>{status ? <Pill tone={tone}>{text}</Pill> : null}</dd>
      </div>
    );
  };
  return (
    <div className="sk-verify" aria-live="polite">
      <div className="head">
        <span className="sk-section-title">PayPal&apos;s record</span>
        <Button variant="quiet" size="sm" onClick={load} busy={busy}>
          Check again
        </Button>
      </div>
      {err ? (
        <span className="soft">Couldn&apos;t reach PayPal ({err}). This doesn&apos;t change the payment; try again.</span>
      ) : !read && busy ? (
        <span className="soft">Reading PayPal&apos;s record…</span>
      ) : (
        <>
          <strong style={{ fontWeight: 600 }}>{t.text}</strong>
          {read && (
            <dl className="sk-pp-ops" aria-label="Each PayPal operation">
              {op("Order", order, null, { CREATED: ["Created", "neutral"], APPROVED: ["Buyer approved", "neutral"], SAVED: ["Saved", "neutral"], COMPLETED: ["Placed", "neutral"], VOIDED: ["Voided", "neutral"] }, "No order")}
              {op("Authorization", auth?.status, auth?.id, AUTH, "None")}
              {op("Capture", cap?.status, cap?.id, CAPTURE, auth?.status === "VOIDED" ? "None: voided first" : "None yet")}
              {transfer && t.kind === "captured" && (
                <div>
                  <dt>Payout</dt>
                  <dd className="idcell">{po?.reference ? <span className="id">{read.payout?.item_status ?? read.payout?.batch_status ?? ""} · {po.reference}</span> : <span className="none">{po?.text}</span>}</dd>
                  <dd>{po?.kind === "paid" ? <Pill tone="ok">Paid out</Pill> : po?.kind === "failed" || po?.kind === "unclaimed" ? <Pill tone="bad">{po.kind === "failed" ? "Failed" : "Unclaimed"}</Pill> : po?.kind === "not_configured" ? null : <Pill tone="pending">Sending</Pill>}</dd>
                </div>
              )}
            </dl>
          )}
        </>
      )}
      {read?.fetched_at && (
        <span className="xs muted">
          Read from the PayPal sandbox at {clock(read.fetched_at)}
          {read.debug_id ? <> · debug <span className="mono">{read.debug_id}</span></> : null}
        </span>
      )}
    </div>
  );
}
