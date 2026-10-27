/**
 * v1.190.1 — the Smart Home Panel card's charge limit and backup timers.
 *
 * `chargeWattPower` is the panel's configured AC charge-rate LIMIT for EACH connected battery
 * (7,200 W, the Delta Pro Ultra's AC input ceiling; every source slot's `ratePower` and the charge
 * time-task's `chargeWatts` read the same), not a live power and not the pool's. Measured on the
 * night of 2026-10-13/14: each Core's own ac_in pinned at ~7.2 kW (7,223 / 6,033 / 7,218 W), the
 * three together took 18.1 kW and the panel's main read 19,253 W. The card had read "Charge power
 * 7.20 kW", and gated its "Charge time" on that limit, so it showed a time to full during a drain
 * (the v1.188.1 review: "38 min" while the pool fell 3.4 kW through the panel).
 *
 * Fixtures carry fake serials and only the fields the code reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARGE_LIMIT_LABEL, backupTimerText, chargeLimitView, connectedSlotCount } from '../../web/src/cards/shp2ChargeText.js';
import { panelForClient } from '../src/shp2Membership.js';

type Any = any; // fixtures carry only the fields the code reads

const NOW = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

/* ══ 1. the charge limit, per battery, and the connected fleet's envelope ═══════════════ */

test('★★★ 7,200 W is the limit per battery: three connected batteries make a 21.6 kW envelope', () => {
  const v = chargeLimitView(7200, 3);
  assert.equal(v.label, CHARGE_LIMIT_LABEL);
  assert.equal(v.label, 'Charge limit (per battery)', 'the field is named as a limit, not a power');
  assert.equal(v.value, '7.20 kW', 'fmtW formatting kept');
  assert.equal(v.envelope, '× 3 connected = 21.60 kW');
  assert.match(v.title, /not live charge power/);
  assert.match(v.title, /3 connected batteries can take up to 21\.60 kW together/);
});

test('two connected batteries: a 14.4 kW envelope; one: 7.2 kW, singular', () => {
  assert.equal(chargeLimitView(7200, 2).envelope, '× 2 connected = 14.40 kW');
  const one = chargeLimitView(7200, 1);
  assert.equal(one.envelope, '× 1 connected = 7.20 kW');
  assert.match(one.title, /1 connected battery can take up to 7\.20 kW/);
});

test('no limit reported: "—" and no envelope; no connected slot: the limit alone', () => {
  const none = chargeLimitView(null, 3);
  assert.equal(none.value, '—');
  assert.equal(none.envelope, null);
  assert.match(none.title, /has not reported/);
  assert.equal(chargeLimitView(undefined, 3).value, '—');
  assert.equal(chargeLimitView(Number.NaN, 3).value, '—');
  const zero = chargeLimitView(7200, 0);
  assert.equal(zero.value, '7.20 kW');
  assert.equal(zero.envelope, null, 'no "× 0 connected = 0 W"');
  assert.doesNotMatch(zero.title, /together/);
  assert.equal(chargeLimitView(7200, -1).envelope, null);
  assert.equal(chargeLimitView(7200, 2.5).envelope, null, 'a slot count is an integer');
});

test('a limit below a kilowatt keeps fmtW’s watt form', () => {
  assert.equal(chargeLimitView(800, 3).value, '800 W');
  assert.equal(chargeLimitView(800, 3).envelope, '× 3 connected = 2.40 kW');
});

test('connectedSlotCount: isConnected AND a serial, the shp2ConnectedDpuSns rule', () => {
  assert.equal(connectedSlotCount([
    { isConnected: true, sn: 'CORE-A' },
    { isConnected: true, sn: null },
    { isConnected: false, sn: 'CORE-C' },
  ]), 1);
  assert.equal(connectedSlotCount([{ isConnected: true, sn: 'A' }, { isConnected: true, sn: 'B' }, { isConnected: true, sn: 'C' }]), 3);
  assert.equal(connectedSlotCount([]), 0);
  assert.equal(connectedSlotCount(undefined), 0, 'a partial quota omits the sources subtree');
  assert.equal(connectedSlotCount(null), 0);
});

/* ══ 2. the backup timers, on the server's verdict ═════════════════════════════════════ */

test('★★★ backupTimerText shows a timer only while the server says it applies', () => {
  assert.equal(backupTimerText(215, true), '3h 35m');
  assert.equal(backupTimerText(38, true), '38 min');
  assert.equal(backupTimerText(38, false), '—', 'the 20:04 drain: no time to full');
  assert.equal(backupTimerText(38, undefined), '—', 'an older server sends no verdict: nothing is shown');
  assert.equal(backupTimerText(null, true), '—');
  assert.equal(backupTimerText(undefined, true), '—');
});

/** A Core reporting on its own meter: content changed `changedAgoMs` ago; packNet > 0 = discharging. */
function core(sn: string, o: { packNet?: number; changedAgoMs?: number; online?: boolean } = {}): Any {
  const net = o.packNet ?? 0;
  return {
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: o.online ?? true, lastUpdated: NOW,
    contentChangedAtMs: NOW - (o.changedAgoMs ?? 5_000),
    projection: { kind: 'dpu', soc: 60, pvTotalWatts: 0, acInWatts: 0, acOutWatts: 0, packs: [{ num: 1, outputWatts: Math.max(0, net), inputWatts: Math.max(0, -net) }] },
  };
}
/** A cloud-offline Core as the snapshot carries it: listed, offline, no projection. */
const darkCore = (sn: string): Any => ({ sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: false, lastUpdated: NOW - 45 * 3600_000 });
/** The house panel: online, a fresh quota, its slots' own meter (negative = delivering). */
function panel(sns: string[], sourceWatts: number[]): Any {
  return {
    sn: 'PANEL-TEST-01', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW,
    lastQuotaAtMs: NOW - 30_000, contentStaleSinceMs: null,
    projection: {
      kind: 'shp2', area: 'Home', backupBatPercent: 86, backupFullCapWh: 92_160, backupRemainWh: 79_000,
      backupChargeTimeMin: 38, backupDischargeTimeMin: 1206, backupReserveSoc: 10, chargeWattPower: 7200, gridWatt: 0,
      circuits: [], pairedCircuits: [],
      sources: sns.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, batteryPercentage: 86, isAcOpen: true, fullCap: 30720, ratePower: 7200, emsBatTemp: 29, hwConnect: true, errorCodeNum: 0 })),
      sourceWatts,
    },
  };
}
const devs = (...ds: Any[]) => Object.fromEntries(ds.map((d) => [d.sn, d]));
const SNS = ['CORE-A', 'CORE-B', 'CORE-C'];

test('★★★ panelForClient sends the backupTimerGate verdict: no charge timer while the pool drains through the panel', () => {
  // The 2026-10-16 20:04 picture: every Core cloud-offline, the panel fresh, its slots delivering
  // ~1.2 kW each, the panel still reporting a 38 min charge timer beside chargeWattPower 7200.
  const drain = devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(SNS, [-1190.67, -1195.02, -1173.66]));
  const out = panelForClient(drain['PANEL-TEST-01'], drain, NOW);
  assert.deepEqual(out.backupTimers, { charge: false, discharge: true });
  assert.equal(drain['PANEL-TEST-01'].backupTimers, undefined, 'the store’s device is untouched');
  // What the card then shows: the discharge time, and "—" for the charge time.
  assert.equal(backupTimerText(out.projection.backupChargeTimeMin, out.backupTimers?.charge), '—');
  assert.equal(backupTimerText(out.projection.backupDischargeTimeMin, out.backupTimers?.discharge), '20h 6m');
  // Every Core charging on its own meter: the charge timer, not the discharge timer.
  const charging = devs(core('CORE-A', { packNet: -2000 }), core('CORE-B', { packNet: -2000 }), core('CORE-C', { packNet: -2000 }), panel(SNS, [0, 0, 0]));
  assert.deepEqual(panelForClient(charging['PANEL-TEST-01'], charging, NOW).backupTimers, { charge: true, discharge: false });
  // Idle inside the ±50 W deadband: both apply, as /api/ha-state publishes both.
  const idle = devs(core('CORE-A'), core('CORE-B'), core('CORE-C'), panel(SNS, [0, 0, 0]));
  assert.deepEqual(panelForClient(idle['PANEL-TEST-01'], idle, NOW).backupTimers, { charge: true, discharge: true });
});

/* ══ 3. the wiring: the card reads the helper and the verdict, the server sends it ══════ */

test('★★★ the card shows both timers through backupTimerText on the server’s verdict, never on chargeWattPower', () => {
  const card = src('../web/src/cards/Shp2Card.tsx');
  assert.ok(card.includes('backupTimerText(p.backupChargeTimeMin, d.backupTimers?.charge)'), 'the charge timer on the charge verdict');
  assert.ok(card.includes('backupTimerText(p.backupDischargeTimeMin, d.backupTimers?.discharge)'), 'the discharge timer on the discharge verdict');
  assert.ok(!card.includes('(p.chargeWattPower ?? 0) > 50'), 'the configured limit no longer gates a timer');
  assert.ok(!/>Charge power</.test(card), 'the field is no longer labelled a power');
  assert.ok(card.includes('chargeLimitView(p.chargeWattPower, connectedSlotCount(p.sources))'), 'the limit and the connected fleet’s envelope come from the helper');
  assert.ok(!card.includes('fmtW(p.chargeWattPower)'), 'the bare figure is not rendered beside the helper’s');
});

test('panelForClient sets backupTimers from backupTimerGate, the gate /api/ha-state publishes the sensors through', () => {
  const mem = src('src/shp2Membership.ts');
  const fn = mem.slice(mem.indexOf('export function panelForClient('));
  assert.ok(/backupTimers: .*backupTimerGate\(devices, nowMs, verdicts\)/.test(fn.slice(0, fn.indexOf('projection: {'))), 'backupTimers from backupTimerGate, on the same verdicts');
  const idx = src('src/index.ts');
  assert.ok(idx.includes('backup_charge_minutes: timers.charge ? (shp2?.projection.backupChargeTimeMin ?? null) : null,'), 'the sensor is still on the same gate');
});

test('the documentation states the per-battery limit and the measured envelope, not 7.2 kW for the pool', () => {
  const cfg = src('../docs/reference/12-configuration-deployment-security.md');
  assert.ok(!cfg.includes('at most 7.2 kW × 6 h = 43.2 kWh'), 'the whole-pool 43.2 kWh ceiling is gone');
  assert.ok(cfg.includes('7.2 kW for each connected battery'), 'the limit is stated per battery');
  assert.ok(cfg.includes('15-2-night-charge-writes.md#11-failure-modes--known-limitations'), 'cross-referenced to the measured envelope');
  const writes = src('../docs/reference/15-2-night-charge-writes.md');
  assert.ok(writes.includes('7,223 / 6,033 / 7,218 W'), 'the 2026-10-13/14 per-Core peaks are recorded');
});
