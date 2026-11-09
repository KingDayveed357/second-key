# Second Key: product review against BackIt, and what changes

2026-11-09. Reviewed: backit.club (full page), the BackIt video's page on YouTube, and Second Key's home, /pay, /agent, /desk, /developers, /try and the reviewer page, in the code and in the browser.

**Limitation:** I could not watch the BackIt video. YouTube wouldn't serve its captions to a script, and the browser window refused to capture frames. What I know about it is its length (2:54) and its description: the builder sets up a founding offer with AI pricing help, fans buy through PayPal, an AI payout agent proposes who is owed what, the builder approves, PayPal Payouts pays. Everything below about BackIt's *presentation* comes from its website, not the video.

## 1. What BackIt does better

- **One sentence, then the product object.** The headline is the benefit ("Turn your product's first fans into your best salespeople"), one supporting line, one primary action. The hero image *is* the product: a sample campaign card with a price, three bullet benefits, "15 of 50 founding spots taken" and a PayPal button.
- **Numbers carry the story.** A recent-activity feed ($60, $80, $20, "Maya paid Sam · Sent through PayPal") and a worked pricing example ($99 → $7.92 fee → $91.08) explain the business model faster than any paragraph.
- **Plain words.** "BackIt, in plain words." Three audiences in one line each. Four numbered steps. No protocol names on the homepage.
- **Trust in three short claims, not badges.** "You stay in charge. Nobody gets paid until you approve it." "A purchase, not an investment." "Out in the open."
- **One label for synthetic data, used once per object** ("Sample", "Sample data"), not a legend repeated on every component.
- **Restraint.** One accent colour, one serif display face, large whitespace, few cards. Each section introduces one new idea.

## 2. What Second Key does better

- **A harder, more important problem**, with real engineering behind it: deterministic policy, quote-grounded AI evidence checked by code, executor-only PayPal calls, three-way match against PayPal's stored order, a hash-chained audit log, AP2 mandate verification, and a trusted contact who is technically, not just visually, the only approver.
- **Every money state is PayPal's own record**, read back, with IDs.
- **A real operations surface** (the Protection Desk on AG Grid and AG Studio). BackIt has no equivalent.
- **Honesty about limits** is already written and accurate.

## 3. What makes Second Key look AI-generated

- **Announcing instead of showing.** A green "Live" tag appears on 12 surfaces, plus "Demo" tags beside most of them. Together they read like a test harness.
- **Everything explained twice.** The payer page says what it's doing in the header, again in the empty progress card, again in the phone card's four-sentence disclaimer, again in the footer.
- **Density.** The agent page carries two complete demos and a third tool (9 runs in total) plus jargon: "open mandates", "closes them", "ES256 JWT", "RFC 7638 thumbprint".
- **The homepage after my last pass**: seven sections, a ledger card, two-door cards, outcome lanes, a powers grid, five acts, a tools grid and the limits list. Each part is accurate; together it's a brochure, not a product.
- **Inconsistent names for the same thing**: "Payer demo / Experience A", "trusted contact / second key / guardian / reviewer", "paused / held / review required".

## 4. What to remove

- The `Live` component and every use. One disclosure line in the footer, and one **About this demo** page that says exactly what is real, sandboxed, synthetic and simulated.
- Most `Demo` tags. Keep one only where synthetic content could be mistaken for real (the call transcript, the product page).
- From the home page: the powers grid, the five acts and the tools grid (tools move to About), and the limits list (moves to About).
- Repeated explanatory paragraphs on /pay and /agent; jargon on /agent's AP2 section.

## 5. What deserves more emphasis

- **The moment the money stops**: one unmistakable state, with what PayPal holds.
- **The PayPal operations as separate facts**: order, authorization (reserved), capture, void, payout, each with its own status and ID.
- **Evidence integrity**: the exact quote, where it sits in the source, and that code confirmed it's really there.
- **Intent against instruction** on the agent page: what Rose asked, what the page told the agent, what the agent did, what Second Key decided.
- **The decision boundary**: Rose can't approve; only Sarah can (people). The agent can't approve; only Rose can (agents).

## 6. What changes

| Area | Change |
|---|---|
| Vocabulary | **Paused** (never "held" in the UI), **trusted contact** for people, **Rose** for her own agent, **reserved / captured / cancelled / paid out** for PayPal. |
| Home | Hero: "Manipulation shouldn't move money." One line on what Second Key is, two doors (a person under pressure, an agent on a poisoned page) as the product objects, each with real scenario numbers. Then three sections: the boundary, what PayPal does in each outcome, where to inspect it. |
| About | New page: what's real, what's sandbox, what's synthetic, what's simulated, the tools, the limits. |
| Footer | One line: "PayPal sandbox demo with synthetic people. No real money moves. About this demo." |
| /pay | Shorter header; a four-step progress (checked → reserved by PayPal → trusted contact decides → PayPal completes or cancels); the phone card down to one sentence; the Live tag removed. |
| PayPal record (shared) | A per-operation list: order, authorization, capture, payout, each with status and ID, under a one-line summary. Used on /pay, /agent, the reviewer page and the Desk. |
| /agent | Leads with the poisoned-page story ("an ordinary page" vs "a poisoned page", plus two further runs), then the AP2 section, then "Try to fool it". Jargon replaced with plain words; rung labels unchanged (the existing video script quotes them). |
| Desk | Header cut to one sentence; "Audit chain verified" as a status, not a Live tag; fewer pills in the toolbar. |

## 7. The demonstration

See `docs/submission/demo-direction.md`: 2:50, human attack, then agent attack, then the decision boundary on the Desk, ending on one sentence.
