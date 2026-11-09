// Environment configuration, validated once at startup. Values are never logged.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Load witness/.env for local development; real environments set variables directly. */
export function loadDotEnv(): void {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

const Base = z.object({
  DATABASE_URL: z.string().min(1),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_BASE_URL: z.string().default("https://api-m.sandbox.paypal.com"),
  CHANNEL3_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export const ApiConfig = Base.extend({
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  WITNESS_DEMO_SHOPPER_ID: z.string().optional(),
  /** Without it every AI check fails closed, so purchases HOLD instead of capturing. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Must be an approved model (packages/ai/src/models.ts); validated at startup. */
  WITNESS_AI_MODEL: z.string().default("claude-haiku-5-5"),
  /** Per-process ceilings: when reached, AI checks fail closed (HOLD) instead of spending more. */
  WITNESS_AI_MAX_SPEND_USD: z.coerce.number().positive().max(50).default(1),
  WITNESS_AI_MAX_CALLS: z.coerce.number().int().positive().max(100_000).default(2000),
  WITNESS_DEMO_AI_MAX_SPEND_USD: z.coerce.number().positive().max(10).default(0.25),
  WITNESS_AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  WITNESS_AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  WITNESS_DEFAULT_RETAILERS: z.string().default("rei.com,backcountry.com"),
  /** One-time reviewer link lifetime (ADR-0017). The hold itself still lasts until auto-void. */
  WITNESS_HOLD_LINK_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  /** Second Key demo: PayPal sandbox account that receives payouts for demo transfers. Unset → no payouts. */
  SECONDKEY_DEMO_RECIPIENT_EMAIL: z.email().optional(),
  /** AP2 receipt signing key: a private P-256 JWK (JSON). Unset: a per-process key, so receipts stop verifying after a restart. */
  SECONDKEY_RECEIPT_JWK: z.string().optional(),
  /** `iss` of every receipt: the verifier's public identity. */
  SECONDKEY_VERIFIER_ISSUER: z.url().default("https://witness-api.onrender.com"),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

export const WorkerConfig = Base.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

/** Parse, and on failure name the missing variables without echoing any values. */
export function parseConfig<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  // A variable left blank in a hosting dashboard arrives as "": treat it as unset, not as a value.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const r = schema.safeParse(cleaned);
  if (!r.success) {
    const names = [...new Set(r.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid configuration: check ${names} (see .env.example)`);
  }
  return r.data;
}

export { ROOT };
