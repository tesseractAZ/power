/**
 * v1.184.0 — three small gaps: an operator clear for a stuck "no grid", the v1.79.0 starved-feed
 * anomaly guard that never ran (it lived in the analytics worker, where the rate-floor state is
 * never set) now on the main thread with idle-held Cores exempt, and a client hang-up logged as a
 * server error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { SnapshotStore } from '../src/snapshot.js';
import { resolveGridBackstop } from '../src/gridState.js';
import { applyStarvedFeedFilter } from '../src/analytics.js';
import { isClientHangup, logMethodHook } from '../src/logHooks.js';

type Any = any;
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const SN = 'SHP2-P';
const listed = (online: 0 | 1) => [{ sn: SN, deviceName: 'Panel', productName: 'Smart Home Panel 2', online } as never];
const quota = (gridSta: number, k = 1): Record<string, unknown> => ({
  'pd303_mc.masterIncreInfo.gridSta': gridSta, 'wattInfo.gridWatt': 0,
  'loadInfo.hall1Watt': [k, 134, 104, 302, 341, 70, 287, 70, 512, 88, 240, 60],
});
const toggleOn = (devices: Any) => resolveGridBackstop({
  devices,
  gridEntity: { entity_id: 'input_boolean.grid_available', state: 'on', last_updated: new Date().toISOString() } as Any,
  gridEntityConfigured: true, gridAvailableFallback: false, atReserveFloor: false,
});
function withPaths(fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'veto-clear-'));
  const prev = { g: process.env.GRID_READING_PATH, s: process.env.SHADOW_WITNESS_PATH };
  process.env.GRID_READING_PATH = join(dir, 'grid-reading.json');
  process.env.SHADOW_WITNESS_PATH = join(dir, 'shadow-witness.json');
  try { fn(process.env.GRID_READING_PATH); } finally {
    if (prev.g == null) delete process.env.GRID_READING_PATH; else process.env.GRID_READING_PATH = prev.g;
    if (prev.s == null) delete process.env.SHADOW_WITNESS_PATH; else process.env.SHADOW_WITNESS_PATH = prev.s;
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 1. The operator clear ───────────────────────────────────────────────────────────── */

test('★★★ a veto held on a DARK panel\'s reading is clearable; clearing lifts it and the panel\'s next reading counts again', () => {
  withPaths((file) => {
    const s = new SnapshotStore();
    let t = Date.now() - 20 * 60_000;
    s.setClock(() => t);
    s.setDeviceList(listed(1));
    s.setDeviceQuota(SN, quota(0));
    s.setDeviceOnline(SN, false); // the panel goes dark; the grid comes back meanwhile
    const before = toggleOn(s.get().devices);
    assert.equal(before.backstopping, false);
    assert.equal(before.vetoClearable, true, 'held on a reading the panel is not refreshing');
    t = Date.now();
    assert.equal(s.clearGridVeto(), 1);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {}, 'the saved reading is forgotten too');
    const after = toggleOn(s.get().devices);
    assert.equal(after.declared, true, 'the declaration stands again');
    assert.equal(after.vetoClearable, false);
    s.setDeviceList(listed(1)); // the 60 s rebuild keeps the clear
    assert.equal(toggleOn(s.get().devices).declared, true);
    // The panel reports again — still no grid: that NEW reading vetoes.
    t += 60_000;
    s.setDeviceQuota(SN, quota(0, 2));
    assert.equal(toggleOn(s.get().devices).declared, false, 'the next real reading counts');
  });
});

test('★★ a panel FRESHLY reporting no grid is not clearable (it is the measurement)', () => {
  withPaths(() => {
    const s = new SnapshotStore();
    s.setDeviceList(listed(1));
    s.setDeviceQuota(SN, quota(0));
    const g = toggleOn(s.get().devices);
    assert.equal(g.backstopping, false);
    assert.equal(g.vetoClearable, false);
  });
});

test('the endpoint refuses when nothing is clearable, and is write-auth guarded; the card offers it only when clearable', () => {
  const idx = src('index.ts');
  assert.match(idx, /app\.post\('\/api\/grid-veto\/clear', \{ preHandler: requireWriteAuth \}/);
  assert.match(idx, /if \(!g\.vetoClearable\) \{\s*reply\.code\(409\);/);
  const card = readFileSync(new URL('../../web/src/cards/Shp2Card.tsx', import.meta.url), 'utf8');
  assert.match(card, /if \(!grid\?\.vetoClearable && state !== 'done'\) return null;/);
  assert.match(card, /window\.confirm\(/);
});

/* ── 2. The starved-feed guard, on the main thread ──────────────────────────────────── */

test('★★★ the starved-feed guard: drops a starved Core\'s anomalies, keeps an idle-held Core\'s', () => {
  const a = (sn: string): Any => ({ id: `baseline-mppt_hv_temp-${sn}`, sourceSn: sn, severity: 'warning', source: 'learned' });
  const other: Any = { id: 'forecast-runtime-P', severity: 'info' };
  const out = applyStarvedFeedFilter([a('C1'), a('C2'), a('C3'), other], ['C1', 'C2'], new Set(['C2']));
  assert.deepEqual(out.map((x) => x.id), ['baseline-mppt_hv_temp-C2', 'baseline-mppt_hv_temp-C3', 'forecast-runtime-P'],
    'C1 starved: dropped; C2 idle-held (healthy, slow): kept; C3 fine: kept');
  assert.equal(applyStarvedFeedFilter([a('C1')], [], new Set()).length, 1);
});

test('★★ wiring: the worker no longer reads the (never-set) rate-floor state; the monitor applies it', () => {
  assert.doesNotMatch(src('analytics.ts'), /getRateFloorCollapses/, 'the analytics worker never receives it');
  assert.match(src('analytics.ts'), /sourceSn: t\.sn, \/\/ v1\.184\.0/);
  assert.match(src('alertMonitor.ts'), /\.\.\.applyStarvedFeedFilter\(baselineAlerts, getRateFloorCollapses\(\)\.map\(\(c\) => c\.sn\), rateFloorIdleHeldSns\(\)\),/);
});

/* ── 3. A client hang-up is not a server error ──────────────────────────────────────── */

test('★★ "premature close" (a client hang-up) is demoted to debug through a REAL pino logger; real errors stay at error', () => {
  const lines: Any[] = [];
  const sink = new Writable({ write(chunk, _e, cb) { lines.push(JSON.parse(String(chunk))); cb(); } });
  const log = pino({ level: 'debug', hooks: { logMethod: logMethodHook as never } }, sink);
  log.error({ err: new Error('premature close') }, 'premature close');
  log.error('mqtt: start failed (REST polling continues)');
  log.info('stream closed prematurely');
  assert.equal(lines.length, 2, 'the pre-existing "stream closed prematurely" drop still applies');
  assert.equal(lines[0].level, 20, 'the hang-up is at debug');
  assert.equal(lines[0].msg, 'premature close', 'kept, not dropped');
  assert.equal(lines[1].level, 50, 'a real error stays an error');
  assert.equal(isClientHangup(['something else']), false);
  assert.match(src('index.ts'), /hooks: \{ logMethod: logMethodHook as never \}/);
});
