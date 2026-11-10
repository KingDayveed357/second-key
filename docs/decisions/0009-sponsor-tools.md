# 0009: Sponsor tools and prize focus

Status: **Accepted** (Dave, Checkpoint 2, 2026-10-11) 

## Context

Rules §8 (**Verified**): *"A project can only win up to one (1) Grand Prize and one (1) Sponsor Prize OR one (1) Honorable Mention Prize and one (1) Sponsor Prize."* Spreading effort across several sponsor prizes buys at most one.

| Tool | What the prize asks (Verified on sponsor pages) | Product value to Second Key | Decision |
|---|---|---|---|
| **AG Grid / AG Studio** | "Polish: custom widgets, theming, and layout tools … Studio Agent Framework: a custom agent talking to Studio's built-in agents, or a swapped-in harness." Prize $5k/$2k/$1k×3 | The ops console is a real product surface: ledger, HOLD queue, evidence chain | **Core. The one sponsor prize we target.** |
| **Channel3** | Must call the API or MCP "as a meaningful part of the product experience" | Independent facts (`GET /v1/products/{id}`, free) and market price from offers across retailers; search for the reference agent | **Core**, for product reasons. Not targeting its prize. |
| **Render** | Deploy; the sponsor page highlights Render Workflows | Hosting with Postgres and a worker | **Core** (hosting). Workflows not used: no scheduling (ADR-0006). |
| **Postman** | No prize listed | Public collection = judge tooling + contract tests | **Core**, cheap |
| **APIMatic** | Rewards using the **Context Plugin for PayPal** inside your AI coding tool while building | Helps us write the PayPal integration | **Use the Context Plugin while building** (low cost; also qualifies for their participant offer). SDK generation from our OpenAPI is a stretch goal. |
| Elastic, Kernel, Bryntum, Zapier, Astropods | — | None identified | **Skip** |

## AG Studio risks

- **Licence through judging:** the hackathon trial is 45 days (**Verified**, sponsor page). From first use around Oct 25 it would end around Dec 9, before the judging window closes on Dec 15. The pricing page gives no trial or OSS terms (**Unknown**). **Action for Dave:** ask AG Grid on the PayPal Discord for a licence covering the judging period, and whether a public repo with the key in Render env vars (not in the repo) is acceptable.
- **The boilerplate doesn't yet include AG Studio packages** (**Verified**: its `package.json` has Next 16, React 19 and `@paypal/paypal-server-sdk` only). The package is `ag-studio-react` (**Verified**, quick start). Licence-key setup is **Unknown, needs a test** in Stage 5.
- **Fallback:** if the licence lapses, the console degrades to AG Grid (not Studio) tables. Still functional, weaker for the prize.

## Consequences

- Effort concentrates on one polished console instead of four thin integrations.
- The Devpost "tools used" list stays honest: every listed tool does a job.
