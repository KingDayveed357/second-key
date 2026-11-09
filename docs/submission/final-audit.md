# Second Key: final audit and roadmap (9 Nov 2026, 13:45 UTC)

**Deadline:** 12 Nov 2026, 12:00 PT (20:00 UTC). That is about 78 hours from this audit. The plan below fits in about 48 working hours and keeps the rest as buffer.

**Basis:** the repository at `cf6210e` (merged to `main`, public, MIT), the live site at witness-web.onrender.com (checked through the browser and the API proxy), and the official Devpost pages (overview, prizes, judging criteria, and the sponsor pages for AG Grid, APIMatic, Channel3, Postman and Render).

---

## 1. Actual state

| Area | Status | Evidence |
|---|---|---|
| PayPal: vaulted AUTHORIZE, capture, void, payouts, webhooks, disputes | **Complete** | AP2 "It goes right" run on the live site captured order `8RF578550F306083J` (9 Nov). Sandbox evidence files. The Desk shows 22 live incidents. |
| Person story (/pay): $1,800 paused; only Sarah can approve; payer can't | **Complete** | Live Desk row "Transfer to J. Morgan, Needs attention". 24 guardian API tests (ADR-0020). |
| Agent story (/agent, first section): poisoned page, HOLD, Rose decides | **Complete** | Live Desk rows "Text giving orders to the AI agent, Review required". |
| AP2 delegated verifier: signatures, constraints, extensions, ledger, settlement, receipts | **Complete** | Live run passed all five rungs and captured. 175 AP2 tests. Interop with Google's SDK. Sandbox 4/4. |
| AP2 receipts that keep verifying | **Incomplete** | The live JWKS kid is `ephemeral-…`, so `SECONDKEY_RECEIPT_JWK` isn't set on Render. Every restart or redeploy breaks verification of earlier receipts, and "ephemeral" is printed on screen. |
| Protection Desk (AG Grid + AG Studio) | **Complete locally (10 Nov); not yet deployed** | New "Agent mandates · AP2" AG Grid tab (layer columns, "AP2 alone would have said yes" count, detail with receipts), AP2 widgets in AG Studio Insights, and the Studio agent knows the new data source. |
| Developers page: no-account test verification, templates, conformance | **Complete** | Verified in an earlier rehearsal; live page returns 200. |
| Channel3 | **Complete locally (10 Nov); not yet deployed** | Real-product panel on `/agent#ap2`: Haiku drafts rules, Channel3 search, Second Key re-fetches by id and signs facts, PayPal sandbox capture (`5AD8723587940254B`, local rehearsal). All five outcomes reproduced on live Channel3 data. |
| Postman collection | **Incomplete, partly broken** | `postman/witness.postman_collection.json` dates from 13 Oct. It has no AP2 (`/v2`) endpoints, still calls `POST /v1/purchases/{id}/hold-link` (removed by ADR-0020), and still says "Witness". |
| APIMatic | **Missing (as far as the repo shows)** | The prize rewards using the APIMatic **Context Plugin for PayPal** while building. Nothing in the repo or docs records that it was used. Only you know. |
| Render | **Complete as hosting** | Web, API, worker and Postgres. The Render prize asks for **Render Workflows**, which aren't used. |
| Tests | **Complete** | On `cf6210e`, 9 Nov: typecheck clean; 54 test files, 702 vitest tests pass. The 16 node tests weren't re-run. |
| Demo video | **Missing** | Not recorded. Two competing scripts exist (`video-script.md`, AP2-first; `demo-direction.md`, manipulation-first). |
| Devpost text | **Incomplete** | `devpost.md` is drafted, but it claims the SDK issue "is reported to Google" (not true yet), names Channel3 for "independent product facts" (not true in the hosted demo), and has no video link. |
| Security disclosure | **Exposed** | The repo is public, and the full mechanism of the Google SDK issue has been public since `124bb8d`. Google hasn't been told (Bug Hunters refused it as out of scope; GitHub private reporting is the open route). |

**Overall completion:** about 85% of what we'd submit. The engineering is done. What's missing is the video, the AP2 lens in the Desk, real Channel3 data in the demo, an accurate partner story, and a few configuration and claim fixes.

---

## 2. Against the official judging criteria

The official criteria are five, equally described with no weights: Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation. A project can win at most one grand or special prize plus one sponsor prize (Rules §8, recorded in ADR-0009).

| Criterion | Score | Evidence | Impressive | Weak | Raise it within the time |
|---|---|---|---|---|---|
| **Technological implementation** | **8** | Real PayPal flow; isolated executor; AP2 verifier interoperable with Google's SDK; 700+ tests. | Depth beyond nearly any hackathon entry: binding a settlement to PayPal's stored order, an advisory-locked ledger, signed receipts. | AI is narrow by design (evidence quotes, listing check, the Studio analyst). A judge scoring "use of AI" may see a small AI role. | Show the AI's job once, clearly: Haiku reads the poisoned page and flags it, but can only add caution. If Channel3 gets built, Haiku turns Rose's sentence into mandate rules. |
| **Design** (complete, coherent product) | **6** | Coherent home page with two stories, navigation, about page, Desk. | Honest labelling of what's real; restrained visuals. | The AP2 section is dense (SD-JWT, ledger, kid). The Desk doesn't show the AP2 story, so the product's newest half isn't in the operator view. Two personas and six surfaces dilute it. | AP2 lens in the Desk; replace the jargon in the AP2 rungs with plain captions; fix the receipt key so "ephemeral" disappears. |
| **Potential impact** | **7** | Authorised-push-payment scams are a real, large problem, and so is agent misbehaviour under prompt injection. | "Who you're talking to isn't the person whose money it is" links both stories. | Who deploys it is vague ("platforms build it into their PayPal flow"). Is it a PSP, a wallet, a merchant? | One sentence on the buyer: payment platforms and agent wallets that hold PayPal orders, where Second Key is the step before capture. |
| **Innovation / idea** | **7** | Delegated AP2 verifier + an attribute constraint AP2 can't express + settlement against PayPal's order. A second key held by someone else. | The "white shoe" case: AP2 alone says yes, Second Key says no. Few entrants will have this. | Trusted contacts and payment holds exist at banks; "AI payment safety" is a crowded phrase. | Lead with the AP2 gap, made concrete with a real product (Channel3), not with "safety". |
| **Presentation** | **2** today (no video); **7–8** achievable | Script drafted, 2:50. | | No video. Two scripts. Narration packed with protocol terms. | Pick one script, record, captions. This is the single biggest lever. |

### The uncomfortable questions

- **Would a judge remember it after 100 projects?** Only if the video lands one image: an AI agent buys the wrong thing, AP2 says it's authorised, and Second Key stops it before PayPal captures. Today that moment sits at minute one of an AP2 section full of protocol terms. As shipped, it's memorable to an AP2 expert and forgettable to a generalist.
- **What's genuinely new?** Three things, and none is "AI checks payments":
  1. a verifier that checks *what the user meant* (attributes) against facts it fetched and signed itself;
  2. binding the mandate to the order PayPal actually holds before capture;
  3. approval that belongs to a different person, enforced in the engine.
- **Does it solve an important agentic-commerce problem?** Yes. AP2 deliberately leaves descriptive intent, state and settlement open, and we fill exactly those gaps with working code.
- **New capability, or explaining a problem?** It's a working capability. But the screens over-explain it: long rung texts, a methodology footer, "what's real" notes.
- **Is the value clear in 30 seconds?** The home page headline is, for the person story. For the agent story, not yet.
- **Does the implementation justify the claims?** Mostly yes, and better than most entrants. Three claims are ahead of reality and must be fixed:
  1. Channel3 "independent product facts" (fixtures in the hosted demo);
  2. "reported to Google";
  3. receipts that "verify" (they stop verifying after a restart).
- **Why would a judge pick us over a technically impressive rival?** Because ours is real end to end: a real PayPal capture or void, real signed AP2 mandates from the user's own browser, and refusals you can verify yourself.
- **Biggest reasons we might lose:**
  1. A weak or confusing video.
  2. A hosted demo that looks scripted (fictional "Ridgeline" products).
  3. Too much on screen: two stories, six surfaces and protocol jargon.
  4. A judge hitting a cold start or a broken Postman request.

---

## 3. Partner audit

Scores are out of 10: Tech = technical implementation, Depth = depth of integration, Rel = relevance to Second Key, Vis = demo visibility, Prize = prize competitiveness.

| Partner | Tech | Depth | Rel | Vis | Prize | Verdict |
|---|---|---|---|---|---|---|
| **AG Grid / AG Studio** | 8 | 7 | 7 | 6 | **6** | **Real and central.** The Desk grid groups incidents with evidence columns. Studio has a Second Key theme, a custom "evidence chain" widget that verifies the hash chain live, and the Studio Agent Framework with a custom harness and agents on Haiku. That is exactly what the sponsor page asks for: polish, custom widgets, theming, and an agent framework with a swapped-in harness. Gaps: AP2 decisions are absent, and the AG Studio trial licence ends about 9 Dec, before judging ends on 15 Dec. |
| **Channel3** | 6 | 3 | 8 | **1** | **2** | **Real code, invisible in the demo.** The sponsor rule says projects that "only reference Channel3 without calling it" don't qualify. The hosted site doesn't call it in any judge-visible flow. As shipped, I wouldn't claim it on Devpost without the change in §3.4. |
| **Postman** | 5 | 4 | 5 | 2 | **n/a** | **There is no Postman prize** in the official prize list. The collection is still useful as judge tooling, but it's stale and partly broken. Fix it or drop the claim; don't invest beyond a refresh. |
| **APIMatic** | ? | ? | 3 | 0 | **1** | The prize rewards building the PayPal integration with the APIMatic Context Plugin in your AI coding tool. If you didn't use it, don't claim it. You could still use it honestly now for any PayPal-touching work in the plan and say exactly that, but it's a weak bet and can't be combined with an AG Grid win. |
| **Render** (not asked about, but it's a prize) | 7 | 5 | 6 | 2 | **2** | Hosting only; the prize highlights Render Workflows. Not worth chasing. |

**One sponsor prize at most.** AG Grid is worth up to $5,000, and its judge, AG Grid's technical community manager, is on the panel. Channel3's prize is $1,500, one winner. Target **AG Grid**. Do Channel3 work only for the core demo's sake.

### 3.4 Channel3: how it works today, and the proposal

**Today:**
- **Purchase screening (`/v1/purchases`):** `catalogFromEnv` → `FallbackCatalog(Channel3Catalog, FixtureCatalog)`. For each product id it calls `GET https://api.trychannel3.com/v1/products/{id}` with `x-api-key`, and `normaliseChannel3` maps offers, attributes and colour variants into `ProductFacts`. The demo ids are fixtures, so Channel3 returns nothing and the fixture is used.
- **AP2 facts attestation (`attestFacts`):** the same catalog, so with fixture ids it again uses fixtures.
- **Search (`POST /v1/search`):** only in `apps/agent/src/tools.ts`, the Haiku reference agent run from the CLI. Evidence: on 12 Oct it bought real Nike Wildhorse shoes (`docs/evidence/stage4-sandbox-run.md`).

**Proposal: "Bring a real product" inside the AP2 section** (not `/try`, which is the scam-message analysis):
1. Rose types a need, for example "gold smartwatch under $150". Haiku turns it into rules (query, colour any_of gold, max $150) and shows them for Rose to edit. That is a meaningful, bounded use of AI.
2. Second Key's API calls Channel3 search with the key held server-side, and shows 4–6 real products with real prices.
3. Rose's device signs the mandate: `acceptable_items` = those results; `x-secondkey.item_attributes.1` = colour any_of gold; amount ≤ $150.
4. **"Agent buys right":** it picks a gold one. Second Key fetches that product from Channel3 and signs the facts; every check passes; real PayPal sandbox capture.
5. **"Agent substitutes":** it picks a silver one from the same results, so it's listed. **AP2 says yes; Second Key's Channel3-backed facts say no.** PayPal is never asked.

**Feasibility:** high. The pattern already exists. Rose's mandate lists a product "family" plus attribute rules (`ap2-surface.ts:94-96`), the normaliser reads Channel3 colour variants, and settlement already works.

**Changes needed:**
- **API:** a demo search endpoint, rate-limited, with the key server-side.
- **Engine:** generalise `runAp2Demo` from the fixed `RUNS` to any product and price from attested facts, and let the demo merchant accept the product's own retailer.
- **Web:** one panel with a search box, product cards and two run buttons.
- **Tests:** an engine DB test using a recorded Channel3 fixture.

**Estimate:** 7–9 hours including tests and a deploy. No change to the verifier, ledger, settlement or executor, so the core guarantees are untouched.

**Risks:**
- Products without a colour variant: filter results to those that have one.
- Credits and latency: cache results per query.
- Retailer prices above sandbox comfort: cap the price.
- A judge's free-text query returning nothing: pre-fill an example query.

**Recommendation: implement, simplified and time-boxed.** Skip comparison views and free-form agent chat: one query, one result list, two buttons. Hard stop at **10 Nov 18:00 UTC**; if it's not passing then, abandon it and keep fixtures. Why it's worth it:
- it replaces the fictional "Ridgeline" shoes with real products, so the agent demo stops looking scripted;
- it shows AP2's gap with live data;
- it adds a visible AI step;
- it makes the Channel3 claim true.

---

## 4. What makes it stand out (pick two)

1. **"Authorised isn't the same as right."** An agent with a valid AP2 mandate buys something the user excluded. Second Key refuses it on facts it fetched itself, and nothing is captured. The proof is the wrong-colour or substitution run, ideally on real Channel3 products.
2. **"The second key is someone else's."** A coached person can't approve their own paused $1,800 payment; only Sarah can, from her own device.

Deliberately leave out of the video: the ledger and reuse run, the Studio analyst, the CSV export, the conformance suite, interop details and the guardian invite flow. Mention them once in the Devpost text.

---

## 5. Demo script (2:50)

Recommendation: **lead with agents, close with people.** The "Best Use of Agentic Commerce" prize and AP2 depth are where we're unusual; the scam story is the emotional close.

| Time | Screen and action | Says |
|---|---|---|
| 0:00–0:15 | Home page headline. | "AI agents can now pay for you. Google's AP2 proves your agent was *allowed* to. It can't prove it bought what you meant." |
| 0:15–0:40 | `/agent#ap2`, real product panel. Type "gold smartwatch under $150"; rules appear; Channel3 results appear. Click **Sign**. | "Rose asks for a gold smartwatch under $150. Real products from Channel3. Her own browser signs an AP2 mandate." |
| 0:40–1:00 | **Agent buys right.** All rungs green; PayPal captured, with its order ID. | "The agent buys a gold one. Every check passes and PayPal captures." |
| 1:00–1:30 | **Agent substitutes.** "AP2 constraints: Passed" beside "Second Key's facts: Stopped it: colour Silver". "PayPal: not reached". | "Now the agent swaps in a silver one from the same results. AP2 says yes. Second Key checked Channel3's own product data, signed it, and refuses. No money moved." |
| 1:30–1:45 | **Verify** on a receipt, showing "Signature valid". | "Every decision is signed. Anyone can verify it." |
| 1:45–2:20 | `/pay`: the $1,800 "grandson" transfer pauses; Rose has no approve control; Sarah's phone approves. | "Same idea for people. A coached payment pauses, and Rose can't approve it, so neither can the scammer. Only Sarah can." |
| 2:20–2:40 | `/desk`: the AP2 refusal and the transfer side by side, then expand one row's evidence. | "Operators see every intervention and why, kept separate from what PayPal recorded." |
| 2:40–2:50 | `/developers`: test verification goes green; repo URL. | "No account, no key: try it yourself. Authorised isn't the same as right." |

If Channel3 is abandoned, use the same script with the existing "Wrong colour" run (0:15–1:30).

---

## 6. UI: highest-impact fixes only

1. **AP2 rungs:** cut each detail to one plain line; move SD-JWT, kid and thumbprint behind "Show".
2. **Receipt key:** set it, so "ephemeral" disappears from the screen (P0, configuration only).
3. **Desk:** add AP2 rows, with what was checked, what caught it and the PayPal outcome.
4. **/desk at 360 px:** fix the 2 px horizontal overflow.
5. Nothing else. The design session's pass already removed the badges and tightened the copy. More redesign is risk without score.

---

## 7. Submission checklist (official requirements)

| Requirement | State |
|---|---|
| Uses PayPal meaningfully | Yes |
| Uses AI meaningfully | Yes; make it visible in the video |
| Working prototype | Yes, hosted |
| Text description | Draft; needs the fixes in §8 |
| Tools used and how | Draft; correct the partner claims |
| Public repo with source and run instructions | Yes, `main`, MIT |
| Licence visible in About | **Check** the GitHub About sidebar shows MIT |
| Hosted demo URL | Yes; it must stay up to 15 Dec, and the AG Studio licence must cover that |
| Video < 3 min, public YouTube, no unlicensed trademarks or music | **Missing** |

---

## 8. Roadmap

**Owners:**
- **You:** anything needing your accounts or judgement (Render, YouTube, Devpost, GitHub, Discord).
- **Session A (this one):** AP2 and engine work.
- **Session B (the design session):** web presentation only.

A and B don't share files: A owns `packages/**`, `apps/api/**`, `apps/web/lib/ap2-*` and the new AP2 panel file; B owns `apps/web/app/(sk)/desk/**`, CSS and page copy.

### Phase 1: critical fixes (by 9 Nov 20:00 UTC)

| # | Task | P | Impact | Time | Dep. | Acceptance | Owner |
|---|---|---|---|---|---|---|---|
| 1.1 | Set `SECONDKEY_RECEIPT_JWK` and `SECONDKEY_DEMO_RECIPIENT_EMAIL` on Render; redeploy. I generate the JWK locally into your `.env` (never echoed); you paste it. | P0 | Receipts verify after restarts; no "ephemeral" on screen; payout visible in the video | 20 min | — | Live JWKS kid isn't `ephemeral-…`; a receipt still verifies after a manual restart | You + A |
| 1.2 | Fix the false or over-stated claims in `devpost.md`, `README.md` and ADR-0023: SDK "reported" becomes the actual status; Channel3 wording matches reality (updated if 2.2 lands). | P0 | Credibility with judges, including the Channel3 judge | 30 min | — | Every partner and security claim is backed by a file or a live screen | A |
| 1.3 | Report the SDK issue through GitHub private vulnerability reporting (text ready in `security-report/`). | P0 (ethics, 15 min) | The details are already public; Google should hear before judges do | 15 min | — | Advisory link saved | You |
| 1.4 | Ask AG Grid on the PayPal Discord for a licence covering judging to 15 Dec. | P0 | The Desk must not show a licence watermark during judging | 10 min + wait | — | Written answer, or a key set on Render | You |
| 1.5 | Run tests; fix anything red. | P0 | Stable base | 30 min | — | Typecheck and all tests pass | A |

### Phase 2: high-impact improvements (9 Nov 20:00 to 10 Nov 18:00 UTC)

| # | Task | P | Impact | Time | Dep. | Acceptance | Owner |
|---|---|---|---|---|---|---|---|
| 2.1 | ✅ done 10 Nov · **AP2 lens in the Desk:** an API read of `ap2_verifications` and settlements (session-scoped plus the public demo scope) as Desk rows: decision, what caught it, PayPal outcome, receipt link. | P1 | AG Grid prize; coherent story; AP2 refusals become visible | 4–5 h | 1.5 | All five AP2 runs appear as rows with the right "caught by"; API test added | A (API) + B (grid columns) |
| 2.2 | ✅ done 10 Nov · **Channel3 real-product panel** (§3.4). Hard stop 10 Nov 18:00 UTC. | P1 | Real data; the AP2 gap shown live; Channel3 claim becomes true; visible AI | 7–9 h | 1.5 | A real query returns real products; "buys right" captures on the sandbox; "substitutes" is refused by Second Key's facts with AP2 passing; engine test with a recorded response | A |
| 2.3 | Plain-language AP2 rung details; protocol detail behind "Show". | P1 | Design score; video clarity | 1.5 h | — | No unexplained acronym on the default view | B |
| 2.4 | Refresh the Postman collection: rename it, drop `hold-link`, add a "Second Key AP2" folder (setup, test verification, JWKS), run it once with Newman against the live site. | P2 | Judges who use Postman don't hit a 404; developer-adoption story | 1.5 h | 1.1 | Newman run green against Render | B or A after 2.1 |
| 2.5 | /desk 360 px overflow. | P2 | Mobile polish | 20 min | — | No horizontal scroll at 360 px | B |

### Phase 3: demo and presentation (10 Nov 18:00 to 11 Nov 18:00 UTC)

| # | Task | P | Time | Dep. | Acceptance | Owner |
|---|---|---|---|---|---|---|
| 3.1 | Choose the single script (§5); delete or mark the other as superseded. | P0 | 15 min | 2.2 decision | One script in `docs/submission/` | You |
| 3.2 | Full rehearsal on the live site: every shot, twice, at 1440×900. | P0 | 1 h | 1.1, 2.x deployed | No failed rung, no cold start on camera | You (A checks) |
| 3.3 | Record, cut to under 2:55, captions, public YouTube upload. | P0 | 4–5 h | 3.2 | Public link plays logged-out | You |
| 3.4 | 3–4 screenshots for Devpost (agent refusal, transfer pause, Desk, developers). | P1 | 30 min | 3.2 | In `docs/submission/screens/` | You |

### Phase 4: final submission (11 Nov 18:00 to 12 Nov 16:00 UTC; deadline 20:00 UTC)

| # | Task | P | Time | Acceptance | Owner |
|---|---|---|---|---|---|
| 4.1 | Final Devpost text from `devpost.md`, video link, tools section, "Best Use of Agentic Commerce" plus AG Grid as targets. | P0 | 1 h | Submitted, preview checked logged-out | You (A drafts) |
| 4.2 | README top: what it is, 60-second judge path, partner section matching reality. | P0 | 45 min | A judge can reach every demo from the README in two clicks | A |
| 4.3 | Freeze: no deploys after submission except to fix outages; Render stays up to 15 Dec. | P0 | — | — | You |
| 4.4 | Submit by **12 Nov 16:00 UTC**, four hours before the deadline. | P0 | — | Confirmation email | You |

**Parallel:** 1.1, 1.3 and 1.4 (you) run alongside 1.2 and 1.5 (A). In Phase 2, A does 2.2 while B does 2.3 and 2.5. 2.1 needs A's API before B's columns.

**If time runs short, abandon in this order:** 2.4 Postman, then 2.5, then 2.2 Channel3 (keep fixtures; reword the claim), then 2.3. **Never** cut 1.1, 1.2, 3.x or 4.x.

---

## 9. Final assessment

**A. Readiness scores**

| | Score |
|---|---|
| Overall completion | ~85% |
| Demo readiness | 6/10 (works live; no video; scripted-looking products) |
| Technical quality | 9/10 |
| Innovation | 7/10 |
| Product quality | 6/10 |
| Submission readiness | 4/10 |

**B. Partners, most to least competitive:** AG Grid (realistic shot at 2nd or 3rd; 1st with the AP2 lens and a strong Desk shot), Channel3 (only if 2.2 lands), APIMatic (only if genuinely used), Postman (no prize).

**C. Positioning.**
- **Better than typical entries:** real money paths, real signatures, verifiable refusals, and tests that prove the guarantees.
- **Worse:** the first impression is dense, and the AI is deliberately modest.
- **Memorable:** "AP2 says yes, Second Key says no" on a real product.

**D. Winning strategy.** Target **Best Use of Agentic Commerce**, and **Best Use of AG Grid** as the sponsor prize. Show two capabilities (§4). Leave out the internals.

**E. Sequence.** Follow the roadmap tables above, in order.

**F. Go / no-go.** If the deadline were today: **no-go**, because there is no video and three claims run ahead of the code. Minimum to submit confidently:
- 1.1 (receipt key);
- 1.2 (claims);
- 3.3 (video);
- 4.1 (Devpost).

Everything else improves the odds; those four make it submittable.
