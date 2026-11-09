"use client";

// The developer kit (/developers): a test verification anyone can run with no account and no key,
// and the constraint templates as JSON. The test signs sample AP2 mandates with a throwaway key
// made in this browser, has Second Key's real verifier check them, and checks the signed receipts
// here against the published key set. Nothing is stored and PayPal isn't called.

import { createLocalJWKSet, jwtVerify, type CryptoKey, type JSONWebKeySet } from "jose";
import { useState } from "react";
import { api, errText } from "../../../lib/client";
import { roseMandates, thumbprint, type Ap2Setup } from "../../../lib/ap2-surface";
import { TEMPLATES, templateFile, type ConstraintTemplate } from "../../../lib/ap2-templates";
import { usd } from "../../../lib/sk";
import { Button, Notice, Pill } from "../_ui/ui";
import { ReceiptRow } from "./receipt";

interface TestResult {
  product: { id: string; title: string; price_cents: number };
  decision: string;
  error?: string;
  findings: { code: string; message: string }[];
  constraints: { type: string; result: string; detail?: string }[];
  facts_attestation: string | null;
  receipts: { checkout: string; payment: string };
  presented: { checkout: string; payment: string };
  note: string;
}

const PRODUCTS = [
  { id: "TRL-GRY-10", label: "Grey shoe (conforms)" },
  { id: "TRL-WHT-10", label: "White shoe (“not white”)" },
  { id: "TRL-PRO-10", label: "$480 shoe (not listed)" },
] as const;

type Step = { label: string; status: "todo" | "now" | "done" | "bad"; detail?: string };
const STEPS = ["Make a throwaway key in this browser", "Sign two AP2 open mandates with it", "Second Key verifies the presented chains", "Check every receipt against the published key set"];

export function TestVerification() {
  const [product, setProduct] = useState<(typeof PRODUCTS)[number]["id"]>("TRL-GRY-10");
  const [steps, setSteps] = useState<Step[]>(STEPS.map((label) => ({ label, status: "todo" })));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [checks, setChecks] = useState<{ label: string; ok: boolean; why?: string }[]>([]);
  const [err, setErr] = useState("");

  const mark = (i: number, status: Step["status"], detail?: string) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, status, ...(detail ? { detail } : {}) } : x)));

  async function run() {
    setBusy(true);
    setErr("");
    setResult(null);
    setChecks([]);
    setSteps(STEPS.map((label) => ({ label, status: "todo" })));
    let at = 0;
    try {
      mark(0, "now");
      // Non-extractable and never stored: it exists for this one test.
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
      const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const jwk = { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
      const kid = await thumbprint(jwk);
      mark(0, "done", `key ${kid.slice(0, 12)}…`);

      at = 1;
      mark(1, "now");
      const setup = await api<Ap2Setup>("/v1/demo/ap2/setup");
      const m = await roseMandates(setup, pair.privateKey, kid);
      mark(1, "done", `${m.openCheckout.length + m.openPayment.length} bytes of SD-JWT`);

      at = 2;
      mark(2, "now");
      const r = await api<TestResult>("/v1/demo/ap2/test-verification", { method: "POST", body: { open_checkout: m.openCheckout, open_payment: m.openPayment, jwk, product } });
      setResult(r);
      mark(2, "done", r.decision);

      at = 3;
      mark(3, "now");
      const set = await api<JSONWebKeySet>("/.well-known/jwks.json");
      const out: { label: string; ok: boolean; why?: string }[] = [];
      for (const [label, jwt] of [["Mandate receipt: checkout", r.receipts.checkout], ["Mandate receipt: payment", r.receipts.payment], ...(r.facts_attestation ? [["Facts attestation", r.facts_attestation]] : [])] as [string, string][]) {
        try {
          await jwtVerify(jwt, createLocalJWKSet(set), { algorithms: ["ES256"] });
          out.push({ label, ok: true });
        } catch (e) {
          out.push({ label, ok: false, why: (e as Error).message });
        }
      }
      setChecks(out);
      mark(3, out.every((c) => c.ok) ? "done" : "bad", `${out.filter((c) => c.ok).length} of ${out.length} signatures valid`);
    } catch (e) {
      mark(at, "bad", errText(e));
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const tone = (d: string) => (d === "CONFORMS" ? "ok" : d === "NONCONFORMING" ? "bad" : "held");

  return (
    <section className="sk-card stack" aria-labelledby="test-verification">
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 id="test-verification" style={{ fontSize: "var(--text-lg)" }}>
          Run a test verification
        </h2>
        <span className="xs muted">No account, no key</span>
      </div>
      <p className="small soft">
        Your browser makes a throwaway key and signs two AP2 open mandates with it. A demo agent closes them for the product you pick, Second Key&apos;s real verifier checks them and signs receipts, and your browser checks those receipts against our published key set. Nothing is stored and PayPal isn&apos;t called.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label className="stack-sm xs" style={{ flex: "1 1 220px" }}>
          <span className="muted">What the agent buys</span>
          <select value={product} onChange={(e) => setProduct(e.target.value as typeof product)} disabled={busy} style={{ minHeight: 40, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-strong)", font: "inherit", background: "var(--surface)", color: "var(--ink)" }}>
            {PRODUCTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={run} busy={busy}>
          {busy ? "Running…" : "Run a test verification"}
        </Button>
      </div>

      <ol className="sk-ladder" aria-label="Test verification steps">
        {steps.map((s) => (
          <li key={s.label} className={s.status === "done" ? "pass" : s.status === "bad" ? "fail" : s.status === "now" ? "wait" : "skip"}>
            <div className="row between" style={{ gap: 8 }}>
              <span className="small">{s.label}</span>
              {s.status !== "todo" && <Pill tone={s.status === "done" ? "ok" : s.status === "bad" ? "bad" : "pending"}>{s.status === "done" ? "Done" : s.status === "bad" ? "Failed" : "Working"}</Pill>}
            </div>
            {s.detail && <span className="xs muted mono" style={{ overflowWrap: "anywhere" }}>{s.detail}</span>}
          </li>
        ))}
      </ol>

      {err && (
        <Notice tone="bad" role="alert">
          {err}
        </Notice>
      )}

      {result && (
        <div className="stack" aria-live="polite">
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill tone={tone(result.decision)}>{result.decision}</Pill>
            <span className="small soft">
              {result.product.title}, {usd(result.product.price_cents)}
            </span>
          </div>
          <ul className="xs" style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 4 }}>
            {result.constraints.map((c, i) => (
              <li key={i}>
                <strong style={{ color: c.result === "pass" ? "var(--moss)" : c.result === "fail" ? "var(--brick)" : "var(--brass)" }}>{c.result}</strong> <span className="mono">{c.type}</span>
                {c.detail ? <span className="soft"> · {c.detail}</span> : null}
              </li>
            ))}
            {result.findings.map((f, i) => (
              <li key={`f${i}`}>
                <strong style={{ color: "var(--brick)" }}>finding</strong> <span className="mono">{f.code}</span> <span className="soft">· {f.message}</span>
              </li>
            ))}
          </ul>
          {checks.length > 0 && (
            <p className="xs">
              {checks.map((c) => (
                <span key={c.label} style={{ marginRight: 12, color: c.ok ? "var(--moss)" : "var(--brick)" }}>
                  {c.ok ? "✓" : "✗"} {c.label}
                  {c.why ? ` (${c.why})` : ""}
                </span>
              ))}
            </p>
          )}
          <div className="stack-sm">
            <ReceiptRow label="Mandate receipt: checkout" jwt={result.receipts.checkout} />
            <ReceiptRow label="Mandate receipt: payment" jwt={result.receipts.payment} />
            {result.facts_attestation && <ReceiptRow label="Facts attestation" jwt={result.facts_attestation} />}
          </div>
          <details className="xs">
            <summary className="muted" style={{ cursor: "pointer" }}>
              The presented chains (open mandate ~~ closed mandate)
            </summary>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--surface-2)", padding: 10, borderRadius: 8, maxHeight: 240, overflow: "auto" }}>
              {`checkout:\n${result.presented.checkout}\n\npayment:\n${result.presented.payment}`}
            </pre>
          </details>
          <p className="xs muted">{result.note}</p>
        </div>
      )}
    </section>
  );
}

function download(t: ConstraintTemplate) {
  const url = URL.createObjectURL(new Blob([templateFile(t)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `ap2-constraints-${t.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ConstraintTemplates() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(t: ConstraintTemplate) {
    try {
      await navigator.clipboard.writeText(templateFile(t));
      setCopied(t.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      download(t);
    }
  }
  return (
    <section className="sk-card stack" aria-labelledby="templates">
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 id="templates" style={{ fontSize: "var(--text-lg)" }}>
          Constraint templates
        </h2>
        <span className="xs muted">AP2 v0.2 + Second Key extensions · JSON</span>
      </div>
      <p className="small soft">Starting points for the constraints in an Open Checkout and an Open Payment Mandate. Fill in the &lt;placeholders&gt;; each says which checks enforce it.</p>
      <div className="stack">
        {TEMPLATES.map((t) => (
          <article key={t.id} className="sk-card tint stack-sm">
            <h3 className="small" style={{ fontWeight: 650 }}>
              {t.title}
            </h3>
            <p className="xs soft">{t.summary}</p>
            <ul className="xs muted" style={{ margin: 0, paddingLeft: 16 }}>
              {t.enforcedBy.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Button size="sm" variant="secondary" onClick={() => download(t)}>
                Download JSON
              </Button>
              <Button size="sm" variant="quiet" onClick={() => copy(t)}>
                {copied === t.id ? "Copied" : "Copy"}
              </Button>
            </div>
            <details className="xs">
              <summary className="muted" style={{ cursor: "pointer" }}>
                Show
              </summary>
              <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--surface)", padding: 10, borderRadius: 8, maxHeight: 320, overflow: "auto" }}>
                {templateFile(t)}
              </pre>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
