import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAlerts, resetVdiffWarnHoldForTesting, packSnTail } from '../src/alerts.js';
import { detectPackResidencyChanges, notifyLocator } from '../src/alertMonitor.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.173.0 — per-pack alert state follows the BATTERY, not the slot.
 *
 * 2026-09-20: Core 4's defective pack 1 was pulled and the Core renumbered the four that
 * remained 1-4. Alert ids stay keyed (chassis, slot) — they are persisted and user-visible —
 * but the state that DESCRIBES a physical pack must not carry over to the pack that moved
 * into the slot: the v1.102.0 residency retire left the old notify record (swallowing the new
 * pack's first push) and the old onset, the vdiff warn-hold was inherited, and the learned
 * families never carried a serial at all. The confirmed-defective latch was already keyed by
 * serial (defectivePackLatch.ts) and needed no change.
 */

const here = dirname(fileURLToPath(import.meta.url));
const AM = readFileSync(resolve(here, '../src/alertMonitor.ts'), 'utf8');
const AN = readFileSync(resolve(here, '../src/analytics.ts'), 'utf8');

/* ══ the residency detector ═══════════════════════════════════════════════ */

test('★★★ the 2026-09-20 renumber: every live id whose pack serial changed is reported', () => {
  const tracked = new Map<string, { alert: { sourcePackSn?: string } }>([
    ['vdiff-warn-S-1', { alert: { sourcePackSn: 'PACK-A' } }],
    ['soc-low-S-2', { alert: { sourcePackSn: 'PACK-B' } }],
  ]);
  const now = [{ id: 'vdiff-warn-S-1', sourcePackSn: 'PACK-B' }, { id: 'soc-low-S-2', sourcePackSn: 'PACK-C' }];
  assert.deepEqual(detectPackResidencyChanges(now, tracked as never), [
    { id: 'vdiff-warn-S-1', from: 'PACK-A', to: 'PACK-B' },
    { id: 'soc-low-S-2', from: 'PACK-B', to: 'PACK-C' },
  ]);
  assert.deepEqual(detectPackResidencyChanges([{ id: 'vdiff-warn-S-1', sourcePackSn: 'PACK-A' }], tracked as never), [], 'same serial');
  assert.deepEqual(detectPackResidencyChanges([{ id: 'vdiff-warn-S-1' }], tracked as never), [], 'a missing serial is never evidence');
  assert.deepEqual(detectPackResidencyChanges([{ id: 'new-S-9', sourcePackSn: 'PACK-Z' }], tracked as never), [], 'untracked');
});

test('★★★ a replaced pack\'s episode closes CLEAN: its notify record goes, its onset restarts, its card is still dismissed', () => {
  const i = AM.indexOf('for (const c of packResidencyChanges) {');
  assert.ok(i > 0);
  const loop = AM.slice(i, AM.indexOf('\n    }\n', i));
  const retire = loop.indexOf('retireTrackedAlert(c.id, t, now);');
  const forget = loop.indexOf('if (persistedNotified.delete(c.id)) persistNotified();');
  const restamp = loop.indexOf('restampAlertOnset(c.id, now);');
  assert.ok(retire > 0 && forget > retire && restamp > forget,
    'retire (reads the OLD onset) → forget the old push record → restart the onset, in that order');
  assert.ok(loop.includes('packReplaced.set(c.id, { pushSent: t.pushSent === true });'));
  assert.ok(AM.includes('pushSent: rec?.sent === true || packReplaced.get(a.id)?.pushSent === true,'),
    'the old episode\'s delivered card is still owed a "Resolved"');
  assert.ok(!AM.includes('const before = t.alert.sourcePackSn;'), 'the inline check is replaced by the pure detector');
});

/* ══ the vdiff warn-hold follows the pack ═════════════════════════════════ */

function dpu(maxVolDiffMv: number, packSn?: string | null): Record<string, DeviceSnapshot> {
  const projection = {
    kind: 'dpu', soc: 50,
    packs: [{ num: 1, maxVolDiffMv, balanceState: 0, ...(packSn !== undefined ? { packSn } : {}) }],
    pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
    pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
    batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
  };
  return { 'DPU-1': { sn: 'DPU-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(), projection } as unknown as DeviceSnapshot };
}
const warn = (mv: number, sn?: string | null) => computeAlerts(dpu(mv, sn)).some((a) => a.id === 'vdiff-warn-DPU-1-1');
beforeEach(() => resetVdiffWarnHoldForTesting());

test('★★★ a pack moving into a slot does NOT inherit the previous pack\'s warn-hold', () => {
  assert.equal(warn(26, 'PACK-A'), true, 'A rises past 24');
  assert.equal(warn(22, 'PACK-A'), true, 'A\'s own hold');
  assert.equal(warn(22, 'PACK-B'), false, 'B moved into slot 1 at 22 mV — it never crossed 24');
  assert.equal(warn(25, 'PACK-B'), true);
  assert.equal(warn(22, 'PACK-B'), true, 'B\'s own hold');
});

test('★★ no serial is no evidence: the hold stands through a missing or flickering serial', () => {
  assert.equal(warn(26), true);
  assert.equal(warn(22), true, 'no serial on either tick — held (v1.21.0 hysteresis unchanged)');
  resetVdiffWarnHoldForTesting();
  assert.equal(warn(26, 'PACK-A'), true);
  assert.equal(warn(22, null), true, 'a null flicker never drops the hold');
  assert.equal(warn(22, 'PACK-A'), true);
});

/* ══ learned alerts carry the pack; pushes name the battery ═══════════════ */

test('★★ every learned per-pack family stamps the physical pack for the residency check', () => {
  const stamps = AN.split('...(pk.packSn ? { sourcePackSn: pk.packSn } : {}),').length - 1;
  assert.ok(stamps >= 2, 'forecast-soh and forecast-imbalance');
  assert.ok(AN.includes('...(t.packSn ? { sourcePackSn: t.packSn } : {}),'), 'baseline pack targets');
  assert.ok(AN.includes("packNum: pk.num, packSn: pk.packSn, live:"), 'baseline targets carry the serial');
});

test('★★ the push/digest locator names the battery by a 6-character serial tail; the spoken title is unchanged', () => {
  assert.equal(notifyLocator({ device: 'Core 4', packNum: 1, sourcePackSn: 'TESTPACKSN00AB0383' } as never), `Core 4 pack 1 (SN ${packSnTail('TESTPACKSN00AB0383')})`);
  assert.equal(packSnTail('TESTPACKSN00AB0383'), '…AB0383');
  assert.notEqual(packSnTail('TESTPACKSN00AB0383'), packSnTail('TESTPACKSN00CD0383'),
    'two packs sharing their last 4 characters stay distinct (observed live on one Core)');
  assert.equal(notifyLocator({ device: 'Core 4', packNum: 1 } as never), 'Core 4 pack 1', 'no serial ⇒ unchanged');
});
