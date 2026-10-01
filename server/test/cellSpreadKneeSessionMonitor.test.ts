/**
 * v1.187.1 — the knee-session file's WIRING, through the REAL alert monitor (startAlertMonitor)
 * run twice on the same state files, with a controllable clock and one Core's pack served to it.
 *
 * The pure pieces (restoreVdiffKneeSessions / persistVdiffKneeSessions and the restore rule) are
 * pinned in cellSpreadKneeSessionRestart.test.ts; this pins that the monitor writes the file where
 * the next process reads it (VDIFF_KNEE_STATE_PATH), on its own ticks, and restores it before its
 * first evaluation. A restart is the process losing its memory: the module's knee map is cleared
 * (resetVdiffWarnHoldForTesting) and a new monitor is started on the same files.
 *
 * The scenario is the one v1.187.0 left open: a 95 / 45 mV fault the BMS balances at 100%, over an
 * hour old, the add-on restarted on a 45 mV reading. Its onset is on record but older than
 * VDIFF_KNEE_GAP_CARRY_MS, so the onset seed alone started a new session at the next crossing and
 * the balancing mute held it for up to 20 more minutes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; keep the event loop alive for the test.
const keepAlive = setInterval(() => {}, 1_000);

const tmp = mkdtempSync(join(tmpdir(), 'ef-knee-session-monitor-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '50';
process.env.ALERT_FEED_BUDGET_MS = '500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
process.env.IDLE_POOL_STATE_PATH = join(tmp, 'idle-pool-state.json');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
process.env.VDIFF_KNEE_STATE_PATH = join(tmp, 'knee-sessions-under-test.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { resetVdiffWarnHoldForTesting } = await import('../src/alerts.js');
const { getAlertOnset, resetAlertOnsetCacheForTests } = await import('../src/alertOnset.js');
type Alert = import('../src/alerts.js').Alert;

/* ── clock: real time flows from 15:00 on 2026-09-29, `offset` jumps it ── */
const MIN = 60_000;
const T0 = Date.parse('2026-09-29T15:00:00-07:00');
const realNow = Date.now.bind(Date);
let offset = T0 - realNow();
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

/* ── one Core, one pack at 100%, the BMS balancing; `spreadMv` is the reading served ── */
const CORE = 'COREXXX00XXX0001';
const KEY = `${CORE}-1`;
const CRIT_ID = `vdiff-crit-${CORE}-1`;
let spreadMv = 95;
const devices = () => ({
  [CORE]: {
    sn: CORE, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 100,
      packs: [{
        num: 1, soc: 100, packSn: 'PACK-A', inputWatts: 0, outputWatts: 0, streamInputW: { w: 0, atMs: Date.now() },
        maxVolDiffMv: spreadMv, maxCellVoltageMv: 3400 + spreadMv, minCellVoltageMv: 3400, balanceState: 1, cellVoltagesMv: [],
      }],
      pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
      pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
      batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
      sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
    },
  },
});

interface Run { mon: ReturnType<typeof startAlertMonitor>; store: InstanceType<typeof SnapshotStore>; logs: string[] }
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
    send: (async () => {}) as any,
  });
  return { mon, store, logs };
}
async function passes(r: Run, n: number): Promise<void> {
  const at = r.mon.stats().evalPasses;
  await until(() => r.mon.stats().evalPasses >= at + n, 5_000, `${n} evaluation passes`, r.logs);
}
const crit = (r: Run): Alert | undefined => ((r.store.get().alerts ?? []) as Alert[]).find((a) => a.id === CRIT_ID);
const onFile = () => {
  try { return JSON.parse(readFileSync(process.env.VDIFF_KNEE_STATE_PATH!, 'utf8')).sessions?.[KEY]; } catch { return undefined; }
};

test('★★★ the monitor writes the knee session where the next process restores it: a fault over an hour old stays loud across a restart on a 45 mV reading', { timeout: 30_000 }, async () => {
  resetVdiffWarnHoldForTesting();
  // ── the first process: the session starts at the first crossing, and is on file ──
  const a = start();
  try {
    await passes(a, 2);
    assert.equal(crit(a)?.mutedBy, 'balancing', 'the first crossing: inside the session bound');
    await until(() => onFile()?.graceFromMs != null, 5_000, 'the session written to VDIFF_KNEE_STATE_PATH', a.logs);
    const sessionStart = onFile().graceFromMs as number;
    assert.ok(Math.abs(sessionStart - T0) < 5_000);
    // An hour on, still at the line: the bound has spoken.
    offset += 65 * MIN;
    await passes(a, 2);
    assert.notEqual(crit(a)?.annunciate, false, 'past the bound: loud');
    // The reading drops to 45 mV: the critical-line clock ends, the session stands.
    spreadMv = 45;
    await passes(a, 2);
    assert.equal(crit(a), undefined);
    await until(() => onFile()?.critSinceMs === null, 5_000, 'the cleared critical-line clock written', a.logs);
    assert.equal(onFile().graceFromMs, sessionStart);
  } finally {
    a.mon.stop();
    await sleep(100);
  }
  assert.ok(getAlertOnset(CRIT_ID)! < Date.now() - 60 * MIN, 'the onset on record is older than the carry: the seed alone opens a new session');

  // ── the restart, on the 45 mV reading ──
  resetVdiffWarnHoldForTesting();
  resetAlertOnsetCacheForTests();
  offset += 2 * MIN;
  const b = start();
  try {
    await passes(b, 2);
    spreadMv = 95; // the next crossing, the BMS still balancing
    await passes(b, 2);
    const back = crit(b);
    assert.equal(back?.severity, 'critical');
    assert.notEqual(back?.annunciate, false, 'the restored session bounds the balancing mute: no new grace');
    assert.match(back!.detail, /First reached the critical line at this top of charge \d+ minutes ago\./);
    assert.ok(b.logs.some((l) => /^cell spread: restored 1 knee session\(s\) from .*knee-sessions-under-test\.json$/.test(l)), b.logs.join('\n'));
  } finally {
    b.mon.stop();
    await sleep(100);
  }
});
