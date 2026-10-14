/**
 * v1.187.22 — the SoC ladders' GLUE (socLadders.ts startSocLadders), driven through store ticks: what
 * each ladder announces, at which priority and in which words, against which pool's grid, and what a
 * grid drop re-escalates. The rules themselves are unit-tested elsewhere (batterySocAlarm: crossings,
 * hysteresis, the same-tick collapse; socGridDispatch: the downgrade and the re-escalation pass); these
 * cases hold the wiring between them, which a hand copy of the consumer cannot. The house ladder's
 * v0.75.0 grid-drop regression: test/batterySocAlarm.test.ts. The boot gate:
 * test/socLadderBootHydration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socAlarmMessage, socAlarmAdvisory } from '../src/batterySocAlarm.js';
import type { PoolGrid } from '../src/socLadders.js';
import { socLadderHarness as harness, settle, persistedAt, twoPanels, HOUSE, GARAGE } from './helpers/socLadderHarness.js';

const G = 'Garage Panel';

test('★★★ every pool reads its OWN grid verdict; a secondary panel keeps its own downgrade record and re-escalates on its own grid drop', async (t) => {
  // The house pool off-grid and the garage pool on-grid, both crossing 10/8/4 in one tick.
  const grid: Record<string, PoolGrid> = {
    [HOUSE]: { backstopping: false },
    [GARAGE]: { backstopping: true, importLive: true },
  };
  const h = harness(t, { hydrated: true, roster: [], grid: (sn) => grid[sn ?? ''] ?? { backstopping: false } });
  const tick = async (houseSoc: number, garageSoc: number) => { h.store.change(twoPanels(garageSoc, houseSoc)); await settle(); };
  await tick(12, 12); // cold-start baselines (arm 10/8/4/2)
  await tick(3, 3);
  assert.deepEqual(h.announced, [
    { priority: 'critical', message: socAlarmMessage({ pct: 4, priority: 'critical' }) },
    { priority: 'low', message: socAlarmAdvisory(4, G, true) },
  ], 'the house pool (off-grid) speaks its worst band as critical; the garage pool (on-grid) one advisory in its own words');
  await tick(5, 5); // a partial recovery out of the 4 % band
  assert.equal(h.announced.length, 2);
  grid[GARAGE] = { backstopping: false }; // the GARAGE grid drops
  await tick(5, 5);
  assert.deepEqual(h.announced.slice(2), [
    { priority: 'critical', message: socAlarmMessage({ pct: 10, priority: 'critical' }, G) },
    { priority: 'critical', message: socAlarmMessage({ pct: 8, priority: 'critical' }, G) },
  ], 'the garage pool re-escalates every band it is still in, named, once; the house pool has nothing downgraded');
  await tick(5, 5);
  assert.equal(h.announced.length, 4, 'once each');
});

test('★★ the house pool\'s grid verdict is read for the house pool, not another panel\'s', async (t) => {
  const grid: Record<string, PoolGrid> = {
    [HOUSE]: { backstopping: true },
    [GARAGE]: { backstopping: false },
  };
  const h = harness(t, { hydrated: true, roster: [], grid: (sn) => grid[sn ?? ''] ?? { backstopping: false } });
  h.store.change(twoPanels(60, 12));
  await settle();
  h.store.change(twoPanels(60, 3));
  await settle();
  assert.deepEqual(h.announced, [{ priority: 'low', message: socAlarmAdvisory(4, undefined, undefined) }],
    'on-grid house pool: one advisory, the grid named as available (no import measured)');
});

test('★★ the Alert Settings annunciation toggles silence a disabled priority on every ladder — crossings and re-escalations', async (t) => {
  // 'low' off: the 50/40/30 rungs are silent on both pools; 20 % (medium) is spoken on both.
  const h = harness(t, {
    hydrated: true, roster: [],
    houseState: persistedAt(52), panelStates: { [GARAGE]: persistedAt(52) },
    isPriorityEnabled: (p) => p !== 'low',
  });
  for (const soc of [49, 39, 29, 19]) {
    h.store.change(twoPanels(soc, soc));
    await settle();
  }
  assert.deepEqual(h.announced, [
    { priority: 'medium', message: socAlarmMessage({ pct: 20, priority: 'medium' }) },
    { priority: 'medium', message: socAlarmMessage({ pct: 20, priority: 'medium' }, G) },
  ]);
});

test('★★ a disabled priority is not re-escalated on a grid drop either (house and secondary)', async (t) => {
  let backstopping = true;
  const h = harness(t, {
    hydrated: true, roster: [],
    grid: () => ({ backstopping }),
    isPriorityEnabled: (p) => p !== 'critical',
  });
  h.store.change(twoPanels(12, 12));
  await settle();
  h.store.change(twoPanels(3, 3));
  await settle();
  assert.deepEqual(h.announced, [
    { priority: 'low', message: socAlarmAdvisory(4, undefined, undefined) },
    { priority: 'low', message: socAlarmAdvisory(4, G, undefined) },
  ], 'the downgraded advisories are low, so they are spoken');
  backstopping = false;
  h.store.change(twoPanels(3, 3));
  await settle();
  assert.equal(h.announced.length, 2, 'critical re-escalations are off in Alert Settings');
});
