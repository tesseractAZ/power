import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.187.21 — a peer cell-spread outlier at WARNING is pushed and carded, never announced.
 *
 * 2026-10-12, Core 2, an evening discharge at 59-65% SoC (about 220 W out of each pack, no
 * input): pack 4's cell spread climbed from 11 to 26 mV between 18:12 and 18:47 while its four
 * siblings held at 2-5 mV until about 18:33. Its peer outlier was raised at 18:21:59 (17 mV
 * against a sibling median of 4 mV, z 4.5, info), became a warning as the spread passed 20 mV,
 * and at 18:31:59 — ten minutes after its onset, the cell-imbalance speak hold — it spoke a
 * yellow on the house speakers. It was the only speakable alert live: the same pack's own
 * vdiff-warn rose at 18:36:59 with audible:false (push-only since v1.187.12).
 *
 * Both alerts describe one physical signal, and the warning-level spread is push-only. The peer
 * outlier at warning now carries audible:false: card and push unchanged (annunciate untouched),
 * never counted toward or voiced by the broadcast condition. The critical line (vdiff-crit) still
 * sounds, and the other peer metrics (thermal, SoC, SoH) still speak at warning.
 *
 * The replay below is the recorder's rows for all five Core 2 packs, 18:12-18:50 (pack*_vol_diff_mv
 * and pack*_soc, value changes only), through the same-tick pipeline: computeAlerts +
 * computeLearnedAlerts → the broadcast tick's speakableAlerts (with the 10-minute onset hold) →
 * conditionFromAlerts, on the alert monitor's 20 s tick.
 * =================================================================== */

const tmp = mkdtempSync(join(tmpdir(), 'ef-peer-spread-pushed-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');

const { computeAlerts, resetVdiffWarnHoldForTesting } = await import('../src/alerts.js');
const { computeLearnedAlerts, _resetPeerHitCounts } = await import('../src/analytics.js');
const { conditionFromAlerts, speakableAlerts, IMBALANCE_SPEAK_HOLD_MS } = await import('../src/broadcast.js');
const { buildAlertMessage } = await import('../src/ttsService.js');
const { risingEdgePushes, shouldDemoteAnnunciation, shouldSendResolve } = await import('../src/alertMonitor.js');

type Field = 'vd' | 'soc';
/** `HH:MM:SS=value` rows, 2026-10-12 (MST, UTC-7); each pack's first row is its value at 18:12. */
const CORE2_1012: Record<number, Record<Field, string>> = {
  1: {
    vd: '18:12:00=4 18:16:56=3 18:19:55=4 18:25:56=2 18:28:56=3 18:34:56=5 18:37:56=6 18:40:56=10 18:46:57=13 18:49:57=12',
    soc: '18:12:00=63 18:15:19=64 18:15:29=63 18:16:19=64 18:16:30=63 18:28:56=62 18:40:56=61',
  },
  2: {
    vd: '18:12:00=4 18:17:42=5 18:23:32=4 18:26:32=5 18:32:32=7 18:35:32=8 18:41:33=11 18:44:33=13 18:47:33=14',
    soc: '18:12:00=61 18:29:20=60 18:42:21=59 18:43:18=60 18:43:29=59 18:44:18=60 18:44:29=59',
  },
  3: {
    vd: '18:12:00=5 18:21:07=4 18:24:07=5 18:27:07=4 18:30:08=5 18:33:08=6 18:36:08=7 18:42:09=10 18:48:09=11',
    soc: '18:12:00=63 18:17:20=62 18:35:21=61',
  },
  4: {
    vd: '18:12:00=11 18:15:43=12 18:18:43=14 18:21:43=17 18:24:43=18 18:27:43=20 18:30:44=22 18:33:44=23 18:36:44=24 18:42:44=26',
    soc: '18:12:00=65 18:17:20=64 18:18:19=65 18:18:29=64 18:35:21=63 18:36:18=64 18:36:29=63',
  },
  5: {
    vd: '18:12:00=3 18:16:20=4 18:22:20=5 18:25:20=4 18:28:19=5 18:34:20=7 18:40:20=9 18:43:20=11 18:46:20=12 18:49:20=13',
    soc: '18:12:00=63 18:31:19=62 18:49:20=61',
  },
};

const SN = 'COREXXX00XXX0002';
const PEER = `peer-voldiff-${SN}-4`;
const VWARN = `vdiff-warn-${SN}-4`;
const VCRIT = `vdiff-crit-${SN}-4`;
const TICK_MS = 20_000;
const at = (hms: string) => Date.parse(`2026-10-12T${hms}-07:00`);
const hmsOf = (t: number) => new Date(t - 7 * 3_600_000).toISOString().slice(11, 19);
/** The wall clock computeAlerts reads, pinned per tick (mocked in beforeEach). */
let clock = 0;

interface Ev { atMs: number; pack: number; field: Field; value: number }
const EVENTS: Ev[] = Object.entries(CORE2_1012).flatMap(([pack, fields]) =>
  (Object.entries(fields) as Array<[Field, string]>).flatMap(([field, rows]) =>
    rows.split(' ').map((row) => {
      const [hms, v] = row.split('=');
      return { atMs: at(hms), pack: Number(pack), field, value: Number(v) };
    }))).sort((a, b) => a.atMs - b.atMs);

type PackVals = Record<Field, number> & { temp?: number; soh?: number };
/** A discharging Core: no input, ~220 W out of each pack, BMS idle, mid-SoC cell voltages. */
function core(vals: Record<number, PackVals>): Record<string, DeviceSnapshot> {
  const packs = Object.entries(vals).map(([num, v]) => ({
    num: Number(num), soc: v.soc, packSn: `PACK-${num}`, inputWatts: 0, outputWatts: 220,
    streamInputW: { w: 0, atMs: clock },
    maxVolDiffMv: v.vd, maxCellVoltageMv: 3300, minCellVoltageMv: 3300 - v.vd,
    balanceState: 0, cellVoltagesMv: [], temp: v.temp ?? 30, maxCellTemp: v.temp ?? 30,
    soh: v.soh ?? 100, actSoh: v.soh ?? 100,
  }));
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 2', productName: 'Delta Pro Ultra', online: true, lastUpdated: clock,
      projection: {
        kind: 'dpu', soc: 63, packs,
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 1100, totalInWatts: 0, totalOutWatts: 1100,
        batVol: 52, batAmp: -20, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}

interface Step { t: number; hms: string; level: string; spoken: Alert[]; all: Alert[] }
/**
 * Replay 18:12:00 → 18:50:00 on the 20 s tick. `strip` = remove the peer outlier's audible flag
 * before the broadcast filters (the control: the outlier as v1.187.20 raised it below the
 * top-of-charge line).
 */
function replay(strip = false): Step[] {
  const vals: Record<number, PackVals> = { 1: {} as PackVals, 2: {} as PackVals, 3: {} as PackVals, 4: {} as PackVals, 5: {} as PackVals };
  const onset = new Map<string, number>(); // alertOnset: first tick present, dropped on absence
  const out: Step[] = [];
  let i = 0;
  for (let t = at('18:12:00'); t <= at('18:50:00'); t += TICK_MS) {
    while (i < EVENTS.length && EVENTS[i].atMs <= t) { vals[EVENTS[i].pack][EVENTS[i].field] = EVENTS[i].value; i++; }
    clock = t;
    const devices = core(vals);
    const raw = [...computeAlerts(devices), ...computeLearnedAlerts(devices)];
    const all = strip ? raw.map((a) => (a.id === PEER ? { ...a, audible: undefined } : a)) : raw;
    const ids = new Set(all.map((a) => a.id));
    for (const id of [...onset.keys()]) if (!ids.has(id)) onset.delete(id);
    for (const id of ids) if (!onset.has(id)) onset.set(id, t);
    const spoken = speakableAlerts(all, t, (id) => onset.get(id));
    out.push({ t, hms: hmsOf(t), level: conditionFromAlerts(spoken).level, spoken, all });
  }
  return out;
}
const find = (s: Step, id: string) => s.all.find((a) => a.id === id);

beforeEach(() => {
  resetVdiffWarnHoldForTesting();
  _resetPeerHitCounts();
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());

test('★★★ 2026-10-12 Core 2, 18:12-18:50: the pack 4 peer outlier is a pushed WARNING card, and nothing is spoken', () => {
  const steps = replay();
  const first = steps.find((s) => find(s, PEER));
  assert.equal(first?.hms, '18:22:00', 'raised at the 18:21:59 tick, as on the day');
  assert.equal(find(first!, PEER)!.severity, 'info', 'at 17 mV against a 4 mV median it is still info (z 4.5)');
  const warned = steps.filter((s) => find(s, PEER)?.severity === 'warning');
  assert.ok(warned.length > 0, 'the fixture reaches the warning that spoke');
  assert.equal(warned[0].hms, '18:28:00', 'a warning once the spread reads 20 mV (z 5.6)');
  for (const s of warned) {
    const a = find(s, PEER)!;
    assert.equal(a.audible, false, `${s.hms}: never voiced`);
    assert.notEqual(a.annunciate, false, `${s.hms}: annunciate untouched — the push is owed`);
    assert.equal(risingEdgePushes(a), true);
    assert.match(a.detail, /Cell-spread warnings are pushed, not announced; a cell imbalance at the critical line is announced\./);
    assert.ok((find(s, PEER)!.facts ?? []).some((f) => f.label === 'Peer z-score'), 'the card keeps its facts');
  }
  for (const s of steps) {
    assert.equal(s.level, 'green', `${s.hms}: ${s.spoken.filter((a) => a.severity !== 'info').map((a) => a.id).join(', ')}`);
  }
  // The same pack's own warning rose at 18:36:59 on the day; it is push-only too (v1.187.12).
  const vwarn = steps.find((s) => find(s, VWARN));
  assert.equal(vwarn?.hms, '18:37:00');
  assert.equal(find(vwarn!, VWARN)!.audible, false);
  assert.equal(steps.some((s) => find(s, VCRIT)), false, 'the spread never reaches the critical line (50 mV off the plateau)');
});

test('★★★ the replay exercises the defect: with the outlier\'s audible flag stripped it speaks the 18:31:59 yellow', () => {
  const steps = replay(true);
  const yellow = steps.filter((s) => s.level === 'yellow');
  assert.ok(yellow.length > 0, 'the v1.187.20 shape below the top-of-charge line raises yellow');
  assert.equal(yellow[0].hms, '18:32:00', 'ten minutes after the 18:22:00 onset (the speak hold), as on the day');
  for (const s of yellow) {
    assert.deepEqual(s.spoken.filter((a) => a.severity === 'warning').map((a) => a.id), [PEER], `${s.hms}: the only speakable warning`);
  }
  assert.match(buildAlertMessage('yellow', yellow[0].spoken), /core two pack four/i, 'and it is the alert named aloud');
});

test('★★★ the push path is unchanged: owed on the rising edge, not demoted, and its Resolved push is owed', () => {
  const s = replay().find((x) => find(x, PEER)?.severity === 'warning')!;
  const a = find(s, PEER)!;
  assert.equal(risingEdgePushes(a), true);
  assert.equal(shouldDemoteAnnunciation(a, []), false, 'a home Core is not demoted for being quiet on the speakers');
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', alert: a }, true, 'warning'), true);
});

/* ── the critical line, and the other peer metrics (scope) ─────────────────────── */

/** One tick of the 18:30 shape with pack 4 replaced; enough ticks for the peer emit gate. */
function tick(pack4: Partial<PackVals>, n = 3): Alert[] {
  const base: Record<number, PackVals> = {
    1: { vd: 3, soc: 62 }, 2: { vd: 5, soc: 60 }, 3: { vd: 5, soc: 62 }, 4: { vd: 22, soc: 64, ...pack4 }, 5: { vd: 5, soc: 63 },
  };
  let out: Alert[] = [];
  for (let k = 0; k < n; k++) {
    clock = at('18:30:00') + k * TICK_MS;
    const devices = core(base);
    out = [...computeAlerts(devices), ...computeLearnedAlerts(devices)];
  }
  return out;
}
const pastHold = (t: number) => () => t - IMBALANCE_SPEAK_HOLD_MS - 60_000;

test('★★★ vdiff-crit for the same pack is still announced: a red, named aloud, while the peer outlier stays quiet', () => {
  const out = tick({ vd: 52 });
  const crit = out.find((a) => a.id === VCRIT);
  assert.ok(crit, '52 mV at 64% SoC is past the 50 mV critical line');
  assert.equal(crit!.severity, 'critical');
  assert.notEqual(crit!.annunciate, false, 'not muted: the BMS is idle, no charge, off the plateau');
  assert.notEqual(crit!.audible, false);
  const peer = out.find((a) => a.id === PEER);
  assert.equal(peer?.severity, 'warning');
  assert.equal(peer!.audible, false, 'the outlier is push-only at the critical line too');
  const spoken = speakableAlerts(out, clock, pastHold(clock));
  assert.ok(spoken.some((a) => a.id === VCRIT), 'the critical reaches the spoken array');
  assert.ok(!spoken.some((a) => a.id === PEER));
  assert.equal(conditionFromAlerts(spoken).level, 'red');
  assert.match(buildAlertMessage('red', spoken), /pack four/i, 'the red names the pack');
});

test('★★★ scope: a THERMAL peer warning on the same pack is still announced', () => {
  const out = tick({ vd: 5, temp: 45 }); // 113 °F against siblings at 86 °F; spreads all quiet
  const t = out.find((a) => a.id === `peer-temp-${SN}-4`);
  assert.equal(t?.severity, 'warning');
  assert.equal(t!.audible, undefined, 'audible:false is for the cell spread only');
  assert.doesNotMatch(t!.detail, /pushed, not announced/);
  const spoken = speakableAlerts(out, clock, pastHold(clock));
  assert.ok(spoken.some((a) => a.id === t!.id));
  assert.equal(conditionFromAlerts(spoken).level, 'yellow');
});

test('★★ scope: SoC and SoH peer warnings keep their voice', () => {
  const soh = tick({ vd: 5, soh: 85 }).find((a) => a.id === `peer-soh-${SN}-4`);
  assert.equal(soh?.severity, 'warning');
  assert.equal(soh!.audible, undefined);
  _resetPeerHitCounts();
  const soc = tick({ vd: 5, soc: 30 }).find((a) => a.id === `peer-soc-${SN}-4`);
  assert.equal(soc?.severity, 'warning');
  assert.equal(soc!.audible, undefined);
});

test('★★ an INFO cell-spread outlier is unchanged (no flag, no sentence); the LOW side keeps its v1.187.1 rule', () => {
  const info = tick({ vd: 17 }).find((a) => a.id === PEER);
  assert.equal(info?.severity, 'info');
  assert.equal(info!.audible, undefined);
  assert.equal(info!.annunciate, undefined);
  assert.doesNotMatch(info!.detail, /pushed, not announced/);
  _resetPeerHitCounts();
  // Pack 4 relaxed to 4 mV while its siblings stand at 30-33 mV: the healthy direction.
  const lowSet: Record<number, PackVals> = {
    1: { vd: 30, soc: 62 }, 2: { vd: 31, soc: 60 }, 3: { vd: 32, soc: 62 }, 4: { vd: 4, soc: 64 }, 5: { vd: 33, soc: 63 },
  };
  let out: Alert[] = [];
  for (let k = 0; k < 3; k++) out = computeLearnedAlerts(core(lowSet));
  const low = out.find((a) => a.id === PEER);
  assert.equal(low?.severity, 'info');
  assert.equal(low!.annunciate, false, 'not pushed, not spoken');
  assert.equal(low!.audible, undefined);
  assert.doesNotMatch(low!.detail, /pushed, not announced/);
});
