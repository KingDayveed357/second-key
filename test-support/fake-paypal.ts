// A stateful fake of the PayPal endpoints Second Key uses, for deterministic pipeline tests.
// Behaviour mirrors what Stage 1 observed on the real sandbox (docs/spike-results.md):
// - a vault_id order is created AND authorized in one call; the response is a minimal
//   representation (reference_id + payments only); GET returns the full order
// - POSTs are idempotent by PayPal-Request-Id (same ID -> same stored response)
// - capturing a voided authorization -> 422 AUTHORIZATION_VOIDED; final_capture blocks further captures
// Knobs inject failures (network errors before/after PayPal applies a call) and tampering.

type Json = any;

interface Auth {
  id: string;
  orderId: string;
  status: "CREATED" | "CAPTURED" | "VOIDED";
  currency: string;
  value: string;
}
interface Capture {
  id: string;
  authId: string;
  status: string;
  currency: string;
  value: string;
}

export type FailMode = "network-before" | "network-after" | "http-500";

export class FakePayPal {
  readonly payee: string;
  orders = new Map<string, Json>();
  auths = new Map<string, Auth>();
  captures = new Map<string, Capture>();
  disputes = new Map<string, { id: string; captureId: string; value: string; currency: string; status: string; links: string[]; evidence: Json; outcome: string | null }>();
  /** Raw body of the last multipart request. */
  lastMultipart: string | null = null;
  idempotent = new Map<string, { status: number; body: Json }>();
  calls: { method: string; path: string; requestId?: string }[] = [];
  #seq = 0;
  #failures: { match: RegExp; mode: FailMode }[] = [];
  /** Status returned by the next capture instead of COMPLETED (e.g. "PENDING"). */
  nextCaptureStatus: string | null = null;
  /** Amount value PayPal records for the next capture instead of the requested one (anomaly test). */
  nextCaptureValue: string | null = null;
  /** Raw body of the last verify-webhook-signature call, to prove events are posted back verbatim. */
  lastVerifyBody: string | null = null;
  /** Payout batches (Second Key). An item reports `nextPayoutItemStatus` (default SUCCESS) once read. */
  payouts = new Map<string, { id: string; senderBatchId: string; receiver: string; value: string; currency: string; itemId: string; itemStatus: string }>();
  nextPayoutItemStatus = "SUCCESS";

  constructor(payee = "7L6D422CPFA9Q") {
    this.payee = payee;
  }

  #id(prefix: string) {
    return `${prefix}${String(++this.#seq).padStart(13, "0")}`;
  }

  failNext(match: RegExp, mode: FailMode) {
    this.#failures.push({ match, mode });
  }

  /** Simulate something changing PayPal's stored order after authorization (e.g. a PATCH). */
  mutateOrder(orderId: string, fn: (pu: Json) => void) {
    fn(this.orders.get(orderId).purchase_units[0]);
  }

  count(method: string, pathPattern: RegExp) {
    return this.calls.filter((c) => c.method === method && pathPattern.test(c.path)).length;
  }

  get fetch(): typeof fetch {
    return (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const headers = (init.headers ?? {}) as Record<string, string>;
      const requestId = headers["PayPal-Request-Id"];
      const path = url.pathname;
      if (path === "/v1/notifications/verify-webhook-signature") this.lastVerifyBody = String(init.body);
      if (path !== "/v1/oauth2/token") this.calls.push({ method, path, ...(requestId ? { requestId } : {}) });
      if (path === "/v1/oauth2/token") return this.#json(200, { access_token: "fake-token", expires_in: 32400 });

      const failure = this.#failures.findIndex((f) => f.match.test(`${method} ${path}`));
      const mode = failure >= 0 ? this.#failures.splice(failure, 1)[0]!.mode : null;
      if (mode === "network-before") throw new TypeError("fetch failed (injected, before PayPal applied it)");
      if (mode === "http-500") return this.#json(500, { name: "INTERNAL_SERVER_ERROR" });

      let res: { status: number; body: Json };
      const key = requestId ? `${method} ${path} ${requestId}` : null;
      if (key && this.idempotent.has(key)) res = this.idempotent.get(key)!;
      else {
        res = this.#handle(method, path, this.#parseBody(headers["Content-Type"] ?? "", init.body));
        if (key && res.status < 500) this.idempotent.set(key, res);
      }
      if (mode === "network-after") throw new TypeError("fetch failed (injected, after PayPal applied it)");
      return this.#json(res.status, res.body);
    }) as typeof fetch;
  }

  /** JSON, or multipart/form-data whose part named "input" holds JSON (Disputes provide-evidence). */
  #parseBody(contentType: string, raw: unknown): Json {
    if (!raw) return undefined;
    const text = String(raw);
    const b = contentType.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
    if (!b) return JSON.parse(text);
    this.lastMultipart = text;
    const part = text.split(`--${b}`).find((x) => /Content-Disposition: form-data; name="input"/.test(x));
    if (!part) return { __multipart_without_input: true };
    return JSON.parse(part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, ""));
  }

  /** Simulate a buyer opening a dispute on a capture. stage "inquiry" needs require-evidence first. */
  openDispute(captureId: string, o: { stage?: "inquiry" | "evidence" } = {}): string {
    const c = this.captures.get(captureId);
    if (!c) throw new Error(`no capture ${captureId}`);
    const id = this.#id("PP-D");
    this.disputes.set(id, { id, captureId, value: c.value, currency: c.currency, status: "WAITING_FOR_SELLER_RESPONSE", links: o.stage === "inquiry" ? ["require_evidence"] : ["provide_evidence"], evidence: null, outcome: null });
    return id;
  }

  #json(status: number, body: Json) {
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status, headers: { "paypal-debug-id": `fake-${this.#seq}` } });
  }

  #fullOrder(id: string) {
    const o = structuredClone(this.orders.get(id));
    const pu = o.purchase_units[0];
    const auth = [...this.auths.values()].find((a) => a.orderId === id);
    pu.payments = {
      authorizations: auth ? [{ id: auth.id, status: auth.status, amount: { currency_code: auth.currency, value: auth.value } }] : [],
      captures: [...this.captures.values()].filter((c) => c.authId === auth?.id).map((c) => ({ id: c.id, status: c.status, amount: { currency_code: c.currency, value: c.value } })),
    };
    return o;
  }

  #handle(method: string, path: string, body: Json): { status: number; body: Json } {
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/v1\/customer\/disputes\/([^/]+)(?:\/([a-z-]+))?$/))) {
      const dsp = this.disputes.get(m[1]!);
      if (!dsp) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      const unprocessable = { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ACTION_NOT_ALLOWED" }] } };
      if (method === "GET" && !m[2]) {
        return {
          status: 200,
          body: {
            dispute_id: dsp.id,
            status: dsp.status,
            reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
            dispute_amount: { currency_code: dsp.currency, value: dsp.value },
            disputed_transactions: [{ seller_transaction_id: dsp.captureId }],
            ...(dsp.outcome ? { dispute_outcome: { outcome_code: dsp.outcome } } : {}),
            links: [{ rel: "self" }, ...dsp.links.map((rel) => ({ rel }))],
          },
        };
      }
      if (method === "POST" && m[2] === "provide-evidence") {
        if (!dsp.links.includes("provide_evidence")) return unprocessable;
        if (!Array.isArray(body?.evidences) || !body.evidences[0]?.notes) return { status: 400, body: { name: "INVALID_REQUEST" } };
        dsp.evidence = body;
        dsp.status = "UNDER_REVIEW";
        dsp.links = ["adjudicate"];
        return { status: 200, body: { links: [{ rel: "self" }] } };
      }
      if (method === "POST" && m[2] === "require-evidence") {
        if (!dsp.links.includes("require_evidence")) return unprocessable;
        dsp.links = ["provide_evidence"];
        return { status: 200, body: { links: [{ rel: "self" }] } };
      }
      if (method === "POST" && m[2] === "adjudicate") {
        if (!dsp.links.includes("adjudicate")) return unprocessable;
        dsp.status = "RESOLVED";
        dsp.outcome = body?.adjudication_outcome === "SELLER_FAVOR" ? "RESOLVED_SELLER_FAVOUR" : "RESOLVED_BUYER_FAVOUR";
        dsp.links = [];
        return { status: 200, body: { links: [{ rel: "self" }] } };
      }
      return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    if (method === "POST" && path === "/v1/payments/payouts") {
      const sb = body?.sender_batch_header?.sender_batch_id as string;
      if ([...this.payouts.values()].some((p) => p.senderBatchId === sb)) return { status: 400, body: { name: "USER_BUSINESS_ERROR", details: [{ issue: "DUPLICATE_SENDER_BATCH_ID" }] } };
      const item = body.items[0];
      const id = this.#id("PB");
      this.payouts.set(id, { id, senderBatchId: sb, receiver: item.receiver, value: item.amount.value, currency: item.amount.currency, itemId: this.#id("PI"), itemStatus: this.nextPayoutItemStatus });
      return { status: 201, body: { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } } };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/payments\/payouts\/([^/]+)$/))) {
      const p = this.payouts.get(m[1]!);
      if (!p) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      return {
        status: 200,
        body: {
          batch_header: { payout_batch_id: p.id, batch_status: p.itemStatus === "SUCCESS" ? "SUCCESS" : "PROCESSING" },
          items: [{ payout_item_id: p.itemId, transaction_status: p.itemStatus, payout_item: { amount: { currency: p.currency, value: p.value }, receiver: p.receiver } }],
        },
      };
    }
    if (method === "POST" && path === "/v2/checkout/orders") {
      const id = this.#id("ORD");
      const pu = { ...structuredClone(body.purchase_units[0]) };
      pu.payee = pu.payee ?? { merchant_id: this.payee, email_address: "merchant@business.example.com" };
      const vault = body.payment_source?.paypal?.vault_id;
      this.orders.set(id, { id, intent: body.intent, status: vault ? "COMPLETED" : "PAYER_ACTION_REQUIRED", purchase_units: [pu] });
      if (!vault) return { status: 200, body: { id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] } };
      const auth: Auth = { id: this.#id("AUTH"), orderId: id, status: "CREATED", currency: pu.amount.currency_code, value: pu.amount.value };
      this.auths.set(auth.id, auth);
      // Minimal representation, exactly as the real sandbox returned it in Stage 1.
      return { status: 201, body: { id, status: "COMPLETED", purchase_units: [{ reference_id: pu.reference_id, payments: { authorizations: [{ id: auth.id, status: "CREATED", amount: { currency_code: auth.currency, value: auth.value } }] } }] } };
    }
    if (method === "GET" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) {
      return this.orders.has(m[1]!) ? { status: 200, body: this.#fullOrder(m[1]!) } : { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    if (method === "GET" && (m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)$/))) {
      const a = this.auths.get(m[1]!);
      return a ? { status: 200, body: { id: a.id, status: a.status, amount: { currency_code: a.currency, value: a.value } } } : { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    if (method === "POST" && (m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/))) {
      const a = this.auths.get(m[1]!);
      if (!a) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (a.status === "VOIDED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED", description: "Authorization has been voided." }] } };
      if (a.status === "CAPTURED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "Authorization has been previously captured." }] } };
      const status = this.nextCaptureStatus ?? "COMPLETED";
      this.nextCaptureStatus = null;
      const value = this.nextCaptureValue ?? body.amount.value;
      this.nextCaptureValue = null;
      const c: Capture = { id: this.#id("CAP"), authId: a.id, status, currency: body.amount.currency_code, value };
      this.captures.set(c.id, c);
      if (body.final_capture) a.status = "CAPTURED";
      return { status: 201, body: { id: c.id, status: c.status, amount: { currency_code: c.currency, value }, final_capture: body.final_capture } };
    }
    if (method === "POST" && (m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/))) {
      const a = this.auths.get(m[1]!);
      if (!a) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (a.status === "CAPTURED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_CAPTURED", description: "Authorization has been previously captured." }] } };
      if (a.status === "VOIDED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_VOIDED" }] } };
      a.status = "VOIDED";
      return { status: 204, body: undefined };
    }
    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      return { status: 200, body: { verification_status: body.transmission_sig === "valid-signature" ? "SUCCESS" : "FAILURE" } };
    }
    return { status: 404, body: { name: "NOT_FOUND", path } };
  }
}
