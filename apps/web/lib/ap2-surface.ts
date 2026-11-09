// Rose's device as AP2's Trusted Surface (8 Nov demo); her key itself lives in ap2-device.ts. This file
// issues her two open mandates as SD-JWTs in the format @witness/ap2 verifies (the AP2 reference
// SDK's): `issuer-jwt~disclosure~…~`, digests = base64url(SHA-256(disclosure)), `_sd` sorted,
// inner disclosures first. It runs in the browser and in Node (tests), using only WebCrypto.

import { CompactSign, type CryptoKey } from "jose";

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlText = (text: string) => b64url(enc.encode(text));

/** base64url(SHA-256(ascii)): disclosure digests and sd_hash. */
export async function sha256b64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

/** Marks a value selectively disclosable (an `_sd` claim, or a `{"...": d}` array element). */
export class Disclose {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}
const disclose = (v: unknown) => new Disclose(v);

async function encode(claims: Record<string, unknown>) {
  const disclosures: string[] = [];
  const make = async (arr: unknown[]) => {
    const raw = b64urlText(JSON.stringify(arr));
    disclosures.push(raw);
    return sha256b64url(raw);
  };
  const salt = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
  const walk = async (v: unknown): Promise<unknown> => {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const el of v) out.push(el instanceof Disclose ? { "...": await make([salt(), await walk(el.value)]) } : await walk(el));
      return out;
    }
    if (typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    const sd: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (val instanceof Disclose) sd.push(await make([salt(), k, await walk(val.value)]));
      else out[k] = await walk(val);
    }
    if (sd.length) out._sd = sd.sort();
    return out;
  };
  const payload = (await walk(claims)) as Record<string, unknown>;
  payload._sd_alg = "sha-256";
  return { payload, disclosures };
}

/** A root SD-JWT carrying one mandate in delegate_payload, signed with Rose's device key. */
export async function issueMandate(mandate: Record<string, unknown>, key: CryptoKey, kid: string): Promise<string> {
  const { payload, disclosures } = await encode({ delegate_payload: [disclose(mandate)] });
  const jwt = await new CompactSign(enc.encode(JSON.stringify(payload))).setProtectedHeader({ alg: "ES256", typ: "dc+sd-jwt", kid }).sign(key);
  return [jwt, ...disclosures, ""].join("~");
}

export interface Ap2Setup {
  agent: { jwk: { kty?: string; crv?: string; x?: string; y?: string; kid?: string } };
  merchant: { id: string; name: string; website: string };
  products: { id: string; title: string; price_cents: number; color: string | null }[];
}

/** What Rose asks for, in words: the open mandates below say exactly this, as constraints. */
export const ROSE_REQUEST = {
  family: "Ridgeline Trail Runner",
  size: "10",
  notColour: "white",
  maxCents: 9000,
};

/**
 * Rose's two open mandates for one pair of shoes. AP2 itself can list acceptable items by id and
 * cap the amount; "not white" needs Second Key's attribute constraint over facts it attests.
 */
export async function roseMandates(setup: Ap2Setup, key: CryptoKey, kid: string, now = Math.floor(Date.now() / 1000)) {
  const family = setup.products.filter((p) => p.title.startsWith(ROSE_REQUEST.family));
  const merchant = { id: setup.merchant.id, name: setup.merchant.name, website: setup.merchant.website };
  const agentKey = { kty: setup.agent.jwk.kty, crv: setup.agent.jwk.crv, x: setup.agent.jwk.x, y: setup.agent.jwk.y };
  const times = { iat: now, exp: now + 30 * 60 };
  const openCheckout = await issueMandate(
    {
      vct: "mandate.checkout.open.1",
      constraints: [
        { type: "checkout.line_items", items: [{ id: "shoes", acceptable_items: family.map((p) => disclose({ id: p.id, title: p.title })), quantity: 1 }] },
        { type: "checkout.allowed_merchants", allowed: [disclose(merchant)] },
        { type: "x-secondkey.item_attributes.1", rules: [{ attribute: "size", any_of: [ROSE_REQUEST.size] }, { attribute: "color", none_of: [ROSE_REQUEST.notColour] }] },
      ],
      cnf: { jwk: agentKey },
      ...times,
    },
    key,
    kid,
  );
  const openPayment = await issueMandate(
    {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.amount_range", currency: "USD", max: ROSE_REQUEST.maxCents },
        { type: "payment.allowed_payees", allowed: [disclose(merchant)] },
        // Binds this payment to the open checkout above, as the agent will present it.
        { type: "payment.reference", conditional_transaction_id: await sha256b64url(openCheckout) },
      ],
      cnf: { jwk: agentKey },
      ...times,
    },
    key,
    kid,
  );
  return { openCheckout, openPayment, acceptable: family };
}

/** RFC 7638 thumbprint, as the server computes it: the device's name. */
export async function thumbprint(jwk: { kty: string; crv: string; x: string; y: string }): Promise<string> {
  return sha256b64url(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}
