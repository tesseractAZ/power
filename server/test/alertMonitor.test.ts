import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuietHours, inQuietWindow, buildIncidents, decideAlertDispatch, isAlertEscalation } from '../src/alertMonitor.js';
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

/* ── v0.76.0 — the rising-edge dispatch decision (quiet-queue vs push vs none) ── */

const D = {
  qualifies: true, alreadyNotified: false, alreadyQueued: false, escalated: false,
  debounceElapsed: true, inQuiet: false, breaksThrough: false,
};

test('decideAlertDispatch — fresh qualifying alert outside quiet hours → dispatch', () => {
  assert.equal(decideAlertDispatch({ ...D }), 'dispatch');
});

test('decideAlertDispatch — fresh qualifying alert IN quiet hours (no break-through) → queue', () => {
  assert.equal(decideAlertDispatch({ ...D, inQuiet: true }), 'queue');
});

test('decideAlertDispatch — critical in quiet hours WITH break-through → dispatch', () => {
  assert.equal(decideAlertDispatch({ ...D, inQuiet: true, breaksThrough: true }), 'dispatch');
});

test('decideAlertDispatch — already notified, not escalated → none (no re-push)', () => {
  assert.equal(decideAlertDispatch({ ...D, alreadyNotified: true }), 'none');
});

test('decideAlertDispatch — already queued, not escalated → none (no re-queue every tick)', () => {
  assert.equal(decideAlertDispatch({ ...D, alreadyQueued: true }), 'none');
});

test('decideAlertDispatch — ESCALATED re-notifies even after a prior push (outside quiet → dispatch)', () => {
  assert.equal(decideAlertDispatch({ ...D, alreadyNotified: true, escalated: true }), 'dispatch');
});

test('decideAlertDispatch — escalated but in quiet hours (no break-through) → queue', () => {
  assert.equal(decideAlertDispatch({ ...D, alreadyNotified: true, escalated: true, inQuiet: true }), 'queue');
});

test('decideAlertDispatch — not yet debounced → none', () => {
  assert.equal(decideAlertDispatch({ ...D, debounceElapsed: false }), 'none');
});

test('decideAlertDispatch — does not qualify (below min severity) → none', () => {
  assert.equal(decideAlertDispatch({ ...D, qualifies: false }), 'none');
});

test('decideAlertDispatch — a queued alert that later ESCALATES is still eligible (escalated overrides alreadyQueued)', () => {
  // The restart-drop fix sets `alreadyQueued` instead of `alreadyNotified` for a
  // held alert; escalation must still be able to re-evaluate it.
  assert.equal(decideAlertDispatch({ ...D, alreadyQueued: true, escalated: true, inQuiet: true }), 'queue');
  assert.equal(decideAlertDispatch({ ...D, alreadyQueued: true, escalated: true, inQuiet: false }), 'dispatch');
});

/* ── v0.76.0 — escalation detection incl. the queued path (the review must-fix) ── */

test('isAlertEscalation — a DISPATCHED warning escalating to critical is an escalation', () => {
  assert.equal(isAlertEscalation({ notified: true, notifiedSeverity: 'warning' }, 'critical'), true);
});

test('isAlertEscalation — a QUEUED warning escalating to critical IS detected (the restart-drop must-fix)', () => {
  // Before the fix, a queued alert had notified=false / notifiedSeverity=undefined, so an
  // escalation while held in quiet hours was invisible — under CRITICAL_BREAKS_QUIET_HOURS=true
  // a real overnight critical would never break through. notifiedSeverity is now recorded at
  // queue time, so escalation fires for a held alert too.
  assert.equal(isAlertEscalation({ notified: false, queued: true, notifiedSeverity: 'warning' }, 'critical'), true);
});

test('isAlertEscalation — a queued alert at the SAME severity is not an escalation', () => {
  assert.equal(isAlertEscalation({ notified: false, queued: true, notifiedSeverity: 'warning' }, 'warning'), false);
});

test('isAlertEscalation — a fresh alert never acted on (no notifiedSeverity) cannot escalate', () => {
  assert.equal(isAlertEscalation({ notified: false, queued: false }, 'critical'), false);
  assert.equal(isAlertEscalation({ notified: false }, 'critical'), false);
});

test('isAlertEscalation — a DE-escalation (critical → warning) is not an escalation', () => {
  assert.equal(isAlertEscalation({ notified: true, notifiedSeverity: 'critical' }, 'warning'), false);
});

test('isAlertEscalation — end-to-end with decideAlertDispatch: a queued warning→critical re-queues (quiet) / dispatches (break-through)', () => {
  // The integration the review flagged as previously unreachable: queued + escalated.
  const prev = { notified: false, queued: true, notifiedSeverity: 'warning' as const };
  const escalated = isAlertEscalation(prev, 'critical');
  assert.equal(escalated, true);
  const base = { qualifies: true, alreadyNotified: false, alreadyQueued: true, escalated, debounceElapsed: true };
  assert.equal(decideAlertDispatch({ ...base, inQuiet: true, breaksThrough: false }), 'queue'); // re-queue at critical
  assert.equal(decideAlertDispatch({ ...base, inQuiet: true, breaksThrough: true }), 'dispatch'); // breaks through
});

test.after(() => {
  for (const p of tmpPaths) {
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
});
