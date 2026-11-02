// The web proxy is the browser's only door to the API: it must forward only allowlisted routes,
// attach the right role key server-side, and keep console routes behind a valid session.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RULES, allowCostly, apiBase, keyFor, match } from "../lib/server/proxy.ts";
import { checkPassword, issueSession, validSession } from "../lib/server/session.ts";

const env = { ...process.env };
beforeEach(() => {
  process.env.WITNESS_DEMO_KEY = "wk_demo";
  process.env.WITNESS_SHOPPER_KEY = "wk_shopper";
  process.env.WITNESS_OPS_KEY = "wk_ops";
  process.env.WITNESS_CONSOLE_PASSWORD = "correct horse battery";
  process.env.WITNESS_SESSION_SECRET = "s".repeat(32);
});
afterEach(() => {
  process.env = { ...env };
});

describe("proxy allowlist", () => {
  test.each([
    ["GET", "/v1/demo/scenarios", "public"],
    ["POST", "/v1/demo/scenarios/normal", "demo"],
    ["POST", "/v1/demo/screen", "demo"],
    ["GET", "/v1/purchases/pur_abc/paypal", "demo"],
    ["POST", "/v1/intents", "shopper"],
    ["POST", "/v1/intents/int_1/confirm", "shopper"],
    ["GET", "/v1/me/purchases", "shopper"],
    ["POST", "/v1/holds/pur_1/approve", "token"],
    ["GET", "/v1/console/stats", "console"],
    ["POST", "/v1/console/disputes/PP-D-1/submit", "console"],
  ])("%s %s → %s", (method, path, role) => {
    expect(match(method, path, false)?.role).toBe(role);
  });

  test.each([
    ["POST", "/v1/purchases"], // agents only: the web never submits purchases
    ["POST", "/v1/webhooks/paypal"],
    ["GET", "/v1/console/purchases/../../admin"],
    ["DELETE", "/v1/demo/scenarios"],
    ["GET", "/v1/intents/int_1/summary"],
    ["POST", "/v1/holds/pur_1/approve/extra"],
    ["GET", "/healthz"],
    ["POST", "/v1/purchases/pur_1/capture"],
  ])("%s %s is not forwarded", (method, path) => {
    expect(match(method, path, false)).toBeNull();
  });

  test("no rule could ever forward a money-moving path", () => {
    for (const r of RULES) expect(r.pattern.source).not.toMatch(/capture|void|refund|reauthorize/);
  });

  test("purchase reads use the ops key only from the signed-in console", () => {
    expect(match("GET", "/v1/purchases/pur_1", true)?.role).toBe("console");
    expect(match("GET", "/v1/purchases/pur_1", false)?.role).toBe("demo");
    expect(match("POST", "/v1/purchases/pur_1", true)).toBeNull();
  });

  test("keys come from the server environment; public and token routes carry none", () => {
    expect(keyFor("demo")).toBe("wk_demo");
    expect(keyFor("console")).toBe("wk_ops");
    expect(keyFor("public")).toBeNull();
    expect(keyFor("token")).toBeNull();
    delete process.env.WITNESS_OPS_KEY;
    expect(keyFor("console")).toBeUndefined(); // caller answers 503, never forwards keyless
  });

  // ADR-0020: the payer's credential never reaches the guardian's channel or a guardian credential.
  test.each([
    ["GET", "/v1/me/protection", "payer"],
    ["POST", "/v1/me/protection/threshold", "payer"],
    ["POST", "/v1/me/protection/guardian/revoke", "payer"],
    ["POST", "/v1/me/guardians", "payer"],
    ["POST", "/v1/me/holds/pur_1/notify", "payer"],
    ["POST", "/v1/me/demo/transfers/scam_transfer", "payer"],
    ["GET", "/v1/holds/pur_1", "payer"],
    ["GET", "/v1/demo/inboxes/SK-ABCD-EF23/messages", "inbox"],
    ["POST", "/v1/demo/inboxes/SK-ABCD-EF23/messages/ntf_1/open", "inbox"],
    ["POST", "/v1/holds/pur_1/view", "token"],
    ["POST", "/v1/holds/pur_1/verification", "token"],
  ])("Second Key: %s %s → %s", (method, path, role) => {
    expect(match(method, path, false)?.role).toBe(role);
  });

  test.each([
    ["GET", "/v1/holds/pur_1/verification"], // credentials never travel in a URL
    ["POST", "/v1/demo/payers"], // the payer key is minted server-side only (/api/sk/session)
    ["GET", "/v1/demo/inboxes/not-an-address/messages"],
    ["POST", "/v1/admin/payee-history"],
  ])("Second Key: %s %s is not forwarded", (method, path) => {
    expect(match(method, path, false)).toBeNull();
  });

  test("inbox routes carry the demo key, never a payer or shopper key; payer routes never fall back to the shared shopper", () => {
    const payerKey = `wk_${"p".repeat(32)}`;
    expect(keyFor("inbox", payerKey, true)).toBe("wk_demo");
    expect(keyFor("payer", payerKey)).toBe(payerKey);
    expect(keyFor("payer", undefined)).toBeUndefined();
    expect(keyFor("payer", "wk_shopper")).toBeUndefined();
    expect(keyFor("shopper", payerKey, true)).toBe(payerKey);
    expect(keyFor("shopper", undefined, true)).toBeUndefined();
    expect(keyFor("shopper", payerKey, false)).toBe("wk_shopper");
  });

  test("Render's private hostport gets a scheme", () => {
    process.env.WITNESS_API_URL = "witness-api:10000";
    expect(apiBase()).toBe("http://witness-api:10000");
    process.env.WITNESS_API_URL = "https://x.onrender.com/";
    expect(apiBase()).toBe("https://x.onrender.com");
  });

  test("model-spending routes are rate limited per client", () => {
    const t0 = 1_000_000;
    let ok = 0;
    for (let i = 0; i < 20; i++) if (allowCostly("1.2.3.4", t0).ok) ok++;
    expect(ok).toBe(12);
    expect(allowCostly("5.6.7.8", t0).ok).toBe(true);
    expect(allowCostly("1.2.3.4", t0 + 61_000).ok).toBe(true);
  });
});

describe("console session", () => {
  test("password check and signed, expiring cookie", () => {
    expect(checkPassword("correct horse battery")).toBe(true);
    expect(checkPassword("wrong")).toBe(false);
    const now = Date.now();
    const s = issueSession(now);
    expect(validSession(s.value, now + 1000)).toBe(true);
    expect(validSession(s.value, now + 9 * 3600_000)).toBe(false); // expired
    const [exp, mac] = s.value.split(".");
    expect(validSession(`${Number(exp) + 999999}.${mac}`, now)).toBe(false); // tampered expiry
    expect(validSession("garbage", now)).toBe(false);
  });

  test("closed when not configured", () => {
    delete process.env.WITNESS_CONSOLE_PASSWORD;
    expect(checkPassword("anything")).toBe(false);
    expect(validSession(issueSession().value)).toBe(false);
    process.env.WITNESS_CONSOLE_PASSWORD = "x";
    process.env.WITNESS_SESSION_SECRET = "short";
    expect(validSession(issueSession().value)).toBe(false);
  });
});
