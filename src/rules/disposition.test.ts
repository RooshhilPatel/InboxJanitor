import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { dispositionFor, type MessageFacts } from './disposition.ts';
import type { SenderStats } from '../report/classify.ts';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const CONFIG = { archiveAfterDays: 180, now: NOW };

function sender(email: string, extra: Partial<SenderStats> = {}): SenderStats {
  return {
    email,
    domain: email.split('@')[1] ?? '',
    displayName: null,
    total: 20,
    inInbox: 20,
    unread: 19,
    starred: 0,
    important: 0,
    last90: 5,
    lastReceived: NOW,
    bulk: true,
    hasUnsubLink: true,
    oneClickUnsub: true,
    contacted: false,
    sampleSubjects: ['a routine update'],
    ...extra,
  };
}

function message(extra: Partial<MessageFacts> = {}): MessageFacts {
  return { subject: 'a routine update', receivedAt: NOW - DAY, unread: true, starred: false, ...extra };
}

// The case that motivated this module: "label it Money, but I still want to see it" cannot be
// expressed by a category alone, because Filed/Money files by default.
test('a pinned sender keeps its label but stays in the inbox', () => {
  const d = dispositionFor(sender('subscriptions@subscriptions.treas.gov'), message(), CONFIG);
  deepEqual({ action: d.action, label: d.label }, { action: 'inbox', label: 'money' });
});

test('stars outrank every other rule', () => {
  const d = dispositionFor(sender('robots@dbrand.com'), message({ starred: true }), CONFIG);
  equal(d.action, 'inbox');
});

test('reviewed noise is trashed and never labelled', () => {
  const d = dispositionFor(sender('robots@dbrand.com'), message(), CONFIG);
  deepEqual({ action: d.action, label: d.label }, { action: 'trash', label: null });
});

test('stale unread building notices are trashed, fresh ones are not', () => {
  const stale = dispositionFor(
    sender('notify@condocontrol.com'),
    message({ receivedAt: NOW - 40 * DAY, subject: 'Movie Night Saturday' }),
    CONFIG,
  );
  equal(stale.action, 'trash');

  const fresh = dispositionFor(
    sender('notify@condocontrol.com'),
    message({ receivedAt: NOW - 5 * DAY, subject: 'Movie Night Saturday' }),
    CONFIG,
  );
  equal(fresh.action, 'file');

  const read = dispositionFor(
    sender('notify@condocontrol.com'),
    message({ receivedAt: NOW - 40 * DAY, unread: false, subject: 'Movie Night Saturday' }),
    CONFIG,
  );
  equal(read.action, 'file', 'read mail is kept — the rule is about mail you ignored');
});

test('urgent subjects override filing', () => {
  const routine = dispositionFor(sender('alerts@tdbank.com'), message({ subject: 'Your statement is ready' }), CONFIG);
  equal(routine.action, 'file');

  const urgent = dispositionFor(sender('alerts@tdbank.com'), message({ subject: 'Security alert: new device' }), CONFIG);
  equal(urgent.action, 'inbox');
  equal(urgent.label, 'money', 'still labelled, just not hidden');
});

// A heuristic guess that a sender matters is not a request to pin it forever.
test('protected senders keep recent mail visible but age out', () => {
  const person = sender('someone@example.test', { contacted: true, bulk: false });
  equal(dispositionFor(person, message({ receivedAt: NOW - 10 * DAY }), CONFIG).action, 'inbox');
  equal(dispositionFor(person, message({ receivedAt: NOW - 200 * DAY }), CONFIG).action, 'file');
});

// Unlike heuristic protection, an explicit keep is permanent.
test('explicitly pinned senders never age out', () => {
  const d = dispositionFor(sender('honda_service@em.honda.com'), message({ receivedAt: NOW - 900 * DAY }), CONFIG);
  equal(d.action, 'inbox');
});

test('newsletters stay in the inbox for mega-newsletter to digest', () => {
  const d = dispositionFor(sender('dan@tldrnewsletter.com'), message({ subject: 'TLDR daily' }), CONFIG);
  deepEqual({ action: d.action, label: d.label }, { action: 'inbox', label: 'newsletters' });
});
