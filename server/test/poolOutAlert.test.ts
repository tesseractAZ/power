/**
 * v1.208.0 — the alert `shp2-pool-out` as computeAlerts emits it, and the monitor's pure hooks for it: the family
 * listing, the quiet-hours push flag, the boot orphan hold, the return notice, the grid verdict's hand-over.
 *
 * computeAlerts is called directly with the context the monitor builds (test/poolOutMonitor.test.ts runs the monitor).
 * The device map comes from a real SnapshotStore fed the pool-out fixture bodies (placeholder serials; the capacity,
 * the flags and the circuit vector are the builder's, not recorded readings).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeAlerts, debouncedOnsetsPending, type Alert, type ConnectivityContext } from '../src/alerts.js';
import * as monitorModule from '../src/alertMonitor.js';
import {
  ENERGY_STATE_FAMILIES, applySilencingRules, decideAlertDispatch, isDeviceDerivedAlertId, fallingEdgeFrozenByEvidence,
  poolOutOrphanHeld, poolOutResolveText, poolOutGridVerdict, notifyLocator, bootSeedNotified, type AlertActionStats,
} from '../src/alertMonitor.js';
import { familyOf } from '../src/alertOutcomes.js';
import { MAINTENANCE_SHELVABLE_PREFIXES } from '../src/maintenanceWindow.js';
import { SnapshotStore, type DeviceSnapshot } from '../src/snapshot.js';
import * as poolOutModule from '../src/poolOut.js';
import { poolOutAlertParts, poolOutDelivery, poolOutAlertId, POOL_OUT_ALERT_ID, type PoolOutAlertParts, type PoolOutState } from '../src/poolOut.js';
import { pickPrimaryAlert, buildAlertMessage, buildAlertMessageEs, verbalizeForTts } from '../src/ttsService.js';
import { conditionNamePool, conditionFromAlerts } from '../src/broadcast.js';
import { priorityOf } from '../src/alertPriority.js';
import { PANEL_SN, CORE_SNS, SLOT_WH, FULL_WH, at, healthyBody, lostBody, quietBody, quietLostBody, synthBody, withEpisode, withReference, fold, minutes, type Body } from './fixtures/poolOutFixtures.js';

const TZ = 'America/Phoenix';
const OTHER_PANEL = 'HD31XXX00XXX0002';
const ctxAt = { nowMs: at(10) + 20_000, timeZone: TZ };
const WARNING: PoolOutAlertParts = poolOutAlertParts(withEpisode(), ctxAt)!;
// Slot 1 out and the panel reporting no grid, the add-on agreeing: critical by the grid.
const CRITICAL: PoolOutAlertParts = poolOutAlertParts(
  fold(withEpisode(), minutes(11, 3, (seq) => lostBody(seq, { gridSta: 0 }), { grid: { present: false, presenceUnknown: false } })).state,
  { nowMs: at(13) + 20_000, timeZone: TZ },
)!;

/** A device map from a real store: `bodies` by panel serial, each fed once at minute 10. */
function devicesOf(bodies: Record<string, Body>, opts: { house?: string } = {}): Record<string, DeviceSnapshot> {
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  store.setClock(() => Date.now());
  const sns = Object.keys(bodies);
  store.setDeviceList(sns.map((sn) => ({ sn, deviceName: sn === PANEL_SN ? 'Smart Home Panel 2' : 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 })) as any);
  if (opts.house) store.pinHousePanel(opts.house);
  for (const [sn, body] of Object.entries(bodies)) store.setDeviceQuota(sn, body);
  return store.get().devices;
}
const context = (poolOutBySn: NonNullable<ConnectivityContext['poolOutBySn']> | undefined): ConnectivityContext => ({
  lastDeviceListAttemptAt: 0, lastDeviceListSuccessAt: Date.now(), perDevice: new Map(), ...(poolOutBySn ? { poolOutBySn } : {}),
});
const poolOut = (alerts: Alert[]): Alert[] => alerts.filter((a) => a.id.startsWith(POOL_OUT_ALERT_ID));
const GRID_PRESENT = { present: true, backstopping: true };

/* ══ the alert ══════════════════════════════════════════════════════════════════════════════════════ */

test('control (passes without this release): a panel whose capacity is one Core short raises nothing through the two slot rules', () => {
  const alerts = computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10) }), context(undefined), GRID_PRESENT);
  assert.deepEqual(alerts.filter((a) => a.category === 'SHP2').map((a) => a.id), [], 'the 2026-11-14 shape: slot 1 at 0 W, listed connected, no error code');
});

test('★★★ the alert, field by field: id, category, device, source, the latched title and fault, the detail, the facts, the quiet-hours flag', () => {
  const alerts = computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10) }), context(new Map([[PANEL_SN, WARNING]])), GRID_PRESENT);
  const [a, ...rest] = poolOut(alerts);
  assert.deepEqual(rest, []);
  assert.deepEqual(a, {
    id: 'shp2-pool-out',
    severity: 'warning',
    category: 'SHP2',
    device: 'Smart Home Panel 2',
    sourceSn: PANEL_SN,
    title: 'Core out of the backup pool: slot 1',
    fault: 'out:1;k=1',
    detail: WARNING.detail,
    spokenDetail: 'Backup capacity reads 61.4 of 92.2 kWh.',
    facts: WARNING.facts,
    pushInQuietHours: true,
  });
  assert.equal(a.detail.startsWith("The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots. It first read under the sum of its slots at 23:00;"), true);
  assert.equal(priorityOf(a), 'high', 'a warning is ISA High');
  assert.equal(notifyLocator(a), 'Smart Home Panel 2', 'the push title ends "— Smart Home Panel 2"');
  assert.equal(a.annunciate, undefined);
  assert.equal(a.audible, undefined, 'speech is left to the broadcast\'s own rules');
  for (const sn of CORE_SNS) assert.equal(JSON.stringify(a).includes(sn), false, '★ no Core serial anywhere in the alert (the off-panel roster mute matches on the id)');
});

test('★★★ NOT gated on the panel\'s projection: the alarm stands while the panel is offline, and with no projection at all', () => {
  const devices = devicesOf({ [PANEL_SN]: lostBody(10, { poolPct: 12 }) });
  const online = computeAlerts(devices, context(new Map([[PANEL_SN, WARNING]])));
  assert.deepEqual(online.filter((a) => a.category === 'SHP2').map((a) => a.id).sort(), ['shp2-below-reserve', 'shp2-pool-out'], 'control: online, both stand');

  const offline = { [PANEL_SN]: { ...devices[PANEL_SN], online: false } };
  const off = computeAlerts(offline, context(new Map([[PANEL_SN, WARNING]])));
  assert.deepEqual(off.filter((a) => a.category === 'SHP2').map((a) => a.id), ['shp2-pool-out'], '★ the reserve pair is gated on an online panel; this alarm is not');

  const dark = { [PANEL_SN]: { ...devices[PANEL_SN], online: true, projection: undefined } };
  assert.deepEqual(poolOut(computeAlerts(dark, context(new Map([[PANEL_SN, WARNING]])))).map((a) => `${a.id} ${a.device}`), ['shp2-pool-out Smart Home Panel 2'],
    '★ a panel listed and not yet projected after a restart: the restored alarm is in the set, under the bare id (a lone panel is the house panel, pinned or not)');

  assert.deepEqual(poolOut(computeAlerts({}, context(new Map([[PANEL_SN, WARNING]])))), [], 'a panel never listed in this process, with nothing latched for it, has no name to alert under');
});

test('★★★ the id and the panel\'s name latched at the raise: the alarm is in the set with NO device list at all (a restart into a cloud outage), and its id does not follow the house pin', () => {
  const card = { id: 'shp2-pool-out', device: 'Smart Home Panel 2' };
  // No device map at all: the store restored the episode and its card; the list has not arrived.
  const dark = poolOut(computeAlerts({}, context(new Map([[PANEL_SN, { ...WARNING, card }]]))));
  assert.deepEqual(dark.map((a) => [a.id, a.device, a.sourceSn, a.title, a.severity, a.pushInQuietHours]), [['shp2-pool-out', 'Smart Home Panel 2', PANEL_SN, 'Core out of the backup pool: slot 1', 'warning', true]],
    '★ present at the first pass, under the id and the name it was raised with');
  // Listed: the live name is shown (a rename is followed), the id stays the latched one.
  const listed = devicesOf({ [PANEL_SN]: lostBody(10) });
  assert.deepEqual(poolOut(computeAlerts(listed, context(new Map([[PANEL_SN, { ...WARNING, card: { id: 'shp2-pool-out', device: 'An older name' } }]])), GRID_PRESENT)).map((a) => [a.id, a.device]), [['shp2-pool-out', 'Smart Home Panel 2']]);
  // Two panels, and the house pin now names the OTHER one: the alarm raised on the first panel as the house panel
  // keeps its bare id (a new id would resolve one card and push another for the same episode).
  const swapped = devicesOf({ [PANEL_SN]: lostBody(10), [OTHER_PANEL]: healthyBody(11) }, { house: OTHER_PANEL });
  assert.deepEqual(poolOut(computeAlerts(swapped, context(new Map([[PANEL_SN, { ...WARNING, card }]])), GRID_PRESENT, () => GRID_PRESENT)).map((a) => a.id), ['shp2-pool-out'], '★ the latched id');
  assert.deepEqual(poolOut(computeAlerts(swapped, context(new Map([[PANEL_SN, { ...WARNING, card: null }]])), GRID_PRESENT, () => GRID_PRESENT)).map((a) => a.id), [`shp2-pool-out-${PANEL_SN}`], 'control: with nothing latched the id is the role of the moment');
});

test('★★★ two panels: the house panel\'s id is bare, any other panel\'s ends with ITS serial; one family, and each names its own panel', () => {
  const devices = devicesOf({ [PANEL_SN]: lostBody(10), [OTHER_PANEL]: lostBody(11) }, { house: PANEL_SN });
  const alerts = poolOut(computeAlerts(devices, context(new Map([[OTHER_PANEL, WARNING], [PANEL_SN, CRITICAL]])), GRID_PRESENT, () => GRID_PRESENT));
  assert.deepEqual(alerts.map((a) => [a.id, a.severity, a.device, a.sourceSn, a.title]), [
    ['shp2-pool-out', 'critical', 'Smart Home Panel 2', PANEL_SN, 'Core out of the backup pool: slot 1'],
    [`shp2-pool-out-${OTHER_PANEL}`, 'warning', 'Garage Panel', OTHER_PANEL, 'Core out of the backup pool: slot 1'],
  ]);
  assert.deepEqual(alerts.map((a) => familyOf(a.id)), ['shp2-pool-out', 'shp2-pool-out']);
  assert.equal(poolOutAlertId(PANEL_SN, true), 'shp2-pool-out');
  assert.equal(poolOutAlertId(OTHER_PANEL, false), `shp2-pool-out-${OTHER_PANEL}`);
  // With the garage panel pinned as the house, the roles swap.
  const swapped = poolOut(computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10), [OTHER_PANEL]: lostBody(11) }, { house: OTHER_PANEL }), context(new Map([[PANEL_SN, WARNING]])), GRID_PRESENT, () => GRID_PRESENT));
  assert.deepEqual(swapped.map((a) => a.id), [`shp2-pool-out-${PANEL_SN}`]);
});

test('★★★ the spoken message: "Backup at or below reserve" is not in the pool it names from (it has its own announcer), and beside ANY other critical this alarm yields the voice', () => {
  // The house panel: at its reserve, off-grid (no grid verdict is the off-grid default), slot 1 out.
  const devices = devicesOf({ [PANEL_SN]: lostBody(10, { poolPct: 12, gridSta: 0 }) });
  const alerts = computeAlerts(devices, context(new Map([[PANEL_SN, CRITICAL]])));
  assert.deepEqual(alerts.filter((a) => a.severity === 'critical').map((a) => a.id), ['shp2-below-reserve', 'shp2-pool-out'], 'both critical; this alarm is emitted last');
  // What the broadcast NAMES FROM is not the alert set: the reserve alarm is spoken by its own announcer and is left out.
  assert.deepEqual(conditionNamePool(alerts).filter((a) => a.severity === 'critical').map((a) => a.id), ['shp2-pool-out'], '★ "Backup at or below reserve" is not a candidate of the condition message');
  assert.deepEqual([conditionFromAlerts(alerts).level, conditionFromAlerts(alerts).crit], ['red', 1]);
  assert.equal(pickPrimaryAlert(conditionNamePool(alerts), 'red')?.id, 'shp2-pool-out', 'the only candidate is the one named');

  // Beside any OTHER critical it yields, whatever the category and whichever comes first in the array. Without the
  // clause an SHP2 alert outranks Grid, Thermal and Connectivity, and a pool-out standing for days would keep each of
  // them from ever being named aloud — "Reserve alarm blind" among them.
  const [pool] = poolOut(alerts);
  const beside = (category: string, extra: Partial<Alert> = {}): Alert => ({ id: `other-${category}`, severity: 'critical', category, device: 'Smart Home Panel 2', title: `Another ${category} critical`, detail: 'd', ...extra } as Alert);
  for (const category of ['Connectivity', 'Grid', 'Thermal', 'Solar', 'SHP2', 'Battery']) {
    const other = beside(category);
    for (const set of [[pool, other], [other, pool]]) {
      assert.equal(pickPrimaryAlert(conditionNamePool(set), 'red')?.id, other.id, `★ ${category}, ${set[0] === pool ? 'this alarm first' : 'this alarm last'}`);
    }
  }
  const blind = beside('Connectivity', { id: 'reserve-alarm-blind', title: 'Reserve alarm blind — off-grid' });
  assert.equal(pickPrimaryAlert(conditionNamePool([pool, blind]), 'red')?.id, 'reserve-alarm-blind', '★ "Reserve alarm blind" keeps the voice');
  // A secondary panel's alarm yields the same way, and so does a warning at yellow.
  assert.equal(pickPrimaryAlert([{ ...pool, id: `shp2-pool-out-${OTHER_PANEL}` }, blind], 'red')?.id, 'reserve-alarm-blind');
  const warn = { ...pool, severity: 'warning' as const };
  assert.equal(pickPrimaryAlert([warn, beside('Connectivity', { severity: 'warning' })], 'yellow')?.id, 'other-Connectivity');
  assert.equal(pickPrimaryAlert([warn], 'yellow')?.id, 'shp2-pool-out', 'alone at its level, it is named');
  // Control (passes without this release): among every OTHER pair nothing moved — SHP2 still outranks Connectivity.
  assert.equal(pickPrimaryAlert([beside('Connectivity'), beside('SHP2')], 'red')?.id, 'other-SHP2');
  assert.equal(pickPrimaryAlert([beside('Grid'), beside('Battery', { coreNum: 1 } as Partial<Alert>)], 'red')?.id, 'other-Battery');
});

test('★ what is spoken for a critical: the title and ONE short sentence of its own (two when the grid made it critical), in English and in Spanish', () => {
  const [a] = poolOut(computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10, { gridSta: 0 }) }), context(new Map([[PANEL_SN, CRITICAL]]))));
  assert.equal(buildAlertMessage('red', [a]),
    'Critical alarm. Critical alarm. Smart panel. Core out of the backup pool: slot 1. Backup capacity reads 61.4 of 92.2 kilowatt hours. No grid reported at 23:13. Acknowledge at console. Repeat. Critical alarm. Critical alarm. Core out of the backup pool: slot 1.');
  assert.equal(buildAlertMessageEs('red', [a]),
    'Alarma crítica. Alarma crítica. Panel inteligente. Core fuera del respaldo. Backup capacity reads 61.4 of 92.2 kilowatt hours. No grid reported at 23:13. Confirme en la consola. Repito. Alarma crítica. Alarma crítica. Core fuera del respaldo.');
  assert.doesNotMatch(buildAlertMessageEs('red', [a]), /Core out of the backup pool/, 'the Spanish pass does not read the English title');
  // The push and the card keep the WHOLE detail: only the voice reads the short sentence.
  assert.equal(a.detail, CRITICAL.detail);
  assert.equal(a.detail.startsWith("The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots. The panel reported no grid at 23:13."), true);
  // Control (passes without this release): an alert with no sentence of its own is spoken from the cut of its detail.
  const { spokenDetail: _own, ...plain } = a;
  void _own;
  assert.equal(buildAlertMessage('red', [plain as Alert]).includes("The panel's backup capacity reads 61.4 kilowatt hours: 30.7 kilowatt hours, the capacity of 1 slot, under the 92.2 kilowatt hours of its 3 slots. The panel reported no grid at 23:13."), true);
});

/* ── every shape the tracker can put in front of the voice, and how long each is ── */

const noGridObs = { grid: { present: false, presenceUnknown: false } };
const twoOut = (o: Record<string, unknown> = {}) => (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }], ...o });
const twoQuiet = (o: Record<string, unknown> = {}) => (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 60, slots: [0, 1, 2].map(() => ({ pct: 60, w: 0 })), ...o });
/** Slot 1 named out, then a second Core out that nothing names (capacity alone, for its own dwell): "slot 1 and one not identified". */
const ONE_NAMED: PoolOutState = fold(withEpisode(), minutes(11, 16, twoQuiet())).state;
const ONE_NAMED_NO_GRID: PoolOutState = fold(ONE_NAMED, minutes(27, 3, twoQuiet({ gridSta: 0 }), noGridObs)).state;
const allOut = (seq: number): Body => synthBody({ seq, capWh: 0, poolPct: 0, remainWh: 0, slots: [0, 1, 2].map(() => ({ pct: 60, w: 0 })) });
const lostNoGrid = (seq: number): Body => lostBody(seq, { gridSta: 0 });
const SHAPES: Array<[string, PoolOutState]> = [
  ['one Core, slot 1', withEpisode()],
  ['one Core, slot not identified', fold(withReference(quietBody), minutes(0, 20, quietLostBody)).state],
  ['two Cores, slots 1 and 3', fold(withReference(), minutes(0, 16, twoOut())).state],
  ['one Core, the grid absent', fold(withEpisode(), minutes(11, 3, lostNoGrid, noGridObs)).state],
  ['two Cores, the grid absent', fold(fold(withReference(), minutes(0, 16, twoOut())).state, minutes(16, 3, twoOut({ gridSta: 0 }), noGridObs)).state],
  ['every slot out', fold(withReference(), minutes(0, 20, allOut)).state],
  ['two Cores, slots not identified', fold(withReference(quietBody), minutes(0, 20, twoQuiet())).state],
  ['two Cores not identified, the grid absent', fold(fold(withReference(quietBody), minutes(0, 20, twoQuiet())).state, minutes(20, 3, twoQuiet({ gridSta: 0 }), noGridObs)).state],
  ['two Cores, one named', ONE_NAMED],
  ['two Cores, one named, the grid absent', ONE_NAMED_NO_GRID],
  // The clear pending (the capacity whole again, the alarm standing until that has held), on one reading and on three.
  ['two Cores, one named, the grid absent, ONE whole reading', fold(ONE_NAMED_NO_GRID, minutes(30, 1, (seq) => healthyBody(seq, { gridSta: 0 }), noGridObs)).state],
  ['two Cores, one named, the grid absent, the clear pending', fold(ONE_NAMED_NO_GRID, minutes(30, 3, (seq) => healthyBody(seq, { gridSta: 0 }), noGridObs)).state],
  // The newest reading's capacity cannot be compared (it reads above the sum of the slots): the newest SHORT reading is said.
  ['one Core, the grid absent, the newest capacity not comparable', fold(fold(withEpisode(), minutes(11, 3, lostNoGrid, noGridObs)).state, minutes(14, 1, (seq) => lostBody(seq, { gridSta: 0, capWh: FULL_WH + 5000 }), noGridObs)).state],
];
/** The alert as computeAlerts emits it for one tracker state, and the English message the renderer hands the voice. */
function spokenFor(state: PoolOutState, nowMs: number): { alert: Alert; en: string; es: string } {
  const parts = poolOutAlertParts(state, { nowMs, timeZone: TZ })!;
  const [alert] = poolOut(computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10) }), context(new Map([[PANEL_SN, parts]])), GRID_PRESENT));
  const level = alert.severity === 'critical' ? 'red' : 'yellow';
  // audioRenderer.renderAnnouncement verbalizes the whole message once more before the engine (idempotent).
  return { alert, en: verbalizeForTts(buildAlertMessage(level, [alert])), es: buildAlertMessageEs(level, [alert]) };
}

test('★★★ the spoken sentence of every shape, word for word: what the panel reads, in the tense of the reading, and the grid when it made the alarm critical', () => {
  const said = Object.fromEntries(SHAPES.map(([name, state]) => [name, spokenFor(state, state.last!.atMs).alert.spokenDetail]));
  assert.deepEqual(said, {
    'one Core, slot 1': 'Backup capacity reads 61.4 of 92.2 kWh.',
    'one Core, slot not identified': 'Backup capacity reads 61.4 of 92.2 kWh.',
    'two Cores, slots 1 and 3': 'Backup capacity reads 30.7 of 92.2 kWh.',
    'one Core, the grid absent': 'Backup capacity reads 61.4 of 92.2 kWh. No grid reported at 23:13.',
    'two Cores, the grid absent': 'Backup capacity reads 30.7 of 92.2 kWh. No grid reported at 23:18.',
    'every slot out': 'Backup capacity reads 0.0 of 92.2 kWh.',
    'two Cores, slots not identified': 'Backup capacity reads 30.7 of 92.2 kWh.',
    'two Cores not identified, the grid absent': 'Backup capacity reads 30.7 of 92.2 kWh. No grid reported at 23:22.',
    'two Cores, one named': 'Backup capacity reads 30.7 of 92.2 kWh.',
    'two Cores, one named, the grid absent': 'Backup capacity reads 30.7 of 92.2 kWh. No grid reported at 23:29.',
    'two Cores, one named, the grid absent, ONE whole reading': 'Backup capacity read 92.2 of 92.2 kWh at 23:30. No grid reported at 23:29.',
    'two Cores, one named, the grid absent, the clear pending': 'Backup capacity has read 92.2 of 92.2 kWh since 23:30. No grid reported at 23:29.',
    'one Core, the grid absent, the newest capacity not comparable': 'Backup capacity read 61.4 of 92.2 kWh at 23:13. No grid reported at 23:13.',
  });
  // An episode restored with no newest reading: the newest SHORT reading on file, in the past tense.
  const ep = withEpisode();
  const restored = { ...structuredClone({ ...ep, proc: undefined }), proc: ep.proc, last: null } as unknown as PoolOutState;
  assert.equal(poolOutAlertParts(restored, { nowMs: at(12), timeZone: TZ })!.spoken, 'Backup capacity read 61.4 of 92.2 kWh at 23:10.');
  // A time on another day carries its day, as in the detail.
  const [, grid] = SHAPES[3];
  assert.equal(poolOutAlertParts(grid, { nowMs: at(13) + 30 * 3600_000, timeZone: TZ })!.spoken, 'Backup capacity reads 61.4 of 92.2 kWh. No grid reported at Sat 23:13.');
});

test('★★★ the spoken message of EVERY critical shape fits one spoken pass: at most 345 characters, said on any later day too (the detail\'s own lead ran them to 349–446)', () => {
  const MAX = (poolOutModule as Record<string, unknown>).POOL_OUT_SPOKEN_MESSAGE_MAX_CHARS as number;
  assert.equal(MAX, 345);
  // The measure behind the figure: 318 characters rendered in 12.8 to 13.9 s on the install it was measured on, a
  // change of voice costs about 1.5 s, and the first of two spoken passes has 17 s. At the slow end 345 take 16.6 s.
  assert.equal(MAX * (13.9 / 318) + 1.5 < 17, true);
  const lengths: Array<[string, string, number]> = [];
  for (const [name, state] of SHAPES) {
    for (const [day, nowMs] of [['the same day', state.last!.atMs], ['the next day', state.last!.atMs + 30 * 3600_000], ['eight days on', state.last!.atMs + 8 * 24 * 3600_000]] as Array<[string, number]>) {
      const { alert, en } = spokenFor(state, nowMs);
      if (alert.severity !== 'critical') continue;
      lengths.push([name, day, en.length]);
      assert.equal(en.length <= MAX, true, `${name}, ${day}: ${en.length} characters — ${en}`);
      assert.equal(en.endsWith(`Critical alarm. Critical alarm. ${alert.title}.`), true, 'control: the critical frame says the title twice');
    }
  }
  assert.equal(lengths.filter(([, day]) => day === 'the same day').length, 11, 'control: eleven of the thirteen shapes are critical');
  assert.equal(spokenFor(ONE_NAMED, ONE_NAMED.last!.atMs).alert.title, '2 Cores out of the backup pool: slot 1 and one not identified', 'control: the longest title is among them');
  // On the day of the alarm: 253 characters (two Cores, both named) to 327 (the longest title, "slot 1 and one not
  // identified", with the clear pending and the grid absent); the same one eight days on, both its times dated, is the
  // longest of all. The shapes of 2026-11-14 with the grid absent or a second Core out are 260 and 253.
  const sameDay = lengths.filter(([, day]) => day === 'the same day').map(([, , n]) => n).sort((x, y) => x - y);
  assert.deepEqual([sameDay[0], sameDay[sameDay.length - 1]], [253, 327]);
  assert.equal(Math.max(...lengths.map(([, , n]) => n)), 341);
  assert.deepEqual(lengths.filter(([name, day]) => day === 'the same day' && /^(one Core, the grid absent|two Cores, slots 1 and 3)$/.test(name)).map(([, , n]) => n), [253, 260]);
  // Control: the SAME shapes spoken from the cut of the detail (as every other alert is) do not fit.
  const fromDetail = SHAPES.map(([, state]) => {
    const { alert } = spokenFor(state, state.last!.atMs);
    const { spokenDetail: _own, ...plain } = alert;
    void _own;
    return alert.severity === 'critical' ? verbalizeForTts(buildAlertMessage('red', [plain as Alert])).length : 0;
  });
  assert.equal(Math.max(...fromDetail) > 400, true, `control: ${Math.max(...fromDetail)} characters from the detail's lead`);
  assert.equal(fromDetail.filter((n) => n > MAX).length >= 9, true, 'control: nine or more of the shapes ran over');
});

test('★★ the Spanish title says how many: "Core fuera del respaldo" for one, the latched count in front of the plural for two or three', () => {
  const titleEs = (state: PoolOutState): string => /Panel inteligente\. ([^.]*)\./.exec(spokenFor(state, state.last!.atMs).es)![1];
  const by = Object.fromEntries(SHAPES.map(([name, state]) => [name, titleEs(state)]));
  assert.equal(by['one Core, slot 1'], 'Core fuera del respaldo');
  assert.equal(by['one Core, slot not identified'], 'Core fuera del respaldo');
  assert.equal(by['one Core, the grid absent'], 'Core fuera del respaldo');
  assert.equal(by['two Cores, slots 1 and 3'], '2 Cores fuera del respaldo');
  assert.equal(by['two Cores, slots not identified'], '2 Cores fuera del respaldo', 'the count is the fault token\'s, named or not');
  assert.equal(by['two Cores, one named'], '2 Cores fuera del respaldo');
  assert.equal(by['every slot out'], '3 Cores fuera del respaldo');
  // The repeat says the same title.
  const es = spokenFor(SHAPES[2][1], SHAPES[2][1].last!.atMs).es;
  assert.equal(es.endsWith('Repito. Alarma crítica. Alarma crítica. 2 Cores fuera del respaldo.'), true, es);
  // A secondary panel's alarm too; an alert of another family with a count-shaped token keeps its own title.
  const [a] = poolOut(computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10) }), context(new Map([[PANEL_SN, poolOutAlertParts(SHAPES[2][1], { nowMs: at(15), timeZone: TZ })!]])), GRID_PRESENT));
  assert.match(buildAlertMessageEs('red', [{ ...a, id: `shp2-pool-out-${OTHER_PANEL}` }]), /Panel inteligente\. 2 Cores fuera del respaldo\./);
  assert.match(buildAlertMessageEs('red', [{ ...a, id: 'shp2-src-err-1', fault: 'out:1+3;k=2' }]), /Panel inteligente\. Error en una fuente de energía\./);
  assert.match(buildAlertMessageEs('red', [{ ...a, fault: undefined }]), /Panel inteligente\. Core fuera del respaldo\./, 'no token: the plain title');
});

test('★ only THIS alert yields the voice: an id that merely starts with the same letters is ranked as any other', () => {
  const crit = (id: string, category: string): Alert => ({ id, severity: 'critical', category, device: 'Smart Home Panel 2', title: id, detail: 'd' } as Alert);
  const grid = crit('grid-thing', 'Grid');
  // The house panel's id and a secondary panel's yield to a Grid critical…
  assert.equal(pickPrimaryAlert([crit('shp2-pool-out', 'SHP2'), grid], 'red')?.id, 'grid-thing');
  assert.equal(pickPrimaryAlert([crit(`shp2-pool-out-${OTHER_PANEL}`, 'SHP2'), grid], 'red')?.id, 'grid-thing');
  // …and another SHP2 family whose id only begins the same way does not: SHP2 outranks Grid, as ever.
  for (const id of ['shp2-pool-outage', 'shp2-pool-outlet-2', 'shp2-pool-out2']) {
    assert.equal(pickPrimaryAlert([crit(id, 'SHP2'), grid], 'red')?.id, id, id);
    assert.equal(pickPrimaryAlert([grid, crit(id, 'SHP2')], 'red')?.id, id, id);
  }
});

test('★★ one panel\'s entry that cannot be read costs that one alarm, never the alert set: every other alert, and the other panel\'s alarm, are emitted', () => {
  const devices = devicesOf({ [PANEL_SN]: lostBody(10, { poolPct: 12 }), [OTHER_PANEL]: lostBody(11) }, { house: PANEL_SN });
  const broken = new Map<string, any>([[PANEL_SN, null], [OTHER_PANEL, WARNING]]);
  let alerts: Alert[] = [];
  assert.doesNotThrow(() => { alerts = computeAlerts(devices, context(broken as any), undefined, () => GRID_PRESENT); });
  assert.deepEqual(poolOut(alerts).map((a) => a.id), [`shp2-pool-out-${OTHER_PANEL}`], '★ the readable panel\'s alarm stands');
  assert.equal(alerts.some((a) => a.id === 'shp2-below-reserve'), true, '★ and so does the reserve alarm of the panel whose entry could not be read');
});

/* ══ the family ═════════════════════════════════════════════════════════════════════════════════════ */

function stats(over: Partial<AlertActionStats>): AlertActionStats {
  return {
    familyKey: 'fam', alertId: 'fam-x', title: 'Fam', severity: 'warning', category: 'SHP2',
    riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
    downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
    neverClearedCount: 0, lastSeenAt: null,
    ...over,
  };
}

test('★★★ the family is never auto-silenced: ten episodes that each stood for hours are exactly what the chronic-noise rule calls noise', () => {
  assert.equal(ENERGY_STATE_FAMILIES.has('shp2-pool-out'), true);
  assert.equal(ENERGY_STATE_FAMILIES.has(familyOf(`shp2-pool-out-${OTHER_PANEL}`)), true, 'a secondary panel\'s id is the same family');
  for (const counters of [
    { riseCount: 10, neverClearedCount: 10 }, // every episode long-standing: Rule 3
    { riseCount: 20, shortClearsCount: 17 }, // a Core that flaps: Rule 2
    { riseCount: 200, shortClearsCount: 100, neverClearedCount: 10 }, // Rule 4
  ]) {
    const mine = stats({ familyKey: 'shp2-pool-out', alertId: 'shp2-pool-out', ...counters });
    assert.deepEqual(applySilencingRules(mine), [], JSON.stringify(counters));
    assert.deepEqual([mine.downgradedSilenced, mine.warningDemotedToInfo, mine.chronicNoiseSilenced], [false, false, false], JSON.stringify(counters));
    // Control (passes without this release): the same counters on a family that is not listed ARE silenced or demoted.
    const other = stats({ familyKey: 'shp2-src-hw', alertId: 'shp2-src-hw-1', ...counters });
    assert.equal(applySilencingRules(other).length > 0, true, `control ${JSON.stringify(counters)}`);
  }
});

test('★ the id is device-derived (re-tracked across a restart, held while the device list is empty) and never shelved by a maintenance window', () => {
  for (const id of ['shp2-pool-out', `shp2-pool-out-${OTHER_PANEL}`]) {
    assert.equal(isDeviceDerivedAlertId(id), true, id);
    assert.equal(MAINTENANCE_SHELVABLE_PREFIXES.some((p) => id.startsWith(p)), false, `${id}: a window on a Core never holds the pool's alarm`);
  }
});

test('★★★ `sourceSn` is the panel: a vanish is held while that panel is offline or has no fresh data (the id names no device)', () => {
  const now = Date.now();
  const base = { id: 'shp2-pool-out', deviceSns: [PANEL_SN], nowMs: now };
  const fresh = { [PANEL_SN]: { online: true, lastUpdated: now - 30_000 } };
  assert.equal(fallingEdgeFrozenByEvidence({ ...base, devices: fresh, sourceSn: PANEL_SN }), false, 'a fresh panel: the vanish is evidence');
  assert.equal(fallingEdgeFrozenByEvidence({ ...base, devices: { [PANEL_SN]: { online: false, lastUpdated: now - 30_000 } }, sourceSn: PANEL_SN }), true, '★ offline: held');
  assert.equal(fallingEdgeFrozenByEvidence({ ...base, devices: { [PANEL_SN]: { online: true, lastUpdated: now - 6 * 60_000 } }, sourceSn: PANEL_SN }), true, '★ no data for six minutes: held');
  assert.equal(fallingEdgeFrozenByEvidence({ ...base, devices: { [PANEL_SN]: { online: false, lastUpdated: 0 } } }), false, 'control: without the declared source the id alone names no device, and nothing is held');
});

test('★ neither a standing alarm nor a streak on its way to one is a pending onset: it never keeps the alert set from settling', () => {
  // Every entry of debouncedOnsetsPending is bounded by a clock; a streak held by contradicting readings is not. A
  // restored alarm is in the set at the first pass, so nothing is withheld that the rule would have to announce.
  const now = Date.now();
  assert.deepEqual(debouncedOnsetsPending(context(new Map([[PANEL_SN, WARNING]])), now, devicesOf({ [PANEL_SN]: lostBody(10) })), [], 'a standing alarm');
  // A STREAK reaches the rule through nothing: what the monitor puts in the context is the store's poolOutAlerts, and
  // a panel with a streak and no alarm has no entry there. (The first assertion could not fail for a streak: it never
  // had one in its context.)
  const store = new SnapshotStore({ poolOutPath: null, poolEventsDir: null });
  let clock = 0;
  store.setClock(() => clock);
  store.setDeviceList([{ sn: PANEL_SN, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: 1 }] as any);
  for (let m = -15; m < 3; m++) { clock = at(m); store.setDeviceQuota(PANEL_SN, m < 0 ? healthyBody(m) : lostBody(m)); }
  assert.equal(store.poolRecord(PANEL_SN).state?.streak?.counted, 3, 'control: a streak stands');
  assert.equal(store.poolOutAlerts(clock).size, 0, '★ and the context field is empty for it');
  assert.deepEqual(debouncedOnsetsPending(context(store.poolOutAlerts(clock)), clock, store.get().devices), []);
  // The rule's own source names nothing of this alarm.
  const src = readFileSync(new URL('../src/alerts.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function debouncedOnsetsPending('), src.indexOf('\n}\n', src.indexOf('export function debouncedOnsetsPending(')));
  assert.equal(body.length > 200 && !/poolOut/i.test(body), true);
});

/* ══ the quiet-hours push ═══════════════════════════════════════════════════════════════════════════ */

test('★★★ the flag is the delivery function\'s answer for the quiet hours, at both severities — and no other alert carries it', () => {
  for (const parts of [WARNING, CRITICAL]) {
    const [a] = poolOut(computeAlerts(devicesOf({ [PANEL_SN]: lostBody(10) }), context(new Map([[PANEL_SN, parts]])), GRID_PRESENT));
    assert.equal(a.pushInQuietHours === true, poolOutDelivery(parts.severity, true).pushNow, parts.severity);
    assert.equal(a.pushInQuietHours, true, `${parts.severity}: the build default pushes at any hour`);
  }
  // A set with the reserve pair, a source error and a source link issue beside it: only this alert is flagged.
  const busy = devicesOf({ [PANEL_SN]: lostBody(10, { poolPct: 12, slots: [{ pct: 72, w: 0, errorCodeNum: 533 }, { pct: 65, w: -1107, hwConnect: 0 }, { pct: 63, w: -1061 }] }) });
  const alerts = computeAlerts(busy, context(new Map([[PANEL_SN, WARNING]])));
  assert.ok(alerts.length >= 4, alerts.map((a) => a.id).join(' '));
  assert.deepEqual(alerts.filter((a) => a.pushInQuietHours != null).map((a) => a.id), ['shp2-pool-out']);
});

test('★★★ in quiet hours the flag dispatches where every other warning — and, by default, every critical — is queued', () => {
  const quiet = { qualifies: true, alreadyNotified: false, alreadyQueued: false, escalated: false, debounceElapsed: true, inQuiet: true };
  assert.equal(decideAlertDispatch({ ...quiet, breaksThrough: false }), 'queue', 'control: held for the morning digest');
  assert.equal(decideAlertDispatch({ ...quiet, breaksThrough: true }), 'dispatch');
  // The monitor reads the alert's own flag in three places, each a way an alert is kept from being pushed at once:
  // the quiet hours, the push debounce, and the hold after a send that failed. alerts.ts is its only writer.
  const monitor = readFileSync(new URL('../src/alertMonitor.ts', import.meta.url), 'utf8');
  assert.equal(monitor.includes("      const breaksThrough = (a.severity === 'critical' && CRITICAL_BREAKS_QUIET) || a.pushInQuietHours === true;"), true, 'the quiet hours');
  assert.equal(monitor.includes("      const debounceMs = a.severity === 'critical' || a.pushInQuietHours === true ? 0 : notifyDebounceMsFor(a);"), true, 'the push debounce');
  assert.equal(monitor.includes('        alreadyQueued: existing.queued === true && (a.pushInQuietHours !== true || waitingToRetry),'), true, 'the hold after a failed send, and the wait before the next try');
  assert.equal(monitor.includes('        escalated: escalated && !waitingToRetry,'), true, 'the same wait for an escalation whose send failed');
  // The other reads follow from that one and decide nothing about WHETHER it is pushed: the hold for the digest said
  // once, the wait set at a failure, the queue entry dropped at a delivery, the digest leaving its push owed, and the
  // failure line's wording.
  assert.equal(monitor.includes('        const heldBefore = existing.queued === true && a.pushInQuietHours === true;'), true);
  assert.deepEqual(monitor.split('\n').filter((l) => /\b(a|qa|alert)\.pushInQuietHours\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).map((l) => l.trim()), [
    ": alert.pushInQuietHours === true ? `it will be tried again, after ${PUSH_RETRY_FIRST_MS / 1000} s and then at doubling waits up to ${PUSH_RETRY_MAX_MS / 60_000} min`",
    'if (qa.pushInQuietHours === true) {',
    "const debounceMs = a.severity === 'critical' || a.pushInQuietHours === true ? 0 : notifyDebounceMsFor(a);",
    "const breaksThrough = (a.severity === 'critical' && CRITICAL_BREAKS_QUIET) || a.pushInQuietHours === true;",
    'const waitingToRetry = a.pushInQuietHours === true && now < (existing.retryAtMs ?? 0);',
    'alreadyQueued: existing.queued === true && (a.pushInQuietHours !== true || waitingToRetry),',
    'const heldBefore = existing.queued === true && a.pushInQuietHours === true;',
    'if (a.pushInQuietHours === true) { existing.failedSends = (existing.failedSends ?? 0) + 1; existing.retryAtMs = now + pushRetryDelayMs(existing.failedSends); }',
    'if (a.pushInQuietHours === true) dropDeliveredHold(existing, a.id);',
  ], 'and no other read');
  // A failed send leaves the alert held for the digest (`queued`); for every other alert that hold ends its retries.
  const held = { qualifies: true, alreadyNotified: false, escalated: false, debounceElapsed: true, inQuiet: true, breaksThrough: true };
  assert.equal(decideAlertDispatch({ ...held, alreadyQueued: true }), 'none', 'control: a held alert is not tried again');
  assert.equal(decideAlertDispatch({ ...held, alreadyQueued: false }), 'dispatch', '★ this alarm is "already queued" only while it waits out its retry, so a later pass sends it');
  const producers = readFileSync(new URL('../src/alerts.ts', import.meta.url), 'utf8');
  assert.equal(producers.split('pushInQuietHours: true').length - 1, 1, 'one producer');
  assert.equal(producers.includes('...(poolOutDelivery(parts.severity, true).pushNow ? { pushInQuietHours: true } : {}),'), true, 'and it asks the delivery function');
});

/* ══ the boot orphan hold ═══════════════════════════════════════════════════════════════════════════ */

test('★★★ the orphan hold: a pool-out id is unevaluable until ITS panel\'s tracker has raised or seen a full clear dwell in this process', () => {
  const asked: string[] = [];
  const released = (answer: boolean) => (sn: string): boolean => { asked.push(sn); return answer; };
  assert.equal(poolOutOrphanHeld('shp2-pool-out', PANEL_SN, released(false)), true, '★ held');
  assert.equal(poolOutOrphanHeld('shp2-pool-out', PANEL_SN, released(true)), false, 'released');
  assert.equal(poolOutOrphanHeld(`shp2-pool-out-${OTHER_PANEL}`, OTHER_PANEL, released(false)), true);
  assert.equal(poolOutOrphanHeld(`shp2-pool-out-${OTHER_PANEL}`, undefined, released(true)), false, 'a secondary panel\'s id names its panel when the record does not');
  assert.deepEqual(asked, [PANEL_SN, PANEL_SN, OTHER_PANEL, OTHER_PANEL], 'the tracker asked is the alert\'s own panel');
  assert.equal(poolOutOrphanHeld('shp2-pool-out', undefined, released(true)), true, '★ no panel on record and none in the id: held, never resolved blind');
  // Every other id: not this rule's business (it adds no hold and asks no tracker).
  for (const id of ['shp2-below-reserve', 'shp2-src-err-1', 'reserve-alarm-blind', 'shp2-pool-outage', 'shp2-pool']) {
    assert.equal(poolOutOrphanHeld(id, PANEL_SN, () => { throw new Error('not asked'); }), false, id);
  }
  const monitor = readFileSync(new URL('../src/alertMonitor.ts', import.meta.url), 'utf8');
  assert.equal(monitor.includes('        }) || heldForHydration(id) || poolOutOrphanHeld(id, rec.sourceSn, (sn) => store.poolOutOrphanReleased(sn, rec.ts)),'), true, 'the boot sweep\'s unevaluable leg reads it, and asks with the time of the push it would resolve');
});

/* ══ a push that failed, and an alarm raised again ══════════════════════════════════════════════════ */

test('★★ the wait before the next try of a push that failed: 20 s, doubling, never more than 10 minutes', () => {
  const delay = (monitorModule as Record<string, unknown>).pushRetryDelayMs as (failedSends: number) => number;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50, 5000].map(delay), [20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000, 600_000]);
  assert.equal(delay(0), 20_000, 'never less than the first wait');
  // A channel down for a day: 6 tries in the first 21 minutes, then one every 10 — not one every 20 seconds (4,320).
  let t = 0;
  let tries = 0;
  for (let n = 1; t < 24 * 3600_000; n++) { t += delay(n); tries += 1; }
  assert.equal(tries, 148);
});

test('★★★ the notification on record is an EARLIER episode\'s when the tracker holds an end at or after it: only for this alert, only with its panel', () => {
  const endedAt = (monitorModule as Record<string, unknown>).poolOutEndedEpisodeAt as (a: { id: string; sourceSn?: string }, rec: { ts: number } | undefined, endedSince: (sn: string, pushedAtMs: number) => number | null) => number | null;
  const asked: Array<[string, number]> = [];
  const store = (answer: number | null) => (sn: string, pushedAtMs: number): number | null => { asked.push([sn, pushedAtMs]); return answer; };
  assert.equal(endedAt({ id: 'shp2-pool-out', sourceSn: PANEL_SN }, { ts: at(10) }, store(at(23))), at(23), '★ the alarm pushed at 23:10 ended at 23:23: the one standing is new');
  assert.equal(endedAt({ id: `shp2-pool-out-${OTHER_PANEL}`, sourceSn: OTHER_PANEL }, { ts: at(10) }, store(at(23))), at(23));
  assert.deepEqual(asked, [[PANEL_SN, at(10)], [OTHER_PANEL, at(10)]], 'the store is asked for THAT panel, with the time of the push on record');
  assert.equal(endedAt({ id: 'shp2-pool-out', sourceSn: PANEL_SN }, { ts: at(10) }, store(null)), null, 'no end on file: the record is this alarm\'s own');
  const never = (): number | null => { throw new Error('not asked'); };
  assert.equal(endedAt({ id: 'shp2-pool-out', sourceSn: PANEL_SN }, undefined, never), null, 'nothing on record');
  assert.equal(endedAt({ id: 'shp2-pool-out' }, { ts: at(10) }, never), null, 'no panel to ask');
  for (const id of ['shp2-below-reserve', 'shp2-src-hw-1', 'shp2-pool-outage', 'reserve-alarm-blind']) {
    assert.equal(endedAt({ id, sourceSn: PANEL_SN }, { ts: at(10) }, never), null, `${id}: its record is untouched`);
  }
});

/* ══ a restart between the raise and its push ═══════════════════════════════════════════════════════ */

test('★★★ at the first pass after a restart a restored pool-out alarm is taken as announced ONLY on a delivery record: with none, it is still owed its push', () => {
  // The store restores a standing episode from its own file, so "standing at boot" does not mean "pushed before the
  // restart": a restart inside the monitor's push debounce leaves the episode on file and no notification anywhere.
  for (const id of ['shp2-pool-out', `shp2-pool-out-${OTHER_PANEL}`]) {
    for (const severity of ['warning', 'critical'] as const) {
      assert.equal(bootSeedNotified({ alert: { id, severity }, firstRun: true, alreadyNotified: false }), false, `★ ${id} ${severity}: no record, not seeded — the next pass dispatches it`);
      assert.equal(bootSeedNotified({ alert: { id, severity }, firstRun: true, alreadyNotified: true }), true, `${id} ${severity}: a record on file — not pushed again`);
      assert.equal(bootSeedNotified({ alert: { id, severity }, firstRun: false, alreadyNotified: false }), false, `${id} ${severity}: a rise in steady state is not seeded either`);
    }
  }
  // Control (passes without this release): every other warning standing at the first pass IS seeded as announced, and a
  // near-miss id is not this rule's business.
  for (const id of ['shp2-src-hw-1', 'shp2-near-reserve', 'shp2-pool-outage', 'shp2-pool']) {
    assert.equal(bootSeedNotified({ alert: { id, severity: 'warning' }, firstRun: true, alreadyNotified: false }), true, `control ${id}`);
  }
});

/* ══ the return notice and the grid verdict ═════════════════════════════════════════════════════════ */

test('★★★ the return notice replaces the resolve text for this id and for no other; with no end on record the usual text stands', () => {
  const notice = { title: 'Core back in the backup pool: slot 1', body: 'The panel\'s backup capacity has read 92.2 kWh…' };
  const asked: string[] = [];
  const end = (sn: string) => { asked.push(sn); return notice; };
  assert.deepEqual(poolOutResolveText({ id: 'shp2-pool-out', sourceSn: PANEL_SN }, end), notice);
  assert.deepEqual(poolOutResolveText({ id: `shp2-pool-out-${OTHER_PANEL}`, sourceSn: OTHER_PANEL }, end), notice);
  assert.deepEqual(asked, [PANEL_SN, OTHER_PANEL]);
  assert.equal(poolOutResolveText({ id: 'shp2-pool-out', sourceSn: PANEL_SN }, () => null), null, 'no end record: the monitor\'s own "(condition cleared)" text');
  assert.equal(poolOutResolveText({ id: 'shp2-pool-out' }, end), null);
  for (const id of ['shp2-below-reserve', 'backup-soc-20', 'shp2-src-err-1', 'forecast-runtime', 'shp2-pool-outage']) {
    assert.equal(poolOutResolveText({ id, sourceSn: PANEL_SN }, () => { throw new Error('not asked'); }), null, `${id}: its resolve text is untouched`);
  }
});

test('★★★ the grid verdict is handed to the tracker as the resolver gave it: "nothing can be heard" stays unknown, never absent', () => {
  assert.deepEqual(poolOutGridVerdict({ present: false, presenceUnknown: true }), { present: false, presenceUnknown: true });
  assert.deepEqual(poolOutGridVerdict({ present: false, presenceUnknown: false }), { present: false, presenceUnknown: false });
  assert.deepEqual(poolOutGridVerdict({ present: true, presenceUnknown: false }), { present: true, presenceUnknown: false });
  // Extra fields of the resolver's verdict do not travel.
  assert.deepEqual(Object.keys(poolOutGridVerdict({ present: true, presenceUnknown: false, backstopping: true } as any)).sort(), ['presenceUnknown', 'present']);
});
