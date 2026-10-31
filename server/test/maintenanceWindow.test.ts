/**
 * v1.197.0 — the per-Core maintenance window (maintenanceWindow.ts): one Core's own alerts held for a
 * set time (no push, no broadcast); every pool, panel and plant-level alarm still sounds.
 *
 * On 2026-08-20 the reconfiguration of two Cores produced 42 pushes and 7 broadcasts, three of them
 * red. The only runtime lever was the Alert Settings per-priority switch, which applies to the whole
 * plant (the battery-level ladder and the runway included) and never expires.
 *
 * Every time below is site-local on 2026-10-30 at UTC−7 and injected; fixture serials are masked.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Alert } from '../src/alerts.js';
import { MUTE_REASON_MAINTENANCE, MUTE_REASON_BENCH_SPARE, deviceGapAlertId } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import {
  MAINTENANCE_SHELVABLE_PREFIXES, MAINT_MAX_MS, MAINT_MIN_MS, MAINT_DEFAULT_MS, MAINT_RETURN_DWELL_MS, MAINT_CHOICES_MIN,
  alertNamesDevice, isShelvable, applyMaintenanceMute, validateStart, stepMaintenance, loadMaintenance, saveMaintenance,
  deviceGapStartMs, renderStartPush, renderEndPush, cleanNote, createMaintenanceController, windowsOnCores, isCoreDevice,
  guardHomeSet, heldUnpushed, lapseReason, STILL_SOUNDS,
  type MaintenanceWindow, type MaintenanceAuditEntry, type DeviceObs,
} from '../src/maintenanceWindow.js';
import { allClearSpeechBlocked, conditionFromAlerts } from '../src/broadcast.js';
import { TELEMETRY_BLIND_ALERT_ID } from '../src/telemetryBlind.js';
import type { NotifyMessage } from '../src/notify.js';

const TMP = mkdtempSync(join(tmpdir(), 'ef-maint-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const C1 = 'COREXXX00XXX0001';
const C2 = 'COREXXX00XXX0002';
const C3 = 'COREXXX00XXX0003';
const C4 = 'COREXXX00XXX0004'; // a bench Core (not on the panel roster)
const C5 = 'COREXXX00XXX0005';
const C31 = 'COREXXX00XXX00031'; // C3's serial is a prefix of this one
const P1 = 'PANEXXX00XXX0001';
const P2 = 'PANEXXX00XXX0002';

const MIN = 60_000;
const H = 3_600_000;
/** Site-local wall time on 2026-10-30 (UTC−7). */
const T = (h: number, m = 0, s = 0): number => Date.UTC(2026, 9, 30, h + 7, m, s);
const hm = (ms: number): string => new Date(ms - 7 * H).toISOString().slice(11, 16);

function core(sn: string, n: number, over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return { sn, deviceName: `Core ${n}`, productName: 'DELTA Pro Ultra', online: true, lastUpdated: T(10), projection: { kind: 'dpu', packs: [] }, ...over } as unknown as DeviceSnapshot;
}
function panel(sn: string): DeviceSnapshot {
  return { sn, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: T(10), projection: { kind: 'shp2', sources: [] } } as unknown as DeviceSnapshot;
}
const DEVICES: Record<string, DeviceSnapshot> = {
  [C1]: core(C1, 1), [C2]: core(C2, 2), [C3]: core(C3, 3), [C4]: core(C4, 4), [C5]: core(C5, 5), [C31]: core(C31, 31), [P1]: panel(P1),
};
const HOME = new Set([C1, C2, C3, C5]);

const al = (id: string, severity: Alert['severity'] = 'warning', over: Partial<Alert> = {}): Alert =>
  ({ id, severity, category: 'Battery', device: 'x', title: id, detail: 'x', ...over });

function startOk(o: Partial<Parameters<typeof validateStart>[0]> = {}): MaintenanceWindow {
  const r = validateStart({
    sn: C3, durationMs: 120 * MIN, nowMs: T(10), source: 'web', devices: DEVICES, windows: [], homePoolSns: HOME, alerts: [], ...o,
  });
  assert.ok(r.ok, JSON.stringify(r));
  return r.window;
}

/* ══ (1) validateStart ══════════════════════════════════════════════════════════════════════ */

test('★★★ limits: 15 min to 4 h, 2 h by default; the card offers 30 min, 1 h, 2 h and 4 h', () => {
  assert.equal(MAINT_MIN_MS, 15 * MIN);
  assert.equal(MAINT_MAX_MS, 4 * H, 'the hard limit of one window');
  assert.equal(MAINT_DEFAULT_MS, 2 * H);
  assert.deepEqual(MAINT_CHOICES_MIN, [30, 60, 120, 240]);
  assert.equal(MAINT_RETURN_DWELL_MS, 15 * MIN);
});

test('★★★ validateStart: Core 3 for 120 min at 10:00:00 is shelved until 12:00:00', () => {
  const w = startOk();
  assert.equal(w.sn, C3);
  assert.equal(w.label, 'Core 3');
  assert.equal(w.coreNum, 3);
  assert.equal(w.startedAtMs, T(10));
  assert.equal(w.untilMs, T(12));
  assert.equal(w.source, 'web');
  assert.equal(w.endedAtMs, undefined);
});

test('★★★ validateStart refuses, never clamps: the panel, an unknown serial, over 4 h, under 15 min', () => {
  const v = (o: Partial<Parameters<typeof validateStart>[0]>) => validateStart({
    sn: C3, durationMs: 120 * MIN, nowMs: T(10), source: 'api', devices: DEVICES, windows: [], homePoolSns: HOME, alerts: [], ...o,
  });
  const panelR = v({ sn: P1 });
  assert.deepEqual(panelR, { ok: false, code: 400, error: 'only a Core can be shelved; the panel carries the pool alarms' });
  assert.deepEqual(v({ sn: 'COREXXX00XXX0099' }), { ok: false, code: 404, error: 'unknown device' });
  assert.equal((v({ durationMs: 241 * MIN }) as { code: number }).code, 400, '4 h 1 min is refused');
  assert.equal((v({ durationMs: 300 * MIN }) as { code: number }).code, 400);
  assert.equal(v({ durationMs: 240 * MIN }).ok, true, 'exactly 4 h is accepted');
  assert.equal((v({ durationMs: 10 * MIN }) as { code: number }).code, 400);
  assert.equal((v({ durationMs: 15 * MIN - 1 }) as { code: number }).code, 400);
  assert.equal(v({ durationMs: 15 * MIN }).ok, true);
  assert.equal((v({ durationMs: Number.NaN }) as { code: number }).code, 400, 'a missing duration is refused');
});

test('★★★ an extension never passes the window start + 4 h; at the limit it is refused (409)', () => {
  const w = startOk(); // 10:00 → 12:00
  const ext = validateStart({ sn: C3, durationMs: 4 * H, nowMs: T(11, 30), source: 'web', devices: DEVICES, windows: [w], homePoolSns: HOME, alerts: [] });
  assert.ok(ext.ok && ext.extended);
  assert.equal(ext.window.untilMs, T(14), 'min(11:30 + 4 h = 15:30, 10:00 + 4 h = 14:00) = 14:00');
  assert.equal(ext.window.startedAtMs, T(10), 'the start is kept');
  const again = validateStart({ sn: C3, durationMs: 2 * H, nowMs: T(13, 30), source: 'web', devices: DEVICES, windows: [ext.window], homePoolSns: HOME, alerts: [] });
  assert.equal(again.ok, false);
  assert.equal((again as { code: number }).code, 409, 'min(15:30, 14:00) = 14:00 is not after 14:00');
  assert.match((again as { error: string }).error, /^already shelved to its limit/);
  // v1.197.0 (review) — a request that would not move the end is refused with its own reason: the
  // window is NOT at its limit (12:00, limit 14:00), and an extension never shortens a window.
  const shorter = validateStart({ sn: C3, durationMs: 30 * MIN, nowMs: T(10, 30), source: 'web', devices: DEVICES, windows: [w], homePoolSns: HOME, alerts: [] });
  assert.deepEqual(shorter, { ok: false, code: 409, error: 'already shelved for longer than that; an extension only moves the end later (end it to finish sooner)' });
  // A NEW window once the old one is over.
  const over = { ...ext.window, endedAtMs: T(14), endReason: 'expired' as const };
  const fresh = validateStart({ sn: C3, durationMs: 2 * H, nowMs: T(14, 5), source: 'web', devices: DEVICES, windows: [over], homePoolSns: HOME, alerts: [] });
  assert.ok(fresh.ok && !fresh.extended, 'a new window after the last one ended');
  assert.equal(fresh.window.untilMs, T(16, 5));
});

test('★★ the home pool keeps one Core with its alarms; a bench Core and a one-Core plant are not limited', () => {
  const pool = new Set([C1, C2, C5]);
  const ws = [startOk({ sn: C1 }), startOk({ sn: C2 })];
  const r = validateStart({ sn: C5, durationMs: 60 * MIN, nowMs: T(10, 30), source: 'web', devices: DEVICES, windows: ws, homePoolSns: pool, alerts: [] });
  assert.deepEqual(r, { ok: false, code: 409, error: 'every other home Core is shelved; at least one keeps its alarms' });
  assert.equal(validateStart({ sn: C4, durationMs: 60 * MIN, nowMs: T(10, 30), source: 'web', devices: DEVICES, windows: ws, homePoolSns: pool, alerts: [] }).ok, true, 'a bench Core');
  assert.equal(validateStart({ sn: C1, durationMs: 60 * MIN, nowMs: T(10), source: 'web', devices: DEVICES, windows: [], homePoolSns: new Set([C1]), alerts: [] }).ok, true,
    'a plant with one home Core can shelve it: its pool alarms still sound');
  // An ended window does not count as shelved.
  const ended = ws.map((w) => ({ ...w, endedAtMs: T(10, 20), endReason: 'ended-by-owner' as const }));
  assert.equal(validateStart({ sn: C5, durationMs: 60 * MIN, nowMs: T(10, 30), source: 'web', devices: DEVICES, windows: ended, homePoolSns: pool, alerts: [] }).ok, true);
});

test('★★★ the home-pool guard holds while the shelved Core is off the roster being re-wired (homeAtStart, guardHomeSet)', () => {
  // 10:00 Core 3 shelved, a home Core then.
  const w3 = startOk({ homePoolSns: new Set([C1, C3]) });
  assert.equal(w3.homeAtStart, true);
  // 10:05 Core 3 unplugged: the live roster reads {Core 1} alone.
  const r = validateStart({ sn: C1, durationMs: 120 * MIN, nowMs: T(10, 10), source: 'web', devices: DEVICES, windows: [w3], homePoolSns: new Set([C1]), alerts: [] });
  assert.deepEqual(r, { ok: false, code: 409, error: 'every other home Core is shelved; at least one keeps its alarms' },
    '★ the last home Core is not shelved because the other dropped off the roster');
  assert.equal(validateStart({ sn: C4, durationMs: 60 * MIN, nowMs: T(10, 10), source: 'web', devices: DEVICES, windows: [{ ...w3, homeAtStart: false }], homePoolSns: new Set([C1]), alerts: [] }).ok, true,
    'a Core shelved off the pool does not count');
  // The set the API passes: a Core a panel lists on a slot counts though the slot reads disconnected,
  // and so does the last-known roster.
  const panelWith = { ...panel(P1), projection: { kind: 'shp2', sources: [{ slot: 1, sn: C1, isConnected: false }, { slot: 3, sn: C3, isConnected: true }] } } as unknown as DeviceSnapshot;
  const devices = { ...DEVICES, [P1]: panelWith };
  assert.deepEqual([...guardHomeSet(devices, new Set([C3]), new Set([C5]))].sort(), [C1, C3, C5].sort());
  assert.equal(guardHomeSet(devices, new Set(), new Set()).has(C4), false, 'a bench Core no panel lists is not home');
  assert.equal(guardHomeSet(devices, new Set(), new Set()).has(P1), false, 'never the panel');
  // Core 1 momentarily off the roster while Core 3 is shelved: the guard still applies to it.
  const r2 = validateStart({ sn: C1, durationMs: 60 * MIN, nowMs: T(10, 10), source: 'web', devices, windows: [w3], homePoolSns: guardHomeSet(devices, new Set([C3]), new Set([C3])), alerts: [] });
  assert.equal((r2 as { code?: number }).code, 409, '★ a target off the live roster is still a home Core');
});

test('a note loses its control characters (ANSI escapes) and is at most 80 characters', () => {
  assert.equal(cleanNote('pack swap\u001b[31m slot 3\u0007'), 'pack swap [31m slot 3');
  assert.equal(cleanNote('x'.repeat(200))?.length, 80);
  assert.equal(cleanNote('   '), null);
  assert.equal(cleanNote(42), null);
  assert.equal(cleanNote('a\u009bb'), 'a b', 'C1 (an 8-bit CSI) too');
  assert.equal(startOk({ note: 'swap\u001b[2J pack 4' }).note, 'swap [2J pack 4');
});

test('the Core\'s own warning-or-above alerts standing at the start are its normal', () => {
  const w = startOk({ alerts: [al(`soh-warn-${C3}-2`), al(`balancing-${C3}-1`, 'info'), al(`soh-warn-${C1}-2`), al('backup-soc-15', 'critical')] });
  assert.deepEqual(w.standingAtStart, [`soh-warn-${C3}-2`]);
});

/* ══ (2) applyMaintenanceMute ═══════════════════════════════════════════════════════════════ */

const W3 = (): MaintenanceWindow => startOk(); // Core 3, 10:00–12:00

test('★★★ a shelved Core\'s own alerts are held: annunciate false, the maintenance reason, shelvedUntilMs = the end', () => {
  const ws = [W3()];
  const ids = [
    `vdiff-crit-${C3}-1`, `offline-${C3}`, `stale-${C3}`, `dpu-err-${C3}`, `peer-cellV-${C3}-2`, `soc-low-${C3}-4`,
    `msg-rate-floor-${C3}`, `soh-warn-${C3}-2`, `dpu-imbalance-${C3}`, `temp-cell-${C3}-1-warning`, deviceGapAlertId(C3, T(10, 5)),
  ];
  for (const id of ids) {
    const a = al(id, id.startsWith('vdiff-crit') || id.startsWith('dpu-err') ? 'critical' : 'warning',
      id.startsWith('vdiff-crit') ? { annunciate: false, mutedBy: 'balancing', muteReason: 'the BMS is balancing the cells' } : {});
    assert.equal(applyMaintenanceMute(a, ws, T(11))?.sn, C3, id);
    assert.equal(a.annunciate, false, id);
    assert.equal(a.muteReason, MUTE_REASON_MAINTENANCE, id);
    assert.equal(a.shelvedUntilMs, T(12), id);
    assert.equal(a.mutedBy, undefined, `${id}: the window is the mute in force`);
  }
});

test('★★★ never held: an overheating pack, a cell at the over-voltage line, a defective pack, another Core', () => {
  const ws = [W3()];
  const loud = [
    al(`temp-cell-${C3}-1-critical`, 'critical', { category: 'Thermal' }),
    al(`mppt-hv-temp-${C3}-critical`, 'critical', { category: 'Thermal' }),
    al(`cell-ovp-${C3}-1`, 'critical'),
    al(`pack-defective-${C3}-4`, 'warning'),
    al(`vdiff-crit-${C1}-1`, 'critical'),
  ];
  for (const a of loud) {
    assert.equal(applyMaintenanceMute(a, ws, T(11)), null, a.id);
    assert.equal(a.annunciate, undefined, a.id);
    assert.equal(a.shelvedUntilMs, undefined, a.id);
  }
});

test('★★★ never held: every pool, panel and plant-level alarm — even one the shelved Core causes', () => {
  const ws = [W3()];
  // v1.197.0 (review) — each fixture NAMES the shelved Core (its sourceSn, or its serial as an id
  // segment), so the family allowlist alone keeps it loud: a pool alarm that ever carried the Core's
  // identity must still sound.
  const pool = [
    al(`backup-soc-15-${C3}`, 'critical'), al('shp2-below-reserve', 'critical', { sourceSn: C3 }), al(`shp2-near-reserve-${C3}`),
    al(`forecast-runtime-${C3}`, 'critical'), al('reserve-alarm-blind', 'critical', { sourceSn: C3 }),
    al(TELEMETRY_BLIND_ALERT_ID, 'critical', { sourceSn: C3 }),
    al('shp2-src-err-3', 'critical', { sourceSn: C3 }), al('shp2-multi-panel', 'critical', { sourceSn: C3 }), al(`grid-offgrid-${C3}`, 'info'),
    al('shp2-src-hw-3', 'warning', { sourceSn: C3 }), al(`circuit-overload-4-${C3}`), al('peak-grid-draw', 'warning', { sourceSn: C3 }),
    al('host-temp-crit', 'critical', { sourceSn: C3 }), al(`cloud-session-stale-${C3}`), al(`storm-Tornado_Warning-${C3}`, 'critical'),
  ];
  for (const a of pool) {
    assert.equal(alertNamesDevice(a, C3), true, `${a.id}: the fixture names the shelved Core`);
    assert.equal(applyMaintenanceMute(a, ws, T(11)), null, a.id);
    assert.equal(a.annunciate, undefined, a.id);
    assert.equal(a.shelvedUntilMs, undefined, a.id);
  }
});

test('★★★ a FORGED window naming the second panel holds none of its pool alarms (the allowlist, not the serial)', () => {
  const forged: MaintenanceWindow = { ...W3(), sn: P2, label: 'Smart Home Panel 2' };
  for (const a of [
    al(`shp2-below-reserve-${P2}`, 'critical'), al(`backup-soc-10-${P2}`, 'critical'), al(`shp2-src-err-3-${P2}`, 'critical', { sourceSn: P2 }),
    al(`reserve-alarm-blind-${P2}`, 'critical'), al(`forecast-runtime-${P2}`, 'critical'), al(`shp2-near-reserve-${P2}`),
  ]) {
    assert.equal(applyMaintenanceMute(a, [forged], T(11)), null, a.id);
    assert.equal(a.annunciate, undefined, a.id);
  }
});

test('★★★ a window on anything but a Core is inert in the stamp (windowsOnCores): a panel\'s own offline alert stays loud', () => {
  const devices = { ...DEVICES, [P2]: panel(P2) };
  const forged: MaintenanceWindow = { ...W3(), sn: P2, label: 'Smart Home Panel 2' };
  assert.deepEqual(windowsOnCores([forged, W3()], devices).map((w) => w.sn), [C3], 'the panel window is dropped, the Core window kept');
  const a = al(`offline-${P2}`);
  assert.equal(applyMaintenanceMute(a, windowsOnCores([forged], devices), T(11)), null);
  assert.equal(a.annunciate, undefined);
  assert.deepEqual(windowsOnCores([W3()], {}), [], 'a Core missing from the map: nothing (the loud direction)');
  const unprojected = { [C3]: { sn: C3, deviceName: 'Core 3', productName: 'DELTA Pro Ultra', online: false, lastUpdated: 0 } as unknown as DeviceSnapshot };
  assert.equal(windowsOnCores([W3()], unprojected).length, 1, 'a Core not yet projected is still a Core, by its product');
  assert.equal(isCoreDevice(panel(P1)), false);
});

test('★★★ expiry and the limit are checked AT STAMP TIME: at 12:00:00 with no step, nothing is held', () => {
  const ws = [W3()];
  const a = () => al(`offline-${C3}`);
  assert.ok(applyMaintenanceMute(a(), ws, T(11, 59, 59)), '11:59:59 held');
  assert.equal(applyMaintenanceMute(a(), ws, T(12)), null, '★ 12:00:00 — the window is over even if its step never ran');
  assert.equal(applyMaintenanceMute(a(), ws, T(9, 58, 59)), null, 'before its start (beyond the clock tolerance)');
  assert.ok(applyMaintenanceMute(a(), ws, T(9, 59, 30)), 'within the 60 s clock tolerance');
  const forged = [{ ...W3(), untilMs: T(14) + 1 }]; // 4 h + 1 ms
  assert.equal(applyMaintenanceMute(a(), forged, T(11)), null, '★ a span over the limit holds nothing');
  const ended = [{ ...W3(), endedAtMs: T(10, 30), endReason: 'ended-by-owner' as const }];
  assert.equal(applyMaintenanceMute(a(), ended, T(11)), null, 'an ended window holds nothing (gaps aside)');
});

test('★★ a serial that is a prefix of another serial names only itself', () => {
  const ws = [W3()];
  assert.equal(alertNamesDevice({ id: `offline-${C31}` }, C3), false);
  assert.equal(applyMaintenanceMute(al(`offline-${C31}`), ws, T(11)), null);
  assert.equal(applyMaintenanceMute(al(`vdiff-crit-${C31}-1`, 'critical'), ws, T(11)), null);
  assert.equal(alertNamesDevice({ id: 'anything', sourceSn: C3 }, C3), true, 'or by sourceSn');
  assert.equal(alertNamesDevice({ id: `offline-${C3}` }, ''), false);
});

test('★★ a bench-spare policy mute is overridden for the window (the window is the mute in force)', () => {
  const a = al(`dpu-err-${C3}`, 'critical', { annunciate: false, muteReason: MUTE_REASON_BENCH_SPARE });
  assert.ok(applyMaintenanceMute(a, [W3()], T(11)));
  assert.equal(a.muteReason, MUTE_REASON_MAINTENANCE);
  assert.equal(a.shelvedUntilMs, T(12));
});

/* ══ broadcast: shelved is held, not cleared ════════════════════════════════════════════════ */

test('★★★ a shelved critical blocks "All clear" and does not raise the condition; a policy mute still does not block', () => {
  const shelved = { id: `vdiff-crit-${C3}-1`, severity: 'critical' as const, annunciate: false, shelvedUntilMs: T(12) };
  assert.equal(allClearSpeechBlocked([shelved]), true, '★ held, not cleared');
  const c = conditionFromAlerts([al(shelved.id, 'critical', { annunciate: false, shelvedUntilMs: T(12) })]);
  assert.equal(c.level, 'green', 'not counted: no klaxon for the shelved Core\'s own critical');
  assert.equal(allClearSpeechBlocked([{ id: `dpu-err-${C4}`, severity: 'critical', annunciate: false }]), false, 'a bench-spare mute: unchanged');
  assert.equal(allClearSpeechBlocked([{ id: `offline-${C3}`, severity: 'warning', annunciate: false, shelvedUntilMs: T(12) }]), false, 'a shelved warning does not');
});

/* ══ (3) stepMaintenance ════════════════════════════════════════════════════════════════════ */

const devs = (over: Partial<DeviceObs> = {}, now = T(10)): Record<string, DeviceObs> => ({ [C3]: { online: true, lastUpdated: now - 20_000, ...over }, [C1]: { online: true, lastUpdated: now } });
const SOH = al(`soh-warn-${C3}-2`);
const W3s = (): MaintenanceWindow => startOk({ alerts: [SOH] });

function run(steps: Array<{ at: number; alerts?: Alert[]; d?: Record<string, DeviceObs> | null }>, w0 = W3s()) {
  let ws: MaintenanceWindow[] = [w0];
  const ended: MaintenanceWindow[] = [];
  for (const s of steps) {
    const stamped = (s.alerts ?? [SOH]).map((a) => { const c = { ...a }; applyMaintenanceMute(c, ws, s.at); return c; });
    const r = stepMaintenance(ws, { alerts: stamped, devices: s.d === undefined ? devs({}, s.at) : s.d }, s.at);
    ws = r.windows;
    ended.push(...r.ended);
  }
  return { ws, ended };
}

test('★★★ returned to normal: offline at 10:05, back and fresh at 10:30 → still held at 10:44:59, ended at 10:45:00', () => {
  const r1 = run([{ at: T(10, 5), alerts: [SOH, al(`offline-${C3}`)], d: devs({ online: false, lastUpdated: T(9, 59) }, T(10, 5)) }]);
  assert.equal(r1.ws[0].abnormalSeenAtMs, T(10, 5));
  const steps = [
    { at: T(10, 5), alerts: [SOH, al(`offline-${C3}`)], d: devs({ online: false, lastUpdated: T(9, 59) }, T(10, 5)) },
    { at: T(10, 30) },
    { at: T(10, 44, 59) },
  ];
  const r2 = run(steps);
  assert.equal(r2.ws[0].normalSinceMs, T(10, 30), 'normal from 10:30 (the standing soh-warn is its normal)');
  assert.equal(r2.ended.length, 0, '10:44:59 still held');
  const r3 = run([...steps, { at: T(10, 45) }]);
  assert.equal(r3.ended.length, 1);
  assert.equal(r3.ended[0].endReason, 'returned-to-normal');
  assert.equal(r3.ended[0].endedAtMs, T(10, 45));
});

test('★★★ never abnormal: still held at 11:59:59, ended "expired" at 12:00 — a healthy Core is not released mid-job', () => {
  const r = run([{ at: T(10, 1) }, { at: T(10, 20) }, { at: T(11, 59, 59) }]);
  assert.equal(r.ended.length, 0, 'no abnormal tick: the dwell never ends it');
  assert.equal(r.ws[0].abnormalSeenAtMs, null);
  const r2 = run([{ at: T(10, 1) }, { at: T(11, 59, 59) }, { at: T(12) }]);
  assert.equal(r2.ended[0]?.endReason, 'expired');
  assert.equal(r2.ended[0]?.endedAtMs, T(12));
});

test('★★ a new warning at 10:40 resets the dwell; normal again from 10:50 → ended at 11:05', () => {
  const base = [
    { at: T(10, 5), alerts: [SOH, al(`offline-${C3}`)], d: devs({ online: false, lastUpdated: T(9, 59) }, T(10, 5)) },
    { at: T(10, 30) },
    { at: T(10, 40), alerts: [SOH, al(`vdiff-warn-${C3}-1`)] },
    { at: T(10, 50) },
  ];
  const r = run([...base, { at: T(11, 4, 59) }]);
  assert.equal(r.ended.length, 0);
  assert.equal(r.ws[0].normalSinceMs, T(10, 50));
  const r2 = run([...base, { at: T(11, 5) }]);
  assert.equal(r2.ended[0]?.endReason, 'returned-to-normal');
});

test('★★ not reporting is abnormal: online with a reading older than the stale line (3 min)', () => {
  const r = run([{ at: T(10, 10), d: devs({ lastUpdated: T(10, 7) }, T(10, 10)) }]);
  assert.equal(r.ws[0].abnormalSeenAtMs, T(10, 10));
  const r2 = run([{ at: T(10, 10), d: devs({ lastUpdated: T(10, 7) + 1 }, T(10, 10)) }]);
  assert.equal(r2.ws[0].abnormalSeenAtMs, null, 'just inside the line');
  const r3 = run([{ at: T(10, 10), alerts: [SOH, al(`balancing-${C3}-1`, 'info'), al(deviceGapAlertId(C3, T(10, 2)))] }]);
  assert.equal(r3.ws[0].abnormalSeenAtMs, null, 'an info alert and a gap event are not abnormal');
});

test('★★ the clock stepped back before the start ends it; a Core gone from a hydrated map ends it; an unhydrated map ends nothing', () => {
  assert.equal(run([{ at: T(9, 58, 59) }]).ended[0]?.endReason, 'clock-stepped-back');
  assert.equal(run([{ at: T(10, 10), d: { [C1]: { online: true, lastUpdated: T(10, 10) } } }]).ended[0]?.endReason, 'device-removed');
  const r = run([{ at: T(10, 10), d: null }, { at: T(10, 30), d: null }]);
  assert.equal(r.ended.length, 0, 'the boot map (null) removes nothing and judges nothing');
  assert.equal(r.ws[0].abnormalSeenAtMs, null);
  const over = { ...W3s(), untilMs: T(14) + 1 };
  assert.equal(run([{ at: T(10, 10) }], over).ended[0]?.endReason, 'over-limit');
});

test('★★ the held list: each held alert once, its rises counted, its worst severity kept; capped at 50', () => {
  const steps = [
    { at: T(10, 5), alerts: [SOH, al(`vdiff-warn-${C3}-1`)] },
    { at: T(10, 6), alerts: [SOH] },
    { at: T(10, 7), alerts: [SOH, al(`vdiff-warn-${C3}-1`, 'critical')] },
    { at: T(10, 8), alerts: [SOH, al(`vdiff-warn-${C3}-1`, 'critical')] },
  ];
  const r = run(steps);
  const v = r.ws[0].held.find((h) => h.id === `vdiff-warn-${C3}-1`)!;
  assert.equal(v.rises, 2, 'absent → present twice');
  assert.equal(v.severity, 'critical');
  assert.equal(v.firstAtMs, T(10, 5));
  assert.ok(r.ws[0].held.some((h) => h.id === SOH.id), 'a standing alert held in the window is listed too');
  const many = Array.from({ length: 60 }, (_, i) => al(`soh-warn-${C3}-${i}`));
  const r2 = run([{ at: T(10, 5), alerts: many }]);
  assert.equal(r2.ws[0].held.length, 50);
  assert.equal(r2.ws[0].heldDropped, 10);
});

test('ended windows are kept 24 h (gap absorption, the API\'s recent list), then pruned', () => {
  const ended = { ...W3s(), endedAtMs: T(10, 45), endReason: 'expired' as const };
  assert.equal(stepMaintenance([ended], { alerts: [], devices: null }, T(10, 45) + 24 * H).windows.length, 1);
  assert.equal(stepMaintenance([ended], { alerts: [], devices: null }, T(10, 45) + 24 * H + 1).windows.length, 0);
});

/* ══ (4) persistence ════════════════════════════════════════════════════════════════════════ */

test('★★ save → load round-trips a window in force', () => {
  const p = join(TMP, 'rt.json');
  const w = { ...W3s(), held: [{ id: `offline-${C3}`, title: 'Device offline', severity: 'warning' as const, firstAtMs: T(10, 5), rises: 2, present: true }] };
  saveMaintenance(p, [w]);
  const r = loadMaintenance(p, T(11));
  assert.equal(r.corrupt, false);
  assert.deepEqual(r.windows, [w]);
  assert.deepEqual(r.endedAtBoot, []);
});

test('★★★ fail closed: an unreadable file shelves nothing (corrupt), a missing one is empty', () => {
  const p = join(TMP, 'garbage.json');
  writeFileSync(p, '{not json');
  assert.deepEqual(loadMaintenance(p, T(11)), { windows: [], endedAtBoot: [], corrupt: true });
  writeFileSync(p, '[1,2]');
  assert.equal(loadMaintenance(p, T(11)).corrupt, true);
  assert.deepEqual(loadMaintenance(join(TMP, 'absent.json'), T(11)), { windows: [], endedAtBoot: [], corrupt: false });
});

test('★★★ a 5 h window on disk loads ENDED (over-limit); one that expired while down is owed its end push', () => {
  const p = join(TMP, 'over.json');
  saveMaintenance(p, [{ ...W3s(), untilMs: T(15) }]);
  const r = loadMaintenance(p, T(11));
  assert.equal(r.windows[0].endReason, 'over-limit');
  assert.equal(r.endedAtBoot.length, 1);
  assert.equal(applyMaintenanceMute(al(`offline-${C3}`), r.windows, T(11)), null, 'it holds nothing');
  saveMaintenance(p, [W3s()]);
  const r2 = loadMaintenance(p, T(12, 30));
  assert.equal(r2.endedAtBoot[0]?.endReason, 'expired');
  assert.equal(r2.endedAtBoot[0]?.endedAtMs, T(12), 'ended at its end, not at the boot');
  const r3 = loadMaintenance(p, T(9, 50));
  assert.equal(r3.endedAtBoot[0]?.endReason, 'clock-stepped-back', 'a start in the future: the clock stepped back while down');
  saveMaintenance(p, [W3s(), { ...W3s(), untilMs: T(11, 30) }]);
  const r4 = loadMaintenance(p, T(11));
  assert.equal(r4.windows.filter((w) => w.endedAtMs == null).length, 1, 'one open window per Core; a second is ended');
  writeFileSync(p, JSON.stringify({ windows: [{ ...W3s(), sn: 'shp2-below' }, { ...W3s(), sn: 'COREXXX00XXX0003', untilMs: 'x' }] }));
  assert.deepEqual(loadMaintenance(p, T(11)).windows, [], 'a serial with a separator, or a bad number: not a window');
});

/* ══ (5) gap absorption ═════════════════════════════════════════════════════════════════════ */

test('★★ a telemetry gap that BEGAN inside the window is held after it ends; one that began outside is not', () => {
  const ended = [{ ...W3s(), endedAtMs: T(10, 45), endReason: 'returned-to-normal' as const }];
  const inside = al(deviceGapAlertId(C3, T(10, 10), 40 * MIN));
  assert.equal(deviceGapStartMs(inside.id, C3), T(10, 10));
  assert.ok(applyMaintenanceMute(inside, ended, T(11)), 'began 10:10, inside 10:00–10:45');
  assert.equal(inside.shelvedUntilMs, T(10, 45));
  assert.equal(applyMaintenanceMute(al(deviceGapAlertId(C3, T(10, 50))), ended, T(11)), null, 'began after the end');
  assert.equal(applyMaintenanceMute(al(deviceGapAlertId(C3, T(9, 50))), ended, T(11)), null, 'began before the start');
  assert.equal(applyMaintenanceMute(al(deviceGapAlertId(C1, T(10, 10))), ended, T(11)), null, 'another Core');
  assert.equal(applyMaintenanceMute(al(deviceGapAlertId(C3, T(10, 10))), [{ ...ended[0], untilMs: T(15) }], T(11)), null, 'never by a window over the limit');
});

test('★★★ a gap filed 6 h into the darkness stays held for its whole life: the window is kept while the gap stands', () => {
  // Window 10:00–12:00 runs out; the Core went dark at 10:05 and the recorder files the gap at 6 h
  // (PER_DEVICE_GAP_THRESHOLD_MS), 16:05; the alert stands until a day after that.
  let ws = stepMaintenance([W3s()], { alerts: [], devices: null }, T(12)).windows;
  assert.equal(ws[0].endReason, 'expired');
  const gapStart = T(10, 5);
  const gap = (): Alert => al(deviceGapAlertId(C3, gapStart, 6 * H + MIN), 'warning', { category: 'Connectivity' });
  const tick = (at: number, alerts: Alert[]) => {
    const stamped = alerts.map((a) => { const c = { ...a }; applyMaintenanceMute(c, ws, at); return c; });
    ws = stepMaintenance(ws, { alerts: stamped, devices: null }, at).windows;
    return stamped;
  };
  assert.equal(tick(T(16, 5), [gap()])[0].annunciate, false, 'held when filed, 4 h after the window ended');
  assert.equal(ws[0].gapSeenAtMs, T(16, 5));
  tick(T(16, 30), [gap()]);
  assert.equal(ws[0].gapSeenAtMs, T(16, 5), 'moved at most hourly (each move is a save)');
  // Hourly ticks through the next day, the gap standing: the window is never pruned.
  for (let at = T(17); at <= T(12) + 24 * H + 4 * H; at += H) tick(at, [gap()]);
  const nextDay = T(12) + 24 * H + 20_000; // 12:00:20 the next day — the old prune point
  assert.equal(tick(nextDay, [gap()])[0].annunciate, false, '★ still held the next day (pruned at its end + 24 h, it pushed then)');
  assert.equal(tick(T(16, 4) + 24 * H, [gap()])[0].annunciate, false, '★ held until the gap ages out');
  // Persisted: a restart keeps it while the gap is recent.
  const p = join(TMP, 'gap-keep.json');
  saveMaintenance(p, ws);
  assert.equal(loadMaintenance(p, T(16, 4) + 24 * H).windows.length, 1, 'kept across a restart');
  // The gap gone: pruned MAINT_ENDED_KEEP_MS after it was last seen.
  const last = ws[0].gapSeenAtMs!;
  assert.equal(stepMaintenance(ws, { alerts: [], devices: null }, last + 24 * H).windows.length, 1);
  assert.equal(stepMaintenance(ws, { alerts: [], devices: null }, last + 24 * H + 1).windows.length, 0);
  assert.equal(loadMaintenance(p, last + 24 * H + 1).windows.length, 0);
});

/* ══ (6) the id-stem pin ════════════════════════════════════════════════════════════════════ */

test('★★★ every Core-scoped id stem is shelvable or deliberately loud; no pool, panel or plant stem is', () => {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, '../src', f), 'utf8');
  const src = read('alerts.ts');
  const at = src.indexOf('export function computeAlerts(');
  const body = src.slice(at, src.indexOf('\nexport ', at + 10));
  const stems = new Set<string>();
  for (const m of body.matchAll(/\b(?:id|idBase): (?:[\w.!]+ \? )?(`[^`]*`)(?: : (`[^`]*`))?/g)) {
    for (const lit of [m[1], m[2]]) if (lit != null && lit.includes('${d.sn}')) stems.add(lit.slice(1).split('${')[0]);
  }
  const an = read('analytics.ts');
  for (const m of an.matchAll(/id: `([a-z-]+)\$\{[^`]*\$\{(?:d|t)\.sn\}[^`]*`|id: `([a-z-]+)\$\{(?:d|t)\.sn\}[^`]*`/g)) stems.add(m[1] ?? m[2]);
  assert.ok(stems.size >= 25, `stems found: ${[...stems].join(', ')}`);
  const LOUD = new Set(['cell-ovp-', 'pack-defective-']);
  for (const stem of stems) {
    if (LOUD.has(stem)) {
      assert.equal(isShelvable({ id: `${stem}X`, severity: 'critical', category: 'Battery' }), false, `${stem} is never held`);
      continue;
    }
    assert.equal(isShelvable({ id: `${stem}X`, severity: 'warning', category: 'Battery' }), true, `computeAlerts/analytics emits "${stem}…" on a Core serial: classify it`);
  }
  for (const s of ['peer-', 'baseline-', 'forecast-soh-', 'forecast-imbalance-']) assert.ok([...stems].some((x) => x.startsWith(s)), `${s} found`);
  for (const id of ['backup-soc-15', 'shp2-below-reserve', 'shp2-near-reserve', 'shp2-src-err-1', 'shp2-src-hw-1', 'shp2-multi-panel',
    'reserve-alarm-blind', `forecast-runtime-${P1}`, 'circuit-overload-1', TELEMETRY_BLIND_ALERT_ID, 'grid-offgrid', 'peak-grid-draw',
    'peak-idle-pool', 'cloud-session-stale', 'host-power-undervoltage', 'system-outage-1700000000000', 'storm-Tornado_Warning']) {
    assert.equal(isShelvable({ id, severity: 'critical', category: 'SHP2' }), false, id);
  }
  assert.ok(MAINTENANCE_SHELVABLE_PREFIXES.every((p) => p.endsWith('-')), 'every prefix ends at a separator');
});

/* ══ the pushes ═════════════════════════════════════════════════════════════════════════════ */

test('★★ the start push: warning, the Core and its end, what still sounds — and no serial', () => {
  const m = renderStartPush({ ...W3s(), note: 'pack swap slot 3' }, false, hm);
  assert.equal(m.severity, 'warning');
  assert.equal(m.dedupId, `maintenance_${C3}`);
  assert.equal(m.title, 'Power · Maintenance: Core 3 alarms shelved until 12:00');
  assert.match(m.body, /Still sounds: the reserve floor and near-reserve alarms; the runway; the battery-level ladder;/);
  assert.match(m.body, /Note: pack swap slot 3\./);
  assert.ok(!m.title.includes(C3) && !m.body.includes(C3), 'no serial in the text');
  assert.equal(renderStartPush(W3s(), true, hm).title, 'Power · Maintenance: Core 3 alarms shelved, now until 12:00');
});

test('★★★ the end push lists everything held, what is still active and the settings changed (no silent loss)', () => {
  const w: MaintenanceWindow = {
    ...W3s(), endedAtMs: T(11, 5), endReason: 'returned-to-normal',
    held: [
      { id: `vdiff-crit-${C3}-1`, title: 'Cell imbalance', severity: 'critical', firstAtMs: T(10, 32), rises: 3, present: false },
      { id: `offline-${C3}`, title: 'Device offline (per EcoFlow Cloud)', severity: 'warning', firstAtMs: T(10, 5), rises: 1, present: false },
    ],
    settingsChanged: [{ key: 'Core 3 · chgMaxSoc', from: 50, to: 100, atMs: T(10, 40) }],
  };
  const quiet = renderEndPush(w, { stillActive: [] }, hm);
  assert.equal(quiet.severity, 'info');
  assert.equal(quiet.title, 'Power · Maintenance over: Core 3 alarms are live again');
  assert.equal(quiet.body, [
    "Core 3's maintenance window (10:00–11:05) ended: the Core has been back to normal for 15 minutes.",
    'Held: 2 alerts (1 critical):\n- Cell imbalance (critical, 3 times, first at 10:32)\n- Device offline (per EcoFlow Cloud) (warning, first at 10:05)',
    'Nothing is still active.',
    'Settings changed on this Core:\n- Core 3 · chgMaxSoc: 50 → 100',
  ].join('\n\n'));
  const loud = renderEndPush({ ...w, endReason: 'expired', endedAtMs: T(12) }, { stillActive: [{ id: `vdiff-crit-${C3}-1`, title: 'Cell imbalance', severity: 'critical' }] }, hm);
  assert.equal(loud.severity, 'warning');
  assert.equal(loud.title, 'Power · Maintenance over: Core 3 alarms are live again (1 still active)');
  assert.match(loud.body, /Still active, and pushed and announced from now on:\n- Cell imbalance \(critical\)/);
  const boot = renderEndPush(w, { stillActive: null }, hm);
  assert.equal(boot.severity, 'warning', 'unknown is not nothing');
  assert.ok(![quiet, loud, boot].some((m) => m.body.includes(C3) || m.title.includes(C3)), 'no serial in the text');
});

/* ══ the controller ═════════════════════════════════════════════════════════════════════════ */

function controller(o: {
  path?: string; now?: () => number; save?: (p: string, ws: readonly MaintenanceWindow[]) => void; remove?: (p: string) => void;
} = {}) {
  const sent: NotifyMessage[] = [];
  const audit: MaintenanceAuditEntry[] = [];
  const logs: string[] = [];
  let clock = T(10);
  const c = createMaintenanceController({
    path: o.path ?? join(mkdtempSync(join(TMP, 'c-')), 'maintenance-windows.json'),
    now: o.now ?? (() => clock),
    send: async (m) => { sent.push(m); },
    log: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`) },
    audit: (e) => audit.push(e),
    fmtClock: hm,
    ...(o.save ? { save: o.save } : {}),
    ...(o.remove ? { remove: o.remove } : {}),
  });
  return { c, sent, audit, logs, setNow: (ms: number) => { clock = ms; } };
}
const flush = () => new Promise((r) => setImmediate(r));
const START = { sn: C3, minutes: 120, source: 'web' as const, devices: DEVICES, homePoolSns: HOME, alerts: [] };

test('★★★ start: saved before it is in force, audited, logged at warn, one push; a failed save shelves nothing (500)', async () => {
  const h = controller();
  const r = h.c.start(START);
  assert.ok(r.ok);
  await flush();
  assert.equal(h.c.active(T(10, 1)).length, 1);
  assert.deepEqual(h.audit.map((e) => [e.action, e.sn, e.params.untilMs]), [['maintenance-start', C3, T(12)]]);
  assert.ok(h.logs.includes('WARN maintenance: Core 3 shelved until 12:00 (web) — its own alerts on screen only; pool and plant alarms unaffected'));
  assert.deepEqual(h.sent.map((m) => m.title), ['Power · Maintenance: Core 3 alarms shelved until 12:00']);
  const failing = controller({ save: () => { throw new Error('EROFS'); } });
  const f = failing.c.start(START);
  assert.deepEqual(f, { ok: false, code: 500, error: 'could not save the window; nothing is shelved' });
  assert.equal(failing.c.active(T(10, 1)).length, 0, '★ nothing shelved');
  assert.equal(failing.audit.length, 0);
  assert.equal(failing.sent.length, 0);
});

test('★★★ the step ends a window and pushes the held list; a restart keeps an open window shelved', async () => {
  const h = controller();
  h.c.start({ ...START, alerts: [SOH] });
  assert.equal(h.c.windows().length, 1);
  const tick = (at: number, alerts: Alert[], d: Record<string, DeviceObs> | null) => {
    const stamped = alerts.map((a) => { const x = { ...a }; applyMaintenanceMute(x, h.c.windows(), at); return x; });
    return { ended: h.c.observe(stamped, d, at), stamped };
  };
  tick(T(10, 5), [SOH, al(`offline-${C3}`, 'warning', { title: 'Device offline' })], devs({ online: false, lastUpdated: T(9, 59) }, T(10, 5)));
  h.c.noteSettingsChange(C3, { key: 'Core 3 · chgMaxSoc', from: 50, to: 100 }, T(10, 20));
  tick(T(10, 30), [SOH], devs({}, T(10, 30)));
  assert.equal(tick(T(10, 44), [SOH], devs({}, T(10, 44))).ended.length, 0);
  const { ended } = tick(T(10, 45), [SOH], devs({}, T(10, 45)));
  await flush();
  assert.equal(ended[0]?.endReason, 'returned-to-normal');
  const end = h.sent.at(-1)!;
  assert.equal(end.title, 'Power · Maintenance over: Core 3 alarms are live again (1 still active)', 'the standing soh-warn is still active');
  assert.match(end.body, /- Device offline \(warning, first at 10:05\)/);
  assert.match(end.body, /- Core 3 · chgMaxSoc: 50 → 100/);
  assert.deepEqual(h.audit.map((e) => e.action), ['maintenance-start', 'maintenance-end']);
  assert.equal(h.audit[1].params.reason, 'returned-to-normal');
  assert.ok(h.logs.some((l) => l.startsWith('WARN maintenance: Core 3 window ended (returned-to-normal)')));
});

test('★★ a restart: an open window is restored and still holds; one that expired while down owes its end push', async () => {
  const dir = mkdtempSync(join(TMP, 'rs-'));
  const path = join(dir, 'maintenance-windows.json');
  const a = controller({ path });
  a.c.start(START);
  const b = controller({ path, now: () => T(11) });
  assert.equal(b.c.active(T(11)).length, 1, 'restored');
  assert.ok(applyMaintenanceMute(al(`offline-${C3}`), b.c.windows(), T(11)), 'and holds');
  const c = controller({ path, now: () => T(12, 30) });
  await flush();
  assert.equal(c.c.active(T(12, 30)).length, 0);
  // v1.197.0 (review) — the end push waits for the first alert check, so it can say what is still active.
  assert.equal(c.sent.length, 0, 'nothing pushed before the first alert check');
  c.c.observe([al(`soc-low-${C3}-4`, 'warning', { title: 'Pack battery low' })], devs({}, T(12, 30)), T(12, 30));
  await flush();
  assert.equal(c.sent.length, 1, 'the end push of the window that expired while the add-on was down');
  assert.equal(c.sent[0].severity, 'warning');
  assert.match(c.sent[0].body, /Still active, and pushed and announced from now on:\n- Pack battery low \(warning\)/, '★ what is still active is listed');
  assert.equal(c.audit[0].params.reason, 'expired');
  assert.equal(c.audit[0].params.stillActive, 1);
  c.c.observe([], devs({}, T(12, 31)), T(12, 31));
  await flush();
  assert.equal(c.sent.length, 1, 'once');
  // On an unhydrated first check (null map), the list is unknown: said so, at the loud tier.
  const p2 = join(mkdtempSync(join(TMP, 'rs2-')), 'maintenance-windows.json');
  saveMaintenance(p2, [W3s()]);
  const e = controller({ path: p2, now: () => T(12, 30) });
  e.c.observe([], null, T(12, 30));
  await flush();
  assert.match(e.sent[0].body, /before the device data was in/);
  assert.equal(e.sent[0].severity, 'warning');
});

test('★★★ heldUnpushed: a held alert is never boot-seeded as pushed — stamped, on a held list, or the Core of a window ended while down', () => {
  const w = { ...W3s(), endedAtMs: T(12), endReason: 'expired' as const,
    held: [{ id: `offline-${C3}`, title: 'Device offline', severity: 'warning' as const, firstAtMs: T(10, 5), rises: 1, present: true }] };
  const none = new Set<string>();
  assert.equal(heldUnpushed(al(`dpu-imbalance-${C1}`, 'warning', { shelvedUntilMs: T(12) }), [], none), true, 'stamped this tick');
  assert.equal(heldUnpushed(al(`offline-${C3}`), [w], none), true, 'on the held list of a retained window');
  assert.equal(heldUnpushed(al(`soc-low-${C3}-4`), [w], none), false, 'not held, no boot end: seeded as before');
  assert.equal(heldUnpushed(al(`soc-low-${C3}-4`), [w], new Set([C3])), true, 'the Core of a window found ended at start-up');
  assert.equal(heldUnpushed(al(`soc-low-${C1}-4`), [w], new Set([C3])), false, 'another Core');
  assert.equal(heldUnpushed(al('shp2-below-reserve', 'warning', { sourceSn: C3 }), [w], new Set([C3])), false, 'a family no window holds');
});

test('★★ the controller answers heldUnpushed for the windows it found ended at start-up', () => {
  const p = join(mkdtempSync(join(TMP, 'hu-')), 'maintenance-windows.json');
  saveMaintenance(p, [W3s()]);
  const h = controller({ path: p, now: () => T(12, 30) });
  assert.equal(h.c.heldUnpushed(al(`dpu-imbalance-${C3}`)), true);
  assert.equal(h.c.heldUnpushed(al(`dpu-imbalance-${C1}`)), false);
});

test('★★ ended by hand: end(sn) and endAll; a Core with no window answers false', async () => {
  const h = controller();
  h.c.start(START);
  h.c.start({ ...START, sn: C4 });
  assert.equal(h.c.end(C1, 'web', []), false);
  assert.equal(h.c.end(C3, 'web', [al(`dpu-err-${C3}`, 'critical', { title: 'Inverter error code' })]), true);
  await flush();
  assert.match(h.sent.at(-1)!.body, /ended: it was ended by hand/);
  assert.match(h.sent.at(-1)!.body, /- Inverter error code \(critical\)/);
  assert.equal(h.c.endAll('ha', []), 1);
  assert.equal(h.c.active(T(10, 1)).length, 0);
  assert.deepEqual(h.audit.map((e) => e.action), ['maintenance-start', 'maintenance-start', 'maintenance-end', 'maintenance-end']);
});

test('★★★ a window lapsed since the last step is ended before a start: no second open window, and End now ends the one in force', async () => {
  const path = join(mkdtempSync(join(TMP, 'lp-')), 'maintenance-windows.json');
  const h = controller({ path });
  assert.ok(h.c.start({ ...START, minutes: 30 }).ok); // 10:00–10:30
  h.setNow(T(10, 30, 5)); // 5 s past its end; the 20 s tick has not stepped it
  assert.equal(lapseReason(h.c.windows()[0], T(10, 30, 5)), 'expired');
  const r = h.c.start({ ...START, minutes: 60 });
  assert.ok(r.ok && !r.extended, JSON.stringify(r));
  await flush();
  assert.equal(h.c.windows().filter((w) => w.endedAtMs == null).length, 1, '★ one open window for the Core');
  assert.deepEqual(h.c.windows().map((w) => w.endReason ?? 'open'), ['expired', 'open']);
  assert.deepEqual(h.sent.map((m) => m.title), [
    'Power · Maintenance: Core 3 alarms shelved until 10:30',
    'Power · Maintenance over: Core 3 alarms are live again',
    'Power · Maintenance: Core 3 alarms shelved until 11:30',
  ], 'the lapsed window\'s end push, then the new start');
  h.setNow(T(10, 30, 8));
  const ext = h.c.start({ ...START, minutes: 120 });
  assert.ok(ext.ok && ext.extended);
  assert.equal(h.c.windows().filter((w) => w.endedAtMs == null).length, 1, 'an extension replaces its own window');
  assert.equal(h.c.end(C3, 'web', []), true);
  assert.equal(h.c.active(T(10, 30, 9)).length, 0, '★ End now leaves nothing in force');
  // Reloaded: nothing open, nothing owed twice.
  const again = loadMaintenance(path, T(10, 31));
  assert.equal(again.windows.filter((w) => w.endedAtMs == null).length, 0);
  assert.deepEqual(again.endedAtBoot, []);
  // End now on a window that lapsed unstepped: it is ended (expired, with its push) and answers true.
  const k = controller();
  k.c.start({ ...START, minutes: 30 });
  k.setNow(T(10, 30, 5));
  assert.equal(k.c.end(C3, 'web', []), true);
  await flush();
  assert.equal(k.audit.at(-1)?.params.reason, 'expired');
  assert.equal(k.c.windows().filter((w) => w.endedAtMs == null).length, 0);
});

test('★★★ an end that cannot be saved removes the file: a restart shelves nothing (never the Core again)', async () => {
  const dir = mkdtempSync(join(TMP, 'eu-'));
  const path = join(dir, 'maintenance-windows.json');
  let failing = false;
  const removed: string[] = [];
  const h = controller({
    path,
    save: (p, ws) => { if (failing) throw new Error('ENOSPC'); saveMaintenance(p, ws); },
    remove: (p) => { removed.push(p); rmSync(p, { force: true }); },
  });
  assert.ok(h.c.start(START).ok);
  assert.equal(loadMaintenance(path, T(10, 5)).windows.length, 1, 'on disk');
  failing = true;
  h.setNow(T(10, 5));
  // A held-list save that fails removes nothing: no end is at stake.
  h.c.observe([al(`offline-${C3}`, 'warning', { shelvedUntilMs: T(12) })], devs({ online: false }, T(10, 5)), T(10, 5));
  assert.deepEqual(removed, []);
  assert.equal(h.c.end(C3, 'web', []), true);
  assert.deepEqual(removed, [path], '★ the stale file holding the window open is removed');
  assert.ok(h.logs.some((l) => l.startsWith('WARN maintenance: removed ')));
  const after = controller({ path, now: () => T(10, 10) });
  assert.equal(after.c.active(T(10, 10)).length, 0, '★ a restart does not shelve the Core again');
  // The next save that succeeds writes the file back.
  failing = false;
  h.c.observe([], devs({}, T(10, 6)), T(10, 6));
  assert.equal(loadMaintenance(path, T(10, 7)).windows[0]?.endReason, 'ended-by-owner');
});

test('a corrupt file is logged at warn and shelves nothing', () => {
  const dir = mkdtempSync(join(TMP, 'cx-'));
  const path = join(dir, 'maintenance-windows.json');
  writeFileSync(path, 'nope');
  const h = controller({ path });
  assert.equal(h.c.windows().length, 0);
  assert.ok(h.logs.some((l) => l.startsWith('WARN maintenance:') && l.includes('unreadable — no Core is shelved')));
});
