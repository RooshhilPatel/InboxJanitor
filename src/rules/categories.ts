/**
 * Deterministic sender → Gmail label mapping. No AI, no network: a sender's category is a pure
 * function of its address, domain, and subject, so the same mail always files the same way and a
 * surprising result is traceable to one rule.
 *
 * Rules are ordered and first-match-wins, which is what lets narrow rules (health.amazon.com)
 * override broad ones (amazon.com) without special-casing. Hand-curated per-sender decisions live
 * in overrides.ts and beat everything here.
 */

export type Category =
  | 'shopping'
  | 'travel'
  | 'dining'
  | 'money'
  | 'home'
  | 'health'
  | 'accounts'
  | 'social'
  | 'newsletters';

export interface CategorySpec {
  /** Gmail label applied on arrival and during the backlog sweep. */
  label: string;
  /**
   * Whether matching mail also leaves the inbox. An urgent-looking subject overrides this and keeps
   * the message visible regardless.
   */
  skipInbox: boolean;
}

/**
 * Every category files on arrival except newsletters, with URGENT_SUBJECT as the only thing that
 * keeps mail in front of you. Chosen after measuring: Filed/Money alone was 918 backlog messages of
 * which only 42 were alert-shaped, so keeping it visible cost 876 messages to protect 42.
 *
 * Newsletters deliberately stay in the inbox. The mega-newsletter automation digests and trashes
 * them daily, so they never accumulate, and filing them risks them falling outside that
 * automation's discovery pass — a silent failure with no error anywhere.
 *
 * `skipInbox` stays a per-category knob rather than being deleted: flipping one back to false is
 * the intended way to make a category visible again if filing turns out to hide something.
 */
export const CATEGORIES: Record<Category, CategorySpec> = {
  shopping: { label: 'Filed/Shopping', skipInbox: true },
  travel: { label: 'Filed/Travel', skipInbox: true },
  dining: { label: 'Filed/Dining', skipInbox: true },
  money: { label: 'Filed/Money', skipInbox: true },
  home: { label: 'Filed/Home', skipInbox: true },
  health: { label: 'Filed/Health', skipInbox: true },
  accounts: { label: 'Filed/Accounts', skipInbox: true },
  social: { label: 'Filed/Social Media', skipInbox: true },
  newsletters: { label: 'Filed/Newsletters', skipInbox: false },
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
 * nothing; a fraud alert, an overdue invoice, or a water shutdown you did not see in time is the
 * expensive failure this whole system exists to avoid.
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
  /** Optional subject discriminator, for senders that carry more than one kind of mail. */
  subject?: RegExp;
}

// Ordered: the first match wins, so narrow entries must precede the broad ones they carve out of.
const RULES: Rule[] = [
  // --- carve-outs that must beat their own parent domain ---
  { category: 'health', domains: ['health.amazon.com'] },
  { category: 'money', emails: ['no_reply@post.gs-savings.apple', 'no_reply@post.applecard.apple'] },
  // One address carries both ride receipts and food orders; only the subject separates them.
  { category: 'dining', domains: ['uber.com'], subject: /uber\s*eats|food|order/i },

  { category: 'shopping', domains: ['amazon.com', 'costco.com', 'fedex.com', 'ups.com', 'shopify.com', 'etsy.com', 'ebay.com', 'target.com', 'walmart.com', 'bestbuy.com', 'wayfair.com', 'chewy.com'] },

  { category: 'travel', domains: ['airbnb.com', 'united.com', 'expedia.com', 'expediamail.com', 'latam.com', 'uber.com', 'lyftmail.com', 'ticketmaster.com', 'globalblue.com', 'booking.com', 'vrbo.com', 'delta.com', 'aa.com', 'jetblue.com', 'southwest.com', 'marriott.com', 'res-marriott.com', 'hilton.com', 'hyatt.com', 'kayak.com', 'tripadvisor.com', 'aircanada.com', 'aircanada.ca', 'amtrak.com', 'busbud.com', 'europcar.com', 'enterpriseholdings.com', 'hertz.com', 'rentals.hertz.com', 'parkmobile.io', 'octopuscards.com', 'reefexperience.com.au'] },

  { category: 'dining', domains: ['resy.com', 'opentable.com', 'doordash.com', 'grubhub.com', 'ubereats.com', 'seamless.com', 'caviar.com', 'toasttab.com'] },

  { category: 'money', domains: ['capitalone.com', 'capitalonebooking.com', 'tdbank.com', 'td.com', 'discover.com', 'chase.com', 'sofi.org', 'sofi.com', 'bankofbaroda.com', 'bankofbaroda.bank.in', 'fidelity.com', 'venmo.com', 'wise.com', 'hrblock.com', 'paypal.com', 'schwab.com', 'vanguard.com', 'americanexpress.com', 'citi.com', 'wellsfargo.com', 'robinhood.com', 'coinbase.com', 'turbotax.com', 'intuit.com', 'creditkarma.com', 'synchrony.com', 'synchronybank.com', 'betterment.com', 'e.betterment.com', 'treas.gov'] },

  { category: 'home', domains: ['condocontrol.com', 'optimum.net', 'billergenie.io', 'xfinity.com', 'verizon.com', 'coned.com', 'pseg.com', 'ring.com', 'adt.com', 'gwecorp.com', 'pruzansky.com', 'amfam.com', 'emails.amfam.com'] },

  { category: 'health', domains: ['uhc.com', 'cvs.com', 'walgreens.com', 'zocdoc.com', 'onemedical.com', 'questdiagnostics.com', 'labcorp.com', 'labcorpservicemessage.com', 'aetna.com', 'cigna.com', 'bcbs.com', 'carecapplus.com', 'phreesia-mail.com', 'patientnotebook.com', 'getweave.com', 'e.eyeappts.com'] },

  { category: 'social', domains: ['linkedin.com', 'facebook.com', 'facebookmail.com', 'snapchat.com', 'instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'tiktok.com', 'nextdoor.com'] },

  // Deliberately no bare `google.com`: colleagues and friends mail from that domain and must never
  // be labelled as an automated account notice.
  { category: 'accounts', emails: ['googleone-noreply@google.com', 'google-gemini-noreply@google.com', 'drive-shares-dm-noreply@google.com', 'noreply@google.com'] },
  { category: 'accounts', domains: ['accounts.google.com', 'cloudflare.com', 'openai.com', 'x.ai', 'discord.com', 'spotify.com', 'apple.com', 'github.com', 'dropbox.com', 'notion.so', 'slack.com', 'microsoft.com', 'adobe.com', 'namecheap.com', 'godaddy.com', 'secure-booker.com', 'isecurus.com', 'ezpassnj.com', 'serif.com', 'audible.com', 'connectbyamfam.com', 'sv3.us', 'image-line.com'] },
];

function domainMatches(senderDomain: string, ruleDomain: string): boolean {
  return senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`);
}

/** Returns the category for a sender, or null when no rule claims it. */
export function categorize(email: string, domain: string, subject: string | null = null): Category | null {
  const address = email.toLowerCase();
  const host = domain.toLowerCase();

  for (const rule of RULES) {
    if (rule.subject !== undefined && (subject === null || !rule.subject.test(subject))) continue;
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
