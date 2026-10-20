/**
 * v1.188.1 — both state publishers take Fleet PV and Battery Net from the energy bridge.
 *
 * 2026-10-15/16 MST: every home Core cloud-offline, the panel fresh and its slots metering ~3.4 kW
 * out of the Cores. Both power sensors were withheld (no online home Core), so Home Assistant's
 * Energy dashboard Now view read Power usage 0 W for two days. They now publish the panel-metered
 * figure while every dark slot can be bridged, and stay withheld (unknown) when one cannot — never
 * a made-up 0. The Cores' own in/out/AC-import sums keep the old rule. Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'energy-bridge-publish-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9'; // no listener: the client never connects

const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');
const { bridgeFleetFlow } = await import('../src/energyBridge.js');
const { READINESS_FIELDS } = await import('../src/publishReadiness.js');

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

type Any = any;
const PANEL = 'HD31XXX00XXX0001';
const CORES = ['Y711XXX00XXX0001', 'Y711XXX00XXX0002', 'Y711XXX00XXX0003'];
/** The sun's position is part of the bridge's rule, so the clock is pinned: 20:15 MST, and noon. */
const NIGHT = Date.parse('2026-10-16T20:15:00-07:00');
const NOON = Date.parse('2026-10-16T12:00:00-07:00');

function devices(at: number, coresOnline: boolean): Any {
  const out: Any = {
    [PANEL]: {
      sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: at,
      lastQuotaAtMs: at - 30_000, contentStaleSinceMs: null, housePanel: true,
      projection: {
        kind: 'shp2', gridWatt: 0, gridSta: 1, gridConnected: true, backupBatPercent: 85, backupRemainWh: 78_000,
        backupFullCapWh: 92_160, backupReserveSoc: 10, circuits: [{ ch: 1, watts: 1860 }], pairedCircuits: [],
        sourceWatts: [-627, -623, -625],
        sources: CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, batteryPercentage: 85, fullCap: 30_720, pvWatts: 0, pvHighWatts: 0, pvLowWatts: 0 })),
      },
    },
  };
  for (const sn of CORES) {
    out[sn] = coresOnline
      ? { sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: true, lastUpdated: at, lastTelemetryAtMs: at, contentChangedAtMs: at - 2_000,
        projection: { kind: 'dpu', soc: 85, pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 625, acInWatts: 0, packs: [{ outputWatts: 640, inputWatts: 0 }] } }
      : { sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: false, lastUpdated: 0 };
  }
  return out;
}

const REPORTS: Record<string, unknown> = {
  forecast: { forecastPvWhNext24: 12_000, forecastPvWhNext24Display: 12_000, minProjectedSoc: 42, structurallyIncomplete: false, pvForecastUnavailable: false, soiling: null },
  degradation: { generatedAt: 1, eolSoh: 70, packs: [] },
  runway: { hoursToReserve: 7.5, hoursToEmpty: 12, unavailable: null },
  roundTripEfficiency: { efficiencyPct: 91 },
  clipping: { todayKwh: 1.2, arrayPeakW: 9000, generatedAt: NIGHT },
  selfConsumption: { solarFractionOfLoadPct: 80, directUseRatioPct: 60, homeDpusCoveragePartial: false },
  carbon: { totalKgAvoided: 10, lifetimeKgAvoided: 100, lifetimeMilesNotDriven: 250, basisComplete: true },
  tariff: { todayGridImportCostDollars: 1, todaySolarLoadValueDollars: 2, netSavingsDollars: 3, basisComplete: true },
  curtailment: { active: false, currentSurplusW: 0, todayKwh: 0, recent7dKwh: 1, current: null, basisComplete: true, generatedAt: NIGHT },
};
function stubAnalytics(): AnalyticsClient {
  return {
    report: async <T = any>(name: string): Promise<T> => structuredClone(REPORTS[name]) as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
}

async function build(devs: Any, at: number, trusted: boolean | 'below' = false): Promise<Record<string, unknown>> {
  setAnalyticsClientForTesting(stubAnalytics());
  const snap: FleetSnapshot = { generatedAt: at, devices: devs, alerts: [], alertsComplete: true };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const rec = makeRecorderStub({
    listLifetimeKeys: () => ['circuit_1_wh'],
    // The production recorder's bridge (energyBridge.flow) at the pinned clock.
    bridgedFleetFlow: (online, d) => bridgeFleetFlow(online, d, at, () => trusted, { lat: 33.4484, lon: -112.074 }),
  });
  const handle = await mqttDiscovery.startMqttDiscovery(store, rec, () => {});
  try {
    return await handle.buildState!(snap);
  } finally {
    handle.stop();
    setAnalyticsClientForTesting(null);
  }
}

test('★★★ every home Core dark at night: Fleet PV 0 W and Battery Net = the slots\' 1875 W publish; the Cores\' own sums stay withheld', async () => {
  const s = await build(devices(NIGHT, false), NIGHT);
  assert.equal(s.fleet_battery_net_watts, 1875, 'Battery Net from the panel slots');
  assert.equal(s.fleet_pv_watts, 0, 'a real 0 W: the sun is down');
  assert.equal(s.ac_import_watts, null, 'the Cores\' AC import is their own reading: withheld while none reports');
});

test('★★★ in daylight both power sensors read a present PV field, checked or not; a field the check has found short today, or no field at all, leaves both unknown — never a made-up 0', async () => {
  const s = await build(devices(NOON, false), NOON);
  assert.equal(s.fleet_pv_watts, 0, 'the field as read (0 W here), published before its check: the two sum to the slot meter whatever it reads');
  assert.equal(s.fleet_battery_net_watts, 1875);
  const t = await build(devices(NOON, false), NOON, true);
  assert.equal(t.fleet_pv_watts, 0, 'a trusted field reading 0 W is a reading');
  assert.equal(t.fleet_battery_net_watts, 1875);
  const b = await build(devices(NOON, false), NOON, 'below');
  assert.equal(b.fleet_pv_watts, null, 'found short of the inferred bound today: withheld');
  assert.equal(b.fleet_battery_net_watts, null);
  const d = devices(NOON, false);
  for (const src of d[PANEL].projection.sources) Object.assign(src, { pvWatts: null, pvHighWatts: null, pvLowWatts: null });
  const a = await build(d, NOON, true);
  assert.equal(a.fleet_pv_watts, null, 'no PV field at all: no figure');
  assert.equal(a.fleet_battery_net_watts, null);
});

test('★★ an all-online fleet publishes exactly the Cores\' own sums (the bridge adds nothing)', async () => {
  const s = await build(devices(NIGHT, true), NIGHT);
  assert.equal(s.fleet_battery_net_watts, 3 * 640);
  assert.equal(s.fleet_pv_watts, 0);
  assert.equal(s.ac_import_watts, 0);
});

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, '../src/', f), 'utf8');

test('★★ both publishers read the two power sensors from the bridged flow and hand it to readiness', () => {
  for (const f of ['mqttDiscovery.ts', 'index.ts']) {
    const s = src(f);
    assert.match(s, /const bridged = recorder\.bridgedFleetFlow\(\{ fleetPv, fleetBatteryNet, acIn, fleetIn, fleetOut \}, snap\.devices, Date\.now\(\)\);/, f);
    // v1.188.1 (review) — AC Import on the same notion (a frozen Core's held ac_in is not published).
    assert.match(s, /ac_import_watts: bridged\.acIn == null \? null : Math\.round\(bridged\.acIn\),/, f);
    assert.match(s, /fleet_pv_watts: bridged\.fleetPv == null \? null : Math\.round\(bridged\.fleetPv\),/, f);
    assert.match(s, /fleet_battery_net_watts: bridged\.fleetBatteryNet == null \? null : Math\.round\(bridged\.fleetBatteryNet\),/, f);
    assert.match(s, /flowBridge: bridged, \/\/ v1\.188\.1/, f);
  }
  // v1.188.1 (review) — /api/ha-state's Fleet Total In / Out on the same notion.
  const idx = src('index.ts');
  assert.ok(idx.includes('fleet_total_in_watts: bridged.fleetIn == null ? null : Math.round(bridged.fleetIn),'), 'index.ts: Fleet Total In');
  assert.ok(idx.includes('fleet_total_out_watts: bridged.fleetOut == null ? null : Math.round(bridged.fleetOut),'), 'index.ts: Fleet Total Out');
  assert.deepEqual([...READINESS_FIELDS.flowBridged], ['fleet_pv_watts', 'fleet_battery_net_watts']);
  assert.ok(!READINESS_FIELDS.flow.includes('fleet_pv_watts') && !READINESS_FIELDS.flow.includes('fleet_battery_net_watts'));
});

test('★★★ every home Core listed online on a FROZEN meter (its quota failing since a 5 kW grid charge), the slots at 0 W: AC Import publishes the slots (0 W), not 15 kW of held AC input', async () => {
  const d = devices(NIGHT, true);
  d[PANEL].projection.sourceWatts = [0, 0, 0];
  d[PANEL].projection.gridWatt = 400;
  for (const sn of CORES) {
    Object.assign(d[sn], { lastTelemetryAtMs: NIGHT - 30 * 60_000, contentChangedAtMs: NIGHT - 30 * 60_000 });
    Object.assign(d[sn].projection, { acInWatts: 5000, totalInWatts: 5000, totalOutWatts: 0, packs: [{ outputWatts: 0, inputWatts: 4800 }] });
  }
  const s = await build(d, NIGHT);
  assert.equal(s.ac_import_watts, 0, 'was 15000 beside a 400 W main');
  assert.equal(s.fleet_battery_net_watts, 0, 'Battery Net: the slots, as before');
  assert.equal(s.fleet_pv_watts, 0);
});
