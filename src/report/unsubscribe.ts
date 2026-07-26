/**
 * Builds the manual unsubscribe worklist from senders judged noise.
 *
 * Filters stop the mail reaching you; unsubscribing stops it being sent at all. Only the second one
 * ends the relationship, which is why this is worth twenty minutes.
 *
 * Run: npm run unsubscribe
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../scan/db.ts';
import { loadSenderPlans } from '../apply/senders.ts';

const OUT = fileURLToPath(new URL('../../out/', import.meta.url));

interface Link {
  http: string | null;
  mailto: string | null;
  oneClick: boolean;
}

/** RFC 2369 packs one or more <URI> values into the header. */
function parseUnsubscribe(header: string | null, post: string | null): Link {
  if (header === null) return { http: null, mailto: null, oneClick: false };
  const uris = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1] ?? '');
  return {
    http: uris.find((u) => u.startsWith('http')) ?? null,
    mailto: uris.find((u) => u.startsWith('mailto:')) ?? null,
    oneClick: post !== null && /one-?click/i.test(post),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function main(): void {
  const noise = new Set(loadSenderPlans().filter((p) => p.intent === 'trash').map((p) => p.sender.email));

  const db = openDb();
  const rows = db
    .prepare(
      `SELECT from_email, MAX(from_name) AS name, COUNT(*) AS n,
              MAX(list_unsubscribe) AS unsub, MAX(list_unsubscribe_post) AS post
       FROM messages GROUP BY from_email ORDER BY n DESC`,
    )
    .all() as Array<{ from_email: string; name: string | null; n: number; unsub: string | null; post: string | null }>;
  db.close();

  const targets = rows
    .filter((row) => noise.has(row.from_email))
    .map((row) => ({ ...row, link: parseUnsubscribe(row.unsub, row.post) }));

  const withLink = targets.filter((t) => t.link.http !== null || t.link.mailto !== null);
  const withoutLink = targets.filter((t) => t.link.http === null && t.link.mailto === null);

  const row = (t: (typeof targets)[number]): string => {
    const action =
      t.link.http !== null
        ? `<a href="${escapeHtml(t.link.http)}" target="_blank" rel="noopener noreferrer">unsubscribe</a>`
        : t.link.mailto !== null
          ? `<a href="${escapeHtml(t.link.mailto)}">email to unsubscribe</a>`
          : '<span class="muted">no link — block instead</span>';
    return `<tr><td><input type="checkbox"></td><td><strong>${escapeHtml(t.name ?? t.from_email)}</strong><br><code>${escapeHtml(t.from_email)}</code></td><td class="n">${t.n}</td><td>${t.link.oneClick ? 'one-click' : t.link.http !== null ? 'web form' : t.link.mailto !== null ? 'email' : '—'}</td><td>${action}</td></tr>`;
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>InboxJanitor — unsubscribe worklist</title><style>
    :root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --line:#d8dce3; --muted:#666e7a; --panel:#f6f7f9; }
    @media (prefers-color-scheme: dark) { :root { --bg:#14171c; --fg:#e6e8ec; --line:#2c313a; --muted:#98a0ad; --panel:#1b1f26; } }
    body { background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; margin:0 auto; padding:2rem; max-width:900px; }
    table { border-collapse:collapse; width:100%; } th,td { border-bottom:1px solid var(--line); padding:.5rem .6rem; text-align:left; }
    th { background:var(--panel); position:sticky; top:0; } td.n,th.n { text-align:right; font-variant-numeric:tabular-nums; }
    code { font-size:.85em; color:var(--muted); } .muted { color:var(--muted); }
    p.warn { background:var(--panel); border-left:3px solid #c96; padding:.75rem 1rem; }
  </style></head><body>
    <h1>Unsubscribe worklist</h1>
    <p class="muted">${targets.length} senders already filtered and trashed. Filters stop the mail reaching you;
    unsubscribing stops it being sent. Work top-down — the list is volume-sorted.</p>
    <p class="warn"><strong>Do not unsubscribe from mail you never signed up for.</strong> For genuine spam, clicking
    confirms your address is live and read. Use Gmail's "Report spam" on those instead — the ${withoutLink.length}
    senders in the second table have no unsubscribe link, which is itself a signal.</p>
    <h2>Has an unsubscribe link <span class="muted">${withLink.length}</span></h2>
    <table><thead><tr><th></th><th>Sender</th><th class="n">Msgs</th><th>Type</th><th>Action</th></tr></thead>
    <tbody>${withLink.map(row).join('')}</tbody></table>
    <h2>No unsubscribe link <span class="muted">${withoutLink.length}</span></h2>
    <p class="muted">Report as spam or block. The filters already handle them.</p>
    <table><thead><tr><th></th><th>Sender</th><th class="n">Msgs</th><th>Type</th><th>Action</th></tr></thead>
    <tbody>${withoutLink.map(row).join('')}</tbody></table>
  </body></html>`;

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}unsubscribe.html`, html, 'utf8');

  console.log(`${targets.length} senders to unsubscribe from`);
  console.log(`  ${withLink.filter((t) => t.link.oneClick).length} one-click`);
  console.log(`  ${withLink.filter((t) => !t.link.oneClick).length} web form or email`);
  console.log(`  ${withoutLink.length} no link — report as spam instead`);
  console.log(`\nWrote ${OUT}unsubscribe.html`);
}

main();
