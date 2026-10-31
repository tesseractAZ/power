/**
 * v1.196.0 — the forecast-skill hindcast measures each past day on that day's recorded Cores.
 *
 * Two defects, one root: the scorer inferred each past day's pool membership from the telemetry
 * it was checking.
 *
 *  1. v1.94.0 read "no rows yet" as "had not joined yet". A blackout already running when the
 *     window began, or Cores returning on different days after a fleet-wide outage, give the same
 *     signal, so the dark Core was exempted and its missing share scored as a forecast miss.
 *  2. The Cores were today's, applied to 30 days of history. A Core in the pool on a past day but
 *     on the bench today was left out of that day's actual: with a dark Core exempted by (1), the
 *     days 2026-08-11..08-19 read 184-258% phantom misses, the PV band calibrator saturated and
 *     the night-charge basis gate closed. The same rule scores a Core that was on the bench on a
 *     past day as home PV, its bench rows passing coverage (+25% a day on the swap fixture below).
 *
 * The membership record (membership-history.json) now says who was in the pool each day, and with
 * v1.196.0 which panel slot each Core held: a Core swapped into a slot takes over the departing
 * Core's PV array, so a day before such a swap is scored on that day's own Cores; a Core added
 * through a slot nobody held leaves the days before it unscored. A stand-in day counts only where a
 * fresh panel reading confirmed the record: a swap made while the panel was cloud-offline is
 * recorded only when it next reads fresh.
 *
 * Common fixture: Cores at 500 W over hours 8-16 (9 daylight hours) at GHI 500 W/m², a model of
 * coefficient 3 at those hours ⇒ predicted 3 × 500 × 9 = 13.5 kWh a day; three Cores ⇒ actual
 * 3 × 0.5 kW × 9 h = 13.5 kWh, an error of 0.
 */
import './helpers/siteZoneIsHostZone.js'; // v1.191.0 — fixtures on the host clock: the site zone is the host's (first import)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-skillroster-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const {
  computeForecastSkill, resetForecastCachesForTesting, homeModelSns, pvBandScoredErrs, skillRosterByDay, coreCoverageByDay,
} = await import('../src/analytics.js');
const { setWeatherCacheForTesting, clearWeatherTestOverride } = await import('../src/weather.js');
const { startOfLocalDayMs } = await import('../src/aggregator.js');
const { siteShiftDaysMs } = await import('../src/siteTime.js');
const { setCurtailmentMembershipHistoryForTesting } = await import('../src/curtailmentFreeze.js');
const {
  emptyHistory, recordMembership, membershipsDuring, latestSlotOf, standInCores, loadMembershipHistory,
  saveMembershipHistory, membershipVerdict, MEMBERSHIP_GLITCH_MS, membershipConfirmedDuring,
  MEMBERSHIP_CONFIRM_STEP_MS, MEMBERSHIP_CONFIRM_SLACK_MS,
} = await import('../src/membershipHistory.js');
const { connectedSlotMap } = await import('../src/shp2Membership.js');
const { makeRecorderStub } = await import('./helpers/recorderStub.js');
type MembershipHistory = import('../src/membershipHistory.js').MembershipHistory;
type DeviceSnapshot = import('../src/snapshot.js').DeviceSnapshot;
type DayForecast = import('../src/analytics.js').DayForecast;
type ForecastSkillReport = import('../src/analytics.js').ForecastSkillReport;

const H = 3_600_000;
const MIN = 60_000;
const T0 = startOfLocalDayMs();
const dayStart = (i: number): number => siteShiftDaysMs(T0, -i);
const PANEL = 'SHP2-T';
const slot = (n: number): string => `${PANEL}:${n}`;

type Rows = Array<{ ts: number; value: number }>;
/** `watts(i, h)` for day i back, daylight hour h (8..16); null = no row that hour. */
function pv(days: number, watts: (i: number, h: number) => number | null): Rows {
  const out: Rows = [];
  for (let i = days; i >= 1; i--) {
    for (let h = 8; h <= 16; h++) {
      const w = watts(i, h);
      if (w != null) out.push({ ts: dayStart(i) + h * H + 5 * MIN, value: w });
    }
  }
  return out;
}

const dpu = (sn: string): DeviceSnapshot =>
  ({ sn, deviceName: sn, online: true, projection: { kind: 'dpu', soc: 80, packs: [] } } as unknown as DeviceSnapshot);
/** Today's plant: A, B, C in slots 1, 2, 3 of one panel. */
const devices: Record<string, DeviceSnapshot> = {
  [PANEL]: {
    sn: PANEL, deviceName: 'SHP2', online: true,
    projection: {
      kind: 'shp2', pairedCircuits: [], circuits: [],
      sources: ['A', 'B', 'C'].map((sn, i) => ({ slot: i + 1, sn, isConnected: true })),
    },
  } as unknown as DeviceSnapshot,
  A: dpu('A'), B: dpu('B'), C: dpu('C'),
};

function forecast(): DayForecast {
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h, coeff: h >= 8 && h <= 16 ? 3 : null, r2: 0.9, samples: 100, observedMaxPvW: 10_000,
  }));
  const m = { hourly, peakCoeff: 3, peakGateMinGhiWm2: 300, pairCount: 240, historyDays: 30 };
  return {
    solarModelSns: homeModelSns(devices), generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 15, hours: [],
    forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null,
    homeDpusConnected: 3, homeDpusReporting: 3, homeDpusCoveragePartial: false,
    forecastPvWhNext24Display: 0, typicalPvWhPerDayDisplay: 0,
    solarModel: m, restoredSolarModel: m, deviceModels: [], soiling: null, structurallyIncomplete: false,
  } as unknown as DayForecast;
}

/** Score `windowDays` against per-SN PV rows. `membership` undefined = the production reader. */
async function score(
  windowDays: number,
  rows: Record<string, Rows>,
  ...membership: [] | [MembershipHistory | null]
): Promise<ForecastSkillReport> {
  const ghi: Rows = [];
  for (let i = windowDays; i >= 1; i--) for (let h = 8; h <= 16; h++) ghi.push({ ts: dayStart(i) + h * H, value: 500 });
  const rec = makeRecorderStub({
    query: (sn, metric, since, until) => {
      const inW = (r: { ts: number }): boolean => r.ts >= since && r.ts <= until;
      if (sn === 'weather' && (metric === 'ghi_wm2' || metric === 'ghi_wm2_realized')) return ghi.filter(inW);
      if (metric === 'pv_total' && rows[sn]) return rows[sn].filter(inW);
      return [];
    },
  });
  return membership.length === 0
    ? computeForecastSkill(devices, rec, forecast(), windowDays, 'realized')
    : computeForecastSkill(devices, rec, forecast(), windowDays, 'realized', membership[0]);
}

const day = (r: ForecastSkillReport, i: number) => r.days[r.days.length - i];
type EntrySpec = [string, number, Record<string, string>?];
/** A history from (fp, atMs, slot map) triples, through the recorder's own writer, every panel
 *  read fresh throughout: each entry is confirmed until 5 min before the next one (or today). */
function history(...entries: EntrySpec[]): MembershipHistory {
  const h = emptyHistory();
  entries.forEach(([fp, at, s], k) => {
    recordMembership(h, fp, at, s, true);
    recordMembership(h, fp, (k + 1 < entries.length ? entries[k + 1][1] : T0) - 5 * MIN, s, true);
  });
  return h;
}
/** The same record, never confirmed by a fresh panel reading. */
function unconfirmed(...entries: EntrySpec[]): MembershipHistory {
  const h = emptyHistory();
  for (const [fp, at, s] of entries) recordMembership(h, fp, at, s);
  return h;
}
const ABC = { [slot(1)]: 'A', [slot(2)]: 'B', [slot(3)]: 'C' };
const ABD = { [slot(1)]: 'A', [slot(2)]: 'B', [slot(3)]: 'D' };

beforeEach(() => {
  resetForecastCachesForTesting();
  setWeatherCacheForTesting({ fetchedAt: Date.now(), lat: 0, lon: 0, hours: [{ ts: T0 + 6 * H, radiationWm2: 0, cloudCoverPct: 0, tempC: 20 }] });
});
afterEach(() => {
  clearWeatherTestOverride();
  setCurtailmentMembershipHistoryForTesting(undefined);
});

/* ── 1. no rows is a gap, whatever the reason ─────────────────────────────── */

for (const [label, rec] of [
  ['no membership record', null],
  ['A recorded in the pool all window', history(['A,B,C', T0 - 40 * 86_400_000, ABC])],
] as const) {
  test(`★ T1 (${label}): a Core already dark when the window began is a gap, not "not joined yet"`, async () => {
    // A has one row 10 days back (it existed before the window), then nothing until day 4.
    const rows = {
      A: [{ ts: dayStart(10) + 12 * H, value: 500 }, ...pv(7, (i) => (i <= 4 ? 500 : null))],
      B: pv(7, () => 500),
      C: pv(7, () => 500),
    };
    const r = await score(7, rows, rec);
    for (const i of [7, 6, 5]) {
      assert.equal(day(r, i).coverageGap, true, `day-${i}: A has no rows`);
      assert.equal(day(r, i).errorPct, null, `day-${i}: not scored (was +50%: 13.5 predicted against 9.0)`);
    }
    for (const i of [4, 3, 2, 1]) assert.equal(day(r, i).errorPct, 0, `day-${i}: all three report`);
    // v1.192.0 read days 7..5 as "A not joined yet": MAE 1.93 kWh (16.7%), bias 0.86.
    assert.equal(r.meanAbsErrorKwh, 0);
    assert.equal(r.meanAbsErrorPct, 0);
    assert.equal(r.biasFactor, 1);
  });
}

test('★ T2: Cores returning on different days after a fleet-wide outage score only the days all three report', async () => {
  // All dark until day 6; A back on day 5; B and C back on day 3.
  const rows = {
    A: pv(30, (i) => (i <= 5 ? 500 : null)),
    B: pv(30, (i) => (i <= 3 ? 500 : null)),
    C: pv(30, (i) => (i <= 3 ? 500 : null)),
  };
  const r = await score(30, rows, null);
  assert.equal(day(r, 5).coverageGap, true);
  assert.equal(day(r, 4).coverageGap, true);
  assert.equal(day(r, 5).errorPct, null, 'was +200%: 13.5 predicted against A alone, 4.5');
  assert.equal(day(r, 4).errorPct, null);
  assert.deepEqual(r.days.filter((d) => d.errorPct != null).map((d) => d.errorPct), [0, 0, 0], 'days 3..1 only');
  // v1.192.0: MAE 3.6 kWh (36.4%), bias 0.73, and the band calibrator's errors
  // [0.37, 0.37, 0.37, 0.543, 0.543].
  assert.equal(r.biasFactor, 1);
  assert.equal(r.meanAbsErrorKwh, 0);
  assert.deepEqual(pvBandScoredErrs(r.days, r.biasFactor), [0, 0, 0]);
});

/* ── 2. a like-for-like swap is scored on that day's Cores ─────────────────── */

/** D held slot 3 until 10:00 on day 3, when C took it (and D's PV array). C sat on the bench
 *  (200 W of bench PV) before that; D reports nothing after it. */
const swapRows = {
  A: pv(7, () => 500),
  B: pv(7, () => 500),
  C: pv(7, (i, h) => (i > 3 || (i === 3 && h < 10) ? 200 : 500)),
  D: pv(7, (i, h) => (i > 3 || (i === 3 && h < 10) ? 500 : null)),
};
const swapAt = (): number => dayStart(3) + 10 * H;

test('★★ T3: before a like-for-like swap, a day is scored on that day\'s own Cores (A, B and the departed D)', async () => {
  const r = await score(7, swapRows, history(['A,B,D', T0 - 40 * 86_400_000, ABD], ['A,B,C', swapAt(), ABC]));
  for (const i of [7, 6, 5, 4]) {
    assert.equal(day(r, i).predecessorCores, true, `day-${i}: D held C's slot`);
    assert.equal(day(r, i).actualKwh, 13.5, `day-${i}: A + B + D, not C's bench 200 W`);
    assert.equal(day(r, i).errorPct, 0, `day-${i}: scored (v1.192.0: actual 10.8, +25%)`);
    assert.equal(day(r, i).offRoster, undefined);
  }
  assert.equal(day(r, 3).offRoster, true, 'the swap day: its Cores changed during the day');
  assert.equal(day(r, 3).errorPct, null);
  for (const i of [2, 1]) {
    assert.equal(day(r, i).errorPct, 0, `day-${i}: on today's Cores`);
    assert.equal(day(r, i).predecessorCores, undefined);
  }
  assert.equal(r.biasFactor, 1);
  assert.equal(r.meanAbsErrorKwh, 0);
  assert.equal(r.unrecordedRosterDays, 0);
});

test('★★ T3b: the production reader is wired — the recorder\'s record, with no argument passed', async () => {
  setCurtailmentMembershipHistoryForTesting(history(['A,B,D', T0 - 40 * 86_400_000, ABD], ['A,B,C', swapAt(), ABC]));
  const r = await score(7, swapRows);
  for (const i of [7, 6, 5, 4]) assert.equal(day(r, i).predecessorCores, true, `day-${i}`);
  assert.equal(day(r, 3).offRoster, true);
  assert.equal(r.unrecordedRosterDays, 0);
});

test('★ T3c: the same swap recorded WITHOUT slot maps (before v1.196.0) cannot be told from an addition: off-roster', async () => {
  const r = await score(7, swapRows, history(['A,B,D', T0 - 40 * 86_400_000], ['A,B,C', swapAt()]));
  for (const i of [7, 6, 5, 4, 3]) {
    assert.equal(day(r, i).offRoster, true, `day-${i}`);
    assert.equal(day(r, i).errorPct, null);
  }
  assert.deepEqual([day(r, 2).errorPct, day(r, 1).errorPct], [0, 0]);
});

test('★★ T3d: a Core ADDED through a slot nobody held leaves the days before it unscored (the pause)', async () => {
  // A and B only, then C into the empty slot 3. C's bench rows before it would read +25%.
  const r = await score(7, swapRows, history(['A,B', T0 - 40 * 86_400_000, { [slot(1)]: 'A', [slot(2)]: 'B' }], ['A,B,C', swapAt(), ABC]));
  for (const i of [7, 6, 5, 4, 3]) {
    assert.equal(day(r, i).offRoster, true, `day-${i}: the pool lacked slot 3's array`);
    assert.equal(day(r, i).errorPct, null, `day-${i} (v1.192.0: scored on C's bench rows, +25%)`);
    assert.equal(day(r, i).predecessorCores, undefined);
  }
  assert.deepEqual([day(r, 2).errorPct, day(r, 1).errorPct], [0, 0]);
  assert.equal(r.biasFactor, 1);
});

test('★ T3e: a swap through an empty interval (D out, then C in later the same day) — before it, scored on D', async () => {
  const r = await score(7, swapRows, history(
    ['A,B,D', T0 - 40 * 86_400_000, ABD],
    ['A,B', dayStart(3) + 9 * H, { [slot(1)]: 'A', [slot(2)]: 'B' }], // an hour with slot 3 empty
    ['A,B,C', swapAt(), ABC],
  ));
  for (const i of [7, 6, 5, 4]) assert.equal(day(r, i).predecessorCores, true, `day-${i}`);
  assert.equal(day(r, 3).offRoster, true);
});

test('★★ T3f: a day before a swap is judged on that day\'s Cores: the departed Core dark that day is a gap, not a miss', async () => {
  // D, the Core day 5 is measured on, recorded nothing that day; C sat on the bench (200 W).
  const rows = { ...swapRows, D: swapRows.D.filter((p) => p.ts < dayStart(5) || p.ts >= dayStart(4)) };
  const r = await score(7, rows, history(['A,B,D', T0 - 40 * 86_400_000, ABD], ['A,B,C', swapAt(), ABC]));
  assert.equal(day(r, 5).predecessorCores, true);
  assert.equal(day(r, 5).coverageGap, true, 'D has no rows on day 5 (C\'s bench rows are not day 5\'s array)');
  assert.equal(day(r, 5).errorPct, null, 'not +50%: 13.5 kWh predicted against A + B alone, 9.0');
  for (const i of [7, 6, 4]) assert.equal(day(r, i).errorPct, 0, `day-${i}`);
  assert.equal(r.biasFactor, 1);
  assert.equal(r.meanAbsErrorKwh, 0);
});

test('★★ T3g: a swap the record could not see (the panel cloud-offline) is not scored on the departed Core', async () => {
  // C took D's slot at the start of day 5; D went to the bench (online, 0 W of bench PV). The panel
  // read stale from 06:00 on day 6 until 10:00 on day 2, so the record named A, B, D until then.
  const rows = {
    A: pv(7, () => 500),
    B: pv(7, () => 500),
    C: pv(7, (i) => (i <= 5 ? 500 : null)),
    D: pv(7, (i) => (i >= 6 ? 500 : 0)),
  };
  const h = emptyHistory();
  recordMembership(h, 'A,B,D', T0 - 40 * 86_400_000, ABD, true);
  recordMembership(h, 'A,B,D', dayStart(6) + 6 * H, ABD, true); // the last fresh reading
  recordMembership(h, 'A,B,C', dayStart(2) + 10 * H, ABC, true); // the panel reads fresh again
  recordMembership(h, 'A,B,C', T0 - 5 * MIN, ABC, true);
  const r = await score(7, rows, h);
  assert.equal(day(r, 7).predecessorCores, true, 'day-7: confirmed, measured on A + B + D');
  assert.equal(day(r, 7).errorPct, 0);
  for (const i of [6, 5, 4, 3]) {
    assert.equal(day(r, i).offRoster, true, `day-${i}: the record cannot vouch for it`);
    assert.equal(day(r, i).errorPct, null, `day-${i} (on the stale record: D's bench 0 W, +50% on days 5..3)`);
    assert.equal(day(r, i).predecessorCores, undefined);
  }
  assert.equal(day(r, 2).offRoster, true, 'the day the record changed');
  assert.equal(day(r, 1).errorPct, 0);
  // On the stale record: MAE 2.25 kWh (20%), bias 0.83.
  assert.equal(r.meanAbsErrorKwh, 0);
  assert.equal(r.biasFactor, 1);
  // A record no fresh reading ever confirmed vouches for no stand-in day.
  resetForecastCachesForTesting();
  const never = await score(7, swapRows, unconfirmed(['A,B,D', T0 - 40 * 86_400_000, ABD], ['A,B,C', swapAt(), ABC]));
  for (const i of [7, 6, 5, 4, 3]) assert.equal(day(never, i).offRoster, true, `unconfirmed day-${i}`);
  assert.deepEqual([day(never, 2).errorPct, day(never, 1).errorPct], [0, 0], 'on-roster days need no stamp');
});

/* ── 3. blips, supersets, the record's start ───────────────────────────────── */

test('★ T4: a membership held under 15 min (a one-poll isConnect flicker) does not take the day off the roster', async () => {
  const rows = { A: pv(7, () => 500), B: pv(7, () => 500), C: pv(7, () => 500) };
  const blip = (dwellMs: number) => history(
    ['A,B,C', T0 - 40 * 86_400_000, ABC],
    ['A,C', dayStart(5) + 12 * H, { [slot(1)]: 'A', [slot(3)]: 'C' }],
    ['A,B,C', dayStart(5) + 12 * H + dwellMs, ABC],
  );
  const short = await score(7, rows, blip(5 * MIN));
  assert.equal(day(short, 5).offRoster, undefined);
  assert.equal(day(short, 5).errorPct, 0, 'scored');
  resetForecastCachesForTesting();
  const long = await score(7, rows, blip(20 * MIN));
  assert.equal(day(long, 5).offRoster, true, 'B out of the pool for 20 min is a real change');
  assert.equal(day(long, 4).errorPct, 0, 'the next day is unaffected');
});

test('★ T5: a pool with MORE Cores than the model (before a Core left) is on the roster; the actual sums the model\'s Cores', async () => {
  const rows = { A: pv(7, () => 500), B: pv(7, () => 500), C: pv(7, () => 500), E: pv(7, (i) => (i > 3 ? 500 : null)) };
  const r = await score(7, rows, history(
    ['A,B,C,E', T0 - 40 * 86_400_000, { ...ABC, 'SHP2-U:1': 'E' }],
    ['A,B,C', dayStart(3) + 10 * H, ABC],
  ));
  for (let i = 7; i >= 1; i--) {
    assert.equal(day(r, i).offRoster, undefined, `day-${i}`);
    assert.equal(day(r, i).actualKwh, 13.5, `day-${i}: E's PV is not the model's`);
    assert.equal(day(r, i).errorPct, 0);
  }
});

test('★ T6: days before the record are scored on coverage alone and counted', async () => {
  const rows = { A: pv(7, () => 500), B: pv(7, () => 500), C: pv(7, () => 500) };
  const r = await score(7, rows, history(['A,B,C', dayStart(2) + 3 * H, ABC]));
  assert.equal(r.unrecordedRosterDays, 6, 'days 7..2 start before the first entry');
  assert.deepEqual(r.days.map((d) => d.errorPct), [0, 0, 0, 0, 0, 0, 0], 'all scored');
  assert.ok(r.days.every((d) => d.offRoster == null));
  resetForecastCachesForTesting();
  const none = await score(7, rows, null);
  assert.equal(none.unrecordedRosterDays, 7);
  assert.deepEqual(none.days.map((d) => d.errorPct), [0, 0, 0, 0, 0, 0, 0]);
});

/* ── 4. the pure pieces ───────────────────────────────────────────────────── */

test('T7 membershipsDuring — the record\'s start, a quiet day, a change mid-day and at the boundary, a folded blip', () => {
  const D0 = dayStart(5);
  const D1 = dayStart(4);
  const h = history(['A,B,C', D0 + 6 * H], ['A,B,E', D1 + 12 * H]);
  assert.equal(membershipsDuring(h, D0, D1), null, 'the day starts before the record');
  assert.deepEqual(membershipsDuring(h, D1 - 6 * H, D1)!.map((e) => e.fp), ['A,B,C'], 'in force, no change');
  assert.deepEqual(membershipsDuring(h, D1, D1 + 86_400_000)!.map((e) => e.fp), ['A,B,C', 'A,B,E'], 'changed mid-day');
  assert.deepEqual(membershipsDuring(h, D1 + 12 * H, D1 + 86_400_000)!.map((e) => e.fp), ['A,B,E'], 'changed exactly at the start');
  assert.deepEqual(membershipsDuring(h, T0, T0 + H)!.map((e) => e.fp), ['A,B,E'], 'the newest entry has no end');
  const blip = history(['A,B,C', D0], ['A,C', D1 + 12 * H], ['A,B,C', D1 + 12 * H + MEMBERSHIP_GLITCH_MS - 1]);
  assert.deepEqual(membershipsDuring(blip, D1, D1 + 86_400_000)!.map((e) => e.fp), ['A,B,C'], 'folded');
  const held = history(['A,B,C', D0], ['A,C', D1 + 12 * H], ['A,B,C', D1 + 12 * H + MEMBERSHIP_GLITCH_MS]);
  assert.deepEqual(membershipsDuring(held, D1, D1 + 86_400_000)!.map((e) => e.fp), ['A,B,C', 'A,C', 'A,B,C'], 'held 15 min: real');
});

test('T7b membershipsDuring — a folded return lends its slot map to an entry recorded without one', () => {
  const D1 = dayStart(4);
  const h: MembershipHistory = { entries: [
    { fp: 'A,B,C', atMs: dayStart(6) },
    { fp: 'A,C', atMs: D1 + 12 * H, slots: { [slot(1)]: 'A', [slot(3)]: 'C' } },
    { fp: 'A,B,C', atMs: D1 + 12 * H + 5 * MIN, slots: ABC },
  ] };
  assert.deepEqual(membershipsDuring(h, D1, D1 + 86_400_000), [{ fp: 'A,B,C', atMs: dayStart(6), slots: ABC }]);
});

test('T7f membershipConfirmedDuring — stamps vouch back to the entry\'s start, up to the next entry or the window\'s end', () => {
  const D1 = dayStart(4);
  const D2 = dayStart(3);
  const stamped = (...e: MembershipHistory['entries']): MembershipHistory => ({ entries: e });
  assert.equal(membershipConfirmedDuring(stamped({ fp: 'A', atMs: D1 + H, confirmedMs: D2 }), D1, D2), false, 'before the record');
  assert.equal(membershipConfirmedDuring(stamped({ fp: 'A', atMs: D1 - H }), D1, D2), false, 'never stamped');
  const toNext = (stamp: number) => stamped({ fp: 'A', atMs: D1 - H, confirmedMs: stamp }, { fp: 'B', atMs: D2 + 6 * H });
  assert.equal(membershipConfirmedDuring(toNext(D2 - MEMBERSHIP_CONFIRM_SLACK_MS), D1, D2), true, 'within the slack of the day\'s end');
  assert.equal(membershipConfirmedDuring(toNext(D2 - MEMBERSHIP_CONFIRM_SLACK_MS - 1), D1, D2), false, 'a stretch past the slack');
  assert.equal(membershipConfirmedDuring(toNext(D1 + 2 * H), D2 - 1, D2), false, 'the unknown stretch reaches the window');
  assert.equal(membershipConfirmedDuring(toNext(D1 + 2 * H), D1, D1 + 2 * H), true, 'a window before it');
  // The next entry starts inside the window: the stamp need only reach that entry.
  const midDay = stamped({ fp: 'A', atMs: D1 - H, confirmedMs: D1 + 9 * H }, { fp: 'B', atMs: D1 + 10 * H, confirmedMs: D2 + H });
  assert.equal(membershipConfirmedDuring(midDay, D1, D2), true);
  // A folded flicker's return lends its later stamp.
  const blip = stamped(
    { fp: 'A', atMs: D1 - H, confirmedMs: D1 },
    { fp: 'B', atMs: D1 + 12 * H, confirmedMs: D1 + 12 * H },
    { fp: 'A', atMs: D1 + 12 * H + 5 * MIN, confirmedMs: D2 },
  );
  assert.equal(membershipConfirmedDuring(blip, D1, D2), true);
  assert.equal(membershipsDuring(blip, D1, D2)![0].confirmedMs, D2);
});

test('T7c standInCores / latestSlotOf — itself, the slot\'s holder then, or nothing', () => {
  const slotOf = latestSlotOf(history(['A,B,D', 1, ABD], ['A,B,C', 2, ABC]), ['A', 'B', 'C']);
  assert.deepEqual([...slotOf].sort(), [['A', slot(1)], ['B', slot(2)], ['C', slot(3)]]);
  // C held slot 2 once (B took it), and slot 3 now (it took D's): the slot it holds NOW.
  const moved = history(['A,C,D', 1, { [slot(1)]: 'A', [slot(2)]: 'C', [slot(3)]: 'D' }], ['A,B,D', 2, ABD], ['A,B,C', 3, ABC]);
  assert.equal(latestSlotOf(moved, ['A', 'B', 'C']).get('C'), slot(3));
  assert.deepEqual(standInCores(moved.entries[1], ['A', 'B', 'C'], latestSlotOf(moved, ['A', 'B', 'C'])), ['A', 'B', 'D']);
  assert.deepEqual(standInCores({ fp: 'A,B,C', atMs: 0, slots: ABC }, ['A', 'B', 'C'], slotOf), ['A', 'B', 'C']);
  assert.deepEqual(standInCores({ fp: 'A,B,D', atMs: 0, slots: ABD }, ['A', 'B', 'C'], slotOf), ['A', 'B', 'D'], 'a swap');
  assert.equal(standInCores({ fp: 'A,B', atMs: 0, slots: { [slot(1)]: 'A', [slot(2)]: 'B' } }, ['A', 'B', 'C'], slotOf), null, 'slot 3 empty');
  assert.equal(standInCores({ fp: 'A,B,D', atMs: 0 }, ['A', 'B', 'C'], slotOf), null, 'no slot map');
  assert.deepEqual(standInCores({ fp: 'A,C', atMs: 0 }, ['A', 'C'], new Map()), ['A', 'C'], 'both members: no slot map needed');
  const aInSlot3 = { fp: 'A,B', atMs: 0, slots: { [slot(1)]: 'B', [slot(3)]: 'A' } };
  assert.equal(standInCores(aInSlot3, ['A', 'C'], new Map([['A', slot(1)], ['C', slot(3)]])), null,
    "C's slot was A's, and A already stands for itself");
  assert.equal(standInCores({ fp: 'A,B', atMs: 0, slots: { ...ABD } }, ['A', 'B', 'C'], slotOf), null,
    'a slot holder outside the pool (an inconsistent record) stands for nothing');
});

test('T7d skillRosterByDay — verdicts per day, a swap day off the roster', () => {
  const h = history(['A,B,D', dayStart(10), ABD], ['A,B,C', dayStart(3) + 10 * H, ABC]);
  const r = skillRosterByDay(h, ['C', 'A', 'B'], T0, 5);
  assert.deepEqual([5, 4, 3, 2, 1].map((i) => r.get(dayStart(i))!.verdict), ['predecessor', 'predecessor', 'off-roster', 'on-roster', 'on-roster']);
  assert.deepEqual(r.get(dayStart(5))!.sns, ['A', 'B', 'D']);
  assert.deepEqual(r.get(dayStart(1))!.sns, ['A', 'B', 'C'], 'sorted');
  assert.deepEqual([...skillRosterByDay(null, ['A'], T0, 2).values()].map((d) => d.verdict), ['unrecorded', 'unrecorded']);
});

test('T7e coreCoverageByDay — over the Cores named for the day; one with no series is a gap', () => {
  const ghi = new Map<number, number>();
  for (let i = 3; i >= 1; i--) for (let h = 8; h <= 16; h++) ghi.set(Math.floor((dayStart(i) + h * H) / H), 500);
  const pvBySn = new Map([['A', pv(3, () => 500)], ['B', pv(3, (i) => (i === 3 ? 500 : null))]]);
  const strict = coreCoverageByDay(ghi, pvBySn, T0, 3);
  assert.deepEqual([3, 2, 1].map((i) => strict.get(dayStart(i))!.covered), [true, false, false], 'every SN, every day');
  const named = coreCoverageByDay(ghi, pvBySn, T0, 3, undefined, (d) => (d === dayStart(3) ? ['A', 'B'] : ['A']));
  assert.deepEqual([3, 2, 1].map((i) => named.get(dayStart(i))!.covered), [true, true, true], 'B is not measured on days 2..1');
  const ghost = coreCoverageByDay(ghi, pvBySn, T0, 3, undefined, () => ['A', 'GONE']);
  assert.equal(ghost.get(dayStart(2))!.covered, false);
  assert.equal(ghost.get(dayStart(2))!.worstSn, 'GONE');
  assert.equal(ghost.get(dayStart(2))!.worstFrac, 0);
});

/* ── 5. the record keeps the slot table ───────────────────────────────────── */

test('recordMembership — the slot map rides on the entry; the same Cores in other slots update it in place', () => {
  const h = emptyHistory();
  assert.equal(recordMembership(h, 'A,B,C', 1000, ABC), true);
  assert.equal(recordMembership(h, 'A,B,C', 2000, { ...ABC }), false, 'unchanged');
  const moved = { [slot(1)]: 'C', [slot(2)]: 'B', [slot(3)]: 'A' };
  assert.equal(recordMembership(h, 'A,B,C', 3000, moved), true, 'a rearrangement is saved');
  assert.equal(h.entries.length, 1, 'but is not a membership change');
  assert.deepEqual(h.entries[0], { fp: 'A,B,C', atMs: 1000, slots: moved });
  assert.equal(membershipVerdict(h, 1500, 4000), 'stable');
  assert.equal(recordMembership(h, 'A,B,C', 4000, {}), false, 'an empty slot map is no information');
  assert.equal(recordMembership(h, 'A,B,D', 5000, ABD), true);
  assert.deepEqual(h.entries[1], { fp: 'A,B,D', atMs: 5000, slots: ABD });
});

test('recordMembership — a fresh reading stamps the entry: at once when appended, then once per step', () => {
  const h = emptyHistory();
  assert.equal(recordMembership(h, 'A,B,C', 1000, ABC), true);
  assert.equal(h.entries[0].confirmedMs, undefined, 'a stale reading confirms nothing');
  assert.equal(recordMembership(h, 'A,B,C', 2000, ABC, true), true, 'the first fresh reading stamps');
  assert.equal(h.entries[0].confirmedMs, 2000);
  assert.equal(recordMembership(h, 'A,B,C', 2000 + MEMBERSHIP_CONFIRM_STEP_MS - 1, ABC, true), false, 'not saved every rollup');
  assert.equal(h.entries[0].confirmedMs, 2000);
  assert.equal(recordMembership(h, 'A,B,C', 2000 + MEMBERSHIP_CONFIRM_STEP_MS, ABC, true), true);
  assert.equal(h.entries[0].confirmedMs, 2000 + MEMBERSHIP_CONFIRM_STEP_MS);
  assert.equal(recordMembership(h, 'A,B,D', 9_000_000, ABD, true), true);
  assert.deepEqual(h.entries[1], { fp: 'A,B,D', atMs: 9_000_000, slots: ABD, confirmedMs: 9_000_000 });
  assert.equal(membershipVerdict(h, 1500, 8_000_000), 'stable', 'a stamp is no membership change');
});

test('recordMembership — an entry recorded before slot maps gains one, without a new entry', () => {
  const h = unconfirmed(['A,B,C', 1000]);
  assert.equal(recordMembership(h, 'A,B,C', 2000, ABC), true);
  assert.deepEqual(h.entries, [{ fp: 'A,B,C', atMs: 1000, slots: ABC }]);
});

test('load/save — the slot map round-trips; a malformed one is dropped and the entry kept', () => {
  const path = join(tmp, 'membership-roundtrip.json');
  saveMembershipHistory(path, unconfirmed(['A,B,C', 1000, ABC], ['A,B,D', 2000, ABD]));
  assert.deepEqual(loadMembershipHistory(path).entries, [{ fp: 'A,B,C', atMs: 1000, slots: ABC }, { fp: 'A,B,D', atMs: 2000, slots: ABD }]);
  saveMembershipHistory(path, { entries: [{ fp: 'A,B,C', atMs: 1000, slots: ABC, confirmedMs: 1500 }] });
  assert.deepEqual(loadMembershipHistory(path).entries, [{ fp: 'A,B,C', atMs: 1000, slots: ABC, confirmedMs: 1500 }], 'the stamp round-trips');
  writeFileSync(path, JSON.stringify({ entries: [
    { fp: 'A', atMs: 1, slots: { x: 7 } }, { fp: 'B', atMs: 2, slots: ['B'] }, { fp: 'C', atMs: 3 },
    { fp: 'D', atMs: 10, confirmedMs: 9 }, { fp: 'E', atMs: 11, confirmedMs: 'soon' },
  ] }));
  assert.deepEqual(loadMembershipHistory(path).entries, [
    { fp: 'A', atMs: 1 }, { fp: 'B', atMs: 2 }, { fp: 'C', atMs: 3 }, { fp: 'D', atMs: 10 }, { fp: 'E', atMs: 11 },
  ], 'a malformed slot map or stamp is dropped, the entry kept');
});

test('connectedSlotMap — every panel\'s connected, serial-bearing sources, keyed panel:slot', () => {
  const map = {
    ...devices,
    'SHP2-U': {
      sn: 'SHP2-U', deviceName: 'SHP2 b', online: true,
      projection: { kind: 'shp2', pairedCircuits: [], circuits: [], sources: [
        { slot: 1, sn: 'E', isConnected: true }, { slot: 2, sn: 'F', isConnected: false }, { slot: 3, sn: null, isConnected: true },
      ] },
    } as unknown as DeviceSnapshot,
  };
  assert.deepEqual(connectedSlotMap(map), { ...ABC, 'SHP2-U:1': 'E' });
});

function makeStore(snap: { generatedAt: number; devices: Record<string, unknown> }) {
  const ee = new EventEmitter() as EventEmitter & { snap: typeof snap; get: () => typeof snap };
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}
const panelOf = (sns: Array<string | null>) => ({
  sn: PANEL, deviceName: 'SHP2', productName: 'SHP2', online: true, lastUpdated: Date.now(),
  projection: {
    kind: 'shp2', area: null, backupBatPercent: 50, backupFullCapWh: null, backupRemainWh: null,
    backupChargeTimeMin: null, backupDischargeTimeMin: null, backupReserveSoc: null, chargeWattPower: null,
    circuits: [], pairedCircuits: [], sourceWatts: [], gridWatt: 0, strategy: {},
    sources: sns.map((sn, i) => ({ slot: i + 1, sn, batteryPercentage: 50, isConnected: sn != null, isAcOpen: true, hwConnect: true })),
  },
});

test('★ the recorder writes the panel\'s slot table into membership-history.json, and a swap is a new entry', async () => {
  const path = join(tmp, 'membership-history.json');
  // An entry from before v1.196.0: no slot map.
  writeFileSync(path, JSON.stringify({ entries: [{ fp: 'A,B,D', atMs: 1000 }] }));
  const { createRecorder } = await import('../src/recorder.js');
  const store = makeStore({ generatedAt: Date.now(), devices: { [PANEL]: panelOf(['A', 'B', 'D']) } });
  const rec = createRecorder(store as never, () => {});
  rec.rollupLifetime();
  const read = () => JSON.parse(readFileSync(path, 'utf8')).entries;
  assert.deepEqual(read(), [{ fp: 'A,B,D', atMs: 1000, slots: ABD }], 'the legacy entry gains its slot map in place');
  store.snap.devices[PANEL] = panelOf(['A', 'B', 'C']); // C takes D's slot
  rec.rollupLifetime();
  const after = read();
  assert.equal(after.length, 2);
  assert.deepEqual({ fp: after[1].fp, slots: after[1].slots }, { fp: 'A,B,C', slots: ABC });
  // The roster the hindcast reads back off it: C's slot was D's.
  assert.deepEqual(standInCores(after[0], ['A', 'B', 'C'], latestSlotOf({ entries: after }, ['A', 'B', 'C'])), ['A', 'B', 'D']);
  // Only a fresh panel reading confirms (shp2ReadbackFresh): none so far had a quota at all.
  assert.ok(after.every((e: { confirmedMs?: number }) => e.confirmedMs == null), 'no quota: nothing confirmed');
  store.snap.devices[PANEL] = { ...panelOf(['A', 'B', 'C']), lastQuotaAtMs: Date.now() - 10 * MIN };
  rec.rollupLifetime();
  assert.equal(read()[1].confirmedMs, undefined, 'a quota 10 min old is a frozen reading: nothing confirmed');
  const before = Date.now();
  store.snap.devices[PANEL] = { ...panelOf(['A', 'B', 'C']), lastQuotaAtMs: Date.now() };
  rec.rollupLifetime();
  const stamped = read();
  assert.equal(stamped.length, 2, 'a stamp is no new entry');
  assert.equal(stamped[0].confirmedMs, undefined);
  assert.ok(stamped[1].confirmedMs >= before, 'a fresh reading stamps the newest entry');
});
