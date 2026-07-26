/**
 * Cold scan — Phase 1. Reads Gmail header metadata into SQLite. Mutates nothing:
 * the only Gmail scopes in play are read and settings, and this file issues GETs only.
 *
 * Run: npm run scan
 */
import 'dotenv/config';
import {
  getMessageMetadata,
  getProfile,
  listMessageIds,
  mapWithConcurrency,
  type GmailMessage,
} from './gmail.ts';
import { openDb, recordContacted, setMeta, upsertMessages, type MessageRow } from './db.ts';
import { parseAddress, parseAddressList } from './headers.ts';

const CATEGORY_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];

function header(message: GmailMessage, name: string): string | null {
  const match = message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function toRow(message: GmailMessage): MessageRow | null {
  const from = header(message, 'From');
  const parsed = from === null ? null : parseAddress(from);
  if (parsed === null) return null;

  const labels = message.labelIds ?? [];
  const domain = parsed.email.split('@')[1] ?? '';

  return {
    id: message.id,
    thread_id: message.threadId,
    from_email: parsed.email,
    from_name: parsed.name,
    from_domain: domain,
    subject: header(message, 'Subject'),
    internal_date: Number(message.internalDate ?? '0'),
    labels: labels.join(','),
    in_inbox: labels.includes('INBOX') ? 1 : 0,
    unread: labels.includes('UNREAD') ? 1 : 0,
    starred: labels.includes('STARRED') ? 1 : 0,
    important: labels.includes('IMPORTANT') ? 1 : 0,
    category: labels.find((l) => CATEGORY_LABELS.includes(l)) ?? null,
    list_unsubscribe: header(message, 'List-Unsubscribe'),
    list_unsubscribe_post: header(message, 'List-Unsubscribe-Post'),
    list_id: header(message, 'List-Id'),
  };
}

async function collectIds(query: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of listMessageIds(query)) ids.push(...page);
  return ids;
}

function progressBar(label: string) {
  let last = 0;
  return (done: number, total: number): void => {
    const pct = Math.floor((done / total) * 100);
    if (pct === last && done !== total) return;
    last = pct;
    process.stdout.write(`\r  ${label}: ${done}/${total} (${pct}%)   `);
    if (done === total) process.stdout.write('\n');
  };
}

async function main(): Promise<void> {
  const concurrency = Number(process.env.SCAN_CONCURRENCY ?? '20');
  const window = process.env.SCAN_WINDOW ?? '3y';
  const db = openDb();

  const profile = await getProfile();
  console.log(`Account: ${profile.emailAddress} (${profile.messagesTotal} messages total)\n`);

  // Pass 1 — who have I written to? This is what protects real correspondents from every
  // downstream rule, so it runs first and is never derived from the inbox itself.
  console.log('Pass 1: sent mail (building the contacted allowlist)');
  const sentIds = await collectIds('in:sent');
  console.log(`  ${sentIds.length} sent messages`);

  const contacted = new Map<string, { count: number; lastSent: number }>();
  await mapWithConcurrency(
    sentIds,
    concurrency,
    async (id) => {
      const message = await getMessageMetadata(id);
      const sentAt = Number(message.internalDate ?? '0');
      const recipients = [
        ...parseAddressList(header(message, 'To')),
        ...parseAddressList(header(message, 'Cc')),
      ];
      for (const email of new Set(recipients)) {
        const existing = contacted.get(email);
        contacted.set(email, {
          count: (existing?.count ?? 0) + 1,
          lastSent: Math.max(existing?.lastSent ?? 0, sentAt),
        });
      }
    },
    progressBar('fetched'),
  );
  recordContacted(db, contacted);
  console.log(`  ${contacted.size} distinct addresses contacted\n`);

  // Pass 2 — the corpus to classify. The whole current inbox regardless of age, plus recent
  // history so per-sender engagement rates are computed over more than just what is still unread.
  console.log(`Pass 2: inbox + last ${window} of received mail`);
  const queries = [
    'in:inbox',
    `newer_than:${window} -in:sent -in:draft -in:chats -in:spam -in:trash`,
  ];

  const ids = new Set<string>();
  for (const query of queries) {
    const found = await collectIds(query);
    console.log(`  "${query}" → ${found.length}`);
    found.forEach((id) => ids.add(id));
  }

  const unique = [...ids];
  console.log(`  ${unique.length} unique messages to fetch`);

  const buffer: MessageRow[] = [];
  await mapWithConcurrency(
    unique,
    concurrency,
    async (id) => {
      const row = toRow(await getMessageMetadata(id));
      if (row !== null) buffer.push(row);
      if (buffer.length >= 500) upsertMessages(db, buffer.splice(0, buffer.length));
    },
    progressBar('fetched'),
  );
  if (buffer.length > 0) upsertMessages(db, buffer);

  setMeta(db, 'last_scan_at', new Date().toISOString());
  setMeta(db, 'scan_window', window);
  setMeta(db, 'account', profile.emailAddress);

  const stored = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  const inboxCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE in_inbox = 1').get() as { n: number };
  console.log(`\nStored ${stored.n} messages (${inboxCount.n} currently in the inbox).`);
  console.log('Next: npm run report');
  db.close();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
