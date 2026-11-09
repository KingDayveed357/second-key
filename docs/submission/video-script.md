# Demo video: script and shot list (target 2:50, limit 3:00)

> **Two scripts exist; record one.** This one leads with AP2 (agentic-commerce depth). `demo-direction.md` follows the human attack → agent attack → decision boundary story. Choose before recording. Since 2026-11-09 the AP2 demo is the second section of `/agent`: open `/agent#ap2` for shots 2–6. Since 10 Nov shots 2–6 use the real-product panel (Channel3); the scripted Ridgeline runs above it remain as a fallback.

Recorded on the deployed app (https://witness-web.onrender.com) against the real PayPal sandbox. Trim waiting time, never results. Narration is about 255 words, which leaves room for the screen to speak. No music, or music you have a licence for; show no third-party logos except the partners' own product UI.

**Before recording**
- **Warm up Render:** open `/`, `/agent`, `/pay`, `/desk` and `/developers` once, so the API isn't cold-starting on camera.
- **Run every scenario once** off camera, so the Desk has incidents to show (it shows your own session).
- **Rehearse the real-product search** once: Channel3 results change over time. Pick the query whose results include at least one gold and one clearly non-gold listed product.
- **Browser:** 1440×900, zoom 110%, a clean profile with no extensions in view.
- **Second window** for Sarah's phone (the `/pay` flow opens it), placed to the right.

| # | Time | Screen and action | Narration |
|---|---|---|---|
| 1 | 0:00–0:15 | `/` home. Hold on the hero, then scroll slowly to the two scenario cards (the $1,800 transfer and the $84 poisoned-page purchase). | "AI agents can now pay. Google's AP2 proves an agent was *allowed* to. It doesn't prove the agent bought what you meant, or that PayPal is about to charge for exactly that. Second Key does." |
| 2 | 0:15–0:40 | `/agent#ap2`, scroll to **Now try it with real products**. Type "a gold smartwatch under $150", click **Draft the mandate**. Hold on *What Rose's device will sign* (the colour rule and budget) and the Channel3 product grid. | "Rose tells her agent: a gold smartwatch, under a hundred and fifty dollars. Haiku drafts the rules, she can check them, and the agent finds real products through Channel3." |
| 3 | 0:40–1:00 | Click **Let the agent choose**. Show the ladder going green and *PayPal's order: Passed … captured*. | "Her device signs the mandate. The agent picks a gold watch, Second Key re-checks it against Channel3 itself, and PayPal captures." |
| 4 | 1:00–1:25 | On a listed product whose badge isn't gold (e.g. Rose Gold or Cream), click **Make the agent buy this**. Zoom on *AP2 constraints: Passed* next to *Second Key's facts: Stopped it*. | "Now the agent buys one from the same list that isn't gold. Every AP2 check passes. Second Key's signed product facts say otherwise, and nothing is paid." |
| 5 | 1:25–1:42 | Click **Checkout swaps the product**. Wait for *PayPal's order: Stopped it*. | "Here the checkout sends PayPal a different product. Second Key reads PayPal's own order before capture and voids it." |
| 6 | 1:42–1:52 | Click **Agent hides Rose's list**: *The list still held*. Then **Verify** on a receipt: *Signature valid*. | "Even if the agent hides part of the signed mandate, the list still holds. Every decision is a receipt you can verify yourself." |
| 7 | 1:52–2:20 | `/pay`. Run the "grandson" $1,800 transfer: *Paused*. Rose can only remind Sarah or cancel; there is no approve control for her. Switch to Sarah's window, open the request, approve. Back to Rose: captured, then paid out. | "The same idea protects people. Rose set a rule while she was calm. A pressured eighteen-hundred-dollar payment pauses, and Rose can't approve it, so neither can whoever is coaching her. Only Sarah can, on her own phone." |
| 8 | 2:20–2:38 | `/desk`, tab **Insights**. Hold on **Where agents were stopped**, click the *Facts it fetched and signed* layer so the dashboard cross-filters, click it again to clear. Optionally ask the analyst "What did AP2 alone miss?". | "Operators see every agent purchase layer by layer: what AP2 checked, what Second Key checked, and what PayPal recorded. Here is everything AP2 alone would have let through." |
| 9 | 2:38–2:50 | `/developers`. Click **Run a test verification** and show the four steps going green. End on the honesty list or the repo URL. | "Developers can check it with no account and no key. AP2 proves your agent was authorized. Second Key proves it was right." |

**Captions** (on screen, lower third; one per shot, all optional)
1. AP2 = authorization · Second Key = conformance + settlement
2. Signed on Rose's device (WebCrypto) · real PayPal sandbox
3. Caught by: AP2 constraints
4. Caught by: Second Key's signed facts. AP2 alone says yes
5. Caught by: PayPal's own order · voided, $0 captured
6. Caught by: the ledger · receipts verify against our JWKS
7. Rose can't approve her own paused payment
8. AG Grid + AG Studio · what AP2 alone would have allowed
9. No account, no key · github.com/KingDayveed357/second-key

**If something fails on camera:** Re-record the shot; don't cut around a wrong result.
- **CANNOT_CONFIRM** on "It goes right" means the AI listing check is unavailable, either the Anthropic key or its spend cap: check the API logs.
- **A 503 on the agent runs** means the receipt key or the demo payer isn't configured.
