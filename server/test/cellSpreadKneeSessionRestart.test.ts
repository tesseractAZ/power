/**
 * v1.187.1 — the end-of-charge knee SESSION across a restart (vdiff-knee-state.json).
 *
 * v1.187.0 restored a pack's session clock after a restart from its standing critical's persisted
 * onset, judged by the ONSET's age (vdiffKneeSeed), and the monitor retires that onset with the
 * tracked alert VDIFF_RESOLVE_DWELL_MS after the critical leaves the set. A fault that follows the
 * charge current crosses the line on isolated readings, so a restart on one of its sub-line
 * readings found an onset held through the dwell for over an hour (95 / 45 mV alternating: no
 * session seeded) or none (hi / lo / lo: retired), and the next crossing opened a new session —
 * up to VDIFF_KNEE_MAX_MUTE_MS more silence. The clocks are now persisted per pack and restored by
 * the in-process gap rule (carried while the last reading is at most VDIFF_KNEE_GAP_CARRY_MS old).
 * v1.187.1 (review) — the rest (quietSinceMs) is persisted too and restored across a short outage,
 * so a restart during the rest after a benign knee does not make the next benign knee sound; the
 * last reading is persisted floored to its grain, one write per grain however many packs.
 *
 * Each tick here is the monitor's sequence: computeAlerts, the onset sync over the TRACKED ids (a
 * cell-imbalance alert stays tracked VDIFF_RESOLVE_DWELL_MS after it leaves the set, as the
 * monitor's resolve dwell holds it), then persistVdiffKneeSessions. A restart is the process
 * losing its memory: the knee map, the onset cache and the tracked set are cleared, and
 * restoreVdiffKneeSessions reads the file, as startAlertMonitor does before its first tick.
 */
import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/* ── environment: set BEFORE any src module is loaded (the onset path is read at import) ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-knee-session-'));
process.env.ALERT_ONSET_PATH = resolve(ROOT, 'alert-onset.json');
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
const KNEE_PATH = resolve(ROOT, 'vdiff-knee-state.json');

const {
  computeAlerts, resetVdiffWarnHoldForTesting, restoreVdiffKneeSessions, persistVdiffKneeSessions,
  VDIFF_KNEE_MAX_MUTE_MS, VDIFF_KNEE_GAP_CARRY_MS, VDIFF_KNEE_SEEN_PERSIST_MS, VDIFF_KNEE_RELAX_MS,
} = await import('../src/alerts.js');
const { syncAlertOnsets, resetAlertOnsetCacheForTests, getAlertOnset } = await import('../src/alertOnset.js');
type Alert = import('../src/alerts.js').Alert;
type DeviceSnapshot = import('../src/snapshot.js').DeviceSnapshot;
type VdiffKneeSessions = import('../src/alerts.js').VdiffKneeSessions;

const SN = 'DPU-A';
const OTHER = 'DPU-B';
const KEY = `${SN}-1`;
const CRIT_ID = `vdiff-crit-${SN}-1`;
const TICK_MS = 20_000;
const SEC = 1_000;
const MIN = 60_000;
/** The BMS publishes cell voltages every ~180 s. */
const READING_MS = 180_000;
/** The monitor's default VDIFF_RESOLVE_DWELL_MS (alertMonitor.ts): a cleared cell-imbalance
 *  alert stays tracked — and its onset on record — this long. */
const DWELL_MS = 3 * MIN;
const T0 = Date.parse('2026-09-29T15:00:00-07:00');
const G = VDIFF_KNEE_SEEN_PERSIST_MS;
const CARRY = VDIFF_KNEE_GAP_CARRY_MS;
let clock = 0;

/** packSn: undefined = the default serial, null = the BMS has not reported one. */
interface Reading { vd: number; soc: number; bal: 0 | 1; in: number; packSn?: string | null }
/** A reading per device; null = the device is offline (its packs produce no reading). */
type Readings = Record<string, Reading | null>;
function devices(rs: Readings): Record<string, DeviceSnapshot> {
  const out: Record<string, DeviceSnapshot> = {};
  for (const [sn, r] of Object.entries(rs)) {
    const pack = r && {
      num: 1, soc: r.soc, packSn: r.packSn === undefined ? `PACK-${sn}` : r.packSn, inputWatts: r.in, outputWatts: 0,
      streamInputW: { w: r.in, atMs: clock },
      maxVolDiffMv: r.vd, maxCellVoltageMv: 3400 + r.vd, minCellVoltageMv: 3400,
      balanceState: r.bal, cellVoltagesMv: [],
    };
    out[sn] = {
      sn, deviceName: sn === SN ? 'Core 9' : 'Core 8', productName: 'Delta Pro Ultra', online: r != null, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: r?.soc ?? 50, packs: pack ? [pack] : [],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot;
  }
  return out;
}

/* ── the monitor, as far as the knee needs it ─────────────────────────────────────────────── */
const tracked = new Map<string, number | null>(); // id → clearedSince
let onDisk: VdiffKneeSessions = {};
/** persistVdiffKneeSessions returns a NEW record exactly when it wrote the file. */
let writes = 0;
const logs: string[] = [];
/** One monitor tick: computeAlerts, the resolve dwell + onset sync over the tracked ids, the persist. */
function tickAll(atMs: number, rs: Readings): Alert[] {
  clock = atMs;
  const alerts = computeAlerts(devices(rs));
  const present = new Set(alerts.map((a) => a.id));
  for (const id of present) tracked.set(id, null);
  for (const [id, since] of [...tracked]) {
    if (present.has(id)) continue;
    if (since == null) tracked.set(id, atMs);
    else if (atMs - since >= DWELL_MS) tracked.delete(id);
  }
  syncAlertOnsets(tracked.keys(), atMs);
  const before = onDisk;
  onDisk = persistVdiffKneeSessions(KNEE_PATH, onDisk);
  if (onDisk !== before) writes++;
  return alerts;
}
function tick(atMs: number, r: Reading | null): Alert | undefined {
  return tickAll(atMs, { [SN]: r }).find((a) => a.id === CRIT_ID);
}
/** The process restarts: memory is gone; the start-up restore reads the knee-session file. */
function restart(atMs: number): void {
  resetVdiffWarnHoldForTesting();
  resetAlertOnsetCacheForTests();
  tracked.clear();
  clock = atMs;
  logs.length = 0;
  onDisk = restoreVdiffKneeSessions(KNEE_PATH, atMs, (m) => logs.push(m));
}
const onFile = (): VdiffKneeSessions => JSON.parse(readFileSync(KNEE_PATH, 'utf8')).sessions;

/** A clean slate: no process memory, no onset on record, no knee-session file. */
function fresh(): void {
  resetVdiffWarnHoldForTesting();
  resetAlertOnsetCacheForTests();
  rmSync(process.env.ALERT_ONSET_PATH!, { force: true });
  rmSync(KNEE_PATH, { force: true });
  tracked.clear();
  onDisk = {};
  writes = 0;
  logs.length = 0;
}
beforeEach(() => {
  fresh();
  mock.method(Date, 'now', () => clock);
});
afterEach(() => mock.restoreAll());
after(() => rmSync(ROOT, { recursive: true, force: true }));

const BAL_HI: Reading = { vd: 95, soc: 100, bal: 1, in: 0 };
const BAL_LO: Reading = { vd: 45, soc: 100, bal: 1, in: 0 };
const CHG_HI: Reading = { vd: 95, soc: 97, bal: 0, in: 600 };
const CHG_LO: Reading = { vd: 45, soc: 97, bal: 0, in: 600 };
const FAULTS: Array<[string, Reading, Reading]> = [
  ['balancing at 100%', BAL_HI, BAL_LO],
  ['charging at 97% (600 W)', CHG_HI, CHG_LO],
];

/* ── (a) 95 / 45 mV alternating, older than the carry ──────────────────────────────────────── */

for (const [label, hi, lo] of FAULTS) {
  test(`★★★ (a) a 95 / 45 mV fault older than an hour, restarted on a 45 mV reading, stays loud on its next crossing — ${label}`, () => {
    const at = (t: number) => (Math.floor(t / READING_MS) % 2 === 0 ? hi : lo);
    for (let t = 0; t < 63 * MIN; t += TICK_MS) {
      const a = tick(T0 + t, at(t));
      if (t === 60 * MIN) assert.notEqual(a!.annunciate, false, 'in-process: loud on every crossing past the session bound');
    }
    assert.equal(getAlertOnset(CRIT_ID), T0, 'the onset is held through the dwell between readings: 63 minutes old');
    restart(T0 + 63 * MIN); // the add-on restarts as the reading drops to 45 mV
    assert.match(logs.join('\n'), /restored 1 knee session/);
    for (let t = 63 * MIN; t < 66 * MIN; t += TICK_MS) assert.equal(tick(T0 + t, lo), undefined);
    for (let t = 66 * MIN; t < 69 * MIN; t += TICK_MS) {
      const a = tick(T0 + t, hi)!;
      assert.notEqual(a.annunciate, false, `+${(t - 66 * MIN) / SEC}s after the next crossing: silenced by a new session's grace`);
      assert.equal(a.mutedBy, undefined);
    }
  });
}

/* ── (b) hi / lo / lo: the onset is retired between crossings ─────────────────────────────── */

for (const [label, hi, lo] of FAULTS) {
  test(`★★★ (b) a hi / lo / lo fault restarted during its low readings starts no new grace — ${label}`, () => {
    const at = (t: number) => (Math.floor(t / READING_MS) % 3 === 0 ? hi : lo);
    for (let t = 0; t < 2000 * SEC; t += TICK_MS) {
      const a = tick(T0 + t, at(t));
      if (t === 1620 * SEC) assert.notEqual(a!.annunciate, false, 'in-process: the crossing 27 minutes into the session is loud');
    }
    assert.equal(getAlertOnset(CRIT_ID), undefined, 'two low readings outlast the dwell: the onset is retired');
    restart(T0 + 2000 * SEC);
    for (let t = 2000 * SEC; t < 2160 * SEC; t += TICK_MS) assert.equal(tick(T0 + t, lo), undefined);
    for (let t = 2160 * SEC; t < 2340 * SEC; t += TICK_MS) {
      assert.notEqual(tick(T0 + t, hi)!.annunciate, false, `+${(t - 2160 * SEC) / SEC}s: the crossing after the restart is still loud`);
    }
  });
}

/* ── (g) between 85% and 95%: the critical-line clock across a restart (v1.187.1 log review) ── */

const PLAT_HI: Reading = { vd: 95, soc: 90, bal: 1, in: 0 };
const PLAT_LO: Reading = { vd: 45, soc: 90, bal: 1, in: 0 };
/** Under the plateau line (90 mV) but not under 50 mV. */
const PLAT_MID: Reading = { vd: 70, soc: 90, bal: 1, in: 0 };
for (const [label, restartMin] of [['on a 45 mV reading', 33], ['on a 95 mV reading', 36]] as const) {
  test(`★★★ (g) at 90% a balancing 95 / 45 mV fault restarted ${label} stays loud: the file holds its FIRST crossing`, () => {
    // Until v1.187.2 no session ran below 95%, so the critical-line clock was the balancing mute's
    // only bound. It used to end on every 45 mV reading, so the file held the latest crossing (a
    // restart on a 95 mV reading) or nothing (on a 45 mV one) — and the process itself never
    // annunciated. v1.187.2 — the session runs across the plateau, and the file holds it too.
    const at = (t: number) => (Math.floor(t / READING_MS) % 2 === 0 ? PLAT_HI : PLAT_LO);
    for (let t = 0; t < restartMin * MIN; t += TICK_MS) {
      const a = tick(T0 + t, at(t));
      if (a) assert.equal(a.annunciate !== false, t >= VDIFF_KNEE_MAX_MUTE_MS, `+${t / SEC}s in-process: loud exactly from 20 minutes`);
      if (t >= READING_MS) assert.equal(onFile()[KEY].critSinceMs, T0, `+${t / SEC}s: the clock on file is the first crossing`);
    }
    assert.equal(onFile()[KEY].graceFromMs, T0, 'v1.187.2: the session runs across the plateau, from the first crossing');
    restart(T0 + restartMin * MIN);
    assert.match(logs.join('\n'), /restored 1 knee session/);
    let loud = 0;
    for (let t = restartMin * MIN; t < (restartMin + 6) * MIN; t += TICK_MS) {
      const a = tick(T0 + t, at(t));
      if (!a) continue;
      assert.notEqual(a.annunciate, false, `+${(t - restartMin * MIN) / SEC}s after the restart: muted again`);
      assert.match(a.detail, /First reached the critical line \d+ minutes ago\./);
      loud++;
    }
    assert.ok(loud >= 9, 'a whole 95 mV reading after the restart');
  });
}

/* ── (h) between 85% and 95%, dips long enough to end the episode (v1.187.2) ─────────────────── */

for (const [label, restartMin] of [['on a 45 mV reading', 21], ['on a 95 mV reading', 27]] as const) {
  test(`★★★ (h) at 90% a balancing hi / lo / lo fault (95 / 45 / 45 mV) restarted ${label} stays loud: the file holds the session's first crossing`, () => {
    // Each pair of 45 mV readings ends the episode clock, so v1.187.1 restarted the 20-minute bound
    // on every crossing and the file held the latest one (or nothing): never announced, in-process or
    // across a restart. The session now runs across the plateau, is written, and bounds it.
    const at = (t: number) => (Math.floor(t / READING_MS) % 3 === 0 ? PLAT_HI : PLAT_LO);
    let firstLoud: number | null = null;
    for (let t = 0; t < restartMin * MIN; t += TICK_MS) {
      const a = tick(T0 + t, at(t));
      if (a && a.annunciate !== false && firstLoud == null) firstLoud = t;
      if (a && firstLoud != null) assert.notEqual(a.annunciate, false, `+${t / SEC}s in-process: muted again`);
    }
    assert.equal(firstLoud, VDIFF_KNEE_MAX_MUTE_MS, 'in-process: loud on the reading that spans 20 minutes from the first crossing');
    assert.equal(onFile()[KEY].graceFromMs, T0, 'the session clock on file is the first crossing');
    restart(T0 + restartMin * MIN);
    assert.match(logs.join('\n'), /restored 1 knee session/);
    let loud = 0;
    for (let t = restartMin * MIN; t < (restartMin + 10) * MIN; t += TICK_MS) {
      const a = tick(T0 + t, at(t));
      if (!a) continue;
      assert.notEqual(a.annunciate, false, `+${(t - restartMin * MIN) / SEC}s after the restart: muted again`);
      assert.match(a.detail, /First reached the critical line above 85% charge \d+ minutes ago\./, 'the session bound (the episode restarted)');
      loud++;
    }
    assert.ok(loud >= 9, 'a whole 95 mV reading after the restart');
  });
}

/* ── (i) an unconfirmed seed keeps its mark across a restart (v1.187.2) ─────────────────────── */

test('★★★ (i) a day-old seeded clock, not yet confirmed at the line, is written WITH its mark: a second restart cannot pass it off as one the process saw', () => {
  // The add-on returns the next day (the knee-session entry dropped: the outage outlasted the carry)
  // to a day-old onset. Its first reading is 70 mV at 90% — under the plateau line, not under
  // 50 mV — so the seeded clock stands, unconfirmed. Written without its mark, the next restart
  // restored it as a clock a process had seen: a reading under 50 mV no longer ended it, and a
  // benign crossing within VDIFF_KNEE_RELAX_MS annunciated at once ("First reached the critical
  // line 1443 minutes ago."). With the mark, the 30 mV reading after the second restart ends it.
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  assert.equal(getAlertOnset(CRIT_ID), T0);
  const day = T0 + 24 * 60 * MIN;
  restart(day);
  assert.match(logs.join('\n'), /restored 0 knee session\(s\).*1 dropped/);
  assert.equal(tick(day, PLAT_MID), undefined, 'under the plateau line');
  assert.equal(getAlertOnset(CRIT_ID), undefined, 'the onset is pruned on the first tick back (the critical is absent)');
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: null, quietSinceMs: null, lastSeenMs: day, critSeeded: true },
    'the unconfirmed seed is on file with its mark');
  restart(day + MIN);
  for (let t = MIN; t < 3 * MIN; t += TICK_MS) assert.equal(tick(day + t, { vd: 30, soc: 90, bal: 1, in: 0 }), undefined);
  assert.equal(onFile()[KEY], undefined, 'ended by the first reading under 50 mV: no clock left');
  const knee = tick(day + 3 * MIN, PLAT_HI)!;
  assert.equal(knee.mutedBy, 'balancing', 'a benign crossing: a new episode, muted while balancing');
  assert.doesNotMatch(knee.detail, /First reached the critical line/);
});

test('★★★ (i) …and a second restart keeps a seeded clock its next crossing confirms: the fault stays loud from its onset (the review of this release)', () => {
  // 95 / 70 mV alternating at 90%, balancing. The add-on goes down 10 minutes into the fault (not
  // yet announced) and returns 71 minutes later on a 70 mV reading: no knee-session entry (the
  // outage outlasted the carry), so the clock is seeded from the 81-minute-old onset, which the
  // first tick back prunes (the critical is absent). A second restart one tick later found neither
  // an onset nor — had the unconfirmed clock been written as none — an entry, and the next crossing
  // opened a fresh 20-minute mute (v1.187.1 and a single restart are loud there).
  const HI: Reading = { vd: 95, soc: 90, bal: 1, in: 0 };
  const at = (t: number) => (Math.floor(t / READING_MS) % 2 === 0 ? HI : PLAT_MID);
  for (let t = 0; t < 10 * MIN; t += TICK_MS) tick(T0 + t, at(t));
  const up1 = 81 * MIN;
  restart(T0 + up1);
  assert.equal(at(up1), PLAT_MID);
  tick(T0 + up1, at(up1));
  assert.equal(getAlertOnset(CRIT_ID), undefined, 'the onset is pruned on the first tick back');
  const up2 = up1 + 2 * TICK_MS;
  restart(T0 + up2);
  assert.match(logs.join('\n'), /restored 1 knee session/);
  let loud = 0;
  for (let t = up2; t < up2 + 10 * MIN; t += TICK_MS) {
    const a = tick(T0 + t, at(t));
    if (!a) continue;
    assert.notEqual(a.annunciate, false, `+${(t - up2) / SEC}s after the second restart: muted (${a.mutedBy})`);
    assert.match(a.detail, /First reached the critical line \d+ minutes ago\./);
    loud++;
  }
  assert.ok(loud >= 9, 'a whole 95 mV reading after the second restart');
});

test('★★ (i) a seeded SESSION is written with the seeded clock, and still bounds the mute after a second restart', () => {
  // The knee-session file is lost (the fallback): the onset, 25 minutes old, seeds both clocks.
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  rmSync(KNEE_PATH, { force: true });
  restart(T0 + 25 * MIN);
  assert.equal(tick(T0 + 25 * MIN, PLAT_MID), undefined);
  const s = onFile()[KEY];
  assert.equal(s.critSinceMs, T0);
  assert.equal(s.critSeeded, true);
  assert.equal(s.graceFromMs, T0, 'the seeded session is written');
  restart(T0 + 26 * MIN);
  assert.equal(tick(T0 + 26 * MIN, { vd: 30, soc: 90, bal: 1, in: 0 }), undefined);
  assert.equal(onFile()[KEY].critSinceMs, null, 'the seed ended on the first reading under 50 mV');
  const back = tick(T0 + 27 * MIN, PLAT_HI)!;
  assert.notEqual(back.annunciate, false, 'the session, 27 minutes old, bounds the balancing mute');
  assert.match(back.detail, /First reached the critical line above 85% charge 27 minutes ago\./);
});

test('★★ (i) the mark on file: a confirmed seed is rewritten without it; a mark with no clock, or not a boolean, is not trusted', () => {
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  const day = T0 + 24 * 60 * MIN;
  restart(day);
  tick(day, PLAT_MID);
  assert.equal(onFile()[KEY].critSeeded, true);
  const SENTINEL = 'untouched';
  writeFileSync(KNEE_PATH, SENTINEL);
  tick(day + TICK_MS, PLAT_MID);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'nothing changed: no write');
  tick(day + 2 * TICK_MS, PLAT_HI);
  assert.equal(onFile()[KEY].critSinceMs, T0, 'confirmed at the line');
  assert.equal('critSeeded' in onFile()[KEY], false, 'the mark is cleared on file on the tick it is confirmed');
  // A seed whose session was seeded with it (an onset inside the carry, the file lost): on the
  // confirming tick the mark is the only value that changes, and it is still written.
  fresh();
  for (let t = 0; t <= VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) tick(T0 + t, { vd: 110, soc: 90, bal: 1, in: 0 });
  rmSync(KNEE_PATH, { force: true });
  restart(T0 + 25 * MIN);
  tick(T0 + 25 * MIN, PLAT_MID);
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: null, lastSeenMs: T0 + 5 * G, critSeeded: true });
  tick(T0 + 25 * MIN + TICK_MS, PLAT_HI);
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: null, lastSeenMs: T0 + 5 * G },
    'only the mark changed, and the file says so');
  // A mark with no clock restores no mark: the entry written back after one tick carries none.
  fresh();
  writeFileSync(KNEE_PATH, JSON.stringify({ sessions: {
    [KEY]: { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: T0, quietSinceMs: null, lastSeenMs: T0, critSeeded: true },
  } }));
  restart(T0 + MIN);
  tick(T0 + MIN, PLAT_MID);
  assert.equal('critSeeded' in onFile()[KEY], false, 'a mark with no clock is dropped');
  // A mark that is not a boolean makes the entry malformed (skipped and counted).
  fresh();
  writeFileSync(KNEE_PATH, JSON.stringify({ sessions: {
    [KEY]: { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: null, quietSinceMs: null, lastSeenMs: T0, critSeeded: 'yes' },
  } }));
  restart(T0 + MIN);
  assert.match(logs[0], /restored 0 knee session\(s\) from .*; 1 malformed entry ignored$/);
});

/* ── (j) upgrading from v1.187.1 mid-fault (v1.187.2) ──────────────────────────────────────── */

test('★★★ (j) upgrading from v1.187.1 mid-fault: a 90% entry holding only the episode clock starts its session from that clock, not from the next crossing', () => {
  // v1.187.1 ran no session below 95%, so its file holds a 90% fault's episode clock alone (the
  // fault crossing on alternate readings for its first 10 minutes). The upgrade restarts the add-on
  // and the fault continues as hi / lo / lo: its pairs of 45 mV readings end the episode after the
  // restart. Started from the next crossing, the session would grant up to 20 more minutes of
  // silence; started from the restored episode clock, the crossing 20 minutes after the fault's
  // first is loud.
  writeFileSync(KNEE_PATH, JSON.stringify({ sessions: {
    [KEY]: { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: null, quietSinceMs: null, lastSeenMs: T0 + 2 * G },
  } }));
  const R = T0 + 11 * MIN;
  restart(R);
  assert.match(logs.join('\n'), /restored 1 knee session/);
  const at = (t: number) => (Math.floor(t / READING_MS) % 3 === 0 ? PLAT_HI : PLAT_LO);
  assert.equal(tick(R, at(0))!.mutedBy, 'balancing', 'the episode is 11 minutes old');
  assert.equal(onFile()[KEY].graceFromMs, T0, 'the session starts from the restored episode clock');
  for (let t = TICK_MS; t < 9 * MIN; t += TICK_MS) tick(R + t, at(t));
  const late = tick(R + 9 * MIN, at(9 * MIN))!;
  assert.notEqual(late.annunciate, false, 'the crossing 20 minutes after the fault\'s first crossing');
  assert.match(late.detail, /First reached the critical line above 85% charge 20 minutes ago\./);
});

/* ── (k) a corrupt session clock (v1.187.2) ─────────────────────────────────────────────────── */

test('★★ (k) a session clock on file LATER than its episode\'s first crossing cannot quiet the episode\'s own 20-minute bound', () => {
  // Every state the process writes has graceFromMs <= critSinceMs, so the session bound comes due
  // first and backs the episode bound up. A hand-edited or corrupt file can invert them; the
  // episode's own bound then still speaks.
  writeFileSync(KNEE_PATH, JSON.stringify({ sessions: {
    [KEY]: { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0 + 15 * MIN, quietSinceMs: null, lastSeenMs: T0 + 4 * G },
  } }));
  restart(T0 + 25 * MIN);
  const a = tick(T0 + 25 * MIN, PLAT_HI)!;
  assert.notEqual(a.annunciate, false, 'balancing, but the episode is 25 minutes old');
  assert.match(a.detail, /First reached the critical line 25 minutes ago\./);
});

/* ── (c) the outage, never the onset's age, decides ───────────────────────────────────────── */

/** A session whose critical has cleared: a 3-minute crossing, then 5 minutes of 45 mV readings
 *  (the onset retires after the dwell; v1.187.1 — the critical-line clock ends on the reading at
 *  +8 min, an unbroken VDIFF_KNEE_RELAX_MS under the line). Returns the last-reading time the file
 *  holds. */
function sessionThenSubLine(): number {
  for (let t = 0; t < 3 * MIN; t += TICK_MS) assert.equal(tick(T0 + t, BAL_HI)!.mutedBy, 'balancing');
  for (let t = 3 * MIN; t <= 8 * MIN; t += TICK_MS) tick(T0 + t, BAL_LO);
  assert.equal(getAlertOnset(CRIT_ID), undefined, 'no onset on record: only the file carries the session');
  const s = onFile()[KEY];
  assert.equal(s.graceFromMs, T0);
  assert.equal(s.critSinceMs, null);
  return s.lastSeenMs;
}

test('★★★ (c) an outage longer than the carry drops the session: the next day\'s benign knee keeps its graces', () => {
  for (let t = 0; t < 1000_000; t += TICK_MS) assert.equal(tick(T0 + t, BAL_HI)!.annunciate, false);
  assert.equal(onFile()[KEY].graceFromMs, T0, 'the session is on file');
  const back = T0 + 24 * 60 * MIN - 10 * MIN; // 14:50 the next day
  restart(back);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /restored 0 knee session\(s\).*; 1 dropped \(last reading more than 60 minutes before the restart\)/);
  for (let t = 0; t < 5 * MIN; t += TICK_MS) assert.equal(tick(back + t, { vd: 10, soc: 99, bal: 0, in: 0 }), undefined);
  assert.equal(onFile()[KEY], undefined, 'and the file forgets it');
  for (let t = 5 * MIN; t < 9 * MIN; t += TICK_MS) assert.equal(tick(back + t, BAL_HI)!.mutedBy, 'balancing', `+${t / SEC}s`);
  for (let t = 9 * MIN; t < 11 * MIN; t += TICK_MS) {
    assert.equal(tick(back + t, { vd: 93, soc: 100, bal: 0, in: 0 })!.mutedBy, 'end-of-charge', `+${t / SEC}s: the grace, earned again`);
  }
  assert.equal(tick(back + 11 * MIN, { vd: 67, soc: 100, bal: 0, in: 0 }), undefined);
});

test('★★★ (c) an outage inside the carry keeps the session, though the onset is long retired', () => {
  sessionThenSubLine();
  const lastReading = T0 + 8 * MIN;
  restart(lastReading + CARRY); // exactly the in-process carry from the true last reading
  assert.match(logs[0], /restored 1 knee session/);
  assert.notEqual(tick(lastReading + CARRY, BAL_HI)!.annunciate, false, 'the session is 68 minutes old: no balancing silence');
});

test('★★ (c) the carry boundary is read from the file\'s last reading plus its grain: kept at it, dropped past it', () => {
  const p = sessionThenSubLine();
  assert.equal(p, T0 + 5 * MIN, 'the file holds the last reading (8:00) floored to its 5-minute grain');
  // The true last reading lies in [p, p + G): the latest it can have been is p + G - 1 ms.
  restart(p + G - 1 + CARRY);
  assert.match(logs[0], /restored 1 knee session/);
  assert.notEqual(tick(p + G - 1 + CARRY, BAL_HI)!.annunciate, false, 'kept: the old session bounds the balancing mute');

  fresh();
  const q = sessionThenSubLine();
  assert.equal(q, p);
  restart(q + G + CARRY);
  assert.match(logs[0], /restored 0 knee session\(s\).*1 dropped/);
  assert.equal(tick(q + G + CARRY, BAL_HI)!.mutedBy, 'balancing', 'dropped: a fresh session, as for a pack unseen that long in the process');
});

test('★★ (c) a quick restart bounds the last reading by the restart itself: an unseen pack is dropped one carry later', () => {
  sessionThenSubLine();
  const r = T0 + 8 * MIN + TICK_MS; // 20 s after the last reading
  restart(r);
  for (let t = r; t <= r + CARRY; t += TICK_MS) tick(t, null); // the Core goes dark
  assert.ok(onFile()[KEY], 'still carried at one carry from the restart');
  tick(r + CARRY + TICK_MS, null);
  assert.equal(onFile()[KEY], undefined, 'dropped one carry after the restart, as in the process');
  assert.equal(tick(r + CARRY + 2 * TICK_MS, BAL_HI)!.mutedBy, 'balancing', 'the returning pack starts a fresh session');
});

test('★★ restarts that see no reading do not walk the persisted last reading forward', () => {
  // Pack A's session; then its Core goes dark and the add-on restarts every 6 minutes while
  // another Core's critical crosses and clears, so the file is rewritten around A's entry.
  const p = sessionThenSubLine();
  const other = (t: number): Reading => (Math.floor(t / READING_MS) % 2 === 0 ? BAL_HI : BAL_LO);
  for (let r = T0 + 14 * MIN; r <= T0 + 80 * MIN; r += 6 * MIN) {
    restart(r);
    for (let t = r; t < r + 4 * MIN; t += TICK_MS) tickAll(t, { [SN]: null, [OTHER]: other(t - T0) });
    const a = onFile()[KEY];
    if (a) assert.equal(a.lastSeenMs, p, `restart at +${(r - T0) / MIN} min: A's last reading is the one it had`);
  }
  assert.ok(onFile()[`${OTHER}-1`], 'the other Core\'s session was being written');
  assert.equal(onFile()[KEY], undefined, 'A is dropped once its outage outlasts the carry');
  assert.equal(tickAll(T0 + 84 * MIN, { [SN]: BAL_HI, [OTHER]: null }).find((x) => x.id === CRIT_ID)!.mutedBy, 'balancing');
});

test('★★ a different battery in the slot after a restart does not inherit the session', () => {
  sessionThenSubLine();
  restart(T0 + 30 * MIN);
  const swapped = { ...BAL_HI, packSn: 'PACK-OTHER' };
  assert.equal(tick(T0 + 30 * MIN, swapped)!.mutedBy, 'balancing', 'a fresh session for the new pack');
  // …while the same battery keeps it.
  fresh();
  sessionThenSubLine();
  restart(T0 + 30 * MIN);
  assert.notEqual(tick(T0 + 30 * MIN, BAL_HI)!.annunciate, false);
});

test('★★ a persisted clock ahead of now (a clock step) is clamped to the restart', () => {
  const r = T0 + 2 * 60 * MIN;
  for (const [label, entry, readings] of [
    // The session clock: a balancing spread whose 6-minute dips end each episode (hi / lo / lo, so
    // only the session bounds it — v1.187.1 log review) is bounded 20 min from the restart.
    ['graceFromMs', { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: r + 60 * MIN, lastSeenMs: r - MIN },
      (t: number) => (Math.floor(t / READING_MS) % 3 === 0 ? BAL_HI : BAL_LO)],
    // The critical-line clock: a steady balancing spread is bounded 20 min from the restart.
    ['critSinceMs', { packSn: `PACK-${SN}`, critSinceMs: r + 60 * MIN, graceFromMs: null, lastSeenMs: r - MIN },
      () => ({ vd: 110, soc: 99, bal: 1 as const, in: 0 })],
  ] as const) {
    fresh();
    writeFileSync(KNEE_PATH, JSON.stringify({ sessions: { [KEY]: entry } }));
    restart(r);
    let loudAt: number | null = null;
    for (let t = 0; t <= 24 * MIN; t += TICK_MS) {
      const a = tick(r + t, readings(t));
      if (a && a.annunciate !== false && loudAt == null) loudAt = t;
    }
    assert.ok(loudAt != null && loudAt <= VDIFF_KNEE_MAX_MUTE_MS + READING_MS, `${label}: announced within the bound from the restart (at ${loudAt})`);
  }
});

test('★ a restore leaves a pack the process already holds alone', () => {
  // In memory: a session that started a minute ago. On file: an older one.
  tick(T0, BAL_HI);
  writeFileSync(KNEE_PATH, JSON.stringify({ sessions: { [KEY]: { packSn: `PACK-${SN}`, critSinceMs: T0 - 3 * 60 * MIN, graceFromMs: T0 - 3 * 60 * MIN, lastSeenMs: T0 } } }));
  onDisk = restoreVdiffKneeSessions(KNEE_PATH, T0 + MIN, (m) => logs.push(m));
  assert.equal(tick(T0 + MIN, BAL_HI)!.mutedBy, 'balancing', 'the live session stands');
});

test('★★★ the activity evidence is never restored: the mute is re-earned from fresh readings', () => {
  // Balancing at the line, the add-on restarts 20 s later, and the BMS has stopped balancing.
  tick(T0, BAL_HI);
  assert.ok(onFile()[KEY], 'the session is on file');
  restart(T0 + TICK_MS);
  const idle = tick(T0 + TICK_MS, { vd: 95, soc: 100, bal: 0, in: 0 })!;
  assert.notEqual(idle.annunciate, false, 'the balancing seen before the restart opens no end-of-charge grace');
  // Charging at the line, the add-on restarts, and the stream now reads 0 W.
  fresh();
  tick(T0, CHG_HI);
  restart(T0 + TICK_MS);
  const stopped = tick(T0 + TICK_MS, { vd: 95, soc: 97, bal: 0, in: 0 })!;
  assert.notEqual(stopped.annunciate, false, 'the charge seen before the restart opens no charging grace');
});

/* ── (f) the rest across a restart (v1.187.1 review) ─────────────────────────────────────── */

/** A benign end-of-charge knee at 100%, `u` ms after its first crossing: balancing at 104 mV,
 *  stopped at +2 min while still at the peak, then 93 and 67 mV on the next readings, and resting
 *  at 10 mV from +9 min (the 09-29 Core 1 pack 1 shape). */
function benignKnee(u: number): Reading {
  if (u < 2 * MIN) return { vd: 104, soc: 100, bal: 1, in: 0 };
  if (u < 3 * MIN) return { vd: 104, soc: 100, bal: 0, in: 0 };
  if (u < 6 * MIN) return { vd: 93, soc: 100, bal: 0, in: 0 };
  if (u < 9 * MIN) return { vd: 67, soc: 100, bal: 0, in: 0 };
  return { vd: 10, soc: 100, bal: 0, in: 0 };
}
/** Two benign knees `gapMs` apart at T0, the add-on restarted at `restartMs` (null: never), as
 *  the ticks of each knee's critical. */
function twoKnees(gapMs: number, restartMs: number | null): { first: Alert[]; second: Alert[] } {
  const first: Alert[] = [], second: Alert[] = [];
  for (let t = 0; t < gapMs + 12 * MIN; t += TICK_MS) {
    if (t === restartMs) restart(T0 + t);
    const a = tick(T0 + t, t < gapMs ? benignKnee(t) : benignKnee(t - gapMs));
    if (a) (t < gapMs ? first : second).push(a);
  }
  return { first, second };
}

// 10: a minute into the rest, while the knee's critical-line clock still stands (v1.187.1 log
// review: it ends VDIFF_KNEE_RELAX_MS under the line), so the rest on file is coherent with it.
for (const [gap, restarts] of [[30, [null, 10, 12, 20, 25]], [35, [null, 20, 25]]] as const) {
  for (const r of restarts) {
    test(`★★★ (f) two benign knees ${gap} minutes apart stay silent — ${r == null ? 'no restart' : `the add-on restarted ${r} minutes after the first, during its rest`}`, () => {
      const { first, second } = twoKnees(gap * MIN, r == null ? null : r * MIN);
      if (r != null) assert.match(logs.join('\n'), /restored 1 knee session/);
      for (const [name, crits] of [['first', first], ['second', second]] as const) {
        assert.ok(crits.length > 0, `${name}: the knee reaches the critical line`);
        for (const a of crits) assert.equal(a.annunciate, false, `${name} knee: ${a.detail}`);
      }
      assert.ok(second.some((a) => a.mutedBy === 'end-of-charge'), 'the second knee earned its end-of-charge grace again');
    });
  }
}

test('★★★ (f) after an outage longer than 10 minutes the rest must be seen again: a second knee inside it annunciates (fail loud)', () => {
  for (let t = 0; t < 12 * MIN; t += TICK_MS) tick(T0 + t, benignKnee(t));
  assert.equal(onFile()[KEY].quietSinceMs, T0 + 9 * MIN, 'the rest is on file');
  restart(T0 + 27 * MIN); // down from +12 to +27 minutes: the file's last reading (+10) is 17 minutes old
  assert.match(logs[0], /restored 1 knee session/, 'the session itself is carried (inside the hour)');
  for (let t = 27 * MIN; t < 30 * MIN; t += TICK_MS) assert.equal(tick(T0 + t, benignKnee(t)), undefined);
  const knee2 = tick(T0 + 30 * MIN, benignKnee(0))!;
  assert.notEqual(knee2.annunciate, false, 'the rest restarted at the restart: the session from +0 still stands');
  assert.match(knee2.detail, /First reached the critical line at this top of charge 30 minutes ago\./);
});

test('★★ (f) the rest\'s outage bound is read from the file\'s own last reading: restored at 10 minutes, not a millisecond later', () => {
  for (const [label, pastMs] of [['at the bound', 0], ['1 ms past it', 1]] as const) {
    fresh();
    for (let t = 0; t <= 20 * MIN; t += TICK_MS) tick(T0 + t, benignKnee(t)); // the last reading at exactly +20
    assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: T0, quietSinceMs: T0 + 9 * MIN, lastSeenMs: T0 + 20 * MIN }, label);
    const r = T0 + 20 * MIN + G + VDIFF_KNEE_RELAX_MS + pastMs;
    restart(r);
    assert.equal(tick(r, benignKnee(15 * MIN)), undefined, label);
    const knee2 = tick(r + TICK_MS, benignKnee(0))!;
    if (pastMs === 0) assert.equal(knee2.mutedBy, 'balancing', `${label}: rested 21 minutes, the session is over and the knee starts a new one`);
    else assert.notEqual(knee2.annunciate, false, `${label}: the rest starts over at the restart, and the 30-minute session bounds the knee`);
  }
});

test('★★★ (f) a rest on file is restored only when it is one the process could have been in (a corrupt rest fails loud)', () => {
  // Restart at +30 min; the file's last reading +25 (5 minutes old: inside the rest's outage bound),
  // a top-of-charge session from T0. After the restart the pack rests at 10 mV for a minute, then a
  // balancing knee. A rest begun 20 minutes before such a reading ends the session there, and the
  // knee earns a new session's balancing mute; a rest that starts over at the restart does not.
  const r = T0 + 30 * MIN;
  const base = { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: T0, lastSeenMs: r - G };
  const run = (entry: Record<string, unknown>) => {
    fresh();
    writeFileSync(KNEE_PATH, JSON.stringify({ sessions: { [KEY]: entry } }));
    restart(r);
    assert.match(logs[0], /restored 1 knee session/);
    tick(r, { vd: 10, soc: 100, bal: 0, in: 0 });
    const quietOnFile = onFile()[KEY].quietSinceMs;
    for (let t = r + TICK_MS; t <= r + MIN; t += TICK_MS) tick(t, { vd: 10, soc: 100, bal: 0, in: 0 });
    return { quietOnFile, knee: tick(r + MIN + TICK_MS, BAL_HI)! };
  };
  // Coherent: restored, and the session ends 20 minutes into it (at +31 min).
  const ok = run({ ...base, quietSinceMs: T0 + 11 * MIN });
  assert.equal(ok.quietOnFile, T0 + 11 * MIN, 'a coherent rest is restored');
  assert.equal(ok.knee.mutedBy, 'balancing', 'rested 20 minutes: the knee starts a new session');
  // …and so is a rest that began while the knee's critical-line clock still stood.
  const during = run({ ...base, critSinceMs: T0 + 8 * MIN, quietSinceMs: T0 + 11 * MIN });
  assert.equal(during.quietOnFile, T0 + 11 * MIN);
  for (const [label, q] of [
    ['0', 0], ['negative', -5], ['before the session', T0 - MIN], ['at the session\'s first crossing', T0],
    ['20 minutes before the last reading (a rest that had already ended the session)', r - G - VDIFF_KNEE_MAX_MUTE_MS],
  ] as const) {
    const bad = run({ ...base, quietSinceMs: q });
    assert.equal(bad.quietOnFile, r, `${label}: not restored — the rest starts over at the restart`);
    assert.notEqual(bad.knee.annunciate, false, `${label}: the session from T0 still bounds the knee (fail loud)`);
    assert.match(bad.knee.detail, /First reached the critical line at this top of charge 31 minutes ago\./, label);
  }
  // Before (or at) the session's first crossing, inside the age bound: a crossing breaks a rest.
  for (const q of [T0 + 10 * MIN, T0 + 15 * MIN]) {
    const before = run({ ...base, graceFromMs: T0 + 15 * MIN, quietSinceMs: q });
    assert.equal(before.quietOnFile, r, `a rest from +${(q - T0) / MIN} min in a session from +15 min is not restored`);
  }
  // Before the standing episode's first crossing (a crossing would have broken it), or with no session.
  for (const c of [T0 + 12 * MIN, T0 + 11 * MIN]) {
    const early = run({ ...base, critSinceMs: c, quietSinceMs: T0 + 11 * MIN });
    assert.equal(early.quietOnFile, r, `a rest from +11 min under an episode from +${(c - T0) / MIN} min is not restored`);
  }
  const noSession = run({ ...base, graceFromMs: null, critSinceMs: T0 + 2 * MIN, quietSinceMs: T0 + 11 * MIN });
  assert.equal(noSession.quietOnFile, r, 'a rest with no session is not restored');
});

test('★ (f) a restored rest is still lost to a tick with no reading after the restart (a rest must be seen)', () => {
  for (let t = 0; t < 12 * MIN; t += TICK_MS) tick(T0 + t, benignKnee(t));
  restart(T0 + 12 * MIN);
  tick(T0 + 12 * MIN, null); // the Core is dark for one tick
  assert.equal(onFile()[KEY].quietSinceMs, null, 'the cleared rest is written');
  for (let t = 12 * MIN + TICK_MS; t < 30 * MIN; t += TICK_MS) tick(T0 + t, benignKnee(t));
  assert.notEqual(tick(T0 + 30 * MIN, benignKnee(0))!.annunciate, false);
});

/* ── (d) a missing, unreadable or malformed file ─────────────────────────────────────────── */

/** The 08-22/23 fault class: a 110 mV spread the BMS keeps balancing at 99%, past the 20-minute
 *  bound (its onset persisted), then the add-on restarts at minute 21. */
function standingBalancedFault(): Reading {
  const r: Reading = { vd: 110, soc: 99, bal: 1, in: 0 };
  for (let t = 0; t < VDIFF_KNEE_MAX_MUTE_MS; t += TICK_MS) assert.equal(tick(T0 + t, r)!.annunciate, false);
  assert.notEqual(tick(T0 + VDIFF_KNEE_MAX_MUTE_MS, r)!.annunciate, false);
  assert.equal(getAlertOnset(CRIT_ID), T0);
  return r;
}

test('★★★ (d) a missing, unreadable or malformed file is ignored with one log line; the onset seed still fails loud', () => {
  const cases: Array<[string, string | null, RegExp]> = [
    ['missing', null, /^cell spread: no knee-session state at .*vdiff-knee-state\.json — each pack starts from its standing critical's persisted onset$/],
    ['unreadable', '{"sessions": {', /^cell spread: knee-session state at .* is unreadable \(.+\) — ignored; each pack starts from/],
    ['not a record', '[1, 2, 3]', /^cell spread: knee-session state at .* is malformed \(no sessions record\) — ignored;/],
    ['no sessions', '{"firedDay": "2026-09-29"}', /is malformed \(no sessions record\)/],
    ['sessions not a map', '{"sessions": [1]}', /is malformed \(no sessions record\)/],
    ['null', 'null', /is malformed \(no sessions record\)/],
  ];
  for (const [label, body, re] of cases) {
    fresh();
    const r = standingBalancedFault();
    if (body == null) rmSync(KNEE_PATH, { force: true });
    else writeFileSync(KNEE_PATH, body);
    assert.doesNotThrow(() => restart(T0 + 21 * MIN), label);
    assert.equal(logs.length, 1, `${label}: one log line`);
    assert.match(logs[0], re, label);
    assert.deepEqual(onDisk, {}, `${label}: nothing restored`);
    const back = tick(T0 + 21 * MIN, r)!;
    assert.notEqual(back.annunciate, false, `${label}: the onset seed keeps the critical loud`);
    assert.match(back.detail, /First reached the critical line 21 minutes ago\./, label);
  }
});

test('★★★ (d) a malformed ENTRY is skipped and counted in the one line; that pack falls back to the onset seed', () => {
  const bad: Array<[string, unknown]> = [
    ['clocks not numbers', { packSn: `PACK-${SN}`, critSinceMs: 'soon', graceFromMs: 'soon', lastSeenMs: T0 + 20 * MIN }],
    ['no clock to carry', { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: null, lastSeenMs: T0 + 20 * MIN }],
    ['serial not a string', { packSn: 7, critSinceMs: T0, graceFromMs: T0, lastSeenMs: T0 + 20 * MIN }],
    ['no last reading', { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, lastSeenMs: 'now' }],
    ['rest not a number', { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: 'soon', lastSeenMs: T0 + 20 * MIN }],
    ['not an object', 42],
  ];
  for (const [label, entry] of bad) {
    fresh();
    const r = standingBalancedFault();
    writeFileSync(KNEE_PATH, JSON.stringify({ sessions: { [KEY]: entry } }));
    restart(T0 + 21 * MIN);
    assert.equal(logs.length, 1, label);
    assert.match(logs[0], /^cell spread: restored 0 knee session\(s\) from .*; 1 malformed entry ignored$/, label);
    assert.notEqual(tick(T0 + 21 * MIN, r)!.annunciate, false, `${label}: the onset seed keeps the critical loud`);
  }
});

/* ── (e) writes only on change ───────────────────────────────────────────────────────────── */

test('★★★ (e) the file is written only when a persisted value changes — never on a tick that changed nothing', () => {
  const SENTINEL = 'untouched';
  assert.equal(T0 % G, 0, 'T0 starts a grain');
  tickAll(T0, { [SN]: BAL_HI, [OTHER]: { vd: 10, soc: 100, bal: 0, in: 0 } });
  assert.deepEqual(onFile(), { [KEY]: { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: null, lastSeenMs: T0 } },
    'the session is written on the tick it starts; a pack holding no clock is not written');
  writeFileSync(KNEE_PATH, SENTINEL);
  // The reading clock moves, nothing else: no write while it stays inside the file's grain.
  for (let t = TICK_MS; t < G; t += TICK_MS) tick(T0 + t, BAL_HI);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'no write per tick');
  // The first reading in the next grain: the last reading is re-written, floored to the grain.
  tick(T0 + G, BAL_HI);
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: null, lastSeenMs: T0 + G });
  writeFileSync(KNEE_PATH, SENTINEL);
  tick(T0 + G + TICK_MS, BAL_HI);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL);
  // A clock changes (the spread falls under 50 mV: the rest starts; v1.187.1 — the critical-line
  // clock stands until an unbroken VDIFF_KNEE_RELAX_MS under the line): written.
  tick(T0 + G + 2 * TICK_MS, BAL_LO);
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: T0 + G + 2 * TICK_MS, lastSeenMs: T0 + G },
    'the clock changes are written; the last reading keeps its grain');
  writeFileSync(KNEE_PATH, SENTINEL);
  for (let t = G + 3 * TICK_MS; t < G + 10 * TICK_MS; t += TICK_MS) tick(T0 + t, BAL_LO);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'nothing changed: no write');
  // The pack reads 90%, on the plateau below the top of charge: v1.187.2 — the session and the
  // rest run across the plateau, so nothing persisted changes and nothing is written…
  tick(T0 + G + 10 * TICK_MS, { vd: 10, soc: 90, bal: 0, in: 0 });
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'the session stands at 90%: no write');
  for (let t = G + 11 * TICK_MS; t < G + 17 * TICK_MS; t += TICK_MS) tick(T0 + t, { vd: 10, soc: 90, bal: 0, in: 0 });
  assert.equal(onFile()[KEY].critSinceMs, T0, 'the next grain was written (T0 + 2G); the critical-line clock stands');
  // …until VDIFF_KNEE_RELAX_MS under the line: the critical-line clock ends and is written.
  tick(T0 + G + 17 * TICK_MS, { vd: 10, soc: 90, bal: 0, in: 0 });
  assert.deepEqual(onFile(), { [KEY]: { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: T0, quietSinceMs: T0 + G + 2 * TICK_MS, lastSeenMs: T0 + 2 * G } });
  // The pack reads below the plateau: the session and the rest end, no clock is left, and the
  // entry is removed.
  tick(T0 + G + 18 * TICK_MS, { vd: 10, soc: 84, bal: 0, in: 0 });
  assert.deepEqual(onFile(), {});
  writeFileSync(KNEE_PATH, SENTINEL);
  for (let t = G + 19 * TICK_MS; t < G + 27 * TICK_MS; t += TICK_MS) tick(T0 + t, { vd: 10, soc: 84, bal: 0, in: 0 });
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'no session, nothing to write');
});

test('★★★ (e) the rest alone is a persisted change: its start and its break are each written on their tick', () => {
  // Inside one grain, so the last reading never changes the file here.
  tick(T0, BAL_HI);
  tick(T0 + TICK_MS, BAL_LO); // the rest starts (the critical-line clock stands: one reading under the line)
  assert.equal(onFile()[KEY].quietSinceMs, T0 + TICK_MS);
  const SENTINEL = 'untouched';
  writeFileSync(KNEE_PATH, SENTINEL);
  // 60 mV breaks the rest; nothing else changes (the critical-line clock stands under the plateau line).
  tick(T0 + 2 * TICK_MS, { vd: 60, soc: 100, bal: 0, in: 0 });
  assert.notEqual(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'the broken rest is written');
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, quietSinceMs: null, lastSeenMs: T0 });
  writeFileSync(KNEE_PATH, SENTINEL);
  // Back under 50 mV: a new rest starts; nothing else changes.
  tick(T0 + 3 * TICK_MS, BAL_LO);
  assert.notEqual(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'the new rest is written');
  assert.equal(onFile()[KEY].quietSinceMs, T0 + 3 * TICK_MS);
});

test('★★ (e) a serial that arrives after the session started is written on that tick, and binds the session across a restart', () => {
  tick(T0, { ...BAL_HI, packSn: null }); // the BMS has not reported the pack serial yet
  assert.equal(onFile()[KEY].packSn, null);
  const SENTINEL = 'untouched';
  writeFileSync(KNEE_PATH, SENTINEL);
  tick(T0 + TICK_MS, BAL_HI); // the serial arrives; no clock changes, same grain
  assert.notEqual(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'the serial alone is a persisted change');
  assert.equal(onFile()[KEY].packSn, `PACK-${SN}`);
  for (let t = 2 * TICK_MS; t < 3 * MIN; t += TICK_MS) tick(T0 + t, BAL_LO);
  // A different battery in the slot after the restart: the written serial tells it apart.
  restart(T0 + 30 * MIN);
  assert.equal(tick(T0 + 30 * MIN, { ...BAL_HI, packSn: 'PACK-OTHER' })!.mutedBy, 'balancing', 'a fresh session for the new pack');
});

test('★★ (e) one write per grain however many packs hold a session: the grains of every pack turn on the same tick', () => {
  // Four Cores, each crossing the line a minute after the last, then holding 60 mV at 100%: a
  // session each, no rest. A per-pack "moved past the grain" rule let them drift out of phase.
  const CORES = ['DPU-A', 'DPU-B', 'DPU-C', 'DPU-D'];
  const at = (t: number): Readings => Object.fromEntries(CORES.map((sn, i) => [sn,
    t < i * MIN ? { vd: 10, soc: 100, bal: 0 as const, in: 0 }
      : t < i * MIN + 2 * MIN ? BAL_HI
      : { vd: 60, soc: 100, bal: 0 as const, in: 0 }]));
  for (let t = 0; t < 15 * MIN; t += TICK_MS) tickAll(T0 + t, at(t));
  assert.equal(Object.keys(onFile()).length, 4, 'four sessions on file');
  writes = 0;
  for (let t = 15 * MIN; t < 75 * MIN; t += TICK_MS) tickAll(T0 + t, at(t));
  assert.equal(writes, 60 * MIN / G, `one write per ${G / MIN}-minute grain over the hour, for four packs (got ${writes})`);
  for (const sn of CORES) assert.equal(onFile()[`${sn}-1`].lastSeenMs, T0 + 70 * MIN);
});

test('★ (e) a restart that changes nothing writes nothing; a failed write is retried on the next tick', () => {
  sessionThenSubLine();
  const before = readFileSync(KNEE_PATH, 'utf8');
  restart(T0 + 8 * MIN + TICK_MS);
  tick(T0 + 8 * MIN + TICK_MS, BAL_LO); // the same reading, in the same grain: nothing it holds changes
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), before);
  // An unwritable path: the write fails, nothing throws, and the change is still owed.
  writeFileSync(resolve(ROOT, 'a-file'), 'x');
  const blocked = resolve(ROOT, 'a-file', 'vdiff-knee-state.json'); // its directory is a file
  let disk = persistVdiffKneeSessions(blocked, {});
  assert.deepEqual(disk, {}, 'the failed write leaves the on-disk view as it was');
  assert.ok(!existsSync(blocked));
  disk = persistVdiffKneeSessions(KNEE_PATH, {});
  assert.ok(disk[KEY], 'retried against the unchanged view, it is written');
});
