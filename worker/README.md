# Email reminders (Cloudflare Worker): built, NOT switched on

Free email reminders for the landlord register windows. Code only: nothing here is deployed, no accounts
exist, and the website does not show the sign-up form. Merging this folder changes nothing for visitors.

- **Worker** (`src/`): `POST /subscribe`, `GET /confirm?token=`, `GET|POST /unsubscribe?token=`, plus a daily cron.
- **Storage**: Cloudflare D1 (`migrations/0001_init.sql`). Only email, region, timestamps and tokens.
- **Sending**: Resend HTTP API. The API key is a Worker secret, never in this repo.
- **Dates**: `src/regions.js` only, copied from `fact-check.md` (Housing Hub + the PRS Database Regulations 2026, checked 19 Oct 2026).
- **Front-end form**: `frontend/` (markup, JS, CSS). The site generator only adds it when built with `REMINDERS_ENABLED=1`.

## How it behaves

| What | Behaviour |
|---|---|
| Sign-up | Email + one of the 9 regions + consent tick box. Validated on the server. Hidden honeypot field (`website`): bots get a fake "success" and nothing is stored. |
| Abuse limits | 5 requests/minute per IP (Workers Rate Limiting binding; the IP is not stored), one confirmation per address+region per 10 minutes, `DAILY_CONFIRM_CAP` confirmations per 24 h. Same reply whether or not an address is already signed up. |
| Double opt-in | Stored as `pending` with a random token (only its SHA-256 hash is stored). Link valid 7 days. |
| Reminders | Per region: 7 days before the window opens, the day it opens, 30 days and 7 days before the deadline (London dates). Every email uses absolute dates. |
| No duplicates | A `sends` row (subscriber, reminder) is claimed *before* sending; a failed send releases it for a retry. Resend `Idempotency-Key` too. |
| Missed run | A reminder can still go out up to 2 days late, never after the deadline. |
| Clean-up | Unconfirmed sign-ups deleted after 7 days. Everyone in a region deleted the day after its deadline. Unsubscribe deletes immediately. |
| Every email | "Independent, not affiliated with the UK government, register only at gov.uk" with link, "not legal advice", unsubscribe link, `List-Unsubscribe` + `List-Unsubscribe-Post` (one-click, RFC 8058). |
| CORS | `POST /subscribe` only accepts `Origin: ALLOWED_ORIGIN`. |
| Kill switch | `REMINDERS_LIVE = "false"` (the default) makes `/subscribe` answer 503 and store nothing. |
| Cron | `0 8-11 * * *` UTC (four runs each morning). Each run sends at most `MAX_SENDS_PER_RUN` (Workers free plan allows 50 outbound requests per run); later runs pick up the rest. |

## Before switching on (prerequisites, all need Alessandro's approval)

1. **ICO data protection fee paid** (check the current fee and tier on ico.org.uk).
2. **Privacy notice**: review the draft reminders section (kept outside this repo, not published), fill in the
   `[TO DO]`s (contact email, ICO number, Resend/Cloudflare transfer safeguards), and save the approved copy.
   The site build refuses to turn the form on without an approved file, and rejects one that still says DRAFT or `[TO DO]`.
3. **Contact email** for the About and Privacy pages (and `REPLY_TO`).
4. **A domain you own** for the sender address. Resend only sends to other people from a verified domain
   (SPF + DKIM DNS records; add DMARC too). This is the one item that costs money.
5. Accounts: **Cloudflare** (free plan) and **Resend** (free plan; check its current daily/monthly limits).

## Switch-on steps

Run in `worker/` with Node 22+.

```sh
npm ci
npx wrangler login                                   # opens the browser, Cloudflare account

# 1. Database (choose a European location)
npx wrangler d1 create landlord-reminders --location weur
#    -> copy the printed database_id into wrangler.toml ([[d1_databases]] database_id)
npx wrangler d1 migrations apply landlord-reminders --remote

# 2. Config in wrangler.toml [vars]: keep REMINDERS_LIVE = "false" for now
#    PUBLIC_URL  = the Worker URL (https://landlord-reminders.<your-subdomain>.workers.dev, or a custom route)
#    FROM_EMAIL  = "Landlord Register Reminders <reminders@YOUR-VERIFIED-DOMAIN>"
#    REPLY_TO    = the contact email
#    ALLOWED_ORIGIN / SITE_URL = the site (change both if the site moves to its own domain)

# 3. Secret (Resend API key with "Sending access" only, limited to your domain)
npx wrangler secret put RESEND_API_KEY

# 4. Deploy with the kill switch still on and check it
npx wrangler deploy
curl -i -X POST "$PUBLIC_URL/subscribe" -H "Origin: https://aleborini.github.io" -H "Content-Type: application/json" -d '{}'
#    -> 503 not_live

# 5. Go live on the Worker
#    set REMINDERS_LIVE = "true" in wrangler.toml, then
npx wrangler deploy
```

6. **Turn the form on in the site build** (generator lives in the private workspace, not in this repo):

   ```sh
   REMINDERS_ENABLED=1 \
   REMINDERS_ENDPOINT=https://landlord-reminders.<your-subdomain>.workers.dev \
   REMINDERS_COMPONENT_DIR=/path/to/repo/worker/frontend \
   REMINDERS_PRIVACY_FILE=/path/to/privacy-reminders.approved.html \
   python3 build/gen_pages.py
   ```

   This adds the form to the home page and the 9 region pages (region pre-selected), ships `reminders.js`,
   adds the form CSS, changes the footer line, adds the approved section to the privacy page, and adds
   **only** `<endpoint>/subscribe` to each of those pages' CSP `connect-src` (hashes are recomputed).
   The tracker, about and 404 pages are unchanged. Copy the output into the repo on a feature branch and open a PR.

7. **Test with your own email**: sign up, confirm, check the unsubscribe link works and that the row is gone:
   `npx wrangler d1 execute landlord-reminders --remote --command "SELECT COUNT(*) FROM subscribers"`.
   To test the cron: `npx wrangler dev --test-scheduled`, then open `/cdn-cgi/handler/scheduled?time=<ms>`.

**Turn it off again**: set `REMINDERS_LIVE = "false"` and `npx wrangler deploy`, and rebuild the site without
`REMINDERS_ENABLED`. To delete all data: `npx wrangler d1 execute landlord-reminders --remote --command "DELETE FROM sends; DELETE FROM subscribers;"`.

## Tests

```sh
npm ci && npm test        # vitest + @cloudflare/vitest-plugin: real workerd runtime, local D1, mocked Resend
```

Covers validation, honeypot, rate limits, CORS, the kill switch, subscribe → confirm → reminders → unsubscribe,
no duplicate sends (repeated, concurrent and retried runs), the 7-day expiry, post-deadline deletion, the per-run cap,
and each region's schedule against the fact-check table. A GitHub Actions workflow is ready in `ci/worker-tests.yml`; to enable it, move it to `.github/workflows/worker-tests.yml`
(pushing workflow files needs the token's **Workflows: Read and write** permission, or add it in the GitHub web UI).

## Notes

- **Dates**: if the government changes a date, update `fact-check.md` (with its source) first, then
  `src/regions.js`, `test/schedule.spec.js` and the site generator together.
- **Link scanners**: some corporate mail filters open links in emails. As specified, `GET /confirm` confirms and
  `GET /unsubscribe` deletes in one click. If scanners start confirming or unsubscribing people, change both to a
  page with a button that POSTs.
- This folder is in the GitHub Pages repo, so its files can be fetched as plain files at `/GrokLandlord/worker/...`.
  They are not linked from the site and contain no secrets.
