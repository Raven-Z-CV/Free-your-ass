import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/ratelimit.js';

test('over-the-limit within an hour is denied; recovers across the window', () => {
  let t = 1_000_000;
  const rl = new RateLimiter({ perHour: 3, now: () => t });
  assert.equal(rl.allow().ok, true);
  assert.equal(rl.allow().ok, true);
  assert.equal(rl.allow().ok, true);
  const denied = rl.allow();
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /rate limit/);

  t += 3600e3 + 1; // past one hour, window slides and recovers
  assert.equal(rl.allow().ok, true);
});

test('old records are evicted and do not occupy the current window', () => {
  let t = 1_000_000;
  const rl = new RateLimiter({ perHour: 1, now: () => t });
  assert.equal(rl.allow().ok, true);
  assert.equal(rl.allow().ok, false);
  t += 2 * 3600e3;
  assert.equal(rl.allow().ok, true);
});

test('default 10 mails/hour', () => {
  let t = 1_000_000;
  const rl = new RateLimiter({ now: () => t });
  let sent = 0;
  while (rl.allow().ok) sent++;
  assert.equal(sent, 10);
});
