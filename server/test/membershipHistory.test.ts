import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyHistory, recordMembership, membershipVerdict, membershipAt,
  loadMembershipHistory, saveMembershipHistory, MEMBERSHIP_HISTORY_MAX,
} from '../src/membershipHistory.js';

/**
 * v1.103.0 — a timestamped record of which DPUs were in the backup pool.
 *
 * Two engines resolved membership ONCE from the live snapshot and applied it
 * across a historical window. After the 2026-08-20 swap that made
 * `computeLocalPackRte` accumulate 77,218 Wh in against 92,676 Wh out — a
 * round-trip "efficiency" of 1.20, impossible, because the two legs of the same
 * day were measured over different sets of batteries.
 *
 * Neither could be fixed by reasoning about the CURRENT roster; the missing
 * information was WHEN membership changed.
 */

const DAY = 86_400_000;
const T = Date.UTC(2026, 7, 20, 7, 0, 0);

test('recordMembership is idempotent — a stable roster appends exactly one entry', () => {
  const h = emptyHistory();
  assert.equal(recordMembership(h, 'A,B,C', T), true, 'first observation records');
  assert.equal(recordMembership(h, 'A,B,C', T + 3_600_000), false, 'unchanged: no-op');
  assert.equal(recordMembership(h, 'A,B,C', T + 7_200_000), false);
  assert.equal(h.entries.length, 1);
});

test('recordMembership NEVER records an empty fingerprint (an unreadable panel is not a change)', () => {
  const h = emptyHistory();
  recordMembership(h, 'A,B,C', T);
  assert.equal(recordMembership(h, '', T + DAY), false, 'panel cloud-dark must not look like a reconfiguration');
  assert.equal(h.entries.length, 1);
  assert.equal(recordMembership(h, 'A,B,C', T + 2 * DAY), false, 'and the roster is still considered unchanged');
});

test('membershipVerdict — stable, changed, and the honest unknown', () => {
  const h = emptyHistory();
  recordMembership(h, 'A,B,C', T);
  recordMembership(h, 'A,B,E', T + 5 * DAY);          // the swap

  assert.equal(membershipVerdict(h, T + DAY, T + 2 * DAY), 'stable', 'window inside one membership');
  assert.equal(membershipVerdict(h, T + 4 * DAY, T + 6 * DAY), 'changed', 'window spans the swap');
  assert.equal(membershipVerdict(h, T + 6 * DAY, T + 7 * DAY), 'stable', 'window after the swap');
  assert.equal(membershipVerdict(h, T - DAY, T + DAY), 'unknown',
    'window starts before anything was recorded — must NOT be reported as stable');
  assert.equal(membershipVerdict(emptyHistory(), T, T + DAY), 'unknown', 'no record at all');
});

test('membershipVerdict — a change exactly AT the window start does not taint that window', () => {
  const h = emptyHistory();
  recordMembership(h, 'A,B,C', T);
  recordMembership(h, 'A,B,E', T + 5 * DAY);
  // The new membership is in force for the whole of the following day.
  assert.equal(membershipVerdict(h, T + 5 * DAY, T + 6 * DAY), 'stable');
});

test('membershipAt — resolves the roster in force, and null before the record begins', () => {
  const h = emptyHistory();
  recordMembership(h, 'A,B,C', T);
  recordMembership(h, 'A,B,E', T + 5 * DAY);
  assert.equal(membershipAt(h, T + DAY), 'A,B,C');
  assert.equal(membershipAt(h, T + 6 * DAY), 'A,B,E');
  assert.equal(membershipAt(h, T - DAY), null, 'never invent a roster we did not observe');
});

test('persistence round-trips, sorts by time, and drops malformed entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memhist-'));
  const path = join(dir, 'membership-history.json');
  const h = emptyHistory();
  recordMembership(h, 'A,B,C', T);
  recordMembership(h, 'A,B,E', T + 5 * DAY);
  saveMembershipHistory(path, h);

  const back = loadMembershipHistory(path);
  assert.deepEqual(back.entries.map((e) => e.fp), ['A,B,C', 'A,B,E']);
  assert.equal(membershipVerdict(back, T + 4 * DAY, T + 6 * DAY), 'changed', 'survives a restart');

  assert.deepEqual(loadMembershipHistory(join(dir, 'nope.json')).entries, [], 'missing file');
});

test('history is capped so a flapping roster cannot grow the file without bound', () => {
  const h = emptyHistory();
  for (let i = 0; i < MEMBERSHIP_HISTORY_MAX + 20; i++) recordMembership(h, `FP-${i}`, T + i * 1000);
  assert.equal(h.entries.length, MEMBERSHIP_HISTORY_MAX);
  assert.equal(h.entries[h.entries.length - 1].fp, `FP-${MEMBERSHIP_HISTORY_MAX + 19}`, 'newest retained');
});
