// Read-only console and demo routes (Stage 5). Nothing here moves money or calls PayPal's money
// paths. Console routes are tenant-scoped (ops); demo routes return aggregates only, plus the
// "try to beat it" screen, which runs the real screening logic on a judge-written listing without
// creating a purchase, an order or any PayPal call.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { UnavailableLlm, evaluateScreen, type LlmClient } from "@witness/ai";
import { Domain, type ProductFacts } from "@witness/core";
import { ap2DeskFeed, demoPolicy, nowOf, revokeIntent, type EngineDeps, type Principal } from "@witness/engine";
import { appendAudit, startEpoch, withTx } from "@witness/db";

type Auth = (...scopes: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Problem = (reply: FastifyReply, status: number, title: string, detail?: string) => FastifyReply;

export interface ConsoleOptions {
  /** Model client for the public "try to beat it" screen, with its own spend cap, so judge traffic can't exhaust the budget real purchases use. */
  demoAi?: LlmClient | undefined;
  /** Max judge screens per minute for this process (default 30). */
  demoScreensPerMinute?: number | undefined;
  /** Max public evidence analyses (/try) per minute for this process (default 20). */
  demoAnalysesPerMinute?: number | undefined;
}

const cents = (n: unknown) => (n == null ? null : Number(n));

/** Purchase ledger rows, flat for grids. The primary reason is the first non-passing check. */
async function ledger(d: EngineDeps, tenantId: string, limit: number, since?: Date) {
  const { rows } = await d.pool.query(
    `SELECT p.id, p.state, p.outcome, p.retailer, p.amount_cents, p.currency, p.reasons, p.intent_id,
            p.paypal_order_id, p.paypal_capture_id, p.created_at, p.updated_at,
            p.cart->'lines'->0->>'name' AS product, coalesce(p.request->>'kind', 'shopping') AS kind,
            (SELECT c.check_id FROM checks c WHERE c.purchase_id = p.id AND c.result <> 'pass' ORDER BY c.id LIMIT 1) AS primary_check,
            (SELECT x.decided_by FROM decisions x WHERE x.purchase_id = p.id ORDER BY x.id DESC LIMIT 1) AS decided_by,
            -- strongest pattern first: same priority order as apps/web/lib/sk.ts rankEvidence
            (SELECT e->>'tactic' FROM checks c, jsonb_array_elements(c.evidence) e
              WHERE c.purchase_id = p.id AND c.result <> 'pass' AND c.evidence IS NOT NULL
              ORDER BY array_position(ARRAY['secrecy','urgency','threat','safe_account','remote_access','unusual_payment_channel','instruction_to_agent','authority_pressure','impersonation','emotional_manipulation','too_good_to_be_true'], e->>'tactic') NULLS LAST
              LIMIT 1) AS top_tactic,
            (SELECT coalesce(sum(jsonb_array_length(c.evidence)), 0)::int FROM checks c WHERE c.purchase_id = p.id AND c.result <> 'pass' AND c.evidence IS NOT NULL) AS evidence_count,
            ((p.request ? 'conversation') OR EXISTS (SELECT 1 FROM shared_context sc WHERE sc.purchase_id = p.id)) AS has_conversation,
            EXISTS (SELECT 1 FROM checks c WHERE c.purchase_id = p.id AND c.check_id = 'transfer.review_rule' AND c.result = 'unknown') AS rule_triggered,
            (SELECT a.event_type FROM audit_log a WHERE a.purchase_id = p.id ORDER BY a.epoch DESC, a.seq DESC LIMIT 1) AS last_event,
            (SELECT a.at FROM audit_log a WHERE a.purchase_id = p.id ORDER BY a.epoch DESC, a.seq DESC LIMIT 1) AS last_event_at,
            p.paypal_authorization_id, h.resolution, h.auto_void_at, po.status AS payout_status
       FROM purchases p
       LEFT JOIN holds h ON h.purchase_id = p.id
       LEFT JOIN payouts po ON po.purchase_id = p.id
      WHERE p.tenant_id = $1 AND ($3::timestamptz IS NULL OR p.created_at >= $3)
      ORDER BY p.created_at DESC
      LIMIT $2`,
    [tenantId, limit, since ?? null],
  );
  return rows.map((r) => ({
    id: r.id as string,
    state: r.state as string,
    outcome: (r.outcome as string | null) ?? null,
    product: (r.product as string | null) ?? null,
    kind: r.kind === "transfer" ? ("transfer" as const) : ("shopping" as const),
    decided_by: (r.decided_by as string | null) ?? null,
    hold_resolution: (r.resolution as string | null) ?? null,
    hold_auto_void_at: r.auto_void_at ? (r.auto_void_at as Date).toISOString() : null,
    top_tactic: (r.top_tactic as string | null) ?? null,
    evidence_count: Number(r.evidence_count ?? 0),
    has_conversation: Boolean(r.has_conversation),
    rule_triggered: Boolean(r.rule_triggered),
    last_event: (r.last_event as string | null) ?? null,
    last_event_at: r.last_event_at ? (r.last_event_at as Date).toISOString() : null,
    paypal_authorization_id: (r.paypal_authorization_id as string | null) ?? null,
    payout_status: (r.payout_status as string | null) ?? null,
    retailer: (r.retailer as string | null) ?? null,
    amount_cents: cents(r.amount_cents),
    currency: (r.currency as string | null) ?? null,
    primary_check: (r.primary_check as string | null) ?? null,
    reasons: (r.reasons as string[]) ?? [],
    intent_id: r.intent_id as string,
    paypal_order_id: (r.paypal_order_id as string | null) ?? null,
    paypal_capture_id: (r.paypal_capture_id as string | null) ?? null,
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  }));
}

/**
 * Aggregates for the console and the judge page. "Unauthorized captures" counts CAPTURED purchases
 * with no consumed single-use approval: the product.s core success metric, computed from the database
 * rather than asserted.
 */
export async function stats(d: EngineDeps, tenantId: string, since?: Date) {
  const scope = since ? "WHERE p.tenant_id = $1 AND p.created_at >= $2" : "WHERE p.tenant_id = $1";
  const args: unknown[] = since ? [tenantId, since] : [tenantId];
  const byState = await d.pool.query(`SELECT p.state, count(*)::int AS n, coalesce(sum(p.amount_cents), 0)::bigint AS cents FROM purchases p ${scope} GROUP BY p.state`, args);
  const blocked = await d.pool.query(
    `SELECT coalesce(pc.check_id, 'other') AS reason, count(*)::int AS n, coalesce(sum(p.amount_cents), 0)::bigint AS cents
       FROM purchases p
       LEFT JOIN LATERAL (SELECT c.check_id FROM checks c WHERE c.purchase_id = p.id AND c.result <> 'pass' ORDER BY c.id LIMIT 1) pc ON true
       ${scope ? `${scope} AND` : "WHERE"} p.state IN ('REJECTED', 'VOIDED')
      GROUP BY 1 ORDER BY 3 DESC, 2 DESC`,
    args,
  );
  const unauthorized = await d.pool.query(
    `SELECT count(*)::int AS n FROM purchases p ${scope ? `${scope} AND` : "WHERE"} p.state = 'CAPTURED'
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.purchase_id = p.id AND a.used_at IS NOT NULL)`,
    args,
  );
  const states = Object.fromEntries(byState.rows.map((r) => [r.state as string, { count: r.n as number, amount_cents: Number(r.cents) }]));
  const sum = (names: string[], k: "count" | "amount_cents") => names.reduce((s, n) => s + (states[n]?.[k] ?? 0), 0);
  return {
    purchases: byState.rows.reduce((s, r) => s + (r.n as number), 0),
    captured: { count: sum(["CAPTURED"], "count"), amount_cents: sum(["CAPTURED"], "amount_cents") },
    rejected: { count: sum(["REJECTED"], "count"), amount_cents: sum(["REJECTED"], "amount_cents") },
    voided: { count: sum(["VOIDED"], "count"), amount_cents: sum(["VOIDED"], "amount_cents") },
    held: { count: sum(["HELD"], "count"), amount_cents: sum(["HELD"], "amount_cents") },
    blocked_by_reason: blocked.rows.map((r) => ({ reason: r.reason as string, count: r.n as number, amount_cents: Number(r.cents) })),
    unauthorized_captures: unauthorized.rows[0]!.n as number,
    by_state: states,
    ...(since ? { since: since.toISOString() } : {}),
  };
}

const JudgeListing = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  brand: z.string().max(80).optional(),
  category: z.string().max(120).optional(),
  color: z.string().max(40).optional(),
  size: z.string().max(20).optional(),
  price: z.number().positive().max(100_000),
  attributes: z.record(z.string().max(40), z.string().max(200)).refine((a) => Object.keys(a).length <= 10, "at most 10 attributes").optional(),
  /**
   * "Try to beat Second Key": what the agent proposes (attacker-controlled). Rose's mandate itself
   * is never accepted from the request; it is demoPolicy, fixed server-side.
   */
  proposal: z
    .strictObject({
      retailer: Domain.optional(),
      quantity: z.number().int().min(1).max(99).optional(),
    })
    .optional(),
  /** Messages the agent received while buying (untrusted). Screened for pressure; they can only add a pause. */
  messages: z
    .array(z.strictObject({ speaker: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(600) }))
    .min(1)
    .max(8)
    .optional(),
});

export function registerConsole(app: FastifyInstance, d: EngineDeps, auth: Auth, problem: Problem, o: ConsoleOptions = {}) {
  const tenantOf = (req: FastifyRequest) => (req.principal as Principal).tenantId;

  app.get<{ Querystring: { limit?: string; scope?: string } }>("/v1/console/purchases", { preHandler: auth("ops", "admin") }, async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200));
    // scope=session: only purchases since the last demo reset (the current audit epoch). Nothing is deleted.
    const e = (await d.pool.query("SELECT epoch, started_at FROM audit_epochs ORDER BY epoch DESC LIMIT 1")).rows[0];
    const since = req.query.scope === "session" && e && e.epoch > 1 ? (e.started_at as Date) : undefined;
    return { purchases: await ledger(d, tenantOf(req), limit, since), session_started_at: since?.toISOString() ?? null };
  });

  /**
   * Public, read-only Protection Desk feed: the demo tenant's CURRENT demo session only (since the
   * last reset), no PII (synthetic data; no payout receiver, no conversation). Detail goes through the
   * evidence endpoint, which masks the payee email.
   */
  app.get<{ Querystring: { limit?: string } }>("/v1/demo/incidents", { preHandler: auth("demo", "admin") }, async (req) => {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const e = (await d.pool.query("SELECT epoch, started_at FROM audit_epochs ORDER BY epoch DESC LIMIT 1")).rows[0];
    const since = e && e.epoch > 1 ? (e.started_at as Date) : undefined;
    const rows = (await ledger(d, tenantOf(req), limit, since)).map(({ reasons: _r, intent_id: _i, ...rest }) => rest);
    return { purchases: rows, session_started_at: since?.toISOString() ?? null, read_only: true };
  });

  // AP2 mandate verifications (10 Nov), for the Desk's "Agent mandates" view. Read-only.
  const epochStart = async () => {
    const e = (await d.pool.query("SELECT epoch, started_at FROM audit_epochs ORDER BY epoch DESC LIMIT 1")).rows[0];
    return e && e.epoch > 1 ? (e.started_at as Date) : undefined;
  };
  app.get<{ Querystring: { limit?: string } }>("/v1/demo/ap2/incidents", { preHandler: auth("demo", "admin") }, async (req) => {
    const since = await epochStart();
    const rows = await ap2DeskFeed(d, tenantOf(req), { limit: Number(req.query.limit ?? 200) || 200, ...(since ? { since } : {}) });
    return { verifications: rows, session_started_at: since?.toISOString() ?? null, read_only: true };
  });
  app.get<{ Querystring: { limit?: string; scope?: string } }>("/v1/console/ap2", { preHandler: auth("ops", "admin") }, async (req) => {
    const since = req.query.scope === "session" ? await epochStart() : undefined;
    const rows = await ap2DeskFeed(d, tenantOf(req), { limit: Number(req.query.limit ?? 200) || 200, ...(since ? { since } : {}) });
    return { verifications: rows, session_started_at: since?.toISOString() ?? null };
  });

  app.get("/v1/console/holds", { preHandler: auth("ops", "admin") }, async (req) => {
    const { rows } = await d.pool.query(
      `SELECT p.id, p.amount_cents, p.currency, p.retailer, p.reasons, p.created_at, p.cart->'lines'->0->>'name' AS product,
              h.auto_void_at, h.notified_at
         FROM purchases p JOIN holds h ON h.purchase_id = p.id
        WHERE p.tenant_id = $1 AND p.state = 'HELD' AND h.resolved_at IS NULL
        ORDER BY h.auto_void_at ASC`,
      [tenantOf(req)],
    );
    return {
      holds: rows.map((r) => ({
        id: r.id as string,
        product: (r.product as string | null) ?? null,
        retailer: (r.retailer as string | null) ?? null,
        amount_cents: cents(r.amount_cents),
        currency: (r.currency as string | null) ?? null,
        reasons: (r.reasons as string[]) ?? [],
        created_at: (r.created_at as Date).toISOString(),
        auto_void_at: (r.auto_void_at as Date).toISOString(),
        shopper_notified: r.notified_at != null,
      })),
    };
  });

  app.get("/v1/console/stats", { preHandler: auth("ops", "admin") }, async (req) => stats(d, tenantOf(req)));

  /** Checks for one purchase, in order, for the evidence-chain widget. */
  app.get<{ Params: { id: string } }>("/v1/console/purchases/:id/checks", { preHandler: auth("ops", "admin") }, async (req, reply) => {
    const owned = await d.pool.query(`SELECT 1 FROM purchases WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantOf(req)]);
    if (!owned.rowCount) return problem(reply, 404, "No such purchase");
    const { rows } = await d.pool.query(
      `SELECT phase, check_id, kind, result, detail, line, model, prompt_version, created_at FROM checks WHERE purchase_id = $1 ORDER BY id`,
      [req.params.id],
    );
    return { checks: rows.map((r) => ({ ...r, created_at: (r.created_at as Date).toISOString() })) };
  });

  // ---- shopper: receipts for the signed-in shopper's own intents ------------------------------
  app.get("/v1/me/purchases", { preHandler: auth("shopper") }, async (req, reply) => {
    const who = req.principal as Principal;
    const shopperId = who.principal.startsWith("shopper:") ? who.principal.slice("shopper:".length) : null;
    if (!shopperId) return problem(reply, 403, "Forbidden", "Not a shopper key");
    const { rows } = await d.pool.query(
      `SELECT p.id, p.state, p.outcome, p.retailer, p.amount_cents, p.currency, p.reasons, p.intent_id, p.created_at,
              p.cart->'lines'->0->>'name' AS product, i.source_text, h.auto_void_at
         FROM purchases p
         JOIN intents i ON i.id = p.intent_id AND i.tenant_id = p.tenant_id
         LEFT JOIN holds h ON h.purchase_id = p.id AND h.resolved_at IS NULL
        WHERE p.tenant_id = $1 AND i.shopper_id = $2
        ORDER BY p.created_at DESC
        LIMIT 50`,
      [who.tenantId, shopperId],
    );
    return {
      purchases: rows.map((r) => ({
        id: r.id as string,
        state: r.state as string,
        outcome: (r.outcome as string | null) ?? null,
        product: (r.product as string | null) ?? null,
        retailer: (r.retailer as string | null) ?? null,
        amount_cents: cents(r.amount_cents),
        currency: (r.currency as string | null) ?? null,
        reasons: (r.reasons as string[]) ?? [],
        intent_id: r.intent_id as string,
        intent_text: (r.source_text as string | null) ?? null,
        created_at: (r.created_at as Date).toISOString(),
        hold_auto_void_at: r.auto_void_at ? (r.auto_void_at as Date).toISOString() : null,
      })),
    };
  });

  // ---- demo: aggregates and the judge's own listing --------------------------------------------
  // Judge counters count from the start of the current audit epoch (a demo reset starts a new one).
  app.get("/v1/demo/stats", { preHandler: auth("demo", "admin") }, async (req) => {
    const e = (await d.pool.query("SELECT epoch, started_at FROM audit_epochs ORDER BY epoch DESC LIMIT 1")).rows[0];
    const s = await stats(d, tenantOf(req), e && e.epoch > 1 ? (e.started_at as Date) : undefined);
    const { by_state: _omit, ...publicStats } = s;
    return publicStats;
  });

  /**
   * Admin only (architecture §"Demo reset without breaking the chain"): release every held
   * authorization by revoking its intent (the executor voids it on PayPal), then start a new audit
   * epoch. Nothing is deleted; earlier epochs stay verifiable. Not exposed through the web app.
   */
  app.post("/v1/demo/reset", { preHandler: auth("admin") }, async (req, reply) => {
    const t = tenantOf(req);
    const held = await d.pool.query("SELECT DISTINCT intent_id FROM purchases WHERE tenant_id = $1 AND state = 'HELD'", [t]);
    for (const r of held.rows) await revokeIntent(d, t, null, r.intent_id as string);
    const epoch = await withTx(d.pool, async (tx) => {
      const n = await startEpoch(tx, `demo reset by ${(req.principal as Principal).principal}`);
      await appendAudit(tx, { tenantId: t, purchaseId: null, eventType: "demo.reset", payload: { epoch: n, holds_released: held.rowCount } });
      return n;
    });
    return reply.code(202).send({ epoch, holds_released: held.rowCount, note: "Held authorizations are being voided by the executor; earlier audit epochs remain verifiable." });
  });

  const perMinute = o.demoScreensPerMinute ?? 30;
  let windowStart = 0;
  let used = 0;
  app.post("/v1/demo/screen", { preHandler: auth("demo", "admin"), bodyLimit: 32 * 1024 }, async (req, reply) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      used = 0;
    }
    if (used >= perMinute) {
      reply.header("retry-after", String(Math.ceil((windowStart + 60_000 - now) / 1000)));
      return problem(reply, 429, "Too many screens", `Try again in a minute (limit ${perMinute}/min)`);
    }
    const parsed = JudgeListing.safeParse(req.body);
    if (!parsed.success) return problem(reply, 400, "Invalid listing", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    used++;
    const l = parsed.data;
    const at = nowOf(d);
    const facts: ProductFacts = {
      product_id: "JUDGE-LISTING",
      title: l.title,
      ...(l.brand ? { brand: l.brand } : {}),
      ...(l.category ? { category: l.category } : {}),
      attributes: { ...(l.attributes ?? {}), ...(l.color ? { color: l.color } : {}), ...(l.size ? { size: l.size } : {}) },
      ...(l.description ? { description: l.description } : {}),
      offers: [{ retailer: l.proposal?.retailer ?? "rei.com", price_cents: Math.round(l.price * 100), currency: "USD", availability: "InStock", condition: "new" }],
      source: "judge",
      fetched_at: at.toISOString(),
    };
    const policy = demoPolicy(at);
    const retailer = l.proposal?.retailer ?? "rei.com";
    const quantity = l.proposal?.quantity ?? 1;
    const request = {
      intent_id: "int_judge",
      retailer,
      lines: [{ product_id: facts.product_id, quantity }],
      ...(l.messages ? { conversation: { context: "Messages Rose's shopping agent received while buying", lines: l.messages } } : {}),
    };
    const r = await evaluateScreen(o.demoAi ?? new UnavailableLlm(), policy, request, new Map([[facts.product_id, facts]]), { now: at });
    return {
      outcome: r.outcome,
      would_reach_paypal: r.outcome !== "REJECT",
      note: "Screening only: no purchase, order or PayPal call was made. CAPTURE means Second Key would authorize and capture after the three-way match on PayPal's order.",
      proposal: { retailer, quantity, total_cents: Math.round(l.price * 100) * quantity },
      policy: { category: policy.category, max_total: "90.00 USD", size: policy.hard.size, excluded_colors: policy.hard.excluded_colors, retailers: policy.retailers, quantity: policy.quantity },
      // `unavailable`: the check couldn't run (a technical failure, so it holds), not a finding.
      checks: r.checks.map((c) => ({ id: c.id, result: c.result, detail: c.detail, unavailable: c.unavailable === true })),
      ai_ms: r.ai_ms,
    };
  });
}
