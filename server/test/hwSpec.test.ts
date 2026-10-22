import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hw from '../src/hwSpec.js';
import { projectShp2 } from '../src/ecoflow/project.js';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.191.0 (review 3) — THE HARDWARE FACTS ARE PINNED.
 *
 * hwSpec.ts gathered the SHP2's and the DELTA Pro Ultra's figures from five modules, "values
 * unchanged", but no test held five of them: the circuit count bounds the SHP2 projection (at 11,
 * channel 12 vanished from the dashboard and the circuit history), the two SoH lines are the
 * pack-health alarms, the 6144 Wh nameplate is the forecast band's last-resort pool size and the
 * 6200 Wh figure sizes the recorder's corrupt-read guard. Each could change with the full suite green.
 * Pinned here by value, the alarms and the circuits by behaviour too, and the reference docs that
 * state them are tied to the code.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('★★★ every hwSpec value is today\'s (a hardware fact changes only with this test)', () => {
  assert.deepEqual({ ...hw }, {
    SHP2_SOURCE_SLOTS: 3,
    SHP2_CIRCUIT_COUNT: 12,
    DPU_MAX_PACKS: 5,
    DPU_PACK_NOMINAL_V: 102.4,
    DPU_PACK_NAMEPLATE_WH: 6144,
    DPU_PACK_GUARD_WH: 6200,
    RESERVE_WRITE_MIN_PCT: 10,
    RESERVE_WRITE_MAX_PCT: 50,
    FORCE_CHARGE_CEILING_MIN_PCT: 80,
    FORCE_CHARGE_CEILING_MAX_PCT: 100,
    MAINS_V: { line: 120, split: 240 },
    SOH_WARN_PCT: 85,
    SOH_CRIT_PCT: 75,
  });
  // The relations the consumers rely on.
  assert.equal(hw.DPU_PACK_NOMINAL_V, 32 * 3.2, '32 LFP cells × 3.2 V');
  assert.equal(hw.DPU_PACK_NAMEPLATE_WH, hw.DPU_PACK_NOMINAL_V * 60, '102.4 V × 60 Ah');
  assert.ok(hw.DPU_PACK_GUARD_WH > hw.DPU_PACK_NAMEPLATE_WH, 'the guard sits above one pack\'s nameplate (DECISION 11 keeps both)');
  assert.ok(hw.SOH_CRIT_PCT < hw.SOH_WARN_PCT);
  assert.equal(hw.MAINS_V.split, 2 * hw.MAINS_V.line);
});

test('★★★ the SHP2 projection builds every circuit, channel 12 included', () => {
  const quota: Record<string, unknown> = { 'loadInfo.hall1Watt': Array.from({ length: 12 }, (_, i) => 100 + i) };
  for (let ch = 1; ch <= 12; ch++) quota[`loadIncreInfo.hall1IncreInfo.ch${ch}Info.chName`] = `Load ${ch}`;
  const p = projectShp2(quota as Parameters<typeof projectShp2>[0]);
  assert.deepEqual(p.circuits.map((c) => c.ch), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(p.circuits[11], {
    ch: 12, name: 'Load 12', watts: 111, setAmp: null, linkCh: null, linkMark: false, loadPriority: null, loadIsEnable: null,
  });
  // A quota with no circuit fields still lists all twelve, by number.
  assert.deepEqual(projectShp2({} as Parameters<typeof projectShp2>[0]).circuits.map((c) => c.name).slice(-1), ['Circuit 12']);
});

/** One DPU whose pack 1 reports `soh` (and `actSoh`, which the alarm prefers). */
function fleetWithSoh(soh: number | null, actSoh?: number | null): Record<string, DeviceSnapshot> {
  const sn = 'DPU-TEST-SOH-1';
  const cells = new Array(32).fill(3300);
  const pack = (num: number, s: number | null, a: number | null | undefined) => ({
    num, soc: 60, soh: s, actSoh: a ?? null, inputWatts: 0, outputWatts: 0, cycles: 100,
    temp: 30, maxCellTemp: 30, minCellTemp: 30, cellVoltagesMv: cells, maxVolDiffMv: 0,
  });
  return {
    [sn]: {
      sn, deviceName: 'Core 9', productName: 'DELTA Pro Ultra', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 60, packs: [pack(1, soh, actSoh), pack(2, 100, 100)] },
    } as unknown as DeviceSnapshot,
  };
}
const sohAlerts = (soh: number | null, actSoh?: number | null) =>
  computeAlerts(fleetWithSoh(soh, actSoh), undefined, { present: true, backstopping: true })
    .filter((a) => a.id.startsWith('soh-'))
    .map((a) => `${a.id.replace('-DPU-TEST-SOH-1', '')}:${a.severity}`);

test('★★★ the pack-health alarms: below 85 % warns, below 75 % is critical, at each line it does not', () => {
  assert.deepEqual(sohAlerts(100), []);
  assert.deepEqual(sohAlerts(85), [], '85 % is not below the warning line');
  assert.deepEqual(sohAlerts(84.9), ['soh-warn-1:warning']);
  assert.deepEqual(sohAlerts(75), ['soh-warn-1:warning'], '75 % warns, not critical');
  assert.deepEqual(sohAlerts(74.9), ['soh-crit-1:critical']);
  assert.deepEqual(sohAlerts(null), [], 'no reading, no alarm');
  // actSoh, when present, is the one judged.
  assert.deepEqual(sohAlerts(90, 74), ['soh-crit-1:critical']);
  const [warn] = computeAlerts(fleetWithSoh(80), undefined, { present: true, backstopping: true }).filter((a) => a.id.startsWith('soh-'));
  assert.match(warn.detail, /SoH 80\.0% \(warning < 85%\)/);
});

test('★★ the reference docs state the values the code holds', () => {
  const alerts = readFileSync(resolve(ROOT, 'docs/reference/08-1-alerts.md'), 'utf8');
  assert.ok(alerts.includes(`| \`SOH_WARN_PCT\` / \`SOH_CRIT_PCT\` | ${hw.SOH_WARN_PCT} / ${hw.SOH_CRIT_PCT} | pack health warn/critical |`));
  const forecast = readFileSync(resolve(ROOT, 'docs/reference/03-solar-forecast.md'), 'utf8');
  assert.ok(forecast.includes(`\`PACK_KWH_NAMEPLATE=${hw.DPU_PACK_NAMEPLATE_WH / 1000}\`, \`PACKS_PER_DPU=${hw.DPU_MAX_PACKS}\``));
  assert.ok(forecast.includes(`PACKS_PER_DPU(${hw.DPU_MAX_PACKS}) · PACK_KWH_NAMEPLATE(${hw.DPU_PACK_NAMEPLATE_WH / 1000})`));
});

test('★★ the consumers read their figure from hwSpec (no second copy)', () => {
  const src = (f: string) => readFileSync(resolve(ROOT, 'server/src', f), 'utf8');
  assert.ok(src('recorder.ts').includes('  const FALLBACK_FULL_PACK_WH = DPU_PACK_GUARD_WH;'), 'the corrupt-read guard');
  assert.ok(src('analytics.ts').includes('  const PACK_KWH_NAMEPLATE = DPU_PACK_NAMEPLATE_WH / 1000;'), 'the forecast band\'s last-resort pool size');
  assert.ok(src('ecoflow/project.ts').includes('  for (let i = 1; i <= SHP2_CIRCUIT_COUNT; i++) {'), 'the circuit projection');
  assert.ok(src('alerts.ts').includes('      if (soh != null && soh < SOH_CRIT_PCT) {'), 'the critical line');
  assert.ok(src('alerts.ts').includes('      } else if (soh != null && soh < SOH_WARN_PCT) {'), 'the warning line');
  for (const f of ['recorder.ts', 'analytics.ts', 'alerts.ts', 'ecoflow/project.ts']) {
    assert.ok(!/\b(?:6144|6200)\b(?!\s*Wh)/.test(src(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), `${f}: no pack-energy literal outside a comment`);
  }
});
