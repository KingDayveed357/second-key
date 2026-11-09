import { beforeAll, describe, expect, test } from "vitest";
import { MemoryLedger, presentHop, verifyPresentation, VCT, disclose, digest, type PresentationVerification } from "../src/index.ts";
import {
  checkoutFor,
  checkoutOpts,
  decodeDisclosure,
  editDisclosures,
  MERCHANT,
  NOW,
  openPaymentWith,
  OTHER_MERCHANT,
  paymentOpts,
  payFor,
  world,
  type World,
} from "./fixtures.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});

const present = (ledger: MemoryLedger, checkout: string, payment?: string, now = NOW) =>
  verifyPresentation({ checkout: { chain: checkout, options: checkoutOpts(w) }, ...(payment ? { payment: { chain: payment, options: paymentOpts(w) } } : {}), now }, ledger);
const summary = (v: PresentationVerification) => ({ decision: v.decision, error: v.error, findings: v.findings.map((f) => f.code), failed: v.constraints.filter((c) => c.result !== "pass").map((c) => c.type) });

describe("one presentation", () => {
  test("the spec-shaped checkout + payment conforms, with every constraint evaluated", async () => {
    const v = await present(new MemoryLedger(), w.checkoutChain, w.paymentChain);
    expect(summary(v)).toEqual({ decision: "CONFORMS", error: undefined, findings: [], failed: [] });
    expect(v.constraints.map((c) => c.type)).toEqual(["checkout.line_items", "checkout.allowed_merchants", "payment.amount_range", "payment.allowed_payees", "payment.reference"]);
  });

  test("a broken chain is invalid_credential, and nothing is evaluated or recorded", async () => {
    const ledger = new MemoryLedger();
    const forged = editDisclosures(w.checkoutChain, 0, (ds) => [...ds].reverse());
    const v = await present(ledger, forged, w.paymentChain);
    expect(summary(v)).toMatchObject({ decision: "NONCONFORMING", error: "invalid_credential", findings: ["binding_mismatch"] });
    expect(ledger.usage.size).toBe(0);
  });

  test("the wrong product is invalid_mandate", async () => {
    const c = await checkoutFor(w, { sku: "sku_white_9" });
    expect(summary(await present(new MemoryLedger(), c.chain))).toEqual({ decision: "NONCONFORMING", error: "invalid_mandate", findings: [], failed: ["checkout.line_items"] });
  });

  test("paying more than the checkout total is caught even inside the amount range", async () => {
    const pay = await payFor(w, w.openPayment, { hash: w.checkoutHash, price: 19950, merchant: MERCHANT });
    expect(summary(await present(new MemoryLedger(), w.checkoutChain, pay)).findings).toEqual(["amount_mismatch"]);
  });

  test("an unknown constraint means CANNOT_CONFIRM (unresolved_constraint), not a pass", async () => {
    const c = await checkoutFor(w, {
      mandate: {
        vct: VCT.openCheckout,
        constraints: [
          { type: "checkout.line_items", items: [{ id: "l", acceptable_items: [disclose({ id: "sku_gold_9", title: "Gold" })], quantity: 1 }] },
          { type: "com.example.loyalty_tier", min: "gold" },
        ],
        cnf: { jwk: w.agent.jwk },
      },
    });
    expect(summary(await present(new MemoryLedger(), c.chain))).toEqual({ decision: "CANNOT_CONFIRM", error: "unresolved_constraint", findings: [], failed: ["com.example.loyalty_tier"] });
  });
});

describe("the ledger", () => {
  test("an open checkout mandate is single-use: a second closed checkout from it is refused", async () => {
    const ledger = new MemoryLedger();
    expect((await present(ledger, w.checkoutChain)).decision).toBe("CONFORMS");
    const again = await presentHop({ chain: w.openCheckout, key: w.agent.privateKey, mandate: w.closedCheckout, aud: "merchant", nonce: "n-checkout-2", iat: NOW });
    const second = await verifyPresentation({ checkout: { chain: again, options: { ...checkoutOpts(w), nonce: "n-checkout-2" } }, now: NOW }, ledger);
    expect(summary(second)).toMatchObject({ decision: "NONCONFORMING", findings: ["ledger.open_mandate_reused"] });
  });

  test("replaying the same closed mandate is refused", async () => {
    const ledger = new MemoryLedger();
    await present(ledger, w.checkoutChain, w.paymentChain);
    expect(summary(await present(ledger, w.checkoutChain, w.paymentChain)).findings).toEqual(
      expect.arrayContaining(["ledger.closed_mandate_reused", "ledger.open_mandate_reused"]),
    );
  });

  test("presenting the open mandate with fewer disclosures does not reset its use count", async () => {
    const ledger = new MemoryLedger();
    await present(ledger, w.checkoutChain);
    // Drop the second merchant's disclosure from the open checkout and close it again.
    const c = await checkoutFor(w);
    const first = await present(ledger, c.chain);
    expect(first.decision).toBe("CONFORMS");
    const [jwt, ...ds] = c.open.split("~").filter(Boolean);
    const trimmed = [jwt, ...ds.filter((d) => !JSON.stringify(decodeDisclosure(d)).includes("merchant_2")), ""].join("~");
    expect(trimmed).not.toBe(c.open);
    const reclosed = await presentHop({ chain: trimmed, key: w.agent.privateKey, mandate: { vct: VCT.checkout, checkout_jwt: disclose(w.checkoutJwt), checkout_hash: w.checkoutHash }, aud: "merchant", nonce: "n-checkout", iat: NOW });
    expect(summary(await present(ledger, reclosed)).findings).toEqual(["ledger.open_mandate_reused"]);
  });

  test("a nonconforming presentation does not consume the mandate", async () => {
    const ledger = new MemoryLedger();
    const bad = await payFor(w, w.openPayment, { hash: w.checkoutHash, price: 19950, merchant: MERCHANT });
    expect((await present(ledger, w.checkoutChain, bad)).decision).toBe("NONCONFORMING");
    expect(ledger.usage.size).toBe(0);
    expect((await present(ledger, w.checkoutChain, w.paymentChain)).decision).toBe("CONFORMS");
  });

  describe("a recurring payment mandate with a budget, across merchants", () => {
    // One open checkout, paid by one recurring payment mandate that references it.
    const recurring = async (w: World) => {
      const openCheckout = (await checkoutFor(w)).open;
      const open = await openPaymentWith(w, openCheckout, [
        { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 5 },
        { type: "payment.amount_range", currency: "USD", max: 30000 },
        { type: "payment.budget", max: 500, currency: "USD" },
        { type: "payment.allowed_payees", allowed: [disclose(MERCHANT), disclose(OTHER_MERCHANT)] },
      ]);
      return { open, at: (o: { price: number; merchant?: typeof MERCHANT }) => checkoutFor(w, { ...o, open: openCheckout }) };
    };

    test("spend at two merchants counts against one budget", async () => {
      const ledger = new MemoryLedger();
      const { open, at } = await recurring(w);
      const a = await at({ price: 25000, merchant: MERCHANT });
      const b = await at({ price: 20000, merchant: OTHER_MERCHANT });
      const c = await at({ price: 10000, merchant: OTHER_MERCHANT });

      const first = await present(ledger, a.chain, await payFor(w, open, a));
      expect(first.decision).toBe("CONFORMS");
      expect(first.ledger.find((e) => e.kind === "open_payment")).toMatchObject({ usesBefore: 0, budgetRemainingMinor: 25000 });

      const second = await present(ledger, b.chain, await payFor(w, open, b));
      expect(second.decision).toBe("CONFORMS");
      expect(second.ledger.find((e) => e.kind === "open_payment")).toMatchObject({ usesBefore: 1, budgetRemainingMinor: 5000 });

      const third = await present(ledger, c.chain, await payFor(w, open, c));
      expect(summary(third)).toMatchObject({ decision: "NONCONFORMING", failed: ["payment.budget"] });
    });

    test("concurrent presentations cannot both spend the last of the budget", async () => {
      const ledger = new MemoryLedger();
      const { open, at } = await recurring(w);
      const cs = await Promise.all([at({ price: 30000 }), at({ price: 30000, merchant: OTHER_MERCHANT })]);
      const pays = await Promise.all(cs.map((c) => payFor(w, open, c)));
      const vs = await Promise.all(cs.map((c, i) => present(ledger, c.chain, pays[i])));
      expect(vs.map((v) => v.decision).sort()).toEqual(["CONFORMS", "NONCONFORMING"]);
    });

    test("max_occurrences stops the sixth use", async () => {
      const ledger = new MemoryLedger();
      const { open, at } = await recurring(w);
      const decisions: string[] = [];
      for (let i = 0; i < 6; i++) {
        const c = await at({ price: 1000 });
        decisions.push((await present(ledger, c.chain, await payFor(w, open, c))).decision);
      }
      expect(decisions).toEqual(["CONFORMS", "CONFORMS", "CONFORMS", "CONFORMS", "CONFORMS", "NONCONFORMING"]);
    });
  });

  test("without recurrence, both open mandates are single-use", async () => {
    const ledger = new MemoryLedger();
    const openCheckout = (await checkoutFor(w)).open;
    const open = await openPaymentWith(w, openCheckout, [{ type: "payment.amount_range", currency: "USD", max: 30000 }]);
    const a = await checkoutFor(w, { open: openCheckout });
    const b = await checkoutFor(w, { open: openCheckout, merchant: OTHER_MERCHANT });
    expect((await present(ledger, a.chain, await payFor(w, open, a))).decision).toBe("CONFORMS");
    const second = summary(await present(ledger, b.chain, await payFor(w, open, b)));
    expect(second.findings).toEqual(["ledger.open_mandate_reused", "ledger.open_mandate_reused"]);
  });

  test("a recurring payment mandate does not unlock an open checkout it doesn't reference", async () => {
    const ledger = new MemoryLedger();
    const { open } = await (async () => {
      const oc = (await checkoutFor(w)).open;
      return { open: await openPaymentWith(w, oc, [{ type: "payment.agent_recurrence", frequency: "ON_DEMAND" }, { type: "payment.amount_range", currency: "USD", max: 30000 }, { type: "payment.budget", max: 1000, currency: "USD" }]) };
    })();
    await present(ledger, w.checkoutChain);
    const v = summary(await present(ledger, w.checkoutChain.replace("n-checkout", "n-checkout"), await payFor(w, open, { hash: w.checkoutHash, price: 19900, merchant: MERCHANT })));
    expect(v.findings).toContain("ledger.open_mandate_reused");
    expect(v.failed).toContain("payment.reference");
  });

  test("a payment for another checkout is refused", async () => {
    const pay = await payFor(w, w.openPayment, { hash: digest("other"), price: 19900, merchant: MERCHANT });
    expect(summary(await present(new MemoryLedger(), w.checkoutChain, pay)).findings).toEqual(["transaction_id_mismatch"]);
  });
});
