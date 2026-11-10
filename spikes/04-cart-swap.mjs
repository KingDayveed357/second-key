// Spike 04: the cart-swap catch (the demo's "wait, what?" moment).
//
// Second Key approves the agent's cart: grey trail shoe, $84. The merchant's checkout
// then creates a PayPal order for a WHITE shoe at the same $84. Price, budget and
// total all still pass. Only matching against PayPal's own authorized order catches it.
//
//   node spikes/04-cart-swap.mjs            # buyer approves in the browser
//   node spikes/04-cart-swap.mjs --vault    # use the saved wallet from spike 03

import { loadJson, arg } from "./lib/paypal.mjs";
import {
  createAuthorizeOrder, approvalUrl, waitForApproval, authorizeOrder, authorizationOf,
  getOrder, getAuthorization, voidAuthorization,
} from "./lib/orders.mjs";
import { evaluateCart, approve, assertCapturable, GateRefusal } from "./lib/gate.mjs";
import { cartOf, TRAIL_SHOE_POLICY } from "./lib/catalog.mjs";

// 1. The agent proposes a compliant cart and Second Key approves exactly that cart.
const proposed = cartOf("TRL-GRY-10");
const evaluation = evaluateCart(TRAIL_SHOE_POLICY, proposed);
const approval = approve(TRAIL_SHOE_POLICY, proposed, evaluation);
console.log(`Agent proposed: ${proposed.items[0].name} -> ${evaluation.decision}`);
console.log(`Approval bound to ${approval.cartDigest.slice(0, 23)}..., ${approval.amount} USD\n`);

// 2. The order PayPal actually receives contains a different SKU at the same price.
const swapped = cartOf("TRL-WHT-10");
const vaultId = arg("vault") ? loadJson("vault.json")?.vaultId : undefined;
if (arg("vault") && !vaultId) throw new Error("No saved wallet: run spike 03 first.");

let order = await createAuthorizeOrder(swapped, { vaultId, customId: "witness:spike-04", label: "create-swapped-order" });
console.log(`Merchant created PayPal order ${order.id} for: ${swapped.items[0].name}, ${swapped.items[0].unit_amount} USD`);

let auth = authorizationOf(order);
if (!auth) {
  if (order.status !== "APPROVED") {
    console.log(`\nApprove as the SANDBOX PERSONAL buyer:\n  ${approvalUrl(order)}\n`);
    process.stdout.write("Waiting for approval");
    await waitForApproval(order.id);
    console.log(" approved.");
  }
  auth = authorizationOf(await authorizeOrder(order.id));
}
console.log(`Authorization ${auth.id}: ${auth.status}. Funds are held.\n`);
console.log("A naive integration would capture now: the amount matches and the total is under budget.\n");

// 3. Second Key re-reads PayPal's order and refuses to capture.
const paypalOrder = await getOrder(order.id, "get-swapped-order");
let refused = false;
try {
  assertCapturable(approval, paypalOrder);
  console.log("✘ Gate allowed capture. This is a bug.");
} catch (err) {
  if (!(err instanceof GateRefusal)) throw err;
  refused = true;
  console.log("Second Key three-way match against PayPal's order:");
  for (const r of err.reasons) console.log(`   ✘ ${r}`);
}

if (refused) {
  await voidAuthorization(auth.id);
  const after = await getAuthorization(auth.id);
  console.log(`\nAuthorization ${auth.id} is now ${after.status}. $0.00 captured.`);
  console.log(`\nGATE 3 (cart swap caught on PayPal's own record): ${after.status === "VOIDED" ? "PASS" : "FAIL"}`);
  process.exitCode = after.status === "VOIDED" ? 0 : 1;
} else {
  process.exitCode = 1;
}
