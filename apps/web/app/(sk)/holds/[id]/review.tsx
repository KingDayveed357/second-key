"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Problem } from "../../../../lib/client";
import { clock, rankEvidence, stageOf, when } from "../../../../lib/sk";
import { QuoteCard, Transcript, type Conversation, type Evidence } from "../../_ui/evidence";
import { Button, Demo, Notice, Rail, StatePill } from "../../_ui/ui";
import { PayPalCheck } from "../../_ui/verify";

interface HoldView {
  purchase_id: string;
  state: string;
  amount: { currency_code: string; value: string } | null;
  items: { product_id: string; name: string; quantity: number }[];
  retailer: string | null;
  auto_void_at: string | null;
  resolution: string | null;
  link_expires_at: string | null;
  replayed?: boolean;
  kind: "shopping" | "transfer";
  payer_name: string | null;
  payee: { name: string; first_payment: boolean; email?: string } | null;
  payout_configured: boolean;
  purpose: string | null;
  conversation: Conversation | null;
  concerns: { check_id: string; kind: string; detail: string; evidence: Evidence[] }[];
  conversation_source: "submitted" | "shared_after_pause" | null;
  feedback: { quote: string; note: string; at: string }[];
  approver?: { kind: "principal" | "guardian" | "legacy"; guardian: { name: string; address: string; status: string } | null };
  reason_classes?: string[];
}

/**
 * The reviewer's credential (ADR-0020 §5): from the link's fragment (never sent to a server, never in a
 * Referer), or handed over by the guardian's phone window in this tab's sessionStorage. It is removed from
 * the address bar at once and only ever sent in a POST body.
 */
function takeCredential(id: string): string {
  const key = `sk_cred:${id}`;
  const frag = new URLSearchParams(window.location.hash.slice(1)).get("k");
  if (frag) {
    window.history.replaceState(null, "", `/holds/${encodeURIComponent(id)}`);
    try {
      sessionStorage.setItem(key, frag);
    } catch {
      /* memory only */
    }
    return frag;
  }
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

type Decision = "approve" | "deny";

/** Messages for link problems: say what happened and what to do, never a raw status code. */
function linkProblem(p: Partial<Problem>): { title: string; body: string } {
  switch (p.status) {
    case 401:
      return { title: "This page needs your link", body: "Open the link from the message you were sent." };
    case 403:
      return { title: "This link isn't valid", body: "It doesn't match this payment, or a newer request replaced it. Use the latest request on your phone." };
    case 404:
      return { title: "Payment not found", body: "The link doesn't match a payment waiting for review." };
    case 410:
      return { title: "This request is no longer valid", body: p.detail ?? "It expired, was replaced by a newer one, or you are no longer the trusted contact for this payment. The payment stays reserved, not sent, until it's decided or released automatically." };
    default:
      return { title: "Couldn't load this payment", body: p.title ?? "Check your connection and try again." };
  }
}

export function Review({ id }: { id: string }) {
  const [hold, setHold] = useState<HoldView | null>(null);
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(null);
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recorded, setRecorded] = useState<{ decision: Decision; at: string; replayed: boolean } | null>(null);
  const [notice, setNotice] = useState<{ tone: "bad" | "held" | ""; title: string; body: string } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const tok = useRef("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    if (!tok.current) {
      setProblem(linkProblem({ status: 401 }));
      return null;
    }
    try {
      const v = await api<HoldView>(`/v1/holds/${id}/view`, { method: "POST", body: { token: tok.current } });
      setHold(v);
      return v;
    } catch (e) {
      setProblem(linkProblem(e as Problem));
      return null;
    }
  }, [id]);

  useEffect(() => {
    tok.current = takeCredential(id);
    void load();
  }, [id, load]);

  // After a decision, follow the payment until PayPal has confirmed the outcome.
  const state = hold?.state;
  useEffect(() => {
    if (!recorded && state !== "VOIDING" && !state?.startsWith("CAPTURE_")) return;
    if (!stageOf(state).moving) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [recorded, state, load]);

  async function decide(decision: Decision) {
    setSubmitting(true);
    setNotice(null);
    try {
      const v = await api<HoldView>(`/v1/holds/${id}/${decision}`, { method: "POST", body: { token: tok.current } });
      setHold(v);
      setRecorded({ decision, at: new Date().toISOString(), replayed: Boolean(v.replayed) });
      setConfirming(null);
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (e) {
      const p = e as Problem;
      if (p.status === 409) {
        await load();
        setConfirming(null);
        setNotice({ tone: "held", title: "Someone already decided", body: "Another decision for this payment was recorded first. The current status is shown below; nothing you did changed it." });
      } else if (p.status === 410 || p.status === 403) {
        setProblem(linkProblem(p));
      } else if (p.status === 502) {
        setNotice({ tone: "bad", title: "Couldn't reach PayPal to re-check the payment", body: "Nothing changed. The payment is still reserved, not sent. Try again in a moment." });
      } else {
        setNotice({ tone: "bad", title: "No response from Second Key", body: "Your decision may not have been recorded. Trying again is safe: a repeated decision is recognised, never applied twice." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (problem && !hold)
    return (
      <div className="sk-phone stack">
        <h1 style={{ fontSize: "var(--text-xl)" }}>{problem.title}</h1>
        <p className="soft">{problem.body}</p>
      </div>
    );
  if (!hold) return <div className="sk-phone muted">Loading the payment…</div>;

  const amount = hold.amount ? new Intl.NumberFormat("en-US", { style: "currency", currency: hold.amount.currency_code }).format(Number(hold.amount.value)) : "—";
  const payer = hold.payer_name ?? "The account holder";
  const toWhom = hold.kind === "transfer" ? hold.payee?.name ?? "the recipient" : hold.items.map((i) => i.name).join(", ");
  const evidence = rankEvidence(hold.concerns.flatMap((c) => c.evidence));
  const noEvidence = hold.concerns.filter((c) => !c.evidence.length && c.check_id !== "transfer.review_rule");
  const rule = hold.concerns.find((c) => c.check_id === "transfer.review_rule");
  const notes = new Map(hold.feedback.map((f) => [f.quote, f.note]));
  const decided = hold.state !== "HELD";
  const s = stageOf(hold.state);

  return (
    <div className="sk-phone stack-lg">
      <div className="appbar">
        <span className="soft">Second Key · review</span>
        <StatePill state={hold.state} />
      </div>

      <header className="stack-sm">
        <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: "var(--text-xl)" }}>
          {decided ? outcomeTitle(hold) : hold.kind === "transfer" ? `${payer} asked you to check a payment` : `${payer}'s shopping agent wants to buy something`}
        </h1>
        <p className="soft">
          {decided
            ? outcomeBody(hold)
            : hold.kind === "transfer"
              ? rule && !evidence.length
                ? `It matches a rule ${payer} set in advance: a second look for large first payments to someone new. That doesn't mean anything is wrong. You decide whether it goes ahead.`
                : rule
                  ? `It matches a rule ${payer} set in advance, and the conversation ${hold.conversation_source === "shared_after_pause" ? `${payer} shared` : "behind it"} has patterns common in scams. You decide whether it goes ahead.`
                  : "Second Key paused it because the conversation behind it has patterns common in scams. You decide whether it goes ahead."
              : "Second Key paused it because the product page tried to give the agent instructions. You decide whether it goes ahead."}
        </p>
      </header>

      <section className="sk-card tint stack" aria-label="The payment">
        <div className="sk-amount">{amount}</div>
        <dl className="sk-kv">
          <dt>{hold.kind === "transfer" ? "To" : "Item"}</dt>
          <dd>
            {toWhom}
            {hold.payee?.first_payment ? <span className="muted"> · first payment to them</span> : null}
            {hold.payee?.email ? <div className="xs muted">PayPal: {hold.payee.email}</div> : null}
          </dd>
          {hold.purpose && (
            <>
              <dt>For</dt>
              <dd>{hold.purpose}</dd>
            </>
          )}
          {hold.kind === "shopping" && hold.retailer && (
            <>
              <dt>Store</dt>
              <dd>{hold.retailer}</dd>
            </>
          )}
          <dt>Right now</dt>
          <dd>{hold.state === "HELD" ? "Reserved in PayPal, not sent" : s.label}</dd>
          {hold.state === "HELD" && hold.auto_void_at && (
            <>
              <dt>If nobody decides</dt>
              <dd>Released automatically {when(hold.auto_void_at)}</dd>
            </>
          )}
        </dl>
      </section>

      {notice && (
        <Notice tone={notice.tone} title={notice.title} role="alert">
          {notice.body}
        </Notice>
      )}

      {(recorded || decided) && (
        <section className="stack" aria-live="polite">
          <Rail
            label="Decision progress"
            steps={[
              { label: "Decision recorded", status: "done" },
              { label: hold.state === "VOIDED" ? "Cancelled with PayPal" : hold.state === "CAPTURED" ? "Completed with PayPal" : "PayPal confirms", status: s.moving ? "now" : hold.state === "CAPTURE_DECLINED" || hold.state === "AUTH_FAILED" ? "bad" : "done", moving: true },
            ]}
          />
          {recorded && (
            <p className="small soft">
              {recorded.replayed ? "This decision was already recorded; nothing was done twice." : `Second Key recorded your decision at ${clock(recorded.at)}.`} {s.moving ? "Waiting for PayPal to confirm…" : ""}
            </p>
          )}
          {!s.moving && hold.amount && (
            <PayPalCheck
              path={`/v1/holds/${id}/verification`}
              body={{ token: tok.current }}
              amount={amount}
              refreshKey={hold.state}
              {...(hold.kind === "transfer" ? { transfer: { payee: toWhom, configured: hold.payout_configured } } : {})}
            />
          )}
        </section>
      )}

      {evidence.length > 0 && (
        <section className="stack" aria-labelledby="why">
          <h2 id="why" className="sk-section-title">What Second Key noticed</h2>
          {(showAll ? evidence : evidence.slice(0, 3)).map((e, i) => (
            <div key={i} className="stack-sm">
              <QuoteCard e={e} sourceLabel={e.source === "listing" ? "On the product page the agent read" : hold.conversation_source === "shared_after_pause" ? `In what ${payer} shared after the pause` : "In the conversation"} active={focus !== null && focus === e.line} onFocus={() => setFocus(e.line ?? null)} />
              {notes.has(e.quote) && (
                <span className="small" style={{ paddingLeft: 8 }}>
                  <strong>{payer} says this isn&apos;t right:</strong> “{notes.get(e.quote)}”
                </span>
              )}
            </div>
          ))}
          {evidence.length > 3 && (
            <Button variant="quiet" size="sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${evidence.length} patterns`}
            </Button>
          )}
        </section>
      )}
      {noEvidence.length > 0 && (
        <section className="stack-sm" aria-label="Other reasons">
          <h2 className="sk-section-title">{evidence.length ? "Also" : "Why it was paused"}</h2>
          <ul className="small soft" style={{ paddingLeft: 18 }}>
            {noEvidence.map((c, i) => (
              <li key={i}>{c.check_id === "ai.manipulation" ? "The safety check couldn't finish, so the payment was paused rather than sent." : c.detail}</li>
            ))}
          </ul>
        </section>
      )}

      {rule && (
        <section className="stack-sm" aria-label="The payer's rule">
          <h2 className="sk-section-title">{payer}&apos;s own rule</h2>
          <div className="sk-quote" style={{ paddingLeft: 24 }}>
            <div className="tactic">Set by {payer} in advance</div>
            <p style={{ marginTop: 4 }}>{rule.detail.replace(/^the payer's rule: /, "").replace(/^./, (c) => c.toUpperCase())}</p>
            <p className="why">{payer} chose a trusted person to look at payments like this. It isn&apos;t a sign of fraud on its own.</p>
          </div>
          {!hold.conversation && <p className="small soft">{payer} didn&apos;t share the conversation behind this payment, so there are no quotes to show. Sharing is optional.</p>}
        </section>
      )}

      {!decided && (
        <Notice title="What Second Key can and can't know">
          {hold.kind === "transfer"
            ? "It recognises patterns that often appear in scams. It doesn't know the people involved. If you can, a quick call to the person on a number you already have is the surest check. Reviewing is a safeguard, not an accusation."
            : "It recognises text that tries to steer a shopping agent. It can't judge the product itself. If this isn't the item you expected the agent to buy, don't buy it."}
        </Notice>
      )}

      {hold.conversation && (
        <details className="sk-card" style={{ padding: 16 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Read the whole conversation{hold.conversation_source === "shared_after_pause" ? ` (shared by ${payer} after the pause)` : ""} <Demo>Synthetic</Demo>
          </summary>
          <div style={{ marginTop: 12 }}>
            <p className="xs muted" style={{ marginBottom: 8 }}>{hold.conversation.context}</p>
            <Transcript conv={hold.conversation} quotes={evidence.map((e) => e.quote)} focusLine={focus} self={payer} />
          </div>
        </details>
      )}

      {!decided && !confirming && (
        <section className="stack" aria-labelledby="decide">
          <h2 id="decide" className="sk-section-title">Your decision</h2>
          <div className="row" style={{ alignItems: "stretch", gap: 12 }}>
            <div className="stack-sm" style={{ flex: "1 1 160px" }}>
              <Button variant="secondary" block onClick={() => setConfirming("deny")}>
                {hold.kind === "transfer" ? "Don't send" : "Don't buy"}
              </Button>
              <span className="xs muted">PayPal releases the reserved money. Nothing is paid.</span>
            </div>
            <div className="stack-sm" style={{ flex: "1 1 160px" }}>
              <Button variant="secondary" block onClick={() => setConfirming("approve")}>
                {hold.kind === "transfer" ? "Send it" : "Buy it"}
              </Button>
              <span className="xs muted">Second Key re-checks PayPal&apos;s record, then completes the payment.</span>
            </div>
          </div>
          {hold.approver?.kind === "guardian" && (
            <span className="xs muted">
              Your decision is recorded as yours ({hold.approver.guardian?.name ?? "trusted contact"}). {payer} can cancel this payment, but can&apos;t approve it: only you can.
            </span>
          )}
          {hold.link_expires_at && <span className="xs muted">This request works until {clock(hold.link_expires_at)}.</span>}
        </section>
      )}

      {!decided && confirming && (
        <section className="sk-sheet stack" role="dialog" aria-modal="false" aria-labelledby="confirm-title">
          <h2 id="confirm-title" style={{ fontSize: "var(--text-lg)" }}>
            {confirming === "deny" ? `${hold.kind === "transfer" ? "Don't send" : "Don't buy"} ${amount}?` : hold.kind === "transfer" ? `Send ${amount} to ${toWhom}?` : `Buy it for ${amount}?`}
          </h2>
          <p className="small soft">
            {confirming === "deny"
              ? `PayPal will release the money reserved in ${payer}'s account. Nothing will be paid to ${toWhom}. This can't be undone; ${payer} can start a new payment if it was genuine.`
              : hold.kind === "transfer" && hold.payout_configured
                ? `Second Key will check PayPal's record still matches, complete the payment, then pay it out to ${toWhom}. Once completed it can't be cancelled here.`
                : `Second Key will check PayPal's record still matches, then complete the payment. Once completed it can't be cancelled here.`}
          </p>
          <div className="row">
            <Button onClick={() => decide(confirming)} busy={submitting}>
              {confirming === "deny" ? (hold.kind === "transfer" ? "Yes, don't send" : "Yes, don't buy") : hold.kind === "transfer" ? "Yes, send it" : "Yes, buy it"}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(null)} disabled={submitting}>
              Back
            </Button>
          </div>
        </section>
      )}

      <div className="row between">
        <span className="xs muted">Statuses are read from Second Key and PayPal</span>
        <span className="xs muted mono">{hold.purchase_id}</span>
      </div>
    </div>
  );
}

function outcomeBody(h: HoldView) {
  switch (h.state) {
    case "VOIDING":
      return "Your decision is recorded. This page updates when PayPal confirms the cancellation.";
    case "VOIDED":
      return "PayPal released the reserved money. Nothing was paid.";
    case "CAPTURE_APPROVED":
    case "CAPTURING":
    case "CAPTURE_PENDING":
      return "Your decision is recorded. This page updates when PayPal confirms the payment.";
    case "CAPTURED":
      return "PayPal completed the payment.";
    default:
      return stageOf(h.state).payer;
  }
}

function outcomeTitle(h: HoldView) {
  switch (h.state) {
    case "VOIDING":
      return "Not sent. Cancelling with PayPal…";
    case "VOIDED":
      return "Cancelled. Nothing was taken.";
    case "CAPTURE_APPROVED":
    case "CAPTURE_PENDING":
      return "Approved. Completing with PayPal…";
    case "CAPTURED":
      return "Approved and completed";
    default:
      return stageOf(h.state).label;
  }
}
