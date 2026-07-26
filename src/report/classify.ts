/**
 * Deterministic tiering. No AI, no network — pure functions over scan aggregates so the same
 * inputs always produce the same tier and any surprising result can be traced to a named signal.
 */

export type Tier = 'E_NEVER_TOUCH' | 'A_AUTO_TRASH' | 'B_UNSUBSCRIBE' | 'C_ARCHIVE' | 'D_REVIEW';

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
  if (sender.starred > 0) reasons.push(`${sender.starred} starred`);
  if (isCritical(sender)) reasons.push('financial/government/medical/legal sender');
  if (matchesAny(sender.sampleSubjects, SECURITY_SUBJECT)) reasons.push('security or verification mail');
  if (MEGA_NEWSLETTER_PROTECTED.includes(sender.email)) reasons.push('mega-newsletter core source');
  if (MEGA_NEWSLETTER_PROTECTED_DOMAINS.includes(sender.domain)) reasons.push('mega-newsletter core domain');
  if (reasons.length > 0) return { tier: 'E_NEVER_TOUCH', reasons };

  // --- Tier C: keep, but out of the inbox. Searchable history worth more than inbox space. ---
  if (!sender.bulk && matchesAny(sender.sampleSubjects, TRANSACTIONAL_SUBJECT)) {
    return {
      tier: 'C_ARCHIVE',
      reasons: ['transactional mail — archive rather than delete so it stays searchable'],
    };
  }

  // --- Tiers A/B: bulk mail you demonstrably do not read. ---
  if (sender.bulk && sender.total >= 3 && rate < 0.1) {
    const evidence = [
      `${sender.total} messages`,
      `${Math.round(rate * 100)}% read`,
      'never replied',
      'never starred',
    ];
    return sender.hasUnsubLink
      ? { tier: 'B_UNSUBSCRIBE', reasons: [...evidence, 'has a working unsubscribe'] }
      : { tier: 'A_AUTO_TRASH', reasons: [...evidence, 'no usable unsubscribe link'] };
  }

  const why =
    sender.bulk && rate >= 0.1
      ? [`bulk sender but ${Math.round(rate * 100)}% read — you may actually want this`]
      : ['not enough signal to decide deterministically'];
  return { tier: 'D_REVIEW', reasons: why };
}
