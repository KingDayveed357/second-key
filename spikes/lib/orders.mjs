// Orders v2 + Payments v2 helpers for the authorize -> capture | void lifecycle.

import { paypal, link, pollUntil, RETURN_URL, CANCEL_URL } from "./paypal.mjs";

const toCents = (v) => Math.round(Number(v) * 100);
export const fromCents = (c) => (c / 100).toFixed(2);

export function cartTotal(cart) {
  return fromCents(cart.items.reduce((sum, i) => sum + toCents(i.unit_amount) * i.quantity, 0));
}

/**
 * Create an order with intent AUTHORIZE carrying real line items, so PayPal's own
 * record of the order can later be matched against what Second Key approved.
 * Pass vaultId to pay with a saved PayPal wallet (no buyer present).
 */
export async function createAuthorizeOrder(cart, { customId, vaultId, label = "create-order" } = {}) {
  const total = cartTotal(cart);
  const body = {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: "witness-default",
        custom_id: customId?.slice(0, 127),
        amount: {
          currency_code: cart.currency,
          value: total,
          breakdown: { item_total: { currency_code: cart.currency, value: total } },
        },
        items: cart.items.map((i) => ({
          name: i.name.slice(0, 127),
          sku: i.sku,
          quantity: String(i.quantity),
          unit_amount: { currency_code: cart.currency, value: Number(i.unit_amount).toFixed(2) },
          category: "PHYSICAL_GOODS",
        })),
      },
    ],
    payment_source: vaultId
      ? { paypal: { vault_id: vaultId } }
      : {
          paypal: {
            experience_context: {
              brand_name: "Second Key Demo Store",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: RETURN_URL,
              cancel_url: CANCEL_URL,
            },
          },
        },
  };
  const { data } = await paypal("POST", "/v2/checkout/orders", { body, label });
  return data;
}

export function approvalUrl(order) {
  return link(order, "payer-action") ?? link(order, "approve");
}

export async function getOrder(orderId, label = "get-order") {
  return (await paypal("GET", `/v2/checkout/orders/${orderId}`, { label })).data;
}

/** Wait for the sandbox buyer to approve the order in their browser. */
export async function waitForApproval(orderId) {
  let dots = 0;
  return pollUntil(
    async () => {
      const order = await getOrder(orderId, "poll-order");
      return order.status === "APPROVED" ? order : null;
    },
    { onWait: () => process.stdout.write(++dots % 20 === 0 ? ".\n" : ".") },
  );
}

export async function authorizeOrder(orderId) {
  return (await paypal("POST", `/v2/checkout/orders/${orderId}/authorize`, { body: {}, label: "authorize-order" })).data;
}

export function authorizationOf(order) {
  return order?.purchase_units?.[0]?.payments?.authorizations?.[0] ?? null;
}

export async function getAuthorization(authId) {
  return (await paypal("GET", `/v2/payments/authorizations/${authId}`, { label: "get-authorization" })).data;
}

/** Capture an explicit amount. Never rely on PayPal's 115% overage default. */
export async function captureAuthorization(authId, amount, { allowFail = false } = {}) {
  return paypal("POST", `/v2/payments/authorizations/${authId}/capture`, {
    body: { amount, final_capture: true },
    label: "capture-authorization",
    allowFail,
  });
}

export async function voidAuthorization(authId) {
  return paypal("POST", `/v2/payments/authorizations/${authId}/void`, { body: {}, label: "void-authorization" });
}

export async function getCapture(captureId) {
  return (await paypal("GET", `/v2/payments/captures/${captureId}`, { label: "get-capture" })).data;
}
