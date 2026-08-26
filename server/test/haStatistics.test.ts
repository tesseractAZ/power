import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportMessage, noonPhoenixIso, VENDOR_STAT_SERIES, HA_STATS_SOURCE } from '../src/haStatistics.js';
import { computeLocalPackRte, RTE_MIN_DAY_CHARGE_WH, MIN_RTE_SAMPLE_DAYS } from '../src/energyHistory.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.89.0 — B1 (HA statistics export) payload builder + B2 (pack-DC RTE).
 * The builder's contracts: cumulative sums in day order, null days SKIPPED
 * (never zero-filled — an unfetched day must not flatten the sum), external
 * ids under the ecoflow_panel source, one hourly row per day at noon Phoenix.
 * ═════════════════════════════════════════════════════════════════════════ */

const day = (ymd: string, over: Record<string, unknown> = {}): any => ({
  day: ymd, fetchedAtMs: 0, homeWh: 90_000, gridWh: 30_000, solarWh: 60_000,
  generatorWh: 0, batteryInWh: 10_000, batteryOutWh: 50_000, circuits: [],
  local: null, driftHomePct: null, driftSolarPct: null, ...over,
});

test('B1: cumulative sums in day order, whatever order the store hands back', () => {
  const series = VENDOR_STAT_SERIES.find((s) => s.id.endsWith('vendor_home_energy'))!;
  const msg = buildImportMessage(series, [day('2026-08-17'), day('2026-08-15'), day('2026-08-16')]);
  assert.ok(msg);
  assert.equal(msg!.metadata.statistic_id, `${HA_STATS_SOURCE}:vendor_home_energy`);
  assert.equal(msg!.metadata.source, HA_STATS_SOURCE);
  // v1.108.0 — HA 2026.x warns when import_statistics omits the unit class.
  assert.equal(msg!.metadata.unit_class, 'energy');
  // v1.109.0 — the ACTUAL 2026.11 deprecation: mean_type (0 = NONE, sum-only).
  assert.equal(msg!.metadata.mean_type, 0);
  assert.deepEqual(msg!.stats.map((s) => s.start), [
    noonPhoenixIso('2026-08-15'), noonPhoenixIso('2026-08-16'), noonPhoenixIso('2026-08-17'),
  ]);
  assert.deepEqual(msg!.stats.map((s) => s.sum), [90_000, 180_000, 270_000]);
});

test('B1: a null day is SKIPPED — the sum never flattens through an unfetched day', () => {
  const series = VENDOR_STAT_SERIES.find((s) => s.id.endsWith('vendor_home_energy'))!;
  const msg = buildImportMessage(series, [day('2026-08-15'), day('2026-08-16', { homeWh: null }), day('2026-08-17')]);
  assert.equal(msg!.stats.length, 2);
  assert.deepEqual(msg!.stats.map((s) => s.sum), [90_000, 180_000]);
  // and a series with NO usable days builds no message at all
  assert.equal(buildImportMessage(series, [day('2026-08-15', { homeWh: null })]), null);
});

test('B1: noon Phoenix is 19:00 UTC year-round (no DST in Arizona)', () => {
  assert.equal(noonPhoenixIso('2026-08-15'), '2026-08-15T19:00:00+00:00');
  assert.equal(noonPhoenixIso('2026-01-15'), '2026-01-15T19:00:00+00:00');
});

test('B2: pack-DC RTE needs meaningful charge days and the sample floor; basis is declared', () => {
  const rteDay = (c: number | null, x: number | null) =>
    day('2026-08-15', { local: { panelLoadWh: null, pvWh: null, batteryChargeWh: c, batteryDischargeWh: x } });
  // 4 qualifying days (floor 5) → null
  const four = Array.from({ length: 4 }, () => rteDay(50_000, 48_000));
  assert.equal(computeLocalPackRte(four).packDcRte, null);
  // 5 qualifying → 240/250 = 0.96 (a plausible pack-DC number — ABOVE the 0.86 AC dispatch assumption)
  const five = [...four, rteDay(50_000, 48_000)];
  const r = computeLocalPackRte(five);
  assert.equal(r.packDcRte, 0.96);
  assert.equal(r.basis, 'pack-dc');
  assert.equal(r.sampleDays, MIN_RTE_SAMPLE_DAYS);
  // a trickle-charge day (< RTE_MIN_DAY_CHARGE_WH) never qualifies
  assert.equal(computeLocalPackRte([...five, rteDay(RTE_MIN_DAY_CHARGE_WH - 1, 90_000)]).sampleDays, 5);
  // null flows are excluded, never treated as zero
  assert.equal(computeLocalPackRte([rteDay(null, 5_000)]).sampleDays, 0);
});
