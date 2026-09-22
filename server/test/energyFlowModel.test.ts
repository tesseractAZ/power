/**
 * v1.175.0 — the Energy flow card's arithmetic, run against the scenes it actually drew.
 *
 * The card's numbers now come from a pure web module (web/src/cards/energyFlowModel.ts),
 * imported here directly the same way webServerMembershipParity runs the web membership
 * code. Each scene below is built from recorded telemetry for 2026-09-22:
 *
 *   03:30  grid backstop  — main 1900.6 W, house 1904.4 W, Core AC out 0 W, packs +16 W.
 *                           The old card drew 1.9 kW INTO the batteries and 1.9 kW OUT of
 *                           them to the house: a grid-fed house shown running on battery.
 *   04:05  force charge   — main 19053 W, Core AC in 15969 W, Core AC out 0 W, house 1996 W.
 *   ~11:40 solar, no grid — main 0 W, Core AC out 14427 W, house 14356 W.
 *
 * The invariant every scene checks: the two edges INTO Loads (grid → house, Cores →
 * house) are both panel-side figures and sum to the Loads node — the arrow and the box
 * it points at can no longer disagree (the reported screenshot: 1925 W into "1.89 kW").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { energyFlowModel, FLOW_EDGE_MIN_W } from '../../web/src/cards/energyFlowModel.js';

type Any = any; // fixtures carry only the fields the model reads

function core(sn: string, o: { acIn?: number; acOut?: number; pv?: number; packNet?: number; soc?: number; online?: boolean } = {}): Any {
  const net = o.packNet ?? 0; // > 0 discharging
  return {
    sn, deviceName: sn, productName: 'Delta Pro Ultra', online: o.online ?? true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: o.soc ?? 60,
      pvTotalWatts: o.pv ?? 0, acInWatts: o.acIn ?? 0, acOutWatts: o.acOut ?? 0,
      packs: [{ num: 1, outputWatts: Math.max(0, net), inputWatts: Math.max(0, -net) }],
    },
  };
}

/** A six-circuit split-phase panel: 12 channels, paired 1↔3, 2↔4, 5↔7, 6↔8, 9↔11, 10↔12. */
function panel(sources: string[], circuitWatts: Array<number | null>): Any {
  const pairs: Array<[number, number]> = [[1, 3], [2, 4], [5, 7], [6, 8], [9, 11], [10, 12]];
  const circuits = circuitWatts.map((w, i) => ({ ch: i + 1, name: `Circuit ${i + 1}`, watts: w }));
  const pairedCircuits = pairs.map(([a, b]) => {
    const wa = circuitWatts[a - 1], wb = circuitWatts[b - 1];
    return { primaryCh: a, secondaryCh: b, name: `Pair ${a}`, watts: wa == null && wb == null ? null : (wa ?? 0) + (wb ?? 0) };
  });
  return {
    sn: 'SHP2', deviceName: 'SHP2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    projection: { kind: 'shp2', circuits, pairedCircuits, sources: sources.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })) },
  };
}

const grid = (homeGridWatts: number, importWatts: number): Any => ({ present: true, declared: true, backstopping: true, homeGridWatts, importWatts });

/** Spread a house total across the twelve channels (legs), like the live 9-of-12 split. */
function legs(total: number, live = 9): Array<number | null> {
  return Array.from({ length: 12 }, (_, i) => (i < live ? total / live : 0));
}

const devs = (...ds: Any[]) => Object.fromEntries(ds.map((d) => [d.sn, d]));
const HOME = ['C1', 'C2', 'C5'];

/* ══ the grid goes where it goes ══════════════════════════════════════════ */

test('★★★ 03:30 backstop: the grid feeds the HOUSE, not the batteries', () => {
  const m = energyFlowModel(
    devs(core('C1', { packNet: 5 }), core('C2', { packNet: 6 }), core('C5', { packNet: 5 }), panel(HOME, legs(1904.4))),
    grid(1900.6, 0),
  );
  assert.equal(m.gridState, 'active');
  assert.ok(m.gridToCoresW < FLOW_EDGE_MIN_W, 'no grid → batteries edge: nothing was charging them');
  assert.equal(m.gridToHouseW, m.load, 'the grid is the house\u2019s only source, so its edge IS the house load');
  assert.equal(m.coresToHouseW, 0, 'and batteries → loads draws nothing: the Cores output 0 W');
});

test('★★★ 04:05 force charge: the grid splits — Cores get their AC input, the house gets its load', () => {
  const m = energyFlowModel(
    devs(core('C1', { acIn: 5323 }), core('C2', { acIn: 5323 }), core('C5', { acIn: 5323 }), panel(HOME, legs(1996))),
    grid(19053, 15969),
  );
  assert.equal(m.gridToCoresW, 15969, 'grid → batteries is the Cores’ own input, not the metered total');
  assert.ok(Math.abs(m.gridToHouseW - 1996) < 0.01,
    'grid → loads is capped at the house: the ~1.1 kW the main and Core meters disagree by is not drawn as load');
  assert.equal(m.gridSupplyW, 19053, 'the grid NODE still shows the metered total at the main');
  assert.equal(m.coresToHouseW, 0, 'the charging Cores deliver nothing to the house');
});

test('midday solar: no grid edges, the Cores carry the house', () => {
  const m = energyFlowModel(
    devs(core('C1', { acOut: 4809, pv: 3000 }), core('C2', { acOut: 4809, pv: 3000 }), core('C5', { acOut: 4809, pv: 2540 }), panel(HOME, legs(14356))),
    grid(0, 0),
  );
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0);
  assert.ok(m.gridToCoresW < FLOW_EDGE_MIN_W);
  assert.equal(m.acOut, 14427, 'the Cores’ own inverter meter reads 71 W above the panel…');
  assert.equal(m.load, 14356);
  assert.equal(m.coresToHouseW, 14356,
    '★★★ …so the arrow is taken from the panel side and equals the box it points at (was Math.max → 14427 W into "14.36 kW")');
});

/* ══ the Loads node ═══════════════════════════════════════════════════════ */

test('★★★ a panel that reported no channel watts reads NULL, not a confident 0 W', () => {
  const m = energyFlowModel(devs(core('C1', { acOut: 900 }), core('C2'), core('C5'), panel(HOME, Array(12).fill(null))), grid(0, 0));
  assert.equal(m.load, null, 'twelve null channels are "not reporting", not "the house draws nothing"');
  assert.equal(m.coresToHouseW, 900, 'with no panel figure the arrow falls back to the Cores\u2019 own meter');
});

test('★★ with grid AND Cores feeding the house, each edge is bounded by its own meter', () => {
  // Evening: the grid tops up a house the Cores are partly carrying.
  const m = energyFlowModel(devs(core('C1', { acOut: 400 }), core('C2', { acOut: 400 }), core('C5', { acOut: 400 }), panel(HOME, legs(2600))), grid(1350, 0));
  assert.equal(m.gridToHouseW, 1350);
  assert.equal(m.coresToHouseW, 1200, 'the remainder is 1250 W, but never more than the Cores\u2019 inverters report');
  assert.ok(Math.abs(m.gridToHouseW + m.coresToHouseW - (m.load as number)) <= 50, 'with two sources the edges sum to the box within meter disagreement');
});

test('with NO panel at all (cold boot) the Cores’ AC output stands in for the house', () => {
  const m = energyFlowModel(devs(core('C1', { acOut: 1200 })), undefined);
  assert.equal(m.load, 1200);
});

test('★★ circuits are counted as circuits: nine energized legs on a six-circuit panel is not "9 circuits"', () => {
  // Legs 1..9 energized: pairs (1,3) (2,4) (5,7) (6,8) (9,11) live, (10,12) dark → 5 circuits.
  const m = energyFlowModel(devs(core('C1'), core('C2'), core('C5'), panel(HOME, legs(2000, 9))), grid(0, 0));
  assert.equal(m.liveCircuits, 5);
  const all = energyFlowModel(devs(core('C1'), panel(['C1'], legs(2400, 12))), grid(0, 0));
  assert.equal(all.liveCircuits, 6, 'a fully energized six-circuit panel reads 6, never 12');
});

test('without a pairing block the count falls back to channels (nothing better is known)', () => {
  const p = panel(HOME, legs(900, 3));
  p.projection.pairedCircuits = [];
  const m = energyFlowModel(devs(core('C1'), p), grid(0, 0));
  assert.equal(m.liveCircuits, 3);
});

/* ══ membership is unchanged ══════════════════════════════════════════════ */

test('an online bench Core is a spare: excluded from every flow, counted in the title', () => {
  const m = energyFlowModel(
    devs(core('C1', { acOut: 1000, pv: 800 }), core('C2'), core('C5'), core('BENCH', { acOut: 999, pv: 999 }), panel(HOME, legs(1000))),
    grid(0, 0),
  );
  assert.equal(m.dpuCount, 3);
  assert.equal(m.spareCount, 1);
  assert.equal(m.acOut, 1000);
  assert.equal(m.pv, 800);
});

test('an islanded home keeps the off state', () => {
  const m = energyFlowModel(devs(core('C1', { acOut: 500 }), panel(['C1'], legs(500))), { present: false, declared: false, backstopping: false, homeGridWatts: 0, importWatts: 0 } as Any);
  assert.equal(m.gridState, 'off');
  assert.equal(m.gridToHouseW, 0);
});

test('★★ the Cores’ import is subtracted before the house gets the rest — the cap alone does not hide it', () => {
  // An early charge with a light house: main 6000 W, Cores drawing 5000 W, house 2500 W.
  // Only 1000 W of the main reached the house through the panel directly; the other
  // 1500 W of the house came from the Cores. Without the subtraction the edge would claim
  // 2500 W (capped at the house) and the Cores' share would vanish.
  const m = energyFlowModel(
    devs(core('C1', { acIn: 1700, acOut: 500 }), core('C2', { acIn: 1650, acOut: 500 }), core('C5', { acIn: 1650, acOut: 500 }), panel(HOME, legs(2500))),
    grid(6000, 5000),
  );
  assert.equal(m.gridToCoresW, 5000);
  assert.equal(m.gridToHouseW, 1000);
  assert.equal(m.coresToHouseW, 1500);
  assert.equal(m.gridToHouseW + m.coresToHouseW, m.load);
});

/* ══ wiring: the card renders the model, not its own arithmetic ═══════════ */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('EnergyFlow.tsx draws every edge and the Loads node from the model', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const card = readFileSync(resolve(here, '../../web/src/cards/EnergyFlow.tsx'), 'utf8');
  for (const pin of [
    '} = energyFlowModel(devices, grid);',
    'watts={gridToCoresW}',
    'watts={gridToHouseW}',
    'watts={coresToHouseW}',
    "value={load == null ? '—' : fmtW(load)}",
    "panelState === 'frozen' ? 'panel data stale' : 'panel not reporting'",
    '`${liveCircuits} circuit${liveCircuits === 1 ? \'\' : \'s\'}`',
  ]) assert.ok(card.includes(pin), `the card must render from the model: missing ${pin}`);
  assert.ok(!card.includes('watts={Math.max(load, acOut)}'), 'the two-meter max no longer feeds an edge');
  assert.ok(!/\.circuits\.reduce\(/.test(card), 'the card no longer sums circuits itself');
});

/* ══ v1.175.0 review: meters that do not update together ══════════════════ */

test('★★★ 03:43 charge ramp: the main lags the Cores’ input — no phantom battery output, grid node covers its edges', () => {
  // Recorded 03:42:52-03:43:25: main held at 3406 W while Core AC-in climbed to 16275 W;
  // house 3410 W; Core AC-out 0 W. The first cut drew 3410 W OUT of the charging Cores.
  const m = energyFlowModel(
    devs(core('C1', { acIn: 5425 }), core('C2', { acIn: 5425 }), core('C5', { acIn: 5425 }), panel(HOME, legs(3410))),
    grid(3406, 0),
  );
  assert.equal(m.coresToHouseW, 0, 'the Cores’ inverters output nothing, so nothing leaves the Batteries');
  assert.equal(m.gridToHouseW, 3410, 'the house is on the grid');
  assert.equal(m.gridToCoresW, 16275);
  assert.ok(m.gridSupplyW >= m.gridToCoresW + m.gridToHouseW, 'the Grid node is never smaller than what leaves it (was "3.41 kW" beside a 16275 W edge)');
});

test('★★ 04:35 steady charge with a small negative meter residual: still no battery output', () => {
  // main 19103, Core AC-in 17947, house 1254 → main − input = 1156 < house: the first cut
  // drew the 98 W difference out of the charging Cores.
  const m = energyFlowModel(
    devs(core('C1', { acIn: 5983 }), core('C2', { acIn: 5982 }), core('C5', { acIn: 5982 }), panel(HOME, legs(1254))),
    grid(19103, 0),
  );
  assert.equal(m.coresToHouseW, 0);
  assert.equal(m.gridToHouseW, 1254);
});

test('★★★ a FROZEN panel (cloud shadow) is not reporting — the grid-fed house is not drawn out of the batteries', () => {
  // The server zeroes homeGridWatts for a shadowed panel; the channels still hold the frozen
  // 1904 W. The first cut paired them: grid "available" and 1.9 kW out of idle Cores.
  const p = panel(HOME, legs(1904.4));
  p.contentStaleSinceMs = Date.now() - 6 * 60_000;
  const m = energyFlowModel(devs(core('C1'), core('C2'), core('C5'), p), grid(0, 0));
  assert.equal(m.panelState, 'frozen');
  assert.equal(m.load, null, 'the Loads node reads "—" / "panel data stale"');
  assert.equal(m.coresToHouseW, 0);
  assert.equal(m.gridToHouseW, 0);
});

test('a frozen panel during a charge: the Cores’ live draw still shows, nothing phantom reaches the house', () => {
  const p = panel(HOME, legs(3000));
  p.contentStaleSinceMs = Date.now() - 60_000;
  const m = energyFlowModel(devs(core('C1', { acIn: 5300 }), core('C2', { acIn: 5300 }), core('C5', { acIn: 5300 }), p), grid(0, 0));
  assert.equal(m.gridState, 'active', 'the Cores’ own input proves the grid is flowing');
  assert.equal(m.gridToCoresW, 15900);
  assert.equal(m.coresToHouseW, 0);
});

test('an OFFLINE panel is frozen too', () => {
  const p = panel(HOME, legs(1500));
  p.online = false;
  const m = energyFlowModel(devs(core('C1', { acOut: 700 }), core('C2'), core('C5'), p), grid(0, 0));
  assert.equal(m.panelState, 'frozen');
  assert.equal(m.load, null);
  assert.equal(m.coresToHouseW, 700, 'with no panel figure the Cores’ own meter stands in');
});

test('★ a Core in a DISCONNECTED source slot is not counted in the grid draw of the Batteries node', () => {
  // Server importWatts sums every source SN; the node contains only isConnected ones. A
  // non-member charging at 1500 W must not be subtracted from the main as if it were a home Core.
  const p = panel(HOME, legs(2000));
  p.projection.sources.push({ slot: 4, sn: 'X', isConnected: false });
  const m = energyFlowModel(
    devs(core('C1'), core('C2'), core('C5'), core('X', { acIn: 1500 }), p),
    { present: true, declared: true, backstopping: true, homeGridWatts: 2000, importWatts: 1500 } as Any,
  );
  assert.equal(m.gridToCoresW, 0, 'the home Cores draw nothing');
  assert.equal(m.gridToHouseW, m.load, 'the whole house is on the grid (the non-member\u2019s 1500 W is not subtracted)');
  assert.equal(m.coresToHouseW, 0);
});

test('an idling inverter’s few watts beside a grid-fed house are meter noise, not drawn as delivery', () => {
  // Grid carries 1900 W of a 1903 W house; the Cores’ inverters idle at 50 W. The remainder
  // (3 W) is below the edge floor: no Batteries → Loads edge.
  const m = energyFlowModel(
    devs(core('C1', { acOut: 20 }), core('C2', { acOut: 15 }), core('C5', { acOut: 15 }), panel(HOME, legs(1903))),
    grid(1900, 0),
  );
  assert.equal(m.gridToHouseW, 1900);
  assert.equal(m.coresToHouseW, 0);
});
