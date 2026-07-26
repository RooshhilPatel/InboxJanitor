/**
 * Deterministic tiering. No AI, no network — pure functions over scan aggregates so the same
 * inputs always produce the same tier and any surprising result can be traced to a named signal.
 */

import { categorize } from '../rules/categories.ts';

export type Tier =
  | 'E_NEVER_TOUCH'
  | 'A_AUTO_TRASH'
  | 'B_UNSUBSCRIBE'
  | 'C_ARCHIVE'
  | 'D_REVIEW'
  | 'L_LOW_VOLUME';

/** Below this, a sender cannot move the inbox number either way and is not worth your attention. */
export const MIN_VOLUME = 3;

/**
 * Stars protect a sender only when they show a real pattern. One star out of thirty says "I saved
 * one thing from this newsletter", not "never filter this sender" — and treating it as the latter
 * shielded 49 senders and 414 inbox messages behind a single star. Individual starred messages are
 * still protected downstream at message level (`-is:starred`), which is where that rule belongs.
 */
const STAR_PROTECT_COUNT = 3;
const STAR_PROTECT_RATIO = 0.2;

function starPatternProtects(sender: SenderStats): boolean {
  if (sender.starred === 0) return false;
  return sender.starred >= STAR_PROTECT_COUNT || sender.starred / sender.total >= STAR_PROTECT_RATIO;
}

export interface SenderStats {
  email: string;
  domain: string;
  displayName: string | null;
  total: number;
  inInbox: number;
  unread: number;
  starred: number;
  important: number;
  last90: number;
  lastReceived: number;
  bulk: boolean;
  hasUnsubLink: boolean;
  oneClickUnsub: boolean;
  contacted: boolean;
  sampleSubjects: string[];
}

export interface Verdict {
  tier: Tier;
  reasons: string[];
}

/**
 * Senders that must never be filtered regardless of engagement. Matched against the full address
 * and the domain. Deliberately broad: a false "keep" costs one email, a false "delete" can cost a
 * password reset, a fraud alert, or a tax document.
 */
const CRITICAL_PATTERNS = [
  /(^|\.)(irs|ssa|usps|uscis)\.gov$/i,
  /\.gov$/i,
  /\b(bank|chase|wellsfargo|citi|amex|americanexpress|capitalone|schwab|fidelity|vanguard)\b/i,
  /\b(paypal|venmo|stripe|coinbase|kraken|gemini)\b/i,
  /\b(insurance|healthcare|health|medical|clinic|hospital|pharmacy|dental)\b/i,
  /\b(legal|attorney|lawfirm|court)\b/i,
];

const SECURITY_SUBJECT = /\b(security alert|verification code|verify your|password reset|2fa|two-factor|sign-in|suspicious activity|confirm your identity)\b/i;

const TRANSACTIONAL_SUBJECT = /\b(receipt|invoice|order|shipped|shipment|tracking|delivered|statement|payment|refund|booking|reservation|itinerary|confirmation)\b/i;

/** Core mega-newsletter sources. Trashing these on arrival would silently break the daily digest. */
export const MEGA_NEWSLETTER_PROTECTED = [
  'crew@morningbrew.com',
  'morningbrew@mail.sailthru.com',
  'news@alphasignal.ai',
  'bullst@substack.com',
  'dan@tldrnewsletter.com',
];
export const MEGA_NEWSLETTER_PROTECTED_DOMAINS = ['tldrnewsletter.com'];

function isCritical(sender: SenderStats): boolean {
  return CRITICAL_PATTERNS.some((pattern) => pattern.test(sender.email) || pattern.test(sender.domain));
}

function matchesAny(subjects: readonly string[], pattern: RegExp): boolean {
  return subjects.some((subject) => pattern.test(subject));
}

export function readRate(sender: SenderStats): number {
  if (sender.total === 0) return 0;
  return (sender.total - sender.unread) / sender.total;
}

export function classify(sender: SenderStats): Verdict {
  const reasons: string[] = [];
  const rate = readRate(sender);

  // --- Tier E: allowlist, evaluated before anything else can propose a deletion. ---
  if (sender.contacted) reasons.push('you have emailed this address');
  if (starPatternProtects(sender)) {
    reasons.push(`${sender.starred} of ${sender.total} starred`);
  }
  if (isCritical(sender)) reasons.push('financial/government/medical/legal sender');
  if (matchesAny(sender.sampleSubjects, SECURITY_SUBJECT)) reasons.push('security or verification mail');
  if (MEGA_NEWSLETTER_PROTECTED.includes(sender.email)) reasons.push('mega-newsletter core source');
  if (MEGA_NEWSLETTER_PROTECTED_DOMAINS.includes(sender.domain)) reasons.push('mega-newsletter core domain');
  if (reasons.length > 0) return { tier: 'E_NEVER_TOUCH', reasons };

  // --- Tier C: keep, but out of the inbox. Searchable history worth more than inbox space. ---
  // Bulk headers are not a counter-signal here: Amazon order confirmations, Airbnb reservations and
  // bank statements all ship List-Unsubscribe. Gating this on `!bulk` sent 95 Amazon order
  // confirmations to the review pile while identical Airbnb mail filed correctly.
  const filedCategory = categorize(sender.email, sender.domain);
  if (matchesAny(sender.sampleSubjects, TRANSACTIONAL_SUBJECT)) {
    return {
      tier: 'C_ARCHIVE',
      reasons: ['transactional mail — archive rather than delete so it stays searchable'],
    };
  }
  if (filedCategory !== null && sender.bulk && sender.total >= MIN_VOLUME) {
    return { tier: 'C_ARCHIVE', reasons: [`known ${filedCategory} sender — file it rather than delete it`] };
  }

  // --- Tiers A/B: bulk mail you demonstrably do not read. ---
  if (sender.bulk && sender.total >= MIN_VOLUME && rate < 0.1) {
    const evidence = [
      `${sender.total} messages`,
      `${Math.round(rate * 100)}% read`,
      'never replied',
      sender.starred === 0 ? 'never starred' : `only ${sender.starred} starred`,
    ];
    return sender.hasUnsubLink
      ? { tier: 'B_UNSUBSCRIBE', reasons: [...evidence, 'has a working unsubscribe'] }
      : { tier: 'A_AUTO_TRASH', reasons: [...evidence, 'no usable unsubscribe link'] };
  }

  // --- Long tail. Separated so it cannot crowd out the senders actually worth a decision. ---
  if (sender.total < MIN_VOLUME) {
    return { tier: 'L_LOW_VOLUME', reasons: [`only ${sender.total} message(s) ever — not worth a rule`] };
  }

  const why =
    sender.bulk && rate >= 0.1
      ? [`bulk sender but ${Math.round(rate * 100)}% read — you may actually want this`]
      : ['not enough signal to decide deterministically'];
  return { tier: 'D_REVIEW', reasons: why };
}
