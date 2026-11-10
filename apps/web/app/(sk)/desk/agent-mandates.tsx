"use client";

// The Desk's AP2 view (10 Nov): one row per mandate verification, on AG Grid. The columns are the
// layers a purchase passes through (signatures, AP2's own constraints, Second Key's facts, the
// ledger, PayPal's order), so an operator sees which party stopped each agent purchase and what
// PayPal recorded. Read-only, like the rest of the Desk.

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ColGroupDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText } from "../../../lib/client";
import { usd } from "../../../lib/sk";
import { Button, Notice, Pill } from "../_ui/ui";
import { ReceiptRow } from "../_ap2/receipt";

ModuleRegistry.registerModules([AllCommunityModule]);

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

type Layer = "pass" | "fail" | "open" | "skip" | "wait";
export interface Ap2Row {
  id: string;
  created_at: string;
  decision: "CONFORMS" | "NONCONFORMING" | "CANNOT_CONFIRM" | "COSIGN_REQUIRED";
  error: string | null;
  kind: "scripted" | "shop" | "api";
  run: string | null;
  product: { id: string; title: string; retailer: string | null; price_cents: number | null; image: string | null; source: string | null } | null;
  sent_to_paypal: { id: string; title: string } | null;
  caught_by: string;
  layers: { signatures: Layer; ap2: Layer; facts: Layer; ledger: Layer; paypal: Layer };
  reasons: string[];
  facts_attestation: string | null;
  receipts: { checkout: string | null; payment: string | null; kid: string | null };
  settlement: { id: string; state: string; paypal_order_id: string; capture_id: string | null; amount_cents: number; diffs: string[] } | null;
}

export const CAUGHT: Record<string, string> = {
  none: "Nothing: bought",
  signatures: "Signatures",
  ap2_constraints: "AP2 constraints",
  secondkey_facts: "Second Key's facts",
  secondkey_ledger: "Second Key's ledger",
  paypal_order: "PayPal's order",
  cannot_confirm: "Couldn't confirm",
  cosign: "Needs a co-signer",
};
const RUN: Record<string, string> = {
  conforms: "It goes right",
  steered: "Agent steered",
  wrong_product: "Wrong colour",
  cart_swap: "Checkout swaps it",
  reused: "Mandate reused",
  reused_first: "First use",
  buy: "Agent buys",
  swap: "Checkout swaps it",
  hide_list: "Agent hides the list",
};
const LAYER: Record<Layer, { text: string; tone: "ok" | "bad" | "held" | "neutral" | "pending" }> = {
  pass: { text: "Passed", tone: "ok" },
  fail: { text: "Stopped it", tone: "bad" },
  open: { text: "Couldn't confirm", tone: "held" },
  skip: { text: "Not reached", tone: "neutral" },
  wait: { text: "In progress", tone: "pending" },
};
const LayerCell = (p: { value?: Layer }) => (p.value ? <Pill tone={LAYER[p.value].tone}>{LAYER[p.value].text}</Pill> : null);
const PAYPAL: Record<string, string> = { CAPTURED: "Captured", VOIDED: "Voided", VOIDING: "Voiding", REFUSED: "Refused", MATCHED: "Capturing", CAPTURING: "Capturing", CAPTURE_DECLINED: "Declined", NEEDS_RECONCILE: "Checking" };

const shortWhen = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** A media query as state; false on the server and before mount. */
function useMedia(q: string) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    setM(mq.matches);
    const on = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/** AP2 alone would have said yes: signatures and AP2's own constraints passed, yet the purchase didn't complete. */
export const ap2AloneWouldAllow = (r: Ap2Row) => r.layers.signatures === "pass" && r.layers.ap2 === "pass" && r.caught_by !== "none";

export function AgentMandates({ mode }: { mode: "public" | "operator" }) {
  const [rows, setRows] = useState<Ap2Row[] | null>(null);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<Ap2Row | null>(null);
  const [quick, setQuick] = useState("");
  const narrow = useMedia("(max-width: 719px)");
  const wide = useMedia("(min-width: 1200px)");

  const load = useCallback(async () => {
    try {
      const path = mode === "public" ? "/v1/demo/ap2/incidents?limit=300" : "/v1/console/ap2?limit=300&scope=session";
      const r = await api<{ verifications: Ap2Row[] }>(path, { console: mode === "operator" });
      setRows((old) => (JSON.stringify(old) === JSON.stringify(r.verifications) ? old : r.verifications));
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }, [mode]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const cols = useMemo<(ColDef<Ap2Row> | ColGroupDef<Ap2Row>)[]>(
    () => [
      {
        headerName: "Agent purchase",
        children: [
          { field: "created_at", headerName: "When", width: 96, sort: "desc", valueFormatter: (p) => (p.value ? shortWhen(p.value) : "") },
          {
            colId: "product",
            headerName: "Product",
            flex: 1,
            minWidth: 240,
            valueGetter: (p) => p.data?.product?.title ?? "(direct API call)",
            cellRenderer: (p: { data?: Ap2Row }) => (
              <span className="row" style={{ gap: 8, alignItems: "center", minWidth: 0 }}>
                {p.data?.product?.image ? <img src={p.data.product.image} alt="" width={28} height={28} style={{ objectFit: "contain", background: "#fff", borderRadius: 6, flex: "none" }} referrerPolicy="no-referrer" /> : null}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.data?.product?.title ?? "(direct API call)"}</span>
              </span>
            ),
            tooltipValueGetter: (p) => (p.data?.product ? `${p.data.product.title}${p.data.product.source ? ` · facts from ${p.data.product.source}` : ""}` : ""),
          },
          { colId: "source", headerName: "Catalog", width: 104, valueGetter: (p) => (p.data?.product?.source === "channel3" ? "Channel3" : p.data?.product?.source === "fixture" ? "Scripted" : "—") },
          { colId: "amount", headerName: "Amount", width: 100, type: "rightAligned", valueGetter: (p) => p.data?.product?.price_cents ?? null, valueFormatter: (p) => (p.value == null ? "" : usd(p.value)) },
          { colId: "run", headerName: "Run", width: 150, valueGetter: (p) => (p.data?.run ? (RUN[p.data.run] ?? p.data.run) : "API") },
        ],
      },
      {
        headerName: "Checked by any AP2 verifier",
        children: [
          { colId: "sig", headerName: "Signatures", width: 124, valueGetter: (p) => p.data?.layers.signatures, cellRenderer: LayerCell },
          { colId: "ap2", headerName: "AP2 constraints", width: 140, valueGetter: (p) => p.data?.layers.ap2, cellRenderer: LayerCell },
        ],
      },
      {
        headerName: "Checked by Second Key",
        children: [
          { colId: "facts", headerName: "Facts", width: 140, valueGetter: (p) => p.data?.layers.facts, cellRenderer: LayerCell },
          { colId: "ledger", headerName: "Ledger", width: 124, valueGetter: (p) => p.data?.layers.ledger, cellRenderer: LayerCell },
        ],
      },
      {
        headerName: "PayPal · recorded",
        children: [
          { colId: "paypal", headerName: "Order check", width: 132, valueGetter: (p) => p.data?.layers.paypal, cellRenderer: LayerCell },
          { colId: "pp_state", headerName: "Money", width: 112, valueGetter: (p) => (p.data?.settlement ? (PAYPAL[p.data.settlement.state] ?? p.data.settlement.state) : "Not sent"), enableCellChangeFlash: true },
        ],
      },
      { headerName: "Outcome", children: [{ colId: "caught", headerName: "Stopped by", width: 170, pinned: wide ? "right" : null, valueGetter: (p) => CAUGHT[p.data?.caught_by ?? ""] ?? p.data?.caught_by }] },
    ],
    [wide],
  );

  const stats = useMemo(() => {
    const all = rows ?? [];
    const by = (k: string) => all.filter((r) => r.caught_by === k).length;
    return {
      total: all.length,
      bought: by("none"),
      ap2Alone: all.filter(ap2AloneWouldAllow).length,
      real: all.filter((r) => r.product?.source === "channel3").length,
      byLayer: ["ap2_constraints", "secondkey_facts", "secondkey_ledger", "paypal_order", "cannot_confirm"].map((k) => ({ k, n: by(k) })).filter((x) => x.n),
    };
  }, [rows]);

  return (
    <div className="stack">
      <div className="sk-stats">
        <div className="sk-card stack-sm">
          <span className="xs muted">Agent purchases verified</span>
          <strong style={{ fontSize: "var(--text-xl)" }}>{stats.total}</strong>
          <span className="xs muted note">{stats.real} on real Channel3 products</span>
        </div>
        <div className="sk-card stack-sm">
          <span className="xs muted">Completed and captured</span>
          <strong style={{ fontSize: "var(--text-xl)" }}>{stats.bought}</strong>
        </div>
        <div className="sk-card stack-sm" style={{ borderColor: "var(--brass)" }}>
          <span className="xs muted">AP2 alone would have said yes</span>
          <strong style={{ fontSize: "var(--text-xl)" }}>{stats.ap2Alone}</strong>
          <span className="xs muted note">signatures and AP2 constraints passed; Second Key or PayPal&apos;s order stopped them</span>
        </div>
        <div className="sk-card stack-sm">
          <span className="xs muted">Stopped by</span>
          <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {stats.byLayer.length ? stats.byLayer.map((x) => <Pill key={x.k} tone="neutral">{`${CAUGHT[x.k]} · ${x.n}`}</Pill>) : <span className="xs muted">nothing yet</span>}
          </span>
        </div>
      </div>

      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <input className="sk-input" style={{ maxWidth: 320 }} placeholder="Filter: product, retailer, layer…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Filter agent purchases" />
        <span className="xs muted">{mode === "public" ? "This demo session's agent purchases. " : ""}Run one from the Agents page; rows appear here within seconds.</span>
      </div>

      {err && (
        <Notice tone="bad" title="Couldn't load agent purchases" role="alert">
          {err}
        </Notice>
      )}

      {narrow ? (
        <ul className="sk-mcards" aria-label="Agent purchases">
          {(rows ?? [])
            .filter((r) => !quick || JSON.stringify([r.product?.title, r.product?.retailer, CAUGHT[r.caught_by], r.run]).toLowerCase().includes(quick.toLowerCase()))
            .map((r) => (
              <li key={r.id}>
                <button type="button" className="sk-mcard" aria-pressed={selected?.id === r.id} onClick={() => setSelected(selected?.id === r.id ? null : r)}>
                  {r.product?.image ? <img src={r.product.image} alt="" referrerPolicy="no-referrer" /> : <span className="ph" />}
                  <span className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.product?.title ?? "(direct API call)"}
                    </span>
                    <span className="xs muted">
                      {[shortWhen(r.created_at), r.product?.price_cents != null ? usd(r.product.price_cents) : null, r.run ? (RUN[r.run] ?? r.run) : null].filter(Boolean).join(" · ")}
                    </span>
                    <span className="row between" style={{ gap: 8 }}>
                      <span className="sk-dots" aria-label={`Signatures ${r.layers.signatures}, AP2 ${r.layers.ap2}, facts ${r.layers.facts}, ledger ${r.layers.ledger}, PayPal ${r.layers.paypal}`}>
                        {(["signatures", "ap2", "facts", "ledger", "paypal"] as const).map((k) => (
                          <i key={k} className={r.layers[k]} />
                        ))}
                      </span>
                      <Pill tone={r.caught_by === "none" ? "ok" : "neutral"}>{CAUGHT[r.caught_by] ?? r.caught_by}</Pill>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          {rows && !rows.length && <li className="small muted">No agent purchases yet. Run one on the Agents page (AP2 section).</li>}
        </ul>
      ) : (
      <div style={{ height: selected ? 360 : 520, border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden" }}>
        <AgGridReact<Ap2Row>
          theme={theme}
          rowData={rows ?? []}
          columnDefs={cols}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => setSelected(e.data ?? null)}
          tooltipShowDelay={300}
          overlayNoRowsTemplate={rows ? "No agent purchases yet. Run one on the Agents page (AP2 section)." : "Loading agent purchases…"}
        />
      </div>
      )}

      {selected && <MandateDetail row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MandateDetail({ row, onClose }: { row: Ap2Row; onClose: () => void }) {
  const layers: { name: string; who: string; layer: Layer }[] = [
    { name: "Signatures", who: "Any AP2 verifier", layer: row.layers.signatures },
    { name: "AP2 constraints", who: "Any AP2 verifier", layer: row.layers.ap2 },
    { name: "Second Key's facts", who: "Second Key", layer: row.layers.facts },
    { name: "Ledger", who: "Second Key", layer: row.layers.ledger },
    { name: "PayPal's order", who: "Second Key + PayPal", layer: row.layers.paypal },
  ];
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [row.id]);
  return (
    <section ref={ref} className="sk-card stack" aria-label="Agent purchase detail">
      <div className="row between" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 12, alignItems: "center", minWidth: 0 }}>
          {row.product?.image && <img src={row.product.image} alt="" width={56} height={56} style={{ objectFit: "contain", background: "#fff", borderRadius: 10 }} referrerPolicy="no-referrer" />}
          <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <strong className="small">{row.product?.title ?? "Direct API verification"}</strong>
            <span className="xs muted">
              {[row.product?.retailer, row.product?.price_cents != null ? usd(row.product.price_cents) : null, row.run ? (RUN[row.run] ?? row.run) : null, new Date(row.created_at).toLocaleString()].filter(Boolean).join(" · ")}
            </span>
          </div>
        </div>
        <Button variant="quiet" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="sk-stage">
        <ol className="sk-ladder" aria-label="Which check stopped it">
          {layers.map((l) => (
            <li key={l.name} className={l.layer}>
              <div className="row between" style={{ gap: 8, alignItems: "baseline" }}>
                <strong className="small">{l.name}</strong>
                <Pill tone={LAYER[l.layer].tone}>{LAYER[l.layer].text}</Pill>
              </div>
              <span className="xs muted">{l.who}</span>
            </li>
          ))}
        </ol>
        <div className="stack-sm">
          <span className="sk-section-title">Why</span>
          {row.reasons.length ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
              {row.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="small soft">Every check passed.</p>
          )}
          {row.sent_to_paypal && (
            <p className="small soft">
              The checkout sent PayPal an order for <strong>{row.sent_to_paypal.title}</strong> instead.
            </p>
          )}
          <span className="sk-section-title" style={{ marginTop: 8 }}>
            PayPal
          </span>
          {row.settlement ? (
            <p className="small mono" style={{ overflowWrap: "anywhere" }}>
              Order {row.settlement.paypal_order_id} · {PAYPAL[row.settlement.state] ?? row.settlement.state}
              {row.settlement.capture_id ? ` · capture ${row.settlement.capture_id}` : ""}
            </p>
          ) : (
            <p className="small soft">Nothing was sent to PayPal.</p>
          )}
        </div>
      </div>
      <div className="stack-sm">
        <span className="sk-section-title">Signed receipts</span>
        {row.receipts.checkout && <ReceiptRow label="Mandate receipt: checkout" jwt={row.receipts.checkout} />}
        {row.receipts.payment && <ReceiptRow label="Mandate receipt: payment" jwt={row.receipts.payment} />}
        {row.facts_attestation && <ReceiptRow label="Facts attestation" jwt={row.facts_attestation} />}
      </div>
    </section>
  );
}
