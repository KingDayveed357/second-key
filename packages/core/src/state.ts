// The purchase state machine (docs/architecture.md §5). The table is the only source of truth:
// a transition that is not listed throws, so an impossible path can't silently happen.

export const STATES = [
  "SCREENING",
  "REJECTED",
  "AUTHORIZING",
  "AUTH_FAILED",
  "VERIFYING",
  "HELD",
  "CAPTURE_APPROVED",
  "CAPTURING",
  "CAPTURE_PENDING",
  "NEEDS_RECONCILE",
  "CAPTURED",
  "CAPTURE_DECLINED",
  "VOIDING",
  "VOIDED",
  "DISPUTED",
  "DISPUTE_RESOLVED",
  "REFUNDED",
] as const;
export type PurchaseState = (typeof STATES)[number];

const T: Record<PurchaseState, readonly PurchaseState[]> = {
  SCREENING: ["REJECTED", "AUTHORIZING"],
  REJECTED: [],
  AUTHORIZING: ["AUTH_FAILED", "VERIFYING"],
  AUTH_FAILED: [],
  VERIFYING: ["HELD", "CAPTURE_APPROVED", "VOIDING"],
  HELD: ["CAPTURE_APPROVED", "VOIDING"],
  CAPTURE_APPROVED: ["CAPTURING", "VOIDING"],
  CAPTURING: ["CAPTURED", "CAPTURE_PENDING", "CAPTURE_DECLINED", "VOIDING", "NEEDS_RECONCILE"],
  CAPTURE_PENDING: ["CAPTURED", "CAPTURE_DECLINED"],
  NEEDS_RECONCILE: ["CAPTURED", "CAPTURE_PENDING", "CAPTURE_DECLINED", "CAPTURING", "VOIDING", "VOIDED"],
  CAPTURED: ["DISPUTED", "REFUNDED"],
  CAPTURE_DECLINED: [],
  VOIDING: ["VOIDED", "NEEDS_RECONCILE"],
  VOIDED: [],
  DISPUTED: ["DISPUTE_RESOLVED"],
  DISPUTE_RESOLVED: ["REFUNDED"],
  REFUNDED: [],
};

export class IllegalTransition extends Error {
  readonly from: PurchaseState;
  readonly to: PurchaseState;
  constructor(from: PurchaseState, to: PurchaseState) {
    super(`illegal purchase transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: PurchaseState, to: PurchaseState): boolean {
  return T[from].includes(to);
}

export function assertTransition(from: PurchaseState, to: PurchaseState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export const isTerminal = (s: PurchaseState) => T[s].length === 0;

/** States in which PayPal may hold funds for this purchase that Second Key must eventually settle. */
export const OPEN_AUTHORIZATION_STATES: readonly PurchaseState[] = [
  "AUTHORIZING",
  "VERIFYING",
  "HELD",
  "CAPTURE_APPROVED",
  "CAPTURING",
  "NEEDS_RECONCILE",
  "VOIDING",
];

export type Outcome = "REJECT" | "HOLD" | "CAPTURE" | "VOID";
