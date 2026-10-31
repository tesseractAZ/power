/**
 * v1.195.0 — the cell-spread critical BELOW the plateau: the off-plateau session, and the low-charge knee.
 *
 * (A) The balancing mute had no limit below 85% SoC, nor with no SoC. The v1.187.0-.2 bounds (the
 * critical-line clock, the plateau session) run only on the plateau and are cleared below it, so the
 * v0.29.0 mute was held up only by its premise that balancing ends: 80 mV at 60% stayed muted for as
 * long as the BMS balanced (3 h in the design pass's replay, 541 ticks), a spread alternating
 * 55 / 45 / 45 mV on the BMS's ~180 s cadence was never announced, and a pack whose SoC read 84 / 85% on
 * alternate readings restarted its plateau session on every 85%. A critical below the plateau now opens
 * an off-plateau session; every mute there ends VDIFF_KNEE_MAX_MUTE_MS after its first crossing, dips
 * under the line do not restart it, and only 20 minutes seen under 50 mV ends it.
 *
 * (B) A healthy pack at the bottom of its charge crossed the instantaneous 50 mV line and sounded red
 * (2026-08-20: Core 5, cleared in 6.7 minutes). A 50-149 mV spread on a pack at 15% or less, within 10
 * points of its sibling packs, is held on the card — not pushed, not sounded — for at most those 20
 * minutes. A stranded pack (10 points or more below its siblings) and a session that reached the line
 * on any other reading get no low-charge grace: they page at once while the BMS is idle, and while it
 * reports balancing they are held by the balancing mute, which speaks 20 minutes after the session's
 * first crossing (10b). 150 mV or more pages at once, balancing or not.
 *
 * The clock is mocked; each tick is the monitor's 20 s computeAlerts.
 */
import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/* ── environment: set BEFORE any src module is loaded (the onset path is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-off-plateau-'));
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
const KNEE_PATH = resolve(ROOT, 'vdiff-knee-state.json');

const {
  computeAlerts, resetVdiffWarnHoldForTesting, advanceVdiffKnee, vdiffCritMute, lowChargeKnee, upperMedianSoc,
  persistVdiffKneeSessions, restoreVdiffKneeSessions, CELL_SPREAD_MUTE_TEXT,
  VDIFF_KNEE_MAX_MUTE_MS, VOL_DIFF_LOW_KNEE_SOC_PCT, VOL_DIFF_LOW_KNEE_PEER_PTS,
} = await import('../src/alerts.js');
const { silentCriticalLine } = await import('../src/alertMonitor.js');
type Alert = import('../src/alerts.js').Alert;
type DeviceSnapshot = import('../src/snapshot.js').DeviceSnapshot;
type VdiffKneeObservation = import('../src/alerts.js').VdiffKneeObservation;
type VdiffKneeSessions = import('../src/alerts.js').VdiffKneeSessions;

const SN = 'DPU-OFF';
const KEY = `${SN}-1`;
const CRIT_ID = `vdiff-crit-${SN}-1`;
const TICK_MS = 20_000;
const MIN = 60_000;
const BMS_MS = 180_000; // the BMS publishes cell voltages every ~180 s
const T0 = Date.parse('2026-10-29T12:00:00-07:00');
let clock = T0;

/** The subject pack (pack 1): its own SoC (null = not reported), spread, balancing flag. */
interface Subject { soc: number | null; vd: number; bal: boolean }
/** One Core: pack 1 is the subject; `siblings` are packs 2.. at those SoCs, each at a quiet 8 mV.
 *  `deviceSoc` (default: the subject's, else the siblings' first) is the projection's own SoC — the
 *  value the rule falls back to when a pack reports none. `vd: null` = no reading this tick. */
function device(s: Omit<Subject, 'vd'> & { vd: number | null }, siblings: Array<number | null> = [60, 60, 60, 60], deviceSoc?: number | null): Record<string, DeviceSnapshot> {
  const pack = (num: number, soc: number | null, vd: number | null, bal: boolean) => ({
    num, soc, packSn: `PACK-${num}`, inputWatts: 0, outputWatts: 0,
    maxVolDiffMv: vd, maxCellVoltageMv: vd == null ? null : 3300 + vd, minCellVoltageMv: vd == null ? null : 3300,
    balanceState: bal ? 1 : 0, cellVoltagesMv: [],
  });
  const packs = [pack(1, s.soc, s.vd, s.bal), ...siblings.map((soc, i) => pack(i + 2, soc, 8, false))];
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 9', productName: 'Delta Pro Ultra', online: true, lastUpdated: clock,
      projection: {
        kind: 'dpu', soc: deviceSoc !== undefined ? deviceSoc : (s.soc ?? siblings[0] ?? null), packs,
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}
/** One monitor tick at `atMs`: the subject's critical, if any. */
function tick(atMs: number, s: Omit<Subject, 'vd'> & { vd: number | null }, siblings?: Array<number | null>, deviceSoc?: number | null): Alert | undefined {
  clock = atMs;
  return computeAlerts(device(s, siblings, deviceSoc)).find((a) => a.id === CRIT_ID);
}
const muted = (a: Alert | undefined) => a != null && a.annunciate === false;
const speaks = (a: Alert | undefined) => a != null && a.annunciate !== false;
const mmss = (ms: number) => `+${Math.floor(ms / MIN)}:${String(Math.round((ms % MIN) / 1000)).padStart(2, '0')}`;

beforeEach(() => {
  resetVdiffWarnHoldForTesting();
  rmSync(KNEE_PATH, { force: true });
  clock = T0;
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());
after(() => rmSync(ROOT, { recursive: true, force: true }));

/* ── (A) the balancing mute below the plateau is bounded ──────────────────────────────────────── */

test('★★★ 1. bound: 80 mV at 60% while the BMS balances is muted through +19:40 and speaks at +20:00 (it never did)', () => {
  const v = { soc: 60, vd: 80, bal: true };
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) {
    const a = tick(T0 + t, v);
    assert.ok(muted(a), `${mmss(t)}: inside the bound, balancing mutes`);
    assert.equal(a!.mutedBy, 'balancing');
  }
  const at = tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, v);
  assert.ok(speaks(at), '+20:00: the balancing mute below the plateau is no longer unbounded');
  assert.match(at!.detail, /First reached the critical line below 85% charge 20 minutes ago\./);
  assert.match(at!.detail, /BMS is actively balancing/);
  // …and it stays spoken for as long as the BMS goes on balancing (v1.192.0: muted at +180 min).
  for (let t = VDIFF_KNEE_MAX_MUTE_MS; t <= 180 * MIN; t += 10 * MIN) assert.ok(speaks(tick(T0 + t, v)), `${mmss(t)}`);
});

test('★★★ 2. dips under the line do not restart the bound: 55 / 45 / 45 mV every 180 s at 60%, balancing, speaks on the critical tick at +20:00', () => {
  const at = (t: number) => [55, 45, 45][Math.floor(t / BMS_MS) % 3];
  let first: number | null = null;
  let spoke = 0;
  for (let t = 0; t <= 60 * MIN; t += TICK_MS) {
    const a = tick(T0 + t, { soc: 60, vd: at(t), bal: true });
    if (at(t) < 50) { assert.equal(a, undefined, `${mmss(t)}: 45 mV is no critical`); continue; }
    if (t < VDIFF_KNEE_MAX_MUTE_MS) assert.ok(muted(a), `${mmss(t)}: muted inside the bound`);
    else {
      // EVERY critical tick past the bound speaks, not just the first: a crossing breaks the rest,
      // so the six-minute dips never add up to the 20 minutes that would end the session and open
      // a fresh, muted one on the next 55 mV (+27:00, +36:00…).
      assert.ok(speaks(a), `${mmss(t)}: past the bound`);
      first ??= t;
      spoke++;
    }
  }
  // The 55 mV readings start at 0, 9, 18, 27… min; the one standing at +20:00 speaks then.
  assert.equal(first, VDIFF_KNEE_MAX_MUTE_MS, 'the six-minute dips are not a rest: one clock, from 12:00');
  assert.equal(spoke, 3 + 4 * 9, 'the rest of the 18-21 run, then the 27, 36, 45 and 54 minute runs');
});

test('★★★ 3. a REST ends the session: 20 minutes under 50 mV, and the next crossing is a new one; 19:40 is not a rest', () => {
  const run = (restMs: number): Alert | undefined => {
    for (let t = 0; t < 10 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 80, bal: true });
    for (let t = 10 * MIN; t <= 10 * MIN + restMs; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 30, bal: false });
    return tick(T0 + 10 * MIN + restMs + TICK_MS, { soc: 60, vd: 80, bal: true });
  };
  const after20 = run(VDIFF_KNEE_MAX_MUTE_MS);
  assert.ok(muted(after20), 'a seen 20-minute rest ended the session: the next balancing crossing is muted again');
  assert.equal(after20!.mutedBy, 'balancing');
  resetVdiffWarnHoldForTesting();
  const after1940 = run(VDIFF_KNEE_MAX_MUTE_MS - TICK_MS);
  assert.ok(speaks(after1940), 'a 19:40 rest did not: the session from 12:00 is 30 minutes old');
  assert.match(after1940!.detail, /below 85% charge 30 minutes ago\./);
});

test('★★★ 4. a reading gap carries the session (60 minutes at most); its rest is not carried', () => {
  for (let t = 0; t < 15 * MIN; t += TICK_MS) assert.ok(muted(tick(T0 + t, { soc: 60, vd: 80, bal: true })));
  // Ten minutes with no reading (the pack reports no spread): the prune carries the clock.
  for (let t = 15 * MIN; t < 25 * MIN; t += TICK_MS) assert.equal(tick(T0 + t, { soc: 60, vd: null, bal: true }), undefined);
  assert.ok(speaks(tick(T0 + 25 * MIN, { soc: 60, vd: 80, bal: true })), 'back at +25: the session from 12:00 is past its bound');

  resetVdiffWarnHoldForTesting();
  for (let t = 0; t < 15 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 80, bal: true });
  // A gap longer than VDIFF_KNEE_GAP_CARRY_MS drops it: a new session on return.
  for (let t = 15 * MIN; t <= 76 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: null, bal: true });
  const back = tick(T0 + 76 * MIN + TICK_MS, { soc: 60, vd: 80, bal: true });
  assert.ok(muted(back), 'after a 61-minute gap the old session is gone');

  // The rest must be SEEN: 12 minutes of it, a 10-minute gap, 9 more minutes — not a rest.
  resetVdiffWarnHoldForTesting();
  tick(T0, { soc: 60, vd: 80, bal: true });
  for (let t = TICK_MS; t < 12 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 30, bal: false });
  for (let t = 12 * MIN; t < 22 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: null, bal: false });
  for (let t = 22 * MIN; t < 31 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 30, bal: false });
  assert.ok(speaks(tick(T0 + 31 * MIN, { soc: 60, vd: 80, bal: true })), 'the session still runs: its rest restarted after the gap');
});

test('★★★ 5. a restart: the session is persisted and restored — speaks at +20, not +36 (no onset on record)', () => {
  let onDisk: VdiffKneeSessions = {};
  for (let t = 0; t <= 15 * MIN; t += TICK_MS) {
    tick(T0 + t, { soc: 60, vd: 80, bal: true });
    onDisk = persistVdiffKneeSessions(KNEE_PATH, onDisk);
  }
  const file = JSON.parse(readFileSync(KNEE_PATH, 'utf8')).sessions;
  assert.deepEqual(file[KEY], { packSn: 'PACK-1', critSinceMs: null, graceFromMs: null, quietSinceMs: null, lastSeenMs: T0 + 15 * MIN, offFromMs: T0 },
    'an off-plateau session is written by its own clock; no low-charge mark, no rest');
  resetVdiffWarnHoldForTesting(); // the process restarts
  const logs: string[] = [];
  restoreVdiffKneeSessions(KNEE_PATH, T0 + 16 * MIN, (m) => logs.push(m));
  assert.match(logs.join('\n'), /restored 1 knee session/);
  for (let t = 16 * MIN; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.ok(muted(tick(T0 + t, { soc: 60, vd: 80, bal: true })), `${mmss(t)}`);
  assert.ok(speaks(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, { soc: 60, vd: 80, bal: true })), '+20: the restart did not restart the bound');
});

test('★★ 5b. the persisted off-plateau fields: parsed and type-checked; the low-charge mark with its clock; the rest only across a short outage and when coherent', () => {
  const write = (entry: Record<string, unknown>) => writeFileSync(KNEE_PATH, JSON.stringify({ sessions: { [KEY]: entry } }));
  const restoreAt = (nowMs: number) => {
    resetVdiffWarnHoldForTesting(); // the process restarts
    const logs: string[] = [];
    const disk = restoreVdiffKneeSessions(KNEE_PATH, nowMs, (m) => logs.push(m));
    return { disk, log: logs.join('\n') };
  };
  const base = { packSn: 'PACK-1', critSinceMs: null, graceFromMs: null, quietSinceMs: null, lastSeenMs: T0 };
  write({ ...base, offFromMs: T0 - 5 * MIN, offQuietSinceMs: T0 - MIN, offKnee: true });
  const r = restoreAt(T0 + 2 * MIN);
  assert.deepEqual(r.disk[KEY], { ...base, offFromMs: T0 - 5 * MIN, offQuietSinceMs: T0 - MIN, offKnee: true });
  assert.equal(tick(T0 + 2 * MIN, { soc: 12, vd: 58, bal: false }, [13, 13, 13, 13])?.mutedBy, 'low-charge',
    'the restored low-charge mark holds inside the restored session\'s bound');
  // A non-numeric clock, or a mark that is not a boolean, is a malformed entry; so is one with no clock.
  write({ ...base, offFromMs: 'soon' });
  assert.match(restoreAt(T0 + MIN).log, /1 malformed entry ignored/);
  write({ ...base, offFromMs: T0, offKnee: 'yes' });
  assert.match(restoreAt(T0 + MIN).log, /1 malformed entry ignored/);
  write({ ...base, offFromMs: T0, offQuietSinceMs: Number.NaN }); // NaN is written as null: no rest
  assert.doesNotMatch(restoreAt(T0 + MIN).log, /malformed/);
  write({ ...base });
  assert.match(restoreAt(T0 + MIN).log, /1 malformed entry ignored/);
  // The rest is dropped after an outage longer than VDIFF_KNEE_SEEN_PERSIST_MS + VDIFF_KNEE_RELAX_MS: it
  // restarts from the first reading after the restart (+11), so at +25 the session from -5 still runs.
  write({ ...base, offFromMs: T0 - 5 * MIN, offQuietSinceMs: T0 - MIN });
  restoreAt(T0 + 11 * MIN);
  for (let t = 11 * MIN; t < 25 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 30, bal: false });
  assert.ok(speaks(tick(T0 + 25 * MIN, { soc: 60, vd: 80, bal: true })), 'a rest restored across that outage would have ended the session at +19');
  // A rest begun before its session is not one the process could have been in: never restored.
  write({ ...base, offFromMs: T0 - 5 * MIN, offQuietSinceMs: T0 - 10 * MIN });
  restoreAt(T0 + MIN);
  for (let t = MIN; t < 16 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 30, bal: false });
  assert.ok(speaks(tick(T0 + 16 * MIN, { soc: 60, vd: 80, bal: true })), 'restored, it would have ended the session at +10');
  // …while a coherent one across a short outage is kept: 20 minutes from -1 ends it at +19.
  write({ ...base, offFromMs: T0 - 5 * MIN, offQuietSinceMs: T0 - MIN });
  restoreAt(T0 + MIN);
  for (let t = MIN; t <= 19 * MIN; t += TICK_MS) tick(T0 + t, { soc: 60, vd: 30, bal: false });
  assert.equal(tick(T0 + 19 * MIN + TICK_MS, { soc: 60, vd: 80, bal: true })?.mutedBy, 'balancing', 'the rest ended the session: a new one opens');
});

test('★★★ 5c. a low-charge session round-trips a restart with its mark, and a forfeit inside one persist grain is written too', () => {
  const sib = [13, 13, 13, 13];
  let onDisk: VdiffKneeSessions = {};
  for (let t = 0; t <= 3 * MIN; t += TICK_MS) {
    assert.equal(tick(T0 + t, { soc: 12, vd: 58, bal: false }, sib)?.mutedBy, 'low-charge', mmss(t));
    onDisk = persistVdiffKneeSessions(KNEE_PATH, onDisk);
  }
  const file = JSON.parse(readFileSync(KNEE_PATH, 'utf8')).sessions;
  assert.deepEqual(file[KEY], { packSn: 'PACK-1', critSinceMs: null, graceFromMs: null, quietSinceMs: null, lastSeenMs: T0, offFromMs: T0, offKnee: true },
    'the session is written with its low-charge mark');
  resetVdiffWarnHoldForTesting(); // the process restarts
  restoreVdiffKneeSessions(KNEE_PATH, T0 + 4 * MIN, () => {});
  for (let t = 4 * MIN; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) {
    assert.equal(tick(T0 + t, { soc: 12, vd: 58, bal: false }, sib)?.mutedBy, 'low-charge', `${mmss(t)}: the restored mark holds on the card, not red`);
  }
  assert.ok(speaks(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, { soc: 12, vd: 58, bal: false }, sib)), '+20: the restored session\'s bound');

  // A FORFEIT is a change to persist even when no clock moved and the last reading stays in the same
  // VDIFF_KNEE_SEEN_PERSIST_MS grain: a restart must not hand the grace back.
  resetVdiffWarnHoldForTesting();
  rmSync(KNEE_PATH, { force: true });
  onDisk = {};
  assert.equal(tick(T0, { soc: 12, vd: 60, bal: false }, sib)?.mutedBy, 'low-charge');
  onDisk = persistVdiffKneeSessions(KNEE_PATH, onDisk);
  assert.equal(onDisk[KEY].offKnee, true);
  assert.ok(speaks(tick(T0 + TICK_MS, { soc: 16, vd: 60, bal: false }, [16, 16, 16, 16])), 'a reading at 16%: forfeit');
  onDisk = persistVdiffKneeSessions(KNEE_PATH, onDisk);
  assert.equal(JSON.parse(readFileSync(KNEE_PATH, 'utf8')).sessions[KEY].offKnee, undefined, 'the forfeit is on disk');
  resetVdiffWarnHoldForTesting(); // the process restarts
  restoreVdiffKneeSessions(KNEE_PATH, T0 + 2 * TICK_MS, () => {});
  assert.ok(speaks(tick(T0 + 2 * TICK_MS, { soc: 12, vd: 60, bal: false }, sib)), 'the restart did not restore the forfeited grace');
});

test('★★★ 6. no SoC reading: 120 mV while balancing speaks at +20', () => {
  const v = { soc: null, vd: 120, bal: true };
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.ok(muted(tick(T0 + t, v, [null, null, null, null], null)), mmss(t));
  const at = tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, v, [null, null, null, null], null);
  assert.ok(speaks(at), 'v1.192.0: muted for as long as the BMS balanced');
  assert.match(at!.detail, /First reached the critical line with no charge reading 20 minutes ago\./);
});

test('★★★ 7. SoC flickering 84 / 85%, 95 mV, balancing: the 84% ticks speak from +20 (v1.192.0: never)', () => {
  let spoke84 = 0;
  for (let t = 0; t <= 40 * MIN; t += TICK_MS) {
    const soc = (t / TICK_MS) % 2 === 0 ? 84 : 85;
    const a = tick(T0 + t, { soc, vd: 95, bal: true });
    assert.ok(a, 'critical at both');
    if (t < VDIFF_KNEE_MAX_MUTE_MS) assert.ok(muted(a), `${mmss(t)} at ${soc}%: inside the bound`);
    else if (soc === 84) { assert.ok(speaks(a), `${mmss(t)} at 84%: the off-plateau bound`); spoke84++; }
  }
  assert.ok(spoke84 > 0);
});

/* ── (B) the low-charge knee ─────────────────────────────────────────────────────────────────── */

test('★★★ 8. the 08-20 shape: packs at 12/13/13/13/13%, pack 1 at 58 mV idle for 6:40 — on the card only, then it closes; nothing ever sounds', () => {
  const sib = [13, 13, 13, 13];
  for (let t = 0; t <= 6 * MIN + 40_000; t += TICK_MS) {
    const a = tick(T0 + t, { soc: 12, vd: 58, bal: false }, sib);
    assert.ok(a, `${mmss(t)}: the critical is on the card`);
    assert.equal(a!.severity, 'critical');
    assert.ok(muted(a), `${mmss(t)}: not pushed, not sounded`);
    assert.equal(a!.mutedBy, 'low-charge');
    assert.equal(a!.muteReason, CELL_SPREAD_MUTE_TEXT['low-charge']);
    assert.match(a!.detail, /Low-charge cell spread\./);
  }
  for (let t = 7 * MIN; t <= 60 * MIN; t += TICK_MS) {
    assert.equal(tick(T0 + t, { soc: 12, vd: 40, bal: false }, sib), undefined, `${mmss(t)}: 40 mV — no critical`);
  }
  // The held line names the mute (alertMonitor's log of a held critical).
  clock = T0 + 61 * MIN;
  const held = computeAlerts(device({ soc: 12, vd: 58, bal: false }, sib)).find((a) => a.id === CRIT_ID)!;
  assert.match(silentCriticalLine(held), /low-charge cell spread, at most 20 minutes/);
});

test('★★★ 9. a low-charge spread that does not close speaks at +20:00', () => {
  const sib = [13, 13, 13, 13];
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.equal(tick(T0 + t, { soc: 12, vd: 58, bal: false }, sib)!.mutedBy, 'low-charge', mmss(t));
  const at = tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, { soc: 12, vd: 58, bal: false }, sib);
  assert.ok(speaks(at), '20 minutes of a low-charge spread is not the knee');
  assert.match(at!.detail, /First reached the critical line below 85% charge 20 minutes ago\./);
  for (let t = VDIFF_KNEE_MAX_MUTE_MS; t <= 25 * MIN; t += TICK_MS) assert.ok(speaks(tick(T0 + t, { soc: 12, vd: 58, bal: false }, sib)));
});

test('★★★ 10. a STRANDED pack, the BMS idle, pages at once: 11% against 56/58/59/60 (median 59); 1% against 21/23/25/26 (median 25)', () => {
  const a = tick(T0, { soc: 11, vd: 71, bal: false }, [56, 58, 59, 60]);
  assert.ok(speaks(a), 'the warranty-pack shape is a fault, not the knee');
  assert.match(a!.detail, /Pack at 11% charge against a sibling median of 59%\./);
  resetVdiffWarnHoldForTesting();
  const b = tick(T0, { soc: 1, vd: 71, bal: false }, [21, 23, 25, 26]);
  assert.ok(speaks(b));
  assert.match(b!.detail, /Pack at 1% charge against a sibling median of 25%\./);
  assert.equal(upperMedianSoc([56, 58, 59, 60]), 59, 'the upper median of an even count');
  assert.equal(upperMedianSoc([13]), null, 'fewer than two siblings: none');
});

test('★★★ 10b. a STRANDED pack while the BMS balances: no low-charge grace, but the balancing mute holds it to +19:40 and it speaks at +20:00', () => {
  // What the docs say of 10: no low-charge grace — "at once" only while the BMS is idle. vdiffCritMute
  // checks the balancing mute before the low-charge branch, so a stranded reading that balances is held
  // as 'balancing', bounded by the off-plateau session like any balancing critical below 85% (1, 15).
  // Before v1.195.0 that mute had no limit here at all. The stranded note is on the card throughout.
  const sib = [56, 58, 59, 60];
  const v = { soc: 11, vd: 71, bal: true };
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) {
    const a = tick(T0 + t, v, sib);
    assert.ok(muted(a), `${mmss(t)}: balancing mutes inside the bound`);
    assert.equal(a!.mutedBy, 'balancing', `${mmss(t)}: the balancing mute, never the low-charge grace`);
    assert.match(a!.detail, /Pack at 11% charge against a sibling median of 59%\./);
  }
  const at = tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, v, sib);
  assert.ok(speaks(at), '+20:00');
  assert.match(at!.detail, /First reached the critical line below 85% charge 20 minutes ago\./);
  // A session opened at 40% on a balancing reading is held the same way, and speaks at the same bound.
  resetVdiffWarnHoldForTesting();
  const w = { soc: 40, vd: 60, bal: true };
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.equal(tick(T0 + t, w, [40, 40, 40, 40])!.mutedBy, 'balancing', mmss(t));
  assert.ok(speaks(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, w, [40, 40, 40, 40])));
});

test('★★ 11. the peer line: 9 points below the siblings is the knee; 10 points is stranded', () => {
  assert.equal(VOL_DIFF_LOW_KNEE_PEER_PTS, 10);
  assert.equal(tick(T0, { soc: 12, vd: 58, bal: false }, [20, 21, 21, 22])!.mutedBy, 'low-charge', 'median 21: 9 points');
  resetVdiffWarnHoldForTesting();
  const s = tick(T0, { soc: 12, vd: 58, bal: false }, [21, 22, 22, 23]);
  assert.ok(speaks(s), 'median 22: 10 points');
  assert.match(s!.detail, /sibling median of 22%/);
});

test('★★ 12. the SoC line and the inputs it needs: 15% is the knee, 16% is not; no own SoC, or fewer than two siblings, is never the knee', () => {
  assert.equal(VOL_DIFF_LOW_KNEE_SOC_PCT, 15);
  assert.equal(tick(T0, { soc: 15, vd: 58, bal: false }, [15, 15, 15, 15])!.mutedBy, 'low-charge', '15%');
  resetVdiffWarnHoldForTesting();
  assert.ok(speaks(tick(T0, { soc: 16, vd: 58, bal: false }, [16, 16, 16, 16])), '16%');
  resetVdiffWarnHoldForTesting();
  assert.ok(speaks(tick(T0, { soc: null, vd: 58, bal: false }, [12, 12, 12, 12], 12)), 'the pack reports no SoC (the device reads 12%)');
  resetVdiffWarnHoldForTesting();
  assert.ok(speaks(tick(T0, { soc: 12, vd: 58, bal: false }, [12])), 'one sibling');
  resetVdiffWarnHoldForTesting();
  assert.ok(speaks(tick(T0, { soc: 12, vd: 58, bal: false }, [12, null, null])), 'one sibling reporting');
});

test('★★★ 13. the grace is forfeit for the session by any reading at the line that is not the knee', () => {
  // A session opened at 40% (red at once), then the pack reads 12% at the line: still red.
  assert.ok(speaks(tick(T0, { soc: 40, vd: 60, bal: false }, [40, 40, 40, 40])));
  assert.ok(speaks(tick(T0 + MIN, { soc: 12, vd: 60, bal: false }, [12, 12, 12, 12])), 'the session reached the line above 15%');
  // A session opened at 12% (held), then one reading at 16%: it speaks, and so do the 12% readings after it.
  resetVdiffWarnHoldForTesting();
  assert.equal(tick(T0, { soc: 12, vd: 60, bal: false }, [12, 12, 12, 12])!.mutedBy, 'low-charge');
  assert.ok(speaks(tick(T0 + TICK_MS, { soc: 16, vd: 60, bal: false }, [16, 16, 16, 16])));
  for (let t = 2 * TICK_MS; t < 5 * MIN; t += TICK_MS) assert.ok(speaks(tick(T0 + t, { soc: 12, vd: 60, bal: false }, [12, 12, 12, 12])), mmss(t));
  // A stranded reading forfeits it too.
  resetVdiffWarnHoldForTesting();
  assert.equal(tick(T0, { soc: 12, vd: 60, bal: false }, [12, 12, 12, 12])!.mutedBy, 'low-charge');
  assert.ok(speaks(tick(T0 + TICK_MS, { soc: 12, vd: 60, bal: false }, [30, 30, 30, 30])));
  assert.ok(speaks(tick(T0 + 2 * TICK_MS, { soc: 12, vd: 60, bal: false }, [12, 12, 12, 12])));
});

test('★★★ 14. the ceiling: 150 mV at 12% pages at once', () => {
  assert.ok(speaks(tick(T0, { soc: 12, vd: 150, bal: false }, [12, 12, 12, 12])));
  resetVdiffWarnHoldForTesting();
  assert.ok(speaks(tick(T0, { soc: 12, vd: 150, bal: true }, [12, 12, 12, 12])), 'balancing or not');
});

test('★★ 15. balancing at 12%: the balancing mute, bounded by the same session', () => {
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.equal(tick(T0 + t, { soc: 12, vd: 70, bal: true }, [12, 12, 12, 12])!.mutedBy, 'balancing', mmss(t));
  assert.ok(speaks(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, { soc: 12, vd: 70, bal: true }, [12, 12, 12, 12])));
});

test('★★★ 16. pure: no off-plateau session is no mute below the plateau (fail closed), whatever else the state holds', () => {
  const obs = (o: Partial<VdiffKneeObservation>): VdiffKneeObservation =>
    ({ packSn: 'P', packSoc: 60, spreadMv: 80, balancing: true, chargeW: null, siblingMedianSoc: 60, ...o });
  const s = advanceVdiffKnee(undefined, obs({}), 0);
  assert.equal(s.offFromMs, 0);
  assert.equal(vdiffCritMute(s, obs({}), 60_000), 'balancing');
  assert.equal(vdiffCritMute({ ...s, offFromMs: null }, obs({}), 60_000), null, 'a state with no session');
  const { offFromMs: _drop, ...pre } = s; // a state built before v1.195.0
  assert.equal(vdiffCritMute(pre, obs({}), 60_000), null, 'a state that never had the field');
  // The knee itself, pure.
  assert.equal(lowChargeKnee({ packSoc: 12, siblingMedianSoc: 21 }), true);
  assert.equal(lowChargeKnee({ packSoc: 12, siblingMedianSoc: 22 }), false);
  assert.equal(lowChargeKnee({ packSoc: 12, siblingMedianSoc: null }), false);
  assert.equal(lowChargeKnee({ packSoc: null, siblingMedianSoc: 12 }), false);
  // A knee session needs offKnee as well as a knee reading.
  const k = advanceVdiffKnee(undefined, obs({ packSoc: 12, siblingMedianSoc: 13, balancing: false, spreadMv: 58 }), 0);
  assert.equal(k.offKnee, true);
  assert.equal(vdiffCritMute(k, obs({ packSoc: 12, siblingMedianSoc: 13, balancing: false, spreadMv: 58 }), 60_000), 'low-charge');
  assert.equal(vdiffCritMute({ ...k, offKnee: false }, obs({ packSoc: 12, siblingMedianSoc: 13, balancing: false, spreadMv: 58 }), 60_000), null);
  // On the plateau the off-plateau session neither starts nor bounds anything.
  const p = advanceVdiffKnee(undefined, obs({ packSoc: 99, spreadMv: 95 }), 0);
  assert.equal(p.offFromMs, null, 'an on-plateau reading never opens it');
});

test('★★ 17. the 05-20 plateau edge (84%, balancing, 52-57 mV for about 3 minutes, then 23 and 4 mV) stays silent', () => {
  const vd = (t: number) => (t < 3 * MIN ? (t < 90_000 ? 52 : 57) : t < 6 * MIN ? 23 : 4);
  for (let t = 0; t <= 30 * MIN; t += TICK_MS) {
    const a = tick(T0 + t, { soc: 84, vd: vd(t), bal: t < 4 * MIN }, [83, 84, 84, 85]);
    if (vd(t) >= 50) assert.ok(muted(a), `${mmss(t)}: ${vd(t)} mV while balancing`);
    else assert.equal(a, undefined);
  }
});
