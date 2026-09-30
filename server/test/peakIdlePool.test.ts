/**
 * v1.187.0 — buying grid ON-PEAK while the house pool sits idle above its reserve.
 *
 * Mon 2026-09-28 16:00-19:00 MST: grid_home_w = panel_load ≈ 1.3-1.4 kW (4.27 kWh at 44.2¢,
 * ~$1.89), backup_pct 26 against a 16 reserve, src1/2/3_w 0 W every bucket — the SHP2's
 * re-entry band after a hold (discharge resumed only at ~36-38% on 09-13/14/27). Nothing
 * reported it: peak-grid-draw watches grid flowing INTO the pack. This is an advisory —
 * a [Low] push, no chime, no device write, once per on-peak day.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateIdlePool, classifyIdlePool, stepIdlePool, emptyIdlePoolState, resetIdlePoolState,
  peakIdlePoolAlerts, peakGridDrawAlerts, PEAK_IDLE_POOL_ALERT_ID, DEFAULT_IDLE_POOL_CONFIG,
  IDLE_DWELL_MS, IDLE_CLEAR_MS, type IdlePoolInputs,
  idlePoolFiredDay, restoreIdlePoolFiredDay, loadIdlePoolFiredDay, persistIdlePoolFiredDay,
} from '../src/peakGridDraw.js';
import { conditionFromAlerts, speakableAlerts } from '../src/broadcast.js';
import { buildAlertMessage, pickPrimaryAlert } from '../src/ttsService.js';
import { idlePoolInputsFrom, orphanedNotifiedIds, type NotifyRecord } from '../src/alertMonitor.js';
import { buildApsREvModel } from '../src/tariff.js';
import type { Alert } from '../src/alerts.js';

const MIN = 60_000;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const REV = buildApsREvModel({
  confirmed: true, onPeak: { summer: 44.2, winter: 30 }, offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 },
});
const MON_1600 = phx(2026, 9, 28, 16);

const incident = (o: Partial<IdlePoolInputs> = {}): IdlePoolInputs => ({
  nowMs: MON_1600, gridPresent: true, gridImportW: 1301, socPct: 26, reserveSocPct: 16,
  sourceWatts: [0, 0, 0], fresh: true, poolFullWh: 92_160, smartBackupMode: 2, ...o,
});
/** Tick every minute from `from` for `mins`, returning the last verdict. */
function run(from: number, mins: number, o: Partial<IdlePoolInputs> = {}) {
  let v = evaluateIdlePool(incident({ ...o, nowMs: from }), REV);
  for (let m = 1; m <= mins; m++) v = evaluateIdlePool(incident({ ...o, nowMs: from + m * MIN }), REV);
  return v;
}

beforeEach(() => resetIdlePoolState());

test('★★★ THE INCIDENT: 1.3 kW on-peak, pool idle at 26% over a 16% reserve → active after the dwell', () => {
  const early = run(MON_1600, 9);
  assert.equal(early.active, false, 'a load step is not a buying pattern');
  assert.equal(early.suppressed, null, 'the condition holds; only the dwell is pending');
  const v = evaluateIdlePool(incident({ nowMs: MON_1600 + IDLE_DWELL_MS }), REV);
  assert.equal(v.active, true);
  assert.equal(v.onPeak, true);
  assert.ok(Math.abs(v.aboveReserveKwh! - 9.216) < 0.01, '10 points of a 92 kWh pool');
  assert.ok(Math.abs(v.centsPerHour! - 1.301 * 44.2) < 0.01);
  const [a] = peakIdlePoolAlerts(v, MON_1600 + IDLE_DWELL_MS);
  assert.equal(a.id, PEAK_IDLE_POOL_ALERT_ID);
  assert.equal(a.severity, 'warning', 'warning so it can push');
  assert.equal(a.priority, 'low', 'money, never above a physical risk');
  assert.equal(a.category, 'Grid');
  assert.match(a.detail, /26% against a 16% reserve/);
  assert.match(a.detail, /roughly 20 points above the reserve/, 'it describes the band');
  assert.match(a.detail, /changes no setting/);
});

test('★★★ SILENT near the reserve: a held pool there is the panel defending the floor', () => {
  for (const soc of [16, 18, 21]) {
    const v = run(MON_1600, 15, { socPct: soc });
    assert.equal(v.active, false, `soc ${soc}`);
    assert.equal(v.suppressed, 'near-reserve');
  }
  assert.equal(run(MON_1600, 15, { socPct: 22 }).active, true, 'just past the headroom it is a cost question');
});

test('★★ SILENT while the pool carries the house (09-29 16:00: -1.6 kW per channel, grid 0)', () => {
  const v = run(MON_1600, 15, { sourceWatts: [-1609, -1574, -1609], gridImportW: 0, socPct: 98 });
  assert.equal(v.active, false);
  assert.equal(v.suppressed, 'pool-active');
  // Charging from the grid is peak-grid-draw's case, not this one.
  assert.equal(run(MON_1600, 15, { sourceWatts: [5200, 5240, 5200], gridImportW: 19000 }).suppressed, 'pool-active');
});

test('★★ SILENT off-peak — weekday evening and the whole weekend', () => {
  assert.equal(run(phx(2026, 9, 28, 19, 5), 15).suppressed, 'off-peak');
  assert.equal(run(phx(2026, 9, 26, 17), 15).suppressed, 'off-peak', 'Saturday');
  assert.equal(run(phx(2026, 9, 28, 15, 30), 15).active, false, '15:30-15:45 is off-peak under R-EV');
});

test('SILENT in an outage, on stale readings, with too little import to matter', () => {
  assert.equal(run(MON_1600, 15, { gridPresent: false }).suppressed, 'outage');
  assert.equal(run(MON_1600, 15, { fresh: false }).suppressed, 'insufficient-data', 'a frozen projection reads its last watts forever');
  assert.equal(run(MON_1600, 15, { sourceWatts: [] }).suppressed, 'insufficient-data');
  assert.equal(run(MON_1600, 15, { socPct: null }).suppressed, 'insufficient-data');
  assert.equal(run(MON_1600, 15, { gridImportW: 120 }).suppressed, 'low-import');
});

test('★★ ONCE per on-peak day: a second rise the same afternoon does not push again', () => {
  assert.equal(run(MON_1600, 12).active, true);
  // The pool starts carrying the house for good: cleared after the clear dwell.
  const cleared = run(MON_1600 + 13 * MIN, 12, { sourceWatts: [-900, -900, -900] });
  assert.equal(cleared.active, false);
  // It goes idle again at 17:00 — held, not re-raised.
  const again = run(phx(2026, 9, 28, 17), 20);
  assert.equal(again.active, false);
  assert.equal(again.suppressed, 'fired-today');
  // Next weekday it can rise again.
  assert.equal(run(phx(2026, 9, 29, 16), 12).active, true);
});

test('★ a brief dip does not resolve it; on-peak ending does, at once', () => {
  run(MON_1600, 12);
  const blip = run(MON_1600 + 13 * MIN, IDLE_CLEAR_MS / MIN - 2, { gridImportW: 100 });
  assert.equal(blip.active, true, 'a load dip is not a resolution');
  assert.equal(evaluateIdlePool(incident({ nowMs: phx(2026, 9, 28, 19) }), REV).active, false, '19:00: on-peak is over');
});

test('stepIdlePool — the episode machine in isolation', () => {
  const ctx = (nowMs: number, day = '2026-09-28') => ({ nowMs, onPeak: true, gridPresent: true, day });
  let st = emptyIdlePoolState();
  let r = stepIdlePool(st, true, ctx(0));
  assert.equal(r.active, false);
  r = stepIdlePool(r.state, true, ctx(DEFAULT_IDLE_POOL_CONFIG.dwellMs));
  assert.equal(r.active, true);
  assert.equal(r.state.firedDay, '2026-09-28');
  r = stepIdlePool(r.state, false, { ...ctx(DEFAULT_IDLE_POOL_CONFIG.dwellMs + MIN), gridPresent: false });
  assert.equal(r.active, false, 'an outage ends it at once');
  st = r.state;
  assert.equal(stepIdlePool(stepIdlePool(st, true, ctx(0)).state, true, ctx(DEFAULT_IDLE_POOL_CONFIG.dwellMs)).active, false, 'same day');
});

test('classifyIdlePool reads the tariff\'s own on-peak (holidays included)', () => {
  const holiday = buildApsREvModel({ confirmed: true, holidays: ['2026-09-28'] });
  assert.equal(classifyIdlePool(incident(), holiday).suppressed, 'off-peak');
  assert.equal(classifyIdlePool(incident(), REV).suppressed, null);
  assert.equal(classifyIdlePool(incident(), buildApsREvModel()).centsPerKwh, null, 'unconfirmed: on-peak known, cost not');
});

test('★★★ NOT AUDIBLE: the notice never raises the chime, while peak-grid-draw still does', () => {
  const v = run(MON_1600, 12);
  const [idle] = peakIdlePoolAlerts(v, MON_1600 + 12 * MIN);
  assert.equal(idle.audible, false, 'audible:false is what keeps it off the speakers');
  assert.notEqual(idle.annunciate, false, 'the [Low] push is kept');
  const c = conditionFromAlerts([idle]);
  assert.equal(c.level, 'green');
  assert.equal(c.warn, 0);
  // The id exclusion in conditionFromAlerts stays as a second guard.
  assert.equal(conditionFromAlerts([{ ...idle, audible: undefined }]).level, 'green', 'the id is excluded from the count too');
  const draw = peakGridDrawAlerts({
    active: true, gridToBatteryW: 6400, onPeak: true, periodLabel: 'On-Peak', centsPerHour: 280,
    heldForMs: 15 * MIN, suppressed: null, coreAttribution: null, forceChargeOn: null,
  }, MON_1600);
  assert.equal(conditionFromAlerts([idle, ...draw]).level, 'yellow', 'the exclusion is this id only');
});

/* ══ v1.187.0 log review: never the alert a yellow names aloud ══ */

/** The alarm host running hot — a warning with no Core location, category Connectivity (ranked
 *  below Grid by pickPrimaryAlert), the shape alerts.ts emits. */
const HOST_TEMP_WARN: Alert = {
  id: 'host-temp-warn', severity: 'warning', category: 'Connectivity', device: 'System',
  title: 'Alarm host running hot',
  detail: 'The host running this monitor reads 78°C at the SoC — above the 75°C action threshold. Improve airflow around the host or relocate it somewhere cooler.',
};

test('★★★ SPOKEN MESSAGE: when another warning raises the yellow, the words name THAT warning, never the idle-pool notice', () => {
  const v = run(MON_1600, 12);
  const [idle] = peakIdlePoolAlerts(v, MON_1600 + 12 * MIN);
  // The broadcast tick's own chain: speakableAlerts → conditionFromAlerts + buildAlertMessage.
  const spoken = speakableAlerts([idle, HOST_TEMP_WARN], MON_1600 + 12 * MIN, () => undefined);
  assert.deepEqual(spoken.map((a) => a.id), ['host-temp-warn'], 'the notice is not in the array the message is built from');
  assert.equal(conditionFromAlerts(spoken).level, 'yellow');
  const msg = buildAlertMessage('yellow', spoken);
  assert.match(msg, /Alarm host running hot/, 'the warning that raised the yellow is named');
  assert.doesNotMatch(msg, /on-peak|battery pool|Grid status/i, 'the money notice is never voiced');
  // …and any other caller that builds a message without the tick's filter cannot voice it either.
  assert.equal(pickPrimaryAlert([idle, HOST_TEMP_WARN], 'yellow')?.id, 'host-temp-warn');
  assert.equal(pickPrimaryAlert([idle], 'yellow'), null);
});

/* ══ v1.187.0 log review: across a restart ══ */

test('★★★ RESTART: the fired day is persisted and restored — a re-rise the same afternoon does not push again', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'ef-idle-'));
  const path = resolve(dir, 'idle-pool-state.json');
  try {
    assert.equal(loadIdlePoolFiredDay(path), null, 'no file: nothing to restore');
    assert.equal(run(MON_1600, 12).active, true);
    assert.equal(idlePoolFiredDay(), '2026-09-28');
    // The monitor writes the day on its change, and only then.
    assert.equal(persistIdlePoolFiredDay(path, null), '2026-09-28');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { firedDay: '2026-09-28' });
    rmSync(path);
    assert.equal(persistIdlePoolFiredDay(path, '2026-09-28'), '2026-09-28', 'unchanged: no write');
    assert.equal(existsSync(path), false);
    persistIdlePoolFiredDay(path, null);
    // An auto-update restart at 16:20 while the house is still buying on-peak.
    resetIdlePoolState();
    restoreIdlePoolFiredDay(loadIdlePoolFiredDay(path));
    const after = run(MON_1600 + 20 * MIN, 30);
    assert.equal(after.active, false, 'the notice already went out today');
    assert.equal(after.suppressed, 'fired-today');
    // Without the restore the same afternoon pushes a second time (the defect).
    resetIdlePoolState();
    assert.equal(run(MON_1600 + 20 * MIN, 12).active, true);
    // The next weekday rises again after a restore of the previous day.
    resetIdlePoolState();
    restoreIdlePoolFiredDay('2026-09-28');
    assert.equal(run(phx(2026, 9, 29, 16), 12).active, true);
    // A corrupt or malformed file restores nothing.
    writeFileSync(path, '{not json');
    assert.equal(loadIdlePoolFiredDay(path), null);
    writeFileSync(path, JSON.stringify({ firedDay: 'yesterday' }));
    assert.equal(loadIdlePoolFiredDay(path), null);
    resetIdlePoolState();
    restoreIdlePoolFiredDay('yesterday');
    assert.equal(idlePoolFiredDay(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ RESTART: a pushed idle-pool record orphaned by a restart is DROPPED, never resolved (like msg-rate-floor-)', () => {
  const rec: NotifyRecord = { ts: MON_1600 + 10 * MIN, sent: true, sev: 'warning', title: 'Buying grid power on-peak while the battery pool sits idle' };
  const out = orphanedNotifiedIds({
    persisted: new Map<string, NotifyRecord>([[PEAK_IDLE_POOL_ALERT_ID, rec], ['peak-grid-draw', rec]]),
    currentIds: new Set(), trackedIds: new Set(), notifyResolved: true, minSeverity: 'warning',
    nowMs: MON_1600 + 30 * MIN, holdUntilMs: MON_1600 + 400 * MIN, unevaluable: () => false,
  });
  assert.ok(out.drop.includes(PEAK_IDLE_POOL_ALERT_ID), 'dropped: its episode is not carried across the restart');
  assert.ok(!out.resolve.includes(PEAK_IDLE_POOL_ALERT_ID), 'no "Resolved:" while the house may still be buying on-peak');
  assert.ok(out.resolve.includes('peak-grid-draw'), 'the rule is this family only');
});

/* ══ integration pins ══ */
const SRC = (f: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../src/${f}`), 'utf8');

test('★★ the monitor evaluates it on the house panel\'s readings (idlePoolInputsFrom) and publishes it', () => {
  // v1.187.0 (review) — the input assembly and its freshness gate are tested behaviourally
  // below (idlePoolInputsFrom); this pins only the tick's wiring.
  const m = SRC('alertMonitor.ts');
  assert.ok(m.includes('const idlePool = evaluateIdlePool(idlePoolInputsFrom(snap.devices, grid.present, idleNowMs), apsREvModelFromEnv());'));
  assert.ok(m.includes('...peakIdlePoolAlerts(idlePool, idleNowMs), // v1.187.0'));
  assert.ok(m.includes("  'peak-idle-pool',\n];"), 'a device-derived family (hydration rules)');
  // v1.187.0 (log review) — the fired day's restore at start-up and persist on every tick are
  // pinned behaviourally, the real monitor run twice on the same state files
  // (peakIdlePoolRestart.test.ts).
});

/* ══ the monitor's input assembly (v1.187.0 review) ══ */

test('★★★ a STALE or offline house panel is not live evidence: the frozen projection never reads "idle"', () => {
  const panel = (lastUpdated: number, extra: Record<string, unknown> = {}) => ({
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated, ...extra,
      projection: {
        kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, backupFullCapWh: 92_160,
        sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 },
        sources: [], pairedCircuits: [],
      },
    },
  }) as any;
  const live = idlePoolInputsFrom(panel(MON_1600 - 30_000), true, MON_1600);
  assert.deepEqual(live, incident({ nowMs: MON_1600 }), 'every field read from the house panel');
  // Cloud-dark for 20 min: the projection is kept verbatim, but it is not evidence.
  const stale = idlePoolInputsFrom(panel(MON_1600 - 20 * MIN), true, MON_1600);
  assert.equal(stale.fresh, false);
  assert.equal(classifyIdlePool(stale, REV).suppressed, 'insufficient-data');
  // Flagged offline with fresh-looking data (the 2026-08-12 blip): not evidence either.
  assert.equal(idlePoolInputsFrom(panel(MON_1600 - 30_000, { online: false }), true, MON_1600).fresh, false);
  // No house panel at all: nothing read, nothing fresh.
  const none = idlePoolInputsFrom({}, true, MON_1600);
  assert.equal(none.fresh, false);
  assert.equal(none.gridImportW, null);
  assert.equal(classifyIdlePool(none, REV).suppressed, 'insufficient-data');
  // The grid verdict is the caller's, passed through.
  assert.equal(idlePoolInputsFrom(panel(MON_1600 - 30_000), false, MON_1600).gridPresent, false);
});
