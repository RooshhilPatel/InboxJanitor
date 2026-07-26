# OAuth setup — one-time manual steps

Gmail access needs its own Google Cloud project. This walks through it end to end.

## Why a separate GCP project

The original plan reused the MegaNewsletterDashboard project (number `324515671302`) with a new
client. That is the wrong trade. If that project's consent screen is *verified* for its Drive
scopes, adding restricted Gmail scopes can push the whole app back into review — putting a working
daily newsletter automation at risk for no benefit. A separate project costs about four extra
minutes and touches nothing that currently works.

---

## Step 1 · Confirm the newsletter project is healthy (read-only)

Open <https://console.cloud.google.com/auth/audience?project=324515671302> and check
**Publishing status**.

Expected: **In production**. Evidence for this as of 2026-07-26 — the dashboard `.env` was last
modified 2026-07-18 and its refresh token still exchanged successfully on 2026-07-26. Testing-mode
refresh tokens expire after 7 days, so surviving 8 days means the app is published.

If it says *Testing*, the Drive token is on a 7-day fuse and needs its own fix. Change nothing here
either way; this step only confirms.

## Step 2 · Create a new project

1. <https://console.cloud.google.com/projectcreate>
2. Project name: `InboxJanitor`
3. **Create**, then select it in the top-left project picker.

Every step below happens inside this project. Confirm the picker before each one.

## Step 3 · Enable the Gmail API

1. <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
2. Confirm the picker shows `InboxJanitor`.
3. **Enable**.

## Step 4 · Configure the consent screen

1. **APIs & Services → OAuth consent screen** (lands in *Google Auth Platform*).
2. **Get started**.
3. App name `InboxJanitor`, user support email = your Gmail → **Next**.
4. Audience: **External**. Internal requires Google Workspace; a personal Gmail account cannot use
   it → **Next**.
5. Contact email → **Next**, agree to the policy → **Create**.

## Step 5 · Add the Gmail scopes

1. **Data Access → Add or remove scopes**.
2. Filter for `gmail` and select exactly:
   - `.../auth/gmail.readonly` (Restricted)
   - `.../auth/gmail.settings.basic` (Sensitive)
3. **Update → Save**.

Never add `https://mail.google.com/`. It is the only scope permitting permanent deletion, and
`src/auth/scopes.ts` throws if it is ever present on the grant.

`gmail.modify` is added later, when Phase 3 begins moving mail to Trash.

## Step 6 · Publish the app

**Audience → Publish app → Confirm.**

What this accepts: the app stays unverified, so consent shows a "Google hasn't verified this app"
warning, and it is capped at 100 users. Both are fine for a personal tool.

What it avoids: Testing-mode refresh tokens expire after 7 days, which would silently break the
scanner every week.

## Step 7 · Create the OAuth client

1. **Clients → + Create client**.
2. Application type: **Desktop app**. A *Web application* client rejects the loopback redirect.
3. Name `InboxJanitor` → **Create**.
4. Copy the client ID and client secret.

No redirect URI configuration is needed — Desktop clients accept `127.0.0.1` loopback automatically.

## Step 8 · Authorize locally

```sh
cd ~/Documents/Development/InboxJanitor
cp .env.example .env
# paste GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET; leave GMAIL_REFRESH_TOKEN blank
npm run auth
```

Open the printed URL, then:

1. Choose your Gmail account.
2. At "Google hasn't verified this app": **Advanced → Go to InboxJanitor (unsafe)**. Expected — it
   is your own freshly created app.
3. Review the two Gmail permissions → **Continue**.
4. The browser confirms authorization; the terminal writes the refresh token to `.env`.

## Step 9 · Scan

```sh
npm run scan     # read-only, 10–25 min depending on archive size
npm run report
open out/report.html
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `invalid_grant` | App is back in Testing, or the grant was revoked. Recheck Step 6, then `npm run auth`. |
| "Access blocked: this app's request is invalid" | Client is a *Web application*. Delete it and redo Step 7 as *Desktop app*. |
| `403 insufficientPermissions` during scan | Scopes did not take. Revoke at <https://myaccount.google.com/permissions>, then `npm run auth`. |
| "Google returned no refresh token" | Google omits it when consent already exists. Revoke at the link above and re-run. |
| Scan seems slow | Deliberate. `SCAN_CONCURRENCY=20` leaves headroom so this never rate-limits the newsletter automation. Past ~45 Gmail starts throttling. |
