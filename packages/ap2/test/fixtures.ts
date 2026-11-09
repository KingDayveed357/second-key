// A checkout chain and a payment chain built with fresh keys, shaped like the spec examples:
// an Open Mandate issued by a trusted surface to an agent key, closed by the agent.

import { CompactSign, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { digest, disclose, issueSdJwt, parseSdJwt, presentHop, sdHash, VCT, type JsonObject } from "../src/index.ts";

export const NOW = 1_800_000_000;
export const MERCHANT = { id: "merchant_1", name: "Demo Merchant", website: "https://demo-merchant.example" };

export async function keyPair() {
  const k = await generateKeyPair("ES256", { extractable: true });
  return { ...k, jwk: await exportJWK(k.publicKey) };
}
export type KeyPair = Awaited<ReturnType<typeof keyPair>>;

export function checkoutPayload(price = 19900): JsonObject {
  return {
    id: "chk_1",
    merchant: MERCHANT,
    line_items: [{ id: "li_1", item: { id: "sku_gold_9", title: "SuperShoe Gold, women's 9", price }, quantity: 1, totals: [{ type: "total", amount: price }] }],
    status: "ready_for_complete",
    currency: "USD",
    totals: [
      { type: "subtotal", amount: price },
      { type: "total", amount: price },
    ],
    links: [],
  };
}

export async function signCheckout(key: CryptoKey, payload: JsonObject = checkoutPayload()) {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "merchant-1" }).sign(key);
}

export function openCheckoutMandate(agent: KeyPair, extra: Record<string, unknown> = {}) {
  return {
    vct: VCT.openCheckout,
    constraints: [
      { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [disclose({ id: "sku_gold_9", title: "SuperShoe Gold" })], quantity: 1 }] },
      { type: "checkout.allowed_merchants", allowed: [disclose(MERCHANT)] },
    ],
    cnf: { jwk: agent.jwk },
    iat: NOW - 60,
    exp: NOW + 3600,
    ...extra,
  };
}

export async function world() {
  const [issuer, agent, merchant] = [await keyPair(), await keyPair(), await keyPair()];
  const rootKey = (h: JsonObject) => (h.kid === "issuer-1" ? issuer.publicKey : undefined);
  const merchantKey = (h: JsonObject) => (h.kid === "merchant-1" ? merchant.publicKey : undefined);

  const openCheckout = await issueSdJwt({ key: issuer.privateKey, typ: "example+sd-jwt", kid: "issuer-1", claims: { delegate_payload: [disclose(openCheckoutMandate(agent))] } });
  const checkoutJwt = await signCheckout(merchant.privateKey);
  const checkoutHash = digest(checkoutJwt);
  const closedCheckout = { vct: VCT.checkout, checkout_jwt: disclose(checkoutJwt), checkout_hash: checkoutHash };
  const checkoutChain = await presentHop({ chain: openCheckout, key: agent.privateKey, mandate: closedCheckout, aud: "merchant", nonce: "n-checkout", iat: NOW });

  const openPaymentMandate = {
    vct: VCT.openPayment,
    constraints: [
      { type: "payment.amount_range", currency: "USD", max: 20000, min: 0 },
      { type: "payment.allowed_payees", allowed: [disclose(MERCHANT)] },
      { type: "payment.reference", conditional_transaction_id: sdHash(parseSdJwt(openCheckout)) },
    ],
    cnf: { jwk: agent.jwk },
    iat: NOW - 60,
    exp: NOW + 3600,
  };
  const openPayment = await issueSdJwt({ key: issuer.privateKey, typ: "example+sd-jwt", kid: "issuer-1", claims: { delegate_payload: [disclose(openPaymentMandate)] } });
  const closedPayment = {
    vct: VCT.payment,
    transaction_id: checkoutHash,
    payee: MERCHANT,
    payment_amount: { amount: 19900, currency: "USD" },
    payment_instrument: { id: "pi_1", type: "paypal" },
  };
  const paymentChain = await presentHop({ chain: openPayment, key: agent.privateKey, mandate: closedPayment, aud: "credential-provider", nonce: "n-payment", iat: NOW });

  return { issuer, agent, merchant, rootKey, merchantKey, openCheckout, checkoutJwt, checkoutHash, closedCheckout, checkoutChain, openPayment, openPaymentMandate, closedPayment, paymentChain };
}
export type World = Awaited<ReturnType<typeof world>>;

export const checkoutOpts = (w: World) => ({ rootKey: w.rootKey, merchantKey: w.merchantKey, aud: "merchant", nonce: "n-checkout", now: NOW });
export const paymentOpts = (w: World) => ({ rootKey: w.rootKey, aud: "credential-provider", nonce: "n-payment", now: NOW });

/** Re-encode one hop's signed payload without re-signing it. */
export function editPayload(chain: string, hop: number, edit: (p: JsonObject) => void): string {
  const segs = chain.split("~~");
  const [jwt, ...rest] = segs[hop]!.split("~") as [string, ...string[]];
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  edit(payload);
  segs[hop] = [`${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`, ...rest].join("~");
  return segs.join("~~");
}

/** Replace hop `hop`'s disclosures (as presented in the chain) via `edit`. */
export function editDisclosures(chain: string, hop: number, edit: (d: string[]) => string[]): string {
  const segs = chain.split("~~");
  const last = hop === segs.length - 1;
  const parts = segs[hop]!.split("~");
  const jwt = parts[0]!;
  const ds = parts.slice(1).filter((d) => d !== "");
  const out = edit(ds);
  segs[hop] = [jwt, ...out].join("~") + (last ? "~" : "");
  return segs.join("~~");
}

export const decodeDisclosure = (d: string) => JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as unknown[];
export const encodeDisclosure = (arr: unknown[]) => Buffer.from(JSON.stringify(arr)).toString("base64url");

export const OTHER_MERCHANT = { id: "merchant_2", name: "Second Shop", website: "https://second-shop.example" };

/** A fresh open checkout (issuer -> agent) closed against a merchant-signed checkout. */
export async function checkoutFor(w: World, o: { price?: number; merchant?: typeof MERCHANT; sku?: string; mandate?: Record<string, unknown>; open?: string } = {}) {
  const price = o.price ?? 19900;
  const merchant = o.merchant ?? MERCHANT;
  const payload = checkoutPayload(price);
  payload.merchant = merchant;
  if (o.sku) ((payload.line_items as JsonObject[])[0]!.item as JsonObject).id = o.sku;
  const open = o.open ?? await issueSdJwt({
    key: w.issuer.privateKey,
    kid: "issuer-1",
    claims: {
      delegate_payload: [
        disclose(
          o.mandate ??
            openCheckoutMandate(w.agent, {
              constraints: [
                { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [disclose({ id: "sku_gold_9", title: "SuperShoe Gold" })], quantity: 1 }] },
                { type: "checkout.allowed_merchants", allowed: [disclose(MERCHANT), disclose(OTHER_MERCHANT)] },
              ],
            }),
        ),
      ],
    },
  });
  const jwt = await signCheckout(w.merchant.privateKey, payload);
  const hash = digest(jwt);
  const chain = await presentHop({ chain: open, key: w.agent.privateKey, mandate: { vct: VCT.checkout, checkout_jwt: disclose(jwt), checkout_hash: hash }, aud: "merchant", nonce: "n-checkout", iat: NOW });
  return { open, chain, hash, price, merchant };
}

/** An open payment mandate (issuer -> agent) with the given constraints, paying for `forCheckout`. */
export const openPaymentWith = (w: World, forCheckout: string, constraints: unknown[]) =>
  issueSdJwt({
    key: w.issuer.privateKey,
    kid: "issuer-1",
    claims: {
      delegate_payload: [
        disclose({
          vct: VCT.openPayment,
          constraints: [...constraints, { type: "payment.reference", conditional_transaction_id: sdHash(parseSdJwt(forCheckout)) }],
          cnf: { jwk: w.agent.jwk },
          iat: NOW - 60,
          exp: NOW + 3600,
        }),
      ],
    },
  });

/** Close an open payment mandate for one checkout. */
export const payFor = (w: World, open: string, c: { hash: string; price: number; merchant: typeof MERCHANT }, extra: Record<string, unknown> = {}) =>
  presentHop({
    chain: open,
    key: w.agent.privateKey,
    mandate: { vct: VCT.payment, transaction_id: c.hash, payee: c.merchant, payment_amount: { amount: c.price, currency: "USD" }, payment_instrument: { id: "pi_1", type: "paypal" }, ...extra },
    aud: "credential-provider",
    nonce: "n-payment",
    iat: NOW,
  });
