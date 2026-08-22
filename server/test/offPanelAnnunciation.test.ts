import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceOffPanelStreaks, shouldDemoteAnnunciation, OFF_PANEL_DEMOTE_TICKS,
} from '../src/alertMonitor.js';
import { isNeverMutedAlert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Alert } from '../src/alerts.js';

/**
 * v1.95.0 — OFF-PANEL annunciation demotion.
 *
 * MOTIVATING INCIDENT (2026-08-20). A physical reconfiguration inverted the
 * static SPARE_DPU_SNS literal: a benched Core absent from the literal
 * annunciated at full volume while a live home Core sat inside it. In one 3h34m
 * audit window 19 of 19 pushes and 48 of 67 seconds of audio concerned hardware
 * that cannot deliver a watt to the house — while the genuinely defective
 * warranty pack, muted by the same literal, emitted nothing.
 *
 * The gate is now the SHP2's own roster, with hysteresis so a flickering
 * isConnect can never silence a live home Core, and a thermal-critical carve-out
 * so a bench pack that is overheating still pages.
 */

const CORE1 = 'Y711ZAB59GBC0314';
const CORE5 = 'Y711ZAB59G9P0090';
const BENCH = 'Y711FAB59J234000';

const dpu = (sn: string): DeviceSnapshot => ({
  sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: true, lastUpdated: 1,
  projection: { kind: 'dpu' } as any,
} as DeviceSnapshot);

const devices = (...a: DeviceSnapshot[]) => Object.fromEntries(a.map((d) => [d.sn, d]));

const alert = (id: string, over: Partial<Alert> = {}): Alert => ({
  id, severity: 'warning', category: 'Battery', device: 'x', title: 't', detail: 'd', ...over,
} as Alert);

test('off-panel — demotion requires OFF_PANEL_DEMOTE_TICKS consecutive absences', () => {
  const streak = new Map<string, number>();
  const roster = new Set([CORE1, CORE5]);
  const devs = devices(dpu(CORE1), dpu(CORE5), dpu(BENCH));
  for (let i = 1; i < OFF_PANEL_DEMOTE_TICKS; i++) {
    assert.deepEqual(advanceOffPanelStreaks(devs, roster, streak), [], `tick ${i}: not yet`);
  }
  assert.deepEqual(advanceOffPanelStreaks(devs, roster, streak), [BENCH], 'demotes on the Nth tick');
});

test('off-panel — ONE sighting re-arms instantly (a flickering isConnect cannot silence a home Core)', () => {
  const streak = new Map<string, number>();
  const devs = devices(dpu(CORE1), dpu(CORE5));
  const full = new Set([CORE1, CORE5]);
  const flickered = new Set([CORE1]); // CORE5 briefly missing from the roster
  for (let i = 0; i < OFF_PANEL_DEMOTE_TICKS - 1; i++) advanceOffPanelStreaks(devs, flickered, streak);
  assert.deepEqual(advanceOffPanelStreaks(devs, full, streak), [], 'one sighting clears the streak');
  // ...and the counter really reset, so the next absence starts from zero.
  for (let i = 1; i < OFF_PANEL_DEMOTE_TICKS; i++) {
    assert.deepEqual(advanceOffPanelStreaks(devs, flickered, streak), [], 'streak restarted');
  }
});

test('off-panel — an EMPTY roster demotes nobody (panel unreadable ⇒ trust nothing)', () => {
  const streak = new Map<string, number>();
  const devs = devices(dpu(CORE1), dpu(BENCH));
  for (let i = 0; i < OFF_PANEL_DEMOTE_TICKS + 2; i++) {
    assert.deepEqual(advanceOffPanelStreaks(devs, new Set(), streak), []);
  }
  assert.equal(streak.size, 0, 'streaks cleared, not accumulated');
});

test('off-panel — only DPUs are considered (the SHP2 is never demoted by its own roster)', () => {
  const streak = new Map<string, number>();
  const shp2 = { sn: 'HD31ZASAHH120432', deviceName: 'SHP2', productName: 'Smart Home Panel 2',
    online: true, lastUpdated: 1, projection: { kind: 'shp2' } as any } as DeviceSnapshot;
  const devs = devices(dpu(CORE1), shp2);
  for (let i = 0; i < OFF_PANEL_DEMOTE_TICKS + 1; i++) advanceOffPanelStreaks(devs, new Set([CORE1]), streak);
  assert.equal(streak.has('HD31ZASAHH120432'), false);
});

test('demotion — a critical THERMAL alert is never demoted, even on off-panel hardware', () => {
  const muted = [BENCH];
  assert.equal(
    shouldDemoteAnnunciation(alert(`temp-${BENCH}-1-critical`, { severity: 'critical', category: 'Thermal' }), muted),
    false, 'an overheating bench pack must still page');
  assert.equal(
    shouldDemoteAnnunciation(alert(`temp-${BENCH}-1-warning`, { severity: 'warning', category: 'Thermal' }), muted),
    true, 'a non-critical thermal on bench hardware is demoted');
  assert.equal(
    shouldDemoteAnnunciation(alert(`vdiff-crit-${BENCH}-1`, { severity: 'critical', category: 'Battery' }), muted),
    true, 'a critical NON-thermal on bench hardware is demoted');
});

test('demotion — home hardware and already-demoted alerts are left alone', () => {
  assert.equal(shouldDemoteAnnunciation(alert(`vdiff-crit-${CORE1}-1`), [BENCH]), false, 'home core untouched');
  assert.equal(
    shouldDemoteAnnunciation(alert(`vdiff-crit-${BENCH}-1`, { annunciate: false }), [BENCH]), false,
    'already demoted — no double work');
  assert.equal(shouldDemoteAnnunciation(alert('storm-Extreme_Heat_Warning'), [BENCH]), false, 'fleet-wide alert untouched');
});

/* ══════════════════════════════════════════════════════════════════════════
 * v1.101.0 — the QUIET half of the severity inversion.
 *
 * v1.95.0 fixed the noisy half: off-panel hardware stopped chiming. The quiet
 * half remained — the genuinely defective warranty pack sat on a bench chassis
 * where every alert it raised was demoted, so the only battery that is actually
 * broken was the only one the operator was never paged about. A confirmed BMS
 * protection latch with an identified deviant cell now annunciates from
 * anywhere, because "this battery is broken" is true wherever it is wired.
 * ═══════════════════════════════════════════════════════════════════════ */

test('never-muted — a confirmed-defective pack annunciates from bench hardware', () => {
  const muted = [BENCH];
  assert.equal(
    shouldDemoteAnnunciation(alert(`pack-defective-${BENCH}-1`, { severity: 'warning', category: 'Battery' }), muted),
    false, 'the one pack that is actually broken must not be silenced by its location');
  // ...while the ordinary per-tick families on the same hardware still go quiet.
  assert.equal(shouldDemoteAnnunciation(alert(`vdiff-warn-${BENCH}-1`), muted), true);
  assert.equal(shouldDemoteAnnunciation(alert(`soc-low-${BENCH}-1`), muted), true);
});

test('never-muted — the predicate is shared, so both demotion paths agree', () => {
  const defective = alert(`pack-defective-${BENCH}-1`, { severity: 'warning', category: 'Battery' });
  const thermalCrit = alert(`temp-cell-${BENCH}-1-critical`, { severity: 'critical', category: 'Thermal' });
  const ordinary = alert(`vdiff-crit-${BENCH}-1`, { severity: 'critical', category: 'Battery' });
  for (const a of [defective, thermalCrit]) {
    assert.equal(isNeverMutedAlert(a), true, `${a.id} must always be heard`);
    assert.equal(shouldDemoteAnnunciation(a, [BENCH]), false, `${a.id} demotion must agree with the predicate`);
  }
  assert.equal(isNeverMutedAlert(ordinary), false);
  assert.equal(shouldDemoteAnnunciation(ordinary, [BENCH]), true);
});
