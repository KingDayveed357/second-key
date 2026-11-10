// Low-level PayPal REST transport. Sandbox only (ADR-0001), redacts credentials, sends
// caller-supplied deterministic PayPal-Request-Ids, and refuses money-moving paths unless the
// process role is "executor" (ADR-0005). Application code uses PayPalClient or MoneyMovementClient.

export const SANDBOX_HOST = "api-m.sandbox.paypal.com";

export type ProcessRole = "api" | "executor" | "script";

export interface TransportOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  role: ProcessRole;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PayPalResponse<T = any> {
  ok: boolean;
  status: number;
  data: T;
  debugId: string | null;
}

export class PayPalHttpError extends Error {
  readonly status: number;
  readonly issue: string;
  readonly debugId: string | null;
  readonly data: unknown;
  constructor(label: string, status: number, data: any, debugId: string | null) {
    const issue = data?.details?.[0]?.issue ?? data?.name ?? data?.error ?? "UNKNOWN";
    const description = data?.details?.[0]?.description ?? data?.message ?? data?.error_description ?? "";
    super(`${label}: HTTP ${status} ${issue} ${description}`.trim());
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
    this.data = data;
  }
}

/** The request may or may not have reached PayPal: the outcome is unknown and must be reconciled. */
export class PayPalNetworkError extends Error {}

export class MoneyMovementForbidden extends Error {}

const MONEY_PATH = /^\/v2\/payments\/authorizations\/[^/]+\/(capture|void|reauthorize)$|^\/v2\/payments\/captures\/[^/]+\/refund$|^\/v1\/payments\/payouts$/;

export function assertSandbox(baseUrl: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("Refusing to run: PAYPAL_BASE_URL is not a valid URL.");
  }
  if (u.protocol !== "https:" || u.hostname !== SANDBOX_HOST || u.port !== "") {
    throw new Error(`Refusing to run against ${u.origin}: Second Key is sandbox-only (${SANDBOX_HOST}).`);
  }
  return u;
}

export class PayPalTransport {
  readonly role: ProcessRole;
  readonly #base: string;
  readonly #id: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(o: TransportOptions) {
    this.#base = assertSandbox(o.baseUrl).origin;
    if (!o.clientId || !o.clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required.");
    this.#id = o.clientId;
    this.#secret = o.clientSecret;
    this.role = o.role;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 20_000;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.#id}:${this.#secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new PayPalNetworkError(`oauth2/token: ${(e as Error).name}`);
    }
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new PayPalHttpError("oauth2/token", res.status, { error: data?.error, error_description: data?.error_description }, res.headers.get("paypal-debug-id"));
    this.#token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
    return this.#token.value;
  }

  async send<T = any>(method: "GET" | "POST" | "PATCH", path: string, o: { body?: unknown; rawBody?: string; multipartInput?: unknown; requestId?: string; label?: string; allowFail?: boolean } = {}): Promise<PayPalResponse<T>> {
    const label = o.label ?? `${method} ${path}`;
    if (MONEY_PATH.test(path) && this.role !== "executor") {
      throw new MoneyMovementForbidden(`${label}: money movement is only allowed in the executor process (role is ${this.role})`);
    }
    if (method !== "GET" && !o.requestId) throw new Error(`${label}: a deterministic PayPal-Request-Id is required`);

    const headers: Record<string, string> = { Authorization: `Bearer ${await this.#accessToken()}` };
    if (o.requestId) headers["PayPal-Request-Id"] = o.requestId;
    // multipart/form-data with the JSON in a part named "input" (Disputes provide-evidence).
    const boundary = o.multipartInput !== undefined ? `witness-${(o.requestId ?? "x").replace(/[^A-Za-z0-9]/g, "")}` : null;
    if (boundary) headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    else if (o.body !== undefined || o.rawBody !== undefined) headers["Content-Type"] = "application/json";
    // Ask for the full resource so verification never depends on a minimal response.
    if (method !== "GET") headers["Prefer"] = "return=representation";

    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers,
        body: boundary
          ? `--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(o.multipartInput)}\r\n--${boundary}--\r\n`
          : (o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body))),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new PayPalNetworkError(`${label}: ${(e as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    const debugId = res.headers.get("paypal-debug-id");
    if (res.status >= 500) throw new PayPalNetworkError(`${label}: HTTP ${res.status} (outcome unknown, debug ${debugId})`);
    if (!res.ok && !o.allowFail) throw new PayPalHttpError(label, res.status, data, debugId);
    return { ok: res.ok, status: res.status, data, debugId };
  }
}
