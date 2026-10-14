/**
 * v1.187.23 — the on-peak idle-pool push states the kWh the pool holds above its reserve on the
 * pool's MEASURED capacity, driven through the REAL alert monitor (startAlertMonitor): the house
 * panel's readings served by the store, the day forecast served by the analytics feed.
 *
 * Since v1.187.19 the SoC percent is a share of the measured capacity (the panel's nameplate
 * `backupFullCapWh` × poolCapacityScale), which the forecast carries as `poolFullWh`. The monitor
 * passed the nameplate to the detector, so the push said "(about 9.2 kWh above it)" for 10 points
 * of a 92.16 kWh nameplate while the forecast and the runway integrated the same 10 points on
 * ~87.0 kWh. The pure input assembly is pinned in peakIdlePool.test.ts; this pins the tick's
 * wiring — the forecast feed's capacity reaches the detector — and the nameplate fallback when
 * the feed carries none.
 *
 * v1.187.23 (review) — and the forecast's OWN basis reaches it too: a forecast whose
 * poolCapacityBasis is 'nameplate' (no Core capacity ratio ever measured) carries the nameplate as
 * its poolFullWh, and the push names it rather than presenting it as measured.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; keep the event loop alive for the test.
const keepAlive = setInterval(() => {}, 1_000);

const tmp = mkdtempSync(join(tmpdir(), 'ef-idle-pool-capacity-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '50';
process.env.ALERT_FEED_BUDGET_MS = '500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
process.env.IDLE_POOL_STATE_PATH = join(tmp, 'idle-pool-state.json');
process.env.GRID_AVAILABLE = 'true';
process.env.TARIFF_APS_RATES_CONFIRMED = 'true';
process.env.TARIFF_APS_ONPEAK_SUMMER_CENTS = '44.2';
process.env.TARIFF_APS_ONPEAK_WINTER_CENTS = '30';
process.env.TARIFF_APS_OFFPEAK_SUMMER_CENTS = '16.91';
process.env.TARIFF_APS_OFFPEAK_WINTER_CENTS = '12';
process.env.TARIFF_APS_OVERNIGHT_CENTS = '12.59';
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { resetIdlePoolState, IDLE_DWELL_MS } = await import('../src/peakGridDraw.js');
const { PoolEnergyBasisTracker } = await import('../src/poolEnergyBasis.js');

/* ── clock: real time flows from an on-peak weekday 16:00 MST, `offset` jumps it ── */
const MIN = 60_000;
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
after(() => {
  Date.now = realNow;
  clearInterval(keepAlive);
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string, logs: string[]): Promise<void> {
  const t0 = realNow();
  while (!pred()) {
    if (realNow() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}\n${logs.slice(-30).join('\n')}`);
    await sleep(10);
  }
}

/* ── the house panel: 1.3 kW from the grid on-peak, the pool idle at 26% over a 16% reserve,
 *    a 92.16 kWh nameplate. ── */
const PANEL = 'PANEXXX00XXX0001';
const NAMEPLATE_WH = 92_160;
const MEASURED_WH = NAMEPLATE_WH * 0.944;
const devices = () => ({
  [PANEL]: {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, backupFullCapWh: NAMEPLATE_WH,
      sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 },
      sources: [], pairedCircuits: [],
    },
  },
});

/** The day forecast the analytics feed serves: only what the monitor reads from it. */
const forecast = (poolFullWh: number | null, poolCapacityBasis: string | null) => ({
  generatedAt: Date.now(), hasWeather: false, historyDays: 7, reserveSoc: 16, hours: [],
  forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null,
  solarModel: { hourly: [] }, poolFullWh, poolCapacityBasis,
});

const IDLE_TITLE = 'Buying grid power on-peak while the battery pool sits idle';
const sent: Array<{ title: string; body: string; severity: string }> = [];
const notices = () => sent.filter((s) => s.severity !== 'resolved' && s.title.includes(IDLE_TITLE));

/** One on-peak afternoon: the monitor runs with `served` as the forecast feed's value until the
 *  notice is pushed; returns its body. */
async function afternoon(dayUtc: number, served: unknown): Promise<string> {
  // Each afternoon is a fresh install: no pushed record and no fired day carried from the last.
  rmSync(process.env.NOTIFY_STATE_PATH!, { force: true });
  rmSync(process.env.IDLE_POOL_STATE_PATH!, { force: true });
  resetIdlePoolState();
  offset = dayUtc - realNow();
  const before = notices().length;
  const logs: string[] = [];
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const realGet = store.get.bind(store);
  store.get = (() => ({ ...realGet(), devices: devices() })) as unknown as typeof store.get;
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? served : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string; body: string; severity: string }) => {
      sent.push({ title: msg.title, body: msg.body, severity: msg.severity });
    }) as any,
  });
  try {
    const at = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= at + 2, 5_000, 'two evaluation passes', logs);
    offset += IDLE_DWELL_MS + MIN;
    await until(() => notices().length === before + 1, 5_000, 'the idle-pool notice pushed', logs);
    return notices()[notices().length - 1].body;
  } finally {
    mon.stop();
    await sleep(100);
  }
}

test('★★★ the push states the kWh above the reserve on the forecast\'s MEASURED pool capacity', { timeout: 30_000 }, async () => {
  const body = await afternoon(Date.UTC(2026, 8, 28, 23, 0), forecast(MEASURED_WH, 'measured')); // Mon 16:00 MST
  assert.match(body, /at 26% against a 16% reserve \(about 8\.7 kWh above it\), has not discharged/,
    `10 points of the measured 87.0 kWh, not of the 92.16 kWh nameplate: ${body}`);
  assert.doesNotMatch(body, /nameplate/);
});

test('★★ no measured capacity in the feed: the nameplate figure, named as the nameplate', { timeout: 30_000 }, async () => {
  const body = await afternoon(Date.UTC(2026, 8, 29, 23, 0), forecast(null, null)); // Tue 16:00 MST
  assert.match(body, /\(about 9\.2 kWh above it on the nameplate capacity\), has not discharged/, body);
});

test('★★★ a forecast on the NAMEPLATE basis (no capacity ratio ever measured): the push names the nameplate', { timeout: 30_000 }, async () => {
  // The forecast's pool figure as analytics builds it (backupFullCapWh × capacityScale, with the
  // tracker's capacityBasis beside it), from the REAL tracker: the panel's one connected Core
  // reports packs without fullCapMah, and nothing was ever persisted — the state of a fresh
  // install, or of packs that never report capacity.
  const CORE = 'COREXXX00XXX0001';
  const now = Date.UTC(2026, 8, 30, 23, 0);
  const panel = {
    ...devices()[PANEL], lastUpdated: now,
    projection: { ...devices()[PANEL].projection, sources: [{ sn: CORE, isConnected: true, fullCap: 30_720 }] },
  };
  const core = {
    sn: CORE, deviceName: 'Core', productName: 'DELTA Pro Ultra', online: true, lastUpdated: now,
    projection: { kind: 'dpu', packCount: 1, packs: [{ fullCapMah: null, designCapMah: 300_000 }] },
  };
  const basis = new PoolEnergyBasisTracker({ path: null }).evaluate({ [PANEL]: panel, [CORE]: core } as any, panel as any, now);
  assert.equal(basis.capacityBasis, 'nameplate', 'no ratio measured: the tracker answers the nameplate');
  assert.equal(basis.capacityScale, 1);
  const served = forecast(NAMEPLATE_WH * basis.capacityScale, basis.capacityBasis);
  assert.equal(served.poolFullWh, NAMEPLATE_WH, 'the forecast\'s pool figure IS the nameplate');
  const body = await afternoon(now, served); // Wed 16:00 MST
  assert.match(body, /\(about 9\.2 kWh above it on the nameplate capacity\), has not discharged/,
    `the nameplate-basis figure is named, not presented as measured: ${body}`);
});
