"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText, money, tone } from "../../lib/client";

/** Dispute view (ADR-0010): attach a buyer-opened dispute, review drafted evidence, approve and submit. */
export function Disputes() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api("/v1/console/disputes", { console: true }).then((r) => setRows(r.disputes), (e) => setErr(errText(e))), []);
  useEffect(() => {
    load();
  }, [load]);

  async function attach(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/v1/console/disputes", { method: "POST", body: { dispute_id: newId.trim() }, console: true });
      setNewId("");
      await load();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted small">
        A buyer opens a dispute in PayPal. Attach it here by its PayPal dispute ID: Second Key checks it is against one of its captures, drafts evidence from the record,
        and submits it only after you approve the exact text.
      </p>
      <form className="card row" onSubmit={attach}>
        <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="PayPal dispute ID, e.g. PP-D-12345" style={{ flex: 1, minWidth: 220 }} required />
        <button className="primary" disabled={busy}>Attach</button>
        <button type="button" onClick={load}>Refresh list</button>
      </form>
      {err && <p className="error">{err}</p>}
      {rows?.length === 0 && <p className="muted">No disputes attached.</p>}
      {rows?.map((d) => <DisputeCard key={d.id} d={d} onChange={load} />)}
    </div>
  );
}

function DisputeCard({ d, onChange }: { d: any; onChange: () => void }) {
  const [draft, setDraft] = useState<{ text: string; source: string; model?: string } | null>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setMsg("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <strong>{d.id}</strong>
        <span className={`badge ${d.outcome ? (/SELLER/.test(d.outcome) ? "ok" : "bad") : "warn"}`}>{d.outcome ?? d.status}</span>
        {d.simulated_verdict && <span className="badge">simulated verdict (sandbox)</span>}
        <span className="small muted">{d.reason} · {money(d.amount_cents, d.currency ?? "USD")} · purchase <code>{d.purchase_id}</code> · capture <code>{d.capture_id}</code></span>
      </div>
      <div className="small muted">PayPal allows now: {d.allowed_actions.length ? d.allowed_actions.join(", ") : "nothing"}</div>
      {d.evidence_submitted_at ? (
        <div className="small">
          <span className={`badge ${tone("CAPTURED")}`}>evidence submitted</span> by {d.evidence_submitted_by} at {new Date(d.evidence_submitted_at).toLocaleString()}
          <pre className="json" style={{ whiteSpace: "pre-wrap" }}>{d.evidence_text}</pre>
        </div>
      ) : (
        <>
          {!draft && (
            <button disabled={!!busy} onClick={() => act("draft", async () => { const r = await api(`/v1/purchases/${d.purchase_id}/dispute-evidence/draft`, { method: "POST", console: true }); setDraft(r); setText(r.text); })}>
              {busy === "draft" ? "Drafting…" : "Draft evidence from the record"}
            </button>
          )}
          {draft && (
            <div className="stack">
              <div className="small muted">Draft by {draft.source === "ai" ? `${draft.model}` : "template (AI unavailable)"}; numbers and IDs are inserted from the record, not written by the model. Edit if needed, then approve.</div>
              <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
              <div className="row">
                <button
                  className="primary"
                  disabled={!!busy || !d.allowed_actions.includes("provide_evidence")}
                  onClick={() => { if (window.confirm("Submit exactly this text to PayPal as evidence? This can be done once.")) act("submit", () => api(`/v1/console/disputes/${d.id}/submit`, { method: "POST", body: { text }, console: true })); }}
                >
                  {busy === "submit" ? "Submitting…" : "Approve and submit to PayPal"}
                </button>
                {!d.allowed_actions.includes("provide_evidence") && <span className="small muted">PayPal isn&apos;t accepting evidence for this dispute right now.</span>}
              </div>
            </div>
          )}
        </>
      )}
      <div className="row small">
        <button disabled={!!busy} onClick={() => act("refresh", () => api(`/v1/console/disputes/${d.id}/refresh`, { method: "POST", console: true }))}>Refresh from PayPal</button>
        {(d.allowed_actions.includes("require_evidence") || (d.evidence_submitted_at && d.allowed_actions.includes("adjudicate"))) && (
          <button disabled={!!busy} onClick={() => act("step", () => api(`/v1/console/disputes/${d.id}/sandbox-step`, { method: "POST", console: true }))} title="Sandbox-only PayPal call. A verdict reached this way is labelled simulated.">
            Sandbox: advance dispute (simulated)
          </button>
        )}
      </div>
      {msg && <p className="error small">{msg}</p>}
    </div>
  );
}
