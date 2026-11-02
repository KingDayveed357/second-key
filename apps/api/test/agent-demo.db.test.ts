// The agent demo's runs: a steered agent is refused on Rose's own limits before PayPal is called; the
// scenario list carries the page the scripted agent read (fixture text, never a live catalog call).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey } from "@witness/db";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
let app: FastifyInstance;
let demo = "";
let ops = "";

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  ops = (await createApiKey(h.pool, h.tenantId, "ops:a", ["ops"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe("agent demo", () => {
  test("steered agent: the cart breaks Rose's budget, so it is refused before any PayPal call", async () => {
    const calls = h.fake.calls.length;
    const r = (await app.inject({ method: "POST", url: "/v1/demo/scenarios/steered", headers: { authorization: `Bearer ${demo}` } })).json();
    expect(r.purchase).toMatchObject({ state: "REJECTED", paypal: { order_id: null } });
    expect(h.fake.calls.length).toBe(calls);
    const ev = (await app.inject({ method: "GET", url: `/v1/purchases/${r.purchase.id}/evidence`, headers: { authorization: `Bearer ${ops}` } })).json();
    expect(ev.checks.find((c: { check_id: string }) => c.check_id === "max_total")).toMatchObject({ result: "fail" });
    expect(Object.keys(ev.facts)).toEqual(["TRL-PRO-10"]);
    expect(ev.intent.policy).toMatchObject({ max_total_cents: 9000, hard: { excluded_colors: ["white"], size: "10" } });
  });

  test("the scenario list shows the page each agent run read, and what it put in the cart", async () => {
    const list = (await app.inject({ method: "GET", url: "/v1/demo/scenarios" })).json() as { name: string; agent?: { followed_note: boolean; read: { product_id: string; description: string | null }; cart_product: string } }[];
    const steered = list.find((s) => s.name === "steered")!;
    expect(steered.agent).toMatchObject({ followed_note: true, read: { product_id: "TRL-INJECT" }, cart_product: "TRL-PRO-10" });
    expect(steered.agent!.read.description).toMatch(/SYSTEM NOTE TO SHOPPING AGENTS/);
    expect(list.find((s) => s.name === "injection")!.agent).toMatchObject({ followed_note: false, cart_product: "TRL-INJECT" });
    expect(list.find((s) => s.name === "scam_transfer")!.agent).toBeUndefined();
  });
});
