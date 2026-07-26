import { ok } from 'node:assert/strict';
import { test } from 'node:test';
import { QuotaBucket } from './gmail.ts';

test('burst is capped at one second of budget, then throttles', async () => {
  const bucket = new QuotaBucket(100);
  const started = Date.now();

  // The initial 100 units are free; the next 100 have to be earned back at 100/sec.
  for (let i = 0; i < 20; i += 1) await bucket.take(5);
  const afterBurst = Date.now() - started;

  for (let i = 0; i < 20; i += 1) await bucket.take(5);
  const afterRefill = Date.now() - started;

  ok(afterBurst < 100, `burst should be immediate, took ${afterBurst}ms`);
  ok(afterRefill >= 900, `second round should wait ~1s, took ${afterRefill}ms`);
});

// The failure this guards against: a 403 means every in-flight worker is over budget, so the
// cooldown must be global. A per-request sleep leaves the other workers pinning the bucket empty.
test('penalize stalls every caller, not just the one that hit the limit', async () => {
  const bucket = new QuotaBucket(1000);
  bucket.penalize(300);

  const started = Date.now();
  await Promise.all([bucket.take(5), bucket.take(5), bucket.take(5)]);
  const elapsed = Date.now() - started;

  ok(elapsed >= 250, `all callers should wait out the cooldown, took ${elapsed}ms`);
});

test('concurrent takers stay within budget', async () => {
  const bucket = new QuotaBucket(100);
  const started = Date.now();

  // 60 units of demand against a 100-unit bucket refilling at 100/sec: the first 100 units clear
  // immediately, the remaining 200 need two more seconds.
  await Promise.all(Array.from({ length: 60 }, () => bucket.take(5)));
  const elapsed = Date.now() - started;

  ok(elapsed >= 1900, `300 units at 100/sec should take ~2s after burst, took ${elapsed}ms`);
});
