/**
 * v1.187.0 — `realized_cost_cents` is written: metered grid import × the tariff's own rate
 * for each interval, over the night's scored span. It was declared in v1.38.0 and never
 * written, on the stated grounds that rates were unconfirmed and no night had actuated —
 * both long expired (ratesConfirmed:true in every tariff_snapshot, 24 actuated nights).
 * The counterfactual columns stay null, and the docs now say why (DOCS §6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pricedImportCents } from '../src/nightLedgerScoring.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const REV = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 44.2, winter: 30 },
  offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 },
});
const centsAt = (t: number) => rateAt(REV, t).centsPerKwh;
/** A constant `w` watts sampled every minute over [from, to]. */
const flat = (from: number, to: number, w: number) => {
  const out: Array<{ ts: number; value: number }> = [];
  for (let t = from; t <= to; t += MIN) out.push({ ts: t, value: w });
  return out;
};

test('an overnight hour at 1 kW costs the overnight rate', () => {
  const c = pricedImportCents(flat(phx(2026, 9, 29, 0), phx(2026, 9, 29, 1), 1000), centsAt);
  assert.equal(c, 12.59);
});

test('★ each interval is priced at ITS period: 15:30-16:30 at 1 kW = half off-peak + half on-peak', () => {
  const c = pricedImportCents(flat(phx(2026, 9, 29, 15, 30), phx(2026, 9, 29, 16, 30), 1000), centsAt)!;
  assert.ok(Math.abs(c - (0.5 * 16.91 + 0.5 * 44.2)) < 0.01, `got ${c}`);
});

test('★★ THE 2026-09-28 ON-PEAK: 4.27 kWh over 16:00-19:00 prices at 44.2¢ (≈ $1.89)', () => {
  const kw = 4270 / 3; // 1.4233 kW for three hours
  const c = pricedImportCents(flat(phx(2026, 9, 28, 16), phx(2026, 9, 28, 19), kw), centsAt)!;
  assert.ok(Math.abs(c - 4.27 * 44.2) < 0.2, `got ${c}`);
});

test('★★ unconfirmed rates price NOTHING — null over a fabricated number', () => {
  const unconfirmed = buildApsREvModel({ onPeak: { summer: 44.2, winter: 30 } });
  assert.equal(pricedImportCents(flat(phx(2026, 9, 29, 0), phx(2026, 9, 29, 1), 1000), (t) => rateAt(unconfirmed, t).centsPerKwh), null);
});

test('a confirmed table with a missing period rate is not half-priced', () => {
  const partial = buildApsREvModel({ confirmed: true, onPeak: { summer: 44.2, winter: 30 } }); // no overnight
  assert.equal(pricedImportCents(flat(phx(2026, 9, 29, 0), phx(2026, 9, 29, 1), 1000), (t) => rateAt(partial, t).centsPerKwh), null);
});

test('an export is not a credit, and a gap over an hour is not integrated (the kWh columns\' rules)', () => {
  assert.equal(pricedImportCents(flat(phx(2026, 9, 29, 0), phx(2026, 9, 29, 1), -2000), centsAt), 0);
  const gapped = [{ ts: phx(2026, 9, 29, 0), value: 1000 }, { ts: phx(2026, 9, 29, 2), value: 1000 }];
  assert.equal(pricedImportCents(gapped, centsAt), 0);
  assert.equal(pricedImportCents([], centsAt), null, 'no samples is unknown, not $0');
  assert.equal(pricedImportCents([{ ts: 0, value: 5 }], centsAt), null);
});

test('the scored span of a weekday night prices the overnight buy, the day and the governed on-peak', () => {
  // Window 23:00-05:00 at 15 kW, then a 1 kW house on grid until 21:00, on-peak included.
  const pts = [
    ...flat(phx(2026, 9, 28, 23), phx(2026, 9, 29, 5), 15000),
    ...flat(phx(2026, 9, 29, 5) + MIN, phx(2026, 9, 29, 21), 1000),
  ];
  const c = pricedImportCents(pts, centsAt)!;
  const expect = 6 * 15 * 12.59 + (11 + 2) * 16.91 + 3 * 44.2; // + the 1-min step at 05:00
  assert.ok(Math.abs(c - expect) < 5, `got ${c}, ~${expect}`);
  assert.ok(pts[pts.length - 1].ts - pts[0].ts === 22 * HOUR);
});

/* ══ integration pins ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('★★ the scorer writes realized_cost_cents from the assembly, over the house panel\'s series', () => {
  // v1.187.0 (review) — the supersede skip, the cost span and the coverage gate are tested
  // behaviourally in ledgerScorerAssembly.test.ts; this pins only the wiring.
  const b = fnBody('function scoreNightRow(');
  assert.ok(b.includes('const cols = assembleNightLedgerColumns({'));
  assert.ok(b.includes('    query: (metric, a, b) => recorder.query(shp2Sn, metric, a, b),'));
  assert.ok(b.includes('    rateAt: (t) => rateAt(tariffNow, t),'));
  assert.ok(b.includes('    scoreSpanEndMs: s.scoreSpanEnd,'));
  assert.ok(b.includes('    supersededBy,'));
  assert.ok(b.includes('realized_cost_cents: cols.cost.cents,'));
  assert.ok(b.includes('score_notes: `${scoreNotes} ${cols.notes}`,'), 'the cost clause reaches score_notes');
  // The counterfactual columns stay unwritten: no honest measurement exists.
  for (const col of ['counterfactual_cost_cents:', 'realized_savings_cents:', 'would_have_peak_imported:']) {
    assert.ok(!b.includes(col), `${col} is not written`);
  }
});
