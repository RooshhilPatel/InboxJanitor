/**
 * Hand-curated per-sender decisions from the 2026-07-26 review of out/report.html.
 *
 * These beat every heuristic, including the safety allowlist — a human who has looked at a sender
 * knows more than any signal we can compute. Ordered, first match wins, so specific addresses must
 * precede the domain rules that would otherwise swallow them.
 *
 * `action`:
 *   trash   — unsubscribe where possible, then move to Trash (30-day recovery)
 *   archive — out of the inbox, kept and searchable
 *   keep    — never touched, stays in the inbox
 * `category`: forces a label. `null` forces *no* label, for senders a domain rule mislabels.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Category } from './categories.ts';

export interface Override {
  emails?: string[];
  domains?: string[];
  action?: 'trash' | 'archive' | 'keep';
  category?: Category | null;
  /** Trash once unread for this many days. Used where mail is only worth seeing while it is fresh. */
  trashIfUnreadAfterDays?: number;
  note?: string;
}

const CATEGORIES = [
  'shopping', 'travel', 'dining', 'money', 'home', 'health', 'accounts', 'social', 'newsletters',
] as const;

const OverrideSchema = z.object({
  emails: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  action: z.enum(['trash', 'archive', 'keep']).optional(),
  category: z.enum(CATEGORIES).nullable().optional(),
  trashIfUnreadAfterDays: z.number().optional(),
  note: z.string().optional(),
});

/**
 * Personal entries — colleagues, family, private relay aliases — live outside the repo so the rule
 * ledger can be published without publishing the people in it. Resolved against the repo root
 * rather than the working directory, so it does not matter where a script is run from.
 */
const PRIVATE_PATH = new URL('../../data/private-overrides.json', import.meta.url);

/**
 * A missing file is the normal case for anyone who is not the account owner, so it returns an empty
 * list rather than throwing. Malformed content is different: silently dropping an entry that says
 * "never file this person" would be the exact failure the entry exists to prevent, so it throws.
 */
/**
 * `category: null` and an absent `category` mean different things — force no label versus express no
 * opinion — so keys are copied only when present rather than spread wholesale. Under
 * exactOptionalPropertyTypes an explicit `undefined` is not the same as an absent key either.
 */
function toOverride(entry: z.infer<typeof OverrideSchema>): Override {
  const out: Override = {};
  if (entry.emails !== undefined) out.emails = entry.emails;
  if (entry.domains !== undefined) out.domains = entry.domains;
  if (entry.action !== undefined) out.action = entry.action;
  if (entry.category !== undefined) out.category = entry.category;
  if (entry.trashIfUnreadAfterDays !== undefined) out.trashIfUnreadAfterDays = entry.trashIfUnreadAfterDays;
  if (entry.note !== undefined) out.note = entry.note;
  return out;
}

export function parsePrivateOverrides(raw: string): Override[] {
  const parsed = z.array(OverrideSchema).safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new Error(
      `private overrides are malformed, and these entries outrank every other rule — ` +
        `refusing to run with them silently dropped: ${parsed.error.message}`,
    );
  }
  return parsed.data.map(toOverride);
}

function loadPrivateOverrides(): Override[] {
  try {
    return parsePrivateOverrides(readFileSync(PRIVATE_PATH, 'utf8'));
  } catch (error) {
    // Absent is the normal case for anyone who is not the account owner. Malformed is not.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Private entries come first because the People block must outrank everything: a domain rule below
 * would otherwise label a colleague's mail as an automated account notice.
 */
export const OVERRIDES: Override[] = [
  ...loadPrivateOverrides(),

  // ---------------------------------------------------------------------------------------------
  // Newsletters. Labelled but left in the inbox: mega-newsletter digests and trashes them daily.
  // ---------------------------------------------------------------------------------------------
  {
    emails: [
      'thebatch@deeplearning.ai',
      'crew@morningbrew.com',
      'morningbrew@mail.sailthru.com',
      'news@alphasignal.ai',
      'bullst@substack.com',
      'dan@tldrnewsletter.com',
    ],
    domains: ['tldrnewsletter.com'],
    action: 'keep',
    category: 'newsletters',
    note: 'mega-newsletter sources; thebatch also needs adding to _rules.md Always include',
  },

  // ---------------------------------------------------------------------------------------------
  // Already handled by a hand-made Gmail filter, under a label outside the managed namespace.
  //
  // These read as textbook noise to the heuristics — high volume, bulk headers, 0% read — but the
  // read rate is an artifact: the mail never lands in the inbox to be read, because a filter the
  // account owner wrote years ago labels and archives it on arrival. Trashing a sender on evidence
  // its own correct handling produced is the failure mode this entry exists to block.
  //
  // `archive` + `category: null` is deliberate, not lazy. It resolves to file-with-no-label, which
  // the compiler leaves unfiltered by design, so this project creates nothing that could race the
  // owner's filter — and it cannot reach the label either way, since only Filed/ and Janitor/ are
  // writable. Staying out of the way *is* the correct behaviour here.
  // ---------------------------------------------------------------------------------------------
  {
    emails: ['scotts-flights-friends-subscribed@googlegroups.com'],
    action: 'archive',
    category: null,
    note: "the owner's own filter already files this under \"Scott's Cheap Flights\"",
  },

  // ---------------------------------------------------------------------------------------------
  // Explicit trash. Reviewed and unwanted.
  // ---------------------------------------------------------------------------------------------
  {
    emails: [
      'updates-noreply@linkedin.com',
      'unitedairlines@enews.united.com',
      'support@hears.com',
      'store-news@amazon.com',
      'robots@dbrand.com',
      'donotreply@facebookuserprivacysettlement.com',
      'members@maharajaclub.airindia.com',
      'maharajaclub@flyai.airindia.com',
      'hello@levels.fyi',
      'noreply@discord.com',
      'carfax@carcare.no-reply.carfax.com',
      'honey@my.joinhoney.com',
      'disneyplus@trx.mail2.disneyplus.com',
      'support@paintingbynumbersshop.com',
    ],
    action: 'trash',
    note: 'paintingbynumbersshop overrides the you-have-emailed-them allowlist, by explicit request',
  },

  // Only worth seeing while fresh. Trash is still Gmail Trash — recoverable for 30 days, then
  // Gmail purges it. Permanent deletion is not available to this project by design.
  {
    emails: ['notify@condocontrol.com'],
    category: 'home',
    trashIfUnreadAfterDays: 30,
    note: 'building notices are worthless once stale',
  },

  // ---------------------------------------------------------------------------------------------
  // Forced categories, correcting the domain heuristics.
  // ---------------------------------------------------------------------------------------------
  { emails: ['messages-noreply@linkedin.com'], action: 'archive', category: 'social' },
  { emails: ['do-not-reply@sv3.us', 'noreply@image-line.com'], category: 'accounts' },
  { emails: ['no_reply@snapchat.com'], category: 'social' },
  {
    emails: [
      'noreply@business-updates.facebook.com',
      'emails@secure-booker.com',
      'no-reply.emessage.njezpass@isecurus.com',
      'affinitymail@serif.com',
      'connecthome.ols@connectbyamfam.com',
      'connecthome@emails.connectbyamfam.com',
      'donotreply@audible.com',
      'no-reply.emessage@ezpassnj.com',
    ],
    category: 'accounts',
    note: 'business-updates.facebook.com kept as Accounts per the explicit listing, not Social Media',
  },
  {
    emails: ['subscriptions@subscriptions.treas.gov'],
    action: 'keep',
    category: 'money',
    note: 'labelled Money but pinned to the inbox by explicit request',
  },
  {
    emails: ['customer.service@servicing.synchrony.com', 'support@betterment.com', 'estatement@bankofbaroda.bank.in'],
    category: 'money',
  },
  {
    emails: [
      'reservations@res-marriott.com',
      'support@busbud.com',
      'communications@info.aircanada.com',
      'confirmation@aircanada.ca',
      'expedia@expediamail.com',
      'info@reefexperience.com.au',
      'etickets@amtrak.com',
      'europcargroup@europcar.com',
      'no-reply@enterpriseholdings.com',
      'hello@mail.parkmobile.io',
      'noreply@alerts.parkmobile.io',
      'noreply@app.octopuscards.com',
      'customerservice@ezpassnj.com',
      'hertznoreply@rentals.hertz.com',
      'reservations@emails.hertz.com',
    ],
    category: 'travel',
  },
  {
    emails: [
      // The private relay aliases for these merchants live in data/private-overrides.json.
      'hi@thebutterflyeffect.com',
      'support@thebutterflyeffect.zendesk.com',
      'onlineorders@centralcomputer.com',
      'ord-status@bhphotovideo.com',
      'support@aersf.com',
      'zenni@shop.zennioptical.com',
      'from@notifications.dcsg.com',
      'info@stepprs.com',
      'deliveries@skypilotapp.com',
      'the-elves@elfster.com',
      'noreply@email.amctheatres.com',
    ],
    action: 'archive',
    category: 'shopping',
  },
  { emails: ['gwe@gwecorp.com', 'info@pruzansky.com', 'contact_us@emails.amfam.com', 'servicepromise@connectbyamfam.com'], category: 'home' },
  {
    emails: [
      'melissa@carecapplus.com',
      'no-reply@phreesia-mail.com',
      'no-reply@patientnotebook.com',
      'noreply@mail.sg.getweave.com',
      'appointments@e.eyeappts.com',
      'dentalplus1@optimum.net',
      'labcorppatient@labcorpservicemessage.com',
    ],
    category: 'health',
  },
  { emails: ['honda_service@em.honda.com'], action: 'keep', note: 'explicitly not to be unsubscribed or trashed' },
  { domains: ['coinbase.com', 'spotify.com'], action: 'archive' },
  { emails: ['google-gemini-noreply@google.com'], action: 'archive', category: 'accounts' },
];

export interface OverrideMatch {
  action?: 'trash' | 'archive' | 'keep';
  category?: Category | null;
  trashIfUnreadAfterDays?: number;
  note?: string;
}

function domainMatches(senderDomain: string, ruleDomain: string): boolean {
  return senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`);
}

/** The first override claiming this sender, or null. */
export function findOverride(email: string, domain: string): OverrideMatch | null {
  return findOverrideIn(OVERRIDES, email, domain);
}

/** Same, against an explicit ledger. Separated so precedence is testable without private data. */
export function findOverrideIn(
  overrides: readonly Override[],
  email: string,
  domain: string,
): OverrideMatch | null {
  const address = email.toLowerCase();
  const host = domain.toLowerCase();

  for (const rule of overrides) {
    const byEmail = rule.emails?.some((candidate) => candidate.toLowerCase() === address) === true;
    const byDomain = rule.domains?.some((candidate) => domainMatches(host, candidate)) === true;
    if (!byEmail && !byDomain) continue;

    const match: OverrideMatch = {};
    if (rule.action !== undefined) match.action = rule.action;
    if ('category' in rule) match.category = rule.category;
    if (rule.trashIfUnreadAfterDays !== undefined) match.trashIfUnreadAfterDays = rule.trashIfUnreadAfterDays;
    if (rule.note !== undefined) match.note = rule.note;
    return match;
  }
  return null;
}

/** Category with overrides applied. Separated so the report and compiler cannot disagree. */
export function resolveCategory(
  email: string,
  domain: string,
  heuristic: Category | null,
): Category | null {
  const override = findOverride(email, domain);
  if (override !== null && 'category' in override) return override.category ?? null;
  return heuristic;
}
