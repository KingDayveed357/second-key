# 0022: AG Studio on the public Desk, with a capped public agent

> The product was called **Witness** when this was written and is now **Second Key**. The decision is unchanged unless a later ADR says otherwise.

Status: accepted (2026-11-02). Amends ADR-0015 §4 (the Studio agent required a console session).

## Problem

The AG Studio dashboard and its Studio agent lived only in the password-gated `/console`, under the old Witness brand. The public Desk used AG Grid Community alone, so anyone without the password never saw AG Studio, its custom widget or the agent.

## Decision

1. **The Desk gets a second tab, Insights,** built on AG Studio.
   - It uses the same incident rows as the grid: public demo incidents, or the operator's session after sign-in.
   - The four facts stay separate fields: the AI observation, the rule outcome, the person's decision and what PayPal recorded.
   - **"Who decided" never shows the engine.** The engine's own HOLD is a rule outcome, so it appears as "No review needed" or "Nobody yet", never as a decision.
   - **Money totals are USD only.** Rows in other currencies are left out rather than summed with USD. The mapping is pure and unit-tested (`lib/desk.ts`: `insightRows`, `personOf`, `stoppedCents`).
2. **Theming:** Second Key's tokens as literal colours, light and dark. AG Charts draws on a canvas and can't read CSS variables.
3. **A custom proof-chain widget** walks one incident through AI observed → rule decided → person decided → PayPal recorded, and verifies its hash-chained audit trail live through the public verify endpoint.
4. **The Studio agent.** A Second Key lead and a read-only analyst (Studio Agent Framework custom agents) work with Studio's built-in page, widget, data and planning agents, on Haiku through `/api/studio-ai`.
   - **Without a console session, the route serves a public tier:**
     - its own budget, separate from the operators' (`WITNESS_STUDIO_AI_PUBLIC_MAX_SPEND_USD`, default $0.25 per process);
     - a per-visitor limit of 30 turns a minute;
     - switched off with `WITNESS_STUDIO_AI_PUBLIC=0`.
   - The agent reads only what AG Studio passes it, which is the synthetic demo incidents. It has no route to the API or to PayPal.

## Trade-offs and limits

- **Public traffic can spend real model money,** bounded per process by the cap; when the cap is reached the agent says so. The limits are in memory, so a restart resets them; acceptable for a single-instance demo (ADR-0015).
- **AG Studio runs in trial mode** (watermark) without `AG_STUDIO_LICENSE_KEY`.
- **The dashboard needs a desktop-width screen.** On a phone the incident grid is the usable view.
- **The agent's answers have not been checked on this machine** (no Anthropic key). The route, the limits and the data mapping are tested; the conversation itself needs a check on Render.
- The old `/console` stays for operators: it has the disputes tab and the full ledger.
