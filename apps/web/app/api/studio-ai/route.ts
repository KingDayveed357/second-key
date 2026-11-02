// One Studio-agent turn. Operators (console session) use the operator budget; anyone else uses the
// public Insights budget (ADR-0022), smaller, separate and per-visitor rate limited. Haiku only;
// the key never leaves here; the agent reads only what AG Studio passes it and can't act on anything.
import { cookies, headers } from "next/headers";
import { SESSION_COOKIE, validSession } from "../../../lib/server/session";
import { STUDIO_MODEL, allowPublicTurn, costOf, fromAnthropic, publicStudioEnabled, publicStudioMeter, studioMeter, toAnthropic, type StudioTurn } from "../../../lib/server/studio-ai";

export const dynamic = "force-dynamic";
// One prompt fans out into several turns across Studio's agents, so this has its own per-minute limit.
const PER_MINUTE = Number(process.env.WITNESS_STUDIO_AI_PER_MINUTE ?? 60);
let windowStart = 0;
let used = 0;
const problem = (status: number, title: string, detail?: string) => Response.json({ title, status, ...(detail ? { detail } : {}) }, { status });

export async function POST(req: Request) {
  const operator = validSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!operator && !publicStudioEnabled()) return problem(401, "Sign in to the console");
  const meter = operator ? studioMeter : publicStudioMeter;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return problem(503, "Studio agent not configured", "ANTHROPIC_API_KEY is not set on the web service");
  if (meter.spent >= meter.limit()) return problem(429, "Studio agent budget reached", `The ${operator ? "operator" : "public demo"} budget of $${meter.limit()} for this process is used up`);
  if (!operator) {
    const client = ((await headers()).get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "local";
    if (!allowPublicTurn(client)) return problem(429, "Slow down", "The demo agent allows a few questions a minute per visitor");
  }
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    used = 0;
  }
  if (++used > PER_MINUTE) return problem(429, "Slow down");

  const raw = await req.text();
  if (raw.length > 600_000) return problem(413, "Turn too large");
  let turn: StudioTurn;
  try {
    turn = JSON.parse(raw);
  } catch {
    return problem(400, "Invalid JSON");
  }
  if (!Array.isArray(turn.input)) return problem(400, "input must be an array");

  const body = toAnthropic(turn);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return problem(502, "Model unreachable");
  }
  const data = await res.json().catch(() => null);
  meter.calls++;
  if (!res.ok || !data) return problem(502, "Model error", data?.error?.type ?? `HTTP ${res.status}`); // never echo provider details or keys
  if (data.model && data.model !== STUDIO_MODEL) return problem(502, "Unexpected model", String(data.model));
  meter.spent += costOf(data.usage ?? {});
  return Response.json(fromAnthropic(data), { headers: { "x-witness-studio-spent-usd": meter.spent.toFixed(5) } });
}
