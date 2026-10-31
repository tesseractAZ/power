/**
 * v1.195.0 — the runway's live-load rung reads a panel reading only while it IS one, and the runway
 * alarm holds its state while the house runway is unavailable.
 *
 * When the last hour holds fewer than two panel_load rows, computeRunway falls back to the live
 * channel sum (Σ circuits[].watts), then a single row, then the carried load (v1.175.0: for at most
 * RUNWAY_LOAD_CARRY_MAX_MS after the last real reading). Since v1.188.1 the recorder writes no row
 * for a HELD panel (heldSamples.projectionRecordable: a cloud replay, or a feed that stopped), while
 * the store keeps the panel's last projection: a hold empties the hour's window and lands in exactly
 * this rung, which summed the frozen circuits as the live load and re-stamped the carry clock on
 * every compute. Circuits held at 600 W hid a 6 kW house (low instead of medium), circuits held at
 * 9 kW projected the reserve floor in 2.8 h on a 2.4 kW house (a false HIGH), and the carry limit
 * never came due. The rung now takes the recorder's own gate.
 *
 * The house runway then reads unavailable once the carry runs out, and the alarm read that as a
 * recovery: it re-armed and stopped its hourly reminder for the rest of the hold. Unavailable now
 * holds its state, as a secondary panel's alarm already did. The load-shed advisor, which reads the
 * same runway through the same classifyRunway, holds its last advisory the same way: it had called
 * the runway healthy and cleared load_shed_recommended mid-depletion.
 *
 * Fixture: pool 38 / 92 kWh, 16% reserve, measured basis ×1 with a 270 W overhead, a flat forecast
 * load with no PV, the clock mocked. Panel serials are placeholders.
 */
import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRunway, resetRunwayCache, setPoolBasisOverrideForTesting, type DayForecast } from '../src/analytics.js';
import { classifyRunway, createRunwayAlarm } from '../src/runwayAlarm.js';
import { createLoadShedAdvisor, advisoryStateFields } from '../src/loadShedAdvisor.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

type Pt = { ts: number; value: number };
const H = 3_600_000, MIN = 60_000;
const T0 = Date.UTC(2026, 9, 29, 3, 0); // 20:00 site time: no solar in the fixture anyway
let now = T0;

interface PanelState {
  /** lastTelemetryAtMs (and lastQuotaAtMs): the last content arrival. */
  tel: number | undefined;
  /** contentStaleSinceMs: the cloud-shadow latch (null = clear). */
  stale?: number | null;
  /** contentNewAtMs: the panel's last NEW body. */
  newAt?: number;
  circuits: number[];
}
const panel = (p: PanelState) => ({
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: now,
    lastTelemetryAtMs: p.tel, lastQuotaAtMs: p.tel, contentStaleSinceMs: p.stale ?? null, contentNewAtMs: p.newAt,
    projection: {
      kind: 'shp2', backupFullCapWh: 92_000, backupRemainWh: 38_000, backupReserveSoc: 16,
      circuits: p.circuits.map((w, i) => ({ ch: i + 1, watts: w })), pairedCircuits: [],
    },
  },
}) as any;

/** A flat `loadW` forecast with no PV. */
const forecast = (loadW: number): DayForecast => ({
  generatedAt: now, hasWeather: true, historyDays: 30, reserveSoc: 16,
  hours: Array.from({ length: 24 }, (_, h) => ({
    ts: now + h * H, forecastPvW: 0, forecastLoadW: loadW, cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: null, modelled: true,
  })),
  forecastPvWhNext24: 0, typicalPvWhPerDay: 0, forecastPvWhNext24Display: 0, typicalPvWhPerDayDisplay: 0, restoredSolarModel: {},
} as unknown as DayForecast);

/** An hour of panel_load rows at `w`, the last at T0 (the moment the panel's readings froze). */
const hourTo = (w: number): Pt[] => Array.from({ length: 60 }, (_, i) => ({ ts: T0 - (59 - i) * MIN, value: w }));
const recorder = (rows: Pt[]): Recorder => makeRecorderStub({
  query: (_sn: string, metric: string, since: number, until: number) => (metric === 'panel_load' ? rows.filter((p) => p.ts >= since && p.ts <= until) : []),
  queryMulti: () => new Map(),
  listMetrics: () => ['panel_load'],
}) as any;

beforeEach(() => {
  now = T0;
  resetRunwayCache();
  setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 270 });
  mock.method(Date, 'now', () => now);
});
afterEach(() => {
  mock.restoreAll();
  resetRunwayCache();
  setPoolBasisOverrideForTesting(null);
});

test('★★★ (a) under-alarm: a hold that freezes the circuits at 600 W does not hide a 6 kW house', () => {
  const rec = recorder(hourTo(6000));
  const fresh = computeRunway(panel({ tel: T0, circuits: [300, 300] }), rec, forecast(2000));
  assert.equal(fresh.recentLoadBasis, 'hour-mean');
  assert.equal(fresh.recentLoadWatts, 6000);
  assert.equal(fresh.hoursToReserve, 5.3);
  assert.equal(fresh.hoursToEmpty, 11.4);
  // 70 minutes on: the panel latched at T0 (a cloud replay; no row written since), the hour is empty.
  now = T0 + 70 * MIN;
  const held = computeRunway(panel({ tel: T0, stale: T0, circuits: [300, 300] }), rec, forecast(2000));
  assert.equal(held.recentLoadBasis, 'carried', 'the last recorded hour, not the held channels');
  assert.equal(held.recentLoadWatts, 6000);
  assert.equal(held.hoursToReserve, 5.3, 'v1.192.0: "live" 600 W → 9.7 h');
  assert.equal(held.hoursToEmpty, 11.4, 'v1.192.0: 15.8 h');
  assert.equal(classifyRunway(held), 'medium', 'v1.192.0: low');
});

test('★★★ (b) over-alarm: circuits held at 9 kW do not raise a false HIGH on a 2.4 kW house', () => {
  const rec = recorder(hourTo(2400));
  computeRunway(panel({ tel: T0, circuits: [7000, 2000] }), rec, forecast(2400));
  now = T0 + 70 * MIN;
  const held = computeRunway(panel({ tel: T0, stale: T0, circuits: [7000, 2000] }), rec, forecast(2400));
  assert.equal(held.recentLoadBasis, 'carried');
  assert.equal(held.recentLoadWatts, 2400);
  assert.equal(held.hoursToReserve, 8.2, 'v1.192.0: "live" 9,000 W → 2.8 h');
  assert.equal(held.hoursToEmpty, 13.5, 'v1.192.0: 7.2 h');
  assert.equal(classifyRunway(held), 'low', 'v1.192.0: high (audible unless the grid backstops)');
  // The control: the same channels on a FRESH panel are the live load, and project that HIGH.
  resetRunwayCache();
  const live = computeRunway(panel({ tel: now, circuits: [7000, 2000] }), rec, forecast(2400));
  assert.equal(live.recentLoadBasis, 'live');
  assert.equal(live.recentLoadWatts, 9000);
  assert.equal(classifyRunway(live), 'high');
});

test('★★★ (c) the carry limit survives a hold: five hours on, the runway is unavailable, not a frozen "live" load', () => {
  const rec = recorder(hourTo(6000));
  computeRunway(panel({ tel: T0, circuits: [300, 300] }), rec, forecast(2000));
  for (const at of [70 * MIN, 2 * H, 2 * H + MIN]) {
    now = T0 + at;
    const r = computeRunway(panel({ tel: T0, stale: T0, circuits: [300, 300] }), rec, forecast(2000));
    if (at <= 2 * H) assert.equal(r.recentLoadBasis, 'carried', `+${at / MIN} min: inside the carry`);
    else assert.match(String(r.unavailable), /panel-load history insufficient/, `+${at / MIN} min: past it`);
  }
  now = T0 + 5 * H;
  const r = computeRunway(panel({ tel: T0, stale: T0, circuits: [300, 300] }), rec, forecast(2000));
  assert.match(String(r.unavailable), /panel-load history insufficient/, 'v1.192.0: "live" 600 W for as long as the hold lasted');
  assert.equal(r.recentLoadBasis, null);
  assert.equal(r.hoursToReserve, null);
  assert.equal(r.hoursToEmpty, null);
});

test('★★ (d) a stale content clock alone (no latch: the feed stopped) is not a reading; three minutes is', () => {
  now = T0;
  const stale = computeRunway(panel({ tel: T0 - 4 * MIN, circuits: [900, 900] }), recorder([]), forecast(2000));
  assert.equal(stale.recentLoadBasis, null);
  assert.match(String(stale.unavailable), /panel-load history insufficient/);
  resetRunwayCache();
  const edge = computeRunway(panel({ tel: T0 - 3 * MIN, circuits: [900, 900] }), recorder([]), forecast(2000));
  assert.equal(edge.recentLoadBasis, 'live', 'RECORD_FRESH_MS (3 min) is still a reading, as the recorder writes it');
  assert.equal(edge.recentLoadWatts, 1800);
  resetRunwayCache();
  const none = computeRunway(panel({ tel: undefined, circuits: [900, 900] }), recorder([]), forecast(2000));
  assert.equal(none.recentLoadBasis, null, 'no content clock at all is not a reading (fail closed)');
});

test('★★ (e) a cloud replay — the latch set, the arrival clock fresh, the body old — is not a reading; a NEW body under the latch is', () => {
  now = T0;
  const replay = computeRunway(panel({ tel: T0, stale: T0 - 10 * MIN, newAt: T0 - 10 * MIN, circuits: [900, 900] }), recorder([]), forecast(2000));
  assert.equal(replay.recentLoadBasis, null, 'a REST 200 that replays the cached body bumps the clock, not the content');
  resetRunwayCache();
  const newBody = computeRunway(panel({ tel: T0, stale: T0 - 10 * MIN, newAt: T0, circuits: [900, 900] }), recorder([]), forecast(2000));
  assert.equal(newBody.recentLoadBasis, 'live', 'latchedBodyNew: the first new body is a reading (the recorder writes it)');
  assert.equal(newBody.recentLoadWatts, 1800);
});

test('★★ (f) a fresh panel with an empty hour (the post-restart case the rung exists for) is the live load', () => {
  now = T0;
  const r = computeRunway(panel({ tel: T0 - 20_000, circuits: [900, 900] }), recorder([]), forecast(2000));
  assert.equal(r.recentLoadBasis, 'live');
  assert.equal(r.recentLoadWatts, 1800);
  assert.equal(r.unavailable, null);
});

/* ── the alarm across the hold ──────────────────────────────────────────────────────────────── */

const statePaths: string[] = [];
after(() => { for (const p of statePaths) rmSync(p, { force: true }); });

test('★★★ the runway alarm HOLDS its state while the house runway is unavailable, and re-announces on return', () => {
  const statePath = join(tmpdir(), `runway-held-${process.pid}-${Date.now()}.json`);
  statePaths.push(statePath);
  const fired: string[] = [];
  // The post-boot re-arm warm-up is switched OFF outright: it compares the mocked Date.now() (T0, a
  // fixed instant in the past) with the real process start, so a warm-up of 0 still read as inside
  // it and blocked the re-arm by itself, and this test passed with the hold deleted.
  const alarm = createRunwayAlarm({ onTrigger: (p) => fired.push(p), statePath, rearmWarmupMs: Number.NEGATIVE_INFINITY, reannounceMs: H });
  const rec = recorder(hourTo(6000));
  const at = (ms: number, p: PanelState) => { now = T0 + ms; const r = computeRunway(panel(p), rec, forecast(2000)); alarm.update(r); return r; };
  at(0, { tel: T0, circuits: [300, 300] });
  assert.deepEqual(fired, ['medium'], '5.3 h to reserve on the recorded 6 kW');
  at(70 * MIN, { tel: T0, stale: T0, circuits: [300, 300] });
  assert.deepEqual(fired, ['medium', 'medium'], 'the carried load keeps the tier, and the hourly reminder');
  const out = at(5 * H, { tel: T0, stale: T0, circuits: [300, 300] });
  assert.ok(out.unavailable, 'past the carry: unavailable');
  assert.equal(alarm.state().announcedPriority, 'medium', 'held — v1.192.0 read this as a recovery and re-armed');
  assert.equal(alarm.state().lastAnnouncedAt, T0 + 70 * MIN);
  // The panel reports again (fresh rows, the latch released): the depletion persisted past the
  // re-announce window, so it is announced again — as the reminder it is.
  const back = recorder([...hourTo(6000), ...Array.from({ length: 10 }, (_, i) => ({ ts: T0 + 5 * H - (9 - i) * MIN + MIN, value: 6000 }))]);
  now = T0 + 5 * H + 2 * MIN;
  alarm.update(computeRunway(panel({ tel: now, circuits: [3000, 3000] }), back, forecast(2000)));
  assert.deepEqual(fired, ['medium', 'medium', 'medium']);
});

test('★★ a blip of unavailability does not re-arm the alarm into a fresh announcement minutes later', () => {
  mock.restoreAll(); // the real clock: the alarm's post-boot re-arm warm-up reads it (generatedAt is the alarm's own clock)
  const statePath = join(tmpdir(), `runway-blip-${process.pid}-${Date.now()}.json`);
  statePaths.push(statePath);
  const fired: string[] = [];
  const alarm = createRunwayAlarm({ onTrigger: (p) => fired.push(p), statePath, rearmWarmupMs: 0, reannounceMs: H });
  const base = { hoursToReserve: 20, hoursToEmpty: null, unavailable: null };
  alarm.update({ generatedAt: 0, ...base });
  alarm.update({ generatedAt: 5 * MIN, hoursToReserve: null, hoursToEmpty: null, unavailable: 'panel-load history insufficient — wait a few minutes' });
  assert.equal(alarm.state().announcedPriority, 'low');
  alarm.update({ generatedAt: 10 * MIN, ...base });
  assert.deepEqual(fired, ['low'], 'v1.192.0: re-armed at +5 and announced again at +10');
  // A REAL recovery still re-arms.
  alarm.update({ generatedAt: 15 * MIN, hoursToReserve: null, hoursToEmpty: null, unavailable: null });
  assert.equal(alarm.state().announcedPriority, null);
});

test('★★★ the load-shed advisor HOLDS its recommendation while the house runway is unavailable (it called it healthy)', () => {
  const rec = recorder(hourTo(6000));
  const pump = { entityId: 'switch.pool_pump', label: 'Pool pump', priority: 1, estimatedWatts: 0, shp2Ch: null, flaggedKeyword: null };
  const advisor = createLoadShedAdvisor({
    getCandidates: () => [pump],
    haEntity: (id) => (id === pump.entityId ? { entityId: id, state: 'on', attributes: {}, watts: 3000, fetchedAt: now } : null),
    shp2CircuitWatts: () => null,
    thresholdHours: () => 6,
    restoreMarginHours: () => 2,
    now: () => now,
  });
  const at = (ms: number, p: PanelState) => { now = T0 + ms; return computeRunway(panel(p), rec, forecast(2000)); };
  const first = advisor.update(at(0, { tel: T0, circuits: [300, 300] }));
  assert.equal(first.band, 'medium', '5.3 h to reserve on the recorded 6 kW');
  assert.deepEqual(first.recommended.map((r) => r.entityId), [pump.entityId]);
  assert.equal(advisoryStateFields(first).load_shed_recommended, true);
  // Past the carry the runway is unavailable: the advisory stands, its age with it.
  const out = at(5 * H, { tel: T0, stale: T0, circuits: [300, 300] });
  assert.ok(out.unavailable, 'past the carry: unavailable');
  const held = advisor.update(out);
  assert.equal(held, first, 'the last advisory on an available runway, unchanged');
  assert.equal(advisoryStateFields(advisor.getStatus()).load_shed_recommended, true, 'v1.192.0 shape: "Runway healthy", recommendation cleared');
  assert.equal(held.generatedAt, T0);
  assert.match(held.note, /^Runway medium: reserve in 5\.3 h\. Shedding Pool pump/);
  // The panel reports again: recomputed on the live runway.
  const back = recorder([...hourTo(6000), ...Array.from({ length: 10 }, (_, i) => ({ ts: T0 + 5 * H - (9 - i) * MIN + MIN, value: 6000 }))]);
  now = T0 + 5 * H + 2 * MIN;
  const again = advisor.update(computeRunway(panel({ tel: now, circuits: [3000, 3000] }), back, forecast(2000)));
  assert.notEqual(again, first);
  assert.equal(again.generatedAt, now);
  // With no available runway yet (a restart into a hold), nothing to hold: no shed, and never "healthy".
  const fresh = createLoadShedAdvisor({
    getCandidates: () => [pump], haEntity: () => null, shp2CircuitWatts: () => null,
    thresholdHours: () => 6, restoreMarginHours: () => 2, now: () => now,
  });
  const none = fresh.update(out);
  assert.equal(advisoryStateFields(none).load_shed_recommended, false);
  assert.equal(none.note, 'Runway projection unavailable — no shed recommended.');
});
