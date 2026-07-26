/**
 * What actually happens to one message. Single source of truth: the report, the filter compiler,
 * and the backlog sweep all call this, so they cannot disagree about where a message ends up.
 *
 * Precedence exists because the inputs genuinely conflict — a sender can be pinned to the inbox and
 * carry a label whose category normally files, and something has to decide. Ordered most to least
 * authoritative, with the cheap mistake always preferred over the expensive one.
 */
import { classify, labelFor, type SenderStats } from '../report/classify.ts';
import { CATEGORIES, maySkipInbox, type Category } from './categories.ts';
import { findOverride } from './overrides.ts';

export type Action = 'trash' | 'file' | 'inbox';

export interface MessageFacts {
  subject: string | null;
  /** Epoch millis. */
  receivedAt: number;
  unread: boolean;
  starred: boolean;
}

export interface Disposition {
  action: Action;
  /** Label to apply, or null. Applies to `file` and `inbox` alike — pinned mail is still filed. */
  label: Category | null;
  reason: string;
}

export interface DispositionConfig {
  archiveAfterDays: number;
  now: number;
}

export function dispositionFor(
  sender: SenderStats,
  message: MessageFacts,
  config: DispositionConfig,
): Disposition {
  const override = findOverride(sender.email, sender.domain);
  const label = labelFor(sender);
  const tier = classify(sender).tier;
  const day = 86_400_000;

  // 1. Stars are a per-message instruction from you. Nothing outranks them.
  if (message.starred) return { action: 'inbox', label, reason: 'starred' };

  // 2. Mail that is only worth seeing while fresh, once it is no longer fresh.
  if (
    override?.trashIfUnreadAfterDays !== undefined &&
    message.unread &&
    message.receivedAt < config.now - override.trashIfUnreadAfterDays * day
  ) {
    return { action: 'trash', label: null, reason: `unread for over ${override.trashIfUnreadAfterDays} days` };
  }

  // 3. Reviewed and unwanted, or heuristically unwanted.
  if (tier === 'B_UNSUBSCRIBE' || tier === 'A_AUTO_TRASH') {
    return { action: 'trash', label: null, reason: 'noise' };
  }

  // 4. Explicitly pinned. This is the case a category alone cannot express: "label it Money, but I
  //    still want to see it." An override saying keep beats the category's filing preference.
  if (override?.action === 'keep') {
    return { action: 'inbox', label, reason: 'pinned to inbox by review' };
  }

  // 5. Reviewed as archive, regardless of what the category would have done.
  if (override?.action === 'archive') return { action: 'file', label, reason: 'reviewed: archive' };

  // 6. Category filing, unless the subject looks urgent.
  if (label !== null) {
    return maySkipInbox(label, message.subject)
      ? { action: 'file', label, reason: `filed as ${CATEGORIES[label].label}` }
      : { action: 'inbox', label, reason: 'urgent subject overrides filing' };
  }

  // 7. Protected senders keep their mail, but old mail still leaves the inbox. Never trashed.
  //    Distinct from case 4: a heuristic guess that a sender matters is not a request to pin it.
  if (tier === 'E_NEVER_TOUCH') {
    return message.receivedAt < config.now - config.archiveAfterDays * day
      ? { action: 'file', label: null, reason: `protected, but older than ${config.archiveAfterDays} days` }
      : { action: 'inbox', label: null, reason: 'protected sender' };
  }

  // 8. Undecided and long-tail senders archive rather than accumulate.
  if (tier === 'C_ARCHIVE' || tier === 'D_REVIEW' || tier === 'L_LOW_VOLUME') {
    return { action: 'file', label: null, reason: tier === 'C_ARCHIVE' ? 'transactional' : 'undecided sender' };
  }

  return message.receivedAt < config.now - config.archiveAfterDays * day
    ? { action: 'file', label: null, reason: `older than ${config.archiveAfterDays} days` }
    : { action: 'inbox', label: null, reason: 'recent' };
}
