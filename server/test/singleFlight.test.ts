import { test } from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../src/singleFlight.js';

// v0.69.0 — guards the cold-start stampede fix. These three properties are the
// whole contract: coalesce concurrent callers, re-run after settle, and clear the
// slot on failure so a transient error doesn't wedge the cache forever.

test('coalesces concurrent callers onto ONE execution', async () => {
  const sf = singleFlight<number>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const fn = async () => { calls++; await gate; return 42; };
  // three callers arrive while the first is still in flight
  const p1 = sf.run(fn);
  const p2 = sf.run(fn);
  const p3 = sf.run(fn);
  assert.equal(sf.inFlight(), true);
  release();
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1, 'fn executed exactly once for 3 concurrent callers');
  assert.deepEqual([a, b, c], [42, 42, 42], 'all callers see the same result');
  assert.equal(sf.inFlight(), false, 'slot cleared once settled');
});

test('re-executes after the prior flight settles', async () => {
  const sf = singleFlight<number>();
  let calls = 0;
  const fn = async () => { calls++; return calls; };
  assert.equal(await sf.run(fn), 1);
  assert.equal(await sf.run(fn), 2, 'a sequential (post-settle) call runs again — not a permanent memo');
  assert.equal(calls, 2);
});

test('clears the slot on rejection so the next call retries', async () => {
  const sf = singleFlight<number>();
  let calls = 0;
  const fn = async () => { calls++; if (calls === 1) throw new Error('boom'); return calls; };
  await assert.rejects(() => sf.run(fn), /boom/);
  assert.equal(sf.inFlight(), false, 'slot cleared after a throw');
  assert.equal(await sf.run(fn), 2, 'next call retries after a failed flight');
});

test('v0.73.0 — 3 concurrent callers onto a REJECTING flight all receive the rejection; slot clears', async () => {
  // The rejection counterpart to the concurrent-coalescing happy path: when the single
  // in-flight computation throws, callers 2..N (who shared it) must each see that same
  // rejection — not a silently-swallowed error or a hang — and the slot must clear so the
  // next cold cycle can retry. fn runs exactly once for all three.
  const sf = singleFlight<number>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const fn = async () => { calls++; await gate; throw new Error('boom'); };
  const p1 = sf.run(fn);
  const p2 = sf.run(fn);
  const p3 = sf.run(fn);
  assert.equal(sf.inFlight(), true, 'all three are queued onto one in-flight computation');
  release();
  // Each of the three concurrent callers receives the rejection.
  const results = await Promise.allSettled([p1, p2, p3]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.match(String((r as PromiseRejectedResult).reason?.message ?? ''), /boom/);
  }
  assert.equal(calls, 1, 'fn executed exactly once for 3 concurrent callers, even on rejection');
  assert.equal(sf.inFlight(), false, 'slot cleared after the shared flight rejected');
});
