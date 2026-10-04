/**
 * v1.187.10 — the two daily figures the analytics worker RE-ESTIMATES during the day are published
 * as `state_class: total` with the day's local midnight as last_reset, not `total_increasing`.
 *
 * computeCurtailment re-walks every hour of today on each 5-min TTL against the current posterior
 * and weather cache, the partial current hour included (and it can drop out on its own), so PV
 * Curtailed Today moves down as well as up with no curtailment in progress: 2026-10-02 3.54 →
 * 3.03 kWh after curtailment ended, then 3.79 at 17:43. Home Assistant's recorder reads a drop to
 * below 0.9× the previous value on a total_increasing sensor as a meter RESET and counts the
 * day again: 09-29 0.11 → 0 and 0.35 → 0, 09-30 1.61 → 1.39, 10-01 1.85 → 1.58. computeClipping
 * re-walks today the same way (PV Clipped Today, latent). As 'total' with last_reset, a revision
 * books as a correction and only a new day — a new last_reset — starts a new cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'daily-figure-total-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9';

const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { SENSORS, BINARY_SENSORS, auditDiscoveryTables, sensorDiscoveryConfig } = mqttDiscovery;
const { dailyFigureResetIso } = await import('../src/haPayloadFmt.js');
const { startOfLocalDayMs } = await import('../src/aggregator.js');
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const DAILY = [
  ['ecoflow_pv_curtailment_kwh_today', 'pv_curtailment_kwh_today'],
  ['ecoflow_pv_clipped_kwh_today', 'pv_clipped_kwh_today'],
] as const;

test('★★★ both re-estimated daily figures are state_class total, with a last_reset template on their own day key', () => {
  for (const [uid, key] of DAILY) {
    const s = SENSORS.find((x) => x.unique_id === uid)!;
    assert.ok(s, uid);
    assert.equal(s.device_class, 'energy', `${uid}: still an energy statistic`);
    assert.equal(s.state_class, 'total', `${uid}: not total_increasing — a revision must not read as a meter reset`);
    assert.equal(s.value_template, `{{ value_json.${key} }}`);
    assert.equal(s.last_reset_value_template, `{{ value_json.${key}_since }}`);
  }
});

test('★★ their retained config carries last_reset and NO expire_after (an accumulating statistic, like total_increasing)', () => {
  for (const [uid] of DAILY) {
    const cfg = sensorDiscoveryConfig(SENSORS.find((x) => x.unique_id === uid)!);
    assert.equal(cfg.state_class, 'total');
    assert.ok(typeof cfg.last_reset_value_template === 'string');
    assert.equal('expire_after' in cfg, false, `${uid}: an expiring statistics source gaps long-term statistics`);
  }
  const live = sensorDiscoveryConfig(SENSORS.find((x) => x.unique_id === 'ecoflow_panel_load_watts')!);
  assert.equal(live.expire_after, 120, 'a live measurement still expires');
  const lifetime = sensorDiscoveryConfig(SENSORS.find((x) => x.unique_id === 'ecoflow_pv_lifetime_kwh')!);
  assert.equal('expire_after' in lifetime, false);
});

test('★★★ the table audit: a daily figure that is total_increasing, or total without last_reset, is a violation', () => {
  assert.deepEqual(auditDiscoveryTables(SENSORS, BINARY_SENSORS), [], 'the shipped tables are coherent');
  const base = { unique_id: 'probe', name: 'Probe', device_class: 'energy', unit_of_measurement: 'kWh', value_template: '{{ value_json.probe_kwh_today }}' };
  const rules = (s: Record<string, unknown>) => auditDiscoveryTables([s as never], []).map((v) => v.rule);
  assert.deepEqual(rules({ ...base, state_class: 'total_increasing' }), ['daily-figure-needs-total-with-reset']);
  assert.deepEqual(rules({ ...base, state_class: 'total' }), ['daily-figure-needs-total-with-reset']);
  assert.deepEqual(rules({ ...base, state_class: 'total', last_reset_value_template: '{{ value_json.probe_kwh_today_since }}' }), []);
  assert.deepEqual(rules({ ...base, state_class: 'total_increasing', value_template: '{{ value_json.probe_lifetime_kwh }}' }), [], 'a lifetime counter is not a daily figure');
});

test('★★ the reset is the local midnight of the REPORT\'s day, not the publish clock', () => {
  const noonToday = new Date(); noonToday.setHours(12, 0, 0, 0);
  const lateYesterday = new Date(noonToday.getTime() - 86_400_000); lateYesterday.setHours(23, 59, 30, 0);
  assert.equal(dailyFigureResetIso(noonToday.getTime()), new Date(startOfLocalDayMs(noonToday)).toISOString());
  assert.equal(
    dailyFigureResetIso(lateYesterday.getTime(), noonToday.getTime()),
    new Date(startOfLocalDayMs(lateYesterday)).toISOString(),
    'a last-good report from before midnight keeps its own day: its figure is that day\'s',
  );
  assert.equal(dailyFigureResetIso(null, noonToday.getTime()), new Date(startOfLocalDayMs(noonToday)).toISOString(), 'no report: today');
  assert.ok(!Number.isNaN(Date.parse(dailyFigureResetIso(undefined))), 'always a parseable timestamp (HA warns on an invalid last_reset)');
});

test('★★★ buildState emits each figure with its day: the reset keys follow their own report', async () => {
  const curtGen = Date.now() - 60_000;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(23, 58, 0, 0);
  const reports: Record<string, unknown> = {
    curtailment: { active: false, currentSurplusW: 0, todayKwh: 3.03, recent7dKwh: 6.9, current: null, basisComplete: true, generatedAt: curtGen },
    clipping: { todayKwh: 0.4, arrayPeakW: 9707, generatedAt: yesterday.getTime() },
  };
  const stub: AnalyticsClient = {
    report: async <T = any>(name: string): Promise<T> => structuredClone(reports[name] ?? null) as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
  setAnalyticsClientForTesting(stub);
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {} };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), () => {});
  try {
    const s = await handle.buildState!(snap);
    assert.equal(s.pv_curtailment_kwh_today_since, new Date(startOfLocalDayMs(new Date(curtGen))).toISOString());
    assert.equal(s.pv_clipped_kwh_today_since, new Date(startOfLocalDayMs(yesterday)).toISOString());
  } finally {
    handle.stop();
    setAnalyticsClientForTesting(null);
  }
});
