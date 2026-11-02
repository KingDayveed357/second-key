"use client";

// Protection Desk · Insights (ADR-0022): AG Studio over the same incident rows the grid shows, themed with
// Second Key's tokens, with a custom proof-chain widget and the Studio Agent Framework (a Second Key lead
// and analyst over Studio's built-in agents, on Haiku through this site's server route). Read-only: the
// data is what the Desk already shows, and nothing here can approve, cancel or move money.

import { useEffect, useMemo, useState } from "react";
import { AgStudio, createWidgets } from "ag-studio-react";
import { AgStudioAiModule, AgStudioLicenseManager, AgStudioModuleRegistry, studioTheme, type AgReportState, type AgWidgetParams } from "ag-studio";
import { secondKeyHarness } from "../../_components/studio-ai";
import { api, errText } from "../../../lib/client";
import { insightRows, personOf, toRow, type DeskRow, type Incident } from "../../../lib/desk";
import { deciderOf, tacticOf } from "../../../lib/sk";

AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

// Second Key's tokens (sk.css) as literal values: AG Charts draws on a canvas, which can't read CSS variables.
const TOKENS = {
  light: { paper: "#f7f5f0", surface: "#ffffff", surface2: "#f1eee7", ink: "#16181d", ink3: "#6f7480", line: "#e3dfd5", brand: "#0f3b36" },
  dark: { paper: "#121412", surface: "#1a1d1b", surface2: "#222623", ink: "#eceae4", ink3: "#9b9a93", line: "#2d322f", brand: "#8cc7bb" },
};
const themeFor = (mode: "light" | "dark") => {
  const t = TOKENS[mode];
  return studioTheme.withParams({
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    backgroundColor: t.surface,
    textColor: t.ink,
    borderColor: t.line,
    accentColor: t.brand,
    gridBrowserColorScheme: mode,
    gridAccentColor: t.brand,
    gridCellTextColor: t.ink,
    gridHeaderTextColor: t.ink3,
    gridHeaderBackgroundColor: t.surface2,
    gridDataBackgroundColor: t.surface,
    gridOddRowBackgroundColor: mode === "dark" ? "#1d201e" : "#faf9f6",
  } as any);
};

const text = (id: string, name: string) => ({ id, name, format: "textFormat" });
const usdField = (id: string, name: string) => ({ id, name, format: "currencyFormat", formatOptions: { currency: "USD" } });
const int = (id: string, name: string) => ({ id, name, format: "integerFormat" });
const FIELDS = [
  text("incident", "Incident"),
  text("detected", "Detected (UTC)"),
  text("workflow", "Workflow"),
  text("counterparty", "To / item"),
  usdField("amount", "Amount (USD)"),
  text("pattern", "AI · strongest pattern"),
  int("evidence", "AI · quoted lines"),
  text("policy", "Rule · outcome"),
  text("review", "Person · decision"),
  text("decided_by", "Person · who decided"),
  text("authorization", "PayPal · authorization"),
  text("capture", "PayPal · capture"),
  text("resolution", "Resolution"),
  usdField("stopped", "Stopped (USD)"),
];


const title = (t: string) => ({ title: { text: t, enabled: true } });
const initialState = {
  selectedPageId: "overview",
  panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true }, ai: { collapsed: false, width: 360 } },
  pages: [
    {
      id: "overview",
      widgets: {
        screened: { type: "value", dataMapping: { value: [{ id: "incidents.incident", aggregation: "count" }] }, format: title("Payments screened") },
        stopped: { type: "value", dataMapping: { value: [{ id: "incidents.stopped", aggregation: "sum" }] }, format: title("Money stopped (USD)") },
        evidence: { type: "value", dataMapping: { value: [{ id: "incidents.evidence", aggregation: "sum" }] }, format: title("Quoted lines of evidence") },
        decided: {
          type: "donut-chart",
          dataMapping: { categoryKey: [{ id: "incidents.decided_by" }], valueKey: [{ id: "incidents.incident", aggregation: "count" }] },
          format: title("Person · who decided"),
        },
        patterns: {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "incidents.pattern" }], valueKey: [{ id: "incidents.incident", aggregation: "count" }] },
          format: title("AI · strongest pattern observed"),
        },
        rules: {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "incidents.policy" }], valueKey: [{ id: "incidents.amount", aggregation: "sum" }] },
          format: title("Rule · outcome, by value (USD)"),
        },
        proof: { type: "proof-chain" },
        list: {
          type: "grid",
          dataMapping: { cols: ["detected", "workflow", "counterparty", "amount", "pattern", "policy", "review", "decided_by", "authorization", "resolution"].map((f) => ({ id: `incidents.${f}` })) },
          format: title("Incidents"),
        },
      },
      widgetLayout: {
        screened: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 5 },
        stopped: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 5 },
        evidence: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 5 },
        decided: { xTrack: 0, yTrack: 5, xSpan: 8, ySpan: 12 },
        patterns: { xTrack: 8, yTrack: 5, xSpan: 8, ySpan: 12 },
        rules: { xTrack: 16, yTrack: 5, xSpan: 8, ySpan: 12 },
        proof: { xTrack: 0, yTrack: 17, xSpan: 24, ySpan: 16 },
        list: { xTrack: 0, yTrack: 33, xSpan: 24, ySpan: 16 },
      },
    },
  ],
} as unknown as AgReportState;

// ---- custom widget: the proof chain of one incident ---------------------------------------------

const CHAIN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

interface ChainEvent {
  seq: number;
  event_type: string;
  at: string;
  hash: string;
}
let rowsForWidget: DeskRow[] = [];

/** AI observation → rule → person → PayPal for one incident, and its hash-chained audit trail verified live. */
function ProofChainWidget(props: AgWidgetParams) {
  const [id, setId] = useState(rowsForWidget.find((r) => r.policy === "Review required")?.id ?? rowsForWidget[0]?.id ?? "");
  const [chain, setChain] = useState<{ valid: boolean; events: ChainEvent[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => props.widgetApi.setDisplayState("displayed"), [props.widgetApi]);
  useEffect(() => {
    if (!id) return;
    setChain(null);
    setErr("");
    api(`/v1/verify/purchases/${id}`).then(setChain, (e) => setErr(errText(e)));
  }, [id]);
  const r = rowsForWidget.find((x) => x.id === id);
  const step = (who: string, what: string, detail: string) => (
    <div style={{ flex: "1 1 160px", border: "1px solid var(--sk-line, #e3dfd5)", borderRadius: 12, padding: 10, minWidth: 0 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.7 }}>{who}</div>
      <div style={{ fontWeight: 600, margin: "2px 0" }}>{what}</div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{detail}</div>
    </div>
  );
  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto", fontSize: 13, display: "grid", gap: 10, alignContent: "start" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>Proof chain</strong>
        <select value={id} onChange={(e) => setId(e.target.value)} aria-label="Incident" style={{ maxWidth: 520, padding: "4px 6px", borderRadius: 8 }}>
          {rowsForWidget.map((x) => (
            <option key={x.id} value={x.id}>
              {x.workflow} · {x.counterparty} · {x.amountCents != null ? `$${(x.amountCents / 100).toFixed(2)}` : "—"} · {x.resolution}
            </option>
          ))}
        </select>
        {chain && <span style={{ fontWeight: 600, color: chain.valid ? "#2e6b3e" : "#a3402e" }}>{chain.valid ? `✓ Audit chain valid (${chain.events.length} events)` : "✗ Audit chain broken"}</span>}
      </div>
      {r && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {step("AI observed", r.pattern === "None found" ? "No pattern" : r.pattern, r.evidenceCount ? `${r.evidenceCount} quoted line${r.evidenceCount === 1 ? "" : "s"} · ${r.evidenceSource.toLowerCase()}` : "Nothing quoted")}
          {step("Rule decided", r.policy, r.policy === "Review required" ? "Held for a person" : r.policy === "Allowed" ? "No pause needed" : "Stopped before money moved")}
          {step("Person decided", r.review, personOf(r, deciderOf))}
          {step("PayPal recorded", `Authorization ${r.authorization.toLowerCase()}`, `Capture ${r.capture.toLowerCase()}`)}
        </div>
      )}
      {err && <span style={{ color: "#a3402e" }}>{err}</span>}
      {chain && (
        <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
          {chain.events.map((e) => (
            <li key={e.seq}>
              <span>{e.event_type}</span> <span style={{ opacity: 0.6, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>#{e.seq} {String(e.hash).slice(7, 19)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const proofChainDefinition = {
  id: "proof-chain",
  label: "Proof chain",
  icon: CHAIN_ICON,
  form: () => [],
  comp: ProofChainWidget,
  defaultSize: { width: 24, height: 16 },
  minSize: { width: 12, height: 10 },
};

// ---- Insights ---------------------------------------------------------------------------------------

export function Insights({ mode, licenseKey }: { mode: "public" | "operator"; licenseKey: string }) {
  const [rows, setRows] = useState<DeskRow[] | null>(null);
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

  const refresh = () => {
    const path = mode === "public" ? "/v1/demo/incidents?limit=300" : "/v1/console/purchases?limit=300&scope=session";
    api<{ purchases: Incident[] }>(path, { console: mode === "operator" }).then(
      (r) => {
        const mapped = r.purchases.map((i) => toRow(i, true, (t) => tacticOf(t).label));
        rowsForWidget = mapped;
        setRows(mapped);
        setLoadedAt(new Date());
      },
      (e) => setErr(errText(e)),
    );
  };
  useEffect(refresh, [mode]);

  const sources = useMemo(() => (rows ? { sources: [{ id: "incidents", data: insightRows(rows, deciderOf), fields: FIELDS }] } : null), [rows]);
  const widgets = useMemo(
    () => (config: any) => createWidgets({ additionalTypes: [proofChainDefinition], menu: [...(config.menu ?? []), { label: "Second Key", widgetIds: ["proof-chain"] }] } as any),
    [],
  );

  if (err) return <p className="small" style={{ color: "var(--brick)" }}>{err}</p>;
  if (!rows || !sources) return <p className="small muted">Loading incidents…</p>;
  return (
    <div className="stack-sm">
      <div className="row between xs muted">
        <span>
          {rows.length} incidents · the same rows as the grid · AG Studio{licenseKey ? "" : " (trial mode, watermark)"} · ask the Second Key agent on the right, or add widgets yourself
        </span>
        <span className="row" style={{ gap: 8 }}>
          {loadedAt && <span>as of {loadedAt.toLocaleTimeString()}</span>}
          <button className="sk-chip" onClick={refresh}>
            Refresh
          </button>
        </span>
      </div>
      <div style={{ height: "calc(100vh - 260px)", minHeight: 720, border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden" }}>
        <AgStudio key={`${loadedAt?.getTime()}-${dark}`} data={sources as any} initialState={initialState} mode="edit" widgets={widgets as any} ai={secondKeyHarness as any} theme={themeFor(dark ? "dark" : "light")} style={{ height: "100%", width: "100%" }} />
      </div>
    </div>
  );
}
