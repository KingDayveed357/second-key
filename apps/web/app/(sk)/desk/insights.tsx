"use client";

// Protection Desk · Insights (ADR-0022): AG Studio over the same incident rows the grid shows, themed with
// Second Key's tokens, with a custom proof-chain widget and the Studio Agent Framework (a Second Key lead
// and analyst over Studio's built-in agents, on Haiku through this site's server route). Read-only: the
// data is what the Desk already shows, and nothing here can approve, cancel or move money.

import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudio, createWidgets } from "ag-studio-react";
import { AgStudioAiModule, AgStudioLicenseManager, AgStudioModuleRegistry, studioTheme, type AgReportState, type AgWidgetParams } from "ag-studio";
import { secondKeyHarness } from "../../_components/studio-ai";
import { api, errText } from "../../../lib/client";
import { insightRows, personOf, toRow, type DeskRow, type Incident } from "../../../lib/desk";
import { deciderOf, tacticOf } from "../../../lib/sk";
import { CAUGHT, ap2AloneWouldAllow, type Ap2Row } from "./agent-mandates";

AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

// Second Key's tokens (sk.css) as literal values: AG Charts draws on a canvas, which can't read CSS variables.
const TOKENS = {
  light: { paper: "#f7f5f0", surface: "#ffffff", surface2: "#f1eee7", ink: "#16181d", ink3: "#6f7480", line: "#e3dfd5", brand: "#0f3b36" },
  dark: { paper: "#121412", surface: "#1a1d1b", surface2: "#222623", ink: "#eceae4", ink3: "#9b9a93", line: "#2d322f", brand: "#8cc7bb" },
};
// Second Key's palette for charts, in the order series are drawn: brand, moss, brass, brick, ink.
const PALETTE = {
  light: ["#0f3b36", "#b8893a", "#a3402e", "#5d6470", "#3f7a52", "#7c5a96", "#7aa79d", "#d6b77a"],
  dark: ["#8cc7bb", "#d8b56b", "#e08b78", "#9aa4b4", "#86b98f", "#c79bd1", "#5f8f86", "#a8894a"],
};
const themeFor = (mode: "light" | "dark", phone = false) => {
  const t = TOKENS[mode];
  const p = PALETTE[mode];
  const sans = "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  const palette = Object.fromEntries(p.flatMap((c, i) => [[`chartPaletteFills${i + 1}Color`, c], [`chartPaletteStrokes${i + 1}Color`, c]]));
  return studioTheme.withParams({
    fontFamily: sans,
    fontSize: 13,
    backgroundColor: t.surface,
    textColor: t.ink,
    subtleTextColor: t.ink3,
    borderColor: t.line,
    accentColor: t.brand,
    borderRadius: 10,
    menuBackgroundColor: t.surface,
    tooltipBackgroundColor: t.ink,
    tooltipTextColor: t.paper,
    rowHoverColor: t.surface2,
    // Frame, panels and canvas: one quiet surface, the canvas a step darker, cards on top.
    studioWrapperBorder: "none",
    studioWrapperBorderRadius: 0,
    studioWrapperBackgroundColor: t.paper,
    studioWrapperSpacing: 10,
    studioPanelContainerBackgroundColor: t.surface,
    studioPanelContainerBorder: `1px solid ${t.line}`,
    studioPanelContainerBorderRadius: 16,
    studioPanelHeaderFontFamily: sans,
    studioPanelHeaderFontWeight: 650,
    studioPanelDividerColor: t.line,
    studioAiPanelWidth: 340,
    studioCanvasBackgroundColor: t.paper,
    studioCanvasBorder: "none",
    studioCanvasBorderRadius: 16,
    studioCanvasShadow: "none",
    studioCanvasPadding: 4,
    studioCanvasMinWidth: 280,
    studioCanvasFontFamily: sans,
    studioCanvasGridLineColor: t.line,
    // Widgets as cards.
    studioWidgetBackgroundColor: t.surface,
    studioWidgetBorder: `1px solid ${t.line}`,
    studioWidgetBorderRadius: 16,
    studioWidgetPadding: 16,
    studioWidgetTitleFontFamily: sans,
    studioWidgetTitleFontSize: 13,
    studioWidgetTitleFontWeight: 650,
    studioWidgetTitleTextColor: t.ink3,
    studioWidgetSubtitleTextColor: t.ink3,
    studioWidgetCaptionTextColor: t.ink3,
    studioWidgetToolbarBackgroundColor: t.surface,
    studioWidgetToolbarBorder: `1px solid ${t.line}`,
    studioValueWidgetFontSize: phone ? 20 : 30,
    // Charts.
    chartFontFamily: sans,
    chartTextColor: t.ink,
    chartSubtleTextColor: t.ink3,
    chartGridLineColor: t.line,
    chartAxisLineColor: t.line,
    chartAccentColor: t.brand,
    chartTooltipBackgroundColor: t.surface,
    chartTooltipTextColor: t.ink,
    chartTooltipBorderRadius: 10,
    ...palette,
    // Grids inside widgets.
    gridBrowserColorScheme: mode,
    gridAccentColor: t.brand,
    gridCellTextColor: t.ink,
    gridHeaderTextColor: t.ink3,
    gridHeaderBackgroundColor: t.surface,
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

// AP2 agent purchases (10 Nov): one row per mandate verification, the layers as text.
const MANDATE_FIELDS = [
  text("verification", "Verification"),
  text("when", "When (UTC)"),
  text("product", "Product"),
  text("catalog", "Catalog"),
  text("retailer", "Retailer"),
  usdField("amount", "Amount (USD)"),
  text("run", "Run"),
  text("decision", "AP2 decision"),
  text("ap2_layer", "AP2 constraints"),
  text("facts_layer", "Second Key facts"),
  text("paypal_layer", "PayPal order check"),
  text("stopped_by", "Stopped by"),
  int("ap2_alone", "AP2 alone would allow (1 = yes)"),
  usdField("captured", "Captured (USD)"),
];
const LAYER_TEXT: Record<string, string> = { pass: "Passed", fail: "Stopped it", open: "Couldn't confirm", skip: "Not reached", wait: "In progress" };
const mandateRows = (rows: Ap2Row[]) =>
  rows.map((r) => ({
    verification: r.id,
    when: r.created_at,
    product: r.product?.title ?? "(direct API call)",
    catalog: r.product?.source === "channel3" ? "Channel3" : r.product ? "Scripted" : "API",
    retailer: r.product?.retailer ?? "",
    amount: r.product?.price_cents != null ? r.product.price_cents / 100 : 0,
    run: r.run ?? "api",
    decision: r.decision,
    ap2_layer: LAYER_TEXT[r.layers.ap2] ?? r.layers.ap2,
    facts_layer: LAYER_TEXT[r.layers.facts] ?? r.layers.facts,
    paypal_layer: LAYER_TEXT[r.layers.paypal] ?? r.layers.paypal,
    stopped_by: CAUGHT[r.caught_by] ?? r.caught_by,
    ap2_alone: ap2AloneWouldAllow(r) ? 1 : 0,
    captured: r.settlement?.state === "CAPTURED" ? r.settlement.amount_cents / 100 : 0,
  }));

const title = (t: string) => ({ title: { text: t, enabled: true } });
/**
 * One page that reads top to bottom: the headline numbers, then where agents were stopped (the AP2
 * gap) beside who decided paused payments, then the patterns behind them, then the evidence.
 * On narrow screens the AI panel starts collapsed so the dashboard keeps the width.
 */
const initialStateFor = (narrow: boolean, phone = false) =>
  ({
    selectedPageId: "overview",
    panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true }, ai: { collapsed: narrow, width: 340 } },
    pages: [
      {
        id: "overview",
        widgets: {
          screened: { type: "value", dataMapping: { value: [{ id: "incidents.incident", aggregation: "count" }] }, format: title("Payments screened") },
          stopped: { type: "value", dataMapping: { value: [{ id: "incidents.stopped", aggregation: "sum" }] }, format: title("Money stopped") },
          verified: { type: "value", dataMapping: { value: [{ id: "mandates.verification", aggregation: "count" }] }, format: title("Agent purchases") },
          alone: { type: "value", dataMapping: { value: [{ id: "mandates.ap2_alone", aggregation: "sum" }] }, format: title("AP2 alone: allowed") },
          layers: { type: "agent-layers", dataMapping: { layer: [{ id: "mandates.stopped_by" }], count: [{ id: "mandates.verification", aggregation: "count" }] } },
          decided: {
            type: "donut-chart",
            dataMapping: { categoryKey: [{ id: "incidents.decided_by" }], valueKey: [{ id: "incidents.incident", aggregation: "count" }] },
            format: title("Paused payments · who decided"),
          },
          patterns: {
            type: "bar-chart-grouped",
            dataMapping: { categoryKey: [{ id: "incidents.pattern" }], valueKey: [{ id: "incidents.incident", aggregation: "count" }] },
            format: title("AI · pressure patterns observed"),
          },
          catalog: {
            type: "donut-chart",
            dataMapping: { categoryKey: [{ id: "mandates.catalog" }], valueKey: [{ id: "mandates.verification", aggregation: "count" }] },
            format: title("Agent products · Channel3 or scripted"),
          },
          proof: { type: "proof-chain" },
          mlist: {
            type: "grid",
            dataMapping: { cols: ["when", "product", "retailer", "amount", "run", "ap2_layer", "facts_layer", "paypal_layer", "stopped_by"].map((f) => ({ id: `mandates.${f}` })) },
            format: title("Agent purchases"),
          },
          list: {
            type: "grid",
            dataMapping: { cols: ["detected", "workflow", "counterparty", "amount", "pattern", "policy", "review", "decided_by", "authorization", "resolution"].map((f) => ({ id: `incidents.${f}` })) },
            format: title("Payments"),
          },
        },
        widgetLayout: narrow
          ? {
              // Tablets and phones: tiles in one row (two by two on phones), then one widget per row.
              ...(phone
                ? {
                    screened: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 6 },
                    stopped: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 6 },
                    verified: { xTrack: 0, yTrack: 6, xSpan: 12, ySpan: 6 },
                    alone: { xTrack: 12, yTrack: 6, xSpan: 12, ySpan: 6 },
                  }
                : {
                    screened: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 12 },
                    stopped: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 12 },
                    verified: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 12 },
                    alone: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 12 },
                  }),
              layers: { xTrack: 0, yTrack: 12, xSpan: 24, ySpan: 26 },
              decided: { xTrack: 0, yTrack: 38, xSpan: 24, ySpan: 16 },
              patterns: { xTrack: 0, yTrack: 54, xSpan: 24, ySpan: 16 },
              catalog: { xTrack: 0, yTrack: 70, xSpan: 24, ySpan: 14 },
              proof: { xTrack: 0, yTrack: 84, xSpan: 24, ySpan: 30 },
              mlist: { xTrack: 0, yTrack: 114, xSpan: 24, ySpan: 18 },
              list: { xTrack: 0, yTrack: 132, xSpan: 24, ySpan: 18 },
            }
          : {
              screened: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
              stopped: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
              verified: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 7 },
              alone: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 7 },
              layers: { xTrack: 0, yTrack: 7, xSpan: 24, ySpan: 21 },
              decided: { xTrack: 0, yTrack: 28, xSpan: 8, ySpan: 16 },
              patterns: { xTrack: 8, yTrack: 28, xSpan: 8, ySpan: 16 },
              catalog: { xTrack: 16, yTrack: 28, xSpan: 8, ySpan: 16 },
              proof: { xTrack: 0, yTrack: 44, xSpan: 24, ySpan: 20 },
              mlist: { xTrack: 0, yTrack: 64, xSpan: 24, ySpan: 18 },
              list: { xTrack: 0, yTrack: 82, xSpan: 24, ySpan: 18 },
            },
      },
    ],
  }) as unknown as AgReportState;


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
  useEffect(() => {
    props.widgetApi.setDisplayState("displayed");
  }, [props.widgetApi]);
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

// ---- custom widget: where agents were stopped (AP2 layers) ---------------------------------------
//
// Reads Studio's own data engine (widgetApi.getData), so page filters and other widgets' cross
// filters apply; clicking a layer cross-filters the rest of the dashboard to those purchases. The
// stages are the order a purchase passes through. The bracket counts what AP2 alone would have let
// through: purchases that passed signatures and AP2's constraints but were stopped by Second Key or
// by PayPal's order.

const LAYERS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 18 9 5 9-5" opacity=".5"/></svg>';

const STAGES: { value: string; label: string; who: "Any AP2 verifier" | "Second Key" | "PayPal" | "Outcome"; tone: "bad" | "held" | "ok" }[] = [
  { value: "Signatures", label: "Signatures", who: "Any AP2 verifier", tone: "bad" },
  { value: "AP2 constraints", label: "AP2 constraints", who: "Any AP2 verifier", tone: "bad" },
  { value: "Second Key's facts", label: "Facts it fetched and signed", who: "Second Key", tone: "bad" },
  { value: "Second Key's ledger", label: "Ledger (mandate reuse)", who: "Second Key", tone: "bad" },
  { value: "Couldn't confirm", label: "Couldn't confirm", who: "Second Key", tone: "held" },
  { value: "Needs a co-signer", label: "Co-signer", who: "Second Key", tone: "held" },
  { value: "PayPal's order", label: "PayPal's stored order", who: "PayPal", tone: "bad" },
  { value: "Nothing: bought", label: "Bought and captured", who: "Outcome", tone: "ok" },
];
const GAP = new Set(["Second Key's facts", "Second Key's ledger", "Couldn't confirm", "Needs a co-signer", "PayPal's order"]);
const TONE = { bad: "var(--brick, #a3402e)", held: "var(--brass, #b8893a)", ok: "var(--moss, #3f7a52)" };
const GROUP_COLOR: Record<string, string> = { "Any AP2 verifier": "var(--ink-3, #6f7480)", "Second Key": "var(--brass, #b8893a)", PayPal: "var(--brand, #0f3b36)", Outcome: "var(--moss, #3f7a52)" };

let mandatesForWidget: Ap2Row[] = [];

function AgentLayersWidget(props: AgWidgetParams) {
  const p = props as AgWidgetParams & { dataMapping?: Record<string, any[]> };
  const layerField = p.dataMapping?.layer?.[0] ?? (p.config as any)?.dataMapping?.layer?.[0];
  const countField = p.dataMapping?.count?.[0] ?? (p.config as any)?.dataMapping?.count?.[0];
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [engine, setEngine] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  // Stages side by side when the widget is wide; a vertical list when it's narrow (phones, small tiles).
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCompact((e?.contentRect.width ?? 999) < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    const fallback = () => {
      const c: Record<string, number> = {};
      for (const r of mandatesForWidget) {
        const k = CAUGHT[r.caught_by] ?? r.caught_by;
        c[k] = (c[k] ?? 0) + 1;
      }
      return c;
    };
    if (!layerField || !countField) {
      setEngine(false);
      setCounts(fallback());
      props.widgetApi.setDisplayState("displayed");
      return;
    }
    // Studio's data engine: page filters and other widgets' cross filters apply.
    props.widgetApi.getData({ kind: "flat", fields: [layerField, countField] } as any, { queryId: "layers" } as any).then(
      (res: any) => {
        if (!live || res?.replaced) return;
        const c: Record<string, number> = {};
        for (const row of res?.results?.rows ?? []) {
          const vals = Object.values(row) as unknown[];
          const label = vals.find((v) => typeof v === "string") as string | undefined;
          const n = vals.find((v) => typeof v === "number") as number | undefined;
          if (label) c[label] = (c[label] ?? 0) + (n ?? 0);
        }
        setEngine(true);
        setCounts(c);
        props.widgetApi.setDisplayState("displayed");
      },
      () => {
        if (!live) return;
        setEngine(false);
        setCounts(fallback());
        props.widgetApi.setDisplayState("displayed");
      },
    );
    return () => {
      live = false;
    };
  }, [props.widgetApi, layerField, countField, props]);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const gap = counts ? [...GAP].reduce((a, k) => a + (counts[k] ?? 0), 0) : 0;
  const max = counts ? Math.max(1, ...Object.values(counts)) : 1;
  const shown = STAGES.filter((s) => s.value !== "Needs a co-signer" || (counts?.[s.value] ?? 0) > 0);
  const cols = `repeat(${shown.length}, minmax(92px, 1fr))`;
  const groups: { who: string; n: number }[] = [];
  for (const st of shown) {
    const last = groups[groups.length - 1];
    if (last && last.who === st.who) last.n++;
    else groups.push({ who: st.who, n: 1 });
  }

  const pick = (value: string) => {
    if (!engine || !layerField) return;
    const next = picked === value ? null : value;
    setPicked(next);
    try {
      if (next) props.widgetApi.toggleCrossFilter({ type: "value", field: layerField, value: next, group: 0 } as any);
      else props.widgetApi.resetCrossFilter();
    } catch {
      /* cross filtering off for this widget */
    }
  };

  return (
    <div ref={rootRef} style={{ height: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 14, padding: "2px 2px 6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ display: "grid", gap: 2 }}>
          <strong style={{ fontSize: 15, letterSpacing: "-0.01em" }}>Where agents were stopped</strong>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {total} agent purchase{total === 1 ? "" : "s"} under AP2 mandates, by the layer that decided {total === 1 ? "it" : "each"}.{engine ? " Click a layer to filter the dashboard." : ""}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 12, background: "color-mix(in srgb, var(--brass, #b8893a) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--brass, #b8893a) 45%, transparent)" }}>
          <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{gap}</span>
          <span style={{ fontSize: 12, lineHeight: 1.3, maxWidth: 190 }}>passed every AP2 check, then were stopped by Second Key or PayPal&apos;s order</span>
        </div>
      </div>

      {compact ? (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }} aria-label="Layers in the order a purchase passes them">
          {shown.map((s) => {
            const n = counts?.[s.value] ?? 0;
            const active = picked === s.value;
            return (
              <li key={s.value}>
                <button
                  type="button"
                  onClick={() => pick(s.value)}
                  aria-pressed={active}
                  style={{
                    all: "unset",
                    boxSizing: "border-box",
                    width: "100%",
                    cursor: engine ? "pointer" : "default",
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 72px 24px",
                    gap: 8,
                    alignItems: "center",
                    padding: "8px 10px",
                    borderRadius: 10,
                    borderLeft: `3px solid ${GROUP_COLOR[s.who] ?? "var(--line)"}`,
                    border: active ? `1px solid ${TONE[s.tone]}` : undefined,
                    background: GAP.has(s.value) ? "color-mix(in srgb, var(--brass, #b8893a) 8%, transparent)" : "color-mix(in srgb, var(--line, #e3dfd5) 35%, transparent)",
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.65 }}>{s.who}</span>
                    <span style={{ display: "block", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</span>
                  </span>
                  <span style={{ height: 8, borderRadius: 4, background: "var(--line, #e3dfd5)", overflow: "hidden" }} aria-hidden>
                    <span style={{ display: "block", height: "100%", width: `${(n / max) * 100}%`, background: TONE[s.tone] }} />
                  </span>
                  <strong style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{counts ? n : "–"}</strong>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
      <div style={{ flex: "0 0 auto", overflowX: "auto", paddingBottom: 2 }}>
      <div style={{ display: "grid", gridTemplateColumns: cols, columnGap: 6, minWidth: shown.length * 98 }}>
        {groups.map((g) => (
          <div
            key={g.who}
            style={{ gridColumn: `span ${g.n}`, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.75, padding: "0 4px 6px", borderBottom: `2px solid ${GROUP_COLOR[g.who] ?? "var(--line)"}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {g.who}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 6, marginTop: 8, minWidth: shown.length * 98 }} role="list" aria-label="Layers in the order a purchase passes them">
        {shown.map((s) => {
          const n = counts?.[s.value] ?? 0;
          const active = picked === s.value;
          return (
            <button
              key={s.value}
              type="button"
              role="listitem"
              onClick={() => pick(s.value)}
              aria-pressed={active}
              title={`${s.value}: ${n}`}
              style={{
                all: "unset",
                cursor: engine ? "pointer" : "default",
                display: "grid",
                gridTemplateRows: "96px auto auto",
                gap: 6,
                padding: "10px 8px",
                borderRadius: 12,
                border: `1px solid ${active ? TONE[s.tone] : "var(--line, #e3dfd5)"}`,
                background: GAP.has(s.value) ? "color-mix(in srgb, var(--brass, #b8893a) 7%, transparent)" : "transparent",
                minWidth: 0,
              }}
            >
              <span style={{ display: "flex", alignItems: "flex-end", height: 96 }} aria-hidden>
                <span style={{ width: "100%", height: `${Math.max(n ? 8 : 2, (n / max) * 96)}px`, borderRadius: 8, background: n ? TONE[s.tone] : "var(--line, #e3dfd5)", opacity: n ? 0.9 : 1, transition: "height .4s ease" }} />
              </span>
              <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{counts ? n : "–"}</span>
              <span style={{ fontSize: 12, lineHeight: 1.25, minHeight: 30 }}>{s.label}</span>
            </button>
          );
        })}
      </div>
      </div>
      )}

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, opacity: 0.75 }}>
        <span>
          <b style={{ color: TONE.bad }}>■</b> stopped
        </span>
        <span>
          <b style={{ color: TONE.held }}>■</b> not confirmed, not paid
        </span>
        <span>
          <b style={{ color: TONE.ok }}>■</b> captured on PayPal
        </span>
        <span>Shaded: what AP2 alone would have allowed</span>
        {!engine && <span>· showing all agent purchases (filters don&apos;t apply to this widget here)</span>}
      </div>
    </div>
  );
}

const agentLayersDefinition = {
  id: "agent-layers",
  label: "Where agents were stopped",
  icon: LAYERS_ICON,
  dataMapping: {
    layer: { type: "field", supportedRoles: ["category"], requires: { cardinality: "one" }, required: true },
    count: { type: "field", supportedRoles: ["numeric"], requires: { cardinality: "one" }, required: true },
  },
  form: (params: any) => (params?.createDefaults ? params.createDefaults({ dataMappingItems: [{ key: "layer", label: "Layer that decided" }, { key: "count", label: "Purchases" }] }) : []),
  comp: AgentLayersWidget,
  defaultSize: { width: 15, height: 14 },
  minSize: { width: 10, height: 10 },
  ai: { description: "AP2 agent purchases by the layer that decided them (signatures, AP2 constraints, Second Key facts and ledger, PayPal's order, captured), with the count AP2 alone would have allowed." },
};

// ---- Insights ---------------------------------------------------------------------------------------

export function Insights({ mode, licenseKey }: { mode: "public" | "operator"; licenseKey: string }) {
  const [rows, setRows] = useState<DeskRow[] | null>(null);
  const [mandates, setMandates] = useState<Ap2Row[]>([]);
  const [err, setErr] = useState("");
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const nq = window.matchMedia("(max-width: 1099px)");
    setDark(mq.matches);
    setNarrow(nq.matches);
    setPhone(window.matchMedia("(max-width: 640px)").matches);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (licenseKey) AgStudioLicenseManager.setLicenseKey(licenseKey);
  }, [licenseKey]);

  // Both sources load before Studio mounts, so every widget starts on complete data.
  const refresh = () => {
    const path = mode === "public" ? "/v1/demo/incidents?limit=300" : "/v1/console/purchases?limit=300&scope=session";
    const ap2Path = mode === "public" ? "/v1/demo/ap2/incidents?limit=300" : "/v1/console/ap2?limit=300&scope=session";
    Promise.all([
      api<{ purchases: Incident[] }>(path, { console: mode === "operator" }),
      api<{ verifications: Ap2Row[] }>(ap2Path, { console: mode === "operator" }).catch(() => ({ verifications: [] as Ap2Row[] })),
    ]).then(
      ([p, a]) => {
        const mapped = p.purchases.map((i) => toRow(i, true, (t) => tacticOf(t).label));
        rowsForWidget = mapped;
        mandatesForWidget = a.verifications;
        setRows(mapped);
        setMandates(a.verifications);
        setLoadedAt(new Date());
      },
      (e) => setErr(errText(e)),
    );
  };
  useEffect(refresh, [mode]);

  const sources = useMemo(
    () => (rows ? { sources: [{ id: "incidents", data: insightRows(rows, deciderOf), fields: FIELDS }, { id: "mandates", data: mandateRows(mandates), fields: MANDATE_FIELDS }] } : null),
    [rows, mandates],
  );
  const widgets = useMemo(
    () => (config: any) =>
      createWidgets({
        additionalTypes: [agentLayersDefinition, proofChainDefinition],
        menu: [...(config.menu ?? []), { label: "Second Key", widgetIds: ["agent-layers", "proof-chain"] }],
      } as any),
    [],
  );
  const initialState = useMemo(() => initialStateFor(narrow, phone), [narrow, phone]);

  if (err) return <p className="small" style={{ color: "var(--brick)" }}>{err}</p>;
  if (!rows || !sources) return <p className="small muted">Loading Insights…</p>;
  return (
    <div className="stack">
      <div className="row between" style={{ gap: 12, flexWrap: "wrap", alignItems: "end" }}>
        <div className="stack-sm" style={{ gap: 2, maxWidth: 720 }}>
          <span className="small">
            <strong>{rows.length}</strong> payments and <strong>{mandates.length}</strong> agent purchases, live from this demo session.
          </span>
          <span className="xs muted">
            Built on AG Studio{licenseKey ? "" : " (trial mode)"}. Click a layer or a chart to cross-filter; ask the Second Key analyst {narrow ? "(open the AI panel)" : "on the left"}; or add your own widgets. Read-only.
          </span>
        </div>
        <span className="row xs muted" style={{ gap: 8 }}>
          {loadedAt && <span>as of {loadedAt.toLocaleTimeString()}</span>}
          <button className="sk-chip" onClick={refresh}>
            Refresh
          </button>
        </span>
      </div>
      <div className="sk-insights-frame" style={{ height: narrow ? "calc(100vh - 120px)" : "calc(100vh - 140px)", minHeight: narrow ? 560 : 760 }}>
        <AgStudio key={`${loadedAt?.getTime()}-${dark}-${narrow}-${phone}`} data={sources as any} initialState={initialState} mode="edit" {...(phone ? { panels: { edit: { left: ["ai"], right: [] } } } : {})} widgets={widgets as any} ai={secondKeyHarness as any} theme={themeFor(dark ? "dark" : "light", phone)} style={{ height: "100%", width: "100%" }} />
      </div>
    </div>
  );
}
