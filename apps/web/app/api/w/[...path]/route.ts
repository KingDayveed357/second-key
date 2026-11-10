// Allowlisted proxy to the Witness API (see lib/server/proxy.ts for the rules).
import { cookies, headers } from "next/headers";
import { PAYER_COOKIE, allowCostly, apiBase, keyFor, match } from "../../../../lib/server/proxy";
import { SESSION_COOKIE, validSession } from "../../../../lib/server/session";

export const dynamic = "force-dynamic";

const problem = (status: number, title: string, detail?: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ title, status, ...(detail ? { detail } : {}) }), { status, headers: { "content-type": "application/problem+json", ...extra } });

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  const path = "/" + segments.map(encodeURIComponent).join("/");
  const jar = await cookies();
  const signedIn = validSession(jar.get(SESSION_COOKIE)?.value);
  const inConsole = signedIn && req.headers.get("x-witness-console") === "1";
  const rule = match(req.method, path, inConsole);
  if (!rule) return problem(404, "Not found");
  if (rule.role === "console" && !signedIn) return problem(401, "Sign in to the console");

  if (rule.costly) {
    const h = await headers();
    const client = (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "local";
    const gate = allowCostly(client);
    if (!gate.ok) return problem(429, "Slow down", `Try again in ${gate.retryAfter}s`, { "retry-after": String(gate.retryAfter) });
  }

  const asPayer = req.headers.get("x-sk-payer") === "1";
  const key = keyFor(rule.role, jar.get(PAYER_COOKIE)?.value, asPayer);
  if ((rule.role === "payer" || (rule.role === "shopper" && asPayer)) && !key) return problem(401, "Start a session", "Open the payer demo to start");
  if (key === undefined || key === "") return problem(503, "Not configured", `This deployment has no ${rule.role} key`);
  // The inbox secret is forwarded only on inbox routes; nothing else ever carries it.
  const inboxSecret = rule.role === "inbox" ? req.headers.get("x-inbox-secret") : null;
  if (rule.role === "inbox" && !inboxSecret) return problem(401, "Inbox secret required");

  const url = new URL(req.url);
  const target = `${apiBase()}${path}${url.search}`;
  const body = req.method === "POST" ? await req.text() : undefined;
  if (body && body.length > 16_384) return problem(413, "Request too large");
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(req.headers.get("idempotency-key") ? { "idempotency-key": req.headers.get("idempotency-key")! } : {}),
        ...(inboxSecret ? { "x-inbox-secret": inboxSecret } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return problem(502, "Service API unreachable");
  }
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(res.headers.get("retry-after") ? { "retry-after": res.headers.get("retry-after")! } : {}) } });
}

export const GET = forward;
export const POST = forward;
