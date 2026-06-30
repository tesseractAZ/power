import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogCoalescer } from '../src/logCoalesce.js';

// v0.76.0 — guards the duplicate-line storm suppression used by the MQTT
// reconnect/error handler. The contract: first occurrence logs, identical
// repeats are swallowed, a periodic roll-up carries the count, distinct lines
// each coalesce independently, and flush() emits the tail + re-arms.

function harness(opts: Parameters<typeof makeLogCoalescer>[1] = {}) {
  const lines: string[] = [];
  let clock = 0;
  const c = makeLogCoalescer((m) => lines.push(m), { now: () => clock, ...opts });
  return { lines, advance: (ms: number) => { clock += ms; }, c };
}

test('logs the first occurrence and suppresses identical repeats', () => {
  const { lines, c } = harness({ summaryWindowMs: 60_000 });
  c.log('mqtt: error EAI_AGAIN');
  c.log('mqtt: error EAI_AGAIN');
  c.log('mqtt: error EAI_AGAIN');
  assert.deepEqual(lines, ['mqtt: error EAI_AGAIN'], 'only the first of three identical lines is emitted');
});

test('emits a roll-up summary once the window elapses', () => {
  const { lines, advance, c } = harness({ summaryWindowMs: 60_000 });
  c.log('mqtt: error EAI_AGAIN'); // first → logged
  for (let i = 0; i < 513; i++) { advance(1_000); c.log('mqtt: error EAI_AGAIN'); } // ~513s of repeats
  // At least one roll-up should have fired carrying a suppressed count.
  const summaries = lines.filter((l) => /more in last/.test(l));
  assert.ok(summaries.length >= 1, 'a summary line is emitted while the storm continues');
  assert.match(summaries[0], /mqtt: error EAI_AGAIN : \d+ more in last/);
});

test('distinct messages coalesce independently (interleaved reconnect cycle)', () => {
  const { lines, c } = harness({ summaryWindowMs: 60_000 });
  // The real MQTT storm interleaves three distinct lines in a loop.
  for (let i = 0; i < 5; i++) {
    c.log('mqtt: reconnecting');
    c.log('mqtt: connection closed');
    c.log('mqtt: error EAI_AGAIN');
  }
  // Each distinct line logs exactly once (its first sighting); the rest suppress.
  assert.deepEqual(lines, ['mqtt: reconnecting', 'mqtt: connection closed', 'mqtt: error EAI_AGAIN']);
});

test('flush emits the pending tail and re-arms keys', () => {
  const { lines, c } = harness({ summaryWindowMs: 60_000 });
  c.log('mqtt: error EAI_AGAIN');
  c.log('mqtt: error EAI_AGAIN');
  c.log('mqtt: error EAI_AGAIN');
  c.flush(); // recovery: emit the suppressed tail
  const tail = lines.filter((l) => /more in last/.test(l));
  assert.equal(tail.length, 1, 'flush emits exactly one summary for the suppressed repeats');
  assert.match(tail[0], /: 2 more in last/);
  // After flush, the same message logs fresh (state was re-armed).
  c.log('mqtt: error EAI_AGAIN');
  assert.equal(lines.filter((l) => l === 'mqtt: error EAI_AGAIN').length, 2, 're-armed: first post-flush sighting logs again');
});

test('flush is a no-op when nothing was suppressed', () => {
  const { lines, c } = harness();
  c.log('mqtt: connected');
  c.flush();
  assert.deepEqual(lines, ['mqtt: connected'], 'no spurious summary when there were no duplicates');
});
