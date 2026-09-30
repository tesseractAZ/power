import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, resetVdiffWarnHoldForTesting, type Alert } from '../src/alerts.js';
import { computeLearnedAlerts, _resetPeerHitCounts } from '../src/analytics.js';
import { quietPeerSpreadUnderHeldCritical, risingEdgePushes } from '../src/alertMonitor.js';
import { conditionFromAlerts, speakableAlerts } from '../src/broadcast.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { readFileSync } from 'node:fs';

/* ===================================================================
 * v1.187.0 — the peer cell-spread outlier yields to its pack's HELD critical.
 *
 * The top-of-charge gate on peer-voldiff (analytics.computeLearnedAlerts, topOfChargeQuietSpread)
 * lifts once the outlier's spread reaches the critical line, on the premise that vdiff-crit
 * speaks there. But the bounded cell-spread mutes (balancing, the end-of-charge grace) hold
 * vdiff-crit silent at exactly that point, so during the 2026-09-29 knee the Core 1 pack 1
 * outlier voiced yellow / all-clear / yellow / all-clear (15:32:00-15:38:40) in place of the
 * suppressed red. alertMonitor.quietPeerSpreadUnderHeldCritical stamps it audible:false while
 * the same pack's vdiff-crit is held (mutedBy); card and push unchanged.
 *
 * The replay below is the recorder's raw rows for all five Core 1 packs, 14:50-15:56
 * (pack*_vol_diff_mv, _vol_max_mv, _soc, _balancing, _in; charge input thinned to its crossings
 * of 50 W), through the same-tick pipeline: computeAlerts + computeLearnedAlerts → the stamp →
 * the broadcast tick's speakableAlerts (with the 10-minute onset hold) → conditionFromAlerts.
 * =================================================================== */

type Field = 'vd' | 'vmax' | 'soc' | 'bal' | 'in';
/** `HH:MM:SS=value` rows, 2026-09-29 (MST, UTC-7). The first row is the value at 14:50:00. */
const CORE1_0929: Record<number, Record<Field, string>> = {
  1: {
    vd: '14:50:00=18 14:52:54=20 14:55:54=25 14:58:54=29 15:01:54=30 15:04:54=33 15:07:55=36 15:10:56=39 15:13:55=44 15:16:56=50 15:19:56=58 15:22:56=52 15:25:56=67 15:28:57=83 15:31:57=93 15:34:57=101 15:37:58=93 15:40:58=67 15:43:59=51 15:46:59=40 15:49:59=31 15:53:00=23',
    vmax: '14:50:00=3398 14:52:54=3406 14:55:54=3414 14:58:54=3421 15:01:54=3416 15:04:54=3415 15:07:55=3417 15:10:56=3421 15:13:55=3426 15:16:56=3434 15:19:56=3443 15:22:56=3429 15:25:56=3453 15:28:57=3470 15:31:57=3481 15:34:57=3489 15:37:58=3470 15:40:58=3431 15:43:59=3411 15:46:59=3395 15:49:59=3381 15:53:00=3370',
    soc: '14:50:00=99 15:37:16=100 15:37:27=99 15:37:58=100',
    bal: '14:50:00=0 15:14:28=1 15:38:28=0',
    in: '14:50:00=263 14:50:14=0 14:50:27=263 15:21:16=0 15:21:27=149 15:37:16=0 15:37:27=147 15:37:58=0',
  },
  2: {
    vd: '14:50:00=13 14:50:30=10 14:53:30=15 14:56:31=17 14:59:31=18 15:02:30=17 15:05:30=16 15:11:30=17 15:14:32=19 15:17:32=23 15:20:33=26 15:23:33=25 15:26:33=33 15:29:33=40 15:32:33=46 15:35:33=51 15:38:34=62 15:44:35=38 15:47:35=26 15:50:36=18 15:53:36=12',
    vmax: '14:50:00=3396 14:50:30=3381 14:53:30=3402 14:56:31=3407 14:59:31=3409 15:02:30=3405 15:05:30=3403 15:08:30=3402 15:11:30=3406 15:14:32=3410 15:17:32=3418 15:20:33=3422 15:23:33=3418 15:26:33=3436 15:29:33=3447 15:32:33=3454 15:35:33=3461 15:38:34=3480 15:41:34=3467 15:44:35=3416 15:47:35=3392 15:50:36=3370 15:53:36=3364',
    soc: '14:50:00=98 14:58:14=99 14:58:27=98 14:59:14=99 14:59:28=98 14:59:38=99 15:41:16=100 15:41:27=99 15:41:37=100',
    bal: '14:50:00=0 15:30:28=1 15:42:28=0',
    in: '14:50:00=359 14:50:14=0 14:50:27=359 14:50:38=31 14:51:14=205 14:51:28=31 14:52:14=354 14:52:27=31 14:53:14=343 14:53:27=31 14:53:38=333 15:21:16=0 15:21:27=186 15:41:16=0 15:41:27=232 15:41:37=0',
  },
  3: {
    vd: '14:50:00=11 14:51:05=7 14:54:05=11 14:57:06=13 15:12:07=15 15:15:07=17 15:18:08=21 15:24:08=24 15:27:09=33 15:30:09=42 15:33:09=47 15:36:10=54 15:39:10=67 15:42:10=57 15:45:10=30 15:48:11=19 15:51:12=12 15:54:12=10',
    vmax: '14:50:00=3400 14:51:05=3382 14:54:05=3402 14:57:06=3409 15:00:06=3404 15:03:06=3406 15:06:07=3404 15:12:07=3408 15:15:07=3412 15:18:08=3420 15:21:08=3413 15:24:08=3421 15:27:09=3437 15:30:09=3449 15:33:09=3455 15:36:10=3463 15:39:10=3483 15:42:10=3453 15:45:10=3402 15:48:11=3382 15:51:12=3365 15:54:12=3362',
    soc: '14:50:00=98 14:59:14=99 14:59:28=98 15:00:06=99 15:41:16=100 15:41:27=99 15:42:10=100',
    bal: '14:50:00=0 15:30:28=1 15:42:28=0',
    in: '14:50:00=434 15:21:08=0 15:22:15=215 15:22:28=0 15:23:15=276 15:23:27=0 15:24:08=269 15:41:16=0 15:41:27=256 15:42:10=0',
  },
  4: {
    vd: '14:50:00=17 14:51:42=13 14:54:42=18 14:57:42=20 15:00:42=19 15:12:43=21 15:15:43=22 15:18:44=26 15:21:44=23 15:24:44=29 15:27:45=36 15:30:44=40 15:33:45=43 15:36:46=48 15:39:46=60 15:42:46=54 15:45:46=29 15:48:47=18 15:51:48=13 15:54:49=11',
    vmax: '14:50:00=3401 14:51:42=3387 14:54:42=3402 14:57:42=3408 15:00:42=3403 15:06:43=3401 15:12:43=3405 15:15:43=3408 15:18:44=3416 15:21:44=3400 15:24:44=3418 15:27:45=3431 15:30:44=3437 15:33:45=3441 15:36:46=3448 15:39:46=3467 15:42:46=3445 15:45:46=3396 15:48:47=3377 15:51:48=3366 15:54:49=3362',
    soc: '14:50:00=97 14:58:14=98 14:58:27=97 14:59:14=98 14:59:28=97 15:00:15=98 15:00:27=97 15:00:42=98 15:20:15=99 15:20:27=98 15:21:16=99 15:21:27=98 15:21:44=99 15:42:16=100 15:42:28=99 15:42:46=100',
    bal: '14:50:00=0 15:31:27=1 15:43:27=0',
    in: '14:50:00=399 15:21:16=0 15:21:27=265 15:42:16=0 15:42:28=267 15:42:46=0',
  },
  5: {
    vd: '14:50:00=8 14:55:18=11 14:58:18=12 15:13:28=13 15:16:19=15 15:19:20=17 15:22:20=15 15:25:20=20 15:28:20=26 15:31:21=31 15:34:21=36 15:37:21=40 15:40:22=49 15:43:23=34 15:46:23=18 15:49:24=12 15:52:23=8 15:55:25=7',
    vmax: '14:50:00=3388 14:52:18=3391 14:55:18=3401 14:58:18=3406 15:01:19=3402 15:07:19=3399 15:10:19=3401 15:13:19=3404 15:16:19=3408 15:19:20=3415 15:22:20=3399 15:25:20=3420 15:28:20=3432 15:31:21=3440 15:34:21=3446 15:37:21=3455 15:40:22=3472 15:43:23=3420 15:46:23=3384 15:49:24=3371 15:52:23=3363 15:55:25=3359',
    soc: '14:50:00=96 14:52:14=97 15:03:14=98 15:03:28=97 15:04:15=98 15:21:16=99 15:21:27=98 15:22:15=99 15:42:16=100 15:42:28=99 15:43:17=100',
    bal: '14:50:00=0 15:37:27=1 15:40:28=0',
    in: '14:50:00=159 15:21:16=0 15:21:27=288 15:42:16=0 15:42:28=291 15:43:17=0',
  },
};

const SN = 'DPU-CORE-ONE';
const TICK_MS = 20_000;
const at = (hms: string) => Date.parse(`2026-09-29T${hms}-07:00`);
/** The wall clock computeAlerts reads, pinned per tick (mocked in beforeEach). */
let clock = 0;

interface Ev { atMs: number; pack: number; field: Field; value: number }
const EVENTS: Ev[] = Object.entries(CORE1_0929).flatMap(([pack, fields]) =>
  (Object.entries(fields) as Array<[Field, string]>).flatMap(([field, rows]) =>
    rows.split(' ').map((row) => {
      const [hms, v] = row.split('=');
      return { atMs: at(hms), pack: Number(pack), field, value: Number(v) };
    }))).sort((a, b) => a.atMs - b.atMs);

function core(vals: Record<number, Record<Field, number>>): Record<string, DeviceSnapshot> {
  const packs = Object.entries(vals).map(([num, v]) => ({
    num: Number(num), soc: v.soc, packSn: `PACK-${num}`, inputWatts: v.in, outputWatts: 0,
    streamInputW: { w: v.in, atMs: clock },
    maxVolDiffMv: v.vd, maxCellVoltageMv: v.vmax, minCellVoltageMv: v.vmax - v.vd,
    balanceState: v.bal, cellVoltagesMv: [], temp: 30, maxCellTemp: 30, soh: 100, actSoh: 100,
  }));
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: clock,
      projection: {
        kind: 'dpu', soc: 99, packs,
        pvHighWatts: 900, pvLowWatts: 900, pvTotalWatts: 1800, pvHighVolts: 300, pvHighAmps: 3, pvLowVolts: 150, pvLowAmps: 6,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 1800, totalOutWatts: 0,
        batVol: 53, batAmp: 10, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}

interface Step { hms: string; level: string; spoken: Alert[]; all: Alert[] }
/** Replay 14:50:00 → 15:56:00 on the 20 s tick; `stamp` = whether the monitor's stamp runs. */
function replay(stamp: boolean): Step[] {
  const vals: Record<number, Record<Field, number>> = { 1: {} as any, 2: {} as any, 3: {} as any, 4: {} as any, 5: {} as any };
  const onset = new Map<string, number>(); // alertOnset: first tick present, dropped on absence
  const out: Step[] = [];
  let i = 0;
  for (let t = at('14:50:00'); t <= at('15:56:00'); t += TICK_MS) {
    while (i < EVENTS.length && EVENTS[i].atMs <= t) { vals[EVENTS[i].pack][EVENTS[i].field] = EVENTS[i].value; i++; }
    clock = t;
    const devices = core(vals);
    const raw = [...computeAlerts(devices), ...computeLearnedAlerts(devices)];
    const all = stamp ? quietPeerSpreadUnderHeldCritical(raw) : raw;
    const ids = new Set(all.map((a) => a.id));
    for (const id of [...onset.keys()]) if (!ids.has(id)) onset.delete(id);
    for (const id of ids) if (!onset.has(id)) onset.set(id, t);
    const spoken = speakableAlerts(all, t, (id) => onset.get(id));
    const hms = new Date(t - 7 * 3_600_000).toISOString().slice(11, 19);
    out.push({ hms, level: conditionFromAlerts(spoken).level, spoken, all });
  }
  return out;
}

beforeEach(() => {
  resetVdiffWarnHoldForTesting();
  _resetPeerHitCounts();
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());

test('★★★ 2026-09-29 Core 1, all five packs, 14:50-15:56: the knee never speaks (no yellow, no red, no all-clear)', () => {
  const steps = replay(true);
  const pack1Crit = steps.filter((s) => s.all.some((a) => a.id === `vdiff-crit-${SN}-1`));
  assert.ok(pack1Crit.length > 0, 'the fixture reaches pack 1\'s plateau critical line');
  const pack1PeerAtLine = steps.filter((s) => s.all.some((a) => a.id === `peer-voldiff-${SN}-1` && /is (9\d|1\d\d) mV/.test(a.detail)));
  assert.ok(pack1PeerAtLine.length > 0, 'and its peer outlier stands at the critical line (93-101 mV vs 31-46)');
  for (const s of steps) {
    assert.equal(s.level, 'green', `${s.hms}: ${s.spoken.filter((a) => a.severity !== 'info').map((a) => a.id).join(', ')}`);
  }
});

test('★★★ the replay exercises the defect: without the stamp the outlier speaks a yellow at the line', () => {
  const steps = replay(false);
  const yellow = steps.filter((s) => s.level === 'yellow');
  assert.ok(yellow.length > 0, 'the v1.187.0-without-stamp pipeline raises yellow during the knee');
  for (const s of yellow) {
    assert.ok(s.spoken.some((a) => a.id === `peer-voldiff-${SN}-1`), `${s.hms}: the yellow is pack 1's peer outlier`);
  }
});

test('★★★ while held, the outlier keeps its card and its PUSH (annunciate untouched)', () => {
  const steps = replay(true);
  const held = steps.flatMap((s) => s.all.filter((a) => a.id === `peer-voldiff-${SN}-1` && /critical is held/.test(a.detail)));
  assert.ok(held.length > 0, 'the stamp ran during the knee');
  assert.ok(held.some((a) => a.severity === 'warning'), 'including at warning severity (the tier that spoke)');
  for (const a of held) {
    assert.equal(a.audible, false);
    assert.notEqual(a.annunciate, false);
    assert.equal(risingEdgePushes(a), true, 'the phone still gets it');
  }
});

/* ── the stamp itself ───────────────────────────────────────────────────── */

const crit = (pk: number, o: Partial<Alert> = {}): Alert => ({
  id: `vdiff-crit-${SN}-${pk}`, severity: 'critical', category: 'Battery', device: 'Core 1', title: 'Cell imbalance',
  detail: `Core 1 Pack ${pk} cell spread 95 mV.`, ...o,
});
const peer = (key: string, pk: number, o: Partial<Alert> = {}): Alert => ({
  id: `peer-${key}-${SN}-${pk}`, severity: 'warning', category: 'Battery', device: 'Core 1', source: 'learned', coreNum: 1, packNum: pk,
  title: 'Cell-voltage spread — peer outlier', detail: `Core 1 Pack ${pk} cell-voltage spread is 95 mV.`, ...o,
});

test('★★★ quietPeerSpreadUnderHeldCritical: a held critical quiets its OWN pack\'s spread outlier only', () => {
  for (const mutedBy of ['balancing', 'end-of-charge', 'charging'] as const) {
    const set = [crit(1, { annunciate: false, mutedBy }), peer('voldiff', 1), peer('voldiff', 2), peer('soh', 1), peer('voldiff', 11)];
    quietPeerSpreadUnderHeldCritical(set);
    assert.equal(set[1].audible, false, `${mutedBy}: the same pack's outlier is quiet`);
    assert.equal(set[1].annunciate, undefined, 'the push is kept');
    assert.match(set[1].detail, /Not announced on the speakers while this pack's cell-imbalance critical is held/);
    assert.equal(set[2].audible, undefined, 'another pack is untouched');
    assert.equal(set[3].audible, undefined, 'another peer metric is untouched');
    assert.equal(set[4].audible, undefined, 'pack 11 is not pack 1');
  }
});

test('★★★ quietPeerSpreadUnderHeldCritical: an ANNUNCIATING critical, or one muted by membership, quiets nothing', () => {
  const speaking = [crit(1), peer('voldiff', 1)];
  quietPeerSpreadUnderHeldCritical(speaking);
  assert.equal(speaking[1].audible, undefined, 'the critical speaks — so does the outlier');
  const bench = [crit(1, { annunciate: false }), peer('voldiff', 1)];
  quietPeerSpreadUnderHeldCritical(bench);
  assert.equal(bench[1].audible, undefined, 'a bench / off-panel mute carries no mutedBy and quiets nothing here');
  const inconsistent = [crit(1, { mutedBy: 'balancing' }), peer('voldiff', 1)];
  quietPeerSpreadUnderHeldCritical(inconsistent);
  assert.equal(inconsistent[1].audible, undefined, 'mutedBy on a critical that still annunciates is not a hold');
});

test('★★ the monitor stamps the SAME tick\'s computeAlerts + computeLearnedAlerts output (main thread)', () => {
  // Both sets must be in hand for the stamp to see the held critical; the analytics worker has
  // no alerts.ts state (see the v1.184.0 worker-guard lesson), so it cannot run there.
  const M = readFileSync(new URL('../src/alertMonitor.ts', import.meta.url), 'utf8');
  const call = M.slice(M.indexOf('const liveHead: Alert[] = quietPeerSpreadUnderHeldCritical(['));
  assert.ok(call.length < M.length, 'liveHead is built through the stamp');
  const body = call.slice(0, call.indexOf(']);'));
  assert.match(body, /\.\.\.computeAlerts\(snap\.devices/);
  assert.match(body, /\.\.\.computeLearnedAlerts\(snap\.devices\)/);
});
