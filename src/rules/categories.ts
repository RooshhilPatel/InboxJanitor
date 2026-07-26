/**
 * Deterministic sender → Gmail label mapping. No AI, no network: a sender's category is a pure
 * function of its address, domain, and subject, so the same mail always files the same way and a
 * surprising result is traceable to one rule.
 *
 * Rules are ordered and first-match-wins, which is what lets narrow rules (health.amazon.com)
 * override broad ones (amazon.com) without special-casing.
 */

export type Category = 'shopping' | 'travel' | 'money' | 'home' | 'health' | 'accounts' | 'newsletters';

export interface CategorySpec {
  /** Gmail label applied on arrival and during the backlog sweep. */
  label: string;
  /**
   * Whether matching mail also leaves the inbox. Low-urgency categories skip; anything where not
   * seeing it in real time has a real cost — money, home, health — stays visible.
   */
  skipInbox: boolean;
}

/**
 * Every category files on arrival; URGENT_SUBJECT is the only thing that keeps mail in front of you.
 * Chosen deliberately after measuring: Filed/Money alone was 918 backlog messages of which only 42
 * were alert-shaped, so keeping the category visible cost 876 messages to protect 42.
 *
 * `skipInbox` stays a per-category knob rather than being deleted — flipping one back to false is
 * the intended way to make a category visible again if filing turns out to hide something.
 */
export const CATEGORIES: Record<Category, CategorySpec> = {
  shopping: { label: 'Filed/Shopping', skipInbox: true },
  travel: { label: 'Filed/Travel', skipInbox: true },
  accounts: { label: 'Filed/Accounts', skipInbox: true },
  newsletters: { label: 'Filed/Newsletters', skipInbox: true },
  money: { label: 'Filed/Money', skipInbox: true },
  home: { label: 'Filed/Home', skipInbox: true },
  health: { label: 'Filed/Health', skipInbox: true },
};

export const QUARANTINE_LABEL = 'Janitor/Quarantine';
export const UNSUBSCRIBE_LABEL = 'Janitor/Unsubscribe';

/**
 * The only label namespaces this project may create, rename, or delete. Everything else in the
 * account is hand-made and topical — Receipts, Land, Boat, 2024 Taxes — and a compiler that can
 * reach those is one bad diff away from destroying years of manual filing. Machine-managed labels
 * live behind a prefix so the boundary is structural rather than a rule someone has to remember.
 */
export const MANAGED_PREFIXES = ['Filed/', 'Janitor/'] as const;

export function isManagedLabel(name: string): boolean {
  return MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Throws unless every label named is one we are allowed to touch. */
export function assertManaged(names: readonly string[]): void {
  const foreign = names.filter((name) => !isManagedLabel(name));
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to modify labels outside the managed namespace: ${foreign.join(', ')}. ` +
        `Only ${MANAGED_PREFIXES.join(' and ')} may be created or deleted.`,
    );
  }
}

/**
 * Nothing matching this ever skips the inbox, whatever its category. A delayed receipt costs
 * nothing; a fraud alert or login notification you did not see in real time is the expensive
 * failure this whole system has to avoid.
 */
export const URGENT_SUBJECT = new RegExp(
  [
    // account security
    'security alert|suspicious|unauthorized|fraud|verification code|verify your|password reset',
    '2fa|two-factor|sign-?in|signed in|new device|logged in|recent login|locked|suspended|restricted',
    // money going wrong
    "declined|failed|unable to|wasn'?t processed|could not be processed|returned|insufficient|on hold",
    'charged twice|double charge|dispute|unusual|overdraft|reached \\$',
    // something is expected of you
    'action required|past due|overdue|final notice|expir(?:ed|ing|es)|request to (?:share|approve)',
    'confirm your|approve|respond|deadline|last chance to',
    // Building and utility interruptions. These are same-day consequential but never phrased as
    // alerts ("Updated Pest Control Schedule", "Water Shutdown Reminder"), so without these terms
    // an urgency filter files them away silently.
    'shut ?down|shut ?off|outage|water main|no water|evacuat|road closure|closure|closed',
    'pest control|exterminat|fumigat|inspection|construction|elevator|heat|hvac|boiler',
    'parking|towed|tow(?:ing)?\\b|move your (?:car|vehicle)|snow|weather alert|emergency',
  ].join('|'),
  'i',
);

interface Rule {
  category: Category;
  /** Exact sender addresses. */
  emails?: string[];
  /** Matches the domain itself or any subdomain of it. */
  domains?: string[];
}

// Ordered: the first match wins, so narrow entries must precede the broad ones they carve out of.
const RULES: Rule[] = [
  // --- carve-outs that must beat their own parent domain ---
  { category: 'health', domains: ['health.amazon.com'] },
  { category: 'money', emails: ['no_reply@post.gs-savings.apple', 'no_reply@post.applecard.apple'] },

  { category: 'shopping', domains: ['amazon.com', 'costco.com', 'fedex.com', 'ups.com', 'shopify.com', 'etsy.com', 'ebay.com', 'target.com', 'walmart.com', 'bestbuy.com', 'wayfair.com', 'chewy.com'] },

  { category: 'travel', domains: ['airbnb.com', 'united.com', 'expedia.com', 'latam.com', 'uber.com', 'lyftmail.com', 'resy.com', 'ticketmaster.com', 'globalblue.com', 'booking.com', 'vrbo.com', 'delta.com', 'aa.com', 'jetblue.com', 'southwest.com', 'marriott.com', 'hilton.com', 'hyatt.com', 'opentable.com', 'kayak.com', 'tripadvisor.com'] },

  { category: 'money', domains: ['capitalone.com', 'tdbank.com', 'td.com', 'discover.com', 'chase.com', 'sofi.org', 'sofi.com', 'bankofbaroda.com', 'fidelity.com', 'venmo.com', 'wise.com', 'hrblock.com', 'paypal.com', 'schwab.com', 'vanguard.com', 'americanexpress.com', 'citi.com', 'wellsfargo.com', 'robinhood.com', 'coinbase.com', 'turbotax.com', 'intuit.com', 'creditkarma.com'] },

  { category: 'home', domains: ['condocontrol.com', 'optimum.net', 'billergenie.io', 'sv3.us', 'xfinity.com', 'verizon.com', 'coned.com', 'pseg.com', 'ring.com', 'adt.com'] },

  { category: 'health', domains: ['uhc.com', 'cvs.com', 'walgreens.com', 'zocdoc.com', 'onemedical.com', 'questdiagnostics.com', 'labcorp.com', 'aetna.com', 'cigna.com', 'bcbs.com'] },

  { category: 'accounts', domains: ['accounts.google.com', 'google.com', 'cloudflare.com', 'openai.com', 'tm.openai.com', 'x.ai', 'discord.com', 'spotify.com', 'apple.com', 'github.com', 'dropbox.com', 'notion.so', 'slack.com', 'linkedin.com', 'microsoft.com', 'adobe.com', 'namecheap.com', 'godaddy.com'] },
];

function domainMatches(senderDomain: string, ruleDomain: string): boolean {
  return senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`);
}

/** Returns the category for a sender, or null when no rule claims it. */
export function categorize(email: string, domain: string): Category | null {
  const address = email.toLowerCase();
  const host = domain.toLowerCase();

  for (const rule of RULES) {
    if (rule.emails?.some((candidate) => candidate.toLowerCase() === address) === true) return rule.category;
    if (rule.domains?.some((candidate) => domainMatches(host, candidate)) === true) return rule.category;
  }
  return null;
}

/**
 * Whether a specific message may leave the inbox. Category preference is the default, but an
 * urgent-looking subject overrides it every time — the cost of the two mistakes is not symmetric.
 */
export function maySkipInbox(category: Category, subject: string | null): boolean {
  if (!CATEGORIES[category].skipInbox) return false;
  return subject === null || !URGENT_SUBJECT.test(subject);
}
