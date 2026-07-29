import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoverage, normalizeSender, uncovered, type GmailFilter, type Planned } from './filters.ts';

const NAMES = new Map([
  ['Label_19', 'Filed/Travel'],
  ['Label_27', 'Janitor/Quarantine'],
  ['TRASH', 'TRASH'],
]);

function filter(from: string, addLabelIds: string[], removeInbox = true): GmailFilter {
  return {
    criteria: { from },
    action: { addLabelIds, ...(removeInbox ? { removeLabelIds: ['INBOX'] } : {}) },
  };
}

function plan(senders: string[], addLabel: string, removeInbox = true): Planned {
  return { description: `→ ${addLabel}`, senders, addLabel, removeInbox };
}

// Gmail hands criteria back in whatever shape it was created in. An unnormalised comparison reads a
// covered sender as uncovered and duplicates its filter on every single run.
test('sender criteria normalise across the shapes Gmail returns', () => {
  for (const raw of ['a@b.com', '"a@b.com"', '<a@b.com>', '(a@b.com)', '  A@B.com  ']) {
    equal(normalizeSender(raw), 'a@b.com', raw);
  }
});

test('coverage records what each live filter already does to a sender', () => {
  const coverage = buildCoverage([filter('x@y.com OR "z@y.com"', ['Label_19'])], NAMES);
  deepEqual([...(coverage.get('x@y.com') ?? [])], ['Filed/Travel | skip-inbox']);
  deepEqual([...(coverage.get('z@y.com') ?? [])], ['Filed/Travel | skip-inbox']);
});

// The bug this exists to prevent: Gmail has no upsert, so a second --apply re-POSTed the entire
// plan and duplicated every filter in the account.
test('a second run creates nothing when Gmail already matches the plan', () => {
  const live = [filter('x@y.com OR z@y.com', ['Label_19'])];
  const coverage = buildCoverage(live, NAMES);
  deepEqual(uncovered([plan(['x@y.com', 'z@y.com'], 'Filed/Travel')], coverage), []);
});

test('only the senders Gmail is missing are re-created', () => {
  const coverage = buildCoverage([filter('x@y.com', ['Label_19'])], NAMES);
  const pending = uncovered([plan(['x@y.com', 'new@y.com'], 'Filed/Travel')], coverage);
  deepEqual(pending.map((p) => p.senders), [['new@y.com']]);
});

// Coverage is per sender, not per group, so re-chunking must not resurrect covered senders. A
// group-level check degrades to "create everything" the moment one sender is added or removed.
test('regrouping the same senders still creates nothing', () => {
  const coverage = buildCoverage([filter('a@y.com OR b@y.com OR c@y.com', ['Label_19'])], NAMES);
  const regrouped = [plan(['a@y.com'], 'Filed/Travel'), plan(['b@y.com', 'c@y.com'], 'Filed/Travel')];
  deepEqual(uncovered(regrouped, coverage), []);
});

// Presence alone is not coverage. A sender already filed under Travel must still get its
// quarantine filter, or a rule change would silently never take effect.
test('the same sender under a different action is not treated as covered', () => {
  const coverage = buildCoverage([filter('x@y.com', ['Label_19'])], NAMES);

  const differentLabel = uncovered([plan(['x@y.com'], 'Janitor/Quarantine')], coverage);
  deepEqual(differentLabel.map((p) => p.senders), [['x@y.com']], 'different label');

  const differentInbox = uncovered([plan(['x@y.com'], 'Filed/Travel', false)], coverage);
  deepEqual(differentInbox.map((p) => p.senders), [['x@y.com']], 'same label, stays in inbox');
});
