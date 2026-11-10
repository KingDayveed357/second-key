# Second Key AI design

Status: **Draft for Checkpoint 2** · 2026-10-11

## Principle

AI turns language into structure and judges fuzzy constraints. **Deterministic code owns the money boundary**: amount, currency, merchant, payee, SKU, quantity, expiry, idempotency and the three-way match. Every AI output is validated against a Zod schema. Any failure (parse error, refusal, timeout, confidence under threshold, schema mismatch) becomes **HOLD, never CAPTURE**. A fully fooled model still cannot capture more, or something different, than the human confirmed.

## Provider and model (ADR-0007)

- Behind an interface, `packages/ai/llm.ts`: `structured<T>(schema: ZodType<T>, prompt: PromptRef, input) → Result<T, AiFailure>`. Implementations are thin. Tests use a deterministic fake.
- Primary: **Anthropic Claude via `@anthropic-ai/sdk`**, using structured outputs (`output_config.format` JSON schema) for every component. Default model **`claude-opus-5-5`** ($4 / $20 per million input/output tokens, from the vendor's model table as of 2026-10-06).
- Your call, decided with eval data in Stage 4: whether the high-volume classifier should run on `claude-haiku-5-5` ($0.10 / $0.50) for latency and cost. I won't downgrade any component without your decision and an eval run showing quality holds.
- Second provider evaluated: OpenAI supports strict JSON-schema structured outputs (**Verified**: [docs](https://developers.openai.com/api/docs/guides/structured-outputs)). Its pricing and latency for our prompts are **Unknown**. We'd measure with the same eval runner if you want the comparison published.
- Disclosure: I'm a Claude model recommending Claude. The eval runner is provider-neutral so you can check that claim on numbers.

## Components

### 1. Intent compiler (free text → `PolicyV1`)

| | |
|---|---|
| Input | The shopper's text, tenant defaults (currency, allowed retailers), today's date |
| Output schema | `{ policy: PolicyV1Draft, ambiguities: [{field, question, options[]}], confidence: 0..1 }` |
| `PolicyV1` | `version`, `products?` (canonical Channel3 IDs) or `category`, `retailers[]`, `max_total_cents`, `currency`, `quantity` (1–99), `hard: {excluded_colors[], size?, brand?}`, `soft: [{id, text}]` (for example "warm", "suitable for trail"), `substitution: deny / hold / same_category_under_max`, `expires_at`, `max_purchases`, `on_ambiguity: hold` |
| Guardrails | The model proposes; **the shopper confirms** on the shopper page (every field shown, ambiguities must be answered). Nothing reaches CONFIRMED without that click. Amounts are re-parsed deterministically from the text where possible, and a mismatch is flagged as an ambiguity. |
| Fails closed | No valid draft → the shopper sees "couldn't understand, please edit" and fills the form manually. No purchase can start. |

### 2. Injection classifier

| | |
|---|---|
| Input | Third-party text only (product title, description, merchant-provided fields), wrapped as quoted data |
| Output | `{ suspected: boolean, confidence, spans: [{text, reason}] }` |
| Use | `suspected && confidence ≥ 0.5` → the purchase can't be CAPTURE: HOLD, or REJECT if any check also fails ("injection plus mismatch" → VOID/REJECT) |
| Fails closed | Classifier error → HOLD with reason `classifier_unavailable` |
| Note | Defence in depth, not the boundary. Injected text can't change the deterministic checks. |

### 3. Semantic verifier

| | |
|---|---|
| Input | Each `soft` constraint + Second Key-fetched facts (title, attributes, description) for each line |
| Output | `[{ constraint_id, line_ref, verdict: satisfies / violates / unknown, confidence, evidence_quote }]`; `evidence_quote` must be a verbatim substring of the facts (checked in code, otherwise treated as `unknown`) |
| Use | `violates` with confidence ≥ 0.8 → REJECT. `unknown`, or confidence below threshold → HOLD. All `satisfies` with confidence ≥ 0.8 → passes |
| Example | "no wool" vs "merino blend": violates; quote "merino wool blend" |
| Fails closed | Error → HOLD |
| Listing integrity (since `semantic@v3`, [ADR-0014](decisions/0014-listing-integrity.md)) | The same call also answers one `integrity` entry per requirement derived from the policy (item and quantity, charges, consistency, category, size, brand, colour). Answers are `consistent`, `conflict` or `unclear`, each with `evidence_field` and `evidence_quote`. A quote must come from the named field, and be at least 12 characters or that field's whole value. Grounded, confident conflict on a hard requirement → REJECT; any other concern → HOLD; `consistent` → no effect. |

### 4. Evidence writer (disputes)

| | |
|---|---|
| Input | The structured record: intent text and digest, checks, facts snapshot, PayPal IDs, chain proof |
| Output | `{ narrative: string, cited_fields: string[] }`. Numbers, IDs and dates are **template-inserted by code**, never generated |
| Guardrails | The ops reviewer approves before anything is sent to PayPal. The text never calls anything "signed" unless it was signed. |
| Fails closed | No narrative → the template-only evidence is sent |

### 5. Reference shopping agent (Stage 4)

A small tool-use loop with **only** these tools: `search_products` (Channel3), `get_intent_summary`, `submit_purchase`, `get_purchase_status`. It has no PayPal tool and no way to approve HOLDs. It's used in the demo and as an adversarial target ("make our agent waste your money").

## Prompt versioning

- Prompts live in `packages/ai/prompts/<component>.v<N>.md` with front-matter (`id`, `version`, `model`, `schema`).
- Every `checks` row stores `model` and `prompt_version`, so any decision can be traced to the exact prompt.
- Changing a prompt means a new file plus an eval run in CI. The report records the score for each version.

## Thresholds (initial, tuned by evals)

| Gate | Threshold | Rationale |
|---|---|---|
| Semantic `satisfies` → pass | ≥ 0.8 | Prefer HOLD over a wrong capture |
| Semantic `violates` → REJECT | ≥ 0.8 | Below that → HOLD (human decides) |
| Injection suspected → no auto-capture | ≥ 0.5 | Cheap to HOLD, costly to miss |
| Price far above market → HOLD | > 1.5 × median Channel3 offer price for the same product | Protects against an "overpriced but in budget" listing |

## Latency budget (targets, measured in evals)

The screen-and-verify path makes 2 LLM calls in parallel (injection + semantic). Target p95 is **under 8 s** at the API for a 1–3 line cart, excluding PayPal. If Opus 5.5 at the default effort misses that, the levers are: effort `low` for the classifier, or a different model for the classifier (your decision).

## Implementation notes (Stage 4, 2026-10-12)

- **Where it lives:** `packages/ai`, which has no access to PayPal, the database or the executor (architecture rule `ai-has-no-money-access`). Prompts are in `packages/ai/prompts/*.v1.md`.
- **Provider (updated 2026-10-12):** `AnthropicProvider` uses **`claude-haiku-5-5` only**, structured outputs (`output_config.format` via `zodOutputFormat`), effort `low`, and **no fallback**. Results are re-validated locally; the model, prompt version, usage, cost, retries and cache status are recorded per call. Without `ANTHROPIC_API_KEY`, `UnavailableProvider` makes every AI check fail closed (HOLD). Details: `docs/ai-operations.md`.
- **Screening runs in three phases:** deterministic checks under the intent lock; AI checks outside any transaction; the decision in a second transaction.
- **Category:** judged semantically when the catalog's taxonomy doesn't literally match ([ADR-0012](decisions/0012-category-judged-semantically.md)).
- **Intent compiler:** amounts the model reads are cross-checked against amounts found deterministically in the shopper's own words. Disagreement becomes an ambiguity, never a value. Drafts may be incomplete; confirmation validates the full policy.
- **Evidence writer:** the model receives placeholders, never raw amounts or IDs. Drafts that write digits, call the instruction "signed" or use unknown placeholders fall back to a template.
- **Channel3 (verified live 2026-10-12):** the offer price is `price.price` (the docs say `price.amount`); brands are in `brands[]`; the category is an object with a `path`; attributes come from `structured_attributes` and `variants.selected`. Variant colour labels can be style codes, so only plain-word labels count as colours.
