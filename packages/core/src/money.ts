// Money is integer cents everywhere inside Second Key. Strings only at the PayPal boundary.

export class MoneyError extends Error {}

// All supported currencies use two decimal places, so cents are exact.
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export type Currency = (typeof CURRENCIES)[number];

const AMOUNT = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;

/** "84.00" -> 8400. Rejects negatives, exponents, more than two decimals and anything else odd. */
export function toCents(value: string): number {
  if (typeof value !== "string" || !AMOUNT.test(value)) {
    throw new MoneyError(`not a valid amount: ${JSON.stringify(value)}`);
  }
  const [whole = "0", frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 8400 -> "84.00" */
export function fromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new MoneyError(`not a valid cent amount: ${cents}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Catalog prices arrive as numbers (e.g. 110 or 84.5). Convert once, carefully. */
export function numberToCents(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new MoneyError(`not a valid price: ${amount}`);
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) throw new MoneyError(`price has sub-cent precision: ${amount}`);
  return cents;
}
