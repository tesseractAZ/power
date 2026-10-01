/**
 * v1.187.1 — the soiling estimate measures the array, not the packs; it is never spoken.
 *
 * 2026-09-30 17:03 MST: soiling-pv rose to a warning at 47.9% and, as the only counted warning,
 * raised the broadcast condition to yellow: "Medium priority alarm. Solar system. Solar output
 * below clean-panel baseline … about 47.9 percent less …" spoken twice. The panels were clean.
 * Three of the five recent clear days were days the packs reached 100% early in the afternoon:
 * each DPU then backs its MPPTs off to the load (Core 1 2766 → 643 W at 13:00 under 786 W/m²),
 * and computeSoiling counted those hours as dirty panels. Unshed morning hours sat within ±5% of
 * their baseline.
 *
 * (1) computeSoiling leaves out each Core's charge-taper hours (chargeTaperHoursFromPts: its own
 *     pack's highest SoC in the hour at or above ceiling − 10, or no SoC recorded) and a day that
 *     lost any counts only if the hours left reach the coverage bar.
 * (2) The PV of [H, H+1) pairs with the radiation labelled H+1 (coveringRadiationEpoch), clear only
 *     when the cloud reading at BOTH labels is ≤ 25%, and only for completed hours.
 * (3) soiling-pv is `audible: false` (card and push kept), and conditionFromAlerts excludes the id.
 * (review) The recent pool must be recent (three of its days in the last ten, else not covered),
 *     and the wash card requires the same; an hour pairs only once its covering label predates
 *     the live cache's fetch (soilingPairedUntil); each Core keeps its own taper set in any order.
 *
 * The fixtures mirror the September pattern: clean clear days, cloudy days, and clear days on
 * which the packs fill by noon (09-18, 09-21, 09-25, 09-30).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSoiling, fleetSoilingFromDevices, chargeTaperHoursFromPts, soilingClearSkyHour, soilingPairedUntil,
  forecastDayAlerts, getDayForecast, computeSoilingDecomposition, resetForecastCachesForTesting,
  resetRunwayCache, type DayForecast, type SoilingEstimate,
} from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride, type WeatherHour } from '../src/weather.js';
import { conditionFromAlerts, speakableAlerts } from '../src/broadcast.js';
import { buildAlertMessage, pickPrimaryAlert } from '../src/ttsService.js';
import { computeRepairIssues } from '../src/repairIssues.js';
import type { Alert } from '../src/alerts.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const H = 3_600_000;
const K = 3.3; // the clean clear-sky coefficient, W per W/m², paired by the covering label
const CAP_W = 800; // the PV a full pack lets through (the house load), W
type Pt = { ts: number; value: number };

/** Clear-sky radiation for the label L (local hour): the average of [L − 1, L), sun up rise → set. */
const ghiAtLabel = (L: number, rise = 7, set = 19) => Math.max(0, Math.round(1000 * Math.sin((Math.PI * (L - 0.5 - rise)) / (set - rise))));
/** Local wall-clock hour h on the local calendar day of `day`. */
const at = (day: Date, h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();

type Kind = 'clean' | 'cloudy' | 'taper';
interface CoreSpec {
  /** Local hour from which this Core's pack is in its taper on a 'taper' day. */
  taperFrom: number;
  /** Soiling factor by day index (1 = clean). */
  factor?: (i: number) => number;
  /** Clean coefficient by local hour (default K at every hour). */
  k?: (h: number) => number;
  /** On a soiled taper day the pack fills later (less PV): its own taper start. */
  soiledTaperFrom?: number;
}
interface Fixture {
  wx: Map<number, WeatherHour>;
  ghiRows: Pt[];
  cloudRows: Pt[];
  cores: Array<{ pv: Map<number, number>; pvPts: Pt[]; socPts: Pt[]; taper: Set<number> }>;
}

/**
 * `days[i]` is the calendar day of index i with its kind. Weather labels 6..20 every day; PV
 * hours 6..19 (only hours whose covering radiation is ≥ 250 W/m² are clear-sky hours: 08-17).
 * SoC is three 20-minute buckets per hour, rising through the morning; on a taper day it reaches
 * 100 at `taperFrom` and the PV is capped at the load.
 */
function buildFixture(days: Array<{ day: Date; kind: Kind }>, cores: CoreSpec[], sun: (i: number) => { rise: number; set: number } = () => ({ rise: 7, set: 19 })): Fixture {
  const wx = new Map<number, WeatherHour>();
  const ghiRows: Pt[] = [];
  const cloudRows: Pt[] = [];
  days.forEach(({ day, kind }, i) => {
    const { rise, set } = sun(i);
    for (let L = 6; L <= 20; L++) {
      const ts = at(day, L);
      const radiationWm2 = ghiAtLabel(L, rise, set);
      const cloudCoverPct = kind === 'cloudy' ? 80 : 5;
      wx.set(Math.floor(ts / H), { ts, radiationWm2, cloudCoverPct, tempC: 30 } as WeatherHour);
      ghiRows.push({ ts, value: radiationWm2 });
      cloudRows.push({ ts, value: cloudCoverPct });
    }
  });
  const out = cores.map((spec) => {
    const pv = new Map<number, number>();
    const pvPts: Pt[] = [];
    const socPts: Pt[] = [];
    days.forEach(({ day, kind }, i) => {
      const { rise, set } = sun(i);
      const f = spec.factor?.(i) ?? 1;
      const from = f < 1 && spec.soiledTaperFrom != null ? spec.soiledTaperFrom : spec.taperFrom;
      for (let h = 6; h <= 19; h++) {
        const ts = at(day, h);
        const full = kind === 'taper' && h >= from;
        const raw = (spec.k?.(h) ?? K) * f * ghiAtLabel(h + 1, rise, set) * (kind === 'cloudy' ? 0.3 : 1);
        const w = full ? Math.min(raw, CAP_W) : raw;
        if (w <= 0) continue;
        pv.set(Math.floor(ts / H), w);
        pvPts.push({ ts, value: w });
        const soc = full ? 100 : kind === 'taper' && h === from - 1 ? 84 : Math.min(80, 50 + 3 * (h - 6));
        for (const m of [0, 20, 40]) socPts.push({ ts: ts + m * 60_000, value: soc });
      }
    });
    return { pv, pvPts, socPts, taper: chargeTaperHoursFromPts(pv, socPts, [], 100) };
  });
  return { wx, ghiRows, cloudRows, cores: out };
}

/** September 2026 as recorded: which clear days filled the packs by noon, which were cloudy. */
const SEPT_TAPER = new Set([18, 21, 25, 30]);
const SEPT_CLOUDY = new Set([4, 5, 6, 7, 9, 10, 11, 12, 15, 16, 17, 20, 23, 24, 27, 28, 29]);
const septDays = (): Array<{ day: Date; kind: Kind }> =>
  Array.from({ length: 30 }, (_, k) => {
    const d = k + 1;
    return { day: new Date(2026, 8, d), kind: SEPT_TAPER.has(d) ? 'taper' : SEPT_CLOUDY.has(d) ? 'cloudy' : 'clean' };
  });
/** 09-30 17:30 local: hours to 16:00 are complete. */
const SEPT_30_1730 = new Date(2026, 8, 30, 17, 30).getTime();
/** Midnight after 09-30: every September hour is complete. */
const OCT_1 = new Date(2026, 9, 1).getTime();
/** Cores 1 and 5 full by noon, Core 2 by 14:00 (09-30: Core 2 still at 97.6% at 13:00). */
const SEPT_CORES: CoreSpec[] = [{ taperFrom: 12 }, { taperFrom: 14 }, { taperFrom: 12 }];

/* ══ (1) the 09-30 incident: full packs are not dirty panels ══ */

test('★★★ 09-30: three full-pack days in the last five read as ~48% "soiling"; with the taper hours left out, under 12% and no alert', () => {
  const fx = buildFixture(septDays(), SEPT_CORES);
  const maps = fx.cores.map((c) => c.pv);
  // Positive control: every hour counted (the v1.187.0 rule) reproduces the incident.
  const before = fleetSoilingFromDevices(maps, fx.wx, [], SEPT_30_1730);
  assert.ok(before && before.dropPct >= 40, `the fixture reproduces the ~47.9% artifact (got ${before?.dropPct})`);
  assert.equal(forecastDayAlerts(forecastWith(before))[0]?.severity, 'warning', 'which was a warning, ≥ 22%');
  // The fix.
  const after = fleetSoilingFromDevices(maps, fx.wx, fx.cores.map((c) => c.taper), SEPT_30_1730);
  assert.ok(after, 'still an estimate: the clean days carry it');
  assert.ok(after!.dropPct < 12, `below the 12% alert floor (got ${after!.dropPct})`);
  assert.equal(forecastDayAlerts(forecastWith(after)).find((a) => a.id === 'soiling-pv'), undefined, 'no soiling-pv alert');
  // The number alone keeps it quiet, not only the recency gate below.
  assert.equal(forecastDayAlerts(forecastWith({ ...after!, recentCovered: true })).find((a) => a.id === 'soiling-pv'), undefined);
  // Per Core: the two that filled by noon lose those days; the clean baseline is not inflated.
  for (const [i, c] of fx.cores.entries()) {
    const e = computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_1730)!;
    assert.ok(Math.abs(e.baselineCoeff - K) < 0.05, `Core ${i}: baseline stays at the clean ${K} (got ${e.baselineCoeff})`);
    assert.ok(e.dropPct < 12, `Core ${i}: ${e.dropPct}`);
    assert.ok((e.taperHours ?? 0) > 0, 'the diagnostic counts the hours left out');
  }
  // And the recency gate: the noon-filling Cores have only 09-22 and 09-26 well covered in the last
  // ten days, so their verdict is not covered; the Core that fills at 14:00 keeps five such days.
  assert.deepEqual(fx.cores.map((c) => computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_1730)!.recentCovered), [false, true, false]);
  assert.equal(after!.recentCovered, false, 'fewer than two covered Cores: the fleet is not covered');
});

test('★★★ a genuinely soiled array still alerts — on full-pack days too (a dimmer array fills later)', () => {
  // From 09-19 every array is 25% dimmer; on the clear days that still fill, the packs fill at 14:00.
  const soiled: CoreSpec[] = SEPT_CORES.map((c) => ({ ...c, factor: (i: number) => (i >= 18 ? 0.75 : 1), soiledTaperFrom: 14 }));
  const fx = buildFixture(septDays(), soiled);
  const est = fleetSoilingFromDevices(fx.cores.map((c) => c.pv), fx.wx, fx.cores.map((c) => c.taper), SEPT_30_1730);
  assert.ok(est && est.dropPct >= 22, `a real 25% loss is a warning (got ${est?.dropPct})`);
  const alert = forecastDayAlerts(forecastWith(est)).find((a) => a.id === 'soiling-pv');
  assert.ok(alert, 'still alerts');
  assert.equal(alert!.severity, 'warning');
  assert.notEqual(alert!.annunciate, false, 'the push is kept');
  // And with the packs never full, the same loss reads the same.
  const unshed = buildFixture(septDays().map((d) => ({ ...d, kind: d.kind === 'taper' ? 'clean' as const : d.kind })), soiled);
  const e2 = fleetSoilingFromDevices(unshed.cores.map((c) => c.pv), unshed.wx, unshed.cores.map((c) => c.taper), SEPT_30_1730);
  assert.ok(e2 && Math.abs(e2.dropPct - 25) < 1, `uniform 25% → 25% (got ${e2?.dropPct})`);
});

test('★★★ a full-pack day counts only if its unshed hours reach the coverage bar — a morning sliver cannot lift the baseline', () => {
  // The clean coefficient varies by hour (a morning bump: 3.9 to 10:00, 3.3 after), as one home
  // Core's does. A full day's median is 3.3; a morning sliver (08-11) reads 3.9. Admitted, four
  // slivers would own the p90 baseline and report a phantom ~15% drop on a clean array.
  const bump: CoreSpec = { taperFrom: 12, k: (h) => (h <= 10 ? 3.9 : 3.3) };
  const fx = buildFixture(septDays(), [bump]);
  const [c] = fx.cores;
  const e = computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_1730)!;
  assert.ok(e, 'an estimate from the clean days');
  assert.ok(e.dropPct < 12, `no phantom drop from slivers (got ${e.dropPct})`);
  assert.equal(e.cleanDays, 9, 'the nine clean clear days, not the four full-pack slivers');
  assert.ok(!e.dayHours!.includes(4), 'no 4-hour day');
  assert.equal(e.covBar, 5);
});

test('★★ the coverage bar is inclusive for a full-pack day: exactly covBar unshed hours count (as the recent pool\'s own bar)', () => {
  // Full from 13:00: unshed 08-12 = 5 hours = covBar.
  const fx = buildFixture(septDays(), [{ taperFrom: 13 }]);
  const [c] = fx.cores;
  const e = computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_1730)!;
  assert.equal(e.covBar, 5);
  assert.equal(e.cleanDays, 13, 'the four full-pack days are measurement days');
  assert.equal(e.dayHours!.filter((n) => n === 5).length, 4);
  assert.ok(e.dropPct < 1, `and they read clean (got ${e.dropPct})`);
});

/* ══ (1b) the recent pool must be recent ══ */

/** September with clean clear days to 09-19, then cloud except on the `clear` days. */
const lateClear = (clear: number[]): Array<{ day: Date; kind: Kind }> =>
  Array.from({ length: 30 }, (_, k) => {
    const d = k + 1;
    return { day: new Date(2026, 8, d), kind: d <= 19 || clear.includes(d) ? 'clean' : 'cloudy' };
  });

test('★★★ the recent pool must be recent: three of its days in the last ten, else not covered (dropPct still reported)', () => {
  const est = (clear: number[], pairedUntil = SEPT_30_1730) => {
    const fx = buildFixture(lateClear(clear), [{ taperFrom: 99 }]);
    const [c] = fx.cores;
    return computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_1730, pairedUntil)!;
  };
  // 09-30 17:30: the window holds the days that began after 09-20 17:30, i.e. 09-21..09-30.
  assert.equal(est([21, 22, 23]).recentCovered, true, 'three recent well-covered days');
  const two = est([21, 22]);
  assert.equal(two.recentCovered, false, 'two recent days and three from 09-14..19: a stale median');
  assert.equal(two.dropPct, 0, 'the figure is still reported, for display');
  assert.equal(two.cleanDays, 21);
  assert.equal(est([20, 21, 22]).recentCovered, false, '09-20 began before the window: the newest covered day is 8 days old');
  assert.equal(est([]).recentCovered, false, 'nothing since 09-19');
  // The age is judged on the clock, not on the pairing bound: a fetch three days old does not
  // carry the window back with it.
  assert.equal(est([21, 22], SEPT_30_1730 - 72 * H).recentCovered, false);
});

test('★★★ 09-30 Core 1: a dusty spell washed by rain, then clear days full by 11:00 — the stale pool reads ≥12%, and the alert and the wash card stay quiet', async () => {
  // Relative to today: 17 clean clear days (the last seven of them 20% low: dust), three days of
  // rain, then ten clear days on which every pack is full by 11:00 (3 unshed hours: no measurement
  // day). The last five well-covered days are the dusty ones, 11-17 days old.
  const today = new Date();
  const days = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (30 - i)),
    kind: (i < 17 ? 'clean' : i < 20 ? 'cloudy' : 'taper') as Kind,
  }));
  const spec: CoreSpec = { taperFrom: 11, factor: (i) => (i >= 10 && i < 17 ? 0.8 : 1) };
  const fx = buildFixture(days, [spec, spec, spec]);
  futureWeatherCache();
  resetForecastCachesForTesting();
  resetRunwayCache();
  try {
    const fc = await getDayForecast(devices() as any, recorderFor(fx));
    assert.ok(fc.soiling && fc.soiling.dropPct >= 12, `the stale pool reads the washed-off dust (got ${fc.soiling?.dropPct})`);
    assert.equal(fc.soiling!.recentCovered, false, 'none of its days is in the last ten');
    assert.equal(forecastDayAlerts(fc).find((a) => a.id === 'soiling-pv'), undefined, 'no soiling-pv');
    setWeatherCacheForTesting(null);
    resetForecastCachesForTesting();
    const r = await computeSoilingDecomposition(devices() as any, recorderFor(fx));
    assert.equal(r.perDevice.length, 3);
    for (const d of r.perDevice) {
      assert.ok(d.dropPct != null && d.dropPct >= 12, `${d.device}: the figure is still shown (${d.dropPct})`);
      assert.equal(d.recentCovered, false, d.device);
    }
    const card = computeRepairIssues({ devices: {}, alerts: [], degradation: null, soiling: r, equipmentHealth: null, forecastSkill: null })
      .issues.find((i) => i.id === 'wash-panels');
    assert.equal(card, undefined, 'no "Wash solar panels" for panels the rain washed');
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('★★ a stale pool no longer calls a newly dimmed array clean: 25% dimmer from 09-22, every clear day full by 11:00 → not covered', () => {
  const kinds = septDays().map((d, i) => (i >= 21 && d.kind !== 'cloudy' ? { ...d, kind: 'taper' as const } : d));
  const dim: CoreSpec = { taperFrom: 11, factor: (i) => (i >= 21 ? 0.75 : 1) };
  const fx = buildFixture(kinds, [dim, dim, dim]);
  const est = fleetSoilingFromDevices(fx.cores.map((c) => c.pv), fx.wx, fx.cores.map((c) => c.taper), SEPT_30_1730)!;
  assert.ok(est.dropPct < 12, `the pool is all pre-dimming days (got ${est.dropPct})`);
  assert.equal(est.recentCovered, false, 'and the estimate says it cannot tell, rather than "clean"');
  assert.equal(forecastDayAlerts(forecastWith(est)).find((a) => a.id === 'soiling-pv'), undefined);
});

/* ══ (2) pairing: the covering label, clear at both ends, completed hours ══ */

test('★★★ PV hour [H, H+1) pairs with the radiation labelled H+1: a clean array reads its coefficient at every hour, every day', () => {
  // The sun's day shortens through the month (as in autumn), so a label-H pairing reads a different
  // ratio at every hour and on every day; the covering label reads exactly K.
  const fx = buildFixture(septDays().map((d) => ({ ...d, kind: d.kind === 'cloudy' ? 'cloudy' : 'clean' as const })), [{ taperFrom: 99 }],
    (i) => ({ rise: 6.5 + 0.03 * i, set: 19.2 - 0.03 * i }));
  const [c] = fx.cores;
  const e = computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_1730)!;
  assert.ok(e.dayCoeffs!.every((x) => x === K), `every day reads ${K}: ${e.dayCoeffs!.join(', ')}`);
  assert.equal(e.dropPct, 0);
  const he = Math.floor(at(new Date(2026, 8, 3), 10) / H);
  assert.equal(soilingClearSkyHour(fx.wx, he, SEPT_30_1730), fx.wx.get(he + 1), 'the covering row');
});

test('★★★ the clear-sky gate reads the cloud at BOTH ends of the hour; a missing end is not clear', () => {
  const fx = buildFixture(septDays(), [{ taperFrom: 99 }]); // the packs never fill
  const [c] = fx.cores;
  const day = new Date(2026, 8, 30);
  const base = computeSoiling(c.pv, fx.wx, c.taper, OCT_1)!;
  const idx = (e: SoilingEstimate) => e.dayHours![e.dayHours!.length - 1]; // 09-30, the last clear day
  assert.equal(idx(base), 10, '08:00-17:00');
  // A cloud reading at the 10:00 label: the hour 09-10 ends on it and the hour 10-11 starts on it.
  const wx = new Map(fx.wx);
  const l10 = Math.floor(at(day, 10) / H);
  wx.set(l10, { ...wx.get(l10)!, cloudCoverPct: 80 });
  assert.equal(idx(computeSoiling(c.pv, wx, c.taper, OCT_1)!), 8, 'both hours touching the cloudy reading are out');
  assert.equal(soilingClearSkyHour(wx, l10 - 1, OCT_1), null, 'cloud at the covering (end) label');
  assert.equal(soilingClearSkyHour(wx, l10, OCT_1), null, 'cloud at the start label');
  // No reading at all at the 12:00 label: neither hour touching it is a measurement.
  const wx2 = new Map(fx.wx);
  wx2.delete(Math.floor(at(day, 12) / H));
  assert.equal(idx(computeSoiling(c.pv, wx2, c.taper, OCT_1)!), 8);
});

test('★★ only completed hours pair: the label covering the hour in progress is still a forecast', () => {
  const fx = buildFixture(septDays(), [{ taperFrom: 99 }]);
  const he = Math.floor(at(new Date(2026, 8, 26), 13) / H);
  assert.equal(soilingClearSkyHour(fx.wx, he, (he + 1) * H), fx.wx.get(he + 1), 'complete at its end');
  assert.equal(soilingClearSkyHour(fx.wx, he, (he + 1) * H - 1), null, 'one millisecond before, in progress');
  // 09-26 14:30: 08:00-13:00 are complete (6 hours); 14:00 is in progress.
  const e = computeSoiling(fx.cores[0].pv, fx.wx, fx.cores[0].taper, new Date(2026, 8, 26, 14, 30).getTime())!;
  assert.equal(e.dayHours![e.dayHours!.length - 1], 6);
});

/** 09-30 made a clean clear day (it was a full-pack day). */
const sept30Clean = () => septDays().map((d) => (d.day.getDate() === 30 ? { ...d, kind: 'clean' as const } : d));
const SEPT_30_NOON = new Date(2026, 8, 30, 12).getTime();

test('★★★ soilingPairedUntil: the live cache\'s fetch when earlier than the clock, else the clock', () => {
  assert.equal(soilingPairedUntil(SEPT_30_NOON, null), SEPT_30_NOON, 'no cache: the clock');
  assert.equal(soilingPairedUntil(SEPT_30_NOON, { fetchedAt: SEPT_30_NOON - 1.5 * H }), SEPT_30_NOON - 1.5 * H);
  assert.equal(soilingPairedUntil(SEPT_30_NOON, { fetchedAt: SEPT_30_NOON + H }), SEPT_30_NOON, 'a fetch stamped ahead of the clock does not open the hour in progress');
});

test('★★★ an hour pairs only once its covering label predates the weather fetch: fetched 1.5 h ago, the hour that ended 1 h ago does not pair', () => {
  const fx = buildFixture(sept30Clean(), [{ taperFrom: 99 }]);
  const [c] = fx.cores;
  const fetched = SEPT_30_NOON - 1.5 * H; // 10:30
  const he10 = Math.floor(at(new Date(2026, 8, 30), 10) / H); // [10:00, 11:00), ended at 11:00
  assert.equal(soilingClearSkyHour(fx.wx, he10, SEPT_30_NOON), fx.wx.get(he10 + 1), 'complete by the clock');
  assert.equal(soilingClearSkyHour(fx.wx, he10, fetched), null, 'its covering label (11:00) came after the 10:30 fetch');
  // 09-30 at noon: 08:00-12:00 holds four complete hours; with the fetch at 10:30 only 08-10
  // pair, and two hours are no day.
  const clock = computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_NOON, SEPT_30_NOON)!;
  const bound = computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_NOON, fetched)!;
  assert.equal(clock.dayHours![clock.dayHours!.length - 1], 4);
  assert.equal(clock.cleanDays - bound.cleanDays, 1, '09-30 is not a measurement day yet');
  assert.equal(computeSoiling(c.pv, fx.wx, c.taper, SEPT_30_NOON)!.cleanDays, clock.cleanDays, 'the bound defaults to the clock');
});

/* ══ the taper hours ══ */

test('★★★ chargeTaperHoursFromPts: the pack\'s HIGHEST SoC in the hour, at or above ceiling − 10; unknown SoC is excluded', () => {
  const he = 500_000;
  const pv = new Map([[he, 3000], [he + 1, 3000], [he + 2, 3000], [he + 3, 3000]]);
  const pts = (h: number, ...v: number[]) => v.map((value, k) => ({ ts: h * H + k * 600_000, value }));
  const soc = [...pts(he, 86, 88, 91), ...pts(he + 1, 89.9, 89.9), ...pts(he + 2, 90)];
  const t = chargeTaperHoursFromPts(pv, soc, [], 100);
  assert.ok(t.has(he), 'reached 91 inside the hour (a mean of 88.3 would miss it)');
  assert.ok(!t.has(he + 1), '89.9 is below the band');
  assert.ok(t.has(he + 2), 'exactly 90 is in the band (the curtailment predicate)');
  assert.ok(t.has(he + 3), 'no SoC recorded for the hour: unknown is not headroom');
});

test('★★ chargeTaperHoursFromPts: the hour\'s recorded ceiling, else the live one, else 100', () => {
  const he = 600_000;
  const pv = new Map([[he, 3000]]);
  const soc = [{ ts: he * H, value: 75 }];
  const ceil = (v: number) => [{ ts: he * H, value: v }];
  assert.ok(chargeTaperHoursFromPts(pv, soc, ceil(80), 100).has(he), 'recorded 80 → band from 70');
  assert.ok(chargeTaperHoursFromPts(pv, soc, [], 80).has(he), 'none recorded, live 80 → band from 70');
  assert.ok(chargeTaperHoursFromPts(pv, soc, ceil(0), 80).has(he), 'a recorded 0 is no ceiling: the live 80 applies');
  assert.ok(!chargeTaperHoursFromPts(pv, soc, [], null).has(he), 'neither → 100, band from 90');
});

test('★★★ each Core is judged on ITS OWN taper hours, in any order: a late filler listed first lends its set to no one', () => {
  // Core A fills at 14:00, Core B at 11:00, A first: a set taken by position 0, or in reverse
  // order, gives B A's later set, and B's shed 11:00-14:00 hours count.
  const fx = buildFixture(septDays(), [{ taperFrom: 14 }, { taperFrom: 11 }]);
  const [A, B] = fx.cores;
  assert.ok(computeSoiling(A.pv, fx.wx, A.taper, SEPT_30_1730)!.dropPct < 12);
  assert.ok(computeSoiling(B.pv, fx.wx, B.taper, SEPT_30_1730)!.dropPct < 12);
  const crossed = computeSoiling(B.pv, fx.wx, A.taper, SEPT_30_1730)!;
  assert.ok(crossed.dropPct >= 12, `positive control: B on A's set reads its shed hours as soiling (got ${crossed.dropPct})`);
  const fleet = fleetSoilingFromDevices([A.pv, B.pv], fx.wx, [A.taper, B.taper], SEPT_30_1730)!;
  assert.ok(fleet.dropPct < 12, `the fleet (got ${fleet.dropPct})`);
  // Three Cores filling at 14:00, 12:00 and 11:00, latest first.
  const fx3 = buildFixture(septDays(), [{ taperFrom: 14 }, { taperFrom: 12 }, { taperFrom: 11 }]);
  for (const [i, c] of fx3.cores.entries()) assert.ok(computeSoiling(c.pv, fx3.wx, c.taper, SEPT_30_1730)!.dropPct < 12, `Core ${i}`);
  assert.ok(fleetSoilingFromDevices(fx3.cores.map((c) => c.pv), fx3.wx, fx3.cores.map((c) => c.taper), SEPT_30_1730)!.dropPct < 12);
});

/* ══ (3) never on the speakers ══ */

const HOST_TEMP_WARN: Alert = {
  id: 'host-temp-warn', severity: 'warning', category: 'Connectivity', device: 'System',
  title: 'Alarm host running hot',
  detail: 'The host running this monitor reads 78°C at the SoC — above the 75°C action threshold.',
};

test('★★★ NOT AUDIBLE: a soiling-pv warning keeps its card and push but never raises the condition', () => {
  const [soil] = forecastDayAlerts(forecastWith({ dropPct: 47.9, baselineCoeff: 3.494, recentCoeff: 1.819, cleanDays: 18, recentCovered: true }));
  assert.equal(soil.id, 'soiling-pv');
  assert.equal(soil.severity, 'warning');
  assert.equal(soil.audible, false, 'audible:false keeps it off the speakers');
  assert.notEqual(soil.annunciate, false, 'the push is kept');
  assert.equal(conditionFromAlerts([soil]).level, 'green', 'it alone is not a yellow (09-30 17:03)');
  // The id exclusion in conditionFromAlerts is the second guard.
  assert.equal(conditionFromAlerts([{ ...soil, audible: undefined }]).level, 'green', 'the id is excluded from the count too');
  assert.equal(conditionFromAlerts([soil, HOST_TEMP_WARN]).level, 'yellow', 'the exclusion is this id only');
  const info = forecastDayAlerts(forecastWith({ dropPct: 14, baselineCoeff: 3.5, recentCoeff: 3.0, cleanDays: 18, recentCovered: true }))[0];
  assert.equal(info.severity, 'info');
  assert.equal(info.audible, false, 'at every severity');
});

test('★★★ SPOKEN MESSAGE: when another warning raises the yellow, the words name THAT warning, never soiling', () => {
  const [soil] = forecastDayAlerts(forecastWith({ dropPct: 47.9, baselineCoeff: 3.494, recentCoeff: 1.819, cleanDays: 18, recentCovered: true }));
  const spoken = speakableAlerts([soil, HOST_TEMP_WARN], Date.now(), () => undefined);
  assert.deepEqual(spoken.map((a) => a.id), ['host-temp-warn'], 'not in the array the message is built from');
  const msg = buildAlertMessage('yellow', spoken);
  assert.match(msg, /Alarm host running hot/);
  assert.doesNotMatch(msg, /soiling|clean-panel|Solar output/i);
  assert.equal(pickPrimaryAlert([soil, HOST_TEMP_WARN], 'yellow')?.id, 'host-temp-warn');
  assert.equal(pickPrimaryAlert([soil], 'yellow'), null);
});

/* ══ wiring: the forecast and the decomposition read each Core's own SoC ══ */

/** The September pattern relative to today: index i is `30 − i` days ago (09-30 ↔ yesterday). */
function relativeFixture(cores: CoreSpec[], sun?: (i: number) => { rise: number; set: number }) {
  const today = new Date();
  const days = septDays().map((d, i) => ({ kind: d.kind, day: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (30 - i)) }));
  return buildFixture(days, cores, sun);
}
const SNS = ['DPU-A', 'DPU-B', 'DPU-C'];
/** Live ceiling 95 and none recorded: the taper starts at 85, so the fixture's 88 is in it. */
const dpu = (sn: string): any => ({ sn, deviceName: sn, online: true, lastSeenMs: Date.now(), lastUpdated: Date.now(), projection: { kind: 'dpu', soc: 80, chgMaxSoc: 95, pvTotalWatts: 0, acInWatts: 0, acOutWatts: 0, packs: [] } });
const panel = (): any => ({ sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(), lastUpdated: Date.now(), projection: { kind: 'shp2', backupBatPercent: 60, backupFullCapWh: 92000, backupRemainWh: 60000, backupReserveSoc: 15, circuits: [], pairedCircuits: [], sources: SNS.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })), sourceWatts: [], strategy: {} } });
const devices = () => ({ 'SHP2-A': panel(), ...Object.fromEntries(SNS.map((sn) => [sn, dpu(sn)])) });

function recorderFor(fx: Fixture) {
  const inWin = (p: Pt[], from: number, to: number) => p.filter((x) => x.ts >= from && x.ts <= to);
  const series = (sn: string, metric: string): Pt[] => {
    const i = SNS.indexOf(sn);
    if (i < 0) return [];
    if (metric === 'pv_total') return fx.cores[i].pvPts;
    if (metric === 'soc') return fx.cores[i].socPts;
    return [];
  };
  return makeRecorderStub({
    query: (sn, metric, from, to) => {
      if (sn === 'weather' && metric === 'ghi_wm2') return inWin(fx.ghiRows, from, to);
      if (sn === 'weather' && metric === 'cloud_pct') return inWin(fx.cloudRows, from, to);
      return inWin(series(sn, metric), from, to);
    },
    queryMulti: (sn, metrics, from, to) => new Map(metrics.map((m) => [m, inWin(series(sn, m), from, to)])),
  });
}
/** A live cache that holds only future hours, so the recorder layer decides the past. */
function futureWeatherCache() {
  const start = Math.ceil(Date.now() / H) * H + H;
  setWeatherCacheForTesting({ fetchedAt: Date.now(), lat: 33.4, lon: -112, hours: Array.from({ length: 24 }, (_, k) => ({ ts: start + k * H, cloudCoverPct: 5, radiationWm2: 500, tempC: 25 })) } as any);
}
/** Taper days: the packs pass 85 (this ceiling's band) at noon but never reach 90. */
const CEIL95_CORES: CoreSpec[] = SEPT_CORES;

test('★★★ the forecast (getDayForecast) judges each home Core on its own pack: no soiling-pv on the full-pack days', async () => {
  const fx = relativeFixture(CEIL95_CORES);
  // On taper days the fixture's SoC is 100 from the taper hour; lower it to 88 so only the live
  // ceiling (95 → band from 85) puts those hours in the taper.
  for (const c of fx.cores) for (const p of c.socPts) if (p.value === 100) p.value = 88;
  futureWeatherCache();
  resetForecastCachesForTesting();
  resetRunwayCache();
  try {
    const fc = await getDayForecast(devices() as any, recorderFor(fx));
    assert.ok(fc.soiling, 'an estimate: soc and chg_max_soc ride the home Cores\' query');
    assert.ok(fc.soiling!.dropPct < 12, `no phantom soiling (got ${fc.soiling!.dropPct})`);
    assert.ok((fc.soiling!.taperHours ?? 0) > 0);
    assert.equal(forecastDayAlerts(fc).find((a) => a.id === 'soiling-pv'), undefined);
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('★★★ the forecast still reports a genuinely soiled fleet: a warning, audible:false', async () => {
  const soiled = SEPT_CORES.map((c) => ({ ...c, factor: (i: number) => (i >= 18 ? 0.75 : 1), soiledTaperFrom: 14 }));
  const fx = relativeFixture(soiled);
  futureWeatherCache();
  resetForecastCachesForTesting();
  resetRunwayCache();
  try {
    const fc = await getDayForecast(devices() as any, recorderFor(fx));
    assert.ok(fc.soiling && fc.soiling.dropPct >= 22, `got ${fc.soiling?.dropPct}`);
    const a = forecastDayAlerts(fc).find((x) => x.id === 'soiling-pv');
    assert.equal(a?.severity, 'warning');
    assert.equal(a?.audible, false);
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('★★★ the decomposition agrees: no per-Core drop, no afternoon per-hour drop, no wash card', async () => {
  // The sun's day shortens through the month, so a label-H pairing in the per-hour shape would
  // read the recent mornings differently from the older ones.
  const fx = relativeFixture(CEIL95_CORES, (i) => ({ rise: 6.5 + 0.03 * i, set: 19.2 - 0.03 * i }));
  for (const c of fx.cores) for (const p of c.socPts) if (p.value === 100) p.value = 88;
  setWeatherCacheForTesting(null);
  resetForecastCachesForTesting();
  try {
    const r = await computeSoilingDecomposition(devices() as any, recorderFor(fx));
    assert.equal(r.perDevice.length, 3);
    for (const d of r.perDevice) assert.ok(d.dropPct != null && d.dropPct < 12, `${d.device}: ${d.dropPct}`);
    // The unshed morning hours still form a shape (08:00 falls under the 400 W/m² floor on the
    // recent, shorter days), and a clean array reads no drop at any of them.
    assert.deepEqual(r.perHour.map((h) => h.hour), [9, 10, 11]);
    for (const h of r.perHour) assert.ok(Math.abs(h.dropPct) < 0.5, `hour ${h.hour}: ${h.dropPct}%`);
    const card = computeRepairIssues({ devices: {}, alerts: [], degradation: null, soiling: r, equipmentHealth: null, forecastSkill: null })
      .issues.find((i) => i.id === 'wash-panels');
    assert.equal(card, undefined, 'no "Wash solar panels" card for full packs');
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('★★★ the forecast gives each home Core its own taper set: the first home Core fills last', async () => {
  const fx = relativeFixture([{ taperFrom: 14 }, { taperFrom: 11 }, { taperFrom: 11 }]);
  futureWeatherCache();
  resetForecastCachesForTesting();
  resetRunwayCache();
  try {
    const fc = await getDayForecast(devices() as any, recorderFor(fx));
    assert.ok(fc.soiling, 'an estimate');
    assert.ok(fc.soiling!.dropPct < 12, `no phantom soiling from a borrowed set (got ${fc.soiling!.dropPct})`);
    assert.equal(forecastDayAlerts(fc).find((a) => a.id === 'soiling-pv'), undefined);
  } finally {
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

test('★★★ wired: the forecast and the decomposition pair an hour only once its covering label predates the cache\'s fetch', async () => {
  // 09-30 at noon (a fixed clock); 09-30 is a clean clear day. Fetched at noon, its hours 08:00-12:00
  // pair (4: a measurement day); fetched at 10:30, the hours that ended at 11:00 and 12:00 do not
  // (2: no day).
  const fx = buildFixture(sept30Clean(), [{ taperFrom: 99 }, { taperFrom: 99 }, { taperFrom: 99 }]);
  const cacheHours = [...fx.wx.values()].filter((w) => w.ts >= new Date(2026, 8, 30).getTime());
  mock.timers.enable({ apis: ['Date'], now: SEPT_30_NOON });
  const run = async (fetchedAt: number) => {
    setWeatherCacheForTesting({ fetchedAt, lat: 33.4, lon: -112, hours: cacheHours } as any);
    resetForecastCachesForTesting();
    resetRunwayCache();
    const fc = await getDayForecast(devices() as any, recorderFor(fx));
    resetForecastCachesForTesting();
    const r = await computeSoilingDecomposition(devices() as any, recorderFor(fx));
    return { soiling: fc.soiling!, r };
  };
  try {
    const clock = await run(SEPT_30_NOON);
    const bound = await run(SEPT_30_NOON - 1.5 * H);
    assert.ok(clock.soiling && bound.soiling);
    assert.equal(clock.soiling.cleanDays - bound.soiling.cleanDays, 1, 'the forecast: 09-30 is not a day yet');
    assert.deepEqual(clock.r.perDevice.map((d) => d.cleanDays - bound.r.perDevice.find((b) => b.sn === d.sn)!.cleanDays), [1, 1, 1], 'the per-Core rows');
    const samples = (x: typeof clock, h: number) => x.r.perHour.find((p) => p.hour === h)?.samples ?? 0;
    assert.equal(samples(clock, 10) - samples(bound, 10), 1, 'the per-hour shape: hour 10 loses 09-30');
    assert.equal(samples(clock, 9), samples(bound, 9), 'hour 9 (label 10:00, before the fetch) keeps it');
  } finally {
    mock.timers.reset();
    clearWeatherTestOverride();
    resetForecastCachesForTesting();
  }
});

/** A DayForecast carrying only a soiling estimate. */
function forecastWith(soiling: SoilingEstimate | null): DayForecast {
  return {
    generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 15, hours: [],
    forecastPvWhNext24: 50_000, typicalPvWhPerDay: 50_000, minProjectedSoc: null, minProjectedSocTs: null,
    homeDpusConnected: 0, homeDpusReporting: 0, homeDpusCoveragePartial: false,
    forecastPvWhNext24Display: 50_000, typicalPvWhPerDayDisplay: 50_000,
    solarModel: { hourly: [], peakCoeff: 0, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 30 },
    restoredSolarModel: { hourly: [], peakCoeff: 0, peakGateMinGhiWm2: 300, pairCount: 0, historyDays: 30 },
    deviceModels: [], soiling,
  } as DayForecast;
}
