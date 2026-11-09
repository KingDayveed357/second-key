// SD-JWT (RFC 9901) as AP2 v0.2 uses it. A token is `issuer-jwt~disclosure~…~` with no trailing
// KB-JWT: AP2 binds delegation hops with KB-SD-JWTs instead (chain.ts). Byte conventions follow
// Google's reference SDK (code/sdk/python/ap2/sdk/sdjwt/common.py; commit in schemas/VERSION.md):
// digests and sd_hash are base64url(H(ascii)), with H from `_sd_alg` (sha-256 when absent).

import { createHash, randomBytes } from "node:crypto";
import { CompactSign, compactVerify, type CryptoKey, type JWK, type KeyObject } from "jose";
import { fail } from "./errors.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
export type VerifyKey = CryptoKey | KeyObject | JWK | Uint8Array;
export type SignKey = CryptoKey | KeyObject;

/** The only signature algorithm AP2 v0.2 keys use (schemas/ap2/types/jwk.json). */
export const SIGNING_ALG = "ES256";

const SD_ALGS = { "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512" } as const;
export type SdAlg = keyof typeof SD_ALGS;

export interface ParsedSdJwt {
  /** Issuer JWT, each disclosure and a trailing `~`: exactly the string `sd_hash` covers. */
  canonical: string;
  issuerJwt: string;
  header: JsonObject;
  /** The signed payload, before disclosures are applied. */
  payload: JsonObject;
  disclosures: string[];
}

export const b64urlJson = (part: string, what: string): JsonObject => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return fail("malformed_token", `${what} is not base64url JSON`);
  }
  if (!isObject(value)) return fail("malformed_token", `${what} is not a JSON object`);
  return value;
};

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

const B64URL = /^[A-Za-z0-9_-]+$/;

export function parseSdJwt(token: string): ParsedSdJwt {
  if (!token.includes("~")) fail("malformed_token", "an SD-JWT contains at least one '~'");
  if (token.startsWith("~")) fail("malformed_token", "an SD-JWT starts with the issuer JWT");
  const parts = token.split("~");
  const last = parts.pop()!;
  if (last !== "") fail("kb_jwt_unsupported", "AP2 tokens carry no trailing KB-JWT; delegation uses KB-SD-JWT hops");
  const [issuerJwt, ...disclosures] = parts as [string, ...string[]];
  for (const d of disclosures) if (!B64URL.test(d)) fail("malformed_token", "empty or non-base64url disclosure");
  const segs = issuerJwt.split(".");
  if (segs.length !== 3 || !segs.every((s) => B64URL.test(s))) fail("malformed_token", "issuer JWT is not header.payload.signature");
  return {
    canonical: token,
    issuerJwt,
    header: b64urlJson(segs[0]!, "JWT header"),
    payload: b64urlJson(segs[1]!, "JWT payload"),
    disclosures,
  };
}

export function sdAlgOf(payload: JsonObject): SdAlg {
  const alg = payload._sd_alg ?? "sha-256";
  if (typeof alg !== "string" || !(alg in SD_ALGS)) return fail("unsupported_sd_alg", `unsupported _sd_alg ${JSON.stringify(alg)}`);
  return alg as SdAlg;
}

/** base64url(H(ascii)). Used for disclosure digests, sd_hash, issuer_jwt_hash and checkout_hash. */
export function digest(value: string, alg: SdAlg = "sha-256"): string {
  return createHash(SD_ALGS[alg]).update(value, "ascii").digest("base64url");
}

export const sdHash = (t: ParsedSdJwt) => digest(t.canonical, sdAlgOf(t.payload));
export const issuerJwtHash = (t: ParsedSdJwt) => digest(t.issuerJwt, sdAlgOf(t.payload));

interface Disclosure {
  raw: string;
  name?: string;
  value: Json;
}

function decodeDisclosure(raw: string): Disclosure {
  let arr: unknown;
  try {
    arr = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return fail("malformed_disclosure", "disclosure is not base64url JSON");
  }
  if (!Array.isArray(arr) || typeof arr[0] !== "string") return fail("malformed_disclosure", "disclosure is not [salt, …]");
  if (arr.length === 2) return { raw, value: arr[1] as Json };
  if (arr.length === 3) {
    const name = arr[1];
    if (typeof name !== "string") return fail("malformed_disclosure", "claim name is not a string");
    if (name === "_sd" || name === "...") return fail("malformed_disclosure", `'${name}' cannot be a disclosed claim name`);
    return { raw, name, value: arr[2] as Json };
  }
  return fail("malformed_disclosure", "disclosure must have 2 or 3 elements");
}

/**
 * Apply disclosures to a signed payload (RFC 9901 §7.1): `_sd` digests become claims, `{"...": d}`
 * array elements become values, undisclosed ones are dropped. Rejects a disclosure that is
 * repeated, referenced twice or not referenced at all, and a disclosed claim that already exists.
 */
export function applyDisclosures(payload: JsonObject, disclosures: string[], alg: SdAlg): JsonObject {
  const byDigest = new Map<string, Disclosure>();
  for (const raw of disclosures) {
    const d = digest(raw, alg);
    if (byDigest.has(d)) fail("disclosure_duplicate", "the same disclosure appears twice");
    byDigest.set(d, decodeDisclosure(raw));
  }
  const used = new Set<string>();
  const take = (d: Json): Disclosure | undefined => {
    if (typeof d !== "string") return fail("malformed_token", "digest is not a string");
    const found = byDigest.get(d);
    if (found) {
      if (used.has(d)) fail("digest_reused", "a digest is referenced more than once");
      used.add(d);
    }
    return found;
  };

  const walk = (v: Json): Json => {
    if (Array.isArray(v)) {
      const out: Json[] = [];
      for (const el of v) {
        if (isObject(el) && "..." in el) {
          if (Object.keys(el).length !== 1) fail("malformed_token", "array placeholder has keys besides '...'");
          const found = take(el["..."]!);
          if (!found) continue;
          if (found.name !== undefined) fail("malformed_disclosure", "array element disclosure has a claim name");
          out.push(walk(found.value));
        } else out.push(walk(el));
      }
      return out;
    }
    if (!isObject(v)) return v;
    const out: JsonObject = {};
    for (const [k, val] of Object.entries(v)) if (k !== "_sd") out[k] = walk(val);
    const sd = v._sd;
    if (sd !== undefined) {
      if (!Array.isArray(sd)) fail("malformed_token", "_sd is not an array");
      for (const d of sd as Json[]) {
        const found = take(d);
        if (!found) continue;
        const name = found.name;
        if (name === undefined) return fail("malformed_disclosure", "object property disclosure has no claim name");
        if (name in out) fail("claim_collision", `disclosed claim '${name}' already exists`);
        out[name] = walk(found.value);
      }
    }
    return out;
  };

  const resolved = walk(payload) as JsonObject;
  delete resolved._sd_alg;
  if (used.size !== byDigest.size) fail("disclosure_unreferenced", "a disclosure is not referenced by the signed payload");
  return resolved;
}

/** Verify the issuer JWT's ES256 signature. The parsed payload is what was signed: same bytes. */
export async function verifySignature(t: ParsedSdJwt, key: VerifyKey): Promise<void> {
  if (t.header.alg !== SIGNING_ALG) fail("unsupported_alg", `alg must be ${SIGNING_ALG}, got ${JSON.stringify(t.header.alg)}`);
  try {
    await compactVerify(t.issuerJwt, key, { algorithms: [SIGNING_ALG] });
  } catch {
    fail("bad_signature", "issuer JWT signature does not verify");
  }
}

// ── Issuing ──────────────────────────────────────────────────────────────

/** Mark a value as selectively disclosable: an `_sd` claim in an object, a `{"...": d}` element in an array. */
export class Disclose {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}
export const disclose = (value: unknown) => new Disclose(value);

const salt = () => randomBytes(16).toString("base64url");

/** Turn claims containing `Disclose` markers into a signed-payload body plus disclosures (inner first). */
export function encodeDisclosures(claims: Record<string, unknown>, alg: SdAlg = "sha-256"): { payload: JsonObject; disclosures: string[] } {
  const disclosures: string[] = [];
  const make = (arr: Json[]) => {
    const raw = Buffer.from(JSON.stringify(arr), "utf8").toString("base64url");
    disclosures.push(raw);
    return digest(raw, alg);
  };
  const walk = (v: unknown): Json => {
    if (v instanceof Disclose) throw new Error("Disclose must sit directly in an object or array");
    if (Array.isArray(v)) return v.map((el) => (el instanceof Disclose ? { "...": make([salt(), walk(el.value)]) } : walk(el)));
    if (typeof v !== "object" || v === null) return v as Json;
    const out: JsonObject = {};
    const sd: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (val instanceof Disclose) sd.push(make([salt(), k, walk(val.value)]));
      else out[k] = walk(val);
    }
    if (sd.length) out._sd = sd.sort();
    return out;
  };
  const payload = walk(claims) as JsonObject;
  payload._sd_alg = alg;
  return { payload, disclosures };
}

export async function issueSdJwt(opts: {
  claims: Record<string, unknown>;
  key: SignKey;
  typ?: string;
  kid?: string;
}): Promise<string> {
  const { payload, disclosures } = encodeDisclosures(opts.claims);
  const header: { alg: string; typ?: string; kid?: string } = { alg: SIGNING_ALG };
  if (opts.typ) header.typ = opts.typ;
  if (opts.kid) header.kid = opts.kid;
  const jwt = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header).sign(opts.key);
  return [jwt, ...disclosures, ""].join("~");
}
