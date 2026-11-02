// Protection Desk data model: one typed row per incident, with the AI assessment, the deterministic
// policy outcome, the person's decision and the PayPal states kept in separate fields. Pure functions,
// unit-tested; the grid only formats them. PayPal fields here are what the executor RECORDED from
// PayPal's responses; the detail panel re-reads PayPal live.


export interface Incident {
  id: string;
  state: string;
  outcome: string | null;
  kind: "shopping" | "transfer";
  product: string | null;
  retailer: string | null;
  amount_cents: number | null;
  currency: string | null;
  primary_check: string | null;
  decided_by: string | null;
  hold_resolution: string | null;
  hold_auto_void_at: string | null;
  top_tactic: string | null;
  evidence_count: number;
  has_conversation: boolean;
  /** The payer's own review rule paused it (ADR-0019). */
  rule_triggered?: boolean;
  last_event: string | null;
  last_event_at: string | null;
  paypal_authorization_id: string | null;
  payout_status: string | null;
  created_at: string;
  updated_at: string;
}

export type Resolution = "Needs attention" | "In progress" | "Resolved";

export interface DeskRow {
  id: string;
  detectedAt: string; // ISO, UTC
  workflow: "Transfer" | "Agent purchase";
  counterparty: string;
  amountCents: number | null;
  currency: string | null;
  // Assessment (AI)
  pattern: string; // top pattern label or "None found"
  evidenceCount: number;
  evidenceSource: "Conversation" | "Product page" | "None";
  // Policy (deterministic)
  policy: "Review required" | "Refused by rule" | "Order mismatch: cancelled" | "Allowed" | "Screening";
  // Person
  review: "Not needed" | "Awaiting" | "Approved" | "Denied" | "Cancelled by payer" | "Auto-released" | "Intent revoked";
  decidedBy: string | null;
  // PayPal (recorded from PayPal responses)
  authorization: "None" | "Requested" | "Failed" | "Reserved" | "Releasing" | "Voided" | "Captured";
  capture: "None" | "In progress" | "Completed" | "Pending" | "Declined" | "Unclear";
  payout: "n/a" | "Not configured" | "Starting" | "Pending" | "Paid" | "Unclaimed" | "Failed" | "Unclear";
  resolution: Resolution;
  state: string;
  lastEvent: string | null;
  lastEventAt: string | null;
}

const PAYOUT_FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "DENIED", "REVERSED", "REFUNDED"]);
const MOVING = new Set(["SCREENING", "AUTHORIZING", "VERIFYING", "VOIDING", "CAPTURE_APPROVED", "CAPTURING", "CAPTURE_PENDING"]);

/** `label` turns a tactic id into words (lib/sk tacticOf); injected so this module has no imports. */
export function toRow(i: Incident, payoutsConfigured = true, label: (tactic: string) => string = (t) => t): DeskRow {
  const held = i.hold_auto_void_at !== null;
  const policy: DeskRow["policy"] =
    i.state === "SCREENING" ? "Screening" : i.state === "REJECTED" ? "Refused by rule" : held ? "Review required" : i.outcome === "VOID" ? "Order mismatch: cancelled" : "Allowed";
  const review: DeskRow["review"] = !held
    ? "Not needed"
    : i.hold_resolution === "APPROVED"
      ? "Approved"
      : i.hold_resolution === "DENIED"
        ? "Denied"
        : i.hold_resolution === "CANCELLED"
          ? "Cancelled by payer"
        : i.hold_resolution === "TIMEOUT"
          ? "Auto-released"
          : i.hold_resolution === "REVOKED"
            ? "Intent revoked"
            : "Awaiting";
  const authorization: DeskRow["authorization"] = (() => {
    switch (i.state) {
      case "SCREENING":
      case "REJECTED":
        return "None";
      case "AUTHORIZING":
        return "Requested";
      case "AUTH_FAILED":
        return "Failed";
      case "VOIDING":
        return "Releasing";
      case "VOIDED":
        return "Voided";
      case "CAPTURED":
      case "CAPTURE_PENDING":
        return "Captured";
      default:
        return i.paypal_authorization_id ? "Reserved" : "None";
    }
  })();
  const capture: DeskRow["capture"] =
    i.state === "CAPTURED" ? "Completed" : i.state === "CAPTURE_PENDING" ? "Pending" : i.state === "CAPTURE_DECLINED" ? "Declined" : i.state === "CAPTURE_APPROVED" || i.state === "CAPTURING" ? "In progress" : i.state === "NEEDS_RECONCILE" ? "Unclear" : "None";
  const payout: DeskRow["payout"] =
    i.kind !== "transfer"
      ? "n/a"
      : i.payout_status === "SUCCESS"
        ? "Paid"
        : i.payout_status === "UNCLAIMED"
          ? "Unclaimed"
          : i.payout_status && PAYOUT_FAILED.has(i.payout_status)
            ? "Failed"
            : i.payout_status === "UNKNOWN"
              ? "Unclear"
              : i.payout_status
                ? "Pending"
                : i.state === "CAPTURED"
                  ? payoutsConfigured
                    ? "Starting"
                    : "Not configured"
                  : "n/a";
  const attention = ["HELD", "NEEDS_RECONCILE", "AUTH_FAILED", "CAPTURE_DECLINED"].includes(i.state) || payout === "Failed" || payout === "Unclear";
  const resolution: Resolution = attention ? "Needs attention" : MOVING.has(i.state) || payout === "Pending" || payout === "Starting" ? "In progress" : "Resolved";
  return {
    id: i.id,
    detectedAt: i.created_at,
    workflow: i.kind === "transfer" ? "Transfer" : "Agent purchase",
    counterparty: (i.product ?? "—").replace(/ \(simulated, platform-held\)$/, ""),
    amountCents: i.amount_cents,
    currency: i.currency,
    pattern: i.top_tactic ? label(i.top_tactic) : i.rule_triggered ? "Payer's rule (no AI evidence)" : "None found",
    evidenceCount: i.evidence_count,
    evidenceSource: i.has_conversation ? "Conversation" : i.top_tactic === "instruction_to_agent" ? "Product page" : "None",
    policy,
    review,
    decidedBy: i.decided_by,
    authorization,
    capture,
    payout,
    resolution,
    state: i.state,
    lastEvent: i.last_event,
    lastEventAt: i.last_event_at,
  };
}

export type ViewKey = "all" | "needs_review" | "attention" | "failed" | "resolved_today";
export const VIEWS: { key: ViewKey; label: string; test: (r: DeskRow, now?: Date) => boolean }[] = [
  { key: "needs_review", label: "Needs review", test: (r) => r.review === "Awaiting" },
  { key: "attention", label: "Needs attention", test: (r) => r.resolution === "Needs attention" },
  { key: "failed", label: "Payment action failed or unclear", test: (r) => r.authorization === "Failed" || ["Declined", "Unclear"].includes(r.capture) || ["Failed", "Unclear"].includes(r.payout) },
  { key: "resolved_today", label: "Resolved today", test: (r, now = new Date()) => r.resolution === "Resolved" && !!r.lastEventAt && new Date(r.lastEventAt).toDateString() === now.toDateString() },
  { key: "all", label: "All", test: () => true },
];

export type LensKey = "resolution" | "workflow" | "policy" | "pattern";
export const LENSES: { key: LensKey; label: string }[] = [
  { key: "resolution", label: "Status" },
  { key: "workflow", label: "Workflow" },
  { key: "policy", label: "Policy outcome" },
  { key: "pattern", label: "Pattern" },
];

/** Sum per currency, never across currencies. Rows without an amount are counted but not summed. */
export function totalsByCurrency(rows: DeskRow[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of rows) if (r.amountCents != null && r.currency) t[r.currency] = (t[r.currency] ?? 0) + r.amountCents;
  return t;
}

export interface LensGroup {
  key: string;
  count: number;
  totals: Record<string, number>;
}
export function groupBy(rows: DeskRow[], lens: LensKey): LensGroup[] {
  const m = new Map<string, DeskRow[]>();
  for (const r of rows) {
    const k = String(r[lens]);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].map(([key, rs]) => ({ key, count: rs.length, totals: totalsByCurrency(rs) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export const formatTotals = (t: Record<string, number>) =>
  Object.entries(t)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cur, cents]) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100))
    .join(" · ") || "—";

/** CSV cell safety: neutralise spreadsheet formulas and mask any email that slipped into a value. */
export function csvSafe(v: unknown): string {
  const s = v == null ? "" : String(v);
  const masked = s.replace(/([A-Za-z0-9._%+-]{2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1•••@$2");
  return /^[=+\-@\t\r]/.test(masked) ? `'${masked}` : masked;
}

// ---- Insights (AG Studio) ---------------------------------------------------------------------------

/**
 * Who made the PERSON decision. The engine's own decisions are rule outcomes, not a person's, so they never
 * appear here: no review needed, nobody yet, or the person (or the auto-release) that resolved the hold.
 */
export function personOf(r: DeskRow, decider: (d: string) => string = (d) => d): string {
  if (r.review === "Not needed") return "No review needed";
  if (r.review === "Awaiting" || !r.decidedBy || r.decidedBy === "engine") return "Nobody yet";
  return decider(r.decidedBy);
}

/** Money that did not move because Second Key, or the person it asked, stopped it. */
export function stoppedCents(r: DeskRow): number {
  const stopped = r.policy === "Refused by rule" || r.policy === "Order mismatch: cancelled" || ["Denied", "Cancelled by payer", "Auto-released", "Intent revoked"].includes(r.review);
  return stopped ? (r.amountCents ?? 0) : 0;
}

export interface InsightRow {
  incident: string;
  detected: string;
  workflow: DeskRow["workflow"];
  counterparty: string;
  amount: number | null;
  pattern: string;
  evidence: number;
  policy: DeskRow["policy"];
  review: DeskRow["review"];
  decided_by: string;
  authorization: DeskRow["authorization"];
  capture: DeskRow["capture"];
  resolution: Resolution;
  stopped: number;
}

/**
 * One AG Studio row per incident, USD only (the source's money fields are USD; other currencies are left
 * out rather than summed together). The four facts stay separate fields. `decider` labels decided_by.
 */
export function insightRows(rows: DeskRow[], decider: (d: string) => string = (d) => d): InsightRow[] {
  return rows
    .filter((r) => (r.currency ?? "USD") === "USD")
    .map((r) => ({
      incident: r.id,
      detected: r.detectedAt.slice(0, 16).replace("T", " "),
      workflow: r.workflow,
      counterparty: r.counterparty,
      amount: r.amountCents == null ? null : r.amountCents / 100,
      pattern: r.pattern,
      evidence: r.evidenceCount,
      policy: r.policy,
      review: r.review,
      decided_by: personOf(r, decider),
      authorization: r.authorization,
      capture: r.capture,
      resolution: r.resolution,
      stopped: stoppedCents(r) / 100,
    }));
}
