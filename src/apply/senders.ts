/**
 * Loads scanned senders and resolves each to a steady-state plan. Shared by the filter compiler and
 * the backlog sweep so a sender cannot be filtered one way and swept another.
 */
import { classify, labelFor, type SenderStats } from '../report/classify.ts';
import { openDb } from '../scan/db.ts';
import { findOverride } from '../rules/overrides.ts';
import { CATEGORIES, type Category } from '../rules/categories.ts';

const DAY = 86_400_000;

export interface SenderPlan {
  sender: SenderStats;
  /** What arriving mail from this sender should do, absent a per-message urgency override. */
  intent: 'trash' | 'file' | 'inbox';
  label: Category | null;
  reason: string;
}

export function loadSenderPlans(): SenderPlan[] {
  const db = openDb();
  const cutoff90 = Date.now() - 90 * DAY;

  const rows = db
    .prepare(
      `SELECT m.from_email, m.from_domain, MAX(m.from_name) AS display_name, COUNT(*) AS total,
         SUM(m.in_inbox) AS in_inbox, SUM(m.unread) AS unread, SUM(m.starred) AS starred,
         SUM(m.important) AS important,
         SUM(CASE WHEN m.internal_date >= ? THEN 1 ELSE 0 END) AS last90,
         MAX(m.internal_date) AS last_received,
         MAX(CASE WHEN m.list_unsubscribe IS NOT NULL THEN 1 ELSE 0 END) AS bulk,
         MAX(CASE WHEN m.list_unsubscribe_post IS NOT NULL THEN 1 ELSE 0 END) AS one_click,
         MAX(CASE WHEN c.email IS NOT NULL THEN 1 ELSE 0 END) AS contacted
       FROM messages m LEFT JOIN contacted c ON c.email = m.from_email
       GROUP BY m.from_email ORDER BY total DESC`,
    )
    .all(cutoff90) as Array<Record<string, never>>;

  const subjects = db.prepare(
    'SELECT subject FROM messages WHERE from_email = ? AND subject IS NOT NULL ORDER BY internal_date DESC LIMIT 5',
  );

  const plans = (rows as unknown as Array<Record<string, string | number | null>>).map((row) => {
    const email = String(row['from_email']);
    const sender: SenderStats = {
      email,
      domain: String(row['from_domain']),
      displayName: row['display_name'] === null ? null : String(row['display_name']),
      total: Number(row['total']),
      inInbox: Number(row['in_inbox']),
      unread: Number(row['unread']),
      starred: Number(row['starred']),
      important: Number(row['important']),
      last90: Number(row['last90']),
      lastReceived: Number(row['last_received']),
      bulk: Number(row['bulk']) === 1,
      hasUnsubLink: Number(row['bulk']) === 1,
      oneClickUnsub: Number(row['one_click']) === 1,
      contacted: Number(row['contacted']) === 1,
      sampleSubjects: (subjects.all(email) as Array<{ subject: string }>).map((s) => s.subject),
    };

    const tier = classify(sender).tier;
    const label = labelFor(sender);
    const override = findOverride(sender.email, sender.domain);

    let intent: SenderPlan['intent'];
    let reason: string;
    if (tier === 'B_UNSUBSCRIBE' || tier === 'A_AUTO_TRASH') {
      intent = 'trash';
      reason = 'noise';
    } else if (override?.action === 'keep') {
      intent = 'inbox';
      reason = 'pinned by review';
    } else if (label !== null && CATEGORIES[label].skipInbox) {
      intent = 'file';
      reason = `files as ${CATEGORIES[label].label}`;
    } else if (label !== null) {
      intent = 'inbox';
      reason = `labelled ${CATEGORIES[label].label}, stays visible`;
    } else if (tier === 'C_ARCHIVE' || tier === 'D_REVIEW' || tier === 'L_LOW_VOLUME') {
      intent = 'file';
      reason = tier === 'C_ARCHIVE' ? 'transactional' : 'undecided';
    } else {
      intent = 'inbox';
      reason = 'protected';
    }

    return { sender, intent, label, reason };
  });

  db.close();
  return plans;
}
