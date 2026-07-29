import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { classify, type SenderStats } from './classify.ts';
import { parseAddress, parseAddressList } from '../scan/headers.ts';

const bulkUnread: SenderStats = {
  email: 'promo@shop.example',
  domain: 'shop.example',
  displayName: 'Shop',
  total: 40,
  inInbox: 40,
  unread: 39,
  starred: 0,
  important: 0,
  last90: 12,
  lastReceived: 0,
  bulk: true,
  hasUnsubLink: true,
  oneClickUnsub: true,
  contacted: false,
  sampleSubjects: ['50% off everything'],
};

test('bulk mail you never open is filterable', () => {
  equal(classify(bulkUnread).tier, 'B_UNSUBSCRIBE');
  equal(classify({ ...bulkUnread, hasUnsubLink: false }).tier, 'A_AUTO_TRASH');
});

// Every one of these must beat the "you never read it" evidence. A false keep costs one email;
// a false delete can cost a password reset, a fraud alert, or a tax document.
test('allowlist signals override deletion evidence', () => {
  for (const override of [
    { contacted: true },
    { email: 'alerts@chase.com', domain: 'chase.com' },
    { email: 'no-reply@irs.gov', domain: 'irs.gov' },
    { sampleSubjects: ['Your verification code'] },
  ]) {
    equal(classify({ ...bulkUnread, ...override }).tier, 'E_NEVER_TOUCH', JSON.stringify(override));
  }
});

// Brand hostnames glue words together, and \b only fires against a non-word character — so the
// bounded patterns skipped the account owner's own bank and health insurer while matching the
// tidily-punctuated examples that made them look correct.
test('critical senders are matched inside glued hostnames', () => {
  for (const [email, domain] of [
    ['uhc@benefits.unitedhealthcare.com', 'benefits.unitedhealthcare.com'],
    ['estatement@bankofbaroda.com', 'bankofbaroda.com'],
    ['mail@em.citizensbank.com', 'em.citizensbank.com'],
    ['statements@mail.synchronybank.com', 'mail.synchronybank.com'],
    ['dental_plus1.sr@e.smilereminder.com', 'e.smilereminder.com'],
    ['no-reply@solvhealth.com', 'solvhealth.com'],
  ] as const) {
    equal(classify({ ...bulkUnread, email, domain }).tier, 'E_NEVER_TOUCH', email);
  }
});

// The other half of the same rule: loosening the boundary must not protect ordinary senders that
// merely contain these letters. `purchase` is the one that would hurt most — it is on every receipt.
test('glued matching does not protect senders that merely contain the letters', () => {
  for (const [email, domain] of [
    ['purchases@shop.example', 'shop.example'],
    ['no-reply@electricity.example', 'electricity.example'],
    ['courtesy@shop.example', 'shop.example'],
    ['deals@pinstripe.example', 'pinstripe.example'],
    ['stay@hospitality.hilton.example', 'hospitality.hilton.example'],
  ] as const) {
    equal(classify({ ...bulkUnread, email, domain }).tier, 'B_UNSUBSCRIBE', email);
  }
});

// One star out of forty means "I saved one thing", not "never filter this sender". Treating it as
// the latter shielded 49 senders and 414 inbox messages behind a single star.
test('stars protect a sender only as a pattern, not as a single instance', () => {
  equal(classify({ ...bulkUnread, starred: 1 }).tier, 'B_UNSUBSCRIBE', 'one star out of 40');
  equal(classify({ ...bulkUnread, starred: 3 }).tier, 'E_NEVER_TOUCH', 'three stars is a habit');
  equal(classify({ ...bulkUnread, total: 10, unread: 10, starred: 2 }).tier, 'E_NEVER_TOUCH', '20% starred');
});

// 265 of 325 review-tier senders had fewer than 3 messages — a long tail that buried the ~60
// senders actually worth a decision.
test('long-tail senders are separated from the real review set', () => {
  equal(classify({ ...bulkUnread, total: 2, unread: 2 }).tier, 'L_LOW_VOLUME');
  equal(classify({ ...bulkUnread, bulk: false, total: 1, unread: 1 }).tier, 'L_LOW_VOLUME');
});

// A delete filter here would silently break the daily digest with no error surfaced anywhere.
test('mega-newsletter sources are protected', () => {
  equal(classify({ ...bulkUnread, email: 'crew@morningbrew.com', domain: 'morningbrew.com' }).tier, 'E_NEVER_TOUCH');
  equal(classify({ ...bulkUnread, email: 'anyone@tldrnewsletter.com', domain: 'tldrnewsletter.com' }).tier, 'E_NEVER_TOUCH');
});

test('transactional mail is archived, never deleted', () => {
  const receipts = { ...bulkUnread, bulk: false, sampleSubjects: ['Your order has shipped'] };
  equal(classify(receipts).tier, 'C_ARCHIVE');
});

test('weak evidence defers instead of guessing', () => {
  equal(classify({ ...bulkUnread, unread: 4 }).tier, 'D_REVIEW', 'bulk but actually read');
  equal(classify({ ...bulkUnread, bulk: false, total: 8, unread: 8 }).tier, 'D_REVIEW', 'no bulk signal');
});

test('address headers parse', () => {
  equal(parseAddress('"Brew, Morning" <crew@morningbrew.com>')?.email, 'crew@morningbrew.com');
  equal(parseAddress('No Reply <NoReply@Example.COM>')?.email, 'noreply@example.com');
  equal(parseAddress('plain@example.com')?.email, 'plain@example.com');
  equal(parseAddress('garbage'), null);
  deepEqual(parseAddressList('"Doe, John" <a@x.com>, b@y.com, Bad'), ['a@x.com', 'b@y.com']);
});
