// Checkout adapters turn a verified cart into the PayPal order body (ADR-0004).
// In a real integration this is the merchant's order system. The faulty adapters exist only to
// demonstrate what the three-way match catches when that integration is buggy or compromised.

import { fromCents } from "./money.ts";
import type { ResolvedCart } from "./checks.ts";
import type { CartItemKey } from "./digest.ts";

export interface OrderContext {
  purchaseId: string;
  policyDigest: string;
  vaultId: string;
}

export interface CheckoutAdapter {
  readonly name: string;
  buildOrder(cart: ResolvedCart, ctx: OrderContext): Record<string, unknown>;
}

/** What Second Key expects to find in PayPal's order for this cart. */
export const expectedItems = (cart: ResolvedCart): CartItemKey[] =>
  cart.lines.map((l) => ({ sku: l.product_id, quantity: l.quantity, unit_cents: l.unit_cents }));

function orderBody(cart: ResolvedCart, ctx: OrderContext, items: { sku: string; name: string; quantity: number; unit_cents: number }[], payee?: string) {
  const total = items.reduce((s, i) => s + i.unit_cents * i.quantity, 0);
  return {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: ctx.purchaseId,
        invoice_id: ctx.purchaseId,
        custom_id: `w1:${ctx.purchaseId}:${ctx.policyDigest.replace("sha256:", "")}`.slice(0, 255),
        ...(payee ? { payee: { merchant_id: payee } } : {}),
        amount: {
          currency_code: cart.currency,
          value: fromCents(total),
          breakdown: { item_total: { currency_code: cart.currency, value: fromCents(total) } },
        },
        items: items.map((i) => ({
          name: i.name.slice(0, 127),
          sku: i.sku,
          quantity: String(i.quantity),
          unit_amount: { currency_code: cart.currency, value: fromCents(i.unit_cents) },
          category: "PHYSICAL_GOODS",
        })),
      },
    ],
    payment_source: { paypal: { vault_id: ctx.vaultId } },
  };
}

const linesOf = (cart: ResolvedCart) => cart.lines.map((l) => ({ sku: l.product_id, name: l.name, quantity: l.quantity, unit_cents: l.unit_cents }));

export const standardAdapter: CheckoutAdapter = {
  name: "standard",
  buildOrder: (cart, ctx) => orderBody(cart, ctx, linesOf(cart)),
};

/** Demo only: swaps the first line for another product at the same price (a cart swap). */
export const swapAdapter = (to: { sku: string; name: string }): CheckoutAdapter => ({
  name: "faulty:swap",
  buildOrder: (cart, ctx) => {
    const [first, ...rest] = linesOf(cart);
    return orderBody(cart, ctx, first ? [{ ...first, sku: to.sku, name: to.name }, ...rest] : rest);
  },
});

/** Demo only: sends the money to a different payee. */
export const payeeAdapter = (merchantId: string): CheckoutAdapter => ({
  name: "faulty:payee",
  buildOrder: (cart, ctx) => orderBody(cart, ctx, linesOf(cart), merchantId),
});

/** What PayPal's stored order must contain for this cart, order and payee. */
export function expectationFor(cart: ResolvedCart, orderId: string, payeeMerchantId: string) {
  return {
    order_id: orderId,
    currency: cart.currency,
    amount_cents: cart.total_cents,
    payee_merchant_id: payeeMerchantId,
    items: expectedItems(cart),
  };
}
