// Spike 03 (THE gate): can Second Key authorize a payment while the buyer is NOT present?
//
// 1. Buyer saves their PayPal wallet once (setup token -> approve -> payment token).
// 2. Create an order with intent AUTHORIZE using only the saved vault_id.
// 3. PASS if PayPal returns an authorization with no buyer action.
//
// If AUTHORIZE fails, a CAPTURE control run tells us whether the vault itself works
// (configuration problem) or only AUTHORIZE is unsupported (API limitation).
//
// Reuse a saved wallet:  node spikes/03-vault-authorize.mjs --vault-id <id>

import { paypal, link, pollUntil, saveJson, loadJson, arg, RETURN_URL, CANCEL_URL } from "./lib/paypal.mjs";
import { createAuthorizeOrder, authorizeOrder, authorizationOf, voidAuthorization, cartTotal } from "./lib/orders.mjs";
import { cartOf } from "./lib/catalog.mjs";

async function saveWallet() {
  const { data: setup } = await paypal("POST", "/v3/vault/setup-tokens", {
    label: "create-setup-token",
    body: {
      payment_source: {
        paypal: {
          description: "Second Key: let your shopping agent pay within the limits you sign",
          permit_multiple_payment_tokens: false,
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          experience_context: {
            shipping_preference: "NO_SHIPPING",
            payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
            brand_name: "Second Key Demo Store",
            locale: "en-US",
            return_url: RETURN_URL,
            cancel_url: CANCEL_URL,
          },
        },
      },
    },
  });

  console.log(`Setup token ${setup.id}: ${setup.status}`);
  console.log(`\nLog in as your SANDBOX PERSONAL (buyer) account and approve:\n  ${link(setup, "approve")}\n`);
  process.stdout.write("Waiting for approval");
  await pollUntil(
    async () => {
      const { data } = await paypal("GET", `/v3/vault/setup-tokens/${setup.id}`, { label: "poll-setup-token" });
      return data.status === "APPROVED" ? data : null;
    },
    { onWait: () => process.stdout.write(".") },
  );
  console.log(" approved.");

  const { data: token } = await paypal("POST", "/v3/vault/payment-tokens", {
    label: "create-payment-token",
    body: { payment_source: { token: { id: setup.id, type: "SETUP_TOKEN" } } },
  });
  saveJson("vault.json", { vaultId: token.id, customerId: token.customer?.id, savedAt: new Date().toISOString() });
  console.log(`Saved wallet: vault_id ${token.id} (stored in spikes/out/vault.json)\n`);
  return token.id;
}

const vaultId = (typeof arg("vault-id") === "string" && arg("vault-id")) || loadJson("vault.json")?.vaultId || (await saveWallet());
const cart = cartOf("TRL-GRY-10");

console.log(`Creating an AUTHORIZE order for ${cartTotal(cart)} USD with vault_id ${vaultId}, no buyer present...`);
let order;
try {
  order = await createAuthorizeOrder(cart, { vaultId, customId: "witness:spike-03", label: "vault-authorize-order" });
} catch (err) {
  console.log(`✘ Order creation failed: ${err.message}`);
  console.log(`  debug id ${err.debugId}; full response in ${err.file}`);
}

let auth = authorizationOf(order);
if (order && !auth && order.status === "APPROVED") {
  console.log("Order is APPROVED without buyer action; calling authorize...");
  auth = authorizationOf(await authorizeOrder(order.id));
}

if (auth) {
  console.log(`✔ Authorization ${auth.id}: ${auth.status} (order ${order.id} is ${order.status})`);
  await voidAuthorization(auth.id); // clean up so the hold doesn't linger
  console.log(`  Voided it again to release the hold.`);
  console.log("\nGATE 2 (human-not-present authorization): PASS -> build Second Key as designed.");
  process.exit(0);
}

if (order) {
  console.log(`✘ No authorization. Order ${order.id} status: ${order.status}`);
  const action = link(order, "payer-action");
  if (action) console.log(`  PayPal wants buyer action: ${action}`);
}

// Control run: does the saved wallet work at all with CAPTURE?
console.log("\nControl: trying the same vault_id with intent CAPTURE (documented path)...");
const control = await paypal("POST", "/v2/checkout/orders", {
  label: "vault-capture-control",
  allowFail: true,
  body: {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }],
    payment_source: { paypal: { vault_id: vaultId } },
  },
});
const controlOk = control.ok && control.data?.status === "COMPLETED";
console.log(`  CAPTURE control: HTTP ${control.status} ${control.data?.status ?? control.data?.name ?? ""}`);

console.log(
  controlOk
    ? "\nGATE 2: FAIL (API limitation): the vault works, but AUTHORIZE with a vault_id does not.\n" +
        "-> Use the human-present fallback (buyer approves each order), or rethink the hold."
    : "\nGATE 2: INCONCLUSIVE (configuration): the vault itself is not working.\n" +
        "-> Check Vault is enabled on the sandbox app, then rerun before deciding anything.",
);
process.exitCode = 1;
