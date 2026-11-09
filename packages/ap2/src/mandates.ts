// AP2 v0.2 mandates over a verified chain: which mandate each hop carries (by `vct`), whether it
// matches the canonical schema, and the hash links between them. A closed Checkout Mandate's
// `checkout_hash` is H(checkout_jwt); a closed Payment Mandate's `transaction_id` is that same
// hash; an Open Payment Mandate's `payment.reference` names the Open Checkout Mandate by its
// sd_hash. Constraint evaluation (amount ranges, line items, …) is separate: constraints.ts.

import { compactVerify } from "jose";
import { Ap2Error } from "./errors.ts";
import { verifyChain, type RootKeyResolver, type VerifiedHop, type VerifyChainOptions } from "./chain.ts";
import { b64urlJson, digest, isObject, issuerJwtHash, sdAlgOf, sdHash, SIGNING_ALG, type JsonObject } from "./sdjwt.ts";
import { validateSchema, type SchemaName } from "./schemas.ts";

export const VCT = {
  openCheckout: "mandate.checkout.open.1",
  checkout: "mandate.checkout.1",
  openPayment: "mandate.payment.open.1",
  payment: "mandate.payment.1",
} as const;

export type MandateKind = "open_checkout" | "checkout" | "open_payment" | "payment";

const BY_VCT: Record<string, { kind: MandateKind; schema: SchemaName }> = {
  [VCT.openCheckout]: { kind: "open_checkout", schema: "open_checkout_mandate" },
  [VCT.checkout]: { kind: "checkout", schema: "checkout_mandate" },
  [VCT.openPayment]: { kind: "open_payment", schema: "open_payment_mandate" },
  [VCT.payment]: { kind: "payment", schema: "payment_mandate" },
};

const CLOSES: Partial<Record<MandateKind, MandateKind>> = { open_checkout: "checkout", open_payment: "payment" };

export interface Finding {
  code: string;
  message: string;
  hop?: number;
}

export interface Mandate {
  hop: number;
  kind: MandateKind;
  value: JsonObject;
}

export interface MandateVerification {
  /** Signatures, bindings, disclosures, times, schemas and hash links all hold. Constraints are not part of this. */
  ok: boolean;
  findings: Finding[];
  hops: Pick<VerifiedHop, "index" | "typ" | "binding">[];
  mandates: Mandate[];
  /** sd_hash of each hop's token; an Open Payment Mandate's payment.reference names its Open Checkout Mandate this way. */
  hopReferences: string[];
  /** Hash of each hop's issuer-signed JWT: stable whatever disclosures are presented (ledger keys, receipt references). */
  hopIssuerHashes: string[];
  checkout?: {
    jwt: string;
    hash: string;
    payload: JsonObject;
    merchantSignature: "verified" | "invalid" | "not_checked";
  };
  /** aud and nonce were checked on the last hop. Without them a captured chain can be replayed. */
  replayChecked: boolean;
}

export interface VerifyMandateOptions extends VerifyChainOptions {
  /** Resolves the merchant's key from the checkout JWT header. Omitted: the signature is reported unchecked. */
  merchantKey?: RootKeyResolver;
}

/**
 * The canonical open-mandate schemas list the AP2 constraint types exhaustively, while the spec
 * lets parties define new ones. Extension constraints (outside the checkout./payment. namespace)
 * are left out of schema validation; constraints.ts evaluates them or reports them unresolved.
 */
const standardOnly = (item: JsonObject): JsonObject =>
  Array.isArray(item.constraints) ? { ...item, constraints: item.constraints.filter((c) => !isObject(c) || typeof c.type !== "string" || /^(checkout|payment)./.test(c.type)) } : item;

const checkoutHashOf = (jwt: string, hop: VerifiedHop) => digest(jwt, sdAlgOf(hop.token.payload));

async function checkCheckout(m: Mandate, hop: VerifiedHop, opts: VerifyMandateOptions, findings: Finding[]) {
  const jwt = m.value.checkout_jwt;
  if (typeof jwt !== "string") {
    findings.push({ code: "checkout_jwt_undisclosed", message: "the closed Checkout Mandate does not disclose checkout_jwt", hop: m.hop });
    return undefined;
  }
  const hash = checkoutHashOf(jwt, hop);
  if (m.value.checkout_hash !== hash)
    findings.push({ code: "checkout_hash_mismatch", message: "checkout_hash is not the hash of checkout_jwt", hop: m.hop });
  const parts = jwt.split(".");
  let payload: JsonObject;
  let header: JsonObject;
  try {
    if (parts.length !== 3) throw new Ap2Error("malformed_token", "checkout_jwt is not header.payload.signature");
    header = b64urlJson(parts[0]!, "checkout_jwt header");
    payload = b64urlJson(parts[1]!, "checkout_jwt payload");
  } catch (e) {
    findings.push({ code: "checkout_jwt_malformed", message: (e as Error).message, hop: m.hop });
    return undefined;
  }
  for (const err of validateSchema("checkout", payload))
    findings.push({ code: "checkout_schema_invalid", message: `checkout ${err}`, hop: m.hop });

  let merchantSignature: "verified" | "invalid" | "not_checked" = "not_checked";
  if (opts.merchantKey) {
    const key = await opts.merchantKey(header);
    merchantSignature = "invalid";
    if (key && header.alg === SIGNING_ALG) {
      try {
        await compactVerify(jwt, key, { algorithms: [SIGNING_ALG] });
        merchantSignature = "verified";
      } catch {
        /* reported below */
      }
    }
    if (merchantSignature === "invalid")
      findings.push({ code: "merchant_signature_invalid", message: "checkout_jwt is not signed by the merchant's key", hop: m.hop });
  }
  return { jwt, hash, payload, merchantSignature };
}

export async function verifyMandate(serialized: string, opts: VerifyMandateOptions): Promise<MandateVerification> {
  const replayChecked = opts.aud !== undefined && opts.nonce !== undefined;
  let hops: VerifiedHop[];
  try {
    hops = await verifyChain(serialized, opts);
  } catch (e) {
    if (!(e instanceof Ap2Error)) throw e;
    return { ok: false, findings: [{ code: e.code, message: e.message }], hops: [], mandates: [], hopReferences: [], hopIssuerHashes: [], replayChecked };
  }

  const findings: Finding[] = [];
  const mandates: Mandate[] = [];
  for (const hop of hops) {
    for (const item of hop.items) {
      const known = typeof item.vct === "string" ? BY_VCT[item.vct] : undefined;
      if (!known) {
        findings.push({ code: "unknown_vct", message: `unknown mandate type ${JSON.stringify(item.vct ?? null)}`, hop: hop.index });
        continue;
      }
      for (const err of validateSchema(known.schema, standardOnly(item)))
        findings.push({ code: "schema_invalid", message: `${known.kind} ${err}`, hop: hop.index });
      mandates.push({ hop: hop.index, kind: known.kind, value: item });
    }
  }

  // A hop after an open mandate either closes it (open checkout -> checkout) or re-delegates it
  // (open checkout -> open checkout). Anything else mixes the checkout and payment families.
  for (const m of mandates) {
    for (const o of mandates.filter((x) => x.hop === m.hop - 1 && CLOSES[x.kind])) {
      if (m.kind !== o.kind && m.kind !== CLOSES[o.kind])
        findings.push({ code: "chain_shape", message: `${o.kind} cannot be followed by ${m.kind}`, hop: m.hop });
    }
  }

  let checkout: MandateVerification["checkout"];
  for (const m of mandates.filter((x) => x.kind === "checkout")) {
    checkout = (await checkCheckout(m, hops[m.hop]!, opts, findings)) ?? checkout;
  }

  return {
    ok: findings.length === 0,
    findings,
    hops: hops.map(({ index, typ, binding }) => ({ index, typ, binding })),
    mandates,
    hopReferences: hops.map((h) => sdHash(h.token)),
    hopIssuerHashes: hops.map((h) => issuerJwtHash(h.token)),
    checkout,
    replayChecked,
  };
}

/**
 * The links between a payment chain and the checkout chain it pays for: the closed Payment
 * Mandate's transaction_id is the checkout hash, and it pays exactly the checkout's total. (The
 * Open Payment Mandate's payment.reference is a constraint: constraints.ts.)
 */
export function crossCheck(payment: MandateVerification, checkout: MandateVerification): Finding[] {
  const closed = payment.mandates.find((m) => m.kind === "payment");
  if (!checkout.checkout) return [{ code: "checkout_missing", message: "the checkout chain has no verified closed Checkout Mandate" }];
  if (!closed) return [{ code: "payment_missing", message: "the payment chain has no closed Payment Mandate" }];
  const findings: Finding[] = [];
  if (closed.value.transaction_id !== checkout.checkout.hash)
    findings.push({ code: "transaction_id_mismatch", message: "transaction_id is not this checkout's hash", hop: closed.hop });
  const c = checkout.checkout.payload;
  const totals = Array.isArray(c.totals) ? c.totals.filter(isObject) : [];
  const total = totals.find((t) => t.type === "total")?.amount;
  const paid = isObject(closed.value.payment_amount) ? closed.value.payment_amount : {};
  if (paid.currency !== c.currency || paid.amount !== total)
    findings.push({
      code: "amount_mismatch",
      message: `the payment is ${String(paid.amount)} ${String(paid.currency)}; the checkout total is ${String(total)} ${String(c.currency)}`,
      hop: closed.hop,
    });
  return findings;
}
