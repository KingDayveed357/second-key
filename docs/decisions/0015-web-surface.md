# 0015: The web surface: a server-side key proxy, a closed-by-default console, and the Studio agent on Haiku

> The product was called **Witness** when this was written and is now **Second Key**. The decision is unchanged unless a later ADR says otherwise.

Status: **Implemented** (Stage 5, 2026-10-13)

## Context

Stage 5 adds `apps/web`: the judge page, the shopper page, the phone HOLD approval page and the AG Studio ops console. Judges must be able to run everything from a URL with no setup. The API authenticates with bearer keys per role (agent, shopper, ops, demo, admin), and none of those keys may reach a browser.

The boilerplate named in the build plan (PayPal's AG Grid starter) mainly provides PayPal SDK samples. Witness's API already owns every PayPal call, so `apps/web` starts from plain Next.js 16 / React 19, the same stack as the boilerplate (ADR-0006), with no PayPal dependency at all.

## Decision

1. **The browser talks only to `/api/w/*` on the web host.** That route is an allowlist, not an open proxy. Each forwarded method and path pattern names the role whose key the server attaches:
   - `public`: no key;
   - `demo`: judge scenarios, the judge screen and aggregate stats;
   - `shopper`: the shared demo shopper's intents, receipts and hold links;
   - `token`: the one-time hold token travels in the request;
   - `console`: the ops key, used only with a valid console session.

   These are not forwardable: purchase submission (agents only), webhooks, intent summaries, and any capture, void or refund path. A test asserts this. The architecture checker already forbids `apps/web` from importing PayPal, the database or the executor.
2. **The console is closed unless configured.** It needs `WITNESS_CONSOLE_PASSWORD` and a 16+ character `WITNESS_SESSION_SECRET`. Sign-in uses a constant-time password check and an HMAC-signed, httpOnly, SameSite=Lax cookie that expires after 8 hours. The cookie is marked Secure whenever the request arrived over HTTPS. The console is read-only: it cannot approve on a shopper's behalf, capture or void (architecture §2).
3. **Model spend from public traffic is bounded twice:**
   - the web proxy rate-limits model-spending routes per client (12 per minute by default);
   - the API's judge screen has its own spend cap (`WITNESS_DEMO_AI_MAX_SPEND_USD`, default $0.25), separate from the budget that screens real purchases. Judge traffic can exhaust only itself, and then judge screens fail closed (HOLD).
4. **The Studio agent (AG Studio Agent Framework) uses Haiku through a server route.** AG Studio's built-in agents call a client-side adapter, which posts each turn to `/api/studio-ai`. That route:
   - requires the console session;
   - translates the turn to Anthropic's Messages API with the one approved model, rejecting any response from another model;
   - caches the stable prefix (instructions and tools);
   - enforces a per-process spend cap (`WITNESS_STUDIO_AI_MAX_SPEND_USD`, default $0.50) and its own rate limit.

   The agent sees only the console data that AG Studio passes it. It has no route to the Witness API or to PayPal.
5. **One-time hold tokens** are removed from the address bar and history as soon as the page has read them.
6. **The judge screen ("try to beat it")** runs the real `evaluateScreen` against the demo policy on a judge-written listing. Its input is strict: unknown fields are rejected, and sizes are capped. It creates no purchase and makes no PayPal call. A test checks the purchase count and the fake PayPal call log before and after.
7. **Demo reset is admin-only** (`POST /v1/demo/reset`, `pnpm demo:reset`). It is not reachable from the web app. It revokes the intents of held purchases, so the executor voids their authorizations on PayPal, then starts a new audit epoch. Nothing is deleted, and earlier epochs stay verifiable. The judge page's own "Reset page" only clears what that page shows.

## Consequences

- **The demo shopper is shared.** Anyone with the URL acts as the demo shopper and can approve a HOLD, which captures in the sandbox. That is the point of the demo, and it is sandbox-only (ADR-0001).
- **Limiters and spend meters are per process and in memory.** A restart resets them. That is acceptable for a single-instance demo; a production deployment would move them to shared storage.
- **AG Studio needs a licence that covers judging (ADR-0009).** Without one it runs in trial mode with a watermark. The built-in agents worked in trial mode on 2026-10-13. Whether a production licence includes the AI module is still unknown.
