# Demo video: script and shot list (target 2:50, limit 3:00)

Recorded on the deployed app (https://witness-web.onrender.com) against the real PayPal sandbox. Trim waiting time, never results. Narration is about 255 words, which leaves room for the screen to speak. No music, or music you have a licence for; show no third-party logos except the partners' own product UI.

**Before recording**
- **Warm up Render:** open `/`, `/agent`, `/pay`, `/desk` and `/developers` once, so the API isn't cold-starting on camera.
- **Run every scenario once** off camera, so the Desk has incidents to show (it shows your own session).
- **Browser:** 1440×900, zoom 110%, a clean profile with no extensions in view.
- **Second window** for Sarah's phone (the `/pay` flow opens it), placed to the right.

| # | Time | Screen and action | Narration |
|---|---|---|---|
| 1 | 0:00–0:15 | `/` home. Hold on the hero, then scroll slowly to the facts ledger. | "AI agents can now pay. Google's AP2 proves an agent was *allowed* to. It doesn't prove the agent bought what you meant, or that PayPal is about to charge for exactly that. Second Key does." |
| 2 | 0:15–0:35 | `/agent`. Point at "What Rose signs" and the device key line. Click **Sign the mandate and let the agent buy** on *It goes right*. Show the ladder going green and PayPal capturing. | "Rose's own browser signs her AP2 mandate: a Ridgeline trail runner, size ten, not white, up to ninety dollars. The agent buys, every check passes, and PayPal captures." |
| 3 | 0:35–0:55 | Choose **Agent steered** and run it. Pause on the red *AP2 constraints* rung and "PayPal's order: not reached". | "A page tells the agent a four-hundred-and-eighty-dollar shoe was pre-approved. AP2's own constraints refuse it, and PayPal is never asked for anything." |
| 4 | 0:55–1:20 | Choose **Wrong colour** and run it. Zoom on *AP2 constraints: Passed* next to *Second Key's facts: Stopped it*, with the detail "color: 'Cloud White' is excluded". | "Here the agent picks the white shoe, which is on Rose's list. Every AP2 check passes. But Second Key fetched the product's facts itself, signed them, and they say Cloud White. Refused." |
| 5 | 1:20–1:40 | Choose **Checkout swaps it** and run it. Wait for the bottom rung, *PayPal's order: Stopped it*, with the SKU diff. | "Now the mandates conform, but the checkout sends PayPal a different shoe at the same price. Before capturing, Second Key reads PayPal's own order, sees the swap, and voids it. Nothing is taken." |
| 6 | 1:40–1:50 | Choose **Mandate reused** and run it. Show *Ledger: Stopped it*. Scroll to **Signed receipts**, click **Verify** on one, and show *Signature valid*. | "Use the same mandate twice and the ledger refuses it. Every decision comes with a signed receipt you can verify yourself." |
| 7 | 1:50–2:20 | `/pay`. Run the "grandson" $1,800 transfer: *Paused*. Rose can only remind Sarah or cancel; there is no approve control for her. Switch to Sarah's window, open the request, approve. Back to Rose: captured, then paid out. | "The same idea protects people. Rose set a rule while she was calm. A pressured eighteen-hundred-dollar payment pauses, and Rose can't approve it, so neither can whoever is coaching her. Only Sarah can, on her own phone." |
| 8 | 2:20–2:38 | `/desk`. Select an incident to show the separate columns for AI, rule, person and PayPal, and *audit chain verified*. Optionally, the Insights tab with one question to the analyst. | "Operators see every intervention: what the AI observed, which rule decided, who decided, and what PayPal recorded, each kept separate, with a verified audit chain." |
| 9 | 2:38–2:50 | `/developers`. Click **Run a test verification** and show the four steps going green. End on the honesty list or the repo URL. | "Developers can check it with no account and no key. AP2 proves your agent was authorized. Second Key proves it was right." |

**Captions** (on screen, lower third; one per shot, all optional)
1. AP2 = authorization · Second Key = conformance + settlement
2. Signed on Rose's device (WebCrypto) · real PayPal sandbox
3. Caught by: AP2 constraints
4. Caught by: Second Key's signed facts. AP2 alone says yes
5. Caught by: PayPal's own order · voided, $0 captured
6. Caught by: the ledger · receipts verify against our JWKS
7. Rose can't approve her own paused payment
8. AG Grid + AG Studio · evidence kept separate
9. No account, no key · github.com/KingDayveed357/second-key

**If something fails on camera:** Re-record the shot; don't cut around a wrong result.
- **CANNOT_CONFIRM** on "It goes right" means the AI listing check is unavailable, either the Anthropic key or its spend cap: check the API logs.
- **A 503 on the agent runs** means the receipt key or the demo payer isn't configured.
