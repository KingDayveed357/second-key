// Public evidence playground (/try): real analysis, policy shown separately, never a payment, bounded,
// rate-limited, fails closed, and a repeated input is served from a labelled cache.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiKey } from "@witness/db";
import { FakeLlm } from "@witness/ai";
import { buildApp } from "../src/app.ts";
import { parseConversation } from "../src/analyze.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
let app: FastifyInstance;
let demoKey = "";
const ai = new FakeLlm().on("manipulation", (input) => {
  const lines = (JSON.parse(input) as { conversation: { text: string }[] }).conversation;
  const hit = lines.find((l) => /bail|tell her|holding account/i.test(l.text));
  return hit
    ? {
        risk: "high",
        tactics: [
          { tactic: "urgency", quote: hit.text.slice(0, 40), speaker: "x", why: "deadline" },
          { tactic: "secrecy", quote: "wire it to the escrow agent tonight", speaker: "x", why: "invented by the model" },
        ],
        legitimate_explanation: "A real relative could be in trouble.",
        confidence: 0.9,
        needs_independent_verification: true,
        recommended_action: "hold_and_verify",
      }
    : { risk: "low", tactics: [], legitimate_explanation: "Agreed invoice from a known contractor.", confidence: 0.9, needs_independent_verification: false, recommended_action: "proceed" };
});
const post = (payload: unknown, key: string | null = demoKey) =>
  app.inject({ method: "POST", url: "/v1/demo/analyze", headers: key ? { authorization: `Bearer ${key}` } : {}, payload: payload as Record<string, unknown> });

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, console: { demoAi: ai, demoAnalysesPerMinute: 4 } });
  await app.ready();
  demoKey = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe("/v1/demo/analyze", () => {
  test("labelled synthetic samples include legitimate urgency and a calm scam", async () => {
    const s = (await app.inject({ method: "GET", url: "/v1/demo/samples" })).json();
    expect(s.length).toBeGreaterThanOrEqual(6);
    expect(s.every((x: { provenance: string }) => /Synthetic/.test(x.provenance))).toBe(true);
    expect(s.map((x: { expected: string }) => x.expected)).toEqual(expect.arrayContaining(["suspicious", "legitimate"]));
  });

  test("findings are only quotes found in the text; invented ones are shown as discarded; policy is separate; no payment, no PayPal call", async () => {
    const purchases = (await h.pool.query("SELECT count(*)::int AS n FROM purchases")).rows[0].n;
    const calls = h.fake.calls.length;
    const r = (await post({ sample: "grandparent-call" })).json();
    expect(r.analysis).toMatchObject({ ok: true, risk: "high", prompt_version: "manipulation@v2" });
    expect(r.analysis.findings).toHaveLength(1);
    const f = r.analysis.findings[0];
    expect(r.conversation.lines[f.line].text).toContain(f.quote);
    expect(r.analysis.discarded_quotes).toEqual(["wire it to the escrow agent tonight"]);
    expect(r.policy).toMatchObject({ intervention: "HOLD_FOR_TRUSTED_CONTACT", rule: "E3 one pattern, model concerned", check_result: "unknown" });
    expect(r.no_payment).toMatch(/no intent, payment or PayPal call/);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM purchases")).rows[0].n).toBe(purchases);
    expect(h.fake.calls.length).toBe(calls);
  });

  test("a legitimate message passes this check, and the policy says so in words", async () => {
    const r = (await post({ sample: "agreed-invoice" })).json();
    expect(r.policy).toMatchObject({ intervention: "PROCEED", rule: "E7 nothing found", check_result: "pass" });
    expect(r.analysis.findings).toEqual([]);
  });

  test("pasted text: 'Name: message' sets the speaker; a repeat is served from a labelled cache", async () => {
    const text = "Caller: we set up a secure holding account for you.\nCaller: do not tell the branch staff.";
    const first = (await post({ text, context: "phone call" })).json();
    expect(first.conversation.lines.map((l: { speaker: string }) => l.speaker)).toEqual(["Caller", "Caller"]);
    expect(first.cached).toBeUndefined();
    const again = (await post({ text, context: "phone call" })).json();
    expect(again.cached).toMatchObject({ seconds_ago: expect.any(Number) });
  });

  test("the model failing never produces a result: the analysis says unavailable and policy fails closed", async () => {
    const down = new FakeLlm();
    down.failAll("timeout");
    const bare = buildApp({ deps: h.d, console: { demoAi: down } });
    await bare.ready();
    const r = (await bare.inject({ method: "POST", url: "/v1/demo/analyze", headers: { authorization: `Bearer ${demoKey}` }, payload: { sample: "agreed-invoice" } })).json();
    expect(r.analysis).toMatchObject({ ok: false, failure: "timeout", findings: [] });
    expect(r.policy).toMatchObject({ intervention: "HOLD_FOR_TRUSTED_CONTACT", rule: "E0 fail closed" });
    await bare.close();
  });

  test("bounded and authenticated input", async () => {
    expect((await post({ text: "short" })).statusCode).toBe(400);
    expect((await post({ text: "x".repeat(4001) })).statusCode).toBe(400);
    expect((await post({ text: "a long enough message here", payee: "x" })).statusCode).toBe(400);
    expect((await post({ text: Array.from({ length: 61 }, (_, i) => `line number ${i}`).join("\n") })).statusCode).toBe(400);
    expect((await post({ sample: "nope" })).statusCode).toBe(404);
    expect((await post({ sample: "agreed-invoice" }, null)).statusCode).toBe(401);
  });

  test("rate limited per minute (cached repeats don't count)", async () => {
    const limited = buildApp({ deps: h.d, console: { demoAi: ai, demoAnalysesPerMinute: 2 } });
    await limited.ready();
    const go = (text: string) => limited.inject({ method: "POST", url: "/v1/demo/analyze", headers: { authorization: `Bearer ${demoKey}` }, payload: { text } });
    expect((await go("first distinct message here")).statusCode).toBe(200);
    expect((await go("first distinct message here")).statusCode).toBe(200); // cached
    expect((await go("second distinct message here")).statusCode).toBe(200);
    const third = await go("third distinct message here");
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    await limited.close();
  });
});

describe("parseConversation", () => {
  test("lines without a speaker become 'Message'; blank lines dropped", () => {
    const c = parseConversation("hello there\n\nBob: hi", "ctx");
    expect(c).toMatchObject({ context: "ctx", lines: [{ speaker: "Message", text: "hello there" }, { speaker: "Bob", text: "hi" }] });
  });
});
