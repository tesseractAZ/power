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
  // v1.187.23 — with the forecast feed's pool capacity and its basis, the pair from one forecast
  // (pinned behaviourally through the real monitor in peakIdlePoolMeasuredCapacity.test.ts).
  assert.ok(m.includes('const idlePool = evaluateIdlePool(idlePoolInputsFrom(snap.devices, grid.present, idleNowMs, forecastNow), apsREvModelFromEnv());'));
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
  // v1.187.23 — no measured capacity passed: the nameplate, named as such.
  assert.deepEqual(live, incident({ nowMs: MON_1600, poolCapacityBasis: 'nameplate' }), 'every field read from the house panel');
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

/* ══ v1.187.23 — the kWh above the reserve is on the pool's MEASURED capacity ══ */

test('★★★ v1.187.23 — a measured pool capacity is the one the kWh figure uses: (soc − reserve)% of it, not of the nameplate', () => {
  // The SoC percent is a share of the measured capacity since v1.187.19 (nameplate × poolCapacityScale);
  // the push said "(about 9.2 kWh above it)" from the 92.16 kWh nameplate while the forecast and the
  // runway integrated the same 10 points on ~87.0 kWh.
  const MEASURED_WH = 92_160 * 0.944;
  const live = MON_1600 - 30_000;
  const panel = {
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: live,
      projection: {
        kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, backupFullCapWh: 92_160,
        sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 },
        sources: [], pairedCircuits: [],
      },
    },
  } as any;
  const inputs = idlePoolInputsFrom(panel, true, MON_1600, { poolFullWh: MEASURED_WH, poolCapacityBasis: 'measured' });
  assert.equal(inputs.poolFullWh, MEASURED_WH);
  assert.equal(inputs.poolCapacityBasis, 'measured');
  run(MON_1600, 9);
  const v = evaluateIdlePool({ ...inputs, nowMs: MON_1600 + IDLE_DWELL_MS }, REV);
  assert.equal(v.active, true);
  assert.ok(Math.abs(v.aboveReserveKwh! - 8.6999) < 0.001, `10 points of the measured 87.0 kWh, got ${v.aboveReserveKwh}`);
  assert.equal(v.poolCapacityBasis, 'measured');
  const [a] = peakIdlePoolAlerts(v, MON_1600 + IDLE_DWELL_MS);
  assert.match(a.detail, /at 26% against a 16% reserve \(about 8\.7 kWh above it\), has not discharged/);
  assert.doesNotMatch(a.detail, /nameplate/, 'the measured figure needs no qualifier');
  assert.equal(a.facts!.find((f) => f.label === 'Above reserve')!.value, '8.7 kWh');
});

test('★★ v1.187.23 — with no measured capacity the nameplate is the fallback, and the push names it', () => {
  const panel = (extra: Record<string, unknown> = {}) => ({
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: MON_1600 - 30_000,
      projection: {
        kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, backupFullCapWh: 92_160,
        sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 }, sources: [], pairedCircuits: [],
        ...extra,
      },
    },
  }) as any;
  // No forecast delivered (undefined, null), a forecast with no pool (null), or an unusable figure.
  for (const none of [undefined, null]) {
    const i = idlePoolInputsFrom(panel(), true, MON_1600, none);
    assert.equal(i.poolFullWh, 92_160, `fallback for no forecast (${none})`);
    assert.equal(i.poolCapacityBasis, 'nameplate', `fallback for no forecast (${none})`);
  }
  for (const none of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const i = idlePoolInputsFrom(panel(), true, MON_1600, { poolFullWh: none, poolCapacityBasis: 'measured' });
    assert.equal(i.poolFullWh, 92_160, `fallback for ${none}`);
    assert.equal(i.poolCapacityBasis, 'nameplate', `fallback for ${none}`);
  }
  run(MON_1600, 9);
  const v = evaluateIdlePool({ ...idlePoolInputsFrom(panel(), true, MON_1600, { poolFullWh: null, poolCapacityBasis: null }), nowMs: MON_1600 + IDLE_DWELL_MS }, REV);
  assert.equal(v.active, true);
  assert.ok(Math.abs(v.aboveReserveKwh! - 9.216) < 0.001);
  assert.equal(v.poolCapacityBasis, 'nameplate');
  const [a] = peakIdlePoolAlerts(v, MON_1600 + IDLE_DWELL_MS);
  assert.match(a.detail, /\(about 9\.2 kWh above it on the nameplate capacity\), has not discharged/);
  assert.equal(a.facts!.find((f) => f.label === 'Above reserve')!.value, '9.2 kWh (nameplate capacity)');
  // A panel reporting no nameplate either: capacity unknown, no figure and no basis.
  const bare = idlePoolInputsFrom(panel({ backupFullCapWh: undefined }), true, MON_1600, { poolFullWh: null, poolCapacityBasis: null });
  assert.equal(bare.poolFullWh, null);
  assert.equal(bare.poolCapacityBasis, null);
  // ...but a measured capacity still serves.
  const measuredOnly = idlePoolInputsFrom(panel({ backupFullCapWh: undefined }), true, MON_1600, { poolFullWh: 80_000, poolCapacityBasis: 'measured' });
  assert.equal(measuredOnly.poolFullWh, 80_000);
  assert.equal(measuredOnly.poolCapacityBasis, 'measured');
  // No house panel: nothing is read, whatever the forecast carries.
  const none = idlePoolInputsFrom({}, true, MON_1600, { poolFullWh: 87_000, poolCapacityBasis: 'measured' });
  assert.equal(none.poolFullWh, null);
  assert.equal(none.poolCapacityBasis, null);
});

test('★★★ v1.187.23 (review) — the forecast\'s figure counts as measured only when its OWN basis says so: a nameplate-basis forecast is the named nameplate', () => {
  // poolEnergyBasis.ts: with no Core capacity ratio ever measured (a fresh install, or packs that
  // never report fullCapMah/designCapMah) the forecast's basis is 'nameplate' at scale 1, so its
  // poolFullWh IS the 92,160 Wh nameplate. Taken as measured, the push said "(about 9.2 kWh above
  // it)" with no qualifier — the rated size presented as what the pool holds.
  const panel = {
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: MON_1600 - 30_000,
      projection: {
        kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, backupFullCapWh: 92_160,
        sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 }, sources: [], pairedCircuits: [],
      },
    },
  } as any;
  // The forecast's own nameplate figure, its basis 'nameplate': the panel's nameplate, named.
  const onNameplate = idlePoolInputsFrom(panel, true, MON_1600, { poolFullWh: 92_160, poolCapacityBasis: 'nameplate' });
  assert.equal(onNameplate.poolFullWh, 92_160);
  assert.equal(onNameplate.poolCapacityBasis, 'nameplate');
  // Whatever figure a non-measured forecast carries, the figure used is the panel's own nameplate
  // (the forecast's is not passed off under the nameplate's name either).
  for (const basis of ['nameplate', null, undefined] as const) {
    const i = idlePoolInputsFrom(panel, true, MON_1600, { poolFullWh: 90_000, poolCapacityBasis: basis });
    assert.equal(i.poolFullWh, 92_160, `basis ${basis}: the panel's nameplate`);
    assert.equal(i.poolCapacityBasis, 'nameplate', `basis ${basis}: an absent basis vouches for nothing`);
  }
  // A basis the allowlist does not hold (a future one) is not presented as measured either.
  const unknown = idlePoolInputsFrom(panel, true, MON_1600, { poolFullWh: 90_000, poolCapacityBasis: 'estimated' as any });
  assert.equal(unknown.poolCapacityBasis, 'nameplate');
  // 'measured', 'held' (a Core's persisted ratio) and 'min-known' (the lowest ratio measured) are
  // all scaled from measured ratios: the forecast's figure, unlabelled.
  for (const basis of ['measured', 'held', 'min-known'] as const) {
    const i = idlePoolInputsFrom(panel, true, MON_1600, { poolFullWh: 87_000, poolCapacityBasis: basis });
    assert.equal(i.poolFullWh, 87_000, `basis ${basis}`);
    assert.equal(i.poolCapacityBasis, 'measured', `basis ${basis}`);
  }
  // The push for the nameplate-basis forecast names the nameplate.
  run(MON_1600, 9);
  const v = evaluateIdlePool({ ...onNameplate, nowMs: MON_1600 + IDLE_DWELL_MS }, REV);
  assert.equal(v.active, true);
  assert.equal(v.poolCapacityBasis, 'nameplate');
  const [a] = peakIdlePoolAlerts(v, MON_1600 + IDLE_DWELL_MS);
  assert.match(a.detail, /\(about 9\.2 kWh above it on the nameplate capacity\), has not discharged/, a.detail);
  assert.equal(a.facts!.find((f) => f.label === 'Above reserve')!.value, '9.2 kWh (nameplate capacity)');
});

test('★ v1.187.23 — a verdict with no kWh figure carries no basis (the card reads "capacity unknown")', () => {
  run(MON_1600, 9, { poolFullWh: null, poolCapacityBasis: 'nameplate' });
  const v = evaluateIdlePool(incident({ nowMs: MON_1600 + IDLE_DWELL_MS, poolFullWh: null, poolCapacityBasis: 'nameplate' }), REV);
  assert.equal(v.active, true);
  assert.equal(v.aboveReserveKwh, null);
  assert.equal(v.poolCapacityBasis, null);
  const [a] = peakIdlePoolAlerts(v, MON_1600 + IDLE_DWELL_MS);
  assert.match(a.detail, /against a 16% reserve, has not discharged/);
  assert.equal(a.facts!.find((f) => f.label === 'Above reserve')!.value, 'capacity unknown');
});

test('★★ v1.187.23 (review) — a measured capacity from a different pool is not used: a Core left or joined since the forecast', () => {
  // The forecast can be up to its day TTL old, and a Core leaving the panel does not reset the
  // worker's caches: its measured 87.0 kWh then describes three Cores while the live panel holds two.
  const panel = (fullCapWh: number) => ({
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: MON_1600 - 30_000,
      projection: {
        kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, backupFullCapWh: fullCapWh,
        sourceWatts: [0, 0], strategy: { backupReserveSoc: 16, smartBackupMode: 2 }, sources: [], pairedCircuits: [],
      },
    },
  }) as any;
  const forecast = { poolFullWh: 92_160 * 0.944, poolCapacityBasis: 'measured' as const };
  // Same pool: the measured figure (inside [0.8, 1] × the live nameplate).
  const same = idlePoolInputsFrom(panel(92_160), true, MON_1600, forecast);
  assert.equal(same.poolCapacityBasis, 'measured');
  assert.equal(same.poolFullWh, forecast.poolFullWh);
  // A Core left (live nameplate 61.44 kWh < the forecast's 87.0): the live nameplate, named.
  const left = idlePoolInputsFrom(panel(61_440), true, MON_1600, forecast);
  assert.equal(left.poolCapacityBasis, 'nameplate', 'a measured figure above the live nameplate is a different pool');
  assert.equal(left.poolFullWh, 61_440);
  // A Core joined (live nameplate 122.88 kWh; 87.0 is under 0.8 × it): the live nameplate, named.
  const joined = idlePoolInputsFrom(panel(122_880), true, MON_1600, forecast);
  assert.equal(joined.poolCapacityBasis, 'nameplate', 'a measured figure under the scale floor is a different pool');
  assert.equal(joined.poolFullWh, 122_880);
  // The boundaries themselves are accepted: exactly the nameplate, and exactly the scale floor.
  assert.equal(idlePoolInputsFrom(panel(92_160), true, MON_1600, { poolFullWh: 92_160, poolCapacityBasis: 'measured' }).poolCapacityBasis, 'measured');
  assert.equal(idlePoolInputsFrom(panel(100_000), true, MON_1600, { poolFullWh: 80_000, poolCapacityBasis: 'measured' }).poolCapacityBasis, 'measured');
});

test('★ v1.187.23 (review) — with no live nameplate to bound it, an unusable measured figure is still refused', () => {
  const panel = {
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: MON_1600 - 30_000,
      projection: {
        kind: 'shp2', gridWatt: 1301, backupBatPercent: 26, sourceWatts: [0, 0, 0],
        strategy: { backupReserveSoc: 16, smartBackupMode: 2 }, sources: [], pairedCircuits: [],
      },
    },
  } as any;
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const i = idlePoolInputsFrom(panel, true, MON_1600, { poolFullWh: bad, poolCapacityBasis: 'measured' });
    assert.equal(i.poolFullWh, null, `no figure from ${bad}`);
    assert.equal(i.poolCapacityBasis, null, `no basis from ${bad}`);
  }
});
