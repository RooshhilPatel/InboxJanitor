import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = fileURLToPath(new URL('../../data/inbox.db', import.meta.url));

export interface MessageRow {
  id: string;
  thread_id: string;
  from_email: string;
  from_name: string | null;
  from_domain: string;
  subject: string | null;
  internal_date: number;
  labels: string;
  in_inbox: number;
  unread: number;
  starred: number;
  important: number;
  category: string | null;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  list_id: string | null;
}

export function openDb(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      from_email TEXT NOT NULL,
      from_name TEXT,
      from_domain TEXT NOT NULL,
      subject TEXT,
      internal_date INTEGER NOT NULL,
      labels TEXT NOT NULL,
      in_inbox INTEGER NOT NULL,
      unread INTEGER NOT NULL,
      starred INTEGER NOT NULL,
      important INTEGER NOT NULL,
      category TEXT,
      list_unsubscribe TEXT,
      list_unsubscribe_post TEXT,
      list_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_email);
    CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages(from_domain);
    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(internal_date);

    -- Addresses I have written to. The strongest single "never touch this sender" signal.
    CREATE TABLE IF NOT EXISTS contacted (
      email TEXT PRIMARY KEY,
      sent_count INTEGER NOT NULL DEFAULT 0,
      last_sent INTEGER
    );

    CREATE TABLE IF NOT EXISTS scan_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

export function upsertMessages(db: Database.Database, rows: readonly MessageRow[]): void {
  const statement = db.prepare(`
    INSERT INTO messages (
      id, thread_id, from_email, from_name, from_domain, subject, internal_date, labels,
      in_inbox, unread, starred, important, category,
      list_unsubscribe, list_unsubscribe_post, list_id
    ) VALUES (
      @id, @thread_id, @from_email, @from_name, @from_domain, @subject, @internal_date, @labels,
      @in_inbox, @unread, @starred, @important, @category,
      @list_unsubscribe, @list_unsubscribe_post, @list_id
    )
    ON CONFLICT(id) DO UPDATE SET
      labels = excluded.labels,
      in_inbox = excluded.in_inbox,
      unread = excluded.unread,
      starred = excluded.starred,
      important = excluded.important,
      category = excluded.category
  `);

  db.transaction((batch: readonly MessageRow[]) => {
    for (const row of batch) statement.run(row);
  })(rows);
}

export function recordContacted(
  db: Database.Database,
  entries: ReadonlyMap<string, { count: number; lastSent: number }>,
): void {
  const statement = db.prepare(`
    INSERT INTO contacted (email, sent_count, last_sent)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      sent_count = contacted.sent_count + excluded.sent_count,
      last_sent = MAX(COALESCE(contacted.last_sent, 0), excluded.last_sent)
  `);

  db.transaction(() => {
    for (const [email, { count, lastSent }] of entries) statement.run(email, count, lastSent);
  })();
}

/**
 * Message ids already stored. A scan can die partway through — rate limits, a dropped connection —
 * and refetching thousands of messages to rediscover what is already on disk wastes the very quota
 * that killed the previous run.
 */
export function existingMessageIds(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT id FROM messages').all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Addresses already recorded as contacted, so pass 1 can be skipped on a resumed run. */
export function contactedCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM contacted').get() as { n: number }).n;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO scan_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
