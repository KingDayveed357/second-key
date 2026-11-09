// Second Key's AP2 extension constraints (spec: "New constraint types MAY be defined", with a
// collision-resistant name). Both are deterministic; neither lets AI or the agent loosen anything.
//
// x-secondkey.item_attributes.1 (open checkout mandate): what the user meant, as attribute rules,
// checked against product facts Second Key fetched itself and signed (a facts attestation), never
// against the merchant's or the agent's description. Its rules are deliberately NOT selectively
// disclosable: withholding a rule would loosen the constraint, the failure we found in the
// reference SDK's acceptable_items handling. A missing fact, a listing that gives instructions to
// agents, or an unavailable listing check is unresolved (CANNOT_CONFIRM), never a pass.
//
//   { "type": "x-secondkey.item_attributes.1",
//     "rules": [ { "attribute": "size", "any_of": ["10"] },
//                { "attribute": "color", "none_of": ["white"] } ] }
//
// x-secondkey.cosign.1 (open payment mandate): above a threshold, the closed payment mandate needs
// a second signature from an enrolled co-signer's key (a guardian's WebCrypto key). Without one the
// decision is COSIGN_REQUIRED; a co-signature from any other key, or for another payment, fails.
//
//   { "type": "x-secondkey.cosign.1",
//     "cosigner": { "name": "Sarah", "jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } },
//     "when": { "amount_over": 50000, "currency": "USD" } }      // omitted: always

import { createHash } from "node:crypto";
import { compactVerify, decodeProtectedHeader, importJWK, SignJWT, jwtVerify, createLocalJWKSet, type CryptoKey, type JSONWebKeySet, type KeyObject } from "jose";
import { registerConstraint, type CheckoutContext, type Evaluator, type PaymentContext } from "./constraints.ts";
import type { ReceiptSigner } from "./receipts.ts";
import { isObject, SIGNING_ALG, type Json, type JsonObject } from "./sdjwt.ts";

export const ITEM_ATTRIBUTES = "x-secondkey.item_attributes.1";
export const COSIGN = "x-secondkey.cosign.1";

// ── Facts attestation ─────────────────────────────────────────────────────

export interface AttestedProduct {
  product_id: string;
  title: string;
  brand?: string;
  category?: string;
  attributes: Record<string, string>;
  /** Where the facts came from (a catalog, or "fixture" in tests and the demo). */
  source: string;
  fetched_at: string;
  /** The listing check over these facts. Only "clean" lets the attribute rules decide. */
  listing_check: "clean" | "concern" | "unavailable";
  listing_detail?: string;
}

export const FACTS_TYP = "secondkey-facts+jwt";

/** Sign the facts Second Key fetched, so a merchant or a dispute reviewer can check them later. */
export async function signFactsAttestation(s: ReceiptSigner, products: AttestedProduct[], now: number, ttlSeconds = 3600): Promise<string> {
  return new SignJWT({ products } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: SIGNING_ALG, typ: FACTS_TYP, kid: s.kid })
    .setIssuer(s.issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(s.key);
}

export async function verifyFactsAttestation(jwt: string, jwks: JSONWebKeySet, now?: number): Promise<AttestedProduct[]> {
  const { payload } = await jwtVerify(jwt, createLocalJWKSet(jwks), { algorithms: [SIGNING_ALG], typ: FACTS_TYP, ...(now ? { currentDate: new Date(now * 1000) } : {}) });
  return payload.products as AttestedProduct[];
}

// ── item_attributes ───────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
const words = (s: string) => ` ${norm(s)} `;

function factOf(p: AttestedProduct, attribute: string): string | undefined {
  const a = norm(attribute);
  if (a === "brand") return p.brand;
  if (a === "category") return p.category;
  if (a === "title") return p.title;
  for (const [k, v] of Object.entries(p.attributes)) if (norm(k) === a || (a === "color" && norm(k) === "colour") || (a === "colour" && norm(k) === "color")) return v;
  return undefined;
}

interface Rule {
  attribute: string;
  any_of?: string[];
  none_of?: string[];
}

const strings = (v: Json | undefined) => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x.trim()) ? (v as string[]) : undefined);

function rulesOf(c: JsonObject): Rule[] | undefined {
  if (!Array.isArray(c.rules) || !c.rules.length) return undefined;
  const out: Rule[] = [];
  for (const r of c.rules) {
    if (!isObject(r) || typeof r.attribute !== "string" || !r.attribute.trim()) return undefined;
    const any = strings(r.any_of);
    const none = strings(r.none_of);
    if ((r.any_of !== undefined && !any) || (r.none_of !== undefined && !none) || (!any && !none)) return undefined;
    out.push({ attribute: r.attribute, ...(any ? { any_of: any } : {}), ...(none ? { none_of: none } : {}) });
  }
  return out;
}

/**
 * any_of: the fact equals one of the values (case, spaces and dashes ignored).
 * none_of: the fact does not contain any of the values as whole words ("white" excludes "Cloud White").
 */
const itemAttributes: Evaluator<CheckoutContext> = (c, { checkout, facts }) => {
  const rules = rulesOf(c);
  if (!rules) return { result: "fail", detail: "malformed rules: each needs an attribute and a non-empty any_of or none_of" };
  const lines = Array.isArray(checkout.line_items) ? checkout.line_items.filter(isObject) : [];
  if (!lines.length) return { result: "fail", detail: "the checkout is empty" };
  const unresolved: string[] = [];
  for (const li of lines) {
    const id = isObject(li.item) && typeof li.item.id === "string" ? li.item.id : undefined;
    const p = id ? facts?.[id] : undefined;
    if (!id || !p) {
      unresolved.push(`no independent facts for ${id ?? "a line item"}`);
      continue;
    }
    for (const r of rules) {
      const v = factOf(p, r.attribute);
      if (r.none_of && v !== undefined) {
        const hit = r.none_of.find((x) => words(v).includes(words(x)));
        if (hit) return { result: "fail", detail: `${r.attribute}: '${v}' is excluded (${id})` };
      }
      if (r.any_of && v !== undefined && !r.any_of.some((x) => norm(x) === norm(v))) return { result: "fail", detail: `${r.attribute}: '${v}' is not one of ${r.any_of.map((x) => `'${x}'`).join(", ")} (${id})` };
      if (v === undefined) unresolved.push(`${id} has no ${r.attribute} in its facts`);
    }
    // Checked after the rules: a definite violation stands, but a clean pass needs a clean listing.
    if (p.listing_check !== "clean") unresolved.push(`listing check for ${id} ${p.listing_check === "concern" ? `raised a concern${p.listing_detail ? `: ${p.listing_detail}` : ""}` : "was unavailable"}`);
  }
  return unresolved.length ? { result: "unresolved", detail: unresolved.join("; ") } : { result: "pass" };
};

// ── cosign ────────────────────────────────────────────────────────────────

export const COSIGN_TYP = "secondkey-cosign+jwt";

/** RFC 7638 thumbprint of an EC public key. */
export function ecThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
}

const ecJwkOf = (v: Json | undefined) =>
  isObject(v) && v.kty === "EC" && v.crv === "P-256" && typeof v.x === "string" && typeof v.y === "string" && !("d" in v) ? { kty: "EC", crv: "P-256", x: v.x, y: v.y } : undefined;

export interface CheckedCosignature {
  /** Thumbprint of the enrolled key that verified it; absent when no enrolled key did. */
  thumbprint?: string;
  reference?: string;
  ok: boolean;
  reason?: string;
}

/** What a co-signer signs: the hash of the closed payment mandate's issuer JWT, briefly. */
export async function signCosignature(key: CryptoKey | KeyObject, reference: string, now: number, ttlSeconds = 900): Promise<string> {
  return new SignJWT({ reference, decision: "approve" }).setProtectedHeader({ alg: SIGNING_ALG, typ: COSIGN_TYP }).setIssuedAt(now).setExpirationTime(now + ttlSeconds).sign(key);
}

/** Check presented co-signatures against every co-signer enrolled in these open mandates. */
export async function checkCosignatures(jwss: string[], openMandates: JsonObject[], now: number): Promise<CheckedCosignature[]> {
  const enrolled = openMandates
    .flatMap((m) => (Array.isArray(m.constraints) ? m.constraints.filter(isObject) : []))
    .filter((c) => c.type === COSIGN)
    .map((c) => ecJwkOf(isObject(c.cosigner) ? c.cosigner.jwk : undefined))
    .filter((j) => j !== undefined);
  const out: CheckedCosignature[] = [];
  for (const jws of jwss) {
    let checked: CheckedCosignature = { ok: false, reason: "not signed by an enrolled co-signer" };
    try {
      if (decodeProtectedHeader(jws).typ !== COSIGN_TYP) throw new Error("typ");
    } catch {
      out.push({ ok: false, reason: "not a co-signature" });
      continue;
    }
    for (const jwk of enrolled) {
      try {
        const { payload } = await compactVerify(jws, await importJWK(jwk, SIGNING_ALG), { algorithms: [SIGNING_ALG] });
        const claims = JSON.parse(new TextDecoder().decode(payload)) as JsonObject;
        const iat = claims.iat;
        const exp = claims.exp;
        if (claims.decision !== "approve" || typeof claims.reference !== "string" || typeof iat !== "number" || typeof exp !== "number" || exp - iat > 3600)
          checked = { ok: false, thumbprint: ecThumbprint(jwk), reason: "malformed co-signature" };
        else if (now > exp + 300 || iat > now + 300) checked = { ok: false, thumbprint: ecThumbprint(jwk), reason: "co-signature expired or not yet valid" };
        else checked = { ok: true, thumbprint: ecThumbprint(jwk), reference: claims.reference };
        break;
      } catch {
        /* try the next enrolled key */
      }
    }
    out.push(checked);
  }
  return out;
}

const cosign: Evaluator<PaymentContext> = (c, { closed, cosignatures = [], closedReference }) => {
  const jwk = ecJwkOf(isObject(c.cosigner) ? c.cosigner.jwk : undefined);
  if (!jwk) return { result: "fail", detail: "malformed: the co-signer needs an EC P-256 public key" };
  const name = isObject(c.cosigner) && typeof c.cosigner.name === "string" ? c.cosigner.name : "the co-signer";
  const when = isObject(c.when) ? c.when : undefined;
  const paid = isObject(closed.payment_amount) ? closed.payment_amount : {};
  if (when && typeof when.amount_over === "number" && paid.currency === when.currency && typeof paid.amount === "number" && paid.amount <= when.amount_over)
    return { result: "pass", detail: `no co-signature needed at ${paid.amount}` };

  const tp = ecThumbprint(jwk);
  const mine = cosignatures.filter((s) => s.thumbprint === tp);
  if (mine.some((s) => s.ok && s.reference === closedReference)) return { result: "pass", detail: `co-signed by ${name}` };
  if (mine.some((s) => s.ok)) return { result: "fail", detail: `${name}'s co-signature is for another payment` };
  const bad = cosignatures.find((s) => !s.ok && (s.thumbprint === undefined || s.thumbprint === tp));
  if (bad) return { result: "fail", detail: `co-signature refused: ${bad.reason}` };
  return { result: "unresolved", needs: "cosign", detail: `needs ${name}'s co-signature` };
};

registerConstraint("checkout", ITEM_ATTRIBUTES, itemAttributes);
registerConstraint("payment", COSIGN, cosign);
