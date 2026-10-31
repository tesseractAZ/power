/**
 * v1.197.0 — the maintenance window through the REAL alert monitor (startAlertMonitor): the stamp sits
 * on the one chokepoint that feeds both the push gate and the broadcast (store.get().alerts), and the
 * monitor steps the windows after every publish.
 *
 * The shape of 2026-08-20: a Core being worked on flaps offline and raises its own criticals for the
 * whole job. Shelved, none of it is pushed or counted by the broadcast while it stays on screen; a pool
 * critical in the same minutes is pushed on its tick; and whatever is still active when the window ends
 * is pushed then — once.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { NotifyMessage } from '../src/notify.js';

const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-maint-wiring-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
process.env.IDLE_POOL_STATE_PATH = join(tmp, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = join(tmp, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = join(tmp, 'latch.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { makeRecorderStub } = await import('./helpers/recorderStub.js');
const { startAlertMonitor, bootSeedNotified } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { conditionFromAlerts, allClearSpeechBlocked } = await import('../src/broadcast.js');
const { createMaintenanceController, MAINT_MAX_MS, MAINTENANCE_SHELVABLE_PREFIXES } = await import('../src/maintenanceWindow.js');
const { MUTE_REASON_MAINTENANCE } = await import('../src/alerts.js');

const PANEL = 'PANEXXX00XXX0001';
const HOME = 'COREXXX00XXX0001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string, logs: string[] = []): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}\n${logs.slice(-20).join('\n')}`);
    await sleep(10);
  }
}

/** A store with the panel, a home Core and the Core under test (`sn`, "Core n"), a monitor, and a
 *  controller whose clock runs `offsetMs` from the real one. Each case uses its own Core serial and
 *  its own notify-state file, so no case's push record suppresses another's. v1.197.0 (review) —
 *  `opts.windowsOnDisk`: the windows file a previous process left (written before the controller
 *  loads it); `opts.injected`: the feed's alerts from the first tick; `opts.returnDwellMs`. */
function harness(sn: string, n: number, opts: { windowsOnDisk?: unknown[]; injected?: Alert[]; returnDwellMs?: number } = {}) {
  process.env.NOTIFY_STATE_PATH = join(tmp, `notify-state-${n}.json`);
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 60, backupReserveSoc: 15, pairedCircuits: [], sources: [{ slot: 1, sn: HOME, isConnected: true }, { slot: 3, sn, isConnected: true }] },
  } as unknown as DeviceSnapshot;
  for (const [s, name] of [[HOME, 'Core 1'], [sn, `Core ${n}`]] as const) {
    devices[s] = { sn: s, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now() } as DeviceSnapshot;
  }
  store.markFirstPollSettled();
  const sent: string[] = [];
  const logs: string[] = [];
  let injected: Alert[] = opts.injected ?? [];
  let offsetMs = 0;
  const maintSent: NotifyMessage[] = [];
  const path = join(mkdtempSync(join(tmp, 'mw-')), 'maintenance-windows.json');
  if (opts.windowsOnDisk) writeFileSync(path, JSON.stringify({ version: 1, windows: opts.windowsOnDisk }));
  const maint = createMaintenanceController({
    path,
    now: () => Date.now() + offsetMs,
    ...(opts.returnDwellMs != null ? { returnDwellMs: opts.returnDwellMs } : {}),
    send: async (m) => { maintSent.push(m); },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    audit: () => {},
    fmtClock: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  const monitor = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (r: string) => (r === 'forecast' ? null : []) } as any,
    // A fresh copy every tick: the monitor stamps the objects it is handed.
    stormPrep: async () => injected.map((a) => ({ ...a })),
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string }) => { sent.push(msg.title); }) as any,
    maintenance: maint,
  });
  const passes = async (k: number) => { const at = monitor.stats().evalPasses; await until(() => monitor.stats().evalPasses >= at + k, 5_000, `${k} passes`, logs); };
  const onScreen = () => (store.get().alerts ?? []) as Alert[];
  const start = (minutes: number) => maint.start({
    sn, minutes, source: 'api', devices: store.get().devices, homePoolSns: new Set([HOME, sn]), alerts: onScreen(),
  });
  return {
    store, devices, monitor, maint, sent, maintSent, logs, passes, onScreen, start,
    setInjected: (a: Alert[]) => { injected = a; },
    setOffset: (ms: number) => { offsetMs = ms; },
    stop: async () => { monitor.stop(); await sleep(200); },
  };
}

const dpuErr = (sn: string, n: number): Alert => ({ id: `dpu-err-${sn}`, severity: 'critical', category: 'Battery', device: `Core ${n}`, title: 'Inverter error code', detail: 'code 1', fault: 'err1' });
const vdiffCrit = (sn: string, n: number): Alert => ({ id: `vdiff-crit-${sn}-1`, severity: 'critical', category: 'Battery', device: `Core ${n}`, title: 'Cell imbalance', detail: '95 mV' });
const below: Alert = { id: 'shp2-below-reserve', severity: 'critical', category: 'SHP2', device: 'Smart Home Panel 2', title: 'Backup pool at reserve', detail: 'x' };
/** The panel's own alert for the Core's slot, carrying the Core's serial: only the family allowlist keeps it loud. */
const srcErr = (sn: string): Alert => ({ id: 'shp2-src-err-3', severity: 'warning', category: 'SHP2', device: 'Smart Home Panel 2', title: 'Energy source error', detail: 'x', sourceSn: sn });
/** A Core warning outside the settle families (no 5-minute push dwell): pushed on its first eligible tick. */
const sohWarn = (sn: string, n: number): Alert => ({ id: `soh-warn-${sn}-2`, severity: 'warning', category: 'Battery', device: `Core ${n}`, title: 'Pack health low', detail: 'x' });
/** A window record as a previous process saved it. */
const onDisk = (sn: string, n: number, startedAtMs: number, untilMs: number, over: Record<string, unknown> = {}) => ({
  sn, label: `Core ${n}`, coreNum: n, startedAtMs, untilMs, source: 'web', note: null, standingAtStart: [], abnormalSeenAtMs: null,
  normalSinceMs: null, held: [], heldDropped: 0, settingsChanged: [], homeAtStart: true, gapSeenAtMs: null, ...over,
});

test('★★★ shelved: 12 ticks of flapping on the Core push nothing and count nothing; a pool critical pushes on its tick; ended by hand → exactly one critical push', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0003';
  const h = harness(SN, 3);
  try {
    await h.passes(2);
    const r = h.start(120);
    assert.ok(r.ok, JSON.stringify(r));
    let offlineHeldSeen = false;
    for (let i = 0; i < 12; i++) {
      h.setInjected([...(i % 2 === 0 ? [dpuErr(SN, 3)] : []), ...(i % 3 === 0 ? [vdiffCrit(SN, 3)] : [])]);
      h.devices[SN].online = i % 4 >= 2; // offline on two ticks of every four
      await h.passes(2);
      const mine = h.onScreen().filter((a) => a.id.includes(SN) && MAINTENANCE_SHELVABLE_PREFIXES.some((p) => a.id.startsWith(p)));
      for (const a of mine) {
        assert.equal(a.annunciate, false, `tick ${i}: ${a.id} held`);
        assert.equal(a.muteReason, MUTE_REASON_MAINTENANCE);
        assert.ok(a.shelvedUntilMs != null);
      }
      // v1.197.0 (review) — the offline card itself, seen held at least once (not merely "online now").
      if (mine.some((a) => a.id === `offline-${SN}` && a.annunciate === false && a.shelvedUntilMs != null)) offlineHeldSeen = true;
      assert.notEqual(conditionFromAlerts(h.onScreen()).level, 'red', `tick ${i}: no klaxon for the shelved Core`);
      if (mine.some((a) => a.severity === 'critical')) assert.equal(allClearSpeechBlocked(h.onScreen()), true, `tick ${i}: held, not cleared`);
    }
    assert.ok(offlineHeldSeen, '★ the offline card was on screen, held, during the flapping');
    assert.deepEqual(h.sent.filter((t) => /Inverter error code|Device offline|Cell imbalance/.test(t)), [], '★★★ nothing of the Core was pushed');
    // A pool critical in the same window: pushed on its tick.
    h.setInjected([dpuErr(SN, 3), below, srcErr(SN)]);
    h.devices[SN].online = true;
    await until(() => h.sent.some((t) => t.includes('Backup pool at reserve')), 5_000, '★ the pool critical is pushed', h.logs);
    assert.equal(conditionFromAlerts(h.onScreen().filter((a) => a.id.includes(SN))).level, 'green', 'the Core\'s own critical is not counted');
    // The panel's own alerts for the shelved Core's slot are the panel's: never held, though this one
    // carries the Core's serial (sourceSn) — the family allowlist keeps it loud.
    const link = h.onScreen().find((a) => a.id === 'shp2-src-err-3');
    assert.ok(link, 'the panel\'s slot-3 alert is on screen');
    assert.equal(link.sourceSn, SN);
    assert.equal(link.annunciate, undefined, '★ the panel\'s slot-3 alert stays loud');
    assert.equal(link.shelvedUntilMs, undefined);
    // Ended by hand with the Core's critical still standing.
    h.setInjected([dpuErr(SN, 3)]);
    await h.passes(2);
    assert.equal(h.maint.end(SN, 'web', h.onScreen()), true);
    await until(() => h.sent.some((t) => t.includes('Inverter error code')), 5_000, '★ the still-active critical is pushed once the window ends', h.logs);
    await h.passes(5);
    assert.equal(h.sent.filter((t) => t.includes('Inverter error code')).length, 1, '★ exactly once');
    assert.equal(h.onScreen().find((a) => a.id === `dpu-err-${SN}`)?.annunciate, undefined, 'annunciating again');
    assert.equal(conditionFromAlerts(h.onScreen()).level, 'red', 'and counted by the broadcast');
    const end = h.maintSent.at(-1)!;
    assert.equal(end.title, 'Power · Maintenance over: Core 3 alarms are live again (1 still active)');
    assert.match(end.body, /Held: \d+ alerts \(\d+ critical\):/);
    assert.match(end.body, /- Inverter error code \(critical/);
  } finally {
    await h.stop();
  }
});

test('★★★ expiry: the window runs out with the Core\'s critical still standing → one critical push and the end push', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0005';
  const h = harness(SN, 5);
  try {
    await h.passes(1);
    // Opened 4 h minus 4 s ago for 4 h: it runs out 4 s from now.
    h.setOffset(-(MAINT_MAX_MS - 4_000));
    const r = h.start(240);
    assert.ok(r.ok, JSON.stringify(r));
    h.setOffset(0);
    h.setInjected([dpuErr(SN, 5)]);
    await h.passes(2);
    if (h.maint.active(Date.now()).length === 1) {
      assert.equal(h.onScreen().find((a) => a.id === `dpu-err-${SN}`)?.annunciate, false, 'held while the window runs');
      assert.equal(h.sent.some((t) => t.includes('Inverter error code')), false, 'not pushed while held');
    }
    await until(() => h.maintSent.some((m) => m.title.startsWith('Power · Maintenance over')), 15_000, '★ the window ends on its own', h.logs);
    await until(() => h.sent.some((t) => t.includes('Inverter error code')), 5_000, '★ the still-active critical is pushed', h.logs);
    await h.passes(5);
    assert.equal(h.sent.filter((t) => t.includes('Inverter error code')).length, 1, 'exactly once');
    const end = h.maintSent.find((m) => m.title.startsWith('Power · Maintenance over'))!;
    assert.match(end.body, /ended: its time is up/);
    assert.equal(end.severity, 'warning');
  } finally {
    await h.stop();
  }
});

test('★★ control: the same flapping with no window pushes the Core\'s critical and its offline warning', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0002';
  const h = harness(SN, 2);
  try {
    await h.passes(2);
    for (let i = 0; i < 6; i++) {
      h.setInjected(i % 2 === 0 ? [dpuErr(SN, 2)] : []);
      h.devices[SN].online = i % 4 >= 2;
      await h.passes(2);
    }
    assert.ok(h.sent.some((t) => t.includes('Inverter error code')), `the critical is pushed: ${h.sent.join(' | ')}`);
    assert.ok(h.sent.some((t) => t.includes('Device offline')), `the offline warning is pushed: ${h.sent.join(' | ')}`);
    assert.ok(h.onScreen().every((a) => a.shelvedUntilMs == null), 'nothing carries the shelved mark');
  } finally {
    await h.stop();
  }
});

/* ══ v1.197.0 (review) ═══════════════════════════════════════════════════════════════════════ */

test('★★★ a restart mid-window: a warning the window held from the first tick is pushed when the window ends', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0006';
  const now = Date.now();
  // Opened 30 min before this process started, for 2 h; the warning stands from the first tick.
  const h = harness(SN, 6, { windowsOnDisk: [onDisk(SN, 6, now - 30 * 60_000, now + 90 * 60_000)], injected: [sohWarn(SN, 6)] });
  try {
    await h.passes(3);
    const a = h.onScreen().find((x) => x.id === `soh-warn-${SN}-2`);
    assert.ok(a, 'on screen from the first tick');
    assert.equal(a.annunciate, false, 'held while the window runs');
    assert.equal(h.sent.some((t) => t.includes('Pack health low')), false, 'not pushed while held');
    assert.equal(h.maint.end(SN, 'web', h.onScreen()), true);
    await until(() => h.sent.some((t) => t.includes('Pack health low')), 5_000, '★ the held warning is pushed once the window ends', h.logs);
    await h.passes(3);
    assert.equal(h.sent.filter((t) => t.includes('Pack health low')).length, 1, 'once');
    assert.match(h.maintSent.at(-1)!.body, /Still active, and pushed and announced from now on:\n- Pack health low \(warning\)/);
  } finally {
    await h.stop();
  }
});

test('★★★ a window that expired while the add-on was down: its end push lists what is still active, and that is pushed', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0007';
  const now = Date.now();
  const h = harness(SN, 7, { windowsOnDisk: [onDisk(SN, 7, now - 150 * 60_000, now - 30 * 60_000)], injected: [sohWarn(SN, 7)] });
  try {
    await until(() => h.maintSent.some((m) => m.title.startsWith('Power · Maintenance over')), 5_000, 'the owed end push', h.logs);
    const end = h.maintSent.find((m) => m.title.startsWith('Power · Maintenance over'))!;
    assert.equal(end.title, 'Power · Maintenance over: Core 7 alarms are live again (1 still active)');
    assert.match(end.body, /ended: its time is up/);
    assert.match(end.body, /Still active, and pushed and announced from now on:\n- Pack health low \(warning\)/, '★ known, not "unknown"');
    await until(() => h.sent.some((t) => t.includes('Pack health low')), 5_000, '★ and the warning is pushed', h.logs);
    await h.passes(3);
    assert.equal(h.maintSent.filter((m) => m.title.startsWith('Power · Maintenance over')).length, 1, 'the end push once');
  } finally {
    await h.stop();
  }
});

test('★★★ back to normal through the real monitor: abnormal (offline), then reporting again for the dwell → ended early', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0008';
  const h = harness(SN, 8, { returnDwellMs: 400 });
  try {
    await h.passes(2);
    assert.ok(h.start(120).ok);
    // Never abnormal: the dwell never runs out, however long it stays normal.
    await h.passes(6);
    assert.equal(h.maint.active(Date.now()).length, 1, 'a healthy Core is not released mid-job');
    // Powered down for a few ticks, then back and reporting.
    h.devices[SN].online = false;
    await h.passes(3);
    assert.equal(h.maint.active(Date.now()).length, 1);
    h.devices[SN].online = true;
    h.devices[SN].lastUpdated = Date.now();
    await until(() => h.maintSent.some((m) => m.title.startsWith('Power · Maintenance over')), 10_000, '★ ended once back to normal for the dwell', h.logs);
    const end = h.maintSent.find((m) => m.title.startsWith('Power · Maintenance over'))!;
    assert.match(end.body, /ended: the Core has been back to normal/);
    assert.equal(h.maint.windows()[0].endReason, 'returned-to-normal');
  } finally {
    await h.stop();
  }
});

test('★★★ a forged window naming the panel holds nothing in the real monitor: the panel\'s offline alert stays loud', { timeout: 60_000 }, async () => {
  const SN = 'COREXXX00XXX0009';
  const now = Date.now();
  const h = harness(SN, 9, { windowsOnDisk: [onDisk(PANEL, 2, now - 10 * 60_000, now + 60 * 60_000, { label: 'Smart Home Panel 2' })] });
  try {
    assert.equal(h.maint.windows().length, 1, 'the record loads (the stamp, not the loader, keeps it inert)');
    h.devices[PANEL].online = false;
    await until(() => h.onScreen().some((a) => a.id === `offline-${PANEL}`), 5_000, 'the panel\'s offline alert', h.logs);
    await h.passes(2);
    const a = h.onScreen().find((x) => x.id === `offline-${PANEL}`)!;
    assert.notEqual(a.annunciate, false, '★ not held by a window on a panel');
    assert.equal(a.shelvedUntilMs, undefined);
  } finally {
    await h.stop();
  }
});

test('★★ bootSeedNotified: a held warning is seeded only on a delivery record', () => {
  const w = { id: `soh-warn-${HOME}-2`, severity: 'warning' as const };
  assert.equal(bootSeedNotified({ alert: w, firstRun: true, alreadyNotified: false }), true, 'a standing warning: seeded, as before');
  assert.equal(bootSeedNotified({ alert: w, firstRun: true, alreadyNotified: false, heldByMaintenance: true }), false, '★ held: never pushed, not seeded');
  assert.equal(bootSeedNotified({ alert: w, firstRun: true, alreadyNotified: true, heldByMaintenance: true }), true, 'pushed before the window: its record dedups');
});

test('★★ SOURCE PIN: index.ts hands the controller to the alert monitor and to Home Assistant\'s End-all button', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.ok(src.includes('const monitor = startAlertMonitor(store, recorder, (m) => app.log.info(m), (m) => app.log.warn(m), { maintenance });'),
    'the monitor stamps and steps the windows (without it the card says shelved and nothing is held, or held for ever)');
  assert.ok(/startMqttDiscovery\(store, recorder, \(m\) => app\.log\.info\(m\), \{\s*\/\/[^\n]*\n\s*active: \(\) => maintenance\.active\(Date\.now\(\)\),\s*endAll: \(\) => maintenance\.endAll\('ha', store\.get\(\)\.alerts \?\? \[\]\),/.test(src),
    'Home Assistant\'s End All Maintenance button ends the controller\'s windows');
  assert.ok(src.includes('homePoolSns: guardHomeSet(devices, shp2ConnectedDpuSns(devices), lastKnownRoster),'), 'the start guard\'s stable home set');
});
