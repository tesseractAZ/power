import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  PoolEnergyBasisTracker,
  candidatePoolScale,
  coreCapacityRatio,
  defaultPoolEnergyBasisPath,
  PACK_NOMINAL_V,
  CAPACITY_INCREASE_HOLD_MS,
  HELD_RATIO_MAX_AGE_MS,
  type HeldRatio,
} from '../src/poolEnergyBasis.js';
import {
  computeRunway,
  resetRunwayCache,
  resetPoolEnergyBasisForTesting,
  resetWorkerReportCaches,
  setPoolBasisOverrideForTesting,
  runwayDrainW,
  runwayPoolOverheadW,
  RUNWAY_POOL_OVERHEAD_FLOOR_W,
  RUNWAY_DISCHARGE_EFFICIENCY,
  RUNWAY_CORE_OVERHEAD_W,
  RUNWAY_CHARGE_EFFICIENCY,
  type DayForecast,
  type ForecastHour,
} from '../src/analytics.js';
import { chargeLegStep } from '../src/physics/chargeLeg.js';
import { panelDrainRunway } from '../src/panelRunway.js';
import { resetOwnerReserveFloorPct } from '../src/nightChargeActuator.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Shp2Projection } from '../src/ecoflow/project.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.19 — the pool's measured energy basis (poolEnergyBasis.ts) and the drain
 * (analytics.runwayDrainW). Every rule here fails toward a SHORTER runway.
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);
const SLOT_WH = 30_720;

type PackSpec = { full: number | null; design?: number | null };
function core(sn: string, packs: PackSpec[] | number, opts: { online?: boolean; packCount?: number | null } = {}): DeviceSnapshot {
  const list: PackSpec[] = typeof packs === 'number' ? Array.from({ length: 5 }, () => ({ full: Math.round(packs * 60_000) })) : packs;
  return {
    sn, deviceName: sn, online: opts.online ?? true, lastSeenMs: NOW,
    projection: {
      kind: 'dpu', soc: 60, packCount: opts.packCount === undefined ? list.length : opts.packCount,
      packs: list.map((p, i) => ({ num: i + 1, soc: 60, fullCapMah: p.full, designCapMah: p.design === undefined ? 60_000 : p.design })),
    },
  } as unknown as DeviceSnapshot;
}
function panel(connected: string[], extra: Partial<Shp2Projection> = {}, sn = 'PANEL-1'): DeviceSnapshot & { projection: Shp2Projection } {
  return {
    sn, deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: NOW,
    projection: {
      kind: 'shp2', backupBatPercent: 60, backupFullCapWh: SLOT_WH * connected.length, backupRemainWh: 0.6 * SLOT_WH * connected.length,
      backupReserveSoc: 16, circuits: [], pairedCircuits: [], sourceWatts: [], strategy: {},
      sources: connected.map((s, i) => ({ slot: i + 1, sn: s, isConnected: true, hwConnect: true, fullCap: SLOT_WH })),
      ...extra,
    },
  } as unknown as DeviceSnapshot & { projection: Shp2Projection };
}
const fleetOf = (...ds: DeviceSnapshot[]): Record<string, DeviceSnapshot> => Object.fromEntries(ds.map((d) => [d.sn, d]));
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

beforeEach(() => { resetOwnerReserveFloorPct(); resetRunwayCache(); resetPoolEnergyBasisForTesting(); });
afterEach(() => { resetRunwayCache(); resetPoolEnergyBasisForTesting(); });

/* ─── the per-Core ratio ─────────────────────────────────────────────── */

test('coreCapacityRatio — Σ fullCapMah / Σ designCapMah over a complete reading', () => {
  const c = core('C1', [{ full: 60_427 }, { full: 59_597 }, { full: 56_722 }, { full: 54_917 }, { full: 56_764 }]);
  assert.ok(near(coreCapacityRatio(c)!, (60_427 + 59_597 + 56_722 + 54_917 + 56_764) / 300_000));
});

test('coreCapacityRatio — an invalid pack makes the Core incomplete (null, ≤ 0, > 1.1 × design, no design)', () => {
  for (const bad of [{ full: null }, { full: 0 }, { full: -5 }, { full: 66_001 }, { full: 58_000, design: null }, { full: 58_000, design: 0 }] as PackSpec[]) {
    const packs: PackSpec[] = [{ full: 58_000 }, { full: 58_000 }, bad, { full: 58_000 }, { full: 58_000 }];
    assert.equal(coreCapacityRatio(core('C1', packs)), null, JSON.stringify(bad));
  }
  // 1.1 × design exactly is still a reading.
  assert.ok(coreCapacityRatio(core('C1', [{ full: 66_000 }])) != null);
});

test('coreCapacityRatio — offline, no packs, or a pack count that disagrees with packCount → incomplete', () => {
  assert.equal(coreCapacityRatio(core('C1', 0.95, { online: false })), null);
  assert.equal(coreCapacityRatio(core('C1', [])), null);
  assert.equal(coreCapacityRatio(core('C1', 0.95, { packCount: 4 })), null);
  assert.ok(coreCapacityRatio(core('C1', 0.95, { packCount: null })) != null, 'no packCount reported → the packs present decide');
  assert.equal(coreCapacityRatio(undefined), null);
});

/* ─── the candidate scale ────────────────────────────────────────────── */

test('★★ complete fleet — the scale is Σ fullCapMah × 102.4 V ÷ backupFullCapWh (2026-10-11: 0.944)', () => {
  // The live readings of 2026-10-11 (per Core: 282,119 / 275,654 / 291,783 mAh).
  const perCore = [282_119, 275_654, 291_783];
  const cores = perCore.map((mah, i) => core(`C${i + 1}`, Array.from({ length: 5 }, (_, k) => ({ full: k === 0 ? mah - 4 * Math.floor(mah / 5) : Math.floor(mah / 5) }))));
  const p = panel(['C1', 'C2', 'C3']);
  const c = candidatePoolScale(p, fleetOf(p, ...cores), new Map(), NOW);
  const spec = ((849_556 * PACK_NOMINAL_V) / 1000) / p.projection.backupFullCapWh!;
  assert.equal(c.basis, 'measured');
  assert.equal(c.connected, 3);
  assert.ok(near(c.scale, spec, 1e-12), `${c.scale} vs ${spec}`);
  assert.ok(near(c.scale, 0.94395, 1e-5));
});

test('★★★ membership is the panel\'s CONNECTED sources — a bench Core (online, fresher packs) is not in the pool', () => {
  const p = panel(['C1', 'C2', 'C3']);
  const home = [core('C1', 0.94), core('C2', 0.92), core('C3', 0.97)];
  const withBench = candidatePoolScale(p, fleetOf(p, ...home, core('BENCH4', 0.985), core('BENCH5', 0.961)), new Map(), NOW);
  const without = candidatePoolScale(p, fleetOf(p, ...home), new Map(), NOW);
  assert.equal(withBench.scale, without.scale);
  assert.ok(near(without.scale, (0.94 + 0.92 + 0.97) / 3, 1e-6));
  // A source the panel lists as NOT connected is not counted either.
  const p2 = panel(['C1', 'C2', 'C3']);
  (p2.projection.sources[2] as { isConnected: boolean }).isConnected = false;
  const two = candidatePoolScale(p2, fleetOf(p2, ...home), new Map(), NOW);
  assert.equal(two.connected, 2);
  assert.ok(near(two.scale, (0.94 + 0.92) / 2, 1e-6));
});

test('★★ one Core cloud-offline — it uses its held ratio (≤ 30 days), basis "held"', () => {
  const p = panel(['C1', 'C2', 'C3']);
  const held = new Map<string, HeldRatio>([['C2', { ratio: 0.9188, atMs: NOW - 3 * 24 * HOUR }]]);
  const c = candidatePoolScale(p, fleetOf(p, core('C1', 0.9404), core('C2', 0.99, { online: false }), core('C3', 0.9726)), held, NOW);
  assert.equal(c.basis, 'held');
  assert.ok(near(c.scale, (0.9404 + 0.9188 + 0.9726) / 3, 1e-6), `${c.scale}`);
  assert.ok(!c.live.has('C2'), 'an offline Core\'s frozen packs are not a new measurement');
});

test('★★★ a held ratio past 30 days, or a Core never measured, takes the LOWEST known ratio — never nameplate once measured', () => {
  const p = panel(['C1', 'C2', 'C3']);
  const stale = new Map<string, HeldRatio>([['C2', { ratio: 0.99, atMs: NOW - HELD_RATIO_MAX_AGE_MS - HOUR }]]);
  const a = candidatePoolScale(p, fleetOf(p, core('C1', 0.95), core('C3', 0.97)), stale, NOW);
  assert.equal(a.basis, 'min-known');
  assert.ok(near(a.scale, (0.95 + 0.95 + 0.97) / 3, 1e-6), `C2 takes the lowest known (0.95), not its stale 0.99; got ${a.scale}`);
  // Nothing reporting now, only an old record of one Core: still that record, not nameplate.
  const b = candidatePoolScale(p, fleetOf(p), new Map([['C9', { ratio: 0.93, atMs: NOW - 400 * 24 * HOUR }]]), NOW);
  assert.equal(b.basis, 'min-known');
  assert.ok(near(b.scale, 0.93, 1e-9));
});

test('★★★ the 24 h hold and the 30-day held-ratio validity are the documented values (literal offsets)', () => {
  assert.equal(CAPACITY_INCREASE_HOLD_MS, 86_400_000);
  assert.equal(HELD_RATIO_MAX_AGE_MS, 30 * 86_400_000);
  const p = panel(['C1', 'C2', 'C3']);
  const fleet = fleetOf(p, core('C1', 0.95), core('C3', 0.97)); // C2 not reporting
  const at = (ageDays: number) => candidatePoolScale(p, fleet, new Map([['C2', { ratio: 0.99, atMs: NOW - ageDays * DAY }]]), NOW);
  assert.equal(at(29).basis, 'held', '29 days old: still the held ratio');
  assert.ok(near(at(29).scale, (0.95 + 0.99 + 0.97) / 3, 1e-9));
  assert.equal(at(30).basis, 'held', 'exactly 30 days: still valid');
  const old = at(31);
  assert.equal(old.basis, 'min-known', '31 days old: falls to the lowest known');
  assert.ok(near(old.scale, (0.95 + 0.95 + 0.97) / 3, 1e-9), `${old.scale}`);
});

test('★★★ no connected source at all (a partial /quota/all) — the lowest known ratio, never nameplate, and the overhead floor holds', () => {
  const p = panel(['C1', 'C2', 'C3']);
  for (const s of p.projection.sources) (s as { isConnected: boolean }).isConnected = false;
  const held = new Map<string, HeldRatio>([['C1', { ratio: 0.9404, atMs: NOW - DAY }], ['C2', { ratio: 0.9188, atMs: NOW - DAY }]]);
  const c = candidatePoolScale(p, fleetOf(p, core('C1', 0.95), core('C2', 0.95)), held, NOW);
  assert.equal(c.connected, 0);
  assert.equal(c.basis, 'min-known');
  assert.ok(near(c.scale, 0.9188, 1e-12), `${c.scale}`);
  assert.equal(runwayPoolOverheadW(c.connected, true), RUNWAY_POOL_OVERHEAD_FLOOR_W);
});

test('★★ never measured anywhere — plain nameplate (1.0), basis "nameplate"', () => {
  const p = panel(['C1', 'C2', 'C3']);
  const c = candidatePoolScale(p, fleetOf(p, core('C1', [{ full: null }]), core('C2', 0.95, { online: false })), new Map(), NOW);
  assert.equal(c.basis, 'nameplate');
  assert.equal(c.scale, 1);
});

test('★★ clamp — never above nameplate, never below 0.80', () => {
  const p = panel(['C1', 'C2', 'C3']);
  const high = candidatePoolScale(p, fleetOf(p, core('C1', 1.06), core('C2', 1.08), core('C3', 1.05)), new Map(), NOW);
  assert.equal(high.scale, 1);
  const low = candidatePoolScale(p, fleetOf(p, core('C1', 0.5), core('C2', 0.6), core('C3', 0.55)), new Map(), NOW);
  assert.equal(low.scale, 0.8);
});

/* ─── the tracker: hold, persistence ─────────────────────────────────── */

test('★★★ asymmetric — a decrease applies at once; an increase waits 24 h, at the lowest figure seen while waiting', () => {
  const t = new PoolEnergyBasisTracker({ path: null });
  const p = panel(['C1', 'C2', 'C3']);
  const at = (r: number) => fleetOf(p, core('C1', r), core('C2', r), core('C3', r));
  assert.ok(near(t.evaluate(at(0.97), p, NOW).capacityScale, 0.97, 1e-9));
  assert.ok(near(t.evaluate(at(0.944), p, NOW + HOUR).capacityScale, 0.944, 1e-9), 'decrease: immediate');
  const up1 = t.evaluate(at(0.96), p, NOW + 2 * HOUR);
  assert.ok(near(up1.capacityScale, 0.944, 1e-9), 'increase: held');
  assert.equal(up1.increaseHeldSinceMs, NOW + 2 * HOUR);
  assert.ok(near(up1.candidateScale, 0.96, 1e-9));
  assert.ok(near(t.evaluate(at(0.955), p, NOW + 10 * HOUR).capacityScale, 0.944, 1e-9));
  assert.ok(near(t.evaluate(at(0.96), p, NOW + 2 * HOUR + 24 * HOUR - 1).capacityScale, 0.944, 1e-9), 'one ms short of 24 h');
  const done = t.evaluate(at(0.96), p, NOW + 2 * HOUR + 24 * HOUR);
  assert.ok(near(done.capacityScale, 0.955, 1e-9), `after 24 h: the lowest figure seen during the hold; got ${done.capacityScale}`);
  assert.equal(done.increaseHeldSinceMs, null);
});

test('asymmetric — a dip back to the applied figure restarts the increase hold', () => {
  const t = new PoolEnergyBasisTracker({ path: null });
  const p = panel(['C1']);
  const at = (r: number) => fleetOf(p, core('C1', r));
  t.evaluate(at(0.94), p, NOW);
  t.evaluate(at(0.96), p, NOW + HOUR);
  t.evaluate(at(0.94), p, NOW + 12 * HOUR); // back: hold cleared
  const again = t.evaluate(at(0.96), p, NOW + 13 * HOUR);
  assert.equal(again.increaseHeldSinceMs, NOW + 13 * HOUR);
  assert.ok(near(t.evaluate(at(0.96), p, NOW + HOUR + 24 * HOUR).capacityScale, 0.94, 1e-9), 'the first hold does not count');
});

test('★★★ persistence — a restart with the Cores not yet reported runs on the held ratios, not nameplate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-basis-'));
  try {
    const path = join(dir, 'pool-energy-basis.json');
    const p = panel(['C1', 'C2', 'C3']);
    const a = new PoolEnergyBasisTracker({ path });
    a.evaluate(fleetOf(p, core('C1', 0.9404), core('C2', 0.9188), core('C3', 0.9726)), p, NOW);
    assert.ok(existsSync(path));
    assert.ok(!/REPLAY|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(readFileSync(path, 'utf8')));
    const b = new PoolEnergyBasisTracker({ path });
    const boot = b.evaluate(fleetOf(p), p, NOW + 5 * 60_000); // Cores absent from the map after a restart
    assert.equal(boot.capacityBasis, 'held');
    assert.ok(near(boot.capacityScale, (0.9404 + 0.9188 + 0.9726) / 3, 1e-6), `${boot.capacityScale}`);
    // A corrupt file starts clean rather than throwing.
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{"v":1,"cores":');
    const c = new PoolEnergyBasisTracker({ path: corrupt });
    assert.equal(c.evaluate(fleetOf(p), p, NOW).capacityBasis, 'nameplate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ persistence — a restart DURING an increase hold keeps the applied figure and the hold\'s start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-basis-hold-'));
  try {
    const path = join(dir, 'pool-energy-basis.json');
    const p = panel(['C1', 'C2', 'C3']);
    const at = (r: number) => fleetOf(p, core('C1', r), core('C2', r), core('C3', r));
    const a = new PoolEnergyBasisTracker({ path });
    a.evaluate(at(0.944), p, NOW);
    const rising = a.evaluate(at(0.97), p, NOW + HOUR); // a BMS recalibration upward
    assert.equal(rising.increaseHeldSinceMs, NOW + HOUR);
    const b = new PoolEnergyBasisTracker({ path }); // the add-on restarts two hours later
    const boot = b.evaluate(at(0.97), p, NOW + 3 * HOUR);
    assert.ok(near(boot.capacityScale, 0.944, 1e-9), `the restart must not apply the increase early; got ${boot.capacityScale}`);
    assert.equal(boot.increaseHeldSinceMs, NOW + HOUR, 'the hold keeps its original start');
    assert.ok(near(b.evaluate(at(0.97), p, NOW + HOUR + 24 * HOUR).capacityScale, 0.97, 1e-9), 'and lands 24 h after it began');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ persistence path — under the Supervisor (DB_PATH unset) the file sits beside the database: /data/pool-energy-basis.json', () => {
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const env: NodeJS.ProcessEnv = { ...process.env, SUPERVISOR_TOKEN: 'test-token' };
  delete env.DB_PATH;
  delete env.POOL_ENERGY_BASIS_DIR;
  const out = execFileSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    "const m = await import('./src/poolEnergyBasis.ts'); process.stdout.write(JSON.stringify([m.defaultPoolEnergyBasisPath('pool-energy-basis'), m.defaultPoolEnergyBasisPath('pool-energy-basis-panels')]));",
  ], { cwd: serverDir, env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['/data/pool-energy-basis.json', '/data/pool-energy-basis-panels.json']);
});

test('persistence path — POOL_ENERGY_BASIS_DIR, one file per tracker name; empty disables', () => {
  const prev = process.env.POOL_ENERGY_BASIS_DIR;
  try {
    process.env.POOL_ENERGY_BASIS_DIR = '/tmp/pb';
    assert.equal(defaultPoolEnergyBasisPath('pool-energy-basis'), '/tmp/pb/pool-energy-basis.json');
    assert.notEqual(defaultPoolEnergyBasisPath('pool-energy-basis'), defaultPoolEnergyBasisPath('pool-energy-basis-panels'));
    process.env.POOL_ENERGY_BASIS_DIR = '';
    assert.equal(defaultPoolEnergyBasisPath('pool-energy-basis'), null);
  } finally {
    if (prev === undefined) delete process.env.POOL_ENERGY_BASIS_DIR; else process.env.POOL_ENERGY_BASIS_DIR = prev;
  }
});

/* ─── the drain ──────────────────────────────────────────────────────── */

test('★★★ runwayDrainW — never below load/η, for any overhead; the overhead is max(270 W floor, 90 W × connected Cores)', () => {
  for (const load of [0, 300, 2_000, 5_000, 12_000]) {
    for (const ovh of [0, 90, 270, 1_000]) {
      assert.ok(runwayDrainW(load, ovh) >= load / RUNWAY_DISCHARGE_EFFICIENCY - 1e-9, `${load} W / ${ovh} W`);
    }
    assert.equal(runwayDrainW(load, 0), load / RUNWAY_DISCHARGE_EFFICIENCY, 'zero overhead: exactly the pre-v1.187.19 drain');
  }
  // The max() guard: a configuration that would read LESS than load/η (a marginal η above 0.94,
  // a negative overhead) is held at load/η.
  for (const load of [500, 3_000, 9_000]) {
    assert.equal(runwayDrainW(load, 0, 1), load / RUNWAY_DISCHARGE_EFFICIENCY);
    assert.equal(runwayDrainW(load, -400), load / RUNWAY_DISCHARGE_EFFICIENCY);
    assert.ok(runwayDrainW(load, 270, 0.9) > 270 + load / RUNWAY_DISCHARGE_EFFICIENCY, 'a lower marginal η drains more');
  }
  assert.equal(RUNWAY_CORE_OVERHEAD_W, 90);
  assert.equal(RUNWAY_POOL_OVERHEAD_FLOOR_W, 270);
  assert.equal(runwayPoolOverheadW(3, true), 270);
  // The 270 W is a three-Core POOL fit, and most of it sits on one slot: a Core leaving, or a
  // reading that lists no connected source, keeps the floor while the pool is reported.
  assert.equal(runwayPoolOverheadW(2, true), 270);
  assert.equal(runwayPoolOverheadW(1, true), 270);
  assert.equal(runwayPoolOverheadW(0, true), 270);
  assert.equal(runwayPoolOverheadW(4, true), 360, 'a larger pool scales above the floor');
  assert.equal(runwayPoolOverheadW(3, false), 270, 'per-Core figure alone');
  assert.equal(runwayPoolOverheadW(0, false), 0, 'no pool reported: nothing to drain');
  assert.ok(near(runwayDrainW(3_000, 270), 270 + 3_000 / 0.94, 1e-9));
});

/* ─── computeRunway on the measured basis ────────────────────────────── */

function runway(devs: Record<string, DeviceSnapshot>, loadW: number, forecast: DayForecast | null = null) {
  resetRunwayCache();
  const now = Date.now();
  const rec = makeRecorderStub({
    query: (_sn, metric) => metric === 'panel_load' ? [{ ts: now - 30 * 60_000, value: loadW }, { ts: now - 5 * 60_000, value: loadW }] : [],
  });
  return computeRunway(devs, rec, forecast);
}

test('★★ computeRunway publishes the basis, scales every kWh figure, and keeps the HA-facing percent', () => {
  const p = panel(['C1', 'C2', 'C3'], { backupBatPercent: 60, backupRemainWh: 0.6 * 92_160, backupFullCapWh: 92_160, backupReserveSoc: 16 });
  const r = runway(fleetOf(p, core('C1', 0.944), core('C2', 0.944), core('C3', 0.944)), 3_000);
  assert.equal(r.capacityBasis, 'measured');
  assert.equal(r.capacityScale, 0.944);
  assert.equal(r.overheadW, 270);
  assert.equal(r.backupFullKwh, Math.round(92.16 * 0.944 * 100) / 100);
  assert.equal(r.backupRemainingKwh, Math.round(0.6 * 92.16 * 0.944 * 100) / 100);
  const expected = ((0.6 - 0.16) * 92_160 * 0.944) / (270 + 3_000 / 0.94);
  assert.ok(Math.abs((r.reserveAtMs! - r.generatedAt) / HOUR - expected) < 1e-5, `${r.hoursToReserve} vs ${expected}`);
  // Unavailable projections carry no basis.
  const none = runway(fleetOf(core('C1', 0.944)), 3_000);
  assert.equal(none.capacityScale, null);
  assert.equal(none.overheadW, null);
});

test('★★★ computeRunway — a reading with no connected source keeps the measured scale (min-known) and the 270 W floor; so does a Core leaving', () => {
  const plate = { backupBatPercent: 60, backupRemainWh: 0.6 * 92_160, backupFullCapWh: 92_160, backupReserveSoc: 16 };
  const cores = [core('C1', 0.944), core('C2', 0.944), core('C3', 0.944)];
  const full = panel(['C1', 'C2', 'C3'], plate);
  const first = runway(fleetOf(full, ...cores), 2_000);
  assert.equal(first.capacityBasis, 'measured');
  // The next panel reading lists no connected source (the pd303_mc sources missing from a partial quota).
  const blank = panel(['C1', 'C2', 'C3'], plate);
  for (const s of blank.projection.sources) (s as { isConnected: boolean }).isConnected = false;
  const r = runway(fleetOf(blank, ...cores), 2_000);
  assert.equal(r.capacityBasis, 'min-known');
  assert.equal(r.capacityScale, 0.944);
  assert.equal(r.overheadW, 270, 'the pool still reports energy: the overhead must not fall to 0');
  const expected = ((0.6 - 0.16) * 92_160 * 0.944) / (270 + 2_000 / 0.94);
  assert.ok(Math.abs((r.reserveAtMs! - r.generatedAt) / HOUR - expected) < 1e-5, `${r.hoursToReserve} vs ${expected}`);
  // One Core leaves the panel: the two left still carry the floor.
  const two = runway(fleetOf(panel(['C1', 'C2'], { ...plate, backupFullCapWh: 61_440, backupRemainWh: 0.6 * 61_440 }), ...cores), 2_000);
  assert.equal(two.overheadW, 270);
});

test('★★★ only a COMPLETE measurement moves the applied scale: a partial map answers min(applied, substitute) and records nothing', () => {
  const t = new PoolEnergyBasisTracker({ path: null });
  const p = panel(['C1', 'C2', 'C3']);
  const c1 = core('C1', 0.9404), c2 = core('C2', 0.9188), c5 = core('C3', 0.9726);
  const full = (0.9404 + 0.9188 + 0.9726) / 3;
  // Fresh tracker, boot: only Core 2 has projected — the others take the lowest known (0.9188).
  const boot = t.evaluate(fleetOf(p, c2), p, NOW);
  assert.equal(boot.capacityBasis, 'min-known');
  assert.ok(near(boot.capacityScale, 0.9188, 1e-9), 'conservative while the map is partial');
  // The full map: the measured figure applies AT ONCE — the partial figure was never recorded.
  const all = t.evaluate(fleetOf(p, c1, c2, c5), p, NOW + 60_000);
  assert.equal(all.capacityBasis, 'measured');
  assert.ok(near(all.capacityScale, full, 1e-9), `got ${all.capacityScale}`);
  assert.equal(all.increaseHeldSinceMs, null);
  // A Core recalibrates upward (an increase now on hold), then goes cloud-offline: its held ratio
  // is the HIGHER reading, and the answer must still not exceed the applied figure.
  const t2 = new PoolEnergyBasisTracker({ path: null });
  const applied = t2.evaluate(fleetOf(p, core('C1', 0.94), core('C2', 0.94), core('C3', 0.94)), p, NOW).capacityScale;
  assert.ok(near(t2.evaluate(fleetOf(p, core('C1', 0.94), core('C2', 0.94), core('C3', 0.99)), p, NOW + HOUR).capacityScale, applied, 1e-12), 'held');
  const offline = t2.evaluate(fleetOf(p, core('C1', 0.94), core('C2', 0.94)), p, NOW + 2 * HOUR); // C3 held at 0.99
  assert.equal(offline.capacityBasis, 'held');
  assert.ok(near(offline.candidateScale, (0.94 + 0.94 + 0.99) / 3, 1e-12));
  assert.ok(near(offline.capacityScale, applied, 1e-12), `the answer stays at the applied ${applied}; got ${offline.capacityScale}`);
  assert.equal(offline.increaseHeldSinceMs, NOW + HOUR, 'a partial map neither advances nor clears the hold');
  // …and a lower substitute answers lower at once, without planting it: back to complete → applied again.
  const lowSub = t2.evaluate(fleetOf(p, core('C1', 0.88)), p, NOW + 3 * HOUR);
  assert.ok(near(lowSub.capacityScale, (0.88 + 0.94 + 0.99) / 3, 1e-12) && lowSub.capacityScale < applied,
    `a lower substitute answers at once; got ${lowSub.capacityScale}`);
  const back = t2.evaluate(fleetOf(p, core('C1', 0.94), core('C2', 0.94), core('C3', 0.94)), p, NOW + 4 * HOUR);
  assert.ok(near(back.capacityScale, applied, 1e-12), 'no 24 h wait after the Cores rejoin at the applied reading');
  assert.equal(back.increaseHeldSinceMs, null);
});

test('★★★ boot basis — partial maps, the worker\'s basis reset, then the first full map: the measured scale, and the reset leaves the basis alone', () => {
  const plate = { backupBatPercent: 60, backupRemainWh: 0.6 * 92_160, backupFullCapWh: 92_160, backupReserveSoc: 16 };
  const p = panel(['C1', 'C2', 'C3'], plate);
  const c1 = core('C1', 0.9404), c2 = core('C2', 0.9188), c5 = core('C3', 0.9726);
  const full = Math.round(((0.9404 + 0.9188 + 0.9726) / 3) * 10_000) / 10_000;
  const at = (devs: Record<string, DeviceSnapshot>) => {
    resetWorkerReportCaches(); // what the report chokepoint does as the boot basis grows
    const now = Date.now();
    const rec = makeRecorderStub({ query: (_sn, m) => (m === 'panel_load' ? [{ ts: now - 1_800_000, value: 2_000 }, { ts: now - 300_000, value: 2_000 }] : []) });
    return computeRunway(devs, rec, null);
  };
  // 1. One Core projected, the panel not yet: no pool, no runway, no basis evaluated.
  const first = at(fleetOf(c1));
  assert.notEqual(first.unavailable, null);
  assert.equal(first.capacityScale, null);
  assert.equal(first.overheadW, null);
  // 2. The panel and Core 2: Cores 1 and 5 take the lowest known (Core 1's ratio was never stored —
  //    step 1 evaluated nothing), the floor overhead applies.
  const partial = at(fleetOf(p, c2));
  assert.equal(partial.capacityBasis, 'min-known');
  assert.equal(partial.capacityScale, 0.9188);
  assert.equal(partial.overheadW, 270);
  // 3. The first full map after the reset: the measured scale at once, not held at 0.9188.
  const complete = at(fleetOf(p, c1, c2, c5));
  assert.equal(complete.capacityBasis, 'measured');
  assert.equal(complete.capacityScale, full);
  // 4. The reset does not wipe the measured basis: Core 5 drops off the map, its held ratio stands.
  const again = at(fleetOf(p, c1, c2));
  assert.equal(again.capacityBasis, 'held');
  assert.equal(again.capacityScale, full);
});

test('★★★ computeRunway — the Cores\' overhead is drawn in PV-surplus hours too (a sunny morning, then the evening deficit)', () => {
  // Pool 40 % of 92.16 kWh nameplate on Cores 0.9404 / 0.9188 / 0.9726 (scale 0.9439), reserve
  // 16 %; 7 h of 6 kW PV under a 2 kW load (surplus, the pool stays below full), then 17 h of
  // 3 kW and no PV. The overhead is measured in PV-surplus hours (docs/PERFORMANCE.md §4a), so
  // the projection must draw runwayDrainW in EVERY hour. v1.194.0 — and the 3.60 kWh surplus of each
  // sunny hour reaches the cells at RUNWAY_CHARGE_EFFICIENCY (0.927): 3.34 kWh. ≈ 19.8 h to the floor
  // and the pool empty at ≈ 23.8 h, trough 0 (before v1.194.0, the surplus at unity: 20.3 h / 1.17 kWh,
  // never empty; dropping the overhead while PV covers the load reads ≈ 20.3 h / 1.09 kWh).
  const p = panel(['C1', 'C2', 'C3'], { backupBatPercent: 40, backupRemainWh: 0.4 * 92_160, backupFullCapWh: 92_160, backupReserveSoc: 16 });
  const devs = fleetOf(p, core('C1', 0.9404), core('C2', 0.9188), core('C3', 0.9726));
  const startTs = Math.ceil(Date.now() / HOUR) * HOUR;
  const pvW = (h: number) => (h < 7 ? 6_000 : 0);
  const loadW = (h: number) => (h < 7 ? 2_000 : 3_000);
  const hours: ForecastHour[] = Array.from({ length: 24 }, (_, h) => ({
    ts: startTs + h * HOUR, forecastPvW: pvW(h), forecastLoadW: loadW(h), cloudCoverPct: null, ghiWm2: null, projectedSocPct: null, modelled: false,
  }));
  const r = runway(devs, 2_000, { hours } as unknown as DayForecast);
  // The analytic integration: runwayDrainW in every hour, on the measured capacity.
  const scale = (0.9404 + 0.9188 + 0.9726) / 3;
  const full = 92.16 * scale, reserve = 0.16 * full;
  let e = 0.4 * full, trough = e, toReserve: number | null = null, toEmpty: number | null = null;
  for (let h = 0; h < 24; h++) {
    const delta = chargeLegStep(pvW(h) / 1000 - runwayDrainW(loadW(h), 270) / 1000, RUNWAY_CHARGE_EFFICIENCY);
    const next = e + delta;
    if (toReserve == null && e > reserve && next <= reserve) toReserve = h + (e - reserve) / -delta;
    if (toEmpty == null && e > 0 && next <= 0) toEmpty = h + e / -delta;
    e = Math.max(0, Math.min(full, next));
    trough = Math.min(trough, e);
  }
  assert.equal(r.capacityBasis, 'measured');
  assert.equal(r.overheadW, 270);
  assert.ok(toReserve != null && Math.abs(toReserve - 19.79) < 0.01 && trough === 0, `analytic ${toReserve} h / ${trough} kWh`);
  assert.ok(toEmpty != null && Math.abs(toEmpty - 23.81) < 0.01, `analytic empty ${toEmpty} h`);
  assert.ok(Math.abs((r.reserveAtMs! - r.generatedAt) / HOUR - toReserve!) < 1e-5, `hoursToReserve ${r.hoursToReserve} vs ${toReserve}`);
  assert.equal(r.hoursToEmpty, Math.round(toEmpty! * 10) / 10);
  assert.equal(r.troughKwh, Math.round(trough * 100) / 100);
});

/** A tiny deterministic PRNG (mulberry32) so the property test is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('★★★ PROPERTY — for random pools, loads and PV the measured runway is never longer than the old one', () => {
  const rnd = prng(20261011);
  const startTs = Math.ceil(Date.now() / HOUR) * HOUR;
  for (let i = 0; i < 400; i++) {
    const pct = 1 + rnd() * 99;
    const reserve = 5 + rnd() * 30;
    const ratio = 0.75 + rnd() * 0.35; // includes values the clamp must hold at 0.80 and 1.00
    const loadW = 200 + rnd() * 9_000;
    const sunny = rnd() < 0.6;
    const hours: ForecastHour[] = Array.from({ length: 24 }, (_, h) => ({
      ts: startTs + h * HOUR,
      forecastPvW: sunny && h % 24 >= 8 && h % 24 <= 16 ? rnd() * 12_000 : 0,
      forecastLoadW: 200 + rnd() * 8_000,
      cloudCoverPct: null, ghiWm2: null, projectedSocPct: null, modelled: false,
    }));
    const fc = { hours } as unknown as DayForecast;
    const p = panel(['C1', 'C2', 'C3'], {
      backupBatPercent: pct, backupRemainWh: (pct / 100) * 92_160, backupFullCapWh: 92_160, backupReserveSoc: reserve,
    });
    const devs = fleetOf(p, core('C1', ratio), core('C2', ratio), core('C3', ratio));
    resetPoolEnergyBasisForTesting();
    const nu = runway(devs, loadW, fc);
    setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 0 });
    const old = runway(devs, loadW, fc);
    setPoolBasisOverrideForTesting(null);
    const inf = (h: number | null) => (h == null ? Infinity : h);
    const tag = `#${i} pct ${pct.toFixed(1)} reserve ${reserve.toFixed(1)} ratio ${ratio.toFixed(3)} load ${loadW.toFixed(0)}`;
    assert.ok(inf(nu.hoursToEmpty) <= inf(old.hoursToEmpty), `${tag}: empty ${nu.hoursToEmpty} > ${old.hoursToEmpty}`);
    // Above the floor (the alarm ladder's domain). Below it the alarm reads the floor itself, not hours.
    if (pct > reserve) {
      assert.ok(inf(nu.hoursToReserve) <= inf(old.hoursToReserve), `${tag}: reserve ${nu.hoursToReserve} > ${old.hoursToReserve}`);
      assert.ok((nu.reserveAtMs ?? Infinity) - nu.generatedAt <= (old.reserveAtMs ?? Infinity) - old.generatedAt + 1);
    }
  }
});

/* ─── a secondary panel's drain runway: scale only ───────────────────── */

test('★★ panelDrainRunway — the measured scale lowers the energies and the hours; a bad scale is clamped, absent = 1', () => {
  const p = panel(['C1', 'C2'], { backupRemainWh: 0.8 * 61_440, backupFullCapWh: 61_440, backupReserveSoc: 20 });
  const now = Date.now();
  (p as { lastQuotaAtMs?: number }).lastQuotaAtMs = now - 1_000; // a fresh readback
  const samples = [{ tMs: now - 20 * 60_000, netW: 3_000 }, { tMs: now - 1_000, netW: 3_000 }];
  const plate = panelDrainRunway(p, samples, now);
  assert.equal(plate.unavailable, null);
  assert.ok(plate.hoursToReserve != null && plate.hoursToReserve > 0);
  const measured = panelDrainRunway(p, samples, now, { capacityScale: 0.944, capacityBasis: 'measured' });
  assert.equal(measured.capacityScale, 0.944);
  assert.ok(near(measured.hoursToReserve!, plate.hoursToReserve! * 0.944, 1e-9));
  assert.ok(near(measured.backupRemainingKwh!, plate.backupRemainingKwh! * 0.944, 1e-9));
  const tooLow = panelDrainRunway(p, samples, now, { capacityScale: 0.3, capacityBasis: 'measured' });
  assert.equal(tooLow.capacityScale, 0.8);
  const nan = panelDrainRunway(p, samples, now, { capacityScale: Number.NaN, capacityBasis: 'measured' });
  assert.equal(nan.hoursToReserve, plate.hoursToReserve);
});
