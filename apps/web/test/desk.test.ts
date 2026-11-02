// Protection Desk row model: AI, policy, person and PayPal facts stay separate; views and lenses
// select the right incidents; totals never mix currencies; CSV cells are safe.
import { describe, expect, test } from "vitest";
import { VIEWS, csvSafe, formatTotals, groupBy, toRow as rawToRow, totalsByCurrency, type Incident, insightRows, stoppedCents } from "../lib/desk.ts";
import { tacticOf } from "../lib/sk.ts";

const toRow = (i: Incident, payouts = true) => rawToRow(i, payouts, (t) => tacticOf(t).label);

const base: Incident = {
  id: "pur_1",
  state: "HELD",
  outcome: "HOLD",
  kind: "transfer",
  product: "Transfer to J. Morgan (simulated, platform-held)",
  retailer: "platform-held transfer (sandbox)",
  amount_cents: 180000,
  currency: "USD",
  primary_check: "ai.manipulation",
  decided_by: "engine",
  hold_resolution: null,
  hold_auto_void_at: "2026-10-20T00:00:00Z",
  top_tactic: "secrecy",
  evidence_count: 4,
  has_conversation: true,
  last_event: "purchase.held",
  last_event_at: "2026-10-18T09:00:00Z",
  paypal_authorization_id: "AUTH1",
  payout_status: null,
  created_at: "2026-10-18T09:00:00Z",
  updated_at: "2026-10-18T09:00:00Z",
};
const view = (k: string) => VIEWS.find((v) => v.key === k)!;

describe("toRow", () => {
  test("a held transfer: AI pattern, policy review, person awaiting, PayPal reserved; needs attention", () => {
    expect(toRow(base)).toMatchObject({ workflow: "Transfer", counterparty: "Transfer to J. Morgan", pattern: "Asked to keep it secret", evidenceSource: "Conversation", policy: "Review required", review: "Awaiting", authorization: "Reserved", capture: "None", payout: "n/a", resolution: "Needs attention" });
  });
  test("denied and voided: resolved, authorization voided, nothing captured", () => {
    expect(toRow({ ...base, state: "VOIDED", outcome: "VOID", hold_resolution: "DENIED", decided_by: "shopper:x(link)" })).toMatchObject({ review: "Denied", authorization: "Voided", capture: "None", resolution: "Resolved" });
  });
  test("captured transfer: the payout is its own column (starting, paid, failed, not configured)", () => {
    const cap = { ...base, state: "CAPTURED", outcome: "CAPTURE", hold_resolution: "APPROVED" };
    expect(toRow(cap)).toMatchObject({ capture: "Completed", payout: "Starting", resolution: "In progress" });
    expect(toRow({ ...cap, payout_status: "SUCCESS" })).toMatchObject({ payout: "Paid", resolution: "Resolved" });
    expect(toRow({ ...cap, payout_status: "FAILED" })).toMatchObject({ payout: "Failed", resolution: "Needs attention" });
    expect(toRow(cap, false).payout).toBe("Not configured");
  });
  test("refused by rule never reached PayPal; an order mismatch is cancelled without review", () => {
    expect(toRow({ ...base, state: "REJECTED", outcome: "REJECT", hold_auto_void_at: null })).toMatchObject({ policy: "Refused by rule", authorization: "None", review: "Not needed" });
    expect(toRow({ ...base, kind: "shopping", state: "VOIDED", outcome: "VOID", hold_auto_void_at: null, top_tactic: null, has_conversation: false })).toMatchObject({ policy: "Order mismatch: cancelled", workflow: "Agent purchase", payout: "n/a", pattern: "None found", evidenceSource: "None" });
  });
  test("a pause by the payer's own rule, with nothing shared, says so instead of inventing a pattern", () => {
    expect(toRow({ ...base, top_tactic: null, evidence_count: 0, has_conversation: false, rule_triggered: true })).toMatchObject({ pattern: "Payer's rule (no AI evidence)", evidenceSource: "None", policy: "Review required" });
  });
  test("an agent instruction is evidence from the product page", () => {
    expect(toRow({ ...base, kind: "shopping", has_conversation: false, top_tactic: "instruction_to_agent" }).evidenceSource).toBe("Product page");
  });
});

describe("views", () => {
  const rows = [toRow(base), toRow({ ...base, id: "b", state: "NEEDS_RECONCILE", hold_auto_void_at: null }), toRow({ ...base, id: "c", state: "VOIDED", hold_resolution: "DENIED" })];
  test("needs review, failed/unclear and resolved today select the right incidents", () => {
    expect(rows.filter((r) => view("needs_review").test(r)).map((r) => r.id)).toEqual(["pur_1"]);
    expect(rows.filter((r) => view("failed").test(r)).map((r) => r.id)).toEqual(["b"]);
    expect(rows.filter((r) => view("resolved_today").test(r, new Date("2026-10-18T12:00:00Z"))).map((r) => r.id)).toEqual(["c"]);
    expect(rows.filter((r) => view("attention").test(r)).map((r) => r.id).sort()).toEqual(["b", "pur_1"]);
  });
});

describe("totals and lenses", () => {
  test("never sums across currencies", () => {
    const rows = [toRow(base), toRow({ ...base, id: "e", currency: "EUR", amount_cents: 5000 }), toRow({ ...base, id: "n", amount_cents: null })];
    expect(totalsByCurrency(rows)).toEqual({ USD: 180000, EUR: 5000 });
    expect(formatTotals({ USD: 180000, EUR: 5000 })).toBe("€50.00 · $1,800.00");
  });
  test("group by a lens counts and totals per group", () => {
    const g = groupBy([toRow(base), toRow({ ...base, id: "x" }), toRow({ ...base, id: "y", state: "VOIDED", hold_resolution: "DENIED" })], "resolution");
    expect(g).toEqual([
      { key: "Needs attention", count: 2, totals: { USD: 360000 } },
      { key: "Resolved", count: 1, totals: { USD: 180000 } },
    ]);
  });
});

describe("csvSafe", () => {
  test("neutralises formulas and masks emails", () => {
    expect(csvSafe("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvSafe("paid sb-abcd1234567@personal.example.com")).toBe("paid sb•••@personal.example.com");
    expect(csvSafe(null)).toBe("");
  });
});

describe("Insights rows (AG Studio source)", () => {
  const row = (over: Partial<Incident>) => toRow({ ...base, ...over });
  test("money counts as stopped only when a rule or a person stopped it", () => {
    expect(stoppedCents(row({ state: "REJECTED", outcome: "REJECT", hold_auto_void_at: null, amount_cents: 48000 }))).toBe(48000);
    expect(stoppedCents(row({ state: "VOIDED", outcome: "VOID", hold_auto_void_at: null, amount_cents: 8400 }))).toBe(8400); // order mismatch
    expect(stoppedCents(row({ state: "VOIDED", outcome: "VOID", hold_auto_void_at: "2026-11-05T00:00:00Z", hold_resolution: "DENIED", amount_cents: 180000 }))).toBe(180000);
    expect(stoppedCents(row({ state: "CAPTURED", outcome: "CAPTURE", hold_auto_void_at: null, amount_cents: 8400 }))).toBe(0);
    expect(stoppedCents(row({ state: "HELD", outcome: "HOLD", hold_auto_void_at: "2026-11-05T00:00:00Z", amount_cents: 180000 }))).toBe(0); // still waiting
  });
  test("keeps the four facts separate, labels who decided, and leaves out non-USD rows instead of mixing currencies", () => {
    const rows = insightRows(
      [
        row({ id: "a", state: "VOIDED", outcome: "VOID", hold_auto_void_at: "2026-11-05T00:00:00Z", hold_resolution: "DENIED", decided_by: "guardian:g1", top_tactic: "secrecy", evidence_count: 3, amount_cents: 180000 }),
        row({ id: "b", currency: "EUR", amount_cents: 5000 }),
        row({ id: "c", state: "CAPTURED", outcome: "CAPTURE", hold_auto_void_at: null, hold_resolution: null, decided_by: null, amount_cents: 8400 }),
      ],
      (d) => (d.startsWith("guardian:") ? "Trusted contact" : d),
    );
    expect(rows.map((r) => r.incident)).toEqual(["a", "c"]);
    expect(rows[0]).toMatchObject({ policy: "Review required", review: "Denied", decided_by: "Trusted contact", evidence: 3, amount: 1800, stopped: 1800 });
    expect(rows[1]).toMatchObject({ review: "Not needed", decided_by: "No review needed", stopped: 0 });
    // The engine's own HOLD is a rule outcome, never "who decided".
    expect(insightRows([row({ id: "d", decided_by: "engine" })])[0]).toMatchObject({ review: "Awaiting", decided_by: "Nobody yet" });
  });
});
