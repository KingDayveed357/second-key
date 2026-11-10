// Spike 02 (human present): prove the money lifecycle Second Key depends on.
//   Order A: buyer approves -> authorize -> Second Key approves -> capture   => COMPLETED
//   Order B: buyer approves -> authorize -> Second Key refuses  -> void      => VOIDED
//   Then try to capture B anyway and confirm PayPal itself refuses.

import { createHash } from "node:crypto";
import { saveJson } from "./lib/paypal.mjs";
import {
  createAuthorizeOrder, approvalUrl, waitForApproval, authorizeOrder, authorizationOf,
  getOrder, getAuthorization, captureAuthorization, voidAuthorization, getCapture,
} from "./lib/orders.mjs";
import { evaluateCart, approve, assertCapturable, Decision } from "./lib/gate.mjs";
import { cartOf, TRAIL_SHOE_POLICY } from "./lib/catalog.mjs";

const intentDigest = "witness:" + createHash("sha256").update(JSON.stringify(TRAIL_SHOE_POLICY)).digest("hex").slice(0, 40);

// --- Order A: a compliant cart -------------------------------------------------
const cartA = cartOf("TRL-GRY-10");
const evalA = evaluateCart(TRAIL_SHOE_POLICY, cartA);
console.log(`Cart A (${cartA.items[0].name}) -> ${evalA.decision}`);
if (evalA.decision !== Decision.CAPTURE) throw new Error("Fixture error: cart A should pass.");
const approvalA = approve(TRAIL_SHOE_POLICY, cartA, evalA);

// --- Order B: a cart that violates the intent ----------------------------------
const cartB = cartOf("TRL-WHT-10");
const evalB = evaluateCart(TRAIL_SHOE_POLICY, cartB);
console.log(`Cart B (${cartB.items[0].name}) -> ${evalB.decision}`);
for (const c of evalB.checks.filter((c) => c.result !== "pass")) console.log(`   ✘ ${c.id}: ${c.detail}`);

// Both orders reach PayPal so we can prove void on a real authorization.
const orderA = await createAuthorizeOrder(cartA, { customId: intentDigest, label: "create-order-A" });
const orderB = await createAuthorizeOrder(cartB, { customId: intentDigest, label: "create-order-B" });

console.log("\nLog in as your SANDBOX PERSONAL (buyer) account and approve both:\n");
console.log(`  A: ${approvalUrl(orderA)}`);
console.log(`  B: ${approvalUrl(orderB)}\n`);
console.log("You can close the tab after approving; the redirect page does not need to load.");
process.stdout.write("Waiting for approvals");
await waitForApproval(orderA.id);
await waitForApproval(orderB.id);
console.log(" approved.\n");

const authA = authorizationOf(await authorizeOrder(orderA.id));
const authB = authorizationOf(await authorizeOrder(orderB.id));
console.log(`A authorization ${authA.id}: ${authA.status}, expires ${authA.expiration_time}`);
console.log(`B authorization ${authB.id}: ${authB.status}`);

// --- Capture A only through the gate: re-read PayPal's order first -------------
const paypalOrderA = await getOrder(orderA.id, "get-order-A");
const amount = assertCapturable(approvalA, paypalOrderA); // three-way match
const { data: capA } = await captureAuthorization(authA.id, amount);
const captureA = await getCapture(capA.id);
console.log(`\nA captured ${captureA.amount.value} ${captureA.amount.currency_code}: capture ${captureA.id} is ${captureA.status}`);

// --- Void B -------------------------------------------------------------------
await voidAuthorization(authB.id);
const authBAfter = await getAuthorization(authB.id);
console.log(`B authorization ${authB.id} is now ${authBAfter.status}`);

// --- Prove a voided authorization cannot be captured --------------------------
const retry = await captureAuthorization(authB.id, { currency_code: "USD", value: "84.00" }, { allowFail: true });
const issue = retry.data?.details?.[0]?.issue ?? retry.data?.name;
console.log(`Capture attempt on voided B: HTTP ${retry.status} ${issue}`);

const pass = captureA.status === "COMPLETED" && authBAfter.status === "VOIDED" && !retry.ok;
const payerId = paypalOrderA.payer?.payer_id;

saveJson("record-order-A.json", {
  intent: TRAIL_SHOE_POLICY.original_text,
  intentDigest,
  cartDigest: approvalA.cartDigest,
  orderId: orderA.id,
  authorizationId: authA.id,
  captureId: captureA.id,
  amount: captureA.amount,
  payerId,
  capturedAt: captureA.create_time,
});

console.log(`\nGATE 1 (capture + void on real authorizations): ${pass ? "PASS" : "FAIL"}`);
console.log("Record for the dispute spike saved to spikes/out/record-order-A.json");
process.exitCode = pass ? 0 : 1;
