"use client";

// The integration conformance suite: every case runs the real engine
// against the PayPal sandbox through the same path an integrator's agent or app uses, and each result
// can be checked against PayPal's own record and the purchase's hash-chained audit trail.

import { useCallback, useEffect, useState } from "react";
import { api, errText, money, settle } from "../../../lib/client";
import { StatePill } from "../_ui/ui";
import { Button } from "../_ui/ui";

interface Scenario {
  name: string;
  title: string;
  expected: "CAPTURE" | "REJECT" | "HOLD" | "VOID";
}
interface Run {
  purchase: { id: string; state: string; amount: { value: string; currency_code: string } | null; reasons: string[] } | null;
  paypal?: { order?: { status?: string } | null; authorizations?: { id: string; status: string }[]; captures?: { id: string; status: string }[]; debug_id?: string };
  chain?: { valid: boolean; events: unknown[] };
  error?: string;
  busy?: boolean;
}

/** The expected outcome as the final purchase state it should reach. */
const FINAL: Record<Scenario["expected"], string[]> = { CAPTURE: ["CAPTURED"], REJECT: ["REJECTED"], HOLD: ["HELD"], VOID: ["VOIDED", "VOIDING"] };
const ORDER = ["normal", "reject", "over_budget", "hold", "overpriced", "injection", "steered", "cart_swap", "scam_transfer", "bank_call_transfer", "benign_transfer"];
const GROUP = (name: string) => (name.endsWith("_transfer") ? "Transfers (people)" : "Agent purchases");

export function Counters() {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api("/v1/demo/stats").then(setS, (e) => setErr(errText(e))), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  if (err) return <p className="small muted">Counters unavailable: {err}</p>;
  if (!s) return <p className="small muted">Loading counters…</p>;
  const blocked = (s.rejected?.amount_cents ?? 0) + (s.voided?.amount_cents ?? 0);
  const tile = (v: React.ReactNode, l: string, bad = false) => (
    <div className="sk-card stack-sm" style={{ padding: 14 }}>
      <span style={{ fontSize: "var(--text-xl)", fontWeight: 650, color: bad ? "var(--brick)" : undefined }}>{v}</span>
      <span className="xs muted">{l}</span>
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }} aria-live="polite">
      {tile(s.purchases, `Payments screened${s.since ? " since the last demo reset" : ""}`)}
      {tile(`${s.captured.count} · ${money(s.captured.amount_cents)}`, "Completed")}
      {tile(money(blocked), "Stopped (refused or cancelled)")}
      {tile(s.unauthorized_captures, "Captures without a recorded approval", s.unauthorized_captures > 0)}
    </div>
  );
}

export function Conformance() {
  const [list, setList] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Scenario[]>("/v1/demo/scenarios").then((l) => setList([...l].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))), (e) => setErr(errText(e)));
  }, []);
  const patch = (name: string, p: Partial<Run>) => setRuns((r) => ({ ...r, [name]: { ...(r[name] ?? { purchase: null }), ...p } }));

  async function run(s: Scenario) {
    setRuns((r) => ({ ...r, [s.name]: { purchase: null, busy: true } }));
    try {
      const started = await api(`/v1/demo/scenarios/${s.name}`, { method: "POST" });
      patch(s.name, { purchase: started.purchase });
      const final = await settle(started.purchase.id, (p) => patch(s.name, { purchase: p }));
      patch(s.name, { purchase: final, busy: false });
    } catch (e) {
      patch(s.name, { error: errText(e), busy: false });
    }
  }
  const read = async (name: string, id: string) => {
    try {
      patch(name, { paypal: await api(`/v1/purchases/${id}/paypal`) });
    } catch (e) {
      patch(name, { error: errText(e) });
    }
  };
  const verify = async (name: string, id: string) => {
    try {
      patch(name, { chain: await api(`/v1/verify/purchases/${id}`) });
    } catch (e) {
      patch(name, { error: errText(e) });
    }
  };

  const groups = [...new Set(list.map((s) => GROUP(s.name)))];
  return (
    <div className="stack-lg">
      {err && <p className="small" style={{ color: "var(--brick)" }}>{err}</p>}
      {groups.map((g) => (
        <section key={g} className="stack">
          <h3 className="sk-section-title">{g}</h3>
          {g === "Agent purchases" && <p className="xs muted">The principal confirmed: trail-running shoes, size 10, under $90, not white, from REI or Backcountry.</p>}
          {g !== "Agent purchases" && <p className="xs muted">The shared demo payer, without a trusted contact: these show the engine&apos;s outcome, not the second-key flow (that is the payer demo).</p>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {list
              .filter((s) => GROUP(s.name) === g)
              .map((s) => {
                const r = runs[s.name];
                const p = r?.purchase;
                const pass = p && !r?.busy ? FINAL[s.expected].includes(p.state) : null;
                return (
                  <div key={s.name} className="sk-card stack-sm" style={{ padding: 14 }}>
                    <strong className="small">{s.title.replace(/^Second Key: /, "")}</strong>
                    <span className="xs muted">
                      Expected: <strong>{s.expected}</strong>
                      {pass !== null && <span style={{ color: pass ? "var(--moss)" : "var(--brick)", marginLeft: 8 }}>{pass ? "✓ as expected" : "✗ unexpected"}</span>}
                    </span>
                    <div className="row" style={{ gap: 8 }}>
                      <Button size="sm" onClick={() => run(s)} busy={r?.busy}>
                        {r?.busy ? "Running…" : p ? "Run again" : "Run"}
                      </Button>
                      {p && <StatePill state={p.state} />}
                    </div>
                    {r?.error && <span className="xs" style={{ color: "var(--brick)" }}>{r.error}</span>}
                    {p && (
                      <>
                        {p.amount && (
                          <span className="xs">
                            {p.amount.value} {p.amount.currency_code}
                          </span>
                        )}
                        {p.reasons.length > 0 && (
                          <ul className="xs soft" style={{ margin: 0, paddingLeft: 16 }}>
                            {p.reasons.slice(0, 3).map((x, i) => (
                              <li key={i}>{x}</li>
                            ))}
                          </ul>
                        )}
                        <div className="row" style={{ gap: 8 }}>
                          <Button size="sm" variant="quiet" onClick={() => read(s.name, p.id)}>
                            Read PayPal&apos;s record
                          </Button>
                          <Button size="sm" variant="quiet" onClick={() => verify(s.name, p.id)}>
                            Verify audit chain
                          </Button>
                        </div>
                        {r?.paypal && (
                          <span className="xs mono">
                            PayPal: order {r.paypal.order?.status ?? "none"} · auth {r.paypal.authorizations?.map((a) => a.status).join(", ") || "none"} · captures {r.paypal.captures?.map((c) => c.status).join(", ") || "none"}
                            {r.paypal.debug_id ? ` · debug ${r.paypal.debug_id}` : ""}
                          </span>
                        )}
                        {r?.chain && <span className="xs">{r.chain.valid ? `✓ Audit chain valid (${r.chain.events.length} events)` : "✗ Audit chain invalid"}</span>}
                      </>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
