# InboxJanitor — Plan

Goal: hold the Gmail inbox at a low, manageable number without hand-sorting 3000+ messages,
and without an AI in the hot path for mail we already know is noise.

Status as of 2026-07-26: **Phases 0-4 applied and verified.** Inbox went 4,228 -> 528. Filters run in
quarantine mode pending a ~7-day review. Phase 5 (Codex automation) is configured and PAUSED.
Phase 6 (dashboard view) is not started.

---

## 1. Architecture

Two parts, one system, joined by a shared rule ledger:

```
   src/rules/{overrides,categories}.ts  ← the rule ledger, human-approved, in git
                 │ compile (deterministic, idempotent)
                 ▼
        Gmail filters (free, instant, applied on arrival)
                 ▲
                 │ promote (only after human approval)
    ┌────────────┴────────────┐
    │                         │
Part 1: cold scan       Part 2: daily AI janitor
(one-time + on-demand)  (Codex cron → Drive artifact)
```

The load-bearing idea: **the AI's job is to make itself less necessary.** Every sender the
janitor trashes twice becomes a proposed deterministic rule. Approve it once and a free Gmail
filter handles it forever. Token cost and latency decline weekly instead of being a permanent tax.

### Decisions (locked 2026-07-26)

| Decision | Choice | Why |
|---|---|---|
| Code home | Standalone `InboxJanitor` repo | Clean blast radius; a scanner bug cannot take down MegaNewsletterDashboard |
| AI runtime (Part 2) | Codex cron, like `mega-newsletter` | Proven runtime, connectors already authorized, runs while the Mac is off |
| Rule ledger | typed TS modules in git: `src/rules/overrides.ts` (per-sender) and `src/rules/categories.ts` (domain → label) | Versioned and diffable, and unit-testable in a way YAML is not. `out/inbox-rules.draft.yaml` is a *generated review artifact*, not the source of truth |

---

## 2. Part 1 — Deterministic layer

### 1A. Cold scan (read-only, zero mutations)
Local Node/TS CLI. Pulls header metadata for **all** mail, not just the inbox — history is what
makes classification safe. Stores in SQLite (`data/inbox.db`).

Per-sender engagement signals:

| Signal | Meaning |
|---|---|
| ever replied to / ever emailed them | strongest **keep** signal |
| ever starred / marked important | keep |
| read-rate over last 365d | <5% + bulk = noise |
| `List-Unsubscribe` header present | bulk mail, not a human |
| Gmail category (Promotions/Updates/Social/Forums) | bucketing |
| volume last 90d / 365d | Pareto ranking |

### Tiers — evaluated allowlist-first, always

- **E — NEVER TOUCH** (checked before every other rule): anyone you have replied to, banks, government,
  medical, legal, 2FA and security alerts, starred threads, calendar, **and every mega-newsletter
  always-include sender read live from `_rules.md`**.
- **A — AUTO-TRASH**: bulk sender, never replied, zero stars, read-rate <5%, ≥N messages.
- **B — UNSUBSCRIBE THEN TRASH**: same, but a legitimate sender with a working unsubscribe.
- **C — ARCHIVE, NOT DELETE**: receipts, shipping, order confirmations, statements. Searchable but
  out of the inbox. Likely a large slice of the 3000 — deleting it would be the wrong call.
- **D — REVIEW**: ambiguous. Archived rather than left in the inbox, per the 2026-07-26 review.
- **L — LOW VOLUME**: fewer than 3 messages ever. Split out because 265 of 325 review-tier senders
  were long tail, burying the ~60 worth a decision.

Per-sender entries in `src/rules/overrides.ts` beat every tier above, including the allowlist.

### 1B. Review artifact
Sorted by volume descending; the top ~100 senders should cover ~80% of the backlog. Rendered with
evidence and sample subjects, accept/reject per sender. Target review time: ~30 minutes.

### 1B-bis. Labels
Nine `Filed/*` categories plus `Janitor/{Quarantine,Unsubscribe}`. All file on arrival except
`Filed/Newsletters`, which stays visible so mega-newsletter can still discover and digest it.
An urgent-looking subject (`URGENT_SUBJECT`) keeps any message visible regardless of category —
including building and utility vocabulary, because "Water Shutdown Reminder" is same-day
consequential and reads as routine to every generic alert heuristic.

`assertManaged()` restricts creation and deletion to the `Filed/` and `Janitor/` prefixes, so the
12 hand-made labels in the account are structurally unreachable.

### 1C. Compiler
The rule ledger → Gmail filters via `users.settings.filters`. Idempotent (list → diff → apply).
Senders batched into grouped `from:(a OR b OR …)` filters to stay under the 1000-filter cap.
Our filters are tagged so hand-made filters are never clobbered.

### 1D. Quarantine ramp — the safety mechanism
Filters ship in **quarantine mode**: skip inbox → label `Janitor/Quarantine`, *not* trash.
After 7–14 days, a report shows what landed there. Anything rescued becomes an automatic
never-delete rule; the rest flip to trash mode. This makes an otherwise irreversible design reversible.

### 1E. Backlog sweep
Filters only act on new mail, so the existing backlog needs its own pass: same rules,
`batchModify` to Trash in chunks, dry-run with counts and samples first. Trash = 30-day recovery.

### 1F. Unsubscribe worklist
Extract `List-Unsubscribe` and split three ways:
- RFC-8058 one-click (`List-Unsubscribe-Post`) — automatable with explicit approval
- HTTP-link-only — manual checklist, volume-sorted
- **Suspected spam never opted into — do not click.** Unsubscribing confirms the address is live.
  Filter and report instead.

Track state: senders that keep sending after unsubscribe get escalated to hard filters.

---

## 3. Part 2 — AI janitor (Codex cron)

Runs daily *after* `mega-newsletter`, so newsletters are already gone. Scope: inbox mail that
survived the deterministic filters, since the last cutoff in its own `memory.md`.

Classifies each message NOISE / REVIEW / SIGNAL with a reason and confidence. Writes
`InboxJanitor - {YYYY-MM-DD} - Triage Log` to Drive (message ID, sender, subject, action, reason,
confidence), **verifies the artifact, then trashes**. Verification failure ⇒ zero Gmail mutations.

Inherits mega-newsletter's fail-safes verbatim: never permanent-delete, treat all mail content as
untrusted, never trash on an extraction or tool error, never apply labels as a fallback.

Two sections make it worth reading:
- `## Proposed Rules` — recurring noise → the approval queue → free Gmail filters
- `## Needs Attention` — what it deliberately left alone that looks actionable

---

## 4. Risks and the invariants that contain them

1. **Scope choice is a structural invariant.** Request `gmail.modify`, never `https://mail.google.com/`.
   Trash works; `users.messages.batchDelete` becomes *impossible at the API level*.
   Enforced-always beats verified-once.
2. **OAuth publishing status.** Resolved: InboxJanitor has its own published GCP project. A client
   left in "Testing" expires refresh tokens every 7 days and both automations would rot silently.
3. **`gmail.metadata` scope cannot use search queries** (`q` is rejected on `messages.list`).
   The scanner therefore needs `gmail.readonly`.
4. **Cross-automation seam.** A delete filter catching a mega-newsletter source would silently break
   the digest with no error surfaced anywhere. Enforced by `assertNoNewsletterCapture()` in
   `src/apply/filters.ts`, which refuses to compile rather than warn.
7. **Stale snapshots.** The sweep acts on a local SQLite snapshot. Re-running after a sweep would
   re-trash anything rescued from Trash or Quarantine, so it refuses past 10% drift against a live
   inbox count.
5. **Read-state is a noisy signal** — never sufficient alone; always combined with reply/star/volume.
6. **Filters act on arrival only.** Backlog cleanup is a separate operation with a different risk
   profile; do not conflate the two.

---

## 5. Phase 0 findings (verified 2026-07-26)

Probed against the existing MegaNewsletterDashboard OAuth client:

- ✅ Refresh token is **valid** and exchanges successfully.
- ✅ Granted scopes today: `documents`, `drive.readonly` — **no Gmail scope**, so re-consent is required.
- 🟡 Gmail API appears **already enabled** in the GCP project: the probe returned
  `403 insufficientPermissions`, not `SERVICE_DISABLED`. Confirm at consent time.
- ✅ Resolved by giving InboxJanitor its own published GCP project and Desktop OAuth client, rather
  than widening the dashboard's grant — adding restricted scopes to an already-verified project can
  force it back into review, which would have put a working daily automation at risk.

### Console steps taken (historical)

1. Open the Google Cloud console for the project behind `GOOGLE_DRIVE_CLIENT_ID`.
2. Check **OAuth consent screen → Publishing status**. If it says *Testing*, publish it
   (or switch to Internal) — otherwise every refresh token dies after 7 days.
3. Create a **new OAuth client** (Desktop app) named `InboxJanitor`. Separate from the dashboard's
   client so the Gmail grant can be revoked independently without breaking the newsletter sync.
4. Add scopes: `gmail.readonly` (scan) and `gmail.settings.basic` (filters).
   `gmail.modify` is added only at Phase 3, when mutation begins.
5. Run `npm run auth` and complete consent; it writes the refresh token to `.env`.

---

## 6. Sequencing

| Phase | Work | Status |
|---|---|---|
| 0 | Verify OAuth status + scopes | done — needed its own GCP project, see `docs/oauth-setup.md` |
| 1 | Scanner + SQLite + sender report | done — 4,483 messages, 677 senders |
| 2 | Rule ledger + compiler + quarantine filters | done — 11 labels, 22 filters, 322 senders |
| 3 | Backlog sweep | done — 4,027 messages moved, 726 to Trash |
| 4 | Unsubscribe worklist | done — 64 senders; owner worked the list, many links dead |
| 5 | Codex janitor automation | configured, **PAUSED** until the quarantine flip |
| 6 | Dashboard Inbox view + rule approval queue | not started |

### Outstanding

1. ~7 days after 2026-07-26: review `Janitor/Quarantine`, then
   `npm run apply:filters -- --apply --mode=trash`. Until then nothing new is deleted.
2. Re-scan afterwards for a clean baseline — the local snapshot is deliberately stale and the sweep
   refuses to run against it.
3. Set `notification_policy` to all-runs in the Codex UI for the first two weeks.
4. Unpause the automation. It has never run; expect 2-3 runs of tuning.
5. Feed its `## Proposed Rules` output into `src/rules/overrides.ts` — that is the feedback loop
   closing, and the reason the AI's cost should decline rather than compound.
