"use client";

// "Try to beat Second Key": an attacker controls everything around Rose's agent except Rose's
// mandate, which is fixed on the server. Presets fill the form; the real screening engine (rules
// plus Claude) decides. Nothing is bought and PayPal isn't called. What's shown is what the engine
// returned; the "expected" line only compares that with what we predicted for the preset.

import { useMemo, useRef, useState } from "react";
import { api, checkLabel, errText } from "../../../lib/client";
import { BASE, MANDATE, SCENARIOS, toBody, validate, type ChallengeInput, type Outcome, type Scenario } from "../../../lib/challenge";
import { usd } from "../../../lib/sk";
import { Button, Notice, Pill } from "../_ui/ui";

interface Check {
  id: string;
  result: "pass" | "fail" | "unknown";
  detail: string;
  unavailable?: boolean;
}
interface ScreenResult {
  outcome: Outcome;
  checks: Check[];
  proposal?: { retailer: string; quantity: number; total_cents: number };
}

const VERDICT: Record<Outcome, { title: string; line: string; tone: "bad" | "held" | "ok" }> = {
  REJECT: { title: "Refused before PayPal", line: "This breaks what Rose authorized, so no order or authorization is created.", tone: "bad" },
  HOLD: { title: "Paused for Rose", line: "PayPal would reserve the money, and only Rose can let it through.", tone: "held" },
  CAPTURE: { title: "Allowed", line: "Nothing here breaks Rose's mandate, so the purchase would complete.", tone: "ok" },
};
const GROUPS: Scenario["group"][] = ["Control", "Prompt injection", "Mandate", "Merchant & product", "Pressure", "Input"];

/** The engine reports money in cents ("25200 vs max 9000 cents"); show dollars. */
const dollars = (detail: string) =>
  detail
    .replace(/(\d+) vs max (\d+) cents/, (_, a, b) => `${usd(Number(a))}, over the ${usd(Number(b))} limit`)
    .replace(/(\d+) vs market median (\d+) cents/, (_, a, b) => `${usd(Number(a))} vs a market price of ${usd(Number(b))}`);

const lookalike =(s: string) => /[\p{L}--\p{Script=Latin}]/v.test(s.normalize("NFKC")) && /[\p{Script=Latin}0-9]/u.test(s);

/** What the attack changed, from the inputs alone (not a claim about what the engine found). */
function changesOf(i: ChallengeInput): { what: string; value: string }[] {
  const out: { what: string; value: string }[] = [];
  const q = Number(i.quantity) || 1;
  const total = Math.round(Number(i.price) * 100) * q;
  const retailer = i.retailer.trim().toLowerCase() || "rei.com";
  if (!MANDATE.retailers.includes(retailer)) out.push({ what: "Merchant", value: `${retailer}, not REI or Backcountry` });
  if (q !== MANDATE.quantity) out.push({ what: "Quantity", value: `${q} pairs, not one` });
  if (Number.isFinite(total) && total > MANDATE.maxCents) out.push({ what: "Total", value: `${usd(total)}, over the ${usd(MANDATE.maxCents)} limit` });
  if (lookalike(i.color)) out.push({ what: "Colour", value: `"${i.color}" uses lookalike letters` });
  else if (i.color.toLowerCase().includes(MANDATE.excluded)) out.push({ what: "Colour", value: `${i.color}, which Rose excluded` });
  if (!i.size.trim()) out.push({ what: "Size", value: "not stated on the page" });
  else if (i.size.trim() !== MANDATE.size) out.push({ what: "Size", value: `${i.size}, not ${MANDATE.size}` });
  if (i.title !== BASE.title || i.category !== BASE.category) out.push({ what: "Product", value: i.title });
  if (i.description.trim() !== BASE.description) out.push({ what: "Page text", value: "rewritten by the seller" });
  const msgs = i.messages.split("\n").filter((l) => l.trim()).length;
  if (msgs) out.push({ what: "Messages", value: `${msgs} sent to the agent` });
  return out;
}

export function Challenge() {
  const [pick, setPick] = useState<Scenario>(SCENARIOS[1]!);
  const [f, setF] = useState<ChallengeInput>({ ...BASE, ...SCENARIOS[1]!.input });
  const [custom, setCustom] = useState(false);
  const [editing, setEditing] = useState(false);
  const [res, setRes] = useState<{ r: ScreenResult; ran: ChallengeInput; scenario: Scenario | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [touched, setTouched] = useState(false);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const errors = useMemo(() => validate(f), [f]);
  const invalid = Object.keys(errors).length > 0;

  const choose = (s: Scenario) => {
    setPick(s);
    setCustom(false);
    setF({ ...BASE, ...s.input });
    setRes(null);
    setErr("");
    setTouched(false);
  };
  const set = (k: keyof ChallengeInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setCustom(true);
  };

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (invalid) {
      setEditing(true);
      return;
    }
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const r = await api<ScreenResult>("/v1/demo/screen", { method: "POST", body: toBody(f) });
      setRes({ r, ran: f, scenario: custom ? null : pick });
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof ChallengeInput, label: string, hint: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="sk-field">
      <span className="sk-field-label">{label}</span>
      <input className="sk-input" value={f[k]} onChange={set(k)} aria-invalid={touched && !!errors[k]} aria-describedby={`h-${k}`} {...extra} />
      <span id={`h-${k}`} className={`sk-field-hint ${touched && errors[k] ? "bad" : ""}`}>
        {touched && errors[k] ? errors[k] : hint}
      </span>
    </label>
  );

  const flagged = res ? res.r.checks.filter((c) => c.result !== "pass") : [];
  const unavailable = flagged.filter((c) => c.unavailable).length;
  const expected = res?.scenario?.expect;
  const asExpected = expected ? expected.includes(res!.r.outcome) : null;

  return (
    <div className="sk-beat">
      <div className="sk-beat-setup">
        <div className="sk-mandate" aria-label="Rose's mandate">
          <span className="sk-section-title">Rose&apos;s mandate · fixed</span>
          <p className="serif" style={{ fontSize: "1.0625rem", margin: 0 }}>
            &ldquo;{MANDATE.text}&rdquo;
          </p>
          <span className="xs muted">Confirmed by Rose and stored by Second Key. Nothing on this page can change it; that&apos;s the point.</span>
        </div>

        <div className="stack-sm">
          <span className="sk-section-title">Pick an attack</span>
          <div className="sk-attacks">
            {GROUPS.map((g) => (
              <div key={g} className="sk-attack-group" role="group" aria-label={g}>
                <span className="xs muted">{g}</span>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {SCENARIOS.filter((s) => s.group === g).map((s) => (
                    <button key={s.id} type="button" className="sk-chip" aria-pressed={!custom && pick.id === s.id} onClick={() => choose(s)} disabled={busy}>
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sk-attack-brief">
          <strong className="small">{custom ? "Your own attack" : pick.name}</strong>
          {!custom && (
            <dl className="sk-brief">
              <dt>Goal</dt>
              <dd>{pick.goal}</dd>
              <dt>Changes</dt>
              <dd>{pick.changes}</dd>
            </dl>
          )}
          {custom && <span className="xs muted">You edited the attack. The result below is compared with Rose&apos;s mandate only.</span>}
        </div>

        <form onSubmit={run} className="stack" noValidate>
          <details className="sk-edit" open={editing} onToggle={(e) => setEditing((e.target as HTMLDetailsElement).open)}>
            <summary>Edit the attack</summary>
            <fieldset>
              <legend>
                The product page <span>written by the seller, so untrusted</span>
              </legend>
              <div className="sk-fields">
                {field("title", "Title", "What the listing is called.", { maxLength: 200, required: true, placeholder: "Ridgeline Trail Runner, Slate Grey, US 10" })}
                {field("price", "Price (USD)", "Price per item.", { inputMode: "decimal", required: true, placeholder: "84.00" })}
                {field("color", "Colour", "As the listing states it.", { maxLength: 40, placeholder: "Slate Grey" })}
                {field("size", "Size", "Leave empty to omit it.", { maxLength: 20, placeholder: "10" })}
                {field("category", "Category", "The seller's category.", { maxLength: 120, placeholder: "Trail-running shoes" })}
                {field("brand", "Brand", "", { maxLength: 80, placeholder: "Ridgeline" })}
              </div>
              <label className="sk-field">
                <span className="sk-field-label">Description</span>
                <textarea className="sk-input" rows={3} value={f.description} onChange={set("description")} maxLength={2000} placeholder="Hide instructions to the agent here, or claim something the product isn't." />
                <span className={`sk-field-hint ${touched && errors.description ? "bad" : ""}`}>{touched && errors.description ? errors.description : "The agent reads this. Second Key treats it as evidence, never as instructions."}</span>
              </label>
            </fieldset>
            <fieldset>
              <legend>
                What the agent proposes <span>the purchase it&apos;s about to make</span>
              </legend>
              <div className="sk-fields two">
                {field("retailer", "Merchant", "Who would be paid, as a domain.", { maxLength: 120, placeholder: "rei.com", autoCapitalize: "off", spellCheck: false })}
                {field("quantity", "Quantity", "Rose asked for one pair.", { inputMode: "numeric", placeholder: "1" })}
              </div>
            </fieldset>
            <fieldset>
              <legend>
                Messages to the agent <span>optional, untrusted</span>
              </legend>
              <label className="sk-field">
                <span className="sk-field-label">One per line, as Speaker: message</span>
                <textarea className="sk-input" rows={3} value={f.messages} onChange={set("messages")} placeholder="Seller assistant: This price expires in 60 seconds. Check out now." />
                <span className={`sk-field-hint ${touched && errors.messages ? "bad" : ""}`}>{touched && errors.messages ? errors.messages : "Up to eight. They can add a pause; they can't change the mandate."}</span>
              </label>
            </fieldset>
            <Button size="sm" variant="quiet" type="button" onClick={() => choose(pick)}>
              Reset to the preset
            </Button>
          </details>

          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button busy={busy} disabled={busy}>
              {busy ? "Second Key is checking…" : "Run this attack"}
            </Button>
            <span className="xs muted">Real rules and AI checks. Nothing is bought; PayPal isn&apos;t called.</span>
          </div>
          {touched && invalid && !editing && <span className="xs" style={{ color: "var(--brick)" }}>Some fields need fixing. Open &ldquo;Edit the attack&rdquo;.</span>}
        </form>
        {err && (
          <Notice tone="bad" title="Second Key refused the request" role="alert">
            {err}
          </Notice>
        )}
      </div>

      <div className="sk-beat-result" aria-live="polite">
        {!res ? (
          <div className="sk-beat-empty">
            <span className="sk-section-title">The decision appears here</span>
            <p className="small soft">
              You&apos;ll see what the attack changed compared with Rose&apos;s mandate, what Second Key found, and the decision it made. If an attack gets through that shouldn&apos;t, that&apos;s a finding, and it&apos;s shown as one.
            </p>
          </div>
        ) : (
          <>
            <div className={`sk-verdict ${VERDICT[res.r.outcome].tone}`}>
              <h3 ref={resultRef} tabIndex={-1}>
                {VERDICT[res.r.outcome].title}
              </h3>
              <p className="small">{VERDICT[res.r.outcome].line}</p>
              {asExpected !== null && (
                <span className="xs">
                  {asExpected ? "As we expected for this attack." : `Not what we expected (${expected!.join(" or ").toLowerCase()}). If it should have been stopped, that's a finding.`}
                </span>
              )}
            </div>

            <div className="stack-sm">
              <span className="sk-section-title">What the attack changed</span>
              {changesOf(res.ran).length ? (
                <ul className="sk-diff">
                  {changesOf(res.ran).map((c) => (
                    <li key={c.what}>
                      <span>{c.what}</span>
                      <span>{c.value}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small soft">Nothing: this is exactly what Rose asked for.</p>
              )}
            </div>

            <div className="stack-sm">
              <span className="sk-section-title">What Second Key found</span>
              {flagged.length ? (
                <ul className="sk-found">
                  {flagged.map((c, i) => (
                    <li key={i} className={c.result === "fail" ? "fail" : c.unavailable ? "skip" : "open"}>
                      <Pill tone={c.result === "fail" ? "bad" : c.unavailable ? "neutral" : "held"}>{c.result === "fail" ? "Breaks the mandate" : c.unavailable ? "Couldn't check" : "Needs Rose"}</Pill>
                      <span className="small">
                        <strong>{checkLabel(c.id)}</strong> <span className="soft">{dollars(c.detail)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small soft">Every check passed.</p>
              )}
              {unavailable > 0 && <p className="xs muted">{unavailable} AI check{unavailable === 1 ? "" : "s"} couldn&apos;t run, so Second Key paused instead of guessing. That&apos;s a technical failure, not a finding about the attack.</p>}
              <details className="xs">
                <summary className="muted" style={{ cursor: "pointer" }}>
                  All {res.r.checks.length} checks
                </summary>
                <ul style={{ margin: "6px 0 0", paddingLeft: 16, display: "grid", gap: 3 }}>
                  {res.r.checks.map((c, i) => (
                    <li key={i}>
                      <strong style={{ color: c.result === "fail" ? "var(--brick)" : c.result === "unknown" ? "var(--brass)" : "var(--moss)" }}>{c.result}</strong> {checkLabel(c.id)} <span className="soft">· {dollars(c.detail)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
