// The browser's only door to the Witness API. NOT an open proxy: each forwarded route is listed
// below with the role whose API key is attached server-side. Keys never leave this process.
//
//   public  - no key (public API routes)
//   demo    - WITNESS_DEMO_KEY (judge scenarios, judge screen, aggregate stats)
//   shopper - WITNESS_SHOPPER_KEY (the shared demo shopper: intents, receipts, hold links), or the
//             visitor's own demo payer key from the httpOnly session cookie when the request says so
//   payer   - the visitor's own demo payer key only (Second Key, ADR-0020); never the shared key
//   token   - no key; the hold credential travels in the POST body, never in a URL
//   inbox   - WITNESS_DEMO_KEY plus the x-inbox-secret header the guardian's window sends. The payer's
//             key is never attached, so no payer route can read guardian messages or credentials
//   console - WITNESS_OPS_KEY, and only with a valid console session cookie
import "server-only";

export type Role = "public" | "demo" | "shopper" | "payer" | "token" | "inbox" | "console";

interface Rule {
  method: "GET" | "POST";
  pattern: RegExp;
  role: Role;
  /** Requests that cost a model call are rate limited per client. */
  costly?: boolean;
}

const ID = "[A-Za-z0-9_-]{1,64}";
export const RULES: Rule[] = [
  { method: "GET", pattern: /^\/v1\/demo\/scenarios$/, role: "public" },
  { method: "POST", pattern: new RegExp(`^/v1/demo/scenarios/${ID}$`), role: "demo", costly: true },
  { method: "GET", pattern: /^\/v1\/demo\/stats$/, role: "demo" },
  { method: "GET", pattern: /^\/v1\/demo\/incidents$/, role: "demo" },
  { method: "POST", pattern: /^\/v1\/demo\/screen$/, role: "demo", costly: true },
  { method: "GET", pattern: /^\/v1\/demo\/samples$/, role: "public" },
  { method: "POST", pattern: /^\/v1\/demo\/analyze$/, role: "demo", costly: true },
  { method: "GET", pattern: new RegExp(`^/v1/purchases/${ID}$`), role: "demo" },
  { method: "GET", pattern: new RegExp(`^/v1/purchases/${ID}/paypal$`), role: "demo" },
  { method: "GET", pattern: new RegExp(`^/v1/purchases/${ID}/evidence$`), role: "demo" },
  { method: "GET", pattern: /^\/v1\/verify\/chain$/, role: "public" },
  { method: "GET", pattern: new RegExp(`^/v1/verify/purchases/${ID}$`), role: "public" },

  { method: "POST", pattern: /^\/v1\/intents$/, role: "shopper", costly: true },
  { method: "GET", pattern: new RegExp(`^/v1/intents/${ID}$`), role: "shopper" },
  { method: "POST", pattern: new RegExp(`^/v1/intents/${ID}/(confirm|revoke)$`), role: "shopper" },
  { method: "GET", pattern: /^\/v1\/me\/purchases$/, role: "shopper" },
  { method: "POST", pattern: new RegExp(`^/v1/purchases/${ID}/hold-link$`), role: "shopper" },
  { method: "POST", pattern: new RegExp(`^/v1/me/purchases/${ID}/context$`), role: "shopper", costly: true },
  { method: "POST", pattern: new RegExp(`^/v1/me/purchases/${ID}/feedback$`), role: "shopper" },
  { method: "POST", pattern: new RegExp(`^/v1/me/holds/${ID}/cancel$`), role: "shopper" },

  // Second Key payer (ADR-0020): the standing profile, reminders, and the payer's own view of a hold.
  // None of these returns a guardian credential or message.
  { method: "GET", pattern: /^\/v1\/me\/protection$/, role: "payer" },
  { method: "POST", pattern: /^\/v1\/me\/protection\/(threshold|guardian|guardian\/remove|guardian\/revoke)$/, role: "payer" },
  { method: "POST", pattern: new RegExp(`^/v1/me/protection/changes/${ID}/cancel$`), role: "payer" },
  { method: "POST", pattern: /^\/v1\/me\/guardians$/, role: "payer" },
  { method: "POST", pattern: new RegExp(`^/v1/me/holds/${ID}/notify$`), role: "payer" },
  { method: "POST", pattern: new RegExp(`^/v1/me/demo/transfers/${ID}$`), role: "payer", costly: true },
  { method: "GET", pattern: new RegExp(`^/v1/holds/${ID}$`), role: "payer" },

  // AP2 agent demo: Rose's browser signs her open mandates with its own key; the visitor's payer key runs them.
  { method: "GET", pattern: /^\/v1\/demo\/ap2\/setup$/, role: "public" },
  // "Run a test verification" (/developers): no account, no key; stores nothing; can run the AI listing check.
  { method: "POST", pattern: /^\/v1\/demo\/ap2\/test-verification$/, role: "public", costly: true },
  { method: "POST", pattern: /^\/v1\/me\/demo\/ap2\/surface$/, role: "payer" },
  { method: "POST", pattern: new RegExp(`^/v1/me/demo/ap2/runs/${ID}$`), role: "payer", costly: true },
  { method: "GET", pattern: new RegExp(`^/v1/me/demo/ap2/settlements/${ID}$`), role: "payer" },
  { method: "GET", pattern: /^\/\.well-known\/jwks\.json$/, role: "public" },

  // The guardian's demo channel: readable only with the inbox secret held by the guardian's window.
  { method: "POST", pattern: /^\/v1\/demo\/inboxes$/, role: "demo", costly: true },
  { method: "GET", pattern: /^\/v1\/demo\/inboxes\/SK-[A-Z0-9]{4}-[A-Z0-9]{4}\/messages$/, role: "inbox" },
  { method: "POST", pattern: new RegExp(`^/v1/demo/inboxes/SK-[A-Z0-9]{4}-[A-Z0-9]{4}/messages/${ID}/(open|accept)$`), role: "inbox" },

  // The reviewer: the credential travels in the POST body only.
  { method: "POST", pattern: new RegExp(`^/v1/holds/${ID}/(view|verification)$`), role: "token" },
  { method: "POST", pattern: new RegExp(`^/v1/holds/${ID}/(approve|deny)$`), role: "token" },

  { method: "GET", pattern: /^\/v1\/console\/(purchases|holds|stats|webhooks)$/, role: "console" },
  { method: "GET", pattern: new RegExp(`^/v1/console/purchases/${ID}/checks$`), role: "console" },
  { method: "GET", pattern: new RegExp(`^/v1/console/disputes$`), role: "console" },
  { method: "POST", pattern: /^\/v1\/console\/disputes$/, role: "console" },
  { method: "POST", pattern: new RegExp(`^/v1/console/disputes/${ID}/(refresh|submit|sandbox-step)$`), role: "console" },
  { method: "POST", pattern: new RegExp(`^/v1/purchases/${ID}/dispute-evidence/draft$`), role: "console", costly: true },
];

/** Same path read by ops in the console uses the ops key instead of the demo key. */
const CONSOLE_READS = [new RegExp(`^/v1/purchases/${ID}(/paypal|/evidence)?$`)];

export function match(method: string, path: string, inConsole: boolean): Rule | null {
  if (inConsole && method === "GET" && CONSOLE_READS.some((p) => p.test(path))) return { method: "GET", pattern: /./, role: "console" };
  return RULES.find((r) => r.method === method && r.pattern.test(path)) ?? null;
}

export function apiBase(): string {
  const raw = process.env.WITNESS_API_URL ?? "http://127.0.0.1:4000";
  // Render's private-network `hostport` has no scheme.
  return /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : `http://${raw}`;
}

/** A visitor's own demo payer key, as kept in the httpOnly session cookie (ADR-0020). */
export const PAYER_COOKIE = "sk_payer";
export const validPayerKey = (k: string | undefined): k is string => typeof k === "string" && /^wk_[A-Za-z0-9_-]{32}$/.test(k);

/**
 * The key for a role. `payerKey` is the visitor's session payer key (if any); `asPayer` is true when the
 * Second Key client asked to act as that payer on a shared shopper route.
 */
export function keyFor(role: Role, payerKey?: string, asPayer = false): string | null | undefined {
  switch (role) {
    case "payer":
      return validPayerKey(payerKey) ? payerKey : undefined;
    case "demo":
    case "inbox":
      return process.env.WITNESS_DEMO_KEY;
    case "shopper":
      if (asPayer) return validPayerKey(payerKey) ? payerKey : undefined;
      return process.env.WITNESS_SHOPPER_KEY;
    case "console":
      return process.env.WITNESS_OPS_KEY;
    default:
      return null; // public and token routes carry no key
  }
}

// Simple per-client limiter for routes that spend model calls (in-memory, per process).
const WINDOW_MS = 60_000;
const COSTLY_PER_WINDOW = Number(process.env.WITNESS_WEB_COSTLY_PER_MINUTE ?? 12);
const hits = new Map<string, { start: number; n: number }>();
export function allowCostly(client: string, now = Date.now()): { ok: boolean; retryAfter: number } {
  const h = hits.get(client);
  if (!h || now - h.start >= WINDOW_MS) {
    hits.set(client, { start: now, n: 1 });
    if (hits.size > 10_000) hits.clear();
    return { ok: true, retryAfter: 0 };
  }
  if (h.n >= COSTLY_PER_WINDOW) return { ok: false, retryAfter: Math.ceil((h.start + WINDOW_MS - now) / 1000) };
  h.n++;
  return { ok: true, retryAfter: 0 };
}
