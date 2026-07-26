# InboxJanitor — Plan

Goal: hold the Gmail inbox at a low, manageable number without hand-sorting 3000+ messages,
and without an AI in the hot path for mail we already know is noise.

Status: Phase 0 complete. Phase 1 blocked on Gmail OAuth consent (see "Blocking human steps").

---

## 1. Architecture

Two parts, one system, joined by a shared rule ledger:

```
        inbox-rules.yaml  ← single source of truth, human-approved, in git
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
| Rule ledger | `inbox-rules.yaml` in git, editable from the dashboard | Versioned and diffable — every rule change has a commit and an author |

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
- **D — REVIEW**: ambiguous → handed to Part 2.

### 1B. Review artifact
Sorted by volume descending; the top ~100 senders should cover ~80% of the backlog. Rendered with
evidence and sample subjects, accept/reject per sender. Target review time: ~30 minutes.

### 1C. Compiler
`inbox-rules.yaml` → Gmail filters via `users.settings.filters`. Idempotent (list → diff → apply).
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
2. **OAuth publishing status.** If the client is in "Testing", refresh tokens expire every 7 days and
   both automations rot silently. Must be confirmed in the console.
3. **`gmail.metadata` scope cannot use search queries** (`q` is rejected on `messages.list`).
   The scanner therefore needs `gmail.readonly`.
4. **Cross-automation seam.** A delete filter catching a mega-newsletter source would silently break
   the digest with no error surfaced anywhere. The compiler must refuse to emit any delete rule that
   overlaps the live `_rules.md` include list.
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
- ⚠️ Publishing status **unknown** — needs one look at the console.

### Blocking human steps

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

| Phase | Work | Est. | Mutates Gmail? |
|---|---|---|---|
| 0 | Verify OAuth status + scopes, read-only smoke test | 0.5h | no |
| 1 | Scanner + SQLite + sender report | 2–3h | no |
| 2 | Review report → rule ledger → compiler → quarantine filters | 2h | filters only |
| 3 | Backlog sweep: dry-run → apply | 1h | **yes, to Trash** |
| 4 | Unsubscribe worklist | 1h | no |
| 5 | Codex janitor automation + memory.md | 2h | **yes, to Trash** |
| 6 | Dashboard Inbox view + rule approval queue | 2–3h | no |
