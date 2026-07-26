/**
 * Builds the review artifact from the scan. Read-only against SQLite; writes two files:
 *   out/report.html            — volume-sorted review page, ~top senders first
 *   out/inbox-rules.draft.yaml — proposed rule ledger, nothing applied until you approve it
 *
 * Run: npm run report
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../scan/db.ts';
import { classify, readRate, type SenderStats, type Tier, type Verdict } from './classify.ts';
import { CATEGORIES, categorize, type Category } from '../rules/categories.ts';

const OUT_DIR = fileURLToPath(new URL('../../out/', import.meta.url));
const DAY = 86_400_000;

interface SenderRow {
  from_email: string;
  from_domain: string;
  display_name: string | null;
  total: number;
  in_inbox: number;
  unread: number;
  starred: number;
  important: number;
  last90: number;
  last_received: number;
  bulk: number;
  has_unsub: number;
  one_click: number;
  contacted: number;
}

const TIER_LABEL: Record<Tier, string> = {
  E_NEVER_TOUCH: 'Never touch',
  A_AUTO_TRASH: 'Auto-trash',
  B_UNSUBSCRIBE: 'Unsubscribe, then trash',
  C_ARCHIVE: 'Archive, not delete',
  D_REVIEW: 'Needs your call',
  L_LOW_VOLUME: 'Long tail — ignore',
};

const TIER_ORDER: Tier[] = [
  'A_AUTO_TRASH',
  'B_UNSUBSCRIBE',
  'C_ARCHIVE',
  'D_REVIEW',
  'E_NEVER_TOUCH',
  'L_LOW_VOLUME',
];

/** Inbox messages older than this are archived regardless of sender. Nothing is deleted. */
const ARCHIVE_AFTER_DAYS = 180;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function loadSenders(): Array<SenderStats & { verdict: Verdict }> {
  const db = openDb();
  const cutoff90 = Date.now() - 90 * DAY;

  const rows = db
    .prepare(
      `SELECT
         m.from_email,
         m.from_domain,
         MAX(m.from_name)                                   AS display_name,
         COUNT(*)                                           AS total,
         SUM(m.in_inbox)                                    AS in_inbox,
         SUM(m.unread)                                      AS unread,
         SUM(m.starred)                                     AS starred,
         SUM(m.important)                                   AS important,
         SUM(CASE WHEN m.internal_date >= ? THEN 1 ELSE 0 END) AS last90,
         MAX(m.internal_date)                               AS last_received,
         MAX(CASE WHEN m.list_unsubscribe IS NOT NULL THEN 1 ELSE 0 END)      AS bulk,
         MAX(CASE WHEN m.list_unsubscribe IS NOT NULL THEN 1 ELSE 0 END)      AS has_unsub,
         MAX(CASE WHEN m.list_unsubscribe_post IS NOT NULL THEN 1 ELSE 0 END) AS one_click,
         MAX(CASE WHEN c.email IS NOT NULL THEN 1 ELSE 0 END)                 AS contacted
       FROM messages m
       LEFT JOIN contacted c ON c.email = m.from_email
       GROUP BY m.from_email
       ORDER BY total DESC`,
    )
    .all(cutoff90) as SenderRow[];

  const subjectStatement = db.prepare(
    'SELECT subject FROM messages WHERE from_email = ? AND subject IS NOT NULL ORDER BY internal_date DESC LIMIT 5',
  );

  const senders = rows.map((row) => {
    const sampleSubjects = (subjectStatement.all(row.from_email) as Array<{ subject: string }>).map(
      (r) => r.subject,
    );
    const stats: SenderStats = {
      email: row.from_email,
      domain: row.from_domain,
      displayName: row.display_name,
      total: row.total,
      inInbox: row.in_inbox,
      unread: row.unread,
      starred: row.starred,
      important: row.important,
      last90: row.last90,
      lastReceived: row.last_received,
      bulk: row.bulk === 1,
      hasUnsubLink: row.has_unsub === 1,
      oneClickUnsub: row.one_click === 1,
      contacted: row.contacted === 1,
      sampleSubjects,
    };
    return { ...stats, verdict: classify(stats) };
  });

  db.close();
  return senders;
}

function categoryRows(senders: ReadonlyArray<SenderStats & { verdict: Verdict }>): string {
  const tally = new Map<Category, { senders: number; inbox: number }>();
  let uncategorized = { senders: 0, inbox: 0 };

  for (const sender of senders) {
    const category = categorize(sender.email, sender.domain);
    if (category === null) {
      uncategorized = { senders: uncategorized.senders + 1, inbox: uncategorized.inbox + sender.inInbox };
      continue;
    }
    const bucket = tally.get(category) ?? { senders: 0, inbox: 0 };
    bucket.senders += 1;
    bucket.inbox += sender.inInbox;
    tally.set(category, bucket);
  }

  const rows = (Object.keys(CATEGORIES) as Category[])
    .map((category) => {
      const bucket = tally.get(category) ?? { senders: 0, inbox: 0 };
      const spec = CATEGORIES[category];
      return `<tr><td><code>${spec.label}</code></td><td>${spec.skipInbox ? 'yes' : 'no — stays visible'}</td><td class="n">${bucket.senders}</td><td class="n">${bucket.inbox}</td></tr>`;
    })
    .join('');

  return `${rows}<tr><td class="muted">uncategorized</td><td class="muted">n/a</td><td class="n">${uncategorized.senders}</td><td class="n">${uncategorized.inbox}</td></tr>`;
}

function renderHtml(senders: ReadonlyArray<SenderStats & { verdict: Verdict }>): string {
  const totals = new Map<Tier, { senders: number; messages: number; inbox: number }>();
  for (const sender of senders) {
    const bucket = totals.get(sender.verdict.tier) ?? { senders: 0, messages: 0, inbox: 0 };
    bucket.senders += 1;
    bucket.messages += sender.total;
    bucket.inbox += sender.inInbox;
    totals.set(sender.verdict.tier, bucket);
  }

  const summary = TIER_ORDER.map((tier) => {
    const bucket = totals.get(tier) ?? { senders: 0, messages: 0, inbox: 0 };
    return `<tr><td>${TIER_LABEL[tier]}</td><td class="n">${bucket.senders}</td><td class="n">${bucket.messages}</td><td class="n">${bucket.inbox}</td></tr>`;
  }).join('');

  const sections = TIER_ORDER.map((tier) => {
    const group = senders.filter((s) => s.verdict.tier === tier);
    if (group.length === 0) return '';
    const rows = group
      .map((s) => {
        const subjects = s.sampleSubjects.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
        const category = categorize(s.email, s.domain);
        const label = category === null ? '<span class="muted">—</span>' : escapeHtml(CATEGORIES[category].label);
        return `<tr>
          <td><strong>${escapeHtml(s.displayName ?? s.email)}</strong><br><code>${escapeHtml(s.email)}</code></td>
          <td>${label}</td>
          <td class="n">${s.total}</td>
          <td class="n">${s.inInbox}</td>
          <td class="n">${Math.round(readRate(s) * 100)}%</td>
          <td class="n">${s.last90}</td>
          <td>${escapeHtml(s.verdict.reasons.join('; '))}</td>
          <td><ul class="subj">${subjects}</ul></td>
        </tr>`;
      })
      .join('');
    return `<h2>${TIER_LABEL[tier]} <span class="count">${group.length} senders</span></h2>
      <table><thead><tr><th>Sender</th><th>Label</th><th>Msgs</th><th>Inbox</th><th>Read</th><th>90d</th><th>Why</th><th>Recent subjects</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>InboxJanitor — sender review</title><style>
    :root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --line:#d8dce3; --muted:#666e7a; --panel:#f6f7f9; }
    @media (prefers-color-scheme: dark) { :root { --bg:#14171c; --fg:#e6e8ec; --line:#2c313a; --muted:#98a0ad; --panel:#1b1f26; } }
    body { background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; margin:0 auto; padding:2rem; max-width:1200px; }
    h1 { font-size:1.5rem; } h2 { font-size:1.1rem; margin-top:2.5rem; }
    .count { color:var(--muted); font-weight:400; font-size:.85rem; }
    table { border-collapse:collapse; width:100%; display:block; overflow-x:auto; }
    th,td { border-bottom:1px solid var(--line); padding:.5rem .6rem; text-align:left; vertical-align:top; }
    th { background:var(--panel); position:sticky; top:0; font-weight:600; }
    td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
    code { font-size:.85em; color:var(--muted); }
    ul.subj { margin:0; padding-left:1rem; color:var(--muted); font-size:.85em; }
    p.note { color:var(--muted); }
    .muted { color:var(--muted); }
  </style></head><body>
    <h1>InboxJanitor — sender review</h1>
    <p class="note">Generated ${new Date().toISOString()}. Nothing has been changed in Gmail. Work top-down: the
    highest-volume senders in each tier account for most of the backlog.</p>
    <table><thead><tr><th>Tier</th><th class="n">Senders</th><th class="n">Messages</th><th class="n">In inbox</th></tr></thead><tbody>${summary}</tbody></table>
    <h2>Labels <span class="count">machine-managed namespace only</span></h2>
    <p class="note">Your hand-made labels (Receipts, Land, Boat, Taxes, …) are never created, renamed, or
    deleted by this tool. "Skips inbox" means the mail is filed on arrival instead of landing in front of
    you; urgent-looking subjects stay visible regardless of category.</p>
    <table><thead><tr><th>Label</th><th>Skips inbox</th><th class="n">Senders</th><th class="n">In inbox</th></tr></thead><tbody>${categoryRows(senders)}</tbody></table>
    ${sections}
  </body></html>`;
}

function renderRulesDraft(senders: ReadonlyArray<SenderStats & { verdict: Verdict }>): string {
  const list = (tier: Tier): string => {
    const group = senders.filter((s) => s.verdict.tier === tier);
    if (group.length === 0) return '    []\n';
    return group
      .map((s) => `    - sender: ${s.email}\n      # ${s.total} msgs, ${Math.round(readRate(s) * 100)}% read — ${s.verdict.reasons.join('; ')}`)
      .join('\n')
      .concat('\n');
  };

  return `# InboxJanitor rule ledger — DRAFT, nothing is applied from this file.
# Review, delete what you disagree with, then save as inbox-rules.yaml.
#
# Filters compile in quarantine mode first: matched mail skips the inbox and lands under
# Janitor/Quarantine instead of Trash. Flip \`mode\` to "trash" only after a quarantine review.

version: 1
mode: quarantine

# Inbox messages older than this are archived regardless of sender: out of the inbox, still
# searchable, nothing deleted. Starred messages are always exempt. This is the single biggest lever
# on the inbox count -- sender rules alone leave roughly 2,400 messages in place.
archive_after_days: ${ARCHIVE_AFTER_DAYS}

# Never applies to a starred message, at any tier. Stars are respected per message, not per sender.
protect_starred: true

# Machine-managed labels. Only these two namespaces are ever created, renamed, or deleted -- your
# hand-made labels (Receipts, Land, Boat, 2024 Taxes, ...) are structurally out of reach.
# skip_inbox: mail is filed on arrival. An urgent-looking subject overrides it and stays visible.
labels:
${(Object.keys(CATEGORIES) as Category[])
  .map((c) => `  - name: ${CATEGORIES[c].label}\n    skip_inbox: ${CATEGORIES[c].skipInbox}`)
  .join('\n')}
  - name: Janitor/Quarantine
    skip_inbox: true
  - name: Janitor/Unsubscribe
    skip_inbox: false

# Stale labels from the retired MegaNewsletter labelling scheme, safe to delete.
delete_labels:
  - MegaNewsletter/NeedsReview/2026-04-28
  - MegaNewsletter/NeedsReview/2026-04-29
  - MegaNewsletter/Error/2026-04-29
  - MegaNewsletter/Digested/2026-04-29

# Evaluated before every other rule. Nothing here is ever filtered.
never_touch:
${list('E_NEVER_TOUCH')}
# Skip the inbox, keep the mail — searchable history, zero inbox cost.
archive:
${list('C_ARCHIVE')}
# Bulk mail you do not read, with no usable unsubscribe.
auto_trash:
${list('A_AUTO_TRASH')}
# Same, but unsubscribe first so the sending stops at the source.
unsubscribe_then_trash:
${list('B_UNSUBSCRIBE')}
# Not decidable from metadata alone. Left for the Part 2 janitor or a manual call.
review:
${list('D_REVIEW')}
# Fewer than 3 messages ever. No rule is worth writing; listed only for completeness.
low_volume:
${list('L_LOW_VOLUME')}`;
}

function main(): void {
  const senders = loadSenders();
  if (senders.length === 0) {
    console.error('No scanned messages found. Run `npm run scan` first.');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}report.html`, renderHtml(senders), 'utf8');
  writeFileSync(`${OUT_DIR}inbox-rules.draft.yaml`, renderRulesDraft(senders), 'utf8');

  const counts = TIER_ORDER.map((tier) => {
    const group = senders.filter((s) => s.verdict.tier === tier);
    const messages = group.reduce((sum, s) => sum + s.inInbox, 0);
    return `  ${TIER_LABEL[tier].padEnd(24)} ${String(group.length).padStart(4)} senders  ${String(messages).padStart(5)} inbox msgs`;
  }).join('\n');

  console.log(`${senders.length} distinct senders\n\n${counts}\n`);
  console.log(`Wrote ${OUT_DIR}report.html`);
  console.log(`Wrote ${OUT_DIR}inbox-rules.draft.yaml`);
}

main();
