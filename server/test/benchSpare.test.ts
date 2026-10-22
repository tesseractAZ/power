import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SPARE_DPU_SNS, benchSpareFloor, isBenchSpareSn, benchSpareSns, isExpectedOfflineSpare, homeCoreCoverage,
  isHomePoolDpu, isOutsideHomePool, homeFleetMeanSoc, housePoolFallbackCoverage, isShp2Connected, aggregateFleetFlow,
  setLastKnownHomeRoster, resetLastKnownHomeRoster, shp2ConnectedDpuSns,
} from '../src/shp2Membership.js';
import { parseBenchSpareSns, configuredBenchSpareSns, benchSpareOptionSet, effectiveBenchSpareFloor } from '../src/topology.js';
import { OPTIONS } from '../src/config.js';
import { siteResponse } from '../src/site.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.191.0 (S8, OWNER DECISION 1) — BENCH_SPARE_SNS replaces the SPARE_DPU_SNS literal as the bench-spare
 * floor when it is set, at every place the literal was read (CA5), and is never unioned with it.
 *
 * The two literal serials are IMPORTED and never written out. They describe the reference plant as it
 * was when the literal was written: LITERAL_BENCH is a genuine bench unit, LITERAL_WIRED a Core that
 * has since been wired into panel slot 3 (the stale entry the v1.121.0 roster override hides). The
 * other serials are placeholders.
 */
const [LITERAL_BENCH, LITERAL_WIRED] = [...SPARE_DPU_SNS].sort() as [string, string];
const PANEL = 'HD31XXX00XXX0001';
const CORE1 = 'Y711XXX00XXX0001';
const CORE2 = 'Y711XXX00XXX0002';
const BENCH3 = 'Y711XXX00XXX0003'; // the real bench unit, which the literal does not name
const ALL = [CORE1, CORE2, LITERAL_WIRED, BENCH3, LITERAL_BENCH];
const HOME_ROSTER = new Set([CORE1, CORE2, LITERAL_WIRED]);

function dpu(sn: string, o: { online?: boolean; soc?: number } = {}): DeviceSnapshot {
  return {
    sn, deviceName: `Core ${ALL.indexOf(sn) + 1}`, productName: 'DELTA Pro Ultra', online: o.online ?? true, lastUpdated: 0,
    projection: { kind: 'dpu', soc: o.soc ?? 50, packs: [{ outputWatts: 100, inputWatts: 0 }], pvTotalWatts: 10, totalInWatts: 0, totalOutWatts: 0, acInWatts: 0 },
  } as unknown as DeviceSnapshot;
}
function shp2(connected: string[], o: { online?: boolean } = {}): DeviceSnapshot {
  return {
    sn: PANEL, deviceName: 'Panel', productName: 'Smart Home Panel 2', online: o.online ?? true, lastUpdated: 0,
    projection: { kind: 'shp2', sources: connected.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, hwConnect: true })), circuits: [] },
  } as unknown as DeviceSnapshot;
}
const map = (list: DeviceSnapshot[]) => Object.fromEntries(list.map((d) => [d.sn, d]));
/** Every DPU online except the bench units; the panel either live (the home roster) or cloud-dark. */
const plant = (panel: 'live' | 'dark' | 'none', online: (sn: string) => boolean = (sn) => sn !== BENCH3 && sn !== LITERAL_BENCH) => {
  const list = ALL.map((sn) => dpu(sn, { online: online(sn) }));
  if (panel === 'live') list.push(shp2([...HOME_ROSTER]));
  if (panel === 'dark') list.push(shp2([], { online: false }));
  return map(list);
};

let saved: string | undefined;
beforeEach(() => { saved = process.env.BENCH_SPARE_SNS; delete process.env.BENCH_SPARE_SNS; resetLastKnownHomeRoster(); });
afterEach(() => { if (saved === undefined) delete process.env.BENCH_SPARE_SNS; else process.env.BENCH_SPARE_SNS = saved; resetLastKnownHomeRoster(); });

test('precondition: the literal names two units, and the option is unset', () => {
  assert.equal(SPARE_DPU_SNS.size, 2);
  assert.equal(configuredBenchSpareSns(), null);
  assert.equal(benchSpareOptionSet(), false);
});

test('BENCH_SPARE_SNS parses as a trimmed, upper-cased comma list; `none` is no spares; blank is unset', () => {
  assert.equal(parseBenchSpareSns(undefined), null);
  assert.equal(parseBenchSpareSns(''), null);
  assert.equal(parseBenchSpareSns('   '), null);
  assert.deepEqual([...parseBenchSpareSns('none')!], []);
  assert.deepEqual([...parseBenchSpareSns(' None ')!], []);
  assert.deepEqual([...parseBenchSpareSns(` ${BENCH3.toLowerCase()} ,, ${CORE2} ,`)!].sort(), [BENCH3, CORE2].sort());
  assert.equal(OPTIONS.BENCH_SPARE_SNS.exportForm, 'has_value');
  assert.equal(OPTIONS.BENCH_SPARE_SNS.source, 'option');
});

test('★ unset: the floor IS the literal (the owner\'s install, identical)', () => {
  assert.equal(benchSpareFloor(), SPARE_DPU_SNS);
  assert.equal(effectiveBenchSpareFloor(SPARE_DPU_SNS), SPARE_DPU_SNS);
  assert.deepEqual(benchSpareSns().sort(), [...SPARE_DPU_SNS].sort());
  assert.equal(isBenchSpareSn(BENCH3), false, 'the unlisted bench unit is not a spare today');
  // The roster override, unchanged: a wired literal entry is not a spare while the roster names it.
  assert.equal(isBenchSpareSn(LITERAL_WIRED, HOME_ROSTER), false);
  assert.equal(isBenchSpareSn(LITERAL_WIRED), true, 'with no roster the stale literal entry still reads as a spare (the documented hole)');
});

test('★★★ REPLACE, not union: with the option set and the panel cloud-dark, the literal\'s wired Core is NOT muted', () => {
  process.env.BENCH_SPARE_SNS = `${LITERAL_BENCH},${BENCH3}`;
  const devices = plant('dark', (sn) => sn !== BENCH3 && sn !== LITERAL_BENCH && sn !== LITERAL_WIRED);
  const connected = shp2ConnectedDpuSns(devices);
  assert.equal(connected.size, 0, 'precondition: the panel is dark, no connected sources');
  // No roster published (cold boot while dark): only the option decides.
  assert.equal(isExpectedOfflineSpare(LITERAL_WIRED, connected), false, 'its genuine offline alarm must annunciate');
  assert.equal(isBenchSpareSn(LITERAL_WIRED), false);
  assert.equal(isExpectedOfflineSpare(BENCH3, connected), true, 'the real bench unit is the spare now');
  assert.equal(isExpectedOfflineSpare(LITERAL_BENCH, connected), true);
  assert.deepEqual(benchSpareSns().sort(), [LITERAL_BENCH, BENCH3].sort());
});

test('★ the roster override still applies on top of the option', () => {
  process.env.BENCH_SPARE_SNS = `${BENCH3},${CORE2}`;
  assert.equal(isBenchSpareSn(CORE2, HOME_ROSTER), false, 'a unit the roster names as a home source is never a spare');
  setLastKnownHomeRoster(HOME_ROSTER);
  assert.equal(isBenchSpareSn(CORE2), false, 'the published roster too');
  assert.equal(isBenchSpareSn(BENCH3), true);
  assert.deepEqual(benchSpareSns(), [BENCH3]);
});

test('`none`: no unit is a spare, the literal included', () => {
  process.env.BENCH_SPARE_SNS = 'none';
  for (const sn of ALL) assert.equal(isBenchSpareSn(sn), false, sn);
  assert.deepEqual(benchSpareSns(), []);
  assert.equal(benchSpareOptionSet(), true);
});

test('★★ CA5 cold boot, no roster, option set: the three home-pool fallbacks agree with the mute floor', () => {
  process.env.BENCH_SPARE_SNS = `${LITERAL_BENCH},${BENCH3}`;
  const devices = plant('none');
  // homeCoreCoverage: the roster is every DPU not in the floor — the wired literal entry IS counted,
  // the real bench unit is NOT.
  const cov = homeCoreCoverage(devices);
  assert.equal(cov.connected, 3);
  assert.equal(cov.reporting, 3);
  assert.equal(cov.complete, true);
  // isHomePoolDpu / isOutsideHomePool
  assert.equal(isHomePoolDpu(LITERAL_WIRED, devices), true);
  assert.equal(isHomePoolDpu(BENCH3, devices), false);
  assert.equal(isOutsideHomePool(BENCH3, devices), true);
  assert.equal(isOutsideHomePool(LITERAL_WIRED, devices), false);
  // housePoolFallbackCoverage (the SoC ladders' boot-gate denominator)
  assert.deepEqual(housePoolFallbackCoverage(devices), { reporting: 3, roster: 3 });
  // homeFleetMeanSoc averages exactly the home Cores: the bench unit's SoC is not in it.
  const soc = map(ALL.map((sn) => dpu(sn, { soc: sn === BENCH3 ? 90 : 30 })));
  assert.equal(homeFleetMeanSoc(soc), 30);
});

test('the same cold boot with the option UNSET keeps today\'s literal answers (the wired entry is left out)', () => {
  const devices = plant('none');
  assert.equal(isHomePoolDpu(LITERAL_WIRED, devices), false);
  assert.equal(isHomePoolDpu(BENCH3, devices), true);
  assert.deepEqual(housePoolFallbackCoverage(devices), { reporting: 2, roster: 3 }, 'today: the bench unit is in the roster and offline');
});

test('★ a DPU-only home (no panel at all) can mark spares: they leave the fleet totals; unset they count, as today', () => {
  const devices = map([dpu(CORE1), dpu(BENCH3)]);
  const empty = new Set<string>();
  assert.equal(isShp2Connected(BENCH3, empty), true, 'unset: every DPU counts with no roster');
  const before = aggregateFleetFlow(devices);
  process.env.BENCH_SPARE_SNS = BENCH3;
  assert.equal(isShp2Connected(BENCH3, empty), false, 'set: the named spare is left out');
  assert.equal(isShp2Connected(CORE1, empty), true);
  const after = aggregateFleetFlow(devices);
  assert.equal(before.fleetPv, 20);
  assert.equal(after.fleetPv, 10, 'the spare\'s PV no longer counts toward the fleet');
  assert.equal(before.fleetBatteryNet, 200);
  assert.equal(after.fleetBatteryNet, 100);
  // A live panel roster still decides on its own.
  assert.equal(isShp2Connected(BENCH3, new Set([BENCH3])), true);
});

test('★ with the option UNSET and no roster, the LITERAL\'s serials still count in the fleet totals (today\'s rule: every DPU counts)', () => {
  // The `configuredBenchSpareSns() != null` guard in isShp2Connected is what keeps the built-in list out
  // of this path: without it both literal serials (one of them a wired home Core, DECISION 1) would drop
  // out of every fleet aggregate whenever the connected set is empty (a cold boot, a dark panel).
  const empty = new Set<string>();
  for (const sn of [...SPARE_DPU_SNS]) assert.equal(isShp2Connected(sn, empty), true, 'unset: a literal serial counts with no roster');
  const devices = map([dpu(CORE1), dpu(LITERAL_WIRED), dpu(LITERAL_BENCH)]);
  const flow = aggregateFleetFlow(devices);
  assert.equal(flow.fleetPv, 30, 'all three DPUs\' PV counts, the literal\'s two included');
  assert.equal(flow.fleetBatteryNet, 300);
  // Once the option is set it decides, and the literal is not consulted: a literal serial the option
  // does not name still counts.
  process.env.BENCH_SPARE_SNS = LITERAL_BENCH;
  assert.equal(isShp2Connected(LITERAL_BENCH, empty), false);
  assert.equal(isShp2Connected(LITERAL_WIRED, empty), true);
});

test('/api/site: the per-DPU benchSpare flag is withheld while the option is unset, and follows the floor once set', () => {
  const devices = plant('live');
  assert.deepEqual(siteResponse(devices, HOME_ROSTER).perDpu, {}, 'unset: no flag, the web keeps its own rule');
  process.env.BENCH_SPARE_SNS = `${LITERAL_BENCH},${BENCH3}`;
  const per = siteResponse(devices, HOME_ROSTER).perDpu;
  assert.deepEqual(Object.keys(per).sort(), [...ALL].sort());
  assert.equal(per[BENCH3].benchSpare, true);
  assert.equal(per[LITERAL_BENCH].benchSpare, true);
  assert.equal(per[LITERAL_WIRED].benchSpare, false);
  assert.equal(per[CORE1].benchSpare, false);
});

/* ── CA17: the worker resolves the same floor ── */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** The static (non-type) import graph of a source file, as paths relative to src/. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(SRC, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/^(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"](\.[^'"]+)['"]/gm)) {
      const p = resolve(dirname(f), m[1]).replace(/\.js$/, '.ts');
      if (existsSync(p)) stack.push(p);
    }
  }
  return new Set([...seen].map((f) => relative(SRC, f)));
}

test('★ CA17 precondition: the analytics worker\'s own module graph loads config.ts, which binds topology.ts\'s option reader', () => {
  const graph = importGraph('analyticsWorker.ts');
  assert.ok(graph.has('config.ts'), 'the worker loads config.ts');
  assert.ok(graph.has('shp2Membership.ts') && graph.has('topology.ts'));
  assert.match(readFileSync(resolve(SRC, 'config.ts'), 'utf8'), /^bindTopologyOptions\(\{ option, dataFile: \(name\) => config\.dataFile\(name\) \}\);$/m);
  // And topology.ts itself never imports config.ts (it would move config.ts's first-load capture of
  // DB_PATH earlier in every process that loads shp2Membership.ts).
  assert.ok(!importGraph('topology.ts').has('config.ts'));
  assert.ok(!importGraph('shp2Membership.ts').has('config.ts'), 'shp2Membership.ts still loads without config.ts');
});

async function workerFloor(env: Record<string, string | undefined>, roster: string[] | null): Promise<{ floor: string[]; spare: Record<string, boolean> }> {
  // The worker loads config.ts as the real analytics worker does (precondition above), then the module.
  const code = `
    import { parentPort, workerData } from 'node:worker_threads';
    await import(${JSON.stringify(pathToFileURL(resolve(SRC, 'config.ts')).href)});
    const m = await import(${JSON.stringify(pathToFileURL(resolve(SRC, 'shp2Membership.ts')).href)});
    if (workerData.roster) m.setLastKnownHomeRoster(new Set(workerData.roster));
    parentPort.postMessage({ floor: [...m.benchSpareFloor()].sort(), spare: Object.fromEntries(workerData.sns.map((sn) => [sn, m.isBenchSpareSn(sn)])) });`;
  const envCopy: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) envCopy[k] = v;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete envCopy[k]; else envCopy[k] = v; }
  const w = new Worker(code, { eval: true, env: envCopy, workerData: { sns: ALL, roster }, execArgv: ['--import', 'tsx'] });
  return new Promise((res, rej) => { w.once('message', (m) => { res(m); void w.terminate(); }); w.once('error', rej); });
}

test('★ CA17: a worker thread resolves the same floor as the main thread, unset and set (the roster forwarded)', async () => {
  for (const value of [undefined, `${LITERAL_BENCH},${BENCH3}`, 'none']) {
    if (value === undefined) delete process.env.BENCH_SPARE_SNS; else process.env.BENCH_SPARE_SNS = value;
    for (const roster of [null, [...HOME_ROSTER]]) {
      resetLastKnownHomeRoster();
      if (roster) setLastKnownHomeRoster(new Set(roster));
      const main = { floor: [...benchSpareFloor()].sort(), spare: Object.fromEntries(ALL.map((sn) => [sn, isBenchSpareSn(sn)])) };
      const fromWorker = await workerFloor({ BENCH_SPARE_SNS: value }, roster);
      assert.deepEqual(fromWorker, main, `BENCH_SPARE_SNS=${value ?? '<unset>'} roster=${roster ? 'published' : 'none'}`);
    }
  }
});

test('CA17 plumbing: the client forwards the home roster to the worker and replays it to a respawned one; the worker applies it', async () => {
  const { createAnalyticsClient } = await import('../src/analyticsClient.js');
  const posted: unknown[] = [];
  const listeners: Array<(m: unknown) => void> = [];
  const fake = {
    postMessage: (m: unknown) => { posted.push(m); },
    on: (ev: string, fn: (m: unknown) => void) => { if (ev === 'message') listeners.push(fn); return fake; },
    once: () => fake, terminate: async () => 0, removeAllListeners: () => fake, unref: () => undefined,
  };
  const client = createAnalyticsClient('/nonexistent.db', () => undefined, { spawnWorker: () => fake as never });
  try {
    client.pushHomeRoster?.([CORE2, CORE1]);
    client.pushHomeRoster?.([CORE1, CORE2]); // same set: not posted again
    const rosterMsgs = () => posted.filter((m) => (m as { kind?: string }).kind === 'homeRoster');
    assert.deepEqual(rosterMsgs(), [{ kind: 'homeRoster', sns: [CORE1, CORE2] }]);
    for (const fn of listeners) fn({ kind: 'ready' });
    assert.equal(rosterMsgs().length, 2, 'replayed on ready, as the owner floor is');
  } finally {
    client.stop();
  }
  const worker = readFileSync(resolve(SRC, 'analyticsWorker.ts'), 'utf8');
  assert.match(worker, /case 'homeRoster':\n\s+setLastKnownHomeRoster\(/);
});
