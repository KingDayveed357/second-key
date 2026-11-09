"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ColGroupDef, type GridApi, type RowClickedEvent } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText } from "../../../lib/client";
import { LENSES, VIEWS, csvSafe, formatTotals, groupBy, toRow, totalsByCurrency, type DeskRow, type Incident, type LensKey, type ViewKey } from "../../../lib/desk";
import { deciderOf, rankEvidence, stageOf, tacticOf, usd, when } from "../../../lib/sk";
import { QuoteCard, Transcript, type Conversation, type Evidence } from "../_ui/evidence";
import { Button, Notice, Pill, StatePill } from "../_ui/ui";
import { PayPalCheck } from "../_ui/verify";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid Community (MIT) themed with Second Key tokens; CSS variables keep light/dark in sync.
const theme = themeQuartz.withParams({
  fontFamily: "var(--sans)",
  fontSize: 14,
  foregroundColor: "var(--ink)",
  backgroundColor: "var(--surface)",
  headerBackgroundColor: "var(--surface)",
  headerTextColor: "var(--ink-3)",
  borderColor: "var(--line)",
  rowBorder: { color: "var(--line)" },
  selectedRowBackgroundColor: "var(--brass-soft)",
  rowHoverColor: "var(--surface-2)",
  wrapperBorderRadius: 20,
  accentColor: "var(--brand)",
});

const CHECK_LABELS: Record<string, string> = {
  "ai.manipulation": "Pressure patterns in the conversation",
  "ai.injection": "Instructions aimed at the agent",
  "transfer.amount": "Amount matches what was confirmed",
  "transfer.payee": "Recipient matches what was confirmed",
  "transfer.review_rule": "Payer's own review rule",
  "intent.kind": "Request type matches the intent",
  "intent.not_expired": "Intent still valid",
  "intent.purchases_left": "Uses left on the intent",
  currency: "Currency",
  max_total: "Within budget",
  size: "Size",
  color: "Colour",
  three_way_match: "PayPal order matches what was approved",
};
/** Time for today's incidents, date otherwise: the queue is about what just happened. */
const shortWhen = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const checkLabel = (id: string) => CHECK_LABELS[id] ?? id.replace(/^ai\.(soft|integrity):/, "Listing: ").replace(/[._]/g, " ");

type Mode = "public" | "operator";

/** Inline "evidence peek" rows (AG Grid Community full-width rows) sit right after their incident. */
type DetailRow = { __detail: true; id: string; parent: DeskRow };
type GridRow = DeskRow | DetailRow;
const isDetail = (r: GridRow | undefined): r is DetailRow => Boolean(r && "__detail" in r);

const STATE_TONE: Record<string, "held" | "ok" | "bad" | "neutral" | "pending"> = {
  Awaiting: "held",
  "Review required": "held",
  "Needs attention": "held",
  Reserved: "held",
  Approved: "ok",
  Completed: "ok",
  Paid: "ok",
  Resolved: "neutral",
  Allowed: "ok",
  Denied: "neutral",
  Voided: "neutral",
  "Auto-released": "neutral",
  "Refused by rule": "neutral",
  "Order mismatch: cancelled": "neutral",
  Failed: "bad",
  Declined: "bad",
  Unclear: "bad",
  Releasing: "pending",
  "In progress": "pending",
  Pending: "pending",
  Starting: "pending",
  Requested: "pending",
};
const StateCell = (p: { value: string }) =>
  !p.value || p.value === "None" || p.value === "n/a" || p.value === "Not needed" ? <span className="muted">{p.value === "n/a" ? "—" : p.value}</span> : <Pill tone={STATE_TONE[p.value] ?? "neutral"}>{p.value}</Pill>;

function loadView(): ViewKey {
  try {
    return (localStorage.getItem("sk.desk.view") as ViewKey) || "all";
  } catch {
    return "all";
  }
}

export function Desk({ mode }: { mode: Mode }) {
  const params = useSearchParams();
  const router = useRouter();
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [payoutsConfigured, setPayoutsConfigured] = useState(true);
  const [err, setErr] = useState("");
  const [stale, setStale] = useState(false);
  const [view, setView] = useState<ViewKey>("all");
  const [lens, setLens] = useState<LensKey>("resolution");
  const [lensValue, setLensValue] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [scope, setScope] = useState<"session" | "all">("session");
  const [selected, setSelected] = useState<string | null>(params.get("incident"));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [grid, setGrid] = useState<GridApi<GridRow> | null>(null);
  const [visible, setVisible] = useState<DeskRow[]>([]);
  const lastJson = useRef("");

  useEffect(() => setView(loadView()), []);
  useEffect(() => {
    try {
      localStorage.setItem("sk.desk.view", view);
    } catch {
      /* per-viewer convenience only */
    }
  }, [view]);

  const load = useCallback(async () => {
    try {
      const path = mode === "public" ? "/v1/demo/incidents?limit=300" : `/v1/console/purchases?limit=300&scope=${scope}`;
      const r = await api<{ purchases: Incident[] }>(path, { console: mode === "operator" });
      // Only re-render when something changed, so polling never steals focus or a click in progress.
      const json = JSON.stringify(r.purchases);
      if (json !== lastJson.current) {
        lastJson.current = json;
        setIncidents(r.purchases);
      }
      setErr("");
      setStale(false);
    } catch (e) {
      setErr(errText(e));
      setStale(true);
    }
  }, [mode, scope]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    api<{ name: string; transfer?: { payout_configured: boolean } }[]>("/v1/demo/scenarios").then((l) => setPayoutsConfigured(Boolean(l.find((s) => s.transfer)?.transfer?.payout_configured)), () => {});
  }, []);

  const rows = useMemo(() => (incidents ?? []).map((i) => toRow(i, payoutsConfigured, (t) => tacticOf(t).label)), [incidents, payoutsConfigured]);
  const viewTest = VIEWS.find((v) => v.key === view)!.test;
  const passes = useCallback((r: DeskRow) => viewTest(r) && (lensValue === null || String(r[lens]) === lensValue), [viewTest, lens, lensValue]);
  const rowData = useMemo<GridRow[]>(() => rows.flatMap((r) => (expanded.has(r.id) ? [r, { __detail: true as const, id: `${r.id}:detail`, parent: r }] : [r])), [rows, expanded]);
  const viewCounts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.key, rows.filter((r) => v.test(r)).length])), [rows]);
  const lensGroups = useMemo(() => groupBy(rows.filter((r) => viewTest(r)), lens), [rows, viewTest, lens]);

  // External filter (Community) drives saved views and lens selection; detail rows follow their parent.
  useEffect(() => {
    grid?.onFilterChanged();
  }, [grid, view, lens, lensValue]);
  const lastVisible = useRef("");
  const refreshVisible = useCallback((api: GridApi<GridRow>) => {
    const v: DeskRow[] = [];
    api.forEachNodeAfterFilterAndSort((n) => {
      if (n.data && !isDetail(n.data)) v.push(n.data);
    });
    // Only set state when the visible rows really changed: otherwise model updates and renders loop.
    const sig = JSON.stringify(v);
    if (sig !== lastVisible.current) {
      lastVisible.current = sig;
      setVisible(v);
    }
  }, []);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const select = (id: string) => {
    setSelected(id);
    router.replace(`/desk?incident=${encodeURIComponent(id)}`, { scroll: false });
  };

  const money = (p: { data?: GridRow }) => (p.data && !isDetail(p.data) && p.data.amountCents != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: p.data.currency ?? "USD" }).format(p.data.amountCents / 100) : "");
  const cols = useMemo<(ColDef<GridRow> | ColGroupDef<GridRow>)[]>(
    () => [
      {
        headerName: "Incident",
        children: [
          {
            colId: "expand",
            headerName: "",
            width: 44,
            sortable: false,
            resizable: false,
            pinned: "left",
            cellRenderer: (p: { data?: GridRow }) =>
              p.data && !isDetail(p.data) ? (
                <button className="sk-btn quiet sm" style={{ padding: 0, width: 28, minHeight: 28 }} aria-expanded={expanded.has(p.data.id)} aria-label={`${expanded.has(p.data.id) ? "Hide" : "Show"} evidence for ${p.data.counterparty}`} onClick={(e) => (e.stopPropagation(), toggle((p.data as DeskRow).id))}>
                  {expanded.has(p.data.id) ? "▾" : "▸"}
                </button>
              ) : null,
          },
          { field: "detectedAt", headerName: "Detected", width: 104, sort: "desc", valueFormatter: (p) => (p.value ? shortWhen(p.value) : ""), tooltipValueGetter: (p) => (p.value ? `${new Date(p.value).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}) · stored UTC ${p.value}` : "") },
          { field: "workflow", headerName: "Workflow", width: 120 },
          { field: "counterparty", headerName: "To / item", flex: 1, minWidth: 180, tooltipField: "counterparty" },
          { field: "amountCents", headerName: "Amount", width: 104, type: "rightAligned", valueFormatter: money, comparator: (a, b) => (a ?? 0) - (b ?? 0) },
        ],
      },
      {
        headerName: "Assessment · AI",
        children: [
          { field: "pattern", headerName: "Strongest pattern", width: 190, tooltipValueGetter: (p) => (p.data && !isDetail(p.data) ? `${p.data.evidenceCount} quoted line(s) · source: ${p.data.evidenceSource}` : "") },
          { field: "evidenceCount", headerName: "Quotes", width: 84, type: "rightAligned" },
        ],
      },
      { headerName: "Policy · rules", children: [{ field: "policy", headerName: "Outcome", width: 170, cellRenderer: StateCell }] },
      { headerName: "Person", children: [{ field: "review", headerName: "Review", width: 130, cellRenderer: StateCell, tooltipValueGetter: (p) => (p.data && !isDetail(p.data) && p.data.decidedBy ? deciderOf(p.data.decidedBy) : "") }] },
      {
        headerName: "PayPal · recorded",
        children: [
          { field: "authorization", headerName: "Authorization", width: 132, cellRenderer: StateCell, enableCellChangeFlash: true },
          { field: "capture", headerName: "Capture", width: 116, cellRenderer: StateCell, enableCellChangeFlash: true },
          { field: "payout", headerName: "Payout", width: 124, cellRenderer: StateCell, enableCellChangeFlash: true },
        ],
      },
      { headerName: "Status", children: [{ field: "resolution", headerName: "Resolution", width: 150, cellRenderer: StateCell, enableCellChangeFlash: true, pinned: "right" }] },
    ],
    [expanded],
  );

  const live = useRef({ passes, filterOn: false, selected, select: (_: string) => {} });
  live.current = { passes, filterOn: view !== "all" || lensValue !== null, selected, select };
  const gridProps = useMemo(
    () => ({
      getRowId: (p: { data: GridRow }) => p.data.id,
      isExternalFilterPresent: () => live.current.filterOn,
      doesExternalFilterPass: (n: { data?: GridRow }) => (n.data ? live.current.passes(isDetail(n.data) ? n.data.parent : n.data) : true),
      isFullWidthRow: (p: { rowNode: { data?: GridRow } }) => isDetail(p.rowNode.data),
      getRowHeight: (p: { data?: GridRow }) => (isDetail(p.data) ? 132 : 52),
      postSortRows: (p: { nodes: { data?: GridRow }[] }) => {
        // Keep each evidence peek directly under its incident, whatever the sort.
        const details = new Map(p.nodes.filter((n) => isDetail(n.data)).map((n) => [(n.data as DetailRow).parent.id, n]));
        const ordered = p.nodes.filter((n) => !isDetail(n.data)).flatMap((n) => (details.has(n.data!.id) ? [n, details.get(n.data!.id)!] : [n]));
        p.nodes.splice(0, p.nodes.length, ...ordered);
      },
      rowSelection: { mode: "singleRow" as const, checkboxes: false, enableClickSelection: true, isRowSelectable: (n: { data?: GridRow; rowPinned?: string | null }) => !isDetail(n.data) && n.rowPinned == null },
      onRowClicked: (e: RowClickedEvent<GridRow>) => {
        if (e.data && !isDetail(e.data) && e.rowPinned == null) live.current.select(e.data.id);
      },
      onCellKeyDown: (e: { data?: GridRow; rowPinned?: string | null; event?: Event | null }) => {
        const k = (e.event as KeyboardEvent | undefined)?.key;
        if (e.data && !isDetail(e.data) && e.rowPinned == null && (k === "Enter" || k === " ")) live.current.select(e.data.id);
      },
      onSelectionChanged: (e: { api: GridApi<GridRow> }) => {
        const row = e.api.getSelectedRows()[0];
        if (row && !isDetail(row) && row.id !== live.current.selected) live.current.select(row.id);
      },
    }),
    [],
  );
  const fullWidthRenderer = useCallback((p: { data: DetailRow }) => <EvidencePeek row={p.data.parent} mode={mode} />, [mode]);

  // Narrow screens keep the columns that answer "what, how much, and where does it stand"; the rest stay
  // one tap away in the incident detail. Column visibility follows the viewport, not a fixed breakpoint list.
  useEffect(() => {
    if (!grid) return;
    const narrow = window.matchMedia("(max-width: 760px)");
    const mid = window.matchMedia("(max-width: 1100px)");
    const apply = () => {
      grid.setColumnsVisible(["workflow", "evidenceCount", "payout"], !mid.matches);
      grid.setColumnsVisible(["pattern", "authorization", "capture", "detectedAt"], !narrow.matches);
      grid.setColumnsPinned(["resolution"], narrow.matches ? null : "right");
    };
    apply();
    narrow.addEventListener("change", apply);
    mid.addEventListener("change", apply);
    return () => {
      narrow.removeEventListener("change", apply);
      mid.removeEventListener("change", apply);
    };
  }, [grid]);
  // Below the two-column layout the detail opens under the grid: bring it into view on selection.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && window.matchMedia("(max-width: 1100px)").matches) detailRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [selected]);

  const totals = totalsByCurrency(visible);
  const pinnedBottom = useMemo(() => (visible.length ? [{ id: "__total", counterparty: `Visible: ${visible.length} incident${visible.length === 1 ? "" : "s"}`, amountCents: null, currency: null } as unknown as DeskRow] : []), [visible.length]);

  function exportCsv() {
    grid?.exportDataAsCsv({
      fileName: `second-key-incidents-${new Date().toISOString().slice(0, 10)}.csv`,
      columnKeys: ["detectedAt", "workflow", "counterparty", "amountCents", "pattern", "evidenceCount", "policy", "review", "authorization", "capture", "payout", "resolution"],
      shouldRowBeSkipped: (p) => isDetail(p.node.data),
      processCellCallback: (p) => csvSafe(p.column.getColId() === "amountCents" && p.node?.data && !isDetail(p.node.data) ? (p.node.data.amountCents ?? 0) / 100 : p.value),
    });
  }

  return (
    <div className="stack">
      <div className="row between">
        <div className="row" style={{ gap: 8 }}>
          <span className="small soft">{mode === "public" ? "Your demo session" : "Operator view · all sessions available"}</span>
          {stale && <Pill tone="bad">Showing last known data</Pill>}
          <span className="xs muted">Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {mode === "operator" && (
            <button className="sk-chip" aria-pressed={scope === "all"} onClick={() => setScope(scope === "all" ? "session" : "all")}>
              Include earlier sessions
            </button>
          )}
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!visible.length}>
            Export CSV (redacted)
          </Button>
          {mode === "public" && (
            <a className="small" href="/desk?signin=1">
              Operator sign-in
            </a>
          )}
        </div>
      </div>

      <div className="sk-desk-bar" style={{ alignItems: "flex-end" }}>
        <div className="sk-filters" role="group" aria-label="Saved views">
          {VIEWS.map((v) => (
            <button key={v.key} className="sk-chip" aria-pressed={view === v.key} onClick={() => (setView(v.key), setLensValue(null))}>
              {v.label} <span className="muted">{viewCounts[v.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          placeholder="Quick filter: payee, pattern, state…"
          aria-label="Quick filter"
          style={{ minHeight: 40, minWidth: 260, padding: "0 12px", borderRadius: 999, border: "1px solid var(--line-strong)", font: "inherit", fontSize: "var(--text-sm)", background: "var(--surface)", color: "var(--ink)" }}
        />
      </div>

      {mode === "public" && incidents && rows.length === 0 && <EmptyDesk />}

      <section className="sk-card" style={{ padding: 12 }} aria-label="Group by">
        <div className="row between" style={{ marginBottom: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="xs muted">Group by</span>
            {LENSES.map((l) => (
              <button key={l.key} className="sk-chip" style={{ minHeight: 28 }} aria-pressed={lens === l.key} onClick={() => (setLens(l.key), setLensValue(null))}>
                {l.label}
              </button>
            ))}
          </div>
          <span className="xs muted">Counts and per-currency totals from the incidents in this view</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "stretch" }}>
          {lensGroups.length === 0 && <span className="small soft">No incidents in this view.</span>}
          {lensGroups.map((g) => (
            <button
              key={g.key}
              className="sk-card"
              aria-pressed={lensValue === g.key}
              onClick={() => setLensValue(lensValue === g.key ? null : g.key)}
              style={{ padding: "8px 12px", textAlign: "left", cursor: "pointer", borderColor: lensValue === g.key ? "var(--ink)" : undefined, background: lensValue === g.key ? "var(--surface-2)" : undefined, font: "inherit", color: "inherit" }}
            >
              <div className="xs muted">{g.key}</div>
              <div style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
                {g.count} <span className="xs muted" style={{ fontWeight: 400 }}>· {formatTotals(g.totals)}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {err && (
        <Notice tone="bad" title={incidents ? "Couldn't refresh; showing last known data" : "Couldn't load incidents"} role="alert">
          {err}
        </Notice>
      )}

      <div className={`sk-desk ${selected ? "" : "solo"}`}>
        <div className="queue" aria-label="Incident queue">
          <AgGridReact<GridRow>
            theme={theme}
            rowData={rowData}
            columnDefs={cols}
            getRowId={gridProps.getRowId}
            quickFilterText={quick}
            isExternalFilterPresent={gridProps.isExternalFilterPresent}
            doesExternalFilterPass={gridProps.doesExternalFilterPass}
            isFullWidthRow={gridProps.isFullWidthRow}
            fullWidthCellRenderer={fullWidthRenderer}
            getRowHeight={gridProps.getRowHeight}
            postSortRows={gridProps.postSortRows as never}
            pinnedBottomRowData={pinnedBottom}
            rowSelection={gridProps.rowSelection as never}
            onGridReady={(e) => setGrid(e.api)}
            onModelUpdated={(e) => refreshVisible(e.api)}
            onRowClicked={gridProps.onRowClicked}
            onCellKeyDown={gridProps.onCellKeyDown as never}
            onSelectionChanged={gridProps.onSelectionChanged as never}
            tooltipShowDelay={300}
            overlayNoRowsTemplate={incidents ? "No incidents match. Run a scenario from the payer or agent demo, or clear the filters." : "Loading incidents…"}
          />
          <p className="xs muted" style={{ marginTop: 6 }}>
            Visible totals: {formatTotals(totals)} (per currency, never combined). PayPal columns show what the executor recorded from PayPal&apos;s responses; select an incident to trace it and re-read PayPal live.
          </p>
        </div>
        {selected ? (
          <div className="detail" ref={detailRef}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="xs muted">Incident detail</span>
              <Button variant="quiet" size="sm" onClick={() => (setSelected(null), router.replace("/desk", { scroll: false }))}>
                Close
              </Button>
            </div>
            <IncidentDetail id={selected} key={selected} mode={mode} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The public Desk shows the visitor's own demo session, so a first visit is empty: say how to fill it. */
function EmptyDesk() {
  return (
    <section className="sk-empty" aria-labelledby="desk-empty">
      <div className="stack-sm">
        <span className="sk-section-title">Your demo session has no incidents yet</span>
        <h2 id="desk-empty">Run a scenario, then come back here</h2>
        <p className="small soft">The public Desk shows only the payments made in your own browser session, so nothing here is invented. Each scenario creates a real incident on the PayPal sandbox within a few seconds.</p>
        <div className="row" style={{ marginTop: 8 }}>
          <Link href="/agent" className="sk-btn primary sm">
            Run the agent demo
          </Link>
          <Link href="/pay" className="sk-btn secondary sm">
            Run the payer demo
          </Link>
        </div>
      </div>
      <div className="stack-sm">
        <span className="sk-section-title">Then, for each incident, the Desk shows</span>
        <ol>
          <li>What the AI observed, with the exact quoted words</li>
          <li>What the deterministic rule decided, and why</li>
          <li>Who decided, if a person had to</li>
          <li>What PayPal recorded: authorization, capture, payout, re-read live</li>
          <li>The hash-chained audit trail, verified live</li>
        </ol>
      </div>
    </section>
  );
}

/** Inline evidence peek: the proof chain for one incident, without leaving the queue. */
function EvidencePeek({ row, mode }: { row: DeskRow; mode: Mode }) {
  const [ev, setEv] = useState<EvidenceResp | null>(null);
  useEffect(() => {
    api<EvidenceResp>(`/v1/purchases/${row.id}/evidence`, { console: mode === "operator" }).then(setEv, () => {});
  }, [row.id, mode]);
  const quotes = ev ? rankEvidence(ev.checks.filter((c) => c.phase === "SCREEN" || c.phase === "CONTEXT").flatMap((c) => c.evidence ?? [])) : [];
  const step = (label: string, who: string, value: string) => (
    <div style={{ flex: "1 1 0", minWidth: 0, borderTop: "3px solid var(--line-strong)", paddingTop: 6 }}>
      <div className="xs muted">
        {label} · {who}
      </div>
      <div className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
  return (
    <div style={{ padding: "10px 16px 10px 56px", background: "var(--surface-2)", height: "100%", display: "flex", flexDirection: "column", gap: 8, whiteSpace: "normal" }}>
      <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
        {step("Evidence", "AI, quotes checked by code", quotes[0] ? `“${quotes[0].quote}”` : row.evidenceCount ? "Loading…" : "No quoted evidence")}
        {step("Rule", "policy", row.policy)}
        {step("Decision", "person", row.review === "Not needed" ? "No review needed" : `${row.review}${row.decidedBy ? ` · ${deciderOf(row.decidedBy)}` : ""}`)}
        {step("Money", "PayPal (recorded)", `Auth ${row.authorization.toLowerCase()} · capture ${row.capture.toLowerCase()}${row.payout !== "n/a" ? ` · payout ${row.payout.toLowerCase()}` : ""}`)}
      </div>
      {quotes.length > 1 && <div className="xs muted">+ {quotes.length - 1} more quoted line(s): {[...new Set(quotes.map((q) => tacticOf(q.tactic).label))].join(" · ")}</div>}
    </div>
  );
}

interface EvidenceResp {
  purchase: { id: string; state: string; amount: { value: string; currency_code: string } | null; retailer: string | null; created_at: string; paypal: { order_id: string | null } };
  facts: Record<string, { title: string; description?: string }>;
  intent: { policy: { kind?: string; payee?: { name: string; first_payment: boolean; email?: string }; purpose?: string } } | null;
  payout: { status: string; receiver: string; amount: { value: string }; batch_id: string | null; last_error: string | null; updated_at: string } | null;
  request: { kind: "shopping" | "transfer"; conversation: Conversation | null; conversation_source: "submitted" | "shared_after_pause" | null };
  feedback: { quote: string; note: string; given_by: string; at: string }[];
  checks: { phase: string; check_id: string; kind: string; result: "pass" | "fail" | "unknown"; detail: string; evidence: Evidence[] | null; model: string | null; prompt_version: string | null; at: string }[];
  decisions: { outcome: string; reasons: string[]; decided_by: string; at: string }[];
  paypal_calls: { op: string; status: string; http_status: number | null; debug_id: string | null; at: string }[];
  chain: { valid: boolean; events: { seq: number; event_type: string; at: string; hash: string; payload?: Record<string, unknown> }[] };
}

const EVENT_COPY: Record<string, string> = {
  "purchase.submitted": "Payment request received",
  "purchase.screened": "Screening finished",
  "purchase.rejected": "Refused by policy (PayPal never called)",
  "purchase.authorized": "PayPal authorization created: money reserved",
  "purchase.held": "Paused for a person's review",
  // ADR-0020: the second key. Credentials themselves are never recorded, only that one was issued.
  "notification.queued": "Request queued for the trusted contact",
  "notification.delivered": "Request delivered to the trusted contact's phone",
  "notification.retry_scheduled": "Delivery to the trusted contact failed; retrying",
  "notification.failed": "Delivery to the trusted contact failed",
  "hold.credential_issued": "Trusted contact opened the request (one-time credential issued)",
  "hold.credential_locked": "Too many wrong credentials; request locked",
  "hold.approve_refused": "Approval refused: only the trusted contact can approve",
  "hold.reminder_requested": "Payer asked for a reminder",
  "hold.guardian_reassigned": "Trusted contact for this payment changed",
  "purchase.void_decided": "Decision: don't send",
  "purchase.voided": "PayPal authorization voided",
  "purchase.capture_approved": "Decision: complete the payment",
  "purchase.captured": "PayPal capture completed",
  "purchase.auth_failed": "PayPal couldn't authorize",
  "purchase.capture_declined": "PayPal declined the capture",
  "capture.started": "Capture sent to PayPal",
  "capture.pending": "PayPal reports the capture as pending",
  "capture.retry": "Capture retried with the same request ID",
  "capture.declined": "PayPal declined the capture",
  "capture.refused": "Executor refused to capture (approval missing or expired)",
  "capture.stalled": "Capture stalled; flagged for reconciliation",
  "capture.outcome_unknown": "Capture outcome unclear; reconciling with PayPal",
  "void.retry": "Void retried with the same request ID",
  "void.unconfirmed": "Void not yet confirmed by PayPal",
  "context.shared": "Payer shared the conversation after the pause",
  "context.analysed": "Shared conversation analysed (can only add concerns)",
  "evidence.disputed": "Payer disputed a finding",
  "payout.requested": "Payout to the recipient requested",
  "payout.accepted": "PayPal accepted the payout batch",
  "payout.status": "Payout status changed",
  "payout.succeeded": "PayPal paid the recipient",
  "payout.unclaimed": "Payout unclaimed (recipient has no PayPal account yet)",
  "payout.failed": "Payout didn't go through",
  "payout.outcome_unknown": "Payout outcome unclear; retrying with the same request ID",
};

function IncidentDetail({ id, mode }: { id: string; mode: Mode }) {
  const [ev, setEv] = useState<EvidenceResp | null>(null);
  const [err, setErr] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setEv(await api<EvidenceResp>(`/v1/purchases/${id}/evidence`, { console: mode === "operator" }));
    } catch (e) {
      setErr(errText(e));
    }
  }, [id, mode]);
  useEffect(() => {
    void load();
  }, [load]);
  // Keep following while the payment is still moving.
  useEffect(() => {
    if (!ev || !stageOf(ev.purchase.state).moving) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [ev, load]);

  if (err) return <Notice tone="bad" title="Couldn't load this incident">{err}</Notice>;
  if (!ev) return <div className="sk-card muted">Loading…</div>;

  const p = ev.purchase;
  const amount = p.amount ? usd(p.amount.value) : "—";
  const screen = ev.checks.filter((c) => c.phase === "SCREEN");
  const recheck = ev.checks.filter((c) => c.phase !== "SCREEN");
  const evidence = rankEvidence(ev.checks.filter((c) => c.phase === "SCREEN" || c.phase === "CONTEXT").flatMap((c) => c.evidence ?? []));
  const listing = Object.values(ev.facts ?? {})[0];
  const isTransfer = ev.request.kind === "transfer";

  return (
    <div className="stack">
      <div className="sk-card stack">
        <div className="row between">
          <span className="small soft">{isTransfer ? "Started by the payer" : "Started by Rose's shopping agent"}</span>
          <StatePill state={p.state} />
        </div>
        <div className="row between" style={{ alignItems: "baseline" }}>
          <div className="sk-amount">{amount}</div>
          <span className="xs muted mono">{p.id}</span>
        </div>
        <p className="small soft">
          {isTransfer && ev.intent?.policy.payee
            ? `To ${ev.intent.policy.payee.name}${ev.intent.policy.payee.first_payment ? " (first payment)" : ""} · ${ev.intent.policy.purpose ?? ""}`
            : (Object.values(ev.facts ?? {})[0]?.title ?? "—")}
        </p>
        <p className="xs muted">
          Created {when(p.created_at)} · {p.retailer ?? "—"}
        </p>
      </div>

      <section className="sk-card stack" aria-labelledby="ev-h">
        <div className="row between">
          <h2 id="ev-h" style={{ fontSize: "var(--text-lg)" }}>What was detected, in its source</h2>
          <span className="xs muted">Code confirms each quote appears in the source</span>
        </div>
        {evidence.length === 0 && <p className="small soft">No pressure patterns or agent instructions were found.</p>}
        {evidence.map((e, i) => (
          <QuoteCard key={i} e={e} sourceLabel={e.source === "listing" ? "Product page the agent read" : "Conversation"} active={focus !== null && focus === e.line} onFocus={() => setFocus(e.line ?? null)} />
        ))}
        {ev.feedback.length > 0 && (
          <Notice title="The payer disputes a finding">
            {ev.feedback.map((f, i) => (
              <div key={i} className="small">
                On “{f.quote}”: “{f.note}” <span className="muted">· {when(f.at)}</span>
              </div>
            ))}
          </Notice>
        )}
        {ev.request.kind === "transfer" && !ev.request.conversation && <p className="small soft">No conversation was shared. Any pause comes from the payer&apos;s own rule.</p>}
        {ev.request.conversation_source === "shared_after_pause" && <p className="xs muted">Conversation shared by the payer after the pause; its analysis could only add concerns.</p>}
        {ev.request.conversation && (
          <div className="sk-card tint" style={{ padding: 12 }}>
            <p className="xs muted" style={{ margin: "0 8px 8px" }}>{ev.request.conversation.context}</p>
            <Transcript conv={ev.request.conversation} quotes={evidence.filter((e) => e.source === "conversation").map((e) => e.quote)} focusLine={focus} />
          </div>
        )}
        {!isTransfer && listing?.description && (
          <div className="sk-card tint" style={{ padding: 12 }}>
            <p className="xs muted" style={{ marginBottom: 6 }}>Product page text: {listing.title}</p>
            <Transcript conv={{ context: "", lines: [{ speaker: "Listing", text: listing.description }] }} quotes={evidence.filter((e) => e.source === "listing").map((e) => e.quote)} />
          </div>
        )}
      </section>

      <section className="sk-card stack" aria-labelledby="as-h">
        <h2 id="as-h" style={{ fontSize: "var(--text-lg)" }}>What the checks found</h2>
        <p className="xs muted">Rules decide; AI checks can only pause a payment, never approve or move money.</p>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
          {[...screen, ...recheck].map((c, i) => (
            <li key={i} className="stack-sm" style={{ borderTop: i ? "1px solid var(--line)" : 0, paddingTop: i ? 10 : 0 }}>
              <div className="row between">
                <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{checkLabel(c.check_id)}</span>
                <Pill tone={c.result === "pass" ? "ok" : c.result === "fail" ? "bad" : "held"}>{c.result === "pass" ? "Passed" : c.result === "fail" ? "Failed" : "Needs review"}</Pill>
              </div>
              <span className="xs muted">
                {c.kind === "ai" ? `AI check · ${c.model ?? "model"} · ${c.prompt_version ?? ""}` : "Rule"}
                {c.phase !== "SCREEN" ? ` · ${c.phase.toLowerCase()}` : ""}
                {c.evidence?.length ? ` · ${[...new Set(c.evidence.map((e) => tacticOf(e.tactic).label))].join(", ")}` : ""}
              </span>
              {c.result !== "pass" && !c.evidence?.length && <span className="xs soft">{c.detail}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="sk-card stack" aria-labelledby="dec-h">
        <h2 id="dec-h" style={{ fontSize: "var(--text-lg)" }}>Who decided</h2>
        {ev.decisions.length === 0 && <p className="small soft">No decision recorded yet.</p>}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {ev.decisions.map((d, i) => (
            <li key={i} className="small">
              <strong>{d.outcome}</strong> · {deciderOf(d.decided_by)} · <span className="muted">{when(d.at)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="sk-card stack" aria-labelledby="pp-h">
        <h2 id="pp-h" style={{ fontSize: "var(--text-lg)" }}>What PayPal recorded</h2>
        {p.paypal.order_id ? (
          <PayPalCheck
            path={`/v1/purchases/${p.id}/paypal`}
            amount={amount}
            refreshKey={p.state}
            console={mode === "operator"}
            {...(isTransfer ? { transfer: { payee: ev.intent?.policy.payee?.name ?? "the recipient", configured: Boolean(ev.intent?.policy.payee?.email) } } : {})}
          />
        ) : (
          <p className="small soft">No PayPal order was created: the payment was refused before PayPal was called.</p>
        )}
        {ev.payout && (
          <p className="xs muted">
            Payout record: {ev.payout.status} · {usd(ev.payout.amount.value)} to {ev.payout.receiver}
            {ev.payout.batch_id ? <> · batch <span className="mono">{ev.payout.batch_id}</span></> : null}
            {ev.payout.last_error ? ` · ${ev.payout.last_error}` : ""}
          </p>
        )}
        {ev.paypal_calls.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }} className="xs">
            {ev.paypal_calls.map((c, i) => (
              <li key={i} className="row between">
                <span>
                  <span className="mono">{c.op}</span> · {c.status} {c.http_status ? `(HTTP ${c.http_status})` : ""}
                </span>
                <span className="muted">{c.debug_id ? <span className="mono">{c.debug_id}</span> : null} · {when(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sk-card stack" aria-labelledby="tl-h">
        <div className="row between">
          <h2 id="tl-h" style={{ fontSize: "var(--text-lg)" }}>Audit trail</h2>
          {ev.chain.valid ? <Pill tone="ok">Audit chain verified</Pill> : <Pill tone="bad">Audit chain broken</Pill>}
        </div>
        {ev.chain.events.length === 0 && <p className="small soft">No audit events found for this payment.</p>}
        <ol className="sk-timeline">
          {ev.chain.events.map((e) => {
            const money = ["purchase.authorized", "purchase.voided", "purchase.captured", "capture.started"].includes(e.event_type) || e.event_type.startsWith("payout.");
            const human = ["purchase.held", "purchase.void_decided", "purchase.capture_approved"].includes(e.event_type);
            const by = typeof e.payload?.decided_by === "string" ? deciderOf(e.payload.decided_by) : null;
            return (
              <li key={e.seq} className={money ? "money" : human ? "human" : ""}>
                <span className="t">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span className="dot" aria-hidden />
                <div className="body">
                  <div>{EVENT_COPY[e.event_type] ?? e.event_type}</div>
                  <div className="xs muted">
                    {by ? `${by} · ` : ""}
                    <span className="mono">#{e.seq} · {e.hash.replace(/^sha256:/, "").slice(0, 10)}…</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <Button variant="quiet" size="sm" onClick={load}>
          Refresh
        </Button>
      </section>
    </div>
  );
}
