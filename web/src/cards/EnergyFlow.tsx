import type { DeviceSnapshot, DpuProjection, Shp2Projection } from '../types';
import { fmtPct, fmtW } from '../format';

interface Props {
  devices: Record<string, DeviceSnapshot>;
}

export function EnergyFlow({ devices }: Props) {
  const list = Object.values(devices);
  const dpus = list.filter((d) => d.projection?.kind === 'dpu' && d.online) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;

  const pv = dpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  // "Grid-tied" means the HOUSE is on grid — AC input on an SHP2-bound DPU. A
  // spare DPU plugged into a wall to self-charge must not flip the whole system.
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
  const acIn = gridDpus.reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
  const acOut = dpus.reduce((s, d) => s + (d.projection.acOutWatts ?? 0), 0);
  const totalIn = dpus.reduce((s, d) => s + (d.projection.totalInWatts ?? 0), 0);
  const totalOut = dpus.reduce((s, d) => s + (d.projection.totalOutWatts ?? 0), 0);
  const batNet = totalOut - totalIn; // > 0 = discharging
  const soc = dpus.length === 0 ? null : dpus.reduce((s, d) => s + (d.projection.soc ?? 0), 0) / dpus.length;
  const load = shp2?.projection.circuits.reduce((s, c) => s + (c.watts ?? 0), 0) ?? acOut;
  const offGrid = acIn < 5;

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
          {offGrid ? <span className="badge badge-warn">off-grid</span> : <span className="badge badge-ok">grid-tied</span>}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 280 }}>
        <defs>
          <style>{`
            @keyframes flowdash { to { stroke-dashoffset: -32; } }
          `}</style>
        </defs>

        {/* PV → Battery */}
        <FlowLine from={[Solar.x + Solar.w, Solar.y + Solar.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} watts={pv} color="#d97706" period={period(pv)} strokeW={strokeW(pv)} label="solar" />
        {/* Grid ↔ Battery */}
        <FlowLine from={[Grid.x + Grid.w, Grid.y + Grid.h / 2]} to={[Battery.x, Battery.y + Battery.h / 2]} watts={acIn} color="#586474" period={period(acIn)} strokeW={strokeW(acIn)} label="grid" />
        {/* Battery → Loads (use load if available, fallback acOut) */}
        <FlowLine from={[Battery.x + Battery.w, Battery.y + Battery.h / 2]} to={[Loads.x, Loads.y + Loads.h / 2]} watts={Math.max(load, acOut)} color="#15803d" period={period(Math.max(load, acOut))} strokeW={strokeW(Math.max(load, acOut))} label="ac-out" />

        {/* Solar node */}
        <Node {...Solar} title="Solar" subtitle="42 panels" value={fmtW(pv)} icon="☀" accent="#d97706" />
        {/* Grid node */}
        <Node {...Grid} title="Grid" subtitle={offGrid ? 'islanded' : 'imported'} value={fmtW(acIn)} icon="⌁" accent={offGrid ? '#586474' : '#0e7490'} />
        {/* Battery node (big) */}
        <Node
          {...Battery}
          title={`Batteries (${dpus.length} DPU)`}
          subtitle={batNet > 5 ? `▼ ${fmtW(batNet)} discharging` : batNet < -5 ? `▲ ${fmtW(-batNet)} charging` : 'idle'}
          value={fmtPct(soc, 1)}
          big
          accent={socAccent(soc)}
        />
        {/* Loads node */}
        <Node {...Loads} title="Loads" subtitle={`${shp2?.projection.circuits.filter((c) => (c.watts ?? 0) > 1).length ?? 0} circuits`} value={fmtW(load)} icon="⌂" accent="#15803d" />
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
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} fill="#ffffff" stroke={accent} strokeOpacity={0.9} strokeWidth={1.5} />
      <text x={x + 12} y={y + 18} fill="#586474" fontSize="10" fontFamily="ui-sans-serif" letterSpacing="0.1em" style={{ textTransform: 'uppercase' }}>{title}</text>
      <text x={x + 12} y={y + h - 10} fill="#586474" fontSize="10" fontFamily="ui-sans-serif">{subtitle ?? ''}</text>
      <text x={x + w - 12} y={y + h / 2 + (big ? 8 : 6)} textAnchor="end" fill={accent} fontSize={big ? 28 : 18} fontWeight="700" fontFamily="ui-sans-serif">
        {value}
      </text>
      {icon && (
        <text x={x + 12} y={y + h / 2 + 8} fill={accent} fontSize={big ? 26 : 22} fontFamily="ui-sans-serif">{icon}</text>
      )}
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
}: {
  from: [number, number];
  to: [number, number];
  watts: number;
  color: string;
  period: number;
  strokeW: number;
  label: string;
}) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  // Smooth bezier (control points at horizontal midpoint)
  const cx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
  const active = period > 0;
  return (
    <g>
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
          y={(y1 + y2) / 2 - 11}
          textAnchor="middle"
          fill={color}
          fontSize="12"
          fontFamily="ui-monospace"
          fontWeight="700"
          stroke="#eef0f3"
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
  if (soc == null) return '#586474';
  if (soc >= 50) return '#15803d';
  if (soc >= 25) return '#d97706';
  return '#b91c1c';
}
