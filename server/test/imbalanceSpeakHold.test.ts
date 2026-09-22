/**
 * v1.174.0 — the cell-imbalance SPEAK HOLD.
 *
 * A cell-voltage spread warning fires at 24 mV and holds at 20 mV, which normal working
 * packs cross for a few minutes and settle back out of. On 2026-09-21 a 6-minute
 * excursion at 21:14 (one pack's own spread, plus the same pack as a peer outlier 40 s
 * later) spoke a yellow over the house; the overnight record is full of 2-30 minute
 * episodes. Nothing in the first minutes is actionable — the operator cannot act faster
 * than the pack rebalances — so the audible now waits for the spread to STAND.
 *
 * Scope is the point of these tests: the hold must touch the AUDIBLE path only, must not
 * touch the CRITICAL, and must not touch any other warning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  heldForImbalanceConfirm,
  conditionFromAlerts,
  IMBALANCE_SPEAK_HOLD_MS,
  IMBALANCE_SPEAK_HOLD_PREFIXES,
} from '../src/broadcast.js';
import type { Alert } from '../src/alerts.js';

const now = Date.now();
const MIN = 60_000;
const warn = (id: string): Alert => ({ id, severity: 'warning', category: 'Battery', device: 'Core 1', title: 'Cell imbalance', detail: 'spread 26 mV' } as Alert);
const crit = (id: string): Alert => ({ ...warn(id), severity: 'critical' } as Alert);

/* ── the hold itself ──────────────────────────────────────────────────────── */

test('★★★ the 6-minute excursion that spoke at 21:14 is HELD', () => {
  assert.equal(heldForImbalanceConfirm(warn('vdiff-warn-SN-1'), now, now - 6 * MIN), true);
});

test('a spread that has STOOD past the hold is spoken — delayed, never dropped', () => {
  assert.equal(heldForImbalanceConfirm(warn('vdiff-warn-SN-1'), now, now - 11 * MIN), false);
  assert.equal(IMBALANCE_SPEAK_HOLD_MS, 10 * MIN, 'the hold is ten minutes');
});

test('the peer-outlier report of the SAME event is held too (both fired within 40 s at 21:14)', () => {
  assert.equal(heldForImbalanceConfirm(warn('peer-voldiff-SN-1-1'), now, now - MIN), true);
  assert.deepEqual([...IMBALANCE_SPEAK_HOLD_PREFIXES], ['vdiff-warn-', 'peer-voldiff-']);
});

test('★★★ the CRITICAL imbalance is NEVER held — it speaks at once', () => {
  // The live critical id sits outside the held prefixes…
  assert.equal(heldForImbalanceConfirm(crit('vdiff-crit-SN-1-2'), now, now), false);
  // …and the hold is severity-scoped in its own right, so it cannot start delaying a
  // critical if one of these families ever escalates. A comfort guard must never be the
  // reason an emergency waits ten minutes.
  for (const prefix of IMBALANCE_SPEAK_HOLD_PREFIXES) {
    assert.equal(heldForImbalanceConfirm(crit(`${prefix}SN-1-2`), now, now), false, `${prefix} critical must speak`);
  }
});

test('an INFO peer-outlier is not held either — the hold only ever delays a WARNING', () => {
  const info = { id: 'peer-voldiff-SN-1-1', severity: 'info' } as Alert;
  assert.equal(heldForImbalanceConfirm(info, now, now), false, 'info alerts stay in the array the tick evaluates');
});

test('an unknown onset holds — bounded to one 20 s sync tick, and an unrecorded id is a new one', () => {
  assert.equal(heldForImbalanceConfirm(warn('vdiff-warn-SN-1'), now, undefined), true);
});

test('no other alert family is touched by this guard', () => {
  for (const id of ['stale-SN-1', 'dpu-imbalance-SN-1', 'msg-rate-floor-SN-1', 'dpu-pvh-err-SN-1', 'telemetry-blind']) {
    assert.equal(heldForImbalanceConfirm(warn(id), now, now), false, `${id} must not be held`);
  }
});

test('an onset exactly at the boundary is released (>= holdMs speaks)', () => {
  assert.equal(heldForImbalanceConfirm(warn('vdiff-warn-SN-1'), now, now - IMBALANCE_SPEAK_HOLD_MS), false);
  assert.equal(heldForImbalanceConfirm(warn('vdiff-warn-SN-1'), now, now - IMBALANCE_SPEAK_HOLD_MS + 1), true);
});

/* ── the effect on the audible condition ──────────────────────────────────── */

test('a held imbalance leaves the audible condition GREEN (no chime, no message)', () => {
  const alerts = [warn('vdiff-warn-SN-1'), warn('peer-voldiff-SN-1-1')];
  assert.equal(conditionFromAlerts(alerts).level, 'yellow', 'unfiltered, these raise a yellow');
  const spoken = alerts.filter((a) => !heldForImbalanceConfirm(a, now, now - 2 * MIN));
  assert.equal(conditionFromAlerts(spoken).level, 'green', 'held, they raise nothing');
});

test('a co-occurring OTHER warning still raises the yellow (the hold mutes one family, not the tick)', () => {
  const alerts = [warn('vdiff-warn-SN-1'), warn('dpu-imbalance-SN-1')];
  const spoken = alerts.filter((a) => !heldForImbalanceConfirm(a, now, now - 2 * MIN));
  assert.equal(spoken.length, 1);
  assert.equal(conditionFromAlerts(spoken).level, 'yellow');
});

test('a co-occurring CRITICAL still raises RED while the imbalance warning is held', () => {
  const alerts = [warn('vdiff-warn-SN-1'), crit('telemetry-blind')];
  const spoken = alerts.filter((a) => !heldForImbalanceConfirm(a, now, now - 2 * MIN));
  const c = conditionFromAlerts(spoken);
  assert.equal(c.level, 'red');
  assert.deepEqual(c.criticalIds, ['telemetry-blind']);
});

/* ── wiring: the filter is on the audible path and nowhere else ───────────── */

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, '../src/', f), 'utf8');

test('the hold is applied in the broadcast tick, against the persistent onset sidecar', () => {
  const B = src('broadcast.ts');
  assert.ok(B.includes('.filter((a) => !heldForImbalanceConfirm(a, tickNow, getAlertOnset(a.id)))'),
    'the tick filters the array that feeds BOTH conditionFromAlerts and messageFor');
  assert.ok(B.includes("import { getAlertOnset } from './alertOnset.js';"),
    'age comes from the restart-persistent sidecar, not an in-process map that a daily restart would reset');
});

test('the card and the push are NOT filtered — the hold exists only on the audible path', () => {
  const AM = src('alertMonitor.ts');
  assert.ok(!AM.includes('heldForImbalanceConfirm'), 'alertMonitor (cards, pushes, digest) is untouched');
  assert.ok(!src('alerts.ts').includes('heldForImbalanceConfirm'), 'the alarm engine still raises the alert immediately');
});
