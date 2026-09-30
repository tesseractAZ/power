/**
 * v1.187.0 review — the mute-reason WIRING, end to end.
 *
 * The first cut tested the pure helpers (monitorMuteReason, silentCriticalLine) and the balancing
 * and plateau stamps, but never ran the monitor's own stamp, the spare/off-panel split behind it,
 * the alerts.ts bench-spare stamps, or the `warn` sink the stuck-feed WARNING is routed to — any of
 * them could be deleted with the whole suite green. It also let a condition mute's reason stand
 * over the roster's: an off-panel Core's pack critical raised while balancing was logged as "the
 * BMS is balancing the cells" — once per id — and never re-logged when the roster became the only
 * mute left. Here: computeAlerts' three spare stamps, applyRosterMute's precedence, the
 * (id, reason)-keyed silent-critical edge, the telemetry-blind hold's stamp, and the real monitor
 * (startAlertMonitor) logging each silent critical with the reason in force, and routing a stuck
 * feed's WARNING to its warn sink.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-mute-wiring-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.OFF_PANEL_DEMOTE_TICKS = '1';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;

const {
  computeAlerts, MUTE_REASON_BALANCING, MUTE_REASON_BENCH_SPARE, MUTE_REASON_OFF_PANEL, MUTE_REASON_REMEDIATION,
} = await import('../src/alerts.js');
const { startAlertMonitor, applyRosterMute, silentCriticalEdges, ALERT_FEED_STUCK_WARN_PASSES } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { SPARE_DPU_SNS } = await import('../src/shp2Membership.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});
async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(10);
  }
}

const SPARE = [...SPARE_DPU_SNS][0] as string; // read from the literal, never written out
const HOME = 'COREXXX00XXX0001';
const OFF = 'COREXXX00XXX0003';
const PANEL = 'PANEXXX00XXX0001';

function dpuProjection(packs: unknown[]): Record<string, unknown> {
  return {
    kind: 'dpu', soc: 50, packs,
    pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
    pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
    batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
  };
}
function dpu(sn: string, name: string, packs: unknown[] = [], over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return { sn, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(), projection: dpuProjection(packs), ...over } as unknown as DeviceSnapshot;
}
function panel(connected: string[]): DeviceSnapshot {
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 60, backupReserveSoc: 15, pairedCircuits: [], sources: connected.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })) },
  } as unknown as DeviceSnapshot;
}
const byId = (alerts: Alert[], id: string) => alerts.find((a) => a.id === id);

/* ══ alerts.ts — the bench-spare stamps (offline, stale, online) ═══════════ */

test('★★ computeAlerts: every bench-spare mute says "bench spare" — offline, stale and online', () => {
  const offline = computeAlerts({ [SPARE]: dpu(SPARE, 'Core 9', [], { online: false }) });
  assert.equal(byId(offline, `offline-spare-${SPARE}`)?.annunciate, false);
  assert.equal(byId(offline, `offline-spare-${SPARE}`)?.muteReason, MUTE_REASON_BENCH_SPARE);

  const stale = computeAlerts({ [SPARE]: dpu(SPARE, 'Core 9', [], { lastUpdated: Date.now() - 2 * 3_600_000 }) });
  assert.equal(byId(stale, `stale-spare-${SPARE}`)?.annunciate, false);
  assert.equal(byId(stale, `stale-spare-${SPARE}`)?.muteReason, MUTE_REASON_BENCH_SPARE);

  // Online: the spare stamp overrides a balancing reason (that mute ends with the condition).
  const online = computeAlerts({ [SPARE]: dpu(SPARE, 'Core 9', [{ num: 1, maxVolDiffMv: 95, balanceState: 1 }]) });
  const crit = byId(online, `vdiff-crit-${SPARE}-1`);
  assert.equal(crit?.severity, 'critical');
  assert.equal(crit?.annunciate, false);
  assert.equal(crit?.muteReason, MUTE_REASON_BENCH_SPARE);
  // A home Core's identical pack keeps the balancing reason.
  const home = computeAlerts({ [HOME]: dpu(HOME, 'Core 1', [{ num: 1, maxVolDiffMv: 95, balanceState: 1 }]) });
  assert.equal(byId(home, `vdiff-crit-${HOME}-1`)?.muteReason, MUTE_REASON_BALANCING);
});

/* ══ applyRosterMute — demote + stamp, and the roster reason outranks a condition's ═══ */

test('★★★ applyRosterMute: the roster reason replaces a condition mute\'s; never-muted alerts are untouched', () => {
  const crit = (id: string, over: Partial<Alert> = {}): Alert => ({ id, severity: 'critical', category: 'Battery', device: 'Core 3', title: 'Cell imbalance', detail: 'x', ...over });
  const fresh = crit(`vdiff-crit-${OFF}-2`);
  applyRosterMute(fresh, [OFF], []);
  assert.equal(fresh.annunciate, false);
  assert.equal(fresh.muteReason, MUTE_REASON_OFF_PANEL);

  const balancing = crit(`vdiff-crit-${OFF}-2`, { annunciate: false, muteReason: MUTE_REASON_BALANCING });
  applyRosterMute(balancing, [OFF], []);
  assert.equal(balancing.annunciate, false);
  assert.equal(balancing.muteReason, MUTE_REASON_OFF_PANEL, 'the roster mute outlasts the balancing flag');

  const spare = crit(`vdiff-crit-${SPARE}-1`, { annunciate: false, muteReason: MUTE_REASON_BALANCING });
  applyRosterMute(spare, [SPARE, OFF], [SPARE]);
  assert.equal(spare.muteReason, MUTE_REASON_BENCH_SPARE);

  // Not on the roster lists: a condition mute keeps its own reason, an annunciating alert stays so.
  const homeBalancing = crit(`vdiff-crit-${HOME}-1`, { annunciate: false, muteReason: MUTE_REASON_BALANCING });
  applyRosterMute(homeBalancing, [OFF], []);
  assert.equal(homeBalancing.muteReason, MUTE_REASON_BALANCING);
  const loud = crit(`vdiff-crit-${HOME}-1`);
  applyRosterMute(loud, [OFF], []);
  assert.equal(loud.annunciate, undefined);
  assert.equal(loud.muteReason, undefined);

  // The v1.95.0 carve-out: a critical Thermal alert pages wherever the hardware is wired.
  const hot = crit(`temp-crit-${OFF}-2`, { category: 'Thermal' });
  applyRosterMute(hot, [OFF], []);
  assert.equal(hot.annunciate, undefined);
  assert.equal(hot.muteReason, undefined);
});

test('★★ silentCriticalEdges: keyed on (id, reason) — a change of policy mid-episode is announced again', () => {
  const logged = new Set<string>();
  const c = { id: `vdiff-crit-${OFF}-2`, severity: 'critical', annunciate: false as const, muteReason: MUTE_REASON_BALANCING };
  assert.equal(silentCriticalEdges(logged, [c]).length, 1);
  assert.equal(silentCriticalEdges(logged, [c]).length, 0, 'once per (id, reason), not per tick');
  const roster = { ...c, muteReason: MUTE_REASON_OFF_PANEL };
  assert.deepEqual(silentCriticalEdges(logged, [roster]).map((a) => a.muteReason), [MUTE_REASON_OFF_PANEL], 'the new reason is logged');
  assert.equal(silentCriticalEdges(logged, [roster]).length, 0);
  assert.equal(logged.size, 1, 'the old key was pruned');
});

test('★★ the telemetry-blind remediation hold stamps its own reason (no annunciate:false site is left unnamed)', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/alertMonitor.ts'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const hold = src.indexOf('if (remediation.hold) for (const a of blindAlerts) a.annunciate = false;');
  const stamp = src.indexOf('if (remediation.hold) for (const a of blindAlerts) a.muteReason = MUTE_REASON_REMEDIATION;');
  assert.ok(hold > 0 && stamp > hold, 'the stamp follows the hold');
  assert.equal(src.slice(hold, stamp).split('\n').length, 2, 'on the next statement, under the same condition');
  assert.equal(MUTE_REASON_REMEDIATION, 'held for remediation (remediate-first)');
});

/* ══ the real monitor ════════════════════════════════════════════════════ */

function startMonitor(store: InstanceType<typeof SnapshotStore>, report: (n: string) => Promise<unknown>) {
  const logs: string[] = [];
  const warns: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => warns.push(m), {
    analytics: { report } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async () => {}) as any,
  });
  return { mon, logs, warns };
}

test('★★★ end to end: each silent critical is logged with the policy that holds it — off-panel, bench spare, and the roster over balancing', { timeout: 20_000 }, async () => {
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = panel([HOME]);
  devices[HOME] = dpu(HOME, 'Core 1');
  // Off the panel roster, with a pack critical raised WHILE the BMS balances.
  devices[OFF] = dpu(OFF, 'Core 3', [{ num: 2, maxVolDiffMv: 90, balanceState: 1, packSn: 'PACKXXX00XXX0077' }]);
  devices[SPARE] = dpu(SPARE, 'Core 9');
  store.markFirstPollSettled();
  const feedCrit = (sn: string, core: number): Alert => ({
    id: `wire-crit-${sn}`, severity: 'critical', category: 'Battery', device: `Core ${core}`, coreNum: core,
    title: 'Wire check', detail: 'test', source: 'threshold',
  });
  const { mon, logs } = startMonitor(store, async (n) => {
    if (n === 'forecast') return null;
    if (n !== 'curtailmentAlerts') return [];
    return [feedCrit(OFF, 3), feedCrit(SPARE, 9)];
  });
  const silent = (s: string) => logs.filter((l) => l.includes('is CRITICAL but held non-annunciating') && l.includes(s));
  try {
    await until(() => silent('"Wire check" — Core 3 ').length > 0 && silent('"Wire check" — Core 9 ').length > 0 && silent('Core 3 pack 2').length > 0, 8_000, 'the three silent-critical lines');
    assert.deepEqual(silent('"Wire check" — Core 3 '), [
      'alerts: "Wire check" — Core 3 is CRITICAL but held non-annunciating (off-panel Core — not on the panel roster) — on-screen only, never spoken or pushed',
    ]);
    assert.deepEqual(silent('"Wire check" — Core 9 '), [
      'alerts: "Wire check" — Core 9 is CRITICAL but held non-annunciating (bench spare) — on-screen only, never spoken or pushed',
    ]);
    const vdiff = silent('Core 3 pack 2');
    assert.equal(vdiff.length, 1, 'one line — the reason in force from the first tick');
    assert.match(vdiff[0], /— Core 3 pack 2 \(SN …XX0077\) is CRITICAL but held non-annunciating \(off-panel Core — not on the panel roster\)/);
    assert.doesNotMatch(vdiff[0], /balancing/, 'the balancing flag is not what keeps it silent');
    const onScreen = store.get().alerts ?? [];
    assert.equal(byId(onScreen, `vdiff-crit-${OFF}-2`)?.muteReason, MUTE_REASON_OFF_PANEL);
    assert.equal(byId(onScreen, `wire-crit-${SPARE}`)?.muteReason, MUTE_REASON_BENCH_SPARE);
    assert.equal(logs.some((l) => l.includes('reason not recorded')), false);
    // Still on screen, never dispatched.
    assert.equal(logs.some((l) => /notify: sent ".*Wire check/.test(l)), false);
  } finally {
    mon.stop();
    await sleep(200);
  }
});

test('★★★ end to end: a STUCK worker feed\'s WARNING reaches the warn sink — for each of the four worker feeds', { timeout: 30_000 }, async () => {
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const answered = new Set<string>();
  const { mon, logs, warns } = startMonitor(store, (n) => {
    if (answered.has(n)) return never();   // answers once, then hangs for good
    answered.add(n);
    return Promise.resolve(n === 'forecast' ? null : []);
  });
  const names = ['forecast', 'curtailmentAlerts', 'baselineAlerts', 'forecastAlerts'];
  const stuck = (lines: string[], name: string) => lines.filter((l) => l.startsWith(`alert-feed: WARNING — ${name} has carried its last good value for ${ALERT_FEED_STUCK_WARN_PASSES} passes`));
  try {
    await until(() => names.every((n) => stuck(warns, n).length === 1), 20_000, 'a stuck-feed WARNING per worker feed');
    for (const n of names) assert.equal(stuck(logs, n).length, 0, `${n}: the WARNING goes to the warn sink, not the info log`);
    // The carry itself is still an info line (logged at its second pass).
    for (const n of names) assert.ok(logs.some((l) => l.startsWith(`alert-feed: ${n} still running after its 60 ms budget — carrying its last good value`)), n);
  } finally {
    mon.stop();
    await sleep(200);
  }
});
