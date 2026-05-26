/**
 * v0.9.40 — System Map.
 *
 * Hand-drawn-feel schematic of Eric's whole installation, rendered as
 * inline SVG. Custom illustrations (no icon font, no stock SVGs) so the
 * map is recognizable AT A GLANCE without text:
 *
 *   ┌────────┐    ┌────────┐
 *   │ ☼ PV   │───▶│   ⌬    │──▶ Loads
 *   │ 42 pnl │    │  DPUs  │
 *   └────────┘    │  20    │──▶ EV
 *                 │  packs │
 *                 └────────┘
 *                      │
 *                      ▼
 *                  ┌────┐
 *                  │SHP2│──▶ Grid (when present)
 *                  └────┘
 *
 * Each node shows live state; the connecting lines animate with the
 * opus-flow-line dasharray (energy direction = active flow).
 *
 * The result is an architecture-clarity visual that doubles as a status
 * dashboard at a glance.
 */

import { totalPvWatts, totalLoadWatts, fmtWatts, allPacks } from '../utils';
import type { FleetSnapshot } from '../../types';

interface SystemMapProps {
  snapshot: FleetSnapshot | null;
}

export function SystemMap({ snapshot }: SystemMapProps) {
  const pv = totalPvWatts(snapshot);
  const load = totalLoadWatts(snapshot);
  const packs = allPacks(snapshot);
  const dpuCount = new Set(packs.map((p) => p.dpuSn)).size;
  const packCount = packs.length;
  const hasShp2 = snapshot ? Object.values(snapshot.devices).some((d) => d.projection?.kind === 'shp2') : false;

  const pvFmt = fmtWatts(pv);
  const loadFmt = fmtWatts(load);

  return (
    <div className="opus-glass p-6">
      <div className="flex items-baseline justify-between mb-1">
        <div className="opus-eyebrow">SYSTEM MAP</div>
        <div className="opus-label">{dpuCount} DPU · {packCount} PACK · 42 PANEL</div>
      </div>
      <div style={{ color: 'rgb(var(--color-ink))', fontSize: 16, fontWeight: 500, marginBottom: 24 }}>
        Your installation, end-to-end.
      </div>

      <svg viewBox="0 0 920 360" width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="opus-pv-node" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--opus-solar)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--opus-solar)" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="opus-storage-node" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--opus-storage)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--opus-storage)" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="opus-load-node" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--opus-load)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--opus-load)" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="opus-grid-node" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--opus-grid)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--opus-grid)" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* ─── flow lines ─── */}
        {/* PV → DPUs */}
        <line
          x1="160" y1="120" x2="380" y2="160"
          stroke="var(--opus-solar)" strokeWidth={pv > 100 ? 1.8 : 1} opacity={pv > 100 ? 0.7 : 0.3}
          className={pv > 100 ? 'opus-flow-line' : ''}
        />
        {/* DPUs → House */}
        <line
          x1="540" y1="160" x2="760" y2="120"
          stroke="var(--opus-load)" strokeWidth={load > 100 ? 1.8 : 1} opacity={load > 100 ? 0.7 : 0.3}
          className={load > 100 ? 'opus-flow-line' : ''}
        />
        {/* DPUs → EV (always drawn dim) */}
        <line
          x1="540" y1="200" x2="760" y2="240"
          stroke="var(--opus-load)" strokeWidth="1" opacity="0.25"
        />
        {/* DPUs → SHP2 (Smart Panel) */}
        {hasShp2 && (
          <line
            x1="460" y1="240" x2="460" y2="300"
            stroke="var(--opus-cosmic)" strokeWidth="1.2" opacity="0.5"
            className="opus-flow-line"
          />
        )}

        {/* ─── nodes ─── */}
        <SolarNode x={80} y={60} watts={pv} />
        <StorageNode x={380} y={130} packs={packCount} dpus={dpuCount} />
        <LoadNode x={760} y={60} watts={load} label="House" />
        <EvNode x={760} y={210} />
        {hasShp2 && <ShpNode x={380} y={290} />}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-6 mt-4 pt-4 border-t" style={{ borderColor: 'var(--opus-glass-border)' }}>
        <FlowLegend color="var(--opus-solar)" label={`Solar ${pvFmt.value} ${pvFmt.unit}`} />
        <FlowLegend color="var(--opus-load)" label={`House ${loadFmt.value} ${loadFmt.unit}`} />
        <FlowLegend color="var(--opus-storage)" label={`Storage ${packCount} packs`} />
        {hasShp2 && <FlowLegend color="var(--opus-cosmic)" label="Smart Panel" />}
      </div>
    </div>
  );
}

/* ─── node illustrations ─────────────────────────────────────────── */

function SolarNode({ x, y, watts }: { x: number; y: number; watts: number }) {
  const active = watts > 50;
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width="160" height="120" rx="12" fill="url(#opus-pv-node)" stroke="var(--opus-solar)" strokeWidth="1" strokeOpacity="0.4" />
      {/* Sun icon */}
      <g transform="translate(80,42)">
        <circle r="11" fill="none" stroke="var(--opus-solar)" strokeWidth="1.5" opacity={active ? 1 : 0.5} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <line
            key={deg}
            x1="0" y1="-16" x2="0" y2="-22"
            stroke="var(--opus-solar)" strokeWidth="1.5" strokeLinecap="round"
            opacity={active ? 1 : 0.4}
            transform={`rotate(${deg})`}
          />
        ))}
      </g>
      <text x="80" y="82" textAnchor="middle" fontSize="11" fontWeight="600" fill="rgb(var(--color-ink))">
        42 Panels
      </text>
      <text x="80" y="98" textAnchor="middle" fontSize="14" fontWeight="200" fill="var(--opus-solar)" fontFamily="var(--font-mono)">
        {watts > 0 ? `${Math.round(watts)} W` : 'OFFLINE'}
      </text>
    </g>
  );
}

function StorageNode({ x, y, packs, dpus }: { x: number; y: number; packs: number; dpus: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width="160" height="160" rx="14" fill="url(#opus-storage-node)" stroke="var(--opus-storage)" strokeWidth="1" strokeOpacity="0.4" />
      {/* Battery stack icon — 5 packs × 4 cells visualization (compressed) */}
      <g transform="translate(50,28)">
        {Array.from({ length: 5 }, (_, i) => (
          <rect
            key={i}
            x={0} y={i * 12}
            width={60} height={9}
            rx="2"
            fill="var(--opus-storage)" fillOpacity="0.25"
            stroke="var(--opus-storage)" strokeWidth="0.7" strokeOpacity="0.5"
          />
        ))}
      </g>
      <text x="80" y="108" textAnchor="middle" fontSize="11" fontWeight="600" fill="rgb(var(--color-ink))">
        Delta Pro Ultra
      </text>
      <text x="80" y="124" textAnchor="middle" fontSize="14" fontWeight="200" fill="var(--opus-storage)" fontFamily="var(--font-mono)">
        {dpus} × {packs > 0 ? Math.round(packs / Math.max(1, dpus)) : 5}
      </text>
      <text x="80" y="142" textAnchor="middle" fontSize="9" fontWeight="500" fill="rgb(var(--color-muted))" letterSpacing="0.1em">
        DPUS · PACKS EACH
      </text>
    </g>
  );
}

function LoadNode({ x, y, watts, label }: { x: number; y: number; watts: number; label: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width="160" height="120" rx="12" fill="url(#opus-load-node)" stroke="var(--opus-load)" strokeWidth="1" strokeOpacity="0.4" />
      {/* House icon */}
      <g transform="translate(80,42)" stroke="var(--opus-load)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M-20,4 L0,-16 L20,4 L20,18 L-20,18 Z" />
        <path d="M-6,18 L-6,8 L6,8 L6,18" />
      </g>
      <text x="80" y="82" textAnchor="middle" fontSize="11" fontWeight="600" fill="rgb(var(--color-ink))">
        {label}
      </text>
      <text x="80" y="98" textAnchor="middle" fontSize="14" fontWeight="200" fill="var(--opus-load)" fontFamily="var(--font-mono)">
        {watts > 0 ? `${Math.round(watts)} W` : 'IDLE'}
      </text>
    </g>
  );
}

function EvNode({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width="160" height="90" rx="12" fill="url(#opus-load-node)" stroke="var(--opus-load)" strokeWidth="1" strokeOpacity="0.3" />
      {/* EV charger icon */}
      <g transform="translate(80,32)" stroke="var(--opus-load)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.7">
        <rect x="-14" y="-12" width="28" height="20" rx="2" />
        <line x1="0" y1="8" x2="0" y2="14" />
        <line x1="-6" y1="14" x2="6" y2="14" />
      </g>
      <text x="80" y="62" textAnchor="middle" fontSize="11" fontWeight="600" fill="rgb(var(--color-ink))">
        EV Charger
      </text>
      <text x="80" y="78" textAnchor="middle" fontSize="9" fontWeight="500" fill="rgb(var(--color-muted))" letterSpacing="0.1em">
        ECOFLOW LEVEL 2
      </text>
    </g>
  );
}

function ShpNode({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width="160" height="60" rx="10" fill="url(#opus-grid-node)" stroke="var(--opus-cosmic)" strokeWidth="1" strokeOpacity="0.4" />
      {/* Panel breaker icon */}
      <g transform="translate(80,30)">
        {[-12, -4, 4, 12].map((dx, i) => (
          <line key={i} x1={dx} y1="-8" x2={dx} y2="8" stroke="var(--opus-cosmic)" strokeWidth="1.2" strokeLinecap="round" />
        ))}
      </g>
      <text x="80" y="50" textAnchor="middle" fontSize="10" fontWeight="600" fill="rgb(var(--color-ink))">
        SHP2 Smart Panel
      </text>
    </g>
  );
}

function FlowLegend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ width: 24, height: 2, background: color }} />
      <div className="text-xs" style={{ color: 'rgb(var(--color-muted))' }}>{label}</div>
    </div>
  );
}
