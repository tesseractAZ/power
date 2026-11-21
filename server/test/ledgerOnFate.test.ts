import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NightActuationState } from '../src/nightChargeActuator.js';
import type { ForceChargeOpts, ForceChargeAction, ForceChargeOnFate } from '../src/nightForceCharge.js';

/**
 * v1.209.0 (part D) — THE LEDGER RECORDS WHETHER THE FORCE-CHARGE ON TOOK.
 *
 * Before it a row kept only that an ON was sent (force_charge_on_at_ms). A night whose ON never took on any slot
 * (2026-11-16) and a night that force-charged read the same on the ledger. Six raw stamps of the night's record
 * now sit beside force_charge_mode: force_charge_on_failed_at_ms, force_charge_on_failed_slots,
 * force_charge_on_left_out, force_charge_on_retries, force_charge_on_slots, force_charge_on_verified_at_ms.
 *
 * What is tested here:
 *  1. THE COLUMNS: in the one schema list (CHARGE_CYCLE_LEDGER_SCHEMA) with their types, added to an existing
 *     database by the column-add pass, NULL on a row written before the release, round-tripped, and never touched
 *     by the plan row.
 *  2. THE DERIVATION (nightForceCharge.forceChargeOnFateColumns): the six values from the record, nothing at all
 *     with no ON, slot text as slot numbers only.
 *  3. THE VERDICT (nightForceCharge.forceChargeOnFateOf) over a row, and the four nights of the specification
 *     replayed through the real decision, the handlers' record writes and the recorder.
 *  4. THE STAMPS (index.ts): where each one sits, pinned on the source. index.ts starts a server when imported, so
 *     the replay in 3 mirrors its handlers and these pins hold the mirror to the source.
 *  5. THE READERS the release leaves alone still key on the ON stamp: forceChargeStateAt, the readiness gate,
 *     middayChargeHourEpochs.
 *  6. THE STATUS ROUTE serves ledger rows without authentication: nothing but slot numbers reaches the new text.
 *
 * The database is created as a v1.208.0 one (the original table plus the force-charge stamps that release had), as
 * the other ledger migration tests build theirs (ledgerChargeCycle.test.ts).
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-on-fate-'));
const DB = join(tmp, 'ecoflow.db');
process.env.DB_PATH = DB;

const H = 3_600_000;
const MIN = 60_000;
const DAY_MS = 24 * H;
/** A v1.208.0 night that force-charged, and one that did not: both written before the fate columns existed. */
const OLD_ON_DAY = '2026-11-16';
const OLD_ON_AT = Date.UTC(2026, 10, 17, 10, 18);
const OLD_QUIET_DAY = '2026-09-01';

{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE night_charge_ledger (
    plan_date TEXT PRIMARY KEY, issued_at_ms INTEGER, algo_version TEXT, posture TEXT, objective TEXT,
    rationale TEXT, confidence_tier TEXT, horizon_hours REAL, soc_now_pct REAL, soc_at_window_start_pct REAL,
    target_soc_pct REAL, buy_kwh REAL, required_extra_kwh REAL, reserve_floor_pct REAL, cushion_pct REAL,
    cushion_kwh REAL, binding_cap TEXT, pv_p10_kwh REAL, pv_p50_kwh REAL, pv_p90_kwh REAL, load_p10_kwh REAL,
    load_p50_kwh REAL, load_p90_kwh REAL, ev_p90_session_kwh REAL, ev_session_count INTEGER,
    min_proj_soc_pct REAL, min_proj_soc_ts_ms INTEGER, pool_full_kwh REAL, band_sigma_cal REAL,
    cal_scored_days INTEGER, forecast_basis TEXT, weather_covered INTEGER, tariff_snapshot TEXT,
    outcome_captured_at_ms INTEGER, actual_pv_kwh REAL, actual_load_kwh REAL, actual_window_import_kwh REAL,
    actual_grid_to_battery_kwh REAL, actual_onpeak_import_kwh REAL, onpeak_import_occurred INTEGER,
    actual_min_soc_pct REAL, actual_min_soc_ts_ms INTEGER, plan_traj_floor_breached INTEGER,
    cushion_breached INTEGER, grid_home_coverage_frac REAL, outage_during_day INTEGER, scored INTEGER,
    score_notes TEXT, pv_err_frac REAL, pv_in_band INTEGER, load_err_frac REAL, load_in_band INTEGER,
    buy_err_kwh REAL, soc_min_err_pct REAL, realized_cost_cents REAL, counterfactual_cost_cents REAL,
    realized_savings_cents REAL, demand_charge_savings_cents REAL, would_have_peak_imported INTEGER
  )`);
  // The force-charge stamps a v1.208.0 database already has: the column-add pass must leave them be.
  for (const col of ['force_charge_on_at_ms INTEGER', 'force_charge_off_at_ms INTEGER', 'force_charge_off_reason TEXT',
    'force_charge_off_verified_at_ms INTEGER', 'force_charge_mode TEXT']) {
    db.exec(`ALTER TABLE night_charge_ledger ADD COLUMN ${col}`);
  }
  db.prepare('INSERT INTO night_charge_ledger (plan_date, issued_at_ms, buy_kwh) VALUES (?, ?, ?)').run(OLD_QUIET_DAY, 1, 30.5);
  db.prepare(`INSERT INTO night_charge_ledger (plan_date, issued_at_ms, buy_kwh, force_charge_on_at_ms, force_charge_mode,
    force_charge_off_at_ms, force_charge_off_reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(OLD_ON_DAY, 2, 41, OLD_ON_AT, 'cost', OLD_ON_AT + 100 * MIN, 'windowEnd');
  db.close();
}

const { createRecorder, CHARGE_CYCLE_LEDGER_SCHEMA } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { legLedgerFields, legRoleOf } = await import('../src/chargeCycle.js');
const { emptyActuationState, coerceActuationState } = await import('../src/nightChargeActuator.js');
const {
  decideForceCharge, forceChargeOnStamp, forceChargeOnReadbackStatus, forceChargeOnFateColumns, forceChargeOnFateOf,
  FORCE_CHARGE_ON_VERIFY_AFTER_MS, FORCE_CHARGE_ON_MAX_RETRIES, FORCE_CHARGE_ON_RETRY_CUTOFF_MS,
} = await import('../src/nightForceCharge.js');
const { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } = await import('../src/nightChargeGate.js');
const { middayChargeHourEpochs } = await import('../src/nightLedgerScoring.js');
const { SHP2_SOURCE_SLOTS } = await import('../src/hwSpec.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

/** The six columns and their declared types, as the specification lists them. */
const FATE_SCHEMA: ReadonlyArray<readonly [string, 'INTEGER' | 'TEXT']> = [
  ['force_charge_on_failed_at_ms', 'INTEGER'],
  ['force_charge_on_failed_slots', 'TEXT'],
  ['force_charge_on_left_out', 'TEXT'],
  ['force_charge_on_retries', 'INTEGER'],
  ['force_charge_on_slots', 'TEXT'],
  ['force_charge_on_verified_at_ms', 'INTEGER'],
];
const FATE_COLUMNS = FATE_SCHEMA.map(([c]) => c);
const FATE_NAME = /\bforce_charge_on_(?:failed_at_ms|failed_slots|left_out|retries|slots|verified_at_ms)\b/;
type Row = Record<string, unknown>;
type Fate = Record<string, number | string | null>;

const openRecorder = () => createRecorder(new SnapshotStore(), () => {});
type Rec = ReturnType<typeof openRecorder>;
const rowOf = (rec: Rec, day: string): Row | undefined =>
  rec.readNightLedger(36_500).find((r) => r.plan_date === day) as unknown as Row | undefined;
const fateOfRow = (r: Row | undefined): Fate => Object.fromEntries(FATE_COLUMNS.map((c) => [c, (r as Row)[c]])) as Fate;
const tableInfo = (): Array<{ name: string; type: string }> => {
  const db = new DatabaseSync(DB);
  try { return db.prepare('PRAGMA table_info(night_charge_ledger)').all() as Array<{ name: string; type: string }>; }
  finally { db.close(); }
};

/* ── source text ─────────────────────────────────────────────────────────── */

const srcUrl = (rel: string): URL => new URL(`../src/${rel}`, import.meta.url);
const raw = (rel: string): string => readFileSync(srcUrl(rel), 'utf8');
/** A file's code lines: every line that is only a comment is dropped (the idiom of forceChargeOn.test.ts). */
const code = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const INDEX = code(raw('index.ts'));
const fnText = (src: string, head: string): string => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is in the source`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at, `${head} closes`);
  return src.slice(at, end + 3);
};
const TICK = INDEX.slice(INDEX.indexOf('async function runForceChargeTick('), INDEX.indexOf('async function escalateForceChargeStuck('));
const TRAILING = fnText(INDEX, 'async function runTrailingLegTick(');
const branch = (head: string): string => {
  const at = TICK.indexOf(head);
  assert.ok(at > 0, `runForceChargeTick has ${head}`);
  return TICK.slice(at, TICK.indexOf('\n  }\n', at));
};
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/* ── the night's record, and a mirror of index.ts's handlers ─────────────── */

const WIN_START = Date.UTC(2027, 2, 2, 6, 0); // 23:00 MST
const WIN_END = WIN_START + 6 * H;            // 05:00 MST
const ON_AT = WIN_END - 100 * MIN;            // a just-in-time start
const DUE = ON_AT + FORCE_CHARGE_ON_VERIFY_AFTER_MS;

/** A cost night whose reserve write was verified and whose panel ceiling is synced: armed, no ON yet. */
const armedNight = (day: string, over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...emptyActuationState(),
  day, targetPct: 50, buyKwh: 40,
  windowStartMs: WIN_START, windowEndMs: WIN_END,
  applyAttemptedAtMs: WIN_START - 5 * MIN, attemptBaselinePct: 16,
  appliedAtMs: WIN_START - 5 * MIN, priorReservePct: 16, applyVerifiedAtMs: WIN_START + MIN,
  forceChargeCeilingPct: 90, forceChargeCeilingAttemptedAtMs: WIN_START + MIN, forceChargeCeilingPriorPct: 100,
  ...over,
});

/** A live readback mid-charge: the pool well short of the 90% stop, every Core below the panel's 90% ceiling. */
const opts = (over: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false,
  slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
  ceilingReadbackPct: 90, poolSocPct: 62, fullKwh: 92,
  slotSocPct: { 1: 62, 2: 61, 3: 63 },
  ...over,
});

/** A record with an ON on it, built directly (the pure derivation's input). */
const onRecord = (over: Partial<NightActuationState> = {}): NightActuationState => ({
  ...armedNight('2027-03-01'), forceChargeOnAtMs: ON_AT, forceChargeSlots: [1, 2, 3], forceChargeMode: 'cost', ...over,
});

/**
 * The night as index.ts runs it, over a real recorder. Each method is the handler's own sequence (the record write,
 * then the ledger stamp), in the order the source pins of part 4 hold index.ts to. `lose` drops the ledger write of
 * one tick: a restart between the record write and the ledger stamp.
 */
function nightRun(rec: Rec, armed: NightActuationState) {
  let live: NightActuationState = armed;
  const actions: string[] = [];
  /** index.ts stampLegOutcome: to the leg's own columns; a stamp with no column for the leg is not written. */
  const stamp = (leg: NightActuationState, fields: Row): void => {
    if (leg.day == null) return;
    const cols = legLedgerFields(legRoleOf(leg as never), fields);
    if (Object.keys(cols).length === 0) return;
    rec.recordNightOutcome(leg.day, cols as never);
  };
  /** index.ts stampForceChargeOnFate: the live record of the same leg, through the one derivation. */
  const stampFate = (leg: NightActuationState, nulls: 'write' | 'omit'): void => {
    if (leg.day == null) return;
    if (live.day !== leg.day || live.windowStartMs !== leg.windowStartMs) return;
    stamp(leg, forceChargeOnFateColumns(live, nulls) as Row);
  };
  return {
    record: (): NightActuationState => live,
    actions,
    /** The 'on' handler: the write-ahead persist (with the slots left out), the attempt time, the ON stamp, the fate. */
    on(atMs: number, slots: number[], leftOut: number[] = [], o: { lose?: boolean } = {}): void {
      const state = live;
      const onStamp = forceChargeOnStamp(state, atMs, slots, { cost: true, line: false });
      live = { ...live, ...onStamp, forceChargeLeftOutSlots: leftOut.length > 0 ? [...leftOut] : null };
      live = { ...live, forceChargeOnLastAttemptMs: atMs };
      if (o.lose) return;
      stamp(state, { force_charge_on_at_ms: atMs, force_charge_mode: onStamp.forceChargeMode });
      stampFate(state, 'write');
    },
    /** One tick of the decision and its handler. `rateLimited`: every write of a re-issue came back rate-limited. */
    tick(nowMs: number, o: Partial<ForceChargeOpts> = {}, x: { lose?: boolean; rateLimited?: boolean } = {}): ForceChargeAction {
      const state = live;
      const action = decideForceCharge(state, nowMs, opts(o));
      actions.push(action.kind);
      if (action.kind === 'onVerified') {
        live = { ...live, forceChargeOnVerifiedAtMs: nowMs };
        if (!x.lose) stampFate(state, 'omit');
      } else if (action.kind === 'onRetry') {
        live = { ...live, forceChargeOnRetries: live.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: nowMs };
        live = {
          ...live, forceChargeOnLastAttemptMs: nowMs,
          ...(x.rateLimited ? { forceChargeOnRetries: Math.max(0, live.forceChargeOnRetries - 1) } : {}),
        };
        if (!x.lose) stampFate(state, 'omit');
      } else if (action.kind === 'onFailed') {
        live = { ...live, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] };
        if (!x.lose) stampFate(state, 'omit');
      } else if (action.kind === 'off') {
        live = { ...live, forceChargeOffAtMs: live.forceChargeOffAtMs ?? nowMs, forceChargeOffLastAttemptMs: nowMs, forceChargeOffReason: action.reason };
        if (state.forceChargeOffAtMs == null) {
          stamp(state, { force_charge_off_at_ms: nowMs, force_charge_off_reason: action.reason });
          stampFate(state, 'omit');
        }
      } else {
        assert.equal(action.kind, 'none', `the replay handles ${action.kind}`);
      }
      return action;
    },
  };
}

/* ══ 1. the columns ════════════════════════════════════════════════════════ */

test('★★★ the six fate columns are in the ONE schema list with the specified types, beside force_charge_mode, and nowhere by hand', () => {
  const types = new Map<string, string>(CHARGE_CYCLE_LEDGER_SCHEMA.map(([c, t]) => [c as string, t]));
  for (const [c, t] of FATE_SCHEMA) assert.equal(types.get(c), t, `${c} is declared ${t}`);
  const names = CHARGE_CYCLE_LEDGER_SCHEMA.map(([c]) => c as string);
  for (const c of FATE_COLUMNS) assert.equal(names.filter((n) => n === c).length, 1, `${c} is listed once`);
  const at = names.indexOf('force_charge_mode');
  assert.deepEqual(names.slice(at + 1, at + 7), FATE_COLUMNS, 'directly after force_charge_mode, sorted');
  assert.deepEqual([...FATE_COLUMNS].sort(), FATE_COLUMNS, 'the six are in name order');
  // The interface and the list are the only two places recorder.ts names a column: no hand-written ALTER string and no
  // entry in the hand-kept allowlist (the list feeds both, so a column cannot be in one and missing from the other).
  const rec = code(raw('recorder.ts'));
  for (const [c, t] of FATE_SCHEMA) {
    assert.equal((rec.match(new RegExp(`\\b${c}\\b`, 'g')) ?? []).length, 2, `${c}: the interface and the schema list`);
    assert.ok(rec.includes(`\n  ${c}: ${t === 'TEXT' ? 'string' : 'number'} | null;\n`), `${c} on NightLedgerRow, nullable`);
    assert.ok(rec.includes(`['${c}', '${t}']`), `${c} in CHARGE_CYCLE_LEDGER_SCHEMA`);
    assert.ok(!rec.includes(`'${c} ${t}'`), `${c} is in no ALTER string of its own`);
  }
  assert.ok(rec.includes('...CHARGE_CYCLE_LEDGER_SCHEMA.map(([c, t]) => `${c} ${t}`),'), 'the column-add pass reads the list');
  assert.ok(rec.includes('...CHARGE_CYCLE_LEDGER_SCHEMA.map(([c]) => c),'), 'and so does the allowlist');
});

test('★★★ a v1.208.0 database gains the six columns with their types on the first start and nothing on the second; its rows read NULL and are never "unconfirmed"', () => {
  const before = tableInfo();
  for (const c of FATE_COLUMNS) assert.ok(!before.some((i) => i.name === c), `${c} is not there before the first start`);
  let first: Array<{ name: string; type: string }>;
  const rec = openRecorder();
  try {
    first = tableInfo();
    const types = new Map(first.map((c) => [c.name, c.type]));
    for (const [c, t] of FATE_SCHEMA) assert.equal(types.get(c), t, `${c} ${t} added by the migration`);
    for (const c of FATE_COLUMNS) assert.equal(first.filter((i) => i.name === c).length, 1);
    // The rows written before the release: kept, NULL in all six.
    const on = rowOf(rec, OLD_ON_DAY)!;
    const quiet = rowOf(rec, OLD_QUIET_DAY)!;
    assert.deepEqual([on.buy_kwh, on.force_charge_on_at_ms, on.force_charge_mode, on.force_charge_off_reason], [41, OLD_ON_AT, 'cost', 'windowEnd'], 'kept as recorded');
    assert.equal(quiet.buy_kwh, 30.5);
    for (const c of FATE_COLUMNS) {
      assert.equal(on[c], null, `${c} is NULL on a row older than the release`);
      assert.equal(quiet[c], null, `${c} is NULL on a row with no ON`);
    }
    // An ON with no fate recorded is "not recorded": never read as an ON that was not confirmed.
    assert.equal(forceChargeOnFateOf(on), 'notRecorded');
    assert.equal(forceChargeOnFateOf(quiet), 'none');
  } finally { rec.close(); }
  const again = openRecorder();
  try {
    assert.deepEqual(tableInfo(), first, 'the second start adds nothing');
    assert.equal(forceChargeOnFateOf(rowOf(again, OLD_ON_DAY)!), 'notRecorded');
  } finally { again.close(); }
});

test('★★ the six columns round-trip through the allowlist: a number, slot text, 0 and NULL each read back as written', () => {
  const rec = openRecorder();
  try {
    const day = '2027-02-01';
    const full: Fate = {
      force_charge_on_failed_at_ms: 1_800_000_000_123, force_charge_on_failed_slots: '2,3', force_charge_on_left_out: '1',
      force_charge_on_retries: 1, force_charge_on_slots: '2,3', force_charge_on_verified_at_ms: 1_800_000_900_456,
    };
    rec.recordNightOutcome(day, full as never);
    assert.deepEqual(fateOfRow(rowOf(rec, day)), full, 'a column missing from the allowlist would be dropped in silence');
    // 0 is a value, not NULL: it is the mark that the fate was recorded.
    rec.recordNightOutcome(day, { force_charge_on_retries: 0 } as never);
    assert.deepEqual(fateOfRow(rowOf(rec, day)), { ...full, force_charge_on_retries: 0 }, 'one column written, the other five kept');
    assert.equal(typeof rowOf(rec, day)!.force_charge_on_retries, 'number');
    // A NULL that is named is written (the ON's stamp writes them: a fresh ON has a fresh fate).
    const cleared: Fate = { ...full, force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null, force_charge_on_verified_at_ms: null };
    rec.recordNightOutcome(day, cleared as never);
    assert.deepEqual(fateOfRow(rowOf(rec, day)), cleared);
  } finally { rec.close(); }
});

test('★★★ the plan row never touches the fate: a re-issued plan leaves all six as they were, and recordNightPlanRow names none of them', () => {
  const rec = openRecorder();
  try {
    const day = '2027-02-02';
    const plan = (buy: number) => ({ plan_date: day, issued_at_ms: buy, algo_version: '3', posture: 'auto', objective: 'cost_arbitrage', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 30, target_soc_pct: 80, buy_kwh: buy, required_extra_kwh: 26,
      reserve_floor_pct: 30, cushion_pct: 15, cushion_kwh: 22.2, binding_cap: 'requirement', cushion_shortfall: 0, window_kind: 'overnight' });
    rec.recordNightPlan(plan(40) as never);
    const cols = forceChargeOnFateColumns(onRecord({ day, forceChargeOnRetries: 1, forceChargeOnVerifiedAtMs: DUE + MIN, forceChargeLeftOutSlots: [1], forceChargeSlots: [2, 3] }));
    rec.recordNightOutcome(day, { force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost', ...cols } as never);
    const stamped = fateOfRow(rowOf(rec, day));
    assert.deepEqual(stamped, {
      force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: '1',
      force_charge_on_retries: 1, force_charge_on_slots: '2,3', force_charge_on_verified_at_ms: DUE + MIN,
    });
    rec.recordNightPlan(plan(28) as never); // the plan of record re-issued (the morning refresh, a later evening run)
    const reissued = rowOf(rec, day)!;
    assert.equal(reissued.buy_kwh, 28, 'the plan columns follow the re-issue');
    assert.deepEqual(fateOfRow(reissued), stamped, 'the fate does not');
    assert.deepEqual([reissued.force_charge_on_at_ms, reissued.force_charge_mode], [ON_AT, 'cost']);
  } finally { rec.close(); }
  const planRow = fnText(INDEX, 'function recordNightPlanRow(');
  assert.ok(planRow.includes('recorder.recordNightPlan(row);'), 'the plan writer');
  assert.doesNotMatch(planRow, FATE_NAME, 'no fate column in the plan row');
  assert.doesNotMatch(planRow, /forceChargeOnFate|force_charge_on_at_ms|force_charge_mode/, 'nor any force-charge stamp');
});

/* ══ 2. the derivation ═════════════════════════════════════════════════════ */

test('★★★ no ON gives nothing at all: a row is never stamped with a fate for an ON that was not sent', () => {
  assert.deepEqual(forceChargeOnFateColumns(emptyActuationState()), {});
  assert.deepEqual(forceChargeOnFateColumns(emptyActuationState(), 'omit'), {});
  assert.deepEqual(forceChargeOnFateColumns(armedNight('2027-03-01')), {}, 'armed, the force-charge never started');
  // Every other fate field set, and still no ON time: nothing (never a half fate).
  const stray = { ...onRecord({ forceChargeOnRetries: 1, forceChargeOnVerifiedAtMs: DUE, forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: [2], forceChargeLeftOutSlots: [1] }), forceChargeOnAtMs: null };
  assert.deepEqual(forceChargeOnFateColumns(stray), {});
  assert.deepEqual(forceChargeOnFateColumns(stray, 'omit'), {});
  assert.deepEqual(forceChargeOnFateColumns({ ...stray, forceChargeOnAtMs: undefined } as never), {}, 'a record from before the field');
  // Through the stamp: the cost leg's columns are the fields as given, so nothing is left to write, and stampLegOutcome
  // returns before the recorder. That return carries weight: an upsert with no column still makes the row.
  assert.deepEqual(legLedgerFields('cost', forceChargeOnFateColumns(armedNight('2027-02-03'), 'omit') as Row), {});
  const stampLeg = fnText(INDEX, 'function stampLegOutcome(');
  assert.ok(stampLeg.includes('  if (Object.keys(cols).length === 0) return;\n  try { recorder.recordNightOutcome(leg.day, cols); }'));
  const rec = openRecorder();
  try {
    assert.equal(rowOf(rec, '2027-02-03'), undefined);
    rec.recordNightOutcome('2027-02-03', {} as never);
    assert.ok(rowOf(rec, '2027-02-03') != null, 'a bare upsert makes a row: the stamp must not reach the recorder with nothing');
    for (const c of FATE_COLUMNS) assert.equal(rowOf(rec, '2027-02-03')![c], null);
  } finally { rec.close(); }
});

test('★★★ a fresh ON: retries 0, the slots it was sent to, the slots left out or NULL, and NULL for every verdict not yet reached', () => {
  const fresh = forceChargeOnFateColumns(onRecord());
  assert.deepEqual(fresh, {
    force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null,
    force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: null,
  });
  assert.deepEqual(Object.keys(fresh).sort(), FATE_COLUMNS, 'all six are named, NULLs included: a fresh ON has a fresh fate');
  assert.deepEqual(forceChargeOnFateColumns(onRecord(), 'write'), fresh, "'write' is the default");
  // A slot left out for the pool alarm is not among the slots the ON went to.
  assert.deepEqual(forceChargeOnFateColumns(onRecord({ forceChargeSlots: [2, 3], forceChargeLeftOutSlots: [1] })), {
    ...fresh, force_charge_on_left_out: '1', force_charge_on_slots: '2,3',
  });
  assert.deepEqual(forceChargeOnFateColumns(onRecord({ forceChargeSlots: [3], forceChargeLeftOutSlots: [2, 1] })), {
    ...fresh, force_charge_on_left_out: '1,2', force_charge_on_slots: '3',
  });
  // Every key is a ledger column the allowlist takes, with the declared kind of value.
  const types = new Map<string, string>(CHARGE_CYCLE_LEDGER_SCHEMA.map(([c, t]) => [c as string, t]));
  const full = forceChargeOnFateColumns(onRecord({ forceChargeOnRetries: 1, forceChargeOnVerifiedAtMs: DUE, forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: [2], forceChargeLeftOutSlots: [1] })) as Fate;
  for (const [c, v] of Object.entries(full)) assert.equal(typeof v, types.get(c) === 'TEXT' ? 'string' : 'number', c);
});

test('★★★ verified; failed with its slots; a late verify after a failure keeps both stamps', () => {
  const base = forceChargeOnFateColumns(onRecord());
  assert.deepEqual(forceChargeOnFateColumns(onRecord({ forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN })),
    { ...base, force_charge_on_verified_at_ms: ON_AT + 3 * MIN });
  assert.deepEqual(forceChargeOnFateColumns(onRecord({ forceChargeOnRetries: 1, forceChargeOnVerifiedAtMs: DUE + 3 * MIN })),
    { ...base, force_charge_on_retries: 1, force_charge_on_verified_at_ms: DUE + 3 * MIN }, 'after one re-issue');
  const failed = onRecord({ forceChargeOnRetries: 1, forceChargeOnFailedAtMs: DUE + 15 * MIN, forceChargeOnFailedSlots: [3, 2] });
  assert.deepEqual(forceChargeOnFateColumns(failed),
    { ...base, force_charge_on_retries: 1, force_charge_on_failed_at_ms: DUE + 15 * MIN, force_charge_on_failed_slots: '2,3' });
  // The ON applied after the warning: the failure is history and stays on the row beside the verification.
  const late = forceChargeOnFateColumns({ ...failed, forceChargeOnVerifiedAtMs: DUE + 40 * MIN });
  assert.deepEqual(late, {
    ...base, force_charge_on_retries: 1, force_charge_on_failed_at_ms: DUE + 15 * MIN, force_charge_on_failed_slots: '2,3',
    force_charge_on_verified_at_ms: DUE + 40 * MIN,
  });
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: ON_AT, ...late }), 'verified', 'and the row reads verified');
  // The failed slots are the slots still off AT that verdict: with no verdict time there is none to name.
  assert.equal(forceChargeOnFateColumns(onRecord({ forceChargeOnFailedSlots: [2, 3] })).force_charge_on_failed_slots, null);
  // A failure recorded before the failed slots were kept: the time, no slots.
  assert.deepEqual(forceChargeOnFateColumns(onRecord({ forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: null })),
    { ...base, force_charge_on_failed_at_ms: DUE });
});

test('★★★ slot text is slot numbers only: ascending, comma-joined, no spaces, each once, 1..3, never an empty string', () => {
  const text = (slots: unknown, key: 'forceChargeSlots' | 'forceChargeLeftOutSlots' | 'forceChargeOnFailedSlots' = 'forceChargeSlots') => {
    const cols = forceChargeOnFateColumns(onRecord({ forceChargeOnFailedAtMs: DUE, [key]: slots } as never)) as Fate;
    return cols[key === 'forceChargeSlots' ? 'force_charge_on_slots' : key === 'forceChargeLeftOutSlots' ? 'force_charge_on_left_out' : 'force_charge_on_failed_slots'];
  };
  assert.equal(SHP2_SOURCE_SLOTS, 3);
  for (const key of ['forceChargeSlots', 'forceChargeLeftOutSlots', 'forceChargeOnFailedSlots'] as const) {
    assert.equal(text([1, 2, 3], key), '1,2,3');
    assert.equal(text([3, 1, 2], key), '1,2,3', 'ascending, whatever order the record holds');
    assert.equal(text([2], key), '2');
    assert.equal(text([3, 3, 1, 1], key), '1,3', 'each slot once');
    // Empty or unreadable: NULL, never ''.
    for (const none of [[], null, undefined, 'serial-1,2', 7, { 0: 1, length: 1 }, [0], [4], [-1], [1.5], [Number.NaN], ['2'], [[1]], [null]]) {
      assert.equal(text(none, key), null, `${key} ${JSON.stringify(none)} gives NULL`);
    }
    // Whatever else is in the list, only an integer 1..3 reaches the text.
    assert.equal(text(['R35-serial', 2, 0, 4, 2.5, '3', { slot: 1 }, Number.POSITIVE_INFINITY, 1, -2, null], key), '1,2');
  }
  // Every text the derivation can give, over every list of the three slots in every order.
  const lists: number[][] = [[]];
  for (let n = 0; n < 4; n++) for (const l of [...lists]) for (const s of [1, 2, 3]) if (l.length === n) lists.push([...l, s]);
  for (const l of lists) {
    const t = text(l);
    if (l.length === 0) { assert.equal(t, null); continue; }
    assert.match(String(t), /^[1-3](,[1-3])*$/, JSON.stringify(l));
    assert.deepEqual(String(t).split(',').map(Number), [...new Set(l)].sort((a, b) => a - b), JSON.stringify(l));
  }
  assert.ok(lists.length > 100, `${lists.length} lists`);
});

test('★★ the re-issue count is always a whole number, 0 or more, once an ON was sent; a time that is not a finite number is NULL', () => {
  const retries = (v: unknown) => forceChargeOnFateColumns(onRecord({ forceChargeOnRetries: v } as never)).force_charge_on_retries;
  for (const n of [0, 1, 2]) assert.equal(retries(n), n);
  for (const hostile of [-1, -0.5, 0.4, 1.5, 2.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '2', null, undefined, {}, [1], true]) {
    for (const nulls of ['write', 'omit'] as const) {
      const v = forceChargeOnFateColumns(onRecord({ forceChargeOnRetries: hostile } as never), nulls).force_charge_on_retries;
      assert.ok(typeof v === 'number' && Number.isInteger(v) && v >= 0, `${String(hostile)} (${nulls}) gives ${String(v)}: never NULL, which a reader takes for "not recorded"`);
      if (typeof hostile === 'number' && Number.isFinite(hostile) && hostile >= 0) assert.ok(v <= hostile, 'never more re-issues than the record holds');
    }
  }
  for (const key of ['forceChargeOnVerifiedAtMs', 'forceChargeOnFailedAtMs'] as const) {
    const col = key === 'forceChargeOnVerifiedAtMs' ? 'force_charge_on_verified_at_ms' : 'force_charge_on_failed_at_ms';
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, 'soon', {}, undefined, null]) {
      const cols = forceChargeOnFateColumns(onRecord({ [key]: hostile, forceChargeOnFailedSlots: [2] } as never)) as Fate;
      assert.equal(cols[col], null, `${key} ${String(hostile)}`);
      if (key === 'forceChargeOnFailedAtMs') assert.equal(cols.force_charge_on_failed_slots, null, 'no slots beside no verdict');
    }
  }
  // The input is read, never changed.
  const frozen = Object.freeze({ ...onRecord({ forceChargeOnFailedAtMs: DUE }), forceChargeSlots: Object.freeze([3, 1, 2]), forceChargeOnFailedSlots: Object.freeze([3, 2]), forceChargeLeftOutSlots: Object.freeze([1]) });
  assert.equal(forceChargeOnFateColumns(frozen as never).force_charge_on_slots, '1,2,3');
  assert.deepEqual(frozen.forceChargeSlots, [3, 1, 2]);
});

test("★★★ 'omit' is the same values less the NULLs, the count always among them: a later stamp never erases what the row holds", () => {
  const records: NightActuationState[] = [
    onRecord(),
    onRecord({ forceChargeLeftOutSlots: [1], forceChargeSlots: [2, 3] }),
    onRecord({ forceChargeOnVerifiedAtMs: DUE }),
    onRecord({ forceChargeOnRetries: 1, forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: [2, 3] }),
    onRecord({ forceChargeOnRetries: 1, forceChargeOnFailedAtMs: DUE, forceChargeOnFailedSlots: [2, 3], forceChargeOnVerifiedAtMs: DUE + H }),
    onRecord({ forceChargeSlots: null }),
    onRecord({ forceChargeSlots: [] }),
  ];
  for (const r of records) {
    const all = forceChargeOnFateColumns(r) as Fate;
    const kept = forceChargeOnFateColumns(r, 'omit') as Fate;
    assert.deepEqual(kept, Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null)));
    assert.ok(!Object.values(kept).some((v) => v == null), 'no NULL and no undefined is named');
    assert.equal(typeof kept.force_charge_on_retries, 'number', 'the count is in every stamp');
  }
  assert.deepEqual(forceChargeOnFateColumns(onRecord(), 'omit'), { force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' });
  // On the row: a verification the row holds survives a stamp from a record that no longer has it.
  const rec = openRecorder();
  try {
    const day = '2027-02-04';
    rec.recordNightOutcome(day, { force_charge_on_at_ms: ON_AT, ...forceChargeOnFateColumns(onRecord({ forceChargeOnVerifiedAtMs: DUE, forceChargeLeftOutSlots: [1], forceChargeSlots: [2, 3] })) } as never);
    rec.recordNightOutcome(day, forceChargeOnFateColumns(onRecord({ forceChargeSlots: [2, 3], forceChargeOnRetries: 1 }), 'omit') as never);
    assert.deepEqual(fateOfRow(rowOf(rec, day)), {
      force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: '1',
      force_charge_on_retries: 1, force_charge_on_slots: '2,3', force_charge_on_verified_at_ms: DUE,
    });
    // The ON's own stamp ('write') does start the fate again: a second ON on the row is a fresh one. (No cast: the
    // derivation's columns are a ledger row's, by type, in both forms.)
    rec.recordNightOutcome(day, forceChargeOnFateColumns(onRecord()));
    assert.deepEqual(fateOfRow(rowOf(rec, day)), forceChargeOnFateColumns(onRecord()));
  } finally { rec.close(); }
});

test('★★ a backup leg has no fate column: its stamp writes nothing', () => {
  const cols = forceChargeOnFateColumns(onRecord({ forceChargeOnVerifiedAtMs: DUE })) as Row;
  assert.deepEqual(legLedgerFields('backup', cols), {});
  assert.deepEqual(legLedgerFields('cost', cols), cols, 'the cost leg (overnight or mid-day) writes the row\'s own columns');
  const rec = openRecorder();
  try {
    const run = nightRun(rec, { ...armedNight('2027-02-05'), leg: 'backup' } as never);
    run.on(ON_AT, [1, 2, 3]);
    assert.equal(rowOf(rec, '2027-02-05'), undefined);
  } finally { rec.close(); }
});

/* ══ 3. the verdict ════════════════════════════════════════════════════════ */

test('★★★ forceChargeOnFateOf: none, notRecorded, verified, failed, unconfirmed; verified wins over failed', () => {
  const T = ON_AT;
  assert.equal(forceChargeOnFateOf({}), 'none');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, force_charge_on_retries: null, force_charge_on_verified_at_ms: null, force_charge_on_failed_at_ms: null }), 'none');
  // An ON stamp with no count: a row older than the release. Never "unconfirmed".
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T }), 'notRecorded');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: null, force_charge_on_verified_at_ms: null, force_charge_on_failed_at_ms: null }), 'notRecorded');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: 0 }), 'unconfirmed');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: 1, force_charge_on_verified_at_ms: null, force_charge_on_failed_at_ms: null }), 'unconfirmed');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: 0, force_charge_on_verified_at_ms: T + MIN }), 'verified');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: 0, force_charge_on_failed_at_ms: T + 15 * MIN }), 'failed');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: 1, force_charge_on_failed_at_ms: T + 30 * MIN, force_charge_on_verified_at_ms: T + 50 * MIN }),
    'verified', 'a late apply after the failure verdict is a verified ON');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: 0, force_charge_on_retries: 0, force_charge_on_verified_at_ms: 0 }), 'verified', 'a time of 0 is a time');
  // The ledger's verdict is the record's own (forceChargeOnReadbackStatus), read from the columns every stamp writes.
  const twin: Record<string, ForceChargeOnFate> = { verified: 'verified', failed: 'failed', unverified: 'unconfirmed' };
  for (const verifiedAt of [null, DUE]) for (const failedAt of [null, DUE + MIN]) for (const retries of [0, 1]) for (const nulls of ['write', 'omit'] as const) {
    const r = onRecord({ forceChargeOnVerifiedAtMs: verifiedAt, forceChargeOnFailedAtMs: failedAt, forceChargeOnFailedSlots: failedAt == null ? null : [3], forceChargeOnRetries: retries });
    const row = { force_charge_on_at_ms: r.forceChargeOnAtMs, ...forceChargeOnFateColumns(r, nulls) };
    assert.equal(forceChargeOnFateOf(row), twin[forceChargeOnReadbackStatus(r)!], JSON.stringify(row));
  }
  assert.equal(forceChargeOnReadbackStatus(emptyActuationState()), null);
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, ...forceChargeOnFateColumns(emptyActuationState()) }), 'none');
});

test('★★★ the four nights of the specification, through the decision, the handlers and the recorder', () => {
  const rec = openRecorder();
  try {
    const NONE: Fate = { force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null,
      force_charge_on_retries: null, force_charge_on_slots: null, force_charge_on_verified_at_ms: null };
    const read = (day: string) => {
      const r = rowOf(rec, day)!;
      return { fate: fateOfRow(r), verdict: forceChargeOnFateOf(r), onAt: r.force_charge_on_at_ms, offReason: r.force_charge_off_reason, mode: r.force_charge_mode };
    };

    // 1. Verified at the first check: a readback three minutes after the ON shows every slot ON.
    const first = nightRun(rec, armedNight('2027-03-01'));
    first.on(ON_AT, [1, 2, 3]);
    assert.deepEqual(read('2027-03-01'), { fate: { ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' }, verdict: 'unconfirmed', onAt: ON_AT, offReason: null, mode: 'cost' },
      'at the ON: the count 0 and the slots, no verdict yet');
    first.tick(ON_AT + 3 * MIN);
    first.tick(WIN_END);
    assert.deepEqual(first.actions, ['onVerified', 'off']);
    assert.deepEqual(read('2027-03-01'), {
      fate: { ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: ON_AT + 3 * MIN },
      verdict: 'verified', onAt: ON_AT, offReason: 'windowEnd', mode: 'cost',
    });

    // 2. One slot re-issued, then verified: slot 3 still reads OFF at the check and takes the re-issue.
    const second = nightRun(rec, armedNight('2027-03-02'));
    second.on(ON_AT, [1, 2, 3]);
    second.tick(ON_AT + 3 * MIN, { slotsOn: [1, 2] });
    second.tick(DUE, { slotsOn: [1, 2] });
    assert.deepEqual(read('2027-03-02').fate, { ...NONE, force_charge_on_retries: 1, force_charge_on_slots: '1,2,3' }, 'the re-issue is on the row before any verdict');
    assert.equal(read('2027-03-02').verdict, 'unconfirmed');
    second.tick(DUE + 3 * MIN);
    second.tick(WIN_END);
    assert.deepEqual(second.actions, ['none', 'onRetry', 'onVerified', 'off']);
    assert.deepEqual(read('2027-03-02'), {
      fate: { ...NONE, force_charge_on_retries: 1, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: DUE + 3 * MIN },
      verdict: 'verified', onAt: ON_AT, offReason: 'windowEnd', mode: 'cost',
    });

    // 3. No slot took it and no re-issue was possible (2026-11-16): slot 1's Core at the panel's ceiling (excused),
    //    slots 2 and 3 OFF, the check inside the re-issue cutoff before the close.
    const LATE_ON = WIN_END - FORCE_CHARGE_ON_RETRY_CUTOFF_MS - 10 * MIN;
    const CHECK = LATE_ON + FORCE_CHARGE_ON_VERIFY_AFTER_MS;
    const third = nightRun(rec, armedNight('2027-03-03'));
    third.on(LATE_ON, [1, 2, 3]);
    const failed = third.tick(CHECK, { slotsOn: [], slotSocPct: { 1: 96, 2: 61, 3: 63 } });
    assert.deepEqual(failed, { kind: 'onFailed', slots: [2, 3], noRetry: true });
    third.tick(WIN_END, { slotsOn: [] });
    assert.deepEqual(third.actions, ['onFailed', 'off']);
    assert.deepEqual(read('2027-03-03'), {
      fate: { ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_failed_at_ms: CHECK, force_charge_on_failed_slots: '2,3' },
      verdict: 'failed', onAt: LATE_ON, offReason: 'windowEnd', mode: 'cost',
    });
    //    The same night with the slot left out of the ON (its Core named out of the pool): failed on 2,3 of 2,3.
    const thirdB = nightRun(rec, armedNight('2027-03-13'));
    thirdB.on(LATE_ON, [2, 3], [1]);
    assert.deepEqual(thirdB.tick(CHECK, { slotsOn: [], connectedSlots: [2, 3], poolOutSlots: [1] }), { kind: 'onFailed', slots: [2, 3], noRetry: true });
    assert.deepEqual(read('2027-03-13').fate, {
      ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '2,3', force_charge_on_left_out: '1', force_charge_on_failed_at_ms: CHECK, force_charge_on_failed_slots: '2,3',
    });
    assert.equal(read('2027-03-13').verdict, 'failed');

    // 4. Never confirmed: no live readback between the ON and the stop at the window close.
    const fourth = nightRun(rec, armedNight('2027-03-04'));
    fourth.on(WIN_END - 10 * MIN, [1, 2, 3]);
    fourth.tick(WIN_END - 5 * MIN, { slotsOn: null });
    fourth.tick(WIN_END, { slotsOn: null });
    assert.deepEqual(fourth.actions, ['none', 'off']);
    assert.deepEqual(read('2027-03-04'), {
      fate: { ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' },
      verdict: 'unconfirmed', onAt: WIN_END - 10 * MIN, offReason: 'windowEnd', mode: 'cost',
    });
    // After the OFF the ON is never judged again: a readback showing every slot ON changes nothing on the row.
    fourth.tick(WIN_END + MIN, { slotsOn: [1, 2, 3] });
    assert.equal(read('2027-03-04').verdict, 'unconfirmed');
    assert.equal(fourth.record().forceChargeOnVerifiedAtMs, null);

    // A late apply after the failure warning: both times on the row, read as verified.
    const late = nightRun(rec, armedNight('2027-03-05'));
    late.on(ON_AT, [1, 2, 3]);
    late.tick(DUE, { slotsOn: [1] });
    late.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [1] });
    assert.equal(read('2027-03-05').verdict, 'failed');
    late.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS + 5 * MIN);
    assert.deepEqual(late.actions, ['onRetry', 'onFailed', 'onVerified']);
    assert.deepEqual(read('2027-03-05').fate, {
      ...NONE, force_charge_on_retries: FORCE_CHARGE_ON_MAX_RETRIES, force_charge_on_slots: '1,2,3',
      force_charge_on_failed_at_ms: DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, force_charge_on_failed_slots: '2,3',
      force_charge_on_verified_at_ms: DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS + 5 * MIN,
    });
    assert.equal(read('2027-03-05').verdict, 'verified');
  } finally { rec.close(); }
});

test('★★★ the re-issue count on the row is the record\'s own: it goes down when a re-issue is handed back, and is never an increment', () => {
  const rec = openRecorder();
  try {
    const day = '2027-03-06';
    const run = nightRun(rec, armedNight(day));
    run.on(ON_AT, [1, 2, 3]);
    // Every write of the re-issue came back rate-limited: it never reached the panel and is handed back.
    run.tick(DUE, { slotsOn: [1, 2] }, { rateLimited: true });
    assert.equal(run.record().forceChargeOnRetries, 0);
    assert.equal(rowOf(rec, day)!.force_charge_on_retries, 0, 'the count after the hand-back, not the count spent');
    // It falls due again and goes out.
    run.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [1, 2] });
    assert.deepEqual(run.actions, ['onRetry', 'onRetry']);
    assert.equal(rowOf(rec, day)!.force_charge_on_retries, 1, 'two runs of the handler, one re-issue made');
    // The same stamp twice writes the same row (an absolute figure).
    const before = fateOfRow(rowOf(rec, day));
    rec.recordNightOutcome(day, forceChargeOnFateColumns(run.record(), 'omit'));
    assert.deepEqual(fateOfRow(rowOf(rec, day)), before);
  } finally { rec.close(); }
});

test('★★★ the first OFF re-stamps the whole fate from the record: a stamp lost to a restart is repaired, and nothing the row holds is erased', () => {
  const rec = openRecorder();
  try {
    // The verify's ledger write is lost (the record was written, the process stopped before the stamp).
    const lostVerify = nightRun(rec, armedNight('2027-03-07'));
    lostVerify.on(ON_AT, [1, 2, 3]);
    lostVerify.tick(ON_AT + 3 * MIN, {}, { lose: true });
    assert.equal(forceChargeOnFateOf(rowOf(rec, '2027-03-07')!), 'unconfirmed', 'the row has not heard');
    lostVerify.tick(WIN_END);
    assert.equal(rowOf(rec, '2027-03-07')!.force_charge_on_verified_at_ms, ON_AT + 3 * MIN);
    assert.equal(forceChargeOnFateOf(rowOf(rec, '2027-03-07')!), 'verified');

    // The re-issue's ledger write is lost, then the failure verdict's: the OFF stamps both.
    const lostFail = nightRun(rec, armedNight('2027-03-08'));
    lostFail.on(ON_AT, [1, 2, 3]);
    lostFail.tick(DUE, { slotsOn: [1] }, { lose: true });
    lostFail.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [1] }, { lose: true });
    assert.deepEqual(lostFail.actions, ['onRetry', 'onFailed']);
    assert.equal(rowOf(rec, '2027-03-08')!.force_charge_on_retries, 0);
    lostFail.tick(WIN_END, { slotsOn: [1] });
    const repaired = rowOf(rec, '2027-03-08')!;
    assert.deepEqual([repaired.force_charge_on_retries, repaired.force_charge_on_failed_at_ms, repaired.force_charge_on_failed_slots], [1, DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, '2,3']);
    assert.equal(forceChargeOnFateOf(repaired), 'failed');

    // A night whose ON was sent and judged by the release before the columns, its OFF after the upgrade: the row had
    // an ON time and no fate; the OFF's re-stamp records it.
    const day = '2027-03-09';
    rec.recordNightOutcome(day, { force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost' } as never);
    assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), 'notRecorded');
    const upgraded = nightRun(rec, onRecord({ day, forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN, forceChargeOnLastAttemptMs: ON_AT }));
    upgraded.tick(WIN_END);
    assert.deepEqual(fateOfRow(rowOf(rec, day)), {
      force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null,
      force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: ON_AT + 3 * MIN,
    });
    assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), 'verified');

    // The other way round: the row heard the verify and the record lost it (the stamp went, the file write did not, the
    // process restarted). The OFF's re-stamp leaves NULLs out, so the verification on the row stands.
    const heard = nightRun(rec, armedNight('2027-03-11'));
    heard.on(ON_AT, [1, 2, 3]);
    heard.tick(ON_AT + 3 * MIN);
    const forgot = nightRun(rec, { ...heard.record(), forceChargeOnVerifiedAtMs: null });
    forgot.tick(WIN_END, { slotsOn: null });
    assert.deepEqual(forgot.actions, ['off']);
    assert.equal(rowOf(rec, '2027-03-11')!.force_charge_on_verified_at_ms, ON_AT + 3 * MIN, 'not erased by a record that no longer holds it');
    assert.equal(forceChargeOnFateOf(rowOf(rec, '2027-03-11')!), 'verified');

    // Every stamp of the ON lost (the fate's and the ON time's, a restart during the ON's own writes): the OFF records
    // the fate beside its own time. It does not write force_charge_on_at_ms, whose readers are unchanged in this
    // release; what verdict such a row should read is deliberately not asserted here.
    const allLost = nightRun(rec, armedNight('2027-03-10'));
    allLost.on(ON_AT, [1, 2, 3], [], { lose: true });
    assert.equal(rowOf(rec, '2027-03-10'), undefined);
    allLost.tick(WIN_END, { slotsOn: null });
    const once = rowOf(rec, '2027-03-10')!;
    assert.deepEqual([once.force_charge_off_at_ms, once.force_charge_off_reason, once.force_charge_on_retries, once.force_charge_on_slots, once.force_charge_on_verified_at_ms],
      [WIN_END, 'windowEnd', 0, '1,2,3', null]);
  } finally { rec.close(); }
});

/* ══ 4. the stamps (index.ts) ══════════════════════════════════════════════ */

test('★★★ index.ts: one helper stamps the fate, from the live record of the same leg, through the one derivation, and never throws', () => {
  const helper = fnText(INDEX, 'function stampForceChargeOnFate(');
  assert.ok(helper.startsWith("function stampForceChargeOnFate(leg: NightActuationState & { leg?: ChargeLegRole }, live: NightActuationState, nulls: 'write' | 'omit'): void {\n  try {\n"));
  assert.ok(helper.includes('    if (leg.day == null) return;\n    if (live.day !== leg.day || live.windowStartMs !== leg.windowStartMs) {\n'), 'another night\'s fate never reaches this row');
  assert.ok(helper.includes('      return;\n    }\n    stampLegOutcome(leg, forceChargeOnFateColumns(live, nulls));\n  } catch (e: any) {\n'), 'the write is stampLegOutcome\'s: the leg\'s own columns, a write of its own');
  assert.equal(count(helper, 'recorder.'), 0, 'no direct write to the recorder');
  assert.equal(count(helper, 'persist'), 0, 'and no write to the record');
  // No second derivation: the columns are named in no code line of index.ts, and the derivation is called once.
  assert.doesNotMatch(INDEX, FATE_NAME);
  assert.equal(count(INDEX, 'forceChargeOnFateColumns('), 1);
  assert.match(raw('index.ts'), /\n {2}forceChargeOnFateColumns,\n\} from '\.\/nightForceCharge\.js';/);
  // Six call sites: the ON ('write'), then the verify, the re-issue, the failure and the two first OFFs ('omit').
  assert.equal(count(INDEX, 'stampForceChargeOnFate('), 7, 'the helper and six calls');
  assert.equal(count(INDEX, "stampForceChargeOnFate(state, nightActuationMem, 'write');"), 1);
  assert.equal(count(INDEX, "stampForceChargeOnFate(state, nightActuationMem, 'omit');"), 4);
  assert.equal(count(INDEX, "stampForceChargeOnFate(t, cur(), 'omit');"), 1);
  assert.equal(count(TICK, 'stampForceChargeOnFate('), 5);
  assert.equal(count(TRAILING, 'stampForceChargeOnFate('), 1);
  assert.equal(count(fnText(INDEX, 'async function runNightActuationTickInner('), 'stampForceChargeOnFate('), 0, 'the reserve tick stamps no fate');
});

test('★★★ index.ts: the ON\'s existing stamp is unchanged, and the fate is a SECOND stamp after it', () => {
  const b = branch("if (action.kind === 'on') {");
  assert.equal(count(b, 'stampLegOutcome('), 1);
  assert.equal(count(b, 'stampLegOutcome(state, { force_charge_on_at_ms: nowMs, force_charge_mode: onMode });'), 1, 'two keys, as before: one failed write of the fate cannot take the ON time with it');
  assert.match(b, /\n {4}stampLegOutcome\(state, \{ force_charge_on_at_ms: nowMs, force_charge_mode: onMode \}\);[^\n]*\n {4}stampForceChargeOnFate\(state, nightActuationMem, 'write'\);\n/);
  assert.equal(count(b, 'stampForceChargeOnFate('), 1);
  // The record holds the ON (and the slots left out) before the stamp reads it, and the stamp reads the live record.
  const persist = b.indexOf('persistNightActuation({ ...nightActuationMem, ...onStamp, forceChargeLeftOutSlots: pool.leftOut.length > 0 ? [...pool.leftOut] : null });');
  const lastWrite = b.lastIndexOf('await setChannelForceCharge(');
  const fate = b.indexOf('stampForceChargeOnFate(');
  assert.ok(persist > 0 && lastWrite > persist && fate > lastWrite, 'the write-ahead persist, the writes, then the stamps');
  const log = b.indexOf('if (rejected > 0) app.log.warn(onLine); else app.log.info(onLine);');
  assert.ok(log > 0 && fate < log, 'before the ON\'s log line');
  assert.ok(b.indexOf('if (blocked) {') < persist && b.slice(b.indexOf('if (blocked) {'), persist).includes('return; }'), 'a refused ON stamps nothing');
});

test('★★★ index.ts: the verify and the failure stamp directly after the record persist; the failure before its awaited push', () => {
  const v = branch("if (action.kind === 'onVerified') {");
  assert.ok(v.includes("\n    persistNightActuation({ ...nightActuationMem, forceChargeOnVerifiedAtMs: nowMs });\n    stampForceChargeOnFate(state, nightActuationMem, 'omit');\n"));
  assert.equal(count(v, 'stampForceChargeOnFate('), 1);
  assert.equal(count(v, 'await '), 0, 'nothing is awaited in the verify');

  const f = branch("if (action.kind === 'onFailed') {");
  const persistLine = 'persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] });';
  const persist = f.indexOf(persistLine);
  const fate = f.indexOf("stampForceChargeOnFate(state, nightActuationMem, 'omit');");
  assert.ok(persist > 0 && fate > persist);
  assert.equal(count(f, 'stampForceChargeOnFate('), 1);
  // One line stands between them: a pure reading of two slot lists (nightChargeExpectedBuy.test.ts pins it directly
  // after the persist). Nothing is awaited, written or logged before the stamp.
  assert.match(f.slice(persist + persistLine.length, fate), /^\n {4}const all = partialForceChargeOnFailureSlots\(\{ forceChargeSlots: state\.forceChargeSlots, forceChargeOnFailedSlots: action\.slots \}\) == null;\n {4}$/);
  assert.ok(fate < f.indexOf('await '), 'before the awaited push: a restart during it would lose a stamp placed after');
  assert.ok(fate < f.indexOf('await sendNotification(loadNotifyConfig(), buildNightForceChargeOnFailure({'));
  assert.ok(fate < f.indexOf('app.log.warn('), 'and before the warning line');
  assert.ok(fate < f.indexOf('store.get()'), 'and before the Cores are read for the push');
});

test('★★★ index.ts: the re-issue stamps the live record\'s count AFTER the hand-back', () => {
  const b = branch("if (action.kind === 'onRetry') {");
  assert.match(b, /\n {6}\.\.\.\(unspent \? \{ forceChargeOnRetries: Math\.max\(0, nightActuationMem\.forceChargeOnRetries - 1\) \} : \{\}\),\n {4}\}\);\n {4}stampForceChargeOnFate\(state, nightActuationMem, 'omit'\);\n/);
  assert.equal(count(b, 'stampForceChargeOnFate('), 1);
  const spend = b.indexOf('forceChargeOnRetries: nightActuationMem.forceChargeOnRetries + 1,');
  const lastWrite = b.lastIndexOf('await setChannelForceCharge(');
  const fate = b.indexOf('stampForceChargeOnFate(');
  assert.ok(spend > 0 && lastWrite > spend && fate > lastWrite, 'spent write-ahead, the writes, the hand-back, then the stamp');
  // The live record, never the copy the tick read at its start, and never a count worked out at the call.
  assert.doesNotMatch(b, /stampForceChargeOnFate\([^)]*state\.forceChargeOnRetries/);
  assert.doesNotMatch(b, /stampLegOutcome\(/, 'no stamp of its own beside the helper');
  assert.ok(b.indexOf('if (blocked) {') < spend && b.slice(b.indexOf('if (blocked) {'), spend).includes('return; }'), 'a refused re-issue is unspent and stamps nothing');
});

test('★★★ index.ts: the first OFF re-stamps the fate, NULLs left out, on the active leg and on the trailing leg', () => {
  const b = branch("if (action.kind === 'off' || action.kind === 'offRetry') {");
  assert.match(b, /\n {4}if \(!isRetry && state\.forceChargeOffAtMs == null\) \{\n {6}stampLegOutcome\(state, \{ force_charge_off_at_ms: nowMs, force_charge_off_reason: action\.reason \}\);[^\n]*\n {6}stampForceChargeOnFate\(state, nightActuationMem, 'omit'\);\n {4}\}\n/);
  assert.equal(count(b, 'stampForceChargeOnFate('), 1);
  assert.match(TRAILING, /\n {4}if \(!isRetry && t\.forceChargeOffAtMs == null\) \{\n {6}stampLegOutcome\(t, \{ force_charge_off_at_ms: nowMs, force_charge_off_reason: action\.reason \}\);\n {6}stampForceChargeOnFate\(t, cur\(\), 'omit'\);\n {4}\}\n/);
  assert.ok(TRAILING.includes('  const cur = (): NightActuationState => nightCycleTrailing ?? t;\n'), 'the trailing record as it stands now');
  // The OFF's own time and reason stay a stamp of their own.
  assert.equal(count(INDEX, 'force_charge_off_at_ms: nowMs, force_charge_off_reason: action.reason }'), 2);
});

/* ══ 5. the readers the release leaves alone ═══════════════════════════════ */

test('★★★ forceChargeStateAt still reads the ON and OFF stamps only (open item: a night whose ON never took is still served as on)', () => {
  const fn = fnText(INDEX, 'function forceChargeStateAt(');
  assert.equal(fn, [
    "function forceChargeStateAt(hourStartMs: number): 'on' | 'off' | 'unknown' {",
    '  const hourEnd = hourStartMs + HOUR_MS;',
    '  const covers = (on: number | null | undefined, off: number | null | undefined, close: number | null | undefined): boolean =>',
    "    typeof on === 'number' && on < hourEnd && (typeof off === 'number' ? off : typeof close === 'number' ? close : Infinity) > hourStartMs;",
    '  const m = nightActuationMem;',
    "  if (covers(m.forceChargeOnAtMs, m.forceChargeOffAtMs, m.windowEndMs)) return 'on';",
    '  try {',
    '    for (const r of recorder.readNightLedger(45)) {',
    "      if (covers(r.force_charge_on_at_ms, r.force_charge_off_at_ms, r.window_end_ms)) return 'on';",
    '    }',
    "    return 'off';",
    '  } catch {',
    "    return 'unknown';",
    '  }',
    '}',
    '',
  ].join('\n'));
  // No reader decides on the verdict in this release: it is defined and called nowhere in the server.
  for (const f of serverSources()) assert.equal(count(f.code, 'forceChargeOnFateOf('), f.rel === 'nightForceCharge.ts' ? 1 : 0, f.rel);
});

/** Every .ts file under server/src, with its code lines (comment-only lines dropped). */
function serverSources(): Array<{ rel: string; code: string }> {
  return (readdirSync(srcUrl(''), { recursive: true }) as string[])
    .filter((p) => p.endsWith('.ts'))
    .map((rel) => ({ rel: rel.split('\\').join('/'), code: code(raw(rel)) }));
}

test('★★★ no other file names a fate column: the readers, the scorer and the web read none of them', () => {
  const files = serverSources();
  assert.ok(files.length > 100, `${files.length} source files read`);
  const naming = files.filter((f) => FATE_NAME.test(f.code)).map((f) => f.rel).sort();
  assert.deepEqual(naming, ['nightForceCharge.ts', 'recorder.ts'], 'the derivation and the schema; no second derivation anywhere');
  const web = (readdirSync(new URL('../../web/src/', import.meta.url), { recursive: true }) as string[])
    .filter((p) => /\.tsx?$/.test(p));
  assert.ok(web.length > 20, `${web.length} web files read`);
  for (const p of web) assert.doesNotMatch(readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8'), FATE_NAME, p);
});

test('★★★ the readiness gate\'s rule is unchanged: "it ran" is the ON stamp, whatever the fate columns say', () => {
  const gate = code(raw('nightChargeGate.ts'));
  assert.ok(gate.includes("    && r.force_charge_on_at_ms == null && (asNum(r.actuated) === 0 || String(r.arm_disposition ?? '').startsWith(MISSED_APPLY_DISPOSITION));\n"));
  assert.ok(gate.includes('    if (asNum(r.cushion_line_force_charge_pct) == null || !(truthy(r.actuated) || lineWriteNeverHeld(r) || lineReserveStood(r)) || r.force_charge_on_at_ms != null) return false;\n'));
  assert.equal(count(gate, 'force_charge_on_at_ms'), 2, 'the two reads of the ON stamp, and no other');
  assert.equal(CURRENT_ALGO_VERSION, 3, 'no scored column moves');
  // The comment no longer says the ledger has no such column; it says the gate does not read it.
  const text = raw('nightChargeGate.ts');
  assert.ok(!text.includes('no ON-verified column'));
  assert.match(text, /this gate does not READ them/);

  const NOW = Date.UTC(2026, 9, 31, 4, 30);
  const sent = NOW - 3 * DAY_MS + 3 * H;
  const row = (f: Row) => ({
    plan_date: phoenixYmd(NOW - 3 * DAY_MS), algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - 3 * DAY_MS, outcome_captured_at_ms: NOW - 2 * DAY_MS,
    scored: 1, actuated: 1, cushion_shortfall: 1, cushion_envelope_shortfall: 1, plan_traj_floor_breached: 0, cushion_breached: 1,
    buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: -0.05, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.95,
    reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: 93.63, cushion_trough_soc_pct: 93.63, window_kind: 'overnight',
    cushion_line_force_charge_pct: 94, force_charge_on_at_ms: null, window_close_soc_pct: 50, actual_min_soc_pct: 40,
    ...f,
  });
  const read = (f: Row) => computeNightChargeReadiness([row(f)] as never, NOW);
  const fates: Record<string, Row> = {
    unconfirmed: { force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' },
    failed: { force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_failed_at_ms: sent + 15 * MIN, force_charge_on_failed_slots: '1,2,3' },
    verified: { force_charge_on_retries: 1, force_charge_on_slots: '2,3', force_charge_on_left_out: '1', force_charge_on_verified_at_ms: sent + 18 * MIN },
    lateVerified: { force_charge_on_retries: 1, force_charge_on_slots: '1,2,3', force_charge_on_failed_at_ms: sent + 30 * MIN, force_charge_on_failed_slots: '3', force_charge_on_verified_at_ms: sent + 50 * MIN },
  };
  const shapes: Record<string, Row> = {
    'armed and disclosed, the ON sent': { force_charge_on_at_ms: sent },
    'armed and disclosed, no ON': {},
    'carried, the ON sent, closed under': { cushion_shortfall: 0, cushion_envelope_shortfall: 0, cushion_line_soc_pct: 55.55, cushion_trough_soc_pct: 55.55, cushion_line_force_charge_pct: 56, force_charge_on_at_ms: sent },
    'the write never held, no ON': { actuated: 0, cushion_shortfall: 0, cushion_envelope_shortfall: 0 },
    'the write never held, the ON sent': { actuated: 0, cushion_shortfall: 0, cushion_envelope_shortfall: 0, force_charge_on_at_ms: sent },
  };
  for (const [name, shape] of Object.entries(shapes)) {
    const base = read(shape);
    for (const [fate, cols] of Object.entries(fates)) assert.deepEqual(read({ ...shape, ...cols }), base, `${name}: ${fate} reads as a row with no fate columns`);
  }
  // The rule itself, as v1.208.0 has it: the ON stamp decides.
  assert.equal(read({}).metrics.activeStrikes, 1, 'armed, disclosed, never switched on, closed under its line');
  assert.equal(read({ force_charge_on_at_ms: sent }).metrics.activeStrikes, 0, 'an ON was sent: exempt');
  assert.equal(read({ force_charge_on_at_ms: sent, ...fates.failed }).metrics.activeStrikes, 0, 'open item of this release: exempt although the ON never took');
});

test('★★★ middayChargeHourEpochs still keys on the ON stamp: the fate columns move no hour', () => {
  const scoring = code(raw('nightLedgerScoring.ts'));
  assert.ok(scoring.includes("      || typeof r.actuation_applied_at_ms === 'number' || typeof r.force_charge_on_at_ms === 'number';\n"));
  assert.equal(count(scoring, 'force_charge_on'), 2, 'its row type and its one read');
  const a = Date.UTC(2026, 9, 15, 17);
  const b = a + 5 * H;
  const wrote = { window_kind: 'super_off_peak', window_start_ms: a, window_end_ms: b, actuated: null, force_charge_on_at_ms: a + H };
  const hours = middayChargeHourEpochs([wrote]);
  assert.equal(hours.size, 6);
  for (const cols of [
    { force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' },
    { force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_failed_at_ms: a + 2 * H, force_charge_on_failed_slots: '1,2,3' },
    { force_charge_on_retries: 1, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: a + 2 * H },
  ]) {
    assert.deepEqual([...middayChargeHourEpochs([{ ...wrote, ...cols }] as never)].sort(), [...hours].sort(), 'an ON of ours was sent: the hours are dropped whatever became of it');
    assert.equal(middayChargeHourEpochs([{ ...wrote, force_charge_on_at_ms: null, ...cols }] as never).size, 0, 'no ON stamp, no write: the fate alone drops nothing');
  }
});

/* ══ 6. the status route ═══════════════════════════════════════════════════ */

test('★★★ the status route serves ledger rows without authentication: only slot numbers reach the new text columns', () => {
  // The route serves the cached rows whole (SELECT *), so every new column is served.
  const route = INDEX.slice(INDEX.indexOf("app.get('/api/night-charge/status'"), INDEX.indexOf("app.post('/api/night-charge/cancel'"));
  assert.ok(route.includes('    recentOutcomes: nightRecentOutcomesMem,\n'));
  assert.ok(INDEX.includes('  try { nightRecentOutcomesMem = recorder.readNightLedger(7); }\n'));
  // A record holding a device serial, a name and worse in every field the derivation reads.
  const SERIAL = 'not-a-real-serial-0042';
  const hostile = {
    ...onRecord(),
    forceChargeOnAtMs: ON_AT,
    forceChargeSlots: [SERIAL, 3, { sn: SERIAL }, 'Core 2', 1, "1'); DROP TABLE night_charge_ledger;--"],
    forceChargeLeftOutSlots: [`slot 2 ${SERIAL}`, 2, 2, Number.NaN],
    forceChargeOnFailedSlots: ['garage', 3, 0, 9, '<script>'],
    forceChargeOnFailedAtMs: DUE,
    forceChargeOnVerifiedAtMs: SERIAL,
    forceChargeOnRetries: SERIAL,
    name: 'garage', sn: SERIAL, deviceName: 'Core 2',
  } as unknown as NightActuationState;
  for (const nulls of ['write', 'omit'] as const) {
    const cols = forceChargeOnFateColumns(hostile, nulls) as Fate;
    for (const k of Object.keys(cols)) assert.ok(FATE_COLUMNS.includes(k), `${k} is one of the six: nothing else of the record passes through`);
    assert.deepEqual([cols.force_charge_on_slots, cols.force_charge_on_left_out, cols.force_charge_on_failed_slots], ['1,3', '2', '3']);
    assert.equal(cols.force_charge_on_retries, 0);
    assert.equal(cols.force_charge_on_failed_at_ms, DUE);
    assert.equal(cols.force_charge_on_verified_at_ms, nulls === 'write' ? null : undefined);
    assert.match(Object.values(cols).filter((v) => v != null).join('|'), /^[\d,|]+$/, 'digits and commas in every value: no letter, no mark');
  }
  // Through the recorder and the read the route's cache makes (the last 7 days).
  const rec = openRecorder();
  try {
    const day = phoenixYmd(Date.now() + DAY_MS);
    rec.recordNightOutcome(day, { force_charge_on_at_ms: ON_AT, ...forceChargeOnFateColumns(hostile) } as never);
    const served = rec.readNightLedger(7).find((r) => r.plan_date === day) as unknown as Row;
    assert.ok(served != null, 'the row is among those the route serves');
    for (const [c, t] of FATE_SCHEMA) {
      const v = served[c];
      if (t === 'TEXT') assert.ok(v === null || /^[1-3](,[1-3])*$/.test(String(v)), `${c}: ${String(v)}`);
      else assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v)), `${c}: ${String(v)}`);
    }
    assert.match(Object.values(fateOfRow(served)).filter((v) => v != null).join('|'), /^[\d,|]+$/, 'digits and commas in the six served values: no letter at all');
    assert.deepEqual(JSON.parse(JSON.stringify(fateOfRow(served))), {
      force_charge_on_failed_at_ms: DUE, force_charge_on_failed_slots: '3', force_charge_on_left_out: '2',
      force_charge_on_retries: 0, force_charge_on_slots: '1,3', force_charge_on_verified_at_ms: null,
    });
  } finally { rec.close(); }
  // The record the route also serves (its `actuation`) holds the slots left out as slot numbers, or nothing.
  assert.ok(route.includes('      ...nightActuationMem,\n'));
  assert.deepEqual(coerceActuationState({ day: '2027-03-01', forceChargeLeftOutSlots: [SERIAL, 2, 'Core 1', 7] }).forceChargeLeftOutSlots, [2]);
  assert.equal(coerceActuationState({ day: '2027-03-01', forceChargeLeftOutSlots: [SERIAL] }).forceChargeLeftOutSlots, null);
});

/* ══ why the ON's fate is a write of its own ═══════════════════════════════ */

test('★★★ a fate write that fails does not take the ON stamp with it: the two are separate upserts', () => {
  // Run last: it removes a column for its duration. The column-add pass swallows every error, so a fate column can
  // be absent; a single upsert naming it and force_charge_on_at_ms would then lose the ON time, which the readiness
  // gate reads as "never switched on".
  const rec = openRecorder();
  const day = '2027-04-01';
  const drop = new DatabaseSync(DB);
  try {
    drop.exec('ALTER TABLE night_charge_ledger DROP COLUMN force_charge_on_retries');
    const onStampOnly = { force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost' };
    const fate = forceChargeOnFateColumns(onRecord({ day }));
    // Read on the second connection: the recorder's own SELECT was prepared for the table as it was.
    const read = () => drop.prepare('SELECT force_charge_on_at_ms, force_charge_mode FROM night_charge_ledger WHERE plan_date = ?').get(day) as Row | undefined;
    assert.throws(() => rec.recordNightOutcome(day, { ...onStampOnly, ...fate } as never), /force_charge_on_retries/, 'folded into one object, the ON time goes down with the fate');
    assert.equal(read(), undefined);
    rec.recordNightOutcome(day, onStampOnly as never);
    assert.throws(() => rec.recordNightOutcome(day, fate as never), /force_charge_on_retries/);
    const r = read()!;
    assert.deepEqual([r.force_charge_on_at_ms, r.force_charge_mode], [ON_AT, 'cost'], 'written apart, the ON time stands');
    // index.ts contains the failed write: the stamp never throws into the tick.
    const stampLeg = fnText(INDEX, 'function stampLegOutcome(');
    assert.ok(stampLeg.includes('  try { recorder.recordNightOutcome(leg.day, cols); }\n  catch (e: any) { app.log.warn(`night-charge: ledger stamp failed for ${leg.day} (${e?.message ?? e})`); }\n'));
  } finally {
    try { drop.exec('ALTER TABLE night_charge_ledger ADD COLUMN force_charge_on_retries INTEGER'); } catch { /* still there */ }
    drop.close();
    rec.close();
  }
});
