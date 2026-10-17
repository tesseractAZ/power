/**
 * v1.188.1 — the Energy flow card with the Cores' own meters absent and the panel fresh.
 *
 * Live 2026-10-16 20:04 MST: every Core had been cloud-offline since 10-14 23:52 (no DPU
 * projection in the snapshot). The panel was fresh: main (gridWatt) 0 W, snapshot.grid
 * {importWatts 0, homeGridWatts 0, importLive false, present true, panelFresh true}, its three
 * source slots −1145, −1145 and −1119 W (delivering; isConnected, dpuStale), the house 3.39 kW
 * and the pool falling 92 → 86 % since 18:30. The card drew "GRID 3.39 kW importing" and a
 * 3390 W grid → Loads edge beside "Batteries (0 DPU) — idle": with no Core reporting, the
 * Cores' AC output summed to 0 and the house-on-grid rule took that as "the Cores deliver
 * nothing", so the grid was given the whole house.
 *
 * Fixtures carry fake serials and only the fields the model reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { energyFlowModel, batteriesTitle, batteriesSubtitle, solarSubtitle } from '../../web/src/cards/energyFlowModel.js';
import { fmtW } from '../../web/src/format.js';

type Any = any; // fixtures carry only the fields the model reads

/** A Core that reports on its own meter. */
function core(sn: string, o: { acIn?: number; acOut?: number; packNet?: number; soc?: number; pv?: number } = {}): Any {
  const net = o.packNet ?? 0; // > 0 discharging
  return {
    sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: o.soc ?? 60, pvTotalWatts: o.pv ?? 0, acInWatts: o.acIn ?? 0, acOutWatts: o.acOut ?? 0,
      packs: [{ num: 1, outputWatts: Math.max(0, net), inputWatts: Math.max(0, -net) }],
    },
  };
}

/** A cloud-offline Core as the snapshot carries it: listed, offline, no projection. */
const darkCore = (sn: string): Any => ({ sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: false, lastUpdated: Date.now() - 45 * 3600_000 });

interface Slot { sn: string; w?: number; pct?: number; connected?: boolean; dpuStale?: boolean; dpuFrozen?: boolean }

/** A six-circuit panel whose source slots carry the panel's own per-slot meter (sourceWatts).
 *  `silent`: every channel watts null. `readbackFresh`: the server's verdict on the panel. */
function panel(
  slots: Slot[], houseW: number,
  o: { sourceWatts?: number[]; sn?: string; silent?: boolean; readbackFresh?: boolean; housePanel?: boolean } = {},
): Any {
  // Three loaded channels in exact thirds of a whole-watt house (no floating-point residue).
  const third = Math.floor(houseW / 3);
  const legs = [houseW - 2 * third, third, third];
  const circuits = Array.from({ length: 12 }, (_, i) => ({ ch: i + 1, name: `Circuit ${i + 1}`, watts: o.silent ? null : legs[i] ?? 0 }));
  return {
    sn: o.sn ?? 'PANEL-TEST-01', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: Date.now(),
    contentStaleSinceMs: null,
    ...(o.readbackFresh != null ? { readbackFresh: o.readbackFresh } : {}),
    ...(o.housePanel ? { housePanel: true } : {}),
    projection: {
      kind: 'shp2', circuits, pairedCircuits: [],
      sources: slots.map((s, i) => ({
        slot: i + 1, sn: s.sn, isConnected: s.connected ?? true, batteryPercentage: s.pct ?? null,
        ...(s.dpuStale != null ? { dpuStale: s.dpuStale } : {}),
        ...(s.dpuFrozen != null ? { dpuFrozen: s.dpuFrozen } : {}),
      })),
      sourceWatts: o.sourceWatts ?? slots.map((s) => s.w ?? 0),
    },
  };
}

/** snapshot.grid as the server sent it at 20:04 (main and Core import both 0). */
const grid = (homeGridWatts = 0, importWatts = 0): Any => ({
  present: true, backstopping: true, importLive: homeGridWatts >= 100, declared: true,
  importWatts, homeGridWatts, shp2GridConnected: true, presenceUnknown: false, panelFresh: true, vetoClearable: false,
});

const devs = (...ds: Any[]) => Object.fromEntries(ds.map((d) => [d.sn, d]));

/** The 20:04 plant: five Cores dark, three of them in the panel's slots. */
const LIVE_SLOTS: Slot[] = [
  { sn: 'CORE-A', w: -1145, pct: 86, dpuStale: true },
  { sn: 'CORE-B', w: -1145, pct: 86, dpuStale: true },
  { sn: 'CORE-C', w: -1119, pct: 85, dpuStale: true },
];
const liveDevices = (slots = LIVE_SLOTS, houseW = 3390, o: { sourceWatts?: number[] } = {}) => devs(
  darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), darkCore('CORE-D'), darkCore('CORE-E'),
  panel(slots, houseW, o),
);

/* ══ the 10-16 20:04 shape ════════════════════════════════════════════════ */

test('★★★ 10-16 20:04: no Core reporting, panel fresh, main 0 W — no grid import; the batteries carry the house', () => {
  const m = energyFlowModel(liveDevices(), grid(0, 0));
  assert.equal(m.panelState, 'ok');
  assert.equal(m.gridState, 'standby', 'the main measured 0 W: the grid is available, not importing (was "GRID 3.39 kW importing")');
  assert.equal(m.gridToHouseW, 0, 'no grid → Loads edge (was 3390 W)');
  assert.equal(m.gridToCoresW, 0);
  assert.equal(m.gridSupplyW, 0);
  assert.ok(Math.abs(m.coresToHouseW - 3390) < 0.01, `batteries → Loads carries the house (got ${m.coresToHouseW})`);
  assert.equal(m.gridToHouseW + m.coresToHouseW, m.load, 'the arrows into Loads sum to the box');
  assert.equal(m.acOut, 3409, 'the Cores’ AC output is the panel’s meter of their three slots');
  assert.equal(m.batNet, 3409, 'and the Batteries node shows it leaving them (was "idle")');
  assert.equal(m.viaPanelCount, 3);
  assert.equal(m.dpuCount, 0);
  assert.ok(m.soc != null && Math.abs(m.soc - (86 + 86 + 85) / 3) < 1e-9, `the slots’ battery percentages (got ${m.soc})`);
  assert.equal(batteriesTitle(m), 'Batteries (3 via panel)', 'three Cores in the node, seen through the panel (was "Batteries (0 DPU)")');
  assert.equal(batteriesSubtitle(m), '▼ 3.41 kW out');
});

test('★★★ the same shape with no slot figures in the frame: still no grid import — the measured main is drawn, nothing is inferred', () => {
  const m = energyFlowModel(liveDevices(LIVE_SLOTS, 3390, { sourceWatts: [] }), grid(0, 0));
  assert.equal(m.viaPanelCount, 0);
  assert.equal(m.gridState, 'standby', 'no Core’s own meter says it delivers nothing, and the main reads 0 W');
  assert.equal(m.gridToHouseW, 0);
  assert.equal(m.coresToHouseW, 0, 'nothing measured the Cores either: no edge is invented for them');
  assert.equal(m.load, 3390, 'the Loads node still shows what the panel measured');
  assert.equal(batteriesTitle(m), 'Batteries (0 DPU)');
  assert.equal(batteriesSubtitle(m), 'idle');
});

test('★★ a slot whose Core is absent from the account entirely is drawn via the panel too', () => {
  const m = energyFlowModel(devs(panel(LIVE_SLOTS.map((s) => ({ ...s, dpuStale: false })), 3390)), grid(0, 0));
  assert.equal(m.viaPanelCount, 3);
  assert.equal(m.gridToHouseW, 0);
  assert.ok(Math.abs(m.coresToHouseW - 3390) < 0.01);
});

/* ══ grid import with the Cores offline ═══════════════════════════════════ */

test('★★★ real grid import with the Cores offline: main 3 kW, slots idle — the grid carries the house', () => {
  const slots = LIVE_SLOTS.map((s) => ({ ...s, w: 0 }));
  const m = energyFlowModel(liveDevices(slots, 3000), grid(3000, 0));
  assert.equal(m.gridState, 'active');
  assert.equal(m.gridToHouseW, 3000);
  assert.equal(m.coresToHouseW, 0);
  assert.equal(m.gridSupplyW, 3000, 'the Grid node is the measured main');
  assert.equal(m.viaPanelCount, 3);
  assert.equal(batteriesSubtitle(m), 'idle');
});

test('★★ grid and panel-metered Cores share the house: the slots’ share, the grid the rest', () => {
  const slots = LIVE_SLOTS.map((s) => ({ ...s, w: -400 }));
  const m = energyFlowModel(liveDevices(slots, 2600), grid(1400, 0));
  assert.equal(m.gridState, 'active');
  assert.equal(m.coresToHouseW, 1200);
  assert.equal(m.gridToHouseW, 1400);
  assert.equal(m.gridSupplyW, 1400);
});

test('★★ a force charge with the Cores offline: the slots’ input is the grid → Batteries edge', () => {
  const slots = LIVE_SLOTS.map((s) => ({ ...s, w: 5300 }));
  const m = energyFlowModel(liveDevices(slots, 2000), grid(19053, 0));
  assert.equal(m.gridToCoresW, 15900, 'the panel meters 5.3 kW into each Core');
  assert.equal(m.gridToHouseW, 2000);
  assert.equal(m.coresToHouseW, 0);
  assert.equal(m.gridSupplyW, 19053, 'main and edges agree within tolerance: the node keeps the main');
  assert.equal(m.batNet, -15900);
  assert.equal(batteriesSubtitle(m), '▲ 15.90 kW in');
});

test('★★★ every Core via the panel, slots idle, main 0 W: the frame measured no grid, so none is drawn', () => {
  // An incoherent frame (3 kW of house, nothing measured feeding it). The pre-fix rule put the
  // house on the grid; with no Core's own meter the inference has nothing to stand on.
  const slots = LIVE_SLOTS.map((s) => ({ ...s, w: 0 }));
  const m = energyFlowModel(liveDevices(slots, 3000), grid(0, 0));
  assert.equal(m.viaPanelCount, 3);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0);
  assert.equal(m.coresToHouseW, 0);
});

/* ══ mixed: some Cores on their own meters ════════════════════════════════ */

test('★★ two Cores report idle, the third is offline delivering through the panel — the house is not put on the grid', () => {
  const p = panel([{ sn: 'CORE-A', w: 0 }, { sn: 'CORE-B', w: 0 }, { sn: 'CORE-C', w: -1500, pct: 70, dpuStale: true }], 1500);
  const m = energyFlowModel(devs(core('CORE-A', { soc: 60 }), core('CORE-B', { soc: 60 }), darkCore('CORE-C'), p), grid(0, 0));
  assert.equal(m.dpuCount, 2);
  assert.equal(m.viaPanelCount, 1);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0, 'was 1500 W: the two idle Cores read as the whole fleet');
  assert.equal(m.coresToHouseW, 1500);
  assert.ok(m.soc != null && Math.abs(m.soc - (60 + 60 + 70) / 3) < 1e-9, 'one value per Core: two own, one from its slot');
  assert.equal(batteriesTitle(m), 'Batteries (2 DPU, 1 via panel)');
  assert.equal(batteriesSubtitle(m), '▼ 1.50 kW out');
});

test('★★ a Core that reports keeps its own meter: its slot is not counted again', () => {
  // The panel's frame lags the Cores' ~10 s meters; here it still shows each slot at −2500 W.
  const p = panel([{ sn: 'CORE-A', w: -2500 }, { sn: 'CORE-B', w: -2500 }, { sn: 'CORE-C', w: -2500 }], 4000);
  const m = energyFlowModel(
    devs(core('CORE-A', { acOut: 1000, packNet: 1000 }), core('CORE-B', { acOut: 1000, packNet: 1000 }), core('CORE-C', { acOut: 1000, packNet: 1000 }), p),
    grid(1000, 0),
  );
  assert.equal(m.viaPanelCount, 0);
  assert.equal(m.acOut, 3000);
  assert.equal(m.batNet, 3000);
  assert.equal(m.coresToHouseW, 3000);
  assert.equal(m.gridToHouseW, 1000);
  assert.equal(batteriesSubtitle(m), '▼ 3.00 kW discharging', 'every Core on its own meter: the pack wording is unchanged');
});

test('★★ 09-21 22:55 hand-over with the panel frame still showing the Cores delivering: the fresher meter still wins', () => {
  // The Cores' own meters already read 0; the panel's frame (slots still −1712 W) is a minute old.
  const p = panel([{ sn: 'CORE-A', w: -1712 }, { sn: 'CORE-B', w: -1712 }, { sn: 'CORE-C', w: -1713 }], 5137);
  const m = energyFlowModel(devs(core('CORE-A'), core('CORE-B'), core('CORE-C'), p), grid(0, 0));
  assert.equal(m.gridState, 'active', 'the Cores deliver nothing on their own meters and the house draws 5 kW: it is on the grid');
  assert.equal(m.gridToHouseW, m.load);
  assert.equal(m.coresToHouseW, 0);
});

test('★★ a connected Core with no figure from either meter is unknown, not idle: the house is not inferred onto the grid', () => {
  // CORE-C is offline and the frame carries no figure for its slot.
  const p = panel([{ sn: 'CORE-A' }, { sn: 'CORE-B' }, { sn: 'CORE-C', dpuStale: true }], 3000, { sourceWatts: [0, 0] });
  const m = energyFlowModel(devs(core('CORE-A'), core('CORE-B'), darkCore('CORE-C'), p), grid(0, 0));
  assert.equal(m.viaPanelCount, 0);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0, 'was 3000 W');
  // ...and once the slot has a figure, the inference stands on the Cores again.
  const p2 = panel([{ sn: 'CORE-A' }, { sn: 'CORE-B' }, { sn: 'CORE-C', w: 0, dpuStale: true }], 3000);
  const m2 = energyFlowModel(devs(core('CORE-A'), core('CORE-B'), darkCore('CORE-C'), p2), grid(0, 0));
  assert.equal(m2.gridState, 'active');
  assert.equal(m2.gridToHouseW, 3000);
});

/* ══ what is not read ═════════════════════════════════════════════════════ */

test('★ a DISCONNECTED slot is not drawn via the panel', () => {
  const p = panel([{ sn: 'CORE-A', w: -1000 }, { sn: 'CORE-B', w: -1000 }, { sn: 'CORE-X', w: -3000, connected: false }], 2000);
  const m = energyFlowModel(devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-X'), p), grid(0, 0));
  assert.equal(m.viaPanelCount, 2);
  assert.equal(m.acOut, 2000);
  assert.equal(m.batNet, 2000);
});

test('★★★ a FROZEN panel’s slots are not read: its figures are not a reading', () => {
  const frozen = liveDevices();
  (frozen['PANEL-TEST-01'] as Any).contentStaleSinceMs = Date.now() - 6 * 60_000;
  const m = energyFlowModel(frozen, grid(0, 0));
  assert.equal(m.panelState, 'frozen');
  assert.equal(m.viaPanelCount, 0);
  assert.equal(m.coresToHouseW, 0);
  assert.equal(m.batNet, 0);
  assert.equal(m.soc, null);
  // ...and the server's panelFresh:false verdict freezes them the same way.
  const stale = energyFlowModel(liveDevices(), { ...grid(0, 0), panelFresh: false });
  assert.equal(stale.panelState, 'frozen');
  assert.equal(stale.viaPanelCount, 0);
  assert.equal(stale.coresToHouseW, 0);
});

/* ══ labels and wiring ════════════════════════════════════════════════════ */

test('the Batteries labels keep their wording while every Core reports', () => {
  assert.equal(batteriesTitle({ dpuCount: 3, viaPanelCount: 0, spareCount: 1, membershipUnknown: false }), 'Batteries (3 DPU, +1 spare)');
  assert.equal(batteriesTitle({ dpuCount: 2, viaPanelCount: 0, spareCount: 0, membershipUnknown: true }), 'Batteries (2 DPU, spares not yet identified)');
  assert.equal(batteriesTitle({ dpuCount: 2, viaPanelCount: 1, spareCount: 1, membershipUnknown: false }), 'Batteries (2 DPU, 1 via panel, +1 spare)');
  assert.equal(batteriesTitle({ dpuCount: 0, viaPanelCount: 3, spareCount: 1, membershipUnknown: false }), 'Batteries (3 via panel, +1 spare)');
  assert.equal(batteriesTitle({ dpuCount: 0, viaPanelCount: 0, spareCount: 0, membershipUnknown: false }), 'Batteries (0 DPU)');
  assert.equal(batteriesSubtitle({ batNet: 1200, viaPanelCount: 0 }), '▼ 1.20 kW discharging');
  assert.equal(batteriesSubtitle({ batNet: -800, viaPanelCount: 0 }), '▲ 800 W charging');
  assert.equal(batteriesSubtitle({ batNet: 3, viaPanelCount: 0 }), 'idle');
  assert.equal(batteriesSubtitle({ batNet: -800, viaPanelCount: 2 }), '▲ 800 W in');
});

test('EnergyFlow.tsx renders the Batteries labels from the model helpers', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const card = readFileSync(resolve(here, '../../web/src/cards/EnergyFlow.tsx'), 'utf8');
  for (const pin of [
    'title={batteriesTitle({ dpuCount, viaPanelCount, spareCount, membershipUnknown })}',
    'subtitle={batteriesSubtitle({ batNet, viaPanelCount })}',
  ]) assert.ok(card.includes(pin), `the card must render from the model: missing ${pin}`);
  assert.ok(!card.includes('discharging`'), 'the card no longer builds the battery wording itself');
});

/* ══ v1.188.1 review — a Core listed online on a FROZEN meter ═══════════════ */

/** The 20:04 slots, their Cores listed online on a frozen meter (the server's dpuFrozen verdict). */
const FROZEN_SLOTS: Slot[] = LIVE_SLOTS.map((s) => ({ ...s, dpuStale: false, dpuFrozen: true }));

test('★★★ the 20:04 shape with the Cores listed ONLINE on frozen meters (acOut 0): still no grid import', () => {
  // A quota fetch that keeps failing (setDeviceError keeps the Core listed online, its projection
  // frozen), or the cloud replaying its cached body: its frozen acOut of 0 W read as "the Cores
  // deliver nothing", and the card drew the 10-16 picture again.
  const m = energyFlowModel(
    devs(core('CORE-A'), core('CORE-B'), core('CORE-C'), darkCore('CORE-D'), darkCore('CORE-E'), panel(FROZEN_SLOTS, 3390)),
    grid(0, 0),
  );
  assert.equal(m.gridState, 'standby', 'was "GRID 3.39 kW importing"');
  assert.equal(m.gridToHouseW, 0, 'was 3390 W');
  assert.equal(m.gridSupplyW, 0);
  assert.ok(Math.abs(m.coresToHouseW - 3390) < 0.01, `batteries → Loads carries the house (got ${m.coresToHouseW})`);
  assert.equal(m.acOut, 3409, 'the frozen Cores are read from their slots');
  assert.equal(m.batNet, 3409);
  assert.equal(m.dpuCount, 0, 'no Core is on its own meter');
  assert.equal(m.viaPanelCount, 3);
  assert.ok(m.soc != null && Math.abs(m.soc - (86 + 86 + 85) / 3) < 1e-9, `the slots’ percentages, not the frozen 60 % (got ${m.soc})`);
  assert.equal(batteriesTitle(m), 'Batteries (3 via panel)', 'was "Batteries (3 DPU)"');
  assert.equal(batteriesSubtitle(m), '▼ 3.41 kW out', 'was "idle"');
});

test('★★★ Cores frozen while DELIVERING after the house moved to the grid: the main carries the house, not their old output', () => {
  // Frozen at 1145/1145/1119 W of output; the panel's live frame: slots 0, main 3390, house 3390.
  const m = energyFlowModel(
    devs(
      core('CORE-A', { acOut: 1145, packNet: 1145 }), core('CORE-B', { acOut: 1145, packNet: 1145 }), core('CORE-C', { acOut: 1119, packNet: 1119 }),
      panel(FROZEN_SLOTS.map((s) => ({ ...s, w: 0 })), 3390),
    ),
    grid(3390, 0),
  );
  assert.equal(m.gridState, 'active');
  assert.equal(m.gridToHouseW, 3390, 'was 0 W');
  assert.equal(m.coresToHouseW, 0, 'was 3390 W from the frozen acOut');
  assert.equal(m.gridSupplyW, 3390, 'the Grid node is the measured main (was 0 W)');
  assert.equal(m.acOut, 0);
  assert.equal(m.batNet, 0);
  assert.equal(batteriesSubtitle(m), 'idle', 'was "▼ 3.41 kW discharging"');
});

test('★★ one Core frozen beside two that report idle: it is read from its slot, and the house is not put on the grid', () => {
  const p = panel([{ sn: 'CORE-A', w: 0 }, { sn: 'CORE-B', w: 0 }, { sn: 'CORE-C', w: -1500, pct: 70, dpuFrozen: true }], 1500);
  const m = energyFlowModel(devs(core('CORE-A', { pv: 300 }), core('CORE-B', { pv: 200 }), core('CORE-C', { pv: 900 }), p), grid(0, 0));
  assert.equal(m.dpuCount, 2);
  assert.equal(m.viaPanelCount, 1);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0, 'was 1500 W: the frozen Core’s 0 W read as idle');
  assert.equal(m.coresToHouseW, 1500);
  assert.equal(batteriesTitle(m), 'Batteries (2 DPU, 1 via panel)');
  assert.equal(m.pv, 500, 'the frozen Core’s 900 W of PV is not a reading');
  assert.equal(m.pvUnreported, 1);
  assert.equal(solarSubtitle(m), '2 of 3 Cores');
});

test('★★★ every Core frozen, its slot idle, main 0 W: no Core’s own meter, so the house is not inferred onto the grid', () => {
  // The panel-only frame of 'every Core via the panel, slots idle' above, reached through frozen
  // Cores that are still listed online and projected: the inference keys on the Cores read on their
  // own meters, not on the Cores the account lists.
  const m = energyFlowModel(
    devs(core('CORE-A'), core('CORE-B'), core('CORE-C'), panel(FROZEN_SLOTS.map((s) => ({ ...s, w: 0 })), 3000)),
    grid(0, 0),
  );
  assert.equal(m.viaPanelCount, 3);
  assert.equal(m.gridState, 'standby');
  assert.equal(m.gridToHouseW, 0);
});

test('★★ frozen Cores behind a frozen panel: nothing is drawn from either, their frozen figures included', () => {
  const ds = devs(core('CORE-A', { acOut: 1145, packNet: 1145, soc: 60 }), core('CORE-B'), core('CORE-C'), panel(FROZEN_SLOTS, 3390));
  (ds['PANEL-TEST-01'] as Any).contentStaleSinceMs = Date.now() - 6 * 60_000;
  const m = energyFlowModel(ds, grid(0, 0));
  assert.equal(m.panelState, 'frozen');
  assert.equal(m.viaPanelCount, 0);
  assert.equal(m.dpuCount, 0);
  assert.equal(m.acOut, 0, 'the frozen 1145 W is not drawn');
  assert.equal(m.coresToHouseW, 0);
  assert.equal(m.batNet, 0);
  assert.equal(m.soc, null);
  assert.equal(m.gridState, 'standby', 'and no grid import is inferred from Cores that are not reporting');
});

/* ══ v1.188.1 review — a SECOND panel whose reading is not fresh ════════════ */

test('★★★ a second panel listed online with a stale quota freezes the card: its slots are not drawn as live delivery', () => {
  // The house panel is fresh (its Core reports 0 W, main 1500 W, house 1500 W). The second panel is
  // online and unshadowed, but its quota stopped refreshing 3 h ago (server: readbackFresh false);
  // its slot still reads −2000 W from then, for a Core that is cloud-offline.
  const house = panel([{ sn: 'CORE-A', w: 0 }], 1500, { housePanel: true, readbackFresh: true });
  const second = panel([{ sn: 'CORE-X', w: -2000, pct: 88, dpuStale: true }], 2000, { sn: 'PANEL-TEST-02', readbackFresh: false });
  const m = energyFlowModel(devs(core('CORE-A'), darkCore('CORE-X'), house, second), grid(1500, 0));
  assert.equal(m.panelState, 'frozen', 'was ok: grid.panelFresh judges only the house panel');
  assert.equal(m.viaPanelCount, 0, 'was 1');
  assert.equal(m.acOut, 0, 'was 2000');
  assert.equal(m.coresToHouseW, 0, 'was 2000');
  assert.equal(m.load, null, 'a load half live, half frozen is neither');
  assert.equal(m.soc, 60, 'the 3-hour-old 88 % is not averaged in');
  // ...and the same panel, fresh, is read.
  const fresh = energyFlowModel(devs(core('CORE-A'), darkCore('CORE-X'), house, { ...second, readbackFresh: true }), grid(1500, 0));
  assert.equal(fresh.panelState, 'ok');
  assert.equal(fresh.viaPanelCount, 1);
  assert.equal(fresh.coresToHouseW, 2000);
});

/* ══ v1.188.1 review — a SILENT panel's slots ═══════════════════════════════ */

test('★★ a SILENT panel (every channel null) with slot figures: its slots are not read either', () => {
  const ds = devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'),
    panel(LIVE_SLOTS.map((s) => ({ ...s, w: -1000 })), 3000, { silent: true }));
  const m = energyFlowModel(ds, grid(0, 0));
  assert.equal(m.panelState, 'silent');
  assert.equal(m.load, null);
  assert.equal(m.viaPanelCount, 0, 'a frame without the house reading is not a live panel reading');
  assert.equal(m.acOut, 0);
  assert.equal(m.coresToHouseW, 0, 'no 3 kW Batteries → Loads edge into a Loads node reading "—"');
  assert.equal(m.batNet, 0);
  assert.equal(m.soc, null);
  assert.equal(batteriesSubtitle(m), 'idle');
});

/* ══ v1.188.1 review — slots of OPPOSITE sign ═══════════════════════════════ */

test('★★ one Core charging and one delivering through the panel: each slot counts on its own side', () => {
  // A per-channel force charge (chNForceCharge) on slot 1 while slot 2 carries the house.
  const slots: Slot[] = [{ sn: 'CORE-A', w: 3000, pct: 40 }, { sn: 'CORE-B', w: -1500, pct: 70 }, { sn: 'CORE-C', w: 0, pct: 70 }];
  const m = energyFlowModel(devs(darkCore('CORE-A'), darkCore('CORE-B'), darkCore('CORE-C'), panel(slots, 4000)), grid(5500, 0));
  assert.equal(m.acOut, 1500, 'only the delivering slot is AC output');
  assert.equal(m.gridToCoresW, 3000, 'only the charging slot is grid → Batteries');
  assert.equal(m.coresToHouseW, 1500);
  assert.equal(m.gridToHouseW, 2500);
  assert.equal(m.gridSupplyW, 5500, 'main and edges agree: the node keeps the main');
  assert.equal(m.batNet, -1500, 'the node’s net is the slots’ net');
  assert.equal(batteriesSubtitle(m), '▲ 1.50 kW in');
});

/* ══ v1.188.1 review — the Solar node with no Core's own PV meter ═══════════ */

test('★★ no Core reporting: the Solar node reads "—", not a confident 0 W', () => {
  const m = energyFlowModel(liveDevices(), grid(0, 0));
  assert.equal(m.pv, null, 'was 0');
  assert.equal(fmtW(m.pv), '—');
  assert.equal(solarSubtitle(m), 'Cores not reporting');
  // Every Core on its own meter: the plant's array, as before.
  const all = energyFlowModel(devs(core('CORE-A', { pv: 800 }), core('CORE-B', { pv: 700 }), panel(LIVE_SLOTS.slice(0, 2), 1000)), grid(0, 0));
  assert.equal(all.pv, 1500);
  assert.equal(all.pvUnreported, 0);
  assert.equal(solarSubtitle(all), '42 panels');
  // No panel and no Core at all (an empty account): 0 W, as before.
  assert.equal(energyFlowModel({}, undefined).pv, 0);
});

test('EnergyFlow.tsx renders the Solar node from the model helper and draws no PV flow without a figure', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const card = readFileSync(resolve(here, '../../web/src/cards/EnergyFlow.tsx'), 'utf8');
  for (const pin of [
    'subtitle={solarSubtitle({ pv, dpuCount, pvUnreported })} value={fmtW(pv)}',
    'watts={pv ?? 0} color={HUES.solar}',
  ]) assert.ok(card.includes(pin), `missing ${pin}`);
  assert.ok(!card.includes('subtitle="42 panels"'), 'the card no longer hard-codes the Solar subtitle');
});
