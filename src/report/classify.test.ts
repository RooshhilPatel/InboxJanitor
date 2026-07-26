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
    { starred: 2 },
    { email: 'alerts@chase.com', domain: 'chase.com' },
    { email: 'no-reply@irs.gov', domain: 'irs.gov' },
    { sampleSubjects: ['Your verification code'] },
  ]) {
    equal(classify({ ...bulkUnread, ...override }).tier, 'E_NEVER_TOUCH', JSON.stringify(override));
  }
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
  equal(classify({ ...bulkUnread, total: 2, unread: 2 }).tier, 'D_REVIEW', 'too few messages');
});

test('address headers parse', () => {
  equal(parseAddress('"Brew, Morning" <crew@morningbrew.com>')?.email, 'crew@morningbrew.com');
  equal(parseAddress('No Reply <NoReply@Example.COM>')?.email, 'noreply@example.com');
  equal(parseAddress('plain@example.com')?.email, 'plain@example.com');
  equal(parseAddress('garbage'), null);
  deepEqual(parseAddressList('"Doe, John" <a@x.com>, b@y.com, Bad'), ['a@x.com', 'b@y.com']);
});
