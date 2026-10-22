/**
 * v1.190.2 — the dashboard's Today card (and the Solar tab's Today tile) while home Cores are dark.
 *
 * Live 2026-10-19 18:45 MST: every home Core cloud-offline since 10-14, the house on the batteries
 * (the pool at 38 % and falling, the three source slots delivering ~2.3 kW), and the card read
 * Solar produced 0 Wh, AC output 0 Wh, Batteries (net) 0 Wh "charged", Panel load 33.42 kWh,
 * "25% measured". It integrated the Cores' own sample series (pv_total, ac_out, pack in / out),
 * which v1.188.1 rightly stopped recording while a Core is dark, while the energy bridge booked
 * those quantities from the panel's slot meters into Home Assistant's Energy counters (that day:
 * solar 41.26 kWh, battery in 34.54, battery out 9.40 by 19:03).
 *
 * /api/summary/today now asks for the totals `bridged` (aggregator.computeTotals): each Core the
 * bridge metered counts the energy the bridge booked for it (the bridge_ledger rows the recorder
 * writes at each rollup) in place of its own samples over the bridge's own windows, and its own
 * samples elsewhere — so the card equals what the lifetime counters booked over the same day, with
 * no span counted twice across a hand-over. A figure with a panel-metered part says so, and the
 * "% measured" counts the slot meter's coverage. A normal day is byte-for-byte what it was.
 * Test serials are placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlant, near, MIN, H, PANEL, CORES, NAMEPLATE_WH } from './helpers/energyBridgePlant.js';
import { goldenStore, goldenRows, goldenWindows, phx, GOLDEN_CORES, GOLDEN_PANEL } from './fixtures/todayBridgeFixtures.js';
import { todayNotes, batterySub } from '../../web/src/cards/todayText.js';
import type { BridgeLedgerRow, BridgeRollupResult } from '../src/energyBridge.js';

const { Plant, cleanup } = await loadPlant('ef-today-bridge-');
// recorderStub.js loads energyBridge.ts, whose graph reaches config.ts (aggregator.ts → siteTime.ts since
// v1.191.0): imported after loadPlant has set DB_PATH, as the helper requires.
const { makeRecorderStub } = await import('./helpers/recorderStub.js');
const { computeTotals, integrateWh, integrateWhOutside, bridgedView } = await import('../src/aggregator.js');
const { bridgeLedgerRows, bridgePvSeenKey } = await import('../src/energyBridge.js');
const { createReadRecorder } = await import('../src/readRecorder.js');
const { buildReport } = await import('../src/reports.js');
test.after(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = phx(2026, 10, 19, 0);
const STEP_WH = NAMEPLATE_WH / 100; // no pack capacity recorded: the nameplate is the capacity
type P = InstanceType<typeof Plant>;

/** The card's figures (what /api/summary/today returns) for [sinceMs, untilMs]. */
const card = (p: P, sinceMs: number, untilMs: number) => computeTotals(p.store, p.rec, sinceMs, untilMs, { bridged: true });

/* ── every Core dark all day: the 2026-10-19 shape ─────────────────────────────────────────── */

/** Each slot over the day, W: out = what the Core delivers to the panel, pv = its PV (the field). */
function liveDay(t: number): { out: number; pv: number } {
  const h = (t - DAY) / H;
  if (h < 7) return { out: 1100, pv: 0 };      // night: the house on the batteries
  if (h < 17.5) return { out: 600, pv: 1800 }; // day: the PV charges the Cores while they supply 600 W
  if (h < 20) return { out: 1100, pv: 0 };     // evening on the batteries
  return { out: 0, pv: 0 };                    // at the reserve: the house on the grid
}

function darkDay(): { p: P; start: ReturnType<P['read']>; slotOutWh: number } {
  const p = new Plant(DAY - 30 * MIN);
  // Dark since before the restart (no projection), the three slots' PV fields trusted by an earlier
  // day's check — the live state.
  p.darkAtFirstSight();
  p.frozenProjection = false;
  for (let s = 1; s <= 3; s++) p.putLifetime(bridgePvSeenKey(PANEL, s), 2000, p.clock - 24 * H);
  p.restart();
  let stored = 0;
  let slotOutWh = 0;
  let prevOut: number | null = null;
  const shape = (t: number): void => {
    const { out, pv } = liveDay(t);
    p.sourceWatts = [-out, -out, -out];
    p.pvW = [pv, pv, pv];
    stored += (pv - out) / 60;
    p.pct = CORES.map(() => 65 + Math.floor(stored / STEP_WH));
    // The house: the three slots, and from the reserve on the grid (2.3 kW).
    p.sample(PANEL, 'panel_load', 3 * out + (out === 0 ? 2300 : 0), t);
    // The slot meter's outflow, as the trapezoid between minute rows integrates it.
    if (t > DAY && prevOut != null) slotOutWh += 3 * (prevOut + out) / 2 / 60;
    prevOut = out;
  };
  shape(p.clock);
  p.panelSamples(p.clock);
  p.run(30, shape); // to 00:00, a rollup on it
  const start = p.read();
  p.run(24 * 60, shape);
  return { p, start, slotOutWh };
}

test('★★★ every home Core dark all day (the 2026-10-19 shape: slots delivering at night, PV by day, then the grid at the reserve): Solar, AC output and Batteries (net) are the bridged energy — exactly the lifetime counters\' deltas over the day; "% measured" counts the slot meters', () => {
  const { p, start, slotOutWh } = darkDay();
  try {
    const end = p.read();
    const t = card(p, DAY, p.clock);
    const pv = end.pv - start.pv;
    const chg = end.chg - start.chg;
    const dsg = end.dsg - start.dsg;
    assert.ok(pv > 3 * 1800 * 10 && chg > 3 * 1200 * 10 && dsg > 3 * 1100 * 9, `the counters booked the day: pv ${pv} in ${chg} out ${dsg}`);
    // ★★★ The card equals what was booked (Home Assistant's daily change of the three counters).
    near(t.fleet.pvWh, pv, 0.01, 'Solar produced = the daily change of PV production');
    near(t.fleet.batteryChargeWh, chg, 0.01, 'battery in = the daily change of Battery Energy In');
    near(t.fleet.batteryDischargeWh, dsg, 0.01, 'battery out = the daily change of Battery Energy Out');
    near(t.fleet.batteryNetWh, dsg - chg, 0.01, 'Batteries (net) = out − in');
    assert.ok(t.fleet.batteryNetWh < 0, 'charged over the day');
    // AC output: the slots' outflow (the Cores' AC delivered to the panel).
    near(t.fleet.acOutWh, slotOutWh, 1, 'AC output = ∫ the slots\' outflow');
    // The bridge's share is named, all of it measured at the panel (the fields trusted: no lower bound).
    const b = t.fleet.bridged!;
    assert.ok(b, 'fleet.bridged present');
    assert.deepEqual(b.cores, [...CORES].sort());
    near(b.pvWh, pv, 0.01, 'all of the day\'s solar came through the bridge');
    assert.equal(b.pvInferredWh, 0);
    assert.equal(b.windows.night + b.windows.measured, 3 * 288, 'one window per Core per rollup');
    assert.ok(b.windows.measured > 3 * 120 && b.windows.night > 3 * 120, JSON.stringify(b.windows));
    assert.deepEqual(todayNotes(b), { solar: 'via panel', acOut: 'via panel', battery: 'via panel' });
    assert.equal(batterySub(t.fleet.batteryNetWh, todayNotes(b).battery), 'charged · via panel');
    // ★★ "% measured": the panel and three Cores metered at their slots (the card read 25 %).
    assert.ok(t.fleet.homeCoverage > 0.99, `homeCoverage ${t.fleet.homeCoverage}`);
    assert.ok(t.fleet.pvCoverage > 0.99, `pvCoverage ${t.fleet.pvCoverage}`);
    // ★★ What the card read before (the totals without the bridge): every Core figure 0, 25 %.
    const before = computeTotals(p.store, p.rec, DAY, p.clock);
    assert.deepEqual([before.fleet.pvWh, before.fleet.acOutWh, before.fleet.batteryNetWh], [0, 0, 0]);
    near(before.fleet.homeCoverage, 0.25, 0.001, 'the panel measured, the three Cores not');
    assert.equal(before.fleet.bridged, undefined);
    // ★★ The analytics worker's read-only recorder reads the same ledger, so the endpoint (which runs
    // there) returns the same figures.
    const ro = createReadRecorder(process.env.DB_PATH);
    try {
      assert.deepEqual(ro.bridgeLedger(DAY, p.clock), p.rec.bridgeLedger(DAY, p.clock), 'the two recorders\' reads agree');
      const viaWorker = computeTotals(p.store, ro, DAY, p.clock, { bridged: true });
      assert.equal(JSON.stringify(viaWorker.fleet), JSON.stringify(t.fleet));
    } finally { ro.close(); }
  } finally { p.close(); }
});

test('★★ the report registry and /api/summary/today ask for the bridged totals; the other callers (the vendor ledger, the reconnect report) do not', async () => {
  const p = new Plant(phx(2026, 10, 16, 1));
  try {
    p.darkAtFirstSight();
    p.frozenProjection = false;
    p.sourceWatts = [-1000, -1000, -1000];
    p.panelSamples(p.clock);
    p.rec.rollupLifetime();
    const t0 = p.clock;
    p.run(30);
    const ctx = { recorder: p.rec, snapshot: p.store.get(), log: () => {} };
    const bridged = await buildReport('totals', ctx, { sinceMs: t0, untilMs: p.clock, bridged: true }) as ReturnType<typeof computeTotals>;
    const own = await buildReport('totals', ctx, { sinceMs: t0, untilMs: p.clock }) as ReturnType<typeof computeTotals>;
    assert.ok(bridged.fleet.bridged, 'bridged: the booked share');
    near(bridged.fleet.batteryDischargeWh, 3 * 1000 / 2, 1, 'half an hour of three slots at 1 kW');
    assert.equal(own.fleet.bridged, undefined, 'without the option: the Cores\' own meters only');
    assert.equal(own.fleet.batteryDischargeWh, 0);
  } finally { p.close(); }
  const idx = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
  const handler = idx.slice(idx.indexOf("app.get<{ Querystring: { since?: string; until?: string } }>('/api/summary/today'"));
  assert.ok(handler.slice(0, 1200).includes("analytics.report('totals', { sinceMs: since, untilMs: until, bridged: true })"), 'the Today endpoint asks for the bridged totals');
  // (v1.191.0 — the vendor ledger's day is the site day, [dayStart, the next site midnight).)
  assert.ok(idx.includes("analytics.report('totals', { sinceMs: dayStart, untilMs: siteDayStartMs(today) })"), 'the vendor-ledger comparison keeps the Cores\' own meters');
  const tile = readFileSync(resolve(HERE, '../../web/src/cards/TodaySummary.tsx'), 'utf8');
  assert.ok(tile.includes('const notes = todayNotes(data?.fleet.bridged);'), 'the card reads the bridged share');
  assert.ok(tile.includes('sub={notes.solar ?? undefined}') && tile.includes('sub={notes.acOut ?? undefined}') && tile.includes('batterySub(data.fleet.batteryNetWh, notes.battery)'), 'and marks each figure');
  const solar = readFileSync(resolve(HERE, '../../web/src/pages/SolarPanel.tsx'), 'utf8');
  assert.ok(solar.includes('const solarNote = todayNotes(summary?.fleet.bridged).solar;'), 'the Solar tab\'s Today tile too');
});

/* ── a mixed day: reporting, dark, reporting again ─────────────────────────────────────────── */

test('★★★ a mixed day (reporting, dark — its own MQTT readings recorded for an hour while the bridge still meters the slot — then reporting again): no span counted twice at either hand-over; the card equals the counters\' deltas', () => {
  const p = new Plant(DAY - 30 * MIN);
  try {
    p.establishHeld(); // the Cores report; held values exist (to 23:35)
    const acOut = [1100, 1100, 1100];
    let stored = 0;
    /** Each minute: the slots and the Cores' own AC output rows (the recorder's gate writes them for
     *  a Core that reports), the slots' percentage following the stored energy. */
    const own = (t: number, extra = false): void => {
      const night = (t - DAY) / H < 7;
      const w = night ? 1100 : 600;
      p.sourceWatts = [-w, -w, -w];
      CORES.forEach((sn, i) => { acOut[i] = w; });
      stored += (night ? -1100 : 1200) / 60;
      p.pct = CORES.map(() => 80 + Math.floor(stored / STEP_WH));
      p.sample(PANEL, 'panel_load', 3 * w, t);
      CORES.forEach((sn, i) => {
        const reports = p.online[sn] && !p.frozen.has(sn);
        if (reports || extra) {
          p.sample(sn, 'ac_out', acOut[i], t);
          p.sample(sn, 'total_in', p.corePv[i], t);
          p.sample(sn, 'total_out', acOut[i], t);
        }
        if (extra) p.ownRows(sn, t); // MQTT data recorded while the cloud lists the Core offline
      });
    };
    p.coreBatW = [1100, 1100, 1100];
    p.run(25, (t) => own(t)); // to 00:00, a rollup on it
    const start = p.read();
    p.run(60, (t) => own(t)); // 00:00-01:00 on their own meters
    p.goDark([-1100, -1100, -1100]); // 01:00: cloud-offline
    p.run(60, (t) => own(t));
    // 02:00-03:00: their MQTT data arrives while the cloud still lists them offline — their own rows are
    // recorded, the bridge keeps metering the slots (marked, not handed back), the counters cut the
    // Cores' own rows there.
    p.run(60, (t) => { own(t, true); p.mqttWhileOffline(); });
    const at3 = card(p, DAY, p.clock);
    // ★★ Between rollups the bridge's last window is still open: the own rows since are left out too.
    p.run(2, (t) => { own(t, true); p.mqttWhileOffline(); });
    const at302 = card(p, DAY, p.clock);
    near(at302.fleet.batteryDischargeWh, at3.fleet.batteryDischargeWh, 1e-6, 'two minutes of own pack rows inside the open window are not counted');
    near(at302.fleet.acOutWh, at3.fleet.acOutWh, 1e-6, 'nor their AC output');
    p.run(3, (t) => own(t));
    p.run(175, (t) => own(t)); // to 06:00, dark
    // 06:00: back online; the publishers read every 30 s (readEach), so the hand-over absorbs at once.
    p.coreBatW = [-1200, -1200, -1200];
    p.corePv = [0, 0, 0];
    p.setOnline(true);
    p.run(360, (t) => {
      p.corePv = (t - DAY) / H >= 7 ? [1800, 1800, 1800] : [0, 0, 0];
      own(t);
    }, { readEach: true });
    const end = p.read();
    assert.equal(p.rec.batteryLifetimeDebug().bridge.markers.length, 0, 'handed back');
    const t = card(p, DAY, p.clock);
    const pv = end.pv - start.pv;
    const chg = end.chg - start.chg;
    const dsg = end.dsg - start.dsg;
    assert.ok(pv > 3 * 1800 * 4.9, `PV from 07:00 on their own meters: ${pv}`);
    near(t.fleet.pvWh, pv, 1, 'Solar produced = the daily change of PV production');
    // Battery: the counters read the BMS registers on the reporting spans, the card the pack power
    // rows (the plant moves both alike); the hand-over absorbed the dark span's register jump.
    near(t.fleet.batteryDischargeWh, dsg, 1, 'battery out = the daily change of Battery Energy Out (the MQTT hour once)');
    near(t.fleet.batteryChargeWh, chg, 1, 'battery in = the daily change of Battery Energy In');
    // ★★ The own pack rows recorded 02:01-03:02 (3 × 1.1 kW for 61 min) are inside the bridged span:
    // without the cut they would have been counted beside the bridge.
    const ownOnly = computeTotals(p.store, p.rec, DAY, p.clock);
    const inside = 3 * 1100 * 61 / 60;
    near(ownOnly.fleet.batteryDischargeWh + t.fleet.bridged!.dischargeWh - t.fleet.batteryDischargeWh, inside, 1, 'the bridged span replaces the own rows inside it');
    // AC output: own 00:00-01:00 and 06:00-12:00, the slots 01:00-06:00.
    const expectAc = 3 * (1100 * 1 + 1100 * 5 + 1100 * 1 + 600 * 5);
    near(t.fleet.acOutWh, expectAc, 3 * 1100 / 60 * 2, 'AC output');
    const b = t.fleet.bridged!;
    assert.deepEqual([b.windows.measured, b.windows.inferred, b.windows.unbridgeable], [0, 0, 0], 'every bridged window at night');
    for (const sn of CORES) {
      const span = p.rec.bridgeLedger(DAY, p.clock).rows.filter((r) => r.sn === sn).reduce((x, r) => x + (r.untilMs - r.sinceMs), 0);
      assert.equal(span, 5 * H, `${sn}: metered at its slot from the flip at 01:00 to the last rollup before its return at 06:00`);
    }
    assert.deepEqual(todayNotes(b), { solar: null, acOut: 'via panel', battery: 'via panel' }, 'no daylight bridged: Solar is the Cores\' own');
    assert.ok(t.fleet.homeCoverage > 0.99, `homeCoverage ${t.fleet.homeCoverage}`);
  } finally { p.close(); }
});

/* ── the inferred basis: a lower bound, labelled ─────────────────────────────────────────────── */

test('★★ daylight, every Core dark, the panel PV field unchecked (reading 0 W while the Cores charge): Solar is the inferred lower bound the counters booked, and says so', () => {
  const t0 = phx(2026, 10, 15, 9);
  const p = new Plant(t0);
  try {
    p.darkAtFirstSight();
    p.frozenProjection = false;
    p.sourceWatts = [-300, -300, -300];
    p.pct = [40, 40, 40];
    p.panelSamples(t0);
    p.rec.rollupLifetime();
    const before = p.read();
    let mins = 0;
    p.run(120, () => { mins += 1; p.pct = CORES.map(() => 40 + Math.floor(mins / 8)); });
    const after = p.read();
    const t = card(p, t0, p.clock);
    near(t.fleet.pvWh, after.pv - before.pv, 0.01, 'the booked solar');
    near(t.fleet.batteryNetWh, (after.dsg - before.dsg) - (after.chg - before.chg), 0.01, 'the booked battery net');
    const b = t.fleet.bridged!;
    assert.ok(b.windows.inferred > 0 && b.pvInferredWh > 1000, JSON.stringify(b));
    near(b.pvInferredWh, b.pvWh, 0.01, 'all of it on the inferred basis');
    assert.equal(todayNotes(b).solar, 'via panel · lower bound');
  } finally { p.close(); }
});

/* ── the ledger rows ──────────────────────────────────────────────────────────────────────── */

test('★★ bridgeLedgerRows: one row per metered window, its booked figures; a held rollup writes none; a window the Core\'s own meters counted is not a bridged window; one that booked nothing keeps its span, with zeros', () => {
  const base = { sinceMs: 1000, untilMs: 301_000, pvWh: 0, gridImportWh: 0, chargeWh: 0, dischargeWh: 0 };
  const w = (over: Partial<BridgeRollupResult['slots'][number]>) => ({ panelSn: PANEL, slot: 1, sn: CORES[0], sinceMs: 1000, basis: 'night' as const, acOutWh: 90, acInWh: 0, pvWh: 0, outWh: 90, inWh: 0, coverageMs: 300_000, ...over });
  const r: BridgeRollupResult = {
    ...base,
    slots: [
      w({}),
      w({ slot: 2, sn: CORES[1], basis: 'unbridgeable', reason: 'the window cannot be inferred (re-anchored)', acOutWh: 40, acInWh: 5 }),
      w({ slot: 3, sn: CORES[2], basis: 'unbridgeable', own: true, inWh: 7, outWh: 3 }),
      w({ slot: 1, sn: 'Y711XXX00XXX0009', sinceMs: 301_000 }), // no time in the window
    ],
  };
  const rows = bridgeLedgerRows(r);
  assert.deepEqual(rows, [
    { sn: CORES[0], panelSn: PANEL, slot: 1, sinceMs: 1000, untilMs: 301_000, basis: 'night', pvWh: 0, acOutWh: 90, acInWh: 0, chargeWh: 0, dischargeWh: 90, coveredMs: 300_000 },
    { sn: CORES[1], panelSn: PANEL, slot: 2, sinceMs: 1000, untilMs: 301_000, basis: 'unbridgeable', pvWh: 0, acOutWh: 0, acInWh: 0, chargeWh: 0, dischargeWh: 0, coveredMs: 0 },
  ]);
  assert.deepEqual(bridgeLedgerRows({ ...r, held: true }), []);
});

test('★★ the recorder writes one ledger row per bridged Core per rollup, at the rollup instant, and both recorders read them back', () => {
  const p = new Plant(phx(2026, 10, 16, 1));
  try {
    p.darkAtFirstSight();
    p.frozenProjection = false;
    p.sourceWatts = [-1000, -1000, -1000];
    p.panelSamples(p.clock);
    p.rec.rollupLifetime();
    const t0 = p.clock;
    p.run(30);
    const l = p.rec.bridgeLedger(t0, p.clock);
    assert.equal(l.rows.length, 3 * 6);
    assert.equal(l.watermarkMs, p.clock);
    for (const row of l.rows) {
      assert.equal(row.basis, 'night');
      assert.equal(row.untilMs - row.sinceMs, 5 * MIN);
      assert.equal((row.untilMs - t0) % (5 * MIN), 0, 'at a rollup instant');
      near(row.dischargeWh, 1000 * 5 / 60, 0.01, 'the window\'s booked battery out');
      assert.equal(row.coveredMs, 5 * MIN);
    }
    assert.equal(p.rec.bridgeLedger(p.clock, p.clock + H).rows.length, 0, 'nothing after the last rollup');
    const ro = createReadRecorder(process.env.DB_PATH);
    try { assert.deepEqual(ro.bridgeLedger(t0, p.clock), l); } finally { ro.close(); }
  } finally { p.close(); }
});

/* ── the window arithmetic ────────────────────────────────────────────────────────────────── */

test('★★ bridgedView: a window counts at its rollup instant (one straddling the start whole, one still open at the end not yet); spans merge, are clipped, and the last one runs on to the read while the bridge still meters the Core', () => {
  const row = (sn: string, sinceMs: number, untilMs: number, over: Partial<BridgeLedgerRow> = {}): BridgeLedgerRow => ({
    sn, panelSn: PANEL, slot: 1, sinceMs, untilMs, basis: 'night', pvWh: 0, acOutWh: 10, acInWh: 0, chargeWh: 0, dischargeWh: 10, coveredMs: untilMs - sinceMs, ...over,
  });
  const [A, B] = CORES;
  const rows = [
    row(A, 0, 300), row(A, 300, 600), row(A, 900, 1200, { basis: 'inferred', pvWh: 7, dischargeWh: 3 }),
    row(B, 0, 300, { basis: 'unbridgeable', acOutWh: 0, dischargeWh: 0, coveredMs: 0 }), row(B, 300, 600),
  ];
  const v = bridgedView({ rows, watermarkMs: 1200 }, 150, 1100)!;
  // Booked by 1100: A's two first windows (the first straddles the start: whole), B's two; A's third is not.
  near(v.totals.dischargeWh, 10 + 10 + 0 + 10, 1e-9, 'discharge');
  assert.deepEqual(v.totals.windows, { night: 3, measured: 0, inferred: 0, unbridgeable: 1 });
  assert.equal(v.totals.pvInferredWh, 0);
  assert.deepEqual(v.cuts.get(A), [[150, 600], [900, 1100]], 'clipped, merged; the open window runs to the read');
  assert.deepEqual(v.cuts.get(B), [[150, 600]], 'B\'s last window is not the watermark: closed');
  near(v.coveredMs.get(A)!, 150 + 300 + 200, 1e-9, 'coverage by overlap');
  near(v.coveredMs.get(B)!, 300, 1e-9, 'a window that booked nothing covers nothing');
  const full = bridgedView({ rows, watermarkMs: 1200 }, 0, 1200)!;
  assert.equal(full.totals.pvInferredWh, 7);
  assert.equal(full.totals.windows.inferred, 1);
  assert.equal(bridgedView({ rows, watermarkMs: 1200 }, 1200, 2000), null, 'no window in the range');
  assert.equal(bridgedView({ rows: [], watermarkMs: 0 }, 0, 2000), null);
  // integrateWhOutside: the pieces between the spans, under integrateWh's rules.
  const pts = Array.from({ length: 61 }, (_, i) => ({ ts: i * MIN, value: 600 }));
  const whole = integrateWh(pts, 0, 60 * MIN);
  const o = integrateWhOutside(pts, 0, 60 * MIN, [[10 * MIN, 20 * MIN], [30 * MIN, 40 * MIN]]);
  near(whole.wh, 600, 1e-9, 'an hour at 600 W');
  near(o.wh, 600 * 40 / 60, 1e-9, 'forty minutes outside the two spans');
  assert.equal(o.coverageMs, 40 * MIN);
  near(integrateWhOutside(pts, 0, 60 * MIN, []).wh, whole.wh, 1e-9, 'no span: the whole window');
  assert.equal(integrateWhOutside(pts, 0, 60 * MIN, [[0, 60 * MIN]]).wh, 0, 'all of it metered at the slot');
});

/* ── a normal day: byte for byte ──────────────────────────────────────────────────────────── */

const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/todayBridge.golden.json'), 'utf8')) as { generatedAt: string; totals: Record<string, string> };

test('★★★ a normal day (every home Core on its own meter, nothing bridged) is byte-for-byte the payload before v1.190.2 — with and without the bridged option, and with bridge windows on either side of it', () => {
  const rows = goldenRows();
  const query = (sn: string, metric: string, s: number, u: number) => (rows.get(`${sn}|${metric}`) ?? []).filter((x) => x.ts >= s && x.ts <= u);
  const d = phx(2026, 10, 13, 0);
  // Windows a bridged Core had the day before and after (an outage that ended at 23:55 and one that
  // began after the day): none of them falls in any golden window.
  const around: BridgeLedgerRow[] = [
    { sn: GOLDEN_CORES[0], panelSn: GOLDEN_PANEL, slot: 1, sinceMs: d - 10 * MIN, untilMs: d - 5 * MIN, basis: 'night', pvWh: 0, acOutWh: 90, acInWh: 0, chargeWh: 0, dischargeWh: 90, coveredMs: 5 * MIN },
    { sn: GOLDEN_CORES[1], panelSn: GOLDEN_PANEL, slot: 2, sinceMs: d + 24 * H, untilMs: d + 24 * H + 5 * MIN, basis: 'night', pvWh: 0, acOutWh: 90, acInWh: 0, chargeWh: 0, dischargeWh: 90, coveredMs: 5 * MIN },
  ];
  const recs = [
    makeRecorderStub({ query }),
    makeRecorderStub({ query, bridgeLedger: (s, u) => ({ rows: around.filter((r) => r.untilMs > s && r.sinceMs < u), watermarkMs: d + 24 * H + 5 * MIN }) }),
  ];
  const labels = Object.keys(GOLDEN.totals);
  assert.equal(labels.length, 4);
  for (const w of goldenWindows()) {
    for (const rec of recs) {
      for (const bridged of [undefined, false, true]) {
        const got = JSON.stringify(computeTotals(goldenStore(), rec, w.sinceMs, w.untilMs, bridged === undefined ? undefined : { bridged }));
        assert.equal(got, GOLDEN.totals[w.label], `${w.label} (bridged ${bridged})`);
      }
    }
  }
});

test('★★ the panel notes: none without a bridged window; a night-only bridged span leaves Solar unmarked; measured, inferred and mixed solar say which', () => {
  const b = (windows: Partial<{ night: number; measured: number; inferred: number; unbridgeable: number }>, pvInferredWh = 0) => ({
    pvWh: 1, acOutWh: 1, acInWh: 0, chargeWh: 0, dischargeWh: 1, pvInferredWh, cores: [CORES[0]],
    windows: { night: 0, measured: 0, inferred: 0, unbridgeable: 0, ...windows },
  });
  assert.deepEqual(todayNotes(undefined), { solar: null, acOut: null, battery: null });
  assert.deepEqual(todayNotes(b({ unbridgeable: 4 })), { solar: null, acOut: null, battery: null }, 'metered, nothing booked: nothing came from the panel');
  assert.deepEqual(todayNotes(b({ night: 4 })), { solar: null, acOut: 'via panel', battery: 'via panel' });
  assert.equal(todayNotes(b({ night: 4, measured: 2 })).solar, 'via panel');
  assert.equal(todayNotes(b({ inferred: 2 }, 300)).solar, 'via panel · lower bound');
  assert.equal(todayNotes(b({ measured: 3, inferred: 2 }, 300)).solar, 'via panel · partly a lower bound');
  assert.equal(todayNotes(b({ inferred: 2 }, 0)).solar, 'via panel', 'an inferred window that booked no solar bounds nothing');
  assert.equal(batterySub(500, null), 'discharged');
  assert.equal(batterySub(-500, null), 'charged');
  assert.equal(batterySub(0, 'via panel'), 'charged · via panel');
  assert.equal(batterySub(1, 'via panel'), 'discharged · via panel');
});
