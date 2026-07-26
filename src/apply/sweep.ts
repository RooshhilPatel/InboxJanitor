/**
 * One-time backlog sweep. Filters only act on arriving mail, so the existing inbox needs its own
 * pass. Uses the same dispositionFor() the filters were compiled from, so a message cannot be
 * filtered one way and swept another.
 *
 * Nothing is permanently deleted: trash means Gmail Trash, recoverable for 30 days. Archiving is
 * fully reversible — the mail keeps every other label and stays searchable.
 *
 * Run: npm run apply:sweep [-- --apply]
 */
import 'dotenv/config';
import { gmailFetch } from '../scan/gmail.ts';
import { openDb } from '../scan/db.ts';
import { ensureLabels } from './labels.ts';
import { dispositionFor } from '../rules/disposition.ts';
import { CATEGORIES } from '../rules/categories.ts';
import { loadSenderPlans } from './senders.ts';
import type { SenderStats } from '../report/classify.ts';

const ARCHIVE_AFTER_DAYS = 180;
/** Gmail's batchModify ceiling. */
const BATCH_SIZE = 1000;

interface Bucket {
  ids: string[];
  addLabelIds: string[];
  removeLabelIds: string[];
}

/**
 * The sweep acts on a local snapshot. Once it has run, that snapshot says "in the inbox" about mail
 * that is now filed or trashed — so a second run would re-trash anything rescued from Trash or
 * pulled back out of Quarantine, silently undoing a deliberate correction. Refuse rather than
 * explain it in a comment nobody reads at the wrong moment.
 */
async function assertSnapshotFresh(localInboxCount: number): Promise<void> {
  let live = 0;
  let pageToken: string | undefined;
  do {
    const page = await gmailFetch<{ messages?: unknown[]; nextPageToken?: string }>('/messages', {
      params: { q: 'in:inbox', maxResults: '500', ...(pageToken !== undefined ? { pageToken } : {}) },
    });
    live += (page.messages ?? []).length;
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);

  const drift = Math.abs(live - localInboxCount) / Math.max(localInboxCount, 1);
  console.log(`local snapshot: ${localInboxCount} inbox messages; live Gmail: ${live}`);
  if (drift > 0.1) {
    throw new Error(
      `Snapshot is stale (${Math.round(drift * 100)}% drift). Re-running would act on mail that has ` +
        `already moved and could re-trash anything you rescued. Run \`npm run scan\` first, or pass ` +
        `--force if you are certain.`,
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'APPLYING backlog sweep\n' : 'DRY RUN — pass --apply to move mail\n');

  const labelIds = await ensureLabels(apply);
  console.log('');

  const senders = new Map<string, SenderStats>(loadSenderPlans().map((p) => [p.sender.email, p.sender]));
  const db = openDb();
  const messages = db
    .prepare('SELECT id, from_email, subject, internal_date, starred, unread FROM messages WHERE in_inbox = 1')
    .all() as Array<{
    id: string;
    from_email: string;
    subject: string | null;
    internal_date: number;
    starred: number;
    unread: number;
  }>;
  db.close();

  const config = { archiveAfterDays: ARCHIVE_AFTER_DAYS, now: Date.now() };
  const buckets = new Map<string, Bucket>();
  const summary = new Map<string, number>();
  let untouched = 0;
  let unknown = 0;

  for (const message of messages) {
    const sender = senders.get(message.from_email);
    if (sender === undefined) {
      unknown += 1;
      continue;
    }

    const decision = dispositionFor(
      sender,
      {
        subject: message.subject,
        receivedAt: message.internal_date,
        unread: message.unread === 1,
        starred: message.starred === 1,
      },
      config,
    );

    if (decision.action === 'inbox') {
      untouched += 1;
      // Still worth the label even when the mail stays visible.
      if (decision.label === null) continue;
      const key = `label:${CATEGORIES[decision.label].label}`;
      const bucket = buckets.get(key) ?? { ids: [], addLabelIds: [CATEGORIES[decision.label].label], removeLabelIds: [] };
      bucket.ids.push(message.id);
      buckets.set(key, bucket);
      summary.set(key, (summary.get(key) ?? 0) + 1);
      continue;
    }

    const key =
      decision.action === 'trash'
        ? 'TRASH'
        : `file:${decision.label === null ? '(no label)' : CATEGORIES[decision.label].label}`;

    const bucket =
      buckets.get(key) ??
      (decision.action === 'trash'
        ? { ids: [], addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }
        : {
            ids: [],
            addLabelIds: decision.label === null ? [] : [CATEGORIES[decision.label].label],
            removeLabelIds: ['INBOX'],
          });
    bucket.ids.push(message.id);
    buckets.set(key, bucket);
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }

  if (!process.argv.includes('--force')) await assertSnapshotFresh(messages.length);

  console.log(`${messages.length} inbox messages in the local scan`);
  if (unknown > 0) console.log(`${unknown} skipped — sender not in the scan aggregate`);
  console.log(`${untouched} stay in the inbox\n`);

  for (const [key, count] of [...summary].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${key}`);
  }

  const totalMoves = [...buckets.values()].reduce((n, b) => n + b.ids.length, 0);
  console.log(`\n${totalMoves} messages to modify across ${buckets.size} groups`);

  if (!apply) {
    console.log('\nNothing was changed.');
    return;
  }

  console.log('');
  for (const [key, bucket] of buckets) {
    const addLabelIds = bucket.addLabelIds.map((name) => {
      if (name === 'TRASH') return 'TRASH';
      const id = labelIds.get(name);
      if (id === undefined) throw new Error(`Missing label id for ${name}`);
      return id;
    });

    for (let i = 0; i < bucket.ids.length; i += BATCH_SIZE) {
      const slice = bucket.ids.slice(i, i + BATCH_SIZE);
      await gmailFetch('/messages/batchModify', {
        method: 'POST',
        cost: 50,
        body: { ids: slice, addLabelIds, removeLabelIds: bucket.removeLabelIds },
      });
      console.log(`  ${key.padEnd(32)} ${i + slice.length}/${bucket.ids.length}`);
    }
  }

  console.log(`\nSwept ${totalMoves} messages.`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
