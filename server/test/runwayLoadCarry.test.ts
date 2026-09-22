/**
 * v1.175.0 — the runway's carried-forward recent load has an age limit.
 *
 * When the last hour holds fewer than two panel_load rows, computeRunway falls back to the
 * live channel sum, then a single recorded row, then the PREVIOUS compute's recentLoadWatts.
 * Each compute writes that value back, so the last rung carried itself forward with no end.
 * It was unreachable while a silent panel recorded 0 W rows; now that a panel reporting no
 * channel watts writes no row (the recorder change in this release), a load captured just
 * before the silence — an EV charging at 14 kW — would keep shortening the projected runway,
 * and could raise a runway alarm, long after the EV stopped. The carry now lasts only while
 * a real reading is under RUNWAY_LOAD_CARRY_MAX_MS (2 h) old.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunway, resetRunwayCache } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

type Pt = { ts: number; value: number };

const MIN = 60_000, H = 3_600_000;
const T0 = Date.UTC(2026, 8, 22, 17, 0);

/** A panel whose twelve channels are all null — present, answering, reporting nothing. */
const silentPanel = () => ({
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: T0,
    projection: {
      kind: 'shp2', backupFullCapWh: 92_000, backupRemainWh: 60_000, backupReserveSoc: 16,
      circuits: Array.from({ length: 12 }, (_, i) => ({ ch: i + 1, watts: null })), pairedCircuits: [],
    },
  },
}) as any;

const recorder = (rows: () => Pt[]): Recorder => makeRecorderStub({
  query: (_sn: string, metric: string) => (metric === 'panel_load' ? rows() : []),
  queryMulti: () => new Map(),
  listMetrics: () => ['panel_load'],
}) as any;

test('★★★ a pre-silence load is carried only while a real reading is recent — then the runway stops claiming it', () => {
  resetRunwayCache();
  let now = T0;
  const clock = mock.method(Date, 'now', () => now);
  try {
    // An EV charging: an hour of 14 kW panel_load rows up to T0.
    let rows: Pt[] = Array.from({ length: 60 }, (_, i) => ({ ts: T0 - (60 - i) * MIN, value: 14_000 }));
    const rec = recorder(() => rows.filter((p) => p.ts >= now - H && p.ts <= now));
    const first = computeRunway(silentPanel(), rec, null);
    assert.equal(first.recentLoadWatts, 14_000);

    // The panel goes silent: no new rows. 90 min on, the window is empty; the last real
    // reading is 91 min old — inside the carry limit, so the carry still stands.
    now = T0 + 90 * MIN;
    const carried = computeRunway(silentPanel(), rec, null);
    assert.equal(carried.recentLoadWatts, 14_000, 'within 2 h of a real reading the last load is still used');

    // Three hours on, nothing real for 3 h: the EV may long have stopped. The runway no longer
    // projects a 14 kW house from a reading it cannot vouch for.
    now = T0 + 3 * H;
    const expired = computeRunway(silentPanel(), rec, null);
    assert.notEqual(expired.recentLoadWatts, 14_000, 'the stale 14 kW is no longer projected');
    assert.match(String(expired.unavailable), /panel-load history insufficient/);

    // And a real reading restores it at once.
    rows = rows.concat(Array.from({ length: 5 }, (_, i) => ({ ts: now - (5 - i) * MIN, value: 1_800 })));
    now += 2 * MIN; // past the 60 s cache
    const back = computeRunway(silentPanel(), rec, null);
    assert.equal(back.unavailable, null);
    assert.equal(back.recentLoadWatts, 1_800);
  } finally {
    clock.mock.restore();
    resetRunwayCache();
  }
});
