# Demo video: "Manipulation shouldn't move money" (2:50, limit 3:00)

The story the brief asks for: the human attack, then the agent attack, then the decision boundary, then one closing line. It is an alternative to `video-script.md`, which leads with AP2. **Record one of them, not both.** This one tells the broader story. The AP2 one goes deeper on agentic-commerce standards.

Every shot is a real run on the deployed app against the PayPal sandbox. Cut waiting time, never results. About 250 words of narration.

## Before recording

1. **Turn payouts on, or don't show them.** If `SECONDKEY_DEMO_RECIPIENT_EMAIL` isn't set on Render, the PayPal record says "Paying J. Morgan isn't set up in this deployment" after the capture. That's honest, but it undercuts shot 4. Either set it on `witness-api`, or end shot 4 on the capture.
2. **Warm Render up**: open `/`, `/pay`, `/agent`, `/desk` once.
3. **Set up Rose off camera**: on `/pay`, set the $500 rule, open Sarah's phone, invite, accept, assign. Setup isn't the story.
4. **Two windows**: Rose's at 1280×860 on the left, Sarah's phone on the right. Browser zoom 110%. No extensions, no bookmarks bar.
5. Run the agent's **ordinary page** once off camera, so the Desk has a clean comparison row.

## Shots

| # | Time | Screen | Narration |
|---|---|---|---|
| 1 | 0:00–0:12 | `/`. Hold on the headline, then on the two scenario cards. | "What happens when the person making a payment, or the AI agent making a purchase, is being manipulated? Second Key holds the money and hands the decision to someone else." |
| 2 | 0:12–0:40 | `/pay`, *An urgent call*. Tick "Also share what prompted this payment". Show the call for two seconds. **Send $1,800**. | "Rose is on the phone with her grandson. He's been arrested, he needs eighteen hundred dollars for bail, and she mustn't tell his mother." |
| 3 | 0:40–1:05 | The paused screen. Point at: *Reserved by PayPal* in the progress; the PayPal record (*Authorization CREATED · Reserved*, *Capture: none yet*); the first quote card, "Promise you won't tell her." | "Her own rule pauses it: a first payment to someone new. PayPal reserves the money; nothing is taken. Second Key quotes the pressure word for word, and code checks every quote is really in the call. And Rose can't approve it. That's the point." |
| 4 | 1:05–1:25 | Sarah's window: the request arrives. **Review the payment** → evidence → **Send it** → **Yes, send it**. Cut to Rose: *Payment completed*, capture COMPLETED with its ID. | "Only Sarah can, on her own phone. Today she decides it's real. The capture is confirmed by PayPal, not assumed." *(Alternative: Sarah taps* Don't send *and the authorization shows VOIDED.)* |
| 5 | 1:25–1:35 | `/agent`. Hold on the header, then Rose's request. | "But what if the one being manipulated is the AI agent acting for you?" |
| 6 | 1:35–2:05 | *A poisoned page* is selected. Point at the page text on the right. **Let the agent buy**. *Paused: the $84.00 purchase needs Rose*. Scroll to the comparison: every row *Matches*, except *Instructions on the page: orders to the agent found · Needs Rose*. | "Rose asked for trail shoes: size ten, under ninety dollars, not white. The agent picks the right shoe, but the page it read tells shopping agents she pre-approved a four-hundred-and-eighty-dollar one. Every fact matches her request. The page still tried to steer her agent, so the agent doesn't get the last word." |
| 7 | 2:05–2:20 | **Ask Rose to check** → Rose's review → **Don't buy** → *Cancelled. Nothing was taken.*, authorization *VOIDED*. | "Rose decides. She says no, and PayPal releases the money." |
| 8 | 2:20–2:40 | `/desk`. Select the $1,800 transfer. Scroll the detail: *What was detected*, *Who decided* (Second Key paused; the trusted contact approved), *What PayPal recorded*, *Audit chain verified*. | "Every decision lands on the Protection Desk: what was detected and where, what the rules decided, who decided, what PayPal recorded, and an audit trail anyone can verify." |
| 9 | 2:40–2:50 | Back to `/`, the headline. | "As agents gain the power to spend, someone else has to hold the second key. Manipulation shouldn't move money." |

**Lower-third captions** (optional, one per shot): 2 *Synthetic call · PayPal sandbox* · 3 *Rose can't approve her own paused payment* · 4 *Captured: confirmed by PayPal* · 6 *Every fact matches. The page still tried to steer the agent.* · 7 *Voided: nothing taken* · 8 *AG Grid · evidence kept separate · audit chain verified*.

## If something goes wrong on camera

Re-record the shot; never cut around a wrong result. *Couldn't reach PayPal* means the sandbox is slow: press **Check again**. If the poisoned page pauses with "couldn't check" instead of a quoted instruction, the AI check was unavailable (Anthropic key or spend cap): check the API logs and re-record.
