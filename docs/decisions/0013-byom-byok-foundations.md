# 0013: Foundations for Bring-Your-Own-Model (BYOM) and Bring-Your-Own-Key (BYOK)

> The product was called **Witness** when this was written and is now **Second Key**. The decision is unchanged unless a later ADR says otherwise.

Status: **Accepted as architectural direction only** (Dave, Checkpoint 4, 2026-10-12). The full BYOM/BYOK feature is **not** part of Stage 5.

## Context

Witness will eventually serve several merchant-of-record platforms (tenants). Some will want to choose the model provider that judges their purchases (**BYOM**). Some will want to pay for model usage with their own provider account (**BYOK**). These are different features with different risks, and neither should be bolted on later by rewriting the screening engine.

Today Witness uses one operator-owned Anthropic key and one approved model (`claude-haiku-5-5`).

## Definitions

- **BYOM (bring your own model):** a tenant or the operator selects a provider and model **from Witness's allowlist**. Witness still owns the credentials and pays for usage, or bills it back. The risk is mainly quality and cost: every allowed model must pass the eval suite before it's allowlisted.
- **BYOK (bring your own key):** a tenant supplies **their own provider API key** and bears that provider's usage cost. The risk is mainly security: Witness becomes the custodian of a third-party secret.

They can be combined (a tenant brings a key for an allowlisted provider), but each needs its own controls.

## What is implemented now (foundation)

- **One provider interface**, `ModelProvider` (`packages/ai/src/llm.ts`): `structured(prompt, input, schema, { maxTokens, signal })` returns a typed `AiResult` with provider, model, prompt version, latency, token usage, estimated cost, retries and cache status. Failures are values (`unavailable | timeout | refusal | truncated | parse | error | budget | cancelled`), and every one fails closed (HOLD). The screening engine depends only on this interface.
- **Implementations:** `AnthropicProvider` (approved Haiku only), `FakeProvider` (offline tests), `UnavailableProvider` (no key: everything holds). No other paid provider is included.
- **Model allowlist with pricing** (`packages/ai/src/models.ts`): an unapproved model is a configuration error at startup, never a silent substitution. There is no server-side fallback to other models; a response from any other model is rejected.
- **Cost accounting and ceilings** (`packages/ai/src/cost.ts`): a `UsageMeter` with call and spend ceilings, checked before every attempt.
- **Architecture rule:** `packages/ai` can't import PayPal, the database or the executor, so no provider can reach money.

## Requirements for the future feature (not implemented)

| Area | Requirement |
|---|---|
| Configuration | Tenant-scoped provider config: `{ tenant_id, provider, model, key_ref?, limits }`. The provider and model must be on Witness's allowlist; no arbitrary model IDs. |
| Endpoints | **No user-supplied base URLs.** Each provider's endpoint is fixed in code. This prevents SSRF and credential exfiltration to an attacker's server. |
| Allowlisting | A model is added only after it passes eval suite 1 (zero false captures on injection and substitution) at the configured prompts. |
| Key storage | Keys encrypted at rest with envelope encryption (KMS-managed key encryption key, per-tenant data keys), stored as `key_ref` only. Never returned to any client after creation; the UI shows only the last 4 characters. |
| Rotation and revocation | Tenants can rotate (new key active, old key revoked after a grace period) and revoke instantly. A revoked key makes that tenant's AI checks fail closed (HOLD), not fall back to the operator key unless the tenant opted in. |
| Redaction | Keys are redacted from logs, traces, error messages, reports and audit payloads (logger serializers plus tests, as with PayPal secrets today). |
| Isolation | One tenant's credentials, prompts, prompt-cache entries and logs are never used for another tenant. Cached prefixes contain only static prompt text (true today), and cache keys are scoped by provider account, which BYOK gives naturally. |
| Quotas and cost | Per-tenant rate limits, a monthly spend ceiling and a per-call cost ceiling, enforced by a per-tenant `UsageMeter`. Per-tenant usage and cost reports. |
| Failure behaviour | Provider timeouts, bounded retries and fail-closed behaviour exactly as today. Budget exhaustion means HOLD, never a different model. |
| Default | Tenants that bring no key use the operator's key and the default approved model, within the operator's quotas. |

## Consequences

- Adding a provider later means writing one class that implements `ModelProvider`, adding its models to the allowlist with pricing, and passing the evals. The engine doesn't change.
- Witness does not claim BYOK support until key custody, encryption, rotation and per-tenant isolation are built and tested.

## Acceptance (Dave, 2026-10-12)

**Accepted:** the provider abstraction and the future BYOM/BYOK direction.

**Not in Stage 5:** the full feature.

**Until a later decision:**
- Anthropic `claude-haiku-5-5` remains the only approved real model.
- `FakeProvider` remains for offline tests.
- The allowlist, cost ceilings, fail-closed behaviour and separation from the payment executor stay as they are.

**Not implemented:** tenant-specific configuration, key custody, encryption at rest, rotation, revocation, per-tenant quotas and tenant isolation. Witness must not be described as supporting BYOK or BYOM.
