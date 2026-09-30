/**
 * v1.187.0 — the MPPT self-baseline is a LOAD-COUPLED reading.
 *
 * 09-28/29: a house Core idle at the reserve reads ~90 °F on its MPPTs against an under-load
 * typical of ~120 °F, and the two-sided hour-of-day test raised warning-level "unusual for
 * the hour" alerts for it — 14 of the 16 pushes before 15:00, the broadcast condition held
 * yellow, and Rule 3 latched on the family. The mirror image (a Core carrying a night charge
 * against idle nights) read "36 °F above its typical". Only an MPPT hotter than typical while
 * the Core carries no more load than the hour usually sees is an anomaly worth a warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBaselineAlerts, resetForecastCachesForTesting, mpptBaselineVerdict, coreActivityContext,
  MPPT_LOAD_EXPLAINS_MIN_W, MPPT_LOAD_PLATEAU_W, MPPT_LOAD_RECENT_MS,
} from '../src/analytics.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import { autoTuneCounts } from '../src/alertMonitor.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const DAY = 86_400_000;
const SN = 'COREXXX00XXX0001';
const BUCKET = 600_000;

/** One Core with its live MPPT temperatures (°C) and live load. */
function core(mpptC: number, loadW: { in: number | null; out: number | null }, packs: unknown[] = []): Record<string, DeviceSnapshot> {
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', mpptHvTemp: mpptC, mpptLvTemp: mpptC, packs, totalInWatts: loadW.in, totalOutWatts: loadW.out },
    } as unknown as DeviceSnapshot,
  };
}

/** 14 days of same-hour history at `typicalC` (small scatter), for any temperature metric. */
function tempHistory(typicalC: number): Array<{ ts: number; value: number }> {
  const now = Date.now();
  const pts: Array<{ ts: number; value: number }> = [];
  for (let k = 14; k >= 1; k--) {
    for (const [off, d] of [[-10, -0.5], [0, 0], [10, 0.5]] as const) pts.push({ ts: now - k * DAY + off * 60_000, value: typicalC + d });
  }
  return pts;
}

/** Bucketed total_in/total_out: `typicalW` at this hour on the 14 prior days, `recentW` over the last hour. */
function activityRows(typicalW: number, recentW: number | null): Map<string, Array<{ ts: number; value: number }>> {
  const now = Date.now();
  const tin: Array<{ ts: number; value: number }> = [];
  const tout: Array<{ ts: number; value: number }> = [];
  const add = (ts: number, w: number) => {
    const b = Math.floor(ts / BUCKET) * BUCKET;
    tin.push({ ts: b, value: 0 });
    tout.push({ ts: b, value: w });
  };
  for (let k = 14; k >= 1; k--) add(now - k * DAY, typicalW);
  if (recentW != null) for (const m of [50, 30, 10]) add(now - m * 60_000, recentW);
  return new Map([['total_in', tin], ['total_out', tout]]);
}

function recorder(typicalC: number, activity: Map<string, Array<{ ts: number; value: number }>> | null, packTypicalC?: number): Recorder {
  return makeRecorderStub({
    query: (_sn, metric) => metric.startsWith('mppt_') ? tempHistory(typicalC)
      : packTypicalC != null && /^pack\d+_temp$/.test(metric) ? tempHistory(packTypicalC) : [],
    queryMulti: (_sn, metrics) => activity ?? new Map(metrics.map((m) => [m, []])),
  });
}

const mppt = (devices: Record<string, DeviceSnapshot>, rec: Recorder) => {
  resetForecastCachesForTesting(); // the baseline cache would otherwise serve the previous scenario
  return computeBaselineAlerts(devices, rec).filter((a) => a.id.startsWith('baseline-mppt_'));
};

/* ── the pure verdict ───────────────────────────────────────────────────── */

/** The verdict at a hot reading well inside the load's reach unless a test overrides it (°F). */
const verdict = (over: Partial<Parameters<typeof mpptBaselineVerdict>[0]>) => mpptBaselineVerdict({
  dirSign: 1, typicalActivityW: 0, loadAgoMs: 0, live: 118, typical: 90, floor: 9, loadedRef: 122, ...over,
});

test('★★★ cooler than typical is never a hazard, whatever the load evidence says', () => {
  assert.equal(verdict({ dirSign: -1, typicalActivityW: null, loadAgoMs: null, live: 84 }), 'cooler');
  assert.equal(verdict({ dirSign: -1, typicalActivityW: 800, loadAgoMs: 0, live: 84 }), 'cooler');
  assert.equal(verdict({ dirSign: -1, typicalActivityW: 0, loadAgoMs: 0, live: 84 }), 'cooler');
});

test('★★★ hotter with NO load evidence stays anomalous — missing data never quiets the hot side', () => {
  assert.equal(verdict({ typicalActivityW: null }), 'anomalous');
  assert.equal(verdict({ loadAgoMs: null }), 'anomalous', 'no load step on record (or none past the typical)');
});

test('★★ hotter after a load step, within its reach, is load-explained; an already-loaded hour is not', () => {
  // The 09-18 night-charge shape: idle-typical hour, the Core carrying a charge now.
  assert.equal(verdict({}), 'load-explained');
  // A partly-loaded typical still below the plateau: the step up explains the heat.
  assert.equal(verdict({ typicalActivityW: 150 }), 'load-explained');
  // Already on the loaded plateau at this hour: measured medians are 117-122 °F from 300 W to
  // > 3 kW, so more load explains no extra heat — a hot MPPT there is anomalous at ANY load.
  assert.equal(verdict({ typicalActivityW: MPPT_LOAD_PLATEAU_W }), 'anomalous');
  assert.equal(verdict({ typicalActivityW: MPPT_LOAD_PLATEAU_W - 1 }), 'load-explained');
  assert.equal(verdict({ typicalActivityW: 800 }), 'anomalous');
});

/* ── the activity context ───────────────────────────────────────────────── */

test('coreActivityContext: typical = median |in|+|out| over the hour window; recent = peak over MPPT_LOAD_RECENT_MS plus live', () => {
  const now = Date.now();
  const h = new Date(now).getHours();
  const hours = new Set([(h + 23) % 24, h, (h + 1) % 24]);
  const rows = activityRows(100, 2500);
  const a = coreActivityContext(rows, hours, now, 40, BUCKET);
  assert.equal(a.typicalW, 100);
  assert.equal(a.recentMaxW, 2500);
  // The live reading joins the recent window.
  assert.equal(coreActivityContext(rows, hours, now, 7000, BUCKET).recentMaxW, 7000);
  // Load that ended more than MPPT_LOAD_RECENT_MS ago is not in the recent peak.
  const old = new Map([
    ['total_in', [{ ts: now - MPPT_LOAD_RECENT_MS - 2 * BUCKET, value: 0 }]],
    ['total_out', [{ ts: now - MPPT_LOAD_RECENT_MS - 2 * BUCKET, value: 5000 }]],
  ]);
  assert.equal(coreActivityContext(old, hours, now, 0, BUCKET).recentMaxW, 0);
  // Fewer than BASELINE_MIN_SAMPLES hour-window buckets: no typical (so no load step either).
  const thin = new Map([...rows].map(([m, pts]) => [m, pts.slice(-5)]));
  assert.equal(coreActivityContext(thin, hours, now, 0, BUCKET).typicalW, null);
  assert.equal(coreActivityContext(thin, hours, now, 7000, BUCKET).loadAgoMs, null);
  // A bucket where only one side reported is not a load reading.
  const oneSided = new Map([['total_in', [] as Array<{ ts: number; value: number }>], ['total_out', rows.get('total_out')!]]);
  const none = coreActivityContext(oneSided, hours, now, null, BUCKET);
  assert.equal(none.typicalW, null);
  assert.equal(none.recentMaxW, null);
  assert.equal(none.loadAgoMs, null);
  // Signed in/out (a charging Core) counts by magnitude.
  const signed = new Map([
    ['total_in', [{ ts: now - BUCKET, value: -400 }]],
    ['total_out', [{ ts: now - BUCKET, value: 0 }]],
  ]);
  assert.equal(coreActivityContext(signed, hours, now, null, BUCKET).recentMaxW, 400);
});

test('★★ coreActivityContext: loadAgoMs is the time since the Core last stepped MPPT_LOAD_EXPLAINS_MIN_W above its typical', () => {
  const now = Date.now();
  const h = new Date(now).getHours();
  const hours = new Set([(h + 23) % 24, h, (h + 1) % 24]);
  // Typical 100 W; 2500 W in the buckets 50/30/10 min ago.
  const rows = activityRows(100, 2500);
  const lastBucket = Math.floor((now - 10 * 60_000) / BUCKET) * BUCKET;
  assert.equal(coreActivityContext(rows, hours, now, 40, BUCKET).loadAgoMs, Math.max(0, now - (lastBucket + BUCKET)), 'from the END of the last step bucket');
  assert.equal(coreActivityContext(rows, hours, now, 7000, BUCKET).loadAgoMs, 0, 'a live reading past the step: loaded now');
  // The same load as usual — a cooling fault's signature — is no step at all.
  assert.equal(coreActivityContext(activityRows(800, 800), hours, now, 800, BUCKET).loadAgoMs, null);
  assert.equal(coreActivityContext(activityRows(100, 100 + MPPT_LOAD_EXPLAINS_MIN_W - 1), hours, now, 0, BUCKET).loadAgoMs, null, 'just under the margin is not a step');
  assert.equal(coreActivityContext(activityRows(100, 100 + MPPT_LOAD_EXPLAINS_MIN_W), hours, now, 0, BUCKET).loadAgoMs != null, true, 'exactly the margin is');
});

/* ── end to end through computeBaselineAlerts ───────────────────────────── */

test('★★★ the 09-28 shape: an IDLE Core\'s cool MPPT is on-screen at info, never pushed, spoken or counted', () => {
  // Under-load typical 49 °C (~120 °F); the Core idles at the reserve and the MPPT cools to 29 °C (~84 °F).
  const alerts = mppt(core(29, { in: 0, out: 0 }), recorder(49, activityRows(700, 0)));
  assert.equal(alerts.length, 2, 'both MPPTs still surface (HV and LV)');
  for (const a of alerts) {
    assert.equal(a.severity, 'info', 'was warning before v1.187.0 (z ≈ 14)');
    assert.equal(a.annunciate, false);
    assert.equal(a.muteReason, 'cooler than typical, not a hazard');
    assert.match(a.detail, /below its typical/);
    assert.match(a.detail, /A cooler MPPT is not a hazard/);
    assert.equal(autoTuneCounts(a), false, 'it feeds no auto-tune rollup, so it cannot latch Rule 3 on the family');
  }
  assert.equal(conditionFromAlerts(alerts).level, 'green', 'it no longer raises the audible condition');
});

test('★★★ a HOT MPPT on an idle Core — no more load than the hour usually sees — still warns and annunciates', () => {
  // Idle typical 32 °C (~90 °F); now 50 °C (~122 °F) with the Core still idle: a cooling or component fault.
  const alerts = mppt(core(50, { in: 0, out: 0 }), recorder(32, activityRows(0, 0)));
  assert.equal(alerts.length, 2);
  for (const a of alerts) {
    assert.equal(a.severity, 'warning');
    assert.notEqual(a.annunciate, false);
    assert.equal(a.muteReason, undefined);
    assert.match(a.detail, /above its typical/);
    assert.ok(a.facts?.some((f) => f.label.startsWith('Core load (peak')), 'the load evidence it read is shown');
  }
  assert.equal(conditionFromAlerts(alerts).level, 'yellow', 'the hazard side still reaches the audible condition');
});

test('★★ a hot MPPT while the Core carries a night charge against idle nights is load-explained: info, on-screen only', () => {
  const alerts = mppt(core(50, { in: 5900, out: 0 }), recorder(32, activityRows(0, 5900)));
  assert.equal(alerts.length, 2);
  for (const a of alerts) {
    assert.equal(a.severity, 'info');
    assert.equal(a.annunciate, false);
    assert.equal(a.muteReason, "heat explained by the Core's load");
    assert.match(a.detail, /carried up to 5900 W in the last 6 h against a typical 0 W for this hour/);
    assert.match(a.detail, /within what that load explains: up to 131°F \(this MPPT runs 122°F under load, a measured default — too little loaded history/);
    assert.match(a.detail, /absolute MPPT temperature alarm still applies/);
  }
});

test('★★★ a hot MPPT where the hour is ALREADY loaded stays a warning, however much more load the Core carries', () => {
  // Typical 49 °C at a typical 800 W: the hour's baseline is the loaded plateau. 62 °C (~144 °F)
  // during a 5.2 kW charge is not explained by load — the plateau does not climb with it.
  // (mpptLoadCeiling.test.ts: the same reading on an IDLE-typical hour warns too.)
  const alerts = mppt(core(62, { in: 5200, out: 0 }), recorder(49, activityRows(800, 5200)));
  assert.equal(alerts.length, 2);
  for (const a of alerts) {
    assert.equal(a.severity, 'warning');
    assert.notEqual(a.annunciate, false);
  }
});

test('★★★ fail loud: with NO load history the hot side keeps its warning', () => {
  const alerts = mppt(core(50, { in: 5900, out: 0 }), recorder(32, null));
  assert.equal(alerts.length, 2);
  for (const a of alerts) {
    assert.equal(a.severity, 'warning', 'the live 5.9 kW alone is not a typical to compare against');
    assert.notEqual(a.annunciate, false);
  }
});

test('★★ a recorder that throws on the load read leaves the hot side annunciating (and the pass alive)', () => {
  const rec = makeRecorderStub({
    query: (_sn, metric) => metric.startsWith('mppt_') ? tempHistory(32) : [],
    queryMulti: () => { throw new Error('database is locked'); },
  });
  const alerts = mppt(core(50, { in: 0, out: 0 }), rec);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((a) => a.severity === 'warning' && a.annunciate !== false));
});

test('★★ scope: pack cell temperature is NOT load-gated — a cold-side pack deviation keeps the old rule', () => {
  // A pack warming (or cooling) while electrically idle is exactly the internal-fault signature
  // the pack baseline exists to catch; v1.187.0 gates only the MPPT targets.
  resetForecastCachesForTesting();
  const devices = core(40, { in: 0, out: 0 }, [{ num: 1, temp: 15, hwBoardTemp: null }]);
  const alerts = computeBaselineAlerts(devices, recorder(40, activityRows(0, 0), 35));
  const pack = alerts.find((a) => a.id === `baseline-pack1_temp-${SN}`);
  assert.ok(pack, 'the pack deviation surfaces');
  assert.equal(pack!.severity, 'warning');
  assert.notEqual(pack!.annunciate, false);
  assert.equal(pack!.muteReason, undefined);
});

test('★ the load history is read only for a hot MPPT excursion, once per Core', () => {
  let reads = 0;
  const rec = makeRecorderStub({
    query: (_sn, metric) => metric.startsWith('mppt_') ? tempHistory(49) : [],
    queryMulti: (_sn, metrics) => { reads++; return new Map(metrics.map((m) => [m, []])); },
  });
  mppt(core(29, { in: 0, out: 0 }), rec);
  assert.equal(reads, 0, 'a cool excursion needs no load evidence');
  const hot = makeRecorderStub({
    query: (_sn, metric) => metric.startsWith('mppt_') ? tempHistory(32) : [],
    queryMulti: (_sn, metrics) => { reads++; return new Map(metrics.map((m) => [m, []])); },
  });
  mppt(core(50, { in: 0, out: 0 }), hot);
  assert.equal(reads, 1, 'HV and LV share one bucketed read');
});
