/**
 * v1.187.3 — the EMS parallel band is a relative band, not a voltage limit: leaving it is an
 * info / Low notice that never pushes and never raises or voices the broadcast condition.
 *
 * EcoFlow's emsParaVolMin/Max is 2.3-3.0 V wide and follows the Core's own voltage (at rest the
 * reference sits within about 40 mV of batVol; the backend block refreshes about every 5 min).
 * batVol leaves it on a fast current change or at the top of charge: 33 home-Core episodes from
 * 08-25 to 10-01, batVol 102.3-109.3 V, highest cell at most 3.512 V. As a warning it took ISA
 * High, raised the yellow, was spoken and pushed — on 10-01 13:25 it was the one audible alarm of
 * Core 5's top of charge, at 108.948 V, 0.45 V BELOW a 109.4-112.4 V band, highest cell 3.494 V.
 *
 * A real overvoltage is cell-ovp-* (critical at 3.600 V, never muted): the same frame with one
 * cell at 3.600 V still raises the red and pushes at once.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-ems-band-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_MIN_SEVERITY = 'warning';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');
process.env.IDLE_POOL_STATE_PATH = join(tmp, 'idle-pool.json');
process.env.VDIFF_KNEE_STATE_PATH = join(tmp, 'knee.json');
process.env.DEFECTIVE_PACK_LATCH_PATH = join(tmp, 'latch.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { computeAlerts, resetVdiffWarnHoldForTesting, CELL_OVP_CRIT_MV } = await import('../src/alerts.js');
const { conditionFromAlerts, speakableAlerts } = await import('../src/broadcast.js');
const { priorityOf } = await import('../src/alertPriority.js');
const { buildAlertMessage, buildAlertMessageEs, pickPrimaryAlert } = await import('../src/ttsService.js');
const { startAlertMonitor, risingEdgePushes } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const CORE = 'COREXXX00XXX0005';
const PANEL = 'PANEXXX00XXX0001';
const ID = `ems-volt-${CORE}`;

/** 2026-10-01 13:24:57, Core 5: the backend report that raised the alarm. Five packs at 99-100%
 *  charging ~20 A; the highest cells of the event (3.482-3.494 V). `over` patches pack 5. */
function frame(batVol: number, over: Record<string, unknown> = {}): DeviceSnapshot {
  const maxCells = [3482, 3468, 3485, 3492, 3494];
  return {
    sn: CORE, deviceName: 'Core 5', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 99,
      packs: maxCells.map((mv, i) => ({
        num: i + 1, soc: i === 4 ? 100 : 99, packSn: `PACKXXX00XXX000${i + 1}`, inputWatts: 400, outputWatts: 0,
        temp: 30, maxCellTemp: 30, soh: 100, actSoh: 100, maxVolDiffMv: 15, minCellVoltageMv: mv - 15,
        maxCellVoltageMv: mv, balanceState: 0, cellVoltagesMv: [],
        ...(i === 4 ? over : {}),
      })),
      pvHighWatts: 1900, pvLowWatts: 0, pvTotalWatts: 1893, pvHighVolts: 300, pvHighAmps: 6.3, pvLowVolts: 0, pvLowAmps: 0,
      pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 1893, totalOutWatts: 0,
      batVol, batAmp: 20, mpptHvTemp: 40, mpptLvTemp: 35,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
      sysErrCode: 0, emsParaVolMaxMv: 112_400, emsParaVolMinMv: 109_400, chgMaxSoc: 100, dsgMinSoc: 10,
    },
  } as unknown as DeviceSnapshot;
}
const EVENT_V = 108.948;
const pure = (d: DeviceSnapshot) => computeAlerts({ [CORE]: d }, undefined, { present: true, backstopping: true });

beforeEach(() => resetVdiffWarnHoldForTesting());

/* ── the rule ────────────────────────────────────────────────────────────────────────────── */

test('★★★ the 10-01 13:24:57 frame: an info / Low notice, audible:false, on the card — not a limit', () => {
  const a = pure(frame(EVENT_V)).find((x) => x.id === ID);
  assert.ok(a, 'the card is kept');
  assert.equal(a!.severity, 'info');
  assert.equal(a!.priority, 'low');
  assert.equal(priorityOf(a!), 'low', 'never ISA High ("a protective hardware limit has been crossed")');
  assert.equal(a!.audible, false);
  assert.notEqual(a!.annunciate, false, 'visible; the severity alone keeps it off the push');
  assert.equal(a!.category, 'Battery');
  assert.equal(a!.title, 'Pack voltage swing outside EMS band');
  assert.doesNotMatch(a!.title, /window|limit|range/i);
  assert.match(a!.detail, /^Core 5 at 108\.9 V — below EcoFlow's 109\.4–112\.4 V parallel band\./);
  assert.match(a!.detail, /not a voltage limit/);
  assert.match(a!.detail, /cell overvoltage at 3\.60 V/);
  assert.equal(risingEdgePushes(a!), true, 'not muted: below the minimum severity is what keeps it off the phone');
});

test('★★ above the band says so; inside it nothing is raised', () => {
  const above = pure(frame(112.5)).find((x) => x.id === ID);
  assert.match(above!.detail, /— above EcoFlow's 109\.4–112\.4 V parallel band\./);
  assert.equal(above!.severity, 'info');
  assert.equal(pure(frame(110.9)).find((x) => x.id === ID), undefined, 'the band centre');
  assert.equal(pure(frame(109.4)).find((x) => x.id === ID), undefined, 'the floor itself is inside');
  assert.ok(pure(frame(109.399)).find((x) => x.id === ID), 'one millivolt below it is outside');
});

test('★★★ it never raises or voices the condition: the frame alone is green', () => {
  const alerts = pure(frame(EVENT_V));
  assert.equal(conditionFromAlerts(alerts).level, 'green');
  const spoken = speakableAlerts(alerts, Date.now(), () => undefined);
  assert.equal(spoken.some((a) => a.id === ID), false, 'dropped before the level and the words');
  // Belt and braces: even a caller that skipped the tick's filter never names it.
  const notice = alerts.find((a) => a.id === ID)!;
  assert.equal(conditionFromAlerts([notice]).level, 'green');
  assert.equal(pickPrimaryAlert([notice], 'yellow'), null);
});

test('★★★ the same frame with a cell at 3.600 V: cell-ovp is critical, red and voiced; the notice stays quiet beside it', () => {
  const alerts = pure(frame(EVENT_V, { maxCellVoltageMv: CELL_OVP_CRIT_MV }));
  const ovp = alerts.find((a) => a.id === `cell-ovp-${CORE}-5`);
  assert.ok(ovp);
  assert.equal(ovp!.severity, 'critical');
  assert.notEqual(ovp!.annunciate, false);
  assert.equal(conditionFromAlerts(speakableAlerts(alerts, Date.now(), () => undefined)).level, 'red');
  assert.match(buildAlertMessage('red', alerts), /overvoltage/i);
  assert.doesNotMatch(buildAlertMessage('red', alerts), /EMS/);
  assert.equal(alerts.find((a) => a.id === ID)?.severity, 'info');
});

test('★ the Spanish title no longer says the voltage is outside the permitted range', () => {
  const a = { ...pure(frame(EVENT_V)).find((x) => x.id === ID)!, severity: 'warning' as const, audible: undefined, coreNum: 5 };
  const es = buildAlertMessageEs('yellow', [a]);
  assert.match(es, /Oscilación de voltaje fuera de la banda del EMS/);
  assert.doesNotMatch(es, /permitido/);
});

/* ── end to end: the real alert monitor ──────────────────────────────────────────────────── */

test('★★★ end to end: the 10-01 frame pushes nothing and reads green; a cell at 3.600 V in it pushes [Critical] and reads red', { timeout: 30_000 }, async () => {
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 99, backupReserveSoc: 15, pairedCircuits: [], sources: [{ slot: 1, sn: CORE, isConnected: true, hwConnect: true }] },
  } as unknown as DeviceSnapshot;
  devices[CORE] = frame(110.9); // inside the band: the first evaluation seeds nothing for it
  store.markFirstPollSettled();
  const logs: string[] = [];
  const sent: Array<{ title: string; severity: string }> = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string; severity: string }) => { sent.push({ title: msg.title, severity: msg.severity }); }) as any,
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 8_000) throw new Error(`timed out waiting for ${what}\n${logs.slice(-30).join('\n')}`);
      await sleep(10);
    }
  };
  const onScreen = () => (store.get().alerts ?? []) as Alert[];
  const passes = async (n: number) => { const at = mon.stats().evalPasses; await until(() => mon.stats().evalPasses >= at + n, `${n} passes`); };
  try {
    await passes(2);
    devices[CORE] = frame(EVENT_V); // 13:24:57
    await until(() => onScreen().some((a) => a.id === ID), 'the notice on the card');
    await passes(4);
    assert.equal(onScreen().find((a) => a.id === ID)!.severity, 'info');
    assert.equal(sent.length, 0, `no push of any kind: ${JSON.stringify(sent)}`);
    assert.equal(conditionFromAlerts(speakableAlerts(onScreen(), Date.now(), () => undefined)).level, 'green',
      JSON.stringify(onScreen().map((a) => [a.id, a.severity, a.annunciate, a.audible])));

    devices[CORE] = frame(EVENT_V, { maxCellVoltageMv: CELL_OVP_CRIT_MV });
    await until(() => sent.some((s) => s.title.includes('Cell overvoltage')), 'the cell-overvoltage push');
    const push = sent.find((s) => s.title.includes('Cell overvoltage'))!;
    assert.match(push.title, /^EcoFlow · \[Critical\] Cell overvoltage/);
    assert.equal(push.severity, 'critical');
    assert.equal(conditionFromAlerts(speakableAlerts(onScreen(), Date.now(), () => undefined)).level, 'red');
    assert.equal(sent.some((s) => /EMS/.test(s.title)), false, 'the notice is still not pushed');
  } finally {
    mon.stop();
    await sleep(200);
  }
});
