/**
 * v1.187.0 review — "load-explained" is bounded by the MPPT's OWN loaded temperature, and follows
 * its cool-down.
 *
 * The first cut quieted ANY hot MPPT reading on an idle-typical hour once the Core had carried
 * 300 W in the last 2 h. The life-safety case is exactly that shape: a grid outage at night (the
 * house Cores' hour-typical load is idle), a Core carrying the house or a 5 kW charge, and its
 * MPPT cooling failing at 62 °C (144 °F). That reading became info and annunciate:false — not
 * pushed, not spoken, not counted toward the condition — where v1.186.5 had pushed a warning.
 * The "typical already on the plateau" guard did not save it either: the temperature typical is a
 * median over RAW change-detected samples, so loaded nights can put it on the ~120 °F plateau
 * while the (time-weighted) load typical still reads idle. And the fixed 2 h window was shorter
 * than the heatsink's own cool-down, so a normal tail could switch to an annunciating warning.
 *
 * Now: the reading must sit at or below mpptLoadCeiling — the MPPT's settled loaded reference
 * (MPPT_LOADED_REF_FALLBACK_F on thin history) plus the floor while the load runs, decaying toward
 * the hour's typical with MPPT_COOL_TAU_MS once it stops, for at most MPPT_LOAD_RECENT_MS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBaselineAlerts, resetForecastCachesForTesting, coreActivityContext, mpptLoadCeiling, mpptBaselineVerdict,
  MPPT_COOL_TAU_MS, MPPT_LOAD_RECENT_MS, MPPT_LOADED_REF_FALLBACK_F, MPPT_LOADED_SETTLE_BUCKETS, MPPT_LOAD_PLATEAU_W,
} from '../src/analytics.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import { autoTuneCounts } from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BUCKET = 600_000;
const SN = 'COREXXX00XXX0007';
const cToF = (c: number) => c * 1.8 + 32;
const bucketOf = (ts: number) => Math.floor(ts / BUCKET) * BUCKET;
type Pt = { ts: number; value: number };

function core(mpptC: number, loadW: number): Record<string, DeviceSnapshot> {
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 7', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', mpptHvTemp: mpptC, mpptLvTemp: mpptC, packs: [], totalInWatts: loadW, totalOutWatts: 0 },
    } as unknown as DeviceSnapshot,
  };
}

interface Scenario {
  /** The hour-window temperature typical (raw samples at this hour on 14 prior days), °C. */
  typicalC: number;
  /** Settled 5 kW sessions on 13 prior days, 12 h away from this hour, at this MPPT temperature (°C); null = none. */
  loadedC: number | null;
  /** Consecutive plateau buckets per loaded session (MPPT_LOADED_SETTLE_BUCKETS + 1 = two settled). */
  sessionBuckets?: number;
  /** A 5 kW step that stepped down this long ago (the live load says whether it still runs); null = none. */
  stepAgoMs: number | null;
}

function recorder(s: Scenario) {
  const now = Date.now();
  const temp: Pt[] = [];
  for (let k = 14; k >= 1; k--) {
    for (const [off, d] of [[-10, -0.5], [0, 0], [10, 0.5]] as const) temp.push({ ts: now - k * DAY + off * 60_000, value: s.typicalC + d });
  }
  const tin: Pt[] = [];
  const tout: Pt[] = [];
  const mppt: Pt[] = [];
  const add = (ts: number, w: number, c: number | null) => {
    tin.push({ ts, value: 0 });
    tout.push({ ts, value: w });
    if (c != null) mppt.push({ ts, value: c });
  };
  // The hour's typical load: idle on 14 prior days.
  for (let k = 14; k >= 1; k--) add(bucketOf(now - k * DAY), 0, s.typicalC);
  // The MPPT's loaded history, well outside the hour window and more than MPPT_LOAD_RECENT_MS ago.
  if (s.loadedC != null) {
    for (let k = 14; k >= 2; k--) {
      const start = bucketOf(now - k * DAY + 12 * HOUR);
      for (let b = 0; b < (s.sessionBuckets ?? MPPT_LOADED_SETTLE_BUCKETS + 1); b++) add(start + b * BUCKET, 5000, s.loadedC);
    }
  }
  // The recent load step: three 5 kW buckets, the last ending `stepAgoMs` (to one bucket) ago.
  if (s.stepAgoMs != null) {
    const end = bucketOf(now - s.stepAgoMs);
    for (let b = 3; b >= 1; b--) add(end - b * BUCKET, 5000, s.loadedC ?? 50);
  }
  const sort = (a: Pt[]) => a.sort((x, y) => x.ts - y.ts);
  const multi = new Map<string, Pt[]>([
    ['total_in', sort(tin)], ['total_out', sort(tout)], ['mppt_hv_temp', sort([...mppt])], ['mppt_lv_temp', sort([...mppt])],
  ]);
  return makeRecorderStub({
    query: (_sn, metric) => (metric.startsWith('mppt_') ? temp : []),
    queryMulti: (_sn, metrics) => new Map(metrics.map((m) => [m, multi.get(m) ?? []])),
  });
}

function mppt(liveC: number, liveLoadW: number, s: Scenario): Alert[] {
  resetForecastCachesForTesting();
  return computeBaselineAlerts(core(liveC, liveLoadW), recorder(s)).filter((a) => a.id.startsWith('baseline-mppt_'));
}

const fact = (a: Alert, label: string) => a.facts?.find((f) => f.label === label)?.value;

function assertWarns(alerts: Alert[], why: string): void {
  assert.equal(alerts.length, 2, 'both MPPTs surface');
  for (const a of alerts) {
    assert.equal(a.severity, 'warning', why);
    assert.notEqual(a.annunciate, false, why);
    assert.equal(a.muteReason, undefined);
    assert.equal(autoTuneCounts(a), true, 'an annunciating episode, counted like any other');
  }
  assert.equal(conditionFromAlerts(alerts).level, 'yellow', 'it reaches the audible condition');
}

function assertExplained(alerts: Alert[]): void {
  assert.equal(alerts.length, 2, 'both MPPTs surface');
  for (const a of alerts) {
    assert.equal(a.severity, 'info');
    assert.equal(a.annunciate, false);
    assert.equal(a.muteReason, "heat explained by the Core's load");
  }
}

/* ── the safety cases the first cut quieted ─────────────────────────────── */

test('★★★ outage night: a failed MPPT cooler at 62 °C during a 5.9 kW charge on an idle-typical hour WARNS', () => {
  // Idle typical 32 °C (~90 °F); the Core's settled loaded history 49.5 °C (~121 °F) → ceiling ~130 °F.
  const alerts = mppt(62, 5900, { typicalC: 32, loadedC: 49.5, stepAgoMs: 0 });
  assertWarns(alerts, 'the first cut read this as load-explained: info, annunciate:false');
  for (const a of alerts) {
    assert.match(a.detail, /is 144°F — 54°F above its typical 90°F/);
    assert.equal(fact(a, 'MPPT under load'), '121°F', 'the reference is the MPPT\'s own loaded history');
    assert.equal(fact(a, 'Load-explained ceiling'), '130°F');
  }
  // With too little loaded history the measured default bounds it the same way.
  const thin = mppt(62, 5900, { typicalC: 32, loadedC: null, stepAgoMs: 0 });
  assertWarns(thin, 'no loaded history is no licence');
  for (const a of thin) assert.equal(fact(a, 'MPPT under load (default)'), `${MPPT_LOADED_REF_FALLBACK_F}°F`);
});

test('★★★ a temperature typical ON THE PLATEAU (sample-weighted) with an idle load typical: the same reading WARNS', () => {
  // `med` is a median over RAW change-detected samples; loaded nights can put it at ~120 °F while
  // the time-weighted load typical still reads 0 W, so "typical below the plateau" passes. The
  // ceiling judges the reading in temperature: a typical at the loaded reference leaves nothing.
  const alerts = mppt(62, 5900, { typicalC: 49, loadedC: 49.5, stepAgoMs: 0 });
  assertWarns(alerts, 'the plateau guard compared load, not temperature');
  const warmer = mppt(57, 5900, { typicalC: 49, loadedC: 49.5, stepAgoMs: 0 });
  assertWarns(warmer, '135 °F against a 120 °F typical under the same load is past the ceiling too');
});

/* ── the reference is the MPPT's own ────────────────────────────────────── */

test('★★ the MPPT\'s own settled loaded temperature sets the reference — and the default when history is thin', () => {
  // A Core whose MPPTs run hotter under load (55 °C ≈ 131 °F): 58 °C (~136 °F) during a charge is
  // within its own normal (ceiling 140 °F)...
  const own = mppt(58, 5000, { typicalC: 32, loadedC: 55, stepAgoMs: 0 });
  assertExplained(own);
  for (const a of own) {
    assert.match(a.detail, /within what that load explains: up to 140°F \(this MPPT runs 131°F under load, cooling toward 90°F once the load stops\)/);
    assert.equal(fact(a, 'MPPT under load'), '131°F');
  }
  // ...but judged against the default (122 °F + 9) it is not.
  assertWarns(mppt(58, 5000, { typicalC: 32, loadedC: null, stepAgoMs: 0 }), 'no loaded history: the measured default');
  // Heat-up buckets are not "loaded": sessions shorter than MPPT_LOADED_SETTLE_BUCKETS give no reference.
  assertWarns(mppt(58, 5000, { typicalC: 32, loadedC: 55, sessionBuckets: MPPT_LOADED_SETTLE_BUCKETS - 1, stepAgoMs: 0 }), 'short sessions never settle');
});

test('coreActivityContext: loadedRaw is the UPPER QUARTILE of settled plateau-load buckets, per MPPT metric', () => {
  const now = Date.now();
  const h = new Date(now).getHours();
  const hours = new Set([(h + 23) % 24, h, (h + 1) % 24]);
  const tin: Pt[] = []; const tout: Pt[] = []; const hv: Pt[] = []; const lv: Pt[] = [];
  // Ten 6-bucket sessions: temperatures 40 … 45 °C in bucket order (HV), +2 °C (LV).
  for (let k = 1; k <= 10; k++) {
    const start = bucketOf(now - k * DAY + 6 * HOUR);
    for (let b = 0; b < 6; b++) {
      const ts = start + b * BUCKET;
      tin.push({ ts, value: 0 }); tout.push({ ts, value: 5000 });
      hv.push({ ts, value: 40 + b }); lv.push({ ts, value: 42 + b });
    }
  }
  // An idle bucket and a light (below-plateau) bucket in front of nothing: never settled.
  tin.push({ ts: bucketOf(now - 2 * HOUR), value: 0 }); tout.push({ ts: bucketOf(now - 2 * HOUR), value: MPPT_LOAD_PLATEAU_W - 1 });
  hv.push({ ts: bucketOf(now - 2 * HOUR), value: 90 });
  const rows = new Map([['total_in', tin], ['total_out', tout], ['mppt_hv_temp', hv], ['mppt_lv_temp', lv]]);
  const a = coreActivityContext(rows, hours, now, 0, BUCKET);
  // Settled = the 3rd to 6th bucket of each session (42-45 °C HV): 40 values — median 43.5, max 45,
  // upper quartile 44 (the heat-up buckets, 40-41 °C, never count).
  assert.equal(a.loadedRaw.get('mppt_hv_temp'), 44);
  assert.equal(a.loadedRaw.get('mppt_lv_temp'), 46);
  // Fewer than BASELINE_MIN_SAMPLES settled buckets: no reference.
  const few = new Map([...rows].map(([m, pts]) => [m, pts.slice(0, 6)])); // one session: 4 settled
  assert.equal(coreActivityContext(few, hours, now, 0, BUCKET).loadedRaw.get('mppt_hv_temp'), null);
});

/* ── the cool-down ──────────────────────────────────────────────────────── */

test('★★ review scenario: 2 h 10 min after a night charge, a normal cool-down tail stays load-explained', () => {
  // Idle typical 27 °C (~81 °F); loaded reference 50 °C (122 °F); the charge ended ~130 min ago and
  // the MPPT reads 36 °C (~97 °F) — 16 °F above typical, z ≈ 6. The first cut's 2 h window had
  // closed, so this pushed a [Medium] warning and a "Resolved:" half an hour later.
  const alerts = mppt(36, 0, { typicalC: 27, loadedC: 50, stepAgoMs: 130 * 60_000 });
  assertExplained(alerts);
  for (const a of alerts) assert.match(a.detail, /the load stepped down 1[34]\d min ago/);
});

test('★★★ the envelope DECAYS: a reading that stops cooling is anomalous; the lookback ends at MPPT_LOAD_RECENT_MS', () => {
  // 3.5 h after the load: the allowance is ~7 °F above typical + floor (~97 °F).
  const s = { typicalC: 27, loadedC: 50, stepAgoMs: 3.5 * HOUR };
  assertExplained(mppt(35, 0, s)); // 95 °F: still cooling
  assertWarns(mppt(43, 0, s), '109 °F three and a half hours after the load stopped is heat from somewhere else');
  // Past the lookback no load step explains anything.
  assertWarns(mppt(35, 0, { ...s, stepAgoMs: MPPT_LOAD_RECENT_MS + HOUR }), 'the load evidence has expired');
});

test('mpptLoadCeiling: reference + floor under load, decaying with MPPT_COOL_TAU_MS toward typical + floor', () => {
  const p = { typical: 80, floor: 9, loadedRef: 122 };
  assert.equal(mpptLoadCeiling({ ...p, loadAgoMs: 0 }), 131);
  assert.ok(Math.abs(mpptLoadCeiling({ ...p, loadAgoMs: MPPT_COOL_TAU_MS }) - (80 + 42 / Math.E + 9)) < 1e-9);
  assert.ok(mpptLoadCeiling({ ...p, loadAgoMs: 3 * MPPT_COOL_TAU_MS }) < 80 + 9 + 0.05 * 42 + 1e-9, 'under 5 % of the span at the lookback');
  assert.equal(mpptLoadCeiling({ ...p, loadAgoMs: -5 }), 131, 'a clock skew is "now", never more');
  assert.equal(mpptLoadCeiling({ ...p, loadedRef: 70, loadAgoMs: 0 }), 89, 'a reference at or below the typical explains nothing above the floor');
  assert.equal(MPPT_LOAD_RECENT_MS, 3 * MPPT_COOL_TAU_MS);
});

test('★★ the verdict reads the ceiling: just inside is explained, just over is anomalous', () => {
  const base = { dirSign: 1, typicalActivityW: 0, loadAgoMs: 0, typical: 90, floor: 9, loadedRef: 122 };
  assert.equal(mpptBaselineVerdict({ ...base, live: 131 }), 'load-explained');
  assert.equal(mpptBaselineVerdict({ ...base, live: 131.01 }), 'anomalous');
  assert.equal(mpptBaselineVerdict({ ...base, live: 100, loadAgoMs: MPPT_LOAD_RECENT_MS }), 'load-explained', 'the lookback is inclusive');
  assert.equal(mpptBaselineVerdict({ ...base, live: 100, loadAgoMs: MPPT_LOAD_RECENT_MS + 1 }), 'anomalous');
});
