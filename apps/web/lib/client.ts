// Browser helpers. Every request goes to this site's /api/w proxy; no API key exists client-side.

export interface Problem {
  status: number;
  title: string;
  detail?: string;
}

export async function api<T = any>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; console?: boolean; asPayer?: boolean; inboxSecret?: string } = {},
): Promise<T> {
  const res = await fetch(`/api/w${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.console ? { "x-witness-console": "1" } : {}),
      // Second Key: act as this visitor's own demo payer (session cookie), not the shared demo shopper.
      ...(init.asPayer ? { "x-sk-payer": "1" } : {}),
      // Only the guardian's window holds this; it is sent only on inbox routes.
      ...(init.inboxSecret ? { "x-inbox-secret": init.inboxSecret } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw { status: res.status, title: json?.title ?? `HTTP ${res.status}`, detail: json?.detail } satisfies Problem;
  return json as T;
}

export const errText = (e: unknown) => {
  const p = e as Partial<Problem>;
  return p?.title ? `${p.title}${p.detail ? `: ${p.detail}` : ""}` : String(e);
};

export const money = (cents: number | null | undefined, currency = "USD") =>
  cents == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

export const TERMINAL = new Set(["REJECTED", "AUTH_FAILED", "CAPTURED", "VOIDED", "CAPTURE_DECLINED", "HELD"]);

/** Badge tone for a purchase state or outcome. */
export function tone(state: string | null | undefined): "ok" | "warn" | "bad" | "" {
  if (!state) return "";
  if (["CAPTURED", "CAPTURE", "pass", "COMPLETED", "consistent"].includes(state)) return "ok";
  if (["HELD", "HOLD", "unknown", "CAPTURE_PENDING", "NEEDS_RECONCILE", "VOIDING"].includes(state)) return "warn";
  if (["REJECTED", "REJECT", "VOIDED", "VOID", "fail", "AUTH_FAILED", "CAPTURE_DECLINED"].includes(state)) return "bad";
  return "";
}

/** Plain-English label for a check id. */
export function checkLabel(id: string): string {
  const map: Record<string, string> = {
    color: "Colour",
    size: "Size",
    category: "Category",
    max_total: "Budget",
    brand: "Brand",
    quantity: "Quantity",
    "product.allowed": "Allowed product",
    "offer.available": "Offer available",
    "facts.available": "Product facts",
    "intent.not_expired": "Intent expiry",
    "intent.purchases_left": "Purchases left",
    retailer: "Merchant",
    currency: "Currency",
    market_price: "Market price",
    three_way_match: "PayPal order match",
    "ai.injection": "Prompt injection",
    "ai.manipulation": "Pressure on the agent",
    "cart.duplicate_line": "Duplicate item",
  };
  if (map[id]) return map[id]!;
  if (id.startsWith("ai.integrity:")) return `Listing integrity: ${id.slice(13)}`;
  if (id.startsWith("ai.soft:")) return `Meaning: ${id.slice(8)}`;
  return id;
}

/** Poll a purchase until it reaches a state a person would care about. */
export async function settle(id: string, onUpdate: (p: any) => void, timeoutMs = 60_000): Promise<any> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const p = await api(`/v1/purchases/${id}`);
    onUpdate(p);
    if (TERMINAL.has(p.state) || Date.now() > end) return p;
    await new Promise((r) => setTimeout(r, 1200));
  }
}
