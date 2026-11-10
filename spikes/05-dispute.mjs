// Spike 05: can a dispute be opened on a Second Key-captured order, defended with
// Second Key's record as evidence, and settled in the sandbox?
//
//   node spikes/05-dispute.mjs create            # uses spikes/out/record-order-A.json
//   node spikes/05-dispute.mjs create --buyer-txn <id> --payer-id <id> --amount 20
//   node spikes/05-dispute.mjs list
//   node spikes/05-dispute.mjs next <dispute-id> # run repeatedly; does the next allowed step
//
// Sandbox note: dispute actions appear a few minutes after creation. `next` only takes
// actions that PayPal currently lists in the dispute's links, so rerunning it is safe.
// The final verdict is chosen by us (SELLER_FAVOR) through a sandbox-only endpoint:
// this proves the evidence pipeline, not that PayPal judged the evidence.

import { paypal, hasLink, loadJson, saveJson, arg, CLIENT_ID } from "./lib/paypal.mjs";

const [, , command, disputeIdArg] = process.argv;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const buyerAssertion = (payerId) => `${b64url({ alg: "none" })}.${b64url({ iss: CLIENT_ID, payer_id: payerId })}.`;

async function create() {
  const rec = loadJson("record-order-A.json");
  const payerId = arg("payer-id") ?? rec?.payerId;
  let buyerTxn = arg("buyer-txn");
  if (!buyerTxn && rec) {
    buyerTxn = rec.captureId;
    console.log(`No --buyer-txn given; trying the capture ID ${buyerTxn}.`);
    console.log("If PayPal rejects it, copy the buyer's transaction ID from the sandbox buyer's Activity page.\n");
  }
  if (!payerId || !buyerTxn) throw new Error("Need --payer-id and --buyer-txn (or run spike 02 first).");

  const res = await paypal("POST", "/v1/customer/disputes", {
    label: "create-dispute",
    allowFail: true,
    headers: { "PayPal-Auth-Assertion": buyerAssertion(payerId) },
    form: {
      disputed_transactions: [{ buyer_transaction_id: buyerTxn }],
      reason: arg("reason") ?? "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      dispute_amount: { currency_code: "USD", value: String(arg("amount") ?? "20.00") },
      extensions: {
        merchant_contacted: true,
        merchant_contacted_outcome: "NO_RESPONSE",
        merchandize_dispute_properties: { issue_type: "PRODUCT" },
      },
    },
  });

  if (!res.ok) {
    console.log(`✘ Create failed: HTTP ${res.status} ${res.data?.details?.[0]?.issue ?? res.data?.name ?? ""}`);
    console.log(`  ${res.data?.details?.[0]?.description ?? res.data?.message ?? ""}`);
    console.log(`  Full response: ${res.file}`);
    console.log("\nFallback: log in as the sandbox buyer at https://www.sandbox.paypal.com, open the payment");
    console.log("in Activity, report a problem, then run `list` to find the dispute ID.");
    process.exitCode = 1;
    return;
  }
  const href = res.data?.links?.[0]?.href ?? "";
  const id = href.split("/").pop();
  console.log(`✔ Dispute created: ${id}`);
  console.log("Wait a few minutes, then run:  node spikes/05-dispute.mjs next " + id);
}

async function list() {
  const { data } = await paypal("GET", "/v1/customer/disputes?page_size=20", { label: "list-disputes" });
  const items = data.items ?? [];
  if (!items.length) console.log("No disputes yet.");
  for (const d of items) {
    console.log(`${d.dispute_id}  ${d.status.padEnd(28)} ${d.reason}  ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}`);
  }
}

function evidenceNotes() {
  const rec = loadJson("record-order-A.json");
  if (!rec) return "Second Key evidence record: see attached intent and cart verification.";
  return [
    "Second Key evidence record.",
    `Buyer's recorded instruction: "${rec.intent}" (SHA-256 intent digest ${rec.intentDigest}, also carried in the order's custom_id; not cryptographically signed).`,
    `Cart verified against that instruction before capture; approved cart digest ${rec.cartDigest}.`,
    `PayPal order ${rec.orderId}, authorization ${rec.authorizationId}, capture ${rec.captureId}, ${rec.amount.value} ${rec.amount.currency_code}.`,
    "The captured order matched the verified cart exactly (three-way match: intent, product facts, PayPal order).",
  ].join(" ");
}

async function next(id) {
  if (!id) throw new Error("Usage: next <dispute-id>");
  const state = loadJson(`dispute-${id}.json`) ?? { evidenceProvided: false, steps: [] };
  const { data: d } = await paypal("GET", `/v1/customer/disputes/${id}`, { label: "show-dispute" });
  console.log(`Dispute ${id}: ${d.status} (${d.dispute_life_cycle_stage ?? "?"}), outcome: ${d.dispute_outcome?.outcome_code ?? "none"}`);
  console.log(`Allowed actions: ${(d.links ?? []).map((l) => l.rel).filter((r) => r !== "self").join(", ") || "none yet"}`);

  const step = async (name, path, opts) => {
    await paypal("POST", `/v1/customer/disputes/${id}/${path}`, { label: name, ...opts });
    state.steps.push({ name, at: new Date().toISOString() });
    console.log(`✔ ${name}`);
  };

  if (d.status === "RESOLVED") {
    const won = /SELLER/.test(d.dispute_outcome?.outcome_code ?? "");
    console.log(`\nGATE 4 (dispute defended with Second Key evidence): ${won && state.evidenceProvided ? "PASS" : "CHECK"}`);
  } else if (hasLink(d, "provide_evidence")) {
    await step("provide-evidence", "provide-evidence", { form: { evidences: [{ evidence_type: "OTHER", notes: evidenceNotes() }] } });
    state.evidenceProvided = true;
  } else if (state.evidenceProvided && hasLink(d, "adjudicate")) {
    await step("adjudicate SELLER_FAVOR", "adjudicate", { body: { adjudication_outcome: "SELLER_FAVOR" } });
  } else if (hasLink(d, "require_evidence")) {
    await step("require-evidence SELLER_EVIDENCE", "require-evidence", { body: { action: "SELLER_EVIDENCE" } });
  } else {
    console.log("Nothing to do yet. Sandbox actions appear a few minutes after creation; rerun shortly.");
  }
  saveJson(`dispute-${id}.json`, state);
}

const commands = { create, list, next: () => next(disputeIdArg) };
if (!commands[command]) {
  console.log("Usage: node spikes/05-dispute.mjs create | list | next <dispute-id>");
  process.exit(1);
}
await commands[command]();
