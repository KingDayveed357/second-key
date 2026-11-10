// Admin: reset the demo (architecture "Demo reset without breaking the chain"). Releases every held
// authorization (the executor voids it on PayPal) and starts a new audit epoch; deletes nothing.
//   WITNESS_API=https://... WITNESS_KEYS_FILE=.secondkey/render-keys.json pnpm demo:reset
// Uses the admin key from the keys file; never prints it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@witness/config";

const base = process.env.WITNESS_API ?? "http://127.0.0.1:4000";
const keys = JSON.parse(readFileSync(process.env.WITNESS_KEYS_FILE ?? join(ROOT, ".secondkey", "dev-keys.json"), "utf8"));
const res = await fetch(`${base}/v1/demo/reset`, { method: "POST", headers: { authorization: `Bearer ${keys.admin}` } });
console.log(`HTTP ${res.status}: ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
