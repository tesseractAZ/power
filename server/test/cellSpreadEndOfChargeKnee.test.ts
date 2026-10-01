import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAlerts, resetVdiffWarnHoldForTesting, advanceVdiffKnee, vdiffCritMute, vdiffKneeChargeW,
  VOL_DIFF_KNEE_HARD_MV, VDIFF_KNEE_RELAX_MS, VDIFF_KNEE_MAX_MUTE_MS, VDIFF_KNEE_CHARGE_W,
  VDIFF_KNEE_STREAM_FRESH_MS, VDIFF_KNEE_GAP_CARRY_MS,
  type Alert, type VdiffKneeObservation,
} from '../src/alerts.js';
import { silentCriticalLine } from '../src/alertMonitor.js';
import { SnapshotStore, type DeviceSnapshot } from '../src/snapshot.js';
import type { DpuProjection } from '../src/ecoflow/project.js';

/* ===================================================================
 * v1.187.0 — the end-of-charge knee (alarm-storm-1, 2026-09-29).
 *
 * Two healthy packs at 100% sounded the 72-second critical klaxon and pushed [Critical]:
 * at or above the plateau line (90 mV at >= 85% SoC) the only mute was the INSTANTANEOUS
 * balancing flag, and the BMS stops balancing about a minute after charging stops — while
 * the spread is at its peak. It was below 90 mV 2-3 minutes later.
 *
 * The grace that fixes it is bounded on every side, and a real imbalance must still speak:
 *   - it opens only on top-of-charge ACTIVITY evidence at >= 95% SoC: balancing (the benign
 *     mechanism — every benign reading at the line had it), or stream-delivered charge input,
 *     which holds a critical for at most VDIFF_KNEE_RELAX_MS from its FIRST crossing;
 *   - VDIFF_KNEE_RELAX_MS after the last balancing, a spread still on the line annunciates;
 *   - VDIFF_KNEE_MAX_MUTE_MS after the spread first reached the line it annunciates even
 *     while the BMS is balancing (that mute was unbounded);
 *   - VOL_DIFF_KNEE_HARD_MV annunciates at once, at any SoC, balancing or not.
 *
 * Fixtures are the recorder's raw rows (pack*_vol_diff_mv, _vol_max_mv, _soc, _balancing, _in;
 * the charge input thinned to its crossings of the 50 W activity line), replayed through
 * computeAlerts on the monitor's 20-second tick. The charge input is delivered as the stream's
 * own value (DpuPack.streamInputW) unless a test says the stream is silent.
 * =================================================================== */

type Field = 'vd' | 'vmax' | 'soc' | 'bal' | 'in';
type Ev = [string, Field, number];
interface Fixture { day: string; start: string; end: string; init: Partial<Record<Field, number>>; events: Ev[] }

/** Core 5 pack 3, 2026-09-29 — v1.186.5 raised red at 15:33:50, 12 s after balancing stopped. */
const C5P3_0929: Fixture = {
  day: '2026-09-29', start: '15:20:00', end: '15:50:00',
  init: { vd: 42, vmax: 3432, soc: 99, bal: 1, in: 248 },
  events: [
    ['15:20:37', 'vd', 52], ['15:20:37', 'vmax', 3444], ['15:21:17', 'in', 0], ['15:21:27', 'in', 215],
    ['15:23:36', 'vd', 49], ['15:23:36', 'vmax', 3435], ['15:26:37', 'vd', 73], ['15:26:37', 'vmax', 3463],
    ['15:29:37', 'vd', 90], ['15:29:37', 'vmax', 3480], ['15:32:37', 'soc', 100], ['15:32:37', 'vd', 104],
    ['15:32:37', 'vmax', 3490], ['15:32:38', 'in', 0], ['15:33:38', 'bal', 0], ['15:35:38', 'vd', 67],
    ['15:35:38', 'vmax', 3431], ['15:38:38', 'vd', 49], ['15:38:38', 'vmax', 3406], ['15:41:39', 'vd', 39],
    ['15:41:39', 'vmax', 3393], ['15:44:39', 'vd', 33], ['15:44:39', 'vmax', 3384], ['15:47:39', 'vd', 28],
    ['15:47:39', 'vmax', 3377],
  ],
};

/** Core 1 pack 1, 2026-09-29 — v1.186.5 pushed [Critical] at 15:38:48, 20 s after balancing stopped. */
const C1P1_0929: Fixture = {
  day: '2026-09-29', start: '15:20:00', end: '15:56:00',
  init: { vd: 58, vmax: 3443, soc: 99, bal: 1, in: 149 },
  events: [
    ['15:21:16', 'in', 0], ['15:21:27', 'in', 149], ['15:22:56', 'vd', 52], ['15:22:56', 'vmax', 3429],
    ['15:25:56', 'vd', 67], ['15:25:56', 'vmax', 3453], ['15:28:57', 'vd', 83], ['15:28:57', 'vmax', 3470],
    ['15:31:57', 'vd', 93], ['15:31:57', 'vmax', 3481], ['15:34:57', 'vd', 101], ['15:34:57', 'vmax', 3489],
    ['15:37:16', 'in', 0], ['15:37:16', 'soc', 100], ['15:37:27', 'in', 147], ['15:37:27', 'soc', 99],
    ['15:37:58', 'in', 0], ['15:37:58', 'soc', 100], ['15:37:58', 'vd', 93], ['15:37:58', 'vmax', 3470],
    ['15:38:28', 'bal', 0], ['15:40:58', 'vd', 67], ['15:40:58', 'vmax', 3431], ['15:43:59', 'vd', 51],
    ['15:43:59', 'vmax', 3411], ['15:46:59', 'vd', 40], ['15:46:59', 'vmax', 3395], ['15:49:59', 'vd', 31],
    ['15:49:59', 'vmax', 3381], ['15:53:00', 'vd', 23], ['15:53:00', 'vmax', 3370],
  ],
};

/** Core 5 pack 1, 2026-09-29 — held by the balancing mute at 101 mV; relaxed as it stopped. */
const C5P1_0929: Fixture = {
  day: '2026-09-29', start: '15:20:00', end: '15:50:00',
  init: { vd: 62, vmax: 3446, soc: 99, bal: 1, in: 179 },
  events: [
    ['15:21:17', 'in', 0], ['15:21:27', 'in', 179], ['15:22:24', 'vd', 49], ['15:22:24', 'vmax', 3419],
    ['15:25:25', 'vd', 66], ['15:25:25', 'vmax', 3448], ['15:28:25', 'vd', 76], ['15:28:25', 'vmax', 3459],
    ['15:31:25', 'vd', 85], ['15:31:25', 'vmax', 3467], ['15:34:26', 'vd', 101], ['15:34:26', 'vmax', 3490],
    ['15:36:17', 'in', 0], ['15:36:17', 'soc', 100], ['15:36:27', 'in', 182], ['15:36:27', 'soc', 99],
    ['15:37:17', 'in', 0], ['15:37:17', 'soc', 100], ['15:37:26', 'vd', 86], ['15:37:26', 'vmax', 3458],
    ['15:37:27', 'bal', 0], ['15:40:27', 'vd', 60], ['15:40:27', 'vmax', 3421], ['15:43:27', 'vd', 46],
    ['15:43:27', 'vmax', 3400], ['15:46:27', 'vd', 35], ['15:46:27', 'vmax', 3386], ['15:49:28', 'vd', 26],
    ['15:49:28', 'vmax', 3368],
  ],
};

/** Core 2 pack 2, 2026-07-28 — a grid top-up at 564 W, balancing; 90 mV, then 30 mV one reading later. */
const C2P2_0728: Fixture = {
  day: '2026-07-28', start: '03:20:00', end: '03:45:00',
  init: { vd: 47, vmax: 3454, soc: 98, bal: 0, in: 840 },
  events: [
    ['03:20:06', 'bal', 1], ['03:22:49', 'vd', 63], ['03:22:49', 'vmax', 3480], ['03:24:59', 'soc', 99],
    ['03:25:09', 'soc', 98], ['03:25:50', 'soc', 99], ['03:25:50', 'vd', 80], ['03:25:50', 'vmax', 3500],
    ['03:28:50', 'vd', 90], ['03:29:59', 'in', 0], ['03:29:59', 'soc', 100], ['03:30:12', 'in', 564],
    ['03:30:12', 'soc', 99], ['03:30:59', 'in', 0], ['03:30:59', 'soc', 100], ['03:31:13', 'in', 564],
    ['03:31:13', 'soc', 99], ['03:31:50', 'in', 0], ['03:31:50', 'soc', 100], ['03:31:50', 'vd', 30],
    ['03:31:50', 'vmax', 3390], ['03:32:17', 'bal', 0], ['03:35:14', 'vd', 17], ['03:35:14', 'vmax', 3369],
  ],
};

/**
 * REAL-IMBALANCE FIXTURE. Core 3 pack 2, 2026-08-22/23 (the week after a pack swap): the same
 * top-of-charge shape — balancing at 99%, the spread climbing to 138 mV — but it RELAXED SLOWLY:
 * 134 mV three minutes after balancing stopped, still >= 90 mV 33 minutes later. This must
 * annunciate once the relaxation window has lapsed.
 */
const C3P2_0822: Fixture = {
  day: '2026-08-22', start: '23:40:00', end: '00:30:00',
  init: { vd: 77, vmax: 3443, soc: 99, bal: 1, in: 51 },
  events: [
    ['23:40:05', 'in', 49], ['23:40:12', 'vd', 87], ['23:40:12', 'vmax', 3453], ['23:43:14', 'vd', 98],
    ['23:43:14', 'vmax', 3464], ['23:46:14', 'vd', 109], ['23:46:14', 'vmax', 3475], ['23:49:14', 'vd', 123],
    ['23:49:14', 'vmax', 3488], ['23:52:14', 'vd', 137], ['23:52:14', 'vmax', 3503], ['23:55:14', 'vd', 138],
    ['23:55:14', 'vmax', 3499], ['23:55:31', 'bal', 0], ['23:57:06', 'in', 85], ['23:57:28', 'in', 6],
    ['23:58:06', 'soc', 100], ['23:58:15', 'vd', 134], ['23:58:15', 'vmax', 3493], ['00:01:15', 'vd', 126],
    ['00:01:15', 'vmax', 3482], ['00:04:14', 'vd', 120], ['00:04:14', 'vmax', 3474], ['00:07:15', 'vd', 119],
    ['00:07:15', 'vmax', 3473], ['00:10:16', 'vd', 115], ['00:10:16', 'vmax', 3467], ['00:13:16', 'vd', 110],
    ['00:13:16', 'vmax', 3461], ['00:16:17', 'vd', 106], ['00:16:17', 'vmax', 3456], ['00:19:17', 'vd', 102],
    ['00:19:17', 'vmax', 3452], ['00:22:16', 'vd', 97], ['00:22:16', 'vmax', 3446], ['00:25:17', 'vd', 94],
    ['00:25:17', 'vmax', 3442], ['00:28:17', 'vd', 90], ['00:28:17', 'vmax', 3437],
  ],
};

/** REAL-IMBALANCE FIXTURE, no balancing at all: Core 3 pack 4, 2026-08-22/23, charging ~110 W at
 *  99% to 118 mV, then 109 → 106 → 101 → 97 → 94 → 90 over the next 18 minutes. */
const C3P4_0822: Fixture = {
  day: '2026-08-22', start: '23:50:00', end: '00:25:00',
  init: { vd: 37, vmax: 3409, soc: 99, bal: 0, in: 110 },
  events: [
    ['23:50:27', 'vd', 50], ['23:50:27', 'vmax', 3421], ['23:53:26', 'vd', 69], ['23:53:26', 'vmax', 3440],
    ['23:54:06', 'in', 46], ['23:54:26', 'in', 102], ['23:55:06', 'in', 46], ['23:55:27', 'in', 102],
    ['23:56:06', 'in', 44], ['23:56:27', 'vd', 78], ['23:56:27', 'vmax', 3442], ['23:57:06', 'in', 110],
    ['23:57:28', 'in', 44], ['23:58:06', 'in', 112], ['23:58:28', 'in', 44], ['23:59:06', 'in', 109],
    ['23:59:27', 'vd', 111], ['23:59:27', 'vmax', 3480], ['00:01:07', 'in', 0], ['00:01:07', 'soc', 100],
    ['00:01:29', 'in', 109], ['00:01:29', 'soc', 99], ['00:02:07', 'in', 0], ['00:02:07', 'soc', 100],
    ['00:02:27', 'vd', 118], ['00:02:27', 'vmax', 3478], ['00:05:27', 'vd', 109], ['00:05:27', 'vmax', 3464],
    ['00:08:27', 'vd', 106], ['00:08:27', 'vmax', 3459], ['00:11:28', 'vd', 101], ['00:11:28', 'vmax', 3452],
    ['00:14:29', 'vd', 97], ['00:14:29', 'vmax', 3447], ['00:17:29', 'vd', 94], ['00:17:29', 'vmax', 3442],
    ['00:20:28', 'vd', 90], ['00:20:28', 'vmax', 3437], ['00:23:29', 'vd', 86], ['00:23:29', 'vmax', 3433],
  ],
};

/**
 * REAL-IMBALANCE FIXTURE (synthetic, from the Core 3 pack 4 fault with a longer trickle): a pack
 * at 99% on a steady 110 W trickle, the BMS idle, and a steady 118 mV spread for 30 minutes.
 * v1.186.5 annunciated at once (not balancing). Charge input alone may hold it for at most
 * VDIFF_KNEE_RELAX_MS from its first crossing — never for as long as the trickle lasts.
 */
const TRICKLE_118: Fixture = {
  day: '2026-09-30', start: '12:00:00', end: '12:30:00',
  init: { vd: 118, vmax: 3478, soc: 99, bal: 0, in: 110 },
  events: [],
};

const SN = 'DPU-KNEE';
const TICK_MS = 20_000;
/** Phoenix local (fixed UTC-7) wall time → epoch ms, rolling past midnight when the clock wraps. */
function atMs(day: string, hms: string, startHms: string): number {
  const base = Date.parse(`${day}T${hms}-07:00`);
  return hms < startHms ? base + 24 * 3_600_000 : base;
}

function device(v: Record<Field, number>, extra: Record<string, unknown> = {}): Record<string, DeviceSnapshot> {
  // The charge input as the MQTT stream itself delivered it, this tick (a live stream).
  const pack = {
    num: 1, soc: v.soc, packSn: 'PACK-A', inputWatts: v.in, outputWatts: 0,
    streamInputW: { w: v.in, atMs: clock },
    maxVolDiffMv: v.vd, maxCellVoltageMv: v.vmax, minCellVoltageMv: v.vmax - v.vd,
    balanceState: v.bal, cellVoltagesMv: [], ...extra,
  };
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 9', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: v.soc, packs: [pack],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}

interface Tick { hms: string; atMs: number; v: Record<Field, number>; crit?: Alert }
/** The wall clock computeAlerts reads, pinned per tick (mocked in beforeEach). */
let clock = 0;

/** Replay a fixture on the 20-second monitor tick with the wall clock pinned to each tick.
 *  `extra` (per tick) overrides pack fields, e.g. a silent stream; `shiftMs` replays it later
 *  (the same knee again, on the same pack state). */
function replay(f: Fixture, extra: (v: Record<Field, number>) => Record<string, unknown> = () => ({}), shiftMs = 0): Tick[] {
  const v = { vd: 0, vmax: 3300, soc: 50, bal: 0, in: 0, ...f.init } as Record<Field, number>;
  const evs = f.events.map(([hms, k, x]) => ({ at: atMs(f.day, hms, f.start), k, x })).sort((a, b) => a.at - b.at);
  const out: Tick[] = [];
  let i = 0;
  for (let at = atMs(f.day, f.start, f.start); at <= atMs(f.day, f.end, f.start); at += TICK_MS) {
    while (i < evs.length && evs[i].at <= at) { v[evs[i].k] = evs[i].x; i++; }
    clock = at + shiftMs;
    const crit = computeAlerts(device(v, extra(v))).find((a) => a.id === `vdiff-crit-${SN}-1`);
    const d = new Date(at + shiftMs - 7 * 3_600_000).toISOString().slice(11, 19);
    out.push({ hms: d, atMs: at + shiftMs, v: { ...v }, crit });
  }
  return out;
}

/** The v1.186.5 rule, for contrast: a plateau crit was silent only while balancing. */
const oldRuleWouldSpeak = (k: Tick) => k.v.soc >= 85 && k.v.vd >= 90 && k.v.bal === 0;

/** Last tick with top-of-charge activity evidence, by the fixture's own raw rows. */
function lastActivity(ticks: Tick[]): Tick | undefined {
  return [...ticks].reverse().find((k) => k.v.soc >= 95 && k.v.vd >= 20 && (k.v.bal !== 0 || k.v.in > VDIFF_KNEE_CHARGE_W));
}
/** Last tick with top-of-charge BALANCING at a knee spread, by the fixture's own raw rows. */
function lastBalancing(ticks: Tick[]): Tick | undefined {
  return [...ticks].reverse().find((k) => k.v.soc >= 95 && k.v.vd >= 20 && k.v.bal !== 0);
}
/** First tick the fixture's spread stood at the plateau critical line. */
function firstCrossing(ticks: Tick[]): Tick | undefined {
  return ticks.find((k) => k.v.soc >= 85 && k.v.vd >= 90);
}

beforeEach(() => {
  resetVdiffWarnHoldForTesting();
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());

/* ── 1. the 2026-09-29 false reds are silent now ──────────────────────────── */

for (const [name, f] of [['Core 5 pack 3', C5P3_0929], ['Core 1 pack 1', C1P1_0929], ['Core 5 pack 1', C5P1_0929], ['Core 2 pack 2 (07-28)', C2P2_0728]] as const) {
  test(`★★★ ${name}: the end-of-charge spread stays on the card and never annunciates`, () => {
    const ticks = replay(f);
    const crits = ticks.filter((k) => k.crit);
    assert.ok(crits.length > 0, 'the fixture reaches the plateau critical line (the card is shown)');
    for (const k of crits) {
      assert.equal(k.crit!.annunciate, false, `${k.hms}: ${k.v.vd} mV must not sound (bal ${k.v.bal})`);
      assert.equal(k.crit!.severity, 'critical', 'still critical on the card');
    }
  });
}

test('★★★ the 09-29 fixtures exercise the post-balancing window that sounded in v1.186.5', () => {
  for (const f of [C5P3_0929, C1P1_0929]) {
    resetVdiffWarnHoldForTesting();
    const ticks = replay(f);
    const exposed = ticks.filter((k) => k.crit && oldRuleWouldSpeak(k));
    assert.ok(exposed.length > 0, 'v1.186.5 would have annunciated on these ticks');
    for (const k of exposed) {
      assert.equal(k.crit!.mutedBy, 'end-of-charge', `${k.hms}: held by the relaxation window`);
      assert.match(k.crit!.detail, /End-of-charge cell spread, relaxing\./);
    }
  }
});

test('while the BMS balances, the mute names balancing (log attribution)', () => {
  const ticks = replay(C5P3_0929);
  const k = ticks.find((x) => x.crit && x.v.bal === 1);
  assert.ok(k);
  assert.equal(k!.crit!.mutedBy, 'balancing');
  assert.match(silentCriticalLine(k!.crit!), /\(the BMS is balancing the cells\)/);
  const r = ticks.find((x) => x.crit?.mutedBy === 'end-of-charge');
  assert.match(silentCriticalLine(r!.crit!), /\(end-of-charge cell-spread relaxation window\)/);
  assert.match(silentCriticalLine({ title: 'Cell imbalance', device: 'Core 1', mutedBy: 'charging' }),
    /\(top-of-charge cell spread while charging, at most 5 minutes\)/);
  assert.match(silentCriticalLine({ title: 'Cell imbalance', device: 'Core 1' }), /\(by policy — reason not recorded\)/,
    'an alert muted with no stamped reason says so rather than guessing a membership reason');
  assert.match(silentCriticalLine({ title: 'Cell imbalance', device: 'Core 4', mutedBy: 'balancing', muteReason: 'bench spare' }), /\(bench spare\)/,
    'a stamped muteReason wins over the cell-spread mute text');
});

/* ── 2. a real imbalance still speaks ─────────────────────────────────────── */

for (const [name, f] of [['Core 3 pack 2 (balancing, 138 mV)', C3P2_0822], ['Core 3 pack 4 (charging only, 118 mV)', C3P4_0822], ['steady 110 W trickle (118 mV, BMS idle)', TRICKLE_118]] as const) {
  test(`★★★ REAL FAULT — ${name}: annunciates within the relaxation window of the last activity`, () => {
    const ticks = replay(f);
    const act = lastActivity(ticks);
    assert.ok(act, 'the fixture shows top-of-charge activity');
    const first = ticks.find((k) => k.crit && k.crit.annunciate !== false);
    assert.ok(first, 'the slow-relaxing spread must annunciate');
    assert.ok(first!.atMs <= act!.atMs + VDIFF_KNEE_RELAX_MS + TICK_MS,
      `annunciated at ${first!.hms}, more than the window after the last activity at ${act!.hms}`);
    assert.match(first!.crit!.detail, /Did not relax at the top of charge\./);
    // …and it keeps annunciating for as long as the spread stays on the line.
    for (const k of ticks.filter((x) => x.atMs > first!.atMs && x.crit)) {
      assert.notEqual(k.crit!.annunciate, false, `${k.hms}: ${k.v.vd} mV silenced again`);
    }
  });
}

test('★★★ REAL FAULT — each grace ends on its own bound: balancing from the last balancing, charge from the first crossing', () => {
  // Core 3 pack 2 balanced, then trickled 85 W once: the balancing window decides (~00:00:20).
  const p2 = replay(C3P2_0822);
  const p2First = p2.find((k) => k.crit && k.crit.annunciate !== false)!;
  assert.ok(p2First.atMs <= lastBalancing(p2)!.atMs + VDIFF_KNEE_RELAX_MS + TICK_MS,
    `${p2First.hms}: later than the last balancing + VDIFF_KNEE_RELAX_MS`);
  // Core 3 pack 4 never balanced: charge input held it from its first crossing (~00:04:40), not
  // from its last charge tick (00:02:00 + 5 min).
  for (const f of [C3P4_0822, TRICKLE_118]) {
    resetVdiffWarnHoldForTesting();
    const ticks = replay(f);
    const cross = firstCrossing(ticks)!;
    const first = ticks.find((k) => k.crit && k.crit.annunciate !== false)!;
    assert.ok(first.atMs <= cross.atMs + VDIFF_KNEE_RELAX_MS + TICK_MS,
      `${first.hms}: later than the first crossing ${cross.hms} + VDIFF_KNEE_RELAX_MS`);
    for (const k of ticks.filter((x) => x.crit && x.atMs < first.atMs)) {
      assert.equal(k.crit!.mutedBy, 'charging', `${k.hms}: held by charge input alone, never the balancing window`);
      assert.match(k.crit!.detail, /Top-of-charge cell spread while charging\./);
      assert.doesNotMatch(k.crit!.detail, /relaxing/, 'a pack still charging is not described as relaxing');
    }
  }
});

test('★★★ REAL FAULT — a steady trickle cannot keep refreshing its own mute', () => {
  const ticks = replay(TRICKLE_118);
  const first = ticks.find((k) => k.crit && k.crit.annunciate !== false)!;
  assert.equal(first.atMs - ticks[0].atMs, VDIFF_KNEE_RELAX_MS, 'speaks VDIFF_KNEE_RELAX_MS after the first crossing');
  assert.equal(first.v.in, 110, 'while still charging');
  for (const k of ticks.filter((x) => x.atMs >= first.atMs)) {
    assert.notEqual(k.crit!.annunciate, false, `${k.hms}: silenced again while charging`);
  }
});

test('★★ the added delay over v1.186.5 on the real-fault fixtures is bounded', () => {
  for (const f of [C3P2_0822, C3P4_0822, TRICKLE_118]) {
    resetVdiffWarnHoldForTesting();
    const ticks = replay(f);
    const oldFirst = ticks.find((k) => k.crit && oldRuleWouldSpeak(k))!;
    const newFirst = ticks.find((k) => k.crit && k.crit.annunciate !== false)!;
    assert.ok(newFirst.atMs - oldFirst.atMs <= VDIFF_KNEE_RELAX_MS + 3 * 60_000,
      `${oldFirst.hms} → ${newFirst.hms}: the grace must stay within one reading of its window`);
  }
});

/* ── 3. the bounds ────────────────────────────────────────────────────────── */

function tickAt(nowMs: number, v: Record<Field, number>, extra?: Record<string, unknown>): Alert | undefined {
  clock = nowMs;
  return computeAlerts(device(v, extra)).find((x) => x.id === `vdiff-crit-${SN}-1`);
}
const T0 = Date.parse('2026-09-29T15:00:00-07:00');

test('★★★ ceiling: a spread at VOL_DIFF_KNEE_HARD_MV annunciates at once, even while balancing', () => {
  assert.equal(VOL_DIFF_KNEE_HARD_MV, 150);
  const top = tickAt(T0, { vd: 150, vmax: 3530, soc: 100, bal: 1, in: 300 });
  assert.ok(top);
  assert.notEqual(top!.annunciate, false, 'top of charge, balancing and charging: the ceiling still speaks');
  resetVdiffWarnHoldForTesting();
  assert.equal(tickAt(T0, { vd: 149, vmax: 3530, soc: 100, bal: 1, in: 300 })!.annunciate, false, '149 mV while balancing: muted');
  resetVdiffWarnHoldForTesting();
  const mid = tickAt(T0, { vd: 150, vmax: 3400, soc: 50, bal: 1, in: 0 });
  assert.notEqual(mid!.annunciate, false, 'off the plateau the v0.29.0 balancing mute is capped too');
  resetVdiffWarnHoldForTesting();
  assert.equal(tickAt(T0, { vd: 149, vmax: 3400, soc: 50, bal: 1, in: 0 })!.annunciate, false,
    'below the ceiling, off-plateau balancing behaves as before');
});

test('★★★ duration: a spread the BMS is still balancing at top of charge speaks after VDIFF_KNEE_MAX_MUTE_MS', () => {
  const v = { vd: 110, vmax: 3500, soc: 100, bal: 1, in: 200 };
  let last: Alert | undefined;
  for (let dt = 0; dt < VDIFF_KNEE_MAX_MUTE_MS; dt += TICK_MS) {
    last = tickAt(T0 + dt, v);
    assert.equal(last!.annunciate, false, `+${dt / 1000}s: inside the bound, balancing mutes`);
  }
  const at = tickAt(T0 + VDIFF_KNEE_MAX_MUTE_MS, v);
  assert.notEqual(at!.annunciate, false, 'the balancing mute is no longer unbounded at top of charge');
  assert.match(at!.detail, /First reached the critical line 20 minutes ago\./);
});

test('★★ duration: a spread hovering on the line cannot restart the clock', () => {
  // 95 / 85 / 95 … while balancing: the dips stay above VOL_DIFF_CRIT_MV, so the episode holds.
  const ticks = VDIFF_KNEE_MAX_MUTE_MS / TICK_MS;
  assert.equal(ticks % 2, 0, 'the last tick lands on a 95 mV reading');
  for (let n = 0; n < ticks; n++) {
    tickAt(T0 + n * TICK_MS, { vd: n % 2 === 0 ? 95 : 85, vmax: 3490, soc: 100, bal: 1, in: 200 });
  }
  const a = tickAt(T0 + VDIFF_KNEE_MAX_MUTE_MS, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 200 });
  assert.notEqual(a!.annunciate, false, 'the clock ran from the FIRST crossing');
});

test('★★ duration BELOW the top of charge (85-95%): the episode clock alone bounds the balancing mute — hovering on the line cannot restart it', () => {
  // At the top of charge the session clock bounds the balancing mute as well; on the rest of the
  // plateau only the critical-line episode does, so its reset rules must hold there on their own.
  const ticks = VDIFF_KNEE_MAX_MUTE_MS / TICK_MS;
  for (let n = 0; n < ticks; n++) {
    const a = tickAt(T0 + n * TICK_MS, { vd: n % 2 === 0 ? 95 : 85, vmax: 3490, soc: 90, bal: 1, in: 200 });
    if (n % 2 === 0) assert.equal(a!.mutedBy, 'balancing', `+${(n * TICK_MS) / 1000}s: inside the bound`);
  }
  const a = tickAt(T0 + VDIFF_KNEE_MAX_MUTE_MS, { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 200 });
  assert.notEqual(a!.annunciate, false, 'the clock ran from the FIRST crossing');
  assert.match(a!.detail, /First reached the critical line 20 minutes ago\./);
});

test('★★ …and a dip under the plateau line SHORTER than VDIFF_KNEE_RELAX_MS keeps it there too', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 0 });
  const dipEnd = T0 + VDIFF_KNEE_RELAX_MS - TICK_MS;
  for (let t = T0 + TICK_MS; t < dipEnd; t += TICK_MS) tickAt(t, { vd: 70, vmax: 3470, soc: 90, bal: 1, in: 0 });
  for (let t = dipEnd; t < T0 + VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tickAt(t, { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 0 });
  const a = tickAt(T0 + VDIFF_KNEE_MAX_MUTE_MS, { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 0 });
  assert.notEqual(a!.annunciate, false, 'the 20-minute bound ran from the first crossing');
});

test('★★★ evidence: no top-of-charge activity → no grace (an idle pack at 99% speaks at once)', () => {
  const a = tickAt(T0, { vd: 95, vmax: 3480, soc: 99, bal: 0, in: 0 });
  assert.notEqual(a!.annunciate, false);
  assert.doesNotMatch(a!.detail, /relaxing/);
});

test('★★ evidence: activity counts only once the spread has reached the warn line', () => {
  // Balancing at 99% with a 10 mV spread is housekeeping, not a knee.
  tickAt(T0, { vd: 10, vmax: 3400, soc: 99, bal: 1, in: 0 });
  const a = tickAt(T0 + TICK_MS, { vd: 95, vmax: 3480, soc: 99, bal: 0, in: 0 });
  assert.notEqual(a!.annunciate, false);
});

test('★★★ evidence: the grace is keyed on pack SoC, never on the max cell alone', () => {
  // 2026-09-22 bench shape: a runaway-high cell (3.461 V) on a pack reading 71%, charging.
  const a = tickAt(T0, { vd: 72, vmax: 3461, soc: 71, bal: 0, in: 383 });
  assert.ok(a, 'off the plateau the 50 mV critical applies');
  assert.notEqual(a!.annunciate, false, 'a mid-SoC runaway cell is a real fault and speaks at once');
  resetVdiffWarnHoldForTesting();
  // At 94% (plateau, below the top-of-charge line) charging is not grace evidence either.
  tickAt(T0, { vd: 60, vmax: 3450, soc: 94, bal: 0, in: 400 });
  const b = tickAt(T0 + TICK_MS, { vd: 92, vmax: 3480, soc: 94, bal: 0, in: 400 });
  assert.notEqual(b!.annunciate, false);
});

test('★★★ fail-to-relax: the window closes VDIFF_KNEE_RELAX_MS after the last activity', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  const inside = tickAt(T0 + VDIFF_KNEE_RELAX_MS - TICK_MS, { vd: 95, vmax: 3480, soc: 100, bal: 0, in: 0 });
  assert.equal(inside!.annunciate, false);
  assert.equal(inside!.mutedBy, 'end-of-charge');
  const out = tickAt(T0 + VDIFF_KNEE_RELAX_MS, { vd: 95, vmax: 3480, soc: 100, bal: 0, in: 0 });
  assert.notEqual(out!.annunciate, false, 'still on the line when the window closes → annunciate');
  assert.match(out!.detail, /Did not relax at the top of charge\./);
});

test('★★★ evidence earned in the WARN band carries to a critical reading that lands after charging stopped', () => {
  // The BMS reports cell voltages every ~180 s: the reading that first crosses the line can
  // arrive after the pack stopped charging (2026-09-21, Core 5 pack 1: 27 mV at the stop, 66 mV
  // ten seconds later). The knee is therefore advanced on every reading, not only critical ones.
  tickAt(T0, { vd: 60, vmax: 3460, soc: 99, bal: 1, in: 180 });
  const a = tickAt(T0 + TICK_MS, { vd: 95, vmax: 3490, soc: 100, bal: 0, in: 0 });
  assert.equal(a!.annunciate, false);
  assert.equal(a!.mutedBy, 'end-of-charge');
});

test('★★ charging alone is activity evidence (2026-09-25: 84 mV at 551 W with the BMS idle)', () => {
  const a = tickAt(T0, { vd: 92, vmax: 3500, soc: 99, bal: 0, in: 551 });
  assert.equal(a!.annunciate, false, 'top-of-charge charging opens the window');
  assert.equal(a!.mutedBy, 'charging');
});

test('★★★ charge evidence must be RECENT: an old top-of-charge charge does not grace a new crossing', () => {
  // Charged at a knee spread, then idle at the top for 10 minutes; the spread then reaches the
  // line with the BMS idle and no charge. A crossing that is fresh does not make evidence fresh.
  tickAt(T0, { vd: 30, vmax: 3440, soc: 99, bal: 0, in: 200 });
  for (let t = T0 + TICK_MS; t < T0 + 10 * 60_000; t += TICK_MS) tickAt(t, { vd: 30, vmax: 3440, soc: 99, bal: 0, in: 0 });
  const a = tickAt(T0 + 10 * 60_000, { vd: 95, vmax: 3490, soc: 99, bal: 0, in: 0 });
  assert.notEqual(a!.annunciate, false);
});

test('★★★ charge input counts only as the STREAM delivered it — never the REST replay', () => {
  // 2026-07-28: the polled inputWatts alternated 0 / 564 W after the stream said 0.
  assert.equal(vdiffKneeChargeW({ streamInputW: { w: 0, atMs: T0 } }, T0), 0, 'the stream says 0 W');
  assert.equal(vdiffKneeChargeW({ streamInputW: { w: 210, atMs: T0 } }, T0 + VDIFF_KNEE_STREAM_FRESH_MS), 210, 'fresh at the edge');
  assert.equal(vdiffKneeChargeW({ streamInputW: { w: 210, atMs: T0 } }, T0 + VDIFF_KNEE_STREAM_FRESH_MS + 1), null,
    'a stream that has gone quiet is no evidence');
  assert.equal(vdiffKneeChargeW({} as never, T0), null, 'no stream value: no evidence (the polled one is never read)');
  // liveFlow falls back per field to the POLLED value when only the output was stream-fresh
  // (snapshot.annotateStreamFlow): a copied 564 W must not count.
  assert.equal(vdiffKneeChargeW({ inputWatts: 564, liveFlow: { inputWatts: 564, outputWatts: 0, atMs: T0 } } as never, T0), null);
  // End to end: the stream said 0 W; the REST replay says 564 W. The window lapses on time.
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  const a = tickAt(T0 + VDIFF_KNEE_RELAX_MS, { vd: 95, vmax: 3480, soc: 100, bal: 0, in: 564 },
    { streamInputW: { w: 0, atMs: T0 + VDIFF_KNEE_RELAX_MS } });
  assert.notEqual(a!.annunciate, false, 'the stream says 0 W: the window has lapsed');
});

test('★★★ the snapshot records the STREAM\'s own input (streamInputW), never the REST replay or liveFlow\'s fallback', () => {
  const CORE = 'COREXXX00XXX0001';
  const P1 = 'hs_yj751_bms_slave_addr.1.';
  const s = new SnapshotStore();
  let t = 1_000_000;
  s.setClock(() => t);
  s.setDeviceList([{ sn: CORE, deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: 1 } as never]);
  const pack = () => (s.get().devices[CORE].projection as DpuProjection).packs.find((p) => p.num === 1)!;
  s.setDeviceQuota(CORE, { [`${P1}soc`]: 100, [`${P1}inputWatts`]: 564, [`${P1}outputWatts`]: 0 });
  assert.equal(pack().streamInputW, undefined, 'a polled value alone is no stream delivery');
  assert.equal(vdiffKneeChargeW(pack(), t), null, 'so no charge evidence');
  t += 5_000;
  // The stream is alive but has delivered only this pack's OUTPUT: its input is still unknown.
  s.mergeDeviceQuota(CORE, { [`${P1}outputWatts`]: 0 }, 'mqtt');
  s.setDeviceQuota(CORE, { [`${P1}soc`]: 100, [`${P1}inputWatts`]: 564, [`${P1}outputWatts`]: 0 });
  assert.equal(pack().liveFlow?.inputWatts, 564, 'liveFlow shows the polled input (display fallback)');
  assert.equal(pack().streamInputW, undefined, 'the alarm copy does not');
  assert.equal(vdiffKneeChargeW(pack(), t), null);
  t += 5_000;
  s.mergeDeviceQuota(CORE, { [`${P1}inputWatts`]: 0 }, 'mqtt'); // the stream: charging stopped
  assert.deepEqual(pack().streamInputW, { w: 0, atMs: t });
  t += 40_000;
  s.setDeviceQuota(CORE, { [`${P1}soc`]: 100, [`${P1}inputWatts`]: 564, [`${P1}outputWatts`]: 0 }); // the replay
  assert.equal(pack().streamInputW!.w, 0, 'the REST replay never overwrites the stream\'s own value');
  assert.equal(vdiffKneeChargeW(pack(), t), 0);
  t += 10_000;
  // Only the OUTPUT is stream-fresh now: liveFlow copies the polled input (a display fallback)…
  s.setDeviceQuota(CORE, { [`${P1}soc`]: 100, [`${P1}inputWatts`]: 564, [`${P1}outputWatts`]: 0 });
  s.mergeDeviceQuota(CORE, { [`${P1}outputWatts`]: 0 }, 'mqtt');
  t += 110_000; // the stream's input is now 160 s old; its output 110 s
  s.setDeviceQuota(CORE, { [`${P1}soc`]: 100, [`${P1}inputWatts`]: 564, [`${P1}outputWatts`]: 0 });
  assert.equal(pack().liveFlow?.inputWatts, 564, 'liveFlow fell back to the polled input');
  assert.equal(vdiffKneeChargeW(pack(), t), null, '…which the knee never reads: the stream\'s own 0 W is now stale');
});

test('★★★ STREAM SILENT — a replayed 200 W cannot hold the critical past the last balancing + window', () => {
  // The MQTT stream for this Core goes silent (a msg-rate-floor collapse) as charging stops; the
  // REST poll keeps reporting the last non-zero 200 W. The BMS balanced until 23:55:31.
  const silent = () => ({ streamInputW: undefined, inputWatts: 200 });
  const ticks = replay(C3P2_0822, silent);
  const bal = lastBalancing(ticks)!;
  const first = ticks.find((k) => k.crit && k.crit.annunciate !== false);
  assert.ok(first, 'the real fault annunciates');
  assert.ok(first!.atMs <= bal.atMs + VDIFF_KNEE_RELAX_MS + TICK_MS,
    `${first!.hms}: later than the last balancing ${bal.hms} + VDIFF_KNEE_RELAX_MS`);
  // …and with the BMS idle throughout (the 118 mV trickle), a silent stream gives no grace at all.
  resetVdiffWarnHoldForTesting();
  const idle = replay(TRICKLE_118, silent);
  assert.notEqual(idle[0].crit!.annunciate, false, 'no stream, no balancing: immediate, as in v1.186.5');
});

test('★★ the knee state follows the PACK: a swapped pack does not inherit the grace', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  const a = tickAt(T0 + TICK_MS, { vd: 95, vmax: 3480, soc: 100, bal: 0, in: 0 }, { packSn: 'PACK-B' });
  assert.notEqual(a!.annunciate, false);
});

test('★★ a reading gap drops the evidence (never carried across blindness)', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  tickAt(T0 + TICK_MS, { vd: 95, vmax: 3490, soc: 100, bal: 0, in: 0 }, { maxVolDiffMv: null });
  const a = tickAt(T0 + 2 * TICK_MS, { vd: 95, vmax: 3480, soc: 100, bal: 0, in: 0 });
  assert.notEqual(a!.annunciate, false);
});

test('★★★ a reading gap does NOT restart the duration clock (offline blips cannot defer the bound)', () => {
  // A 110 mV spread the BMS keeps balancing at 99%, with a missed reading every 5 minutes (an
  // offline blip): the 20-minute bound still runs from the FIRST crossing.
  const v = { vd: 110, vmax: 3500, soc: 99, bal: 1, in: 0 };
  for (let dt = 0; dt < VDIFF_KNEE_MAX_MUTE_MS; dt += TICK_MS) {
    const gap = dt > 0 && dt % (5 * 60_000) === 0;
    const a = tickAt(T0 + dt, v, gap ? { maxVolDiffMv: null } : {});
    if (!gap) assert.equal(a!.annunciate, false, `+${dt / 1000}s: inside the bound, balancing mutes`);
  }
  const at = tickAt(T0 + VDIFF_KNEE_MAX_MUTE_MS, v);
  assert.notEqual(at!.annunciate, false, 'the gaps did not restart the 20-minute clock');
  assert.match(at!.detail, /First reached the critical line 20 minutes ago\./);
});

test('★ a gap longer than VDIFF_KNEE_GAP_CARRY_MS drops the old episode (a returning pack starts fresh)', () => {
  const v = { vd: 110, vmax: 3500, soc: 99, bal: 1, in: 0 };
  tickAt(T0, v);
  tickAt(T0 + TICK_MS, v, { maxVolDiffMv: null });
  tickAt(T0 + VDIFF_KNEE_GAP_CARRY_MS + 2 * TICK_MS, v, { maxVolDiffMv: null });
  const back = tickAt(T0 + VDIFF_KNEE_GAP_CARRY_MS + 3 * TICK_MS, v);
  assert.equal(back!.annunciate, false, 'balancing on return: a new episode, muted by balancing');
  assert.equal(back!.mutedBy, 'balancing');
});

test('★★ a spread that RELAXED under the line for VDIFF_KNEE_RELAX_MS starts a new episode', () => {
  // On the plateau below the top of charge (93%): a crossing while balancing, then 55-80 mV for
  // 25 minutes (intermittent PV), then a new burst to 92 mV while balancing — a new episode, not
  // "sustained for 20 minutes"; the balancing mute there is bounded by the episode alone.
  tickAt(T0, { vd: 95, vmax: 3490, soc: 93, bal: 1, in: 0 });
  for (let t = T0 + TICK_MS; t < T0 + 25 * 60_000; t += TICK_MS) {
    tickAt(t, { vd: 55 + Math.round(25 * Math.abs(Math.sin(t / 97_000))), vmax: 3460, soc: 93, bal: 0, in: 0 });
  }
  const a = tickAt(T0 + 25 * 60_000, { vd: 92, vmax: 3490, soc: 93, bal: 1, in: 0 });
  assert.equal(a!.annunciate, false, 'a fresh crossing while balancing');
  assert.equal(a!.mutedBy, 'balancing');
  assert.doesNotMatch(a!.detail, /First reached the critical line/);
});

test('★★ …at the TOP of charge the same shape annunciates: the balancing mute is bounded by the session, which the 55-80 mV readings never ended', () => {
  // The same shape at 99-100%: the episode clock restarts, but the session's first crossing was
  // 25 minutes ago and the pack never rested under 50 mV.
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  for (let t = T0 + TICK_MS; t < T0 + 25 * 60_000; t += TICK_MS) {
    tickAt(t, { vd: 55 + Math.round(25 * Math.abs(Math.sin(t / 97_000))), vmax: 3460, soc: 99, bal: 0, in: 0 });
  }
  const a = tickAt(T0 + 25 * 60_000, { vd: 92, vmax: 3490, soc: 100, bal: 1, in: 0 });
  assert.notEqual(a!.annunciate, false, 'balancing, but 25 minutes into the top-of-charge session');
  assert.match(a!.detail, /First reached the critical line at this top of charge 25 minutes ago\./);
});

test('★★ a dip under the line SHORTER than VDIFF_KNEE_RELAX_MS keeps the episode clock', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  const dipEnd = T0 + VDIFF_KNEE_RELAX_MS - TICK_MS;
  for (let t = T0 + TICK_MS; t < dipEnd; t += TICK_MS) tickAt(t, { vd: 70, vmax: 3470, soc: 100, bal: 1, in: 0 });
  for (let t = dipEnd; t < T0 + VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tickAt(t, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  const a = tickAt(T0 + VDIFF_KNEE_MAX_MUTE_MS, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  assert.notEqual(a!.annunciate, false, 'the 20-minute bound ran from the first crossing');
});

test('★ leaving the top of charge drops the activity evidence', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  tickAt(T0 + TICK_MS, { vd: 60, vmax: 3450, soc: 90, bal: 0, in: 0 });
  const a = tickAt(T0 + 2 * TICK_MS, { vd: 95, vmax: 3480, soc: 99, bal: 0, in: 0 });
  assert.notEqual(a!.annunciate, false);
});

/* ── 4. the pure state machine ────────────────────────────────────────────── */

test('advanceVdiffKnee / vdiffCritMute: order of the bounds', () => {
  const obs = (o: Partial<VdiffKneeObservation>): VdiffKneeObservation =>
    ({ packSn: 'P', packSoc: 100, spreadMv: 100, balancing: false, chargeW: 0, ...o });
  let s = advanceVdiffKnee(undefined, obs({ balancing: true }), 0);
  assert.equal(s.lastBalancingMs, 0);
  assert.equal(s.lastChargeMs, null);
  assert.equal(s.critSinceMs, 0);
  assert.equal(vdiffCritMute(s, obs({ balancing: true }), 0), 'balancing');
  assert.equal(vdiffCritMute(s, obs({ balancing: true, spreadMv: 150 }), 0), null, 'ceiling before balancing');
  assert.equal(vdiffCritMute(s, obs({ balancing: true }), VDIFF_KNEE_MAX_MUTE_MS), null, 'duration before balancing');
  s = advanceVdiffKnee(s, obs({}), 60_000);
  assert.equal(s.lastBalancingMs, 0, 'an idle tick keeps the last balancing');
  assert.equal(vdiffCritMute(s, obs({}), 60_000), 'end-of-charge');
  assert.equal(vdiffCritMute(s, obs({}), VDIFF_KNEE_RELAX_MS), null);
  assert.equal(vdiffCritMute(s, obs({ packSoc: 94 }), 60_000), null, 'the relaxation grace is top-of-charge only');
  // v1.187.1 (log review) — on the plateau one reading under VOL_DIFF_CRIT_MV does not end the
  // episode; an unbroken VDIFF_KNEE_RELAX_MS under the plateau line does.
  s = advanceVdiffKnee(s, obs({ spreadMv: 49 }), 120_000);
  assert.equal(s.critSinceMs, 0, 'one reading under VOL_DIFF_CRIT_MV: the episode stands');
  s = advanceVdiffKnee(s, obs({ spreadMv: 49 }), 120_000 + VDIFF_KNEE_RELAX_MS - 1);
  assert.equal(s.critSinceMs, 0, 'not a millisecond early');
  s = advanceVdiffKnee(s, obs({ spreadMv: 49 }), 120_000 + VDIFF_KNEE_RELAX_MS);
  assert.equal(s.critSinceMs, null, 'the episode ends after VDIFF_KNEE_RELAX_MS under the line');
  s = advanceVdiffKnee(s, obs({ packSoc: 80, spreadMv: 60 }), 180_000 + VDIFF_KNEE_RELAX_MS);
  assert.equal(s.lastBalancingMs, null, 'off the top the evidence is gone');
});

test('advanceVdiffKnee / vdiffCritMute: charge input is its own, narrower evidence', () => {
  const obs = (o: Partial<VdiffKneeObservation>): VdiffKneeObservation =>
    ({ packSn: 'P', packSoc: 99, spreadMv: 100, balancing: false, chargeW: 0, ...o });
  let s = advanceVdiffKnee(undefined, obs({ chargeW: 110 }), 0);
  assert.equal(s.lastChargeMs, 0);
  assert.equal(s.lastBalancingMs, null, 'charging never refreshes the balancing window');
  assert.equal(vdiffCritMute(s, obs({ chargeW: 110 }), 0), 'charging');
  for (let t = TICK_MS; t < VDIFF_KNEE_RELAX_MS; t += TICK_MS) s = advanceVdiffKnee(s, obs({ chargeW: 110 }), t);
  assert.equal(vdiffCritMute(s, obs({ chargeW: 110 }), VDIFF_KNEE_RELAX_MS - TICK_MS), 'charging');
  s = advanceVdiffKnee(s, obs({ chargeW: 110 }), VDIFF_KNEE_RELAX_MS);
  assert.equal(vdiffCritMute(s, obs({ chargeW: 110 }), VDIFF_KNEE_RELAX_MS), null,
    'still charging, but VDIFF_KNEE_RELAX_MS from the first crossing: annunciate');
  assert.equal(advanceVdiffKnee(undefined, obs({ chargeW: VDIFF_KNEE_CHARGE_W }), 0).lastChargeMs, null, 'the line is exclusive');
  assert.equal(advanceVdiffKnee(undefined, obs({ chargeW: 300, spreadMv: 19 }), 0).lastChargeMs, null, 'below the warn line');
  assert.equal(advanceVdiffKnee(undefined, obs({ chargeW: null }), 0).lastChargeMs, null, 'no stream value: no evidence');
});

/* ── 5. the top-of-charge SESSION bounds both graces (v1.187.0 log review) ───────────── */

/** Two readings alternating every `periodMs` (the BMS publishes cell voltages every ~180 s), on the
 *  20-second monitor tick. `hi` / `lo` are each a full reading. */
function alternating(
  start: number, spanMs: number, periodMs: number,
  hi: Record<Field, number>, lo: Record<Field, number>,
  gapAt?: (t: number) => boolean,
): Array<{ t: number; v: Record<Field, number>; crit?: Alert }> {
  const out: Array<{ t: number; v: Record<Field, number>; crit?: Alert }> = [];
  for (let t = 0; t <= spanMs; t += TICK_MS) {
    const v = Math.floor(t / periodMs) % 2 === 0 ? hi : lo;
    const gap = gapAt?.(t) ?? false;
    const crit = tickAt(start + t, v, gap ? { maxVolDiffMv: null } : {});
    if (!gap) out.push({ t, v, crit });
  }
  return out;
}

test('★★★ REAL FAULT — a spread that follows the charge current (95 / 45 mV on alternate readings, 97%, 600 W) is announced once the SESSION grace lapses', () => {
  // A high-resistance cell during an afternoon PV charge: the spread tracks the charge current,
  // and the BMS publishes about every 180 s. Every dip under 50 mV restarted the critical-line
  // clock, so each crossing earned a fresh 5-minute charging grace: in v1.187.0 as merged, 0 of
  // the critical ticks over 3 h annunciated. v1.186.5 annunciated every one (no balancing).
  const PERIOD = 180_000;
  const ticks = alternating(T0, 3 * 3_600_000, PERIOD,
    { vd: 95, vmax: 3490, soc: 97, bal: 0, in: 600 }, { vd: 45, vmax: 3440, soc: 97, bal: 0, in: 600 });
  const crits = ticks.filter((k) => k.crit);
  assert.ok(crits.length > 200, 'the fixture sits on the critical line for half the ticks');
  const first = crits.find((k) => k.crit!.annunciate !== false)!;
  assert.ok(first, 'the fault is announced');
  // The first critical reading at or past VDIFF_KNEE_RELAX_MS from the session's first crossing:
  // the grace covers the first reading only; the next 95 mV reading (t = 6 min) speaks.
  assert.equal(first.t, 2 * PERIOD);
  assert.ok(first.t <= VDIFF_KNEE_RELAX_MS + PERIOD, 'within one reading of the 5-minute bound');
  for (const k of crits.filter((x) => x.t < first.t)) {
    assert.ok(k.t < VDIFF_KNEE_RELAX_MS, `+${k.t / 1000}s: silent only inside the session's first 5 minutes`);
    assert.equal(k.crit!.mutedBy, 'charging');
  }
  for (const k of crits.filter((x) => x.t >= first.t)) {
    assert.notEqual(k.crit!.annunciate, false, `+${k.t / 1000}s: a later crossing earned a fresh grace`);
  }
});

test('★★★ REAL FAULT — the end-of-charge grace is bounded by the session too (100 mV idle / 45 mV balancing on alternate readings)', () => {
  // Balancing on for the low readings keeps "the last balancing" within 5 minutes of every high
  // reading, and each dip under 50 mV restarted the 20-minute duration bound: muted indefinitely.
  const PERIOD = 180_000;
  const ticks = alternating(T0, 2 * 3_600_000, PERIOD,
    { vd: 45, vmax: 3440, soc: 99, bal: 1, in: 0 }, { vd: 100, vmax: 3495, soc: 99, bal: 0, in: 0 });
  const crits = ticks.filter((k) => k.crit);
  const first = crits.find((k) => k.crit!.annunciate !== false)!;
  assert.ok(first, 'the fault is announced');
  const sessionFrom = crits[0].t; // the first crossing: t = 180 s
  assert.ok(first.t >= sessionFrom + VDIFF_KNEE_MAX_MUTE_MS - PERIOD, 'the end-of-charge grace still applies inside its bound');
  assert.ok(first.t <= sessionFrom + VDIFF_KNEE_MAX_MUTE_MS + 2 * PERIOD,
    `+${first.t / 1000}s: later than one reading past VDIFF_KNEE_MAX_MUTE_MS from the session's first crossing`);
  for (const k of crits.filter((x) => x.t < first.t)) assert.equal(k.crit!.mutedBy, 'end-of-charge');
  for (const k of crits.filter((x) => x.t >= first.t)) assert.notEqual(k.crit!.annunciate, false, `+${k.t / 1000}s`);
  // v1.187.1 — the 45 mV dips (one reading each) no longer end the critical-line episode either, so
  // its own 20-minute bound comes due on the same reading and names it.
  assert.match(first.crit!.detail, /First reached the critical line 20 minutes ago\./);
});

test('★★★ REAL FAULT — …and with dips long enough to end the episode (100 mV idle / 45 mV balancing ×2), the SESSION alone bounds the end-of-charge grace', () => {
  // Two 45 mV balancing readings (6 minutes under the line) end the critical-line episode, so every
  // 100 mV crossing starts a new one; the balancing on the low readings keeps the end-of-charge
  // window open at every crossing. Only the session (graceFromMs, never ended: no 20-minute rest
  // under 50 mV, no reading below 95%) bounds it.
  const PERIOD = 180_000;
  const out: Array<{ t: number; crit?: Alert }> = [];
  for (let t = 0; t <= 2 * 3_600_000; t += TICK_MS) {
    const hi = Math.floor(t / PERIOD) % 3 === 2; // balancing first: the knee's evidence
    out.push({ t, crit: tickAt(T0 + t, hi ? { vd: 100, vmax: 3495, soc: 99, bal: 0, in: 0 } : { vd: 45, vmax: 3440, soc: 99, bal: 1, in: 0 }) });
  }
  const crits = out.filter((k) => k.crit);
  const first = crits.find((k) => k.crit!.annunciate !== false)!;
  assert.ok(first, 'the fault is announced');
  const sessionFrom = crits[0].t; // the first crossing: t = 360 s
  assert.ok(first.t >= sessionFrom + VDIFF_KNEE_MAX_MUTE_MS && first.t <= sessionFrom + VDIFF_KNEE_MAX_MUTE_MS + 2 * PERIOD,
    `+${first.t / 1000}s: on the first crossing at or past 20 minutes from the session's first`);
  for (const k of crits.filter((x) => x.t < first.t)) assert.equal(k.crit!.mutedBy, 'end-of-charge');
  for (const k of crits.filter((x) => x.t >= first.t)) assert.notEqual(k.crit!.annunciate, false, `+${k.t / 1000}s`);
  assert.match(first.crit!.detail, /Did not relax at the top of charge\./, 'the episode clock restarted; the session bound spoke');
});

test('★★★ a reading gap during a sub-line reading does not re-grant the session grace', () => {
  // As the 95 / 45 fault, with the reading missed during the second (45 mV) period: no critical
  // episode is running then, and dropping the state would hand the next crossing a fresh grace.
  const PERIOD = 180_000;
  const ticks = alternating(T0, 20 * 60_000, PERIOD,
    { vd: 95, vmax: 3490, soc: 97, bal: 0, in: 600 }, { vd: 45, vmax: 3440, soc: 97, bal: 0, in: 600 },
    (t) => t >= PERIOD + 60_000 && t < PERIOD + 120_000);
  const first = ticks.find((k) => k.crit && k.crit.annunciate !== false)!;
  assert.equal(first.t, 2 * PERIOD, 'the next crossing speaks, gap or not');
});

test('★★ a NEW top-of-charge session re-earns its graces (the session ends when the pack reads below 95%)', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  tickAt(T0 + TICK_MS, { vd: 60, vmax: 3450, soc: 90, bal: 0, in: 0 }); // discharged below the top
  for (let t = T0 + 2 * TICK_MS; t < T0 + 30 * 60_000; t += 60_000) tickAt(t, { vd: 30, vmax: 3440, soc: 92, bal: 0, in: 0 });
  // Charged back up 30 minutes later: a fresh knee in a fresh session.
  tickAt(T0 + 30 * 60_000, { vd: 95, vmax: 3490, soc: 99, bal: 1, in: 200 });
  const a = tickAt(T0 + 31 * 60_000, { vd: 95, vmax: 3485, soc: 100, bal: 0, in: 0 });
  assert.equal(a!.annunciate, false);
  assert.equal(a!.mutedBy, 'end-of-charge');
});

test('★★ …while a SECOND knee in the same session, without a rest, annunciates past the session bound — balancing or not (fail loud)', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  assert.equal(tickAt(T0 + 60_000, { vd: 95, vmax: 3485, soc: 100, bal: 0, in: 0 })!.mutedBy, 'end-of-charge');
  // Relaxed at the top, but for less than the rest that ends a session (critSinceMs ends under 50 mV).
  for (let t = T0 + 2 * 60_000; t < T0 + 21 * 60_000; t += 60_000) tickAt(t, { vd: 30, vmax: 3440, soc: 99, bal: 0, in: 0 });
  const bal = tickAt(T0 + 21 * 60_000, { vd: 92, vmax: 3490, soc: 99, bal: 1, in: 0 });
  assert.notEqual(bal!.annunciate, false, 'the balancing mute is bounded by the session at the top of charge');
  assert.match(bal!.detail, /First reached the critical line at this top of charge 21 minutes ago\./);
  const after = tickAt(T0 + 22 * 60_000, { vd: 92, vmax: 3485, soc: 100, bal: 0, in: 0 });
  assert.notEqual(after!.annunciate, false, 'no second end-of-charge grace in one session');
});

test('★★★ a pack that has RESTED at the top of charge (20 minutes under 50 mV) starts a new session: two 09-29 Core 1 pack 1 knees 30 minutes apart are both silent', () => {
  // The recorder's C1P1 knee, the pack resting at 98% with a 10 mV spread, then the same knee
  // again. Ending the session only below 95% gave the second knee no grace: 7 of its 27 critical
  // ticks sounded the klaxon after balancing stopped.
  const first = replay(C1P1_0929);
  const endMs = first[first.length - 1].atMs;
  const restMs = 30 * 60_000;
  for (let t = endMs + TICK_MS; t < endMs + restMs; t += TICK_MS) tickAt(t, { vd: 10, vmax: 3350, soc: 98, bal: 0, in: 0 });
  const second = replay(C1P1_0929, () => ({}), endMs + restMs - first[0].atMs);
  for (const [name, ticks] of [['first', first], ['second', second]] as const) {
    const crits = ticks.filter((k) => k.crit);
    assert.ok(crits.length > 0, `${name}: the knee reaches the critical line`);
    for (const k of crits) assert.equal(k.crit!.annunciate, false, `${name} knee ${k.hms}: ${k.v.vd} mV must not sound (bal ${k.v.bal})`);
  }
  assert.ok(second.some((k) => k.crit?.mutedBy === 'end-of-charge'), 'the second knee earned its end-of-charge grace again');
});

test('★★★ REAL FAULT — a balancing spread on alternate readings (95 mV balancing / 45 mV, 97%, 600 W) is announced once the SESSION bound lapses', () => {
  // The balancing mute was bounded only by the episode clock, which restarts on every dip under
  // 50 mV: 0 of 271 critical ticks over 3 h annunciated, before this release and after the
  // session fix for the two graces.
  const PERIOD = 180_000;
  const ticks = alternating(T0, 3 * 3_600_000, PERIOD,
    { vd: 95, vmax: 3490, soc: 97, bal: 1, in: 600 }, { vd: 45, vmax: 3440, soc: 97, bal: 0, in: 600 });
  const crits = ticks.filter((k) => k.crit);
  assert.ok(crits.length > 200);
  const first = crits.find((k) => k.crit!.annunciate !== false)!;
  assert.ok(first, 'the fault is announced');
  assert.ok(first.t >= VDIFF_KNEE_MAX_MUTE_MS && first.t <= VDIFF_KNEE_MAX_MUTE_MS + 2 * PERIOD,
    `+${first.t / 1000}s: within one loud reading of 20 minutes from the session's first crossing`);
  for (const k of crits.filter((x) => x.t < first.t)) assert.equal(k.crit!.mutedBy, 'balancing');
  for (const k of crits.filter((x) => x.t >= first.t)) assert.notEqual(k.crit!.annunciate, false, `+${k.t / 1000}s`);
});

for (const [phase, hiFirst] of [['the high reading first', true], ['the low reading first', false]] as const) {
  test(`★★★ REAL FAULT — between 85% and 95% (no session runs there) a balancing spread alternating 95 / 45 mV is announced within VDIFF_KNEE_MAX_MUTE_MS of its first crossing (+ one reading) — ${phase}`, () => {
    // v1.187.1 (log review) — at 90% SoC the critical-line clock was the balancing mute's only
    // bound, and every 45 mV reading ended it: 0 of the critical ticks over 3 h annunciated. On the
    // plateau a reading under 50 mV no longer ends the episode; an unbroken VDIFF_KNEE_RELAX_MS
    // under the line does, which a spread that crosses on every other reading never has.
    const PERIOD = 180_000;
    const HI = { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 300 };
    const LO = { vd: 45, vmax: 3440, soc: 90, bal: 1, in: 300 };
    const ticks = alternating(T0, 3 * 3_600_000, PERIOD, hiFirst ? HI : LO, hiFirst ? LO : HI);
    const crits = ticks.filter((k) => k.crit);
    assert.ok(crits.length > 200, 'the fixture sits on the critical line for half the ticks');
    const firstCrossing = crits[0].t;
    assert.equal(firstCrossing, hiFirst ? 0 : PERIOD);
    const first = crits.find((k) => k.crit!.annunciate !== false)!;
    assert.ok(first, 'the fault is announced');
    assert.ok(first.t >= firstCrossing + VDIFF_KNEE_MAX_MUTE_MS, 'the balancing mute holds inside its bound');
    assert.ok(first.t <= firstCrossing + VDIFF_KNEE_MAX_MUTE_MS + PERIOD,
      `+${first.t / 1000}s: more than one reading past VDIFF_KNEE_MAX_MUTE_MS from the first crossing (+${firstCrossing / 1000}s)`);
    assert.match(first.crit!.detail, /First reached the critical line 20 minutes ago\./);
    for (const k of crits.filter((x) => x.t < first.t)) assert.equal(k.crit!.mutedBy, 'balancing');
    for (const k of crits.filter((x) => x.t >= first.t)) {
      assert.notEqual(k.crit!.annunciate, false, `+${k.t / 1000}s: a later crossing was muted again`);
    }
  });
}

test('★★ …while at 90% a spread that RELAXED under 50 mV for VDIFF_KNEE_RELAX_MS starts a new episode', () => {
  // A crossing while balancing, then 30 mV for 18 minutes, then a new crossing 21 minutes after the
  // first: a new episode (the clock ended 5 minutes into the run), not "first reached 21 minutes ago".
  for (let t = T0; t < T0 + 3 * 60_000; t += TICK_MS) tickAt(t, { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 0 });
  for (let t = T0 + 3 * 60_000; t < T0 + 21 * 60_000; t += TICK_MS) tickAt(t, { vd: 30, vmax: 3430, soc: 90, bal: 1, in: 0 });
  const a = tickAt(T0 + 21 * 60_000, { vd: 95, vmax: 3490, soc: 90, bal: 1, in: 0 });
  assert.equal(a!.mutedBy, 'balancing', 'a fresh episode after a relaxed run');
  assert.doesNotMatch(a!.detail, /First reached the critical line/);
});

test('advanceVdiffKnee: the session clock (graceFromMs) — start, carry, end', () => {
  const obs = (o: Partial<VdiffKneeObservation>): VdiffKneeObservation =>
    ({ packSn: 'P', packSoc: 99, spreadMv: 95, balancing: false, chargeW: 600, ...o });
  // Starts at the first crossing at the top of charge.
  let s = advanceVdiffKnee(undefined, obs({}), 0);
  assert.equal(s.graceFromMs, 0);
  // Survives a dip under 50 mV long enough to end the critical-line episode (v1.187.1: an unbroken
  // VDIFF_KNEE_RELAX_MS under the line), and the next crossing.
  s = advanceVdiffKnee(s, obs({ spreadMv: 45 }), 180_000);
  assert.equal(s.critSinceMs, 0, 'one dip does not end the episode');
  s = advanceVdiffKnee(s, obs({ spreadMv: 45 }), 180_000 + VDIFF_KNEE_RELAX_MS);
  assert.equal(s.critSinceMs, null);
  assert.equal(s.graceFromMs, 0);
  s = advanceVdiffKnee(s, obs({}), 540_000);
  assert.equal(s.critSinceMs, 540_000);
  assert.equal(s.graceFromMs, 0, 'the session keeps its first crossing');
  assert.equal(vdiffCritMute(s, obs({}), 540_000), null, 'charging: past the session bound');
  // An unknown SoC is not evidence the pack left the top (fail loud)…
  s = advanceVdiffKnee(s, obs({ packSoc: null, spreadMv: 45 }), 580_000);
  assert.equal(s.graceFromMs, 0);
  // …a reading below the top of charge is.
  s = advanceVdiffKnee(s, obs({ packSoc: 94, spreadMv: 45 }), 600_000);
  assert.equal(s.graceFromMs, null);
  // A crossing that BEGAN lower on the plateau (93%) starts the session from that crossing.
  let p = advanceVdiffKnee(undefined, obs({ packSoc: 93 }), 0);
  assert.equal(p.critSinceMs, 0);
  assert.equal(p.graceFromMs, null, 'not yet at the top of charge');
  assert.equal(vdiffCritMute(p, obs({ packSoc: 93 }), 0), null, 'below the top: no grace at all');
  p = advanceVdiffKnee(p, obs({ packSoc: 96 }), 180_000);
  assert.equal(p.graceFromMs, 0, "from the episode's own first crossing, not the tick it reached 95%");
  assert.equal(vdiffCritMute(p, obs({ packSoc: 96 }), 180_000), 'charging');
  p = advanceVdiffKnee(p, obs({ packSoc: 96 }), VDIFF_KNEE_RELAX_MS);
  assert.equal(vdiffCritMute(p, obs({ packSoc: 96 }), VDIFF_KNEE_RELAX_MS), null, '5 minutes from the first crossing');
  // A hand-built state with no session clock gets no grace.
  assert.equal(vdiffCritMute({ ...p, graceFromMs: null }, obs({ packSoc: 96 }), 60_000), null);
});

test('advanceVdiffKnee: a REST at the top of charge (quietSinceMs) ends the session; the balancing mute is session-bound there', () => {
  const obs = (o: Partial<VdiffKneeObservation>): VdiffKneeObservation =>
    ({ packSn: 'P', packSoc: 99, spreadMv: 95, balancing: true, chargeW: 0, ...o });
  let s = advanceVdiffKnee(undefined, obs({}), 0);
  assert.equal(s.graceFromMs, 0);
  assert.equal(s.quietSinceMs, null, 'at the line: not resting');
  // The rest starts on the first reading under 50 mV at the top of charge…
  s = advanceVdiffKnee(s, obs({ spreadMv: 30, balancing: false }), 60_000);
  assert.equal(s.quietSinceMs, 60_000);
  s = advanceVdiffKnee(s, obs({ spreadMv: 45, balancing: false }), 120_000);
  assert.equal(s.quietSinceMs, 60_000, 'kept while it stays under 50 mV');
  // …an unknown SoC neither starts nor breaks it…
  s = advanceVdiffKnee(s, obs({ packSoc: null, spreadMv: 20, balancing: false }), 180_000);
  assert.equal(s.quietSinceMs, 60_000);
  let fresh = advanceVdiffKnee(undefined, obs({ packSoc: null, spreadMv: 20, balancing: false }), 0);
  assert.equal(fresh.quietSinceMs, null, 'not started on an unknown SoC');
  // …a reading at 50 mV or more breaks it…
  const broken = advanceVdiffKnee(s, obs({ spreadMv: 50, balancing: false }), 240_000);
  assert.equal(broken.quietSinceMs, null);
  assert.equal(broken.graceFromMs, 0, 'the session stands');
  // …and an unbroken VDIFF_KNEE_MAX_MUTE_MS of it ends the session.
  s = advanceVdiffKnee(s, obs({ spreadMv: 10, balancing: false }), 60_000 + VDIFF_KNEE_MAX_MUTE_MS - 1);
  assert.equal(s.graceFromMs, 0, 'not a millisecond early');
  s = advanceVdiffKnee(s, obs({ spreadMv: 10, balancing: false }), 60_000 + VDIFF_KNEE_MAX_MUTE_MS);
  assert.equal(s.graceFromMs, null, 'rested: the session is over');
  // The next crossing starts a new session, with its graces.
  const t2 = 60_000 + VDIFF_KNEE_MAX_MUTE_MS + 60_000;
  s = advanceVdiffKnee(s, obs({}), t2);
  assert.equal(s.graceFromMs, t2);
  assert.equal(s.quietSinceMs, null);
  assert.equal(vdiffCritMute(s, obs({}), t2), 'balancing');
  // A reading below the top of charge clears the rest with the session.
  fresh = advanceVdiffKnee(undefined, obs({ spreadMv: 10, balancing: false }), 0);
  assert.equal(fresh.quietSinceMs, 0);
  assert.equal(advanceVdiffKnee(fresh, obs({ packSoc: 90, spreadMv: 10, balancing: false }), 60_000).quietSinceMs, null);
  // The balancing mute in a top-of-charge session lasts VDIFF_KNEE_MAX_MUTE_MS from the session's
  // first crossing, whatever the episode clock says (it restarted 10 minutes in, on a dip)…
  const late = { ...s, critSinceMs: t2 + 10 * 60_000 };
  assert.equal(vdiffCritMute(late, obs({}), t2 + VDIFF_KNEE_MAX_MUTE_MS - 1), 'balancing');
  assert.equal(vdiffCritMute(late, obs({}), t2 + VDIFF_KNEE_MAX_MUTE_MS), null, 'session-bound');
  assert.equal(vdiffCritMute(late, obs({ packSoc: null }), t2 + VDIFF_KNEE_MAX_MUTE_MS), null, 'an unknown SoC does not end the session (fail loud)');
  // …while below the top of charge (the reading ends the session) the episode clock alone bounds it.
  const below = advanceVdiffKnee(late, obs({ packSoc: 94 }), t2 + VDIFF_KNEE_MAX_MUTE_MS);
  assert.equal(below.graceFromMs, null);
  assert.equal(vdiffCritMute(below, obs({ packSoc: 94 }), t2 + VDIFF_KNEE_MAX_MUTE_MS), 'balancing', 'below the top: the episode bound only');
  assert.equal(vdiffCritMute(below, obs({ packSoc: 94 }), t2 + 10 * 60_000 + VDIFF_KNEE_MAX_MUTE_MS), null, 'which still applies');
});

test('★★ a rest must be SEEN unbroken: a reading gap during it restarts it (the session, and its bounds, stand)', () => {
  tickAt(T0, { vd: 95, vmax: 3490, soc: 100, bal: 1, in: 0 });
  assert.equal(tickAt(T0 + 60_000, { vd: 95, vmax: 3485, soc: 100, bal: 0, in: 0 })!.mutedBy, 'end-of-charge');
  for (let t = T0 + 2 * 60_000; t < T0 + 12 * 60_000; t += TICK_MS) tickAt(t, { vd: 30, vmax: 3440, soc: 99, bal: 0, in: 0 });
  // Ten minutes with no reading (the Core offline), then the rest resumes: 20 minutes by the clock
  // since it began, but only a minute of it seen since the gap.
  for (let t = T0 + 12 * 60_000; t < T0 + 22 * 60_000; t += TICK_MS) tickAt(t, { vd: 30, vmax: 3440, soc: 99, bal: 0, in: 0 }, { maxVolDiffMv: null });
  for (let t = T0 + 22 * 60_000; t < T0 + 23 * 60_000; t += TICK_MS) tickAt(t, { vd: 30, vmax: 3440, soc: 99, bal: 0, in: 0 });
  const knee = tickAt(T0 + 23 * 60_000, { vd: 92, vmax: 3490, soc: 100, bal: 1, in: 0 });
  assert.notEqual(knee!.annunciate, false, 'the session still runs: 23 minutes past its first crossing');
});
