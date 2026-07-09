/**
 * Render tests for the SUMMARY-mode TUI (`renderScreen` — the 8 legacy
 * control-room screens: overview/devices/solar/battery/shp2/strategy/alerts/
 * predictive). Companion to tui.test.ts (which covers Plant mode).
 *
 * Goals mirror tui.test.ts's invariants — no screen throws, every line fits the
 * requested width, no `undefined`/`NaN`/`[object Object]` leaks, ANSI spans
 * balance — PLUS targeted assertions for the v0.44.0–v0.50.0 accuracy/feature
 * changes the v0.52.0 overhaul ported into the TUI:
 *
 *   • per-pack battery NET (Σ output−input), POSITIVE=discharge, NEGATIVE=charge
 *     — NOT DPU throughput (v0.46.0);
 *   • Solar "% measured" reads PV-only coverage (fleet.pvCoverage) (v0.44.0);
 *   • Strategy reserve reads the canonical projection.backupReserveSoc, disabled
 *     circuits are marked, mode enums shown as raw codes, TOU gate respected
 *     (v0.47.0);
 *   • cloud-offline (not "zombie") framing + offline-freeze surfacing (v0.49.0 /
 *     v0.45.0).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderScreen, SCREENS, fleetBatteryNetWatts, getDpus, type ScreenId, type SessionView, type RenderData } from '../src/telnet/screens.js';
import { visLen } from '../src/telnet/ansi.js';
import type { FleetSnapshot, DeviceSnapshot } from '../src/snapshot.js';
import type { DpuProjection, DpuPack, Shp2Projection } from '../src/ecoflow/project.js';
import type { FleetEnergyTotals } from '../src/aggregator.js';
import type { FleetDegradation } from '../src/analytics.js';

/* ── fixture ───────────────────────────────────────────────────────────── */

function buildPack(num: number, opts: { soc?: number; inW?: number; outW?: number } = {}): DpuPack {
  const soc = opts.soc ?? 60;
  return {
    num, soc, soh: 98, actSoh: 97.8,
    inputWatts: opts.inW ?? 0, outputWatts: opts.outW ?? 0,
    temp: 25, cycles: 50, remainTimeMin: 180, packSn: `PK-${num}`,
    designCapMah: 100_000, fullCapMah: 98_000, remainCapMah: Math.round(98_000 * (soc / 100)),
    accuChgMah: 5_900_000, accuDsgMah: 6_050_000, // discharge>charge — the v0.45.0 honest case
    cellTemps: [25, 25, 25, 25, 25, 25, 25], mosTemps: [30, 30, 30, 30], ptcTemps: [20, 20, 20, 20],
    hwBoardTemp: 32, curResTemp: 28, minCellTemp: 24, maxCellTemp: 26, minMosTemp: 30, maxMosTemp: 32,
    cellVoltagesMv: Array.from({ length: 32 }, () => 3300), minCellVoltageMv: 3290, maxCellVoltageMv: 3310,
    maxVolDiffMv: 20, balanceState: 0, packVoltageMv: 51_200, adBatVoltageMv: 51_200, ocvMv: 51_180,
  };
}

function buildDpu(idx: number, sn: string, opts: { online?: boolean; charging?: boolean; pvW?: number } = {}): DeviceSnapshot {
  // charging => packs net-import (inputWatts dominant); discharging => output dominant.
  const perPack = opts.charging ? { inW: 600, outW: 0 } : { inW: 0, outW: 500 };
  const packs = Array.from({ length: 5 }, (_, i) => buildPack(i + 1, { soc: 60, ...perPack }));
  const pv = opts.pvW ?? 0;
  const projection: DpuProjection = {
    kind: 'dpu', soc: 60, packCount: 5, packs,
    pvHighWatts: Math.round(pv * 0.6), pvLowWatts: Math.round(pv * 0.4), pvTotalWatts: pv,
    pvHighVolts: 280, pvHighAmps: 3.5, pvLowVolts: 120, pvLowAmps: 4.2, pvHighErrCode: 0, pvLowErrCode: 0,
    acInWatts: 0, acOutWatts: 250, acOutFreq: 60, acOutVol: 240_000,
    batVol: 51_200, batAmp: 100,
    // Throughput numbers deliberately DIFFER from the per-pack flow so a test can
    // catch any regression back to throughput-based net.
    totalInWatts: 9999, totalOutWatts: 1,
    remainTimeMin: 180, mpptHvTemp: 38, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
  };
  return {
    sn, deviceName: `DELTA-PRO-ULTRA-${idx}`, productName: 'Delta Pro Ultra',
    online: opts.online !== false, lastUpdated: Date.now(), projection,
  };
}

function buildShp2(sn: string, sourceSns: string[]): DeviceSnapshot {
  const projection: Shp2Projection = {
    kind: 'shp2', area: 'Home',
    backupBatPercent: 48, backupFullCapWh: 36_000, backupRemainWh: 17_280,
    backupChargeTimeMin: 180, backupDischargeTimeMin: 720,
    backupReserveSoc: 10, // canonical reserve the alarm acts on
    chargeWattPower: 0, gridWatt: 0,
    circuits: Array.from({ length: 4 }, (_, i) => ({
      ch: i + 1, name: `Circuit ${i + 1}`, watts: 100, setAmp: 20,
      linkCh: null, linkMark: false, loadPriority: 1, loadIsEnable: true,
    })),
    pairedCircuits: [
      { primaryCh: 1, secondaryCh: null, name: 'Closet Subpanel', watts: 583, breakerAmps: 30, loadPriority: 1, loadIsEnable: true, isSplitPhase: false },
      { primaryCh: 3, secondaryCh: 4, name: 'Garage Subpanel & AC', watts: 654, breakerAmps: 50, loadPriority: 3, loadIsEnable: true, isSplitPhase: true },
      // Pool Pump: highest priority (sheds FIRST) AND disabled — the v0.47.0 case.
      { primaryCh: 9, secondaryCh: 10, name: 'Pool Pump', watts: 340, breakerAmps: 30, loadPriority: 25, loadIsEnable: false, isSplitPhase: true },
    ],
    sources: sourceSns.map((s, i) => ({
      slot: i + 1, sn: s, batteryPercentage: 50, isConnected: true, isAcOpen: true,
      fullCap: 7200, ratePower: 3600, emsBatTemp: 25, hwConnect: true, errorCodeNum: 0,
    })),
    sourceWatts: sourceSns.map(() => 0),
    strategy: {
      loadShedEnabled: false, loadShedConfigured: true, midPriorityDischargeFloorSoc: null,
      backupMode: 0, overloadMode: 0, smartBackupMode: 2,
      // A divergent strategy reserve to prove the screen reads the CANONICAL field.
      backupReserveSoc: 99, backupReserveEnabled: true, solarBackupReserveSoc: null,
      timeTask: {
        type: 'CHARGE_TIME_TASK', isEnabled: false, rangeEnabled: true,
        timeMode: 'STARTEGY_EVERY_DAY', chargeWatts: 1800, chargeCeilingSoc: 100, chargeFloorSoc: 20,
        windows: [{ startMinute: 640, endMinute: 880 }], slotMinutes: 10,
      },
    },
  };
  return {
    sn, deviceName: 'SMART-HOME-PANEL-2', productName: 'Smart Home Panel 2',
    online: true, lastUpdated: Date.now(), projection,
  };
}

function buildSnapshot(opts: { charging?: boolean; offlineCore?: boolean; pv?: boolean } = {}): FleetSnapshot {
  const dpus = [
    buildDpu(1, 'DPU-SN-1', { charging: opts.charging, pvW: opts.pv ? 4000 : 0, online: !opts.offlineCore }),
    buildDpu(2, 'DPU-SN-2', { charging: opts.charging, pvW: opts.pv ? 3000 : 0 }),
  ];
  const shp2 = buildShp2('SHP2-SN', dpus.map((d) => d.sn));
  const devices: Record<string, DeviceSnapshot> = {};
  for (const d of dpus) devices[d.sn] = d;
  devices[shp2.sn] = shp2;
  return {
    generatedAt: Date.now(), devices,
    alerts: [
      { id: 'a0', severity: 'warning', category: 'Connectivity', title: 'Core offline', detail: 'Core 1 lost its EcoFlow cloud (enhanced) connection.', device: 'DELTA-PRO-ULTRA-1', source: 'threshold', coreNum: 1 },
    ],
  };
}

function makeTotals(): FleetEnergyTotals {
  return {
    sinceMs: Date.now() - 3_600_000, untilMs: Date.now(), devices: [],
    fleet: { pvWh: 29_698, acOutWh: 13_469, panelLoadWh: 37_657, batteryNetWh: -12_077, coverage: 0.50, pvCoverage: 0.95 },
  };
}

const DEGRADATION: FleetDegradation = { generatedAt: Date.now(), eolSoh: 80, packs: [] };

function makeData(snap: FleetSnapshot, totals: FleetEnergyTotals | null = null): RenderData {
  return { snap, totals, forecast: null, degradation: DEGRADATION };
}

function makeView(screen: ScreenId, width = 100, height = 40): SessionView {
  return { width, height, screen, battDpu: 0, battPack: 0, alertScroll: 0 };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/* ── width / safety invariants across every screen + shape ─────────────── */

const SHAPES = [
  { name: '80x24', width: 80, height: 24 },
  { name: '100x40', width: 100, height: 40 },
  { name: '200x60', width: 200, height: 60 },
];

for (const screen of SCREENS) {
  for (const shape of SHAPES) {
    test(`renderScreen(${screen}) — ${shape.name}, full fleet`, () => {
      const lines = renderScreen(makeView(screen, shape.width, shape.height), makeData(buildSnapshot({ pv: true }), makeTotals()));
      assert.ok(Array.isArray(lines) && lines.length > 0, `${screen}: empty frame`);
      for (let i = 0; i < lines.length; i++) {
        assert.ok(visLen(lines[i]) <= shape.width, `${screen}@${shape.name}: line ${i} width ${visLen(lines[i])} > ${shape.width}`);
        assert.ok(!/undefined/.test(lines[i]), `${screen}: line ${i} has 'undefined'`);
        assert.ok(!/NaN/.test(lines[i]), `${screen}: line ${i} has 'NaN'`);
        assert.ok(!/\[object Object\]/.test(lines[i]), `${screen}: line ${i} has '[object Object]'`);
      }
    });
  }

  test(`renderScreen(${screen}) — empty fleet, no throw`, () => {
    const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [] };
    const lines = renderScreen(makeView(screen), makeData(snap));
    assert.ok(Array.isArray(lines), `${screen}: empty-fleet render failed`);
  });
}

/* ── per-pack battery NET (v0.46.0) ────────────────────────────────────── */

test('fleetBatteryNetWatts — charging is NEGATIVE, discharging is POSITIVE', () => {
  const charging = getDpus(buildSnapshot({ charging: true }));
  const discharging = getDpus(buildSnapshot({ charging: false }));
  // 2 DPUs × 5 packs × (0 − 600) = −6000 charging; × (500 − 0) = +5000 discharging.
  assert.equal(fleetBatteryNetWatts(charging), -6000, 'charging net must be negative');
  assert.equal(fleetBatteryNetWatts(discharging), 5000, 'discharging net must be positive');
});

test('overview battery line uses per-pack flow, not DPU throughput', () => {
  // Throughput would be totalOut(1) − totalIn(9999) = −9998 per DPU → wildly off.
  // Per-pack charging net is −6000 → "charging 6.00 kW". Assert the per-pack number
  // shows and the throughput number does not.
  const lines = renderScreen(makeView('overview'), makeData(buildSnapshot({ charging: true }), makeTotals()));
  const plain = lines.map(stripAnsi).join('\n');
  assert.ok(/charging 6\.00 kW/.test(plain), `expected per-pack 'charging 6.00 kW', got:\n${plain}`);
  assert.ok(!/9\.99 kW|9998/.test(plain), 'throughput-derived net leaked into overview');
});

// v0.96.0 (re-audit #1/#11) — the fleet battery-net header must read the SAME basis as
// the `fleet_battery_net_watts` HA sensor (aggregateFleetFlow = online AND SHP2-connected),
// NOT a raw sum over every online DPU. A spare Core (online, bench/PV-charging, not on the
// home bus) was leaking its per-pack flow into the header as a phantom fleet swing.
test('overview fleet battery-net EXCLUDES a spare (non-SHP2-connected) core', () => {
  const home1 = buildDpu(1, 'DPU-SN-1', { charging: true }); // 5×(0−600) = −3000
  const home2 = buildDpu(2, 'DPU-SN-2', { charging: true }); // −3000  → connected net −6000
  // Third core: ONLINE but NOT one of the SHP2's declared sources. Discharging hard —
  // if it leaked in it would swing the net −6000 → −3500 ("charging 3.50 kW").
  const spare = buildDpu(3, 'SPARE-SN', { charging: false }); // 5×(500−0) = +2500
  const shp2 = buildShp2('SHP2-SN', ['DPU-SN-1', 'DPU-SN-2']); // only the two home cores connected
  const devices: Record<string, DeviceSnapshot> = {};
  for (const d of [home1, home2, spare, shp2]) devices[d.sn] = d;
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices, alerts: [] };

  const plain = renderScreen(makeView('overview'), makeData(snap, makeTotals())).map(stripAnsi).join('\n');
  assert.ok(/charging 6\.00 kW/.test(plain), `connected-only net expected 'charging 6.00 kW', got:\n${plain}`);
  assert.ok(!/charging 3\.50 kW/.test(plain), 'spare-core pack flow leaked into the fleet battery-net');
  assert.ok(!/discharging/.test(plain), 'fleet header wrongly flipped to discharging with a spare present');
});

/* ── Solar PV coverage (v0.44.0) ───────────────────────────────────────── */

test('solar "% measured" uses PV-only coverage, not all-metric coverage', () => {
  // fleet.coverage=0.50, fleet.pvCoverage=0.95 — the tile must show 95%, not 50%.
  const lines = renderScreen(makeView('solar'), makeData(buildSnapshot({ pv: true }), makeTotals()));
  const plain = lines.map(stripAnsi).join('\n');
  assert.ok(/95% measured/.test(plain), `expected '95% measured' (PV coverage), got:\n${plain}`);
  assert.ok(!/50% measured/.test(plain), 'all-metric coverage (50%) leaked into the Solar tile');
});

/* ── Strategy (v0.47.0) ────────────────────────────────────────────────── */

test('strategy backup reserve reads canonical projection field, not strategy decode', () => {
  // projection.backupReserveSoc=10 (canonical); strategy.backupReserveSoc=99 (divergent).
  const lines = renderScreen(makeView('strategy'), makeData(buildSnapshot()));
  const plain = lines.map(stripAnsi).join('\n');
  assert.ok(/Backup reserve\s*10%/.test(plain), `expected canonical reserve 10%, got:\n${plain}`);
  assert.ok(!/99%/.test(plain), 'divergent strategy.backupReserveSoc (99%) was shown');
});

test('strategy marks disabled Pool Pump and shows mode codes honestly', () => {
  const lines = renderScreen(makeView('strategy'), makeData(buildSnapshot()));
  const plain = lines.map(stripAnsi).join('\n');
  assert.ok(/Pool Pump/.test(plain), 'Pool Pump circuit missing');
  assert.ok(/disabled · off in SHP2/.test(plain), 'disabled circuit not clearly marked');
  assert.ok(/raw SHP2 codes/.test(plain), 'mode enums not labelled as raw codes');
  // TOU task is disabled → windows must be flagged not-active, not presented live.
  assert.ok(/not active|gate disabled|task disabled/.test(plain), 'TOU disabled-task gate not respected');
});

test('strategy ranks most-protected first, disabled circuits last', () => {
  const lines = renderScreen(makeView('strategy'), makeData(buildSnapshot())).map(stripAnsi);
  const closetIdx = lines.findIndex((l) => /Closet Subpanel/.test(l));   // prio 1 = shed last
  const poolIdx = lines.findIndex((l) => /Pool Pump/.test(l));           // prio 25 + disabled
  assert.ok(closetIdx >= 0 && poolIdx >= 0, 'circuit rows missing');
  assert.ok(closetIdx < poolIdx, 'disabled Pool Pump should sort below the protected subpanel');
});

/* ── cloud-offline framing (v0.49.0) + offline-freeze (v0.45.0) ────────── */

test('no TUI screen renders the legacy "zombie" word', () => {
  for (const screen of SCREENS) {
    const lines = renderScreen(makeView(screen), makeData(buildSnapshot({ offlineCore: true, pv: true }), makeTotals()));
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(!/zombie/i.test(plain), `${screen} contains the legacy 'zombie' framing`);
  }
});

test('devices screen frames an offline core as cloud-offline, not stale-live', () => {
  const lines = renderScreen(makeView('devices'), makeData(buildSnapshot({ offlineCore: true }))).map(stripAnsi);
  const offRow = lines.find((l) => /DELTA-PRO-ULTRA-1/.test(l));
  assert.ok(offRow, 'offline DPU row missing');
  assert.ok(/OFFLINE/.test(offRow!), 'offline status not shown');
  assert.ok(/cloud-offline \(held\)/.test(offRow!), 'offline core shown with live PV instead of cloud-offline framing');
});

/* ── SoH display clamp (≤ 100%) — matrix + vitals ──────────────────────────
 * A couple near-new packs report fullCap > designCap, so actSoh lands just over
 * 100% (e.g. 100.44). That's physically nonsensical to SHOW; the degradation
 * engine keeps the raw value, but every display site clamps to 100% so the
 * matrix (1-decimal) and the detail vitals (2-decimal) never render > 100.0. */
test('battery matrix + vitals clamp SoH display to ≤ 100%', () => {
  const snap = buildSnapshot();
  // Push every pack's measured SoH above nameplate on the SELECTED DPU (battDpu 0).
  const dpu0 = Object.values(snap.devices).find((d) => d.projection?.kind === 'dpu')!;
  for (const pk of (dpu0.projection as DpuProjection).packs) pk.actSoh = 100.44;
  const lines = renderScreen(makeView('battery'), makeData(snap)).map(stripAnsi);
  const plain = lines.join('\n');
  // The raw over-100 tokens the unclamped formatters would emit must be absent.
  assert.ok(!/100\.4%/.test(plain), `matrix rendered an unclamped SoH (100.4%):\n${plain}`);
  assert.ok(!/100\.44%/.test(plain), `vitals rendered an unclamped SoH (100.44%):\n${plain}`);
  // No SoH percentage token anywhere exceeds 100.0.
  for (const m of plain.matchAll(/(\d+(?:\.\d+)?)%/g)) {
    assert.ok(Number(m[1]) <= 100, `a percentage token (${m[1]}%) exceeds 100`);
  }
  // The clamped matrix value is what shows.
  assert.ok(/100\.0%/.test(plain), `clamped SoH 100.0% not present:\n${plain}`);
});

test('battery screen surfaces the offline-freeze (held-from-last-known) state', () => {
  const lines = renderScreen(makeView('battery'), makeData(buildSnapshot({ offlineCore: true }))).map(stripAnsi);
  const plain = lines.join('\n');
  assert.ok(/held from last-known/.test(plain), 'offline-freeze hold state not surfaced on Battery screen');
  // And the honest independent-lifetime note (discharge>charge normal).
  assert.ok(/discharge>charge is normal/.test(plain), 'lifetime independence note missing');
});
