import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.189.0 on v1.188.1 — the night ledger's two additions meet on one row: v1.188.1's held
 * telemetry (a row on held readings is not scored; a row captured on them is reset and re-captured,
 * or tagged past the horizon) and v1.189.0's charge cycle and mid-day shadow (the evening's
 * shadow_* columns and the shadow's measured window, captured with the row).
 *  - the shadow's window is measured on the held verdict over the window itself, the rule the
 *    row's own PV/load actuals are withheld by;
 *  - the held repair's reset clears the shadow's measured window with the outcome (the re-capture
 *    measures it again) and leaves what the evening computed; a tag keeps the row as captured;
 *  - a database as v1.188.1 leaves it (the held tables, a row refused for held telemetry, none of
 *    the v1.189.0 columns) gains every charge-cycle and shadow column on the first start and
 *    nothing on the second; its held spans and the row's verdict are kept and the repair owes the
 *    row nothing.
 * Serials are fakes.
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-held-shadow-'));
const DB = join(tmp, 'ecoflow.db');
process.env.DB_PATH = DB;

const { createRecorder, CHARGE_CYCLE_LEDGER_SCHEMA, MIDDAY_SHADOW_LEDGER_SCHEMA } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const {
  shadowWindowActuals, heldLedgerVerdict, heldLedgerNote, heldLedgerRepair, heldRepairColumns, forecastSpanResetColumns,
  forecastSpanRecaptureHorizonMs, HELD_LEDGER_MIN_OVERLAP_MS, LEDGER_SPAN_MIN_COVERAGE, FORECAST_SPAN_MS,
} = await import('../src/nightLedgerScoring.js');
import type { LedgerHeldSpan } from '../src/nightLedgerScoring.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const CORES = ['COREXXX00XXX0001', 'COREXXX00XXX0002'];
const PANEL = 'PANEXXX00XXX0001';
const name = (sn: string) => (sn === PANEL ? 'Smart Home Panel 2' : `Core ${sn.slice(-1)}`);
const HORIZON = forecastSpanRecaptureHorizonMs(30, 60);
const V1189_COLUMNS = [...CHARGE_CYCLE_LEDGER_SCHEMA, ...MIDDAY_SHADOW_LEDGER_SCHEMA];

/** A winter weekday's mid-day window, 10:00-15:00, the evening before it the row's issue. */
const A = phx(11, 17, 10);
const B = phx(11, 17, 15);
const ISSUED = phx(11, 16, 21, 30);
/** Every 5 minutes over [from, to]: a series with every reading present. */
const flat = (w: number, from = A, to = B) => {
  const out: Array<{ ts: number; value: number }> = [];
  for (let t = from; t <= to; t += 5 * MIN) out.push({ ts: t, value: w });
  return out;
};
const SHADOW_ROW = { shadow_cost_window_start_ms: A, shadow_cost_window_end_ms: B };

/* ══ the shadow's window, on the held verdict ══════════════════════════════ */

test('★★★ the shadow\'s window withholds each side held for an hour or more of it — the scorer\'s rule, per side', () => {
  const measure = (spans: LedgerHeldSpan[]) => shadowWindowActuals({
    row: SHADOW_ROW, nowMs: B + H, homeSns: CORES,
    queryPv: () => flat(2000), queryLoad: () => flat(3000),
    held: { spans: (a, b) => { assert.deepEqual([a, b], [A, B], 'the spans over the window itself'); return spans; }, panelSn: PANEL },
  });
  // Every reading present: only the verdict can refuse here (the coverage is full).
  assert.deepEqual(measure([]), { pvKwh: 20, loadKwh: 15 }, '2 Cores × 2 kW × 5 h; 3 kW × 5 h');
  const core1 = (startMs: number, endMs: number): LedgerHeldSpan => ({ sn: CORES[0], startMs, endMs });
  assert.deepEqual(measure([core1(A + H, A + H + HELD_LEDGER_MIN_OVERLAP_MS)]), { pvKwh: null, loadKwh: 15 },
    '★★★ a home Core held an hour of the window: no PV figure; the load stands');
  assert.deepEqual(measure([core1(A + H, A + H + HELD_LEDGER_MIN_OVERLAP_MS - MIN)]), { pvKwh: 20, loadKwh: 15 },
    'under an hour is integrated across, as over the row\'s span');
  assert.deepEqual(measure([{ sn: PANEL, startMs: A - 3 * H, endMs: A + 2 * H }]), { pvKwh: 20, loadKwh: null },
    '★★★ the house panel held two hours of the window: no load figure; the PV stands');
  assert.deepEqual(measure([core1(A - 6 * H, A)]), { pvKwh: 20, loadKwh: 15 }, 'a hold that ended at the window open is outside it');
  assert.deepEqual(measure([{ sn: 'COREXXX00XXX0009', startMs: A, endMs: B }]), { pvKwh: 20, loadKwh: 15 },
    'a device off the panel is no home Core of this row');
  // Without the spans (a caller that has none) nothing is held: the figures are as before.
  assert.deepEqual(shadowWindowActuals({ row: SHADOW_ROW, nowMs: B + H, homeSns: CORES, queryPv: () => flat(2000), queryLoad: () => flat(3000) }),
    { pvKwh: 20, loadKwh: 15 });
});

test('★★ with the held readings out of samples (the v1.188.1 recorder), an hour-long hole anywhere in the window fails the coverage too', () => {
  // The two rules agree on the 10:00-15:00 window: an hour is a fifth of it, the coverage allows a tenth.
  assert.ok(B - A <= HELD_LEDGER_MIN_OVERLAP_MS / (1 - LEDGER_SPAN_MIN_COVERAGE), 'a window this short cannot hide a held hour in its coverage');
  for (let s = A; s + H <= B; s += 5 * MIN) {
    const holed = (sn: string) => (sn === CORES[1] ? flat(2000).filter((p) => p.ts < s || p.ts >= s + H) : flat(2000));
    const r = shadowWindowActuals({ row: SHADOW_ROW, nowMs: B + H, homeSns: CORES, queryPv: holed, queryLoad: () => flat(3000) })!;
    assert.equal(r.pvKwh, null, `a held hour from ${(s - A) / MIN} min`);
  }
});

/* ══ the held repair on a row with a shadow ════════════════════════════════ */

/** The row as captured the evening after (issue + 24 h), the shadow's window measured with it on
 *  readings the hourly scan found held only afterwards. */
const CAPTURED = {
  plan_date: '2026-11-16',
  issued_at_ms: ISSUED,
  window_start_ms: phx(11, 16, 23),
  window_end_ms: phx(11, 17, 5),
  outcome_captured_at_ms: ISSUED + FORECAST_SPAN_MS + MIN,
  score_notes: 'scored — planner-sizing basis (algo v3): net forecast miss 1.2 kWh (PV 31→29.8, load 44→44); advisory night.',
  pv_model_sns: CORES.join(','),
  delivered_kwh: null,
  delivered_basis: null,
  actual_pv_kwh: 29.8,
  actual_load_kwh: 44,
  ...SHADOW_ROW,
  shadow_cost_level_pct: 80,
  shadow_window_pv_p50_kwh: 12,
  shadow_window_pv_kwh: 11.4,
  shadow_window_load_kwh: 14.9,
};
/** Found after the capture: Core 2 replayed its last reading from 11:00 to 14:00. */
const FOUND: LedgerHeldSpan[] = [{ sn: CORES[1], startMs: A + H, endMs: A + 4 * H }];

test('★★★ the held repair\'s reset clears the shadow\'s measured window with the outcome; what the evening computed stays', () => {
  const r = heldLedgerRepair(CAPTURED, { spans: FOUND, coreSns: CORES, panelSn: PANEL, nowMs: CAPTURED.outcome_captured_at_ms + 2 * H, horizonMs: HORIZON });
  assert.equal(r?.action, 'recapture');
  assert.deepEqual(r!.added, ['PV']);
  const cols = heldRepairColumns(CAPTURED, r!, name) as Record<string, unknown>;
  assert.equal(cols.outcome_captured_at_ms, null, 'the sweep captures it again');
  assert.equal(cols.shadow_window_pv_kwh, null, '★★★ no figure measured on the replayed readings is kept');
  assert.equal(cols.shadow_window_load_kwh, null, 'the window is re-measured whole');
  assert.deepEqual(Object.keys(cols).filter((k) => k.startsWith('shadow_')).sort(), ['shadow_window_load_kwh', 'shadow_window_pv_kwh'],
    'the shadow\'s own columns (its window, level, P50s) are not outcome columns');
  // The forecast-span reset is the same set of columns (heldResetColumns builds on it).
  const fs = forecastSpanResetColumns(2 * H) as Record<string, unknown>;
  assert.equal(fs.shadow_window_pv_kwh, null);
  assert.equal(fs.shadow_window_load_kwh, null);
  // The re-capture measures the window on the verdict: Core 2's three held hours leave no PV figure.
  const again = shadowWindowActuals({
    row: { ...CAPTURED, ...cols }, nowMs: CAPTURED.outcome_captured_at_ms + 2 * H, homeSns: CORES,
    queryPv: () => flat(2000), queryLoad: () => flat(3000), held: { spans: () => FOUND, panelSn: PANEL },
  });
  assert.deepEqual(again, { pvKwh: null, loadKwh: 15 });
  // Past the horizon the row is tagged and kept as captured, the shadow's window with it.
  const late = heldLedgerRepair(CAPTURED, { spans: FOUND, coreSns: CORES, panelSn: PANEL, nowMs: ISSUED + HORIZON + 2 * DAY, horizonMs: HORIZON });
  assert.equal(late?.action, 'tag');
  assert.deepEqual(Object.keys(heldRepairColumns(CAPTURED, late!, name)), ['score_notes']);
});

test('★★★ SOURCE PIN: the scorer measures the shadow\'s window on the recorder\'s held spans and the house panel', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const score = idx.slice(idx.indexOf('function scoreNightRow('), idx.indexOf('The single ~21:30 America/Phoenix evening job'));
  const call = score.slice(score.indexOf('const shadowActuals = shadowWindowActuals({'), score.indexOf('if (shadowActuals != null) {'));
  assert.ok(call.includes('    held: { spans: (a, b) => recorder.heldSpans?.(a, b) ?? [], panelSn: shp2Sn },'), call);
  // The same panel the row's own actuals and the held verdict over its span read.
  assert.ok(score.includes("const loadPts = recorder.query(shp2Sn, 'panel_load', fcSpanStart, fcSpanEnd);"));
  assert.ok(score.includes('coreSns: [...homeSns], panelSn: shp2Sn, span: { startMs: fcSpanStart, endMs: fcSpanEnd },'));
});

/* ══ a database as v1.188.1 leaves it ══════════════════════════════════════ */

test('★★★ a v1.188.1 database gains every v1.189.0 column on the first start and nothing on the second; the held spans and the refused row are kept', () => {
  const tableInfo = () => {
    const db = new DatabaseSync(DB);
    try { return db.prepare('PRAGMA table_info(night_charge_ledger)').all() as Array<{ name: string; type: string }>; } finally { db.close(); }
  };
  const issued = phx(10, 14, 21, 30);
  const span = { startMs: issued, endMs: issued + FORECAST_SPAN_MS };
  const spans: LedgerHeldSpan[] = [
    ...CORES.map((sn) => ({ sn, startMs: phx(10, 14, 23, 53), endMs: phx(10, 16, 20, 28) })),
    { sn: PANEL, startMs: phx(10, 14, 23, 53), endMs: phx(10, 15, 4, 11) },
  ];
  const verdict = heldLedgerVerdict({ spans, coreSns: CORES, panelSn: PANEL, span })!;
  const notes = `${heldLedgerNote(verdict, name)} On-peak: none.`;
  // The first start of any version writes the schema and the held tables; the row as v1.188.1
  // captured it: refused for held telemetry, its actuals empty.
  {
    const rec = createRecorder(new SnapshotStore(), () => {});
    rec.recordNightPlan({
      plan_date: '2026-10-14', issued_at_ms: issued, buy_kwh: 0, algo_version: '3',
      window_start_ms: phx(10, 14, 23), window_end_ms: phx(10, 15, 5), pv_model_sns: CORES.join(','),
    } as never);
    rec.recordNightOutcome('2026-10-14', {
      outcome_captured_at_ms: issued + FORECAST_SPAN_MS + MIN, scored: 0, score_notes: notes, actual_pv_kwh: null, actual_load_kwh: null,
    } as never);
    rec.close();
  }
  // v1.188.1's shape: the ledger without the columns v1.189.0 adds, and the spans its gate and scan logged.
  {
    const db = new DatabaseSync(DB);
    for (const [c] of V1189_COLUMNS) db.exec(`ALTER TABLE night_charge_ledger DROP COLUMN ${c}`);
    const ins = db.prepare('INSERT INTO held_spans (sn, start_ts, end_ts, reason, rows, detected_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of spans) ins.run(s.sn, s.startMs, s.endMs, s.sn === PANEL ? 'frozen' : 'gate-stale', s.sn === PANEL ? 52 : 0, phx(10, 16, 20, 30));
    db.close();
  }
  const before = tableInfo();
  for (const [c] of V1189_COLUMNS) assert.ok(!before.some((x) => x.name === c), `${c} is not on a v1.188.1 ledger`);

  let firstCount = 0;
  for (const pass of [1, 2]) {
    const rec = createRecorder(new SnapshotStore(), () => {});
    try {
      const info = tableInfo();
      const types = new Map(info.map((x) => [x.name, x.type]));
      for (const [c, t] of V1189_COLUMNS) assert.equal(types.get(c), t, `pass ${pass}: ${c} ${t}`);
      assert.equal(info.length, before.length + V1189_COLUMNS.length, `pass ${pass}: each column once`);
      if (pass === 1) firstCount = info.length;
      else assert.equal(info.length, firstCount, 'the second start adds nothing');
      const row = rec.readNightLedger(3650).find((r) => r.plan_date === '2026-10-14')!;
      assert.equal(row.score_notes, notes, 'the held verdict kept as v1.188.1 wrote it');
      assert.equal(row.actual_pv_kwh, null);
      if (pass === 1) for (const [c] of V1189_COLUMNS) assert.equal((row as unknown as Record<string, unknown>)[c], null, `${c} is NULL on the old row`);
      const held = rec.heldSpans!(issued - DAY, issued + 3 * DAY);
      assert.deepEqual(held.map((s) => s.sn).sort(), [...CORES, PANEL].sort(), 'the held spans are kept');
      assert.equal(heldLedgerRepair(row, {
        spans: held, coreSns: CORES, panelSn: PANEL, nowMs: phx(10, 17, 9), horizonMs: HORIZON,
        restored: rec.restoredHeldSpans?.(issued - DAY, issued + 3 * DAY) ?? [],
      }), null, '★★★ the repair owes the upgraded row nothing: its notes state both held sides');
      // The evening's charge-cycle and shadow stamps land on the upgraded row and survive a restart.
      if (pass === 1) rec.recordNightOutcome('2026-10-14', { window_kind: 'overnight', shadow_cycle_why: 'overnight-configured' } as never);
      else assert.deepEqual([row.window_kind, row.shadow_cycle_why], ['overnight', 'overnight-configured']);
    } finally { rec.close(); }
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
