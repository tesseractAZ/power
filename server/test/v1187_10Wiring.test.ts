/**
 * v1.187.10 (log review, group 3) — the WIRING, through the real alert monitor (startAlertMonitor):
 *  - a full cleared ledger keeps a new INFO clear (its reserve, CLEARED_INFO_RESERVE_DIVISOR): an old
 *    warning leaves instead. At the live 1500 cap with 0 info rows, every info clear had been the row
 *    it evicted;
 *  - the rehydrate line says what a full ledger holds and what each new clear evicts
 *    (clearedLedgerCapNote), instead of "older records are being dropped";
 *  - the tick publishes its roster mute (rosterMuteReasonForSn), which the rate-floor collapse line
 *    reads to log a muted device at INFO instead of WARN;
 *  - a rate-floor episode that ends through its recovery dwell leaves a closing body that says it
 *    recovered from its onset figures, not "collapsed to 27.0, far below ~25".
 * The pure rules are pinned in clearedLedgerRetention and messageRateFloorV1187_10.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; keep the event loop alive for the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-18710-wiring-'));
const CLEARED = join(tmp, 'cleared.json');
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.OFF_PANEL_DEMOTE_TICKS = '1';
process.env.CLEARED_LOG_MAX = '50';
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

const { startAlertMonitor, rosterMuteReasonForSn } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { MUTE_REASON_OFF_PANEL } = await import('../src/alerts.js');
const { setRateFloorCollapses, resetRateFloorCollapses } = await import('../src/messageRateFloorAlert.js');

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

/** A ledger at the cap: 50 ordinary warnings, 2..51 days old, no info row (the live shape). */
function seedLedger(now: number): void {
  const DAY = 86_400_000;
  const rows: unknown[] = [];
  for (let d = 2; d <= 51; d++) {
    rows.push({
      alert: { id: `seed-old-${d}`, severity: 'warning', category: 'Battery', device: 'Core', title: `seed ${d}`, detail: 'x' },
      raisedAt: now - d * DAY - 60_000, clearedAt: now - d * DAY, durationMs: 60_000,
    });
  }
  writeFileSync(CLEARED, JSON.stringify(rows));
}

test('★★★ v1.187.10 end to end: the rehydrate line names what a full ledger evicts; an info clear at the cap is kept and an old warning leaves; the roster mute is published', { timeout: 30_000 }, async () => {
  seedLedger(Date.now());
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = panel([HOME]); // OFF is off the panel roster
  devices[HOME] = dpu(HOME, 'Core 1');
  devices[OFF] = dpu(OFF, 'Core 3');
  store.markFirstPollSettled();

  let feed: Alert[] = [];
  const logs: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), () => {}, {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : n === 'curtailmentAlerts' ? feed : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async () => {}) as any,
  });
  const onScreen = (id: string) => ((store.get().alerts ?? []) as Alert[]).find((a) => a.id === id);
  const passes = async (n: number) => { const at = mon.stats().evalPasses; await until(() => mon.stats().evalPasses >= at + n, 5_000, `${n} passes`, logs); };
  try {
    // ── the rehydrate line ──
    const boot = logs.find((l) => l.startsWith('alerts: rehydrated 50 cleared-alert record(s)'));
    assert.ok(boot, logs.slice(0, 20).join('\n'));
    assert.ok(boot!.endsWith(' [AT CAP 50 — 50 warning (oldest 51d), 0 critical, 0 info; each new clear evicts one row: info beyond the newest 3 first, then old roster-muted and noise warnings not recorded as pushed, then the oldest warning; criticals last]'), boot);
    assert.ok(!boot!.includes('older records are being dropped'));

    // ── the roster mute is published by the tick ──
    await passes(2);
    assert.equal(rosterMuteReasonForSn(OFF), MUTE_REASON_OFF_PANEL, 'off the panel roster: muted, with its reason');
    assert.equal(rosterMuteReasonForSn(HOME), null, 'on the roster: not muted');

    // ── an info alert raises and clears at the cap ──
    feed = [{ id: `curtail-info-${HOME}`, severity: 'info', category: 'Solar', device: 'Core 1', title: 'Info notice', detail: 'test', source: 'threshold' } as Alert];
    await until(() => onScreen(`curtail-info-${HOME}`) != null, 5_000, 'the info alert', logs);
    await passes(1);
    feed = [];
    await until(() => {
      try { return (JSON.parse(readFileSync(CLEARED, 'utf8')) as any[]).some((x) => String(x.alert?.id).startsWith('curtail-info-')); } catch { return false; }
    }, 8_000, 'the info row persisted', logs);
    const rows = JSON.parse(readFileSync(CLEARED, 'utf8')) as any[];
    assert.equal(rows.length, 50, 'still at the cap');
    assert.ok(rows.some((x) => String(x.alert.id).startsWith('curtail-info-')), '★ the info clear is kept (its reserve)');
    assert.equal(rows.some((x) => x.alert.id === 'seed-old-51'), false, 'the oldest warning left instead');

    // ── a rate-floor episode that ends through its recovery dwell: the closing body says so ──
    setRateFloorCollapses([{ sn: HOME, deviceName: 'Core 1', rate: 4, baseline: 20, onset: { rate: 4, baseline: 20 }, recovering: false }]);
    await until(() => onScreen(`msg-rate-floor-${HOME}`) != null, 5_000, 'the rate-floor card', logs);
    assert.match(onScreen(`msg-rate-floor-${HOME}`)!.detail, /collapsed to 4\.0 msg\/min, far below its learned ~20/);
    setRateFloorCollapses([{ sn: HOME, deviceName: 'Core 1', rate: 27, baseline: 25, onset: { rate: 4, baseline: 20 }, recovering: true }]);
    await until(() => /recovering/.test(onScreen(`msg-rate-floor-${HOME}`)?.detail ?? ''), 5_000, 'the recovering card', logs);
    setRateFloorCollapses([]);
    await until(() => {
      try { return (JSON.parse(readFileSync(CLEARED, 'utf8')) as any[]).some((x) => x.alert?.id === `msg-rate-floor-${HOME}`); } catch { return false; }
    }, 8_000, 'the rate-floor row persisted', logs);
    const rf = (JSON.parse(readFileSync(CLEARED, 'utf8')) as any[]).find((x) => x.alert?.id === `msg-rate-floor-${HOME}`);
    assert.match(rf.alert.detail, /collapsed to 4\.0 msg\/min, far below its learned ~20/, 'the opening body: the onset');
    assert.ok(rf.closedAs, 'a closing body is recorded');
    assert.doesNotMatch(rf.closedAs.detail, /far below/, `★ no "collapsed to 27, far below ~25": ${rf.closedAs.detail}`);
    assert.match(rf.closedAs.detail, /fell to 4\.0 msg\/min against its learned ~20 msg\/min baseline/);
    assert.match(rf.closedAs.detail, /now 27\.0 msg\/min, back above the collapse floor/);
  } finally {
    resetRateFloorCollapses();
    mon.stop();
    await sleep(200);
  }
});
