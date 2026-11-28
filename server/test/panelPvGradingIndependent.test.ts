/**
 * panelPvGradingIndependent.test.ts — an independent check of the night-charge ledger's solar on a row planned on the panel's own
 * readings, with the Cores dark.
 *
 * The whole scorer (index.ts scoreNightRow, as the file writes it) is compiled and run here on stub telemetry, with every other name
 * it reads resolved from the modules index.ts itself imports it from. Only the recorder, the device store and the log are stubs.
 *
 * What is held:
 *  - A row on the Cores' basis: its figure and both of the Cores' warnings, to the letter (the per-Core coverage gate is a safety
 *    rule: one Core silent for days makes the fleet sum a fraction of true production).
 *  - A row on the panel basis: the same figure as the panel path gives, and never the Cores-only warning; the panel path's own
 *    outcome is said once where it withholds the figure or leaves it pending, and nothing is said where it is written.
 *  - The mid-day shadow's measured window solar: the panel's per-slot readings where the cost leg was sized on the panel band of the
 *    row's own evening, only once the 7-day energy balance admitted the window's day, NULL on held telemetry and NULL rather than a
 *    partial sum; the Cores' meter where it was sized on the Cores' band; and today's output wherever the panel path cannot produce a
 *    figure (no slot list, another evening's band, a row not on the panel basis).
 *  - The shadow's own way out of pending: on a panel row whose own PV actual was settled at its capture (withheld for readings thin
 *    or held over the night) while the window's day was unjudged, no re-capture follows, so the backfill sweep measures the window
 *    alone once the balance has judged that day (index.ts remeasurePendingShadowPv, compiled here as the file writes it): the figure a
 *    re-capture would give, written to the shadow's column only; NULL and nothing written wherever the capture's rule gives NULL; and
 *    nothing read for a row the sweep does not own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { siteTimeZone, zonedWallTimeMs, addDaysYmd } from '../src/siteTime.js';
import {
  shadowWindowActuals, panelPvRecaptureDue, panelPvRecaptureColumns, shadowPanelPvRemeasureDue, forecastSpanRecaptureHorizonMs,
  type PanelAdmission,
} from '../src/nightLedgerScoring.js';
import { middayShadowLedgerColumns, shadowCostPanelPvAsOfDay, type MiddayShadowRecord, type ShadowLegSummary } from '../src/middayShadow.js';
import type { NightLedgerRow } from '../src/recorder.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ─── the scorer, as index.ts writes it ────────────────────────────────────────────────────────── */

const srcUrl = (rel: string): URL => new URL(`../src/${rel}`, import.meta.url);
const INDEX = readFileSync(srcUrl('index.ts'), 'utf8');

/** A top-level function of index.ts, from its head to its closing brace at column zero. */
function topLevelFunction(head: string): string {
  const at = INDEX.indexOf(`\n${head}`);
  assert.ok(at >= 0, `index.ts has ${head}`);
  assert.equal(INDEX.indexOf(`\n${head}`, at + 1), -1, `${head} is unique in index.ts`);
  const end = INDEX.indexOf('\n}\n', at);
  assert.ok(end > at);
  return INDEX.slice(at + 1, end + 2);
}

/** One-line local helper of index.ts (round2, round1). */
function oneLineFunction(name: string): string {
  const m = new RegExp(`^function ${name}\\(.*\\}$`, 'm').exec(INDEX);
  assert.ok(m != null, `index.ts has its own ${name}`);
  return m[0];
}

/** index.ts's named value imports: local name → { module, exported name }. */
function indexImports(): Map<string, { mod: string; name: string }> {
  const out = new Map<string, { mod: string; name: string }>();
  for (const m of INDEX.matchAll(/^import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+'([^']+)';/gm)) {
    if (m[1] != null) continue;
    for (const raw of m[2].replace(/\/\/[^\n]*/g, '').split(',')) {
      const part = raw.trim();
      if (part === '' || part.startsWith('type ')) continue;
      const mm = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(part);
      assert.ok(mm != null, `an import part index.ts writes: ${part}`);
      out.set(mm[2] ?? mm[1], { mod: m[3], name: mm[1] });
    }
  }
  return out;
}

const SCORER = topLevelFunction('function scoreNightRow(');
const SCORER_WORDS = new Set(SCORER.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
const IMPORTS = indexImports();
/** Every imported name the scorer reads, with the module index.ts takes it from. */
const SCORER_IMPORTS = [...IMPORTS].filter(([local]) => SCORER_WORDS.has(local));

const resolved: Record<string, unknown> = {};
for (const [local, { mod, name }] of SCORER_IMPORTS) {
  assert.ok(mod.startsWith('./') && mod.endsWith('.js'), `a module of the add-on: ${mod}`);
  const ns: Record<string, unknown> = await import(srcUrl(`${mod.slice(2, -3)}.ts`).href);
  assert.ok(name in ns, `${mod} exports ${name}`);
  resolved[local] = ns[name];
}

const PV_LEDGER_MIN_CORE_COVERAGE = Number(/^export const PV_LEDGER_MIN_CORE_COVERAGE = ([\d.]+);$/m.exec(INDEX)?.[1]);

type Sample = { ts: number; value: number };
type LogCall = { level: string; text: string };
type HeldSpan = { sn: string; startMs: number; endMs: number };
interface World {
  devices: Record<string, unknown>;
  /** `${sn}|${metric}` → the watts at an instant, or null for no sample there. */
  series: Map<string, (ts: number) => number | null>;
  held: HeldSpan[];
  admission: PanelAdmission | null;
}
interface Run { logs: LogCall[]; writes: Array<{ day: string; cols: Record<string, unknown> }>; row: Record<string, unknown>; recorderCalls: Set<string> }

const FIVE_MIN = 5 * 60_000;
let world: World | null = null;
let current: Run | null = null;

const recorder = new Proxy({}, {
  get(_t, prop: string) {
    current!.recorderCalls.add(prop);
    if (prop === 'query') {
      return (sn: string, metric: string, a: number, b: number): Sample[] => {
        const f = world!.series.get(`${sn}|${metric}`);
        if (f == null) return [];
        const out: Sample[] = [];
        for (let ts = a; ts < b; ts += FIVE_MIN) { const v = f(ts); if (v != null) out.push({ ts, value: v }); }
        return out;
      };
    }
    if (prop === 'heldSpans') {
      return (a: number, b: number): HeldSpan[] => world!.held
        .filter((h) => h.endMs > a && h.startMs < b).map((h) => ({ ...h, startMs: Math.max(h.startMs, a), endMs: Math.min(h.endMs, b) }));
    }
    if (prop === 'recordNightOutcome') {
      return (day: string, cols: Record<string, unknown>): void => {
        current!.writes.push({ day, cols });
        Object.assign(current!.row, cols);
      };
    }
    return undefined;
  },
});
const logger = (level: string) => (text: string): void => { current!.logs.push({ level, text }); };
const app = { log: { warn: logger('warn'), info: logger('info'), error: logger('error'), debug: logger('debug'), trace: logger('trace'), fatal: logger('fatal') } };
const store = { get: () => ({ devices: world!.devices }) };

const scope: Record<string, unknown> = {
  ...resolved, recorder, app, store, PV_LEDGER_MIN_CORE_COVERAGE,
  homeChgMaxSocPcts: (): Array<number | null> => [],
};
Object.defineProperty(scope, 'panelAdmissionMem', { get: () => world!.admission, enumerable: true });
const scopeProxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t });
const compiled = transformSync(`${oneLineFunction('round2')}\n${oneLineFunction('round1')}\n${SCORER}`, { loader: 'ts' }).code;
type ScoreNightRow = (y: NightLedgerRow, s: unknown, shp2Sn: string, nowMs: number, supersededBy?: string | null) => void;
// eslint-disable-next-line no-new-func
const scoreNightRow = new Function('__scope', `with (__scope) { return (function () {\n${compiled}\nreturn scoreNightRow;\n})(); }`)(scopeProxy) as ScoreNightRow;

/* ─── the site, the night, the stubs ───────────────────────────────────────────────────────────── */

const TZ = siteTimeZone();
const D = '2026-11-24';
const D_PREV = addDaysYmd(D, -1);
const D1 = addDaysYmd(D, 1);
const D2 = addDaysYmd(D, 2);
const at = (ymd: string, h: number, m = 0): number => zonedWallTimeMs(ymd, h, m, TZ);
const ISSUED = at(D, 21, 30);
const WIN_START = at(D, 23);
const WIN_END = at(D1, 5);
const SHADOW_START = at(D1, 10);
const SHADOW_END = at(D1, 15);
const NOW = at(D2, 10);
const HOUR = 3_600_000;

const PANEL = 'PANEL-A';
const CORES = ['CORE-1', 'CORE-2', 'CORE-3'];
const devices = (): Record<string, unknown> => ({
  [PANEL]: {
    sn: PANEL, deviceName: 'House panel', housePanel: true,
    projection: { kind: 'shp2', sources: CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })) },
  },
  ...Object.fromEntries(CORES.map((sn, i) => [sn, { sn, deviceName: `Core ${i + 1}` }])),
});

/** The watts each stub series reads (constant, a sample every five minutes). */
const W = { p1: 1000, p2: 500, p3: 250, c1: 600, c2: 400, c3: 200, load: 800 };
/** A constant series' energy over [a, b) on five-minute samples from a (the trapezoid has (n − 1) steps), kWh. */
const kwhOver = (watts: number, a: number, b: number): number => (watts * ((Math.ceil((b - a) / FIVE_MIN) - 1) * FIVE_MIN)) / HOUR / 1000;
const r2 = (x: number): number => Math.round(x * 100) / 100;

const SPAN_END = ISSUED + 24 * HOUR;
const PANEL_SPAN_KWH = r2(kwhOver(W.p1 + W.p2 + W.p3, ISSUED, SPAN_END));
const CORES_SPAN_KWH = r2(kwhOver(W.c1 + W.c2 + W.c3, ISSUED, SPAN_END));
const PANEL_WINDOW_KWH = r2(kwhOver(W.p1 + W.p2 + W.p3, SHADOW_START, SHADOW_END));
const CORES_WINDOW_KWH = r2(kwhOver(W.c1 + W.c2 + W.c3, SHADOW_START, SHADOW_END));
const LOAD_WINDOW_KWH = r2(kwhOver(W.load, SHADOW_START, SHADOW_END));

/** The panel's own per-slot readings, its load, SoC and grid meter: present over the whole night and day. */
function panelSeries(m: Map<string, (ts: number) => number | null>): void {
  m.set(`${PANEL}|src1_pv_w`, () => W.p1);
  m.set(`${PANEL}|src2_pv_w`, () => W.p2);
  m.set(`${PANEL}|src3_pv_w`, () => W.p3);
  m.set(`${PANEL}|panel_load`, () => W.load);
  m.set(`${PANEL}|backup_pct`, () => 60);
  m.set(`${PANEL}|grid_home_w`, () => 0);
}
function coreSeries(m: Map<string, (ts: number) => number | null>, which: number[] = [1, 2, 3]): void {
  const w = [W.c1, W.c2, W.c3];
  for (const n of which) m.set(`${CORES[n - 1]}|pv_total`, () => w[n - 1]);
}

const ADMIT_ALL: PanelAdmission = { asOfDay: D2, builtAtMs: at(D2, 9, 30), slotDays: { 1: [D, D1], 2: [D, D1], 3: [D, D1] } };

/* ─── the shadow's row columns, as the shadow writes them ──────────────────────────────────────── */

const COST_DISP = 'not armed — the plan basis is incomplete (only 0 scored calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14))';
const BACKUP_DISP = 'not armed — the cushion asks for nothing over the backup window';

function leg(role: 'backup' | 'cost', disposition: string, panelPvAsOfDay?: string): ShadowLegSummary {
  const start = role === 'cost' ? SHADOW_START : at(D, 23);
  const end = role === 'cost' ? SHADOW_END : at(D1, 5);
  return {
    role, kind: role === 'cost' ? 'midday' : 'overnight', windowStartMs: start, windowEndMs: end, basisComplete: false, chargeTonight: false,
    reservePct: null, reserveBasis: null, levelPct: null, buyKwh: null, expectedBuyKwh: null, wouldArm: false, disposition,
    windowPvP50Kwh: 9.1, windowLoadP50Kwh: 4.2,
    ...(panelPvAsOfDay != null ? { panelPvAsOfDay } : {}),
  } as unknown as ShadowLegSummary;
}
function shadowCols(o: { backupBand?: string; costBand?: string; optionBBand?: string; noCost?: boolean; note?: string }): Partial<NightLedgerRow> {
  const rec = {
    version: 1, day: D, computedAtMs: at(D, 21, 40), why: 'midday', mode: 'advisory',
    backup: o.note != null ? null : leg('backup', BACKUP_DISP, o.backupBand),
    backupB: o.optionBBand != null ? leg('backup', 'option B', o.optionBBand) : null,
    cost: o.note != null || o.noCost === true ? null : leg('cost', COST_DISP, o.costBand),
    refresh: null, note: o.note ?? null,
  } as unknown as MiddayShadowRecord;
  return middayShadowLedgerColumns(rec);
}

/* ─── one capture ──────────────────────────────────────────────────────────────────────────────── */

type Basis = { pv_basis: string | null; pv_basis_slots: string | null };
const CORES_BASIS: Basis = { pv_basis: 'cores', pv_basis_slots: null };
const PANEL_BASIS: Basis = { pv_basis: 'panel', pv_basis_slots: '1:P,2:P,3:P' };

interface Telemetry {
  cores?: number[];
  coreSeriesOverride?: Array<[number, (ts: number) => number | null]>;
  panelOverride?: Array<[string, (ts: number) => number | null]>;
  held?: HeldSpan[];
  /** The house panel's view of a Core's link (slot → isConnected), where it is not the default (every Core connected). */
  connected?: Partial<Record<1 | 2 | 3, boolean>>;
}
/** The world a capture or a sweep reads: the telemetry, the held spans, the store and the newest admission read. */
function worldOf(o: Telemetry, admission: PanelAdmission | null): World {
  const series = new Map<string, (ts: number) => number | null>();
  panelSeries(series);
  coreSeries(series, o.cores ?? []);
  for (const [n, f] of o.coreSeriesOverride ?? []) series.set(`${CORES[n - 1]}|pv_total`, f);
  for (const [metric, f] of o.panelOverride ?? []) series.set(`${PANEL}|${metric}`, f);
  const devs = devices() as Record<string, any>;
  for (const [slot, c] of Object.entries(o.connected ?? {})) devs[PANEL].projection.sources[Number(slot) - 1].isConnected = c;
  return { devices: devs, series, held: o.held ?? [], admission };
}

function capture(o: Telemetry & {
  basis: Basis;
  admission?: PanelAdmission | null;
  shadow?: Partial<NightLedgerRow>;
  nowMs?: number;
}): Run {
  world = worldOf(o, o.admission === undefined ? ADMIT_ALL : o.admission);
  const y = {
    plan_date: D, issued_at_ms: ISSUED, algo_version: 3, objective: 'cost', confidence_tier: 'normal',
    window_start_ms: WIN_START, window_end_ms: WIN_END,
    min_proj_soc_pct: 35, target_soc_pct: 60, buy_kwh: 0, required_extra_kwh: 0,
    pv_p10_kwh: 20, pv_p50_kwh: 30, pv_p90_kwh: 45, load_p10_kwh: 15, load_p50_kwh: 19, load_p90_kwh: 25,
    reserve_floor_pct: 10, cushion_pct: 10, rationale: '',
    pv_model_sns: [...CORES].sort().join(','), pv_upper_ratio: 0.97, actual_pv_basis: null,
    ...o.basis,
    ...(o.shadow ?? shadowCols({ costBand: o.basis.pv_basis === 'panel' || o.basis.pv_basis === 'mixed' ? D : undefined })),
  } as unknown as NightLedgerRow;
  current = { logs: [], writes: [], row: {}, recorderCalls: new Set() };
  const spans = { windowStart: WIN_START, windowEnd: WIN_END, onpeak: null, scoreSpanEnd: WIN_END + 16 * HOUR, completeMs: WIN_END + 16 * HOUR, windowKnown: true };
  scoreNightRow(y, spans, PANEL, o.nowMs ?? NOW, null);
  const run = current;
  current = null;
  return run;
}
const pvLogs = (r: Run): LogCall[] => r.logs.filter((l) => /actual_pv_kwh/.test(l.text));
const CORES_COVERAGE_WARNING = (cov: string): string =>
  `night-charge ledger: actual_pv_kwh WITHHELD — worst per-core PV coverage ${cov} < 0.9 over the scored span; a fleet sum across a dark core under-counts and this column is durable`;
const isCoresOnlyLine = (t: string): boolean => /worst per-core PV coverage|a fleet sum across a dark core|of the span had no fresh readings \(held telemetry\)/.test(t);

/* ─── the harness itself ───────────────────────────────────────────────────────────────────────── */

test('the scorer is the one index.ts writes: it reads only scoring modules, the recorder, the store and the log', () => {
  assert.equal(PV_LEDGER_MIN_CORE_COVERAGE, 0.9);
  const mods = [...new Set(SCORER_IMPORTS.map(([, v]) => v.mod))].sort();
  assert.deepEqual(mods, [
    './analytics.js', './limits.js', './middayShadow.js', './nightChargeAdvisor.js', './nightChargeGate.js', './nightLedgerScoring.js',
    './shp2Membership.js', './tariff.js',
  ]);
  // No device write, push or announcement is reachable from the capture.
  for (const [local] of SCORER_IMPORTS) {
    assert.doesNotMatch(local, /^(set|send|push|publish|announce|write|arm|apply|force)/i, `${local} is not a write`);
  }
  const r = capture({ basis: PANEL_BASIS });
  assert.deepEqual([...r.recorderCalls].sort(), ['heldSpans', 'query', 'recordNightOutcome']);
  assert.ok(r.writes.every((w) => w.day === D));
});

/* ─── 1. a row on the Cores' basis: to the letter ──────────────────────────────────────────────── */

test('Cores basis, every Core reporting: the Cores\' sum, no PV line, and the shadow on the Cores\' meter', () => {
  const r = capture({ basis: CORES_BASIS, cores: [1, 2, 3] });
  assert.equal(r.row.actual_pv_kwh, CORES_SPAN_KWH);
  assert.equal(r.row.actual_pv_kwh, 28.7);
  assert.equal(r.row.actual_pv_basis, null);
  assert.deepEqual(pvLogs(r), []);
  assert.equal(r.row.shadow_window_pv_kwh, CORES_WINDOW_KWH);
  assert.equal(r.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
});

test('Cores basis, every Core dark: NULL, and the Cores\' coverage warning, word for word, once', () => {
  const r = capture({ basis: CORES_BASIS, cores: [] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.equal(r.row.actual_pv_basis, null);
  assert.deepEqual(r.logs, [{ level: 'warn', text: CORES_COVERAGE_WARNING('0.00') }]);
  // The panel's readings are present and are not used on this row, for the live figure or the shadow's (Cores' band).
  assert.equal(r.row.shadow_window_pv_kwh, null);
  assert.equal(r.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
});

test('Cores basis, one Core dark: NULL (never the two-Core sum), and the warning at 0.00', () => {
  const r = capture({ basis: CORES_BASIS, cores: [1, 3] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.deepEqual(r.logs, [{ level: 'warn', text: CORES_COVERAGE_WARNING('0.00') }]);
  assert.equal(r.row.shadow_window_pv_kwh, null);
});

test('Cores basis, one Core thin (85 % covered): NULL, and the warning states that Core\'s coverage', () => {
  const cutoff = ISSUED + 245 * FIVE_MIN; // 245 of 288 five-minute buckets
  const r = capture({ basis: CORES_BASIS, cores: [1, 3], coreSeriesOverride: [[2, (ts) => (ts < cutoff ? W.c2 : null)]] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.deepEqual(r.logs, [{ level: 'warn', text: CORES_COVERAGE_WARNING('0.85') }]);
});

test('Cores basis, a Core held two hours: NULL, and the Cores\' held line, word for word', () => {
  const r = capture({ basis: CORES_BASIS, cores: [1, 2, 3], held: [{ sn: 'CORE-2', startMs: ISSUED + HOUR, endMs: ISSUED + 3 * HOUR }] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.deepEqual(r.logs, [{
    level: 'warn',
    text: `night-charge ledger: actual_pv_kwh WITHHELD for ${D} — Core 2 2.0 h of the span had no fresh readings (held telemetry)`,
  }]);
});

test('a row with no solar basis (pv_basis NULL) is a Cores row, even with the panel\'s slot verdict recorded', () => {
  const r = capture({ basis: { pv_basis: null, pv_basis_slots: '1:P,2:P,3:P' }, cores: [] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.equal(r.row.actual_pv_basis, null);
  assert.deepEqual(r.logs, [{ level: 'warn', text: CORES_COVERAGE_WARNING('0.00') }]);
  const up = capture({ basis: { pv_basis: null, pv_basis_slots: '1:P,2:P,3:P' }, cores: [1, 2, 3] });
  assert.equal(up.row.actual_pv_kwh, CORES_SPAN_KWH);
  assert.deepEqual(pvLogs(up), []);
});

/* ─── 2. a row on the panel basis: the panel path's figure, never the Cores-only warning ────────── */

test('panel basis, Cores dark, admitted: the panel\'s own figure is written and nothing is logged about it', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [] });
  assert.equal(r.row.actual_pv_kwh, PANEL_SPAN_KWH);
  assert.equal(r.row.actual_pv_kwh, 41.85);
  assert.equal(r.row.actual_pv_basis, '1:P,2:P,3:P');
  assert.deepEqual(r.logs, [], 'no line: the figure is written, and the Cores\' gate is not this row\'s');
});

test('panel basis, Cores reporting too: the panel path\'s figure, not the Cores\' sum, and no line', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [1, 2, 3] });
  assert.equal(r.row.actual_pv_kwh, PANEL_SPAN_KWH);
  assert.deepEqual(r.logs, []);
});

test('panel basis, pending the energy balance: NULL, pending in the note, one line that says pending (never the Cores\')', () => {
  for (const admission of [null, { ...ADMIT_ALL, asOfDay: D1 }, { ...ADMIT_ALL, builtAtMs: at(D2, 8, 59) }]) {
    const r = capture({ basis: PANEL_BASIS, cores: [], admission });
    assert.equal(r.row.actual_pv_kwh, null);
    assert.match(String(r.row.score_notes), /PV actual pending the energy balance/);
    const lines = pvLogs(r);
    assert.equal(lines.length, 1, JSON.stringify(r.logs));
    assert.ok(!isCoresOnlyLine(lines[0].text), lines[0].text);
    assert.match(lines[0].text, new RegExp(`${D}.*pending|pending.*${D}`));
    assert.doesNotMatch(lines[0].text, /WITHHELD/, 'pending is not a withholding');
    assert.equal(r.logs.length, 1);
  }
});

test('panel basis, a span day the balance did not pass: NULL, one WITHHELD line naming the slot and day', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [], admission: { ...ADMIT_ALL, slotDays: { ...ADMIT_ALL.slotDays, 2: [D] } } });
  assert.equal(r.row.actual_pv_kwh, null);
  const lines = pvLogs(r);
  assert.equal(r.logs.length, 1, JSON.stringify(r.logs));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
  assert.ok(!isCoresOnlyLine(lines[0].text), lines[0].text);
  assert.match(lines[0].text, /WITHHELD/);
  assert.match(lines[0].text, new RegExp(D));
  assert.match(lines[0].text, /slot 2/);
  assert.match(lines[0].text, new RegExp(D1));
});

test('panel basis, the panel held two hours: NULL, one WITHHELD line for held telemetry, not the Cores\' held line', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [], held: [{ sn: PANEL, startMs: ISSUED + HOUR, endMs: ISSUED + 3 * HOUR }] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.equal(r.logs.length, 1, JSON.stringify(r.logs));
  assert.equal(r.logs[0].level, 'warn');
  assert.ok(!isCoresOnlyLine(r.logs[0].text), r.logs[0].text);
  assert.match(r.logs[0].text, /WITHHELD/);
  assert.match(r.logs[0].text, /held/);
});

test('panel basis, a Core held two hours: NULL (the live row\'s rule), one line, and it is not the Cores\' held line', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [], held: [{ sn: 'CORE-2', startMs: ISSUED + HOUR, endMs: ISSUED + 3 * HOUR }] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.equal(r.logs.length, 1, JSON.stringify(r.logs));
  assert.ok(!isCoresOnlyLine(r.logs[0].text), r.logs[0].text);
  assert.match(r.logs[0].text, /WITHHELD/);
});

test('panel basis, a slot thin over the span: NULL, never the sum of the other slots, and one line', () => {
  const cutoff = ISSUED + 200 * FIVE_MIN;
  const r = capture({ basis: PANEL_BASIS, cores: [], panelOverride: [['src3_pv_w', (ts) => (ts < cutoff ? W.p3 : null)]] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.equal(r.logs.length, 1, JSON.stringify(r.logs));
  assert.ok(!isCoresOnlyLine(r.logs[0].text), r.logs[0].text);
  assert.match(r.logs[0].text, /WITHHELD/);
});

test('mixed basis: the panel for P slots and the slot\'s Core for its C slot; no Cores-only warning with two Cores dark', () => {
  const MIXED: Basis = { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' };
  const r = capture({ basis: MIXED, cores: [3] });
  assert.equal(r.row.actual_pv_kwh, r2(kwhOver(W.p1 + W.p2 + W.c3, ISSUED, SPAN_END)));
  assert.equal(r.row.actual_pv_basis, '1:P,2:P,3:C');
  assert.deepEqual(r.logs, []);
  // Its Core dark too: NULL, and the panel path's own line.
  const dark = capture({ basis: MIXED, cores: [] });
  assert.equal(dark.row.actual_pv_kwh, null);
  assert.equal(dark.logs.length, 1, JSON.stringify(dark.logs));
  assert.ok(!isCoresOnlyLine(dark.logs[0].text), dark.logs[0].text);
  assert.match(dark.logs[0].text, /WITHHELD/);
});

test('panel basis with no slot list: NULL, one WITHHELD line, never the Cores\' warning', () => {
  const r = capture({ basis: { pv_basis: 'panel', pv_basis_slots: null }, cores: [] });
  assert.equal(r.row.actual_pv_kwh, null);
  assert.match(String(r.row.score_notes), /PV actual withheld \(no per-slot sources recorded\)/);
  assert.equal(r.logs.length, 1, JSON.stringify(r.logs));
  assert.ok(!isCoresOnlyLine(r.logs[0].text), r.logs[0].text);
  assert.match(r.logs[0].text, /WITHHELD/);
  // The shadow cannot be measured on the panel without the slots: today's output (the Cores' meter, set aside on a panel row).
  assert.equal(r.row.shadow_window_pv_kwh, null);
  assert.equal(r.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
});

test('every PV line on a panel row agrees with what the row holds: WITHHELD ⇒ NULL, pending ⇒ the pending note, none ⇒ a figure', () => {
  const cases = [
    capture({ basis: PANEL_BASIS, cores: [] }),
    capture({ basis: PANEL_BASIS, cores: [], admission: null }),
    capture({ basis: PANEL_BASIS, cores: [], admission: { ...ADMIT_ALL, slotDays: { 1: [D, D1], 2: [D, D1], 3: [D1] } } }),
    capture({ basis: PANEL_BASIS, cores: [], held: [{ sn: PANEL, startMs: ISSUED, endMs: ISSUED + 2 * HOUR }] }),
    capture({ basis: { pv_basis: 'mixed', pv_basis_slots: '1:P,2:N,3:P' }, cores: [] }),
  ];
  for (const r of cases) {
    const lines = pvLogs(r);
    assert.ok(lines.length <= 1, JSON.stringify(r.logs));
    if (lines.length === 0) assert.equal(typeof r.row.actual_pv_kwh, 'number');
    else if (/WITHHELD/.test(lines[0].text)) assert.equal(r.row.actual_pv_kwh, null);
    else {
      assert.match(lines[0].text, /pending/);
      assert.equal(r.row.actual_pv_kwh, null);
      assert.match(String(r.row.score_notes), /pending the energy balance/);
    }
  }
});

/* ─── 3. the shadow's measured window solar ────────────────────────────────────────────────────── */

test('the shadow\'s cost leg on the panel band of the row\'s evening: the panel\'s per-slot reading over the window, Cores dark', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({ costBand: D }) });
  assert.equal(r.row.shadow_window_pv_kwh, PANEL_WINDOW_KWH);
  assert.equal(r.row.shadow_window_pv_kwh, 8.6);
  assert.equal(r.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
  // With the Cores reporting it is still the panel's (the band the leg was sized on), never the Cores' meter.
  const up = capture({ basis: PANEL_BASIS, cores: [1, 2, 3], shadow: shadowCols({ costBand: D }) });
  assert.equal(up.row.shadow_window_pv_kwh, PANEL_WINDOW_KWH);
});

test('the shadow on the panel band with the backup and option B on it too: the cost leg\'s band decides', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({ backupBand: D, costBand: D, optionBBand: D }) });
  assert.equal(r.row.shadow_window_pv_kwh, PANEL_WINDOW_KWH);
});

test('the shadow is never graded on an unadmitted panel reading: NULL while pending and where the window\'s day did not pass', () => {
  for (const admission of [null, { ...ADMIT_ALL, asOfDay: D1 }, { ...ADMIT_ALL, builtAtMs: at(D2, 8, 59) },
    { ...ADMIT_ALL, slotDays: { 1: [D, D1], 2: [D], 3: [D, D1] } }, { ...ADMIT_ALL, slotDays: {} }]) {
    const r = capture({ basis: PANEL_BASIS, cores: [], admission, shadow: shadowCols({ costBand: D }) });
    assert.equal(r.row.shadow_window_pv_kwh, null, JSON.stringify(admission));
    assert.equal(r.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
  }
});

test('the shadow is graded on its own window\'s day: a plan-evening day the balance did not pass does not withhold the window', () => {
  const r = capture({ basis: PANEL_BASIS, cores: [], admission: { ...ADMIT_ALL, slotDays: { 1: [D, D1], 2: [D1], 3: [D, D1] } }, shadow: shadowCols({ costBand: D }) });
  assert.equal(r.row.actual_pv_kwh, null, 'the live row: its span day D was not passed for slot 2');
  assert.equal(r.row.shadow_window_pv_kwh, PANEL_WINDOW_KWH, 'the window is on D+1, which passed');
});

test('the shadow: NULL on held telemetry inside the window (the panel or a Core), measured where the hold was outside it', () => {
  const inside = (sn: string): HeldSpan => ({ sn, startMs: SHADOW_START + HOUR, endMs: SHADOW_START + 3 * HOUR });
  const panelHeld = capture({ basis: PANEL_BASIS, cores: [], held: [inside(PANEL)], shadow: shadowCols({ costBand: D }) });
  assert.equal(panelHeld.row.shadow_window_pv_kwh, null);
  assert.equal(panelHeld.row.shadow_window_load_kwh, null);
  const coreHeld = capture({ basis: PANEL_BASIS, cores: [], held: [inside('CORE-1')], shadow: shadowCols({ costBand: D }) });
  assert.equal(coreHeld.row.shadow_window_pv_kwh, null);
  assert.equal(coreHeld.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
  const outside = capture({ basis: PANEL_BASIS, cores: [], held: [{ sn: PANEL, startMs: ISSUED, endMs: ISSUED + 2 * HOUR }], shadow: shadowCols({ costBand: D }) });
  assert.equal(outside.row.actual_pv_kwh, null, 'the live row is withheld over its own span');
  assert.equal(outside.row.shadow_window_pv_kwh, PANEL_WINDOW_KWH);
});

test('the shadow: NULL rather than a partial sum where one slot\'s readings are thin inside the window', () => {
  const thin = (ts: number): number | null => (ts >= SHADOW_START && ts < SHADOW_START + HOUR ? null : W.p3);
  const r = capture({ basis: PANEL_BASIS, cores: [], panelOverride: [['src3_pv_w', thin]], shadow: shadowCols({ costBand: D }) });
  assert.equal(r.row.shadow_window_pv_kwh, null);
  // An N slot, and a missing slot list: no figure from the panel either.
  const n = capture({ basis: { pv_basis: 'mixed', pv_basis_slots: '1:P,2:N,3:P' }, cores: [], shadow: shadowCols({ costBand: D }) });
  assert.equal(n.row.shadow_window_pv_kwh, null);
});

test('the shadow on a mixed row: the panel for P slots and the slot\'s Core for its C slot, NULL with that Core dark', () => {
  const MIXED: Basis = { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' };
  const r = capture({ basis: MIXED, cores: [3], shadow: shadowCols({ costBand: D }) });
  assert.equal(r.row.shadow_window_pv_kwh, r2(kwhOver(W.p1 + W.p2 + W.c3, SHADOW_START, SHADOW_END)));
  const dark = capture({ basis: MIXED, cores: [], shadow: shadowCols({ costBand: D }) });
  assert.equal(dark.row.shadow_window_pv_kwh, null);
});

test('the shadow\'s cost leg on the Cores\' band: the Cores\' meter, as today', () => {
  // On a row on the Cores' basis: the Cores' meter, the Cores reporting.
  const r = capture({ basis: CORES_BASIS, cores: [1, 2, 3], shadow: shadowCols({}) });
  assert.equal(r.row.shadow_window_pv_kwh, CORES_WINDOW_KWH);
  // One Core thin inside the window: NULL (the per-Core rule), never the panel.
  const thin = capture({ basis: CORES_BASIS, cores: [1, 3], coreSeriesOverride: [[2, (ts) => (ts >= SHADOW_START && ts < SHADOW_START + HOUR ? null : W.c2)]], shadow: shadowCols({}) });
  assert.equal(thin.row.shadow_window_pv_kwh, null);
  // On a row on the panel basis: today's output, the Cores' meter under the row's own PV set-aside (NULL).
  for (const shadow of [shadowCols({}), shadowCols({ backupBand: D }), shadowCols({ optionBBand: D }), shadowCols({ backupBand: D, optionBBand: D })]) {
    const p = capture({ basis: PANEL_BASIS, cores: [1, 2, 3], shadow });
    assert.equal(p.row.shadow_window_pv_kwh, null, String(shadow.shadow_arm_disposition));
    assert.equal(p.row.shadow_window_load_kwh, LOAD_WINDOW_KWH);
  }
});

test('unknown equals today: another evening\'s band, a row not on the panel basis, a window not closed', () => {
  // A band as of another evening than the row's: the panel path does not apply (today: the Cores' meter, set aside on a panel row).
  const other = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({ costBand: D_PREV }) });
  assert.equal(other.row.shadow_window_pv_kwh, null);
  // A row on the Cores' basis whose cost leg was sized on the panel band: no slot list to measure it by, so the Cores' meter.
  const coresRow = capture({ basis: CORES_BASIS, cores: [1, 2, 3], shadow: shadowCols({ costBand: D }) });
  assert.equal(coresRow.row.shadow_window_pv_kwh, CORES_WINDOW_KWH);
  const coresRowDark = capture({ basis: CORES_BASIS, cores: [], shadow: shadowCols({ costBand: D }) });
  assert.equal(coresRowDark.row.shadow_window_pv_kwh, null);
  // A row with no solar basis that still records the evening's slot verdict: not a panel row, so the Cores' meter too.
  const noBasis: Basis = { pv_basis: null, pv_basis_slots: '1:P,2:P,3:P' };
  assert.equal(capture({ basis: noBasis, cores: [1, 2, 3], shadow: shadowCols({ costBand: D }) }).row.shadow_window_pv_kwh, CORES_WINDOW_KWH);
  assert.equal(capture({ basis: noBasis, cores: [], shadow: shadowCols({ costBand: D }) }).row.shadow_window_pv_kwh, null);
  // The window not closed yet: no shadow columns are written at all.
  const open = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({ costBand: D }), nowMs: SHADOW_END - 1 });
  assert.ok(open.writes.every((w) => !('shadow_window_pv_kwh' in w.cols)));
  // A row with no shadow leg: no shadow columns either.
  const none = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({ note: 'the cycle is overnight: Friday' }) });
  assert.ok(none.writes.every((w) => !('shadow_window_pv_kwh' in w.cols)));
});

test('captured pending, then re-captured: the row and its shadow are measured on the newer judgement, each line said once', () => {
  // The first capture runs the evening after the span: the newest report is as of that evening, which cannot judge its own day.
  const early: PanelAdmission = { asOfDay: D1, builtAtMs: at(D1, 21, 35), slotDays: { 1: [D_PREV, D], 2: [D_PREV, D], 3: [D_PREV, D] } };
  const first = capture({ basis: PANEL_BASIS, cores: [], admission: early, nowMs: at(D1, 22), shadow: shadowCols({ costBand: D }) });
  assert.equal(first.row.actual_pv_kwh, null);
  assert.equal(first.row.shadow_window_pv_kwh, null);
  assert.equal(first.logs.length, 1);
  assert.match(first.logs[0].text, /pending/);
  const captured = { plan_date: D, issued_at_ms: ISSUED, ...PANEL_BASIS, ...shadowCols({ costBand: D }), ...first.row } as unknown as NightLedgerRow;
  assert.equal(panelPvRecaptureDue(captured, ADMIT_ALL, NOW, 30 * 86_400_000), true, 'the judged report makes the row due');
  const reset = panelPvRecaptureColumns(D2);
  assert.ok('shadow_window_pv_kwh' in reset && reset.shadow_window_pv_kwh === null, 'the reset clears the shadow figure with the outcome');
  const second = capture({ basis: PANEL_BASIS, cores: [], admission: ADMIT_ALL, shadow: shadowCols({ costBand: D }) });
  assert.equal(second.row.actual_pv_kwh, PANEL_SPAN_KWH);
  assert.equal(second.row.shadow_window_pv_kwh, PANEL_WINDOW_KWH);
  assert.deepEqual(second.logs, []);
});

test('the shadow\'s figure never changes a column of the live row: the outcome write is the same with the shadow on either band', () => {
  const onPanel = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({ costBand: D }) });
  const onCores = capture({ basis: PANEL_BASIS, cores: [], shadow: shadowCols({}) });
  const outcome = (r: Run): Record<string, unknown> => {
    const w = r.writes.find((x) => 'outcome_captured_at_ms' in x.cols);
    assert.ok(w != null);
    return w.cols;
  };
  assert.deepEqual(outcome(onPanel), outcome(onCores));
  assert.deepEqual(onPanel.logs, onCores.logs);
});

/* ─── 4. the band, read back from the row ──────────────────────────────────────────────────────── */

test('the cost leg\'s band, read back from what the shadow writes: the cost leg\'s only', () => {
  const read = (o: Parameters<typeof shadowCols>[0]): string | null => shadowCostPanelPvAsOfDay(shadowCols(o).shadow_arm_disposition);
  assert.equal(read({ costBand: D }), D);
  assert.equal(read({ backupBand: D, costBand: D }), D);
  assert.equal(read({ backupBand: D, costBand: D, optionBBand: D }), D);
  assert.equal(read({ costBand: D, optionBBand: D_PREV }), D);
  assert.equal(read({ backupBand: D_PREV, costBand: D }), D);
  assert.equal(read({}), null);
  assert.equal(read({ backupBand: D }), null);
  assert.equal(read({ optionBBand: D }), null);
  assert.equal(read({ backupBand: D, optionBBand: D }), null);
  assert.equal(read({ backupBand: D, noCost: true }), null);
  assert.equal(read({ note: 'the cycle is overnight: Friday' }), null);
  assert.equal(shadowCostPanelPvAsOfDay(null), null);
  assert.equal(shadowCostPanelPvAsOfDay(undefined), null);
  assert.equal(shadowCostPanelPvAsOfDay(''), null);
});

/* ─── 5. the pure measure, called without the panel path: as before ────────────────────────────── */

test('shadowWindowActuals without its panel input measures the Cores\' meter, as before', () => {
  const q = (w: number) => (_sn: string, a: number, b: number): Sample[] => {
    const out: Sample[] = [];
    for (let ts = a; ts < b; ts += FIVE_MIN) out.push({ ts, value: w });
    return out;
  };
  const row = {
    shadow_cost_window_start_ms: SHADOW_START, shadow_cost_window_end_ms: SHADOW_END, plan_date: D, ...PANEL_BASIS, actual_pv_basis: null,
  } as Partial<NightLedgerRow>;
  const base = { row, nowMs: NOW, homeSns: CORES, queryPv: q(400), queryLoad: (a: number, b: number) => q(W.load)('', a, b) };
  assert.deepEqual(shadowWindowActuals(base), { pvKwh: r2(kwhOver(1200, SHADOW_START, SHADOW_END)), loadKwh: LOAD_WINDOW_KWH });
  assert.deepEqual(shadowWindowActuals({ ...base, panel: null }), { pvKwh: r2(kwhOver(1200, SHADOW_START, SHADOW_END)), loadKwh: LOAD_WINDOW_KWH });
  assert.deepEqual(shadowWindowActuals({ ...base, pvSetAside: 'set aside' }), { pvKwh: null, loadKwh: LOAD_WINDOW_KWH });
  // Given the panel input on a panel row on the panel band of its own evening, but with no readable slot list: the panel path
  // cannot produce a figure, and the output is the one it gives without the panel input.
  const panel = {
    bandAsOfDay: D, panelSn: PANEL, coreOfSlot: (n: number) => CORES[n - 1] ?? null, admission: ADMIT_ALL,
    query: (_sn: string, _m: string, a: number, b: number) => q(700)('', a, b),
  };
  for (const slots of [null, '', 'garbled', '1:P,2:X']) {
    const r = { ...row, pv_basis_slots: slots };
    assert.deepEqual(shadowWindowActuals({ ...base, row: r, panel }), shadowWindowActuals({ ...base, row: r }), String(slots));
  }
  // With the slots readable, the panel path measures (three P slots at 700 W each), and the Cores' 400 W do not enter.
  assert.deepEqual(shadowWindowActuals({ ...base, panel }), { pvKwh: r2(kwhOver(2100, SHADOW_START, SHADOW_END)), loadKwh: LOAD_WINDOW_KWH });
});

/* ─── 6. the shadow's own way out of pending: the sweep, as index.ts writes it ─────────────────── */

const SWEEP = topLevelFunction('function remeasurePendingShadowPv(');
const SWEEP_WORDS = new Set(SWEEP.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
/** Every imported name the sweep reads, with the module index.ts takes it from (the configuration is the stub below). */
const SWEEP_IMPORTS = [...IMPORTS].filter(([local]) => SWEEP_WORDS.has(local));
const sweepResolved: Record<string, unknown> = {};
for (const [local, { mod, name }] of SWEEP_IMPORTS) {
  if (local === 'config') continue;
  const ns: Record<string, unknown> = await import(srcUrl(`${mod.slice(2, -3)}.ts`).href);
  assert.ok(name in ns, `${mod} exports ${name}`);
  sweepResolved[local] = ns[name];
}
const SWEEP_DAYS = Number(/^const LEDGER_BACKFILL_SWEEP_DAYS = (\d+);$/m.exec(INDEX)?.[1]);
const RETENTION_DAYS = 30;
const HORIZON_MS = forecastSpanRecaptureHorizonMs(RETENTION_DAYS, SWEEP_DAYS);
/** The sweep's once-per-boot memory (index.ts shadowPvRemeasuredThisBoot): a new Set is a new boot. */
let bootMemo = new Set<string>();
const sweepScope: Record<string, unknown> = {
  ...sweepResolved, recorder, app, store, config: { retentionDays: RETENTION_DAYS }, LEDGER_BACKFILL_SWEEP_DAYS: SWEEP_DAYS,
};
Object.defineProperty(sweepScope, 'panelAdmissionMem', { get: () => world!.admission, enumerable: true });
Object.defineProperty(sweepScope, 'shadowPvRemeasuredThisBoot', { get: () => bootMemo, enumerable: true });
const sweepProxy = new Proxy(sweepScope, { has: (t, k) => typeof k === 'string' && k in t });
type Sweep = (rows: NightLedgerRow[], shp2Sn: string, nowMs: number) => void;
// eslint-disable-next-line no-new-func
const remeasurePendingShadowPv = new Function('__scope', `with (__scope) { return (function () {\n${transformSync(SWEEP, { loader: 'ts' }).code}\nreturn remeasurePendingShadowPv;\n})(); }`)(sweepProxy) as Sweep;

/** The first capture's report: as of the evening after the span, which cannot judge its own day. */
const EARLY: PanelAdmission = { asOfDay: D1, builtAtMs: at(D1, 21, 35), slotDays: { 1: [D_PREV, D], 2: [D_PREV, D], 3: [D_PREV, D] } };
/** The row as the ledger holds it after its capture (by default the usual one: the evening after the span, on that evening's report). */
function captured(o: Telemetry & { basis: Basis; shadow?: Partial<NightLedgerRow>; admission?: PanelAdmission | null; nowMs?: number }): { first: Run; row: NightLedgerRow } {
  const shadow = o.shadow ?? shadowCols({ costBand: D });
  const first = capture({ ...o, shadow, admission: o.admission === undefined ? EARLY : o.admission, nowMs: o.nowMs ?? at(D1, 22) });
  return { first, row: { plan_date: D, issued_at_ms: ISSUED, ...o.basis, ...shadow, ...first.row } as unknown as NightLedgerRow };
}
/** One pass of the sweep over `rows` on the same telemetry, with `admission` the newest report read. */
function sweepOnce(rows: NightLedgerRow[], o: Telemetry & { admission: PanelAdmission | null; nowMs?: number }): Run {
  world = worldOf(o, o.admission);
  current = { logs: [], writes: [], row: {}, recorderCalls: new Set() };
  remeasurePendingShadowPv(rows, PANEL, o.nowMs ?? NOW);
  const run = current;
  current = null;
  return run;
}
const nothing = (r: Run, label: string): void => {
  assert.deepEqual(r.writes, [], `${label}: nothing written`);
  assert.deepEqual(r.logs, [], `${label}: nothing said`);
  assert.deepEqual([...r.recorderCalls], [], `${label}: nothing read`);
};

const SLOT3_THIN_AT_NIGHT: Telemetry = { cores: [], panelOverride: [['src3_pv_w', (ts) => (ts < ISSUED + 40 * FIVE_MIN ? null : W.p3)]] };
const PANEL_HELD_AT_NIGHT: Telemetry = { cores: [], held: [{ sn: PANEL, startMs: ISSUED, endMs: ISSUED + 2 * HOUR }] };
const NOT_PASSED_D1_SLOT2: PanelAdmission = { ...ADMIT_ALL, slotDays: { ...ADMIT_ALL.slotDays, 2: [D] } };

test('the sweep runs on every pass of the backfill sweep, after both repairs and before the capture loop; it reads only scoring modules, the recorder, the store and the log', () => {
  const pass = topLevelFunction('function scoreCompletedNights(');
  const repaired = pass.indexOf('  if (repairPendingPanelPv(rows, nowMs)) rows = recorder.readNightLedger(LEDGER_BACKFILL_SWEEP_DAYS);');
  const swept = pass.indexOf('\n  remeasurePendingShadowPv(rows, shp2Sn, nowMs);\n');
  const loop = pass.indexOf('for (const { row: y, spans: s } of ledgerRowsDueForCapture(rows, nowMs, nightSpansForRow))');
  assert.ok(repaired > 0 && swept > repaired && loop > swept, 'repairs, then the sweep, then the capture loop');
  assert.deepEqual([...new Set(SWEEP_IMPORTS.map(([, v]) => v.mod))].sort(), ['./config.js', './middayShadow.js', './nightLedgerScoring.js', './shp2Membership.js']);
  for (const [local] of SWEEP_IMPORTS) assert.doesNotMatch(local, /^(set|send|push|publish|announce|write|arm|apply|force)/i, `${local} is not a write`);
  const { row } = captured({ basis: PANEL_BASIS, ...SLOT3_THIN_AT_NIGHT });
  bootMemo = new Set();
  const r = sweepOnce([row], { ...SLOT3_THIN_AT_NIGHT, admission: ADMIT_ALL });
  assert.deepEqual([...r.recorderCalls].sort(), ['heldSpans', 'query', 'recordNightOutcome']);
});

test('★★★ a panel row withheld at its capture (a slot thin, or the panel held, over the night) is never re-captured: the sweep grades its window alone once the balance has judged the window\'s day', () => {
  for (const [label, t] of [['slot 3 thin at night', SLOT3_THIN_AT_NIGHT], ['the panel held at night', PANEL_HELD_AT_NIGHT]] as const) {
    const { first, row } = captured({ basis: PANEL_BASIS, ...t });
    assert.equal(first.row.actual_pv_kwh, null, label);
    assert.equal(first.row.shadow_window_pv_kwh, null, `${label}: pending at the capture`);
    assert.doesNotMatch(String(first.row.score_notes), /PV actual pending the energy balance/, `${label}: the row's own actual is settled`);
    assert.equal(panelPvRecaptureDue(row, ADMIT_ALL, NOW, HORIZON_MS), false, `${label}: no re-capture follows`);
    // The evening of the capture: the window's day is not judged yet. Nothing is read.
    bootMemo = new Set();
    nothing(sweepOnce([row], { ...t, admission: EARLY, nowMs: at(D1, 23) }), `${label}, unjudged`);
    // The morning after the window's day, the judging report read: the window's PV, and only that column.
    const judged = sweepOnce([row], { ...t, admission: ADMIT_ALL });
    assert.deepEqual(judged.writes, [{ day: D, cols: { shadow_window_pv_kwh: PANEL_WINDOW_KWH } }], label);
    assert.deepEqual(judged.logs, [{
      level: 'info',
      text: `night-charge ledger: shadow_window_pv_kwh for ${D} measured on the panel's own readings (actual_pv_basis 1:P,2:P,3:P) — ${PANEL_WINDOW_KWH} kWh, the window's day judged by the 7-day energy balance as of ${D2}; the row's own columns are kept as captured`,
    }], label);
    // The figure a capture on that judgement grades.
    assert.equal(capture({ basis: PANEL_BASIS, ...t, shadow: shadowCols({ costBand: D }), admission: ADMIT_ALL }).row.shadow_window_pv_kwh, PANEL_WINDOW_KWH);
    assert.equal(PANEL_WINDOW_KWH, 8.6);
    // Written, it is not measured again, this boot or the next.
    nothing(sweepOnce([row], { ...t, admission: ADMIT_ALL }), `${label}, again`);
    bootMemo = new Set();
    nothing(sweepOnce([{ ...row, shadow_window_pv_kwh: PANEL_WINDOW_KWH } as NightLedgerRow], { ...t, admission: ADMIT_ALL }), `${label}, written`);
  }
});

test('★★★ the sweep grades nothing the capture would not: NULL and nothing written where the window\'s day was not passed, a side was held or a slot was thin inside the window; said once per boot', () => {
  const inWindow = (h: number): { startMs: number; endMs: number } => ({ startMs: SHADOW_START + HOUR, endMs: SHADOW_START + (1 + h) * HOUR });
  const cases: Array<[string, Telemetry, PanelAdmission, string]> = [
    ['the window\'s day not passed', SLOT3_THIN_AT_NIGHT, NOT_PASSED_D1_SLOT2, `slot 2's ${D1} was not passed by the 7-day energy balance as of ${D2}`],
    ['the panel held inside the window', { ...SLOT3_THIN_AT_NIGHT, held: [{ sn: PANEL, ...inWindow(2) }] }, ADMIT_ALL, 'held telemetry over the window'],
    ['a Core held inside the window', { ...SLOT3_THIN_AT_NIGHT, held: [{ sn: 'CORE-2', ...inWindow(2) }] }, ADMIT_ALL, 'held telemetry over the window'],
    ['slot 1 thin inside the window', {
      cores: [], panelOverride: [
        ['src3_pv_w', (ts) => (ts < ISSUED + 40 * FIVE_MIN ? null : W.p3)],
        ['src1_pv_w', (ts) => (ts >= SHADOW_START && ts < SHADOW_START + HOUR ? null : W.p1)],
      ],
    }, ADMIT_ALL, 'worst per-slot PV coverage 0.80 < 0.9'],
  ];
  for (const [label, t, admission, why] of cases) {
    const { first, row } = captured({ basis: PANEL_BASIS, ...t });
    assert.equal(first.row.actual_pv_kwh, null, label);
    assert.equal(first.row.shadow_window_pv_kwh, null, label);
    // The capture on the same judgement gives NULL too.
    assert.equal(capture({ basis: PANEL_BASIS, ...t, shadow: shadowCols({ costBand: D }), admission }).row.shadow_window_pv_kwh, null, label);
    bootMemo = new Set();
    const r = sweepOnce([row], { ...t, admission });
    assert.deepEqual(r.writes, [], `${label}: nothing written`);
    assert.deepEqual(r.logs, [{ level: 'debug', text: `night-charge ledger: shadow_window_pv_kwh for ${D} stays NULL (actual_pv_basis 1:P,2:P,3:P) — ${why}` }], label);
    nothing(sweepOnce([row], { ...t, admission }), `${label}, the same boot`);
    bootMemo = new Set();
    assert.equal(sweepOnce([row], { ...t, admission }).logs.length, 1, `${label}: once in the next boot`);
  }
});

test('★★★ not the sweep\'s, and nothing is read: a row its own re-capture revisits, a Cores row, a Cores-band leg, another evening\'s band, a row the capture judged, past the horizon, the day still unjudged', () => {
  const none = (row: NightLedgerRow, t: Telemetry, admission: PanelAdmission | null, label: string, nowMs = NOW): void => {
    bootMemo = new Set();
    nothing(sweepOnce([row], { ...t, admission, nowMs }), label);
  };
  // Captured pending: the row's own re-capture measures the window (and clears it first).
  const pend = captured({ basis: PANEL_BASIS, cores: [] });
  assert.match(String(pend.row.score_notes), /PV actual pending the energy balance/);
  assert.equal(panelPvRecaptureDue(pend.row, ADMIT_ALL, NOW, HORIZON_MS), true);
  none(pend.row, { cores: [] }, ADMIT_ALL, 'pending row');
  // A row on the Cores' basis, its shadow on the panel band: the Cores' meter at its capture, as before.
  none(captured({ basis: CORES_BASIS, cores: [], shadow: shadowCols({ costBand: D }) }).row, { cores: [] }, ADMIT_ALL, 'Cores row');
  // A panel row withheld at its capture whose cost leg was on the Cores' band, or on another evening's band.
  none(captured({ basis: PANEL_BASIS, ...SLOT3_THIN_AT_NIGHT, shadow: shadowCols({}) }).row, SLOT3_THIN_AT_NIGHT, ADMIT_ALL, 'Cores band');
  none(captured({ basis: PANEL_BASIS, ...SLOT3_THIN_AT_NIGHT, shadow: shadowCols({ costBand: D_PREV }) }).row, SLOT3_THIN_AT_NIGHT, ADMIT_ALL, 'another evening');
  // Captured once the window's day could be judged: the capture judged it (here, not passed), and a later report does not re-judge it.
  const D3 = addDaysYmd(D, 3);
  const late = captured({ basis: PANEL_BASIS, ...SLOT3_THIN_AT_NIGHT, admission: NOT_PASSED_D1_SLOT2, nowMs: at(D2, 10) });
  assert.equal(late.row.shadow_window_pv_kwh, null);
  none(late.row, SLOT3_THIN_AT_NIGHT, { asOfDay: D3, builtAtMs: at(D3, 9, 30), slotDays: ADMIT_ALL.slotDays }, 'judged at its capture', at(D3, 10));
  // Past the re-capture horizon (the raw telemetry it would read), and the day still unjudged.
  const thin = captured({ basis: PANEL_BASIS, ...SLOT3_THIN_AT_NIGHT }).row;
  none(thin, SLOT3_THIN_AT_NIGHT, ADMIT_ALL, 'past the horizon', ISSUED + HORIZON_MS + 1);
  none(thin, SLOT3_THIN_AT_NIGHT, null, 'no report read');
  none(thin, SLOT3_THIN_AT_NIGHT, { ...ADMIT_ALL, builtAtMs: at(D2, 8, 59) }, 'built before the day\'s total is in');
  none(thin, SLOT3_THIN_AT_NIGHT, { ...ADMIT_ALL, asOfDay: D1 }, 'as of the window\'s own day');
});

test('shadowPanelPvRemeasureDue: captured before 09:00 the morning after the window\'s day, never at it; inside the horizon to its edge; a row with no P slot on record never pends', () => {
  const { row } = captured({ basis: PANEL_BASIS, ...SLOT3_THIN_AT_NIGHT });
  const band = shadowCostPanelPvAsOfDay(row.shadow_arm_disposition);
  assert.equal(band, D);
  const judgeFrom = at(D2, 9);
  const due = (r: Partial<NightLedgerRow>, nowMs = NOW, admission: PanelAdmission | null = ADMIT_ALL): boolean =>
    shadowPanelPvRemeasureDue({ ...row, ...r } as NightLedgerRow, band, admission, nowMs, HORIZON_MS);
  assert.equal(due({}), true);
  assert.equal(due({ outcome_captured_at_ms: judgeFrom - 1 }), true);
  assert.equal(due({ outcome_captured_at_ms: judgeFrom }), false);
  assert.equal(due({ outcome_captured_at_ms: null }), false, 'not captured');
  assert.equal(due({}, ISSUED + HORIZON_MS), true);
  assert.equal(due({}, ISSUED + HORIZON_MS + 1), false);
  assert.equal(due({ actual_pv_basis: '1:C,2:C,3:C' }), false, 'no P slot: never pending');
  assert.equal(due({ actual_pv_basis: null }), false, 'no sources recorded');
  assert.equal(due({ shadow_window_pv_kwh: 0 }), false, 'a figure, zero included');
  assert.equal(due({ shadow_cost_window_start_ms: null }), false, 'no window');
  assert.equal(shadowPanelPvRemeasureDue(row, null, ADMIT_ALL, NOW, HORIZON_MS), false, 'the Cores\' band');
  assert.equal(shadowPanelPvRemeasureDue(row, D_PREV, ADMIT_ALL, NOW, HORIZON_MS), false, 'another evening\'s band');
});

test('the sweep on a mixed row: the panel for P slots and the slot\'s connected Core for its C slot; NULL with that Core off the panel', () => {
  const MIXED: Basis = { pv_basis: 'mixed', pv_basis_slots: '1:P,2:P,3:C' };
  const t: Telemetry = { cores: [3], panelOverride: [['src1_pv_w', (ts) => (ts < ISSUED + 40 * FIVE_MIN ? null : W.p1)]] };
  const { first, row } = captured({ basis: MIXED, ...t });
  assert.equal(first.row.actual_pv_kwh, null);
  assert.equal(first.row.actual_pv_basis, '1:P,2:P,3:C');
  bootMemo = new Set();
  assert.deepEqual(sweepOnce([row], { ...t, admission: ADMIT_ALL }).writes,
    [{ day: D, cols: { shadow_window_pv_kwh: r2(kwhOver(W.p1 + W.p2 + W.c3, SHADOW_START, SHADOW_END)) } }]);
  bootMemo = new Set();
  const off = sweepOnce([row], { ...t, connected: { 3: false }, admission: ADMIT_ALL });
  assert.deepEqual(off.writes, []);
  assert.deepEqual(off.logs, [{ level: 'debug', text: `night-charge ledger: shadow_window_pv_kwh for ${D} stays NULL (actual_pv_basis 1:P,2:P,3:C) — slot 3's Core is not connected` }]);
});
