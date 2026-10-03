/**
 * v1.187.2 — the knee SESSION runs across the whole plateau (85-100% SoC), not from the top of
 * charge (95%) only.
 *
 * Between VOL_DIFF_PLATEAU_SOC_PCT (85%) and the 95% quiet line no session clock (graceFromMs) ran,
 * so the critical-line clock (critSinceMs) was the balancing mute's only bound there. v1.187.1 kept
 * that clock through dips under the plateau line SHORTER than VDIFF_KNEE_RELAX_MS, but a dip of
 * VDIFF_KNEE_RELAX_MS or more ends it, and the next crossing started a new 20-minute bound. A
 * balancing spread that rises and falls with the charge current on a ~180 s BMS cadence — 95 / 45 /
 * 45 mV, 95 / 45 mV with one reading missed, or 95 / 70 / 70 mV — restarted the bound on every
 * crossing and was never announced. At 95% or more the session bounds the same shapes at 20 minutes
 * from the first crossing. The session now starts on the plateau, the rest that ends it (an unbroken
 * VDIFF_KNEE_MAX_MUTE_MS of readings under 50 mV) runs there too, and a reading below the plateau
 * ends it.
 *
 * Each tick is computeAlerts on the monitor's 20-second cadence, the wall clock pinned to it.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAlerts, resetVdiffWarnHoldForTesting, advanceVdiffKnee, vdiffCritMute, VDIFF_KNEE_MAX_MUTE_MS,
  VDIFF_KNEE_RELAX_MS, type Alert, type VdiffKneeObservation,
} from '../src/alerts.js';
import { VOL_DIFF_PLATEAU_SOC_PCT, VOL_DIFF_PLATEAU_QUIET_SOC_PCT } from '../src/cellSpread.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const SN = 'DPU-A';
const CRIT_ID = `vdiff-crit-${SN}-1`;
const TICK_MS = 20_000;
const MIN = 60_000;
/** The BMS publishes cell voltages every ~180 s. */
const READING_MS = 180_000;
const T0 = Date.parse('2026-09-30T13:00:00-07:00');
let clock = 0;

interface Reading { vd: number; soc: number | null; bal: 0 | 1; in: number }
function device(r: Reading): Record<string, DeviceSnapshot> {
  const pack = {
    num: 1, soc: r.soc, packSn: 'COREXXX00XXX0001', inputWatts: r.in, outputWatts: 0,
    streamInputW: { w: r.in, atMs: clock },
    maxVolDiffMv: r.vd, maxCellVoltageMv: 3400 + r.vd, minCellVoltageMv: 3400,
    balanceState: r.bal, cellVoltagesMv: [],
  };
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 9', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: r.soc, packs: [pack],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}
function tick(atMs: number, r: Reading): Alert | undefined {
  clock = atMs;
  return computeAlerts(device(r)).find((a) => a.id === CRIT_ID);
}
/** Replay a reading sequence (one entry per ~180 s BMS reading, repeated) on the 20 s tick. */
function replayReadings(pattern: Reading[], spanMs: number, start = T0): Array<{ t: number; r: Reading; crit?: Alert }> {
  const out: Array<{ t: number; r: Reading; crit?: Alert }> = [];
  for (let t = 0; t <= spanMs; t += TICK_MS) {
    const r = pattern[Math.floor(t / READING_MS) % pattern.length];
    out.push({ t, r, crit: tick(start + t, r) });
  }
  return out;
}

beforeEach(() => {
  resetVdiffWarnHoldForTesting();
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());

/** The bound every shape below must meet: silent ('balancing') before VDIFF_KNEE_MAX_MUTE_MS from
 *  the first crossing, announced on the first critical tick at or past it — at most one reading
 *  later — and on every critical tick after it. Returns the first loud tick. */
function assertSessionBound(ticks: Array<{ t: number; crit?: Alert }>, label: string): { t: number; crit?: Alert } {
  const crits = ticks.filter((k) => k.crit);
  assert.ok(crits.length > 50, `${label}: the fixture reaches the critical line`);
  const firstCrossing = crits[0].t;
  const first = crits.find((k) => k.crit!.annunciate !== false);
  assert.ok(first, `${label}: the fault is announced`);
  assert.ok(first.t >= firstCrossing + VDIFF_KNEE_MAX_MUTE_MS, `${label}: the balancing mute holds inside its bound`);
  assert.ok(first.t <= firstCrossing + VDIFF_KNEE_MAX_MUTE_MS + READING_MS,
    `${label}: +${first.t / 1000}s — more than one reading past VDIFF_KNEE_MAX_MUTE_MS from the first crossing (+${firstCrossing / 1000}s)`);
  for (const k of crits.filter((x) => x.t < first.t)) assert.equal(k.crit!.mutedBy, 'balancing', `${label}: +${k.t / 1000}s`);
  for (const k of crits.filter((x) => x.t >= first.t)) {
    assert.notEqual(k.crit!.annunciate, false, `${label}: +${k.t / 1000}s — a later crossing was muted again`);
  }
  return first;
}

/* ── the shapes v1.187.1 never announced between 85% and 95% ─────────────────────────────── */

for (const soc of [85, 90, 94]) {
  for (const phase of [0, 1, 2]) {
    test(`★★★ REAL FAULT — hi / lo / lo at ${soc}% (95 / 45 / 45 mV, balancing, ~180 s readings; phase ${phase}) is announced within VDIFF_KNEE_MAX_MUTE_MS of its first crossing + one reading`, () => {
      // Each pair of 45 mV readings is 6 minutes under the line: the episode clock ends on every one
      // (VDIFF_KNEE_RELAX_MS), so v1.187.1 restarted the 20-minute bound on every crossing — 0
      // critical ticks loud over 3 hours. The session, started by the first crossing, never rests
      // (one high reading in three) and bounds it.
      const HI: Reading = { vd: 95, soc, bal: 1, in: 300 };
      const LO: Reading = { vd: 45, soc, bal: 1, in: 300 };
      const pattern = [HI, LO, LO];
      const ticks = replayReadings([...pattern.slice(phase), ...pattern.slice(0, phase)], 3 * 60 * MIN);
      const first = assertSessionBound(ticks, `${soc}% phase ${phase}`);
      assert.match(first.crit!.detail, /First reached the critical line above 85% charge 20 minutes ago\./,
        'the session bound spoke (the episode clock restarted on the last crossing)');
    });
  }
}

test('★★★ REAL FAULT — 95 / 45 mV at 90% with a missed BMS reading every other cycle is announced within VDIFF_KNEE_MAX_MUTE_MS + one reading', () => {
  // hi lo hi lo lo: the missed reading holds 45 mV for 6 minutes, which ends the episode clock every
  // 15 minutes — before its 20-minute bound — so v1.187.1 never announced it.
  const HI: Reading = { vd: 95, soc: 90, bal: 1, in: 300 };
  const LO: Reading = { vd: 45, soc: 90, bal: 1, in: 300 };
  const first = assertSessionBound(replayReadings([HI, LO, HI, LO, LO], 3 * 60 * MIN), 'missed reading');
  assert.equal(first.t, 7 * READING_MS, 'the first crossing at or past 20 minutes: the reading at 21 minutes');
});

test('★★★ REAL FAULT — hi / 70 / 70 at 90% (95 mV balancing, 70 mV between) is announced within VDIFF_KNEE_MAX_MUTE_MS + one reading', () => {
  // 70 mV is under the plateau line (90) but never under 50 mV: the episode clock ends after 5 minutes
  // under the line on every cycle, and no rest ever starts, so the session stands.
  const HI: Reading = { vd: 95, soc: 90, bal: 1, in: 300 };
  const MID: Reading = { vd: 70, soc: 90, bal: 1, in: 300 };
  const first = assertSessionBound(replayReadings([HI, MID, MID], 3 * 60 * MIN), 'hi / 70 / 70');
  assert.equal(first.t, 20 * MIN, 'the bound is 20 minutes (a literal: the helper reads the constant)');
  assert.match(first.crit!.detail, /First reached the critical line above 85% charge 20 minutes ago\./);
});

test('★★ …the same hi / lo / lo at 97% is bounded alike (the top-of-charge session, unchanged)', () => {
  const HI: Reading = { vd: 95, soc: 97, bal: 1, in: 300 };
  const LO: Reading = { vd: 45, soc: 97, bal: 1, in: 300 };
  const first = assertSessionBound(replayReadings([HI, LO, LO], 3 * 60 * MIN), '97%');
  assert.match(first.crit!.detail, /First reached the critical line at this top of charge 20 minutes ago\./);
});

test('★★ a session that rises from the plateau to the top of charge keeps its first crossing (hi / lo / lo from 90% to 97%)', () => {
  // The pack charges through 95% part-way: one session, bounded from its first crossing at 90%.
  const ticks: Array<{ t: number; crit?: Alert }> = [];
  for (let t = 0; t <= 60 * MIN; t += TICK_MS) {
    const soc = t < 12 * MIN ? 90 : 97;
    const hi = Math.floor(t / READING_MS) % 3 === 0;
    ticks.push({ t, crit: tick(T0 + t, { vd: hi ? 95 : 45, soc, bal: 1, in: 300 }) });
  }
  const first = assertSessionBound(ticks, '90% → 97%');
  assert.equal(first.t, VDIFF_KNEE_MAX_MUTE_MS);
  assert.match(first.crit!.detail, /First reached the critical line at this top of charge 20 minutes ago\./);
});

test('★ the note follows the reading: "at this top of charge" from exactly 95%, "above 85% charge" below it and with no SoC', () => {
  // A crossing at 90%, then 60 mV for 10 minutes (the episode ends; no rest), then the spread back
  // at the line while balancing 25 minutes after the first crossing, read at 95%, at 94% and with no
  // SoC (pack and Core): the session bound speaks each time.
  for (const [soc, where] of [[95, 'at this top of charge'], [94, 'above 85% charge'], [null, 'above 85% charge']] as const) {
    resetVdiffWarnHoldForTesting();
    tick(T0, { vd: 95, soc: 90, bal: 1, in: 300 });
    for (let t = TICK_MS; t < 25 * MIN; t += TICK_MS) tick(T0 + t, { vd: 60, soc: 90, bal: 0, in: 300 });
    const a = tick(T0 + 25 * MIN, { vd: 95, soc, bal: 1, in: 300 })!;
    assert.notEqual(a.annunciate, false, `SoC ${soc}`);
    assert.match(a.detail, new RegExp(`First reached the critical line ${where} 25 minutes ago\\.`), `SoC ${soc}`);
  }
});

/* ── what still ends a session on the plateau ────────────────────────────────────────────── */

test('★★★ a benign crossing on the plateau that RESTS under 50 mV for 20 minutes leaves the next crossing its full mute', () => {
  // Two balancing crossings at 90%, each relaxing to 10-30 mV for 25 minutes: each starts its own
  // session, and each is silent.
  for (let k = 0; k < 2; k++) {
    const at = T0 + k * 30 * MIN;
    for (let t = 0; t < 3 * MIN; t += TICK_MS) {
      const a = tick(at + t, { vd: 95, soc: 90, bal: 1, in: 300 })!;
      assert.equal(a.mutedBy, 'balancing', `crossing ${k + 1}, +${t / 1000}s`);
    }
    for (let t = 3 * MIN; t < 30 * MIN; t += TICK_MS) assert.equal(tick(at + t, { vd: 20, soc: 90, bal: 0, in: 0 }), undefined);
  }
});

test('★★★ a reading below the plateau ends the session; a reading at 85% does not', () => {
  // A crossing at 90%, then 60 mV (no rest, under the line) for 25 minutes with one reading at
  // `dip` SoC part-way, then a balancing crossing at 90% again.
  for (const [dip, fresh] of [[VOL_DIFF_PLATEAU_SOC_PCT - 1, true], [VOL_DIFF_PLATEAU_SOC_PCT, false]] as const) {
    resetVdiffWarnHoldForTesting();
    tick(T0, { vd: 95, soc: 90, bal: 1, in: 300 });
    for (let t = TICK_MS; t < 25 * MIN; t += TICK_MS) {
      tick(T0 + t, { vd: 60, soc: t === 10 * MIN ? dip : 90, bal: 0, in: 300 });
    }
    const a = tick(T0 + 25 * MIN, { vd: 95, soc: 90, bal: 1, in: 300 })!;
    if (fresh) assert.equal(a.mutedBy, 'balancing', `read at ${dip}%: a new session`);
    else {
      assert.notEqual(a.annunciate, false, `read at ${dip}%: the session stands, 25 minutes old`);
      assert.match(a.detail, /First reached the critical line above 85% charge 25 minutes ago\./);
    }
  }
});

test('★★ a session begun on the plateau bounds the top-of-charge graces from its first crossing (fail loud)', () => {
  // A balancing crossing at 90%, then 60 mV at 92% for 10 minutes (the episode ends; no rest), then
  // the pack reaches 97% on a 600 W charge at 95 mV. Until v1.187.2 that crossing opened a fresh
  // top-of-charge session with a 5-minute charging grace; it is now the same session, 13 minutes old:
  // a second knee without a rest, announced at once.
  tick(T0, { vd: 95, soc: 90, bal: 1, in: 300 });
  for (let t = TICK_MS; t < 13 * MIN; t += TICK_MS) tick(T0 + t, { vd: 60, soc: 92, bal: 0, in: 300 });
  const a = tick(T0 + 13 * MIN, { vd: 95, soc: 97, bal: 0, in: 600 })!;
  assert.notEqual(a.annunciate, false);
  assert.equal(a.mutedBy, undefined);
});

/* ── the pure state machine ──────────────────────────────────────────────────────────────── */

test('advanceVdiffKnee (v1.187.2): the session and the rest on the plateau; the balancing bound below the top of charge', () => {
  const obs = (o: Partial<VdiffKneeObservation>): VdiffKneeObservation =>
    ({ packSn: 'P', packSoc: 90, spreadMv: 95, balancing: true, chargeW: null, ...o });
  // The session starts on the first crossing on the plateau (85% included), not below it.
  assert.equal(advanceVdiffKnee(undefined, obs({ packSoc: VOL_DIFF_PLATEAU_SOC_PCT }), 0).graceFromMs, 0);
  assert.equal(advanceVdiffKnee(undefined, obs({ packSoc: VOL_DIFF_PLATEAU_SOC_PCT - 1 }), 0).graceFromMs, null);
  assert.ok(VOL_DIFF_PLATEAU_SOC_PCT < VOL_DIFF_PLATEAU_QUIET_SOC_PCT);
  // A dip of VDIFF_KNEE_RELAX_MS ends the episode, never the session…
  let s = advanceVdiffKnee(undefined, obs({}), 0);
  s = advanceVdiffKnee(s, obs({ spreadMv: 45 }), READING_MS);
  s = advanceVdiffKnee(s, obs({ spreadMv: 45 }), READING_MS + VDIFF_KNEE_RELAX_MS);
  assert.equal(s.critSinceMs, null, 'the episode ended');
  assert.equal(s.graceFromMs, 0, 'the session stands');
  assert.equal(s.quietSinceMs, READING_MS, 'the rest runs on the plateau');
  // …and the balancing mute on the next crossing is bounded by the session.
  s = advanceVdiffKnee(s, obs({}), VDIFF_KNEE_MAX_MUTE_MS - TICK_MS);
  assert.equal(s.critSinceMs, VDIFF_KNEE_MAX_MUTE_MS - TICK_MS);
  assert.equal(s.quietSinceMs, null, 'the crossing breaks the rest');
  assert.equal(vdiffCritMute(s, obs({}), VDIFF_KNEE_MAX_MUTE_MS - TICK_MS), 'balancing');
  s = advanceVdiffKnee(s, obs({}), VDIFF_KNEE_MAX_MUTE_MS);
  assert.equal(vdiffCritMute(s, obs({}), VDIFF_KNEE_MAX_MUTE_MS), null, 'at 90%: 20 minutes from the session\'s first crossing');
  // A seen rest of VDIFF_KNEE_MAX_MUTE_MS on the plateau ends the session.
  let r = advanceVdiffKnee(undefined, obs({}), 0);
  r = advanceVdiffKnee(r, obs({ spreadMv: 30 }), MIN);
  r = advanceVdiffKnee(r, obs({ spreadMv: 30 }), MIN + VDIFF_KNEE_MAX_MUTE_MS - 1);
  assert.equal(r.graceFromMs, 0, 'not a millisecond early');
  r = advanceVdiffKnee(r, obs({ spreadMv: 30 }), MIN + VDIFF_KNEE_MAX_MUTE_MS);
  assert.equal(r.graceFromMs, null, 'rested on the plateau: the session is over');
  // An unknown SoC starts no session (off the plateau: its critical line is 50 mV)…
  assert.equal(advanceVdiffKnee(undefined, obs({ packSoc: null, spreadMv: 95 }), 0).graceFromMs, null);
  // …and neither ends one nor starts a rest.
  const u = advanceVdiffKnee(advanceVdiffKnee(undefined, obs({}), 0), obs({ packSoc: null, spreadMv: 30 }), MIN);
  assert.equal(u.graceFromMs, 0);
  assert.equal(u.quietSinceMs, null);
});
