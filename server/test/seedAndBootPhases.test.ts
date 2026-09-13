import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.154.0 — the per-device gap seed and the boot-phases line, DRIVEN rather than
 * grepped.
 *
 * v1.152.0 seeded the per-device gap clocks from `samples` so a blackout spanning a
 * restart would be seen. A log review of its own output found three defects in it:
 *  - it excluded benchSpareSns() before index.ts had published the roster, so the
 *    stale SPARE_DPU_SNS literal decided — dropping Core 5, a wired home Core;
 *  - its GROUP BY visited every index entry: 5.8 s of blocked boot, emitted after
 *    the boot-phases line, which is how v1.153.0 came to call ANALYZE "99.99%" of a
 *    boot it was 62.6% of;
 *  - a seeded clock is a device's last sample, so any add-on outage over 6 h would
 *    file every device as a per-device blackout.
 *
 * Hermetic: a fresh DB_PATH captured at import (config.ts reads it once), shared by
 * every recorder here exactly as restarts share /data/ecoflow.db. Wall and monotonic
 * clocks are mocked per test so hours can pass without waiting for them.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-seed-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder, seededDeviceDarkMs, fleetDarkOverlapMs, SEED_SQL } = await import('../src/recorder.js');
const { SPARE_DPU_SNS, setLastKnownHomeRoster, resetLastKnownHomeRoster } = await import('../src/shp2Membership.js');

const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');
const H = 3_600_000;
const M = 60_000;

function makeStore() {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: 0, devices: {} };
  ee.get = () => ee.snap;
  return ee;
}
function boot() {
  const lines: string[] = [];
  const rec = createRecorder(makeStore() as any, (m: string) => lines.push(m));
  return { rec, lines };
}

// Create the schema once, as a first boot would.
boot().rec.close();

type Row = [ts: number, sn: string, metric: string, value: number];
function seedDb(rows: Row[]) {
  if (existsSync(GAPS_PATH)) unlinkSync(GAPS_PATH);
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('DELETE FROM samples');
    const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
    for (const r of rows) ins.run(...r);
  } finally {
    db.close();
  }
}

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return c;
}

let v = 0;
const dpu = (...sns: string[]) => ({
  generatedAt: 0,
  devices: Object.fromEntries(sns.map((sn) => [sn, { sn, projection: { kind: 'dpu', soc: 20 + (v++ % 60), packs: [] } }])),
}) as any;
const deviceGaps = (rec: { telemetryGaps: () => any[] }, sn: string) => rec.telemetryGaps().filter((g) => g.sn === sn);

/* ── the outage guard ───────────────────────────────────────────────── */

test('★ an add-on outage longer than 6 h does NOT file every device as dark', (t) => {
  const T = Date.now();
  seedDb([[T - 7 * H, 'CORE_A', 'soc', 50], [T - 7 * H + 30_000, 'CORE_B', 'soc', 51]]);
  clocks(t, T);
  const { rec } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));  // the fleet is back; CORE_B has not reported yet
    assert.ok(rec.telemetryGaps().some((g) => g.restartSpanning), 'precondition: the outage is ledgered — as a FLEET gap');
    assert.deepEqual(deviceGaps(rec, 'CORE_B'), [], 'CORE_B was dark only while the add-on was; that is not a device blackout');
  } finally {
    rec.close();
  }
});

test('★ a device dark BEFORE the outage carries its dark time straight through it', (t) => {
  const T = Date.now();
  seedDb([[T - 7 * H, 'CORE_A', 'soc', 50], [T - 37 * H, 'CORE_B', 'soc', 51]]);
  clocks(t, T);
  const { rec, lines } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));
    const [g] = deviceGaps(rec, 'CORE_B');
    assert.ok(g, 'thirty hours dark before the add-on went down is a blackout');
    assert.equal(g.startMs, T - 37 * H, "the gap starts at the device's own last sample");
    assert.ok(g.endMs >= g.startMs);
    assert.deepEqual(deviceGaps(rec, 'CORE_A'), []);
    assert.ok(lines.some((l) => l.includes('DEVICE TELEMETRY GAP')));
  } finally {
    rec.close();
  }
});

test('★ post-boot dark time runs on the MONOTONIC clock, from the first home write', (t) => {
  const T = Date.now();
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - 2 * M, 'CORE_B', 'soc', 51]]);
  const c = clocks(t, T);
  const { rec } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));
    c.wall += 8 * H; c.mono += 10 * M;  // NTP steps an RTC-less Pi forward 8 h; 10 min really passed
    rec.insertSnapshot(dpu('CORE_A'));
    assert.deepEqual(deviceGaps(rec, 'CORE_B'), [], 'a clock step is not eight hours of darkness');
    c.wall += 6 * H; c.mono += 6 * H;
    rec.insertSnapshot(dpu('CORE_A'));
    assert.equal(deviceGaps(rec, 'CORE_B').length, 1, 'six real hours of silence after the fleet returned IS a blackout');
  } finally {
    rec.close();
  }
});

test('★ a device that has reported since boot is measured from ITS OWN write, not from the boot', (t) => {
  const T = Date.now();
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - M, 'CORE_B', 'soc', 51]]);
  const c = clocks(t, T);
  const { rec } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));
    c.wall += 3 * H; c.mono += 3 * H;
    rec.insertSnapshot(dpu('CORE_A', 'CORE_B'));
    c.wall += 4 * H; c.mono += 4 * H;
    rec.insertSnapshot(dpu('CORE_A'));
    assert.deepEqual(deviceGaps(rec, 'CORE_B'), [], 'four hours since CORE_B last wrote is under the 6 h threshold');
  } finally {
    rec.close();
  }
});

test('a boot clock BEHIND every sample cannot write a gap that ends before it starts', (t) => {
  const T = Date.now();
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - 30 * H, 'CORE_B', 'soc', 51]]);
  clocks(t, T - 31 * H);  // RTC-less Pi before NTP — the restart probe's `defer` case
  const { rec } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));
    const [g] = deviceGaps(rec, 'CORE_B');
    assert.ok(g, 'thirty hours dark relative to the fleet is still a blackout');
    assert.ok(g.endMs >= g.startMs && g.durationMs > 0, `endMs ${g.endMs} must not precede startMs ${g.startMs}`);
  } finally {
    rec.close();
  }
});

test('★ an intervening short boot does not charge a silent device with the outage before it', (t) => {
  // v1.154.0 review. The fleet anchor is the newest home sample from ANY device, so a
  // few-minute boot in which CORE_A wrote (and CORE_B, say a failing fetch, did not)
  // moves it past the ten-hour outage. Charging anchor − seed then files CORE_B as
  // dark for ten hours it was never observed.
  const T = Date.now();
  seedDb([[T - 10 * H, 'CORE_A', 'soc', 50], [T - 10 * H, 'CORE_B', 'soc', 51]]);
  const c = clocks(t, T - 5 * M);
  const first = boot();
  first.rec.insertSnapshot(dpu('CORE_A'));
  assert.ok(first.rec.telemetryGaps().some((g) => g.restartSpanning), 'precondition: boot 1 ledgered the outage');
  first.rec.close();
  c.wall = T; c.mono += 5 * M;  // a routine restart five minutes later
  const second = boot();
  try {
    second.rec.insertSnapshot(dpu('CORE_A'));
    assert.deepEqual(deviceGaps(second.rec, 'CORE_B'), [], 'CORE_B was observed silent for minutes, not ten hours');
  } finally {
    second.rec.close();
  }
});

test("a device's OWN earlier per-device gap is not discounted — only fleet-dark windows are", (t) => {
  const T = Date.now();
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - 12 * H, 'CORE_B', 'soc', 51]]);
  writeFileSync(GAPS_PATH, JSON.stringify([
    { sn: 'CORE_B', startMs: T - 12 * H, endMs: T - 5 * H, durationMs: 7 * H, detectedAt: T - 5 * H },
  ]));
  clocks(t, T);
  const { rec } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));
    const gaps = deviceGaps(rec, 'CORE_B');
    assert.equal(gaps.length, 1, 'one record for one blackout');
    assert.equal(gaps[0].startMs, T - 12 * H);
    assert.ok(gaps[0].endMs >= T - M, `still dark, so the record is EXTENDED to this detection (endMs ${gaps[0].endMs})`);
  } finally {
    rec.close();
  }
});

/* ── what gets seeded ───────────────────────────────────────────────── */

test('★★ a wired Core still named in the stale spare literal IS seeded — the roster decides at sweep time', (t) => {
  const WIRED = [...SPARE_DPU_SNS][0];
  assert.ok(WIRED, 'precondition: the literal names at least one SN');
  const T = Date.now();
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - 30 * H, WIRED, 'soc', 51]]);
  clocks(t, T);
  resetLastKnownHomeRoster();  // nothing published yet, as the seed must assume
  const { rec, lines } = boot();
  try {
    assert.ok(lines.some((l) => /seeded per-device gap clocks for 2 SN\(s\)/.test(l)),
      lines.filter((l) => l.includes('seeded')).join(' | ') || 'no seed line');
    setLastKnownHomeRoster(new Set(['CORE_A', WIRED]));  // the SHP2 reports it as a home source
    rec.insertSnapshot(dpu('CORE_A'));
    assert.equal(deviceGaps(rec, WIRED).length, 1, 'a wired Core dark for 30 h must be ledgered');
  } finally {
    rec.close();
    resetLastKnownHomeRoster();
  }
});

test('a bench spare is seeded but never swept', (t) => {
  const BENCH = [...SPARE_DPU_SNS][0];
  const T = Date.now();
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - 30 * H, BENCH, 'soc', 51]]);
  clocks(t, T);
  const { rec } = boot();
  try {
    setLastKnownHomeRoster(new Set(['CORE_A']));  // the SHP2 does not report it: bench hardware
    rec.insertSnapshot(dpu('CORE_A'));
    assert.deepEqual(deviceGaps(rec, BENCH), [], 'a bench spare is dark BY DESIGN');
  } finally {
    rec.close();
    resetLastKnownHomeRoster();
  }
});

test('synthetic SNs are never seeded, so never swept', (t) => {
  const T = Date.now();
  seedDb([
    [T - M, 'CORE_A', 'soc', 50],
    [T - 30 * H, 'weather', 'ghi_wm2', 400],
    [T - 30 * H, 'forecast', 'pv_next24_wh', 1],
    [T - 30 * H, 'night_charge', 'plan_kwh', 1],
  ]);
  clocks(t, T);
  const { rec, lines } = boot();
  try {
    assert.ok(lines.some((l) => /seeded per-device gap clocks for 1 SN\(s\)/.test(l)));
    rec.insertSnapshot(dpu('CORE_A'));
    for (const sn of ['weather', 'forecast', 'night_charge']) assert.deepEqual(deviceGaps(rec, sn), [], sn);
  } finally {
    rec.close();
  }
});

test("a seeded clock is the NEWEST sample across all of an SN's metrics", (t) => {
  const T = Date.now();
  // 'ac_in' sorts before 'soc', so a seed that stopped at the first metric would read 30 h.
  seedDb([[T - M, 'CORE_A', 'soc', 50], [T - 30 * H, 'CORE_B', 'ac_in', 0], [T - 2 * M, 'CORE_B', 'soc', 51]]);
  clocks(t, T);
  const { rec } = boot();
  try {
    rec.insertSnapshot(dpu('CORE_A'));
    assert.deepEqual(deviceGaps(rec, 'CORE_B'), []);
  } finally {
    rec.close();
  }
});

test("seededDeviceDarkMs — the outage is nobody's; before and after it are the device's", () => {
  assert.equal(seededDeviceDarkMs(1_000, 1_000, 0), 0, 'last to report when the fleet went down, nothing since');
  assert.equal(seededDeviceDarkMs(1_000, 31 * H + 1_000, 0), 31 * H, 'dark before the outage carries through');
  assert.equal(seededDeviceDarkMs(5_000, 1_000, 2 * H), 2 * H, 'a seed newer than the anchor contributes nothing');
  assert.equal(seededDeviceDarkMs(1_000, null, 3 * H), 3 * H, 'no anchor: only what this process observed');
  assert.equal(seededDeviceDarkMs(1_000, 1_000, -5), 0, 'a negative monotonic delta is clamped');
  assert.equal(seededDeviceDarkMs(0, 10 * H, 0, [{ startMs: 1 * H, endMs: 8 * H }]), 3 * H,
    'a fleet-dark window between seed and anchor is subtracted');
});

test('fleetDarkOverlapMs — the UNION of the windows, clipped to the span', () => {
  assert.equal(fleetDarkOverlapMs([], 0, 10), 0);
  assert.equal(fleetDarkOverlapMs([{ startMs: 2, endMs: 5 }], 0, 10), 3);
  assert.equal(fleetDarkOverlapMs([{ startMs: 2, endMs: 5 }, { startMs: 4, endMs: 8 }], 0, 10), 6, 'overlapping windows count once');
  assert.equal(fleetDarkOverlapMs([{ startMs: -5, endMs: 3 }, { startMs: 9, endMs: 20 }], 0, 10), 4, 'clipped at both ends');
  assert.equal(fleetDarkOverlapMs([{ startMs: 6, endMs: 7 }, { startMs: 1, endMs: 2 }], 0, 10), 2, 'input order does not matter');
  assert.equal(fleetDarkOverlapMs([{ startMs: 1, endMs: 9 }, { startMs: 2, endMs: 3 }], 0, 10), 8, 'a contained window adds nothing');
});

test('★ every seed statement is an index SEARCH — the cost follows series, not rows', () => {
  // The 1.152.0 seed was a GROUP BY that visited every index entry: 5.8 s per boot.
  const db = new DatabaseSync(DB_PATH);
  try {
    for (const [name, sql] of Object.entries(SEED_SQL)) {
      const params = (sql.match(/\?/g) ?? []).map(() => 'x');
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
      assert.ok(plan.length > 0, `${name}: no plan`);
      for (const row of plan) {
        assert.match(row.detail, /^SEARCH samples USING COVERING INDEX idx_samples_sn_metric_ts/, `${name}: ${row.detail}`);
      }
    }
  } finally {
    db.close();
  }
});

/* ── the boot-phases line ───────────────────────────────────────────── */

test('★ the boot-phases line comes AFTER the seed, is the only one, and names every phase', () => {
  seedDb([[Date.now() - M, 'CORE_A', 'soc', 50]]);
  const { rec, lines } = boot();
  rec.close();
  const seedIdx = lines.findIndex((l) => l.startsWith('recorder: seeded per-device gap clocks'));
  const phaseLines = lines.filter((l) => l.startsWith('recorder: boot phases — '));
  const phaseIdx = lines.findIndex((l) => l.startsWith('recorder: boot phases — '));
  assert.ok(seedIdx >= 0, 'the seed logged');
  assert.equal(phaseLines.length, 1, `exactly one boot-phases line, got: ${phaseLines.join(' | ')}`);
  assert.ok(phaseIdx > seedIdx,
    `the boot-phases line (#${phaseIdx}) must follow the seed (#${seedIdx}); v1.153.0's "99.99%" came from one that did not`);
  assert.match(
    lines[phaseIdx],
    /^recorder: boot phases — open \d+ms, schema\+migrations \d+ms, analyze \d+ms, setup \d+ms, seed \d+ms, restart-probe \d+ms, rest \d+ms \(total \d+ms, db /,
  );
});

test('★ the boot-phases line is the LAST statement before createRecorder returns', () => {
  // v1.154.0 review. No behavioural check can see work that runs after the line: the
  // phases are chained from one clock, so they always sum to whatever total the line
  // reports. Position is the property, so position is what is pinned.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/recorder.ts'), 'utf8');
  assert.equal(src.split("phase('rest')").length - 1, 1, 'exactly one rest phase');
  assert.match(src, /\n  const tRest = phase\('rest'\);\n  log\(`recorder: boot phases — [^\n]*\);\n\n  return \{\n    insertSnapshot: /,
    'nothing may run between the boot-phases line and the returned API');
});
