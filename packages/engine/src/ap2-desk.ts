// AP2 in the Protection Desk (10 Nov): one row per mandate verification, with what each layer
// decided and what PayPal recorded. Read-only, from ap2_verifications and ap2_settlements.

import type { EngineDeps } from "./deps.ts";
import type { VerificationResponse } from "./ap2.ts";

export type Layer = "pass" | "fail" | "open" | "skip" | "wait";

export interface Ap2DeskRow {
  id: string;
  created_at: string;
  decision: VerificationResponse["decision"];
  error: string | null;
  /** scripted: the fixed runs; shop: real Channel3 products; api: a direct POST /v2/verifications. */
  kind: "scripted" | "shop" | "api";
  run: string | null;
  product: { id: string; title: string; retailer: string | null; price_cents: number | null; image: string | null; source: string | null } | null;
  sent_to_paypal: { id: string; title: string } | null;
  caught_by: string;
  layers: { signatures: Layer; ap2: Layer; facts: Layer; ledger: Layer; paypal: Layer };
  /** Plain reasons, from the verifier's own findings and failed constraints. */
  reasons: string[];
  constraints: VerificationResponse["constraints"];
  findings: VerificationResponse["findings"];
  facts_attestation: string | null;
  receipts: { checkout: string | null; payment: string | null; kid: string | null };
  settlement: { id: string; state: string; paypal_order_id: string; capture_id: string | null; amount_cents: number; diffs: string[] } | null;
}

const of = (cs: VerificationResponse["constraints"]): Layer => (cs.some((c) => c.result === "fail") ? "fail" : cs.some((c) => c.result === "unresolved") ? "open" : cs.length ? "pass" : "skip");

/** The same reading of a verification as the agent page's ladder. */
export function layersOf(v: VerificationResponse, s: { state: string } | null): Ap2DeskRow["layers"] {
  const standard = v.constraints.filter((c) => /^(checkout|payment)\./.test(c.type));
  const ours = v.constraints.filter((c) => c.type.startsWith("x-secondkey."));
  const ledger = v.findings.filter((f) => f.code.startsWith("ledger."));
  const other = v.findings.filter((f) => !f.code.startsWith("ledger."));
  const signatures: Layer = v.error === "invalid_credential" ? "fail" : "pass";
  if (signatures === "fail") return { signatures, ap2: "skip", facts: "skip", ledger: "skip", paypal: "skip" };
  const paypal: Layer = v.decision !== "CONFORMS" || !s ? "skip" : s.state === "CAPTURED" ? "pass" : ["VOIDED", "VOIDING", "REFUSED", "CAPTURE_DECLINED"].includes(s.state) ? "fail" : "wait";
  return { signatures, ap2: other.length ? "fail" : of(standard), facts: of(ours), ledger: ledger.length ? "fail" : "pass", paypal };
}

function caught(v: VerificationResponse, layers: Ap2DeskRow["layers"]): string {
  if (layers.signatures === "fail") return "signatures";
  if (layers.ledger === "fail") return "secondkey_ledger";
  if (layers.ap2 === "fail") return "ap2_constraints";
  if (layers.facts === "fail") return "secondkey_facts";
  if (layers.paypal === "fail") return "paypal_order";
  if (v.decision === "COSIGN_REQUIRED") return "cosign";
  if (v.decision !== "CONFORMS") return "cannot_confirm";
  return "none";
}

/** Verifications in a tenant, newest first; `since` scopes the public view to the current demo session. */
export async function ap2DeskFeed(d: EngineDeps, tenantId: string, o: { limit?: number; since?: Date; principal?: string } = {}): Promise<Ap2DeskRow[]> {
  const limit = Math.min(300, Math.max(1, o.limit ?? 200));
  const { rows } = await d.pool.query(
    `SELECT v.id, v.created_at, v.decision, v.response, v.demo, v.principal,
            s.id AS s_id, s.state AS s_state, s.paypal_order_id, s.paypal_capture_id, s.amount_minor, s.diffs
       FROM ap2_verifications v LEFT JOIN ap2_settlements s ON s.verification_id = v.id
      WHERE v.tenant_id = $1 AND ($2::timestamptz IS NULL OR v.created_at >= $2) AND ($3::text IS NULL OR v.principal = $3)
      ORDER BY v.created_at DESC LIMIT $4`,
    [tenantId, o.since ?? null, o.principal ?? null, limit],
  );
  return rows.map((r) => {
    const v = r.response as VerificationResponse;
    const demo = (r.demo ?? null) as { kind?: string; run?: string; product?: Ap2DeskRow["product"]; sent_to_paypal?: Ap2DeskRow["sent_to_paypal"] } | null;
    const s = r.s_id ? { state: r.s_state as string } : null;
    const layers = layersOf(v, s);
    const reasons = [
      ...v.findings.map((f) => f.message),
      ...v.constraints.filter((c) => c.result !== "pass").map((c) => `${c.type}: ${c.detail ?? c.result}`),
      ...((r.diffs as string[] | null) ?? []),
    ].slice(0, 8);
    return {
      id: r.id as string,
      created_at: (r.created_at as Date).toISOString(),
      decision: v.decision,
      error: v.error ?? null,
      kind: demo?.kind === "shop" ? "shop" : demo?.kind === "scripted" ? "scripted" : "api",
      run: demo?.run ?? null,
      product: demo?.product ?? null,
      sent_to_paypal: demo?.sent_to_paypal ?? null,
      caught_by: caught(v, layers),
      layers,
      reasons,
      constraints: v.constraints,
      findings: v.findings,
      facts_attestation: v.facts_attestation,
      receipts: { checkout: v.receipts?.checkout ?? null, payment: v.receipts?.payment ?? null, kid: v.receipts?.kid ?? null },
      settlement: r.s_id
        ? { id: r.s_id as string, state: r.s_state as string, paypal_order_id: r.paypal_order_id as string, capture_id: (r.paypal_capture_id as string | null) ?? null, amount_cents: Number(r.amount_minor), diffs: (r.diffs as string[]) ?? [] }
        : null,
    };
  });
}
