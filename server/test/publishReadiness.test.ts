/**
 * v1.178.0 — a published value is null until the data behind it exists.
 *
 * At every add-on restart the first MQTT state publish ran ~0.8 s before the first device
 * poll, before the alarm monitor's first evaluation and the first speaker probe, and against
 * an analytics worker with an empty device view. Home Assistant history for 2026-09-22's four
 * restarts: 16 sensors went X → 0 → X each time, and the total_increasing
 * pv_curtailment_kwh_today dip (5.44 → 0 → 5.44 kWh) read as a meter reset — the day's
 * curtailment counted again, 8 times since 09-01.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishReadiness, withholdUnready, READINESS_FIELDS, type ReadinessInputs } from '../src/publishReadiness.js';
import { computeCarbonReport, computeTariffReport, resetTariffCache } from '../src/analytics.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

type Any = any;

/** The main snapshot at broker connect: devices listed by /device/list, none projected. */
const bootInputs = (): ReadinessInputs => ({
  devices: { SHP2: { online: true }, C1: { online: true }, C2: { online: true } },
  alerts: undefined,
  speakerLastProbeAt: null,
  forecast: { pvForecastUnavailable: true },
  clipping: { arrayPeakW: 0 },
  curtailment: { basisComplete: false },
  carbon: { basisComplete: false },
  tariff: { basisComplete: false },
});

const warmInputs = (): ReadinessInputs => ({
  devices: {
    SHP2: { online: true, projection: { kind: 'shp2', circuits: [{ watts: 400 }, { watts: null }] } },
    C1: { online: true, projection: { kind: 'dpu' } },
  },
  alerts: [],
  speakerLastProbeAt: Date.now(),
  forecast: { pvForecastUnavailable: false },
  clipping: { arrayPeakW: 9707 },
  curtailment: { basisComplete: true },
  carbon: { basisComplete: true },
  tariff: { basisComplete: true },
});

/** A payload shaped like the boot publish: every governed field a model-less 0. */
function bootPayload(): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const keys of Object.values(READINESS_FIELDS)) for (const k of keys) p[k] = 0;
  p.pv_lifetime_kwh = 6659.1; // lifetime counters come from the persisted accumulator — real at boot
  p.carbon_lifetime_kg_avoided = 4210;
  p.fleet_devices_online = 10;
  return p;
}

test('★★★ at boot every governed field is null — no model-less 0 reaches Home Assistant', () => {
  const r = publishReadiness(bootInputs());
  assert.deepEqual(Object.values(r).filter(Boolean), [], `every flag false at boot: ${JSON.stringify(r)}`);
  const out = withholdUnready(bootPayload(), r);
  for (const keys of Object.values(READINESS_FIELDS)) for (const k of keys) assert.equal(out[k], null, k);
});

test('★★★ the total_increasing curtailment counter is null at boot, so HA sees no meter reset', () => {
  const out = withholdUnready({ pv_curtailment_kwh_today: 0 }, publishReadiness(bootInputs()));
  assert.equal(out.pv_curtailment_kwh_today, null);
});

test('real-at-boot values pass through untouched (lifetime counters, device count)', () => {
  const out = withholdUnready(bootPayload(), publishReadiness(bootInputs()));
  assert.equal(out.pv_lifetime_kwh, 6659.1);
  assert.equal(out.carbon_lifetime_kg_avoided, 4210);
  assert.equal(out.fleet_devices_online, 10);
});

test('once warm nothing is withheld — including legitimate zeros (PV at night, no alarms)', () => {
  const r = publishReadiness(warmInputs());
  assert.ok(Object.values(r).every(Boolean), JSON.stringify(r));
  const out = withholdUnready(bootPayload(), r);
  assert.equal(out.fleet_pv_watts, 0, 'a real night-time 0 W is published');
  assert.equal(out.alert_critical_count, 0, 'a real "no criticals" is published');
});

test('★★ each group is independent: alarm counts publish the moment the monitor has run, even with a cold worker', () => {
  const i = bootInputs();
  i.alerts = [];
  const r = publishReadiness(i);
  assert.equal(r.alerts, true);
  assert.equal(r.carbon, false);
  const out = withholdUnready({ alert_high_count: 0, carbon_kg_avoided_7d: 0 }, r);
  assert.equal(out.alert_high_count, 0);
  assert.equal(out.carbon_kg_avoided_7d, null);
});

test('panel load needs a projected panel with at least one REPORTED channel (a silent panel is not 0 W)', () => {
  const i = warmInputs();
  (i.devices.SHP2 as Any).projection.circuits = [{ watts: null }, { watts: null }];
  assert.equal(publishReadiness(i).panel, false);
});

test('★★ a bench spare alone does not make the fleet flows real: every home Core wedged, the spare online', () => {
  const i = warmInputs();
  (i.devices.SHP2 as Any).projection.sources = [{ slot: 1, sn: 'A', isConnected: true }];
  i.devices = { SHP2: i.devices.SHP2, A: { online: false }, SPARE: { online: true, projection: { kind: 'dpu' } } } as Any;
  assert.equal(publishReadiness(i).flow, false, 'aggregateFleetFlow sums over nothing: not a reading');
  (i.devices as Any).A = { online: true, projection: { kind: 'dpu' } };
  assert.equal(publishReadiness(i).flow, true);
});

test('★ a panel LISTED but not projected (boot race, or cloud-offline at a restart) is not a DPU-only install: flows wait', () => {
  const i = warmInputs();
  i.devices = {
    P: { sn: 'P', productName: 'Smart Home Panel 2', online: false } as Any,
    SPARE: { sn: 'SPARE', online: true, projection: { kind: 'dpu' } },
  };
  assert.equal(publishReadiness(i).flow, false, 'membership unknown: the spare may be all there is');
  delete (i.devices as Any).P;
  assert.equal(publishReadiness(i).flow, true, 'no panel listed at all: a DPU-only install');
});

test('the charge ceiling is not governed: a live device setting, null when unknown, needs no weather', () => {
  const out = withholdUnready({ pv_curtailment_charge_ceiling_pct: 90 }, publishReadiness(bootInputs()));
  assert.equal(out.pv_curtailment_charge_ceiling_pct, 90);
});

test('the flow group needs an ONLINE projected Core', () => {
  const i = warmInputs();
  (i.devices.C1 as Any).online = false;
  assert.equal(publishReadiness(i).flow, false);
});

/* ── the report gates are real ───────────────────────────────────────────── */

const emptyRec = makeRecorderStub({ query: () => [], queryMulti: () => new Map(), listMetrics: () => [] } as Any);

test('★★ carbon and tariff report basisComplete=false on a boot-partial snapshot (no projections)', () => {
  const listed: Any = { SHP2: { sn: 'SHP2', deviceName: 'SHP2', online: true, lastUpdated: 0 }, C1: { sn: 'C1', deviceName: 'C1', online: true, lastUpdated: 0 } };
  assert.equal(computeCarbonReport(listed, emptyRec).basisComplete, false);
  assert.equal(computeTariffReport(listed, emptyRec).basisComplete, false);
});

test('★★ a DPU-only install (no panel listed at all) prices ac_in and publishes its tariff; a panel LISTED but unprojected is the boot race', () => {
  const core: Any = { sn: 'C1', deviceName: 'Core', productName: 'Delta Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: { kind: 'dpu', soc: 50, acInWatts: 0, packs: [] } };
  resetTariffCache();
  assert.equal(computeTariffReport({ C1: core }, emptyRec).basisComplete, true, 'DPU-only: complete without a panel');
  resetTariffCache();
  const listedPanel: Any = { sn: 'P', deviceName: 'Panel', productName: 'Smart Home Panel 2', online: true, lastUpdated: 0 };
  assert.equal(computeTariffReport({ C1: core, P: listedPanel }, emptyRec).basisComplete, false, 'panel listed, not yet projected');
  resetTariffCache();
});

/* ── wiring and key integrity ────────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, '../src/', f), 'utf8');

test('★★ both publishers pass their payload through withholdUnready(publishReadiness(...))', () => {
  const mqtt = src('mqttDiscovery.ts');
  assert.ok(/return withholdUnready\(state, publishReadiness\(\{/.test(mqtt), 'MQTT buildState');
  const rest = src('index.ts');
  assert.ok(/withholdUnready\(payload as Record<string, unknown>, publishReadiness\(\{/.test(rest), '/api/ha-state');
  for (const f of [mqtt, rest]) assert.ok(f.includes('speakerLastProbeAt: getBroadcastHealth().lastProbeAt'));
});

test('★★★ v1.178.1 — both publishers take the fleet sums AFTER the reports\' await, with no await before readiness', () => {
  // `snap` is the store's live object and publishReadiness judges it after the await. At the
  // v1.178.0 deploy the sums were taken BEFORE it: the first poll landed during the await,
  // readiness saw projected devices, and the pre-poll 0 W sums went out as readings
  // (battery net and panel load X → 0 → X). Sums and readiness must read the same moment.
  for (const [file, open] of [
    ['mqttDiscovery.ts', 'const buildState = async'],
    ['index.ts', "app.get('/api/ha-state'"],
  ] as const) {
    const f = src(file);
    const start = f.indexOf(open);
    assert.ok(start > 0, `${file}: ${open}`);
    const readiness = f.indexOf('publishReadiness({', start);
    const body = f.slice(start, readiness);
    const reportsAwait = body.indexOf('await Promise.all([');
    const firstSums = body.indexOf('aggregateFleetFlow(snap.devices)');
    assert.ok(reportsAwait > 0 && firstSums > 0, `${file}: both found`);
    assert.ok(firstSums > reportsAwait, `${file}: the fleet sums are taken after the reports' await`);
    assert.doesNotMatch(body.slice(firstSums), /\bawait\b/, `${file}: no await between the sums and publishReadiness`);
  }
});

test('★★ every governed key exists in at least one publisher — a typo would silently guard nothing', () => {
  const both = src('mqttDiscovery.ts') + src('index.ts');
  for (const [flag, keys] of Object.entries(READINESS_FIELDS)) {
    for (const k of keys) assert.ok(new RegExp(`\\b${k}\\s*:`).test(both), `${flag}: "${k}" is not published anywhere`);
  }
});

test('★★ a withheld BINARY sensor renders "None" (HA unknown), not "OFF" — a falsy-null template would fabricate an off edge', async () => {
  // HA 2026.9 mqtt/binary_sensor.py: payload == PAYLOAD_NONE ("None") → is_on = None (unknown).
  // `{{ "ON" if value_json.x else "OFF" }}` renders null as "OFF": an on→off edge at every restart.
  const { BINARY_SENSORS } = await import('../src/mqttDiscovery.js');
  const governed = new Set(Object.values(READINESS_FIELDS).flat());
  let checked = 0;
  for (const b of BINARY_SENSORS) {
    const key = /value_json\.(\w+)/.exec(b.value_template)?.[1];
    if (!key || !governed.has(key)) continue;
    checked++;
    assert.match(b.value_template, new RegExp(`"None" if value_json\\.${key} is none`), `${b.unique_id}: null must render "None"`);
  }
  assert.ok(checked >= 1, 'pv_curtailment_active is governed and checked');
});

test('★★ the forecast flags a model-less PV forecast: no projected home Core means pvForecastUnavailable', async () => {
  const { getDayForecast, resetForecastCachesForTesting } = await import('../src/analytics.js');
  resetForecastCachesForTesting();
  const listed: Any = { SHP2: { sn: 'SHP2', deviceName: 'SHP2', online: true, lastUpdated: 0 }, C1: { sn: 'C1', deviceName: 'C1', online: true, lastUpdated: 0 } };
  const fc = await getDayForecast(listed, emptyRec, () => {});
  assert.equal(fc.pvForecastUnavailable, true, 'the boot forecast is not a forecast');
  assert.equal(fc.forecastPvWhNext24, 0, '(and this is the 0 that used to be published)');
  resetForecastCachesForTesting();
});

test('★★ the flag follows the PUBLISHED basis: every home Core wedged at a restart, their own recorded PV still makes a real display forecast', async () => {
  const { getDayForecast, resetForecastCachesForTesting } = await import('../src/analytics.js');
  const HOUR = 3_600_000;
  const now = Date.now();
  const series = (w: number) => Array.from({ length: 48 }, (_, k) => ({ ts: now - (48 - k) * HOUR, value: w }));
  // The panel is projected and names A and B as connected sources; neither Core is projected
  // (cloud-offline when the add-on started, so no quota was fetched). A bench spare is.
  const devices: Any = {
    SHP2: { sn: 'SHP2', deviceName: 'SHP2', online: true, lastUpdated: now,
      projection: { kind: 'shp2', backupBatPercent: 60, backupFullCapWh: 100_000, backupRemainWh: 60_000, backupReserveSoc: 15,
        circuits: [{ ch: 1, watts: 900 }], pairedCircuits: [], sources: [{ slot: 1, sn: 'A', isConnected: true }, { slot: 2, sn: 'B', isConnected: true }], sourceWatts: [] } },
    A: { sn: 'A', deviceName: 'Core A', online: false, lastUpdated: 0 },
    B: { sn: 'B', deviceName: 'Core B', online: false, lastUpdated: 0 },
    SPARE: { sn: 'SPARE', deviceName: 'Spare', online: true, lastUpdated: now, projection: { kind: 'dpu', soc: 50, pvTotalWatts: 0, packs: [] } },
  };
  const withHistory = makeRecorderStub({
    query: (sn: string, metric: string) => (metric === 'pv_total' && sn === 'A' ? series(1500) : metric === 'panel_load' ? series(900) : []),
    queryMulti: (_sn: string, metrics: string[]) => new Map(metrics.map((m) => [m, []])),
    listMetrics: () => [],
  } as Any);
  resetForecastCachesForTesting();
  const fc = await getDayForecast(devices, withHistory, () => {});
  assert.equal(fc.pvForecastUnavailable, false, 'Core A\'s own recorded PV is the published basis');
  resetForecastCachesForTesting();
  const cold = makeRecorderStub({ query: () => [], queryMulti: () => new Map(), listMetrics: () => [] } as Any);
  assert.equal((await getDayForecast(devices, cold, () => {})).pvForecastUnavailable, true, 'no history anywhere: model-less');
  resetForecastCachesForTesting();
});
