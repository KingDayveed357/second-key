// Writes chains built by @witness/ap2 for the reference SDK to verify:
//   tsx packages/ap2/test/interop-export.ts <out.json>
//   python -I packages/ap2/interop/sdk_vectors.py verify <ap2-clone> <out.json>

import { writeFileSync } from "node:fs";
import type { CryptoKey } from "jose";
import { closedMandateReference, loadReceiptSigner, parseSdJwt, presentHop, sdHash, signCheckoutReceipt, signPaymentReceipt } from "../src/index.ts";
import { keyPair, NOW, openCheckoutMandate, world } from "./fixtures.ts";

const w = await world();
const hop = (chain: string, key: CryptoKey, mandate: Record<string, unknown>, aud = "merchant", nonce = "n-checkout", hashMode: "sd_hash" | "issuer_jwt_hash" = "sd_hash") =>
  presentHop({ chain, key, mandate, aud, nonce, hashMode, iat: NOW });

const sub = await keyPair();
const reDelegated = await hop(w.openCheckout, w.agent.privateKey, openCheckoutMandate(sub), "sub-agent", "n-sub");
const thief = await keyPair();
const signer = await loadReceiptSigner("https://verifier.secondkey.example");
const checkoutRef = closedMandateReference(w.checkoutChain);
const paymentRef = closedMandateReference(w.paymentChain);

const out = {
  generator: "packages/ap2/test/interop-export.ts (@witness/ap2)",
  now: NOW,
  issuer_jwk: w.issuer.jwk,
  checkout_jwt: w.checkoutJwt,
  checkout_hash: w.checkoutHash,
  open_checkout_ref: sdHash(parseSdJwt(w.openCheckout)),
  checkout_chain: w.checkoutChain,
  checkout_chain_issuer_jwt_hash: await hop(w.openCheckout, w.agent.privateKey, w.closedCheckout, "merchant", "n-checkout", "issuer_jwt_hash"),
  checkout_three_hop: await hop(reDelegated, sub.privateKey, w.closedCheckout),
  payment_chain: w.paymentChain,
  forged_checkout_chain: await hop(w.openCheckout, thief.privateKey, w.closedCheckout),
  receipt_jwk: signer.publicJwk,
  checkout_receipt: await signCheckoutReceipt(signer, { status: "Success", reference: checkoutRef, iat: NOW, order_id: "5O190127TN364715T" }),
  checkout_receipt_reference: checkoutRef,
  payment_receipt: await signPaymentReceipt(signer, { status: "Success", reference: paymentRef, iat: NOW, payment_id: "pay_1", psp_confirmation_id: "CAP-1", network_confirmation_id: "NET-1" }),
  payment_receipt_reference: paymentRef,
};
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${process.argv[2]}`);
