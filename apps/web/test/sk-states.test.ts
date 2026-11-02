// The words Second Key shows must match what the backend and PayPal actually confirmed.
import { describe, expect, test } from "vitest";
import { deciderOf, highlight, moneyTruth, payoutTruth, rankEvidence, stageOf, tacticOf } from "../lib/sk.ts";

describe("stageOf", () => {
  test("a decision is never shown as a completed money action", () => {
    expect(stageOf("VOIDING")).toMatchObject({ label: "Cancelling", moving: true });
    expect(stageOf("VOIDING").payer).toMatch(/Cancelling with PayPal/);
    expect(stageOf("CAPTURE_APPROVED")).toMatchObject({ label: "Completing", moving: true });
    expect(stageOf("VOIDED")).toMatchObject({ label: "Cancelled", moving: false });
    expect(stageOf("CAPTURED")).toMatchObject({ label: "Completed", moving: false });
  });
  test("held means reserved, not sent; rejected means PayPal was never asked", () => {
    expect(stageOf("HELD").payer).toMatch(/reserved, not sent/);
    expect(stageOf("REJECTED").payer).toMatch(/never asked/);
  });
  test("unknown states keep polling rather than claiming an outcome", () => {
    expect(stageOf("SOMETHING_NEW").moving).toBe(true);
    expect(stageOf("NEEDS_RECONCILE").moving).toBe(true);
  });
});

describe("moneyTruth: only authorization and capture records count", () => {
  test("order COMPLETED with an uncaptured authorization is 'reserved', not 'complete'", () => {
    const t = moneyTruth({ order: { status: "COMPLETED" }, authorizations: [{ id: "A1", status: "CREATED" }], captures: [] }, "$1,800.00");
    expect(t).toMatchObject({ kind: "reserved", reference: "A1" });
    expect(t.text).not.toMatch(/complete/i);
  });
  test("voided authorization with no capture is 'released'", () => {
    expect(moneyTruth({ authorizations: [{ id: "A1", status: "VOIDED" }], captures: [] }, "$1").kind).toBe("released");
  });
  test("a completed capture is 'captured'; a pending one is not", () => {
    expect(moneyTruth({ authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C1", status: "COMPLETED" }] }, "$1")).toMatchObject({ kind: "captured", reference: "C1" });
    expect(moneyTruth({ authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C1", status: "PENDING" }] }, "$1").kind).toBe("pending");
  });
  test("no read yet is stated as such", () => {
    expect(moneyTruth(null, "$1").kind).toBe("none");
  });
});

describe("copy helpers", () => {
  test("decider labels", () => {
    // ADR-0020: only a guardian credential is a trusted contact's decision. A pre-0020 link was issued to
    // the account holder, so a "(link)" decision is attributed to them, not to a trusted contact.
    expect(deciderOf("guardian:gdn_1")).toMatch(/Trusted contact/);
    expect(deciderOf("payer:shp_1")).toMatch(/payer \(cancelled\)/);
    expect(deciderOf("shopper:shp_1(link)")).toMatch(/Account holder, via one-time link/);
    expect(deciderOf("engine")).toMatch(/automatic/);
  });
  test("unknown tactics degrade to readable words", () => {
    expect(tacticOf("new_tactic").label).toBe("new tactic");
    expect(tacticOf("secrecy").label).toMatch(/secret/);
  });
  test("highlight marks every quote occurrence once, merging overlaps", () => {
    const parts = highlight("Please, I need eighteen hundred dollars for bail right now.", ["for bail right now", "bail right"]);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["for bail right now"]);
    expect(parts.map((p) => p.text).join("")).toBe("Please, I need eighteen hundred dollars for bail right now.");
  });
});

describe("rankEvidence", () => {
  test("strongest patterns first, one per pattern before repeats, nothing dropped", () => {
    const input = [
      { tactic: "impersonation", quote: "a" },
      { tactic: "impersonation", quote: "b" },
      { tactic: "urgency", quote: "c" },
      { tactic: "secrecy", quote: "d" },
      { tactic: "made_up", quote: "e" },
    ];
    const out = rankEvidence(input);
    expect(out.map((e) => e.quote)).toEqual(["d", "c", "a", "e", "b"]);
    expect(out).toHaveLength(input.length);
  });
});

describe("payoutTruth: capture and payout are separate facts", () => {
  const o = { configured: true, payee: "J. Morgan", amount: "$1,800.00" };
  test("not configured is stated, never implied paid", () => {
    expect(payoutTruth({ captures: [{ id: "C", status: "COMPLETED" }] }, { ...o, configured: false })).toMatchObject({ kind: "not_configured", settled: true });
  });
  test("captured but no batch yet is waiting, not paid", () => {
    expect(payoutTruth({ captures: [{ id: "C", status: "COMPLETED" }] }, o)).toMatchObject({ kind: "waiting", settled: false });
  });
  test("only a SUCCESS item is 'paid'", () => {
    const base = { batch_id: "B", item_id: "I", batch_status: "PROCESSING", amount: "1800.00" };
    expect(payoutTruth({ payout: { ...base, item_status: "PENDING" } }, o)).toMatchObject({ kind: "pending", settled: false });
    expect(payoutTruth({ payout: { ...base, item_status: "SUCCESS" } }, o)).toMatchObject({ kind: "paid", reference: "I" });
    expect(payoutTruth({ payout: { ...base, item_status: "UNCLAIMED" } }, o).kind).toBe("unclaimed");
    expect(payoutTruth({ payout: { ...base, item_status: "RETURNED" } }, o)).toMatchObject({ kind: "failed", settled: true });
  });
});
