// Disputes on Second Key captures (ADR-0010), console-only. The buyer opens the dispute in PayPal; ops
// attaches it by ID; Second Key checks it is against one of this tenant's captures; a reviewer approves
// the evidence text; Second Key submits exactly that text. No route here moves money, and evidence is
// never submitted without a person approving the final text.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv5, WITNESS_NAMESPACE, toCents } from "@witness/core";
import { appendAudit, withTx } from "@witness/db";
import type { EngineDeps, Principal } from "@witness/engine";

type Auth = (...scopes: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Problem = (reply: FastifyReply, status: number, title: string, detail?: string) => FastifyReply;

const DisputeId = z.string().regex(/^[A-Za-z0-9-]{4,64}$/);

interface PayPalDispute {
  dispute_id?: string;
  status?: string;
  reason?: string;
  dispute_amount?: { value?: string; currency_code?: string };
  disputed_transactions?: { seller_transaction_id?: string }[];
  dispute_outcome?: { outcome_code?: string };
  links?: { rel?: string }[];
}

const summarise = (d: PayPalDispute) => {
  let amount_cents: number | null = null;
  try {
    amount_cents = d.dispute_amount?.value ? toCents(d.dispute_amount.value) : null;
  } catch {
    amount_cents = null;
  }
  return {
    status: d.status ?? "UNKNOWN",
    reason: d.reason ?? null,
    amount_cents,
    currency: d.dispute_amount?.currency_code ?? null,
    allowed_actions: (d.links ?? []).map((l) => l.rel ?? "").filter((r) => r && r !== "self"),
    outcome: d.dispute_outcome?.outcome_code ?? null,
  };
};

const row = (r: any) => ({
  id: r.id as string,
  purchase_id: r.purchase_id as string,
  status: r.status as string,
  reason: r.reason as string | null,
  amount_cents: r.amount_cents as number | null,
  currency: r.currency as string | null,
  allowed_actions: r.allowed_actions as string[],
  outcome: r.outcome as string | null,
  evidence_text: r.evidence_text as string | null,
  evidence_submitted_by: r.evidence_submitted_by as string | null,
  evidence_submitted_at: r.evidence_submitted_at ? (r.evidence_submitted_at as Date).toISOString() : null,
  simulated_verdict: r.simulated_verdict as boolean,
  capture_id: (r.paypal_capture_id as string | null) ?? null,
  updated_at: (r.updated_at as Date).toISOString(),
});

export function registerDisputes(app: FastifyInstance, d: EngineDeps, auth: Auth, problem: Problem) {
  const who = (req: FastifyRequest) => req.principal as Principal;
  const SELECT = `SELECT ds.*, p.paypal_capture_id FROM disputes ds JOIN purchases p ON p.id = ds.purchase_id`;
  const one = async (tenantId: string, id: string) => (await d.pool.query(`${SELECT} WHERE ds.id = $1 AND ds.tenant_id = $2`, [id, tenantId])).rows[0];

  async function refresh(tenantId: string, id: string) {
    const live = (await d.paypal.getDispute(id)).data as PayPalDispute;
    const s = summarise(live);
    await d.pool.query(`UPDATE disputes SET status = $3, reason = $4, amount_cents = $5, currency = $6, allowed_actions = $7, outcome = $8, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
      s.status,
      s.reason,
      s.amount_cents,
      s.currency,
      JSON.stringify(s.allowed_actions),
      s.outcome,
    ]);
    return one(tenantId, id);
  }

  app.get("/v1/console/disputes", { preHandler: auth("ops", "admin") }, async (req) => {
    const { rows } = await d.pool.query(`${SELECT} WHERE ds.tenant_id = $1 ORDER BY ds.created_at DESC LIMIT 100`, [who(req).tenantId]);
    return { disputes: rows.map(row) };
  });

  /** Attach a buyer-opened dispute. It must be against a capture Second Key made for this tenant. */
  app.post<{ Body: { dispute_id?: unknown } }>("/v1/console/disputes", { preHandler: auth("ops", "admin") }, async (req, reply) => {
    const id = DisputeId.safeParse(req.body?.dispute_id);
    if (!id.success) return problem(reply, 400, "Invalid dispute_id");
    const t = who(req).tenantId;
    const res = await d.paypal.getDispute(id.data);
    const live = res.data as PayPalDispute;
    const captureIds = (live.disputed_transactions ?? []).map((x) => x.seller_transaction_id).filter((x): x is string => Boolean(x));
    const p = captureIds.length ? (await d.pool.query(`SELECT id FROM purchases WHERE tenant_id = $1 AND paypal_capture_id = ANY($2::text[])`, [t, captureIds])).rows[0] : undefined;
    if (!p) return problem(reply, 422, "Not a Second Key capture", "This dispute is not against a capture Second Key made for your tenant");
    const s = summarise(live);
    await withTx(d.pool, async (tx) => {
      const ins = await tx.client.query(
        `INSERT INTO disputes (id, paypal_dispute_id, tenant_id, purchase_id, status, reason, amount_cents, currency, allowed_actions, outcome)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [id.data, t, p.id, s.status, s.reason, s.amount_cents, s.currency, JSON.stringify(s.allowed_actions), s.outcome],
      );
      if (ins.rowCount) await appendAudit(tx, { tenantId: t, purchaseId: p.id, eventType: "dispute.attached", payload: { dispute_id: id.data, status: s.status, reason: s.reason, attached_by: who(req).principal } });
    });
    return reply.code(201).send(row(await one(t, id.data)));
  });

  app.post<{ Params: { id: string } }>("/v1/console/disputes/:id/refresh", { preHandler: auth("ops", "admin") }, async (req, reply) => {
    const t = who(req).tenantId;
    if (!(await one(t, req.params.id))) return problem(reply, 404, "Dispute not attached");
    return row(await refresh(t, req.params.id));
  });

  /** Submit reviewer-approved evidence text, exactly as approved, at most once. */
  app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/v1/console/disputes/:id/submit", { preHandler: auth("ops", "admin") }, async (req, reply) => {
    const t = who(req).tenantId;
    const text = z.string().trim().min(50).max(5000).safeParse(req.body?.text);
    if (!text.success) return problem(reply, 400, "Evidence text must be 50 to 5000 characters");
    if (/\{\{[a-z_]+\}\}/.test(text.data)) return problem(reply, 400, "Evidence text still contains unfilled placeholders");
    const existing = await one(t, req.params.id);
    if (!existing) return problem(reply, 404, "Dispute not attached");
    if (existing.evidence_submitted_at) return problem(reply, 409, "Evidence already submitted", `at ${(existing.evidence_submitted_at as Date).toISOString()}`);
    const current = await refresh(t, req.params.id);
    if (!(current.allowed_actions as string[]).includes("provide_evidence")) return problem(reply, 409, "PayPal is not accepting evidence for this dispute now", `status ${current.status}; allowed: ${(current.allowed_actions as string[]).join(", ") || "none"}`);
    // Deterministic request id: a retry of the same submission can't create a second one.
    const res = await d.paypal.provideEvidence(req.params.id, text.data, uuidv5(`evidence:${req.params.id}`, WITNESS_NAMESPACE));
    if (!res.ok) return problem(reply, 502, "PayPal refused the evidence", `HTTP ${res.status}`);
    await withTx(d.pool, async (tx) => {
      await tx.client.query(`UPDATE disputes SET evidence_text = $3, evidence_submitted_by = $4, evidence_submitted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, t, text.data, who(req).principal]);
      await appendAudit(tx, { tenantId: t, purchaseId: existing.purchase_id, eventType: "dispute.evidence_submitted", payload: { dispute_id: req.params.id, submitted_by: who(req).principal, chars: text.data.length, debug_id: res.debugId } });
    });
    return row(await refresh(t, req.params.id));
  });

  /**
   * Sandbox only: advance the dispute so the demo can finish (require-evidence, then adjudicate in
   * the seller's favour once evidence is in). The verdict is recorded as SIMULATED.
   */
  app.post<{ Params: { id: string } }>("/v1/console/disputes/:id/sandbox-step", { preHandler: auth("ops", "admin") }, async (req, reply) => {
    const t = who(req).tenantId;
    const existing = await one(t, req.params.id);
    if (!existing) return problem(reply, 404, "Dispute not attached");
    const current = await refresh(t, req.params.id);
    const actions = current.allowed_actions as string[];
    let step: string;
    if (current.evidence_submitted_at && actions.includes("adjudicate")) {
      await d.paypal.adjudicate(req.params.id, "SELLER_FAVOR", uuidv5(`adjudicate:${req.params.id}`, WITNESS_NAMESPACE));
      await d.pool.query(`UPDATE disputes SET simulated_verdict = true, updated_at = now() WHERE id = $1`, [req.params.id]);
      step = "adjudicate (simulated verdict)";
    } else if (!current.evidence_submitted_at && actions.includes("require_evidence")) {
      await d.paypal.requireEvidence(req.params.id, uuidv5(`require-evidence:${req.params.id}`, WITNESS_NAMESPACE));
      step = "require-evidence";
    } else {
      return problem(reply, 409, "No sandbox step available now", `status ${current.status}; allowed: ${actions.join(", ") || "none"}`);
    }
    await withTx(d.pool, (tx) => appendAudit(tx, { tenantId: t, purchaseId: existing.purchase_id, eventType: "dispute.sandbox_step", payload: { dispute_id: req.params.id, step, by: who(req).principal } }));
    return { step, dispute: row(await refresh(t, req.params.id)) };
  });
}
