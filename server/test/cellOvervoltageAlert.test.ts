import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAlerts, isNeverMutedAlert, resetVdiffWarnHoldForTesting, CELL_OVP_CRIT_MV, CELL_OVP_IMPLAUSIBLE_MV,
  type Alert,
} from '../src/alerts.js';
import { shouldDemoteAnnunciation, pushDebounceMsFor } from '../src/alertMonitor.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import { buildAlertMessageEs } from '../src/ttsService.js';
import { SPARE_DPU_SNS } from '../src/shp2Membership.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.187.0 — CELL OVERVOLTAGE. No alert read the pack's highest cell voltage, so the one
 * top-of-charge hazard that matters — a cell running toward its overvoltage limit — was never
 * watched; the cell-spread rule only ever saw it indirectly, and that rule carries mutes.
 *
 * LFP cells are rated to ~3.65 V. The highest cell this fleet has reported is 3.533 V
 * (2026-09-18), 3.532 V before it (2026-07-23), across every pack since 2026-07-02. The line is
 * 3.600 V. The alert is exempt from the balancing, plateau and end-of-charge mutes (it is a
 * separate alert none of them read), and from the bench-spare stamp and the off-panel demotion
 * (isNeverMutedAlert), like a critical Thermal alert.
 * =================================================================== */

const [BENCH_SN] = [...SPARE_DPU_SNS] as [string]; // read from the literal, not restated
const SN = 'DPU-OVP';

function core(pack: Record<string, unknown>, sn = SN): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: 'Core 9', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: 100,
        packs: [{
          num: 1, soc: 100, packSn: 'PACK-O', inputWatts: 300, outputWatts: 0,
          maxVolDiffMv: 40, minCellVoltageMv: 3450, balanceState: 0, cellVoltagesMv: [], ...pack,
        }],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
      },
    } as unknown as DeviceSnapshot,
  };
}
const ovp = (pack: Record<string, unknown>, sn = SN): Alert | undefined =>
  computeAlerts(core(pack, sn), undefined, { present: true, backstopping: true })
    .find((a) => a.id === `cell-ovp-${sn}-1`);

beforeEach(() => resetVdiffWarnHoldForTesting());

test('★★★ a cell at 3.600 V raises an annunciating CRITICAL "Cell overvoltage"', () => {
  assert.equal(CELL_OVP_CRIT_MV, 3600);
  const a = ovp({ maxCellVoltageMv: 3600 });
  assert.ok(a, 'raised');
  assert.equal(a!.severity, 'critical');
  assert.equal(a!.category, 'Battery');
  assert.equal(a!.title, 'Cell overvoltage');
  assert.notEqual(a!.annunciate, false);
  assert.match(a!.detail, /highest cell at 3\.600 V \(critical ≥ 3\.60 V/);
  assert.ok(a!.facts?.some((f) => f.label === 'Highest cell' && f.value === '3.600 V'));
  assert.equal(a!.packNum, 1, 'pack-scoped like the rest of the pack family');
  assert.equal(a!.sourcePackSn, 'PACK-O', 'follows the physical pack');
  assert.equal(conditionFromAlerts([a!]).level, 'red', 'it raises the audible condition');
  assert.equal(pushDebounceMsFor(a!.id, 0), 0, 'a critical outside the settle families pushes at once');
});

test('★★★ the observed fleet maximum (3.533 V) and 3.599 V raise nothing', () => {
  assert.equal(ovp({ maxCellVoltageMv: 3533 }), undefined);
  assert.equal(ovp({ maxCellVoltageMv: 3599 }), undefined);
  assert.equal(ovp({ maxCellVoltageMv: null }), undefined);
});

test('★★ a reading that is not a measurement raises nothing (null over fabrication)', () => {
  assert.equal(CELL_OVP_IMPLAUSIBLE_MV, 5000);
  assert.equal(ovp({ maxCellVoltageMv: 65535 }), undefined, 'the uint16 "unknown" sentinel');
  assert.equal(ovp({ maxCellVoltageMv: CELL_OVP_IMPLAUSIBLE_MV }), undefined);
  assert.ok(ovp({ maxCellVoltageMv: CELL_OVP_IMPLAUSIBLE_MV - 1 }), 'anything a cell can physically read still alarms');
});

test('★★★ exempt from the cell-spread mutes: it speaks while the BMS balances at top of charge', () => {
  const alerts = computeAlerts(core({ maxCellVoltageMv: 3610, maxVolDiffMv: 120, balanceState: 1 }));
  const crit = alerts.find((a) => a.id === `vdiff-crit-${SN}-1`);
  assert.equal(crit?.annunciate, false, 'the spread critical is held by the balancing mute');
  const a = alerts.find((x) => x.id === `cell-ovp-${SN}-1`);
  assert.ok(a);
  assert.notEqual(a!.annunciate, false, 'the overvoltage critical is not');
});

test('★★★ exempt from the bench-spare stamp: a bench chassis on a charger still pages', () => {
  const alerts = computeAlerts(core({ maxCellVoltageMv: 3620, maxVolDiffMv: 60 }, BENCH_SN), undefined, { present: true, backstopping: true });
  const a = alerts.find((x) => x.id === `cell-ovp-${BENCH_SN}-1`);
  assert.ok(a, 'raised on the bench chassis');
  assert.notEqual(a!.annunciate, false, 'must survive the bench-spare stamp');
  const vd = alerts.find((x) => x.id.startsWith('vdiff-') && x.id.includes(BENCH_SN));
  assert.equal(vd?.annunciate, false, 'ordinary families on the same device stay demoted');
});

test('★★★ exempt from the off-panel demotion (isNeverMutedAlert, one shared predicate)', () => {
  const a = { id: `cell-ovp-${SN}-1`, severity: 'critical' as const, category: 'Battery' as const };
  assert.equal(isNeverMutedAlert(a), true);
  assert.equal(shouldDemoteAnnunciation(a, [SN]), false);
  assert.equal(shouldDemoteAnnunciation({ id: `vdiff-crit-${SN}-1`, severity: 'critical', category: 'Battery' }, [SN]), true,
    'the demotion itself still applies to the spread critical');
});

test('★ the Spanish pass names it', () => {
  const a = ovp({ maxCellVoltageMv: 3600 })!;
  assert.match(buildAlertMessageEs('red', [{ ...a, coreNum: 1 }]), /Sobrevoltaje de celda/);
});
