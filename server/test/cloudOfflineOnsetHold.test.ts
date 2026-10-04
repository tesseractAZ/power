/**
 * v1.187.10 (log review) — a cloud OFFLINE flag that live MQTT data contradicts is held for its onset.
 *
 * 2026-10-03 19:31 MST, right after a WAN drop: EcoFlow's /device/list listed the panel and every Core
 * offline in one poll. The condition went yellow in the same second and was spoken on every speaker
 * for 92 s; three "[Medium] Device offline (per EcoFlow Cloud)" pushes went out; every flag cleared
 * within about 2 minutes. A home Core or panel listed offline while its own MQTT data still arrives
 * (a data message within 90 s) is now on screen at once but non-annunciating — not spoken, not pushed
 * — for 3 minutes from the transition. The moment its data stops, or the hold runs out, it
 * annunciates as before. A flag with no transition seen here, or a device with no MQTT data, is never
 * held. The spoken text no longer reads the API path or "message s" either (verbalizeForTts).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert, ConnectivityContext } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-cloud-offline-hold-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '60';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
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

const {
  computeAlerts, cloudOfflineOnsetHeld, CLOUD_OFFLINE_ONSET_HOLD_MS, CLOUD_OFFLINE_MQTT_LIVE_MS,
  MUTE_REASON_CLOUD_OFFLINE_MQTT_LIVE, MUTE_REASON_BENCH_SPARE,
} = await import('../src/alerts.js');
const { conditionFromAlerts } = await import('../src/broadcast.js');
const { buildAlertMessage, verbalizeForTts } = await import('../src/ttsService.js');
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { SPARE_DPU_SNS } = await import('../src/shp2Membership.js');

const CORE = 'COREXXX00XXX0001';
const PANEL = 'PANEXXX00XXX0001';
const WAVE = 'WAVEXXX00XXX0001';
const SEC = 1_000;
const MIN = 60_000;

function dev(sn: string, productName: string, deviceName: string, over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return { sn, deviceName, productName, online: false, lastUpdated: 0, ...over } as DeviceSnapshot;
}
function conn(entries: Array<[string, number | undefined]>): ConnectivityContext {
  const now = Date.now();
  return {
    lastDeviceListAttemptAt: now, lastDeviceListSuccessAt: now,
    perDevice: new Map(entries.map(([sn, lastMqttAt]) => [sn, { mqttCount: lastMqttAt != null ? 1234 : 0, lastMqttAt, lastSource: lastMqttAt != null ? 'mqtt' as const : undefined }])),
  };
}
/** A home Core listed offline `offlineAgoMs` ago by the device list, its last MQTT data `mqttAgoMs` ago. */
function coreOffline(offlineAgoMs: number | undefined, mqttAgoMs: number | undefined): Alert {
  const now = Date.now();
  const d = dev(CORE, 'DELTA Pro Ultra', 'Core 5', offlineAgoMs != null ? { onlineChangedAtMs: now - offlineAgoMs, onlineChangedVia: 'device-list' } : {});
  return computeAlerts({ [CORE]: d }, conn([[CORE, mqttAgoMs != null ? now - mqttAgoMs : undefined]])).find((a) => a.id === `offline-${CORE}`)!;
}

test('cloudOfflineOnsetHeld: held only inside the onset window AND while MQTT data is live; unknown is never held', () => {
  const T = 10_000_000;
  assert.equal(CLOUD_OFFLINE_ONSET_HOLD_MS, 3 * MIN, 'the 3-minute window of the other onset debounces');
  assert.equal(CLOUD_OFFLINE_MQTT_LIVE_MS, 90 * SEC);
  assert.equal(cloudOfflineOnsetHeld(T - 30 * SEC, T - 31 * SEC, T), true, '★ the 19:31 shape: offline 30 s, data 31 s ago');
  assert.equal(cloudOfflineOnsetHeld(T, T, T), true, 'the first tick of the transition');
  assert.equal(cloudOfflineOnsetHeld(T - CLOUD_OFFLINE_ONSET_HOLD_MS + 1, T, T), true, 'the last millisecond of the hold');
  assert.equal(cloudOfflineOnsetHeld(T - CLOUD_OFFLINE_ONSET_HOLD_MS, T, T), false, '★ the hold runs out at 3 min, data or not');
  assert.equal(cloudOfflineOnsetHeld(T - 30 * SEC, T - CLOUD_OFFLINE_MQTT_LIVE_MS + 1, T), true, 'data just inside the live window');
  assert.equal(cloudOfflineOnsetHeld(T - 30 * SEC, T - CLOUD_OFFLINE_MQTT_LIVE_MS, T), false, '★ silent on MQTT for 90 s: alarms at once (fail-loud)');
  assert.equal(cloudOfflineOnsetHeld(undefined, T, T), false, 'no transition seen in this process (offline at the first list): never held');
  assert.equal(cloudOfflineOnsetHeld(T - 30 * SEC, undefined, T), false, 'no MQTT data this session: never held');
  assert.equal(cloudOfflineOnsetHeld(T + 5 * SEC, T, T), false, 'a transition stamped in the future is not an onset');
});

test('★★★ the 19:31 shape: a home Core listed offline while its MQTT data still arrives is on screen, held non-annunciating, and does not raise the condition', () => {
  const a = coreOffline(30 * SEC, 31 * SEC);
  assert.equal(a.severity, 'warning', 'unchanged');
  assert.equal(a.priority, 'medium', 'unchanged');
  assert.equal(a.title, 'Device offline (per EcoFlow Cloud)', 'unchanged');
  assert.equal(a.annunciate, false, '★ not spoken, not pushed');
  assert.equal(a.muteReason, MUTE_REASON_CLOUD_OFFLINE_MQTT_LIVE);
  assert.deepEqual(a.facts?.find((f) => f.label === 'Onset hold'),
    { label: 'Onset hold', value: 'MQTT data still arriving (last 31s ago) — held up to 3 min from the transition before it is spoken or pushed' });
  assert.equal(conditionFromAlerts([a]).level, 'green', '★ the condition stays green');
  assert.equal(buildAlertMessage('yellow', [a]).includes('Device offline'), false, 'never the spoken alert');
});

test('★★★ fail-loud: offline AND silent on MQTT alarms at once, as before', () => {
  const a = coreOffline(30 * SEC, 120 * SEC);
  assert.equal(a.annunciate, undefined, 'annunciates');
  assert.equal(a.muteReason, undefined);
  assert.equal(a.facts?.some((f) => f.label === 'Onset hold'), false);
  assert.equal(conditionFromAlerts([a]).level, 'yellow', '★ raises the condition');
});

test('★★★ the hold ends at 3 minutes even while MQTT data keeps arriving', () => {
  assert.equal(coreOffline(CLOUD_OFFLINE_ONSET_HOLD_MS - 5 * SEC, 1 * SEC).annunciate, false, 'inside the hold');
  const a = coreOffline(CLOUD_OFFLINE_ONSET_HOLD_MS + 5 * SEC, 1 * SEC);
  assert.equal(a.annunciate, undefined, '★ persisted past the hold: annunciates');
  assert.equal(conditionFromAlerts([a]).level, 'yellow');
});

test('★★ never held: offline since the first device list, or no MQTT data this session', () => {
  assert.equal(coreOffline(undefined, 5 * SEC).annunciate, undefined, 'no transition seen in this process');
  assert.equal(coreOffline(30 * SEC, undefined).annunciate, undefined, 'no MQTT data this session');
});

test('★★ the panel is held the same way (its own flag raised the same yellow in the 19:31 event); a peripheral and a bench spare are unchanged', () => {
  const now = Date.now();
  const flagged = { online: false, onlineChangedAtMs: now - 20 * SEC, onlineChangedVia: 'device-list' as const };
  const panel = computeAlerts({ [PANEL]: dev(PANEL, 'Smart Home Panel 2', 'Smart Home Panel 2', flagged) }, conn([[PANEL, now - 5 * SEC]]))
    .find((a) => a.id === `offline-${PANEL}`)!;
  assert.equal(panel.severity, 'warning');
  assert.equal(panel.priority, 'high', 'unchanged');
  assert.equal(panel.annunciate, false, '★ held');
  assert.equal(panel.muteReason, MUTE_REASON_CLOUD_OFFLINE_MQTT_LIVE);
  const silentPanel = computeAlerts({ [PANEL]: dev(PANEL, 'Smart Home Panel 2', 'Smart Home Panel 2', flagged) }, conn([[PANEL, now - 100 * SEC]]))
    .find((a) => a.id === `offline-${PANEL}`)!;
  assert.equal(silentPanel.annunciate, undefined, 'a silent panel alarms at once');
  const wave = computeAlerts({ [WAVE]: dev(WAVE, 'WAVE 2', 'WAVE 2', flagged) }, conn([[WAVE, now - 5 * SEC]])).find((a) => a.id === `offline-${WAVE}`)!;
  assert.equal(wave.severity, 'info');
  assert.equal(wave.annunciate, undefined, 'a peripheral is not stamped');
  assert.equal(wave.muteReason, undefined);
  const spareSn = [...SPARE_DPU_SNS][0];
  if (spareSn != null) {
    const spare = computeAlerts({ [spareSn]: dev(spareSn, 'DELTA Pro Ultra', 'Core 4', flagged) }, conn([[spareSn, now - 5 * SEC]]))
      .find((a) => a.id === `offline-spare-${spareSn}`)!;
    assert.equal(spare.muteReason, MUTE_REASON_BENCH_SPARE, 'the bench-spare reason, not the onset hold');
    assert.equal(spare.annunciate, false);
  }
});

test('★★★ the spoken text reads no API path and no broken plural', () => {
  const a = coreOffline(10 * MIN, 31 * SEC); // past the hold: spoken
  assert.match(a.detail, /flagged offline by EcoFlow's \/device\/list\. We previously received 1234 MQTT message\(s\) this session; last data 31s ago via MQTT\./, 'the screen text is unchanged');
  const spoken = buildAlertMessage('yellow', [a]);
  assert.ok(spoken.includes("flagged offline by EcoFlow's device list. We previously received 1234 MQTT messages this session; last data 31 seconds ago via MQTT."), spoken);
  assert.doesNotMatch(spoken, /\/|message s\b|\(|\)|31s/);
});

test('★★ verbalizeForTts: API paths, any "(s)" plural and a glued seconds age; idempotent; rate slashes unchanged', () => {
  assert.equal(verbalizeForTts("flagged offline by EcoFlow's /device/list."), "flagged offline by EcoFlow's device list.");
  assert.equal(verbalizeForTts('observed via MQTT /status'), 'observed via MQTT status');
  assert.equal(verbalizeForTts('/quota failed'), 'quota failed', 'at the start of the text');
  assert.equal(verbalizeForTts('2 fetch failure(s)'), '2 fetch failures');
  assert.equal(verbalizeForTts('last data 31s ago'), 'last data 31 seconds ago');
  assert.equal(verbalizeForTts('last data 1s ago'), 'last data 1 second ago');
  assert.equal(verbalizeForTts('draining 1.2%/h, 18.3 kWh/day'), 'draining 1.2 percent per hour, 18.3 kilowatt hours per day', 'rate slashes unchanged');
  assert.equal(verbalizeForTts('PACKXXX0015s'), 'PACKXXX0015s', 'a serial ending in s is not an age (no word boundary before the digits)');
  for (const s of ["EcoFlow's /device/list. 1234 MQTT message(s); last data 31s ago.", 'last data 1s ago']) {
    const once = verbalizeForTts(s);
    assert.equal(verbalizeForTts(once), once, `idempotent: ${s}`);
  }
});

/* ══ end to end: the real alert monitor ═══════════════════════════════════════ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string, logs: string[] = []): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}\n${logs.slice(-20).join('\n')}`);
    await sleep(10);
  }
}

test('★★★ end to end: held while the data arrives (on screen, not pushed, condition green); the data stops → pushed and the condition is yellow', { timeout: 30_000 }, async () => {
  const store = new SnapshotStore();
  const devices = store.get().devices as Record<string, DeviceSnapshot>;
  devices[PANEL] = {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', backupBatPercent: 60, backupReserveSoc: 15, pairedCircuits: [], sources: [{ slot: 1, sn: CORE, isConnected: true }] },
  } as unknown as DeviceSnapshot;
  devices[CORE] = dev(CORE, 'DELTA Pro Ultra', 'Core 5', { online: true, lastUpdated: Date.now() });
  store.markFirstPollSettled();
  const sent: string[] = [];
  const logs: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: { report: async (n: string) => (n === 'forecast' ? null : []) } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string }) => { sent.push(msg.title); }) as any,
  });
  const onScreen = () => ((store.get().alerts ?? []) as Alert[]).find((a) => a.id === `offline-${CORE}`);
  const passes = async (n: number) => { const at = mon.stats().evalPasses; await until(() => mon.stats().evalPasses >= at + n, 5_000, `${n} passes`, logs); };
  try {
    await passes(2);
    // The cloud lists the Core offline; its MQTT data keeps arriving.
    devices[CORE].online = false;
    devices[CORE].onlineChangedAtMs = Date.now();
    devices[CORE].onlineChangedVia = 'device-list';
    store.lastMqttAtBySn.set(CORE, Date.now());
    await until(() => onScreen() != null, 5_000, 'the offline card', logs);
    for (let i = 0; i < 5; i++) { store.lastMqttAtBySn.set(CORE, Date.now()); await passes(1); }
    assert.equal(onScreen()!.annunciate, false, '★ held');
    assert.equal(onScreen()!.muteReason, MUTE_REASON_CLOUD_OFFLINE_MQTT_LIVE);
    assert.equal(sent.some((t) => t.includes('Device offline')), false, '★ not pushed (debounce 0, five passes)');
    assert.equal(conditionFromAlerts([onScreen()!]).level, 'green', '★ it does not raise the condition');
    // The data stops: 100 s since the last message.
    store.lastMqttAtBySn.set(CORE, Date.now() - 100 * SEC);
    await until(() => sent.some((t) => t.includes('Device offline (per EcoFlow Cloud)')), 5_000, '★ pushed once the data stopped', logs);
    assert.notEqual(onScreen()!.annunciate, false);
    assert.equal(conditionFromAlerts([onScreen()!]).level, 'yellow', '★ it raises the condition');
  } finally {
    mon.stop();
    await sleep(200);
  }
});
