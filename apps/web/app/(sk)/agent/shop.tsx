"use client";

// Real products, real mandate (10 Nov). The visitor tells Rose's agent what to buy in words; Haiku
// drafts the rules; the visitor sees and edits them; Channel3 returns real products; Rose's device
// signs a mandate for the shortlist and the rules. Then the agent buys, either the product it picks
// or one the visitor makes it pick, and the same verifier, ledger and PayPal settlement decide.

import { useEffect, useRef, useState } from "react";
import { api, errText } from "../../../lib/client";
import { deviceKey, type DeviceKey } from "../../../lib/ap2-device";
import { shopMandates, thumbprint, type ShopPlan, type ShopRule, type ShopSetup } from "../../../lib/ap2-surface";
import { usd } from "../../../lib/sk";
import { Button, Notice, Pill } from "../_ui/ui";
import { FINAL, HEADLINE, Ladder, Receipts, startSession, type CaughtBy, type Settlement, type Verification } from "./mandates";

interface Hit {
  id: string;
  title: string;
  brand: string | null;
  image: string | null;
  price_cents: number;
  retailer: string;
  attributes: Record<string, string>;
  rules: { attribute: string; value: string | null; ok: boolean | null }[];
}
type Mode = "buy" | "swap" | "hide_list";
interface ShopRun {
  mode: Mode;
  agent: { product_id: string; title: string; retailer: string; price_cents: number; image: string | null };
  sent_to_paypal?: { product_id: string; title: string };
  withheld?: number;
  verification: Verification;
  settlement: Settlement | null;
  caught_by: CaughtBy;
}

/** How many search results the agent proposes for Rose's AP2 list. */
const PROPOSED = 8;

const EXAMPLES = ["a gold smartwatch under $150", "black running shoes under $120, not white", "a silver necklace under $80"];

let enrolledKey: string | null = null;
async function enrol(d: DeviceKey) {
  const k = d.publicJwk.x;
  if (enrolledKey === k) return;
  await startSession();
  try {
    await api("/v1/me/demo/ap2/surface", { method: "POST", body: { jwk: d.publicJwk }, asPayer: true });
  } catch {
    await startSession(true);
    await api("/v1/me/demo/ap2/surface", { method: "POST", body: { jwk: d.publicJwk }, asPayer: true });
  }
  enrolledKey = k;
}

const ruleText = (r: ShopRule) => `${r.attribute} ${r.any_of?.length ? `is ${r.any_of.join(" or ")}` : ""}${r.any_of?.length && r.none_of?.length ? ", " : ""}${r.none_of?.length ? `not ${r.none_of.join(" or ")}` : ""}`;

export function RealShop() {
  const [setup, setSetup] = useState<ShopSetup | null>(null);
  const [device, setDevice] = useState<(DeviceKey & { kid: string }) | null>(null);
  const [need, setNeed] = useState(EXAMPLES[0]!);
  const [plan, setPlan] = useState<ShopPlan | null>(null);
  const [summary, setSummary] = useState("");
  const [draftedBy, setDraftedBy] = useState<"ai" | "rules" | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [shortlist, setShortlist] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [run, setRun] = useState<ShopRun | null>(null);
  const [pickReason, setPickReason] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [err, setErr] = useState("");
  const resultRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, k] = await Promise.all([api<ShopSetup>("/v1/demo/ap2/setup"), deviceKey()]);
        setSetup(s);
        setDevice({ ...k, kid: await thumbprint(k.publicJwk) });
      } catch (e) {
        setErr(errText(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!settlement || FINAL.includes(settlement.state)) return;
    const t = setInterval(async () => {
      try {
        const s = await api<Settlement>(`/v1/me/demo/ap2/settlements/${settlement.settlement_id}`, { asPayer: true });
        if (s.state !== settlement.state || (s.receipts && !settlement.receipts)) setSettlement(s);
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [settlement]);

  async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setErr("");
    try {
      if (device) await enrol(device);
      return await fn();
    } catch (e) {
      setErr(errText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function search(p: ShopPlan) {
    const r = await api<{ source: string; hits: Hit[] }>("/v1/me/demo/ap2/shop/search", { method: "POST", body: p, asPayer: true });
    setHits(r.hits);
    // The agent proposes its top results; Rose approves them as her AP2 list. Her rules do the rest.
    setShortlist(new Set(r.hits.slice(0, PROPOSED).map((h) => h.id)));
  }

  const draft = () =>
    step("plan", async () => {
      setRun(null);
      setSettlement(null);
      setHits(null);
      const r = await api<{ plan: ShopPlan; summary: string; drafted_by: "ai" | "rules" }>("/v1/me/demo/ap2/shop/plan", { method: "POST", body: { need }, asPayer: true });
      setPlan(r.plan);
      setSummary(r.summary);
      setDraftedBy(r.drafted_by);
      await search(r.plan);
    });

  const refresh = (p: ShopPlan) => step("search", async () => (setPlan(p), setRun(null), setSettlement(null), await search(p)));

  async function buy(mode: Mode, productId: string, extra: Record<string, unknown> = {}) {
    if (!plan || !hits || !setup || !device) return;
    const list = hits.filter((h) => shortlist.has(h.id)).map((h) => ({ id: h.id, title: h.title }));
    // Enrol the key that is about to sign, every run: the payer has exactly one enrolled device key.
    await api("/v1/me/demo/ap2/surface", { method: "POST", body: { jwk: device.publicJwk }, asPayer: true });
    const m = await shopMandates(setup, plan, list, device.privateKey, device.kid);
    const hit = hits.find((h) => h.id === productId);
    const v = await api<ShopRun>("/v1/me/demo/ap2/shop/runs", {
      method: "POST",
      body: { mode, product_id: productId, open_checkout: m.openCheckout, open_payment: m.openPayment, ...(hit?.image ? { image: hit.image } : {}), ...extra },
      asPayer: true,
    });
    setRun(v);
    setSettlement(v.settlement);
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  const agentChooses = () =>
    step("pick", async () => {
      setRun(null);
      setSettlement(null);
      const candidates = hits!.slice(0, 12).map((h) => ({ ...h, listed: shortlist.has(h.id) }));
      const p = await api<{ product_id: string; reason: string; picked_by: "ai" | "rules" }>("/v1/me/demo/ap2/shop/pick", { method: "POST", body: { summary, plan, hits: candidates }, asPayer: true });
      setPickReason(`${p.picked_by === "ai" ? "The agent (Haiku)" : "The agent"} picked it: ${p.reason}`);
      await buy("buy", p.product_id);
    });
  const userPicks = (id: string) => step(`buy:${id}`, async () => (setPickReason("You made the agent pick it."), setRun(null), setSettlement(null), await buy("buy", id)));

  const listed = hits?.filter((h) => shortlist.has(h.id)) ?? [];
  const unlisted = hits?.filter((h) => !shortlist.has(h.id)) ?? [];
  const swap = () =>
    step("swap", async () => {
      setPickReason("The agent's cart is right; the checkout sends PayPal an order for a different product at the same price.");
      setRun(null);
      setSettlement(null);
      await buy("swap", listed[0]!.id, { swap_to: (unlisted[0] ?? listed[1])!.id });
    });
  const hideList = () =>
    step("hide", async () => {
      setPickReason("The agent withholds the part of Rose's mandate that lists her shortlist, then buys something outside it.");
      setRun(null);
      setSettlement(null);
      await buy("hide_list", unlisted[0]!.id);
    });

  const caught: CaughtBy | null = run ? (run.caught_by === "none" && settlement && ["VOIDED", "VOIDING", "REFUSED"].includes(settlement.state) ? "paypal_order" : run.caught_by) : null;
  const headline = !run
    ? ""
    : run.mode === "hide_list" && caught === "ap2_constraints"
      ? "The agent hid Rose's list. The list still held."
      : caught === "none" && settlement?.state !== "CAPTURED"
        ? "Every check passed: PayPal is capturing…"
        : HEADLINE[caught!];
  const hitOf = (id: string) => hits?.find((h) => h.id === id);
  const factsPass = plan?.rules.length
    ? `${plan.rules.map(ruleText).join("; ")}: true on the product facts Second Key fetched from Channel3 itself and signed`
    : "No attribute rule in this mandate.";

  return (
    <div className="sk-card stack-lg">
      <form
        className="row"
        style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          void draft();
        }}
      >
        <label className="stack-sm xs" style={{ flex: "1 1 320px" }}>
          <span className="muted">What should Rose&apos;s agent buy?</span>
          <input className="sk-input" value={need} maxLength={300} onChange={(e) => setNeed(e.target.value)} disabled={!!busy} />
        </label>
        <Button busy={busy === "plan"} disabled={!!busy || !setup || !device || need.trim().length < 3}>
          {busy === "plan" ? "Drafting and searching…" : "Draft the mandate"}
        </Button>
      </form>
      <div className="row xs" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="muted">Try:</span>
        {EXAMPLES.map((x) => (
          <button key={x} type="button" className="sk-chip" disabled={!!busy} onClick={() => setNeed(x)}>
            {x}
          </button>
        ))}
      </div>

      {plan && (
        <PlanEditor
          plan={plan}
          draftedBy={draftedBy}
          busy={!!busy}
          merchant={setup?.shop.merchant.name ?? "the shop"}
          onChange={(p) => void refresh(p)}
        />
      )}

      {hits && (
        <div className="stack">
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className="small">
              <strong>{hits.length}</strong> real products from Channel3 under {usd(plan!.max_cents)} · <strong>{listed.length}</strong> on Rose&apos;s shortlist
            </span>
            <span className="xs muted">The agent proposed its top {PROPOSED}; Rose approves them as her AP2 list (untick to change it). Her rules still apply to whatever the agent buys. Badges show each listing&apos;s own data; Second Key re-fetches the product before deciding.</span>
          </div>
          {hits.length === 0 ? (
            <Notice tone="held">Channel3 found nothing under that budget. Try a broader search or a higher budget.</Notice>
          ) : (
            <ul className="sk-shop-grid">
              {hits.map((h) => (
                <li key={h.id} className={`sk-shop-card ${shortlist.has(h.id) ? "listed" : ""} ${run?.agent.product_id === h.id ? "picked" : ""}`}>
                  <label className="sk-shop-tick xs">
                    <input
                      type="checkbox"
                      checked={shortlist.has(h.id)}
                      disabled={!!busy}
                      onChange={(e) => setShortlist((s) => (e.target.checked ? new Set(s).add(h.id) : new Set([...s].filter((x) => x !== h.id))))}
                    />
                    Shortlist
                  </label>
                  <div className="sk-shop-img">{h.image ? <img src={h.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="xs muted">No image</span>}</div>
                  <div className="stack-sm" style={{ gap: 4 }}>
                    <span className="small" style={{ fontWeight: 600, lineHeight: 1.3 }}>
                      {h.title}
                    </span>
                    <span className="xs muted">
                      {h.brand ? `${h.brand} · ` : ""}
                      {h.retailer}
                    </span>
                    <span className="small" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {usd(h.price_cents)}
                    </span>
                    <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                      {h.rules.map((r, i) => (
                        <Pill key={i} tone={r.ok === true ? "ok" : r.ok === false ? "bad" : "held"}>
                          {r.value ? `${r.attribute}: ${r.value}` : `${r.attribute}: not stated`}
                        </Pill>
                      ))}
                    </span>
                  </div>
                  <Button size="sm" variant="secondary" busy={busy === `buy:${h.id}`} disabled={!!busy} onClick={() => void userPicks(h.id)}>
                    Make the agent buy this
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {hits.length > 0 && (
            <div className="sk-card tint stack-sm">
              <span className="sk-section-title">Or let something go wrong</span>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Button busy={busy === "pick"} disabled={!!busy || !listed.length} onClick={() => void agentChooses()}>
                  Let the agent choose
                </Button>
                <Button variant="secondary" busy={busy === "swap"} disabled={!!busy || !listed.length || hits.length < 2} onClick={() => void swap()}>
                  Checkout swaps the product
                </Button>
                <Button variant="secondary" busy={busy === "hide"} disabled={!!busy || !listed.length || !unlisted.length} onClick={() => void hideList()}>
                  Agent hides Rose&apos;s list
                </Button>
              </div>
              <p className="xs muted">
                Each run signs a fresh mandate on this device: open mandates are single-use. Purchases that pass are captured on the PayPal sandbox; nothing real is bought.
              </p>
            </div>
          )}
        </div>
      )}

      {err && (
        <Notice tone="bad" title="Something went wrong" role="alert">
          {err}
        </Notice>
      )}

      {run && (
        <div className="sk-stage" aria-live="polite">
          <div className="stack">
            <h3 ref={resultRef} tabIndex={-1} style={{ fontSize: "var(--text-xl)" }}>
              {headline}
            </h3>
            <div className="row" style={{ gap: 12, alignItems: "center" }}>
              {run.agent.image && <img src={run.agent.image} alt="" width={64} height={64} style={{ objectFit: "contain", borderRadius: 12, background: "#fff" }} referrerPolicy="no-referrer" />}
              <div className="stack-sm" style={{ gap: 2 }}>
                <span className="small">
                  <strong>{run.agent.title}</strong>
                </span>
                <span className="xs muted">
                  {run.agent.retailer} · {usd(run.agent.price_cents)} · {shortlist.has(run.agent.product_id) ? "on Rose's shortlist" : "not on Rose's shortlist"}
                </span>
              </div>
            </div>
            {pickReason && <p className="small soft">{pickReason}</p>}
            {run.sent_to_paypal && (
              <p className="small soft">
                The checkout sent PayPal: <strong>{run.sent_to_paypal.title}</strong>.
              </p>
            )}
            {run.mode === "hide_list" && (
              <p className="small soft">
                The agent withheld {run.withheld} signed disclosure{run.withheld === 1 ? "" : "s"}: Rose&apos;s signature still verifies, but her shortlist now looks empty. A verifier that reads an empty list as &ldquo;anything goes&rdquo; would accept this purchase. Second Key treats a list with nothing revealed as matching nothing.
              </p>
            )}
            {hitOf(run.agent.product_id)?.rules.some((r) => r.ok === null) && caught === "cannot_confirm" && (
              <p className="small soft">Channel3&apos;s data for this product doesn&apos;t state every attribute Rose&apos;s rules need, so Second Key can&apos;t confirm it. It isn&apos;t paid.</p>
            )}
          </div>
          <Ladder view={run} settlement={settlement} factsPass={factsPass} />
        </div>
      )}
      {run && <Receipts view={run} settlement={settlement} />}
    </div>
  );
}

function PlanEditor({ plan, draftedBy, busy, merchant, onChange }: { plan: ShopPlan; draftedBy: "ai" | "rules" | null; busy: boolean; merchant: string; onChange: (p: ShopPlan) => void }) {
  const [query, setQuery] = useState(plan.query);
  const [budget, setBudget] = useState(String(plan.max_cents / 100));
  useEffect(() => {
    setQuery(plan.query);
    setBudget(String(plan.max_cents / 100));
  }, [plan]);
  const apply = (rules = plan.rules) => {
    const max = Math.round(Number(budget) * 100);
    if (query.trim().length < 2 || !Number.isFinite(max) || max < 100 || max > 100_000) return;
    onChange({ query: query.trim(), max_cents: max, rules });
  };
  return (
    <div className="sk-phone stack" style={{ maxWidth: "none" }} aria-label="What Rose signs">
      <div className="appbar">
        <span className="soft">What Rose&apos;s device will sign</span>
        <span className="xs muted">{draftedBy === "ai" ? "Drafted by Haiku from your words. Check it: nothing applies until it's signed." : "Drafted from your words. Check it: nothing applies until it's signed."}</span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label className="stack-sm xs" style={{ flex: "2 1 220px" }}>
          <span className="muted">Search</span>
          <input className="sk-input" value={query} maxLength={80} disabled={busy} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="stack-sm xs" style={{ flex: "1 1 100px" }}>
          <span className="muted">Budget (USD)</span>
          <input className="sk-input" inputMode="decimal" value={budget} disabled={busy} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => apply()}>
          Search again
        </Button>
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
        <li>
          One item from her <strong>shortlist</strong> (AP2 line items, by Channel3 product id)
        </li>
        {plan.rules.map((r, i) => (
          <li key={i}>
            <strong>{ruleText(r)}</strong> <span className="xs muted">(Second Key&apos;s attribute constraint)</span>{" "}
            <button type="button" className="sk-chip" disabled={busy} onClick={() => apply(plan.rules.filter((_, j) => j !== i))} aria-label={`Remove rule ${ruleText(r)}`}>
              Remove
            </button>
          </li>
        ))}
        <li>
          Up to <strong>{usd(plan.max_cents)}</strong>, paid to {merchant} only (AP2 amount and payee)
        </li>
        <li>Only her agent&apos;s key can use it, once, for the next 30 minutes</li>
      </ul>
    </div>
  );
}
