# AI operations: model, configuration, limits, evaluation

Last updated 2026-10-12 (Stage 4 verification).

## Model

| | |
|---|---|
| Provider | Anthropic, via `@anthropic-ai/sdk` 0.128.0 (`client.messages.parse` with structured outputs) |
| Model | **`claude-haiku-5-5`** (the only approved model; `packages/ai/src/models.ts`) |
| Verified | Through the Models API on 2026-10-12 (`pnpm ai:smoke`): id `claude-haiku-5-5`, display name "Claude Haiku 5.5", structured outputs supported, effort `low` supported, 1,000,000 input tokens |
| Effort | `low`, set explicitly. Haiku 5.5's default is `medium`. Thinking is left adaptive, per Anthropic's guidance to use effort as the lever. |
| Fallback | **None.** No server-side fallback is requested, and a response from any other model is treated as a failure (HOLD). |
| Pricing (estimate source) | $0.10 / $0.50 per MTok input/output for prompts up to 100K tokens ($0.50 / $2.50 above); cache reads 0.1×, 5-minute cache writes 1.25× (pricing version `anthropic-2026-10-06`) |

An unapproved model is a startup error for the API, and a construction error for the provider, eval runner and reference agent.

## Configuration (server-side only; values never logged)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Without it, every AI check fails closed and purchases HOLD. |
| `WITNESS_AI_MODEL` | `claude-haiku-5-5` | Must be on the allowlist. |
| `WITNESS_AI_MAX_SPEND_USD` | `1` | Per-process estimated spend ceiling. When reached, AI checks return `budget`, which means HOLD. |
| `WITNESS_AI_MAX_CALLS` | `2000` | Per-process attempt ceiling, retries included. |
| `WITNESS_AI_TIMEOUT_MS` | `30000` | Per-attempt timeout. |
| `WITNESS_AI_MAX_RETRIES` | `2` | Retries for transient errors only (429, 5xx/overloaded, connection, timeout), with exponential backoff and full jitter, honouring `retry-after`. |
| `WITNESS_AGENT_MAX_SPEND_USD` | `0.05` | Reference-agent spend cap per run. |

**Output caps** (per prompt front-matter; thinking counts toward them): injection 1,200, semantic 3,000 (`semantic@v3` returns preference verdicts and listing-integrity answers, ADR-0014), intent 1,500, evidence 1,500. In the full evaluation after ADR-0014, output averaged about 255 tokens per call. Hitting a cap returns `truncated`, which means HOLD.

## Commands

```bash
pnpm eval:fake
```
Offline: fake model, no network, no cost. Writes `evals/report/fake-latest.*`, labelled "not a measurement".

```bash
pnpm ai:smoke
```
LIVE: Models API check plus 2 tiny requests (about $0.0003; hard cap $0.01).

```bash
pnpm eval:smoke
```
LIVE: 18 representative cases × 1 run. Prints the plan and worst-case cost, then asks you to type `yes`.

```bash
pnpm eval
```
LIVE: the full benchmark (suite1-v2, 76 cases × 3 runs, 354 calls since ADR-0014). It refuses to start if the worst case exceeds `--max-spend` (default $1.00). Only this run writes `evals/report/latest.*`.

```bash
pnpm eval -- --suite adv-v2
```
LIVE: the separate adversarial suites, `adv-v2` (29 cases) or `adv-v1` (19 cases, frozen), × 3 runs. Reports go to `evals/report/adv-v2-latest.*` and `adv-v1-latest.*`; they are never merged into the benchmark's numbers.

With `semantic@v3`, the full benchmark's conservative worst case with 2 retries per call is $1.44, so the runner refuses it under the $1 ceiling. Run it with `WITNESS_AI_MAX_RETRIES=1` (worst case $0.96). The actual cost was $0.065.

Every report re-derives its headline numbers from the per-case, per-run table before writing, and aborts if they disagree.

Every run dry-runs the selected cases through the fake model first, to count exactly how many model calls it will make, and prints a conservative worst case (input billed at the cache-write rate, every output token used, every retry taken).

## Prompt caching

The static system prompt (security rules, rubric, worked examples) carries a `cache_control` breakpoint. The structured-output schema follows it in the cached prefix. **Purchase-specific and merchant-controlled text is only ever in the user turn**, so no tenant or transaction data is cached.

`injection@v2`, `semantic@v2` and `semantic@v3` exceed Haiku 5.5's 512-token caching minimum. The measured cached prefix was 1,526 tokens for the injection prompt.

**Measured (2026-10-12):**
- Smoke pair: a cache-write call cost an estimated $0.000211, and the following cache-hit call $0.000036 (**83% less**). Latency fell from 2.7 s to 1.2 s.
- Full evaluation, suite1-v1: all 252 requests read the cache (369,588 cache-read tokens, against 32,979 uncached input tokens).
- Full evaluation, suite1-v2: 270 of 276 requests read the cache; 6 wrote it (395,508 cache-read tokens), $0.0155.

Cache entries last 5 minutes. Sparse production traffic will mostly pay the write rate; caching helps most in bursts.

## Rotating or revoking the Anthropic key

1. In the Anthropic Console, create a new key, update `witness/.env` and Render's `witness-api` environment, and redeploy. Then delete the old key in the Console.
2. If a key is compromised: delete it in the Console immediately. Second Key then fails closed (every purchase HOLDs) until a new key is configured.
3. Keys never appear in Git, logs, reports or prompts. Commits are scanned for `sk-ant-` patterns before every commit in this workflow.

## Known limitations

- **The eval set is self-authored.** The same team wrote the prompts and the 76 benchmark cases (the prompt examples were deliberately made different from the cases). A perfect score shows the system works as designed on this set; it is not evidence against unseen attacks.
- **Before ADR-0014, the adversarial suite adv-v1 found real gaps: 10 of 17 adversarial carts were captured on every run** (`evals/report/adversarial-latest.md`). The AI is asked only about injection and about the shopper's explicit soft constraints, and the deterministic checks trust merchant-supplied fields. So nothing catches contradicting listing facts:
  - fees or subscriptions;
  - kids' sizing or size substitution;
  - single items or multi-packs;
  - replicas with the brand field set;
  - colour synonyms;
  - a category field that lies.

  Injection in listing fields was caught in all 4 cases. **After ADR-0014 (listing integrity): 0 of 51 adv-v1 and 0 of 69 adv-v2 prohibited runs captured.** See `docs/evals.md` for limits; the suites are internally authored.
- **Open false reject:** the preference verdict misreads "Rated to 15°F" as violating "rated to 20°F or colder" (adv-v2 v2-ctl-01). Left untuned so adv-v2 stays a fair test; fix in the next prompt version, measured on a new suite.
- **Cost per screened cart is now about $0.0003** (one injection call plus one semantic call for every cart that passes deterministic screening). p95 screening latency is 5.3–6.5 s.
- **Real catalog data is often thin.** In the live agent run, Channel3 had no size for a real Nike shoe, so Second Key correctly held it. Expect a meaningful HOLD rate on real listings until sizes and colours are resolved from variants.
- **Costs are local estimates.** Anthropic's bill is authoritative; reconcile in the Console. The remaining balance can't be read with a standard API key (usage and cost reports need an Admin API key).
