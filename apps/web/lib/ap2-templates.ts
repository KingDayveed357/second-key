// Constraint templates a platform can start from: the `constraints` arrays of an Open Checkout and an
// Open Payment Mandate, in AP2 v0.2's canonical shapes plus Second Key's extension types. Values in
// angle brackets are placeholders to fill in. Exported as JSON from /developers.

export interface ConstraintTemplate {
  id: string;
  title: string;
  summary: string;
  /** Which parties' checks enforce it. */
  enforcedBy: string[];
  open_checkout: { vct: "mandate.checkout.open.1"; constraints: unknown[] };
  open_payment: { vct: "mandate.payment.open.1"; constraints: unknown[] };
  notes: string[];
}

const MERCHANT = { id: "<merchant id>", name: "<merchant name>", website: "<https://merchant.example>" };
const REFERENCE = { type: "payment.reference", conditional_transaction_id: "<sd_hash of the Open Checkout Mandate as the agent will present it>" };

export const TEMPLATES: ConstraintTemplate[] = [
  {
    id: "exactly-what-i-meant",
    title: "One item, exactly what I meant",
    summary: "A short list of acceptable items, one merchant, a price cap, and the attributes AP2 can't express (size 10, not white).",
    enforcedBy: ["Any AP2 verifier: line_items, allowed_merchants, amount_range, allowed_payees, reference", "Second Key: item_attributes against facts it fetches and signs"],
    open_checkout: {
      vct: "mandate.checkout.open.1",
      constraints: [
        { type: "checkout.line_items", items: [{ id: "item-1", acceptable_items: [{ id: "<sku>", title: "<title>" }, { id: "<another sku>", title: "<title>" }], quantity: 1 }] },
        { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
        { type: "x-secondkey.item_attributes.1", rules: [{ attribute: "size", any_of: ["10"] }, { attribute: "color", none_of: ["white"] }] },
      ],
    },
    open_payment: {
      vct: "mandate.payment.open.1",
      constraints: [{ type: "payment.amount_range", currency: "USD", max: 9000 }, { type: "payment.allowed_payees", allowed: [MERCHANT] }, REFERENCE],
    },
    notes: [
      "Issue acceptable_items as disclosed: a verifier matches only the items it can see.",
      "Don't make item_attributes rules selectively disclosable: withholding one would loosen the mandate.",
      "amount_range is in minor units (9000 = $90.00).",
    ],
  },
  {
    id: "monthly-with-budget",
    title: "A monthly purchase with a budget",
    summary: "The agent may buy once a month, at most 12 times, never more than $40 a time or $300 in total, across merchants.",
    enforcedBy: ["Any AP2 verifier: line_items, amount_range, reference", "The verifier's ledger: agent_recurrence and budget (Second Key keeps one ledger across merchants)"],
    open_checkout: {
      vct: "mandate.checkout.open.1",
      constraints: [{ type: "checkout.line_items", items: [{ id: "refill", acceptable_items: [{ id: "<sku>", title: "<title>" }], quantity: 1 }] }],
    },
    open_payment: {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.agent_recurrence", frequency: "MONTHLY", max_occurrences: 12 },
        { type: "payment.amount_range", currency: "USD", max: 4000 },
        { type: "payment.budget", max: 300.0, currency: "USD" },
        REFERENCE,
      ],
    },
    notes: [
      "agent_recurrence needs amount_range and budget alongside it.",
      "budget.max is in major units (300.00 = $300), unlike amount_range: that is how the spec's example and the reference SDK read it.",
      "Months are UTC calendar months: one presentation per month.",
    ],
  },
  {
    id: "two-person-rule",
    title: "A second signature above a threshold",
    summary: "Up to $500 the agent can pay alone; above it, a co-signer's own key must sign that exact payment.",
    enforcedBy: ["Any AP2 verifier: amount_range, allowed_payees, reference", "Second Key: cosign (COSIGN_REQUIRED until the enrolled key signs)"],
    open_checkout: {
      vct: "mandate.checkout.open.1",
      constraints: [{ type: "checkout.allowed_merchants", allowed: [MERCHANT] }, { type: "checkout.line_items", items: [{ id: "order", acceptable_items: [{ id: "<sku>", title: "<title>" }], quantity: 1 }] }],
    },
    open_payment: {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.amount_range", currency: "USD", max: 250000 },
        { type: "payment.allowed_payees", allowed: [MERCHANT] },
        { type: "x-secondkey.cosign.1", cosigner: { name: "<co-signer>", jwk: { kty: "EC", crv: "P-256", x: "<base64url x>", y: "<base64url y>" } }, when: { amount_over: 50000, currency: "USD" } },
        REFERENCE,
      ],
    },
    notes: [
      "The co-signer signs the closed payment mandate's reference (returned with COSIGN_REQUIRED) with a JWT of typ secondkey-cosign+jwt.",
      "Only the enrolled key counts: the agent's own key, or anyone else's, is refused.",
    ],
  },
];

/** The file a developer downloads: the template plus where it came from. */
export const templateFile = (t: ConstraintTemplate) =>
  JSON.stringify({ $comment: "AP2 v0.2 constraint template from Second Key. Fill in the <placeholders>; the spec is at github.com/google-agentic-commerce/AP2.", template: t.id, title: t.title, open_checkout: t.open_checkout, open_payment: t.open_payment, notes: t.notes }, null, 2);
