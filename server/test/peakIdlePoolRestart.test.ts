/**
 * v1.187.0 (log review, verifier round) — the on-peak idle-pool notice's once-per-day promise
 * across a restart, driven through the REAL alert monitor (startAlertMonitor) twice on the same
 * state files, with the house panel's readings served to it and a controllable clock.
 *
 * The pure pieces (loadIdlePoolFiredDay / restoreIdlePoolFiredDay / persistIdlePoolFiredDay and
 * the orphan sweep's drop) are pinned in peakIdlePool.test.ts; this pins the monitor's wiring:
 * the fired day is written where the next process reads it, and restored before its first
 * evaluation. A restart is simulated as the process loses it — the module's episode state is
 * reset (resetIdlePoolState) and a new monitor is started on the same IDLE_POOL_STATE_PATH and
 * NOTIFY_STATE_PATH.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; keep the event loop alive for the test.
const keepAlive = setInterval(() => {}, 1_000);

const tmp = mkdtempSync(join(tmpdir(), 'ef-idle-pool-restart-'));
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

const { startAlertMonitor, LEARNED_RESOLVE_GRACE_MS } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { resetIdlePoolState, IDLE_DWELL_MS, PEAK_IDLE_POOL_ALERT_ID } = await import('../src/peakGridDraw.js');

/* ── clock: real time flows from Mon 2026-09-28 16:00 MST (on-peak), `offset` jumps it ── */
const MIN = 60_000;
const MON_1600 = Date.UTC(2026, 8, 28, 23, 0); // 16:00 Phoenix (UTC-7)
const realNow = Date.now.bind(Date);
let offset = MON_1600 - realNow();
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

/* ── the house panel, as the store serves it: 09-28's reading — 1.3 kW from the grid on-peak,
 *    the pool idle at 26% over a 16% reserve. `buying` false: the house is not importing. ── */
const PANEL = 'PANEXXX00XXX0001';
let buying = true;
const devices = () => ({
  [PANEL]: {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'shp2', gridWatt: buying ? 1301 : 0, backupBatPercent: 26, backupFullCapWh: 92_160,
      sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 },
      sources: [], pairedCircuits: [],
    },
  },
});

interface Run { mon: ReturnType<typeof startAlertMonitor>; logs: string[] }
const sent: Array<{ title: string; severity: string }> = [];
function start(): Run {
  const logs: string[] = [];
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const realGet = store.get.bind(store);
  store.get = (() => ({ ...realGet(), devices: devices() })) as unknown as typeof store.get;
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string; severity: string }) => { sent.push({ title: msg.title, severity: msg.severity }); }) as any,
  });
  return { mon, logs };
}
const IDLE_TITLE = 'Buying grid power on-peak while the battery pool sits idle';
const notices = () => sent.filter((s) => s.severity !== 'resolved' && s.title.includes(IDLE_TITLE));
const resolves = () => sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:') && s.title.includes(IDLE_TITLE));
async function passes(r: Run, n: number): Promise<void> {
  const at = r.mon.stats().evalPasses;
  await until(() => r.mon.stats().evalPasses >= at + n, 5_000, `${n} evaluation passes`, r.logs);
}

test('★★★ a restart inside the on-peak afternoon: the fired day is restored from disk — no second notice, and no "Resolved:" at the boot sweep', { timeout: 30_000 }, async () => {
  resetIdlePoolState();
  // ── the first process: the notice rises after its dwell and is pushed once ──
  const a = start();
  try {
    await passes(a, 2); // the condition is seen: the dwell starts
    offset += IDLE_DWELL_MS + MIN;
    await until(() => notices().length === 1, 5_000, 'the idle-pool notice pushed', a.logs);
    assert.ok(a.mon.activeAlertIds().includes(PEAK_IDLE_POOL_ALERT_ID));
    await until(() => {
      try { return JSON.parse(readFileSync(process.env.IDLE_POOL_STATE_PATH!, 'utf8')).firedDay === '2026-09-28'; } catch { return false; }
    }, 5_000, 'the fired day written to IDLE_POOL_STATE_PATH', a.logs);
    await passes(a, 2);
  } finally {
    a.mon.stop();
    await sleep(100);
  }
  assert.ok(JSON.parse(readFileSync(process.env.NOTIFY_STATE_PATH!, 'utf8'))[PEAK_IDLE_POOL_ALERT_ID], 'its push is on record');

  // ── the restart: the episode is lost with the process; the house is still buying ──
  resetIdlePoolState();
  offset += 2 * MIN;
  const b = start();
  try {
    await passes(b, 2);
    // Past the orphan sweep's grace: the pushed record is dropped, never resolved.
    offset += LEARNED_RESOLVE_GRACE_MS + MIN;
    await until(() => b.logs.some((l) => l.includes('notify: boot reconcile')), 5_000, 'the boot sweep', b.logs);
    const reconcile = b.logs.find((l) => l.includes('notify: boot reconcile'))!;
    assert.match(reconcile, /resolved 0, dropped 1/);
    // Well past a second dwell, the house still buying on-peak the same afternoon.
    for (let i = 0; i < 3; i++) { offset += IDLE_DWELL_MS; await passes(b, 2); }
    assert.equal(notices().length, 1, 'once per on-peak day, across the restart');
    assert.equal(resolves().length, 0, 'no "Resolved:" while the house may still be buying on-peak');
    assert.ok(!b.mon.activeAlertIds().includes(PEAK_IDLE_POOL_ALERT_ID), 'suppressed as fired today');
  } finally {
    b.mon.stop();
    await sleep(100);
  }
});

test('★★ …the next weekday it rises again (the restored day is only today\'s)', { timeout: 30_000 }, async () => {
  resetIdlePoolState();
  offset = Date.UTC(2026, 8, 29, 23, 0) - realNow(); // Tue 16:00 MST
  const before = notices().length;
  const c = start();
  try {
    await passes(c, 2);
    offset += IDLE_DWELL_MS + MIN;
    await until(() => notices().length === before + 1, 5_000, 'the next day\'s notice', c.logs);
    await until(() => {
      try { return JSON.parse(readFileSync(process.env.IDLE_POOL_STATE_PATH!, 'utf8')).firedDay === '2026-09-29'; } catch { return false; }
    }, 5_000, 'the new day written', c.logs);
  } finally {
    c.mon.stop();
    await sleep(100);
  }
});
