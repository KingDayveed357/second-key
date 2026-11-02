"use client";

// The payer's standing protection (ADR-0020): set once, while calm. Tightening applies now; loosening
// or replacing the trusted contact waits 48 hours and the current contact is told. Every value shown here
// comes from the backend (GET /v1/me/protection); nothing is computed or enforced in the browser.

import { useEffect, useState } from "react";
import { api, errText } from "../../../lib/client";
import { usd, when } from "../../../lib/sk";
import { Button, Demo, Notice } from "../_ui/ui";

export interface ProtectionView {
  version: number;
  threshold_cents: number | null;
  protection_on: boolean;
  guardian: { id: string; name: string; address: string; status: string } | null;
  guardians: { id: string; name: string; address: string; status: string }[];
  pending: { id: string; kind: "threshold" | "guardian" | "remove_guardian"; value: { threshold_cents?: number | null; guardian_id?: string }; requested_at: string; effective_at: string }[];
}

const input: React.CSSProperties = { minHeight: 40, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-strong)", font: "inherit", background: "var(--surface)", color: "var(--ink)" };

/** Sarah's window announces its (public) address so Rose can enrol it without retyping. Never the secret. */
function useGuardianWindowAddress(): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("sk-demo-guardian");
    ch.onmessage = (e) => {
      const a = (e.data as { address?: unknown })?.address;
      if (typeof a === "string" && /^SK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(a)) setAddress(a);
    };
    ch.postMessage({ ask: "address" });
    return () => ch.close();
  }, []);
  return address;
}

export function openGuardianWindow() {
  window.open("/guardian", "sk-guardian", "popup,width=440,height=820");
}

/** First-run setup: a rule, then a trusted contact who accepts on their own phone. */
export function ProtectionSetup({ view, onChange }: { view: ProtectionView; onChange: (v: ProtectionView) => void }) {
  const [threshold, setThreshold] = useState("500");
  const [name, setName] = useState("Sarah");
  const [address, setAddress] = useState("");
  const [typed, setTyped] = useState(false);
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const heard = useGuardianWindowAddress();
  // Follow the phone window's number until the payer types one themselves.
  useEffect(() => {
    if (heard && !typed) setAddress(heard);
  }, [heard, typed]);

  const call = async (what: string, path: string, body?: unknown) => {
    setBusy(what);
    setErr("");
    try {
      onChange(await api<ProtectionView>(path, { method: "POST", asPayer: true, ...(body !== undefined ? { body } : {}) }));
      setAgain(false);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const accepted = view.guardians.find((g) => g.status === "ACTIVE");
  const invited = view.guardians.filter((g) => g.status === "INVITED").at(-1);

  return (
    <div className="stack-lg">
      <div className="stack-sm">
        <span className="sk-section-title">Set up your second key</span>
        <p className="small soft">Rose sets this once, while calm. Later, under pressure, it can&apos;t be switched off in a hurry.</p>
      </div>

      <div className="sk-card tint stack-sm" style={{ padding: 14 }}>
        <strong className="small">1 · Your rule</strong>
        {view.threshold_cents === null ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="small">First payments to someone new of $</span>
            <input aria-label="Threshold in dollars" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/[^\d]/g, ""))} style={{ ...input, width: 90 }} />
            <span className="small">or more get a second look.</span>
            <Button size="sm" onClick={() => call("rule", "/v1/me/protection/threshold", { threshold_cents: Number(threshold) * 100 })} busy={busy === "rule"} disabled={!threshold}>
              Set rule
            </Button>
          </div>
        ) : (
          <span className="small">First payments of {usd(view.threshold_cents)} or more to someone new get a second look. ✓</span>
        )}
      </div>

      <div className="sk-card tint stack-sm" style={{ padding: 14 }}>
        <strong className="small">2 · Who holds your second key?</strong>
        {!accepted && (!invited || again) && (
          <>
            <p className="xs soft">They get the request on their own phone. You can&apos;t approve a paused payment yourself; they can.</p>
            <div className="row" style={{ gap: 8 }}>
              <input aria-label="Their name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} style={{ ...input, width: 110 }} />
              <input aria-label="Their phone (demo address)" placeholder="SK-XXXX-XXXX" value={address} onChange={(e) => (setTyped(true), setAddress(e.target.value.toUpperCase()))} style={{ ...input, width: 150, fontFamily: "var(--mono)" }} />
              <Button size="sm" onClick={() => call("invite", "/v1/me/guardians", { display_name: name.trim(), address: address.trim() })} busy={busy === "invite"} disabled={!name.trim() || !/^SK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(address.trim())}>
                Invite
              </Button>
            </div>
            <div className="row between">
              <Button size="sm" variant="secondary" onClick={openGuardianWindow}>
                Open {name || "their"}&apos;s phone ↗
              </Button>
              <Demo>Demo channel</Demo>
            </div>
            {heard && <span className="xs muted">Found the phone open in the other window: {heard}</span>}
          </>
        )}
        {invited && !accepted && !again && (
          <Notice tone="held" title={`Waiting for ${invited.name} to accept`} role="status">
            The invitation went to {invited.name}&apos;s phone ({invited.address}). Only that phone can accept it.{" "}
            <Button size="sm" variant="quiet" onClick={() => setAgain(true)}>
              Invite a different number
            </Button>
          </Notice>
        )}
        {accepted && !view.protection_on && (
          <div className="stack-sm">
            <span className="small">{accepted.name} accepted on their phone ({accepted.address}).</span>
            <Button size="sm" onClick={() => call("assign", "/v1/me/protection/guardian", { guardian_id: accepted.id })} busy={busy === "assign"} disabled={view.threshold_cents === null}>
              Make {accepted.name} your second key
            </Button>
            {view.threshold_cents === null && <span className="xs muted">Set your rule first.</span>}
          </div>
        )}
      </div>
      {err && (
        <Notice tone="bad" role="alert">
          {err}
        </Notice>
      )}
    </div>
  );
}

const describePending = (p: ProtectionView["pending"][number], view: ProtectionView) =>
  p.kind === "threshold"
    ? p.value.threshold_cents == null
      ? "Turn off the first-payment rule"
      : `Raise the rule to ${usd(p.value.threshold_cents)}`
    : p.kind === "guardian"
      ? `Replace your trusted contact with ${view.guardians.find((g) => g.id === p.value.guardian_id)?.name ?? "someone new"}`
      : "Turn off your second key";

/** Once set up: what is in force, what is waiting, and the controls (each change goes to the backend). */
export function ProtectionSummary({ view, onChange }: { view: ProtectionView; onChange: (v: ProtectionView) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [raise, setRaise] = useState("");
  const [reason, setReason] = useState("");
  const call = async (what: string, path: string, body?: unknown) => {
    setBusy(what);
    setErr("");
    try {
      onChange(await api<ProtectionView>(path, { method: "POST", asPayer: true, ...(body !== undefined ? { body } : {}) }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="sk-card tint stack-sm" style={{ padding: 14 }}>
      <div className="row between">
        <span className="sk-section-title">Your second key</span>
        <Button size="sm" variant="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Done" : "Manage"}
        </Button>
      </div>
      <span className="small">
        {view.threshold_cents !== null ? <>First payments of <strong>{usd(view.threshold_cents)}</strong> or more to someone new need </> : <>Paused payments need </>}
        {view.guardian ? <strong>{view.guardian.name}</strong> : <strong>a trusted contact (none in force)</strong>}
        {view.guardian && <span className="muted"> · {view.guardian.address}</span>}. You can&apos;t approve them yourself.
      </span>
      {view.pending.map((p) => (
        <div key={p.id} className="row between xs" style={{ gap: 8 }}>
          <span>
            Waiting: {describePending(p, view)} · takes effect {when(p.effective_at)}. Until then, what&apos;s above stays in force{view.guardian ? ` and ${view.guardian.name} has been told` : ""}.
          </span>
          <Button size="sm" variant="quiet" onClick={() => call(`cancel-${p.id}`, `/v1/me/protection/changes/${p.id}/cancel`)} busy={busy === `cancel-${p.id}`}>
            Cancel change
          </Button>
        </div>
      ))}
      {open && (
        <div className="stack-sm" style={{ marginTop: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="xs">New rule: $</span>
            <input aria-label="New threshold in dollars" inputMode="numeric" value={raise} onChange={(e) => setRaise(e.target.value.replace(/[^\d]/g, ""))} style={{ ...input, width: 90, minHeight: 34 }} />
            <Button size="sm" variant="secondary" disabled={!raise} busy={busy === "threshold"} onClick={() => call("threshold", "/v1/me/protection/threshold", { threshold_cents: Number(raise) * 100 })}>
              Change
            </Button>
          </div>
          <span className="xs muted">Lowering applies now. Raising waits 48 hours, and your trusted contact is told.</span>
          {view.guardian && (
            <div className="row" style={{ gap: 8 }}>
              <input aria-label="Why you are revoking" placeholder="Reason, e.g. phone stolen" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} style={{ ...input, flex: "1 1 160px", minHeight: 34 }} />
              <Button size="sm" variant="secondary" disabled={reason.trim().length < 3} busy={busy === "revoke"} onClick={() => call("revoke", "/v1/me/protection/guardian/revoke", { reason: reason.trim() })}>
                Revoke {view.guardian.name} now
              </Button>
            </div>
          )}
          {view.guardian && <span className="xs muted">For a lost or compromised phone. It removes {view.guardian.name}&apos;s authority at once; paused payments then wait for a replacement (which takes 48 hours) or your cancel. It never lets you approve them yourself.</span>}
        </div>
      )}
      {err && (
        <Notice tone="bad" role="alert">
          {err}
        </Notice>
      )}
    </div>
  );
}
