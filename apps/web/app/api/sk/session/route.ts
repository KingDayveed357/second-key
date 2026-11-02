// Second Key demo session (ADR-0020): each visitor gets their own demo payer, so one visitor's trusted
// contact never receives another visitor's payments and the 48 h delay is real. The payer's API key is
// minted by the API and kept only in an httpOnly cookie; the browser never sees it.
import { cookies, headers } from "next/headers";
import { PAYER_COOKIE, allowCostly, apiBase, keyFor, validPayerKey } from "../../../../lib/server/proxy";

export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: Request) {
  const jar = await cookies();
  const reset = new URL(req.url).searchParams.get("reset") === "1";
  if (!reset && validPayerKey(jar.get(PAYER_COOKIE)?.value)) return json(200, { session: "existing" });

  const h = await headers();
  const gate = allowCostly(`session:${(h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "local"}`);
  if (!gate.ok) return json(429, { title: "Slow down", detail: `Try again in ${gate.retryAfter}s` });
  const demo = keyFor("demo");
  if (!demo) return json(503, { title: "Not configured", detail: "This deployment has no demo key" });
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/demo/payers`, { method: "POST", headers: { authorization: `Bearer ${demo}` }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  } catch {
    return json(502, { title: "Second Key API unreachable" });
  }
  if (!res.ok) return json(res.status, { title: "Couldn't start a demo session" });
  const { key } = (await res.json()) as { key: string };
  const https = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  jar.set(PAYER_COOKIE, key, { httpOnly: true, secure: https, sameSite: "strict", path: "/", maxAge: 7 * 86_400 });
  return json(201, { session: "new" });
}
