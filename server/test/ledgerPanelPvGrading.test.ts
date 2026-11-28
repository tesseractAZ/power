/**
 * ledgerPanelPvGrading.test.ts — ★★★ v1.210.1: the ledger's solar on the panel's own readings, said and graded, with the Cores dark.
 *
 * 1. THE CAPTURE'S LOG LINE. On a row planned on the panel basis (isPanelBasisRow) the PV actual is the panel path's (the per-slot
 *    resolver through the 7-day energy balance), so the Cores' per-Core coverage gate no longer logs its "WITHHELD — worst per-core
 *    PV coverage" line there: the panel path states its own outcome, once (withheld, pending, withheld by the balance; nothing when
 *    written). On a row on the Cores' basis the gate and its lines are the v1.210.0 lines to the letter: scoreNightRow's PV block, as
 *    written in index.ts, runs beside the v1.210.0 block (kept below verbatim) on the same inputs, and every output and every log
 *    call is compared.
 * 2. THE SHADOW'S MEASURED WINDOW. A cost leg the panel-measured band of the row's own evening sized, on a panel row, has its window's
 *    PV measured by the same rule as the live row (the per-slot resolver on the window, held telemetry, the same admission: pending,
 *    withheld, admitted); a leg on the Cores' band, and every case the panel path does not cover, is measured as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import {
  shadowWindowActuals, panelPvActualLogLine, panelPvActualNote, panelRowPvActual, panelPvAdmission, isPanelBasisRow,
  integrateWh, coverageFrac, panelPvVerdictSetAside, forecastSpanResetColumns, heldSides,
  PANEL_PV_PENDING_MARKER, FORECAST_SPAN_MS,
  type PanelAdmission, type PanelPvAdmission, type HeldLedgerVerdict, type LedgerHeldSpan,
} from '../src/nightLedgerScoring.js';
import { shadowCostPanelPvAsOfDay, middayShadowLedgerColumns, panelPvBasisNote, type MiddayShadowRecord, type ShadowLegSummary } from '../src/middayShadow.js';
import { siteDayStartMs, addDaysYmd } from '../src/siteTime.js';
import type { NightLedgerRow } from '../src/recorder.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const SCORE_AT = INDEX.indexOf('function scoreNightRow(');
const SCORE = INDEX.slice(SCORE_AT, INDEX.indexOf('\nfunction ', SCORE_AT + 10));
const H = 3_600_000;
const D = '2026-11-25';
const D1 = addDaysYmd(D, 1);
const D2 = addDaysYmd(D, 2);
const ISSUED = siteDayStartMs(D) + (21 * 60 + 30) * 60_000;
const SPAN = { startMs: ISSUED, endMs: ISSUED + FORECAST_SPAN_MS };
const PANEL = 'PANEL';
const CORES = ['CORE1', 'CORE2', 'CORE3'];
const SOURCES = CORES.map((sn, k) => ({ slot: k + 1, sn, isConnected: true }));
/** 5-minute samples of a constant power over [from, to]. */
const flat = (w: number, from: number, to: number) => {
  const out: Array<{ ts: number; value: number }> = [];
  for (let t = from; t <= to; t += 300_000) out.push({ ts: t, value: w });
  return out;
};
/** A planning report as of an evening after `lastDay`, built at 09:00 the morning after it, admitting `days` on every slot. */
const judged = (lastDay: string, days: string[], o: Partial<Record<1 | 2 | 3, string[]>> = {}): PanelAdmission => ({
  asOfDay: addDaysYmd(lastDay, 1), builtAtMs: siteDayStartMs(addDaysYmd(lastDay, 1)) + 9 * H,
  slotDays: { 1: o[1] ?? days, 2: o[2] ?? days, 3: o[3] ?? days },
});

/* ══ 1. the log line, pure ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

test('★★★ panelPvActualLogLine: the panel path\'s own outcome, one line — pending (info), withheld by the balance or with its reason (warn), nothing when written', () => {
  const pending: PanelPvAdmission = { state: 'pending', lastDay: D1, judgeFromMs: siteDayStartMs(D2) + 9 * H };
  assert.deepEqual(panelPvActualLogLine(D, '1:P,2:P,3:P', null, pending), {
    level: 'info',
    text: `night-charge ledger: actual_pv_kwh for ${D} pending the 7-day energy balance (actual_pv_basis 1:P,2:P,3:P) — ${D1} is judged no earlier than 9:00 the next morning, and the row is re-captured once the night planner has read that judgement`,
  });
  assert.deepEqual(panelPvActualLogLine(D, '1:P,2:P,3:P', null, { state: 'withheld', asOfDay: D2, slot: 2, day: D1 }), {
    level: 'warn',
    text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — slot 2's ${D1} was not passed by the 7-day energy balance as of ${D2}`,
  });
  assert.deepEqual(panelPvActualLogLine(D, '1:P,2:P', 'worst per-slot PV coverage 0.42 < 0.9', null), {
    level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P) — worst per-slot PV coverage 0.42 < 0.9`,
  });
  assert.deepEqual(panelPvActualLogLine(D, '1:P,2:P,3:P', 'held telemetry over the span', null, 'Panel 2.0 h, Core one 1.5 h'), {
    level: 'warn',
    text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — held telemetry over the span (Panel 2.0 h, Core one 1.5 h with no fresh readings)`,
  });
  assert.equal(panelPvActualLogLine(D, null, 'no per-slot sources recorded', null)!.text,
    `night-charge ledger: actual_pv_kwh WITHHELD for ${D} — no per-slot sources recorded`, 'no sources: no basis clause');
  assert.equal(panelPvActualLogLine(D, '1:P,2:P,3:P', null, { state: 'admitted', asOfDay: D2 }), null, 'written: no line');
  assert.equal(panelPvActualLogLine(D, '1:P,2:P,3:P', null, null), null);
  for (const l of [panelPvActualLogLine(D, '1:P', 'x', null), panelPvActualLogLine(D, '1:P', null, pending)]) {
    assert.doesNotMatch(l!.text, /per-core|dark core/, 'never the Cores\' words');
  }
});

test('★★★ panelPvActualLogLine follows the note\'s precedence: a line exactly where the note says pending or withheld, of the same kind', () => {
  const r = { plan_date: D, pv_upper_ratio: 1.0123 };
  const pending: PanelPvAdmission = { state: 'pending', lastDay: D1, judgeFromMs: 0 };
  const withheld: PanelPvAdmission = { state: 'withheld', asOfDay: D2, slot: 3, day: D };
  const admitted: PanelPvAdmission = { state: 'admitted', asOfDay: D2 };
  for (const why of [null, 'held telemetry over the span', 'slot 2 had no source'] as Array<string | null>) {
    for (const adm of [null, pending, withheld, admitted] as Array<PanelPvAdmission | null>) {
      // index.ts passes the note's own arguments: the admission only where no reason withholds it.
      const a = why != null ? null : adm;
      const note = panelPvActualNote(r, '1:P,2:P,3:P', why, a);
      const line = panelPvActualLogLine(D, '1:P,2:P,3:P', why, a);
      const tag: string = `${why} / ${adm?.state}`;
      if (note.startsWith(' PV actual is ')) assert.equal(line, null, tag);
      else if (note.includes(PANEL_PV_PENDING_MARKER)) assert.equal(line?.level, 'info', tag);
      else {
        assert.ok(note.startsWith(' PV actual withheld'), tag);
        assert.equal(line?.level, 'warn', tag);
        assert.match(line!.text, /actual_pv_kwh WITHHELD for /, tag);
      }
    }
  }
});

/* ══ 1. scoreNightRow's PV block, as written, against v1.210.0's ═══════════════════════════════════════════════════════════════ */

// The v1.210.0 block (index.ts scoreNightRow, from the PV actual's declaration to the end of the panel row's block, and the panel
// row's note), verbatim: the golden the new block is held to.
const V1210_PV_BLOCK = [
  "  let actualPvKwh: number | null = null;",
  "  let actualPvCoverage: number | null = null;",
  "  if (homeSns.size) {",
  "    let pvWh = 0;",
  "    let worstCov = 1;",
  "    for (const sn of homeSns) {",
  "      const pts = recorder.query(sn, 'pv_total', fcSpanStart, fcSpanEnd);",
  "      pvWh += integrateWh(pts, true);",
  "      // Per-core, not fleet-averaged: one dark core in three averages to a",
  "      // healthy-looking 0.67 while the total is a third short. The MINIMUM is",
  "      // the only summary that cannot hide a single dark member.",
  "      worstCov = Math.min(worstCov, coverageFrac(pts, fcSpanStart, fcSpanEnd));",
  "    }",
  "    actualPvCoverage = round2(worstCov);",
  "    const pvHeld = heldSide.pv;",
  "    actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE && !pvHeld ? round2(pvWh / 1000) : null;",
  "    if (pvHeld && heldVerdict != null) {",
  "      app.log.warn(`night-charge ledger: actual_pv_kwh WITHHELD for ${yDate} — ${heldVerdict.pv.map((p) => `${deviceNameOf(p.sn)} ${(p.heldMs / 3_600_000).toFixed(1)} h`).join(', ')} of the span had no fresh readings (held telemetry)`);",
  "    } else if (actualPvKwh == null) {",
  "      app.log.warn(`night-charge ledger: actual_pv_kwh WITHHELD — worst per-core PV coverage ${worstCov.toFixed(2)} < ${PV_LEDGER_MIN_CORE_COVERAGE} over the scored span; a fleet sum across a dark core under-counts and this column is durable`);",
  "    }",
  "  }",
  "  // ★★★ v1.204.0 — a row planned on the panel's own per-slot readings ('panel' / 'mixed'): its PV actual is the per-slot resolver over",
  "  // the same span — the panel's reading (src{n}_pv_w) for a slot that took it, the slot's Core's pv_total for one that did not",
  "  // (panelRowPvActual) — each slot at the Cores' coverage minimum, and withheld when the panel or a Core read held telemetry. The",
  "  // sources go to actual_pv_basis; the note (panelPvActualNote) says what it is and that the row is kept apart.",
  "  const panelRow = isPanelBasisRow(y);",
  "  let panelPv: ReturnType<typeof panelRowPvActual> | null = null;",
  "  let panelAdmission: ReturnType<typeof panelPvAdmission> | null = null;",
  "  if (panelRow) {",
  "    const houseSrc = (findShp2(store.get().devices)?.projection?.sources ?? []) as Array<{ slot?: number; sn?: string; isConnected?: boolean }>;",
  "    panelPv = panelRowPvActual({",
  "      slots: y.pv_basis_slots, span: { startMs: fcSpanStart, endMs: fcSpanEnd }, panelSn: shp2Sn,",
  "      coreOfSlot: (slot) => houseSrc.find((x) => x.slot === slot && x.isConnected === true && typeof x.sn === 'string')?.sn ?? null,",
  "      query: (sn, metric, a, b) => recorder.query(sn, metric, a, b),",
  "      minCoverage: PV_LEDGER_MIN_CORE_COVERAGE,",
  "    });",
  "    const held = heldSide.pv || heldSide.load;",
  "    // v1.204.0 (L5) — and only on slot-days the 7-day energy balance admitted, as of an evening after the span, read after the",
  "    // morning its last day's daily total comes in (panelPvAdmission): pending until then (re-captured: repairPendingPanelPv), withheld",
  "    // where a span day was not passed. The PV-independent columns are captured now either way.",
  "    panelAdmission = panelPvAdmission({ basis: panelPv.basis, span: { startMs: fcSpanStart, endMs: fcSpanEnd }, admission: panelAdmissionMem });",
  "    actualPvKwh = held || panelAdmission.state !== 'admitted' ? null : panelPv.kwh;",
  "    actualPvCoverage = panelPv.worstCoverage;",
  "    if (held) panelPv = { ...panelPv, kwh: null, why: 'held telemetry over the span' };",
  "    else if (panelAdmission.state !== 'admitted') panelPv = { ...panelPv, kwh: null };",
  "  }",
].join('\n');
const V1210_NOTE_BLOCK = [
  "  if (panelRow && panelPv != null) {",
  "    const why = panelPv.why != null ? panelPv.why : panelPv.kwh == null && panelAdmission?.state === 'admitted' ? 'withheld' : null;",
  "    scoreNotes += panelPvActualNote(y, panelPv.basis, why, why != null ? null : panelAdmission);",
  "  }",
].join('\n');

/** A part of scoreNightRow as written: from `head` (found once) to the end of the first `tail` after it. */
function part(headText: string, tail: string): string {
  const at = SCORE.indexOf(headText);
  assert.ok(at > 0 && SCORE.indexOf(headText, at + 1) < 0, headText);
  const end = SCORE.indexOf(tail, at);
  assert.ok(end > at, tail);
  return SCORE.slice(at, end + tail.length);
}
const PV_BLOCK = part('  const panelRow = isPanelBasisRow(y);\n', "    else if (panelAdmission.state !== 'admitted') panelPv = { ...panelPv, kwh: null };\n  }\n");
const NOTE_BLOCK = part('  if (panelRow && panelPv != null) {\n', '    if (pvLog != null) app.log[pvLog.level](pvLog.text);\n  }\n');

interface BlockOut { actualPvKwh: number | null; actualPvCoverage: number | null; panelPv: Any; panelAdmission: Any; scoreNotes: string }
const compile = (body: string): ((env: Any) => BlockOut) => new Function(`${transformSync(`function __run(env: any) {
const { y, homeSns, recorder, heldSide, heldVerdict, deviceNameOf, app, yDate, fcSpanStart, fcSpanEnd, shp2Sn, store, findShp2,
  panelAdmissionMem, isPanelBasisRow, panelRowPvActual, panelPvAdmission, panelPvActualNote, panelPvActualLogLine, integrateWh,
  coverageFrac, round2, PV_LEDGER_MIN_CORE_COVERAGE } = env;
let scoreNotes = '';
${body}
return { actualPvKwh, actualPvCoverage, panelPv, panelAdmission, scoreNotes };
}`, { loader: 'ts' }).code}\nreturn __run;`)();
const RUN_NOW = compile(`${PV_BLOCK}${NOTE_BLOCK}`);
const RUN_V1210 = compile(`${V1210_PV_BLOCK}\n${V1210_NOTE_BLOCK}\n`);

interface BlockCase {
  name: string;
  row: Partial<NightLedgerRow>;
  /** Each Core's pv_total (W), absent: dark (no samples). `thin`: the Cores with only a third of the span. */
  coreW?: Partial<Record<string, number>>;
  thin?: string[];
  /** The panel's per-slot reading (W) on every slot, absent: none; `panelThin`: two hours of it. */
  panelW?: number;
  panelThin?: boolean;
  held?: HeldLedgerVerdict | null;
  admission?: PanelAdmission | null;
  homeSns?: string[];
}
function runBlock(run: (env: Any) => BlockOut, c: BlockCase): BlockOut & { logs: Array<{ level: string; text: string }> } {
  const logs: Array<{ level: string; text: string }> = [];
  const query = (sn: string, metric: string, a: number, b: number) => {
    if (sn === PANEL) return /^src\d_pv_w$/.test(metric) && c.panelW != null ? flat(c.panelW, a, c.panelThin ? a + 2 * H : b) : [];
    const w = metric === 'pv_total' ? c.coreW?.[sn] : undefined;
    return w == null ? [] : flat(w, a, c.thin?.includes(sn) ? a + 8 * H : b);
  };
  const heldVerdict = c.held ?? null;
  const out = run({
    y: { plan_date: D, issued_at_ms: ISSUED, pv_upper_ratio: 1.0123, ...c.row }, homeSns: new Set(c.homeSns ?? CORES),
    recorder: { query }, heldSide: heldSides(heldVerdict), heldVerdict, deviceNameOf: (sn: string) => `Device ${sn}`,
    app: { log: { warn: (text: string) => logs.push({ level: 'warn', text }), info: (text: string) => logs.push({ level: 'info', text }) } },
    yDate: D, fcSpanStart: SPAN.startMs, fcSpanEnd: SPAN.endMs, shp2Sn: PANEL,
    store: { get: () => ({ devices: {} }) }, findShp2: () => ({ projection: { sources: SOURCES } }),
    panelAdmissionMem: c.admission ?? null,
    isPanelBasisRow, panelRowPvActual, panelPvAdmission, panelPvActualNote, panelPvActualLogLine, integrateWh, coverageFrac,
    round2: (n: number) => Math.round(n * 100) / 100, PV_LEDGER_MIN_CORE_COVERAGE: 0.9,
  });
  return { ...out, logs };
}
const ALL_ON = { CORE1: 1000, CORE2: 1000, CORE3: 1000 };
const STALE = `night-charge ledger: actual_pv_kwh WITHHELD — worst per-core PV coverage 0.00 < 0.9 over the scored span; a fleet sum across a dark core under-counts and this column is durable`;

test('★★★ SOURCE PIN: the stubs are the scorer\'s own: the coverage minimum, round2, the slot lookup', () => {
  assert.match(INDEX, /\nexport const PV_LEDGER_MIN_CORE_COVERAGE = 0\.9;\n/);
  assert.match(INDEX, /\nfunction round2\(n: number\): number \{ return Math\.round\(n \* 100\) \/ 100; \}\n/);
  assert.ok(PV_BLOCK.includes('const houseSrc = (findShp2(store.get().devices)?.projection?.sources ?? [])'));
  // The block reads nothing the stubs do not give: every free name it uses is in the destructuring above.
  assert.ok(!/\bnowMs\b|\bcols\b/.test(PV_BLOCK + NOTE_BLOCK));
});

test('★★★ a row on the Cores\' basis is scored and logged exactly as v1.210.0: every figure, the note and every log line, held and dark Cores included', () => {
  const cores: BlockCase[] = [
    { name: 'all three Cores reporting', row: { pv_basis: 'cores' }, coreW: ALL_ON },
    { name: 'one Core dark (the August case)', row: { pv_basis: 'cores' }, coreW: { CORE1: 1000, CORE2: 1000 } },
    { name: 'one Core thin', row: { pv_basis: 'cores' }, coreW: ALL_ON, thin: ['CORE2'] },
    { name: 'every Core dark', row: { pv_basis: 'cores' } },
    { name: 'a row from before the panel basis (pv_basis null)', row: { pv_basis: null } },
    { name: 'a Core held', row: { pv_basis: 'cores' }, coreW: ALL_ON, held: { pv: [{ sn: 'CORE2', heldMs: 2 * H }], load: [] } },
    { name: 'the panel held (load side only)', row: { pv_basis: 'cores' }, coreW: ALL_ON, held: { pv: [], load: [{ sn: PANEL, heldMs: 3 * H }] } },
    { name: 'no home Cores', row: { pv_basis: 'cores' }, homeSns: [] },
    { name: 'the panel reading present on a Cores row', row: { pv_basis: 'cores', pv_basis_slots: '1:P,2:P,3:P' }, panelW: 900, admission: judged(D1, [D, D1]) },
  ];
  for (const c of cores) {
    assert.equal(isPanelBasisRow({ pv_basis: c.row.pv_basis ?? null }), false, c.name);
    const now = runBlock(RUN_NOW, c);
    const was = runBlock(RUN_V1210, c);
    assert.deepEqual(now, was, c.name);
  }
  // The lines themselves, as v1.210.0 wrote them.
  assert.deepEqual(runBlock(RUN_NOW, cores[3]).logs, [{ level: 'warn', text: STALE }]);
  assert.deepEqual(runBlock(RUN_NOW, cores[1]).logs.map((l) => l.text),
    ['night-charge ledger: actual_pv_kwh WITHHELD — worst per-core PV coverage 0.00 < 0.9 over the scored span; a fleet sum across a dark core under-counts and this column is durable']);
  assert.deepEqual(runBlock(RUN_NOW, cores[5]).logs.map((l) => l.text),
    [`night-charge ledger: actual_pv_kwh WITHHELD for ${D} — Device CORE2 2.0 h of the span had no fresh readings (held telemetry)`]);
  assert.equal(runBlock(RUN_NOW, cores[0]).actualPvKwh, 72, 'three Cores at 1 kW over 24 h');
  assert.equal(runBlock(RUN_NOW, cores[1]).actualPvKwh, null, 'the gate still withholds a sum across a dark Core');
  assert.deepEqual(runBlock(RUN_NOW, cores[0]).logs, []);
});

test('★★★ a panel-basis row no longer logs the Cores-only warning: its figure and note are v1.210.0\'s, and its one log line is the panel path\'s own outcome', () => {
  const P = { pv_basis: 'panel', pv_basis_slots: '1:P,2:P,3:P' } as Partial<NightLedgerRow>;
  const days = [D, D1];
  const panel: Array<BlockCase & { line: { level: string; text: string } | null }> = [
    // The live 11-18..11-25 shape: Cores dark, the panel's readings admitted. v1.210.0 logged the stale warning here, daily.
    { name: 'Cores dark, admitted', row: P, panelW: 1000, admission: judged(D1, days), line: null },
    { name: 'Cores dark, pending (first capture)', row: P, panelW: 1000, admission: null,
      line: { level: 'info', text: `night-charge ledger: actual_pv_kwh for ${D} pending the 7-day energy balance (actual_pv_basis 1:P,2:P,3:P) — ${D1} is judged no earlier than 9:00 the next morning, and the row is re-captured once the night planner has read that judgement` } },
    { name: 'Cores dark, a report as of the plan\'s own next evening (still pending)', row: P, panelW: 1000, admission: { ...judged(D1, days), asOfDay: D1 },
      line: { level: 'info', text: `night-charge ledger: actual_pv_kwh for ${D} pending the 7-day energy balance (actual_pv_basis 1:P,2:P,3:P) — ${D1} is judged no earlier than 9:00 the next morning, and the row is re-captured once the night planner has read that judgement` } },
    { name: 'Cores dark, withheld by the balance', row: P, panelW: 1000, admission: judged(D1, days, { 2: [D] }),
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — slot 2's ${D1} was not passed by the 7-day energy balance as of ${D2}` } },
    { name: 'Cores dark, the panel\'s reading thin', row: P, panelW: 1000, panelThin: true, admission: judged(D1, days),
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — worst per-slot PV coverage 0.09 < 0.9` } },
    // A reason withholds it even while the balance has not judged the span: the note says withheld (no re-capture), and so does the log.
    { name: 'Cores dark, the panel\'s reading thin, pending', row: P, panelW: 1000, panelThin: true, admission: null,
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — worst per-slot PV coverage 0.09 < 0.9` } },
    { name: 'Cores dark, the panel held', row: P, panelW: 1000, admission: judged(D1, days), held: { pv: [], load: [{ sn: PANEL, heldMs: 2 * H }] },
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — held telemetry over the span (Device PANEL 2.0 h with no fresh readings)` } },
    { name: 'a Core held', row: P, panelW: 1000, coreW: ALL_ON, admission: judged(D1, days), held: { pv: [{ sn: 'CORE1', heldMs: 1.5 * H }], load: [] },
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:P) — held telemetry over the span (Device CORE1 1.5 h with no fresh readings)` } },
    { name: 'mixed, its Core slot dark', row: { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' }, panelW: 1000, admission: judged(D1, days),
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} (actual_pv_basis 1:P,2:P,3:C) — worst per-slot PV coverage 0.00 < 0.9` } },
    { name: 'mixed, its Core slot reporting', row: { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' }, panelW: 1000, coreW: { CORE3: 500 }, admission: judged(D1, days), line: null },
    { name: 'no slots recorded', row: { pv_basis: 'panel', pv_basis_slots: null }, panelW: 1000, admission: judged(D1, days),
      line: { level: 'warn', text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} — no per-slot sources recorded` } },
    { name: 'the Cores reporting, admitted', row: P, panelW: 1000, coreW: ALL_ON, admission: judged(D1, days), line: null },
    { name: 'the Cores reporting, pending', row: P, panelW: 1000, coreW: ALL_ON, admission: null,
      line: { level: 'info', text: `night-charge ledger: actual_pv_kwh for ${D} pending the 7-day energy balance (actual_pv_basis 1:P,2:P,3:P) — ${D1} is judged no earlier than 9:00 the next morning, and the row is re-captured once the night planner has read that judgement` } },
    { name: 'captured before as a panel row (actual_pv_basis)', row: { pv_basis: null, pv_basis_slots: '1:P,2:P,3:P', actual_pv_basis: '1:P,2:P,3:P' }, panelW: 1000, admission: judged(D1, days), line: null },
  ];
  for (const c of panel) {
    const now = runBlock(RUN_NOW, c);
    const was = runBlock(RUN_V1210, c);
    const { logs: nowLogs, ...nowCols } = now;
    const { logs: _wasLogs, ...wasCols } = was;
    assert.deepEqual(nowCols, wasCols, `${c.name}: the figure, coverage, sources, admission and note are v1.210.0's`);
    assert.deepEqual(nowLogs, c.line == null ? [] : [c.line], c.name);
    assert.ok(nowLogs.every((l) => !/per-core PV coverage|dark core/.test(l.text)), `${c.name}: never the Cores-only warning`);
  }
  // v1.210.0 logged the stale warning on the live shape while it wrote the panel's figure: the defect this release removes.
  const live = runBlock(RUN_V1210, panel[0]);
  assert.equal(live.actualPvKwh, 72);
  assert.deepEqual(live.logs, [{ level: 'warn', text: STALE }]);
  assert.equal(runBlock(RUN_NOW, panel[0]).actualPvKwh, 72);
});

/* ══ 2. the cost leg's band, read back from the row ════════════════════════════════════════════════════════════════════════════ */

const leg = (role: 'backup' | 'cost', disposition: string, panelPvAsOfDay?: string): ShadowLegSummary => ({
  role, kind: role === 'cost' ? 'super_off_peak' : 'overnight', windowStartMs: 0, windowEndMs: 1, basisComplete: true, chargeTonight: true,
  reservePct: 50, reserveBasis: null, levelPct: 60, costCeilingSocPct: null, buyKwh: 5, expectedBuyKwh: 4, expectedStartSocPct: 30,
  cushionTroughSocPct: null, cushionLineSocPct: null, wouldArm: true, disposition, windowPvP50Kwh: 20, windowLoadP50Kwh: 10,
  ...(panelPvAsOfDay != null ? { panelPvAsOfDay } : {}),
} as ShadowLegSummary);
const record = (o: Partial<MiddayShadowRecord>): MiddayShadowRecord => ({
  version: 1, day: D, computedAtMs: 0, why: 'midday', mode: 'supervised', backup: null, cost: null, refresh: null, note: null, ...o,
} as MiddayShadowRecord);
const dispOf = (o: Partial<MiddayShadowRecord>): string | null | undefined => middayShadowLedgerColumns(record(o)).shadow_arm_disposition;
const REFUSED = 'not armed — the plan basis is incomplete (only 0 scored calibration day(s), need 4; the panel\'s own solar readings are not used: the panel-measured band has no fitted solar response for the daylight hour from 11:00 AM)';

test('★★★ shadowCostPanelPvAsOfDay reads back what middayShadowLedgerColumns wrote: the COST leg\'s band only, never the backup\'s or option B\'s', () => {
  // The cost leg on the panel band (with and without the backup and option B on it): its evening.
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ backup: leg('backup', 'would arm', D), cost: leg('cost', 'would arm', D), backupB: leg('backup', 'x', D) })), D);
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ backup: leg('backup', 'would arm'), cost: leg('cost', 'would arm', D) })), D);
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ cost: leg('cost', 'would arm', D) })), D, 'no backup leg');
  // A cost disposition with its own semicolons and parentheses.
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ backup: leg('backup', REFUSED), cost: leg('cost', 'held on the re-entry line (31.3%; level 60%)', D1) })), D1);
  // The cost leg on the Cores' band while the backup and option B took the panel band (the daylight rule refuses only the cost
  // leg's hours): not the cost leg's.
  const split = dispOf({ backup: leg('backup', 'would arm', D), cost: leg('cost', REFUSED), backupB: leg('backup', 'x', D) });
  assert.ok(split!.includes(panelPvBasisNote(D)), split!);
  assert.equal(shadowCostPanelPvAsOfDay(split), null);
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ backup: leg('backup', 'would arm', D), cost: leg('cost', 'would arm') })), null);
  // Nothing to read: no cost leg, a note-only row, a row from before v1.210.0, no value.
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ backup: leg('backup', 'would arm', D) })), null);
  assert.equal(shadowCostPanelPvAsOfDay(dispOf({ why: 'friday' as Any, note: 'not a mid-day cycle: Friday' })), null);
  assert.equal(shadowCostPanelPvAsOfDay(`backup: would arm; cost: would arm`), null);
  assert.equal(shadowCostPanelPvAsOfDay(null), null);
  assert.equal(shadowCostPanelPvAsOfDay(undefined), null);
  assert.equal(shadowCostPanelPvAsOfDay(`cost: would arm (on the panel-measured planning band as of yesterday)`), null, 'a malformed evening is no band');
});

/* ══ 2. the shadow's measured window ═══════════════════════════════════════════════════════════════════════════════════════════ */

const WA = siteDayStartMs(D1) + 10 * H;
const WB = siteDayStartMs(D1) + 15 * H;
const AFTER = WB + 7 * H;
const PANEL_ROW = { shadow_cost_window_start_ms: WA, shadow_cost_window_end_ms: WB, plan_date: D, pv_basis: 'panel', pv_basis_slots: '1:P,2:P,3:P' } as Partial<NightLedgerRow>;
interface WinCase { coreW?: Partial<Record<string, number>>; panelW?: number; panelThin?: boolean; loadW?: number; held?: LedgerHeldSpan[] }
const winQuery = (c: WinCase) => ({
  queryPv: (sn: string, a: number, b: number) => (c.coreW?.[sn] == null ? [] : flat(c.coreW[sn]!, a, b)),
  queryLoad: (a: number, b: number) => flat(c.loadW ?? 3000, a, b),
  query: (sn: string, metric: string, a: number, b: number) => (sn === PANEL && /^src\d_pv_w$/.test(metric) && c.panelW != null
    ? flat(c.panelW, a, c.panelThin ? a + H : b)
    : metric === 'pv_total' && c.coreW?.[sn] != null ? flat(c.coreW[sn]!, a, b) : []),
});
/** The capture's call: today's arguments, and the panel path's when `band` is given. */
const measure = (row: Partial<NightLedgerRow>, c: WinCase, o: { band?: string | null; admission?: PanelAdmission | null; pvSetAside?: string | null; panel?: boolean } = {}) => {
  const q = winQuery(c);
  return shadowWindowActuals({
    row, nowMs: AFTER, homeSns: CORES, queryPv: q.queryPv, queryLoad: q.queryLoad,
    held: { spans: () => c.held ?? [], panelSn: PANEL }, pvSetAside: o.pvSetAside === undefined ? panelPvVerdictSetAside(String(row.pv_basis)) : o.pvSetAside,
    ...(o.panel === false ? {} : {
      panel: {
        bandAsOfDay: o.band === undefined ? D : o.band, panelSn: PANEL, coreOfSlot: (slot: number) => SOURCES.find((s) => s.slot === slot)?.sn ?? null,
        query: q.query, admission: o.admission === undefined ? judged(D1, [D1]) : o.admission,
      },
    }),
  });
};
const today = (row: Partial<NightLedgerRow>, c: WinCase, pvSetAside?: string | null) => measure(row, c, { panel: false, pvSetAside });

test('★★★ the shadow\'s window PV on the panel band is the panel\'s own per-slot reading, admitted — with the Cores dark', () => {
  // 3 slots × 2 kW × 5 h; the load (3 kW × 5 h) as before.
  assert.deepEqual(measure(PANEL_ROW, { panelW: 2000 }), { pvKwh: 30, loadKwh: 15 });
  // v1.210.0 on the same row: NULL (the Cores dark, and the row's set-aside).
  assert.deepEqual(today(PANEL_ROW, { panelW: 2000 }), { pvKwh: null, loadKwh: 15 });
  // The row's set-aside (the panel's own: no independent meter) does not null it, nor does no set-aside.
  assert.equal(panelPvVerdictSetAside('panel') != null, true);
  assert.deepEqual(measure(PANEL_ROW, { panelW: 2000 }, { pvSetAside: null }), { pvKwh: 30, loadKwh: 15 });
  // A mixed band: the panel's slots and the Core's own meter for its C slot (no admission needed for it).
  const mixed = { ...PANEL_ROW, pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' } as Partial<NightLedgerRow>;
  assert.deepEqual(measure(mixed, { panelW: 2000, coreW: { CORE3: 1000 } }, { admission: judged(D1, [D1], { 3: [] }) }), { pvKwh: 25, loadKwh: 15 });
  assert.deepEqual(measure(mixed, { panelW: 2000 }), { pvKwh: null, loadKwh: 15 }, 'its Core dark: withheld, never a partial sum');
  // A row captured before as a panel row (actual_pv_basis) is a panel row.
  assert.deepEqual(measure({ ...PANEL_ROW, pv_basis: null, actual_pv_basis: '1:P,2:P,3:P' }, { panelW: 2000 }), { pvKwh: 30, loadKwh: 15 });
});

test('★★★ pending until the energy balance judges the window\'s day, withheld where it did not pass, NULL on held telemetry or thin readings', () => {
  const c = { panelW: 2000 };
  // Pending: no report read; one as of the plan's own next evening (the window's day is not judged); one built before 09:00.
  assert.deepEqual(measure(PANEL_ROW, c, { admission: null }), { pvKwh: null, loadKwh: 15 });
  assert.deepEqual(measure(PANEL_ROW, c, { admission: { ...judged(D1, [D1]), asOfDay: D1 } }), { pvKwh: null, loadKwh: 15 });
  assert.deepEqual(measure(PANEL_ROW, c, { admission: { ...judged(D1, [D1]), builtAtMs: siteDayStartMs(D2) + 9 * H - 1 } }), { pvKwh: null, loadKwh: 15 });
  assert.deepEqual(measure(PANEL_ROW, c, { admission: { ...judged(D1, [D1]), builtAtMs: siteDayStartMs(D2) + 9 * H } }), { pvKwh: 30, loadKwh: 15 });
  // Withheld: a slot whose window day the balance did not pass. The plan's own evening is not the window's day.
  assert.deepEqual(measure(PANEL_ROW, c, { admission: judged(D1, [D1], { 2: [D] }) }), { pvKwh: null, loadKwh: 15 });
  assert.deepEqual(measure(PANEL_ROW, c, { admission: judged(D1, [D1], { 1: [D1], 2: [D1], 3: [D1] }) }), { pvKwh: 30, loadKwh: 15 });
  // Held over the window, either side (the live panel row's rule): the panel held leaves both figures empty, a Core held the PV.
  assert.deepEqual(measure(PANEL_ROW, { ...c, held: [{ sn: PANEL, startMs: WA, endMs: WA + 2 * H }] }), { pvKwh: null, loadKwh: null });
  assert.deepEqual(measure(PANEL_ROW, { ...c, held: [{ sn: 'CORE2', startMs: WA, endMs: WA + 2 * H }] }), { pvKwh: null, loadKwh: 15 });
  assert.deepEqual(measure(PANEL_ROW, { ...c, held: [{ sn: PANEL, startMs: WA, endMs: WA + 30 * 60_000 }] }), { pvKwh: 30, loadKwh: 15 }, 'under an hour: not held');
  // Thin panel readings (an hour of the five), or a slot with no source: withheld, never a partial sum.
  assert.deepEqual(measure(PANEL_ROW, { panelW: 2000, panelThin: true }), { pvKwh: null, loadKwh: 15 });
  assert.deepEqual(measure({ ...PANEL_ROW, pv_basis_slots: '1:P,2:N' }, c), { pvKwh: null, loadKwh: 15 });
  // The window not closed yet: nothing measured, as before.
  assert.equal(shadowWindowActuals({ row: PANEL_ROW, nowMs: WB - 1, homeSns: CORES, queryPv: () => [], queryLoad: () => [],
    panel: { bandAsOfDay: D, panelSn: PANEL, coreOfSlot: () => null, query: () => flat(2000, WA, WB), admission: judged(D1, [D1]) } }), null);
});

test('★★★ the shadow is pending exactly when the live row is (the window\'s day is the span\'s last), and the live row\'s re-capture clears its figure for the newer judgement', () => {
  const reports: Array<PanelAdmission | null> = [
    null, { ...judged(D1, [D, D1]), asOfDay: D1 }, { ...judged(D1, [D, D1]), builtAtMs: siteDayStartMs(D2) + 8 * H }, judged(D1, [D, D1]),
    judged(D1, [D1]), judged(addDaysYmd(D1, 1), [D, D1]),
  ];
  for (const a of reports) {
    const live = panelPvAdmission({ basis: '1:P,2:P,3:P', span: SPAN, admission: a }).state;
    const win = panelPvAdmission({ basis: '1:P,2:P,3:P', span: { startMs: WA, endMs: WB }, admission: a }).state;
    assert.equal(win === 'pending', live === 'pending', JSON.stringify(a));
  }
  const reset = forecastSpanResetColumns(0);
  assert.equal(reset.shadow_window_pv_kwh, null);
  assert.ok('shadow_window_pv_kwh' in reset);
});

test('★★★ unknown equals today: a Cores-band leg, another evening\'s band, a row not on the panel basis, no slots — each measured exactly as v1.210.0', () => {
  const cases: Array<{ name: string; row: Partial<NightLedgerRow>; c: WinCase; band: string | null }> = [
    { name: 'the cost leg on the Cores\' band, the Cores dark', row: PANEL_ROW, c: { panelW: 2000 }, band: null },
    { name: 'the cost leg on the Cores\' band, the Cores reporting', row: PANEL_ROW, c: { panelW: 2000, coreW: { CORE1: 2000, CORE2: 2000, CORE3: 2000 } }, band: null },
    { name: 'a band of another evening', row: PANEL_ROW, c: { panelW: 2000 }, band: D1 },
    { name: 'a row on the Cores\' basis (the Cores reporting)', row: { ...PANEL_ROW, pv_basis: 'cores' }, c: { panelW: 2000, coreW: { CORE1: 2000, CORE2: 2000, CORE3: 2000 } }, band: D },
    { name: 'a row on the Cores\' basis (the Cores dark)', row: { ...PANEL_ROW, pv_basis: 'cores' }, c: { panelW: 2000 }, band: D },
    { name: 'a row before the panel basis', row: { ...PANEL_ROW, pv_basis: null, pv_basis_slots: null }, c: { coreW: { CORE1: 1000, CORE2: 1000, CORE3: 1000 } }, band: D },
    { name: 'a panel row with no slots recorded', row: { ...PANEL_ROW, pv_basis_slots: null }, c: { panelW: 2000, coreW: { CORE1: 2000, CORE2: 2000, CORE3: 2000 } }, band: D },
    { name: 'a panel row with unreadable slots', row: { ...PANEL_ROW, pv_basis_slots: '1:X' }, c: { panelW: 2000, coreW: { CORE1: 2000, CORE2: 2000, CORE3: 2000 } }, band: D },
    { name: 'a panel row with unreadable slots, the Cores dark', row: { ...PANEL_ROW, pv_basis_slots: '1:P,x' }, c: { panelW: 2000 }, band: D },
    { name: 'no shadow window', row: { ...PANEL_ROW, shadow_cost_window_start_ms: null, shadow_cost_window_end_ms: null }, c: { panelW: 2000 }, band: D },
  ];
  for (const k of cases) {
    for (const aside of [undefined, null]) {
      const sa = aside === undefined ? panelPvVerdictSetAside(String(k.row.pv_basis)) : null;
      assert.deepEqual(measure(k.row, k.c, { band: k.band, pvSetAside: sa }), today(k.row, k.c, sa), `${k.name} (set-aside ${sa != null})`);
    }
  }
  // Where the Cores report and no set-aside applies, today's figure is the Cores' meter, and the panel path never replaces it.
  assert.deepEqual(measure({ ...PANEL_ROW, pv_basis_slots: '1:X' }, { panelW: 9000, coreW: { CORE1: 2000, CORE2: 2000, CORE3: 2000 } }, { pvSetAside: null }),
    { pvKwh: 30, loadKwh: 15 });
  // The Cores' meter where the leg was sized on the Cores' band: on a Cores row, the Cores' figure.
  assert.deepEqual(measure({ ...PANEL_ROW, pv_basis: 'cores' }, { panelW: 9000, coreW: { CORE1: 2000, CORE2: 2000, CORE3: 2000 } }, { band: null, pvSetAside: null }),
    { pvKwh: 30, loadKwh: 15 });
});

/* ══ 2. index.ts: the capture's call, as written ═══════════════════════════════════════════════════════════════════════════════ */

test('★★★ the capture passes the panel path the row\'s own band, the house panel, the live block\'s slot lookup, the recorder and the newest admission', () => {
  const at = SCORE.indexOf('  const shadowActuals = shadowWindowActuals({');
  const call = SCORE.slice(at, SCORE.indexOf('\n  });\n', at) + '\n  });\n'.length);
  assert.ok(call.includes('    pvSetAside: cols.pvSetAside,\n'), 'the set-aside still passed: today\'s rule off the panel path');
  const run = new Function(`${transformSync(`function __run(env: any) {
const { y, nowMs, homeSns, recorder, shp2Sn, cols, findShp2, store, panelAdmissionMem, shadowWindowActuals, shadowCostPanelPvAsOfDay } = env;
${call}
return shadowActuals;
}`, { loader: 'ts' }).code}\nreturn __run;`)() as (env: Any) => { pvKwh: number | null; loadKwh: number | null } | null;
  const recorder = {
    query: (sn: string, metric: string, a: number, b: number) => (sn === PANEL
      ? (metric === 'panel_load' ? flat(3000, a, b) : /^src\d_pv_w$/.test(metric) ? flat(2000, a, b) : [])
      : []),
    heldSpans: () => [],
  };
  const disposition = middayShadowLedgerColumns(record({ backup: leg('backup', 'would arm', D), cost: leg('cost', 'would arm', D) })).shadow_arm_disposition;
  const env = (o: Partial<{ y: Any; admission: PanelAdmission | null }>) => ({
    y: { ...PANEL_ROW, shadow_arm_disposition: disposition, ...o.y }, nowMs: AFTER, homeSns: new Set(CORES), recorder, shp2Sn: PANEL,
    cols: { pvSetAside: panelPvVerdictSetAside('panel') }, findShp2: () => ({ projection: { sources: SOURCES } }), store: { get: () => ({ devices: {} }) },
    panelAdmissionMem: o.admission === undefined ? judged(D1, [D1]) : o.admission, shadowWindowActuals, shadowCostPanelPvAsOfDay,
  });
  assert.deepEqual(run(env({})), { pvKwh: 30, loadKwh: 15 });
  assert.deepEqual(run(env({ admission: null })), { pvKwh: null, loadKwh: 15 }, 'pending');
  // The mixed band's C slot resolves through the house panel's connected sources, as the live block's lookup does.
  const mixedRec = { ...recorder, query: (sn: string, metric: string, a: number, b: number) => (sn === 'CORE3' && metric === 'pv_total' ? flat(1000, a, b) : recorder.query(sn, metric, a, b)) };
  assert.deepEqual(run({ ...env({ y: { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' }, admission: judged(D1, [D1], { 3: [] }) }), recorder: mixedRec }), { pvKwh: 25, loadKwh: 15 });
  assert.deepEqual(run({ ...env({ y: { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' } }), findShp2: () => ({ projection: { sources: SOURCES.map((s) => ({ ...s, isConnected: s.slot !== 3 })) } }), recorder: mixedRec }),
    { pvKwh: null, loadKwh: 15 }, 'its Core not connected: withheld');
  // The cost leg on the Cores' band: today's (the Cores dark under the row's set-aside).
  const cores = middayShadowLedgerColumns(record({ backup: leg('backup', 'would arm', D), cost: leg('cost', 'would arm') })).shadow_arm_disposition;
  assert.deepEqual(run(env({ y: { shadow_arm_disposition: cores } })), { pvKwh: null, loadKwh: 15 });
});
