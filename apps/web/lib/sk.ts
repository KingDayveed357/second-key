// Second Key's single source of truth for what a backend state means to a person. Every screen (payer,
// trusted contact, Desk) uses these, so they can't disagree, and no screen claims more than the
// backend or PayPal has confirmed (blueprint §6).

export type Tone = "held" | "ok" | "bad" | "neutral" | "pending";

export interface Stage {
  tone: Tone;
  /** Short status word for pills. */
  label: string;
  /** One sentence for the payer, true for this state. */
  payer: string;
  /** True while the backend is still working; the UI should keep polling. */
  moving: boolean;
}

export function stageOf(state: string | null | undefined): Stage {
  switch (state) {
    case "SCREENING":
    case "AUTHORIZING":
    case "VERIFYING":
      return { tone: "pending", label: "Checking", payer: "Second Key is checking this payment.", moving: true };
    case "HELD":
      return { tone: "held", label: "Paused for review", payer: "The money is reserved, not sent, while someone you trust takes a look.", moving: false };
    case "VOIDING":
      return { tone: "pending", label: "Cancelling", payer: "The decision is recorded. Cancelling with PayPal…", moving: true };
    case "VOIDED":
      return { tone: "neutral", label: "Cancelled", payer: "Cancelled. The reserved money was released.", moving: false };
    case "CAPTURE_APPROVED":
    case "CAPTURING":
    case "CAPTURE_PENDING":
      return { tone: "pending", label: "Completing", payer: "Approved. Completing the payment with PayPal…", moving: true };
    case "CAPTURED":
      return { tone: "ok", label: "Completed", payer: "The payment was completed.", moving: false };
    case "REJECTED":
      return { tone: "neutral", label: "Not sent", payer: "This payment didn't match what you set up, so it wasn't sent. PayPal was never asked.", moving: false };
    case "AUTH_FAILED":
      return { tone: "bad", label: "Couldn't reserve", payer: "PayPal couldn't reserve the money, so nothing was sent.", moving: false };
    case "CAPTURE_DECLINED":
      return { tone: "bad", label: "Declined", payer: "PayPal declined to complete the payment. Nothing was taken.", moving: false };
    case "NEEDS_RECONCILE":
      return { tone: "pending", label: "Confirming", payer: "We're confirming the result with PayPal. This can take a minute.", moving: true };
    default:
      return { tone: "pending", label: state ?? "Unknown", payer: "Waiting for the latest status.", moving: true };
  }
}

/** PayPal's own record, as returned by /paypal (Desk, payer) or /holds/:id/verification (reviewer). */
export interface PayPalRead {
  fetched_at?: string;
  debug_id?: string | null;
  order?: { status?: string } | null;
  order_status?: string | null;
  authorizations?: { id: string; status: string; amount?: { value?: string }; value?: string }[];
  captures?: { id: string; status: string; amount?: { value?: string }; value?: string }[];
  /** Second Key recipient payout, read live from PayPal (null until a batch exists). */
  payout?: { batch_id: string; item_id: string | null; item_status: string | null; batch_status: string | null; amount: string | null; error?: string } | null;
}

export interface PayoutTruth {
  kind: "not_configured" | "waiting" | "pending" | "paid" | "unclaimed" | "failed";
  text: string;
  reference: string | null;
  settled: boolean;
}

const PAYOUT_FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "DENIED", "REVERSED", "REFUNDED"]);

/**
 * What PayPal says about paying the recipient, after the capture. Separate from the capture on
 * purpose: a completed capture means PayPal took the money; only a SUCCESS payout item means the
 * recipient received it.
 */
export function payoutTruth(read: PayPalRead | null | undefined, o: { configured: boolean; payee: string; amount: string }): PayoutTruth {
  if (!o.configured) return { kind: "not_configured", text: `Paying ${o.payee} isn't set up in this deployment, so the captured money stays with the Second Key demo merchant.`, reference: null, settled: true };
  const p = read?.payout;
  if (!p) return { kind: "waiting", text: `Paying ${o.payee}: asking PayPal to send ${o.amount}…`, reference: null, settled: false };
  const s = p.item_status;
  const ref = p.item_id ?? p.batch_id;
  if (s === "SUCCESS") return { kind: "paid", text: `PayPal shows ${o.amount} paid out to ${o.payee}.`, reference: ref, settled: true };
  if (s === "UNCLAIMED") return { kind: "unclaimed", text: `Sent to ${o.payee}, whose email has no PayPal account yet. PayPal returns it if it isn't claimed within 30 days.`, reference: ref, settled: true };
  if (s && PAYOUT_FAILED.has(s)) return { kind: "failed", text: `The payout to ${o.payee} didn't go through (PayPal: ${s.toLowerCase()}). The captured money remains with the Second Key demo merchant.`, reference: ref, settled: true };
  return { kind: "pending", text: `Paying ${o.payee}: PayPal shows the payout as ${(s ?? p.batch_status ?? "pending").toLowerCase()}.`, reference: ref, settled: false };
}

export interface MoneyTruth {
  kind: "reserved" | "released" | "captured" | "pending" | "none";
  /** Plain sentence, only what PayPal's record supports. */
  text: string;
  /** The PayPal reference a reviewer can quote. */
  reference: string | null;
}

/**
 * What PayPal says happened to the money. Deliberately ignores the order status (PayPal reports an
 * order COMPLETED while the authorization is only CREATED): only authorization and capture records count.
 */
export function moneyTruth(read: PayPalRead | null | undefined, amount: string): MoneyTruth {
  if (!read) return { kind: "none", text: "Not checked with PayPal yet.", reference: null };
  const auth = read.authorizations?.[0];
  const caps = read.captures ?? [];
  const completed = caps.filter((c) => c.status === "COMPLETED");
  if (completed.length) return { kind: "captured", text: `PayPal shows ${amount} captured: the payment is complete.`, reference: completed[0]!.id };
  if (caps.some((c) => c.status === "PENDING")) return { kind: "pending", text: "PayPal shows the capture as pending.", reference: caps[0]!.id };
  if (auth?.status === "VOIDED") return { kind: "released", text: `PayPal shows the authorization voided: nothing was taken.`, reference: auth.id };
  if (auth?.status === "CREATED") return { kind: "reserved", text: `PayPal shows ${amount} reserved, nothing taken yet.`, reference: auth.id };
  if (auth) return { kind: "pending", text: `PayPal shows the authorization as ${auth.status.toLowerCase()}.`, reference: auth.id };
  return { kind: "none", text: "PayPal has no authorization for this payment.", reference: null };
}

/** Plain-language explanation of each pattern. Patterns, never verdicts. */
export const TACTICS: Record<string, { label: string; plain: string }> = {
  urgency: { label: "Pressure to act right now", plain: "Real emergencies can almost always wait for one call to check." },
  secrecy: { label: "Asked to keep it secret", plain: "Being told not to tell family is one of the most common signs of a scam." },
  impersonation: { label: "Identity can't be confirmed", plain: "Voices and names can be faked or misheard. Calling back on a number you already have settles it." },
  authority_pressure: { label: "Police, court or official trouble", plain: "Claims of arrest or official action are often used to rush a payment." },
  emotional_manipulation: { label: "Strong emotional pressure", plain: "Fear and guilt make it hard to stop and check." },
  unusual_payment_channel: { label: "An unusual way to pay", plain: "Gift cards, crypto or wire transfers to strangers are hard to get back." },
  safe_account: { label: "Told to move money to a “safe” account", plain: "Banks never ask you to move money to protect it." },
  too_good_to_be_true: { label: "An offer that sounds too good", plain: "Guaranteed returns and prizes that cost money to claim are classic lures." },
  remote_access: { label: "Asked for access to a device", plain: "Installing software or sharing a screen gives a stranger control." },
  threat: { label: "A threat if you don't pay", plain: "Threats are meant to stop you from checking." },
  instruction_to_agent: { label: "Text giving orders to the AI agent", plain: "Product pages shouldn't instruct shopping agents. This text tried to change what the agent buys." },
  payment_instruction_change: { label: "Asked to pay somewhere new", plain: "A change of account or recipient by message is the most common way invoice payments are stolen. Confirm it on a number you already had." },
  instruction_to_ai: { label: "Text giving orders to an AI", plain: "A message shouldn't instruct the system checking it. This text tried to change the outcome." },
};
export const tacticOf = (t: string) => TACTICS[t] ?? { label: t.replace(/_/g, " "), plain: "" };

const PRIORITY = ["payment_instruction_change", "secrecy", "urgency", "threat", "safe_account", "remote_access", "unusual_payment_channel", "instruction_to_agent", "instruction_to_ai", "authority_pressure", "impersonation", "emotional_manipulation", "too_good_to_be_true"];

/** Strongest signals first, and one card per pattern before any repeats. */
export function rankEvidence<T extends { tactic: string }>(items: T[]): T[] {
  const rank = (t: string) => {
    const i = PRIORITY.indexOf(t);
    return i < 0 ? PRIORITY.length : i;
  };
  const sorted = [...items].sort((a, b) => rank(a.tactic) - rank(b.tactic));
  const seen = new Set<string>();
  const first: T[] = [];
  const repeats: T[] = [];
  for (const e of sorted) {
    if (seen.has(e.tactic)) repeats.push(e);
    else {
      seen.add(e.tactic);
      first.push(e);
    }
  }
  return [...first, ...repeats];
}

/** Who made a recorded decision, in words. */
export function deciderOf(decidedBy: string | null | undefined): string {
  if (!decidedBy) return "—";
  if (decidedBy === "engine") return "Second Key (automatic screening)";
  // ADR-0020: decisions name who made them. A guardian decides with a credential sent to their own channel.
  if (decidedBy.startsWith("guardian:")) return "Trusted contact (second key)";
  if (decidedBy.startsWith("payer:")) return "The payer (cancelled)";
  if (decidedBy.endsWith("(link)")) return "Account holder, via one-time link";
  if (decidedBy.startsWith("shopper:")) return "Account holder (signed in)";
  if (decidedBy === "admin") return "Administrator";
  if (decidedBy.startsWith("executor")) return "Payment executor";
  return decidedBy;
}

/** Split text into plain and highlighted parts for the quotes found in it (case-insensitive). */
export function highlight(text: string, quotes: string[]): { text: string; mark: boolean }[] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const q of quotes) {
    const needle = q.trim().toLowerCase();
    if (needle.length < 3) continue;
    const at = lower.indexOf(needle);
    if (at >= 0) ranges.push([at, at + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out: { text: string; mark: boolean }[] = [];
  let i = 0;
  for (const [a, b] of merged) {
    if (a > i) out.push({ text: text.slice(i, a), mark: false });
    out.push({ text: text.slice(a, b), mark: true });
    i = b;
  }
  if (i < text.length) out.push({ text: text.slice(i), mark: false });
  return out;
}

export const usd = (value: string | number | null | undefined) => {
  if (value == null || value === "") return "—";
  const n = typeof value === "number" ? value / 100 : Number(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
};

export const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
