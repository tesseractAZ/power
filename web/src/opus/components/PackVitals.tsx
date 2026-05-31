/**
 * v0.9.40 — Pack Vitals constellation.
 *
 * the operator's fleet has up to 4 DPUs × 5 packs = 20 packs. Showing all 20 as
 * a tidy grid of numbers is correct but boring. Showing them as a
 * *constellation* — each pack a breathing dot whose color = SoH and
 * size = engaged-watts — makes "fleet health at a glance" the obvious
 * read.
 *
 * Layout: 4 columns (DPUs) × 5 rows (packs). Hover a dot for a tooltip
 * with pack details. Outlier packs (flagged by hierarchical Bayes via
 * /api/models/hierarchical-pack-soh) get a dashed amber halo.
 *
 * Note on the outlier API integration: as of v0.9.40 we don't yet fetch
 * the API client-side — the data is server-rendered via the WebSocket
 * snapshot. Future enhancement: pull outlier flags from /api/models/
 * hierarchical-pack-soh and visually highlight them.
 */

import { useMemo } from 'react';
import { allPacks, packColor } from '../utils';
import type { FleetSnapshot } from '../../types';

interface PackVitalsProps {
  snapshot: FleetSnapshot | null;
}

export function PackVitals({ snapshot }: PackVitalsProps) {
  const packs = useMemo(() => allPacks(snapshot), [snapshot]);
  // Group by DPU SN, then sort columns numerically by "Core N" trailing number.
  // v0.9.42 — previously cared only about packs-within-DPU order, so the column
  // sequence was whatever order the snapshot enumerator yielded (MQTT report
  // order). the desired order is Core 1, Core 2, Core 3, Core 4 left-to-right.
  const byDpu = useMemo(() => {
    const map = new Map<string, ReturnType<typeof allPacks>>();
    for (const p of packs) {
      let arr = map.get(p.dpuSn);
      if (!arr) { arr = []; map.set(p.dpuSn, arr); }
      arr.push(p);
    }
    // Sort packs within each DPU by pack number.
    for (const arr of map.values()) arr.sort((a, b) => a.packNum - b.packNum);
    // Sort the DPU columns themselves by trailing integer in the device name
    // ("Core 5" → 5). Falls back to alphabetical when no number is present.
    return Array.from(map.entries()).sort(([, a], [, b]) => {
      const na = trailingNum(a[0]?.dpuName ?? '');
      const nb = trailingNum(b[0]?.dpuName ?? '');
      if (na != null && nb != null) return na - nb;
      if (na != null) return -1;
      if (nb != null) return 1;
      return (a[0]?.dpuName ?? '').localeCompare(b[0]?.dpuName ?? '');
    });
  }, [packs]);

  // Aggregate stats for the header.
  const total = packs.length;
  const healthy = packs.filter((p) => (p.soh ?? 0) >= 90).length;
  const watch = packs.filter((p) => (p.soh ?? 0) >= 70 && (p.soh ?? 0) < 90).length;
  const critical = packs.filter((p) => (p.soh ?? 100) < 70).length;
  const meanSoh = packs.length > 0
    ? packs.reduce((s, p) => s + (p.soh ?? 0), 0) / packs.filter((p) => p.soh != null).length
    : 0;

  return (
    <div className="opus-glass p-6">
      <div className="flex items-baseline justify-between mb-1">
        <div className="opus-eyebrow">PACK VITALS</div>
        <div className="opus-label">{total} PACKS · MEAN SOH {meanSoh.toFixed(1)}%</div>
      </div>
      <div style={{ color: 'rgb(var(--color-ink))', fontSize: 16, fontWeight: 500, marginBottom: 24 }}>
        {critical === 0 && watch === 0 ? 'Every pack within healthy range.'
         : critical > 0 ? `${critical} pack${critical === 1 ? '' : 's'} need attention.`
         : `${watch} pack${watch === 1 ? '' : 's'} in watch range.`}
      </div>

      {/* The constellation */}
      <div className="grid gap-x-12 gap-y-4" style={{ gridTemplateColumns: `repeat(${Math.max(byDpu.length, 1)}, minmax(0, 1fr))` }}>
        {byDpu.map(([sn, ds]) => {
          const friendly = ds[0]?.dpuName ?? sn.slice(0, 8);
          const dpuMean = ds.length > 0
            ? ds.reduce((s, p) => s + (p.soh ?? 0), 0) / ds.filter((p) => p.soh != null).length
            : 0;
          return (
            <div key={sn}>
              <div className="opus-label" style={{ fontSize: 9, marginBottom: 12 }}>{friendly}</div>
              <div className="flex flex-col gap-3">
                {ds.map((p) => (
                  <PackDot key={p.packNum} pack={p} />
                ))}
              </div>
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--opus-glass-border)' }}>
                <div className="opus-label" style={{ fontSize: 9 }}>MEAN</div>
                <div className="opus-numeral opus-numeral-sm" style={{ color: packColor(dpuMean) }}>
                  {dpuMean.toFixed(0)}<span className="opus-numeral-unit">%</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 mt-6 pt-6 border-t" style={{ borderColor: 'var(--opus-glass-border)' }}>
        <LegendDot color="var(--opus-life-1)" label="Healthy ≥ 95%" />
        <LegendDot color="var(--opus-life-2)" label="Nominal 90-95%" />
        <LegendDot color="var(--opus-solar-2)" label="Watch 80-90%" />
        <LegendDot color="var(--opus-solar)" label="Aging 70-80%" />
        <LegendDot color="var(--color-bad)" label="Critical < 70%" />
        <div className="ml-auto flex items-center gap-2">
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '1px dashed var(--opus-solar)' }} />
          <div className="text-xs" style={{ color: 'rgb(var(--color-muted))' }}>Outlier (Bayes)</div>
        </div>
      </div>
    </div>
  );
}

/* ─── individual pack dot with hover detail ────────────────────────── */

interface PackDotProps {
  pack: ReturnType<typeof allPacks>[number];
}

function PackDot({ pack }: PackDotProps) {
  const color = packColor(pack.soh);
  // Size scales with engagement: idle = small, busy = larger.
  const engagement = Math.max(Math.abs(pack.inputW ?? 0), Math.abs(pack.outputW ?? 0));
  const sizeBoost = engagement > 50 ? Math.min(0.5, engagement / 2000) : 0;
  const scale = 1 + sizeBoost;

  return (
    <div className="group relative flex items-center gap-3 cursor-default">
      <div
        className="opus-pack-dot"
        style={{ color, transform: `scale(${scale})` }}
      />
      <div className="flex-1 flex items-baseline justify-between text-xs">
        <span style={{ color: 'rgb(var(--color-muted))' }}>Pack {pack.packNum}</span>
        <span
          className="font-mono tabular-nums font-semibold"
          style={{ color: 'rgb(var(--color-ink))' }}
        >
          {pack.soh != null ? `${pack.soh.toFixed(1)}%` : '—'}
        </span>
      </div>

      {/* Hover tooltip */}
      <div
        className="absolute left-full ml-3 top-1/2 -translate-y-1/2 z-10 opus-glass opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200"
        style={{ minWidth: 200, padding: 12, borderRadius: 10 }}
      >
        <div className="opus-label mb-2" style={{ fontSize: 9 }}>{pack.dpuName} · PACK {pack.packNum}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <span style={{ color: 'rgb(var(--color-muted))' }}>SoC</span>
          <span className="font-mono tabular-nums text-right">{pack.soc != null ? `${pack.soc}%` : '—'}</span>
          <span style={{ color: 'rgb(var(--color-muted))' }}>SoH</span>
          <span className="font-mono tabular-nums text-right" style={{ color }}>
            {pack.soh != null ? `${pack.soh.toFixed(1)}%` : '—'}
          </span>
          <span style={{ color: 'rgb(var(--color-muted))' }}>Temp</span>
          <span className="font-mono tabular-nums text-right">{pack.temp != null ? `${(pack.temp * 1.8 + 32).toFixed(0)}°F` : '—'}</span>
          <span style={{ color: 'rgb(var(--color-muted))' }}>Cycles</span>
          <span className="font-mono tabular-nums text-right">{pack.cycles ?? '—'}</span>
          <span style={{ color: 'rgb(var(--color-muted))' }}>Cell Δ</span>
          <span className="font-mono tabular-nums text-right">{pack.cellSpreadMv != null ? `${pack.cellSpreadMv} mV` : '—'}</span>
          {engagement > 0 && (
            <>
              <span style={{ color: 'rgb(var(--color-muted))' }}>{(pack.outputW ?? 0) > (pack.inputW ?? 0) ? 'Out' : 'In'}</span>
              <span className="font-mono tabular-nums text-right">{Math.round(engagement)} W</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}` }} />
      <div className="text-xs" style={{ color: 'rgb(var(--color-muted))' }}>{label}</div>
    </div>
  );
}

/** Extract a trailing integer from a device name ("Core 5" → 5). Mirrors
 *  the helper in src/sort.ts so the Opus skin stays self-contained. */
function trailingNum(name: string): number | null {
  const m = name.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
