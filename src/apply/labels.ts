/**
 * Creates the machine-managed labels. Touches no mail — the safest step in the whole project.
 *
 * Run: npm run apply:labels [-- --apply]
 */
import 'dotenv/config';
import { gmailFetch } from '../scan/gmail.ts';
import { CATEGORIES, QUARANTINE_LABEL, UNSUBSCRIBE_LABEL, assertManaged, type Category } from '../rules/categories.ts';

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

export async function listLabels(): Promise<GmailLabel[]> {
  const response = await gmailFetch<{ labels?: GmailLabel[] }>('/labels');
  return response.labels ?? [];
}

/** Every label this project needs to exist. */
export function desiredLabels(): string[] {
  const categories = (Object.keys(CATEGORIES) as Category[]).map((key) => CATEGORIES[key].label);
  return [...categories, QUARANTINE_LABEL, UNSUBSCRIBE_LABEL];
}

export async function ensureLabels(apply: boolean): Promise<Map<string, string>> {
  const desired = desiredLabels();
  // Cannot create a label outside Filed/ or Janitor/, by construction rather than by convention.
  assertManaged(desired);

  const existing = await listLabels();
  const byName = new Map(existing.map((label) => [label.name, label.id]));
  const missing = desired.filter((name) => !byName.has(name));

  console.log(`${existing.length} labels in the account, ${existing.filter((l) => l.type === 'user').length} user-created`);
  console.log(`${desired.length} needed, ${missing.length} missing\n`);

  for (const name of missing) {
    if (!apply) {
      console.log(`  would create  ${name}`);
      continue;
    }
    const created = await gmailFetch<GmailLabel>('/labels', {
      method: 'POST',
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    byName.set(name, created.id);
    console.log(`  created  ${name}`);
  }

  for (const name of desired.filter((n) => byName.has(n) && !missing.includes(n))) {
    console.log(`  exists   ${name}`);
  }

  return byName;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'APPLYING label changes\n' : 'DRY RUN — pass --apply to create labels\n');
  await ensureLabels(apply);
  console.log(apply ? '\nLabels ready.' : '\nNothing was changed.');
}

if (process.argv[1]?.endsWith('labels.ts') === true) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
