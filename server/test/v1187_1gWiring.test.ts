/**
 * v1.187.1 (group G) — the WIRING, through the real alert monitor (startAlertMonitor):
 *  - the cleared ledger's retention facts (general-2): each cleared row records whether its push
 *    went out and whether it was on screen only by the roster (never annunciated on any tick, its
 *    Core off the panel roster); a full ledger drops an old roster-muted row first;
 *  - the defective-pack retirement line reaches the monitor's warn sink (general-3);
 *  - the offline alert of a device with no data this session is described from its first listing,
 *    which the monitor reads from the store (general-5).
 * The pure rules are pinned in clearedLedgerRetention, defectivePackRetireLog and
 * offlineNoDataWording.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-1871g-wiring-'));
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

const { startAlertMonitor, CLEARED_ROSTER_MUTED_KEEP_MS } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { confirmDefectivePack, markPackPresent, retireAbsentPacks, DEFECTIVE_PACK_ABSENT_RETIRE_MS } = await import('../src/defectivePackLatch.js');

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
const WAVE = 'WAVEXXX00XXX0001';
const PACK = 'PACKXXX00XXX0037';

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
const feedAlert = (id: string, severity: Alert['severity'], core: number): Alert =>
  ({ id, severity, category: 'Battery', device: `Core ${core}`, coreNum: core, title: `Wire ${id.split('-')[1]}`, detail: 'test', source: 'threshold' } as Alert);

/** A pre-v1.187.1-shaped ledger at the cap: 48 ordinary warnings (2-49 days old) and one roster-muted
 *  row 40 days old, plus one recent roster-muted row (5 days) that must be kept. */
function seedLedger(now: number): void {
  const DAY = 86_400_000;
  const rows: unknown[] = [];
  const mk = (id: string, ageDays: number, extra: Record<string, unknown> = {}) => ({
    alert: { id, severity: 'warning', category: 'Battery', device: 'Core', title: id, detail: 'x' },
    raisedAt: now - ageDays * DAY - 60_000, clearedAt: now - ageDays * DAY, durationMs: 60_000, ...extra,
  });
  rows.push(mk(`seed-recent-${OFF}`, 5, { rosterMuted: true, pushed: false }));
  for (let d = 2; d <= 49; d++) rows.push(mk(`seed-old-${d}`, d));
  rows.push(mk(`seed-roster-${OFF}`, 40, { rosterMuted: true, pushed: false }));
  rows.sort((a: any, b: any) => b.clearedAt - a.clearedAt);
  writeFileSync(CLEARED, JSON.stringify(rows));
}

test('★★★ end to end: cleared rows carry pushed / rosterMuted, a full ledger drops the old roster-muted row first, the retirement line reaches warn, and a no-data device is described from its first listing', { timeout: 30_000 }, async () => {
  assert.equal(CLEARED_ROSTER_MUTED_KEEP_MS, 30 * 86_400_000);
  seedLedger(Date.now());
  const store = new SnapshotStore();
  // A peripheral listed offline at first sight, with no data this session.
  store.setDeviceList([{ sn: WAVE, deviceName: 'WAVE 2', productName: 'WAVE 2', online: 0 } as never]);
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = panel([HOME, OFF2]);   // phase 1: OFF2 on the roster, OFF off it
  devices[HOME] = dpu(HOME, 'Core 1');
  devices[OFF] = dpu(OFF, 'Core 3');
  devices[OFF2] = dpu(OFF2, 'Core 5');
  store.markFirstPollSettled();

  let feed: Alert[] = []; // raised after the first evaluation, which seeds standing alerts unpushed
  const logs: string[] = [];
  const warns: string[] = [];
  const sent: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => warns.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : n === 'curtailmentAlerts' ? feed : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    // c's push fails: it annunciates on screen and in the condition, but is never pushed.
    send: (async (_cfg: unknown, msg: { title: string }) => {
      if (msg.title.includes('Wire c')) throw new Error('refused (test)');
      sent.push(msg.title);
    }) as any,
  });
  const onScreen = (id: string) => ((store.get().alerts ?? []) as Alert[]).find((a) => a.id === id);
  const passes = async (n: number) => { const at = mon.stats().evalPasses; await until(() => mon.stats().evalPasses >= at + n, 5_000, `${n} passes`, logs); };
  try {
    // ── the offline peripheral: described from its first listing, not as a measured gap ──
    await until(() => onScreen(`offline-${WAVE}`) != null, 5_000, 'the offline alert', logs);
    const off = onScreen(`offline-${WAVE}`)!;
    assert.match(off.detail, /It has not reported since the add-on started\. EcoFlow Cloud has listed it offline since the add-on's first device list \(\d+s ago\);/, off.detail);
    assert.doesNotMatch(off.detail, /30 minutes/);

    // ── phase 1: b pushes; c annunciates; a is muted (off the roster) ──
    await passes(2);
    feed = [
      feedAlert(`ledger-a-${OFF}`, 'warning', 3),   // off the roster throughout: on screen only
      feedAlert(`ledger-b-${HOME}`, 'warning', 1),  // a home Core: pushed
      feedAlert(`ledger-c-${OFF2}`, 'warning', 5),  // annunciating while on the roster, muted later; its push fails
    ];
    await until(() => logs.some((l) => l.startsWith('notify: sent') && l.includes(`ledger-b`)) || sent.length > 0, 5_000, 'the home push', logs);
    await passes(2);
    assert.equal(onScreen(`ledger-a-${OFF}`)?.annunciate, false);
    assert.equal(onScreen(`ledger-c-${OFF2}`)?.annunciate, undefined, 'on the roster: annunciating');
    // ── phase 2: OFF2 leaves the roster; c is muted from the next tick ──
    devices[PANEL] = panel([HOME]);
    await until(() => onScreen(`ledger-c-${OFF2}`)?.annunciate === false, 5_000, 'c muted by the roster', logs);
    await passes(2);
    // ── phase 3: everything clears ──
    feed = [];
    await until(() => {
      try { const r = JSON.parse(readFileSync(CLEARED, 'utf8')) as any[]; return r.filter((x) => String(x.alert?.id).startsWith('ledger-')).length === 3; } catch { return false; }
    }, 8_000, 'three cleared rows', logs);
    const rows = JSON.parse(readFileSync(CLEARED, 'utf8')) as any[];
    const byId = (p: string) => rows.find((x) => String(x.alert.id).startsWith(p));
    assert.equal(byId('ledger-a-').rosterMuted, true, 'never annunciated, off the roster: on screen only by the roster');
    assert.equal(byId('ledger-a-').pushed, false);
    assert.equal(byId('ledger-b-').pushed, true, 'its push went out');
    assert.equal(byId('ledger-b-').rosterMuted, undefined);
    assert.equal(byId('ledger-c-').pushed, false);
    assert.equal(byId('ledger-c-').rosterMuted, undefined, 'it annunciated on some tick: not roster-only');
    // ── the ledger was at its cap: three clears, three evictions — the old roster row went first ──
    assert.equal(rows.length, 50);
    assert.equal(rows.some((x) => x.alert.id === `seed-roster-${OFF}`), false, 'the 40-day-old roster-muted row left first');
    assert.equal(rows.some((x) => x.alert.id === `seed-recent-${OFF}`), true, 'a 5-day-old one stays');
    // Then the oldest ordinary rows, oldest first (other clears of the tick may take a few more).
    const gone = [];
    for (let d = 2; d <= 49; d++) if (!rows.some((x) => x.alert.id === `seed-old-${d}`)) gone.push(d);
    assert.ok(gone.length >= 2, `${gone}`);
    assert.deepEqual(gone, Array.from({ length: gone.length }, (_, i) => 49 - gone.length + 1 + i), `the oldest, contiguous: ${gone}`);

    // ── the defective-pack retirement goes to the monitor's warn sink ──
    const now = Date.now();
    confirmDefectivePack({ packSn: PACK, deviceSn: HOME, deviceName: 'Core 1', packNum: 2, socPct: 1, siblingMedianSocPct: 80, packAbsW: 0, siblingMedianAbsW: 300, deviantCell: 9, deltaMv: -90 }, now);
    markPackPresent(PACK, now, HOME);
    retireAbsentPacks({ nowMs: now + DEFECTIVE_PACK_ABSENT_RETIRE_MS + 60_000, evaluableDeviceSns: new Set([HOME]) });
    const retired = warns.filter((l) => l.includes(`RETIRING the confirmed-defective record for pack ${PACK}`));
    assert.equal(retired.length, 1, warns.join('\n'));
    assert.equal(logs.some((l) => l.includes('RETIRING')), false, 'at warn level, not info');
    assert.ok(existsSync(CLEARED));
  } finally {
    mon.stop();
    await sleep(200);
  }
});
