import type { DeviceSnapshot, GridBackstop } from '../types';
import { fmtPct, fmtW } from '../format';
import { energyFlowModel, FLOW_EDGE_MIN_W } from './energyFlowModel';
import { HUES, UI } from '../theme';

/**
 * v0.36.0 — theme-aware fonts for SVG <text>. The High Contrast theme swaps
 * `--font-sans` → Orbitron and `--font-mono` → Share Tech Mono under
 * [data-theme="high-contrast"] (src/index.css); the Default theme resolves them
 * to ui-sans-serif / ui-monospace, so referencing the CSS var stays
 * byte-identical on Default while letting High Contrast re-skin. Hardcoding
 * "ui-sans-serif"/"ui-monospace" here (as the old core-kW label did) bypasses
 * that swap and clashes with the rest of the High Contrast chrome — so all flow
 * labels route through these vars instead.
 */
const FONT_SANS = 'var(--font-sans)';
const FONT_MONO = 'var(--font-mono)';

/**
 * v0.36.0 — the SHP2 grid backstop, mirrored from the server's GridBackstop
 * (server/src/gridState.ts) and surfaced on the fleet snapshot as `snapshot.grid`.
 * Optional in Props so the card degrades gracefully (legacy DPU-acIn-only view) on a
 * cold snapshot that predates the field. The SHP2 is the grid interconnect; the
 * grid is a BACKSTOP that is tapped automatically at the reserve floor / for
 * rebalancing. Three states the flow renders:
 *   (1) ACTIVE   — homeGridWatts>0 (or importWatts>0): grid carrying the home now.
 *   (2) STANDBY  — present/declared but homeGridWatts≈0: there, not yet needed.
 *   (3) OFF-GRID — present false: islanded.
 */
interface Props {
  devices: Record<string, DeviceSnapshot>;
  /** v0.36.0 — SHP2 grid backstop (snapshot.grid). Absent on a cold snapshot. */
  grid?: GridBackstop;
}

export function EnergyFlow({ devices, grid }: Props) {
  // v1.175.0 — every number on this card comes from energyFlowModel (pure, and run by the
  // test suite); this component only lays them out.
  const {
    dpuCount, spareCount, pv, batNet, soc, load, panelState, liveCircuits,
    gridState, gridSupplyW, gridToCoresW, gridToHouseW, coresToHouseW,
  } = energyFlowModel(devices, grid);

  // SVG geometry
  const W = 720;
  const H = 260;

  const Solar = { x: 90, y: 50, w: 130, h: 60 };
  const Grid = { x: 90, y: 170, w: 130, h: 60 };
  const Battery = { x: 290, y: 95, w: 150, h: 90 };
  const Loads = { x: 510, y: 95, w: 130, h: 90 };

  // Convert a watt value to an animation period (seconds): more watts = faster.
  const period = (w: number) => {
    if (w < 5) return 0; // no animation if effectively zero
    return Math.max(0.6, Math.min(8, 1500 / Math.max(w, 50)));
  };
  const strokeW = (w: number) => Math.min(8, Math.max(1.5, Math.log10(Math.max(10, w)) * 1.6));

  return (
    <div className="card col-span-full">
      <div className="card-title flex items-center justify-between">
        <span>Energy flow</span>
        <span className="flex items-center gap-2 normal-case tracking-normal text-xs text-muted">
          {gridState === 'off' ? (
            <span className="badge badge-warn">off-grid</span>
          ) : gridState === 'active' ? (
            <span className="badge badge-ok">grid active</span>
          ) : (
            <span className="badge badge-ok">grid standby</span>
          )}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 280 }}>
        <defs>
          <style>{`
            @keyframes flowdash { to { stroke-dashoffset: -32; } }
          `}</style>
        </defs>

        {/* PV → Battery */}
        <FlowLine from={[Solar.x + Solar.w, Solar.y + Solar.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} watts={pv} color={HUES.solar} period={period(pv)} strokeW={strokeW(pv)} label="solar" />
        {/* Grid → Home (backstop). v0.36.0 — three states:
            (1) ACTIVE: animated grid→battery flow labelled with the live kW the
                SHP2 is pulling to carry the home (homeGridWatts) or to charge
                the DPUs (importWatts).
            (2) STANDBY: a faint, un-animated connector — grid is there but the
                battery/PV is covering, so it is NOT a live source.
            (3) OFF-GRID: omit the flow entirely (islanded). */}
        {/* v1.175.0 — the grid draws to its real destinations (see gridToHouseW):
            grid → Batteries only for the Cores' own AC input, grid → Loads for the
            house, routed BELOW the battery node so it cannot read as passing through
            it. An active grid with neither edge above the floor keeps the standby
            connector rather than an unlabelled line into the battery. */}
        {gridState === 'active' && gridToCoresW >= FLOW_EDGE_MIN_W && (
          <FlowLine from={[Grid.x + Grid.w, Grid.y + Grid.h / 2 - 12]} to={[Battery.x, Battery.y + Battery.h / 2 + 14]} watts={gridToCoresW} color={HUES.grid} period={period(gridToCoresW)} strokeW={strokeW(gridToCoresW)} label="grid-to-cores" />
        )}
        {gridState === 'active' && gridToHouseW >= FLOW_EDGE_MIN_W && (
          <FlowLine from={[Grid.x + Grid.w, Grid.y + Grid.h / 2 + 12]} to={[Loads.x, Loads.y + Loads.h - 18]} watts={gridToHouseW} color={HUES.grid} period={period(gridToHouseW)} strokeW={strokeW(gridToHouseW)} bow={45} label="grid-to-house" />
        )}
        {(gridState === 'standby' || (gridState === 'active' && gridToCoresW < FLOW_EDGE_MIN_W && gridToHouseW < FLOW_EDGE_MIN_W)) && (
          <StandbyLink from={[Grid.x + Grid.w, Grid.y + Grid.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} color={HUES.grid} />
        )}
        {/* Batteries → Loads: the Cores' delivery to the house (see coresToHouseW) — the
            house total when they are its only source, never more than their inverters
            report. v1.175.0 — was Math.max(load, acOut), two meters on opposite sides of
            the panel, so the arrow and the box it points at disagreed, and a grid-fed house
            was drawn flowing out of idle packs. */}
        <FlowLine from={[Battery.x + Battery.w, Battery.y + Battery.h / 2]} to={[Loads.x, Loads.y + Loads.h / 2]} watts={coresToHouseW} color={HUES.soc} period={period(coresToHouseW)} strokeW={strokeW(coresToHouseW)} label="cores-to-house" />

        {/* Solar node */}
        <Node {...Solar} title="Solar" subtitle="42 panels" value={fmtW(pv)} icon="☀" accent={HUES.solar} />
        {/* Grid node — 3-state subtitle + value:
            active → live kW into the home; standby → "standby" backstop;
            off → "islanded". The amber/accent treatment is reserved for the
            ACTIVE state so a backstopping grid reads as a live source. */}
        <Node
          {...Grid}
          title="Grid"
          subtitle={gridState === 'active' ? 'backstopping' : gridState === 'standby' ? 'standby / backstop' : 'islanded'}
          value={gridState === 'active' ? fmtW(gridSupplyW) : gridState === 'standby' ? 'available' : 'off'}
          icon="⌁"
          accent={gridState === 'active' ? HUES.battery : HUES.grid}
          dim={gridState !== 'active'}
        />
        {/* Battery node (big) */}
        <Node
          {...Battery}
          title={`Batteries (${dpuCount} DPU${spareCount > 0 ? `, +${spareCount} spare` : ''})`}
          subtitle={batNet > 5 ? `▼ ${fmtW(batNet)} discharging` : batNet < -5 ? `▲ ${fmtW(-batNet)} charging` : 'idle'}
          value={fmtPct(soc, 1)}
          big
          accent={socAccent(soc)}
        />
        {/* Loads node */}
        {/* v1.175.0 — a panel that is silent or frozen (offline / cloud shadow) reads "—", not a number. */}
        <Node
          {...Loads}
          title="Loads"
          subtitle={load == null ? (panelState === 'frozen' ? 'panel data stale' : 'panel not reporting') : `${liveCircuits} circuit${liveCircuits === 1 ? '' : 's'}`}
          value={load == null ? '—' : fmtW(load)}
          icon="⌂"
          accent={HUES.soc}
          dim={load == null}
        />
      </svg>
    </div>
  );
}

function Node({
  x,
  y,
  w,
  h,
  title,
  subtitle,
  value,
  icon,
  accent,
  big = false,
  dim = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle?: string;
  value: string;
  icon?: string;
  accent: string;
  big?: boolean;
  /** Render the node muted (standby / off-grid) so it doesn't read as live. */
  dim?: boolean;
}) {
  return (
    <g opacity={dim ? 0.6 : 1}>
      <rect x={x} y={y} width={w} height={h} rx={6} fill={UI.elev} stroke={accent} strokeOpacity={dim ? 0.5 : 0.9} strokeWidth={1.5} strokeDasharray={dim ? '4 4' : undefined} />
      <text x={x + 12} y={y + 18} fill={UI.muted} fontSize="10" fontFamily={FONT_SANS} letterSpacing="0.1em" style={{ textTransform: 'uppercase' }}>{title}</text>
      <text x={x + 12} y={y + h - 10} fill={UI.muted} fontSize="10" fontFamily={FONT_SANS}>{subtitle ?? ''}</text>
      {/* The central core/value readout — uses the theme MONO var (Share Tech
          Mono in High Contrast) so it matches the rest of the High Contrast flow
          chrome instead of the old hardcoded ui-sans-serif that clashed with the
          dark UI. */}
      <text x={x + w - 12} y={y + h / 2 + (big ? 8 : 6)} textAnchor="end" fill={accent} fontSize={big ? 28 : 18} fontWeight="700" fontFamily={FONT_MONO}>
        {value}
      </text>
      {icon && (
        <text x={x + 12} y={y + h / 2 + 8} fill={accent} fontSize={big ? 26 : 22} fontFamily={FONT_SANS}>{icon}</text>
      )}
    </g>
  );
}

/**
 * v0.36.0 — a faint, un-animated connector for the grid STANDBY state: the grid
 * interconnect is present and available but the battery/PV is covering the home,
 * so it is NOT a live flow. Visually distinct from FlowLine (no moving dashes,
 * lower opacity) so a backstop-on-standby never reads as imported power.
 */
function StandbyLink({ from, to, color }: { from: [number, number]; to: [number, number]; color: string }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const cx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.22} strokeWidth={1.5} strokeDasharray="2 6" />
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 11}
        textAnchor="middle"
        fill={color}
        fontSize="11"
        fontFamily={FONT_SANS}
        stroke={UI.panel}
        strokeWidth={4}
        style={{ paintOrder: 'stroke' }}
      >
        standby
      </text>
    </g>
  );
}

function FlowLine({
  from,
  to,
  watts,
  color,
  period,
  strokeW,
  label,
  bow = 0,
}: {
  from: [number, number];
  to: [number, number];
  watts: number;
  color: string;
  period: number;
  strokeW: number;
  /** Identifies the edge (data-flow attribute for tests and inspection); not rendered. */
  label: string;
  /** v1.175.0 — push both control points down by this many px, so an edge can route
   *  BELOW a node instead of through it (grid → Loads passes under the battery). */
  bow?: number;
}) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  // Smooth bezier (control points at horizontal midpoint, optionally bowed downward)
  const cx = (x1 + x2) / 2;
  const cy1 = y1 + bow;
  const cy2 = y2 + bow;
  const d = `M ${x1} ${y1} C ${cx} ${cy1}, ${cx} ${cy2}, ${x2} ${y2}`;
  // The curve's true midpoint (t = 0.5 of a cubic bezier); equals (y1+y2)/2 when bow = 0.
  const midY = (y1 + 3 * cy1 + 3 * cy2 + y2) / 8;
  const active = period > 0;
  return (
    <g data-flow={label}>
      {/* Base line */}
      <path d={d} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={strokeW} />
      {/* Animated dashes */}
      {active && (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray="6 10"
          strokeLinecap="round"
          style={{ animation: `flowdash ${period}s linear infinite` }}
        />
      )}
      {/* Wattage label — white halo (paint-order: stroke) keeps it readable
          where it crosses the animated flow path. */}
      {watts >= 1 && (
        <text
          x={(x1 + x2) / 2}
          y={midY - 11}
          textAnchor="middle"
          fill={color}
          fontSize="12"
          fontFamily={FONT_MONO}
          fontWeight="700"
          stroke={UI.panel}
          strokeWidth={4}
          style={{ paintOrder: 'stroke' }}
        >
          {Math.round(watts)} W
        </text>
      )}
    </g>
  );
}

function socAccent(soc: number | null) {
  if (soc == null) return HUES.grid;
  if (soc >= 50) return HUES.soc;
  if (soc >= 25) return HUES.solar;
  return UI.bad;
}
