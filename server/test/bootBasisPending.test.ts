/**
 * v1.187.10 — a forecast or runway built while a home Core's first reading is pending is not
 * published as a definite value.
 *
 * The analytics worker is released on the first snapshot with ANY projection; at a restart that is
 * often the panel's alone, with every home Core listed ONLINE and none of their quotas landed yet.
 * The first forecast then had no home Core in its solar model (a zero-PV alarm-facing series, no
 * bias correction), the SoC sim drained to 0 %, and structurallyIncomplete stayed false (pvCold
 * needs a projected home Core; the panel keeps loadCold and socBasisMissing false). HA history:
 * 2026-10-03 12:08:43 Projected Low SoC 0 % and Runway to Reserve 10.7 h / to Empty 15.9 h (999
 * before and after), Forecast Basis Incomplete OFF; 12:09:38 both runways read 15.9 h — the
 * to-empty hysteresis had latched the partial compute and coherentRunwayPair clamped the next
 * complete reserve crossing to it; 2026-10-02 19:24:29 runway 19.1 / 21.5 h. Now:
 *   - homeBasisPending: a connected home Core listed online with no projection (the boot race; a
 *     wedged Core is listed offline and keeps its conservative figures), bounded to
 *     HOME_BASIS_PENDING_MAX_MS of the worker's life;
 *   - the forecast is structurally incomplete and carries homeBasisPending;
 *   - the runway carries basisPending, is not cached, and neither reads nor arms the hysteresis;
 *   - both publishers withhold the PV pair, Projected Low SoC and the runway fields, and the
 *     lighting posture is not advanced on them. The alarm path still reads the conservative figures.
 * Test serials are placeholders.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'boot-basis-pending-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9';

const analytics = await import('../src/analytics.js');
const { homeBasisPending, HOME_BASIS_PENDING_MAX_MS, getDayForecast, resetForecastCachesForTesting, computeRunway, resetRunwayCache } = analytics;
const { publishReadiness, withholdUnready } = await import('../src/publishReadiness.js');
const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

type Any = any;
const H = 3_600_000;
const PANEL = 'PANEXXX00XXX0001';
const A = 'COREXXX00XXX0001';
const B = 'COREXXX00XXX0002';

function panel(remainWh = 65_400): Any {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    lastQuotaAtMs: Date.now(),
    projection: {
      kind: 'shp2', backupBatPercent: 71, backupFullCapWh: 92_160, backupRemainWh: remainWh, backupReserveSoc: 16,
      circuits: [{ ch: 1, watts: 2400 }], pairedCircuits: [],
      sources: [{ slot: 1, sn: A, isConnected: true }, { slot: 2, sn: B, isConnected: true }], sourceWatts: [],
    },
  };
}
/** Listed by /device/list; `projected` once its first quota has landed. */
function coreDev(sn: string, online: boolean, projected: boolean): Any {
  return {
    sn, deviceName: `Core ${sn.slice(-1)}`, productName: 'DELTA Pro Ultra', online, lastUpdated: projected ? Date.now() : 0,
    ...(projected ? { projection: { kind: 'dpu', soc: 71, pvTotalWatts: 0, packs: [] } } : {}),
  };
}
const map = (a: Any, b: Any): Any => ({ [PANEL]: panel(), [A]: a, [B]: b });

/* ── the predicate ─────────────────────────────────────────────────────── */

test('★★★ the boot race: the panel lists Cores the device list reports ONLINE, with no quota landed — pending', () => {
  assert.equal(homeBasisPending(map(coreDev(A, true, false), coreDev(B, true, false))), true);
  assert.equal(homeBasisPending(map(coreDev(A, true, true), coreDev(B, true, false))), true, 'one still pending is enough');
  assert.equal(homeBasisPending(map(coreDev(A, true, true), coreDev(B, true, true))), false, 'every Core projected');
});

test('★★★ a WEDGED Core (listed offline, unprojected after a restart) is not pending: its conservative figures stand', () => {
  assert.equal(homeBasisPending(map(coreDev(A, true, true), coreDev(B, false, false))), false);
  assert.equal(homeBasisPending(map(coreDev(A, false, false), coreDev(B, false, false))), false);
});

test('★★ no panel projection, no roster: nothing is pending (the SHP2-absent case is socBasisMissing)', () => {
  assert.equal(homeBasisPending({ [A]: coreDev(A, true, false) }), false);
});

test('★★ bounded: past HOME_BASIS_PENDING_MAX_MS of the worker\'s life a Core whose quota keeps failing stops counting', () => {
  assert.equal(HOME_BASIS_PENDING_MAX_MS, 600_000);
  const m = map(coreDev(A, true, false), coreDev(B, true, true));
  const t = Date.now();
  assert.equal(homeBasisPending(m, t, t - 600_000), true, 'at the bound');
  assert.equal(homeBasisPending(m, t, t - 600_001), false, 'past it');
});

/* ── the forecast ──────────────────────────────────────────────────────── */

const series = (w: number) => Array.from({ length: 48 }, (_, k) => ({ ts: Date.now() - (48 - k) * H, value: w }));
const history = makeRecorderStub({
  query: (sn: string, metric: string) => (metric === 'pv_total' && (sn === A || sn === B) ? series(1500) : metric === 'panel_load' ? series(2700) : []),
  queryMulti: (_sn: string, metrics: string[]) => new Map(metrics.map((m) => [m, []])),
  listMetrics: () => [],
} as Any);

test('★★★ a forecast built on the boot map is structurally incomplete and says why', async () => {
  resetForecastCachesForTesting();
  const fc = await getDayForecast(map(coreDev(A, true, false), coreDev(B, true, false)), history, () => {});
  assert.equal(fc.homeBasisPending, true);
  assert.equal(fc.structurallyIncomplete, true, 'Forecast Basis Incomplete reads ON, not OFF');
  resetForecastCachesForTesting();
});

test('★★ the same map with both Cores WEDGED (listed offline) is not pending — and, with history, not incomplete', async () => {
  resetForecastCachesForTesting();
  const fc = await getDayForecast(map(coreDev(A, false, false), coreDev(B, false, false)), history, () => {});
  assert.equal(fc.homeBasisPending, false);
  assert.equal(fc.structurallyIncomplete, false, 'the control: nothing else made this basis incomplete');
  resetForecastCachesForTesting();
});

/* ── the runway ────────────────────────────────────────────────────────── */

const loadRows = makeRecorderStub({
  query: (_sn: string, metric: string) => (metric === 'panel_load'
    ? Array.from({ length: 60 }, (_, i) => ({ ts: Date.now() - (60 - i) * 60_000, value: 2700 })) : []),
  queryMulti: () => new Map(),
  listMetrics: () => ['panel_load'],
} as Any);
function forecast(pvKw: number, pending = false): Any {
  return {
    generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 16, homeBasisPending: pending,
    hours: Array.from({ length: 24 }, (_, h) => ({
      ts: Date.now() + h * H, forecastPvW: pvKw * 1000, forecastLoadW: 2700, cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: null, modelled: true,
    })),
    forecastPvWhNext24: pvKw * 24_000, typicalPvWhPerDay: 0, restoredSolarModel: {},
  };
}

test('★★★ a pending-basis runway is marked, not cached, and does not arm the to-empty hysteresis', () => {
  resetRunwayCache();
  // 12:08:43 — the worker's map holds the panel, the Cores listed online and unprojected; no PV.
  const partial = computeRunway(map(coreDev(A, true, false), coreDev(B, true, false)), loadRows, forecast(0));
  assert.equal(partial.basisPending, true);
  assert.ok(partial.hoursToEmpty != null && partial.hoursToEmpty < 24, `a finite to-empty crossing (${partial.hoursToEmpty})`);
  // Seconds later the Cores have landed and the complete forecast has PV: no crossing.
  const complete = computeRunway(map(coreDev(A, true, true), coreDev(B, true, true)), loadRows, forecast(6));
  assert.equal(complete.basisPending, undefined, 'recomputed — the pending value was not served from the cache');
  assert.equal(complete.hoursToEmpty, null, 'released at once: nothing was latched from the partial compute');
  assert.equal(complete.hoursToReserve, null, 'and the reserve crossing is not clamped to a latched value');
  resetRunwayCache();
});

test('★★ the discriminator: a COMPLETE finite crossing still arms the hysteresis (it holds the next no-crossing compute)', () => {
  resetRunwayCache();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const all = map(coreDev(A, true, true), coreDev(B, true, true));
    const first = computeRunway(all, loadRows, forecast(0));
    assert.equal(first.basisPending, undefined);
    assert.ok(first.hoursToEmpty != null);
    mock.timers.tick(61_000); // past RUNWAY_TTL_MS, so the next call recomputes
    const next = computeRunway(all, loadRows, forecast(6));
    assert.equal(next.hoursToEmpty, first.hoursToEmpty, 'held by the latch, as v0.60.0 designs');
  } finally {
    mock.timers.reset();
    resetRunwayCache();
  }
});

test('★★ a forecast that was built pending marks the runway even on a complete map (a cached partial forecast)', () => {
  resetRunwayCache();
  const r = computeRunway(map(coreDev(A, true, true), coreDev(B, true, true)), loadRows, forecast(0, true));
  assert.equal(r.basisPending, true);
  resetRunwayCache();
});

/* ── publish readiness ─────────────────────────────────────────────────── */

const inputs = (fc: Any, runway: Any) => ({
  devices: {}, alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: fc, runway,
  clipping: null, curtailment: null, carbon: null, tariff: null,
});

test('★★★ withheld while pending: the PV pair and Projected Low SoC (forecast), the runway fields (runway)', () => {
  const pay = (): Record<string, unknown> => ({
    forecast_pv_next_24h_kwh: 49.5, typical_pv_per_day_kwh: 48, projected_low_soc_percent: 0, projected_low_soc_at: 123,
    runway_to_reserve_hours: 10.7, runway_to_empty_hours: 15.9, runway_recent_load_watts: 2700, runway_forecast_pv_used_kwh: 0,
    forecast_structurally_incomplete: true,
  });
  const pending = withholdUnready(pay(), publishReadiness(inputs({ pvForecastUnavailable: false, homeBasisPending: true }, { basisPending: true })));
  for (const k of ['forecast_pv_next_24h_kwh', 'typical_pv_per_day_kwh', 'projected_low_soc_percent', 'projected_low_soc_at',
    'runway_to_reserve_hours', 'runway_to_empty_hours', 'runway_recent_load_watts', 'runway_forecast_pv_used_kwh']) {
    assert.equal(pending[k], null, k);
  }
  assert.equal(pending.forecast_structurally_incomplete, true, 'the diagnostic flag publishes: it is the truth about the basis');
  const done = withholdUnready(pay(), publishReadiness(inputs({ pvForecastUnavailable: false, homeBasisPending: false }, {})));
  assert.equal(done.projected_low_soc_percent, 0, 'a real 0 % low on a complete basis publishes');
  assert.equal(done.runway_to_reserve_hours, 10.7);
  // Each report is judged on its own basis.
  const runwayOnly = withholdUnready(pay(), publishReadiness(inputs({ pvForecastUnavailable: false }, { basisPending: true })));
  assert.equal(runwayOnly.projected_low_soc_percent, 0);
  assert.equal(runwayOnly.runway_to_empty_hours, null);
  assert.equal(publishReadiness(inputs({}, null)).runwayBasis, false, 'no runway report: not ready');
});

/* ── the MQTT publisher ────────────────────────────────────────────────── */

const REPORTS = (pending: boolean): Record<string, unknown> => ({
  forecast: { forecastPvWhNext24: 49_500, forecastPvWhNext24Display: 49_500, minProjectedSoc: pending ? 0 : 12, structurallyIncomplete: pending, homeBasisPending: pending, pvForecastUnavailable: false, soiling: null },
  degradation: { generatedAt: 1, eolSoh: 70, packs: [] },
  runway: pending
    ? { hoursToReserve: 10.7, hoursToEmpty: 15.9, unavailable: null, basisPending: true, backupRemainingKwh: 65.4, backupReserveKwh: 14.7 }
    : { hoursToReserve: null, hoursToEmpty: null, unavailable: null, backupRemainingKwh: 65.4, backupReserveKwh: 14.7 },
  roundTripEfficiency: { efficiencyPct: 91 },
  clipping: { todayKwh: 0, arrayPeakW: 9000, generatedAt: Date.now() },
  selfConsumption: null,
  carbon: null,
  tariff: null,
  curtailment: { active: false, currentSurplusW: 0, todayKwh: 0, recent7dKwh: 1, current: null, basisComplete: true, generatedAt: Date.now() },
});

async function build(pending: boolean): Promise<Record<string, unknown>> {
  const stub: AnalyticsClient = {
    report: async <T = any>(name: string): Promise<T> => structuredClone(REPORTS(pending)[name]) as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
  setAnalyticsClientForTesting(stub);
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: map(coreDev(A, true, true), coreDev(B, true, true)), alerts: [], alertsComplete: true };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), () => {});
  try {
    return await handle.buildState!(snap);
  } finally {
    handle.stop();
    setAnalyticsClientForTesting(null);
  }
}

test('★★★ buildState, 12:08:43 replayed: no 0 % low, no finite runway, no posture — and the basis flag reads ON', async () => {
  const s = await build(true);
  assert.equal(s.projected_low_soc_percent, null);
  assert.equal(s.forecast_pv_next_24h_kwh, null);
  assert.equal(s.runway_to_reserve_hours, null);
  assert.equal(s.runway_to_empty_hours, null);
  assert.equal(s.lighting_posture, null, 'the tracker is not advanced on a pending basis');
  assert.equal(s.lighting_posture_reason, null);
  assert.equal(s.forecast_structurally_incomplete, true);
});

test('★★ buildState on the complete basis publishes them (999 = no depletion)', async () => {
  const s = await build(false);
  assert.equal(s.projected_low_soc_percent, 12);
  assert.equal(s.forecast_pv_next_24h_kwh, 49.5);
  assert.equal(s.runway_to_reserve_hours, 999);
  assert.equal(s.runway_to_empty_hours, 999);
  assert.equal(typeof s.lighting_posture, 'string');
  assert.equal(s.forecast_structurally_incomplete, false);
});
