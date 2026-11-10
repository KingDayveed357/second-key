// Seed the demo tenant: payee merchant, demo shopper with a saved sandbox wallet, and API keys.
// Keys are written to WITNESS_KEYS_FILE (default .secondkey/dev-keys.json, gitignored) and never printed.
//
// Needs: DATABASE_URL, PAYPAL_MERCHANT_ID (the sandbox Business account's merchant ID, the payee
// every order must pay), and a vault ID from WITNESS_DEMO_VAULT_ID or spikes/out/vault.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "@witness/core";
import { loadDotEnv, ROOT } from "@witness/config";
import { createApiKey, createPool, migrate } from "@witness/db";

loadDotEnv();
const url = process.env.DATABASE_URL;
const merchant = process.env.PAYPAL_MERCHANT_ID;
const vaultFile = join(ROOT, "spikes", "out", "vault.json");
const vaultId = process.env.WITNESS_DEMO_VAULT_ID ?? (existsSync(vaultFile) ? JSON.parse(readFileSync(vaultFile, "utf8")).vaultId : undefined);
if (!url || !merchant || !vaultId) {
  console.error(`Missing: ${[!url && "DATABASE_URL", !merchant && "PAYPAL_MERCHANT_ID", !vaultId && "WITNESS_DEMO_VAULT_ID (or spikes/out/vault.json)"].filter(Boolean).join(", ")}`);
  process.exit(1);
}

const pool = createPool(url);
await migrate(pool, console.log);
const tenantId = newId("ten");
const shopperId = newId("shp");
await pool.query("INSERT INTO tenants (id, name, paypal_merchant_id) VALUES ($1, 'Second Key Demo MoR', $2)", [tenantId, merchant]);
await pool.query("INSERT INTO shoppers (id, tenant_id, display_name, vault_id) VALUES ($1, $2, 'Rose', $3)", [shopperId, tenantId, vaultId]);
// ADR-0020: "paid before" is recorded history, never an assertion. The demo shopper has paid Morgan & Sons
// (the contractor scenario), with and without the demo recipient email the deployment may configure.
const recipient = process.env.SECONDKEY_DEMO_RECIPIENT_EMAIL;
for (const key of ["id:payee_morgan_sons", ...(recipient ? [`email:${recipient.trim().toLowerCase()}#id:payee_morgan_sons`] : [])]) {
  await pool.query("INSERT INTO payee_history (tenant_id, shopper_id, payee_key, first_paid_at, source) VALUES ($1, $2, $3, now(), 'imported') ON CONFLICT DO NOTHING", [tenantId, shopperId, key]);
}

const keys = {
  tenant_id: tenantId,
  demo_shopper_id: shopperId,
  agent: (await createApiKey(pool, tenantId, "agent:demo", ["agent:purchase"])).key,
  shopper: (await createApiKey(pool, tenantId, `shopper:${shopperId}`, ["shopper"])).key,
  ops: (await createApiKey(pool, tenantId, "ops:dave", ["ops"])).key,
  demo: (await createApiKey(pool, tenantId, "demo", ["demo"])).key,
  admin: (await createApiKey(pool, tenantId, "admin", ["admin", "ops"])).key,
};
const keysFile = process.env.WITNESS_KEYS_FILE ?? join(ROOT, ".secondkey", "dev-keys.json");
mkdirSync(dirname(keysFile), { recursive: true });
writeFileSync(keysFile, JSON.stringify(keys, null, 2));
await pool.end();
console.log(`Seeded tenant ${tenantId}, demo shopper ${shopperId}. API keys written to ${keysFile} (not printed).`);
console.log(`Set WITNESS_DEMO_SHOPPER_ID=${shopperId} for the API's demo scenarios.`);
