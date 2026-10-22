/**
 * v1.188.1 (review) — a curtailment hour with no panel_load is unknown load, not 0 W.
 *
 * Since the freshness gate a panel the EcoFlow cloud lists offline writes no rows while the Cores
 * keep streaming over MQTT. sampleCurtailmentHour read the missing load as `?? 0`, which skipped
 * the weather-verified "PV meaningfully exceeds load → not curtailing" disqualifier: an hour of a
 * full pool, measured sun and a held panel was counted as curtailed (2.997 kWh in the reproduction),
 * fed "PV Curtailed Today/7d" and could be frozen into the day for a week. Before the gate the held
 * panel's heartbeat restated its last panel_load, so the mean was always present.
 *
 * Driven through a real SnapshotStore and createRecorder (its freshness gate), then
 * computeCurtailment over the recorder, with fake serials. Control: the same hour with the panel live.
 *
 * The fixture is on the SITE clock (zonedWallTimeMs / siteHour), as computeCurtailment walks site
 * hours: on a host-clock fixture a host/site split moved the held hour off site hour 11, and both
 * negative checks passed whatever the code did.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'ef-curtail-held-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.SHADOW_WITNESS_PATH = join(tmp, 'shadow-witness.json');
process.env.CURTAILMENT_DAYS_PATH = join(tmp, 'curtailment-days.json');
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { computeCurtailment, resetForecastCachesForTesting, setBayesianModelForTesting } = await import('../src/analytics.js');
const { setWeatherCacheForTesting, clearWeatherTestOverride } = await import('../src/weather.js');
const { resetCurtailmentFreezeForTesting, setCurtailmentMembershipHistoryForTesting } = await import('../src/curtailmentFreeze.js');
const { siteHour, siteTimeZone, zonedWallTimeMs } = await import('../src/siteTime.js');

const MIN = 60_000;
const H = 60 * MIN;
const CORE = 'COREXXX00XXX0001';
const PANEL = 'PANEXXX00XXX0001';
/** A site wall time on 2026-01-20. */
const at = (h: number, m = 0) => zonedWallTimeMs('2026-01-20', h, m, siteTimeZone());

const listItem = (sn: string, online: boolean) => ({
  sn, deviceName: sn === PANEL ? 'Smart Home Panel 2' : 'Core 1',
  productName: sn === PANEL ? 'Smart Home Panel 2' : 'Delta Pro Ultra', online: online ? 1 : 0,
}) as any;
/** A Core at the charge ceiling producing ~4 kW. */
const coreQuota = (k: number) => ({
  'hs_yj751_pd_appshow_addr.soc': 99,
  'hs_yj751_pd_appshow_addr.inHvMpptPwr': 4000 + (k % 7),
  'hs_yj751_pd_appshow_addr.inLvMpptPwr': 0,
  'hs_yj751_pd_appshow_addr.wattsOutSum': 900 + (k % 11),
  'hs_yj751_pd_backend_addr.batVol': 53 + (k % 3) / 10,
  'hs_yj751_pd_app_set_info_addr.chgMaxSoc': 100,
});
/** The panel: 12 circuits, ~1,800 W, the Core connected. */
const panelQuota = (k: number) => ({
  'loadInfo.hall1Watt': [150 + (k % 5), 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150],
  'wattInfo.gridWatt': 0,
  'pd303_mc.backupIncreInfo.Energy1Info.devInfo.modelInfo.sn': CORE,
  'pd303_mc.backupIncreInfo.Energy1Info.isConnect': 1,
  'pd303_mc.backupIncreInfo.Energy1Info.batteryPercentage': 99,
});

function clocks(t: TestContext, wall0: number) {
  const c = { wall: wall0, mono: 1_000 };
  t.mock.method(Date, 'now', () => c.wall);
  t.mock.method(performance, 'now', () => c.mono);
  return { c, advance: (ms: number) => { c.wall += ms; c.mono += ms; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
function resetDb() {
  if (!existsSync(DB_PATH)) return;
  const db = new DatabaseSync(DB_PATH);
  try { db.exec('DELETE FROM samples'); } finally { db.close(); }
}
const bayes = (mu: number) => ({
  generatedAt: Date.now(),
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, posteriorMean: mu, posteriorStdev: 0.5, ci95Low: mu - 1, ci95High: mu + 1, samples: 10 })),
  totalSamples: 240, medianStdev: 0.5, agreementWithOls: 1,
});
/** A clear day: 700 W/m² measured from site 08:00 to 16:00 (labels on the UTC hour, as Open-Meteo's). */
function weather(fetchedAt: number) {
  const hours: any[] = [];
  const d0 = Math.floor(zonedWallTimeMs('2026-01-19', 0, 0, siteTimeZone()) / H) * H;
  for (let ts = d0; ts < d0 + 3 * 24 * H; ts += H) {
    const h = siteHour(ts);
    hours.push({ ts, cloudCoverPct: 0, radiationWm2: h >= 8 && h <= 16 ? 700 : 0, tempC: 20, ensembleSources: 1 });
  }
  return { fetchedAt, lat: 33.45, lon: -112.07, hours };
}

async function scenario(t: TestContext, panelHeld: boolean) {
  resetDb();
  const { c, advance } = clocks(t, at(10, 30));
  const store = new SnapshotStore();
  store.setClock(() => Date.now());
  store.setLogger(() => {});
  const rec = createRecorder(store, () => {});
  try {
    let k = 0;
    while (c.wall < at(12, 30)) {
      // 10:55 → 12:10 the cloud lists the panel offline: no quota for it, so its reading is held.
      const inHold = panelHeld && c.wall >= at(10, 55) && c.wall < at(12, 10);
      store.setDeviceList([listItem(CORE, true), listItem(PANEL, !inHold)]);
      await flush();
      store.setDeviceQuota(CORE, coreQuota(k));
      await flush();
      if (!inHold) { store.setDeviceQuota(PANEL, panelQuota(k)); await flush(); }
      k++;
      advance(MIN);
    }
    const db = new DatabaseSync(DB_PATH);
    let panelLoadRows = 0;
    try {
      panelLoadRows = Number((db.prepare("SELECT COUNT(*) AS n FROM samples WHERE sn = ? AND metric = 'panel_load' AND ts >= ? AND ts <= ?").get(PANEL, at(11), at(12)) as any).n);
    } finally { db.close(); }
    advance(at(14) - c.wall);
    resetForecastCachesForTesting();
    resetCurtailmentFreezeForTesting();
    setCurtailmentMembershipHistoryForTesting({ entries: [{ fp: CORE, atMs: 0 }] } as any);
    setWeatherCacheForTesting(weather(at(14)) as any);
    setBayesianModelForTesting(bayes(10) as any); // μ × 700 W/m² = 7 kW expected; 4 kW produced
    const r = await computeCurtailment(store.get().devices, rec, () => {}, at(14));
    return { r, panelLoadRows };
  } finally {
    rec.close();
  }
}

test('control: a live panel at ~1,800 W and 4 kW of PV — PV exceeds load, so hour 11 is not curtailment', async (t) => {
  const { r, panelLoadRows } = await scenario(t, false);
  assert.ok(panelLoadRows > 0, 'precondition: panel_load recorded');
  assert.equal(r.todayHours.find((x) => x.hour === 11), undefined);
  assert.deepEqual(r.todayHours, [], 'no hour of the window is curtailment');
});

test('★★ a held panel (no panel_load in the hour) is unknown load: the hour is not counted as curtailed', async (t) => {
  const { r, panelLoadRows } = await scenario(t, true);
  assert.equal(panelLoadRows, 0, 'precondition: the gate wrote nothing for the held panel');
  assert.equal(r.todayHours.find((x) => x.hour === 11), undefined,
    `★★ v1.188.1 before review: hour 11 counted at loadW 0, weatherVerified, ~3 kWh: ${JSON.stringify(r.todayHours)}`);
  assert.deepEqual(r.todayHours, [], 'no hour of the window is curtailment');
});

test('cleanup', () => {
  resetCurtailmentFreezeForTesting();
  setCurtailmentMembershipHistoryForTesting(undefined);
  clearWeatherTestOverride();
  resetForecastCachesForTesting();
});
