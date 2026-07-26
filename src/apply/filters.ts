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
import { ensureLabels } from './labels.ts';
import { loadSenderPlans, type SenderPlan } from './senders.ts';
import { CATEGORIES, QUARANTINE_LABEL } from '../rules/categories.ts';
import { MEGA_NEWSLETTER_PROTECTED, MEGA_NEWSLETTER_PROTECTED_DOMAINS } from '../report/classify.ts';

/** Senders per filter. Gmail rejects very long criteria, and small groups keep diffs readable. */
const GROUP_SIZE = 20;

interface GmailFilter {
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
  const existingFrom = new Set(
    existing.flatMap((f) => (f.criteria?.from ?? f.criteria?.query ?? '').split(/\s+OR\s+/)),
  );

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

  interface Planned {
    description: string;
    senders: string[];
    addLabel: string;
    removeInbox: boolean;
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

  const alreadyCovered = planned.filter((p) => p.senders.every((s) => existingFrom.has(s))).length;

  /**
   * Undecided and long-tail senders are archived in the backlog but get no filter, so future mail
   * from them still arrives visibly. Auto-hiding unlabelled mail from a sender we could not
   * classify is exactly how something important disappears; if one turns out to be recurring noise,
   * the AI janitor sees it and proposes a real rule. This is the division of labour, not an
   * oversight.
   */
  const unfiltered = plans.filter((p) => p.intent === 'file' && p.label === null);

  console.log(`mode: ${mode}${mode === 'quarantine' ? ' (nothing is deleted; noise lands in Janitor/Quarantine)' : ''}`);
  console.log(`${existing.length} filters already exist, ${alreadyCovered} planned groups look already covered`);
  console.log(`${planned.length} filters to create, covering ${planned.reduce((n, p) => n + p.senders.length, 0)} senders`);
  console.log(
    `${unfiltered.length} undecided/long-tail senders get NO filter by design — their backlog is ` +
      `archived but future mail stays visible\n`,
  );

  for (const item of planned) {
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

  console.log(apply ? `\n${planned.length} filters created.` : '\nNothing was changed.');
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
