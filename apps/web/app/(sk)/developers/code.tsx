"use client";

// Code blocks for /developers: language tabs (remembered across blocks on the page), a copy button,
// and an optional response panel under the request.

import { useEffect, useState } from "react";
import type { Sample } from "../../../lib/dev-samples";

let preferred: Sample["lang"] = "curl";
const listeners = new Set<(l: Sample["lang"]) => void>();

/** Clipboard API first; the older execCommand path where the API isn't allowed (some embeds, http). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function Copy({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className="sk-code-copy"
      onClick={async () => {
        setState((await copyText(text)) ? "done" : "failed");
        setTimeout(() => setState("idle"), 1600);
      }}
      aria-label="Copy to clipboard"
      aria-live="polite"
    >
      {state === "done" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
    </button>
  );
}

export function Code({ samples, response, responseLabel = "Response", title }: { samples: Sample[]; response?: string; responseLabel?: string; title?: string }) {
  const [lang, setLang] = useState<Sample["lang"]>(preferred);
  useEffect(() => {
    const on = (l: Sample["lang"]) => setLang(l);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  const pick = (l: Sample["lang"]) => {
    preferred = l;
    listeners.forEach((f) => f(l));
  };
  const current = samples.find((s) => s.lang === lang) ?? samples[0]!;
  return (
    <div className="sk-code">
      <div className="sk-code-bar">
        {samples.length > 1 ? (
          <div role="tablist" aria-label="Language" className="sk-code-tabs">
            {samples.map((s) => (
              <button key={s.lang} role="tab" type="button" aria-selected={s.lang === current.lang} onClick={() => pick(s.lang)}>
                {s.lang}
              </button>
            ))}
          </div>
        ) : (
          <span className="sk-code-title">{title ?? current.lang}</span>
        )}
        <Copy text={current.code} />
      </div>
      <pre tabIndex={0}>
        <code>{current.code}</code>
      </pre>
      {response && (
        <>
          <div className="sk-code-bar sub">
            <span className="sk-code-title">{responseLabel}</span>
          </div>
          <pre tabIndex={0} className="resp">
            <code>{response}</code>
          </pre>
        </>
      )}
    </div>
  );
}

export function Shell({ code, title = "Terminal" }: { code: string; title?: string }) {
  return <Code samples={[{ lang: "curl", code }]} title={title} />;
}
