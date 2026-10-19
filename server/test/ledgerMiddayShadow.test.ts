import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * R4 (v1.189.0) — the ledger of the mid-day cycle (plan §6), before the switch:
 *  - the shadow's own columns (MIDDAY_SHADOW_LEDGER_SCHEMA), added to an old table and writable;
 *  - a two-leg row's three spans (cycleLedgerSpans): the rows tile, a 07:00 breach falls inside a
 *    row and is a strike on an actuated cycle, armed backup or not; both cheap periods for the
 *    on-peak attribution; a later row's backup window supersedes;
 *  - the learners (plan §3.3): only the buy de-bias is stratified by window kind, and it reads the
 *    refreshed worst case when the row has one; the load band stays pooled;
 *  - the readiness gate's per-kind graduation counts;
 *  - §4 item 9, the accounting part: the hours a mid-day charge of ours held the pool, dropped by
 *    the soiling estimate, the Bayesian posterior and the PV bias hindcast.
 * No row is two-leg before the switch: every row scored today takes the overnight branch.
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-midday-shadow-'));
const DB = join(tmp, 'ecoflow.db');
process.env.DB_PATH = DB;
{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE night_charge_ledger (
    plan_date TEXT PRIMARY KEY, issued_at_ms INTEGER, algo_version TEXT, buy_kwh REAL
  )`);
  db.prepare(`INSERT INTO night_charge_ledger (plan_date, issued_at_ms, buy_kwh) VALUES (?, ?, ?)`).run('2026-10-01', 1, 30.5);
  db.close();
}
const { createRecorder, MIDDAY_SHADOW_LEDGER_SCHEMA, CHARGE_CYCLE_LEDGER_SCHEMA } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const {
  cycleLedgerSpans, ledgerCheapPeriodIds, minOverSpans, shadowWindowActuals, middayChargeHourEpochs, withoutHourEpochs,
  supersedingPlanDate, ledgerSpansForWindow, SCORE_SPAN_AFTER_CLOSE_MS,
} = await import('../src/nightLedgerScoring.js');
const { calibratedBuyDebiasFactor, ledgerRowWindowKind, medianFilter3, DELIVERED_BASIS } = await import('../src/nightChargeAdvisor.js');
const { computeNightChargeReadiness, CURRENT_ALGO_VERSION } = await import('../src/nightChargeGate.js');
const { chooseChargeCycle, nextChargeableOpenMs } = await import('../src/chargeWindows.js');
const { buildApsREvModel, rateAt } = await import('../src/tariff.js');
const { middayShadowLedgerColumns } = await import('../src/middayShadow.js');
import type { NightLedgerRow } from '../src/recorder.js';

const H = 3_600_000;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const MODEL = buildApsREvModel();
const isOnPeak = (t: number) => rateAt(MODEL, t).isOnPeak;
const cheapFor = (kind: string | null) => (t: number) => ledgerCheapPeriodIds(kind).includes(rateAt(MODEL, t).periodId);
const CFG = { costWindow: 'super_off_peak' as const, objective: 'cost' as const, costMaxSocPct: 90 };

/** The two-leg row an evening's mid-day cycle would write (the switch's plan columns). */
function twoLegRow(mo: number, d: number): Partial<NightLedgerRow> & { plan_date: string } {
  const at = phx(mo, d, 21, 30);
  const c = chooseChargeCycle(MODEL, at, CFG);
  assert.equal(c.why, 'midday', `${mo}-${d}`);
  return {
    plan_date: `2026-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    window_kind: 'super_off_peak', window_start_ms: c.cost!.startMs, window_end_ms: c.cost!.endMs,
    backup_window_start_ms: c.backup!.startMs, backup_window_end_ms: c.backup!.endMs,
    next_recharge_ms: nextChargeableOpenMs(MODEL, c.cost!.endMs + H, CFG),
  };
}

/* ══ the shadow columns ════════════════════════════════════════════════════ */

test('★★★ an old-schema ledger gains every shadow column with its type; an old row reads NULL; every column round-trips', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const info = new DatabaseSync(DB).prepare('PRAGMA table_info(night_charge_ledger)').all() as Array<{ name: string; type: string }>;
    const types = new Map(info.map((c) => [c.name, c.type]));
    // R5 — 32: the shadow refresh's weather age.
    assert.equal(MIDDAY_SHADOW_LEDGER_SCHEMA.length, 32);
    for (const [c, t] of MIDDAY_SHADOW_LEDGER_SCHEMA) {
      assert.equal(types.get(c), t, `${c} ${t}`);
      assert.match(c, /^shadow_/, 'a shadow column never shares a name with a live one');
    }
    const live = new Set(CHARGE_CYCLE_LEDGER_SCHEMA.map(([c]) => c as string));
    for (const [c] of MIDDAY_SHADOW_LEDGER_SCHEMA) assert.ok(!live.has(c));
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    for (const [c] of MIDDAY_SHADOW_LEDGER_SCHEMA) assert.equal(at('2026-10-01')[c], null, c);
    const sample = (t: string, i: number) => (t === 'TEXT' ? `v${i}` : t === 'INTEGER' ? 2_000 + i : i + 0.25);
    const all = Object.fromEntries(MIDDAY_SHADOW_LEDGER_SCHEMA.map(([c, t], i) => [c, sample(t, i)]));
    rec.recordNightOutcome('2026-10-01', all as never);
    for (const [c] of MIDDAY_SHADOW_LEDGER_SCHEMA) assert.deepEqual(at('2026-10-01')[c], all[c], c);
    assert.equal(at('2026-10-01').buy_kwh, 30.5, 'the live plan column is untouched');
    // Every column the shadow's evening writes is one of them.
    const cols = new Set(MIDDAY_SHADOW_LEDGER_SCHEMA.map(([c]) => c as string));
    const written = middayShadowLedgerColumns({
      version: 1, day: '2026-10-14', computedAtMs: 1, why: 'midday', mode: 'supervised', backup: null, cost: null, refresh: null, note: null,
    });
    for (const k of Object.keys(written)) assert.ok(cols.has(k), k);
  } finally { rec.close(); }
});

/* ══ a two-leg row's spans ═════════════════════════════════════════════════ */

test('★★★ two-leg rows tile end to end: backup [overnight open, 10:00), window, post [15:00, 23:00)', () => {
  // Sunday 10-18 to Thursday 10-22.
  const rows = [18, 19, 20, 21, 22].map((d) => twoLegRow(10, d));
  const spans = rows.map((r) => cycleLedgerSpans(r as NightLedgerRow, isOnPeak, cheapFor('super_off_peak'))!);
  // Sunday's backup is Monday 00:00–05:00; the rest 23:00–05:00.
  assert.deepEqual(spans[0].troughSpans, [{ startMs: phx(10, 19, 0), endMs: phx(10, 19, 10) }, { startMs: phx(10, 19, 15), endMs: phx(10, 19, 23) }]);
  for (let i = 1; i < spans.length; i++) {
    assert.equal(spans[i].troughSpans[0].startMs, spans[i - 1].troughSpans[1].endMs, `row ${rows[i].plan_date} opens where the last closed`);
    assert.equal(spans[i].troughSpans[1].endMs - spans[i].troughSpans[1].startMs, 8 * H, '15:00 to 23:00');
    assert.equal(spans[i].scoreSpanEndMs, spans[i].troughSpans[1].endMs);
  }
  // A plain close + 16 h would have ended at 07:00, inside the next row's backup span.
  assert.equal(rows[1].window_end_ms! + SCORE_SPAN_AFTER_CLOSE_MS, phx(10, 21, 7));
  // Wednesday's 07:00 low falls inside exactly one row: Tuesday's, whose backup span runs from
  // Tuesday 23:00 to Wednesday 10:00 (Monday's post span closed at Tuesday 23:00).
  const sevenAm = phx(10, 21, 7);
  const owner = spans.filter((s) => s.troughSpans.some((sp) => sevenAm >= sp.startMs && sevenAm < sp.endMs));
  assert.equal(owner.length, 1);
  assert.equal(spans.indexOf(owner[0]), 2, 'Tuesday\'s row');
  // The governed on-peak is the day's 16:00–19:00, and the row completes after it and the post span.
  assert.deepEqual(spans[1].onpeak, { startMs: phx(10, 20, 16), endMs: phx(10, 20, 19) });
  assert.equal(spans[1].completeMs, phx(10, 20, 23), 'captured at 23:00 the next day');
});

test('★★★ every row before the switch keeps close + 16 h: an overnight row, or a row with no window kind, has no cycle spans', () => {
  for (const kind of ['overnight', null, undefined]) {
    assert.equal(cycleLedgerSpans({ window_kind: kind as never, window_start_ms: phx(10, 14, 23), window_end_ms: phx(10, 15, 5) }, isOnPeak, cheapFor(null)), null);
  }
  assert.deepEqual([...ledgerCheapPeriodIds('overnight')], ['overnight']);
  assert.deepEqual([...ledgerCheapPeriodIds(null)], ['overnight']);
  assert.deepEqual([...ledgerCheapPeriodIds('super_off_peak')], ['overnight', 'super_off_peak']);
  // An overnight row's spans are the ones it always had.
  const s = ledgerSpansForWindow(phx(10, 15, 5), isOnPeak, cheapFor('overnight'));
  assert.equal(s.scoreSpanEndMs, phx(10, 15, 21));
  // A two-leg row with no backup open on it scores the post span alone; no span is invented.
  const r = twoLegRow(10, 20);
  const noBackup = cycleLedgerSpans({ ...r, backup_window_start_ms: null } as NightLedgerRow, isOnPeak, cheapFor('super_off_peak'))!;
  assert.equal(noBackup.troughSpans.length, 1);
  // No next chargeable open on the row: the post span is capped at close + 16 h.
  const noNext = cycleLedgerSpans({ ...r, next_recharge_ms: null } as NightLedgerRow, isOnPeak, cheapFor('super_off_peak'))!;
  assert.equal(noNext.scoreSpanEndMs, r.window_end_ms! + SCORE_SPAN_AFTER_CLOSE_MS);
});

test('★★★ on-peak attribution: a two-leg row counts both cheap periods; a later row\'s BACKUP window supersedes', () => {
  // Saturday's overnight arm for Monday 00:00–05:00 is superseded by Sunday's two-leg row, whose
  // backup holds that window — as by Sunday's overnight row before the switch.
  const sat = { plan_date: '2026-10-17', window_start_ms: phx(10, 19, 0), window_end_ms: phx(10, 19, 5) };
  const sun = twoLegRow(10, 18) as NightLedgerRow;
  assert.equal(supersedingPlanDate(sat as NightLedgerRow, [sat as NightLedgerRow, sun]), '2026-10-18');
  // The pre-switch shape still supersedes on the same window.
  const sunOvernight = { plan_date: '2026-10-18', window_start_ms: phx(10, 19, 0), window_end_ms: phx(10, 19, 5) };
  assert.equal(supersedingPlanDate(sat as NightLedgerRow, [sat as NightLedgerRow, sunOvernight as NightLedgerRow]), '2026-10-18');
  // An earlier row's backup never supersedes a later one, and an unrelated backup window does not match.
  assert.equal(supersedingPlanDate(sun, [sat as NightLedgerRow, sun]), null);
  assert.equal(supersedingPlanDate(twoLegRow(10, 20) as NightLedgerRow, [twoLegRow(10, 20) as NightLedgerRow, twoLegRow(10, 21) as NightLedgerRow]), null);
  // A two-leg row's governed on-peak, scanned with both cheap periods, is still the 16:00 on-peak.
  const s = cycleLedgerSpans(twoLegRow(10, 20) as NightLedgerRow, isOnPeak, cheapFor('super_off_peak'))!;
  assert.deepEqual(s.onpeak, { startMs: phx(10, 21, 16), endMs: phx(10, 21, 19) });
});

test('★★★ the realized trough covers the backup AND the post span: a 07:00 breach on an actuated cycle is a strike, armed backup or not', () => {
  const r = twoLegRow(10, 20);
  const spans = cycleLedgerSpans(r as NightLedgerRow, isOnPeak, cheapFor('super_off_peak'))!;
  // Telemetry: 50% all along, a dip to 22% at 07:00 the next morning, a lone 0 spike at 18:00 (in
  // the post span: a reconnect artifact, filtered).
  const pts: Array<{ ts: number; value: number }> = [];
  for (let t = phx(10, 20, 23); t < phx(10, 21, 23); t += 5 * 60_000) {
    pts.push({ ts: t, value: t >= phx(10, 21, 6, 30) && t < phx(10, 21, 7, 30) ? 22 : t === phx(10, 21, 18) ? 0 : 50 });
  }
  const q = (a: number, b: number) => pts.filter((p) => p.ts >= a && p.ts < b);
  const low = minOverSpans(spans.troughSpans, q, medianFilter3)!;
  assert.equal(low.value, 22, 'the 07:00 low; the lone spike is filtered');
  assert.ok(low.ts >= phx(10, 21, 6, 30) && low.ts < phx(10, 21, 7, 30));
  // The post span alone would have missed it (the window close + 16 h would also have caught it, but
  // in the NEXT row's backup span).
  assert.equal(minOverSpans([spans.troughSpans[1]], q, medianFilter3)!.value, 50);
  assert.equal(minOverSpans([], q, medianFilter3), null);
  // The gate: actuated, the cushion breached on that trough, no disclosed shortfall — a strike, with
  // the backup never armed.
  const now = phx(10, 22, 23);
  const row = {
    ...r, algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast', issued_at_ms: phx(10, 20, 21, 30),
    outcome_captured_at_ms: phx(10, 21, 23), scored: 1, actuated: 1, cushion_shortfall: 0, cushion_breached: 1,
    actual_min_soc_pct: 22, backup_actuated: null, buy_err_kwh: 1, pv_err_frac: 0, load_err_frac: 0,
  } as unknown as NightLedgerRow;
  const g = computeNightChargeReadiness([row], now);
  assert.equal(g.metrics.activeStrikes, 1);
  assert.equal(g.state, 'BLOCKED');
  assert.equal(g.metrics.actuatedNightsMidday, 1);
  assert.equal(g.metrics.actuatedNightsOvernight, 0);
});

test('★★ readiness: graduation counts per window kind, every criterion pooled (a NULL window kind is overnight)', () => {
  const now = phx(10, 30, 23);
  const base = { algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast', scored: 1, actuated: 1, cushion_shortfall: 1, buy_err_kwh: 1 };
  const rows = [
    { ...base, plan_date: '2026-10-20', window_kind: null },
    { ...base, plan_date: '2026-10-21', window_kind: 'overnight' },
    { ...base, plan_date: '2026-10-22', window_kind: 'super_off_peak' },
    { ...base, plan_date: '2026-10-23', window_kind: 'super_off_peak', actuated: 0 },
  ] as unknown as NightLedgerRow[];
  const g = computeNightChargeReadiness(rows, now);
  assert.equal(g.metrics.actuatedNights, 3, 'pooled');
  assert.equal(g.metrics.actuatedNightsOvernight, 2);
  assert.equal(g.metrics.actuatedNightsMidday, 1);
  assert.equal(g.scoredDays, 3);
});

/* ══ the shadow's window, measured ═════════════════════════════════════════ */

test('★★★ shadowWindowActuals: the home Cores\' PV and the panel\'s load over the mid-day window; each needs 90% coverage', () => {
  const a = phx(10, 15, 10);
  const b = phx(10, 15, 15);
  const flat = (w: number, from = a, to = b) => {
    const out: Array<{ ts: number; value: number }> = [];
    for (let t = from; t <= to; t += 5 * 60_000) out.push({ ts: t, value: w });
    return out;
  };
  const row = { shadow_cost_window_start_ms: a, shadow_cost_window_end_ms: b };
  const r = shadowWindowActuals({ row, nowMs: b + H, homeSns: ['A', 'B'], queryPv: () => flat(2000), queryLoad: () => flat(3000) })!;
  assert.equal(r.pvKwh, 20, '2 Cores × 2 kW × 5 h');
  assert.equal(r.loadKwh, 15);
  // One dark Core withholds the PV figure; a thin load series the load figure.
  const dark = shadowWindowActuals({ row, nowMs: b + H, homeSns: ['A', 'B'], queryPv: (sn) => (sn === 'B' ? flat(2000, a, a + 2 * H) : flat(2000)), queryLoad: () => flat(3000, a, a + H) })!;
  assert.deepEqual(dark, { pvKwh: null, loadKwh: null });
  // Not before the window closes; not on a row with no shadow window.
  assert.equal(shadowWindowActuals({ row, nowMs: b - 1, homeSns: ['A'], queryPv: () => flat(1), queryLoad: () => flat(1) }), null);
  assert.equal(shadowWindowActuals({ row: {}, nowMs: b + H, homeSns: ['A'], queryPv: () => flat(1), queryLoad: () => flat(1) }), null);
  assert.deepEqual(shadowWindowActuals({ row, nowMs: b + H, homeSns: [], queryPv: () => flat(1), queryLoad: () => flat(3000) }), { pvKwh: null, loadKwh: 15 });
});

/**
 * v1.189.0 (review) — the shadow's measured window PV is forecast-skill evidence only where the
 * row's own PV verdict is: the shadow's window P50 comes from the same evening band. A band built
 * on a solar model fitted on other Cores than the actuals (pvVerdictSetAside: the 2026-09-27
 * partial-device-map class, or a roster change between plan and capture) sets the row's verdict
 * aside — and the window's three-Core sum was still written beside a one-Core P50 as a graded pair.
 */
test('★★★ shadowWindowActuals: no measured PV on a row whose PV verdict is set aside; the load is kept', async () => {
  const { pvVerdictSetAside } = await import('../src/nightLedgerScoring.js');
  const a = phx(10, 15, 10);
  const b = phx(10, 15, 15);
  const flat = (w: number) => {
    const out: Array<{ ts: number; value: number }> = [];
    for (let t = a; t <= b; t += 5 * 60_000) out.push({ ts: t, value: w });
    return out;
  };
  const row = { shadow_cost_window_start_ms: a, shadow_cost_window_end_ms: b };
  const homeSns = ['A', 'B', 'C'];
  const base = { row, nowMs: b + H, homeSns, queryPv: () => flat(2000), queryLoad: () => flat(3000) };
  // The band was fitted on one Core, the actuals sum three: the row's verdict is set aside.
  const aside = pvVerdictSetAside('A', homeSns);
  assert.ok(aside != null && /set aside/.test(aside));
  assert.deepEqual(shadowWindowActuals({ ...base, pvSetAside: aside }), { pvKwh: null, loadKwh: 15 });
  // The same Cores: the verdict stands, and so does the measured PV.
  assert.equal(pvVerdictSetAside('A,B,C', homeSns), null);
  assert.deepEqual(shadowWindowActuals({ ...base, pvSetAside: pvVerdictSetAside('A,B,C', homeSns) }), { pvKwh: 30, loadKwh: 15 });
  assert.deepEqual(shadowWindowActuals(base), { pvKwh: 30, loadKwh: 15 }, 'no set-aside given: measured');
  // The scorer passes the row's own set-aside, the one written to pv_verdict_set_aside.
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const score = idx.slice(idx.indexOf('function scoreNightRow('), idx.indexOf('The single ~21:30 America/Phoenix evening job'));
  const call = score.slice(score.indexOf('const shadowActuals = shadowWindowActuals({'), score.indexOf('if (shadowActuals != null) {'));
  assert.ok(call.includes('    pvSetAside: cols.pvSetAside,\n'), call);
  assert.ok(score.includes('    pv_verdict_set_aside: cols.pvSetAside,\n'));
});

/* ══ the learners (plan §3.3) ══════════════════════════════════════════════ */

test('★★★ the buy de-bias reads one stratum per window kind; a NULL window kind is overnight; the refreshed worst case is the planned figure', () => {
  const r = (kind: string | null, delivered: number, buy: number, refreshed: number | null = null) => ({
    actuated: 1, scored: 1, cushion_shortfall: 0, buy_kwh: buy, delivered_kwh: delivered, delivered_basis: DELIVERED_BASIS,
    window_kind: kind, refreshed_buy_kwh: refreshed,
  });
  const overnight = Array.from({ length: 7 }, (_, i) => r(i % 2 ? 'overnight' : null, 30, 20)); // ×1.5
  const midday = Array.from({ length: 7 }, () => r('super_off_peak', 22, 20, 20)); // ×1.1
  const rows = [...overnight, ...midday];
  const o = calibratedBuyDebiasFactor(rows);
  assert.deepEqual([o.factor, o.basis, o.samples], [1.5, 'measured', 7], 'the default stratum is overnight, NULL rows included');
  assert.deepEqual(calibratedBuyDebiasFactor(rows, { windowKind: 'overnight' }), o);
  const m = calibratedBuyDebiasFactor(rows, { windowKind: 'super_off_peak' });
  assert.deepEqual([m.factor, m.samples], [1.1, 7]);
  // The refreshed worst case is the figure the leg ran on.
  const refreshed = Array.from({ length: 7 }, () => r('super_off_peak', 22, 40, 20));
  assert.equal(calibratedBuyDebiasFactor(refreshed, { windowKind: 'super_off_peak' }).factor, 1.1, '22 / 20, not 22 / 40');
  // An empty stratum is the floor, unmeasured — the overnight stratum never lends it its factor.
  const thin = calibratedBuyDebiasFactor(overnight, { windowKind: 'super_off_peak' });
  assert.deepEqual([thin.factor, thin.basis, thin.samples], [1, 'default', 0]);
  assert.equal(ledgerRowWindowKind({ window_kind: null }), 'overnight');
  assert.equal(ledgerRowWindowKind({}), 'overnight');
  assert.equal(ledgerRowWindowKind({ window_kind: 'super_off_peak' }), 'super_off_peak');
});

const INDEX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ANALYTICS = readFileSync(new URL('../src/analytics.ts', import.meta.url), 'utf8');

test('★★★ the learners at the call site: the de-bias in the leg\'s stratum (overnight for every live plan); the load band and the cost-load factor pooled', () => {
  assert.match(INDEX, /const buyDebiasCal = calibratedBuyDebiasFactor\(\n\s+\(\(\) => \{ try \{ return recorder\.readNightLedger\(120\); \} catch \{ return \[\]; \} \}\)\(\),\n\s+\{ windowKind: shadowLeg\?\.spec\.kind \?\? 'overnight' \},\n\s+\);/);
  // The load band reads every row's load error, whatever its window.
  assert.match(INDEX, /try \{ return recorder\.readNightLedger\(120\)\.map\(\(r: any\) => r\.load_err_frac as number \| null\); \}/);
  assert.equal(INDEX.split('window_kind').length - 1 >= 1, true);
  const fn = INDEX.slice(INDEX.indexOf('const loadBandCal = calibratedLoadBandFactor('), INDEX.indexOf('const loadP90Factor = loadBandCal.factor;'));
  assert.doesNotMatch(fn, /window_kind|windowKind|filter/, 'no stratum on the load band');
});

/* ══ plan §4 item 9 — the accounting part ══════════════════════════════════ */

test('★★★ middayChargeHourEpochs: the hours a mid-day charge of ours wrote; never an overnight row; never an unwritten one', () => {
  const a = phx(10, 15, 10);
  const b = phx(10, 15, 15);
  const wrote = { window_kind: 'super_off_peak', window_start_ms: a, window_end_ms: b, actuated: 1 };
  const hours = middayChargeHourEpochs([wrote]);
  assert.deepEqual([...hours].sort(), [10, 11, 12, 13, 14, 15].map((h) => Math.floor(phx(10, 15, h) / H)), 'the window and the hour of its restore');
  assert.equal(middayChargeHourEpochs([{ ...wrote, actuated: 0 }]).size, 0, 'armed and never written');
  assert.equal(middayChargeHourEpochs([{ ...wrote, actuated: null, actuation_applied_at_ms: a }]).size, 6, 'an applied stamp');
  assert.equal(middayChargeHourEpochs([{ ...wrote, actuated: null, force_charge_on_at_ms: a + H }]).size, 6, 'a force-charge stamp');
  assert.equal(middayChargeHourEpochs([{ ...wrote, window_kind: 'overnight' }]).size, 0, 'overnight rows: no sun, nothing dropped');
  assert.equal(middayChargeHourEpochs([{ ...wrote, window_kind: null }]).size, 0);
  const m = new Map([[Math.floor(a / H), 1], [Math.floor(a / H) - 1, 2]]);
  assert.deepEqual([...withoutHourEpochs(m, hours)], [[Math.floor(a / H) - 1, 2]]);
  assert.equal(withoutHourEpochs(m, new Set()), m, 'nothing to drop: the same map');
});

test('★★★ the soiling estimate, the Bayesian posterior and the PV bias hindcast drop those hours (empty until the switch)', () => {
  assert.match(ANALYTICS, /return typeof read === 'function' \? middayChargeHourEpochs\(read\.call\(recorder, CHARGE_HOURS_LEDGER_DAYS\)\) : new Set<number>\(\);/);
  assert.match(ANALYTICS, /const CHARGE_HOURS_LEDGER_DAYS = 62;/);
  assert.match(ANALYTICS, /soiling: weather \? fleetSoilingFromDevices\(homeCorePvMaps\.map\(\(m\) => withoutHourEpochs\(m, chargeHours\)\), wxByHour,/);
  assert.match(ANALYTICS, /pvBySnForBias\.set\(d\.sn, withoutChargeHourPoints\(recorder\.query\(d\.sn, 'pv_total', biasWindowStart, biasTodayStart\), chargeHours\)\);/);
  const bayes = ANALYTICS.slice(ANALYTICS.indexOf('export async function computeBayesianSolarModel('), ANALYTICS.indexOf('// Compare with the OLS solar model'));
  assert.match(bayes, /const chargeHours = middayChargeHoursFromLedger\(recorder\);\n[\s\S]*for \(const \[he, pv\] of entries\) \{\n\s+if \(chargeHours\.has\(he\)\) continue;/);
  // Not the solar model the forecast is built on, nor the taper hours: only the three learners.
  assert.equal(ANALYTICS.split('chargeHours').length - 1, 5);
});

/* ══ the scorer's wiring (index.ts) ════════════════════════════════════════ */

test('★★★ the scorer: a two-leg row\'s spans and trough; every other row exactly as before', () => {
  const fn = INDEX.slice(INDEX.indexOf('function nightSpansForRow('), INDEX.indexOf('const LEDGER_BACKFILL_SWEEP_DAYS'));
  assert.match(fn, /const cheapIds = ledgerCheapPeriodIds\(y\.window_kind\);\n\s+const cycle = cycleLedgerSpans\(\n\s+y,\n\s+\(t\) => rateAt\(tariff, t\)\.isOnPeak,\n\s+\(t\) => cheapIds\.includes\(rateAt\(tariff, t\)\.periodId\),\n\s+\);/);
  assert.match(fn, /scoreSpanEnd: cycle\.scoreSpanEndMs, completeMs: cycle\.completeMs, windowKnown: true, troughSpans: cycle\.troughSpans,/);
  // The overnight branch is the one it always was.
  assert.match(fn, /const spans = ledgerSpansForWindow\(\n\s+we,\n\s+\(t\) => rateAt\(tariff, t\)\.isOnPeak,\n\s+\(t\) => rateAt\(tariff, t\)\.periodId === NIGHT_CHEAP_PERIOD_ID,\n\s+\);/);
  const score = INDEX.slice(INDEX.indexOf('function scoreNightRow('), INDEX.indexOf('The single ~21:30 America/Phoenix evening job'));
  assert.match(score, /const socPts = s\.troughSpans == null \? recorder\.query\(shp2Sn, 'backup_pct', scoreFrom, spanEnd\) : \[\];/);
  assert.match(score, /if \(s\.troughSpans != null\) \{\n\s+const low = minOverSpans\(s\.troughSpans, \(a, b\) => recorder\.query\(shp2Sn, 'backup_pct', a, Math\.min\(nowMs, b\)\), medianFilter3\);/);
  // The shadow's window is measured apart from the outcome write, and only for a shadow row.
  assert.match(score, /if \(shadowActuals != null\) \{\n\s+recorder\.recordNightOutcome\(yDate, \{ shadow_window_pv_kwh: shadowActuals\.pvKwh, shadow_window_load_kwh: shadowActuals\.loadKwh \}\);/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
