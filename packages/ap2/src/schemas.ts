// AP2 v0.2 canonical JSON schemas, vendored unchanged from the reference repository (see
// schemas/VERSION.md), compiled once. Each schema is registered under the URL its file path
// implies: upstream's receipt_status.json declares `$id` ".../receipt-status.json" while the
// receipts reference "types/receipt_status.json", so trusting the declared `$id`s breaks `$ref`.

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import checkoutMandate from "../schemas/ap2/checkout_mandate.json" with { type: "json" };
import checkoutReceipt from "../schemas/ap2/checkout_receipt.json" with { type: "json" };
import openCheckoutMandate from "../schemas/ap2/open_checkout_mandate.json" with { type: "json" };
import openPaymentMandate from "../schemas/ap2/open_payment_mandate.json" with { type: "json" };
import paymentMandate from "../schemas/ap2/payment_mandate.json" with { type: "json" };
import paymentReceipt from "../schemas/ap2/payment_receipt.json" with { type: "json" };
import amount from "../schemas/ap2/types/amount.json" with { type: "json" };
import item from "../schemas/ap2/types/item.json" with { type: "json" };
import jwk from "../schemas/ap2/types/jwk.json" with { type: "json" };
import merchant from "../schemas/ap2/types/merchant.json" with { type: "json" };
import paymentInstrument from "../schemas/ap2/types/payment_instrument.json" with { type: "json" };
import pisp from "../schemas/ap2/types/pisp.json" with { type: "json" };
import receiptStatus from "../schemas/ap2/types/receipt_status.json" with { type: "json" };
import buyer from "../schemas/ucp/types/buyer.json" with { type: "json" };
import checkout from "../schemas/ucp/types/checkout.json" with { type: "json" };
import lineItem from "../schemas/ucp/types/line_item.json" with { type: "json" };
import link from "../schemas/ucp/types/link.json" with { type: "json" };
import message from "../schemas/ucp/types/message.json" with { type: "json" };
import messageError from "../schemas/ucp/types/message_error.json" with { type: "json" };
import messageInfo from "../schemas/ucp/types/message_info.json" with { type: "json" };
import messageWarning from "../schemas/ucp/types/message_warning.json" with { type: "json" };
import total from "../schemas/ucp/types/total.json" with { type: "json" };

const BASE = "https://ap2-protocol.org/schemas/";

const FILES: Record<string, object> = {
  "checkout_mandate.json": checkoutMandate,
  "checkout_receipt.json": checkoutReceipt,
  "open_checkout_mandate.json": openCheckoutMandate,
  "open_payment_mandate.json": openPaymentMandate,
  "payment_mandate.json": paymentMandate,
  "payment_receipt.json": paymentReceipt,
  "types/amount.json": amount,
  "types/item.json": item,
  "types/jwk.json": jwk,
  "types/merchant.json": merchant,
  "types/payment_instrument.json": paymentInstrument,
  "types/pisp.json": pisp,
  "types/receipt_status.json": receiptStatus,
  "types/buyer.json": buyer,
  "types/checkout.json": checkout,
  "types/line_item.json": lineItem,
  "types/link.json": link,
  "types/message.json": message,
  "types/message_error.json": messageError,
  "types/message_info.json": messageInfo,
  "types/message_warning.json": messageWarning,
  "types/total.json": total,
};

export type SchemaName =
  | "open_checkout_mandate"
  | "checkout_mandate"
  | "open_payment_mandate"
  | "payment_mandate"
  | "checkout_receipt"
  | "payment_receipt"
  | "checkout";

const PATHS: Record<SchemaName, string> = {
  open_checkout_mandate: "open_checkout_mandate.json",
  checkout_mandate: "checkout_mandate.json",
  open_payment_mandate: "open_payment_mandate.json",
  payment_mandate: "payment_mandate.json",
  checkout_receipt: "checkout_receipt.json",
  payment_receipt: "payment_receipt.json",
  checkout: "types/checkout.json",
};

let ajv: Ajv2020 | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function validator(name: SchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (v) return v;
  if (!ajv) {
    // `format` is an annotation in draft 2020-12 unless a vocabulary asserts it; keep it so.
    ajv = new Ajv2020({ allErrors: true, validateFormats: false });
    ajv.addKeyword({ keyword: "x-selectively-disclosable-field" });
    ajv.addKeyword({ keyword: "x-selectively-disclosable-array" });
    for (const [path, schema] of Object.entries(FILES)) ajv.addSchema({ ...schema, $id: BASE + path });
  }
  v = ajv.getSchema(BASE + PATHS[name])!;
  compiled.set(name, v);
  return v;
}

export const formatSchemaError = (e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`;

/** Validate a decoded (disclosures applied) object against one of the canonical schemas. */
export function validateSchema(name: SchemaName, value: unknown): string[] {
  const v = validator(name);
  return v(value) ? [] : (v.errors ?? []).map(formatSchemaError);
}
