import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertMessage } from '../src/ttsService.js';
import type { Alert } from '../src/alerts.js';

/**
 * v0.9.29 / v0.9.70 — TTS alert-message tests.
 *
 * Pre-v0.9.70 this file ALSO tested the speakerProfiles.ts helpers
 * (inferProtocol, defaultBufferMs, groupByProtocol, scheduleStagger).
 * Those went away in v0.9.70's broadcast rewrite — the new pipeline
 * fires one MA play_announcement to every target at once, no protocol
 * bucketing or per-group stagger. The 11 tests for that machinery were
 * removed alongside `server/src/speakerProfiles.ts`.
 *
 * What stays: buildAlertMessage. It's still the spoken-text formatter
 * the broadcast monitor calls, and it does meaningful normalization
 * (SoH → "state of health", % → percent, MPPT → "M P P T", etc.) that
 * matters whether the engine is Wyoming/Piper or Cloud — keep tests.
 */

/* ─── buildAlertMessage — alert → spoken sentence ────────────────── */

test('buildAlertMessage — green → all clear', () => {
  const m = buildAlertMessage('green', []);
  assert.match(m, /All clear/);
});

test('buildAlertMessage — red with critical alert names category + repeats', () => {
  const alerts: Alert[] = [{
    id: 'soh-crit-DEADBEEF12345678-2',
    severity: 'critical',
    category: 'Battery',
    device: 'Core 3',
    title: 'Pack health critical',
    detail: 'Core 3 Pack 2 SoH 68.2% (critical < 70%).',
    coreNum: 3,
    packNum: 2,
  }];
  const m = buildAlertMessage('red', alerts);
  assert.match(m, /Red alert/);
  assert.match(m, /Battery system/);
  assert.match(m, /Core three pack two/);
  assert.match(m, /state of health/);
  assert.match(m, /percent/);
  assert.match(m, /Acknowledge at console/);
  assert.match(m, /Repeat/);
});

test('buildAlertMessage — yellow expands MPPT / HV', () => {
  const alerts: Alert[] = [{
    id: 'mppt-hv', severity: 'warning', category: 'Solar', device: 'Core 5',
    title: 'HV MPPT error code',
    detail: 'Core 5 HV solar reports error code 17.',
    coreNum: 5,
  }];
  const m = buildAlertMessage('yellow', alerts);
  assert.match(m, /Yellow alert/);
  assert.match(m, /Solar system/);
  assert.match(m, /Core five/);
  assert.match(m, /high voltage/);
  assert.match(m, /M P P T/);
  assert.doesNotMatch(m, /Repeat/, "warning shouldn't repeat");
});

test('buildAlertMessage — red without alerts still says red alert', () => {
  const m = buildAlertMessage('red', []);
  assert.match(m, /Red alert/);
  assert.match(m, /Critical condition/i);
});

test('buildAlertMessage — Battery > Solar in priority order', () => {
  const alerts: Alert[] = [
    { id: 'a', severity: 'critical', category: 'Solar',   device: 'core 5', title: 'Solar problem',   detail: 'd', coreNum: 5 },
    { id: 'b', severity: 'critical', category: 'Battery', device: 'core 3', title: 'Battery problem', detail: 'd', coreNum: 3 },
  ];
  const m = buildAlertMessage('red', alerts);
  assert.match(m, /Battery problem/);
  assert.doesNotMatch(m, /Solar problem/);
});
