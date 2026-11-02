"use client";

import { highlight, tacticOf } from "../../../lib/sk";

export interface Evidence {
  tactic: string;
  quote: string;
  source: "conversation" | "listing";
  speaker?: string;
  line?: number;
  why?: string;
}

export interface Conversation {
  context: string;
  lines: { speaker: string; text: string }[];
}

/** One observed pattern, with the exact words that show it. Observed (the quote) is set apart from inferred (the label). */
export function QuoteCard({ e, sourceLabel, active, onFocus }: { e: Evidence; sourceLabel: string; active?: boolean; onFocus?: () => void }) {
  const t = tacticOf(e.tactic);
  return (
    <figure className={`sk-quote ${active ? "active" : ""}`} tabIndex={onFocus ? 0 : undefined} onMouseEnter={onFocus} onFocus={onFocus}>
      <div className="tactic">{t.label}</div>
      <blockquote>“{e.quote}”</blockquote>
      <figcaption className="who">
        {e.speaker ? `${e.speaker} · ` : ""}
        {sourceLabel}
      </figcaption>
      {e.why && <p className="why">{e.why}</p>}
      {t.plain && (
        <p className="why" style={e.why ? { opacity: 0.75, fontSize: "var(--text-xs)" } : undefined}>
          {t.plain}
        </p>
      )}
    </figure>
  );
}

/** The original conversation, with the quoted words marked where they occur. */
export function Transcript({ conv, quotes, focusLine, self }: { conv: Conversation; quotes: string[]; focusLine?: number | null; self?: string }) {
  return (
    <div className="sk-transcript">
      {conv.lines.map((l, i) => (
        <div key={i} className={`sk-line ${focusLine === i ? "focus" : ""} ${self && l.speaker === self ? "self" : ""}`}>
          <span className="speaker">{l.speaker}</span>
          <span className="text">
            {highlight(l.text, quotes).map((p, j) => (p.mark ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}
          </span>
        </div>
      ))}
    </div>
  );
}
