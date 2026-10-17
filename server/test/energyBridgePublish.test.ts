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
      ? { sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: true, lastUpdated: at,
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

async function build(devs: Any, at: number, trusted = false): Promise<Record<string, unknown>> {
  setAnalyticsClientForTesting(stubAnalytics());
  const snap: FleetSnapshot = { generatedAt: at, devices: devs, alerts: [], alertsComplete: true };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const rec = makeRecorderStub({
    listLifetimeKeys: () => ['circuit_1_wh'],
    // The production recorder's bridge (energyBridge.flow) at the pinned clock.
    bridgedFleetFlow: (online, d) => bridgeFleetFlow(online, d, at, () => trusted),
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

test('★★★ in daylight with a PV field never seen working, both power sensors are unknown — never a made-up 0', async () => {
  const s = await build(devices(NOON, false), NOON);
  assert.equal(s.fleet_pv_watts, null);
  assert.equal(s.fleet_battery_net_watts, null);
  const t = await build(devices(NOON, false), NOON, true);
  assert.equal(t.fleet_pv_watts, 0, 'a trusted field reading 0 W is a reading');
  assert.equal(t.fleet_battery_net_watts, 1875);
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
    assert.match(s, /const bridged = recorder\.bridgedFleetFlow\(\{ fleetPv, fleetBatteryNet \}, snap\.devices, Date\.now\(\)\);/, f);
    assert.match(s, /fleet_pv_watts: bridged\.fleetPv == null \? null : Math\.round\(bridged\.fleetPv\),/, f);
    assert.match(s, /fleet_battery_net_watts: bridged\.fleetBatteryNet == null \? null : Math\.round\(bridged\.fleetBatteryNet\),/, f);
    assert.match(s, /flowBridge: bridged, \/\/ v1\.188\.1/, f);
  }
  assert.deepEqual([...READINESS_FIELDS.flowBridged], ['fleet_pv_watts', 'fleet_battery_net_watts']);
  assert.ok(!READINESS_FIELDS.flow.includes('fleet_pv_watts') && !READINESS_FIELDS.flow.includes('fleet_battery_net_watts'));
});
