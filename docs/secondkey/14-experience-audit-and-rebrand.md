# Second Key: experience audit, judging matrix and rebrand plan

Written 2026-11-09, three days before the Devpost deadline. Based on the working tree of branch `second-key-guardian` @ `0147cf4` plus uncommitted work, and on a browser pass of every public route at 360, 390, 430, 768, 1024, 1280 and 1440 px in light and dark.

**Coordination.** A parallel session owns the AP2 / real-mandates work: everything it had modified or added (`packages/ap2`, settlement, verifier, migrations 0008–0010, `(sk)/agent/*`, `lib/ap2-*`, `lib/server/proxy.ts`, `sk.css`, `render.yaml`, every `package.json`, the lockfile, `test-support/*`, `.env.example`). This pass touched none of those files. New styles live in `(sk)/sk-shell.css`, so neither session edits the other's CSS.

---

## 1. Audit

| # | Question | Finding |
|---|---|---|
| 1 | **What works well** | The engine's separation of powers (AI adds caution only; deterministic policy; executor-only PayPal calls; read-back states); honest live/demo labelling; the design tokens (paper, evergreen, brass) and state wording in `lib/sk.ts`; the Desk's AG Grid build (column groups per fact, saved views, lenses, inline evidence rows, redacted CSV, keyboard selection); AG Studio Insights with a read-only analyst; the guardian flow (ADR-0020). Keep all of it. |
| 2 | **Unfinished or inconsistent** | The operator console (`/console`) still showed "Witness" in widget menus, check labels, disputes copy and the AI analyst's name. Fixed. |
| 3 | **Hard to understand** | The home page led with the payer scam story, while the strongest and most novel demo is the agent one. The seven separate facts (authorized, agent intent, page content, verified facts, policy, person, PayPal) were never shown side by side before a visitor reached a demo. Fixed: the hero is now that ledger. |
| 4 | **Weakens the narrative** | (a) **A first visit to the public Desk shows an empty grid**, because it shows only the visitor's own session. Fixed with a guided empty state that says why and links to both demos. (b) Pages read as separate demos, not one journey. Fixed: a five-act path on the home page and nav in story order. |
| 5 | **Missing from the judging criteria** | *Presentation* is judged on a video under 3 minutes: there is no script in the repo. See §5. *Design* ("complete, coherent product experience"): mobile navigation was broken (below). |
| 6 | **Underused partners** | **Channel3**: wired (`packages/catalog`, live response shape verified 2026-10-12) but the demo scenarios use fixture product IDs, so the live demo never shows Channel3 data. The facts record a `source` field; the agent demo could display it. **AG Studio**: strong, but the licence through judging is still unresolved (ADR-0009). |
| 7 | **Live-demo failure risks** | AG Studio licence expiry (watermark); Render free-tier cold starts on the API; Anthropic spend caps reached mid-demo (public cap $0.25 per process); payouts off when `SECONDKEY_DEMO_RECIPIENT_EMAIL` is unset; an empty public Desk if the presenter opens it before running a scenario (now explained on screen). |
| 8 | **Mobile and tablet** | **At 360–430 px every page was 497 px wide**: the four nav links didn't fit, and the footer's nowrap legend tag overflowed. CSS also hid the Agent demo link on phones. Fixed (see §2). The Desk now shows a reduced column set on small screens. |

## 2. What changed in this pass

| Change | Files | Verified |
|---|---|---|
| Disclosure menu under 860 px (aria-expanded/controls, focus moves in, Escape returns focus, closes on navigation and outside click); nav in story order; skip link; active-page indicator | `(sk)/_ui/ui.tsx` (`Nav` only; every export unchanged), `(sk)/layout.tsx`, `(sk)/sk-shell.css` | Browser at 360/1024/1440 |
| No horizontal overflow on any route | `sk-shell.css` | `scrollWidth == innerWidth` on `/`, `/pay`, `/agent`, `/desk`, `/developers`, `/try`, `/guardian` at 360, 390, 430, 1024 |
| Home rebuilt around "An AI agent can be manipulated. Your money shouldn't be.": the seven-facts ledger (labelled as an illustration of the real "agent steered" run), five acts, separation of powers, one job per partner tool, the honesty section kept and extended | `(sk)/page.tsx`, `sk-shell.css` | Light and dark, 360–1440 |
| Desk: guided empty state for the public view; toolbar wraps; columns follow the viewport (≤1100 px hides workflow/quotes/payout; ≤760 px also hides pattern/auth/capture/time and unpins status); selecting an incident on narrow screens scrolls the detail into view | `(sk)/desk/desk.tsx` | Column sets checked at 360/768/1440. **Not verified with incidents loaded** (no seeded local API available to this session) |
| Operator console: visible "Witness" strings → Second Key (internal identifiers and env var names unchanged) | `app/_components/studio.tsx`, `studio-ai.ts`, `disputes.tsx` | Typecheck |
| `distDir` reads `SK_NEXT_DIST_DIR` (default `.next`) so a second local dev server can't corrupt another's build | `apps/web/next.config.mjs`, `.gitignore` | Ran both |
| README lead matches the positioning | `README.md` | — |

Checks run: `tsc -p apps/web` (pass), `vitest --project unit` (34 files, 475 tests, pass), `check-architecture` (pass). DB tests were not run: the shared Postgres was in use by the parallel session's rehearsal.

## 3. Judging matrix

Official criteria (Devpost page, read 2026-11-09): **Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation**. Prizes include Best Use of Agentic Commerce, Best Use of PayPal + AI, Best Demo Delivery, AG Grid ($5k / $2k / $1k×3), Channel3 ($1.5k) and Render (credits). Rules §8 as recorded in ADR-0009: at most one grand/honorable prize **and one sponsor prize** per project.

| Criterion / prize | Existing | Gap | Improvement | Evidence a judge can inspect | Demo moment |
|---|---|---|---|---|---|
| Technological Implementation | Orders v2 authorize → void / capture → Payouts, read back; executor isolation; hash-chained audit; AP2 verifier (parallel session) | Sandbox evidence is in docs, not one page | Link `docs/evidence/*` from /developers | `docs/evidence/`, Postman collection, 475 unit + DB tests | /developers conformance run |
| Design | Token system, honest labels | Mobile nav broken; Desk empty on first visit | **Done** (§2) | Any page on a phone | Open the menu on a phone |
| Potential Impact | Two audiences: agent platforms, people under pressure | — | Home now names both | Home "Separation of powers" | Hero ledger |
| Innovation | Mandate + independently fetched facts + PayPal's stored order, three independent checks | — | Home makes the separation explicit | /agent, five runs | "Agent steered" run |
| Presentation | — | No script | §5 | — | — |
| Best Use of Agentic Commerce | AP2 mandates, cart-vs-intent, cart swap caught at PayPal | — | Lead with it | /agent | Steered + cart swap |
| **AG Grid (the sponsor prize to target)** | Community grid with column groups, views, lenses, full-width evidence rows, CSV; AG Studio Insights with custom proof-chain widget and Studio Agent Framework agents | Licence for judging unresolved; mobile columns | Responsive columns **done**; get a licence (owner: Dave) | /desk, /desk?tab=insights | Select an incident, then ask the analyst "who decided the paused payments?" |
| Channel3 | Live client with fixture fallback | Demo never shows a live Channel3 read | Show `facts.source` in the agent demo (parallel session's file), or add one scenario on a real Channel3 product ID | `packages/catalog` | — |
| Render | Blueprint: web, API, worker, Postgres | — | — | `render.yaml` | — |

## 4. Rebrand: Witness → Second Key

Public identity is now Second Key on every route. What remains is internal or infrastructure, and **should not change before the deadline**: the package rename touches every `package.json`, every import and the lockfile, all of which the parallel session is editing, and the infrastructure names are tied to the running demo.

| Layer | Today | Plan | When |
|---|---|---|---|
| 1. Public identity (UI, titles, README, console text) | Second Key | Done | Now |
| 2. Packages `@witness/*`, root `witness` | 15 packages | `@secondkey/*`: rename names, rewrite imports (`grep -rl "@witness/"`), update `render.yaml` `--filter`, `tsconfig.base.json` paths, `scripts/architecture-rules.ts`; `pnpm install` to regenerate the lockfile; full `pnpm check` | After the AP2 work is committed; one commit; not before judging |
| 3. Infrastructure (Render services `witness-api/-worker/-web`, group `witness-shared`, DB `witness`) | Live | **Keep.** Renaming a service's display name is allowed but its `onrender.com` slug never changes (§6). Never recreate the DB | Not planned |
| 4. Env vars `WITNESS_*` (30) | Set on Render | Read `SECONDKEY_X ?? WITNESS_X` in `packages/config` and the web's server code; add new names on Render; remove old ones a release later | After judging |
| 5. Historical docs (ADR-0004 "witness creates orders", evidence runs, spikes) | Mention Witness | Keep as history; ADR titles are records | — |
| 6. Persistent names (DB name, `.witness/` keys dir, `witness_console` cookie, `x-witness-*` headers) | In use | Keep; renaming the cookie signs everyone out, and the headers are an internal contract | — |

## 5. Demo script (under 3 minutes)

1. **0:00 Home.** The hero line, then the seven-facts ledger: "an agent can be told anything; these facts are kept apart."
2. **0:20 /agent, "Agent steered".** The page told the agent the person pre-approved another shoe; the ladder shows which check refused it; PayPal was never called.
3. **0:55 /agent, "Checkout swaps it".** The cart was right but PayPal's stored order wasn't: Second Key voids before capture. Show PayPal's own order read.
4. **1:25 /pay.** Rose's rule pauses $1,800; open Sarah's phone; Sarah approves; capture then payout, each read back.
5. **2:05 /desk.** Select the incident: AI observation, rule, person, PayPal, audit chain verified. Switch to Insights and ask the analyst one question.
6. **2:35 /developers.** One API; conformance suite on the sandbox. Close on the honesty list.

Rehearse with the Desk opened **after** running the scenarios; it shows the presenter's own session.

## 6. GitHub and Render

**Status 2026-11-09: done.** The repo is `KingDayveed357/second-key`. Same commits on all three branches, the old URL still serves `git`, the local `origin` and the /developers links point at the new name, and Render's `witness-web`, `witness-api` and `witness-worker` already list `KingDayveed357/second-key` (branch `main`, auto-deploy on commit). Still to update by hand: the Devpost submission's repo URL.

**GitHub rename** (`KingDayveed357/witness` → `second-key`), Settings → General → Repository name → Rename. GitHub keeps every branch, commit, issue, PR, star and release, and redirects web and `git` traffic from the old name to the new one ([GitHub docs: renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)). The old name redirects only until someone creates a new repo with that name. Then:

```bash
git remote set-url origin https://github.com/KingDayveed357/second-key.git
```

Update the one hard-coded link in `apps/web/app/(sk)/developers/page.tsx` (`REPO`) and the Devpost submission's repo URL. `ci.yml` has no repo-name reference. Render's GitHub app tracks the repository, not its name; after the rename open each service's Settings → Build & Deploy and confirm the repo shows `second-key` and a manual deploy succeeds. **Safe to do before the deadline**, ideally when no deploy is running.

**Render URL** (`witness-web.onrender.com` → `second-key-web.onrender.com`). Render staff state that a service can be renamed but its `onrender.com` subdomain can't be changed; a new subdomain needs a new service ([community.render.com](https://community.render.com/t/can-i-change-my-existing-subdomain-onrender-com-to-a-new-one/9999), [community.render.com](https://community.render.com/t/how-do-i-change-url-of-a-web-service/11980)). These are staff forum replies, not the official docs; confirm in the dashboard. Options:

- **Recommended for judging: keep `witness-web.onrender.com`.** Rename the service's display name to "second-key-web" if wanted; the URL stays.
- **A custom domain** (Settings → Custom Domains) gives a Second Key URL without a new service. Needs a domain you own.
- **A new `second-key-web` service** is the only way to get that subdomain: a second web service (cost against the credits), new env vars, and every URL below updated. Not worth the risk three days out.

If the URL ever changes, update: README (7 links), `docs/openapi.yaml` (`servers`), `docs/deploy-render.md`, the Postman collection's base URL, `WITNESS_RETURN_URL` / `WITNESS_CANCEL_URL` on Render (PayPal return URLs), the web's `WITNESS_API_URL` if the API moves, and the Devpost demo URL.

## 7. Open items

- Verify the Desk changes with incidents loaded (empty state, column sets with data, detail scroll on a phone).
- AG Studio licence through judging (Dave).
- Channel3 visibility in the agent demo (the parallel session's files).
- Package and env-var renames after judging (§4).
