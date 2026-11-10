// Minimal PayPal REST client for the Second Key spikes.
// Zero dependencies (Node >= 20.12). Every request and response is written to
// spikes/out/ so each spike leaves real evidence behind, not just console text.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT_DIR = join(ROOT, "spikes", "out");

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // No .env file: fall back to the real environment.
}

export const BASE_URL = process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
export const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
export const RETURN_URL = process.env.WITNESS_RETURN_URL ?? "https://example.com/witness/return";
export const CANCEL_URL = process.env.WITNESS_CANCEL_URL ?? "https://example.com/witness/cancel";

// Safety: these scripts move money. Refuse anything that is not the sandbox host exactly.
const SANDBOX_HOST = "api-m.sandbox.paypal.com";
let parsedBase;
try {
  parsedBase = new URL(BASE_URL);
} catch {
  throw new Error(`Refusing to run: PAYPAL_BASE_URL is not a valid URL.`);
}
if (parsedBase.protocol !== "https:" || parsedBase.hostname !== SANDBOX_HOST) {
  throw new Error(`Refusing to run against ${parsedBase.origin}: spikes are sandbox-only (${SANDBOX_HOST}).`);
}

export class PayPalError extends Error {
  constructor(label, status, data, debugId) {
    const issue = data?.details?.[0]?.issue ?? data?.name ?? data?.error ?? "UNKNOWN";
    const description = data?.details?.[0]?.description ?? data?.message ?? data?.error_description ?? "";
    super(`${label}: HTTP ${status} ${issue} ${description}`.trim());
    this.status = status;
    this.issue = issue;
    this.data = data;
    this.debugId = debugId;
  }
}

let cachedToken = null;

export async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (copy .env.example).");
  }
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new PayPalError("oauth2/token", res.status, data, res.headers.get("paypal-debug-id"));
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, scope: data.scope };
  return cachedToken.value;
}

export function tokenScopes() {
  return cachedToken?.scope?.split(" ") ?? [];
}

let seq = 0;

function record(label, entry) {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(OUT_DIR, `${stamp}-${String(++seq).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

/**
 * Call the PayPal REST API.
 * - POST requests get a PayPal-Request-Id (idempotency key) unless one is passed.
 * - `form` sends multipart/form-data with the JSON in a part named "input".
 * - Throws PayPalError on non-2xx unless `allowFail` is set.
 */
export async function paypal(method, path, { body, form, headers = {}, label = path, allowFail = false, requestId } = {}) {
  const token = await getAccessToken();
  const reqHeaders = { Authorization: `Bearer ${token}`, ...headers };
  if (method !== "GET") reqHeaders["PayPal-Request-Id"] = requestId ?? randomUUID();

  let payload;
  if (form) {
    const fd = new FormData();
    fd.append("input", new Blob([JSON.stringify(form)], { type: "application/json" }), "input.json");
    payload = fd; // fetch sets the multipart boundary itself
  } else if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, { method, headers: reqHeaders, body: payload });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  const debugId = res.headers.get("paypal-debug-id");

  const redacted = { ...reqHeaders, Authorization: "Bearer <redacted>" };
  const file = record(label, {
    request: { method, path, headers: redacted, body: body ?? form ?? null },
    response: { status: res.status, debugId, data },
  });

  if (!res.ok && !allowFail) {
    const err = new PayPalError(label, res.status, data, debugId);
    err.file = file;
    throw err;
  }
  return { ok: res.ok, status: res.status, data, debugId, file };
}

export function link(resource, rel) {
  return resource?.links?.find((l) => l.rel === rel)?.href ?? null;
}

export function hasLink(resource, rel) {
  const want = rel.replace(/-/g, "_");
  return Boolean(resource?.links?.some((l) => l.rel.replace(/-/g, "_") === want));
}

export function saveJson(name, value) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export function loadJson(name) {
  const file = join(OUT_DIR, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` returns a truthy value or the timeout passes. */
export async function pollUntil(check, { everyMs = 3000, timeoutMs = 10 * 60_000, onWait } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    onWait?.();
    await sleep(everyMs);
  }
}

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}
