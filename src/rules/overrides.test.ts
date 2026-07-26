import { equal } from 'node:assert/strict';
import { test } from 'node:test';
import { classify, labelFor, type SenderStats } from '../report/classify.ts';
import { categorize } from './categories.ts';

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
// message "Filed/Accounts" is both wrong and quietly insulting.
test('people are never filed or labelled', () => {
  for (const email of ['redacted-person-1@example.com', 'redacted-person-2@example.com', 'redacted-person-5@example.com', 'redacted-person-7@example.com']) {
    equal(classify(sender(email)).tier, 'E_NEVER_TOUCH', email);
    equal(labelFor(sender(email)), null, email);
  }
  equal(labelFor(sender('someone@biggerpockets.com', { contacted: true })), null, 'contacted senders lose the label');
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
