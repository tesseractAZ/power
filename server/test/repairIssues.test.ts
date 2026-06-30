import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v0.76.0 — repair-issue card tests.
 *
 * Pins two defect fixes plus two pre-existing invariants:
 *
 *  (1) SEVERITY MISMATCH — the cloud-offline repair card must match the
 *      alert engine's severity for the SAME offline event. alerts.ts
 *      (offline branch) classifies Cores + the SHP2 as 'warning' and every
 *      peripheral (Smart Generator, WAVE 2, EVSE, ...) as 'info'. Previously
 *      repairIssues hard-coded 'warning' for ALL offline devices, so a WAVE 2
 *      got a 'warning' card while the alert said 'info' — same event, two
 *      severities. Split is product-name based: 'delta pro ultra' = Core,
 *      'smart home panel' = SHP2 → warning; anything else → info.
 *
 *  (2) SOILING THRESHOLD — the repair card must fire at the SAME drop% as the
 *      soiling alert (analytics.ts: dropPct >= 12). The card previously
 *      required >= 15, so a 12–15% drop was alerted-but-uncardable.
 *
 *  (3) Spare-DPU skip — an intentionally-offline bench spare (SPARE_DPU_SNS)
 *      gets NO cloud-offline card (its offline state is expected steady state).
 *
 *  (4) firstSeenAt persistence — the same active id keeps its first-seen
 *      timestamp across repeated computeRepairIssues calls.
 *
 * Isolation: REPAIR_FIRST_SEEN_PATH is pointed at a throwaway temp file BEFORE
 * importing the module, so the test never reads/writes the real sidecar and the
 * module-level firstSeenById map starts empty.
 */

// Must be set before the dynamic import below — the module resolves the sidecar
// path and loads firstSeenById at import time.
process.env.REPAIR_FIRST_SEEN_PATH = join(
  mkdtempSync(join(tmpdir(), 'repair-first-seen-')),
  'repair-first-seen.json',
);

const { computeRepairIssues } = await import('../src/repairIssues.js');
const { SPARE_DPU_SNS } = await import('../src/shp2Membership.js');
import type { RepairContext } from '../src/repairIssues.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { SoilingDecomposition, SoilingPerDevice } from '../src/analytics.js';

/* ─── fixtures ──────────────────────────────────────────────────── */

function device(opts: {
  sn: string;
  deviceName: string;
  productName: string;
  online: boolean;
}): DeviceSnapshot {
  return {
    sn: opts.sn,
    deviceName: opts.deviceName,
    productName: opts.productName,
    online: opts.online,
    lastUpdated: 0,
  };
}

/** A RepairContext with only `devices` populated; everything else nulled out. */
function ctxWithDevices(devices: DeviceSnapshot[]): RepairContext {
  return {
    devices: Object.fromEntries(devices.map((d) => [d.sn, d])),
    alerts: [],
    degradation: null,
    soiling: null,
    equipmentHealth: null,
    forecastSkill: null,
  };
}

function perDevice(dropPct: number | null, cleanDays = 6): SoilingPerDevice {
  return {
    sn: 'CORE_1',
    device: 'Core 1',
    coreNum: 1,
    dropPct,
    cleanDays,
    recentCoeff: 0.8,
    baselineCoeff: 1.0,
  };
}

function ctxWithSoiling(rows: SoilingPerDevice[]): RepairContext {
  const soiling: SoilingDecomposition = {
    generatedAt: 0,
    perDevice: rows,
    perHour: [],
  };
  return {
    devices: {},
    alerts: [],
    degradation: null,
    soiling,
    equipmentHealth: null,
    forecastSkill: null,
  };
}

const CORE = 'DELTA Pro Ultra';
const SHP2 = 'Smart Home Panel 2';
const GENERATOR = 'Smart Generator';
const WAVE = 'WAVE 2';

/* ─── (3) spare-DPU skip ────────────────────────────────────────── */

test('cloud-offline — designated bench spare gets NO repair card', () => {
  const spareSn = [...SPARE_DPU_SNS][0]; // a real spare SN (Core 4)
  const ctx = ctxWithDevices([
    device({ sn: spareSn, deviceName: 'Core 4', productName: CORE, online: false }),
  ]);
  const issues = computeRepairIssues(ctx).issues;
  assert.equal(issues.filter((i) => i.id.startsWith('cloud-offline-')).length, 0);
});

/* ─── (1) peripheral=info vs core=warning severity fix ──────────── */

test('cloud-offline — offline Core gets a WARNING card', () => {
  const ctx = ctxWithDevices([
    device({ sn: 'CORE_1', deviceName: 'Core 1', productName: CORE, online: false }),
  ]);
  const card = computeRepairIssues(ctx).issues.find((i) => i.id === 'cloud-offline-CORE_1');
  assert.ok(card, 'expected a cloud-offline card for the Core');
  assert.equal(card.severity, 'warning');
});

test('cloud-offline — offline SHP2 gets a WARNING card', () => {
  const ctx = ctxWithDevices([
    device({ sn: 'SHP2_1', deviceName: 'Smart Home Panel 2', productName: SHP2, online: false }),
  ]);
  const card = computeRepairIssues(ctx).issues.find((i) => i.id === 'cloud-offline-SHP2_1');
  assert.ok(card);
  assert.equal(card.severity, 'warning');
});

test('cloud-offline — offline peripheral (Smart Generator) gets an INFO card', () => {
  const ctx = ctxWithDevices([
    device({ sn: 'GEN_1', deviceName: 'Smart Generator', productName: GENERATOR, online: false }),
  ]);
  const card = computeRepairIssues(ctx).issues.find((i) => i.id === 'cloud-offline-GEN_1');
  assert.ok(card, 'expected a cloud-offline card for the generator');
  assert.equal(card.severity, 'info'); // was 'warning' before the fix
});

test('cloud-offline — offline peripheral (WAVE 2) gets an INFO card', () => {
  const ctx = ctxWithDevices([
    device({ sn: 'WAVE_1', deviceName: 'WAVE 2', productName: WAVE, online: false }),
  ]);
  const card = computeRepairIssues(ctx).issues.find((i) => i.id === 'cloud-offline-WAVE_1');
  assert.ok(card);
  assert.equal(card.severity, 'info');
});

test('cloud-offline — Core and peripheral offline together get DIFFERENT severities', () => {
  const ctx = ctxWithDevices([
    device({ sn: 'CORE_1', deviceName: 'Core 1', productName: CORE, online: false }),
    device({ sn: 'WAVE_1', deviceName: 'WAVE 2', productName: WAVE, online: false }),
  ]);
  const issues = computeRepairIssues(ctx).issues;
  const core = issues.find((i) => i.id === 'cloud-offline-CORE_1');
  const wave = issues.find((i) => i.id === 'cloud-offline-WAVE_1');
  assert.equal(core?.severity, 'warning');
  assert.equal(wave?.severity, 'info');
});

/* ─── (2) soiling threshold boundary (aligned to alert = 12) ────── */

test('soiling — 11% drop is BELOW the aligned threshold → no wash card', () => {
  const ctx = ctxWithSoiling([perDevice(11)]);
  const issues = computeRepairIssues(ctx).issues;
  assert.equal(issues.filter((i) => i.id === 'wash-panels').length, 0);
});

test('soiling — 12% drop is AT the aligned threshold → wash card fires', () => {
  const ctx = ctxWithSoiling([perDevice(12)]);
  const card = computeRepairIssues(ctx).issues.find((i) => i.id === 'wash-panels');
  assert.ok(card, 'a 12% drop must now produce a wash card (matches the alert)');
  // 12% is below the 22% warning ceiling, so the card is info-severity.
  assert.equal(card.severity, 'info');
});

test('soiling — 14% drop (in the old 12–15 gap) now produces a card', () => {
  // Regression guard for the exact gap the fix closed: alerted-but-uncardable.
  const ctx = ctxWithSoiling([perDevice(14)]);
  const card = computeRepairIssues(ctx).issues.find((i) => i.id === 'wash-panels');
  assert.ok(card);
  assert.equal(card.severity, 'info');
});

test('soiling — fewer than 6 clean days suppresses the card even above threshold', () => {
  const ctx = ctxWithSoiling([perDevice(30, /*cleanDays*/ 5)]);
  assert.equal(
    computeRepairIssues(ctx).issues.filter((i) => i.id === 'wash-panels').length,
    0,
  );
});

/* ─── (4) firstSeenAt persistence across two calls ─────────────── */

test('firstSeenAt — same active id keeps its timestamp across two calls', () => {
  const ctx = ctxWithDevices([
    device({ sn: 'PERSIST_1', deviceName: 'Core 1', productName: CORE, online: false }),
  ]);
  const first = computeRepairIssues(ctx).issues.find((i) => i.id === 'cloud-offline-PERSIST_1');
  assert.ok(first);
  const firstSeen = first.firstSeenAt;

  // Second call (a later generatedAt) must NOT reset the first-seen timestamp.
  const second = computeRepairIssues(ctx).issues.find((i) => i.id === 'cloud-offline-PERSIST_1');
  assert.ok(second);
  assert.equal(second.firstSeenAt, firstSeen);
  // And it is a real start-of-condition timestamp, not zero.
  assert.ok(firstSeen > 0);
});
