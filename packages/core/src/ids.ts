// Deterministic identifiers. PayPal-Request-Id values are derived, never random, so a retry
// of the same operation is recognised by PayPal as the same request.

import { createHash, randomBytes } from "node:crypto";

/** RFC 4122 version-5 UUID (SHA-1, name-based). */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`bad namespace UUID: ${namespace}`);
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fixed namespace for IDs Second Key derives. Changing it would change every request ID. */
export const WITNESS_NAMESPACE = "1b4e28ba-2fa1-5d6e-9c3b-7a1f00c0ffee";

export type MoneyOp = "create-order" | "capture" | "void" | "payout";

export const paypalRequestId = (subjectId: string, op: MoneyOp) => uuidv5(`${op}:${subjectId}`, WITNESS_NAMESPACE);

/** Opaque random IDs for rows, prefixed by kind: pur_..., int_..., apr_... */
export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
