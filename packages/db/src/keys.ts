// API keys: 192-bit random secrets, shown once, stored as SHA-256 (a fast hash is appropriate for
// high-entropy keys; slow password hashes are for low-entropy human passwords).

import { createHash, randomBytes } from "node:crypto";
import { newId } from "@witness/core";
import type pg from "pg";

export const SCOPES = ["agent:purchase", "shopper", "ops", "demo", "admin", "ap2:verify"] as const;
export type Scope = (typeof SCOPES)[number];

export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export async function createApiKey(pool: pg.Pool, tenantId: string, principal: string, scopes: Scope[]): Promise<{ id: string; key: string }> {
  const id = newId("key");
  const key = `wk_${randomBytes(24).toString("base64url")}`;
  await pool.query("INSERT INTO api_keys (id, tenant_id, principal, scopes, key_hash) VALUES ($1, $2, $3, $4, $5)", [id, tenantId, principal, scopes, hashKey(key)]);
  return { id, key };
}

export async function lookupApiKey(pool: pg.Pool, key: string): Promise<{ tenantId: string; principal: string; scopes: string[] } | null> {
  if (!/^wk_[A-Za-z0-9_-]{32}$/.test(key)) return null;
  const { rows } = await pool.query<{ tenant_id: string; principal: string; scopes: string[] }>(
    "SELECT tenant_id, principal, scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [hashKey(key)],
  );
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, principal: r.principal, scopes: r.scopes } : null;
}
