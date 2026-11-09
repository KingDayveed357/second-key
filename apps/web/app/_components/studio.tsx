"use client";

// The ops console on AG Studio (ADR-0009): a themed, two-page report over Second Key's ledger, with a
// custom "evidence chain" widget that verifies a purchase's hash-chained audit trail live.
import { useEffect, useMemo, useState } from "react";
import { AgStudio, createWidgets } from "ag-studio-react";
import { AgStudioAiModule, AgStudioLicenseManager, AgStudioModuleRegistry, studioTheme, type AgReportState, type AgWidgetParams } from "ag-studio";
import { witnessHarness } from "./studio-ai";

// Studio Agent Framework: a Second Key lead and analyst (custom agents) working with Studio's built-in
// agents, all on Haiku via this site's server route (studio-ai.ts, lib/server/studio-ai.ts).
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);
const ai = witnessHarness;
import { api, checkLabel, errText, money, tone } from "../../lib/client";

interface Data {
  ledger: Record<string, unknown>[];
  holds: Record<string, unknown>[];
  blocked: Record<string, unknown>[];
}

const dollars = (c: unknown) => (c == null ? null : Number(c) / 100);

// Explicit fields, so a source renders even when it has no rows (an empty HOLD queue is normal).
const text = (id: string, name: string) => ({ id, name, format: "textFormat" });
const usd = (id: string, name: string) => ({ id, name, format: "currencyFormat", formatOptions: { currency: "USD" } });
const int = (id: string, name: string) => ({ id, name, format: "integerFormat" });
const FIELDS = {
  ledger: [text("purchase", "Purchase"), text("created", "Created (UTC)"), text("state", "State"), text("product", "Product"), text("retailer", "Retailer"), usd("amount", "Amount"), text("reason", "Primary reason"), text("paypal_order", "PayPal order")],
  holds: [text("purchase", "Purchase"), text("product", "Product"), usd("amount", "Amount"), text("why", "Why held"), text("auto_void_at", "Auto-void at (UTC)"), text("shopper_notified", "Shopper notified")],
  blocked: [text("reason", "Reason"), int("purchases", "Purchases"), usd("value", "Value blocked")],
};

// Second Key theme on AG Studio's theming API, following the page's light/dark mode.
const THEMES = {
  light: studioTheme.withParams({ fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", backgroundColor: "#ffffff", textColor: "#14171c", borderColor: "#dde1e7", accentColor: "#0b57d0", gridBrowserColorScheme: "light", gridAccentColor: "#0b57d0", gridCellTextColor: "#14171c", gridHeaderBackgroundColor: "#f0f2f5" } as any),
  dark: studioTheme.withParams({ fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", backgroundColor: "#171b21", textColor: "#e8eaed", borderColor: "#2c333d", accentColor: "#8ab4f8", gridBrowserColorScheme: "dark", gridAccentColor: "#8ab4f8", gridCellTextColor: "#e8eaed", gridHeaderTextColor: "#c3cfdd", gridHeaderBackgroundColor: "#1f242c", gridDataBackgroundColor: "#171b21", gridOddRowBackgroundColor: "#1b2027", gridIconColor: "#9aa3ae" } as any),
};
const title = (t: string) => ({ title: { text: t, enabled: true } });

async function load(): Promise<Data> {
  const [p, h, s] = await Promise.all([
    api("/v1/console/purchases?limit=500", { console: true }),
    api("/v1/console/holds", { console: true }),
    api("/v1/console/stats", { console: true }),
  ]);
  return {
    ledger: p.purchases.map((r: any) => ({
      purchase: r.id,
      created: r.created_at.slice(0, 16).replace("T", " "),
      state: r.state,
      product: r.product ?? "(not priced)",
      retailer: r.retailer ?? "",
      amount: dollars(r.amount_cents),
      reason: r.primary_check ? checkLabel(r.primary_check) : "all checks passed",
      paypal_order: r.paypal_order_id ?? "",
    })),
    holds: h.holds.map((r: any) => ({
      purchase: r.id,
      product: r.product ?? "",
      amount: dollars(r.amount_cents),
      why: r.reasons.join("; "),
      auto_void_at: r.auto_void_at.slice(0, 16).replace("T", " "),
      shopper_notified: r.shopper_notified ? "yes" : "no",
    })),
    blocked: s.blocked_by_reason.map((r: any) => ({ reason: checkLabel(r.reason), purchases: r.count, value: dollars(r.amount_cents) })),
  };
}

const initialState = {
  selectedPageId: "overview",
  // Edit mode is needed for the AI panel; open it and collapse the authoring panels so the dashboard stays readable.
  panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true }, ai: { collapsed: false, width: 360 } },
  pages: [
    {
      id: "overview",
      widgets: {
        screened: { type: "value", dataMapping: { value: [{ id: "ledger.purchase", aggregation: "count" }] }, format: title("Purchases screened") },
        value: { type: "value", dataMapping: { value: [{ id: "ledger.amount", aggregation: "sum" }] }, format: title("Value screened (USD)") },
        blockedValue: { type: "value", dataMapping: { value: [{ id: "blocked.value", aggregation: "sum" }] }, format: title("Value blocked (USD)") },
        byReason: {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "blocked.reason" }], valueKey: [{ id: "blocked.value", aggregation: "sum" }] },
          format: title("Blocked value by reason"),
        },
        byState: {
          type: "donut-chart",
          dataMapping: { categoryKey: [{ id: "ledger.state" }], valueKey: [{ id: "ledger.purchase", aggregation: "count" }] },
          format: title("Decisions"),
        },
        ledger: {
          type: "grid",
          dataMapping: { cols: ["created", "state", "product", "retailer", "amount", "reason", "purchase", "paypal_order"].map((f) => ({ id: `ledger.${f}` })) },
          format: title("Ledger"),
        },
        chain: { type: "evidence-chain" },
      },
      widgetLayout: {
        screened: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 5 },
        value: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 5 },
        blockedValue: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 5 },
        byReason: { xTrack: 0, yTrack: 5, xSpan: 14, ySpan: 12 },
        byState: { xTrack: 14, yTrack: 5, xSpan: 10, ySpan: 12 },
        ledger: { xTrack: 0, yTrack: 17, xSpan: 24, ySpan: 16 },
        chain: { xTrack: 0, yTrack: 33, xSpan: 24, ySpan: 18 },
      },
    },
    {
      id: "holds",
      widgets: {
        holdCount: { type: "value", dataMapping: { value: [{ id: "holds.purchase", aggregation: "count" }] }, format: title("Awaiting the shopper") },
        heldValue: { type: "value", dataMapping: { value: [{ id: "holds.amount", aggregation: "sum" }] }, format: title("Authorized, not captured (USD)") },
        queue: {
          type: "grid",
          dataMapping: { cols: ["auto_void_at", "product", "amount", "why", "shopper_notified", "purchase"].map((f) => ({ id: `holds.${f}` })) },
          format: title("HOLD queue (soonest auto-void first)"),
        },
      },
      widgetLayout: {
        holdCount: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 5 },
        heldValue: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 5 },
        queue: { xTrack: 0, yTrack: 5, xSpan: 24, ySpan: 20 },
      },
    },
  ],
} as unknown as AgReportState;

// ---- custom widget: evidence chain ------------------------------------------------------------

const CHAIN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

function EvidenceChainWidget(props: AgWidgetParams) {
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [id, setId] = useState("");
  const [view, setView] = useState<{ chain: any; checks: any[]; purchase: any } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    props.widgetApi.setDisplayState("displayed");
    api("/v1/console/purchases?limit=50", { console: true }).then(
      (r) => {
        const opts = r.purchases.map((p: any) => ({ id: p.id, label: `${p.state} · ${p.product ?? "unpriced"} · ${p.id}` }));
        setOptions(opts);
        if (opts[0]) setId(opts[0].id);
      },
      (e) => setErr(errText(e)),
    );
  }, [props.widgetApi]);

  useEffect(() => {
    if (!id) return;
    setView(null);
    Promise.all([api(`/v1/verify/purchases/${id}`), api(`/v1/console/purchases/${id}/checks`, { console: true }), api(`/v1/purchases/${id}`, { console: true })]).then(
      ([chain, c, purchase]) => setView({ chain, checks: c.checks, purchase }),
      (e) => setErr(errText(e)),
    );
  }, [id]);

  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto", fontSize: 13 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>Evidence chain</strong>
        <select value={id} onChange={(e) => setId(e.target.value)} style={{ maxWidth: 520 }} aria-label="Purchase">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {view && <span className={`badge ${view.chain.valid ? "ok" : "bad"}`}>{view.chain.valid ? "hash chain valid" : "CHAIN BROKEN"}</span>}
      </div>
      {err && <p className="error">{err}</p>}
      {view && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) minmax(260px, 1fr)", gap: 16 }}>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>
              Audit events (each hash covers the previous one). {view.purchase.amount ? `${view.purchase.amount.value} ${view.purchase.amount.currency_code}` : ""} · <span className={`badge ${tone(view.purchase.state)}`}>{view.purchase.state}</span>
            </div>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {view.chain.events.map((e: any) => (
                <li key={e.seq} style={{ marginBottom: 6 }}>
                  <strong>{e.event_type}</strong> <span className="muted">{new Date(e.at).toLocaleTimeString()}</span>
                  <div className="mono muted">#{e.seq} {String(e.hash).slice(7, 19)} ← {String(e.prev_hash).slice(7, 19)}</div>
                </li>
              ))}
            </ol>
            {view.purchase.paypal?.order_id && (
              <div className="small" style={{ marginTop: 6 }}>
                PayPal: order <code>{view.purchase.paypal.order_id}</code>
                {view.purchase.paypal.authorization_id && <> · auth <code>{view.purchase.paypal.authorization_id}</code></>}
                {view.purchase.paypal.capture_id && <> · capture <code>{view.purchase.paypal.capture_id}</code></>}
              </div>
            )}
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Checks, in the order Second Key ran them</div>
            <ul className="checks">
              {view.checks.map((c: any, i: number) => (
                <li key={i}>
                  <span className={`badge ${tone(c.result)}`}>{c.result}</span>
                  <span>
                    <strong>{checkLabel(c.check_id)}</strong> <span className="muted">[{c.phase}{c.model ? ` · ${c.model} ${c.prompt_version}` : ""}]</span> {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

const evidenceChainDefinition = {
  id: "evidence-chain",
  label: "Evidence chain",
  icon: CHAIN_ICON,
  form: () => [],
  comp: EvidenceChainWidget,
  defaultSize: { width: 24, height: 18 },
  minSize: { width: 12, height: 10 },
};

// ---- console ------------------------------------------------------------------------------------

export function ConsoleStudio({ licenseKey }: { licenseKey: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (licenseKey) AgStudioLicenseManager.setLicenseKey(licenseKey);
  }, [licenseKey]);

  const refresh = () =>
    load().then(
      (d) => {
        setData(d);
        setLoadedAt(new Date());
      },
      (e) => setErr(errText(e)),
    );
  useEffect(() => {
    refresh();
  }, []);

  const sources = useMemo(
    () => (data ? { sources: [{ id: "ledger", data: data.ledger, fields: FIELDS.ledger }, { id: "holds", data: data.holds, fields: FIELDS.holds }, { id: "blocked", data: data.blocked, fields: FIELDS.blocked }] } : null),
    [data],
  );
  const widgets = useMemo(
    () => (config: any) => createWidgets({ additionalTypes: [evidenceChainDefinition], menu: [...(config.menu ?? []), { label: "Second Key", widgetIds: ["evidence-chain"] }] } as any),
    [],
  );

  if (err) return <p className="error">{err}</p>;
  if (!data || !sources) return <p className="muted">Loading ledger…</p>;
  return (
    <>
      <div className="row small muted" style={{ marginBottom: 8 }}>
        <span>{data.ledger.length} purchases · {data.holds.length} held · blocked {money(Math.round(data.blocked.reduce((s, b) => s + Number(b.value ?? 0), 0) * 100))}</span>
        <button onClick={refresh}>Refresh</button>
        {loadedAt && <span>as of {loadedAt.toLocaleTimeString()}</span>}
        {!licenseKey && <span className="badge warn">AG Studio trial mode (no licence key set)</span>}
      </div>
      <div style={{ height: "calc(100vh - 210px)", minHeight: 640, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <AgStudio key={`${loadedAt?.getTime()}-${dark}`} data={sources as any} initialState={initialState} mode="edit" widgets={widgets as any} ai={ai as any} theme={dark ? THEMES.dark : THEMES.light} style={{ height: "100%", width: "100%" }} />
      </div>
    </>
  );
}
