/**
 * Compiles the rule ledger into Gmail filters. Filters act on arriving mail only — the existing
 * backlog is the sweep's job.
 *
 * Quarantine mode: senders judged noise are labelled Janitor/Quarantine and skip the inbox rather
 * than being trashed, so a week of real arrivals can be inspected before anything is deleted.
 *
 * Run: npm run apply:filters [-- --apply] [-- --mode=trash]
 */
import 'dotenv/config';
import { gmailFetch } from '../scan/gmail.ts';
import { ensureLabels, listLabels } from './labels.ts';
import { loadSenderPlans, type SenderPlan } from './senders.ts';
import { CATEGORIES, QUARANTINE_LABEL } from '../rules/categories.ts';
import { MEGA_NEWSLETTER_PROTECTED, MEGA_NEWSLETTER_PROTECTED_DOMAINS } from '../report/classify.ts';

/** Senders per filter. Gmail rejects very long criteria, and small groups keep diffs readable. */
const GROUP_SIZE = 20;

export interface GmailFilter {
  id?: string;
  criteria?: { from?: string; query?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

async function listFilters(): Promise<GmailFilter[]> {
  const response = await gmailFetch<{ filter?: GmailFilter[] }>('/settings/filters');
  return response.filter ?? [];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Gmail stores filter criteria in whatever form it was created with — bare, quoted, parenthesised,
 * or angle-bracketed as `<a@b.com>`. Left unnormalised, `<a@b.com>` never equals the `a@b.com` the
 * planner emits, so a covered sender reads as uncovered and gets a duplicate filter on every run.
 * Addresses are case-insensitive, so fold case too.
 */
export function normalizeSender(raw: string): string {
  return raw.replace(/["()<>]/g, '').trim().toLowerCase();
}

/**
 * What a filter does to a sender, as a comparable string. Both halves matter: the same address
 * labelled Filed/Travel and labelled Janitor/Quarantine are different filters, and so are two that
 * agree on the label but disagree about removing it from the inbox.
 */
export function actionKey(addLabel: string, removeInbox: boolean): string {
  return `${addLabel} | ${removeInbox ? 'skip-inbox' : 'stay-visible'}`;
}

/**
 * Sender → the set of actions Gmail already applies to it.
 *
 * Idempotency has to be judged per sender, not per planned group. Groups are an artifact of
 * GROUP_SIZE chunking, so adding or removing a single sender re-cuts every boundary after it and
 * no group would ever match again — a group-level check degrades to "create everything" on the
 * first rule change. Sender-level coverage survives regrouping, and it is also what makes hand-
 * editing a live filter safe: the compiler sees the senders that remain, not the shape they were in.
 */
export function buildCoverage(
  filters: readonly GmailFilter[],
  nameById: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const coverage = new Map<string, Set<string>>();

  for (const filter of filters) {
    const criteria = filter.criteria?.from ?? filter.criteria?.query ?? '';
    const senders = criteria.split(/\s+OR\s+/).map(normalizeSender).filter((s) => s.length > 0);
    const removeInbox = (filter.action?.removeLabelIds ?? []).includes('INBOX');

    for (const labelId of filter.action?.addLabelIds ?? []) {
      const key = actionKey(nameById.get(labelId) ?? labelId, removeInbox);
      for (const sender of senders) {
        const keys = coverage.get(sender) ?? new Set<string>();
        keys.add(key);
        coverage.set(sender, keys);
      }
    }
  }
  return coverage;
}

export interface Planned {
  description: string;
  senders: string[];
  addLabel: string;
  removeInbox: boolean;
}

/**
 * Re-running must converge, not accumulate. Gmail has no upsert and no uniqueness constraint on
 * filters, so a second --apply used to POST the whole plan again and duplicate every filter in the
 * account. Each planned group is narrowed to the senders Gmail is not already handling this exact
 * way; groups with nothing left are dropped.
 */
export function uncovered(
  planned: readonly Planned[],
  coverage: ReadonlyMap<string, ReadonlySet<string>>,
): Planned[] {
  return planned
    .map((item) => ({
      ...item,
      senders: item.senders.filter(
        (sender) =>
          coverage.get(normalizeSender(sender))?.has(actionKey(item.addLabel, item.removeInbox)) !== true,
      ),
    }))
    .filter((item) => item.senders.length > 0);
}

/**
 * Filters that trash or quarantine a sender the rules no longer consider noise. Reported, never
 * deleted — this is exactly how two dental practices ended up quarantined after their senders
 * became protected, and a silent recompile would have left them there. Deleting is a judgement
 * call about mail that has already moved, so it stays a human's.
 */
function reportStaleDestructive(
  filters: readonly GmailFilter[],
  nameById: ReadonlyMap<string, string>,
  plans: readonly SenderPlan[],
): void {
  const stillNoise = new Set(plans.filter((p) => p.intent === 'trash').map((p) => p.sender.email));
  const stale = new Set<string>();

  for (const filter of filters) {
    const adds = (filter.action?.addLabelIds ?? []).map((id) => nameById.get(id) ?? id);
    if (!adds.includes(QUARANTINE_LABEL) && !adds.includes('TRASH')) continue;

    const criteria = filter.criteria?.from ?? filter.criteria?.query ?? '';
    for (const sender of criteria.split(/\s+OR\s+/).map(normalizeSender)) {
      if (sender.length > 0 && !stillNoise.has(sender)) stale.add(sender);
    }
  }

  if (stale.size === 0) return;
  console.log(
    `\n⚠ ${stale.size} sender(s) are quarantined or trashed by a live filter but are no longer ` +
      `noise under the current rules. Nothing here deletes them — review and remove by hand:`,
  );
  for (const sender of [...stale].sort()) console.log(`    ${sender}`);
}

/**
 * A filter that trashes or hides a mega-newsletter source would break the daily digest with no
 * error surfaced anywhere — the automation would simply find nothing and report a quiet zero.
 */
function assertNoNewsletterCapture(plans: readonly SenderPlan[]): void {
  const captured = plans
    .filter((plan) => plan.intent !== 'inbox')
    .filter(
      (plan) =>
        MEGA_NEWSLETTER_PROTECTED.includes(plan.sender.email) ||
        MEGA_NEWSLETTER_PROTECTED_DOMAINS.includes(plan.sender.domain),
    );

  if (captured.length > 0) {
    throw new Error(
      `Refusing to compile: these mega-newsletter sources would be removed from the inbox and the ` +
        `daily digest would silently find nothing — ${captured.map((c) => c.sender.email).join(', ')}`,
    );
  }
}

export async function compile(apply: boolean, mode: 'quarantine' | 'trash'): Promise<void> {
  const plans = loadSenderPlans();
  assertNoNewsletterCapture(plans);

  const labelIds = await ensureLabels(apply);
  console.log('');

  const existing = await listFilters();
  const nameById = new Map((await listLabels()).map((label) => [label.id, label.name]));
  const coverage = buildCoverage(existing, nameById);

  const trashSenders = plans.filter((p) => p.intent === 'trash').map((p) => p.sender.email);
  const fileGroups = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.intent !== 'file' || plan.label === null) continue;
    const label = CATEGORIES[plan.label].label;
    fileGroups.set(label, [...(fileGroups.get(label) ?? []), plan.sender.email]);
  }
  // Labelled but visible: tag on arrival without removing INBOX.
  const pinGroups = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.intent !== 'inbox' || plan.label === null) continue;
    const label = CATEGORIES[plan.label].label;
    pinGroups.set(label, [...(pinGroups.get(label) ?? []), plan.sender.email]);
  }

  const planned: Planned[] = [];
  const noiseLabel = mode === 'trash' ? 'TRASH' : QUARANTINE_LABEL;
  for (const group of chunk(trashSenders, GROUP_SIZE)) {
    planned.push({ description: `noise → ${noiseLabel}`, senders: group, addLabel: noiseLabel, removeInbox: true });
  }
  for (const [label, senders] of fileGroups) {
    for (const group of chunk(senders, GROUP_SIZE)) {
      planned.push({ description: `file → ${label}`, senders: group, addLabel: label, removeInbox: true });
    }
  }
  for (const [label, senders] of pinGroups) {
    for (const group of chunk(senders, GROUP_SIZE)) {
      planned.push({ description: `label only → ${label}`, senders: group, addLabel: label, removeInbox: false });
    }
  }

  const pending = uncovered(planned, coverage);
  const skippedSenders =
    planned.reduce((n, p) => n + p.senders.length, 0) - pending.reduce((n, p) => n + p.senders.length, 0);

  /**
   * Undecided and long-tail senders are archived in the backlog but get no filter, so future mail
   * from them still arrives visibly. Auto-hiding unlabelled mail from a sender we could not
   * classify is exactly how something important disappears; if one turns out to be recurring noise,
   * the AI janitor sees it and proposes a real rule. This is the division of labour, not an
   * oversight.
   */
  const unfiltered = plans.filter((p) => p.intent === 'file' && p.label === null);

  console.log(`mode: ${mode}${mode === 'quarantine' ? ' (nothing is deleted; noise lands in Janitor/Quarantine)' : ''}`);
  console.log(`${existing.length} filters already exist, covering ${coverage.size} senders`);
  console.log(`${skippedSenders} senders already filtered exactly this way — skipped`);
  console.log(`${pending.length} filters to create, covering ${pending.reduce((n, p) => n + p.senders.length, 0)} senders`);
  console.log(
    `${unfiltered.length} undecided/long-tail senders get NO filter by design — their backlog is ` +
      `archived but future mail stays visible`,
  );

  reportStaleDestructive(existing, nameById, plans);
  console.log('');

  for (const item of pending) {
    console.log(`  ${apply ? 'creating' : 'would create'}  ${item.description.padEnd(34)} ${item.senders.length} senders`);
    if (!apply) continue;

    const addLabelId = item.addLabel === 'TRASH' ? 'TRASH' : labelIds.get(item.addLabel);
    if (addLabelId === undefined) throw new Error(`Missing label id for ${item.addLabel}`);

    await gmailFetch('/settings/filters', {
      method: 'POST',
      body: {
        criteria: { from: item.senders.join(' OR ') },
        action: {
          addLabelIds: [addLabelId],
          ...(item.removeInbox ? { removeLabelIds: ['INBOX'] } : {}),
        },
      },
    });
  }

  if (pending.length === 0) console.log('  nothing to do — Gmail already matches the rules');
  console.log(apply ? `\n${pending.length} filters created.` : '\nNothing was changed.');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mode = process.argv.includes('--mode=trash') ? 'trash' : 'quarantine';
  console.log(apply ? 'APPLYING filter changes\n' : 'DRY RUN — pass --apply to create filters\n');
  await compile(apply, mode);
}

if (process.argv[1]?.endsWith('filters.ts') === true) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
