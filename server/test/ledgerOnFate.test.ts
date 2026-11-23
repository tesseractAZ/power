import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transformSync } from 'esbuild';
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
 *     with no ON, slot text as slot numbers only. And the ON's own two columns again from the same record
 *     (forceChargeOnStampColumns): the ON time and the mode, each only when the record holds it, never a NULL.
 *  3. THE VERDICT (nightForceCharge.forceChargeOnFateOf) over a row: its full truth table, stated once (a row with
 *     no ON is one with neither an ON time nor a re-issue count; a row with a fate and no ON time is judged by its
 *     fate). And the nights of the specification replayed through the real decision, the handlers' record writes
 *     and the recorder: every fate stamp restores an ON time and mode that a restart lost, and writes the same
 *     value on a row that holds them.
 *  4. THE STAMPS (index.ts): where each one sits, pinned on the source. index.ts starts a server when imported, so
 *     the replay in 3 mirrors its handlers and these pins hold the mirror to the source. The two stamp helpers
 *     themselves are not mirrored: the replay runs their code as index.ts has it (sourceStampers). The first OFF's
 *     stamp is the leg's last, so it is made from the leg's own copy when the record has moved on (`final`); every
 *     other stamp of a record that moved on is skipped.
 *  5. THE READERS the release leaves alone still key on the ON stamp: forceChargeStateAt, the readiness gate,
 *     middayChargeHourEpochs. Their code is unchanged; on a row whose ON time was restored they read the ON that
 *     was sent, shown beside the same row with the ON time missing.
 *  6. THE STATUS ROUTE serves ledger rows without authentication: nothing but slot numbers reaches the new text.
 *
 * The database is created as a v1.208.0 one (the original table plus the force-charge stamps that release had), as
 * the other ledger migration tests build theirs (ledgerChargeCycle.test.ts).
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-on-fate-'));
// Registered before anything else can throw: a failed setup still removes its folder.
after(() => rmSync(tmp, { recursive: true, force: true }));
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
  forceChargeOnStampColumns,
  FORCE_CHARGE_ON_VERIFY_AFTER_MS, FORCE_CHARGE_ON_MAX_RETRIES, FORCE_CHARGE_ON_RETRY_CUTOFF_MS,
} = await import('../src/nightForceCharge.js');
const { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } = await import('../src/nightChargeGate.js');
const { middayChargeHourEpochs } = await import('../src/nightLedgerScoring.js');
const { SHP2_SOURCE_SLOTS } = await import('../src/hwSpec.js');


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
/** The ON's own two columns, which every fate stamp writes again from the record (forceChargeOnStampColumns). */
const ON_STAMP_COLUMNS = ['force_charge_on_at_ms', 'force_charge_mode'];
type Row = Record<string, unknown>;
type Fate = Record<string, number | string | null>;

/**
 * THE VERDICT'S TRUTH TABLE (forceChargeOnFateOf), stated once: NULL (false) or set (true) for the four columns the
 * verdict reads, in the order the ON time, the re-issue count, the verified time, the failed time.
 *  - The count NULL: the fate was never stamped. With no ON time either the row has no ON ('none'); with an ON time it
 *    is 'notRecorded' (a row older than the columns), whatever else it holds.
 *  - The count set: the fate was stamped, and it decides, with or without an ON time (a row whose ON stamp was lost
 *    is judged by its fate): verified wins, then failed, else unconfirmed.
 */
const VERDICT_TABLE: ReadonlyArray<readonly [onAt: boolean, retries: boolean, verifiedAt: boolean, failedAt: boolean, verdict: ForceChargeOnFate]> = [
  [false, false, false, false, 'none'],
  [false, false, false, true, 'none'],
  [false, false, true, false, 'none'],
  [false, false, true, true, 'none'],
  [true, false, false, false, 'notRecorded'],
  [true, false, false, true, 'notRecorded'],
  [true, false, true, false, 'notRecorded'],
  [true, false, true, true, 'notRecorded'],
  [false, true, false, false, 'unconfirmed'],
  [false, true, false, true, 'failed'],
  [false, true, true, false, 'verified'],
  [false, true, true, true, 'verified'],
  [true, true, false, false, 'unconfirmed'],
  [true, true, false, true, 'failed'],
  [true, true, true, false, 'verified'],
  [true, true, true, true, 'verified'],
];
/** The same order as SQL over the stored columns (the form a reader of the database uses). */
const VERDICT_SQL = `CASE
  WHEN force_charge_on_retries IS NULL AND force_charge_on_at_ms IS NULL THEN 'none'
  WHEN force_charge_on_retries IS NULL THEN 'notRecorded'
  WHEN force_charge_on_verified_at_ms IS NOT NULL THEN 'verified'
  WHEN force_charge_on_failed_at_ms IS NOT NULL THEN 'failed'
  ELSE 'unconfirmed' END`;
/** The record's own verdict (forceChargeOnReadbackStatus) in the ledger's words. */
const RECORD_VERDICT: Record<string, ForceChargeOnFate> = { verified: 'verified', failed: 'failed', unverified: 'unconfirmed' };

const openRecorder = () => createRecorder(new SnapshotStore(), () => {});
type Rec = ReturnType<typeof openRecorder>;
const rowOf = (rec: Rec, day: string): Row | undefined =>
  rec.readNightLedger(36_500).find((r) => r.plan_date === day) as unknown as Row | undefined;
const fateOfRow = (r: Row | undefined): Fate => Object.fromEntries(FATE_COLUMNS.map((c) => [c, (r as Row)[c]])) as Fate;
/** A stored row as a plain object (the driver's rows have no prototype), to compare a whole row before and after. */
const wholeRow = (rec: Rec, day: string): Row => ({ ...rowOf(rec, day) });
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

/* ── index.ts's own code, run ────────────────────────────────────────────── */

interface StampLog { warn: string[]; debug: string[] }
type LegRecord = NightActuationState & { leg?: 'cost' | 'backup' };
interface SourceStampers {
  stampLegOutcome(leg: LegRecord, fields: Row): void;
  stampForceChargeOnFate(leg: LegRecord, live: NightActuationState, nulls: 'write' | 'omit', final?: boolean): void;
}
/** Functions of index.ts as written there (their code lines, types stripped), with what they close over handed in. */
const fromIndex = <T>(params: string, heads: string[], result: string): T =>
  new Function(`${transformSync(`function __make(${params}) {\n${heads.map((h) => fnText(INDEX, h)).join('\n')}\nreturn ${result};\n}`, { loader: 'ts' }).code}\nreturn __make;`)() as T;
const makeSourceStampers = fromIndex<(...deps: unknown[]) => SourceStampers>(
  'recorder, app, legLedgerFields, legRoleOf, forceChargeOnStampColumns, forceChargeOnFateColumns',
  ['function stampLegOutcome(', 'function stampForceChargeOnFate('], '{ stampLegOutcome, stampForceChargeOnFate }');
/**
 * index.ts's stampLegOutcome and stampForceChargeOnFate THEMSELVES, over the recorder and the log handed in: nothing
 * of either helper is modelled here, so a change to what they stamp, skip or contain is replayed, not only pinned.
 */
function sourceStampers(recorder: { recordNightOutcome: (day: string, cols: Row) => void }, log: StampLog = { warn: [], debug: [] }): SourceStampers {
  const app = { log: { warn: (m: string): void => { log.warn.push(m); }, debug: (m: string): void => { log.debug.push(m); } } };
  return makeSourceStampers(recorder, app, legLedgerFields, legRoleOf, forceChargeOnStampColumns, forceChargeOnFateColumns);
}
/** The same, over a real recorder, keeping every upsert it makes (`writes`: the row's day and the columns named, in the order named). */
function recordingStampers(rec: Rec) {
  const writes: Array<{ day: string; cols: Row }> = [];
  const log: StampLog = { warn: [], debug: [] };
  const stampers = sourceStampers({
    recordNightOutcome: (day, cols) => { writes.push({ day, cols: { ...cols } }); rec.recordNightOutcome(day, cols as never); },
  }, log);
  return { ...stampers, writes, log };
}

/** index.ts's forceChargeStateAt itself, over a record in memory and a ledger read. */
const makeForceChargeStateAt = fromIndex<(hourMs: number, mem: NightActuationState, recorder: { readNightLedger: (days: number) => unknown[] }) => (hourStartMs: number) => 'on' | 'off' | 'unknown'>(
  'HOUR_MS, nightActuationMem, recorder', ['function forceChargeStateAt('], 'forceChargeStateAt');

/**
 * The night as index.ts runs it, over a real recorder. Each method is the handler's own sequence (the record write,
 * then the ledger stamp), in the order the source pins of part 4 hold index.ts to; the stamps themselves are index.ts's
 * two helpers, run (sourceStampers). `lose` drops the ledger writes of one tick: a restart between the record write and
 * the ledger stamp. `replacedBy`: the record in memory is another night's by the time the handler's awaited device writes
 * return (the cycle re-armed, promoted or moved the leg to the trailing slot under the await).
 */
function nightRun(rec: Rec, armed: NightActuationState) {
  let live: NightActuationState = armed;
  const actions: string[] = [];
  const { stampLegOutcome, stampForceChargeOnFate, writes, log } = recordingStampers(rec);
  return {
    record: (): NightActuationState => live,
    actions,
    /** Every upsert the night's stamps made. */
    writes,
    /** What the stamps logged. */
    log,
    /** The 'on' handler: the write-ahead persist (with the slots left out), the attempt time, the ON stamp, the fate. */
    on(atMs: number, slots: number[], leftOut: number[] = [], o: { lose?: boolean } = {}): void {
      const state = live;
      const onStamp = forceChargeOnStamp(state, atMs, slots, { cost: true, line: false });
      live = { ...live, ...onStamp, forceChargeLeftOutSlots: leftOut.length > 0 ? [...leftOut] : null };
      live = { ...live, forceChargeOnLastAttemptMs: atMs };
      if (o.lose) return;
      stampLegOutcome(state, { force_charge_on_at_ms: atMs, force_charge_mode: onStamp.forceChargeMode });
      stampForceChargeOnFate(state, live, 'write');
    },
    /** One tick of the decision and its handler. `rateLimited`: every write of a re-issue came back rate-limited. */
    tick(nowMs: number, o: Partial<ForceChargeOpts> = {}, x: { lose?: boolean; rateLimited?: boolean; replacedBy?: NightActuationState } = {}): ForceChargeAction {
      const state = live;
      const action = decideForceCharge(state, nowMs, opts(o));
      actions.push(action.kind);
      if (action.kind === 'onVerified') {
        live = { ...live, forceChargeOnVerifiedAtMs: nowMs };
        if (!x.lose) stampForceChargeOnFate(state, live, 'omit');
      } else if (action.kind === 'onRetry') {
        live = { ...live, forceChargeOnRetries: live.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: nowMs };
        if (x.replacedBy != null) live = x.replacedBy; // under the re-issue's awaited writes
        live = {
          ...live, forceChargeOnLastAttemptMs: nowMs,
          ...(x.rateLimited ? { forceChargeOnRetries: Math.max(0, live.forceChargeOnRetries - 1) } : {}),
        };
        if (!x.lose) stampForceChargeOnFate(state, live, 'omit');
      } else if (action.kind === 'onFailed') {
        live = { ...live, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] };
        if (!x.lose) stampForceChargeOnFate(state, live, 'omit');
      } else if (action.kind === 'off') {
        live = { ...live, forceChargeOffAtMs: live.forceChargeOffAtMs ?? nowMs, forceChargeOffLastAttemptMs: nowMs, forceChargeOffReason: action.reason };
        if (x.replacedBy != null) live = x.replacedBy; // under the OFF's awaited writes
        if (state.forceChargeOffAtMs == null) {
          stampLegOutcome(state, { force_charge_off_at_ms: nowMs, force_charge_off_reason: action.reason });
          stampForceChargeOnFate(state, live, 'omit', true); // the leg's last stamp: final
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

test('★★★ forceChargeOnStampColumns: the ON time and the mode from the record, the mode only when cost or line, nothing with no finite ON time, never a NULL', () => {
  // Both columns, as the ON's own stamp wrote them: the record's instant and the mode it was switched on in.
  assert.deepEqual(forceChargeOnStampColumns(onRecord()), { force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost' });
  assert.deepEqual(forceChargeOnStampColumns(onRecord({ forceChargeMode: 'line' })), { force_charge_on_at_ms: ON_AT, force_charge_mode: 'line' });
  assert.deepEqual(forceChargeOnStampColumns({ forceChargeOnAtMs: 0, forceChargeMode: 'cost' }), { force_charge_on_at_ms: 0, force_charge_mode: 'cost' }, 'a time of 0 is a time');
  assert.deepEqual(Object.keys(forceChargeOnStampColumns(onRecord())), ON_STAMP_COLUMNS);
  for (const c of ON_STAMP_COLUMNS) assert.ok(!FATE_COLUMNS.includes(c), `${c} is not a fate column: the two derivations name no column in common`);
  // What the ON's handler stamps first is what this gives for the record it persisted: a later stamp writes the same values.
  const lineNight = armedNight('2027-03-01', { forceChargeCeilingPct: null, forceChargeLineAskPct: 94, forceChargeLinePct: 93.6 });
  for (const [night, gates, mode] of [[armedNight('2027-03-01'), { cost: true, line: false }, 'cost'], [lineNight, { cost: false, line: true }, 'line']] as const) {
    const onStamp = forceChargeOnStamp(night, ON_AT + 7, [1, 2, 3], gates);
    assert.equal(onStamp.forceChargeMode, mode);
    assert.deepEqual(forceChargeOnStampColumns({ ...night, ...onStamp }), { force_charge_on_at_ms: ON_AT + 7, force_charge_mode: onStamp.forceChargeMode });
  }
  // The mode only when it is one of the two: anything else leaves the key OUT (a NULL named here would blank the row's mode).
  const SERIAL = 'not-a-real-serial-0042';
  for (const mode of [null, undefined, '', 'Cost', 'LINE', 'line ', 'both', SERIAL, 0, 1, true, ['cost'], { kind: 'cost' }, { toString: () => 'cost' }]) {
    const cols = forceChargeOnStampColumns({ forceChargeOnAtMs: ON_AT, forceChargeMode: mode } as never);
    assert.deepEqual(cols, { force_charge_on_at_ms: ON_AT }, `mode ${JSON.stringify(mode)}`);
    assert.ok(!('force_charge_mode' in cols), 'the key is absent, not NULL');
  }
  // No finite ON time: nothing at all, whatever the mode says. Never an ON time on a row whose record holds none.
  for (const at of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, String(ON_AT), 'soon', SERIAL, true, {}, [ON_AT], { valueOf: () => ON_AT }]) {
    for (const mode of ['cost', 'line', null]) {
      const cols = forceChargeOnStampColumns({ forceChargeOnAtMs: at, forceChargeMode: mode } as never);
      assert.deepEqual(cols, {}, `ON time ${String(at)}, mode ${String(mode)}`);
      assert.equal(Object.keys(cols).length, 0);
    }
  }
  assert.deepEqual(forceChargeOnStampColumns(emptyActuationState()), {});
  assert.deepEqual(forceChargeOnStampColumns(armedNight('2027-03-01')), {}, 'armed, the force-charge never started');
  assert.deepEqual(forceChargeOnStampColumns({} as never), {}, 'a record from before either field');
  // Never a key with a NULL (or undefined) value, and never a key but the two, over every shape above at once.
  for (const at of [ON_AT, 0, null, undefined, Number.NaN, 'soon']) for (const mode of ['cost', 'line', null, undefined, 'both', 7]) {
    const cols = forceChargeOnStampColumns({ forceChargeOnAtMs: at, forceChargeMode: mode } as never) as Row;
    for (const [k, v] of Object.entries(cols)) {
      assert.ok(ON_STAMP_COLUMNS.includes(k), k);
      assert.ok(v != null, `${k} is never NULL (ON time ${String(at)}, mode ${String(mode)})`);
    }
    assert.ok(cols.force_charge_mode === undefined || cols.force_charge_on_at_ms !== undefined, 'never a mode without an ON time');
  }
  // On the row: a stamp from a record that lost its mode leaves the row's mode as it was; one from a record with no ON
  // names nothing, and an upsert of nothing but the fate keeps both.
  const rec = openRecorder();
  try {
    const day = '2027-02-06';
    rec.recordNightOutcome(day, { force_charge_on_at_ms: ON_AT, force_charge_mode: 'line' } as never);
    rec.recordNightOutcome(day, { ...forceChargeOnStampColumns(onRecord({ forceChargeMode: null })), ...forceChargeOnFateColumns(onRecord(), 'omit') } as never);
    assert.deepEqual([rowOf(rec, day)!.force_charge_on_at_ms, rowOf(rec, day)!.force_charge_mode], [ON_AT, 'line']);
    rec.recordNightOutcome(day, { ...forceChargeOnStampColumns(armedNight(day)), ...forceChargeOnFateColumns(onRecord({ forceChargeOnRetries: 1 }), 'omit') } as never);
    assert.deepEqual([rowOf(rec, day)!.force_charge_on_at_ms, rowOf(rec, day)!.force_charge_mode, rowOf(rec, day)!.force_charge_on_retries], [ON_AT, 'line', 1]);
  } finally { rec.close(); }
  // The input is read, never changed.
  const frozen = Object.freeze({ forceChargeOnAtMs: ON_AT, forceChargeMode: 'cost' as const });
  assert.deepEqual(forceChargeOnStampColumns(frozen), { force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost' });
});

test('★★ a time of 0 is a time in the six columns too: an ON at 0 has a fate, a verdict at 0 is written, and the failed slots stand beside a failure at 0', () => {
  // The verdict reads 0 as a value in all four of its columns, and forceChargeOnStampColumns writes an ON time of 0
  // (both asserted elsewhere in this file). The six columns keep the same rule: "set" is "not NULL", never "truthy".
  // No record of the add-on holds such a time (each is the clock's); this is the rule's edge, held so that the two
  // derivations and the verdict cannot come to disagree about what a set time is.
  const atZero = onRecord({ forceChargeOnAtMs: 0 });
  for (const nulls of ['write', 'omit'] as const) {
    assert.deepEqual(forceChargeOnFateColumns(atZero, nulls), forceChargeOnFateColumns(onRecord(), nulls), `an ON at 0 has the fate of any other ON (${nulls})`);
  }
  assert.deepEqual(forceChargeOnFateColumns(atZero, 'omit'), { force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' });
  // The whole stamp of such a record, as the helper builds it: the ON time 0 beside the fate, and the row reads by its fate.
  const whole = { ...forceChargeOnStampColumns(atZero), ...forceChargeOnFateColumns(atZero, 'omit') };
  assert.deepEqual(whole, { force_charge_on_at_ms: 0, force_charge_mode: 'cost', force_charge_on_retries: 0, force_charge_on_slots: '1,2,3' });
  assert.equal(forceChargeOnFateOf(whole), 'unconfirmed');
  assert.equal(forceChargeOnReadbackStatus(atZero), 'unverified', 'as the record\'s own status reads it');
  // A verified time of 0 and a failure time of 0 are written, in both forms, and the failed slots stand beside the failure.
  for (const nulls of ['write', 'omit'] as const) {
    const verified = forceChargeOnFateColumns(onRecord({ forceChargeOnVerifiedAtMs: 0 }), nulls);
    assert.equal(verified.force_charge_on_verified_at_ms, 0, `a verified time of 0 (${nulls})`);
    assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: ON_AT, ...verified }), 'verified');
    const failed = forceChargeOnFateColumns(onRecord({ forceChargeOnFailedAtMs: 0, forceChargeOnFailedSlots: [3, 2] }), nulls);
    assert.equal(failed.force_charge_on_failed_at_ms, 0, `a failure time of 0 (${nulls})`);
    assert.equal(failed.force_charge_on_failed_slots, '2,3', `a failure at 0 is a failure: its slots are named (${nulls})`);
    assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: ON_AT, ...failed }), 'failed');
  }
  // On the row: 0 is stored and read back as 0, not as NULL, and the stored row reads the same verdicts.
  const rec = openRecorder();
  try {
    const day = '2027-02-08';
    const failedAtZero = onRecord({ day, forceChargeOnFailedAtMs: 0, forceChargeOnFailedSlots: [3, 2] });
    rec.recordNightOutcome(day, { ...forceChargeOnStampColumns(failedAtZero), ...forceChargeOnFateColumns(failedAtZero) });
    assert.deepEqual(fateOfRow(rowOf(rec, day)), {
      force_charge_on_failed_at_ms: 0, force_charge_on_failed_slots: '2,3', force_charge_on_left_out: null,
      force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: null,
    });
    assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), 'failed');
    rec.recordNightOutcome(day, forceChargeOnFateColumns({ ...failedAtZero, forceChargeOnVerifiedAtMs: 0 }, 'omit'));
    assert.equal(rowOf(rec, day)!.force_charge_on_verified_at_ms, 0);
    assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), 'verified', 'verified wins, at 0 as at any other time');
  } finally { rec.close(); }
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

test('★★ a backup leg has no fate column and no ON column: its stamps write nothing, the final one included', () => {
  const cols = forceChargeOnFateColumns(onRecord({ forceChargeOnVerifiedAtMs: DUE })) as Row;
  assert.deepEqual(legLedgerFields('backup', cols), {});
  assert.deepEqual(legLedgerFields('cost', cols), cols, 'the cost leg (overnight or mid-day) writes the row\'s own columns');
  // The whole stamp as the helper builds it (the ON's two columns, then the fate): still nothing for a backup leg.
  const whole = { ...forceChargeOnStampColumns(onRecord()), ...cols };
  assert.deepEqual(Object.keys(whole), [...ON_STAMP_COLUMNS, ...FATE_COLUMNS]);
  assert.deepEqual(legLedgerFields('backup', whole), {});
  assert.deepEqual(legLedgerFields('cost', whole), whole);
  const rec = openRecorder();
  try {
    const day = '2027-02-05';
    const run = nightRun(rec, { ...armedNight(day), leg: 'backup' } as never);
    run.on(ON_AT, [1, 2, 3]);
    assert.equal(rowOf(rec, day), undefined);
    run.tick(ON_AT + 3 * MIN);
    run.tick(WIN_END);
    assert.deepEqual(run.actions, ['onVerified', 'off']);
    assert.equal(legRoleOf(run.record() as never), 'backup');
    assert.equal(run.writes.length, 0, 'no upsert at the ON, the verify or the first OFF');
    assert.equal(rowOf(rec, day), undefined, 'and no row');
    // The helper itself, with the record moved on, at the leg's last stamp.
    const s = recordingStampers(rec);
    s.stampForceChargeOnFate(run.record(), armedNight('2027-02-07'), 'omit', true);
    s.stampForceChargeOnFate(run.record(), run.record(), 'write');
    assert.equal(s.writes.length, 0);
    assert.equal(rowOf(rec, day), undefined);
  } finally { rec.close(); }
});

/* ══ 3. the verdict ════════════════════════════════════════════════════════ */

test('★★★ forceChargeOnFateOf, the full truth table: none needs BOTH the ON time and the count NULL; a row with a fate and no ON time is judged by its fate; verified wins over failed', () => {
  const T = ON_AT;
  // The table is whole: every combination of NULL and set for the four columns, once.
  assert.equal(VERDICT_TABLE.length, 16);
  assert.equal(new Set(VERDICT_TABLE.map(([a, b, c, d]) => [a, b, c, d].join())).size, 16);
  // Each set column over more than one value (0 is a value: a time of 0 is a time, and a count of 0 is the mark that
  // the fate was recorded); each NULL as NULL, as undefined and as a key that is not there.
  const SET = { on: [T, 0], retries: [0, 1, 2], verified: [T + MIN, 0], failed: [T + 15 * MIN, 0] };
  const NONE = [null, undefined];
  let rows = 0;
  for (const [on, retries, verified, failed, verdict] of VERDICT_TABLE) {
    for (const a of on ? SET.on : NONE) for (const b of retries ? SET.retries : NONE) for (const c of verified ? SET.verified : NONE) for (const d of failed ? SET.failed : NONE) {
      const row = { force_charge_on_at_ms: a, force_charge_on_retries: b, force_charge_on_verified_at_ms: c, force_charge_on_failed_at_ms: d };
      const said = `ON time ${String(a)}, count ${String(b)}, verified ${String(c)}, failed ${String(d)}`;
      assert.equal(forceChargeOnFateOf(row), verdict, said);
      assert.equal(forceChargeOnFateOf(Object.fromEntries(Object.entries(row).filter(([, v]) => v != null))), verdict, `${said} (absent keys)`);
      rows++;
    }
  }
  assert.ok(rows > 100, `${rows} rows read`);
  // What the table says, in words.
  //  - 'none' needs BOTH NULL: the four rows with neither an ON time nor a count, and no other.
  assert.deepEqual(VERDICT_TABLE.filter(([, , , , v]) => v === 'none').map(([on, retries]) => [on, retries]), [[false, false], [false, false], [false, false], [false, false]]);
  assert.equal(forceChargeOnFateOf({}), 'none');
  //  - A fate with no ON time is judged by its fate: the ON was sent (a fate is stamped only from a record that holds
  //    an ON) and its own stamp was lost. Not 'none'.
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, force_charge_on_retries: 0, force_charge_on_verified_at_ms: T }), 'verified');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, force_charge_on_retries: 0, force_charge_on_failed_at_ms: T }), 'failed');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, force_charge_on_retries: 0 }), 'unconfirmed');
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, force_charge_on_retries: 0, force_charge_on_verified_at_ms: null, force_charge_on_failed_at_ms: null }), 'unconfirmed');
  //  - Once the count is set the ON time decides nothing: the verdict with it and without it is the same.
  for (const [, , verified, failed, verdict] of VERDICT_TABLE.filter(([on, retries]) => on && retries)) {
    assert.equal(VERDICT_TABLE.find(([on, retries, v, f]) => !on && retries && v === verified && f === failed)![4], verdict);
  }
  //  - An ON stamp with no count: a row older than the release. Never 'unconfirmed', whatever else it holds.
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T }), 'notRecorded');
  for (const [, , , , verdict] of VERDICT_TABLE.filter(([on, retries]) => on && !retries)) assert.equal(verdict, 'notRecorded');
  //  - Verified wins over failed: a late apply after the failure verdict is a verified ON.
  assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: T, force_charge_on_retries: 1, force_charge_on_failed_at_ms: T + 30 * MIN, force_charge_on_verified_at_ms: T + 50 * MIN }), 'verified');
  for (const [, retries, verified, , verdict] of VERDICT_TABLE) if (retries && verified) assert.equal(verdict, 'verified');
  for (const [, retries, verified, failed, verdict] of VERDICT_TABLE) if (retries && !verified) assert.equal(verdict, failed ? 'failed' : 'unconfirmed');

  // The same table over rows as the database stores them, read by the function and by the same order written as SQL.
  const rec = openRecorder();
  const db = new DatabaseSync(DB);
  try {
    const sql = db.prepare(`SELECT ${VERDICT_SQL} AS verdict FROM night_charge_ledger WHERE plan_date = ?`);
    VERDICT_TABLE.forEach(([on, retries, verified, failed, verdict], i) => {
      const day = `2028-01-${String(i + 1).padStart(2, '0')}`;
      rec.recordNightOutcome(day, {
        force_charge_on_at_ms: on ? T : null, force_charge_on_retries: retries ? 0 : null,
        force_charge_on_verified_at_ms: verified ? T + MIN : null, force_charge_on_failed_at_ms: failed ? T + 15 * MIN : null,
      } as never);
      assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), verdict, `${day} as stored`);
      assert.equal((sql.get(day) as { verdict: string }).verdict, verdict, `${day} by the SQL form`);
    });
  } finally { db.close(); rec.close(); }

  // The ledger's verdict is the record's own (forceChargeOnReadbackStatus), read from the columns every stamp writes:
  // from the whole stamp (the ON's two columns and the fate), and from the fate alone (the ON time never reached the row).
  for (const verifiedAt of [null, DUE]) for (const failedAt of [null, DUE + MIN]) for (const retries of [0, 1]) for (const nulls of ['write', 'omit'] as const) {
    const r = onRecord({ forceChargeOnVerifiedAtMs: verifiedAt, forceChargeOnFailedAtMs: failedAt, forceChargeOnFailedSlots: failedAt == null ? null : [3], forceChargeOnRetries: retries });
    const fate = forceChargeOnFateColumns(r, nulls);
    const row = { ...forceChargeOnStampColumns(r), ...fate };
    assert.equal(row.force_charge_on_at_ms, ON_AT);
    assert.equal(forceChargeOnFateOf(row), RECORD_VERDICT[forceChargeOnReadbackStatus(r)!], JSON.stringify(row));
    assert.equal(forceChargeOnFateOf(fate), RECORD_VERDICT[forceChargeOnReadbackStatus(r)!], `no ON time: ${JSON.stringify(fate)}`);
    assert.equal(forceChargeOnFateOf({ force_charge_on_at_ms: null, ...fate }), RECORD_VERDICT[forceChargeOnReadbackStatus(r)!]);
  }
  // A record with no ON gives neither an ON column nor a fate: the row reads 'none'.
  assert.equal(forceChargeOnReadbackStatus(emptyActuationState()), null);
  assert.deepEqual({ ...forceChargeOnStampColumns(emptyActuationState()), ...forceChargeOnFateColumns(emptyActuationState()) }, {});
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
    //    The night's upserts, each with the columns it names, in the order named: the ON's own stamp; the fate at the ON
    //    (the ON's two columns again, then all six, NULLs included); the verify and the first OFF's re-stamp (the ON's two
    //    columns, then the fate less its NULLs); the OFF's own stamp between them. All to this night's row.
    const SET_FATE = ['force_charge_on_retries', 'force_charge_on_slots', 'force_charge_on_verified_at_ms'];
    assert.deepEqual(first.writes.map((w) => Object.keys(w.cols)), [
      ON_STAMP_COLUMNS,
      [...ON_STAMP_COLUMNS, ...FATE_COLUMNS],
      [...ON_STAMP_COLUMNS, ...SET_FATE],
      ['force_charge_off_at_ms', 'force_charge_off_reason'],
      [...ON_STAMP_COLUMNS, ...SET_FATE],
    ]);
    assert.deepEqual(first.writes.map((w) => w.day), Array(5).fill('2027-03-01'));
    assert.deepEqual(first.log, { warn: [], debug: [] });

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
    //    A Core named out of the pool AFTER the ON went to its slot. With no slot of ours reading ON the failure names
    //    every slot the ON was sent to, the excused one too: the failed slots equal the slots sent, so the row cannot be
    //    read as an ON that took on the rest. The re-issue between went to slots 2 and 3 only.
    const outAfter = nightRun(rec, armedNight('2027-03-14'));
    outAfter.on(ON_AT, [1, 2, 3]);
    assert.deepEqual(outAfter.tick(DUE, { slotsOn: [], poolOutSlots: [1] }), { kind: 'onRetry', slots: [2, 3] });
    assert.deepEqual(outAfter.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [], poolOutSlots: [1] }), { kind: 'onFailed', slots: [1, 2, 3] });
    assert.deepEqual(read('2027-03-14').fate, {
      ...NONE, force_charge_on_retries: 1, force_charge_on_slots: '1,2,3',
      force_charge_on_failed_at_ms: DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, force_charge_on_failed_slots: '1,2,3',
    }, 'no slot is "left out": the ON went to all three');
    assert.equal(read('2027-03-14').verdict, 'failed');
    //    The same with slot 3 reading ON: the failure is on slot 2 alone, the excused slot stays out of it.
    const partial = nightRun(rec, armedNight('2027-03-15'));
    partial.on(ON_AT, [1, 2, 3]);
    assert.deepEqual(partial.tick(DUE, { slotsOn: [3], poolOutSlots: [1] }), { kind: 'onRetry', slots: [2] });
    assert.deepEqual(partial.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [3], poolOutSlots: [1] }), { kind: 'onFailed', slots: [2] });
    assert.deepEqual([read('2027-03-15').fate.force_charge_on_failed_slots, read('2027-03-15').fate.force_charge_on_slots, read('2027-03-15').verdict], ['2', '1,2,3', 'failed']);

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

    // THE REPLAY. Every stamp of the ON lost: the record was persisted before the ON's awaited device writes, and the
    // process stopped before the row heard of the ON time, the mode or the fate. No readback comes before the window
    // closes, so the window-end OFF is the next stamp. It restores the ON's own two columns from the record beside the
    // fate, and the row reads what the record says of the night: an ON sent and never confirmed. Not 'none'.
    const allLost = nightRun(rec, armedNight('2027-03-10'));
    allLost.on(ON_AT, [1, 2, 3], [], { lose: true });
    assert.equal(rowOf(rec, '2027-03-10'), undefined);
    assert.equal(allLost.writes.length, 0);
    allLost.tick(WIN_END, { slotsOn: null });
    assert.deepEqual(allLost.actions, ['off']);
    const once = rowOf(rec, '2027-03-10')!;
    assert.deepEqual([once.force_charge_on_at_ms, once.force_charge_mode], [ON_AT, 'cost'], 'the ON time and the mode, restored from the record');
    assert.deepEqual([once.force_charge_on_at_ms, once.force_charge_mode], [allLost.record().forceChargeOnAtMs, allLost.record().forceChargeMode]);
    assert.deepEqual([once.force_charge_off_at_ms, once.force_charge_off_reason], [WIN_END, 'windowEnd']);
    assert.deepEqual(fateOfRow(once), {
      force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null,
      force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: null,
    });
    assert.equal(forceChargeOnReadbackStatus(allLost.record()), 'unverified');
    assert.equal(forceChargeOnFateOf(once), 'unconfirmed', 'the record\'s verdict in the ledger\'s words');
    assert.notEqual(forceChargeOnFateOf(once), 'none');
    // Two upserts made the row: the OFF's own stamp, then the final stamp (the ON's two columns, then the fate's set columns).
    assert.deepEqual(allLost.writes.map((w) => Object.keys(w.cols)), [
      ['force_charge_off_at_ms', 'force_charge_off_reason'],
      [...ON_STAMP_COLUMNS, 'force_charge_on_retries', 'force_charge_on_slots'],
    ]);
  } finally { rec.close(); }
});

test('★★★ every fate stamp restores an ON time and mode the row never heard, at whichever stamp comes first; the row then reads what the record says', () => {
  const rec = openRecorder();
  try {
    const NONE: Fate = { force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null,
      force_charge_on_retries: null, force_charge_on_slots: null, force_charge_on_verified_at_ms: null };
    /** The row's ON columns are the record's, and its verdict is the record's own. */
    const restored = (run: ReturnType<typeof nightRun>, day: string, onAt: number, verdict: ForceChargeOnFate): Row => {
      const r = rowOf(rec, day)!;
      assert.deepEqual([r.force_charge_on_at_ms, r.force_charge_mode], [onAt, 'cost'], `${day}: restored`);
      assert.deepEqual([run.record().forceChargeOnAtMs, run.record().forceChargeMode], [onAt, 'cost']);
      assert.equal(forceChargeOnFateOf(r), verdict, day);
      assert.equal(RECORD_VERDICT[forceChargeOnReadbackStatus(run.record())!], verdict, `${day}: as the record reads`);
      assert.deepEqual(run.writes.map((w) => Object.keys(w.cols).slice(0, 2)), [ON_STAMP_COLUMNS], `${day}: one upsert, the ON's two columns first`);
      return r;
    };
    // At the verify: a readback three minutes after the ON shows every slot ON.
    const atVerify = nightRun(rec, armedNight('2027-05-01'));
    atVerify.on(ON_AT, [1, 2, 3], [], { lose: true });
    assert.equal(rowOf(rec, '2027-05-01'), undefined, 'a restart during the ON\'s own writes: the row has heard nothing');
    atVerify.tick(ON_AT + 3 * MIN);
    assert.deepEqual(atVerify.actions, ['onVerified']);
    assert.deepEqual(fateOfRow(restored(atVerify, '2027-05-01', ON_AT, 'verified')),
      { ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: ON_AT + 3 * MIN });
    // At a re-issue: slot 3 still reads OFF at the check. The slots left out reach the row with it (the ON's own
    // stamp of the fate, which would have written them, was lost too).
    const atRetry = nightRun(rec, armedNight('2027-05-02'));
    atRetry.on(ON_AT, [2, 3], [1], { lose: true });
    assert.deepEqual(atRetry.tick(DUE, { slotsOn: [2], connectedSlots: [2, 3], poolOutSlots: [1] }), { kind: 'onRetry', slots: [3] });
    assert.deepEqual(fateOfRow(restored(atRetry, '2027-05-02', ON_AT, 'unconfirmed')),
      { ...NONE, force_charge_on_retries: 1, force_charge_on_slots: '2,3', force_charge_on_left_out: '1' });
    // At the failure verdict: no slot took it and the window is too short for a re-issue.
    const LATE_ON = WIN_END - FORCE_CHARGE_ON_RETRY_CUTOFF_MS - 10 * MIN;
    const CHECK = LATE_ON + FORCE_CHARGE_ON_VERIFY_AFTER_MS;
    const atFailure = nightRun(rec, armedNight('2027-05-03'));
    atFailure.on(LATE_ON, [1, 2, 3], [], { lose: true });
    assert.deepEqual(atFailure.tick(CHECK, { slotsOn: [] }), { kind: 'onFailed', slots: [1, 2, 3], noRetry: true });
    assert.deepEqual(fateOfRow(restored(atFailure, '2027-05-03', LATE_ON, 'failed')),
      { ...NONE, force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_failed_at_ms: CHECK, force_charge_on_failed_slots: '1,2,3' });
    // (At the first OFF: the replay of 2027-03-10 above.)
  } finally { rec.close(); }
});

test('★★★ a repair never changes what the row holds: every fate stamp writes the same ON time and mode the first stamp wrote, and a record with no ON writes nothing', () => {
  const rec = openRecorder();
  try {
    const day = '2027-05-04';
    const run = nightRun(rec, armedNight(day));
    const two = (): unknown[] => [rowOf(rec, day)!.force_charge_on_at_ms, rowOf(rec, day)!.force_charge_mode];
    run.on(ON_AT, [1, 2, 3]);
    assert.deepEqual(two(), [ON_AT, 'cost']);
    // A re-issue, the failure verdict, a late verify, the first OFF: after each, the two columns are as the ON left them.
    run.tick(DUE, { slotsOn: [1] });
    assert.deepEqual(two(), [ON_AT, 'cost']);
    run.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [1] });
    assert.deepEqual(two(), [ON_AT, 'cost']);
    run.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS + 5 * MIN);
    assert.deepEqual(two(), [ON_AT, 'cost']);
    run.tick(WIN_END);
    assert.deepEqual(two(), [ON_AT, 'cost']);
    assert.deepEqual(run.actions, ['onRetry', 'onFailed', 'onVerified', 'off']);
    // The ON's own stamp and five fate stamps name the ON time: each the record's own instant and mode, the values the
    // first of them wrote. The seventh upsert is the OFF's own and names neither.
    const naming = run.writes.filter((w) => 'force_charge_on_at_ms' in w.cols);
    assert.equal(run.writes.length, 7);
    assert.equal(naming.length, 6);
    for (const w of naming) assert.deepEqual([w.day, w.cols.force_charge_on_at_ms, w.cols.force_charge_mode], [day, ON_AT, 'cost']);
    assert.deepEqual([run.record().forceChargeOnAtMs, run.record().forceChargeMode], [ON_AT, 'cost'], 'the record\'s own two fields, set once at the ON');
    const before = wholeRow(rec, day);

    // The helper itself, on the same row.
    const s = recordingStampers(rec);
    const leg = run.record();
    // The same stamp again changes nothing on the row (every value is the record's own, absolute).
    s.stampForceChargeOnFate(leg, leg, 'omit');
    s.stampForceChargeOnFate(leg, leg, 'omit', true);
    assert.deepEqual(wholeRow(rec, day), before);
    assert.equal(s.writes.length, 2);
    // A record that lost its mode writes the ON time alone: the row's mode stands.
    s.stampForceChargeOnFate(leg, { ...leg, forceChargeMode: null }, 'omit');
    assert.equal(s.writes.length, 3);
    assert.equal(s.writes[2].cols.force_charge_on_at_ms, ON_AT);
    assert.ok(!('force_charge_mode' in s.writes[2].cols), 'the mode is not named, so it is not blanked');
    assert.deepEqual(wholeRow(rec, day), before);
    // A record that holds no ON (its ON time lost, or never there) writes nothing at all: neither an ON time nor a
    // fate reaches a row from a record that has no ON, final or not.
    for (const noOn of [{ ...leg, forceChargeOnAtMs: null }, armedNight(day), { ...leg, forceChargeOnAtMs: undefined } as never]) {
      s.stampForceChargeOnFate(leg, noOn, 'omit');
      s.stampForceChargeOnFate(leg, noOn, 'omit', true);
      s.stampForceChargeOnFate(leg, noOn, 'write');
    }
    assert.equal(s.writes.length, 3, 'no upsert from a record with no ON');
    assert.deepEqual(wholeRow(rec, day), before);
    assert.deepEqual(s.log, { warn: [], debug: [] });

    // A night switched on in line mode gets 'line' back, not a default.
    const lineLeg = onRecord({ day: '2027-05-05', forceChargeMode: 'line', forceChargeOnVerifiedAtMs: ON_AT + 3 * MIN });
    s.stampForceChargeOnFate(lineLeg, lineLeg, 'omit');
    const line = rowOf(rec, '2027-05-05')!;
    assert.deepEqual([line.force_charge_on_at_ms, line.force_charge_mode, forceChargeOnFateOf(line)], [ON_AT, 'line', 'verified']);
  } finally { rec.close(); }
});

test('★★★ the helper as index.ts has it, run: the live record while it holds the leg; a record that moved on is skipped, except at the first OFF, where the leg\'s own copy is stamped', () => {
  const rec = openRecorder();
  try {
    const s = recordingStampers(rec);
    const day = '2027-06-01';
    // The leg as its tick read it: an ON sent, one re-issue spent, judged not applied on slots 2 and 3.
    const leg = onRecord({ day, forceChargeOnRetries: 1, forceChargeOnFailedAtMs: DUE + 15 * MIN, forceChargeOnFailedSlots: [2, 3] });
    const legCols = {
      force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost',
      force_charge_on_failed_at_ms: DUE + 15 * MIN, force_charge_on_failed_slots: '2,3', force_charge_on_retries: 1, force_charge_on_slots: '1,2,3',
    };
    // Another night's record, with an ON of its own that a readback verified: what must never reach this leg's row.
    const other = onRecord({
      day: '2027-06-02', windowStartMs: WIN_START + DAY_MS, windowEndMs: WIN_END + DAY_MS, forceChargeMode: 'line',
      forceChargeOnAtMs: ON_AT + DAY_MS, forceChargeSlots: [1], forceChargeOnVerifiedAtMs: ON_AT + DAY_MS + 3 * MIN, forceChargeLeftOutSlots: [2, 3],
    });
    // The records that are not this leg's: another night; this night with another window (the cycle's other leg, or
    // another record of the day); another night armed for this same window (two evenings can share one); an idle one.
    const movedOn: NightActuationState[] = [
      other, { ...leg, windowStartMs: WIN_START + H }, { ...other, day }, { ...other, windowStartMs: leg.windowStartMs, windowEndMs: leg.windowEndMs }, emptyActuationState(),
    ];

    // Not final: skipped, with one debug line each that names the leg's night. Nothing is written, no row is made.
    for (const live of movedOn) for (const nulls of ['write', 'omit'] as const) {
      s.stampForceChargeOnFate(leg, live, nulls);
      s.stampForceChargeOnFate(leg, live, nulls, false);
    }
    assert.equal(s.writes.length, 0);
    assert.equal(rowOf(rec, day), undefined);
    assert.equal(s.log.debug.length, movedOn.length * 4);
    for (const line of s.log.debug) assert.match(line, /skipped for 2027-06-01: the record no longer holds that leg\.$/);
    assert.deepEqual(s.log.warn, []);

    // Final (the first OFF): the leg's OWN copy is stamped, to the leg's own row, whatever the record in memory is.
    for (const live of movedOn) {
      s.log.debug.length = 0;
      s.writes.length = 0;
      s.stampForceChargeOnFate(leg, live, 'omit', true);
      assert.deepEqual(s.writes, [{ day, cols: legCols }], 'the leg\'s copy, to the leg\'s row, the ON\'s two columns first');
      assert.deepEqual(s.log, { warn: [], debug: [] }, 'made, not skipped');
    }
    const row = rowOf(rec, day)!;
    assert.equal(forceChargeOnFateOf(row), 'failed', 'the leg\'s own fate');
    assert.deepEqual([row.force_charge_on_at_ms, row.force_charge_mode, row.force_charge_on_verified_at_ms, row.force_charge_on_left_out], [ON_AT, 'cost', null, null],
      'nothing of the other night: not its ON time, its mode, its verification or its slots');
    assert.equal(rowOf(rec, '2027-06-02'), undefined, 'and the other night\'s row is not made');

    // While the record still holds the leg, the LIVE record is stamped, final or not: the handler has just changed it,
    // and the copy the tick read at its start is behind.
    const live = { ...leg, forceChargeOnVerifiedAtMs: DUE + 40 * MIN, forceChargeOnRetries: 0 };
    for (const final of [false, true, undefined]) {
      s.writes.length = 0;
      s.stampForceChargeOnFate(leg, live, 'omit', final);
      assert.deepEqual(s.writes, [{ day, cols: { ...legCols, force_charge_on_retries: 0, force_charge_on_verified_at_ms: DUE + 40 * MIN } }], `final ${String(final)}`);
    }
    assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), 'verified');
    assert.equal(rowOf(rec, day)!.force_charge_on_retries, 0, 'the live count, down as well as up');
    // 'write' names all six, NULLs included, after the ON's two columns; 'omit' named only what is set (above).
    s.writes.length = 0;
    s.stampForceChargeOnFate(leg, onRecord({ day }), 'write');
    assert.deepEqual(Object.keys(s.writes[0].cols), [...ON_STAMP_COLUMNS, ...FATE_COLUMNS]);
    assert.deepEqual(fateOfRow(rowOf(rec, day)), forceChargeOnFateColumns(onRecord()));

    // A leg with no night names no row; nothing is written and nothing is logged.
    s.writes.length = 0;
    s.stampForceChargeOnFate({ ...leg, day: null }, { ...leg, day: null }, 'omit', true);
    s.stampForceChargeOnFate({ ...leg, day: null }, other, 'omit', true);
    assert.deepEqual([s.writes.length, s.log], [0, { warn: [], debug: [] }]);

    // It never throws into the tick: a recorder that fails, and a record that cannot be read, each end in one warning.
    const failing: StampLog = { warn: [], debug: [] };
    const broken = sourceStampers({ recordNightOutcome: () => { throw new Error('database is locked'); } }, failing);
    assert.doesNotThrow(() => broken.stampForceChargeOnFate(leg, leg, 'omit', true));
    assert.deepEqual(failing.warn, ['night-charge: ledger stamp failed for 2027-06-01 (database is locked)']);
    assert.doesNotThrow(() => broken.stampForceChargeOnFate(leg, null as never, 'omit'));
    assert.equal(failing.warn.length, 2);
    assert.match(failing.warn[1], /^night-charge: ledger stamp of the force-charge ON's fate failed for 2027-06-01 \(/);
  } finally { rec.close(); }
});

test('★★★ replayed: the record is replaced during the first OFF\'s writes, and the row still gets the leg\'s own fate, never the other night\'s; under a re-issue\'s writes the stamp is skipped', () => {
  const rec = openRecorder();
  try {
    // The next evening's backup leg arms over this leg during the OFF's device writes: the leg moves to the trailing
    // slot and the record in memory is the backup leg's. Both of this leg's earlier stamps (the re-issue, the failure
    // verdict) were lost, so the row still reads an ON never confirmed. The first OFF's stamp is the last this leg gets.
    const backup = { ...armedNight('2027-06-12', { windowStartMs: WIN_START + DAY_MS, windowEndMs: WIN_END + DAY_MS }), leg: 'backup' } as NightActuationState;
    const run = nightRun(rec, armedNight('2027-06-11'));
    run.on(ON_AT, [1, 2, 3]);
    run.tick(DUE, { slotsOn: [1] }, { lose: true });
    run.tick(DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, { slotsOn: [1] }, { lose: true });
    assert.equal(forceChargeOnFateOf(rowOf(rec, '2027-06-11')!), 'unconfirmed', 'the row has not heard of the failure');
    const legCopy = run.record();
    run.tick(WIN_END, { slotsOn: [1] }, { replacedBy: backup });
    assert.deepEqual(run.actions, ['onRetry', 'onFailed', 'off']);
    assert.equal(run.record(), backup, 'the record in memory is the other night\'s');
    const row = rowOf(rec, '2027-06-11')!;
    assert.deepEqual([row.force_charge_off_at_ms, row.force_charge_off_reason], [WIN_END, 'windowEnd']);
    assert.deepEqual([row.force_charge_on_at_ms, row.force_charge_mode], [ON_AT, 'cost']);
    assert.deepEqual(fateOfRow(row), {
      force_charge_on_failed_at_ms: DUE + FORCE_CHARGE_ON_VERIFY_AFTER_MS, force_charge_on_failed_slots: '2,3', force_charge_on_left_out: null,
      force_charge_on_retries: 1, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: null,
    }, 'the leg\'s own fate, from the copy the tick read');
    assert.deepEqual(fateOfRow(row), forceChargeOnFateColumns(legCopy));
    assert.equal(forceChargeOnFateOf(row), 'failed', 'not left reading "never confirmed"');
    assert.equal(rowOf(rec, '2027-06-12'), undefined, 'nothing is written for the night that took the record');
    assert.deepEqual(run.log, { warn: [], debug: [] }, 'made, not skipped');
    assert.ok(run.writes.every((w) => w.day === '2027-06-11'));

    // The record that took its place holds an ON of its own that a readback verified. A night never confirmed must not
    // come to read verified, nor take that night's ON time, mode or slots.
    const verifiedElsewhere = onRecord({
      day: '2027-06-22', windowStartMs: WIN_START + DAY_MS, windowEndMs: WIN_END + DAY_MS, forceChargeMode: 'line',
      forceChargeOnAtMs: ON_AT + DAY_MS, forceChargeSlots: [1], forceChargeOnRetries: 1, forceChargeOnVerifiedAtMs: ON_AT + DAY_MS + 3 * MIN,
    });
    const never = nightRun(rec, armedNight('2027-06-21'));
    never.on(WIN_END - 10 * MIN, [1, 2, 3], [], { lose: true });
    never.tick(WIN_END, { slotsOn: null }, { replacedBy: verifiedElsewhere });
    assert.deepEqual(never.actions, ['off']);
    const neverRow = rowOf(rec, '2027-06-21')!;
    assert.equal(forceChargeOnFateOf(neverRow), 'unconfirmed');
    assert.deepEqual([neverRow.force_charge_on_at_ms, neverRow.force_charge_mode], [WIN_END - 10 * MIN, 'cost'], 'this leg\'s own ON, restored from its own copy');
    assert.deepEqual(fateOfRow(neverRow), {
      force_charge_on_failed_at_ms: null, force_charge_on_failed_slots: null, force_charge_on_left_out: null,
      force_charge_on_retries: 0, force_charge_on_slots: '1,2,3', force_charge_on_verified_at_ms: null,
    });
    assert.equal(rowOf(rec, '2027-06-22'), undefined);

    // A stamp that is not the leg's last is skipped when the record has moved on: under a re-issue's awaited writes
    // the row keeps what it held, and the debug line says so.
    const mid = nightRun(rec, armedNight('2027-06-13'));
    mid.on(ON_AT, [1, 2, 3]);
    const held = wholeRow(rec, '2027-06-13');
    mid.tick(DUE, { slotsOn: [1, 2] }, { replacedBy: verifiedElsewhere });
    assert.deepEqual(mid.actions, ['onRetry']);
    assert.deepEqual(wholeRow(rec, '2027-06-13'), held, 'retries 0, no verdict: untouched');
    assert.equal(mid.writes.length, 2, 'the ON\'s two upserts, and none after');
    assert.deepEqual(mid.log, { warn: [], debug: ['night-charge: ledger stamp of the force-charge ON\'s fate skipped for 2027-06-13: the record no longer holds that leg.'] });
    assert.equal(rowOf(rec, '2027-06-22'), undefined);
  } finally { rec.close(); }
});

test('★★★ replayed: the trailing leg\'s first OFF stamps the fate from the trailing record as it stands, and from the leg\'s own copy when the slot no longer holds it', () => {
  const rec = openRecorder();
  try {
    const OFF_AT = WIN_END + 15 * H;
    /** runTrailingLegTick's first OFF: `cur` is the trailing slot as it stands, else the leg the tick read; the slot is
     *  written before the awaited device writes; the OFF's own stamp and the final fate stamp follow them. */
    const trailingFirstOff = (t: NightActuationState, during: (slot: NightActuationState) => NightActuationState | null) => {
      const s = recordingStampers(rec);
      let slot: NightActuationState | null = t;
      const cur = (): NightActuationState => slot ?? t;
      slot = { ...cur(), forceChargeOffAtMs: cur().forceChargeOffAtMs ?? OFF_AT, forceChargeOffLastAttemptMs: OFF_AT, forceChargeOffReason: 'disabled' };
      slot = during(slot);
      if (t.forceChargeOffAtMs == null) {
        s.stampLegOutcome(t, { force_charge_off_at_ms: OFF_AT, force_charge_off_reason: 'disabled' });
        s.stampForceChargeOnFate(t, cur(), 'omit', true);
      }
      return s;
    };
    // A leg that moved to the trailing slot before its OFF, its verify stamp lost: the row reads an ON never confirmed.
    const moved = (day: string): NightActuationState => {
      const run = nightRun(rec, armedNight(day));
      run.on(ON_AT, [1, 2, 3]);
      run.tick(ON_AT + 3 * MIN, {}, { lose: true });
      assert.equal(forceChargeOnFateOf(rowOf(rec, day)!), 'unconfirmed');
      return run.record();
    };
    const other = onRecord({ day: '2027-06-19', windowStartMs: WIN_START + DAY_MS, forceChargeOnAtMs: ON_AT + DAY_MS, forceChargeOnFailedAtMs: DUE + DAY_MS, forceChargeOnFailedSlots: [1, 2, 3] });
    for (const [day, during] of [
      ['2027-06-15', (slot: NightActuationState) => slot],          // the slot still holds the leg
      ['2027-06-16', () => null],                                   // the slot was emptied under the writes
      ['2027-06-17', () => other],                                  // the slot holds another leg
    ] as const) {
      const s = trailingFirstOff(moved(day), during);
      const row = rowOf(rec, day)!;
      assert.deepEqual([row.force_charge_off_at_ms, row.force_charge_off_reason, row.force_charge_on_verified_at_ms, forceChargeOnFateOf(row)],
        [OFF_AT, 'disabled', ON_AT + 3 * MIN, 'verified'], `${day}: repaired at the trailing leg's first OFF`);
      assert.deepEqual([row.force_charge_on_at_ms, row.force_charge_mode, row.force_charge_on_failed_at_ms], [ON_AT, 'cost', null]);
      assert.deepEqual(s.writes.map((w) => w.day), [day, day]);
      assert.deepEqual(s.log, { warn: [], debug: [] });
    }
    assert.equal(rowOf(rec, '2027-06-19'), undefined);
    // The stamp is the FIRST OFF's: a trailing leg whose first OFF went before it moved makes none here (the tick that
    // sent that OFF made it, from its own copy if the record had moved on by then: the replay above).
    const sent = { ...moved('2027-06-18'), forceChargeOffAtMs: WIN_END };
    assert.equal(trailingFirstOff(sent, (slot) => slot).writes.length, 0);
  } finally { rec.close(); }
});

/* ══ 4. the stamps (index.ts) ══════════════════════════════════════════════ */

test('★★★ index.ts: one helper stamps the fate and the ON\'s two columns, from the live record of the same leg or (final) the leg\'s own copy, through the two derivations, and never throws', () => {
  const helper = fnText(INDEX, 'function stampForceChargeOnFate(');
  // The signature: the fourth argument is `final`, false unless a caller says otherwise.
  assert.ok(helper.startsWith("function stampForceChargeOnFate(leg: NightActuationState & { leg?: ChargeLegRole }, live: NightActuationState, nulls: 'write' | 'omit', final = false): void {\n  try {\n"));
  // `held`: the record is still this leg's (the same night and the same window). A record that is not is skipped ONLY
  // when the stamp is not the leg's last: another night's fate never reaches this row either way.
  assert.ok(helper.includes('    if (leg.day == null) return;\n    const held = live.day === leg.day && live.windowStartMs === leg.windowStartMs;\n    if (!held && !final) {\n'));
  // `from`: the live record while it holds the leg, else the leg's own copy. One write, stampLegOutcome's (the leg's
  // own row and columns), of the ON's two columns FIRST and the fate after them, both from the same record.
  assert.ok(helper.includes('      return;\n    }\n    const from = held ? live : leg;\n    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(from, nulls) });\n  } catch (e: any) {\n'));
  assert.equal(count(helper, 'stampLegOutcome('), 1, 'one write');
  assert.equal(count(helper, 'return;'), 2, 'two ways out before it: no night, and a record that moved on at a stamp that is not final');
  assert.equal(count(helper, 'final'), 2, 'the argument and the one test of it');
  assert.equal(count(helper, 'held'), 3, 'set once, read by the skip and by the choice of record');
  assert.equal(count(helper, 'live'), 4, 'the argument, the two fields `held` compares, and the record stamped while held');
  assert.equal(count(helper, 'recorder.'), 0, 'no direct write to the recorder');
  assert.equal(count(helper, 'persist'), 0, 'and no write to the record');
  // No second derivation: the fate columns are named in no code line of index.ts, and each derivation is called once,
  // in the helper.
  assert.doesNotMatch(INDEX, FATE_NAME);
  assert.equal(count(INDEX, 'forceChargeOnFateColumns('), 1);
  assert.equal(count(INDEX, 'forceChargeOnStampColumns('), 1);
  assert.equal(count(helper, 'forceChargeOnFateColumns('), 1);
  assert.equal(count(helper, 'forceChargeOnStampColumns('), 1);
  assert.ok(INDEX.includes("\n  forceChargeOnFateColumns,\n  forceChargeOnStampColumns,\n} from './nightForceCharge.js';"));
  // Six call sites, in the order of the night: the ON ('write'); the verify, the re-issue and the failure ('omit', no
  // fourth argument); the two first OFFs ('omit', final).
  assert.equal(count(INDEX, 'stampForceChargeOnFate('), 7, 'the helper and six calls');
  assert.deepEqual(INDEX.split('\n').filter((l) => l.includes('stampForceChargeOnFate(') && !l.startsWith('function ')).map((l) => l.trim()), [
    "stampForceChargeOnFate(state, nightActuationMem, 'write');",
    "stampForceChargeOnFate(state, nightActuationMem, 'omit');",
    "stampForceChargeOnFate(state, nightActuationMem, 'omit');",
    "stampForceChargeOnFate(state, nightActuationMem, 'omit');",
    "stampForceChargeOnFate(state, nightActuationMem, 'omit', true);",
    "stampForceChargeOnFate(t, cur(), 'omit', true);",
  ]);
  assert.equal(count(INDEX, "'omit', true);"), 2, 'final at the two first OFFs and nowhere else');
  assert.equal(count(INDEX, "'write', true"), 0);
  assert.equal(count(TICK, 'stampForceChargeOnFate('), 5);
  assert.equal(count(TRAILING, 'stampForceChargeOnFate('), 1);
  assert.equal(count(fnText(INDEX, 'async function runNightActuationTickInner('), 'stampForceChargeOnFate('), 0, 'the reserve tick stamps no fate');
  // The replay runs this helper and stampLegOutcome as written here (sourceStampers): what it closes over is what is handed in.
  assert.equal(typeof sourceStampers({ recordNightOutcome: () => {} }).stampForceChargeOnFate, 'function');
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

test('★★★ index.ts: the first OFF re-stamps the fate, NULLs left out and FINAL, on the active leg and on the trailing leg; no other stamp is final', () => {
  const b = branch("if (action.kind === 'off' || action.kind === 'offRetry') {");
  assert.match(b, /\n {4}if \(!isRetry && state\.forceChargeOffAtMs == null\) \{\n {6}stampLegOutcome\(state, \{ force_charge_off_at_ms: nowMs, force_charge_off_reason: action\.reason \}\);[^\n]*\n {6}stampForceChargeOnFate\(state, nightActuationMem, 'omit', true\);\n {4}\}\n/);
  assert.equal(count(b, 'stampForceChargeOnFate('), 1);
  assert.match(TRAILING, /\n {4}if \(!isRetry && t\.forceChargeOffAtMs == null\) \{\n {6}stampLegOutcome\(t, \{ force_charge_off_at_ms: nowMs, force_charge_off_reason: action\.reason \}\);\n {6}stampForceChargeOnFate\(t, cur\(\), 'omit', true\);\n {4}\}\n/);
  assert.ok(TRAILING.includes('  const cur = (): NightActuationState => nightCycleTrailing ?? t;\n'), 'the trailing record as it stands now');
  assert.ok(TRAILING.includes('  const t = nightCycleTrailing;\n  if (t == null) return;\n'), 'and the leg as the tick read it: the copy a final stamp falls back to');
  // The stamp follows the OFF's awaited device writes, under which the cycle can move the leg on: that is why it is final.
  const lastWrite = b.lastIndexOf('await setChannelForceCharge(');
  const firstOff = b.indexOf("stampForceChargeOnFate(state, nightActuationMem, 'omit', true);");
  const persist = b.indexOf('forceChargeOffAtMs: nightActuationMem.forceChargeOffAtMs ?? nowMs,');
  assert.ok(persist > 0 && lastWrite > persist && firstOff > lastWrite, 'the write-ahead persist, the device writes, then the stamps');
  assert.ok(TRAILING.indexOf("stampForceChargeOnFate(t, cur(), 'omit', true);") > TRAILING.lastIndexOf('await setChannelForceCharge('));
  // The leg handed to the active tick's stamp is the tick's own copy of the record (`state`), read before the writes.
  assert.ok(TICK.includes('  let state = nightActuationMem;\n  if (state.day == null) return;\n'));
  // Final nowhere else: the ON, the verify, the re-issue and the failure pass three arguments.
  for (const head of ["if (action.kind === 'on') {", "if (action.kind === 'onVerified') {", "if (action.kind === 'onRetry') {", "if (action.kind === 'onFailed') {"]) {
    const other = branch(head);
    assert.equal(count(other, 'stampForceChargeOnFate('), 1, head);
    assert.equal(count(other, `stampForceChargeOnFate(state, nightActuationMem, '${head.includes("'on')") ? 'write' : 'omit'}');`), 1, head);
    assert.doesNotMatch(other, /stampForceChargeOnFate\([^\n]*true/, head);
  }
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
  assert.ok(INDEX.includes('\nconst HOUR_MS = 3_600_000;\n'), 'the hour it counts in');
  // No reader decides on the verdict in this release: it is defined and called nowhere in the server.
  for (const f of serverSources()) assert.equal(count(f.code, 'forceChargeOnFateOf('), f.rel === 'nightForceCharge.ts' ? 1 : 0, f.rel);
  // The ON's two columns are written again from ONE place: forceChargeOnStampColumns is defined in nightForceCharge.ts
  // and called once, in index.ts, inside stampForceChargeOnFate. No other file calls it, and none writes an ON time
  // from a record by another road.
  for (const f of serverSources()) {
    assert.equal(count(f.code, 'forceChargeOnStampColumns('), f.rel === 'nightForceCharge.ts' || f.rel === 'index.ts' ? 1 : 0, f.rel);
    assert.equal(count(f.code, 'forceChargeOnStampColumns'), f.rel === 'nightForceCharge.ts' ? 1 : f.rel === 'index.ts' ? 2 : 0, `${f.rel}: its definition, or its import and its one call`);
  }
  assert.ok(code(raw('nightForceCharge.ts')).includes('\nexport function forceChargeOnStampColumns(\n'));
  assert.equal(count(fnText(INDEX, 'function stampForceChargeOnFate('), 'forceChargeOnStampColumns(from)'), 1);
  assert.equal(count(INDEX, 'force_charge_on_at_ms: nowMs, force_charge_mode: onMode }'), 1, 'and the ON\'s own stamp is the only code line of index.ts that names the two columns');
  assert.equal(count(INDEX, 'force_charge_mode'), 1);
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

test('★★★ the readers on a row whose ON time was restored: the gate exempts the night, forceChargeStateAt reads it on, the mid-day mask drops its hours; with the ON time missing each read a night never switched on', () => {
  const rec = openRecorder();
  try {
    /** The night with every stamp of the ON lost and then its window-end OFF: the row as this release leaves it. */
    const restoredNight = (armed: NightActuationState, onAt: number): Row => {
      const run = nightRun(rec, armed);
      run.on(onAt, [1, 2, 3], [], { lose: true });
      run.tick(armed.windowEndMs!, { slotsOn: null });
      assert.deepEqual(run.actions, ['off']);
      return rowOf(rec, armed.day!)!;
    };
    /** The same night's row with the ON time missing: the OFF's own stamp and the fate alone, with no ON column beside it. */
    const missingNight = (armed: NightActuationState, onAt: number): Row => {
      const record = { ...armed, ...forceChargeOnStamp(armed, onAt, [1, 2, 3], { cost: true, line: false }) };
      rec.recordNightOutcome(armed.day!, { force_charge_off_at_ms: armed.windowEndMs, force_charge_off_reason: 'windowEnd' } as never);
      rec.recordNightOutcome(armed.day!, forceChargeOnFateColumns(record, 'omit'));
      return rowOf(rec, armed.day!)!;
    };
    /** The two rows are one night but for the ON's two columns: whatever a reader says differently, it says of those. */
    const sameButForTheOn = (restored: Row, missing: Row, onAt: number): void => {
      assert.deepEqual([restored.force_charge_on_at_ms, restored.force_charge_mode, missing.force_charge_on_at_ms, missing.force_charge_mode], [onAt, 'cost', null, null]);
      const rest = (r: Row): Row => ({ ...r, plan_date: null, force_charge_on_at_ms: null, force_charge_mode: null });
      assert.deepEqual(rest(restored), rest(missing));
      assert.deepEqual([forceChargeOnFateOf(restored), forceChargeOnFateOf(missing)], ['unconfirmed', 'unconfirmed'], 'the verdict is the fate\'s either way');
    };
    /** forceChargeStateAt as index.ts has it, once the record in memory has moved on, over this one night's row. It
     *  asks for the last 45 days; the row is handed over whatever today's date is (this night is dated, the clock is not). */
    const stateAt = (day: string) => makeForceChargeStateAt(H, emptyActuationState(), {
      readNightLedger: (days: number) => { assert.equal(days, 45); return rec.readNightLedger(36_500).filter((r) => r.plan_date === day); },
    });

    // ── An overnight night that armed the force-charge for a disclosed line and closed under it: what the gate grades. ──
    const G_START = Date.UTC(2027, 6, 2, 6, 0); // 23:00 MST on 2027-07-01
    const G_END = G_START + 6 * H;
    const G_ON = G_END - 100 * MIN;             // 03:20: the run is 03:20 to the window-end OFF at 05:00
    const NOW = G_END + 3 * DAY_MS;
    const overnight = (day: string): NightActuationState => armedNight(day, { windowStartMs: G_START, windowEndMs: G_END });
    const graded = (day: string): Row => ({
      algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast', issued_at_ms: G_START - 3 * H, outcome_captured_at_ms: G_END + 15 * H,
      scored: 1, actuated: 1, cushion_shortfall: 1, cushion_envelope_shortfall: 1, plan_traj_floor_breached: 0, cushion_breached: 1,
      buy_err_kwh: 0.5, pv_err_frac: 0.05, load_err_frac: -0.05, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.95,
      reserve_floor_pct: 30, cushion_pct: 15, cushion_line_soc_pct: 93.63, cushion_trough_soc_pct: 93.63, window_kind: 'overnight',
      cushion_line_force_charge_pct: 94, window_close_soc_pct: 50, actual_min_soc_pct: 40, window_start_ms: G_START, window_end_ms: G_END,
      plan_date: day,
    });
    for (const day of ['2027-07-01', '2027-07-02']) rec.recordNightOutcome(day, graded(day) as never);
    const restored = restoredNight(overnight('2027-07-01'), G_ON);
    const missing = missingNight(overnight('2027-07-02'), G_ON);
    sameButForTheOn(restored, missing, G_ON);
    for (const [k, v] of Object.entries(graded('2027-07-01'))) assert.equal(restored[k], v, `${k} is on the stored row`);
    // The readiness gate, over the row as stored. Missing: armed, disclosed, "never switched on", closed under its line:
    // a strike. Restored: an ON was sent, so the night is exempt as a disclosed row is (the gate's rule, unchanged: it
    // does not read the fate, so it is exempt whether or not the ON took).
    const gate = (r: Row) => computeNightChargeReadiness([r] as never, NOW).metrics;
    assert.deepEqual([gate(missing).activeStrikes, gate(missing).lineForceChargeStrikes], [1, 1], 'the ON time missing: struck as never switched on');
    assert.deepEqual([gate(restored).activeStrikes, gate(restored).lineForceChargeStrikes], [0, 0], 'restored: exempt, an ON was sent');
    // The ON time alone decides it: the stored rows are one night but for it, and each reads as the other with it swapped.
    assert.deepEqual(gate({ ...restored, force_charge_on_at_ms: null }), gate({ ...missing, plan_date: restored.plan_date }));
    assert.deepEqual(gate({ ...missing, force_charge_on_at_ms: G_ON }), gate({ ...restored, plan_date: missing.plan_date }));
    // forceChargeStateAt, for hours of that night.
    const inside = G_END - H;        // 04:00 to 05:00, inside the run
    const onHour = G_END - 2 * H;    // 03:00 to 04:00, the ON falls in it
    const before = G_END - 3 * H;    // 02:00 to 03:00, before the ON
    const after = G_END;             // 05:00 to 06:00, after the OFF
    assert.ok(G_ON > onHour && G_ON < inside);
    assert.deepEqual([inside, onHour, before, after].map(stateAt('2027-07-01')), ['on', 'on', 'off', 'off'], 'restored: on for the hours the force-charge ran, off around them');
    assert.deepEqual([inside, onHour, before, after].map(stateAt('2027-07-02')), ['off', 'off', 'off', 'off'], 'the ON time missing: read as a night with no force-charge');
    // While the record in memory is still that night's, it answers first; the ledger is read once the record has moved on.
    const stillHeld = makeForceChargeStateAt(H, { ...overnight('2027-07-02'), forceChargeOnAtMs: G_ON, forceChargeOffAtMs: G_END }, { readNightLedger: () => [] });
    assert.deepEqual([inside, before].map(stillHeld), ['on', 'off']);
    // A ledger that cannot be read is 'unknown', never 'off'.
    assert.equal(makeForceChargeStateAt(H, emptyActuationState(), { readNightLedger: () => { throw new Error('database is locked'); } })(inside), 'unknown');

    // ── A mid-day charge that rode a standing reserve: no reserve write, so the ON stamp is the row's only mark of a write of ours. ──
    const MID_START = Date.UTC(2027, 6, 3, 17, 0); // 10:00 MST
    const MID_END = MID_START + 5 * H;
    const MID_ON = MID_START + 40 * MIN;
    const midday = (day: string): NightActuationState => ({ ...armedNight(day, { windowStartMs: MID_START, windowEndMs: MID_END }), leg: 'cost', windowKind: 'super_off_peak' } as NightActuationState);
    for (const day of ['2027-07-03', '2027-07-04']) rec.recordNightOutcome(day, { window_kind: 'super_off_peak', window_start_ms: MID_START, window_end_ms: MID_END } as never);
    const midRestored = restoredNight(midday('2027-07-03'), MID_ON);
    const midMissing = missingNight(midday('2027-07-04'), MID_ON);
    sameButForTheOn(midRestored, midMissing, MID_ON);
    assert.deepEqual([midRestored.actuated, midRestored.actuation_applied_at_ms, midRestored.window_kind], [null, null, 'super_off_peak']);
    // middayChargeHourEpochs, over the row as stored: restored, the window's hours (and the hour after its close) are
    // dropped from what the solar learners read; missing, none is, and a grid charge beside the sun is read as evidence
    // about the arrays.
    const hours = [...middayChargeHourEpochs([midRestored] as never)].sort((a, b) => a - b);
    assert.deepEqual(hours, [0, 1, 2, 3, 4, 5].map((n) => Math.floor(MID_START / H) + n));
    assert.equal(middayChargeHourEpochs([midMissing] as never).size, 0);
    assert.deepEqual([...middayChargeHourEpochs([midMissing, midRestored, restored, missing] as never)].sort((a, b) => a - b), hours, 'an overnight row adds none either way');
    assert.deepEqual([MID_START + H, MID_START, MID_START - H, MID_END].map(stateAt('2027-07-03')), ['on', 'on', 'off', 'off']);
    assert.deepEqual([MID_START + H, MID_START, MID_START - H, MID_END].map(stateAt('2027-07-04')), ['off', 'off', 'off', 'off']);
  } finally { rec.close(); }
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
  // The ON's own two columns, written again beside the fate from the same record: a finite number and 'cost' or 'line',
  // or nothing. A mode or a time that is anything else never reaches the row.
  assert.deepEqual(forceChargeOnStampColumns(hostile), { force_charge_on_at_ms: ON_AT, force_charge_mode: 'cost' });
  assert.deepEqual(forceChargeOnStampColumns({ ...hostile, forceChargeMode: SERIAL } as never), { force_charge_on_at_ms: ON_AT });
  assert.deepEqual(forceChargeOnStampColumns({ ...hostile, forceChargeMode: `line ${SERIAL}` } as never), { force_charge_on_at_ms: ON_AT });
  assert.deepEqual(forceChargeOnStampColumns({ ...hostile, forceChargeOnAtMs: SERIAL } as never), {});
  // Through index.ts's own helper, the recorder and the read the route's cache makes (the last 7 days).
  const rec = openRecorder();
  try {
    const day = phoenixYmd(Date.now() + DAY_MS);
    // "Tomorrow" can be a day an earlier test of this file already gave a row (its fixture days are calendar days), with a
    // mode on it. What is asserted of the mode is that the stamp does not write one: the row keeps what it held.
    const heldMode = (rec.readNightLedger(7).find((r) => r.plan_date === day) as unknown as Row | undefined)?.force_charge_mode ?? null;
    const leg = { ...hostile, day, forceChargeMode: SERIAL } as unknown as NightActuationState;
    const s = recordingStampers(rec);
    s.stampForceChargeOnFate(leg, leg, 'write');
    assert.deepEqual(s.writes.map((w) => [w.day, Object.keys(w.cols)]), [[day, ['force_charge_on_at_ms', ...FATE_COLUMNS]]]);
    assert.deepEqual(s.log, { warn: [], debug: [] });
    const served = rec.readNightLedger(7).find((r) => r.plan_date === day) as unknown as Row;
    assert.ok(served != null, 'the row is among those the route serves');
    assert.deepEqual([served.force_charge_on_at_ms, served.force_charge_mode], [ON_AT, heldMode], 'the ON time; the mode that is not a mode is not written (the row keeps what it held)');
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
    const read = (d: string = day) => drop.prepare('SELECT force_charge_on_at_ms, force_charge_mode FROM night_charge_ledger WHERE plan_date = ?').get(d) as Row | undefined;
    assert.throws(() => rec.recordNightOutcome(day, { ...onStampOnly, ...fate } as never), /force_charge_on_retries/, 'folded into one object, the ON time goes down with the fate');
    assert.equal(read(), undefined);
    rec.recordNightOutcome(day, onStampOnly as never);
    assert.throws(() => rec.recordNightOutcome(day, fate as never), /force_charge_on_retries/);
    const r = read()!;
    assert.deepEqual([r.force_charge_on_at_ms, r.force_charge_mode], [ON_AT, 'cost'], 'written apart, the ON time stands');
    // The helper's write names the ON's two columns beside the fate, in ONE upsert: on such a database it fails whole.
    // That is why the ON still has a stamp of its own ahead of it. index.ts's two helpers, run: the ON's stamp lands,
    // the fate stamp fails, is contained in one warning, and takes nothing with it.
    const failing: StampLog = { warn: [], debug: [] };
    const s = sourceStampers({ recordNightOutcome: (d, cols) => rec.recordNightOutcome(d, cols as never) }, failing);
    const leg = onRecord({ day: '2027-04-02' });
    assert.doesNotThrow(() => s.stampForceChargeOnFate(leg, leg, 'write'));
    assert.equal(read('2027-04-02'), undefined, 'the fate stamp alone restores no ON time here: its one upsert failed');
    s.stampLegOutcome(leg, onStampOnly);
    assert.doesNotThrow(() => s.stampForceChargeOnFate(leg, leg, 'write'));
    assert.doesNotThrow(() => s.stampForceChargeOnFate(leg, armedNight('2027-04-03'), 'omit', true));
    assert.equal(failing.warn.length, 3);
    for (const line of failing.warn) assert.match(line, /^night-charge: ledger stamp failed for 2027-04-02 \(.*force_charge_on_retries/);
    assert.deepEqual([read('2027-04-02')!.force_charge_on_at_ms, read('2027-04-02')!.force_charge_mode], [ON_AT, 'cost']);
    // index.ts contains the failed write: the stamp never throws into the tick.
    const stampLeg = fnText(INDEX, 'function stampLegOutcome(');
    assert.ok(stampLeg.includes('  try { recorder.recordNightOutcome(leg.day, cols); }\n  catch (e: any) { app.log.warn(`night-charge: ledger stamp failed for ${leg.day} (${e?.message ?? e})`); }\n'));
  } finally {
    try { drop.exec('ALTER TABLE night_charge_ledger ADD COLUMN force_charge_on_retries INTEGER'); } catch { /* still there */ }
    drop.close();
    rec.close();
  }
});
