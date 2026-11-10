// The four AI components (docs/ai-design.md). Each returns structured, validated results; anything
// the model gets wrong or can't do becomes "unknown" (HOLD) or an ambiguity for the shopper. AI can
// only make a decision stricter: it never loosens a deterministic check, and it never sets amounts,
// SKUs, merchants or quantities.

import { z } from "zod";
import { CURRENCIES, PolicyV1, numberToCents, type Check, type EvidenceItem, type ProductFacts, type ResolvedCart } from "@witness/core";
import { promptRef, type AiResult, type LlmClient } from "./llm.ts";
import { PROMPTS } from "./prompts.ts";
import { MANIPULATION_PROMPT, assess, type Conversation } from "./manipulation.ts";

export const THRESHOLDS = { injection: 0.5, semantic: 0.8, integrity: 0.8, intentReview: 0.6 } as const;

const conf = z.number();
const inUnit = (n: number) => n >= 0 && n <= 1;
const aiMeta = (r: AiResult<unknown>) => ({ kind: "ai" as const, model: r.model ?? "none", prompt_version: r.promptVersion });

// ---------------------------------------------------------------------------------------------
// Injection classifier
// ---------------------------------------------------------------------------------------------

export const InjectionOut = z.object({
  suspected: z.boolean(),
  confidence: conf,
  spans: z.array(z.object({ text: z.string(), reason: z.string() })),
});

const listingText = (f: ProductFacts) =>
  [f.title, f.brand, f.category, ...Object.entries(f.attributes).map(([k, v]) => `${k}: ${v}`), f.description].filter(Boolean).join("\n");

export async function checkInjection(ai: LlmClient, facts: ProductFacts[]): Promise<Check> {
  const input = facts
    .map((f) => `<listing product_id="${f.product_id}">\n<title>${f.title}</title>\n<details>\n${listingText(f)}\n</details>\n</listing>`)
    .join("\n\n");
  const r = await ai.structured(PROMPTS.injection, input, InjectionOut);
  if (!r.ok || !inUnit(r.value.confidence)) {
    return { id: "ai.injection", result: "unknown", detail: `injection check unavailable (${r.ok ? "confidence out of range" : r.reason}); a human must decide`, ...aiMeta(r), unavailable: true };
  }
  if (r.value.suspected && r.value.confidence >= THRESHOLDS.injection) {
    const span = r.value.spans[0];
    // Only spans that really occur in a listing Second Key fetched count as evidence.
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const texts = facts.map((f) => norm(listingText(f)));
    const evidence: EvidenceItem[] = r.value.spans
      .filter((sp) => norm(sp.text).length >= 12 && texts.some((t) => t.includes(norm(sp.text))))
      .slice(0, 4)
      .map((sp) => ({ tactic: "instruction_to_agent", quote: sp.text.slice(0, 300), source: "listing", why: sp.reason.slice(0, 300) }));
    return { id: "ai.injection", result: "unknown", detail: `possible prompt injection in listing text${span ? `: "${span.text.slice(0, 160)}" (${span.reason})` : ""}`, ...aiMeta(r), evidence };
  }
  return { id: "ai.injection", result: "pass", detail: `no manipulation found in listing text (confidence ${r.value.confidence.toFixed(2)})`, ...aiMeta(r) };
}

// ---------------------------------------------------------------------------------------------
// Semantic verifier + listing integrity: one structured call (semantic@v3)
// ---------------------------------------------------------------------------------------------

const evidenceFields = { evidence_field: z.string(), evidence_quote: z.string() };

export const SemanticOut = z.object({
  verdicts: z.array(
    z.object({
      constraint_id: z.string(),
      product_id: z.string(),
      verdict: z.enum(["satisfies", "violates", "unknown"]),
      confidence: conf,
      ...evidenceFields,
    }),
  ),
  integrity: z.array(
    z.object({
      requirement_id: z.string(),
      product_id: z.string(),
      verdict: z.enum(["consistent", "conflict", "unclear"]),
      confidence: conf,
      ...evidenceFields,
      reason: z.string(),
    }),
  ),
});

/**
 * Something the shopper already confirmed, restated so the model can look for listing text that
 * contradicts it. Derived from the policy by code, never by the model. `hard`: a confirmed conflict
 * rejects; otherwise a conflict holds for the shopper.
 */
export interface IntegrityRequirement {
  id: string;
  text: string;
  hard: boolean;
}

export function integrityRequirements(policy: PolicyV1): IntegrityRequirement[] {
  const q = policy.quantity;
  const reqs: IntegrityRequirement[] = [
    { id: "item", hard: true, text: `nothing in the listing indicates that buying quantity ${q} delivers anything other than exactly ${q} complete unit${q > 1 ? "s" : ""} of one specific product, e.g. a part, refill, accessory, toy version, single piece of a pair or set, multi-pack, bundle, or a version chosen later` },
    { id: "charges", hard: false, text: "nothing in the listing indicates a charge beyond the listed price: fees, surcharges, deposits, mandatory add-ons, recurring payments or subscriptions (optional extras the shopper may decline are fine)" },
    { id: "consistency", hard: false, text: "nothing in the listing contradicts another part of the listing about what the product is, its size, colour, quantity, brand, condition or price" },
  ];
  if (policy.category) reqs.push({ id: "category", hard: true, text: `nothing in the listing indicates that the product is something other than a ${policy.category} itself (judge the whole listing, not the category label alone)` });
  if (policy.hard.size) reqs.push({ id: "size", hard: true, text: `nothing in the listing indicates that the item delivered may not be size ${policy.hard.size} as an adult shopper means it: a different size stated anywhere, a youth/kids or other sizing system, the size label referring to something else, or the seller substituting another size` });
  if (policy.hard.brand) reqs.push({ id: "brand", hard: true, text: `nothing in the listing indicates that the product is not a genuine ${policy.hard.brand} product: a copy, replica, "style", "compatible" or "inspired by" item, grey-market or unofficial, or a different maker named` });
  if (policy.hard.excluded_colors.length) reqs.push({ id: "colour", hard: true, text: `nothing in the listing indicates that the product is ${policy.hard.excluded_colors.join(" or ")}, including shades and marketing names of ${policy.hard.excluded_colors.length > 1 ? "those colours" : "that colour"}, in any field` });
  return reqs;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const MIN_QUOTE_CHARS = 12;

function fieldText(f: ProductFacts, field: string): string | undefined {
  if (field === "title") return f.title;
  if (field === "brand") return f.brand;
  if (field === "category") return f.category;
  if (field === "description") return f.description;
  if (field.startsWith("attributes.")) return f.attributes[field.slice("attributes.".length)];
  return undefined;
}

/**
 * Evidence counts only if the quote is copied from the named field of the listing Second Key fetched,
 * and is substantive: at least 12 characters, or that field's entire value (e.g. a colour "Ivory").
 * A matching scrap of text or a high confidence on its own is not proof.
 */
export function evidenceHolds(f: ProductFacts, field: string, quote: string): boolean {
  const q = normalise(quote);
  const text = fieldText(f, field.trim());
  if (!q || text === undefined) return false;
  const t = normalise(text);
  return t.includes(q) && (q.length >= MIN_QUOTE_CHARS || q === t);
}

/**
 * One model call per cart: the shopper's soft constraints (plus a deferred category, ADR-0012) and
 * the listing-integrity requirements (ADR-0014). Every result either passes, tightens the decision,
 * or holds; nothing here can loosen a deterministic check.
 */
export async function verifyListing(ai: LlmClient, policy: PolicyV1, facts: ProductFacts[], implicit: { id: string; text: string }[] = []): Promise<Check[]> {
  const constraints = [...policy.soft, ...implicit];
  const requirements = integrityRequirements(policy);
  if (!facts.length) return [];
  const input = JSON.stringify(
    {
      constraints: constraints.map((s) => ({ id: s.id, text: s.text })),
      requirements: requirements.map((q) => ({ id: q.id, text: q.text })),
      products: facts.map((f) => ({ product_id: f.product_id, title: f.title, brand: f.brand ?? null, category: f.category ?? null, attributes: f.attributes, description: f.description ?? null })),
    },
    null,
    2,
  );
  const r = await ai.structured(PROMPTS.semantic, input, SemanticOut);
  const out: Check[] = [];

  for (const s of constraints) {
    for (const f of facts) {
      const id = `ai.soft:${s.id}`;
      if (!r.ok) {
        out.push({ id, line: f.product_id, result: "unknown", detail: `"${s.text}": semantic check unavailable (${r.reason})`, ...aiMeta(r), unavailable: true });
        continue;
      }
      const v = r.value.verdicts.find((x) => x.constraint_id === s.id && x.product_id === f.product_id);
      if (!v || !inUnit(v.confidence)) {
        out.push({ id, line: f.product_id, result: "unknown", detail: `"${s.text}": no usable verdict from the model`, ...aiMeta(r), unavailable: true });
        continue;
      }
      const grounded = evidenceHolds(f, v.evidence_field, v.evidence_quote);
      const confident = v.confidence >= THRESHOLDS.semantic;
      let result: Check["result"] = "unknown";
      if (v.verdict === "violates" && confident && grounded) result = "fail";
      else if (v.verdict === "satisfies" && confident && grounded) result = "pass";
      const why = v.verdict === "unknown" ? "facts don't settle it" : !grounded ? `model said ${v.verdict} but its evidence isn't a substantive quote from the named listing field` : !confident ? `model said ${v.verdict} with low confidence ${v.confidence.toFixed(2)}` : `${v.verdict}: "${v.evidence_quote.slice(0, 120)}" (${v.evidence_field})`;
      out.push({ id, line: f.product_id, result, detail: `"${s.text}": ${why}`, ...aiMeta(r) });
    }
  }

  for (const q of requirements) {
    for (const f of facts) {
      const id = `ai.integrity:${q.id}`;
      if (!r.ok) {
        out.push({ id, line: f.product_id, result: "unknown", detail: `listing integrity (${q.id}) unavailable (${r.reason}); a human must decide`, ...aiMeta(r), unavailable: true });
        continue;
      }
      const v = r.value.integrity.find((x) => x.requirement_id === q.id && x.product_id === f.product_id);
      if (!v || !inUnit(v.confidence)) {
        out.push({ id, line: f.product_id, result: "unknown", detail: `listing integrity (${q.id}): no usable verdict from the model`, ...aiMeta(r), unavailable: true });
        continue;
      }
      const confident = v.confidence >= THRESHOLDS.integrity;
      const grounded = evidenceHolds(f, v.evidence_field, v.evidence_quote);
      const quoted = v.evidence_quote ? `: "${v.evidence_quote.slice(0, 120)}" (${v.evidence_field})` : "";
      let result: Check["result"];
      let detail: string;
      if (v.verdict === "consistent") {
        // "No contradiction found" adds no hold and settles nothing: every other check still
        // applies in full, so its confidence cannot weaken anything.
        result = "pass";
        detail = `listing integrity (${q.id}): no contradiction found (confidence ${v.confidence.toFixed(2)})`;
      } else if (v.verdict === "conflict" && confident && grounded) {
        result = q.hard ? "fail" : "unknown";
        detail = `listing contradicts the confirmed ${q.id} requirement${quoted} (${v.reason.slice(0, 80)})`;
      } else {
        // A concern the model raised is never ignored: unclear, low-confidence or unverifiable
        // conflicts all hold for a human.
        result = "unknown";
        detail = `listing integrity (${q.id}): ${v.verdict === "unclear" ? "uncertain" : !grounded ? "possible conflict, evidence not verifiable in the listing" : "possible conflict, low confidence"}${quoted} (${v.reason.slice(0, 80)})`;
      }
      out.push({ id, line: f.product_id, result, detail, ...aiMeta(r) });
    }
  }
  return out;
}

/**
 * All AI checks for a cart that passed deterministic screening: the injection classifier and the
 * listing verifier (soft constraints + listing integrity), two calls in parallel.
 * If deterministic checks deferred to a semantic judgement (category), the matching implicit
 * constraint is added, e.g. "is a trail-running shoe".
 */
export async function aiScreen(
  ai: LlmClient,
  policy: PolicyV1,
  cart: ResolvedCart,
  facts: Map<string, ProductFacts>,
  deterministic: Check[] = [],
  conversation?: Conversation,
): Promise<Check[]> {
  const lineFacts = cart.lines.map((l) => facts.get(l.product_id)).filter((f): f is ProductFacts => Boolean(f));
  const implicit = deterministic.some((c) => c.defers_to === "ai.soft:category") && policy.category ? [{ id: "category", text: `is a ${policy.category}` }] : [];
  const [injection, soft, manipulation] = await Promise.all([
    checkInjection(ai, lineFacts),
    verifyListing(ai, policy, lineFacts, implicit),
    conversation ? checkManipulation(ai, conversation) : null,
  ]);
  return [injection, ...soft, ...(manipulation ? [manipulation] : [])];
}

/** What the AI layer screens: a shopping cart (with its listings) or a transfer (ADR-0016). */
export type AiSubject =
  | { kind: "shopping"; policy: PolicyV1; cart: ResolvedCart; facts: Map<string, ProductFacts>; deterministic: Check[] }
  | { kind: "transfer" };

/** AI checks that must be present for a payment of this kind; a missing one holds it. */
export function requiredAiChecks(kind: "shopping" | "transfer", hasConversation: boolean): string[] {
  const ids = kind === "shopping" ? ["ai.injection"] : [];
  // ADR-0019: evidence is optional. When a conversation IS supplied, analysing it is mandatory.
  if (hasConversation) ids.push("ai.manipulation");
  return ids;
}

/** Add an "unknown" (HOLD) check for every required AI check that did not run. */
export function enforceRequired(required: string[], checks: Check[]): Check[] {
  const missing = required.filter((id) => !checks.some((c) => c.id === id));
  return [...checks, ...missing.map((id) => ({ id, result: "unknown" as const, detail: `required check ${id} did not run; held for review`, kind: "ai" as const, unavailable: true }))];
}

/**
 * The AI screen for any payment. Shopping gets the listing checks; a transfer has no listing, so it
 * gets only the shared manipulation check, which is required for every transfer. Whatever runs,
 * the required set is enforced afterwards, so a skipped check becomes a HOLD, never a pass.
 */
export async function screenPaymentAi(ai: LlmClient, subject: AiSubject, conversation?: Conversation): Promise<Check[]> {
  const checks =
    subject.kind === "shopping"
      ? await aiScreen(ai, subject.policy, subject.cart, subject.facts, subject.deterministic, conversation)
      : conversation
        ? [await checkManipulation(ai, conversation)]
        : [];
  return enforceRequired(requiredAiChecks(subject.kind, Boolean(conversation)), checks);
}

/**
 * Second Key: was the payer being manipulated into this payment? Never "fail": a flagged payment is
 * held for the payer's trusted contact to decide, so anything but a grounded, confident "proceed"
 * is "unknown" (HOLD). The detail carries only quotes verified to appear in the conversation.
 */
export async function checkManipulation(ai: LlmClient, conversation: Conversation): Promise<Check> {
  const a = await assess(ai, conversation);
  const meta = { kind: "ai" as const, model: a.model ?? "none", prompt_version: promptRef(MANIPULATION_PROMPT) };
  if (!a.ok) return { id: "ai.manipulation", result: "unknown", detail: `manipulation check unavailable (${a.failure}); held for review`, ...meta, unavailable: true };
  const brief = a.grounded.slice(0, 4).map((g) => `${g.tactic.replace(/_/g, " ")}: "${g.quote.slice(0, 120)}" (${g.speaker.slice(0, 40)})`);
  const summary = brief.length ? `; ${brief.join("; ")}` : "";
  const evidence: EvidenceItem[] = a.grounded.slice(0, 8).map((g) => ({ tactic: g.tactic, quote: g.quote.slice(0, 300), source: "conversation", speaker: g.speaker.slice(0, 80), line: g.line_index, why: g.why.slice(0, 300) }));
  if (a.intervention === "PROCEED") return { id: "ai.manipulation", result: "pass", detail: `no pause from the conversation (${a.rule}; model risk ${a.risk})${summary}`, ...meta, evidence };
  const what = a.intervention === "HOLD_FOR_TRUSTED_CONTACT" ? "hold for trusted contact" : "verify before paying";
  return { id: "ai.manipulation", result: "unknown", detail: `${what} (${a.rule}; model risk ${a.risk})${summary}`, ...meta, evidence };
}

/**
 * Drop deterministic "unknown" checks that a definitive AI verdict settled as a pass for the same
 * line. A failing verdict needs no settling (fail already rejects); an unknown verdict leaves the
 * deferred check in place, so the purchase holds.
 */
export function settleDeferred(deterministic: Check[], ai: Check[]): Check[] {
  return deterministic.filter((c) => !(c.result === "unknown" && c.defers_to && ai.some((a) => a.id === c.defers_to && a.line === c.line && a.result === "pass")));
}

// ---------------------------------------------------------------------------------------------
// Intent compiler
// ---------------------------------------------------------------------------------------------

export const IntentOut = z.object({
  category: z.string().nullable(),
  max_total: z.number().nullable(),
  currency: z.string(),
  quantity: z.number().nullable(),
  retailers: z.array(z.string()),
  excluded_colors: z.array(z.string()),
  size: z.string().nullable(),
  brand: z.string().nullable(),
  soft: z.array(z.object({ id: z.string(), text: z.string() })),
  substitution: z.enum(["deny", "hold", "same_category_under_max"]),
  expires_in_days: z.number().nullable(),
  ambiguities: z.array(z.object({ field: z.string(), question: z.string(), options: z.array(z.string()) })),
  confidence: conf,
});

export interface Ambiguity {
  field: string;
  question: string;
  options: string[];
}

export type CompileResult =
  | { kind: "ok"; draft: Record<string, unknown>; complete: boolean; ambiguities: Ambiguity[]; confidence: number; compiler: { model: string; prompt_version: string; latency_ms: number } }
  | { kind: "error"; reason: string };

/** Money amounts written in the shopper's own words, found deterministically. */
export function amountsInText(text: string): number[] {
  const re = /(?:[$€£]\s?|\b(?:usd|eur|gbp)\s?)(\d{1,7}(?:[.,]\d{1,2})?)|(\d{1,7}(?:[.,]\d{1,2})?)\s?(?:dollars?|bucks|usd|eur|euros?|gbp|pounds?)\b/gi;
  const out: number[] = [];
  for (const m of text.matchAll(re)) out.push(Number((m[1] ?? m[2])!.replace(",", ".")));
  return [...new Set(out)];
}

export async function compileIntent(
  ai: LlmClient,
  text: string,
  ctx: { now: Date; defaultRetailers: string[] },
): Promise<CompileResult> {
  const r = await ai.structured(PROMPTS.intent, `<request>\n${text}\n</request>`, IntentOut);
  if (!r.ok) return { kind: "error", reason: r.reason };
  const v = r.value;
  const amb: Ambiguity[] = v.ambiguities.map((a) => ({ field: a.field, question: a.question, options: a.options.slice(0, 4) }));
  const ask = (field: string, question: string, options: string[] = []) => {
    if (!amb.some((a) => a.field === field)) amb.push({ field, question, options });
  };

  // Money: the model's reading must agree with what the shopper actually wrote.
  let max_total_cents: number | undefined;
  const written = amountsInText(text);
  if (v.max_total == null) ask("max_total_cents", "What is the most you want to spend in total?");
  else {
    try {
      max_total_cents = numberToCents(v.max_total);
    } catch {
      ask("max_total_cents", "Please confirm the spending limit.");
    }
    if (written.length > 1) ask("max_total_cents", `Your request mentions several amounts (${written.join(", ")}). Which one is the total limit?`, written.map(String));
    else if (written.length === 1 && max_total_cents !== undefined && Math.round(written[0]! * 100) !== max_total_cents) {
      ask("max_total_cents", `Your request says ${written[0]}, but it was read as ${v.max_total}. Which is the limit?`, [String(written[0]), String(v.max_total)]);
      max_total_cents = undefined;
    }
  }

  const currency = (CURRENCIES as readonly string[]).includes(v.currency.toUpperCase()) ? v.currency.toUpperCase() : undefined;
  if (!currency) ask("currency", `Which currency? (${CURRENCIES.join(", ")})`, [...CURRENCIES]);

  let retailers = v.retailers.map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!retailers.length) {
    retailers = ctx.defaultRetailers;
    ask("retailers", "Which stores may the agent buy from?", ctx.defaultRetailers);
  }
  if (!v.category) ask("category", "What kind of product should the agent buy?");
  if (v.confidence < THRESHOLDS.intentReview) ask("policy", "Please review every field: the request was hard to interpret.");

  const quantity = v.quantity != null && Number.isInteger(v.quantity) && v.quantity >= 1 ? v.quantity : 1;
  const days = v.expires_in_days != null && v.expires_in_days > 0 ? Math.min(v.expires_in_days, 90) : 7;
  const draft: Record<string, unknown> = {
    version: 1,
    ...(v.category ? { category: v.category } : {}),
    retailers,
    ...(max_total_cents !== undefined ? { max_total_cents } : {}),
    ...(currency ? { currency } : {}),
    quantity,
    hard: { excluded_colors: v.excluded_colors, ...(v.size ? { size: v.size } : {}), ...(v.brand ? { brand: v.brand } : {}) },
    soft: v.soft.map((s, i) => ({ id: (s.id.replace(/[^\w]/g, "_").slice(0, 40) || `soft_${i + 1}`), text: s.text.slice(0, 200) })),
    substitution: v.substitution === "same_category_under_max" && !v.category ? "hold" : v.substitution,
    expires_at: new Date(ctx.now.getTime() + days * 86_400_000).toISOString(),
    max_purchases: 1,
  };
  const complete = PolicyV1.safeParse(draft).success;
  return { kind: "ok", draft, complete, ambiguities: amb, confidence: v.confidence, compiler: { model: r.model ?? "unknown", prompt_version: r.promptVersion, latency_ms: r.latencyMs } };
}

// ---------------------------------------------------------------------------------------------
// Evidence writer
// ---------------------------------------------------------------------------------------------

export const EvidenceOut = z.object({ narrative: z.string(), cited_fields: z.array(z.string()) });

export const EVIDENCE_PLACEHOLDERS = ["amount", "currency", "order_id", "authorization_id", "capture_id", "policy_digest", "captured_at", "intent_text"] as const;
export type EvidenceValues = Record<(typeof EVIDENCE_PLACEHOLDERS)[number], string>;

/** Draft a dispute narrative. Numbers and IDs are inserted by code; the model may not write any. */
export async function writeEvidence(ai: LlmClient, record: Record<string, unknown>, values: EvidenceValues): Promise<{ kind: "ok"; text: string; model: string; prompt_version: string } | { kind: "error"; reason: string }> {
  const r = await ai.structured(PROMPTS.evidence, JSON.stringify(record, null, 2), EvidenceOut);
  if (!r.ok) return { kind: "error", reason: r.reason };
  const n = r.value.narrative;
  const unknown = [...n.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).filter((p) => !(EVIDENCE_PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown.length) return { kind: "error", reason: `unknown placeholders: ${unknown.join(", ")}` };
  if (/\d/.test(n.replace(/\{\{\w+\}\}/g, ""))) return { kind: "error", reason: "the draft wrote numbers itself instead of using placeholders" };
  if (/(?<!not (?:cryptographically )?)\bsigned\b/i.test(n)) return { kind: "error", reason: 'the draft calls the instruction "signed"' };
  const text = n.replace(/\{\{(\w+)\}\}/g, (_, k: keyof EvidenceValues) => values[k]);
  return { kind: "ok", text, model: r.model ?? "unknown", prompt_version: r.promptVersion };
}
