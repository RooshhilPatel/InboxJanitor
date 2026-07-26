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

```sh
npm install
cp .env.example .env      # fill in GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET
npm run auth              # opens consent, writes GMAIL_REFRESH_TOKEN
```

Google Cloud console, one time:

1. Confirm **OAuth consent screen → Publishing status** is not *Testing* — refresh tokens expire
   after 7 days there, which would silently break this and the newsletter sync.
2. Create a **Desktop app** OAuth client named `InboxJanitor`, separate from the
   MegaNewsletterDashboard client, so the Gmail grant can be revoked independently.
3. Scopes: `gmail.readonly` and `gmail.settings.basic`. `gmail.modify` is added only at Phase 3.

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

Phases 0 and 1 are built. Phases 2–6 (compiler, backlog sweep, unsubscribe worklist, Codex
automation, dashboard view) are specified in [PLAN.md](PLAN.md) but not yet implemented.
