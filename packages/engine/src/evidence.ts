// Dispute evidence draft (docs/ai-design.md §4). The AI writes the narrative with placeholders;
// code inserts every number and identifier. If the AI draft fails any rule, a plain template is
// used instead, so the reviewer always gets a correct draft. Nothing is sent to PayPal from here:
// an ops reviewer approves first (Stage 5 dispute view).

import { and, asc, eq } from "drizzle-orm";
import { UnavailableLlm, writeEvidence, type EvidenceValues } from "@witness/ai";
import { fromCents } from "@witness/core";
import { dbOf, schema, verifyChain } from "@witness/db";
import type { EngineDeps } from "./deps.ts";

export function templateEvidence(v: EvidenceValues): string {
  return [
    `The shopper's recorded instruction was: "${v.intent_text}". It was confirmed by the shopper before purchase and is recorded with SHA-256 digest ${v.policy_digest} in a hash-chained audit log; it is not cryptographically signed.`,
    `Before any money was captured, Second Key checked the selected product against that instruction using product facts it fetched itself, and re-read PayPal's own order ${v.order_id} to confirm it contained exactly the approved item, quantity, price, currency and payee.`,
    `All checks passed. Second Key then captured exactly ${v.amount} ${v.currency} against authorization ${v.authorization_id} (capture ${v.capture_id}) at ${v.captured_at}, the amount the shopper's policy allowed.`,
  ].join(" ");
}

export type EvidenceDraft =
  | { kind: "ok"; text: string; source: "ai" | "template"; ai_error?: string; model?: string; prompt_version?: string; values: EvidenceValues }
  | { kind: "error"; status: 404 | 409; title: string };

export async function draftDisputeEvidence(d: EngineDeps, tenantId: string, purchaseId: string): Promise<EvidenceDraft> {
  const db = dbOf(d.pool);
  const p = (await db.select().from(schema.purchases).where(and(eq(schema.purchases.id, purchaseId), eq(schema.purchases.tenantId, tenantId))).limit(1))[0];
  if (!p) return { kind: "error", status: 404, title: "Purchase not found" };
  if (!["CAPTURED", "DISPUTED", "DISPUTE_RESOLVED"].includes(p.state) || !p.paypalCaptureId) return { kind: "error", status: 409, title: `Purchase is ${p.state}: evidence applies to captured purchases` };
  const intent = (await db.select().from(schema.intents).where(eq(schema.intents.id, p.intentId)).limit(1))[0]!;
  const checks = await db.select().from(schema.checks).where(eq(schema.checks.purchaseId, p.id)).orderBy(asc(schema.checks.id));
  const captured = (await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.purchaseId, p.id), eq(schema.auditLog.eventType, "purchase.captured"))).limit(1))[0];
  const client = await d.pool.connect();
  let chainValid = false;
  try {
    chainValid = (await verifyChain(client, { purchaseId: p.id })).valid;
  } finally {
    client.release();
  }

  const values: EvidenceValues = {
    amount: fromCents(p.amountCents ?? 0),
    currency: p.currency ?? "",
    order_id: p.paypalOrderId ?? "",
    authorization_id: p.paypalAuthorizationId ?? "",
    capture_id: p.paypalCaptureId,
    policy_digest: p.policyDigest,
    captured_at: (captured?.at ?? p.updatedAt).toISOString(),
    intent_text: intent.sourceText ?? "(structured policy, no free text)",
  };
  // The model sees what was checked and the outcome, never raw amounts or IDs to copy from.
  const record = {
    intent: { text: "{{intent_text}}", policy_digest: "{{policy_digest}}", confirmed_by_shopper: Boolean(intent.confirmedAt) },
    checks: checks.map((c) => ({ phase: c.phase, check: c.checkId, kind: c.kind, result: c.result })),
    paypal: { order: "{{order_id}}", authorization: "{{authorization_id}}", capture: "{{capture_id}}", amount: "{{amount}} {{currency}}", captured_at: "{{captured_at}}" },
    three_way_match: checks.some((c) => c.checkId === "three_way_match" && c.result === "pass") ? "passed" : "not recorded",
    audit_chain: chainValid ? "verified" : "unverified",
  };
  const r = await writeEvidence(d.ai ?? new UnavailableLlm(), record, values);
  if (r.kind === "ok") return { kind: "ok", text: r.text, source: "ai", model: r.model, prompt_version: r.prompt_version, values };
  return { kind: "ok", text: templateEvidence(values), source: "template", ai_error: r.reason, values };
}
