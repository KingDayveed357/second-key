// evaluateScreen (what the evals measure) must reach the same screening outcome as the engine does
// for every demo scenario (whose engine outcomes are proven by the pipeline tests).

import { describe, expect, test } from "vitest";
import { evaluateScreen } from "@witness/ai";
import { FixtureCatalog } from "@witness/catalog";
import { SCENARIOS, demoPolicy, transferPolicy, transferRequest } from "@witness/engine";
import { harnessAi } from "../test-support/fake-ai.ts";

describe("eval function agrees with the engine", () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const now = new Date("2026-10-12T12:00:00Z");
      const r = s.transfer
        ? await evaluateScreen(harnessAi(), transferPolicy(now, s.transfer), transferRequest("int", s.transfer.conversation, s.transfer.payee.id, s.transfer.amount_cents), new Map(), { now })
        : await evaluateScreen(harnessAi(), demoPolicy(now), { intent_id: "int", retailer: "rei.com", lines: [{ product_id: s.product, quantity: 1 }] }, (await new FixtureCatalog().getProducts([s.product])).facts, { now });
      // The cart swap happens after screening (in PayPal's order), so screening says CAPTURE.
      expect(r.outcome).toBe(s.expected === "VOID" ? "CAPTURE" : s.expected);
    });
  }
});
