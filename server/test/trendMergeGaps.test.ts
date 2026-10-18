/**
 * v1.188.1 (review) — the Overview trend charts show a held device's gap as a break, not as its
 * last reading painted flat.
 *
 * The history endpoint omits a bucket with no sample, and since the freshness gate a device the
 * EcoFlow cloud lists offline has no rows at all. TrendChart merged its series onto the union of
 * their timestamps carrying each series' last value forward without bound, and drew `connectNulls`:
 * a held Core sat flat at its last value across the gap while a sibling reported, and a one-device
 * chart drew one straight segment across it. The merge is now web/src/charts/trendMerge.ts (pure),
 * tested here; the chart's wiring is pinned at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTrendSeries, trendGapMs, TREND_GAP_MS, type TrendPoint } from '../../web/src/charts/trendMerge.js';

const MIN = 60_000;
const H = 60 * MIN;
const A = { key: 'COREXXX00XXX0001|pv_total', label: 'Core 1 PV' };
const B = { key: 'COREXXX00XXX0002|pv_total', label: 'Core 2 PV' };
const every = (from: number, to: number, stepMs: number, v: (ts: number) => number): TrendPoint[] => {
  const out: TrendPoint[] = [];
  for (let ts = from; ts <= to; ts += stepMs) out.push({ ts, value: v(ts) });
  return out;
};

/** v0.22.0's merge, verbatim in effect: the last value carried forward without bound. */
function legacyMerge(series: Array<{ key: string; label: string }>, data: Record<string, TrendPoint[]>) {
  const all = new Set<number>();
  const idx: Record<string, Map<number, number>> = {};
  for (const s of series) {
    const m = new Map<number, number>();
    for (const p of data[s.key] ?? []) { all.add(p.ts); if (!m.has(p.ts)) m.set(p.ts, p.value); }
    idx[s.key] = m;
  }
  const last: Record<string, number | null> = {};
  for (const s of series) last[s.key] = null;
  return [...all].sort((a, b) => a - b).map((ts) => {
    const row: Record<string, number | null> = { ts };
    for (const s of series) { if (idx[s.key].has(ts)) last[s.key] = idx[s.key].get(ts)!; row[s.label] = last[s.key]; }
    return row;
  });
}

test('trendGapMs — two heartbeats, or two buckets when the buckets are longer', () => {
  assert.equal(TREND_GAP_MS, 10 * MIN);
  assert.equal(trendGapMs(), 10 * MIN);
  assert.equal(trendGapMs(60), 10 * MIN, 'the Overview charts (60 s buckets)');
  assert.equal(trendGapMs(900), 30 * MIN);
});

test('★★★ a Core held for 2 h while its sibling reports: null across the gap, not its last value', () => {
  const data = {
    [A.key]: [...every(0, 2 * H, MIN, (t) => 2000 + (t / MIN) % 300), ...every(4 * H, 5 * H, MIN, (t) => 2500 + (t / MIN) % 7)],
    [B.key]: every(0, 5 * H, MIN, (t) => 2300 + (t / MIN) % 500),
  };
  const rows = mergeTrendSeries([A, B], data, trendGapMs(60));
  const inGap = rows.filter((r) => r.ts! > 2 * H && r.ts! < 4 * H);
  assert.ok(inGap.length >= 119);
  assert.ok(inGap.every((r) => r[A.label] === null), '★★★ no value is drawn for the held Core');
  assert.ok(inGap.every((r) => typeof r[B.label] === 'number'), 'the sibling is unchanged');
  const legacy = legacyMerge([A, B], data).filter((r) => r.ts! > 2 * H && r.ts! < 4 * H);
  assert.equal(new Set(legacy.map((r) => r[A.label])).size, 1, 'v0.22.0 painted the last pre-hold value flat across it');
});

test('★★ a constant metric restated every 5 min is carried between its heartbeats, exactly as before', () => {
  const data = {
    [A.key]: every(0, 2 * H, 5 * MIN, () => 0),
    [B.key]: every(0, 2 * H, MIN, (t) => 900 + (t / MIN) % 13),
  };
  const rows = mergeTrendSeries([A, B], data, trendGapMs(60));
  assert.ok(rows.every((r) => r[A.label] === 0), 'no break between two heartbeats');
  assert.deepEqual(rows, legacyMerge([A, B], data), '★★ gap-free data merges byte for byte as before');
});

test('★★ a one-series chart breaks across a gap: a null row is placed just inside it', () => {
  const data = { [A.key]: [...every(0, H, MIN, (t) => t / MIN), ...every(3 * H, 4 * H, MIN, (t) => t / MIN)] };
  const rows = mergeTrendSeries([A], data, trendGapMs(60));
  const brk = rows.filter((r) => r.ts! > H && r.ts! < 3 * H);
  assert.deepEqual(brk, [{ ts: H + 1, [A.label]: null }], 'one break row, so the line does not run straight across');
  assert.equal(rows.length, data[A.key].length + 1);
});

test('★★ a hold still running: carried for at most the gap after its newest point, then null', () => {
  const data = {
    [A.key]: every(0, H, MIN, (t) => 2000 + (t / MIN) % 50),
    [B.key]: every(0, 3 * H, MIN, (t) => 2300 + (t / MIN) % 50),
  };
  const rows = mergeTrendSeries([A, B], data, trendGapMs(60));
  const lastA = data[A.key][data[A.key].length - 1];
  for (const r of rows.filter((x) => x.ts! > H)) {
    assert.equal(r[A.label], r.ts! - H <= 10 * MIN ? lastA.value : null, `ts +${(r.ts! - H) / MIN} min`);
  }
});

test('before a series\' first point it is null; a duplicated ts keeps its first value', () => {
  const data = { [A.key]: [{ ts: 5 * MIN, value: 1 }, { ts: 5 * MIN, value: 9 }, { ts: 6 * MIN, value: 2 }], [B.key]: every(0, 6 * MIN, MIN, () => 7) };
  const rows = mergeTrendSeries([A, B], data);
  assert.equal(rows[0][A.label], null);
  assert.equal(rows.find((r) => r.ts === 5 * MIN)![A.label], 1);
});

test('SOURCE PIN: TrendChart merges with trendMerge and draws nulls as breaks', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src/charts/TrendChart.tsx'), 'utf8');
  assert.ok(src.includes('mergeTrendSeries(series.map((s) => ({ key: `${s.sn}|${s.metric}`, label: s.label })), dataBySeries, trendGapMs(bucketSec))'));
  assert.ok(!/connectNulls/.test(src.replace(/\/\/.*$/gm, '')), 'no connectNulls on the Areas');
  assert.ok(!src.includes('lastBy['), 'the unbounded carry-forward is gone');
});
