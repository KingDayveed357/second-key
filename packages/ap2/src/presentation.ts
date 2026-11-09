// One verification of a presented checkout chain (and optionally the payment chain that pays for
// it): chain and mandate checks, every constraint of every open mandate, and the ledger, all
// decided together. Outcomes and receipt errors follow docs/ap2/agent_authorization.md:
//   invalid_credential     the chain itself does not verify (terminal)
//   invalid_mandate        it verifies but does not authorize this action (terminal)
//   unresolved_constraint  a constraint can't be evaluated here (may fall back to the human)
// COSIGN_REQUIRED is CANNOT_CONFIRM where the only open question is a co-signature the mandate
// asks for (x-secondkey.cosign.1): the same request, re-sent with that signature, can conform.

import { evaluateCheckoutConstraints, evaluatePaymentConstraints, type ConstraintResult, type LedgerUsage } from "./constraints.ts";
import type { Ledger, LedgerRecord } from "./ledger.ts";
import { crossCheck, verifyMandate, type Finding, type MandateVerification, type VerifyMandateOptions } from "./mandates.ts";
import { checkCosignatures, type AttestedProduct } from "./extensions.ts";
import { isObject, type JsonObject } from "./sdjwt.ts";

export type Decision = "CONFORMS" | "NONCONFORMING" | "CANNOT_CONFIRM" | "COSIGN_REQUIRED";
export type ReceiptError = "invalid_credential" | "invalid_mandate" | "unresolved_constraint";

export interface PresentationInput {
  checkout: { chain: string; options: VerifyMandateOptions };
  payment?: { chain: string; options: VerifyMandateOptions };
  /** Unix seconds; also passed to chain time checks unless the options set their own. */
  now: number;
  /** Product facts Second Key attested, by product id, for x-secondkey.item_attributes.1. */
  facts?: Record<string, AttestedProduct>;
  /** Co-signatures (compact JWS) presented with the payment, for x-secondkey.cosign.1. */
  cosignatures?: string[];
}

export interface LedgerEntry {
  /** Issuer-JWT hash of the open mandate. */
  ref: string;
  kind: "open_checkout" | "open_payment";
  usesBefore: number;
  /** Present when the open mandate carries payment.budget. */
  budgetRemainingMinor?: number;
}

export interface PresentationVerification {
  decision: Decision;
  error?: ReceiptError;
  findings: Finding[];
  constraints: ConstraintResult[];
  checkout: MandateVerification;
  payment?: MandateVerification;
  ledger: LedgerEntry[];
  /** With COSIGN_REQUIRED: what the co-signer must sign (the closed payment mandate's reference). */
  cosign?: { reference: string };
}

/** The chain-level failures: nothing in the mandates can be trusted. */
const CREDENTIAL_FAILURE = (v: MandateVerification) => v.hops.length === 0;

const constraintsOf = (m: JsonObject) => (Array.isArray(m.constraints) ? m.constraints.filter(isObject) : []);

export async function verifyPresentation(input: PresentationInput, ledger: Ledger): Promise<PresentationVerification> {
  const at = (o: VerifyMandateOptions) => ({ now: input.now, ...o });
  const checkout = await verifyMandate(input.checkout.chain, at(input.checkout.options));
  const payment = input.payment ? await verifyMandate(input.payment.chain, at(input.payment.options)) : undefined;
  const base = { checkout, ...(payment ? { payment } : {}) };

  const chainFindings = [...checkout.findings, ...(payment?.findings ?? [])];
  if (CREDENTIAL_FAILURE(checkout) || (payment && CREDENTIAL_FAILURE(payment)))
    return { decision: "NONCONFORMING", error: "invalid_credential", findings: chainFindings, constraints: [], ledger: [], ...base };

  const findings = [...chainFindings, ...(payment ? crossCheck(payment, checkout) : [])];
  if (!payment && checkout.mandates.some((m) => m.kind === "open_payment"))
    findings.push({ code: "chain_shape", message: "a payment mandate was presented as the checkout chain" });

  // Ledger keys: every open mandate in either chain, and the closed mandate ending each chain.
  const opens = [
    ...checkout.mandates.filter((m) => m.kind === "open_checkout").map((m) => ({ m, ref: checkout.hopIssuerHashes[m.hop]! })),
    ...(payment?.mandates.filter((m) => m.kind === "open_payment").map((m) => ({ m, ref: payment.hopIssuerHashes[m.hop]! })) ?? []),
  ];
  const closedRefs = [checkout, ...(payment ? [payment] : [])].map((v) => v.hopIssuerHashes[v.hopIssuerHashes.length - 1]!);
  const closedPayment = payment?.mandates.find((m) => m.kind === "payment")?.value;
  // The canonical schema makes every Open Payment Mandate name one Open Checkout Mandate
  // (payment.reference). A recurring one therefore closes that open checkout once per occurrence,
  // so the open checkout is reusable exactly when a recurring payment mandate referencing it comes along.
  const recurringPayment = payment?.mandates.find(
    (m) =>
      m.kind === "open_payment" &&
      constraintsOf(m.value).some((c) => c.type === "payment.agent_recurrence") &&
      constraintsOf(m.value).some((c) => c.type === "payment.reference" && checkout.hopReferences.includes(c.conditional_transaction_id as string)),
  );
  const amount = isObject(closedPayment?.payment_amount) ? closedPayment.payment_amount : undefined;
  const closedPaymentRef = payment ? payment.hopIssuerHashes[payment.hopIssuerHashes.length - 1]! : undefined;
  const cosignatures = payment ? await checkCosignatures(input.cosignatures ?? [], opens.filter((o) => o.m.kind === "open_payment").map((o) => o.m.value), input.now) : [];

  return ledger.transact({ open: opens.map((o) => o.ref), closed: closedRefs }, async ({ usage, closedSeen }) => {
    const ledgerFindings: Finding[] = [];
    if (closedSeen.size) ledgerFindings.push({ code: "ledger.closed_mandate_reused", message: "this closed mandate was already presented" });

    const constraints: ConstraintResult[] = [];
    const entries: LedgerEntry[] = [];
    for (const { m, ref } of opens) {
      const u: LedgerUsage = usage.get(ref) ?? { uses: 0, totalMinor: 0 };
      // Single-use, unless recurrence governs it: its own (payment) or a referencing payment's (checkout).
      const recurring = m.kind === "open_payment" ? constraintsOf(m.value).some((c) => c.type === "payment.agent_recurrence") : !!recurringPayment;
      if (u.uses > 0 && !recurring)
        ledgerFindings.push({ code: "ledger.open_mandate_reused", message: `this ${m.kind.replace("_", " ")} mandate was already used`, hop: m.hop });

      if (m.kind === "open_checkout") {
        if (checkout.checkout) constraints.push(...evaluateCheckoutConstraints(m.value, { checkout: checkout.checkout.payload, ...(input.facts ? { facts: input.facts } : {}) }, m.hop));
        else for (const c of constraintsOf(m.value)) constraints.push({ type: String(c.type), result: "unresolved", detail: "no verified checkout to evaluate against", hop: m.hop });
      } else if (closedPayment) {
        constraints.push(...evaluatePaymentConstraints(m.value, { closed: closedPayment, checkoutReferences: checkout.hopReferences, usage: u, now: input.now, cosignatures, ...(closedPaymentRef ? { closedReference: closedPaymentRef } : {}) }, m.hop));
      }

      const entry: LedgerEntry = { ref, kind: m.kind as LedgerEntry["kind"], usesBefore: u.uses };
      const b = constraintsOf(m.value).find((c) => c.type === "payment.budget");
      if (b && typeof b.max === "number") entry.budgetRemainingMinor = Math.round(b.max * 100) - u.totalMinor;
      entries.push(entry);
    }

    const all = [...findings, ...ledgerFindings];
    const open = constraints.filter((c) => c.result === "unresolved");
    const decision: Decision =
      all.length || constraints.some((c) => c.result === "fail") ? "NONCONFORMING" : !open.length ? "CONFORMS" : open.every((c) => c.needs === "cosign") ? "COSIGN_REQUIRED" : "CANNOT_CONFIRM";
    const value: PresentationVerification = {
      decision,
      ...(decision === "NONCONFORMING" ? { error: "invalid_mandate" as const } : decision === "CONFORMS" ? {} : { error: "unresolved_constraint" as const }),
      findings: all,
      constraints,
      ledger: entries,
      ...(decision === "COSIGN_REQUIRED" && closedPaymentRef ? { cosign: { reference: closedPaymentRef } } : {}),
      ...base,
    };
    if (decision !== "CONFORMS") return { value };

    const record: LedgerRecord = {
      closed: closedRefs,
      opens: opens.map(({ m, ref }) =>
        m.kind === "open_payment" && amount && typeof amount.amount === "number" ? { ref, amountMinor: amount.amount, currency: String(amount.currency) } : { ref },
      ),
      at: input.now,
    };
    for (const e of entries) if (e.budgetRemainingMinor !== undefined && amount && typeof amount.amount === "number") e.budgetRemainingMinor -= amount.amount;
    return { value, record };
  });
}
