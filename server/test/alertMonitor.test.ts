import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuietHours, inQuietWindow, buildIncidents } from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';

test('parseQuietHours — accepts "22-06" → [22, 6]', () => {
  assert.deepEqual(parseQuietHours('22-06'), [22, 6]);
});

test('parseQuietHours — accepts "0-12" → [0, 12]', () => {
  assert.deepEqual(parseQuietHours('0-12'), [0, 12]);
});

test('parseQuietHours — rejects empty / invalid input', () => {
  assert.equal(parseQuietHours(''), null);
  assert.equal(parseQuietHours('22'), null);
  assert.equal(parseQuietHours('22-'), null);
  assert.equal(parseQuietHours('22-25'), null); // 25 > 23
  assert.equal(parseQuietHours('-1-5'), null);
});

test('inQuietWindow — non-wrapping window (9-17)', () => {
  const win: [number, number] = [9, 17];
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 8), win), false);   // 8am — before
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 9), win), true);    // 9am — start boundary (inclusive)
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 12), win), true);   // noon — inside
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 16), win), true);   // 4pm — inside
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 17), win), false);  // 5pm — end boundary (exclusive)
});

test('inQuietWindow — wrapping window (22-06) is inside both before & after midnight', () => {
  const win: [number, number] = [22, 6];
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 21), win), false); // 9pm — before window
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 22), win), true);  // 10pm — start
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 23, 59), win), true); // 11:59pm
  assert.equal(inQuietWindow(new Date(2026, 0, 2, 0), win), true);   // midnight (next day)
  assert.equal(inQuietWindow(new Date(2026, 0, 2, 5, 59), win), true); // 5:59am
  assert.equal(inQuietWindow(new Date(2026, 0, 2, 6), win), false);  // 6am — end boundary (exclusive)
});

test('inQuietWindow — window collapsed (start == end) is always false', () => {
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 10), [10, 10]), false);
  assert.equal(inQuietWindow(new Date(2026, 0, 1, 23), [10, 10]), false);
});

function alert(id: string, sev: Alert['severity'], coreNum: number | null, packNum: number | null, title: string): Alert {
  return {
    id,
    severity: sev,
    category: 'Battery',
    device: coreNum != null ? `Core ${coreNum}` : 'System',
    title,
    detail: '',
    coreNum,
    packNum,
  };
}

test('buildIncidents — 2 alerts on the same Pack collapse to one incident', () => {
  const inc = buildIncidents([
    alert('temp-hot-Y7-X-3', 'warning', 3, 2, 'Pack 2 hot'),
    alert('cell-imbalance-Y7-X-3', 'info', 3, 2, 'Pack 2 cell spread'),
  ]);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].alertCount, 2);
  assert.equal(inc[0].scope, 'pack');
  assert.equal(inc[0].coreNum, 3);
  assert.equal(inc[0].packNum, 2);
  // Highest severity wins (warning > info)
  assert.equal(inc[0].severity, 'warning');
});

test('buildIncidents — single Core-level alert (no pack) becomes scope="core"', () => {
  const inc = buildIncidents([alert('mppt-hot-3', 'warning', 3, null, 'HV MPPT hot')]);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].scope, 'core');
  assert.equal(inc[0].alertCount, 1);
});

test('buildIncidents — thermal-cascade name fires for 2+ Thermal alerts on same Core', () => {
  // 2 Thermal-category alerts on Core 3 with no pack → "Thermal cascade on Core 3"
  const a1: Alert = { ...alert('mppt-hot-3', 'warning', 3, null, 'HV MPPT hot'), category: 'Thermal' };
  const a2: Alert = { ...alert('inverter-hot-3', 'warning', 3, null, 'Inverter hot'), category: 'Thermal' };
  const inc = buildIncidents([a1, a2]);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].alertCount, 2);
  assert.match(inc[0].title, /Thermal cascade on Core 3/);
});

test('buildIncidents — orphan (no core/pack) gets scope="system"', () => {
  const a: Alert = {
    id: 'cloud-session-stale',
    severity: 'warning',
    category: 'Connectivity',
    device: 'EcoFlow Cloud',
    title: 'Cloud session stale',
    detail: '',
  };
  const inc = buildIncidents([a]);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].scope, 'system');
});

test('buildIncidents — sorted by severity (critical first), then by alertCount desc', () => {
  const inc = buildIncidents([
    alert('a-info', 'info', 5, 1, 'A'),
    alert('b-warn', 'warning', 4, null, 'B'),
    alert('c-crit-1', 'critical', 3, 2, 'C1'),
    alert('c-crit-2', 'critical', 3, 2, 'C2'), // groups with c-crit-1
  ]);
  // First incident should be the critical pack with 2 alerts.
  assert.equal(inc[0].severity, 'critical');
  assert.equal(inc[0].alertCount, 2);
});

/* ─── v0.15.21 — notified-state persistence across restarts ──────────── */

import { loadNotifiedState, saveNotifiedState, NOTIFY_STATE_MAX_AGE_MS } from '../src/alertMonitor.js';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpPaths: string[] = [];
let seq = 0;
function tmpState(): string {
  const p = join(tmpdir(), `notify-state-${process.pid}-${seq++}.json`);
  tmpPaths.push(p);
  return p;
}

test('notify-state — round-trips notified alerts across a "restart"', () => {
  const path = tmpState();
  const now = Date.now();
  const state = new Map([['forecast-runtime-dip', now - 60_000], ['soc-low-20', now - 5_000]]);
  saveNotifiedState(path, state);
  const loaded = loadNotifiedState(path, now);
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get('forecast-runtime-dip'), now - 60_000);
});

test('notify-state — stale entries (> 24 h) are dropped at load', () => {
  const path = tmpState();
  const now = Date.now();
  saveNotifiedState(path, new Map([
    ['old-event', now - NOTIFY_STATE_MAX_AGE_MS - 1000],
    ['fresh-event', now - 1000],
  ]));
  const loaded = loadNotifiedState(path, now);
  assert.equal(loaded.size, 1);
  assert.ok(loaded.has('fresh-event'));
});

test('notify-state — corrupt or missing files seed fresh, never throw', () => {
  const missing = loadNotifiedState(join(tmpdir(), 'definitely-not-here.json'));
  assert.equal(missing.size, 0);
  const path = tmpState();
  writeFileSync(path, '{broken json');
  assert.equal(loadNotifiedState(path).size, 0);
  const path2 = tmpState();
  writeFileSync(path2, JSON.stringify({ weird: 'not-a-number' }));
  assert.equal(loadNotifiedState(path2).size, 0);
});

test.after(() => {
  for (const p of tmpPaths) {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});
