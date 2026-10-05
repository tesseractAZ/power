/**
 * v1.187.10 — the greedy dispatch plan tops the pack off from the grid only AHEAD of a peak,
 * and only at the cheapest rate before it.
 *
 * Its deficit branch imported in every off-peak hour while the pool sat below the 80%
 * pre-peak target, whether or not any on-peak hour lay ahead, at whatever rate. The live
 * 2026-10-03 plan (a Saturday: APS R-EV has no on-peak and no overnight tier on weekends)
 * imported for 12 h at 16.91 c with the pack at 76-79%, while Sunday's PV later filled it to
 * 100% and the night-charge engine bought nothing. By the same rule a weekday evening imported
 * 19:00-23:00 at 16.91 c ahead of the 12.59 c overnight tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The confirmed APS R-EV table (rateTableUnify.test.ts): set before analytics is loaded.
Object.assign(process.env, {
  TARIFF_APS_RATES_CONFIRMED: 'true',
  TARIFF_APS_ONPEAK_SUMMER_CENTS: '44.20',
  TARIFF_APS_ONPEAK_WINTER_CENTS: '39.5',
  TARIFF_APS_OFFPEAK_SUMMER_CENTS: '16.91',
  TARIFF_APS_OFFPEAK_WINTER_CENTS: '17.0',
  TARIFF_APS_OVERNIGHT_CENTS: '12.59',
  TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '8.2',
});
const { computeDispatchPlan, dispatchTopOffHours, resetForecastCachesForTesting } = await import('../src/analytics.js');

const H = 3_600_000;
/** UTC ms of a Phoenix (UTC-7, no DST) wall-clock hour. */
const phx = (y: number, mo: number, d: number, h: number) => Date.UTC(y, mo - 1, d, h + 7);
const panel = (fullWh: number, remainWh: number, reservePct: number) => ({
  SHP2: {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
    projection: { kind: 'shp2', backupFullCapWh: fullWh, backupRemainWh: remainWh, backupReserveSoc: reservePct, pairedCircuits: [] },
  },
}) as any;
/** 24 hourly slots from `startMs`; PV `pvW` in Phoenix hours 8-15, a flat `loadW`. */
const horizon = (startMs: number, loadW: number, pvW: number) => ({
  generatedAt: Date.now(), hasWeather: true, historyDays: 30, reserveSoc: 16,
  forecastPvWhNext24: 0, typicalPvWhPerDay: 0, minProjectedSoc: null, minProjectedSocTs: null,
  hours: Array.from({ length: 24 }, (_, k) => {
    const ts = startMs + k * H;
    const hod = new Date(ts - 7 * H).getUTCHours();
    return { ts, forecastPvW: hod >= 8 && hod < 16 ? pvW : 0, forecastLoadW: loadW, cloudCoverPct: 0, ghiWm2: 0, projectedSocPct: null, modelled: true };
  }),
}) as any;
const hodOf = (ts: number) => new Date(ts - 7 * H).getUTCHours();
const impliedCents = (h: { hourlyCostDollars: number; flowW: number }) => (h.hourlyCostDollars / (h.flowW / 1000)) * 100;

test('★★★ a weekend horizon (no on-peak anywhere) never imports while the pack is above its reserve', () => {
  // The 10-03 shape: Saturday 18:00 → Sunday 17:00, the pool at 75% of 92.16 kWh, 16% reserve,
  // a 3 kW night and an 8 kW solar day.
  resetForecastCachesForTesting();
  const plan = computeDispatchPlan(panel(92_160, 69_120, 16), horizon(phx(2026, 8, 8, 18), 3_000, 8_000));
  assert.equal(plan.hours.length, 24);
  assert.ok(plan.hours.every((h) => !h.onPeak), 'no on-peak hour in the horizon');
  const imports = plan.hours.filter((h) => h.action === 'grid_import');
  assert.deepEqual(imports.map((h) => hodOf(h.ts)), [], 'the defect: 12 h of 16.91 c import with the pack at 76-79%');
  for (const h of plan.hours) {
    if (h.loadW > h.pvW) assert.equal(h.action, 'discharge_to_load', `hour ${hodOf(h.ts)} carries the house from the pack`);
    assert.ok(h.socEndPct >= 16, `never below the reserve (hour ${hodOf(h.ts)}: ${h.socEndPct}%)`);
  }
  assert.ok(plan.hours.some((h) => h.action === 'charge_from_pv'), 'the solar day refills it');
});

test('★★★ a weekday evening tops off only in the 12.59 c overnight tier, never at 16.91 c', () => {
  // Tuesday 19:00 → Wednesday 18:00: 60% of 60 kWh, 20% reserve, 2 kW load, 6 kW solar day;
  // Wednesday 16:00-19:00 is on-peak.
  resetForecastCachesForTesting();
  const plan = computeDispatchPlan(panel(60_000, 36_000, 20), horizon(phx(2026, 8, 4, 19), 2_000, 6_000));
  assert.deepEqual(plan.hours.filter((h) => h.onPeak).map((h) => hodOf(h.ts)), [16, 17, 18], 'the peak lies ahead');
  const imports = plan.hours.filter((h) => h.action === 'grid_import');
  assert.deepEqual(imports.map((h) => hodOf(h.ts)), [23, 0, 1, 2, 3, 4], 'the top-off is the overnight tier, all of it');
  for (const h of imports) {
    // hourlyCostDollars is rounded to the cent, so the implied rate carries ±0.2 c.
    assert.ok(Math.abs(impliedCents(h) - 12.59) < 0.5, `hour ${hodOf(h.ts)} priced ${impliedCents(h).toFixed(2)} c`);
    assert.ok(h.flowW > h.loadW, 'a top-off draws more than the house load');
  }
  for (const hod of [19, 20, 21, 22, 5, 6, 7]) {
    const h = plan.hours.find((x) => hodOf(x.ts) === hod)!;
    assert.equal(h.action, 'discharge_to_load', `${hod}:00 is 16.91 c — the pack carries it, the cheaper tier refills`);
  }
  for (const hod of [16, 17, 18]) assert.equal(plan.hours.find((x) => hodOf(x.ts) === hod)!.action, 'discharge_to_load');
});

/* ══ the pure rule ══════════════════════════════════════════════════════════ */

const off = (rateCents: number) => ({ onPeak: false, rateCents });
const on = (rateCents = 44.2) => ({ onPeak: true, rateCents });

test('★★ top-off hours: the cheapest of the off-peak run before each on-peak hour', () => {
  // 19-22 off-peak, 23-04 overnight, 05-15 off-peak, 16-18 on-peak.
  const day = [...Array(4).fill(off(16.91)), ...Array(6).fill(off(12.59)), ...Array(11).fill(off(16.91)), on(), on(), on()];
  const t = dispatchTopOffHours(day);
  assert.deepEqual(t.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [4, 5, 6, 7, 8, 9]);
});

test('★★ no on-peak hour later in the horizon ⇒ no top-off at all', () => {
  assert.deepEqual(dispatchTopOffHours(Array(24).fill(off(16.91))), Array(24).fill(false));
  // The run AFTER the last peak is not topped off either.
  const t = dispatchTopOffHours([off(12.59), on(), off(12.59), off(12.59)]);
  assert.deepEqual(t, [true, false, false, false]);
});

test('★ an unconfirmed (flat off-peak) table tops off in every off-peak hour ahead of a peak; each run is judged on its own', () => {
  assert.deepEqual(dispatchTopOffHours([off(16.91), off(16.91), on(), on()]), [true, true, false, false]);
  // Two peaks: the second run's cheapest is its own.
  const t = dispatchTopOffHours([off(16.91), off(12.59), on(), off(16.91), off(14), on()]);
  assert.deepEqual(t, [false, true, false, false, true, false]);
  assert.deepEqual(dispatchTopOffHours([]), []);
});
