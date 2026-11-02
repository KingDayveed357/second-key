"use client";

// Sarah's phone (ADR-0020 §10). In production a trusted contact receives requests by text or email from
// a provider. Here this window stands in for that phone: it creates a demo inbox and keeps the inbox
// secret in THIS tab's sessionStorage only. It is never put in a cookie, so other tabs of the site
// (Rose's included) never send it; the payer's API key can't read this inbox at all.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errText } from "../../../lib/client";
import { usd, when } from "../../../lib/sk";
import { Button, Demo, Notice } from "../_ui/ui";

interface Message {
  id: string;
  kind: "invite" | "hold_review" | "authority_change" | "revoked";
  at: string;
  guardian: { id: string; name: string; status: string };
  purchase_id: string | null;
  body: { payer_name?: string; guardian_name?: string; payee_name?: string; amount_cents?: number; currency?: string; purpose?: string; summary?: string; effective_at?: string };
  actionable: boolean;
}
type Inbox = { address: string; secret: string };

const KEY = "sk_inbox";
const read = (): Inbox | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    return v && typeof v.address === "string" && typeof v.secret === "string" ? v : null;
  } catch {
    return null;
  }
};

/** One inbox per tab, even if the effect runs twice (React dev mode) before the first one is stored. */
let creating: Promise<Inbox> | null = null;
function inboxForThisTab(): Promise<Inbox> {
  const have = read();
  if (have) return Promise.resolve(have);
  creating ??= api<Inbox>("/v1/demo/inboxes", { method: "POST" }).then((i) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(i));
    } catch {
      /* the inbox still works for this page view */
    }
    return i;
  });
  return creating;
}

export function GuardianPhone() {
  const router = useRouter();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    inboxForThisTab().then(setInbox, (e) => setErr(errText(e)));
  }, []);

  // Tell Rose's window this phone's address (public, like a phone number). Never the secret.
  useEffect(() => {
    if (!inbox || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("sk-demo-guardian");
    const say = () => ch.postMessage({ address: inbox.address });
    ch.onmessage = (e) => (e.data as { ask?: string })?.ask === "address" && say();
    say();
    return () => ch.close();
  }, [inbox]);

  const load = useCallback(async () => {
    if (!inbox) return;
    try {
      setMessages((await api<{ messages: Message[] }>(`/v1/demo/inboxes/${inbox.address}/messages`, { inboxSecret: inbox.secret })).messages);
    } catch (e) {
      setErr(errText(e));
    }
  }, [inbox]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  async function accept(m: Message) {
    if (!inbox) return;
    setBusy(m.id);
    try {
      await api(`/v1/demo/inboxes/${inbox.address}/messages/${m.id}/accept`, { method: "POST", inboxSecret: inbox.secret });
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  }

  /** Opening a request mints its one credential here, at the channel's last hop, and keeps it in this tab. */
  async function review(m: Message) {
    if (!inbox || !m.purchase_id) return;
    setBusy(m.id);
    try {
      const r = await api<{ purchase_id: string; token: string }>(`/v1/demo/inboxes/${inbox.address}/messages/${m.id}/open`, { method: "POST", inboxSecret: inbox.secret });
      sessionStorage.setItem(`sk_cred:${r.purchase_id}`, r.token);
      router.push(`/holds/${encodeURIComponent(r.purchase_id)}`);
    } catch (e) {
      setErr(errText(e));
      setBusy(null);
    }
  }

  return (
    <div className="sk-phone stack-lg" style={{ maxWidth: 440, margin: "0 auto" }}>
      <div className="appbar">
        <span className="soft">Sarah&apos;s phone</span>
        <Demo>Demo channel</Demo>
      </div>
      <p className="xs muted">
        This window stands in for a trusted contact&apos;s phone. It holds its own key, so Rose&apos;s screen can&apos;t read these messages. In production they arrive by text or email from a provider, and that channel&apos;s security is what keeps the two keys apart. Both windows here run on one computer, so this demo shows the API boundary, not channel security.
      </p>
      {inbox && (
        <div className="sk-card tint stack-sm" style={{ padding: 14 }}>
          <span className="sk-section-title">This phone&apos;s number</span>
          <span className="mono" style={{ fontSize: "var(--text-lg)" }}>
            {inbox.address}
          </span>
          <span className="xs muted">Rose enrols this number. Only this window can read what is sent to it.</span>
        </div>
      )}
      {err && (
        <Notice tone="bad" role="alert">
          {err}
        </Notice>
      )}
      {messages && messages.length === 0 && <p className="small muted">No messages yet.</p>}
      <div className="stack" aria-live="polite">
        {(messages ?? []).map((m) => (
          <div key={m.id} className="sk-card stack-sm" style={{ padding: 14, opacity: m.actionable || m.kind === "authority_change" || m.kind === "revoked" ? 1 : 0.6 }}>
            <span className="xs muted">{when(m.at)}</span>
            {m.kind === "invite" && (
              <>
                <span className="small">
                  <strong>{m.body.payer_name ?? "Someone"}</strong> asked you to hold their second key: to look at payments their rule pauses, and decide whether they go ahead.
                </span>
                {m.actionable ? (
                  <Button size="sm" onClick={() => accept(m)} busy={busy === m.id}>
                    Accept
                  </Button>
                ) : (
                  <span className="xs muted">{m.guardian.status === "ACTIVE" ? "Accepted" : "No longer valid"}</span>
                )}
              </>
            )}
            {m.kind === "hold_review" && (
              <>
                <span className="small">
                  <strong>{m.body.payer_name ?? "Someone"}</strong> is sending {m.body.amount_cents != null ? usd(m.body.amount_cents) : "a payment"} to {m.body.payee_name ?? "a recipient"}
                  {m.body.purpose ? ` (“${m.body.purpose}”)` : ""}. It&apos;s paused until you decide.
                </span>
                {m.actionable ? (
                  <Button size="sm" onClick={() => review(m)} busy={busy === m.id}>
                    Review the payment
                  </Button>
                ) : (
                  <span className="xs muted">Replaced by a newer request, already decided, or no longer yours to decide.</span>
                )}
              </>
            )}
            {(m.kind === "authority_change" || m.kind === "revoked") && (
              <span className="small">
                {m.body.summary ?? "Your role changed."}
                {m.body.effective_at ? ` It takes effect ${when(m.body.effective_at)}; until then you stay their trusted contact.` : ""}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
