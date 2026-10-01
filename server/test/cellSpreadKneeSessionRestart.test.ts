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
  VDIFF_KNEE_MAX_MUTE_MS, VDIFF_KNEE_GAP_CARRY_MS, VDIFF_KNEE_SEEN_PERSIST_MS,
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

interface Reading { vd: number; soc: number; bal: 0 | 1; in: number; packSn?: string }
/** A reading per device; null = the device is offline (its packs produce no reading). */
type Readings = Record<string, Reading | null>;
function devices(rs: Readings): Record<string, DeviceSnapshot> {
  const out: Record<string, DeviceSnapshot> = {};
  for (const [sn, r] of Object.entries(rs)) {
    const pack = r && {
      num: 1, soc: r.soc, packSn: r.packSn ?? `PACK-${sn}`, inputWatts: r.in, outputWatts: 0,
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
  onDisk = persistVdiffKneeSessions(KNEE_PATH, onDisk);
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

/* ── (c) the outage, never the onset's age, decides ───────────────────────────────────────── */

/** A session whose critical has cleared: a 3-minute crossing, then 5 minutes of 45 mV readings
 *  (the onset retires after the dwell). Returns the last-reading time the file holds. */
function sessionThenSubLine(): number {
  for (let t = 0; t < 3 * MIN; t += TICK_MS) assert.equal(tick(T0 + t, BAL_HI)!.mutedBy, 'balancing');
  for (let t = 3 * MIN; t < 8 * MIN; t += TICK_MS) tick(T0 + t, BAL_LO);
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
  const lastReading = T0 + 8 * MIN - TICK_MS;
  restart(lastReading + CARRY); // exactly the in-process carry from the true last reading
  assert.match(logs[0], /restored 1 knee session/);
  assert.notEqual(tick(lastReading + CARRY, BAL_HI)!.annunciate, false, 'the session is 68 minutes old: no balancing silence');
});

test('★★ (c) the carry boundary is read from the file\'s last reading plus its grain: kept at it, dropped past it', () => {
  const p = sessionThenSubLine();
  assert.ok(p < T0 + 8 * MIN - TICK_MS, 'the file\'s last reading lags the true one (the grain)');
  restart(p + G + CARRY);
  assert.match(logs[0], /restored 1 knee session/);
  assert.notEqual(tick(p + G + CARRY, BAL_HI)!.annunciate, false, 'kept: the old session bounds the balancing mute');

  fresh();
  const q = sessionThenSubLine();
  assert.equal(q, p);
  restart(q + G + CARRY + 1);
  assert.match(logs[0], /restored 0 knee session\(s\).*1 dropped/);
  assert.equal(tick(q + G + CARRY + 1, BAL_HI)!.mutedBy, 'balancing', 'dropped: a fresh session, as for a pack unseen that long in the process');
});

test('★★ (c) a quick restart bounds the last reading by the restart itself: an unseen pack is dropped one carry later', () => {
  sessionThenSubLine();
  const r = T0 + 8 * MIN; // 20 s after the last reading
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
    // The session clock: a balancing spread on alternate readings is bounded 20 min from the restart.
    ['graceFromMs', { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: r + 60 * MIN, lastSeenMs: r - MIN },
      (t: number) => (Math.floor(t / READING_MS) % 2 === 0 ? BAL_HI : BAL_LO)],
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
  tickAll(T0, { [SN]: BAL_HI, [OTHER]: { vd: 10, soc: 100, bal: 0, in: 0 } });
  assert.deepEqual(onFile(), { [KEY]: { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, lastSeenMs: T0 } },
    'the session is written on the tick it starts; a pack holding no clock is not written');
  writeFileSync(KNEE_PATH, SENTINEL);
  // The reading clock moves, nothing else: no write while it is within the grain of the file.
  for (let t = TICK_MS; t <= G; t += TICK_MS) tick(T0 + t, BAL_HI);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'no write per tick');
  // Past the grain: the last reading is re-written.
  tick(T0 + G + TICK_MS, BAL_HI);
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: T0, graceFromMs: T0, lastSeenMs: T0 + G + TICK_MS });
  writeFileSync(KNEE_PATH, SENTINEL);
  tick(T0 + G + 2 * TICK_MS, BAL_HI);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL);
  // A clock changes (the spread falls under 50 mV: the critical-line clock ends): written.
  tick(T0 + G + 3 * TICK_MS, BAL_LO);
  assert.deepEqual(onFile()[KEY], { packSn: `PACK-${SN}`, critSinceMs: null, graceFromMs: T0, lastSeenMs: T0 + G + TICK_MS },
    'the clock change is written; the last reading keeps its grain');
  writeFileSync(KNEE_PATH, SENTINEL);
  for (let t = G + 4 * TICK_MS; t < G + 10 * TICK_MS; t += TICK_MS) tick(T0 + t, BAL_LO);
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'nothing changed: no write');
  // The session ends (the pack read below the top of charge): the entry is removed.
  tick(T0 + G + 10 * TICK_MS, { vd: 10, soc: 90, bal: 0, in: 0 });
  assert.deepEqual(onFile(), {});
  writeFileSync(KNEE_PATH, SENTINEL);
  for (let t = G + 11 * TICK_MS; t < G + 20 * TICK_MS; t += TICK_MS) tick(T0 + t, { vd: 10, soc: 90, bal: 0, in: 0 });
  assert.equal(readFileSync(KNEE_PATH, 'utf8'), SENTINEL, 'no session, nothing to write');
});

test('★ (e) a restart that changes nothing writes nothing; a failed write is retried on the next tick', () => {
  sessionThenSubLine();
  const before = readFileSync(KNEE_PATH, 'utf8');
  restart(T0 + 8 * MIN);
  tick(T0 + 8 * MIN, null); // the Core is dark: nothing it holds changes
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
