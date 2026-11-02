// ADR-0020: the second key is held by someone else. These tests prove the invariant through the public
// API: the payer's credential can never approve a guardian-protected payment, read the guardian's
// channel, or obtain a guardian credential; a guardian credential decides only its own hold, dies with
// a re-notify, replacement or revocation, and never outlives its guardian's authority; the standing
// profile can't be weakened by a payment's intent, and loosening waits.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { newId } from "@witness/core";
import { createApiKey, withTx } from "@witness/db";
import { FakeLlm } from "@witness/ai";
import { recordPaidPayee, type Notifier } from "@witness/engine";
import { buildApp } from "../src/app.ts";
import { createHarness, type Harness } from "../../../test-support/harness.ts";

let h: Harness;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const HOUR = 3600_000;

/** A transfer intent policy written by a caller (possibly hostile): $1,800 to this payee. */
const transferPolicyOf = (now: Date, payee: { id: string; name: string; first_payment: boolean; email?: string }, threshold?: number) => ({
  version: 1,
  kind: "transfer",
  payee,
  amount_cents: 180000,
  currency: "USD",
  purpose: "test",
  ...(threshold !== undefined ? { review_threshold_cents: threshold } : {}),
  expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
});

beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ deps: h.d, demoShopperId: h.shopperId });
  await app.ready();
  keys.demo = (await createApiKey(h.pool, h.tenantId, "demo", ["demo"])).key;
  keys.admin = (await createApiKey(h.pool, h.tenantId, "admin", ["admin"])).key;
  keys.ops = (await createApiKey(h.pool, h.tenantId, "ops:g", ["ops"])).key;
  keys.agent = (await createApiKey(h.pool, h.tenantId, "agent:g", ["agent:purchase"])).key;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

type Inbox = { address: string; secret: string };
const post = (url: string, key: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { ...bearer(key), ...extra }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const get = (url: string, key: string, extra: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { ...bearer(key), ...extra } });

const newPayer = async () => (await post("/v1/demo/payers", keys.demo!)).json() as { shopper_id: string; key: string };
const newInbox = async (): Promise<Inbox> => (await post("/v1/demo/inboxes", keys.demo!)).json();
const inbox = async (i: Inbox) => (await get(`/v1/demo/inboxes/${i.address}/messages`, keys.demo!, { "x-inbox-secret": i.secret })).json().messages as { id: string; kind: string; purchase_id: string | null; actionable: boolean; guardian: { id: string } }[];
const open = (i: Inbox, msgId: string) => post(`/v1/demo/inboxes/${i.address}/messages/${msgId}/open`, keys.demo!, undefined, { "x-inbox-secret": i.secret });
const latestReview = async (i: Inbox, purchaseId: string) => (await inbox(i)).find((m) => m.kind === "hold_review" && m.purchase_id === purchaseId && m.actionable);
const tokenFor = async (i: Inbox, purchaseId: string) => {
  await h.drain();
  const m = await latestReview(i, purchaseId);
  expect(m, "an actionable review request in the guardian's inbox").toBeDefined();
  const r = await open(i, m!.id);
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
};
const decide = (id: string, d: "approve" | "deny", body: unknown, key?: string) => app.inject({ method: "POST", url: `/v1/holds/${id}/${d}`, ...(key ? { headers: bearer(key) } : {}), payload: body as Record<string, unknown> });
const holdOf = async (id: string) => (await h.pool.query("SELECT * FROM holds WHERE purchase_id = $1", [id])).rows[0];
const stateOf = async (id: string) => (await h.pool.query("SELECT state FROM purchases WHERE id = $1", [id])).rows[0].state as string;
const auditTypes = async (id: string) => (await h.pool.query("SELECT event_type, payload FROM audit_log WHERE purchase_id = $1 ORDER BY seq", [id])).rows as { event_type: string; payload: Record<string, unknown> }[];

/** Rose with Sarah enrolled (invited, accepted through Sarah's inbox, assigned) and a $500 rule. */
async function protectedPayer(name = "Sarah") {
  const payer = await newPayer();
  const sarah = await newInbox();
  expect((await post("/v1/me/guardians", payer.key, { display_name: name, address: sarah.address })).statusCode).toBe(200);
  await h.drain();
  const invite = (await inbox(sarah)).find((m) => m.kind === "invite")!;
  expect(invite.actionable).toBe(true);
  // The payer's own key can't accept on Sarah's behalf: the route needs the demo role and Sarah's secret.
  expect((await post(`/v1/demo/inboxes/${sarah.address}/messages/${invite.id}/accept`, payer.key, undefined, { "x-inbox-secret": sarah.secret })).statusCode).toBe(403);
  expect((await post(`/v1/demo/inboxes/${sarah.address}/messages/${invite.id}/accept`, keys.demo!, undefined, { "x-inbox-secret": sarah.secret })).statusCode).toBe(200);
  const view = (await post("/v1/me/protection/guardian", payer.key, { guardian_id: invite.guardian.id })).json();
  expect(view).toMatchObject({ protection_on: true, guardian: { name } });
  expect((await post("/v1/me/protection/threshold", payer.key, { threshold_cents: 50000 })).json()).toMatchObject({ threshold_cents: 50000 });
  return { payer, sarah, guardianId: invite.guardian.id };
}

async function scamHold(payerKey: string, evidence = true) {
  const r = await post(`/v1/me/demo/transfers/scam_transfer${evidence ? "" : "?evidence=none"}`, payerKey);
  expect(r.statusCode).toBe(202);
  const p = r.json().purchase;
  expect(p.state).toBe("HELD");
  return p.id as string;
}

describe("the payer can't exercise the guardian's authority", () => {
  test("Rose can't approve, by bearer key or hold-link; an admin can't either; the hold stays HELD and the refusal is audited", async () => {
    const { payer } = await protectedPayer();
    const id = await scamHold(payer.key);
    const hold = await holdOf(id);
    expect(hold).toMatchObject({ approver: "guardian" });
    expect(hold.reason_classes).toEqual(expect.arrayContaining(["POLICY_REVIEW", "EVIDENCE_CONCERN"]));

    const self = await decide(id, "approve", {}, payer.key);
    expect(self.statusCode).toBe(403);
    expect(self.json().title).toMatch(/Only Sarah can approve/);
    expect((await decide(id, "approve", {}, keys.admin)).statusCode).toBe(403);
    // No shopper route hands out a credential for a guardian hold.
    expect((await post(`/v1/purchases/${id}/hold-link`, payer.key)).statusCode).toBe(409);
    const remind = await post(`/v1/me/holds/${id}/notify`, payer.key);
    expect(remind.statusCode).toBe(429); // created moments ago with the hold
    expect(await stateOf(id)).toBe("HELD");
    expect((await auditTypes(id)).filter((e) => e.event_type === "hold.approve_refused")).toHaveLength(2);
  });

  test("Rose's key can't read Sarah's inbox; the inbox needs the demo role AND Sarah's secret, in the right tenant", async () => {
    const { payer, sarah } = await protectedPayer();
    await scamHold(payer.key);
    await h.drain();
    expect((await get(`/v1/demo/inboxes/${sarah.address}/messages`, payer.key, { "x-inbox-secret": sarah.secret })).statusCode).toBe(403);
    expect((await get(`/v1/demo/inboxes/${sarah.address}/messages`, keys.demo!)).statusCode).toBe(401);
    expect((await get(`/v1/demo/inboxes/${sarah.address}/messages`, keys.demo!, { "x-inbox-secret": "w".repeat(32) })).statusCode).toBe(403);
    // Another tenant's demo key can't see this inbox at all.
    const other = newId("ten");
    await h.pool.query("INSERT INTO tenants (id, name, paypal_merchant_id) VALUES ($1, 'Other', 'X')", [other]);
    const otherDemo = (await createApiKey(h.pool, other, "demo", ["demo"])).key;
    expect((await get(`/v1/demo/inboxes/${sarah.address}/messages`, otherDemo, { "x-inbox-secret": sarah.secret })).statusCode).toBe(404);
    // Nothing the payer can call returns a credential: the hold view carries delivery state only.
    const v = (await get(`/v1/holds/${(await inbox(sarah)).find((m) => m.kind === "hold_review")!.purchase_id}`, payer.key)).json();
    expect(JSON.stringify(v)).not.toMatch(/"token"|credential_hash/);
    expect(v.approver).toMatchObject({ kind: "guardian", guardian: { name: "Sarah", status: "ACTIVE" } });
    expect(v.notification).toMatchObject({ status: "DELIVERED", seq: 1 });
  });

  test("a query-string credential is never accepted", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    expect((await app.inject({ method: "GET", url: `/v1/holds/${id}?t=${token}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/view`, payload: { token } })).statusCode).toBe(200);
  });
});

describe("Sarah decides exactly the payment assigned to her", () => {
  test("her credential can't act on another hold; it approves her own; the decision is hers; the executor captures; history records the payee", async () => {
    const { payer, sarah, guardianId } = await protectedPayer();
    const a = await scamHold(payer.key);
    const b = await scamHold(payer.key);
    const tokenA = await tokenFor(sarah, a);
    await tokenFor(sarah, b); // b has its own live credential; a's can't decide it
    expect((await decide(b, "approve", { token: tokenA })).statusCode).toBe(403);
    const ok = await decide(a, "approve", { token: tokenA });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: "CAPTURE_APPROVED", resolution: "APPROVED" });
    // A credential decides once: the same decision replays the record; the opposite gets 409.
    expect((await decide(a, "approve", { token: tokenA })).json()).toMatchObject({ replayed: true });
    expect((await decide(a, "deny", { token: tokenA })).statusCode).toBe(409);
    await h.drain();
    expect(await stateOf(a)).toBe("CAPTURED");
    const decisions = (await h.pool.query("SELECT decided_by FROM decisions WHERE purchase_id = $1 ORDER BY id", [a])).rows.map((r) => r.decided_by);
    expect(decisions).toEqual(["engine", `guardian:${guardianId}`]);
    const hist = await h.pool.query("SELECT source, purchase_id FROM payee_history WHERE shopper_id = $1 AND payee_key = 'id:payee_jmorgan'", [payer.shopper_id]);
    expect(hist.rows).toEqual([{ source: "captured", purchase_id: a }]);
  });

  test("Sarah declining cancels that purchase only, recorded as her decline (not the payer's cancel)", async () => {
    const { payer, sarah, guardianId } = await protectedPayer();
    const id = await scamHold(payer.key);
    const r = await decide(id, "deny", { token: await tokenFor(sarah, id) });
    expect(r.json()).toMatchObject({ state: "VOIDING", resolution: "DENIED" });
    const d = (await h.pool.query("SELECT decided_by, reasons FROM decisions WHERE purchase_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
    expect(d).toEqual({ decided_by: `guardian:${guardianId}`, reasons: ["the trusted contact declined this payment"] });
    await h.drain();
    expect(await stateOf(id)).toBe("VOIDED");
  });

  test("Rose cancelling is recorded as the payer's cancel; Sarah's credential then gets 409", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    expect((await post(`/v1/me/holds/${id}/cancel`, payer.key)).json()).toMatchObject({ resolution: "CANCELLED" });
    expect((await h.pool.query("SELECT decided_by FROM decisions WHERE purchase_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0].decided_by).toBe(`payer:${payer.shopper_id}`);
    expect((await decide(id, "approve", { token })).statusCode).toBe(409);
  });

  test("concurrent payer cancel and guardian approve: exactly one applies", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    const [c, a] = await Promise.all([post(`/v1/me/holds/${id}/cancel`, payer.key), decide(id, "approve", { token })]);
    expect([c.statusCode, a.statusCode].sort()).toEqual([200, 409]);
  });
});

describe("credential lifecycle", () => {
  test("a reminder supersedes the request and kills the old credential; at most one per minute; it never returns a credential", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const first = await tokenFor(sarah, id);
    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    const r = await post(`/v1/me/holds/${id}/notify`, payer.key);
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(["sent_to", "seq"]);
    expect(r.json().sent_to).toMatch(/^Sarah · •••• /);
    expect((await post(`/v1/me/holds/${id}/notify`, payer.key)).statusCode).toBe(429);
    expect((await decide(id, "approve", { token: first })).statusCode).toBe(410);
    const second = await tokenFor(sarah, id);
    expect((await decide(id, "approve", { token: second })).statusCode).toBe(200);
  });

  test("ten wrong credentials clear the live one; the right one then needs a fresh request", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    for (let i = 0; i < 10; i++) expect((await decide(id, "approve", { token: `${"z".repeat(31)}${i}` })).statusCode).toBe(403);
    expect((await decide(id, "approve", { token })).statusCode).toBe(410);
    expect(await stateOf(id)).toBe("HELD");
  });

  test("a credential expires on server time and never outlives the hold", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    const hold = await holdOf(id);
    expect(hold.credential_expires_at.getTime()).toBeLessThanOrEqual(hold.auto_void_at.getTime());
    h.clock.now = new Date(h.clock.now.getTime() + 31 * 60_000);
    expect((await decide(id, "approve", { token })).statusCode).toBe(410);
  });
});

describe("notifications: a transactional outbox", () => {
  test("delivery failure leaves the hold HELD, retries with backoff, shows the payer the failure, and never grants the payer approval", async () => {
    const saved = h.d.notifier;
    const down: Notifier = { deliver: async () => Promise.reject(new Error("provider down")) };
    const { payer } = await protectedPayer();
    h.d.notifier = down;
    try {
      const id = await scamHold(payer.key);
      await h.drain();
      const n = (await h.pool.query("SELECT status, attempts, last_error FROM notifications WHERE purchase_id = $1", [id])).rows[0];
      expect(n).toMatchObject({ status: "PENDING", attempts: 1, last_error: "provider down" });
      const v = (await get(`/v1/holds/${id}`, payer.key)).json();
      expect(v.notification).toMatchObject({ status: "PENDING", attempts: 1, last_error: "provider down" });
      expect((await decide(id, "approve", {}, payer.key)).statusCode).toBe(403);
      expect(await stateOf(id)).toBe("HELD");
    } finally {
      h.d.notifier = saved;
    }
  });
});

describe("the standing profile is authoritative", () => {
  test("a malicious intent can't weaken it: a huge intent threshold and first_payment:false for an unknown payee are still held", async () => {
    const { payer } = await protectedPayer();
    const policy = transferPolicyOf(h.clock.now, { id: "payee_new", name: "New Person", first_payment: false }, 10_000_000);
    const i = await post("/v1/intents", payer.key, { policy });
    expect(i.statusCode).toBe(201);
    await post(`/v1/intents/${i.json().id}/confirm`, payer.key);
    const r = await app.inject({ method: "POST", url: "/v1/purchases", headers: { ...bearer(keys.agent!), "idempotency-key": `g-${Math.random()}` }, payload: { kind: "transfer", intent_id: i.json().id, payee_id: "payee_new", amount_cents: 180000, currency: "USD" } });
    expect(r.json().state).toBe("HELD");
    const snap = (await h.pool.query("SELECT protection FROM purchases WHERE id = $1", [r.json().id])).rows[0].protection;
    expect(snap).toMatchObject({ profile_threshold_cents: 50000, intent_threshold_cents: 10_000_000, paid_before: false, protection_on: true });
    expect((await holdOf(r.json().id)).approver).toBe("guardian");
  });

  test("a known payee id with a new payout email is a NEW payee", async () => {
    const { payer } = await protectedPayer();
    // Rose has paid Morgan & Sons (seeded for every demo payer): id payee_morgan_sons, no email.
    const policy = transferPolicyOf(h.clock.now, { id: "payee_morgan_sons", name: "Morgan & Sons Builders", first_payment: false, email: "scammer@example.com" });
    const i = await post("/v1/intents", payer.key, { policy });
    await post(`/v1/intents/${i.json().id}/confirm`, payer.key);
    const r = await app.inject({ method: "POST", url: "/v1/purchases", headers: { ...bearer(keys.agent!), "idempotency-key": `g-${Math.random()}` }, payload: { kind: "transfer", intent_id: i.json().id, payee_id: "payee_morgan_sons", amount_cents: 180000, currency: "USD" } });
    expect(r.json().state).toBe("HELD");
    // The genuine known payee (same id, no new email) goes straight through.
    const ok = await post("/v1/me/demo/transfers/benign_transfer", payer.key);
    await h.drain();
    expect(await stateOf(ok.json().purchase.id)).toBe("CAPTURED");
  });

  test("threshold semantics: strict body, same value 409, raise is pending, tighten supersedes, one pending loosen at a time", async () => {
    const { payer } = await protectedPayer();
    for (const bad of [{}, { threshold_cents: -1 }, { threshold_cents: "500" }, { threshold_cents: 1.5 }, { threshold_cents: 100, effective_at: "2020-01-01T00:00:00Z" }]) {
      expect((await post("/v1/me/protection/threshold", payer.key, bad)).statusCode).toBe(422);
    }
    expect((await post("/v1/me/protection/threshold", payer.key, { threshold_cents: 50000 })).statusCode).toBe(409);
    const raised = (await post("/v1/me/protection/threshold", payer.key, { threshold_cents: 200000 })).json();
    expect(raised.threshold_cents).toBe(50000); // still in force
    expect(raised.pending).toEqual([expect.objectContaining({ kind: "threshold", value: { threshold_cents: 200000 } })]);
    expect(new Date(raised.pending[0].effective_at).getTime() - h.clock.now.getTime()).toBe(48 * HOUR);
    expect((await post("/v1/me/protection/threshold", payer.key, { threshold_cents: null })).statusCode).toBe(409);
    const tightened = (await post("/v1/me/protection/threshold", payer.key, { threshold_cents: 0 })).json();
    expect(tightened).toMatchObject({ threshold_cents: 0, pending: [] });
  });

  test("a loosen applies only after 48 h of server time, and never changes a payment already screened", async () => {
    const { payer } = await protectedPayer();
    const before = await scamHold(payer.key);
    const v0 = (await h.pool.query("SELECT protection FROM purchases WHERE id = $1", [before])).rows[0].protection.profile_version;
    await post("/v1/me/protection/threshold", payer.key, { threshold_cents: null });
    h.clock.now = new Date(h.clock.now.getTime() + 47 * HOUR);
    expect((await get("/v1/me/protection", payer.key)).json().threshold_cents).toBe(50000);
    h.clock.now = new Date(h.clock.now.getTime() + 2 * HOUR);
    const after = (await get("/v1/me/protection", payer.key)).json();
    expect(after).toMatchObject({ threshold_cents: null, pending: [] });
    expect(after.version).toBeGreaterThan(v0);
    // The earlier payment keeps the snapshot (and the decision) it was screened under.
    expect((await h.pool.query("SELECT protection FROM purchases WHERE id = $1", [before])).rows[0].protection).toMatchObject({ profile_version: v0, profile_threshold_cents: 50000 });
    expect(await stateOf(before)).toBe("HELD");
  });
});

describe("guardian lifecycle with payments pending", () => {
  async function enrolSecond(payerKey: string, name = "Tom") {
    const tom = await newInbox();
    await post("/v1/me/guardians", payerKey, { display_name: name, address: tom.address });
    await h.drain();
    const inv = (await inbox(tom)).find((m) => m.kind === "invite")!;
    await post(`/v1/demo/inboxes/${tom.address}/messages/${inv.id}/accept`, keys.demo!, undefined, { "x-inbox-secret": tom.secret });
    return { tom, tomId: inv.guardian.id };
  }

  test("replacement: pending for 48 h (Sarah keeps authority and is told); then holds move to Tom, Sarah's credential dies, Tom is asked", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const sarahToken = await tokenFor(sarah, id);
    const { tom, tomId } = await enrolSecond(payer.key);
    const pending = (await post("/v1/me/protection/guardian", payer.key, { guardian_id: tomId })).json();
    expect(pending).toMatchObject({ guardian: { name: "Sarah" }, pending: [expect.objectContaining({ kind: "guardian" })] });
    await h.drain();
    expect((await inbox(sarah)).some((m) => m.kind === "authority_change")).toBe(true);
    // During the delay Sarah's authority stands.
    expect((await app.inject({ method: "POST", url: `/v1/holds/${id}/view`, payload: { token: sarahToken } })).statusCode).toBe(200);

    h.clock.now = new Date(h.clock.now.getTime() + 49 * HOUR);
    expect((await get("/v1/me/protection", payer.key)).json()).toMatchObject({ guardian: { name: "Tom" } });
    expect((await holdOf(id)).guardian_id).toBe(tomId);
    expect((await decide(id, "approve", { token: sarahToken })).statusCode).toBe(410);
    expect(await stateOf(id)).toBe("HELD");
    const tomToken = await tokenFor(tom, id);
    expect((await decide(id, "approve", { token: tomToken })).statusCode).toBe(200);
  });

  test("removal: after 48 h nobody can approve the open hold, never the payer; the payer can cancel", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    expect((await post("/v1/me/protection/guardian/remove", payer.key)).statusCode).toBe(200);
    h.clock.now = new Date(h.clock.now.getTime() + 49 * HOUR);
    expect((await get("/v1/me/protection", payer.key)).json()).toMatchObject({ protection_on: false, guardian: null });
    expect((await holdOf(id))).toMatchObject({ approver: "guardian", guardian_id: null });
    expect((await decide(id, "approve", { token })).statusCode).toBe(410);
    expect((await decide(id, "approve", {}, payer.key)).statusCode).toBe(403);
    expect((await post(`/v1/me/holds/${id}/notify`, payer.key)).statusCode).toBe(409);
    expect((await post(`/v1/me/holds/${id}/cancel`, payer.key)).json()).toMatchObject({ resolution: "CANCELLED" });
  });

  test("emergency revocation: immediate, reasoned and audited; Sarah's credential dies; protection stays on; a replacement still waits 48 h", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    expect((await post("/v1/me/protection/guardian/revoke", payer.key, {})).statusCode).toBe(422);
    const r = (await post("/v1/me/protection/guardian/revoke", payer.key, { reason: "her phone was stolen" })).json();
    expect(r).toMatchObject({ protection_on: true, guardian: null });
    expect((await decide(id, "approve", { token })).statusCode).toBe(410);
    expect((await decide(id, "approve", {}, payer.key)).statusCode).toBe(403);
    expect(await stateOf(id)).toBe("HELD");
    // A new payment is still guardian-protected (unassigned), not handed to the payer.
    const fresh = await scamHold(payer.key);
    expect(await holdOf(fresh)).toMatchObject({ approver: "guardian", guardian_id: null });
    // Re-granting authority after a guardian existed is delayed.
    const { tom, tomId } = await enrolSecond(payer.key);
    expect((await post("/v1/me/protection/guardian", payer.key, { guardian_id: tomId })).json()).toMatchObject({ guardian: null, pending: [expect.objectContaining({ kind: "guardian" })] });
    h.clock.now = new Date(h.clock.now.getTime() + 49 * HOUR);
    await get("/v1/me/protection", payer.key);
    expect((await holdOf(id)).guardian_id).toBe(tomId);
    expect(await tokenFor(tom, id)).toBeTruthy();
    expect((await h.pool.query("SELECT ended_reason, status FROM guardians WHERE address = $1", [sarah.address])).rows[0]).toEqual({ ended_reason: "her phone was stolen", status: "REVOKED" });
  });

  test("revocation racing an approval: either the approval landed first, or the credential is dead; never both", async () => {
    const { payer, sarah } = await protectedPayer();
    const id = await scamHold(payer.key);
    const token = await tokenFor(sarah, id);
    const [rev, ap] = await Promise.all([post("/v1/me/protection/guardian/revoke", payer.key, { reason: "compromised" }), decide(id, "approve", { token })]);
    expect(rev.statusCode).toBe(200);
    const hold = await holdOf(id);
    if (ap.statusCode === 200) expect(hold.resolution).toBe("APPROVED");
    else {
      expect(ap.statusCode).toBe(410);
      expect(hold).toMatchObject({ resolved_at: null, guardian_id: null });
    }
  });
});

describe("assessment failures and tenant isolation", () => {
  test("AI unavailable: held, classed ASSESSMENT_UNAVAILABLE (not evidence), guardian decides; never PROCEED", async () => {
    const { payer } = await protectedPayer();
    const saved = h.d.ai;
    const down = new FakeLlm();
    down.failAll("timeout");
    h.d.ai = down;
    try {
      // A known payee below nothing: the rule doesn't fire, only the failed check holds it.
      const r = await post("/v1/me/demo/transfers/benign_transfer", payer.key);
      const id = r.json().purchase.id;
      expect(await stateOf(id)).toBe("HELD");
      expect(await holdOf(id)).toMatchObject({ approver: "guardian", reason_classes: ["ASSESSMENT_UNAVAILABLE"] });
    } finally {
      h.d.ai = saved;
    }
  });

  test("another tenant's payer can't see, remind, cancel or decide this tenant's hold", async () => {
    const { payer } = await protectedPayer();
    const id = await scamHold(payer.key);
    const other = newId("ten");
    const otherShopper = newId("shp");
    await h.pool.query("INSERT INTO tenants (id, name, paypal_merchant_id) VALUES ($1, 'Other', 'X')", [other]);
    await h.pool.query("INSERT INTO shoppers (id, tenant_id, display_name, vault_id) VALUES ($1, $2, 'Eve', 'v')", [otherShopper, other]);
    const eve = (await createApiKey(h.pool, other, `shopper:${otherShopper}`, ["shopper"])).key;
    expect((await get(`/v1/holds/${id}`, eve)).statusCode).toBe(404);
    expect((await post(`/v1/me/holds/${id}/notify`, eve)).statusCode).toBe(404);
    expect((await post(`/v1/me/holds/${id}/cancel`, eve)).statusCode).toBe(404);
    expect((await decide(id, "approve", {}, eve)).statusCode).toBe(404);
  });

  test("payee history: only captures count, and a duplicate capture adds nothing", async () => {
    const { payer } = await protectedPayer();
    const r = await post("/v1/me/demo/transfers/benign_transfer", payer.key);
    await h.drain();
    const p = (await h.pool.query("SELECT id, tenant_id AS \"tenantId\", intent_id AS \"intentId\", request FROM purchases WHERE id = $1", [r.json().purchase.id])).rows[0];
    await withTx(h.pool, (tx) => recordPaidPayee(tx, p, new Date()));
    const rows = (await h.pool.query("SELECT source FROM payee_history WHERE shopper_id = $1 ORDER BY source", [payer.shopper_id])).rows.map((x) => x.source);
    expect(rows).toEqual(["imported"]); // the demo seed already recorded Morgan & Sons; the capture added no duplicate
    // A voided payment establishes nothing.
    const scam = await scamHold(payer.key);
    await post(`/v1/me/holds/${scam}/cancel`, payer.key);
    await h.drain();
    expect((await h.pool.query("SELECT count(*)::int AS n FROM payee_history WHERE shopper_id = $1 AND payee_key = 'id:payee_jmorgan'", [payer.shopper_id])).rows[0].n).toBe(0);
  });
});
