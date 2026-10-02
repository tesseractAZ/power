/**
 * v1.187.1 — what a FULL cleared-alert ledger drops first (general-2).
 *
 * The ledger sits at its cap (1500 rows, 82 days on 2026-09-30) and every new clear evicts one row.
 * The tiers were info → a noise-flagged warning → the oldest warning → the oldest overall. So
 * 82-day-old rows that had pushed were dropped while recent on-screen-only bench-spare rows stayed
 * (Core 4, a bench spare: ~190 muted rows in 14 days); since v1.186.0 learns the auto-tune flags
 * from annunciating alerts only, the noise tier was a single family (peer-voldiff), so its PUSHED
 * episodes went first; and the seven pack-defective rows for the RMA'd Core 4 pack 1 were 738
 * warnings from the front of the queue.
 *
 * Now, among warnings: a roster-muted row (never annunciated; bench spare or off-panel Core) older
 * than CLEARED_ROSTER_MUTED_KEEP_MS → a noise-flagged row recorded as NOT pushed → any noise-flagged
 * row → the oldest warning that is not never-muted → the oldest warning that is not pack-defective →
 * the oldest warning. Warranty evidence (the pack-defective rows, their Core's rows while they stood,
 * the pack's own rows) never leaves in an early tier, and pack-defective rows leave after every other
 * warning. A row muted by a CONDITION
 * (balancing, top of charge) stays in the plain FIFO tier: it is how a mute that hid a real fault
 * is found afterwards (the verifier's binding correction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pruneOldestNonSignificant, warrantyEvidence, clearedRetention, CLEARED_ROSTER_MUTED_KEEP_MS,
  CLEARED_INFO_KEPT_AS_WARNING_PREFIXES, type ClearedAlert,
} from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const CORE4 = 'COREXXX00XXX0004';
const CORE1 = 'COREXXX00XXX0001';

/** A cleared row: `ageDays` old at NOW (cleared then, raised an hour before). */
function row(id: string, ageDays: number, over: Partial<ClearedAlert> = {}, alert: Partial<Alert> = {}): ClearedAlert {
  const clearedAt = NOW - ageDays * DAY;
  return {
    alert: { id, severity: 'warning', category: 'Battery', device: 'Core', title: id, detail: 'x', ...alert } as Alert,
    raisedAt: clearedAt - 3_600_000, clearedAt, durationMs: 3_600_000, ...over,
  };
}
/** Newest-first, as the ledger is kept. */
const ledger = (...rows: ClearedAlert[]) => [...rows].sort((a, b) => b.clearedAt - a.clearedAt);
const evictOnce = (log: ClearedAlert[], isNoise?: (e: ClearedAlert) => boolean) => {
  const before = new Set(log);
  pruneOldestNonSignificant(log, isNoise, NOW);
  return [...before].filter((r) => !log.includes(r)).map((r) => r.alert.id);
};

test('★★★ an OLD roster-muted row leaves before older annunciated history', () => {
  const log = ledger(
    row('vdiff-warn-HOME-1', 80),                                        // pushed history, the oldest
    row(`vdiff-warn-${CORE4}-2`, 40, { rosterMuted: true, pushed: false }), // bench spare, 40 d
  );
  assert.deepEqual(evictOnce(log), [`vdiff-warn-${CORE4}-2`]);
});

test('★★★ the last CLEARED_ROSTER_MUTED_KEEP_MS of roster-muted rows stay whole (FIFO with everything else)', () => {
  const keep = CLEARED_ROSTER_MUTED_KEEP_MS / DAY;
  const log = ledger(row('vdiff-warn-HOME-1', 80), row(`vdiff-warn-${CORE4}-2`, keep, { rosterMuted: true, pushed: false }));
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-1'], 'exactly at the bound: kept');
  const older = ledger(row('vdiff-warn-HOME-1', 80), row(`vdiff-warn-${CORE4}-2`, keep + 0.001, { rosterMuted: true, pushed: false }));
  assert.deepEqual(evictOnce(older), [`vdiff-warn-${CORE4}-2`], 'past it: first');
  assert.equal(CLEARED_ROSTER_MUTED_KEEP_MS, 30 * DAY);
});

test('★★★ a roster-muted CRITICAL is not in the early tier (criticals leave only when the log is all criticals)', () => {
  const log = ledger(row('vdiff-warn-HOME-1', 80), row(`vdiff-crit-${CORE4}-2`, 60, { rosterMuted: true, pushed: false }, { severity: 'critical' }));
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-1']);
});

test('★★★ a CONDITION-muted row (balancing, top of charge) is not roster-muted: it stays in FIFO', () => {
  // clearedRetention stamps rosterMuted only from the roster lists; a home pack muted while it
  // balances carries no flag, so it is ordinary history.
  const w = ledger(row(`vdiff-warn-${CORE1}-1`, 70, { pushed: false }, { annunciate: false }), row('vdiff-warn-HOME-1', 75));
  assert.deepEqual(evictOnce(w), ['vdiff-warn-HOME-1'], 'the older row leaves first, muted or not');
});

test('★★★ the noise tier takes an UNPUSHED noise row before a pushed one; a legacy row (unknown) counts as possibly pushed', () => {
  const noise = (e: ClearedAlert) => e.alert.id.startsWith('peer-voldiff-');
  const log = ledger(
    row('peer-voldiff-HOME-1', 50, { pushed: true }),   // reached the phone
    row('peer-voldiff-HOME-2', 40),                      // legacy: unknown
    row('peer-voldiff-HOME-3', 10, { pushed: false }),  // a short clear that never pushed
    row('vdiff-warn-HOME-1', 80),                        // ordinary, oldest
  );
  assert.deepEqual(evictOnce(log, noise), ['peer-voldiff-HOME-3']);
  assert.deepEqual(evictOnce(log, noise), ['peer-voldiff-HOME-1'], 'then the oldest noise row, pushed or not');
  assert.deepEqual(evictOnce(log, noise), ['peer-voldiff-HOME-2']);
  assert.deepEqual(evictOnce(log, noise), ['vdiff-warn-HOME-1']);
});

test('★★★ pack-defective rows leave after EVERY other warning — even with 738 newer ones ahead of them', () => {
  const pd = row(`pack-defective-${CORE4}-1`, 37, { pushed: true }, { annunciate: true, sourcePackSn: 'PACKXXX00XXX0037' });
  const log = ledger(pd, row('vdiff-warn-HOME-1', 5), row('vdiff-warn-HOME-2', 1));
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-1']);
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-2']);
  assert.deepEqual(evictOnce(log), [`pack-defective-${CORE4}-1`], 'only when no other warning is left');
  // …and still before a critical.
  const crit = ledger(row(`pack-defective-${CORE4}-1`, 5), row('dpu-err-HOME', 90, {}, { severity: 'critical' }));
  assert.deepEqual(evictOnce(crit), [`pack-defective-${CORE4}-1`]);
});

test('★★★ (review) …the other never-muted warnings included: a newer shp2-multi-panel row leaves before an older pack-defective row', () => {
  const log = ledger(
    row(`pack-defective-${CORE4}-1`, 60, { pushed: true }),
    row('shp2-multi-panel', 2, { pushed: true }),
  );
  assert.deepEqual(evictOnce(log), ['shp2-multi-panel']);
  assert.deepEqual(evictOnce(log), [`pack-defective-${CORE4}-1`]);
});

test('★★ a never-muted warning (shp2-multi-panel) leaves after a NEWER ordinary warning', () => {
  const log = ledger(row('shp2-multi-panel', 60, { pushed: true }), row('vdiff-warn-HOME-1', 2, { pushed: true }));
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-1']);
  assert.deepEqual(evictOnce(log), ['shp2-multi-panel']);
});

test('★★★ a noise-flagged pack-defective row is still not evicted early', () => {
  const pd = row(`pack-defective-${CORE4}-1`, 60, { pushed: false });
  const log = ledger(pd, row('vdiff-warn-HOME-1', 50));
  assert.deepEqual(evictOnce(log, () => true), ['vdiff-warn-HOME-1']);
});

test('★★★ the RMA record: the defective pack\'s bench-spare rows while it stood are not evicted early; later ones are', () => {
  // Core 4 carried the defective pack 08-24 → 09-20 (days 60 → 35 here); it was a bench spare throughout.
  const pd = row(`pack-defective-${CORE4}-1`, 35, { raisedAt: NOW - 60 * DAY, pushed: true }, { sourcePackSn: 'PACKXXX00XXX0037' });
  const during = row(`vdiff-warn-${CORE4}-1`, 50, { rosterMuted: true, pushed: false });
  const after = row(`vdiff-warn-${CORE4}-2`, 33, { rosterMuted: true, pushed: false });
  const pushedHistory = row('vdiff-warn-HOME-1', 90);
  const log = ledger(pd, during, after, pushedHistory);
  assert.deepEqual(evictOnce(log), [`vdiff-warn-${CORE4}-2`], 'after the pack left: an ordinary roster-muted row');
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-1'], 'the evidence row is not taken early: FIFO first');
  assert.deepEqual(evictOnce(log), [`vdiff-warn-${CORE4}-1`]);
});

test('★★ warranty evidence: the Core\'s rows overlapping a pack-defective episode, and the pack\'s own rows anywhere', () => {
  const pd = row(`pack-defective-${CORE4}-1`, 35, { raisedAt: NOW - 60 * DAY }, { sourcePackSn: 'PACKXXX00XXX0037' });
  const isEvidence = warrantyEvidence([pd]);
  assert.equal(isEvidence(pd), true, 'its own row');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 50)), true, 'the Core, inside the episode');
  assert.equal(isEvidence(row('dpu-imbalance-X', 50, {}, { sourceSn: CORE4 })), true, 'matched on sourceSn too');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 34)), false, 'the Core, after the episode');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 61, { raisedAt: NOW - 70 * DAY })), false, 'the Core, before the episode');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 34.99, { raisedAt: NOW - 36 * DAY })), true, 'an episode that overlaps the end');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 59.5, { raisedAt: NOW - 61 * DAY })), true, 'an episode that overlaps the start');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 60, { raisedAt: NOW - 61 * DAY })), true, 'one that ends as it begins');
  assert.equal(isEvidence(row(`ems-volt-${CORE4}`, 36, { raisedAt: NOW - 35 * DAY })), true, 'one that begins as it ends');
  assert.equal(isEvidence(row(`vdiff-warn-${CORE1}-3`, 10, {}, { sourcePackSn: 'PACKXXX00XXX0037' })), true, 'the pack\'s serial, in another Core, later');
  assert.equal(isEvidence(row(`vdiff-warn-${CORE1}-3`, 50)), false, 'another Core in the window');
  assert.equal(isEvidence(row(`vdiff-warn-${CORE1}-3`, 50, {}, { sourcePackSn: 'PACKXXX00XXX0099' })), false, 'another pack');
  assert.equal(warrantyEvidence([row('vdiff-warn-HOME-1', 1)])(row(`ems-volt-${CORE4}`, 50)), false, 'no pack-defective row: nothing is evidence');
});

test('★★★ clearedRetention: roster-muted only when never annunciated, never pushed, and the roster mutes its subject', () => {
  const a = { id: `vdiff-warn-${CORE4}-2` };
  assert.deepEqual(clearedRetention({ alert: a }, [CORE4]), { pushed: false, rosterMuted: true });
  assert.deepEqual(clearedRetention({ alert: a, annunciated: true }, [CORE4]), { pushed: false }, 'it annunciated on some tick');
  assert.deepEqual(clearedRetention({ alert: a, pushSent: true }, [CORE4]), { pushed: true }, 'its push went out (before a restart)');
  assert.deepEqual(clearedRetention({ alert: a }, [CORE1]), { pushed: false }, 'not on the roster lists: a condition mute');
  assert.deepEqual(clearedRetention({ alert: { id: 'vdiff-warn-HOME-1' }, pushSent: true, annunciated: true }, []), { pushed: true });
});

test('the v1.14.0 order is unchanged otherwise: info first, then warnings, criticals last', () => {
  const log = ledger(row('a', 1, {}, { severity: 'critical' }), row('b', 2), row('c', 3, {}, { severity: 'info' }));
  assert.deepEqual(evictOnce(log), ['c']);
  assert.deepEqual(evictOnce(log), ['b']);
  assert.deepEqual(evictOnce(log), ['a']);
});

test('★★★ (log review) a row with no string id cannot throw into the tick: it leaves with the ordinary warnings, and is no one\'s warranty evidence', () => {
  // loadClearedLog drops such rows (clearedLog.test.ts); this is the in-memory guard behind it. On
  // f6ce55f the never-muted tier read `a.id.startsWith` and threw on every clear at the cap.
  const corrupt = (id: unknown, ageDays: number): ClearedAlert => {
    const clearedAt = NOW - ageDays * DAY;
    return { alert: { severity: 'warning', ...(id === undefined ? {} : { id }) } as unknown as Alert, raisedAt: clearedAt - 3_600_000, clearedAt, durationMs: 3_600_000 };
  };
  for (const id of [undefined, 42, null, { not: 'an id' }]) {
    const bad = corrupt(id, 80);
    const pd = row(`pack-defective-${CORE4}-1`, 90, { pushed: true });
    const ordinary = row('vdiff-warn-HOME-1', 5);
    const log = ledger(ordinary, bad, pd);
    assert.doesNotThrow(() => pruneOldestNonSignificant(log, undefined, NOW), `id ${JSON.stringify(id)}`);
    assert.equal(log.includes(bad), false, `id ${JSON.stringify(id)}: the corrupt row leaves first (it is not never-muted)`);
    assert.ok(log.includes(ordinary) && log.includes(pd));
    // warranty evidence: no throw on either side, and the row matches nothing by id.
    const isEvidence = warrantyEvidence([pd, bad]);
    assert.equal(isEvidence(bad), false, `id ${JSON.stringify(id)}`);
    assert.equal(isEvidence(pd), true, 'the pack-defective row is still its own evidence');
  }
  // A corrupt row in the SCAN for pack-defective rows (a critical, so no eviction tier reads it first).
  const critBad = { ...corrupt(7, 10), alert: { id: 7, severity: 'critical' } as unknown as Alert };
  assert.doesNotThrow(() => warrantyEvidence([critBad])(row(`ems-volt-${CORE4}`, 5)));
});

test('★★★ v1.187.3: an ems-volt row, info since v1.187.3, keeps the warning tier — not the first row out of a full ledger', () => {
  // At the cap the info tier is nearly empty, so as plain info each new band episode would leave on
  // the next clear: its record (and the warranty evidence of a Core that carried a defective pack)
  // gone within one tick.
  assert.deepEqual([...CLEARED_INFO_KEPT_AS_WARNING_PREFIXES], ['ems-volt-']);
  const ems = row(`ems-volt-${CORE1}`, 2, { pushed: false }, { severity: 'info' });
  const log = ledger(ems, row('vdiff-warn-HOME-1', 30));
  assert.deepEqual(evictOnce(log), ['vdiff-warn-HOME-1'], 'the OLDER warning leaves first');
  assert.deepEqual(evictOnce(log), [`ems-volt-${CORE1}`]);
  // Any other info row still leaves first, before an older ems-volt row.
  const other = ledger(row(`ems-volt-${CORE1}`, 40, {}, { severity: 'info' }), row(`balancing-${CORE1}-1`, 1, {}, { severity: 'info' }));
  assert.deepEqual(evictOnce(other), [`balancing-${CORE1}-1`]);
  // A critical still outlives it.
  const crit = ledger(row('dpu-err-HOME', 90, {}, { severity: 'critical' }), row(`ems-volt-${CORE1}`, 1, {}, { severity: 'info' }));
  assert.deepEqual(evictOnce(crit), [`ems-volt-${CORE1}`]);
});

test('★★ v1.187.3: an ems-volt info row inside a pack-defective episode is warranty evidence the noise tier does not take', () => {
  const pd = row(`pack-defective-${CORE4}-1`, 35, { raisedAt: NOW - 60 * DAY, pushed: true }, { sourcePackSn: 'PACKXXX00XXX0037' });
  const during = row(`ems-volt-${CORE4}`, 50, { pushed: false }, { severity: 'info' });
  const older = row('vdiff-warn-HOME-1', 80);
  const log = ledger(pd, during, older);
  assert.deepEqual(evictOnce(log, (e) => e.alert.id.startsWith('ems-volt-')), ['vdiff-warn-HOME-1'], 'FIFO first: the evidence row is not taken early');
  assert.deepEqual(evictOnce(log), [`ems-volt-${CORE4}`], 'then with the warnings, before the pack-defective row');
});
