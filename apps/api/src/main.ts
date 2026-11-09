// Witness API process. Holds the PayPal secret for creating and reading orders only; the
// transport refuses capture/void in this process (role "api").

import { catalogFromEnv } from "@witness/catalog";
import { ApiConfig, loadDotEnv, parseConfig } from "@witness/config";
import { createBoss, createPool, ensureQueues, migrate } from "@witness/db";
import { PayPalClient } from "@witness/paypal";
import { AnthropicProvider, UnavailableProvider, UsageMeter, approvedModel } from "@witness/ai";
import { loadReceiptSigner } from "@witness/ap2";
import { buildApp } from "./app.ts";

loadDotEnv();
const cfg = parseConfig(ApiConfig);
// Fail at startup on an unapproved model (only Haiku is allowed), never at the first purchase.
approvedModel(cfg.WITNESS_AI_MODEL);
const aiMeter = new UsageMeter({ maxCalls: cfg.WITNESS_AI_MAX_CALLS, maxSpendUsd: cfg.WITNESS_AI_MAX_SPEND_USD });
// The public "try to beat it" screen has its own, smaller budget: judge traffic can never exhaust the
// budget that screens real purchases (when it runs out, only judge screens hold).
const demoMeter = new UsageMeter({ maxCalls: Math.ceil(cfg.WITNESS_AI_MAX_CALLS / 4), maxSpendUsd: cfg.WITNESS_DEMO_AI_MAX_SPEND_USD });
const receipts = await loadReceiptSigner(cfg.SECONDKEY_VERIFIER_ISSUER, cfg.SECONDKEY_RECEIPT_JWK);
const pool = createPool(cfg.DATABASE_URL);
await migrate(pool);
const boss = createBoss(cfg.DATABASE_URL, "api");
boss.on("error", (e) => console.error("pg-boss:", e.message));
await boss.start();
await ensureQueues(boss);

const app = buildApp({
  deps: {
    pool,
    boss,
    paypal: new PayPalClient({ baseUrl: cfg.PAYPAL_BASE_URL, clientId: cfg.PAYPAL_CLIENT_ID, clientSecret: cfg.PAYPAL_CLIENT_SECRET, role: "api" }),
    catalog: catalogFromEnv(cfg),
    ai: cfg.ANTHROPIC_API_KEY
      ? new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.WITNESS_AI_MODEL, timeoutMs: cfg.WITNESS_AI_TIMEOUT_MS, maxRetries: cfg.WITNESS_AI_MAX_RETRIES, meter: aiMeter })
      : new UnavailableProvider(),
    defaultRetailers: cfg.WITNESS_DEFAULT_RETAILERS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    holdLinkMs: cfg.WITNESS_HOLD_LINK_TTL_MINUTES * 60_000,
    receipts,
    ...(cfg.SECONDKEY_DEMO_RECIPIENT_EMAIL ? { demoRecipientEmail: cfg.SECONDKEY_DEMO_RECIPIENT_EMAIL } : {}),
  },
  webhookId: cfg.PAYPAL_WEBHOOK_ID,
  demoShopperId: cfg.WITNESS_DEMO_SHOPPER_ID,
  console: {
    demoAi: cfg.ANTHROPIC_API_KEY
      ? new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.WITNESS_AI_MODEL, timeoutMs: cfg.WITNESS_AI_TIMEOUT_MS, maxRetries: cfg.WITNESS_AI_MAX_RETRIES, meter: demoMeter })
      : new UnavailableProvider(),
  },
  logger: { level: cfg.LOG_LEVEL, redact: ["req.headers.authorization"] },
});

const close = async () => {
  await app.close();
  await boss.stop({ graceful: true });
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: cfg.PORT, host: cfg.HOST });
if (receipts.ephemeral) app.log.warn("SECONDKEY_RECEIPT_JWK is not set: AP2 receipts are signed with a per-process key and stop verifying after a restart");
if (!cfg.ANTHROPIC_API_KEY) app.log.warn("ANTHROPIC_API_KEY is not set: AI checks fail closed and every purchase will HOLD");
