import { equal } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classify, labelFor, type SenderStats } from '../report/classify.ts';
import { categorize } from './categories.ts';
import { OVERRIDES, findOverrideIn, parsePrivateOverrides, type Override } from './overrides.ts';

function sender(email: string, extra: Partial<SenderStats> = {}): SenderStats {
  const domain = email.split('@')[1] ?? '';
  return {
    email,
    domain,
    displayName: null,
    total: 20,
    inInbox: 20,
    unread: 19,
    starred: 0,
    important: 0,
    last90: 5,
    lastReceived: 0,
    bulk: true,
    hasUnsubLink: true,
    oneClickUnsub: true,
    contacted: false,
    sampleSubjects: ['a routine update'],
    ...extra,
  };
}

test('reviewed trash decisions beat every heuristic', () => {
  for (const email of [
    'updates-noreply@linkedin.com',
    'unitedairlines@enews.united.com',
    'store-news@amazon.com',
    'robots@dbrand.com',
    'members@maharajaclub.airindia.com',
    'noreply@discord.com',
    'carfax@carcare.no-reply.carfax.com',
  ]) {
    equal(classify(sender(email)).tier, 'B_UNSUBSCRIBE', email);
  }
});

// Explicitly requested: this sender has been emailed, which normally makes it untouchable.
test('a reviewed trash decision overrides the you-emailed-them allowlist', () => {
  equal(classify(sender('support@paintingbynumbersshop.com', { contacted: true })).tier, 'B_UNSUBSCRIBE');
});

test('reviewed keep decisions survive low engagement', () => {
  equal(classify(sender('honda_service@em.honda.com')).tier, 'E_NEVER_TOUCH');
  equal(classify(sender('thebatch@deeplearning.ai')).tier, 'E_NEVER_TOUCH');
});

// Colleagues and family mail from domains that also send automated notices. Labelling a person's
// message "Filed/Accounts" is both wrong and quietly insulting. The addresses themselves live in
// data/private-overrides.json, so this asserts the mechanism against a synthetic stand-in.
test('people are never filed or labelled', () => {
  const person: Override = { emails: ['a.colleague@example.com'], action: 'keep', category: null };
  const match = findOverrideIn([person, ...OVERRIDES], 'a.colleague@example.com', 'example.com');
  equal(match?.action, 'keep');
  equal(match?.category, null);
  equal(labelFor(sender('someone@biggerpockets.com', { contacted: true })), null, 'contacted senders lose the label');
});

// The private file is loaded ahead of the public ledger for exactly this reason: a domain rule
// below would otherwise claim a human correspondent before the People entry was ever consulted.
test('private entries outrank the public ledger', () => {
  const asPerson: Override = { emails: ['messages-noreply@linkedin.com'], action: 'keep', category: null };
  equal(findOverrideIn(OVERRIDES, 'messages-noreply@linkedin.com', 'linkedin.com')?.category, 'social');
  equal(findOverrideIn([asPerson, ...OVERRIDES], 'messages-noreply@linkedin.com', 'linkedin.com')?.category, null);
});

// A dropped entry here silently unprotects a person, so a malformed file must never parse to "none".
test('the private overrides template is valid', () => {
  const raw = readFileSync(new URL('../../data/private-overrides.example.json', import.meta.url), 'utf8');
  const entries = parsePrivateOverrides(raw);
  equal(entries.length > 0, true);
  equal(entries[0]?.action, 'keep');
});

test('sibling addresses on one domain can take different labels', () => {
  equal(labelFor(sender('customerservice@ezpassnj.com')), 'travel');
  equal(labelFor(sender('no-reply.emessage@ezpassnj.com')), 'accounts');
  equal(labelFor(sender('dentalplus1@optimum.net')), 'health');
  equal(labelFor(sender('ebill@ebill.optimum.net')), 'home');
  equal(labelFor(sender('messages-noreply@linkedin.com')), 'social');
});

test('new categories route correctly', () => {
  equal(labelFor(sender('noreply@resy.com')), 'dining');
  equal(labelFor(sender('no-reply@opentable.com')), 'dining');
  equal(labelFor(sender('no_reply@snapchat.com')), 'social');
  equal(labelFor(sender('friendupdates@facebookmail.com')), 'social');
});

// One address carries both ride receipts and food orders; only the subject separates them.
test('uber splits by subject', () => {
  equal(categorize('noreply@uber.com', 'uber.com', 'Your Friday evening order with Uber Eats'), 'dining');
  equal(categorize('noreply@uber.com', 'uber.com', 'Your Thursday morning trip with Uber'), 'travel');
});

test('newsletters are labelled but stay in the inbox for mega-newsletter to digest', () => {
  equal(labelFor(sender('dan@tldrnewsletter.com')), 'newsletters');
  equal(labelFor(sender('crew@morningbrew.com')), 'newsletters');
  equal(labelFor(sender('thebatch@deeplearning.ai')), 'newsletters');
});

test('reviewed category corrections apply', () => {
  equal(labelFor(sender('do-not-reply@sv3.us')), 'accounts');
  equal(labelFor(sender('contact_us@emails.amfam.com')), 'home');
  equal(labelFor(sender('connecthome@emails.connectbyamfam.com')), 'accounts');
  equal(labelFor(sender('labcorppatient@labcorpservicemessage.com')), 'health');
  equal(labelFor(sender('the-elves@elfster.com')), 'shopping');
  equal(labelFor(sender('support@betterment.com')), 'money');
  equal(labelFor(sender('etickets@amtrak.com')), 'travel');
});
