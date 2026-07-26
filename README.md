# InboxJanitor

Keeps the Gmail inbox at a low number without hand-sorting thousands of messages, and without an AI
in the hot path for mail already known to be noise.

Two parts, one system, joined by a shared rule ledger. Full design and risk analysis: [PLAN.md](PLAN.md).

| Part | What it does | Runtime |
|---|---|---|
| 1 — deterministic | Cold-scans mail metadata, tiers senders, compiles Gmail filters | this repo |
| 2 — AI janitor | Daily triage of what survives the filters, proposes new rules | Codex cron ([prompt](docs/part2-codex-automation.md)) |

The AI's job is to make itself less necessary: senders it trashes twice become proposed
deterministic rules, and once approved a free Gmail filter handles them forever.

## Safety model

- **Permanent deletion is impossible at the API level.** `https://mail.google.com/` — the only scope
  that permits `messages.batchDelete` — is never requested, and every token exchange re-asserts
  this. Everything bottoms out in Trash, which Gmail retains for 30 days. See `src/auth/scopes.ts`.
- **Allowlist first.** Anyone you have replied to, starred threads, financial/government/medical/
  legal senders, security mail, and every mega-newsletter source are checked before any rule can
  propose a deletion.
- **Quarantine ramp.** New filters route to `Janitor/Quarantine`, not Trash. They only flip to Trash
  after you review what landed there.
- **Nothing applies without approval.** The scan writes a *draft* ledger; it is inert until you
  rename it to `inbox-rules.yaml`.

## Setup

Gmail access needs its own Google Cloud project — full walkthrough in
[docs/oauth-setup.md](docs/oauth-setup.md). Short version: new GCP project, enable the Gmail API,
consent screen set to External and **published** (Testing-mode refresh tokens expire after 7 days),
scopes `gmail.readonly` + `gmail.settings.basic`, then a **Desktop app** OAuth client.

```sh
npm install
cp .env.example .env      # fill in GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET
npm run auth              # opens consent, writes GMAIL_REFRESH_TOKEN
```

## Use

```sh
npm run scan      # read-only; header metadata → data/inbox.db
npm run report    # → out/report.html and out/inbox-rules.draft.yaml
npm test          # classifier and header-parsing checks
npm run typecheck
```

Review `out/report.html` top-down — the highest-volume senders in each tier account for most of the
backlog. Prune what you disagree with in the draft ledger, then save it as `inbox-rules.yaml`.

## Status

**Live since 2026-07-26.** Inbox 4,228 -> 528: 11 labels created, 22 filters covering 322 senders,
4,027 messages swept (726 to Trash). Verified against live Gmail — 103 starred messages still in the
inbox, zero starred or `Filed/*` mail in Trash.

Filters run in **quarantine mode**: noise is labelled `Janitor/Quarantine` and skips the inbox
rather than being trashed, pending a ~7-day review. Part 2 (the Codex janitor) is configured and
paused. See [PLAN.md](PLAN.md) for what is outstanding.

## How a decision gets made

`src/rules/disposition.ts` is the single place that decides what happens to a message — the report,
the filter compiler and the backlog sweep all call it, so they cannot disagree. Precedence, most to
least authoritative:

1. Starred — a per-message instruction from you, nothing outranks it
2. A per-sender rule in `src/rules/overrides.ts` (reviewed by hand; beats even the safety allowlist)
3. Tier from `src/report/classify.ts` (noise / transactional / protected / undecided)
4. Category filing from `src/rules/categories.ts`, unless the subject looks urgent
5. Age — anything older than 180 days leaves the inbox
