import { equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { assertManaged, categorize, isManagedLabel, maySkipInbox } from './categories.ts';

test('senders map to their category', () => {
  equal(categorize('shipment-tracking@amazon.com', 'amazon.com'), 'shopping');
  equal(categorize('express@airbnb.com', 'airbnb.com'), 'travel');
  equal(categorize('alerts@tdbank.com', 'tdbank.com'), 'money');
  equal(categorize('notify@condocontrol.com', 'condocontrol.com'), 'home');
  equal(categorize('noreply@discord.com', 'discord.com'), 'accounts');
  equal(categorize('someone@unknown-domain.test', 'unknown-domain.test'), null);
});

test('subdomains inherit their parent domain', () => {
  equal(categorize('capitalone@notification.capitalone.com', 'notification.capitalone.com'), 'money');
  equal(categorize('no-reply@services.discover.com', 'services.discover.com'), 'money');
});

// Ordering is load-bearing: health.amazon.com sits inside amazon.com, and Apple's card and savings
// senders sit inside a domain otherwise classed as accounts.
test('narrow rules beat the broad domains they carve out of', () => {
  equal(categorize('hello@email.health.amazon.com', 'email.health.amazon.com'), 'health');
  equal(categorize('no_reply@post.applecard.apple', 'post.applecard.apple'), 'money');
  equal(categorize('no_reply@email.apple.com', 'email.apple.com'), 'accounts');
});

// Record-keeping files itself. Filed/Money was 918 backlog messages of which only 42 were
// alert-shaped; keeping the category visible cost 876 messages to protect 42.
test('routine mail files itself in every category', () => {
  equal(maySkipInbox('shopping', 'Delivered: 1 item'), true);
  equal(maySkipInbox('travel', 'Your reservation is confirmed'), true);
  equal(maySkipInbox('money', 'Your order has been executed'), true);
  equal(maySkipInbox('money', "We've received your payment"), true);
  equal(maySkipInbox('health', 'Here is your new Health Statement'), true);
});

// Real subjects pulled from the scan that must not disappear into a label.
test('money going wrong still reaches the inbox', () => {
  for (const subject of [
    'Sign-in attempt from new device',
    'It looks like you were charged twice',
    "Sorry, your automatic statement credit wasn't processed",
    'Overdue: Invoice 170401 from Pruzansky Plumbing',
    'Request to share your TD account data',
    'Action required to complete your pending deposit',
  ]) {
    equal(maySkipInbox('money', subject), false, subject);
  }
});

// Building notices are same-day consequential but never phrased as alerts, so the urgency filter
// has to know the vocabulary of things breaking in a building.
test('service interruptions reach the inbox despite calm wording', () => {
  for (const subject of [
    'Water Shutdown Reminder - Rialto & Capitol',
    'Updated Pest Control Schedule: Monday July 14',
    'Capitol HVAC Shutdown Notice - Water Loop System Issue',
    'Jersey City Travel & Road Closure Notice',
    'Important Community Parking Update',
    'Weather Alert - June 22',
  ]) {
    equal(maySkipInbox('home', subject), false, subject);
  }
});

// The asymmetry that matters: a delayed receipt costs nothing, an unseen fraud alert costs a lot.
test('urgent subjects never skip the inbox, whatever the category', () => {
  equal(maySkipInbox('shopping', 'Security alert: new device'), false);
  equal(maySkipInbox('accounts', 'Your password reset request'), false);
  equal(maySkipInbox('travel', 'Action required: flight cancelled'), false);
  equal(maySkipInbox('accounts', 'Your subscription is expiring'), false);
});

// Years of hand-filed mail live in labels this tool must never be able to reach.
test('only the machine-managed namespace may be modified', () => {
  equal(isManagedLabel('Filed/Shopping'), true);
  equal(isManagedLabel('Janitor/Quarantine'), true);
  equal(isManagedLabel('Receipts'), false);
  equal(isManagedLabel('2024 Taxes'), false);

  assertManaged(['Filed/Money', 'Janitor/Unsubscribe']);
  throws(() => assertManaged(['Filed/Money', 'Land']), /outside the managed namespace: Land/);
});
