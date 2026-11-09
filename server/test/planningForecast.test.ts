/**
 * v1.204.0 — the analytics worker's PLANNING layer (getPlanningForecast and its reports) on a synthetic
 * dark plant built through the recorder interface: three slots of one panel, 25 days of the Cores' own
 * meter with a night charge (the constants' days), then 19 dark days on which only the panel's per-slot
 * field reads the solar, with the energy bridge's windows measured and the vendor's daily solar beside it.
 * The slot percent follows a fixed energy balance, so the 7-day balance reads 1.
 *
 * It pins: the planning layer as of E (the verdict, the keys = the slots connected now, the solar model
 * from the panel's field, every window ending at the start of E), the alarm objects untouched (the
 * forecast's hours, the published band, the runway), the caches apart per basis and per E, the reports
 * echoing E, and the identity branch (no slot-hour took the field: every planning field IS the alarm
 * object). Serials are placeholders.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecorderStub } from './helpers/recorderStub.js';
import {
  getDayForecast, getPlanningForecast, computeForecastSkill, computeProbabilisticForecast, computeMultiDayForecast, computeRunway,
  resetForecastCachesForTesting, resetWorkerReportCaches, resetRunwayCache, type DayForecast,
} from '../src/analytics.js';
import {
  setPanelBasisConstantsPathForTesting, setPanelBasisMembershipForTesting, setPanelBasisSunForTesting, setPanelBasisVendorForTesting,
  resetPanelBasisMemos,
} from '../src/analytics/panelBasisInputs.js';
import { setWeatherCacheForTesting } from '../src/weather.js';
import { buildReport, resetReportBasisForTesting } from '../src/reports.js';
import { addDaysYmd, siteDayStartMs, siteYmd } from '../src/siteTime.js';
import type { Recorder } from '../src/recorder.js';

type Any = any;
const H = 3_600_000;
const STEP = 300_000;
const PANEL = 'PANEXXX00XXX0009';
const CORES = ['COREXXX00XXX0011', 'COREXXX00XXX0012', 'COREXXX00XXX0013'];
const E = siteYmd(Date.now());
const START = siteDayStartMs(addDaysYmd(E, -44));
const DARK = siteDayStartMs(addDaysYmd(E, -19));
const END = siteDayStartMs(E);
const K = { cd: 1.07, cn: 1.1, g: 0.92, ed: 80, en: 55 };
const CAP = 30_720;

const hourOfDay = (ms: number): number => Math.floor((ms - siteDayStartMs(siteYmd(ms))) / H);
const sun = (ms: number): boolean => { const h = (ms - siteDayStartMs(siteYmd(ms))) / H; return h >= 6.5 && h < 17.5; };
const frac = (n: number): number => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const dayIdx = (ms: number): number => Math.floor((ms - START) / (24 * H));
const ghiAt = (he: number): number => {
  const ms = he * H;
  const h = hourOfDay(ms) + 0.5;
  const clear = h > 6.5 && h < 17.5 ? 900 * Math.sin(Math.PI * (h - 6.5) / 11) : 0;
  return clear * (0.7 + 0.3 * frac(dayIdx(ms)));
};
/** One slot's hourly flows (constant over the hour). */
function flows(slot: number, hs: number) {
  const he = Math.floor(hs / H);
  const s = sun(hs) || sun(hs + H);
  const pv = s ? (2.6 + 0.2 * slot) * ghiAt(he) : 0;
  const hod = hourOfDay(hs);
  const inn = !s && (hod === 1 || hod === 2) ? 1800 : 0;
  // The slot meter reads one direction in an hour: AC into the Core while it charges, out otherwise.
  const out = inn > 0 ? 0 : 500 + 200 * slot + 150 * Math.cos(hod);
  return { s, pv, out, inn };
}

/** The synthetic plant's series, and the bridge's windows. */
function buildWorld(opts: { coresReport: boolean }) {
  const series = new Map<string, Array<{ ts: number; value: number }>>();
  const push = (sn: string, m: string, ts: number, v: number) => {
    const k = `${sn}|${m}`;
    let a = series.get(k);
    if (!a) series.set(k, (a = []));
    a.push({ ts, value: v });
  };
  const bridge: Array<Any> = [];
  const vendor = new Map<string, number>();
  const pct = [40, 45, 50];
  for (let hs = START; hs < END; hs += H) {
    const dark = !opts.coresReport && hs >= DARK;
    for (const slot of [1, 2, 3]) {
      const f = flows(slot, hs);
      const dE = f.pv - (f.s ? K.cd : K.cn) * f.out + K.g * f.inn - (f.s ? K.ed : K.en);
      const p0 = pct[slot - 1];
      const p1 = p0 + (dE / CAP) * 100;
      for (let t = hs; t < hs + H; t += STEP) {
        const x = (t - hs) / H;
        push(PANEL, `src${slot}_pct`, t, p0 + (p1 - p0) * x);
        push(PANEL, `src${slot}_w`, t, f.inn > 0 ? f.inn : -f.out);
        if (dark) {
          push(PANEL, `src${slot}_pv_w`, t, f.pv);
          push(PANEL, `src${slot}_pv_hv_w`, t, f.pv * 0.6 + (t / STEP) % 7);
          push(PANEL, `src${slot}_pv_lv_w`, t, Math.max(0, f.pv * 0.4 - (t / STEP) % 7));
          bridge.push({ sn: CORES[slot - 1], panelSn: PANEL, slot, sinceMs: t, untilMs: t + STEP, basis: sun(t) || sun(t + STEP) ? 'measured' : 'night', pvWh: 0, acOutWh: 0, acInWh: 0, chargeWh: 0, dischargeWh: 0, coveredMs: STEP });
        } else {
          push(CORES[slot - 1], 'pv_total', t, f.pv);
        }
        push(PANEL, 'panel_load', t, 1700 + 300 * Math.sin(hourOfDay(t) / 3));
      }
      pct[slot - 1] = p1;
      if (dark) vendor.set(siteYmd(hs), (vendor.get(siteYmd(hs)) ?? 0) + f.pv);
    }
    push('weather', 'ghi_wm2', hs, ghiAt(Math.floor(hs / H)));
  }
  for (const slot of [1, 2, 3]) push(PANEL, `src${slot}_pct`, END, pct[slot - 1]);
  const within = (pts: Array<{ ts: number; value: number }>, a: number, b: number) => pts.filter((p) => p.ts >= a && p.ts <= b);
  const bucket = (pts: Array<{ ts: number; value: number }>, sec: number) => {
    const m = new Map<number, number[]>();
    for (const p of pts) { const k = Math.floor(p.ts / (sec * 1000)) * sec * 1000; const a = m.get(k); if (a) a.push(p.value); else m.set(k, [p.value]); }
    return [...m].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts, value: v.reduce((s, x) => s + x, 0) / v.length }));
  };
  const q = (sn: string, metric: string, a: number, b: number, sec?: number) => {
    const pts = within(series.get(`${sn}|${metric}`) ?? [], a, b);
    return sec ? bucket(pts, sec) : pts;
  };
  const recorder = makeRecorderStub({
    query: q,
    queryMulti: (sn: string, metrics: string[], a: number, b: number, sec?: number) => new Map(metrics.map((m) => [m, q(sn, m, a, b, sec)])),
    queryFirstLast: (sn: string, metric: string, a: number, b: number) => {
      const pts = within(series.get(`${sn}|${metric}`) ?? [], a, b);
      return pts.length === 0 ? [] : pts.length === 1 ? [pts[0]] : [pts[0], pts[pts.length - 1]];
    },
    listMetrics: () => [],
    listLifetimeKeys: () => (opts.coresReport ? [] : [1, 2, 3].map((s) => `bridge_pvseen_${PANEL}_${s}`)),
    bridgeLedger: (a: number, b: number) => ({ rows: bridge.filter((r) => r.untilMs > a && r.sinceMs < b), watermarkMs: END }),
  } as Any) as Recorder;
  return { recorder, vendor };
}

function devicesWith(opts: { slot3Connected?: boolean; coresProjected?: boolean } = {}): Any {
  const fullWh = 92_160;
  const remainWh = 46_000;
  return {
    [PANEL]: {
      sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(), lastQuotaAtMs: Date.now(),
      projection: {
        kind: 'shp2', backupBatPercent: 50, backupFullCapWh: fullWh, backupRemainWh: remainWh, backupReserveSoc: 16,
        circuits: [{ ch: 1, watts: 1800 }], pairedCircuits: [],
        sources: CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: i < 2 || opts.slot3Connected !== false, fullCap: CAP })), sourceWatts: [],
      },
    },
    ...Object.fromEntries(CORES.map((sn, i) => [sn, opts.coresProjected
      ? { sn, deviceName: `Core ${i + 1}`, productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(), projection: { kind: 'dpu', soc: 50, chgMaxSoc: 100, packs: [] } }
      : { sn, deviceName: `Core ${i + 1}`, productName: 'DELTA Pro Ultra', online: false, lastUpdated: 0 }])),
  };
}

const membership = { entries: [{ fp: [...CORES].sort().join(','), atMs: START - 10 * 24 * H, slots: Object.fromEntries(CORES.map((sn, i) => [`${PANEL}:${i + 1}`, sn])), confirmedMs: END }] };

function setUp(world: ReturnType<typeof buildWorld>) {
  resetForecastCachesForTesting();
  resetWorkerReportCaches();
  resetPanelBasisMemos();
  resetRunwayCache();
  setPanelBasisMembershipForTesting(membership as Any);
  setPanelBasisVendorForTesting(world.vendor);
  setPanelBasisConstantsPathForTesting(null);
  setPanelBasisSunForTesting(sun);
  const now = Date.now();
  setWeatherCacheForTesting({
    fetchedAt: now - 60_000, lat: 0, lon: 0, ensembleSourcesCount: 1,
    hours: Array.from({ length: 24 * 10 }, (_, k) => {
      const ts = (Math.floor(now / H) - 24 * 7 + k) * H;
      return { ts, cloudCoverPct: 20, radiationWm2: ghiAt(Math.floor(ts / H)), tempC: 22, ensembleSources: 1 };
    }),
  } as Any);
}

after(() => {
  setPanelBasisMembershipForTesting(undefined);
  setPanelBasisVendorForTesting(undefined);
  setPanelBasisConstantsPathForTesting(undefined);
  setPanelBasisSunForTesting(undefined);
  setWeatherCacheForTesting(null);
  resetForecastCachesForTesting();
  resetPanelBasisMemos();
});

const dark = buildWorld({ coresReport: false });
beforeEach(() => setUp(dark));

test('★★★ dark plant: the planning layer as of E passes the balance on the panel\'s field; the alarm forecast stays at zero sun', async () => {
  const devices = devicesWith();
  const fc = await getDayForecast(devices, dark.recorder, () => {});
  const p = (await getPlanningForecast(devices, dark.recorder, () => {}, E))!;
  assert.ok(p, 'a planning layer');
  assert.equal(p.asOfDay, E);
  assert.equal(p.planningAsOfDay, E);
  assert.equal(p.identity, false);
  assert.equal(p.planningVerdict.state, 'pass', JSON.stringify(p.planningVerdict.reason));
  assert.ok(Math.abs((p.planningVerdict.checks.ratio as number) - 1) < 1e-3, `the balance closes: ${p.planningVerdict.checks.ratio}`);
  assert.equal(p.planningPvBasis, 'panel');
  assert.deepEqual(p.planningModelKeys, [1, 2, 3].map((s) => `${PANEL}#${s}`));
  assert.ok(p.planningSlotHours.field > 0 && p.planningSlotHours.core > 0, 'the window holds the Cores\' own hours and the field\'s');
  assert.ok(p.planningAdmittedDays >= 7);
  assert.ok(p.planningHours.some((h) => h.forecastPvW > 0), 'planning PV in daylight');
  assert.ok(fc.hours.every((h) => h.forecastPvW === 0), 'the alarm series: no Core reports, zero sun');
  assert.notEqual(p.planningHours, fc.hours);
  assert.deepEqual(p.planningHours.map((h) => [h.ts, h.forecastLoadW]), fc.hours.map((h) => [h.ts, h.forecastLoadW]), 'the same hours and loads');
});

test('★★★ the planning keys are the slots connected NOW: slot 3 out today gives the two-slot fit, not three slots scaled ×1.5', async () => {
  const three = (await getPlanningForecast(devicesWith(), dark.recorder, () => {}, E))!;
  setUp(dark);
  const two = (await getPlanningForecast(devicesWith({ slot3Connected: false }), dark.recorder, () => {}, E))!;
  assert.deepEqual(two.planningModelKeys, [1, 2].map((s) => `${PANEL}#${s}`));
  const noon = (p: Any) => p.planningSolarModel.hourly.reduce((m: number, h: Any) => Math.max(m, h.coeff ?? 0), 0);
  // Slot gains 2.8 / 3.0 / 3.2 W per W/m²: two slots read (2.8 + 3.0) / 9.0 of three.
  assert.ok(Math.abs(noon(two) / noon(three) - 5.8 / 9.0) < 0.02, `${noon(two)} / ${noon(three)}`);
});

test('★★★ every planning window ends at the start of E: the skill scores E−30..E−1, and a recompute for the previous evening scores the day before', async () => {
  const devices = devicesWith();
  const fc = await getDayForecast(devices, dark.recorder, () => {});
  const p = (await getPlanningForecast(devices, dark.recorder, () => {}, E))!;
  const s = await computeForecastSkill(devices, dark.recorder, fc, 30, 'realized', undefined, { kind: 'planning', planning: p });
  assert.equal(s.days[0].date, addDaysYmd(E, -30));
  assert.equal(s.days[s.days.length - 1].date, addDaysYmd(E, -1));
  const prev = (await getPlanningForecast(devices, dark.recorder, () => {}, addDaysYmd(E, -1)))!;
  const s2 = await computeForecastSkill(devices, dark.recorder, fc, 30, 'realized', undefined, { kind: 'planning', planning: prev });
  assert.equal(s2.days[s2.days.length - 1].date, addDaysYmd(E, -2));
  assert.notEqual(s, s2, 'one cache slot per E');
  assert.equal(await getPlanningForecast(devices, dark.recorder, () => {}, addDaysYmd(E, 1)), null, 'an evening that has not come');
  assert.equal(await getPlanningForecast(devices, dark.recorder, () => {}, 'tomorrow'), null);
});

test('★★★ the published band, the published rollup and the runway are untouched by the planning layer; the caches are apart', async () => {
  const devices = devicesWith();
  const fc = await getDayForecast(devices, dark.recorder, () => {});
  const runway0 = await computeRunway(devices, dark.recorder, fc);
  const skill0 = await computeForecastSkill(devices, dark.recorder, fc, 30, 'realized');
  const band0 = await computeProbabilisticForecast(fc, skill0);
  const md0 = await computeMultiDayForecast(devices, dark.recorder, fc, 3);
  const hours0 = JSON.stringify(fc.hours);
  const p = (await getPlanningForecast(devices, dark.recorder, () => {}, E))!;
  const sp = await computeForecastSkill(devices, dark.recorder, fc, 30, 'realized', undefined, { kind: 'planning', planning: p });
  const bandP = await computeProbabilisticForecast(fc, sp, p);
  const mdP = await computeMultiDayForecast(devices, dark.recorder, fc, 3, p);
  assert.equal(JSON.stringify(fc.hours), hours0, 'the forecast object is not written');
  assert.deepEqual(await computeProbabilisticForecast(fc, skill0), band0, 'the published band, from its own cache slot');
  assert.deepEqual(await computeMultiDayForecast(devices, dark.recorder, fc, 3), md0);
  resetRunwayCache();
  const { generatedAt: _g1, ...r1 } = await computeRunway(devices, dark.recorder, fc) as Any;
  const { generatedAt: _g0, ...r0 } = runway0 as Any;
  assert.deepEqual(r1, r0, 'the runway reads hours[].forecastPvW alone');
  assert.ok(band0.hours.every((h) => h.p50W === 0) && bandP.hours.some((h) => h.p50W > 0), 'the planning band carries the panel\'s solar');
  assert.deepEqual(bandP.solarModelSns, p.planningModelKeys);
  assert.ok(mdP.days.some((d) => d.pvKwh > 0) && md0.days.every((d) => d.pvKwh === 0));
  assert.notEqual(skill0, sp);
  // computeRunway's source never names a planning field.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/analytics.ts'), 'utf8');
  const at = src.indexOf('export function computeRunway(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.ok(at > 0 && !/\bplanning[A-Z]\w*|PlanningForecast|planningDayForecast/.test(body), 'computeRunway reads no planning field');
});

test('★★ the reports echo E: planningForecast, planningProbabilisticForecast, multiDayForecast {basis: planning}', async () => {
  resetReportBasisForTesting();
  const ctx = { recorder: dark.recorder, snapshot: { devices: devicesWith() } as Any, log: () => {} };
  const pf = await buildReport('planningForecast', ctx, { asOfDay: E }) as Any;
  assert.equal(pf.asOfDay, E);
  const band = await buildReport('planningProbabilisticForecast', ctx, { asOfDay: E }) as Any;
  assert.equal(band.asOfDay, E);
  assert.equal(band.planningPvBasis, 'panel');
  assert.equal(band.planningVerdict.state, 'pass');
  assert.equal(band.planningIdentity, false);
  assert.ok(band.calScoredDays >= 4, `the planning band is calibrated on scored days (${band.calScoredDays})`);
  const md = await buildReport('multiDayForecast', ctx, { days: 3, basis: 'planning', asOfDay: E }) as Any;
  assert.equal(md.basis, 'planning');
  assert.equal(md.asOfDay, E);
  assert.equal(await buildReport('planningForecast', ctx, { asOfDay: addDaysYmd(E, 2) }), null);
  const published = await buildReport('multiDayForecast', ctx, { days: 3 }) as Any;
  assert.equal(published.basis, undefined, 'the published rollup is unchanged');
});

test('★★★ identity: with every Core reporting its own meter and no field hour, every planning field IS the alarm object', async () => {
  const live = buildWorld({ coresReport: true });
  setUp(live);
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'panel-pv-identity-'));
  setPanelBasisConstantsPathForTesting(join(dir, 'panel-pv-constants.json'));
  const devices = devicesWith({ coresProjected: true });
  const fc: DayForecast = await getDayForecast(devices, live.recorder, () => {});
  const p = (await getPlanningForecast(devices, live.recorder, () => {}, E))!;
  assert.equal(existsSync(join(dir, 'panel-pv-constants.json')), false, 'no slot takes the field: nothing is fitted or kept');
  rmSync(dir, { recursive: true, force: true });
  assert.equal(p.identity, true);
  assert.equal(p.planningSolarModel, fc.solarModel);
  assert.equal(p.planningHours, fc.hours);
  assert.equal(p.planningPvBiasFactor, fc.pvBiasFactor ?? 1);
  assert.equal(p.planningPvCeilingW, fc.pvCeilingW);
  assert.equal(p.planningVerdict.state, 'not-needed');
  assert.equal(p.planningPvBasis, 'cores');
  assert.equal(p.planningSlotHours.field, 0);
  const skill = await computeForecastSkill(devices, live.recorder, fc, 30, 'realized');
  const sp = await computeForecastSkill(devices, live.recorder, fc, 30, 'realized', undefined, { kind: 'planning', planning: p });
  assert.deepEqual(sp, skill, 'the planning skill is the alarm skill');
  const { generatedAt: _a, ...bandP } = await computeProbabilisticForecast(fc, sp, p);
  const { generatedAt: _b, ...band } = await computeProbabilisticForecast(fc, skill);
  assert.deepEqual(bandP, band, 'and the band');
});

test('★★ L10: the fitted constants are kept with their day set, so rows ageing out of the retention do not take them away', async () => {
  const { mkdtempSync, readFileSync: rd, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'panel-pv-constants-'));
  const path = join(dir, 'panel-pv-constants.json');
  try {
    const devices = devicesWith();
    setPanelBasisConstantsPathForTesting(path);
    const first = (await getPlanningForecast(devices, dark.recorder, () => {}, E))!;
    assert.equal(first.planningVerdict.state, 'pass');
    const kept = JSON.parse(rd(path, 'utf8'));
    const keys = Object.keys(kept.fits).sort();
    assert.equal(keys.length, 3, 'one per (slot, Core)');
    for (const k of keys) {
      const fit = kept.fits[k].fit;
      assert.equal(fit.days, 25);
      assert.equal(fit.dayList.length, 25, 'with the days it was fitted on');
      assert.ok(fit.constants != null && fit.chargeHours === 50, 'the constants, with their charge hours');
    }
    // The retention prunes everything older than E−30: the Cores keep 10 of their 25 whole days (and
    // their last pv_total row, so the kept fit is for the same Core history).
    const cutoff = siteDayStartMs(addDaysYmd(E, -30));
    const pruned = { ...dark.recorder } as Any;
    const keep = (pts: Array<{ ts: number }>) => pts.filter((p) => p.ts >= cutoff);
    pruned.query = (...a: Any[]) => keep((dark.recorder.query as Any)(...a));
    pruned.queryMulti = (...a: Any[]) => new Map([...(dark.recorder.queryMulti as Any)(...a)].map(([m, pts]: Any) => [m, keep(pts)]));
    setUp({ recorder: pruned, vendor: dark.vendor });
    setPanelBasisConstantsPathForTesting(path);
    const again = (await getPlanningForecast(devices, pruned, () => {}, E))!;
    assert.equal(again.planningVerdict.state, 'pass', JSON.stringify(again.planningVerdict.reason));
    assert.deepEqual(again.planningVerdict.checks.constants, first.planningVerdict.checks.constants);
    // Without the kept record the pruned rows cannot fit them, and the check refuses by name.
    setUp({ recorder: pruned, vendor: dark.vendor });
    const none = (await getPlanningForecast(devices, pruned, () => {}, E))!;
    assert.equal(none.planningVerdict.reason?.code, 'no-constants');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
