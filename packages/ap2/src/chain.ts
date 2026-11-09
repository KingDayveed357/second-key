// Delegate SD-JWT chains (draft-gco-oauth-delegate-sd-jwt-00 §6) as AP2 v0.2 joins them: hops
// separated by `~~`. Hop 0 is the root SD-JWT, verified with the issuer's key. Every later hop is a
// KB-SD-JWT signed by the previous hop's `cnf.jwk` and bound to it by `sd_hash` (the previous hop's
// exact disclosures) or `issuer_jwt_hash` (its issuer JWT only). Mirrors the reference SDK's
// sdjwt/chain.py and kb_sd_jwt.py, with the stricter choices noted inline.

import { importJWK, type JWK } from "jose";
import { fail } from "./errors.ts";
import {
  applyDisclosures,
  disclose,
  isObject,
  issueSdJwt,
  issuerJwtHash,
  parseSdJwt,
  sdAlgOf,
  sdHash,
  verifySignature,
  type JsonObject,
  type ParsedSdJwt,
  type SignKey,
  type VerifyKey,
} from "./sdjwt.ts";

export const TYP_TERMINAL = ["kb+sd-jwt", "kb-sd-jwt"];
export const TYP_INTERMEDIATE = ["kb+sd-jwt+kb", "kb-sd-jwt+kb"];
const KB_TYPS = [...TYP_TERMINAL, ...TYP_INTERMEDIATE];

/** Resolve the root issuer's key from the root header (`kid`). x5c chains are not supported yet. */
export type RootKeyResolver = (header: JsonObject) => VerifyKey | undefined | Promise<VerifyKey | undefined>;

export interface VerifyChainOptions {
  rootKey: RootKeyResolver;
  /** Checked on the last hop when given. A verifier that skips them accepts replays. */
  aud?: string;
  nonce?: string;
  /** Unix seconds; defaults to now. */
  now?: number;
  clockSkewSeconds?: number;
}

export interface VerifiedHop {
  index: number;
  token: ParsedSdJwt;
  typ: string | undefined;
  /** The hop's payload with its disclosures applied. */
  claims: JsonObject;
  /** The disclosed `delegate_payload` items: the mandates this hop carries. */
  items: JsonObject[];
  binding?: { claim: "sd_hash" | "issuer_jwt_hash"; value: string };
}

/** Split a `~~`-joined chain, restoring the trailing `~` the join removed from each earlier hop. */
export function splitChain(serialized: string): ParsedSdJwt[] {
  const segments = serialized.split("~~");
  return segments.map((s, i) => parseSdJwt(i < segments.length - 1 && !s.endsWith("~") ? s + "~" : s));
}

/** Join hops the way the reference SDK's `present()` does. */
export function joinChain(tokens: string[]): string {
  return tokens.map((t, i) => (i < tokens.length - 1 && t.endsWith("~") ? t.slice(0, -1) : t)).join("~~");
}

function delegateItems(claims: JsonObject, index: number, requireSingle: boolean): JsonObject[] {
  const dp = claims.delegate_payload;
  if (dp === undefined) return [];
  if (!Array.isArray(dp)) return fail("delegate_payload_invalid", `hop ${index}: delegate_payload is not an array`);
  const items = dp.filter(isObject);
  if (items.length !== dp.length) fail("delegate_payload_invalid", `hop ${index}: delegate_payload holds a non-object`);
  if (requireSingle && items.length !== 1) fail("delegate_payload_invalid", `hop ${index}: expected exactly 1 disclosed delegate item, got ${items.length}`);
  return items;
}

/** The key the next hop must be signed with: the single delegate item's `cnf.jwk`, else the hop's own. */
export function cnfJwkOf(hop: Pick<VerifiedHop, "claims" | "items">): JWK | undefined {
  for (const src of [...hop.items, hop.claims]) {
    const cnf = src.cnf;
    if (isObject(cnf) && isObject(cnf.jwk)) return cnf.jwk as JWK;
  }
  return undefined;
}

async function importCnf(jwk: JWK, index: number) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string")
    fail("cnf_invalid", `hop ${index - 1}: cnf.jwk must be an EC P-256 public key`);
  // A private key in cnf means the delegate's signing key has been published: reject the chain.
  if ("d" in jwk) fail("cnf_invalid", `hop ${index - 1}: cnf.jwk contains a private key`);
  try {
    return await importJWK({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, "ES256");
  } catch {
    return fail("cnf_invalid", `hop ${index - 1}: cnf.jwk is not a valid P-256 point`);
  }
}

function checkTimes(objs: JsonObject[], index: number, now: number, skew: number) {
  for (const o of objs) {
    for (const k of ["exp", "iat", "nbf"] as const) {
      if (o[k] !== undefined && typeof o[k] !== "number") fail("malformed_token", `hop ${index}: '${k}' is not a number`);
    }
    if (typeof o.exp === "number" && now > o.exp + skew) fail("expired", `hop ${index} expired at ${o.exp}`);
    if (typeof o.iat === "number" && o.iat > now + skew) fail("not_yet_valid", `hop ${index}: iat is in the future`);
    if (typeof o.nbf === "number" && o.nbf > now + skew) fail("not_yet_valid", `hop ${index}: not valid before ${o.nbf}`);
  }
}

/** Exactly one of sd_hash / issuer_jwt_hash, equal to the previous hop's hash. */
export function checkBinding(claims: JsonObject, prev: ParsedSdJwt, index: number): NonNullable<VerifiedHop["binding"]> {
  const hasSd = "sd_hash" in claims;
  const hasIss = "issuer_jwt_hash" in claims;
  if (hasSd === hasIss) fail("binding_missing", `hop ${index}: needs exactly one of sd_hash or issuer_jwt_hash`);
  const claim = hasSd ? "sd_hash" : "issuer_jwt_hash";
  const expected = hasSd ? sdHash(prev) : issuerJwtHash(prev);
  if (claims[claim] !== expected) fail("binding_mismatch", `hop ${index}: ${claim} does not match hop ${index - 1}`);
  return { claim, value: expected };
}

/** Verify one hop's signature and disclosures; returns its resolved claims and delegate items. */
export async function openHop(token: ParsedSdJwt, key: VerifyKey, index: number, requireSingle: boolean) {
  await verifySignature(token, key);
  const claims = applyDisclosures(token.payload, token.disclosures, sdAlgOf(token.payload));
  return { claims, items: delegateItems(claims, index, requireSingle) };
}

export async function verifyChain(serialized: string, opts: VerifyChainOptions): Promise<VerifiedHop[]> {
  const tokens = splitChain(serialized);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSeconds ?? 300;
  const hops: VerifiedHop[] = [];

  for (const [i, token] of tokens.entries()) {
    const last = i === tokens.length - 1;
    const typ = typeof token.header.typ === "string" ? token.header.typ : undefined;
    let key: VerifyKey;
    if (i === 0) {
      if (typ && KB_TYPS.includes(typ)) fail("typ_invalid", "the root of a chain cannot be a KB-SD-JWT");
      const k = await opts.rootKey(token.header);
      if (!k) return fail("root_key_unavailable", `no key for root issuer ${JSON.stringify(token.header.kid ?? null)}`);
      key = k;
    } else {
      if (!typ || !KB_TYPS.includes(typ)) fail("typ_invalid", `hop ${i}: typ must be one of ${KB_TYPS.join(", ")}`);
      const jwk = cnfJwkOf(hops[i - 1]!);
      if (!jwk) return fail("cnf_missing", `hop ${i - 1} carries no cnf.jwk to verify hop ${i}`);
      key = await importCnf(jwk, i);
    }

    // The reference SDK lets only the last hop carry several delegate items; the root always one.
    const { claims, items } = await openHop(token, key, i, i === 0 || !last);
    const hop: VerifiedHop = { index: i, token, typ, claims, items };

    if (i > 0) {
      hop.binding = checkBinding(claims, tokens[i - 1]!, i);
      // Stricter than the SDK, which checks iat only on terminal hops: every KB hop is dated.
      if (typeof claims.iat !== "number") fail("iat_missing", `hop ${i}: KB-SD-JWT requires iat`);
      const terminal = TYP_TERMINAL.includes(typ!);
      const hasCnf = items.some((it) => isObject(it.cnf));
      if (terminal && hasCnf) fail("cnf_forbidden", `hop ${i}: a terminal KB-SD-JWT must not delegate further (cnf)`);
      if (!terminal && !hasCnf) fail("cnf_missing", `hop ${i}: an intermediate KB-SD-JWT must carry cnf`);
      if (last && terminal) {
        if (opts.aud !== undefined && claims.aud !== opts.aud) fail("aud_mismatch", `hop ${i}: aud is not ${opts.aud}`);
        if (opts.nonce !== undefined && claims.nonce !== opts.nonce) fail("nonce_mismatch", `hop ${i}: nonce does not match`);
      }
    }
    checkTimes([claims, ...items], i, now, skew);
    hops.push(hop);
  }
  return hops;
}

/**
 * Append a KB-SD-JWT hop to `chain` (a root token or an existing chain), signed with the key bound
 * in the last hop's `cnf`. A mandate carrying `cnf` makes an intermediate hop, otherwise terminal.
 * `sd_hash` commits to the previous hop exactly as sent; `issuer_jwt_hash` lets later holders drop
 * its disclosures.
 */
export async function presentHop(opts: {
  chain: string;
  key: SignKey;
  /** The mandate this hop carries; `Disclose` markers inside it become nested disclosures. */
  mandate: Record<string, unknown>;
  aud: string;
  nonce: string;
  hashMode?: "sd_hash" | "issuer_jwt_hash";
  iat?: number;
}): Promise<string> {
  if (!opts.aud || !opts.nonce) throw new Error("aud and nonce are required for a KB-SD-JWT hop");
  const tokens = splitChain(opts.chain);
  const prev = tokens[tokens.length - 1]!;
  const mode = opts.hashMode ?? "sd_hash";
  const hop = await issueSdJwt({
    key: opts.key,
    typ: "cnf" in opts.mandate ? TYP_INTERMEDIATE[0] : TYP_TERMINAL[0],
    claims: {
      delegate_payload: [disclose(opts.mandate)],
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      aud: opts.aud,
      nonce: opts.nonce,
      [mode]: mode === "sd_hash" ? sdHash(prev) : issuerJwtHash(prev),
    },
  });
  return joinChain([...tokens.map((t) => t.canonical), hop]);
}
