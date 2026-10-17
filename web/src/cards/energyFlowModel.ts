import type { DeviceSnapshot, DpuProjection, GridBackstop, Shp2EnergySource, Shp2Projection } from '../types';
import { shp2ConnectedDpuSns, isShp2Connected, allPanels } from '../shp2Membership';
import { fmtW } from '../format';

/**
 * v1.175.0 — the Energy flow card's numbers, as a pure function of the snapshot.
 *
 * Extracted from EnergyFlow.tsx so the arithmetic the operator reads off the headline
 * diagram is executed by the test suite (server/test/energyFlowModel.test.ts imports this
 * file directly, the same way webServerMembershipParity runs the web membership module).
 * The component only lays these numbers out.
 *
 * Every edge carries the flow it is drawn as, measured at the meter that sees it:
 *   Solar → Batteries   pv            — PV into the Cores
 *   Grid  → Batteries   gridToCoresW  — the home Cores' own AC input (grid charging them)
 *   Grid  → Loads       gridToHouseW  — the grid serving the house through the panel
 *   Batteries → Loads   coresToHouseW — the Cores' delivery, never more than their inverters report
 * and the Loads NODE is the house total the panel measured. The two edges into Loads sum to
 * the node: the Cores' share is taken from their own (faster) meter and the grid
 * takes the rest of the house. (v1.188.1 — except while a connected Core's delivery is
 * unmeasured: the grid edge is then the measured main and the unmeasured share is not drawn.)
 * The Solar and Batteries
 * nodes are NOT balanced against them: PV is metered on the DC side and the house on the
 * AC side, and the MPPT, charger and inverter losses between them are not drawn.
 *
 * v1.188.1 — a Core with no reading of its own is metered at the PANEL. The panel measures each
 * source slot itself, so a connected Core whose telemetry is absent (cloud-offline, or listed
 * without a projection) still has an AC output, an AC input and a battery percentage on the
 * panel's side while the panel's reading is live; the Batteries node then says "via panel". The
 * house-on-grid inference is drawn only on the Cores' own meters (see houseOnGrid). A Core listed
 * online whose own meter the server judges FROZEN (its slot's dpuFrozen) has no reading of its own
 * either, and a panel the server judges not fresh (readbackFresh false) freezes the card's panel
 * figures as the house panel's grid.panelFresh does.
 */

/** Below this an edge is not drawn (and an active grid with no qualifying edge keeps
 *  the standby connector). */
export const FLOW_EDGE_MIN_W = 5;

/** v1.188.1 — a reporting Core's slot figure and its own meter agree within max(150 W, 20 %);
 *  beyond that the panel's frame is behind the Cores (see behindPanels). */
export const FRAME_LAG_MIN_W = 150;
export const FRAME_LAG_FRACTION = 0.2;

export type GridFlowState = 'active' | 'standby' | 'off';
/** ok = reporting; silent = no channel watts in the payload; frozen = offline or replaying a
 *  cloud shadow; absent = no SHP2 observed (cold boot). */
export type PanelState = 'ok' | 'silent' | 'frozen' | 'absent';

export interface EnergyFlowModel {
  /** Home DPUs drawn in the Batteries node on their OWN meters (SHP2-connected; every online DPU
   *  on a cold boot). v1.188.1 — not a Core the server judges frozen: that one is via the panel. */
  dpuCount: number;
  /** Online DPUs NOT in the home set (bench spares). */
  spareCount: number;
  /** v1.182.0 — a panel is present but its source list is not known, so every online DPU is
   *  drawn as home — bench spares included — and spareCount cannot say how many. */
  membershipUnknown: boolean;
  /** v1.188.1 — connected Cores drawn from the PANEL's meter of their source slot because
   *  they have no reading of their own (0 while every Core reports). */
  viaPanelCount: number;
  /** PV into the Cores, from their own meters. v1.188.1 — NULL when no connected Core has a reading
   *  of its own (the panel's slots carry their PV inside the AC exchange, unseparated). */
  pv: number | null;
  /** v1.188.1 — connected Cores whose PV is not in `pv` (no reading of their own). */
  pvUnreported: number;
  /** The Cores' AC output: their own inverters' meters, plus the panel's slot meter for a
   *  Core drawn via the panel. */
  acOut: number;
  /** > 0 = discharging, from per-pack flow; a Core drawn via the panel adds its slot's net
   *  AC output (the panel cannot see its packs, so that share includes the Core's PV). */
  batNet: number;
  soc: number | null;
  /** The house total (SHP2 circuits), or NULL when the panel is silent or frozen. */
  load: number | null;
  /** Why `load` is what it is. */
  panelState: PanelState;
  /** Energized CIRCUITS (split-phase pairs count once), not channels. */
  liveCircuits: number;
  gridState: GridFlowState;
  /** The Grid node: the main meter, or the sum of its edges when the main is evidently stale. */
  gridSupplyW: number;
  gridToCoresW: number;
  gridToHouseW: number;
  /** The Cores' delivery to the house, measured on the panel (load − grid-to-house). */
  coresToHouseW: number;
}

type Dpu = DeviceSnapshot & { projection: DpuProjection };
type Shp2 = DeviceSnapshot & { projection: Shp2Projection };

export function energyFlowModel(devices: Record<string, DeviceSnapshot>, grid?: GridBackstop): EnergyFlowModel {
  const list = Object.values(devices);
  const allDpus = list.filter((d) => d.projection?.kind === 'dpu' && d.online) as Dpu[];
  // v1.185.0 — EVERY panel, house panel first. The Cores, PV, battery and grid figures already
  // span every panel (union roster; the server sums each panel's grid), so the load does too.
  const panels = allPanels(devices) as Shp2[];
  const shp2: Shp2 | undefined = panels[0];

  // v0.9.77 — the headline diagram is the HOME energy flow. Bench spares are not part of
  // the home's PV / battery / SoC story, even when they're online; filter them out via
  // the same SHP2-membership helper the analytics engines + MQTT discovery use
  // (server/src/shp2Membership.ts). When the SHP2 hasn't been observed yet (cold boot),
  // fall back to every online DPU so the diagram isn't empty.
  const connected = shp2ConnectedDpuSns(devices);
  const dpus = connected.size > 0 ? allDpus.filter((d) => isShp2Connected(d.sn, connected)) : allDpus;
  // v1.188.1 — the Cores read on their OWN meters: not one the server judges frozen (its slot's
  // dpuFrozen, shp2Membership.ts isSourceDpuFrozen: listed online, content unchanged for 5 min — a
  // quota fetch that keeps failing, or the cloud replaying its cached body). A frozen Core's figures
  // are not a reading: its acOut of 0 W read as "the Cores deliver nothing" and drew the 10-16
  // false grid import again, and one frozen while delivering kept drawing its old output after the
  // house had moved to the grid. It is read from its slot below, like an offline Core.
  const frozenSns = new Set(
    panels.flatMap((p) => p.projection.sources ?? []).filter((s) => s.isConnected && s.dpuFrozen === true)
      .map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const metered = dpus.filter((d) => !frozenSns.has(d.sn));

  const ownPv = metered.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  // acIn from the SHP2's sources (by definition the home-connected DPUs) — kept as a
  // defensive fallback for the cold-boot path above.
  const sourceSns = new Set(
    panels.flatMap((p) => p.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const gridDpus = sourceSns.size > 0 ? metered.filter((d) => sourceSns.has(d.sn)) : metered;
  // The Cores' own meters. A Core drawn via the panel adds its slot's figures below (v1.188.1).
  const ownAcIn = gridDpus.reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  const ownAcOut = metered.reduce((s, d) => s + (d.projection.acOutWatts ?? 0), 0);
  // v0.46.0 — battery net from PER-PACK flow, not DPU throughput, mirroring the server's
  // fleet_battery_net_watts. Pack out = discharge, pack in = charge; net > 0 = discharging.
  const ownBatNet = metered.reduce(
    // v1.186.2 — prefer the stream's fresh flow over the poll's last-non-zero replay (server snapshot.ts).
    (s, d) => s + d.projection.packs.reduce((p, pk) => { const f = pk.liveFlow ?? pk; return p + ((f.outputWatts ?? 0) - (f.inputWatts ?? 0)); }, 0),
    0,
  );
  // v1.145.0 — average only the packs that REPORTED; a silent DPU is not a 0% pack.
  const ownSocVals = metered.map((d) => d.projection.soc);

  // v1.175.0 — the house load, and NULL when the panel's figure cannot be trusted.
  //
  // ★ The old expression was `circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? acOut`.
  // The projection ALWAYS builds twelve channel entries (project.ts loops 1..12) and sets
  // `watts: null` for any the payload omitted, so the array is never absent, `??` never
  // fired, and a panel that reported no channel watts summed to a confident 0 — "the house
  // is drawing 0 W" — rendered identically to a real reading.
  // ★ A panel that is OFFLINE or replaying a cloud shadow (contentStaleSinceMs) keeps its
  // last projection, so its channels still sum to a plausible house load — FROZEN. The
  // server already refuses to count such a panel's grid reading (gridState.ts
  // computeHomeGridWatts returns 0), so pairing the frozen load with that zeroed grid drew
  // the whole house flowing out of idle batteries: the exact picture this release removes.
  // Frozen is treated like silent. Only a total absence of the SHP2 (cold boot) falls back
  // to the Cores' AC output.
  // ★ v1.179.0 — a THIRD way to be frozen: online and unshadowed, but its readings stopped
  // refreshing (a failing quota fetch). The server now zeroes that panel's grid reading too,
  // and says so in `grid.panelFresh`; the card keys on the server's verdict, not a client clock.
  // v1.185.0 — any panel frozen freezes the load: a sum that is half live, half frozen is neither.
  // v1.188.1 — `grid.panelFresh` judges the HOUSE panel only; every panel carries the server's own
  // verdict (readbackFresh), so a second panel listed online while its quota keeps failing freezes
  // the figures too — its frozen slots would otherwise be drawn as the Cores delivering now.
  const circuits = panels.flatMap((p) => p.projection.circuits ?? []);
  const measured = circuits.filter((c) => c.watts != null);
  const panelState: PanelState = !shp2
    ? 'absent'
    : panels.some((p) => !p.online || p.contentStaleSinceMs != null) || grid?.panelFresh === false
      || panels.some((p) => p.readbackFresh === false)
      ? 'frozen'
      : measured.length === 0
        ? 'silent'
        : 'ok';

  // ── v1.188.1 — Cores the panel meters for them ───────────────────────────
  // Live 2026-10-16 20:04 MST: every Core cloud-offline since 10-14 23:52 (none projected), the
  // panel fresh: main 0 W, its three source slots −1145, −1145 and −1119 W, the house 3.39 kW and
  // the pool falling 92 → 86 %. With no Core reporting, the AC output summed to 0, the
  // house-on-grid rule read that as "the Cores deliver nothing", and the card drew "GRID 3.39 kW
  // importing" with a 3390 W grid → Loads edge beside "Batteries (0 DPU) — idle".
  // The panel meters every source slot itself (sourceWatts = backupInfo.chWatt, from the same
  // frame as its main and its circuits): negative = the Core delivering into the panel, positive
  // = the Core charging from it (the sign App.tsx and Shp2Card flip for display). A CONNECTED
  // slot (isConnected: the membership every flow here uses) whose Core has no reading of its own
  // in this snapshot — offline (the server marks the slot dpuStale) or listed without a
  // projection — is drawn from that figure, and only while the panel's own reading is live
  // (panelState 'ok'). A Core that reports keeps its own meter: it is the faster one (~10 s
  // against the panel's ~60 s frame), and its slot is never counted twice. A Core the server
  // judges frozen (dpuFrozen) is not on its own meter, so its slot is read.
  const ownMeter = new Set(metered.map((d) => d.sn));
  const silentSlots = panels
    .flatMap((p) => (p.projection.sources ?? []).map((s, i) => ({ p, s, w: p.projection.sourceWatts?.[i] })))
    .filter(({ s }) => s.isConnected && !!s.sn && !ownMeter.has(s.sn));
  const viaPanel = panelState === 'ok'
    ? silentSlots.filter((x): x is { p: Shp2; s: Shp2EnergySource; w: number } => typeof x.w === 'number' && Number.isFinite(x.w))
    : [];
  // v1.188.1 review — a panel's frame BEHIND the Cores' own meters. The ~60 s frame lags the ~10 s
  // meters at every transition, and a Core that reports on its own meter shows it: its slot figure
  // (the AC it exchanges with the panel, + = into the Core) disagrees with its own AC input less its
  // AC output beyond the meters' tolerance. The dark Cores' slot figures on that panel are from the
  // same old frame, so while it is behind their FLOWS are left out (their percentage and their place
  // in the node stay), and the house-on-grid rule stands on the Cores' own meters, as it did before
  // v1.188.1. A mixed fleet at the 09-21 hand-over (two Cores at 0 W on their own meters, the frame
  // still showing every slot at −1712 W, main 0, house 5137 W) otherwise read the third, dark, Core's
  // stale −1713 W as the Cores still delivering, put the grid on standby and drew a 5137 W
  // Batteries → Loads edge; at the 09-22 charge end its stale +5300 W was drawn as a grid →
  // Batteries edge after the charge had ended. Each panel has its own frame and is judged alone.
  const ownBySn = new Map(metered.map((d) => [d.sn, d]));
  const behindPanels = new Set(panels.filter((p) => (p.projection.sources ?? []).some((s, i) => {
    const d = s.isConnected && s.sn ? ownBySn.get(s.sn) : undefined;
    const w = p.projection.sourceWatts?.[i];
    if (!d || typeof w !== 'number' || !Number.isFinite(w)) return false;
    const own = (d.projection.acInWatts ?? 0) - (d.projection.acOutWatts ?? 0);
    return Math.abs(w - own) > Math.max(FRAME_LAG_MIN_W, FRAME_LAG_FRACTION * Math.max(Math.abs(w), Math.abs(own)));
  })));
  const viaFlow = viaPanel.filter((x) => !behindPanels.has(x.p));
  const acIn = ownAcIn + viaFlow.reduce((t, x) => t + Math.max(0, x.w), 0);
  const acOut = ownAcOut + viaFlow.reduce((t, x) => t + Math.max(0, -x.w), 0);
  const batNet = ownBatNet - viaFlow.reduce((t, x) => t + x.w, 0);
  const socVals = [...ownSocVals, ...viaPanel.map((x) => x.s.batteryPercentage)]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const soc = socVals.length === 0 ? null : socVals.reduce((a, b) => a + b, 0) / socVals.length;
  // A connected Core with no figure from either meter: its delivery is unknown, not zero.
  const unmeteredCores = silentSlots.length - viaPanel.length;
  // v1.188.1 — the Solar node is the Cores' own PV meters. With none of them reporting, "0 W" would be
  // a missing meter drawn as a reading — beside an "out" figure that carries those Cores' PV — so it
  // is null ("—"). With some reporting it is their PV, and pvUnreported says how many it leaves out.
  const pv: number | null = ownMeter.size === 0 && silentSlots.length > 0 ? null : ownPv;

  const load: number | null = panelState === 'ok'
    ? measured.reduce((s, c) => s + (c.watts as number), 0)
    : panelState === 'absent'
      ? acOut
      : null;

  // v1.175.0 — COUNT CIRCUITS, NOT LEGS. `circuits` is twelve channels; a split-phase 240 V
  // circuit occupies two, and the projection pairs them in `pairedCircuits` (the SHP2 card
  // on the same page renders that list as "Circuits (6)"). Counting energized channels
  // read "9 circuits" on a six-circuit panel and could reach twelve. Raw channels are the
  // fallback only when the payload carried no pairing.
  const groups = panels.flatMap((p) => p.projection.pairedCircuits ?? []);
  const liveCircuits = groups.length > 0
    ? groups.filter((g) => (g.watts ?? 0) > 1).length
    : circuits.filter((c) => (c.watts ?? 0) > 1).length;

  // ── the grid ─────────────────────────────────────────────────────────────
  // homeGridWatts is the TOTAL metered at the SHP2 main: the panel's node balance is
  // load = grid + Core AC output, and during a charge the main also carries the Cores' AC
  // input. The card used to draw that whole total as ONE edge into the Batteries, with the
  // only edge into Loads coming out of the Batteries — so a grid carrying the house was
  // drawn as the house running on battery (live 2026-09-22 03:30: grid 1901 W, house
  // 1904 W, Core AC output 0 W, packs +16 W).
  //
  // ★ TWO CADENCES. The panel's figures (main, house, channels) arrive in one REST frame
  // every ~60 s; the Cores' AC input and output stream every ~10 s. Every transition —
  // a charge ramp, a charge ending, the Cores handing the house to the grid — therefore has
  // up to a minute in which the two disagree. Replayed over 190 h of recorded history, a
  // rule that trusted the panel's frame drew phantom battery output at charge ramps and lost
  // the Cores' real delivery when a charge ended. The rules below attribute from the
  // FRESHER meter first and let the panel's total absorb the rest.
  const homeGridW = grid?.homeGridWatts ?? 0;
  // The Cores' grid draw, over the same Cores drawn in the Batteries node. With a connection
  // table that is their own acIn (the server's importWatts also counts a source slot whose
  // Core is not connected). WITHOUT one (cold boot, or a partial quota missing the sources
  // subtree) every online DPU stands in for the node — bench spares included — so their
  // acIn would include a spare's wall charge; the server's importWatts fails safe to 0 in
  // exactly that state, and is used instead. No snapshot `grid` at all is the legacy path.
  const coresAcIn = connected.size > 0 ? acIn : grid ? (grid.importWatts ?? 0) : acIn;
  const coresDelivering = acOut >= FLOW_EDGE_MIN_W;
  const gridPresent = grid ? grid.present || grid.declared : acIn >= FLOW_EDGE_MIN_W;
  // The house is evidently on the grid when the Cores (fresh meter) deliver nothing while
  // the panel shows the house drawing: the grid is the only other source. This covers the
  // up-to-60 s after the Cores stop, before the panel's next frame shows the main rising
  // (recorded 09-21 22:55:37-22:56:27: house 5137 W, Cores 0 W, main still 0).
  // v1.188.1 — and only on the Cores' OWN evidence. "The Cores deliver nothing" is a reading when
  // at least one Core reports on its own meter and every connected Core has a figure (its own, or
  // its slot's via the panel); a Core with neither is unknown, not idle. With no Core's own meter
  // every figure comes from the panel's one frame, whose main measured the grid directly, so the
  // main is drawn and nothing is inferred (10-16 20:04: no Core reporting, main 0 W, the house
  // drawn as 3.39 kW of grid import). A dark Core on a panel whose frame is behind the Cores
  // (behindPanels) has a figure, a frame old: its flows wait for the next frame, and "the Cores
  // deliver nothing" is the reporting Cores' reading, as at 09-21 before v1.188.1.
  const coresSeenIdle = !coresDelivering && ownMeter.size > 0 && unmeteredCores === 0;
  const houseOnGrid = gridPresent && coresSeenIdle && load != null && load >= FLOW_EDGE_MIN_W;
  const gridActive = grid
    ? homeGridW > 0 || coresAcIn >= FLOW_EDGE_MIN_W || houseOnGrid
    : acIn >= FLOW_EDGE_MIN_W;
  const gridState: GridFlowState = gridActive ? 'active' : gridPresent ? 'standby' : 'off';
  const gridToCoresW = coresAcIn;

  // ── who feeds the house ───────────────────────────────────────────────────
  //   · Cores idle (their inverters report < 5 W) and grid active → the grid carries the
  //     whole house: grid → Loads is the house load. v1.188.1 — only when the Cores are SEEN
  //     idle (coresSeenIdle); otherwise grid → Loads is the measured main less the Cores' draw.
  //   · Cores delivering, grid not active → the Cores are the only source: their edge IS the
  //     house load, so the arrow equals the box (the reported view had 1925 W into a
  //     "1.89 kW" box — the Cores' inverter meter against the panel's).
  //   · both → the Cores' share comes from their own fresh meter (capped at the house), and
  //     the grid takes the rest. When a charge ends the panel's frame still shows the main
  //     carrying everything for up to a minute (09-22 04:53:41: main 3331 W, house 3335 W,
  //     Cores already outputting 3298 W); the fresh meter keeps their delivery on screen.
  //     A Core drawn via the panel (v1.188.1) brings its slot's figure from the same frame as
  //     the main, so the two agree to within the panel's own metering.
  //   · a silent or frozen panel (load null) → each edge from its own meter.
  let gridToHouseW: number;
  let coresToHouseW: number;
  if (load == null) {
    gridToHouseW = Math.max(0, homeGridW - coresAcIn);
    coresToHouseW = coresDelivering ? acOut : 0;
  } else if (!coresDelivering) {
    // v1.188.1 review — the grid carries the whole house only on the Cores' own evidence that they
    // deliver nothing (coresSeenIdle). Without it (no Core on its own meter, or a connected Core with
    // no figure from either meter) the measured main is drawn, less the Cores' own draw: a fresh
    // main of 500 W below a 3.39 kW house was drawn as "GRID 3.39 kW" when the frame carried no
    // slot figures. The share nothing measured is not drawn.
    gridToHouseW = gridState !== 'active' ? 0 : coresSeenIdle ? load : Math.min(load, Math.max(0, homeGridW - coresAcIn));
    coresToHouseW = 0;
  } else if (gridState !== 'active') {
    gridToHouseW = 0;
    coresToHouseW = load;
  } else {
    coresToHouseW = Math.min(acOut, load);
    gridToHouseW = load - coresToHouseW;
  }
  if (coresToHouseW < FLOW_EDGE_MIN_W) coresToHouseW = 0;
  if (gridToHouseW < FLOW_EDGE_MIN_W) gridToHouseW = 0;

  // The Grid node: the main meter, unless the fresher meters show it is evidently stale.
  // The main and the Cores' meters normally agree to within a few percent (steady 16 kW
  // charge: main 19053 W vs 17965 W drawn — the node keeps the main). At a transition the
  // main can be a whole frame behind: 3.41 kW beside a 16.3 kW grid → Cores edge at a charge
  // ramp, 18.4 kW beside a 2.1 kW house edge when a charge had just ended. Beyond the meters'
  // tolerance the node shows what its edges carry, so it never contradicts them.
  const gridEdgesW = gridToCoresW + gridToHouseW;
  const meterToleranceW = Math.max(500, 0.1 * Math.max(homeGridW, gridEdgesW));
  const gridSupplyW = homeGridW > 0 && Math.abs(homeGridW - gridEdgesW) <= meterToleranceW ? homeGridW : gridEdgesW;

  return {
    dpuCount: metered.length,
    spareCount: connected.size > 0 ? allDpus.length - dpus.length : 0,
    membershipUnknown: connected.size === 0
      && list.some((d) => (d.productName ?? '').toLowerCase().includes('smart home panel')),
    viaPanelCount: viaPanel.length,
    pv,
    pvUnreported: silentSlots.length,
    acOut,
    batNet,
    soc,
    load,
    panelState,
    liveCircuits,
    gridState,
    gridSupplyW,
    gridToCoresW,
    gridToHouseW,
    coresToHouseW,
  };
}

/** v1.188.1 — the Batteries node's title: the DPUs drawn on their own meters, the Cores drawn
 *  through the panel, and the spares left out. With every Core drawn through the panel it reads
 *  "Batteries (3 via panel)", not "0 DPU, 3 via panel" (the node holds three Cores, not none). */
export function batteriesTitle(m: Pick<EnergyFlowModel, 'dpuCount' | 'viaPanelCount' | 'spareCount' | 'membershipUnknown'>): string {
  const own = m.dpuCount > 0 || m.viaPanelCount === 0 ? [`${m.dpuCount} DPU`] : [];
  const panelPart = m.viaPanelCount > 0 ? [`${m.viaPanelCount} via panel`] : [];
  const spares = m.spareCount > 0 ? [`+${m.spareCount} spare`] : m.membershipUnknown ? ['spares not yet identified'] : [];
  return `Batteries (${[...own, ...panelPart, ...spares].join(', ')})`;
}

/** v1.188.1 — the Solar node's subtitle: the plant's array, or which Cores the figure covers when
 *  some have no reading of their own ("2 of 3 Cores"), or "Cores not reporting" when none has. */
export function solarSubtitle(m: Pick<EnergyFlowModel, 'pv' | 'dpuCount' | 'pvUnreported'>): string {
  if (m.pv == null) return 'Cores not reporting';
  if (m.pvUnreported > 0) return `${m.dpuCount} of ${m.dpuCount + m.pvUnreported} Cores`;
  return '42 panels';
}

/** v1.188.1 — the Batteries node's subtitle. A slot meters the Core's AC exchange with the panel,
 *  which carries the Core's PV as well as its packs, so a figure that includes a Core drawn via
 *  the panel reads "out" / "in", never "discharging" / "charging". */
export function batteriesSubtitle(m: Pick<EnergyFlowModel, 'batNet' | 'viaPanelCount'>): string {
  const acExchange = m.viaPanelCount > 0;
  if (m.batNet > 5) return `▼ ${fmtW(m.batNet)} ${acExchange ? 'out' : 'discharging'}`;
  if (m.batNet < -5) return `▲ ${fmtW(-m.batNet)} ${acExchange ? 'in' : 'charging'}`;
  return 'idle';
}
