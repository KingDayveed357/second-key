# Deploying Second Key to Render (and getting the PayPal webhook ID)

Audience: Dave · Written 2026-10-11 · Time needed: about 60–90 minutes, mostly waiting for builds.

You'll end with:
- `witness-api` (public HTTPS), `witness-worker` (no port) and `witness-db` (Postgres 17) running on Render;
- the sandbox demo tenant seeded;
- a PayPal webhook delivering real, signature-verified events;
- a sandbox acceptance run against the live URL.

**Rules for this whole guide**
- Sandbox credentials only. The code refuses any host except `api-m.sandbox.paypal.com`.
- Never paste secrets into chat, GitHub, docs or screenshots. They go only into your local `.env` and Render's environment screens.
- Things I couldn't verify from here are marked **(check)**. If the screen doesn't match, follow what Render or PayPal show and tell me what you saw.

---

## Step 0: Prepare credentials (10 min)

**0.1 Rotate the sandbox secret** (it was exposed during Checkpoint 1):
1. Go to https://developer.paypal.com/dashboard/ → **Apps & Credentials** → make sure the **Sandbox** toggle is on → open your app.
2. Under the secret, generate a new one or rotate it **(check: button wording)**. If PayPal offers to keep the old secret alive for a while, don't.
3. Paste the new secret into `.env` (repo root) as `PAYPAL_CLIENT_SECRET=`.

The saved wallet (vault token) belongs to the merchant account, not the secret, so it should keep working (**Inference**). Step 0.3 confirms it.

**0.2 Add the payee to `.env` (repo root):**
```
PAYPAL_MERCHANT_ID=7L6D422CPFA9Q
```
This is your sandbox Business account's merchant ID, from the Stage 1 evidence. It isn't a secret.

**0.3 Check the new credentials locally.** From the repo folder:
```bash
npm run spike:auth
```
Expect `Token OK` and three ✔ lines. If it fails, the new secret isn't in `.env` correctly.

---

## Step 1: Put the code on GitHub (10 min)

Render deploys from a Git repository.

1. Go to https://github.com/new. Name it `second-key`. **Private** for now (it must be public before submission; make it public in Stage 7). **Don't** add a README, .gitignore or licence: the repo already has them.
2. In a terminal in the repo folder, connect and push:
```bash
git remote add origin https://github.com/YOUR-USERNAME/second-key.git
```
```bash
git push -u origin main
```
3. On GitHub, open the **Actions** tab. The **CI** workflow should run and go green: typecheck, architecture rules, unit tests, real-Postgres tests. If it's red, send me the failing step's log before going on.

What gets pushed: code, docs, the sanitized PayPal fixtures, and evidence files containing sandbox order IDs. What doesn't: `.env`, `spikes/out/`, `.secondkey/` and `.pgdata/`, all gitignored. I scanned every commit for secrets before committing.

---

## Step 2: Render account and credits (5 min)

1. Sign up at https://render.com, using **Sign in with GitHub** (it makes step 3 easier).
2. Claim the hackathon credits: https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon ($50, from the Render sponsor page).
3. Render may ask for a payment method before creating paid instances **(check)**. Credits are spent first.
4. Keep the workspace on the **Hobby** plan ($0 + compute). You don't need Pro.

---

## Step 3: Create the services from the Blueprint (15 min, mostly build time)

1. In Render: **New +** → **Blueprint**.
2. Connect GitHub if asked, and give Render access to the `second-key` repo only.
3. Select the repo. Render reads `render.yaml` and shows three resources: `witness-api` (web service), `witness-worker` (background worker) and `witness-db` (Postgres).
4. **Check the instance types and prices on this screen.** None of them should say **Free**. A free database would be deleted 30 days after creation, before judging. Expected defaults are about `0.5c-512mb` for the two services and about `0.1c-256mb` for Postgres. Note the monthly total: our budget is the $50 credit until Dec 15.
5. Render asks for the secret values (the `sync: false` ones):

| Service | Variable | What to enter |
|---|---|---|
| witness-api | `PAYPAL_CLIENT_ID` | your sandbox client ID |
| witness-api | `PAYPAL_CLIENT_SECRET` | the **new** sandbox secret from step 0.1 |
| witness-api | `PAYPAL_WEBHOOK_ID` | **leave blank** (we create it in step 6) |
| witness-api | `CHANNEL3_API_KEY` | blank, unless you already have one |
| witness-api | `WITNESS_DEMO_SHOPPER_ID` | **leave blank** (we get it in step 5) |
| witness-worker | `PAYPAL_CLIENT_ID` | same as above |
| witness-worker | `PAYPAL_CLIENT_SECRET` | same as above |
| witness-worker | `CHANNEL3_API_KEY` | blank, or your key |

Blank is safe: the code treats a blank value as "not set". If Render won't accept a blank, skip that field and add it later under the service's **Environment** tab.

6. Click **Apply**. Render creates the database, builds both services, runs the database migration (the API's pre-deploy step), then starts them.

**What success looks like** (each service's **Logs** tab):
- Build: ends with pnpm's `Done in …s`.
- witness-api pre-deploy: `applied 0001_init.sql` (or `database is up to date`).
- witness-api: a Fastify "Server listening" line.
- witness-worker: `{"level":"info","msg":"worker started",…}`.

7. Find the API URL at the top of the **witness-api** page, something like `https://witness-api-xxxx.onrender.com`. Open these two in a browser:
- `https://YOUR-API-URL/healthz` → `{"ok":true}`
- `https://YOUR-API-URL/readyz` → `{"ok":true}` (proves the database connection)

If the build fails, see Troubleshooting at the end.

---

## Step 4: Note what you'll need (2 min)

Keep these handy (not secrets, except where marked):
- **API URL** from step 3.7.
- **External Database URL**: Render → `witness-db` → **Connect** → **External** tab → copy it. **This contains the database password: treat it as a secret.**
- Under `witness-db` → **Access Control** **(check)**: make sure your current IP is allowed. Some setups allow everyone by default.

---

## Step 5: Seed the demo tenant into the Render database (5 min)

This runs on **your laptop** and connects to the Render database over TLS. It creates the demo tenant (with your merchant ID as the required payee), the demo shopper with your saved sandbox wallet (read from `spikes/out/vault.json`), and API keys. The keys go into `.secondkey/render-keys.json` (gitignored) and are **never printed**.

In the repo folder, replacing the URL with your External Database URL and keeping `?sslmode=require` on the end:
```bash
DATABASE_URL="PASTE-EXTERNAL-DATABASE-URL?sslmode=require" WITNESS_KEYS_FILE=.secondkey/render-keys.json pnpm db:seed
```
- Expect: `Seeded tenant ten_…, demo shopper shp_…`.
- If you get a certificate error, rerun with `?sslmode=no-verify` instead of `?sslmode=require` and tell me (**check**: I couldn't confirm which one Render's certificates need).
- If you're in PowerShell rather than Git Bash, set the variables first: `$env:DATABASE_URL="…"; $env:WITNESS_KEYS_FILE=".secondkey/render-keys.json"; pnpm db:seed`.

Then copy the printed `shp_…` ID into Render: **witness-api** → **Environment** → `WITNESS_DEMO_SHOPPER_ID` = `shp_…` → **Save changes**. Render redeploys the API, which takes about a minute.

---

## Step 6: Create the PayPal webhook and get its ID (10 min)

PayPal's requirements (from PayPal's webhook docs): the listener must be HTTPS on port 443 (Render provides that) and return a 2xx. PayPal retries failed deliveries up to 25 times over 3 days.

1. https://developer.paypal.com/dashboard/ → **Apps & Credentials** → **Sandbox** → open the same app as your client ID.
2. Scroll to **Webhooks** (**check**: may say "Sandbox Webhooks") → **Add Webhook**.
3. **Webhook URL:** `https://YOUR-API-URL/v1/webhooks/paypal`
4. **Event types:** tick these (they're the ones Second Key handles; all exist in the sandbox event list we fetched in Stage 1):
   - `Checkout order approved`, `Checkout order completed` (CHECKOUT.ORDER.APPROVED, CHECKOUT.ORDER.COMPLETED)
   - `Payment authorization created`, `Payment authorization voided` (PAYMENT.AUTHORIZATION.CREATED, .VOIDED)
   - `Payment capture completed`, `pending`, `declined`, `denied`, `refunded`, `reversed` (PAYMENT.CAPTURE.*)
   - `Customer dispute created`, `updated`, `resolved` (CUSTOMER.DISPUTE.*)
   - Don't choose "All events": it would add noise to the logs.
5. **Save.** PayPal shows the new webhook in the list with a **Webhook ID** (a string of about 17 letters and numbers). Copy it.
6. In Render: **witness-api** → **Environment** → `PAYPAL_WEBHOOK_ID` = the ID → **Save changes** (redeploys).

**Don't use PayPal's Webhooks Simulator to judge success.** PayPal documents that simulator ("mock") events can't be verified by the postback method Second Key uses, so the API will reject them with HTTP 400. That's correct behaviour. Real events come from real sandbox payments, which step 7 generates.

---

## Step 7: Prove it works against the live URL (10 min)

Run the acceptance suite against Render. It creates real sandbox purchases through the public API, checks PayPal's own state, waits for webhooks, and reports what arrived:
```bash
WITNESS_API=https://YOUR-API-URL WITNESS_KEYS_FILE=.secondkey/render-keys.json EVIDENCE_FILE=render-sandbox-run.md WEBHOOK_WAIT_MS=45000 npx tsx scripts/sandbox-acceptance.ts
```

**Expected:**
```
PASS S1 Clean purchase: … captures COMPLETED 84.00
PASS S2 Excluded colour: … no order exists
PASS S5 Cart swap (faulty checkout adapter): … auth VOIDED; captures none
PASS S7 Idempotency-Key replay: …
PASS HOLD Missing size -> HOLD (funds held), shopper revokes: … auth VOIDED
Webhooks: N verified event(s) received (CHECKOUT.ORDER.COMPLETED, PAYMENT.AUTHORIZATION.CREATED, …); 0 rejected.
audit chain: valid …
all scenarios passed
```
The run writes `docs/evidence/render-sandbox-run.md`.

**PowerShell** doesn't understand `VAR=value command`. Set the variables first; they last for that window:
```powershell
$env:WITNESS_API = "https://YOUR-API-URL"; $env:WITNESS_KEYS_FILE = ".secondkey/render-keys.json"; $env:EVIDENCE_FILE = "render-sandbox-run.md"; $env:WEBHOOK_WAIT_MS = "45000"
```
```powershell
npx tsx scripts/sandbox-acceptance.ts
```
If you see `HTTP 401 … Missing or invalid API key`, the script used the wrong keys file: `WITNESS_KEYS_FILE` must point at the file the Render seed wrote (`.secondkey/render-keys.json`), not the local `.secondkey/dev-keys.json`.

To look at webhook deliveries at any time (uses the ops key from the keys file; the key isn't displayed):
```bash
curl -s -H "Authorization: Bearer $(node -p "require('./.secondkey/render-keys.json').ops")" https://YOUR-API-URL/v1/console/webhooks
```
In PowerShell (use `curl.exe`: plain `curl` is an alias for `Invoke-WebRequest`):
```powershell
$ops = node -p "require('./.secondkey/render-keys.json').ops"; curl.exe -s -H "Authorization: Bearer $ops" https://YOUR-API-URL/v1/console/webhooks
```

**Send me:**
1. the acceptance output (it contains no secrets);
2. the API URL;
3. anything that didn't match this guide.

I'll then record which webhook events fire for each step (an open "Unknown" from Stage 1) and close tasks 3.8 and 3.11.

---

## Costs and housekeeping

- Check **Billing** in Render after a day to see real spend against the credit.
- Nothing here is free tier, so there are no cold starts and the database won't expire.
- To pause spending later: suspend the services in Render. They must be running from about Nov 8 (recording) through Dec 15 (end of judging).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails at `npx -y pnpm@10.33.0 install` | npm registry hiccup, or Node version | Click **Manual Deploy → Clear build cache & deploy**. Check `NODE_VERSION=24` is set on the service. |
| `Invalid configuration: check PAYPAL_CLIENT_ID…` in logs | Secret not entered for **that** service (each service has its own) | Add it under the service's **Environment** tab and save |
| `Refusing to run against …` | `PAYPAL_BASE_URL` changed | It must be exactly `https://api-m.sandbox.paypal.com` |
| `/readyz` returns 503 | Database not ready or not linked | Wait for `witness-db` to show "Available"; check `DATABASE_URL` comes from the database |
| Seed: `ECONNREFUSED` / timeout | IP not allowed, or wrong URL | Use the **External** URL; check Access Control |
| Seed: certificate error | TLS verification mode | Use `?sslmode=no-verify` and tell me |
| Demo scenarios return 503 "Demo not configured" | `WITNESS_DEMO_SHOPPER_ID` not set | Step 5, last part |
| Scenario returns AUTH_FAILED "buyer action required" | Saved wallet not usable with these credentials | Tell me; we re-run spike 03 to save a fresh wallet |
| Webhooks: 0 verified, some rejected | Wrong `PAYPAL_WEBHOOK_ID`, or the webhook belongs to a different app than the client ID | Copy the ID again from the **same** app; save; rerun step 7 |
| Webhooks: 0 received at all | URL typo in PayPal, or wrong event types | Check the URL ends with `/v1/webhooks/paypal`; check the events are ticked |

---

## Second Key on Render (added 2026-10-17)

Deploying the Second Key branch needs no new services. Migrations `0003_check_evidence` and `0004_payouts` run automatically in `witness-api`'s pre-deploy step. Two optional settings are made in the Render dashboard (they aren't in `render.yaml`, so a Blueprint sync never blocks a deploy):

1. **Recipient payouts.** In `witness-api` → **Environment**, add `SECONDKEY_DEMO_RECIPIENT_EMAIL` = the email of the PayPal **sandbox personal** account that stands in for demo recipients. Save; Render redeploys the API. Without it, approved transfers are captured but not paid out, and the screens say "Paying the recipient isn't set up in this deployment". The sandbox merchant's balance must cover the $1,800 payouts.
2. **The demo payer's name.** The reviewer screen says "<name> asked you to check a payment", using the seeded shopper's display name. To show "Rose", run this once against the Render database (External Database URL, `?sslmode=require`):
   ```bash
   psql "PASTE-EXTERNAL-DATABASE-URL?sslmode=require" -c "UPDATE shoppers SET display_name = 'Rose' WHERE id = 'shp_…';"
   ```
   Use the same `shp_…` as `WITNESS_DEMO_SHOPPER_ID`.

The Protection Desk at `/desk` uses the existing console password (`WITNESS_CONSOLE_PASSWORD`). The demo reset (`POST /v1/demo/reset`, admin key from `.secondkey/render-keys.json`) starts a clean demo session without deleting anything.
