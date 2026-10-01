/**
 * v1.187.1 (group G, review) — an off-panel Core's alerts do not count as annunciated while its
 * ROSTER MUTE is still warming up.
 *
 * The off-panel streak (advanceOffPanelStreaks) starts at 0 in every process and mutes a Core only
 * after OFF_PANEL_DEMOTE_TICKS ticks off a non-empty roster — and not at all while the roster has
 * not been read. So for the first ticks after each restart an off-panel Core's standing alerts
 * annunciated, the episode was marked annunciated, and its cleared row never read as roster-muted:
 * with restarts several a day, the early-eviction tier barely applied to an off-panel Core.
 * Ticks on which the Core's mute has not settled (rosterMuteUnsettledSns) no longer mark the
 * episode; ticks on which it is settled and the alert annunciates still do. Through the real alert
 * monitor (startAlertMonitor), with OFF_PANEL_DEMOTE_TICKS = 8 so each warm-up spans several
 * observable ticks. The pure rule is pinned in clearedLedgerRetention.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-1871g-warmup-'));
const CLEARED = join(tmp, 'cleared.json');
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.OFF_PANEL_DEMOTE_TICKS = '8';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = CLEARED;
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
process.env.IDLE_POOL_STATE_PATH = join(tmp, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = join(tmp, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = join(tmp, 'latch.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { startAlertMonitor, rosterMuteUnsettledSns } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string, logs: string[] = []): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}\n${logs.slice(-30).join('\n')}`);
    await sleep(10);
  }
}

const HOME = 'COREXXX00XXX0001';
const OFF = 'COREXXX00XXX0003';
const OFF2 = 'COREXXX00XXX0005';
const PANEL = 'PANEXXX00XXX0001';

function dpu(sn: string, name: string): DeviceSnapshot {
  return {
    sn, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 50, packs: [],
      pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
      pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
      batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
      sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
    },
  } as unknown as DeviceSnapshot;
}
function panel(connected: string[]): DeviceSnapshot {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 60, backupReserveSoc: 15, pairedCircuits: [], sources: connected.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })) },
  } as unknown as DeviceSnapshot;
}
const feedAlert = (id: string, core: number): Alert =>
  ({ id, severity: 'warning', category: 'Battery', device: `Core ${core}`, coreNum: core, title: `Wire ${id.split('-')[1]}`, detail: 'test', source: 'threshold' } as Alert);

test('★★ the pure rule: every Core before the roster is read; then only a Core part-way through its streak', () => {
  const devices = { [HOME]: dpu(HOME, 'Core 1'), [OFF]: dpu(OFF, 'Core 3'), [PANEL]: panel([HOME]) } as Record<string, DeviceSnapshot>;
  assert.deepEqual(rosterMuteUnsettledSns(devices, new Map(), false, 3), [HOME, OFF], 'roster not read: no Core is settled (the panel is not a Core)');
  assert.deepEqual(rosterMuteUnsettledSns(devices, new Map(), true, 3), [], 'read, nobody off it: all settled');
  assert.deepEqual(rosterMuteUnsettledSns(devices, new Map([[OFF, 1]]), true, 3), [OFF]);
  assert.deepEqual(rosterMuteUnsettledSns(devices, new Map([[OFF, 2]]), true, 3), [OFF]);
  assert.deepEqual(rosterMuteUnsettledSns(devices, new Map([[OFF, 3]]), true, 3), [], 'muted: settled');
});

test('★★★ end to end: an off-panel Core alert standing across a boot that clears muted is stamped rosterMuted; one that annunciated on a settled tick is not', { timeout: 30_000 }, async () => {
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = panel([]);              // boot: the panel's roster not read yet
  devices[HOME] = dpu(HOME, 'Core 1');
  devices[OFF] = dpu(OFF, 'Core 3');       // off the panel throughout
  devices[OFF2] = dpu(OFF2, 'Core 5');     // on the panel, then off it
  store.markFirstPollSettled();

  // a: standing from the first tick (a restart while it stood).
  let feed: Alert[] = [feedAlert(`warm-a-${OFF}`, 3)];
  const logs: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), () => {}, {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : n === 'curtailmentAlerts' ? feed : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    // b's and c's pushes fail: they annunciate, but are never pushed (a push is recorded as `pushed`,
    // which keeps a row out of the roster tier on its own — this is about the annunciated stamp).
    send: (async (_cfg: unknown, msg: { title: string }) => { if (/Wire [bc]/.test(msg.title)) throw new Error('refused (test)'); }) as any,
  });
  const onScreen = (id: string) => ((store.get().alerts ?? []) as Alert[]).find((a) => a.id === id);
  const annunciating = (id: string) => { const a = onScreen(id); return a != null && a.annunciate !== false; };
  try {
    // ── the roster is not read: nobody is muted, and a annunciates (unsettled) ──
    await until(() => annunciating(`warm-a-${OFF}`), 5_000, 'a annunciating before the roster is read', logs);
    // ── the roster is read: OFF is off it, warming up for 8 ticks; c rises on OFF2, on the roster ──
    devices[PANEL] = panel([HOME, OFF2]);
    feed = [feedAlert(`warm-a-${OFF}`, 3), feedAlert(`warm-c-${OFF2}`, 5)];
    await until(() => annunciating(`warm-c-${OFF2}`), 5_000, 'c annunciating on a settled tick', logs);
    assert.equal(annunciating(`warm-a-${OFF}`), true, 'a is still in its warm-up');
    await until(() => onScreen(`warm-a-${OFF}`)?.annunciate === false, 5_000, 'a muted by the roster', logs);
    // ── OFF2 leaves the roster; b rises on it inside its warm-up ──
    devices[PANEL] = panel([HOME]);
    feed = [feedAlert(`warm-a-${OFF}`, 3), feedAlert(`warm-c-${OFF2}`, 5), feedAlert(`warm-b-${OFF2}`, 5)];
    await until(() => annunciating(`warm-b-${OFF2}`), 5_000, 'b annunciating inside OFF2\'s warm-up', logs);
    await until(() => onScreen(`warm-b-${OFF2}`)?.annunciate === false && onScreen(`warm-c-${OFF2}`)?.annunciate === false, 5_000, 'b and c muted', logs);
    // ── everything clears ──
    feed = [];
    await until(() => {
      try { const r = JSON.parse(readFileSync(CLEARED, 'utf8')) as any[]; return r.filter((x) => String(x.alert?.id).startsWith('warm-')).length === 3; } catch { return false; }
    }, 8_000, 'three cleared rows', logs);
    const rows = JSON.parse(readFileSync(CLEARED, 'utf8')) as any[];
    const byId = (p: string) => rows.find((x) => String(x.alert.id).startsWith(p));
    assert.equal(byId('warm-a-').rosterMuted, true, 'annunciated only before the roster was read and in its warm-up: roster-muted');
    assert.equal(byId('warm-a-').pushed, false);
    assert.equal(byId('warm-b-').rosterMuted, true, 'annunciated only inside its Core\'s warm-up: roster-muted');
    assert.equal(byId('warm-b-').pushed, false);
    assert.equal(byId('warm-c-').rosterMuted, undefined, 'annunciated while its Core was on the roster: not roster-only');
    assert.equal(byId('warm-c-').pushed, false);
  } finally {
    mon.stop();
    await sleep(200);
  }
});
