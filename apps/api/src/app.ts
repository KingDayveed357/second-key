// The public Witness API. It screens, authorizes and decides; it has NO capture or void route
// (money moves only in the worker's executor; see the route-inventory test).

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { uuidv5, WITNESS_NAMESPACE } from "@witness/core";
import { QUEUES, dbOf, enqueue, lookupApiKey, schema, verifyChain, withTx } from "@witness/db";
import {
  agentView,
  confirmIntent,
  createIntent,
  getIntent,
  intentView,
  purchaseView,
  revokeIntent,
  runScenario,
  SCENARIOS,
  transferPolicy,
  shareContext,
  giveFeedback,
  conversationOf,
  feedbackOf,
  getPayout,
  livePayout,
  maskEmail,
  compileAndCreateIntent,
  draftDisputeEvidence,
  getHold,
  issueHoldLink,
  resolveHold,
  verifyHold,
  submitPurchase,
  getProtection,
  setThreshold,
  inviteGuardian,
  setGuardian,
  removeGuardian,
  revokeGuardian,
  cancelProfileChange,
  remindGuardian,
  createDemoInbox,
  listInbox,
  openInboxMessage,
  acceptInvite,
  createDemoPayer,
  demoKnownPayees,
  importPayee,
  type ProtectionResult,
  type HoldActor,
  type HoldResult,
  type EngineDeps,
  type Principal,
} from "@witness/engine";
import { PayPalHttpError, PayPalNetworkError } from "@witness/paypal";
import { registerConsole, type ConsoleOptions } from "./console.ts";
import { registerAnalyze } from "./analyze.ts";
import { registerDisputes } from "./disputes.ts";

export interface AppOptions {
  deps: EngineDeps;
  webhookId?: string | undefined;
  demoShopperId?: string | undefined;
  console?: ConsoleOptions;
  logger?: boolean | object;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const problem = (reply: FastifyReply, status: number, title: string, detail?: string) =>
  reply
    .code(status)
    .type("application/problem+json")
    .send({ type: "about:blank", title, status, ...(detail ? { detail } : {}), trace_id: reply.request.id });

const shopperIdOf = (p: Principal) => (p.principal.startsWith("shopper:") ? p.principal.slice("shopper:".length) : null);

/** Mask a transfer payee's email in an intent view (the receiver is shown masked everywhere). */
function maskIntentEmail<T extends { policy: unknown }>(v: T): T {
  const policy = v.policy as { kind?: string; payee?: { email?: string } } | null;
  if (policy?.kind !== "transfer" || !policy.payee?.email) return v;
  return { ...v, policy: { ...policy, payee: { ...policy.payee, email: maskEmail(policy.payee.email) } } };
}

/** The audit epoch that holds a purchase's events (a demo reset starts a new epoch). */
async function epochOf(client: { query: (q: string, v: unknown[]) => Promise<{ rows: { epoch: number | null }[] }> }, purchaseId: string): Promise<{ epoch?: number }> {
  const r = await client.query("SELECT max(epoch) AS epoch FROM audit_log WHERE purchase_id = $1", [purchaseId]);
  const e = r.rows[0]?.epoch;
  return e == null ? {} : { epoch: Number(e) };
}

export function buildApp(o: AppOptions): FastifyInstance {
  const d = o.deps;
  const app = Fastify({
    logger: o.logger ?? false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
    bodyLimit: 64 * 1024,
  });

  const auth =
    (...scopes: string[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const header = req.headers.authorization ?? "";
      const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const who = key ? await lookupApiKey(d.pool, key) : null;
      if (!who) return problem(reply, 401, "Unauthorized", "Missing or invalid API key");
      if (!scopes.some((s) => who.scopes.includes(s))) return problem(reply, 403, "Forbidden", `Requires one of: ${scopes.join(", ")}`);
      req.principal = who;
    };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof PayPalNetworkError || err instanceof PayPalHttpError) {
      req.log.warn({ err: err.message }, "paypal error");
      return problem(reply, 502, "PayPal unavailable", err.message);
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    // Fastify's own client errors (bad JSON, body too large, wrong content type) keep their 4xx.
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) return problem(reply, e.statusCode ?? 400, "Bad request", e.message);
    req.log.error({ err }, "unhandled");
    return problem(reply, 500, "Internal error");
  });

  // ---- health -----------------------------------------------------------------------------
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await d.pool.query("SELECT 1");
      return { ok: true };
    } catch {
      return problem(reply, 503, "Not ready", "database unavailable");
    }
  });

  // ---- intents ----------------------------------------------------------------------------
  app.post<{ Body: { shopper_id?: string; policy?: unknown; source_text?: string; text?: string } }>("/v1/intents", { preHandler: auth("shopper", "admin") }, async (req, reply) => {
    const who = req.principal!;
    const shopperId = shopperIdOf(who) ?? req.body?.shopper_id;
    if (!shopperId) return problem(reply, 422, "shopper_id required");
    // Free text -> AI-compiled DRAFT (shopper confirms every field); or a structured policy directly.
    const r =
      typeof req.body?.text === "string" && req.body.policy === undefined
        ? await compileAndCreateIntent(d, who.tenantId, shopperId, req.body.text)
        : await createIntent(d, who.tenantId, shopperId, { policy: req.body?.policy, ...(req.body?.source_text ? { source_text: req.body.source_text } : {}) });
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    return reply.code(201).send(intentView(r.intent));
  });

  app.get<{ Params: { id: string } }>("/v1/intents/:id", { preHandler: auth("shopper", "ops", "admin") }, async (req, reply) => {
    const who = req.principal!;
    const i = await getIntent(d, who.tenantId, req.params.id);
    const sid = shopperIdOf(who);
    if (!i || (sid && i.shopperId !== sid)) return problem(reply, 404, "Intent not found");
    return intentView(i);
  });

  app.post<{ Params: { id: string }; Body: { policy?: unknown } }>("/v1/intents/:id/confirm", { preHandler: auth("shopper", "admin") }, async (req, reply) => {
    const who = req.principal!;
    const r = await confirmIntent(d, who.tenantId, shopperIdOf(who), req.params.id, req.body?.policy);
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    return intentView(r.intent);
  });

  app.post<{ Params: { id: string } }>("/v1/intents/:id/revoke", { preHandler: auth("shopper", "admin") }, async (req, reply) => {
    const who = req.principal!;
    const r = await revokeIntent(d, who.tenantId, shopperIdOf(who), req.params.id);
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    return intentView(r.intent);
  });

  // ---- purchases --------------------------------------------------------------------------
  app.post("/v1/purchases", { preHandler: auth("agent:purchase") }, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string") return problem(reply, 422, "Idempotency-Key header required");
    const r = await submitPurchase(d, req.principal!, key, req.body);
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    return reply.code(r.replay ? 200 : 202).send(agentView(r.purchase));
  });

  const loadPurchase = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const who = req.principal!;
    const p = (await dbOf(d.pool).select().from(schema.purchases).where(and(eq(schema.purchases.id, req.params.id), eq(schema.purchases.tenantId, who.tenantId))).limit(1))[0];
    if (!p) return null;
    // Agents see only their own purchases; shoppers only purchases on their intents.
    if (who.scopes.includes("agent:purchase") && !who.scopes.some((s) => s === "ops" || s === "admin") && p.agentPrincipal !== who.principal) return null;
    const sid = shopperIdOf(who);
    if (sid) {
      const i = await getIntent(d, who.tenantId, p.intentId);
      if (i?.shopperId !== sid) return null;
    }
    return p;
  };

  app.get<{ Params: { id: string } }>("/v1/purchases/:id", { preHandler: auth("agent:purchase", "shopper", "ops", "demo", "admin") }, async (req, reply) => {
    const p = await loadPurchase(req);
    if (!p) return problem(reply, 404, "Purchase not found");
    const full = req.principal!.scopes.some((s) => s !== "agent:purchase");
    return full ? purchaseView(p) : agentView(p);
  });

  app.get<{ Params: { id: string } }>("/v1/purchases/:id/evidence", { preHandler: auth("shopper", "ops", "demo", "admin") }, async (req, reply) => {
    const p = await loadPurchase(req);
    if (!p) return problem(reply, 404, "Purchase not found");
    const db = dbOf(d.pool);
    const conv = await conversationOf(d, p);
    const [intent, checks, decisions, calls] = await Promise.all([
      getIntent(d, p.tenantId, p.intentId),
      db.select().from(schema.checks).where(eq(schema.checks.purchaseId, p.id)).orderBy(asc(schema.checks.id)),
      db.select().from(schema.decisions).where(eq(schema.decisions.purchaseId, p.id)).orderBy(asc(schema.decisions.id)),
      db.select().from(schema.paypalCalls).where(eq(schema.paypalCalls.purchaseId, p.id)).orderBy(asc(schema.paypalCalls.id)),
    ]);
    const client = await d.pool.connect();
    try {
      const chain = await verifyChain(client, { purchaseId: p.id, ...(await epochOf(client, p.id)) });
      return {
        purchase: purchaseView(p),
        payout: await getPayout(d, p.id),
        intent: intent ? maskIntentEmail(intentView(intent)) : null,
        facts: p.facts,
        request: { kind: (p.request as { kind?: string } | null)?.kind === "transfer" ? "transfer" : "shopping", conversation: conv?.conversation ?? null, conversation_source: conv?.source ?? null },
        feedback: await feedbackOf(d, p.id),
        checks: checks.map((c) => ({ phase: c.phase, check_id: c.checkId, kind: c.kind, result: c.result, detail: c.detail, line: c.line, evidence: c.evidence ?? null, model: c.model, prompt_version: c.promptVersion, at: c.createdAt })),
        decisions: decisions.map((x) => ({ outcome: x.outcome, reasons: x.reasons, decided_by: x.decidedBy, at: x.createdAt })),
        paypal_calls: calls.map((c) => ({ op: c.op, request_id: c.requestId, status: c.status, http_status: c.httpStatus, debug_id: c.debugId, at: c.createdAt })),
        chain,
      };
    } finally {
      client.release();
    }
  });

  /** Live, read-only proxy of PayPal's own state, so anyone can check a verdict against PayPal. */
  app.get<{ Params: { id: string } }>("/v1/purchases/:id/paypal", { preHandler: auth("shopper", "ops", "demo", "admin") }, async (req, reply) => {
    const p = await loadPurchase(req);
    if (!p) return problem(reply, 404, "Purchase not found");
    if (!p.paypalOrderId) return { fetched_at: new Date().toISOString(), order: null, note: "No PayPal order was ever created for this purchase." };
    const order = await d.paypal.getOrder(p.paypalOrderId);
    const pu = order.data?.purchase_units?.[0] ?? {};
    return {
      fetched_at: new Date().toISOString(),
      debug_id: order.debugId,
      order: { id: order.data?.id, status: order.data?.status, amount: pu.amount, payee: pu.payee?.merchant_id, items: pu.items?.map((i: any) => ({ sku: i.sku, quantity: i.quantity, unit_amount: i.unit_amount })) },
      authorizations: pu.payments?.authorizations?.map((a: any) => ({ id: a.id, status: a.status, amount: a.amount })) ?? [],
      captures: pu.payments?.captures?.map((c: any) => ({ id: c.id, status: c.status, amount: c.amount })) ?? [],
      payout: await livePayout(d, await getPayout(d, p.id)),
    };
  });

  /** Read-only view an agent needs to shop: what the shopper asked for. Agents can't edit intents. */
  app.get<{ Params: { id: string } }>("/v1/intents/:id/summary", { preHandler: auth("agent:purchase", "shopper", "ops", "admin") }, async (req, reply) => {
    const i = await getIntent(d, req.principal!.tenantId, req.params.id);
    if (!i || i.status !== "CONFIRMED") return problem(reply, 404, "No confirmed intent with that id");
    return { id: i.id, status: i.status, source_text: i.sourceText, policy: i.policy };
  });

  /** Draft dispute evidence for review. Never sent to PayPal from here. */
  app.post<{ Params: { id: string } }>("/v1/purchases/:id/dispute-evidence/draft", { preHandler: auth("ops", "admin") }, async (req, reply) => {
    const r = await draftDisputeEvidence(d, req.principal!.tenantId, req.params.id);
    if (r.kind === "error") return problem(reply, r.status, r.title);
    return r;
  });

  // ---- holds (shopper decides on a held purchase; funds stay authorized meanwhile) ----------
  // The hold credential travels only in a POST body, never a URL (ADR-0020 §5, amends ADR-0017).
  const holdActor = async (req: FastifyRequest, token: unknown): Promise<HoldActor | null> => {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) {
      const who = await lookupApiKey(d.pool, header.slice(7).trim());
      if (!who) return null;
      req.principal = who;
      const sid = shopperIdOf(who);
      if (sid && who.scopes.includes("shopper")) return { shopperId: sid };
      if (who.scopes.includes("admin")) return { admin: true };
      return null;
    }
    return typeof token === "string" && token.length >= 20 && token.length <= 128 ? { token } : null;
  };
  const sendHold = (reply: FastifyReply, r: HoldResult<unknown>) => (r.kind === "error" ? problem(reply, r.status, r.title, r.detail) : r.value);

  app.post<{ Params: { id: string } }>("/v1/purchases/:id/hold-link", { preHandler: auth("shopper", "admin") }, async (req, reply) => {
    const who = req.principal!;
    const sid = shopperIdOf(who);
    const r = await issueHoldLink(d, who.tenantId, req.params.id, sid ? { shopperId: sid } : { admin: true });
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    // Shown once. Only the hash is stored. The credential rides in the fragment, which browsers never
    // send to a server or put in a Referer (ADR-0020 §5).
    return { path: `/holds/${req.params.id}#k=${r.value.token}`, token: r.value.token, expires_at: r.value.expires_at };
  });

  const signedIn = async (req: FastifyRequest) => (req.headers.authorization?.startsWith("Bearer ") ? holdActor(req, undefined) : null);
  const viaLink = "Sign in, or send the credential from your request in the body of a POST";
  app.get<{ Params: { id: string } }>("/v1/holds/:id", async (req, reply) => {
    const actor = await signedIn(req);
    if (!actor) return problem(reply, 401, "Unauthorized", viaLink);
    return sendHold(reply, await getHold(d, req.params.id, actor, req.principal?.tenantId));
  });
  app.get<{ Params: { id: string } }>("/v1/holds/:id/verification", async (req, reply) => {
    const actor = await signedIn(req);
    if (!actor) return problem(reply, 401, "Unauthorized", viaLink);
    return sendHold(reply, await verifyHold(d, req.params.id, actor, req.principal?.tenantId));
  });
  app.post<{ Params: { id: string }; Body: { token?: string } }>("/v1/holds/:id/view", async (req, reply) => {
    const actor = await holdActor(req, req.body?.token);
    if (!actor) return problem(reply, 401, "Unauthorized", viaLink);
    return sendHold(reply, await getHold(d, req.params.id, actor, req.principal?.tenantId));
  });
  app.post<{ Params: { id: string }; Body: { token?: string } }>("/v1/holds/:id/verification", async (req, reply) => {
    const actor = await holdActor(req, req.body?.token);
    if (!actor) return problem(reply, 401, "Unauthorized", viaLink);
    return sendHold(reply, await verifyHold(d, req.params.id, actor, req.principal?.tenantId));
  });

  // ---- the payer's own paused payment (ADR-0019) -------------------------------------------
  const payer = (req: FastifyRequest) => ({ tenantId: req.principal!.tenantId, shopperId: shopperIdOf(req.principal!) });
  const sendCtx = (reply: FastifyReply, r: { kind: "ok"; value: unknown } | { kind: "error"; status: number; title: string; detail?: string }) => (r.kind === "error" ? problem(reply, r.status, r.title, r.detail) : r.value);
  app.post<{ Params: { id: string } }>("/v1/me/purchases/:id/context", { preHandler: auth("shopper") }, async (req, reply) => {
    const { tenantId, shopperId } = payer(req);
    if (!shopperId) return problem(reply, 403, "Payer only");
    return sendCtx(reply, await shareContext(d, tenantId, shopperId, req.params.id, req.body));
  });
  app.post<{ Params: { id: string } }>("/v1/me/purchases/:id/feedback", { preHandler: auth("shopper") }, async (req, reply) => {
    const { tenantId, shopperId } = payer(req);
    if (!shopperId) return problem(reply, 403, "Payer only");
    return sendCtx(reply, await giveFeedback(d, tenantId, shopperId, req.params.id, req.body));
  });
  app.post<{ Params: { id: string } }>("/v1/me/holds/:id/cancel", { preHandler: auth("shopper") }, async (req, reply) => {
    const { tenantId, shopperId } = payer(req);
    if (!shopperId) return problem(reply, 403, "Payer only");
    return sendHold(reply, await resolveHold(d, req.params.id, "deny", { shopperId }, tenantId));
  });

  app.post<{ Params: { id: string } }>("/v1/me/holds/:id/notify", { preHandler: auth("shopper") }, async (req, reply) => {
    const { tenantId, shopperId } = payer(req);
    if (!shopperId) return problem(reply, 403, "Payer only");
    return sendProt(reply, await remindGuardian(d, tenantId, shopperId, req.params.id));
  });

  // ---- the payer's standing protection (ADR-0020) -------------------------------------------
  // One change per request; the server alone decides tighten (now) or loosen (after the delay).
  const sendProt = (reply: FastifyReply, r: ProtectionResult<unknown>) => (r.kind === "error" ? problem(reply, r.status, r.title, r.detail) : r.value);
  const asPayer = (fn: (tenantId: string, shopperId: string, req: FastifyRequest) => Promise<ProtectionResult<unknown>>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { tenantId, shopperId } = payer(req);
    if (!shopperId) return problem(reply, 403, "Payer only");
    return sendProt(reply, await fn(tenantId, shopperId, req));
  };
  app.get("/v1/me/protection", { preHandler: auth("shopper") }, asPayer((t, s) => getProtection(d, t, s)));
  app.post("/v1/me/protection/threshold", { preHandler: auth("shopper") }, asPayer((t, s, req) => setThreshold(d, t, s, req.body)));
  app.post("/v1/me/guardians", { preHandler: auth("shopper") }, asPayer((t, s, req) => inviteGuardian(d, t, s, req.body)));
  app.post("/v1/me/protection/guardian", { preHandler: auth("shopper") }, asPayer((t, s, req) => setGuardian(d, t, s, req.body)));
  app.post("/v1/me/protection/guardian/remove", { preHandler: auth("shopper") }, asPayer((t, s) => removeGuardian(d, t, s)));
  app.post("/v1/me/protection/guardian/revoke", { preHandler: auth("shopper") }, asPayer((t, s, req) => revokeGuardian(d, t, s, req.body)));
  app.post<{ Params: { id: string } }>("/v1/me/protection/changes/:id/cancel", { preHandler: auth("shopper") }, asPayer((t, s, req) => cancelProfileChange(d, t, s, (req.params as { id: string }).id)));

  /** Admin only: import a payee the payer is known to have paid (audited). */
  app.post<{ Body: { shopper_id?: unknown; payee_id?: unknown; email?: unknown } }>("/v1/admin/payee-history", { preHandler: auth("admin") }, async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.shopper_id !== "string" || typeof b.payee_id !== "string" || (b.email !== undefined && typeof b.email !== "string")) return problem(reply, 422, "Send { shopper_id, payee_id, email? }");
    await importPayee(d, req.principal!.tenantId, b.shopper_id, { id: b.payee_id, ...(typeof b.email === "string" ? { email: b.email } : {}) }, `admin:${req.principal!.principal}`);
    return { imported: true };
  });

  // ---- Second Key demo: a payer per visitor, and an inbox standing in for the guardian's phone ----
  // The inbox is read only with its secret, which the guardian's window alone holds. No shopper-role
  // route reaches it: the payer's credential can't read guardian messages or obtain a hold credential.
  app.post("/v1/demo/payers", { preHandler: auth("demo", "admin") }, async (req, reply) => {
    if (!o.demoShopperId) return problem(reply, 503, "Demo not configured", "WITNESS_DEMO_SHOPPER_ID is not set");
    return reply.code(201).send(await createDemoPayer(d, req.principal!.tenantId, o.demoShopperId, demoKnownPayees(d)));
  });
  app.post<{ Params: { name: string }; Querystring: { evidence?: string } }>("/v1/me/demo/transfers/:name", { preHandler: auth("shopper") }, async (req, reply) => {
    const { tenantId, shopperId } = payer(req);
    if (!shopperId) return problem(reply, 403, "Payer only");
    if (!o.demoShopperId) return problem(reply, 503, "Demo not configured");
    if (!SCENARIOS[req.params.name]?.transfer) return problem(reply, 404, "Unknown transfer scenario", req.params.name);
    const r = await runScenario(d, { tenantId, principal: `agent:payer-app-${shopperId}`, scopes: ["agent:purchase"] }, shopperId, req.params.name, { evidence: req.query.evidence !== "none", standingProfile: true });
    if (!r) return problem(reply, 404, "Unknown scenario", req.params.name);
    if (r.result.kind === "error") return problem(reply, r.result.status, r.result.title, r.result.detail);
    return reply.code(202).send({ scenario: req.params.name, intent_id: r.intentId, purchase: purchaseView(r.result.purchase) });
  });
  const inboxSecret = (req: FastifyRequest) => req.headers["x-inbox-secret"];
  app.post("/v1/demo/inboxes", { preHandler: auth("demo", "admin") }, async (req, reply) => reply.code(201).send(await createDemoInbox(d, req.principal!.tenantId)));
  app.get<{ Params: { address: string } }>("/v1/demo/inboxes/:address/messages", { preHandler: auth("demo", "admin") }, async (req, reply) =>
    sendProt(reply, await listInbox(d, req.principal!.tenantId, req.params.address, inboxSecret(req))),
  );
  app.post<{ Params: { address: string; id: string } }>("/v1/demo/inboxes/:address/messages/:id/open", { preHandler: auth("demo", "admin") }, async (req, reply) =>
    sendProt(reply, await openInboxMessage(d, req.principal!.tenantId, req.params.address, inboxSecret(req), req.params.id)),
  );
  app.post<{ Params: { address: string; id: string } }>("/v1/demo/inboxes/:address/messages/:id/accept", { preHandler: auth("demo", "admin") }, async (req, reply) =>
    sendProt(reply, await acceptInvite(d, req.principal!.tenantId, req.params.address, inboxSecret(req), req.params.id)),
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post<{ Params: { id: string }; Body: { token?: string } }>(`/v1/holds/:id/${decision}`, async (req, reply) => {
      const actor = await holdActor(req, req.body?.token);
      if (!actor) return problem(reply, 401, "Unauthorized", "Sign in or use the link you were sent");
      return sendHold(reply, await resolveHold(d, req.params.id, decision, actor, req.principal?.tenantId));
    });
  }

  // ---- demo -------------------------------------------------------------------------------
  // Scenario details are synthetic demo data (people, conversations), so the payer screen can show
  // exactly what the engine will screen.
  app.get("/v1/demo/scenarios", async () =>
    Object.entries(SCENARIOS).map(([name, s]) => ({
      name,
      title: s.title,
      expected: s.expected,
      ...(s.transfer
        ? {
            transfer: {
              payee: { ...s.transfer.payee, ...(d.demoRecipientEmail ? { email: maskEmail(d.demoRecipientEmail) } : {}) },
              payout_configured: Boolean(d.demoRecipientEmail),
              amount_cents: transferPolicy(new Date(), s.transfer).amount_cents,
              currency: "USD",
              purpose: s.transfer.purpose,
              conversation: s.transfer.conversation,
              review_threshold_cents: s.transfer.review_threshold_cents ?? null,
            },
          }
        : {}),
    })),
  );

  app.post<{ Params: { name: string } }>("/v1/demo/scenarios/:name", { preHandler: auth("demo", "admin") }, async (req, reply) => {
    if (!o.demoShopperId) return problem(reply, 503, "Demo not configured", "WITNESS_DEMO_SHOPPER_ID is not set");
    const who = req.principal!;
    const r = await runScenario(d, { ...who, principal: `agent:demo-${who.principal}` }, o.demoShopperId, req.params.name, { evidence: (req.query as { evidence?: string }).evidence !== "none" });
    if (!r) return problem(reply, 404, "Unknown scenario", req.params.name);
    if (r.result.kind === "error") return problem(reply, r.result.status, r.result.title, r.result.detail);
    return reply.code(202).send({ scenario: req.params.name, expected: r.scenario.expected, intent_id: r.intentId, purchase: purchaseView(r.result.purchase) });
  });

  // ---- webhooks ---------------------------------------------------------------------------
  // Webhooks get their own JSON parser that keeps the raw body: PayPal verifies the event only if it
  // is posted back exactly as received.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      try {
        (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
        done(null, JSON.parse(body as string));
      } catch {
        const err = new Error("Malformed JSON") as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    });
    scope.post<{ Body: Record<string, any> }>("/v1/webhooks/paypal", async (req, reply) => {
    if (!o.webhookId) return problem(reply, 503, "Webhooks not configured", "PAYPAL_WEBHOOK_ID is not set");
    const h = req.headers;
    const pick = (name: string) => (typeof h[name] === "string" ? (h[name] as string) : "");
    const headers = {
      auth_algo: pick("paypal-auth-algo"),
      cert_url: pick("paypal-cert-url"),
      transmission_id: pick("paypal-transmission-id"),
      transmission_sig: pick("paypal-transmission-sig"),
      transmission_time: pick("paypal-transmission-time"),
    };
    const event = req.body ?? {};
    if (Object.values(headers).some((v) => !v) || typeof event.id !== "string") return problem(reply, 400, "Malformed webhook");

    const rawEvent = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(event);
    const verified = await d.paypal.verifyWebhookSignature(headers, o.webhookId, rawEvent, uuidv5(`verify:${headers.transmission_id}`, WITNESS_NAMESPACE));
    const resource = event.resource ?? {};
    await withTx(d.pool, async (tx) => {
      const inserted = await tx.db
        .insert(schema.webhookEvents)
        .values({
          eventId: verified ? event.id : `unverified:${headers.transmission_id}`,
          eventType: String(event.event_type ?? "unknown"),
          resourceType: typeof event.resource_type === "string" ? event.resource_type : null,
          resourceId: typeof resource.id === "string" ? resource.id : null,
          transmissionId: headers.transmission_id,
          verified,
          payload: event,
        })
        .onConflictDoNothing()
        .returning({ id: schema.webhookEvents.eventId });
      if (verified && inserted.length) await enqueue(d.boss, tx, QUEUES.webhook, { eventId: event.id }, { singletonKey: `webhook:${event.id}` });
    });
    if (!verified) return problem(reply, 400, "Webhook signature verification failed");
    return { received: true };
    });
  });

  /** Recent webhook deliveries (no payloads): lets ops confirm PayPal is reaching us and signatures verify. */
  app.get("/v1/console/webhooks", { preHandler: auth("ops", "admin") }, async () => {
    const rows = await dbOf(d.pool)
      .select({
        event_id: schema.webhookEvents.eventId,
        event_type: schema.webhookEvents.eventType,
        resource_id: schema.webhookEvents.resourceId,
        verified: schema.webhookEvents.verified,
        received_at: schema.webhookEvents.receivedAt,
        processed_at: schema.webhookEvents.processedAt,
        outcome: schema.webhookEvents.outcome,
      })
      .from(schema.webhookEvents)
      .orderBy(desc(schema.webhookEvents.receivedAt))
      .limit(50);
    return { configured: Boolean(o.webhookId), events: rows };
  });

  registerConsole(app, d, auth, problem, o.console);
  registerAnalyze(app, auth, problem, { demoAi: o.console?.demoAi, demoAnalysesPerMinute: o.console?.demoAnalysesPerMinute });
  registerDisputes(app, d, auth, problem);

  // ---- public verification ----------------------------------------------------------------
  app.get<{ Querystring: { epoch?: string } }>("/v1/verify/chain", async (req) => {
    const client = await d.pool.connect();
    try {
      const proof = await verifyChain(client, req.query.epoch ? { epoch: Number(req.query.epoch) } : {});
      return { epoch: proof.epoch, valid: proof.valid, count: proof.count, head_hash: proof.head_hash, first_invalid_seq: proof.first_invalid_seq };
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>("/v1/verify/purchases/:id", async (req) => {
    const client = await d.pool.connect();
    try {
      const proof = await verifyChain(client, { purchaseId: req.params.id, ...(await epochOf(client, req.params.id)) });
      // Public: hashes and event types only, no payloads.
      return { epoch: proof.epoch, valid: proof.valid, head_hash: proof.head_hash, events: proof.events.map((e) => ({ seq: e.seq, event_type: e.event_type, at: e.at, prev_hash: e.prev_hash, hash: e.hash })) };
    } finally {
      client.release();
    }
  });

  return app;
}
