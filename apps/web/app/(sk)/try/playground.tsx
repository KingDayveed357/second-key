"use client";

import { useEffect, useRef, useState } from "react";
import { api, type Problem } from "../../../lib/client";
import { rankEvidence, tacticOf } from "../../../lib/sk";
import { QuoteCard, Transcript, type Conversation } from "../_ui/evidence";
import { Button, Demo, Notice, Pill } from "../_ui/ui";

interface Sample {
  id: string;
  label: string;
  expected: "suspicious" | "legitimate";
  provenance: string;
  context: string;
  text: string;
}
interface Result {
  no_payment: string;
  conversation: Conversation;
  analysis: {
    ok: boolean;
    failure: string | null;
    risk: string;
    findings: { tactic: string; quote: string; speaker: string; line: number; why: string }[];
    discarded_quotes: string[];
    legitimate_explanation: string | null;
    needs_independent_verification: boolean | null;
    model: string | null;
    prompt_version: string;
    latency_ms: number;
  };
  policy: { intervention: "HOLD_FOR_TRUSTED_CONTACT" | "VERIFY_BEFORE_PAYING" | "PROCEED"; rule: string; reason: string; check_result: string; in_a_real_payment: string };
  cached?: { seconds_ago: number };
}

const RISK_WORDS: Record<string, string> = {
  high: "High: several strong pressure patterns",
  medium: "Medium: some patterns, could be innocent",
  low: "Low: nothing that looks like pressure",
  insufficient_information: "Not enough to judge",
  unavailable: "No answer from the model",
};
const OUTCOME: Record<Result["policy"]["intervention"], { label: string; tone: "held" | "ok" | "pending" }> = {
  HOLD_FOR_TRUSTED_CONTACT: { label: "Hold for review", tone: "held" },
  VERIFY_BEFORE_PAYING: { label: "Verify before paying", tone: "pending" },
  PROCEED: { label: "No pause from this check", tone: "ok" },
};

function problemText(p: Partial<Problem>): string {
  if (p.status === 429) return "Too many analyses right now. This public demo is rate-limited to protect its budget; try again in a minute.";
  if (p.status === 400) return p.detail ? `That input isn't accepted: ${p.detail}.` : "That input isn't accepted.";
  if (p.status === 502 || p.status === 503) return "The analysis service isn't reachable right now. Nothing is shown instead of a made-up result.";
  return p.title ? `${p.title}${p.detail ? `: ${p.detail}` : ""}` : "Something went wrong.";
}

export function Playground() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const out = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Sample[]>("/v1/demo/samples").then(setSamples, () => {});
  }, []);

  const pick = (s: Sample) => {
    setPicked(s.id);
    setText(s.text);
    setContext(s.context);
    setRes(null);
    setErr("");
  };
  const sample = samples.find((s) => s.id === picked);
  const editedSample = sample && (sample.text !== text || sample.context !== context);

  async function analyse() {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const body = sample && !editedSample ? { sample: sample.id } : { text, ...(context.trim() ? { context } : {}) };
      setRes(await api<Result>("/v1/demo/analyze", { method: "POST", body }));
      requestAnimationFrame(() => out.current?.focus());
    } catch (e) {
      setErr(problemText(e as Problem));
    } finally {
      setBusy(false);
    }
  }

  // Stacked layout (phones, small tablets): the result renders below the form, so bring it into view.
  useEffect(() => {
    if (!(res || err) || !window.matchMedia("(max-width: 900px)").matches) return;
    out.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [res, err]);

  const findings = res ? rankEvidence(res.analysis.findings) : [];
  const o = res ? OUTCOME[res.policy.intervention] : null;

  return (
    <div className="sk-try">
      <section className="stack" aria-label="Your input">
        <div className="sk-card stack">
          <div className="row between">
            <h2 style={{ fontSize: "var(--text-lg)" }}>Paste a message, or pick a sample</h2>
            <Demo>Samples are synthetic</Demo>
          </div>
          <div className="sk-try-samples" role="group" aria-label="Samples">
            {samples.map((s) => (
              <button key={s.id} className="sk-chip" aria-pressed={picked === s.id} onClick={() => pick(s)} title={s.provenance}>
                {s.label}
              </button>
            ))}
          </div>
          <label className="stack-sm small">
            <span>
              The conversation <span className="muted">· one message per line; “Name: message” sets the speaker</span>
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              maxLength={4000}
              placeholder={"Caller: This is your bank's fraud team…\nYou: What do I need to do?"}
              className="sk-try-field" style={{ fontFamily: "var(--serif)", fontSize: "1.0625rem", lineHeight: 1.5, padding: 12, resize: "vertical" }}
            />
            <span className="xs muted" style={{ textAlign: "right" }}>{text.length.toLocaleString()} / 4,000</span>
          </label>
          <label className="stack-sm small">
            <span>
              Context <span className="muted">· optional, e.g. “phone call before a bank transfer”</span>
            </span>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              maxLength={300}
              className="sk-try-field" style={{ minHeight: 44, padding: "0 12px" }}
            />
          </label>
          <Button onClick={analyse} busy={busy} disabled={text.trim().length < 10}>
            {busy ? "Analysing…" : "Analyse"}
          </Button>
          <p className="xs muted">
            Sent to the live model for analysis only. No payment is created and nothing is stored beyond a 10-minute cache of identical inputs. Don&apos;t paste real personal data.
          </p>
          {sample && (
            <p className="xs muted">
              Sample: {sample.provenance} Written to be <strong>{sample.expected}</strong>.{editedSample ? " (You've edited it.)" : ""}
            </p>
          )}
        </div>
      </section>

      <section className="stack" aria-label="Result" aria-live="polite" ref={out} tabIndex={-1} style={{ scrollMarginTop: 84 }}>
        {!res && !err && (
          <div className="sk-card stack">
            <h2 style={{ fontSize: "var(--text-lg)" }}>What you&apos;ll see</h2>
            <ol className="small soft" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
              <li>
                <strong>What the AI observed</strong>: patterns, each with the exact words. Quotes are checked by code to really appear in your text; any that don&apos;t are discarded and listed.
              </li>
              <li>
                <strong>Its own estimate</strong>, in words: not a calibrated probability.
              </li>
              <li>
                <strong>What policy does with it</strong>: a fixed rule, separate from the AI. The AI can pause a payment, never approve one.
              </li>
            </ol>
            <p className="xs muted">Try the legitimate samples too, and try to fool it. It will make mistakes; that&apos;s why a person decides.</p>
          </div>
        )}
        {err && (
          <Notice tone="bad" title="No analysis" role="alert">
            {err}
          </Notice>
        )}
        {res && o && (
          <>
            <div className="sk-card stack">
              <div className="row between">
                <span className="sk-section-title">What policy does</span>
                <Pill tone={o.tone}>{o.label}</Pill>
              </div>
              <p>{res.policy.reason}</p>
              <span className="xs muted">
                Rule <span className="mono">{res.policy.rule}</span> · check result <span className="mono">{res.policy.check_result}</span>
              </span>
              <p className="xs muted">{res.policy.in_a_real_payment}</p>
            </div>

            <div className="sk-card stack">
              <div className="row between">
                <span className="sk-section-title">What the AI observed</span>
                {res.analysis.ok ? (
                  <span className="xs muted">
                    {res.cached ? `Cached ${res.cached.seconds_ago}s ago (same input)` : `${res.analysis.model} · ${(res.analysis.latency_ms / 1000).toFixed(1)} s`}
                  </span>
                ) : (
                  <Pill tone="bad">No answer from the model</Pill>
                )}
              </div>
              {!res.analysis.ok && <p className="small soft">The model didn&apos;t return a usable answer ({res.analysis.failure}). Nothing is shown instead of a made-up result, and policy fails closed.</p>}
              {res.analysis.ok && findings.length === 0 && <p className="small soft">No pressure patterns found in this text.</p>}
              {findings.map((f, i) => (
                <QuoteCard key={i} e={{ ...f, source: "conversation" }} sourceLabel="In your text" active={focus === f.line} onFocus={() => setFocus(f.line)} />
              ))}
              {res.analysis.discarded_quotes.length > 0 && (
                <Notice title={`${res.analysis.discarded_quotes.length} quote${res.analysis.discarded_quotes.length === 1 ? "" : "s"} discarded`}>
                  The model quoted words that aren&apos;t in your text, so they don&apos;t count as evidence: {res.analysis.discarded_quotes.map((q) => `“${q}”`).join(", ")}.
                </Notice>
              )}
              <div className="sk-card tint" style={{ padding: 12 }}>
                <Transcript conv={res.conversation} quotes={findings.map((f) => f.quote)} focusLine={focus} />
              </div>
            </div>

            {res.analysis.ok && (
              <div className="sk-card stack">
                <span className="sk-section-title">Its own estimate (not calibrated)</span>
                <p>{RISK_WORDS[res.analysis.risk] ?? res.analysis.risk}</p>
                {res.analysis.legitimate_explanation && (
                  <p className="small soft">
                    <strong>An innocent explanation it considered:</strong> {res.analysis.legitimate_explanation}
                  </p>
                )}
                {findings.length > 0 && <p className="xs muted">Patterns: {[...new Set(findings.map((f) => tacticOf(f.tactic).label))].join(" · ")}</p>}
                <p className="xs muted">
                  {res.analysis.prompt_version} · {res.no_payment}
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
