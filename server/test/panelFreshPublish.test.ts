/**
 * v1.187.10 — a Smart Home Panel 2 whose reading is not fresh publishes its live figures as null.
 *
 * 2026-10-02 00:09:17–00:15:17 MST the cloud served the panel a STALE SHADOW (the payload had not
 * moved across 5 polls). The server treated it as frozen — shp2_grid_connected read unknown and the
 * dashboard showed the panel's figures as stale — but the HA value sensors kept publishing the
 * replayed projection: Panel Load sat at 1611 W from 00:05:17 to 00:14:47 while the Cores' battery
 * net rose to ~4.1 kW, and the first fresh reading was 3626 W. MQTT expire_after could not catch
 * it: every 30 s republish resets the timer. While the house panel fails shp2ReadbackFresh
 * (cloud-offline, no REST quota for SHP2_READBACK_STALE_MS, or shadowed) both publishers now send
 * its live figures — load, grid power, grid status, backup pool and remaining kWh, the per-circuit
 * watts — as null; the lifetime counters, the reserve/strategy settings, the Cores' battery net and
 * the payload-frozen diagnostic are untouched. Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'panel-fresh-publish-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9'; // no listener: the client never connects

const { publishReadiness, withholdUnready, READINESS_FIELDS } = await import('../src/publishReadiness.js');
const { SHP2_READBACK_STALE_MS } = await import('../src/shp2Membership.js');
const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const NOW = Date.now();
const HOUSE = 'PANEXXX00XXX0001';
const GARAGE = 'PANEXXX00XXX0002';
const CORE = 'COREXXX00XXX0001';

type Any = any;

function panel(sn: string, over: Record<string, unknown> = {}, house = true): Any {
  return {
    sn, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW,
    lastQuotaAtMs: NOW - 30_000, contentStaleSinceMs: null, housePanel: house,
    projection: {
      kind: 'shp2', gridWatt: 2400, gridSta: 1, gridConnected: true, backupBatPercent: 72, backupRemainWh: 66_700,
      backupFullCapWh: 92_160, backupReserveSoc: 16, sources: [{ slot: 1, sn: CORE, isConnected: true }],
      circuits: [{ ch: 1, watts: 1200 }, { ch: 2, watts: 411 }], pairedCircuits: [],
    },
    ...over,
  };
}
function core(): Any {
  return {
    sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true, lastUpdated: NOW,
    projection: { kind: 'dpu', soc: 60, pvTotalWatts: 0, totalInWatts: 0, totalOutWatts: 4100, acInWatts: 0, packs: [{ outputWatts: 4100, inputWatts: 0 }] },
  };
}
const readiness = (devices: Any, nowMs = NOW) => publishReadiness({
  devices, alerts: [], alertsComplete: true, speakerLastProbeAt: NOW, forecast: { pvForecastUnavailable: false },
  runway: {}, clipping: { arrayPeakW: 9000 }, curtailment: { basisComplete: true }, carbon: { basisComplete: true },
  tariff: { basisComplete: true }, nowMs,
});

/* ── the readiness verdict ─────────────────────────────────────────────── */

test('★★★ a SHADOWED house panel is not a reading: panel load and the live panel fields are withheld', () => {
  assert.equal(readiness({ [HOUSE]: panel(HOUSE), [CORE]: core() }).panelLive, true, 'fresh control');
  assert.equal(readiness({ [HOUSE]: panel(HOUSE), [CORE]: core() }).panel, true);
  const shadowed = { [HOUSE]: panel(HOUSE, { contentStaleSinceMs: NOW - 240_000 }), [CORE]: core() };
  const r = readiness(shadowed);
  assert.equal(r.panelLive, false);
  assert.equal(r.panel, false);
  assert.equal(r.flow, true, 'the Cores are their own reading — the fleet flows are not governed by the panel');
});

test('★★ a panel whose quota is older than SHP2_READBACK_STALE_MS, or that is cloud-offline, is not a reading either', () => {
  assert.equal(SHP2_READBACK_STALE_MS, 300_000);
  const old = readiness({ [HOUSE]: panel(HOUSE, { lastQuotaAtMs: NOW - 301_000 }), [CORE]: core() });
  assert.equal(old.panelLive, false);
  assert.equal(old.panel, false);
  const justInside = readiness({ [HOUSE]: panel(HOUSE, { lastQuotaAtMs: NOW - 299_000 }), [CORE]: core() });
  assert.equal(justInside.panelLive, true);
  const offline = readiness({ [HOUSE]: panel(HOUSE, { online: false }), [CORE]: core() });
  assert.equal(offline.panelLive, false);
  assert.equal(offline.panel, false);
});

test('★★ two panels: a shadowed SECOND panel withholds the plant load (it sums both) but not the house panel\'s own figures', () => {
  const r = readiness({ [HOUSE]: panel(HOUSE), [GARAGE]: panel(GARAGE, { contentStaleSinceMs: NOW - 300_000 }, false), [CORE]: core() });
  assert.equal(r.panel, false, 'half live, half frozen is neither');
  assert.equal(r.panelLive, true, 'the house panel reads live');
});

/* ── what is withheld, and what is not ─────────────────────────────────── */

function payload(): Record<string, unknown> {
  return {
    panel_load_watts: 1611, grid_home_watts: 0, shp2_grid_status: 'Grid OK', backup_pool_percent: 72,
    backup_remaining_kwh: 66.7, backup_charge_minutes: 90, backup_discharge_minutes: 900,
    circuit_1_watts: 1200, circuit_12_watts: 91, circuit_1_lifetime_kwh: 812.4, circuit_12_lifetime_kwh: 33.1,
    fleet_battery_net_watts: 4041, backup_full_capacity_kwh: 92.2, backup_reserve_percent: 16,
    grid_to_home_lifetime_kwh: 5442.074, shp2_content_frozen_s: 570, shp2_grid_connected: null,
  };
}

test('★★★ withheld: load, grid power and status, backup pool and remaining, timers, EVERY circuit_N_watts', () => {
  const out = withholdUnready(payload(), readiness({ [HOUSE]: panel(HOUSE, { contentStaleSinceMs: NOW - 240_000 }), [CORE]: core() }));
  for (const k of ['panel_load_watts', 'grid_home_watts', 'shp2_grid_status', 'backup_pool_percent', 'backup_remaining_kwh',
    'backup_charge_minutes', 'backup_discharge_minutes', 'circuit_1_watts', 'circuit_12_watts']) {
    assert.equal(out[k], null, k);
  }
});

test('★★★ NOT withheld: lifetime counters (per-circuit too), battery net, capacity, reserve floor, the frozen-for diagnostic', () => {
  const out = withholdUnready(payload(), readiness({ [HOUSE]: panel(HOUSE, { contentStaleSinceMs: NOW - 240_000 }), [CORE]: core() }));
  assert.equal(out.circuit_1_lifetime_kwh, 812.4);
  assert.equal(out.circuit_12_lifetime_kwh, 33.1);
  assert.equal(out.fleet_battery_net_watts, 4041);
  assert.equal(out.backup_full_capacity_kwh, 92.2);
  assert.equal(out.backup_reserve_percent, 16);
  assert.equal(out.grid_to_home_lifetime_kwh, 5442.074);
  assert.equal(out.shp2_content_frozen_s, 570, 'the instrument that shows the freeze must keep publishing');
});

test('a fresh panel publishes every figure unchanged, including a real 0 W grid', () => {
  const out = withholdUnready(payload(), readiness({ [HOUSE]: panel(HOUSE), [CORE]: core() }));
  assert.deepEqual(out, payload());
});

test('the governed static keys are the house panel\'s live figures, and only those', () => {
  assert.deepEqual([...READINESS_FIELDS.panelLive].sort(), [
    'backup_charge_minutes', 'backup_discharge_minutes', 'backup_pool_percent', 'backup_remaining_kwh',
    'grid_home_watts', 'shp2_grid_status',
  ]);
  assert.deepEqual([...READINESS_FIELDS.panel], ['panel_load_watts']);
});

/* ── the MQTT publisher, end to end ────────────────────────────────────── */

const REPORTS: Record<string, unknown> = {
  forecast: { forecastPvWhNext24: 12_000, forecastPvWhNext24Display: 12_000, minProjectedSoc: 42, structurallyIncomplete: false, pvForecastUnavailable: false, soiling: null },
  degradation: { generatedAt: 1, eolSoh: 70, packs: [] },
  runway: { hoursToReserve: 7.5, hoursToEmpty: 12, unavailable: null },
  roundTripEfficiency: { efficiencyPct: 91 },
  clipping: { todayKwh: 1.2, arrayPeakW: 9000, generatedAt: NOW },
  selfConsumption: { solarFractionOfLoadPct: 80, directUseRatioPct: 60, homeDpusCoveragePartial: false },
  carbon: { totalKgAvoided: 10, lifetimeKgAvoided: 100, lifetimeMilesNotDriven: 250, basisComplete: true },
  tariff: { todayGridImportCostDollars: 1, todaySolarLoadValueDollars: 2, netSavingsDollars: 3, basisComplete: true },
  curtailment: { active: false, currentSurplusW: 0, todayKwh: 0, recent7dKwh: 1, current: null, basisComplete: true, generatedAt: NOW },
};
function stubAnalytics(): AnalyticsClient {
  return {
    report: async <T = any>(name: string): Promise<T> => structuredClone(REPORTS[name]) as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
}

async function build(devices: Any): Promise<Record<string, unknown>> {
  setAnalyticsClientForTesting(stubAnalytics());
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices, alerts: [], alertsComplete: true };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const rec = makeRecorderStub({ listLifetimeKeys: () => ['circuit_1_wh', 'circuit_2_wh'] });
  const handle = await mqttDiscovery.startMqttDiscovery(store, rec, () => {});
  try {
    return await handle.buildState!(snap);
  } finally {
    handle.stop();
    setAnalyticsClientForTesting(null);
  }
}

test('★★★ buildState: a shadowed panel publishes its live figures as null — the rest of the payload is untouched', async () => {
  const live = await build({ [HOUSE]: panel(HOUSE, { lastQuotaAtMs: Date.now() - 30_000 }), [CORE]: core() });
  assert.equal(live.panel_load_watts, 1611, 'fresh control: the channel sum');
  assert.equal(live.grid_home_watts, 2400);
  assert.equal(live.shp2_grid_status, 'Grid OK');
  assert.equal(live.backup_pool_percent, 72);
  assert.equal(live.backup_remaining_kwh, 66.7);
  assert.equal(live.circuit_1_watts, 1200);
  assert.equal(live.shp2_content_frozen_s, 0);

  const frozen = await build({ [HOUSE]: panel(HOUSE, { lastQuotaAtMs: Date.now() - 30_000, contentStaleSinceMs: Date.now() - 240_000 }), [CORE]: core() });
  for (const k of ['panel_load_watts', 'grid_home_watts', 'shp2_grid_status', 'backup_pool_percent', 'backup_remaining_kwh', 'circuit_1_watts', 'circuit_2_watts']) {
    assert.equal(frozen[k], null, k);
  }
  assert.equal(frozen.shp2_grid_connected, null, 'already unknown (gridState) — consistent now');
  assert.ok((frozen.shp2_content_frozen_s as number) >= 239, 'the frozen-for diagnostic still publishes');
  assert.equal(frozen.fleet_battery_net_watts, 4100, 'the Cores\' battery net is their own reading');
  assert.equal(frozen.backup_full_capacity_kwh, 92.2);
  assert.equal(frozen.backup_reserve_percent, 16);
  assert.ok('circuit_1_lifetime_kwh' in frozen, 'the per-circuit lifetime keys still publish');
});

test('★★ buildState: a panel with no quota for five minutes publishes null too (the readback-stale door)', async () => {
  const stale = await build({ [HOUSE]: panel(HOUSE, { lastQuotaAtMs: Date.now() - 6 * 60_000 }), [CORE]: core() });
  assert.equal(stale.panel_load_watts, null);
  assert.equal(stale.backup_pool_percent, null);
  assert.equal(stale.grid_home_watts, null);
});
