// AP2 delegated verification (strategy doc §5). A merchant or processor delegate posts the presented
// mandate chains; the answer is a decision plus signed receipts anyone can check against our JWKS.
// Nothing here moves money: a settlement is bound here and captured or voided by the worker's executor.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { jwksOf } from "@witness/ap2";
import { bindSettlement, getAp2Verification, getSettlement, verifyAp2, type EngineDeps } from "@witness/engine";

type Auth = (...scopes: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Problem = (reply: FastifyReply, status: number, title: string, detail?: string) => FastifyReply;

export function registerVerifier(app: FastifyInstance, d: EngineDeps, auth: Auth, problem: Problem) {
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    if (!d.receipts) return problem(reply, 503, "Receipt signing is not configured");
    return reply.header("cache-control", "public, max-age=300").send(jwksOf([d.receipts]));
  });

  app.post("/v2/verifications", { preHandler: auth("ap2:verify", "admin") }, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[\x21-\x7e]{8,200}$/.test(key)) return problem(reply, 422, "Idempotency-Key header required", "8 to 200 printable characters");
    const r = await verifyAp2(d, req.principal!, key, req.body);
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    if (r.replay) reply.header("idempotent-replayed", "true");
    return reply.code(r.replay ? 200 : 201).header("location", `/v2/verifications/${r.body.verification_id}`).send(r.body);
  });

  app.post("/v2/settlements", { preHandler: auth("ap2:verify", "admin") }, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[\x21-\x7e]{8,200}$/.test(key)) return problem(reply, 422, "Idempotency-Key header required", "8 to 200 printable characters");
    const r = await bindSettlement(d, req.principal!, key, req.body);
    if (r.kind === "error") return problem(reply, r.status, r.title, r.detail);
    if (r.replay) reply.header("idempotent-replayed", "true");
    return reply.code(r.status).header("location", `/v2/settlements/${r.body.settlement_id}`).send(r.body);
  });

  app.get<{ Params: { id: string } }>("/v2/settlements/:id", { preHandler: auth("ap2:verify", "admin") }, async (req, reply) => {
    const s = await getSettlement(d, req.principal!, req.params.id);
    return s ?? problem(reply, 404, "Settlement not found");
  });

  app.get<{ Params: { id: string } }>("/v2/verifications/:id", { preHandler: auth("ap2:verify", "admin") }, async (req, reply) => {
    const v = await getAp2Verification(d, req.principal!, req.params.id);
    return v ?? problem(reply, 404, "Verification not found");
  });
}
