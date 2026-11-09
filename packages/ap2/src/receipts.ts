// Signed receipts and the key set that verifies them. Three kinds, all ES256 JWTs with a `kid`:
// - the Mandate Receipt a verifier MUST return on acceptance or rejection (agent_authorization.md):
//   result success|error, reference = sd_hash-style hash of the final SD-JWT in the chain;
// - the Checkout and Payment Receipts of the canonical schemas (status, order_id / payment_id and
//   PSP confirmation), issued once settlement has happened. Their reference follows the reference
//   SDK's samples: the hash of the closed mandate's issuer JWT, stable under any disclosure choice.
// Each receipt is validated against its schema before it is signed.

import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type KeyObject,
} from "jose";
import type { ConstraintResult } from "./constraints.ts";
import { splitChain } from "./chain.ts";
import type { PresentationVerification } from "./presentation.ts";
import { validateSchema } from "./schemas.ts";
import { digest, issuerJwtHash, sdHash, SIGNING_ALG } from "./sdjwt.ts";

export interface ReceiptSigner {
  kid: string;
  issuer: string;
  key: CryptoKey | KeyObject;
  publicJwk: JWK;
}

/**
 * Load the receipt key from a private P-256 JWK (JSON). Without one, a fresh key lives only as
 * long as the process: receipts it signs stop verifying after a restart, so `ephemeral` says so.
 */
export async function loadReceiptSigner(issuer: string, privateJwk?: string): Promise<ReceiptSigner & { ephemeral: boolean }> {
  let priv: JWK;
  if (privateJwk) {
    priv = JSON.parse(privateJwk) as JWK;
    if (priv.kty !== "EC" || priv.crv !== "P-256" || !priv.d) throw new Error("the receipt key must be a private EC P-256 JWK");
  } else {
    priv = await exportJWK((await generateKeyPair(SIGNING_ALG, { extractable: true })).privateKey);
  }
  const { d: _d, ...pub } = priv;
  const publicJwk: JWK = { kty: pub.kty!, crv: pub.crv!, x: pub.x!, y: pub.y! };
  const kid = priv.kid ?? (privateJwk ? "" : "ephemeral-") + (await calculateJwkThumbprint(publicJwk));
  return {
    kid,
    issuer,
    key: (await importJWK({ ...priv, kid }, SIGNING_ALG)) as CryptoKey,
    publicJwk: { ...publicJwk, kid, alg: SIGNING_ALG, use: "sig" },
    ephemeral: !privateJwk,
  };
}

/** The public half of every current receipt key: GET /.well-known/jwks.json. */
export const jwksOf = (signers: ReceiptSigner[]): JSONWebKeySet => ({ keys: signers.map((s) => s.publicJwk) });

const sign = (s: ReceiptSigner, claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: SIGNING_ALG, typ: "JWT", kid: s.kid }).sign(s.key);

/** Reference for a Mandate Receipt: the final SD-JWT of the chain, hashed as sd_hash is. */
export function mandateReference(chain: string): string {
  const tokens = splitChain(chain);
  return sdHash(tokens[tokens.length - 1]!);
}

/** Reference for Checkout/Payment Receipts: hash of the closed mandate's issuer JWT. */
export function closedMandateReference(chain: string): string {
  const tokens = splitChain(chain);
  return issuerJwtHash(tokens[tokens.length - 1]!);
}

export interface MandateReceiptClaims {
  iss: string;
  iat: number;
  result: "success" | "error";
  reference: string;
  error?: string;
  error_description?: string;
  /** Second Key's use-case properties (allowed by the spec): what was decided and why. */
  "x-secondkey": {
    decision: PresentationVerification["decision"];
    mandate: "checkout" | "payment";
    constraints: ConstraintResult[];
    findings: string[];
    checkout_hash?: string;
    /** Hash of the facts attestation the attribute rules were evaluated against. */
    facts_attestation?: string;
    ledger: { open_mandate: string; uses_before: number; budget_remaining_minor?: number }[];
  };
}

export async function signMandateReceipt(
  s: ReceiptSigner,
  v: PresentationVerification,
  which: "checkout" | "payment",
  chain: string,
  now: number,
  factsAttestation?: string,
): Promise<string> {
  const ok = v.decision === "CONFORMS";
  const claims: MandateReceiptClaims = {
    iss: s.issuer,
    iat: now,
    result: ok ? "success" : "error",
    reference: mandateReference(chain),
    ...(ok ? {} : { error: v.error!, error_description: describe(v) }),
    "x-secondkey": {
      decision: v.decision,
      mandate: which,
      constraints: v.constraints,
      findings: v.findings.map((f) => f.code),
      ...(v.checkout.checkout ? { checkout_hash: v.checkout.checkout.hash } : {}),
      ...(factsAttestation ? { facts_attestation: digest(factsAttestation) } : {}),
      ledger: v.ledger.map((e) => ({ open_mandate: e.ref, uses_before: e.usesBefore, ...(e.budgetRemainingMinor === undefined ? {} : { budget_remaining_minor: e.budgetRemainingMinor }) })),
    },
  };
  return sign(s, claims as unknown as Record<string, unknown>);
}

function describe(v: PresentationVerification): string {
  const failed = v.constraints.filter((c) => c.result !== "pass").map((c) => `${c.type}: ${c.detail ?? c.result}`);
  return [...v.findings.map((f) => f.message), ...failed].join("; ").slice(0, 1000) || v.decision;
}

type ErrorStatus = { status: "Error"; error: string; error_description: string };

export async function signCheckoutReceipt(s: ReceiptSigner, r: { reference: string; iat: number } & ({ status: "Success"; order_id: string } | ErrorStatus)) {
  const claims = { iss: s.issuer, ...r };
  const errors = validateSchema("checkout_receipt", claims);
  if (errors.length) throw new Error(`checkout receipt is invalid: ${errors.join("; ")}`);
  return sign(s, claims);
}

export async function signPaymentReceipt(
  s: ReceiptSigner,
  r: { reference: string; iat: number; payment_id: string } & ({ status: "Success"; psp_confirmation_id: string; network_confirmation_id: string } | ErrorStatus),
) {
  const claims = { iss: s.issuer, ...r };
  const errors = validateSchema("payment_receipt", claims);
  if (errors.length) throw new Error(`payment receipt is invalid: ${errors.join("; ")}`);
  return sign(s, claims);
}

/** Verify any of the three receipt kinds against a JWKS (ours, or a copy fetched from us). */
export async function verifyReceipt(jwt: string, jwks: JSONWebKeySet, issuer?: string): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(jwt, createLocalJWKSet(jwks), { algorithms: [SIGNING_ALG], ...(issuer ? { issuer } : {}) });
  return payload as Record<string, unknown>;
}

/** Re-derive a receipt's reference from the chain it claims to bind; both conventions. */
export function receiptBinds(receipt: Record<string, unknown>, chain: string): boolean {
  return receipt.reference === mandateReference(chain) || receipt.reference === closedMandateReference(chain);
}
