import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { DeviceSnapshot, DpuProjection, Shp2Projection } from '../types';

// Array configuration: each equipped DPU has a 10-panel high-voltage string and
// a 4-panel low-voltage string; all panels are 400 W. Spare DPUs have no array.
const HV_PANELS = 10;
const LV_PANELS = 4;
const PANEL_W = 400;
const PANELS_PER_DPU = HV_PANELS + LV_PANELS;
import { fmtTemp, fmtW, fmtWh } from '../format';
import { sortDevices } from '../sort';
import { SolarResponseCard } from '../cards/SolarResponseCard';
import { CurtailmentCard } from '../cards/CurtailmentCard';
import { apiUrl } from '../api';
import { CHART, HUES } from '../theme';

const DPU_COLORS = [HUES.battery, HUES.soc, HUES.solar, HUES.violet];

interface SummaryResp {
  fleet: {
    pvWh: number;
    coverage: number;
    // PV-only coverage (`pv_total`), added server-side in v0.44.0; the Solar
    // "% measured" tile binds to this so it reflects PV — not battery/grid/load/
    // temps, which the all-metric `coverage` averaged in. Optional so an older
    // server during dev falls back to `coverage` instead of breaking.
    pvCoverage?: number;
  };
}

interface Point {
  ts: number;
  value: number;
}

export function SolarPanel({ devices }: { devices: Record<string, DeviceSnapshot> }) {
  const list = sortDevices(Object.values(devices));
  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const onlineDpus = dpus.filter((d) => d.online && d.projection);

  // DPUs with a solar array = the SHP2-bound Cores; the spares have none.
  const shp2 = list.find((d) => d.projection?.kind === 'shp2');
  const arraySns = new Set<string>(
    shp2?.projection?.kind === 'shp2'
      ? (shp2.projection as Shp2Projection).sources.map((s) => s.sn).filter((sn): sn is string => !!sn)
      : [],
  );
  // v0.43.0 — array TOPOLOGY (panel + HV/LV channel counts) is driven by the equipped
  // SHP2-bound Cores, NOT live connectivity: a cloud-offline-but-wired Core (e.g. Core 1)
  // still has its 10 HV + 4 LV strings physically installed. Same `|| onlineDpus.length`
  // fallback so it degrades gracefully on cold boot before the SHP2 sources populate.
  const equippedCores = arraySns.size || onlineDpus.length;
  // v0.43.0 (Copilot follow-up) — count ONLINE *equipped* (SHP2-bound) cores, so the
  // "· N offline" suffix isn't understated by an online bench spare (which is in
  // onlineDpus but not arraySns). When membership is unknown (no SHP2), all online count.
  const equippedOnline = arraySns.size > 0 ? onlineDpus.filter((d) => arraySns.has(d.sn)).length : onlineDpus.length;
  const totalPanels = equippedCores * PANELS_PER_DPU;

  // v0.9.75 — defensive log for the "Core 3 LV showed no data" report.
  // If SHP2 hasn't loaded into the snapshot yet (cold boot, brief
  // restart, websocket reconnect) `arraySns` is empty and every
  // productive Core renders as "spare core · no PV array" until the
  // snapshot re-populates. That looked like "Core 3 has no data" to
  // the operator. Surface a one-time console warning whenever this state is
  // hit so the next occurrence is one DevTools tab away from diagnosis
  // instead of another round of agent-driven log archaeology.
  if (arraySns.size === 0 && onlineDpus.length > 0) {
    // Suppress on first render (the snapshot may still be loading);
    // only warn if we've seen SHP2 data before in this session.
    const seenShp2 = (window as unknown as { __seenShp2?: boolean }).__seenShp2;
    if (seenShp2) {
      console.warn(
        '[SolarPanel] arraySns is empty but', onlineDpus.length,
        'DPU(s) are online. Every Core will render as "spare" until the SHP2 source list re-populates.',
        'This is the failure mode from the v0.9.74 audit; may indicate a stale snapshot or SHP2 went briefly offline.',
      );
    }
  } else if (shp2) {
    (window as unknown as { __seenShp2?: boolean }).__seenShp2 = true;
  }

  // Current fleet PV
  const pvNow = onlineDpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  const pvHighNow = onlineDpus.reduce((s, d) => s + (d.projection.pvHighWatts ?? 0), 0);
  const pvLowNow = onlineDpus.reduce((s, d) => s + (d.projection.pvLowWatts ?? 0), 0);

  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [peakToday, setPeakToday] = useState<{ value: number; ts: number } | null>(null);
  const [pvSeries, setPvSeries] = useState<Record<string, Point[]>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Summary for today's kWh
        const sumR = await fetch(apiUrl('api/summary/today'));
        const sumJ = (await sumR.json()) as SummaryResp;
        if (!cancelled) setSummary(sumJ);

        // 24h PV per DPU
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const since = dayStart.getTime();
        const next: Record<string, Point[]> = {};
        let peakVal = 0;
        let peakTs = 0;
        await Promise.all(
          onlineDpus.map(async (d) => {
            const r = await fetch(apiUrl(`api/history?sn=${d.sn}&metric=pv_total&since=${since}&bucket=60`));
            const j = (await r.json()) as { points: Point[] };
            next[d.sn] = j.points;
          }),
        );
        // Compute fleet peak by summing across DPUs at each timestamp (best effort)
        const allTs = new Set<number>();
        for (const pts of Object.values(next)) for (const p of pts) allTs.add(p.ts);
        for (const ts of allTs) {
          let sum = 0;
          for (const sn of Object.keys(next)) {
            const pt = next[sn].find((p) => p.ts === ts);
            if (pt) sum += pt.value;
          }
          if (sum > peakVal) {
            peakVal = sum;
            peakTs = ts;
          }
        }
        if (!cancelled) {
          setPvSeries(next);
          setPeakToday(peakVal > 0 ? { value: peakVal, ts: peakTs } : null);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [onlineDpus.map((d) => d.sn).join(',')]);

  // Merge series for chart. v0.24.3 — memoized (was a bare render-body IIFE that
  // re-ran on every ~1 Hz snapshot re-render of the Solar tab) + a ts-indexed Map
  // per DPU to drop the inner O(points) `.find`, mirroring TrendChart.tsx's
  // v0.22.0 fix. Keyed on pvSeries + a (sn|deviceName) signature — deviceName is
  // mutable and the row keys + recharts dataKey/gradient depend on it, so a
  // rename must invalidate the memo.
  //
  // v0.44.0 — a bucket where a DPU has NO sample now emits `null` for that DPU
  // (a true gap recharts breaks the line through) instead of carrying its last
  // value forward. The history endpoint omits empty buckets, so the old
  // carry-forward painted a flat line across a per-DPU data gap whenever a
  // SIBLING DPU still had a sample at that timestamp — reading as steady
  // production when there was actually no data. The fleet total now sums only
  // the DPUs present at each bucket (an absent DPU contributes nothing rather
  // than a stale value).
  const deviceSig = onlineDpus.map((d) => `${d.sn}|${d.deviceName}`).join(',');
  const mergedSeries = useMemo(() => {
    const all = new Set<number>();
    for (const pts of Object.values(pvSeries)) for (const p of pts) all.add(p.ts);
    const sortedTs = Array.from(all).sort((a, b) => a - b);
    const idxBySn: Record<string, Map<number, number>> = {};
    for (const d of onlineDpus) {
      const idx = new Map<number, number>();
      for (const p of pvSeries[d.sn] ?? []) if (!idx.has(p.ts)) idx.set(p.ts, p.value);
      idxBySn[d.sn] = idx;
    }
    return sortedTs.map((ts) => {
      const row: Record<string, number | string | null> = { ts };
      let total = 0;
      for (const d of onlineDpus) {
        const idx = idxBySn[d.sn];
        const v = idx.has(ts) ? idx.get(ts)! : null;
        row[d.deviceName] = v;
        total += v ?? 0;
      }
      row['Fleet total'] = total;
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvSeries, deviceSig]);

  return (
    <div className="space-y-4">
      {/* Fleet summary */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Solar overview</span>
          <span className="text-xs text-muted normal-case tracking-normal">
            {totalPanels} panels · {PANEL_W} W each · {HV_PANELS} HV + {LV_PANELS} LV per DPU
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <SummaryTile label="Producing now" value={fmtW(pvNow)} accent="text-warn" sub={`HV ${fmtW(pvHighNow)} · LV ${fmtW(pvLowNow)}`} />
          <SummaryTile
            label="Today"
            value={summary ? fmtWh(summary.fleet.pvWh) : '—'}
            accent="text-warn"
            sub={summary ? `${((summary.fleet.pvCoverage ?? summary.fleet.coverage) * 100).toFixed(0)}% measured` : ''}
          />
          <SummaryTile
            label="Peak today"
            value={peakToday ? fmtW(peakToday.value) : '—'}
            sub={peakToday ? `at ${new Date(peakToday.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'no peak yet'}
          />
          <SummaryTile label="HV channels" value={`${equippedCores}`} sub={equippedCores > equippedOnline ? `high-voltage MPPT · ${equippedCores - equippedOnline} offline` : 'high-voltage MPPT'} />
          <SummaryTile label="LV channels" value={`${equippedCores}`} sub={equippedCores > equippedOnline ? `low-voltage MPPT · ${equippedCores - equippedOnline} offline` : 'low-voltage MPPT'} />
        </div>
      </div>

      {/* Flow diagram */}
      <FlowDiagram dpus={onlineDpus} arraySns={arraySns} totalPanels={totalPanels} />

      {/* Per-DPU detail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {onlineDpus.map((d) => (
          <DpuSolarCard key={d.sn} d={d} />
        ))}
      </div>

      {/* 24h chart */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Solar production (today)</span>
          <span className="text-xs text-muted normal-case tracking-normal">1-min buckets</span>
        </div>
        <div style={{ width: '100%', height: 280 }}>
          {/* v0.12.0 — minWidth={0}/minHeight silence recharts' 0-size warning
              when the parent measures 0 at mount; fixed px height unchanged. */}
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
            <AreaChart data={mergedSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <defs>
                {onlineDpus.map((d, i) => (
                  <linearGradient id={`gpv-${d.sn}`} key={d.sn} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={DPU_COLORS[i % DPU_COLORS.length]} stopOpacity={0.5} />
                    <stop offset="100%" stopColor={DPU_COLORS[i % DPU_COLORS.length]} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                tick={{ fill: CHART.axis, fontSize: 10 }}
                tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              />
              <YAxis tick={{ fill: CHART.axis, fontSize: 10 }} width={56} unit=" W" />
              <Tooltip
                contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: CHART.axis }}
                labelFormatter={(t) => new Date(t as number).toLocaleString()}
                formatter={(v) => (typeof v === 'number' ? `${Math.round(v)} W` : v)}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: CHART.axis }} />
              {onlineDpus.map((d, i) => (
                <Area
                  key={d.sn}
                  type="monotone"
                  dataKey={d.deviceName}
                  stroke={DPU_COLORS[i % DPU_COLORS.length]}
                  fill={`url(#gpv-${d.sn})`}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  /* v0.44.0 — do NOT connectNulls: a null is a genuine per-DPU
                     data gap (no sample in that bucket), so the area should break
                     there rather than bridge across it as if production continued. */
                  stackId={undefined}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Learned array response model */}
      <SolarResponseCard />

      {/* Solar curtailment — energy thrown away when batteries are full and home
          load can't absorb the PV. Lives on the Solar page (v0.24.2). */}
      <CurtailmentCard />
    </div>
  );
}

function FlowDiagram({
  dpus,
  arraySns,
  totalPanels,
}: {
  dpus: Array<DeviceSnapshot & { projection: DpuProjection }>;
  arraySns: Set<string>;
  totalPanels: number;
}) {
  const W = 900;
  const ROW_H = 128;
  const TOP = 56;
  // A DPU belongs on the SHP2 solar-flow diagram only when it's an SHP2 source
  // (an array-equipped home Core). A bench spare is powered but NOT wired to the
  // SHP2 — it has no PV array and occupies no SHP2 connector — so drawing it as a
  // row feeding the shared battery cluster wrongly implied it was attached to a
  // connector (surfaced once the spares were powered up). Fallback: if the SHP2
  // binding is unknown (cold boot / SHP2 briefly offline) arraySns is empty and we
  // draw every DPU rather than hiding the real array.
  const hasArray = (sn: string) => arraySns.size === 0 || arraySns.has(sn);
  const drawn = dpus.filter((d) => hasArray(d.sn));
  const H = TOP + drawn.length * ROW_H + 36;

  // Animation period: faster = more watts
  const period = (w: number) => {
    if (w < 5) return 0;
    return Math.max(0.6, Math.min(8, 1500 / Math.max(w, 50)));
  };
  const strokeW = (w: number) => Math.min(8, Math.max(1.2, Math.log10(Math.max(10, w)) * 1.6));

  const COL_PANELS = 80;
  const COL_DPU = 600;
  const COL_BAT = 800;

  // Panel-glyph geometry — the HV string draws as a 5 × 2 block and the LV
  // string as a single row of 4, each grouped beside its MPPT channel line.
  const CELL_W = 13;
  const CELL_H = 9;
  const HV_COLS = 5;
  const PANELS_X = 28;
  const LINE_START_X = 132;

  return (
    <div className="card">
      <div className="card-title">Solar power flow</div>
      {/* No maxHeight cap — let the SVG render at full width-scale so the
          labels stay legible; the card scrolls for a tall fleet. */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <style>{`@keyframes pvflow { to { stroke-dashoffset: -32; } }`}</style>
          <symbol id="sun" viewBox="-12 -12 24 24">
            <circle cx="0" cy="0" r="6" fill={HUES.solar} />
            {Array.from({ length: 8 }).map((_, i) => {
              const a = (i * Math.PI) / 4;
              return (
                <line
                  key={i}
                  x1={Math.cos(a) * 8}
                  y1={Math.sin(a) * 8}
                  x2={Math.cos(a) * 11}
                  y2={Math.sin(a) * 11}
                  stroke={HUES.solar}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              );
            })}
          </symbol>
          <symbol id="panel" viewBox="0 0 20 14">
            <rect x="0.5" y="0.5" width="19" height="13" fill="#d8dde3" stroke="#8b94a3" strokeWidth="1" rx="1.5" />
            {[1, 2, 3].map((i) => (
              <line key={`v${i}`} x1={i * 5} y1="0.5" x2={i * 5} y2="13.5" stroke="#8b94a3" strokeWidth="0.5" />
            ))}
            {[1, 2].map((i) => (
              <line key={`h${i}`} x1="0.5" y1={(i * 14) / 3} x2="19.5" y2={(i * 14) / 3} stroke="#8b94a3" strokeWidth="0.5" />
            ))}
          </symbol>
        </defs>

        {/* Sun + panels */}
        <use href="#sun" x={COL_PANELS - 32} y={26} width="30" height="30" />
        <text x={COL_PANELS + 6} y={36} fill={HUES.solar} fontSize="14" fontFamily="ui-sans-serif" fontWeight="700">
          {/* v0.43.0 — the diagram draws a row per ONLINE equipped Core, but the
              installed nameplate (totalPanels) counts ALL equipped Cores incl. any
              cloud-offline one. When fewer are drawn than installed, say so explicitly
              instead of captioning "42 panels" above 28 glyphs. */}
          {(() => {
            const shown = drawn.length * PANELS_PER_DPU;
            return shown < totalPanels
              ? `${totalPanels} installed · ${shown} shown · ${PANEL_W} W each`
              : `${totalPanels} panels · ${PANEL_W} W each`;
          })()}
        </text>

        {drawn.map((d, i) => {
          const p = d.projection;
          const yMid = TOP + i * ROW_H + ROW_H / 2;
          const hvW = p.pvHighWatts ?? 0;
          const lvW = p.pvLowWatts ?? 0;
          const totalW = p.pvTotalWatts ?? 0;
          const arrayed = hasArray(d.sn);

          return (
            <g key={d.sn}>
              {arrayed ? (
                <>
                  {/* HV string — 10 panels in a 5 × 2 block straddling the HV line */}
                  {Array.from({ length: HV_PANELS }).map((_, n) => (
                    <use
                      key={`hv${n}`}
                      href="#panel"
                      x={PANELS_X + (n % HV_COLS) * CELL_W}
                      y={yMid - 32 + Math.floor(n / HV_COLS) * CELL_H}
                      width={CELL_W - 2}
                      height={CELL_H - 2}
                    />
                  ))}
                  {/* LV string — 4 panels in a single row on the LV line */}
                  {Array.from({ length: LV_PANELS }).map((_, n) => (
                    <use
                      key={`lv${n}`}
                      href="#panel"
                      x={PANELS_X + n * CELL_W}
                      y={yMid + 24 - (CELL_H - 2) / 2}
                      width={CELL_W - 2}
                      height={CELL_H - 2}
                    />
                  ))}

                  {/* HV channel line */}
                  <FlowSegment
                    x1={LINE_START_X}
                    y1={yMid - 24}
                    x2={COL_DPU - 10}
                    y2={yMid - 24}
                    watts={hvW}
                    color={HUES.solar}
                    period={period(hvW)}
                    strokeW={strokeW(hvW)}
                  />
                  <text x={LINE_START_X + 22} y={yMid - 34} fill={HUES.solar} fontSize="14" fontWeight="700" fontFamily="ui-monospace">
                    HV: {fmtW(hvW)}
                  </text>
                  <text x={LINE_START_X + 22} y={yMid - 11} fill={CHART.axis} fontSize="11" fontFamily="ui-monospace">
                    {p.pvHighVolts?.toFixed(0) ?? '—'} V · {p.pvHighAmps?.toFixed(1) ?? '—'} A · {fmtTemp(p.mpptHvTemp)} · {HV_PANELS} × {PANEL_W} W
                  </text>

                  {/* LV channel line */}
                  <FlowSegment
                    x1={LINE_START_X}
                    y1={yMid + 24}
                    x2={COL_DPU - 10}
                    y2={yMid + 24}
                    watts={lvW}
                    color="#c2410c"
                    period={period(lvW)}
                    strokeW={strokeW(lvW)}
                  />
                  <text x={LINE_START_X + 22} y={yMid + 38} fill="#c2410c" fontSize="14" fontWeight="700" fontFamily="ui-monospace">
                    LV: {fmtW(lvW)}
                  </text>
                  <text x={LINE_START_X + 22} y={yMid + 53} fill={CHART.axis} fontSize="11" fontFamily="ui-monospace">
                    {p.pvLowVolts?.toFixed(0) ?? '—'} V · {p.pvLowAmps?.toFixed(1) ?? '—'} A · {fmtTemp(p.mpptLvTemp)} · {LV_PANELS} × {PANEL_W} W
                  </text>
                </>
              ) : (
                /* Spare DPU — no PV array wired in */
                <text x={PANELS_X} y={yMid + 4} fill={CHART.tooltipBorder} fontSize="12" fontStyle="italic">
                  spare core · no PV array
                </text>
              )}

              {/* DPU node */}
              <rect x={COL_DPU} y={yMid - 32} width={150} height={64} rx={6} fill={CHART.tooltipBg} stroke={HUES.battery} strokeOpacity={0.9} strokeWidth={1.5} />
              <text x={COL_DPU + 12} y={yMid - 15} fill={CHART.axis} fontSize="11" fontWeight="600" letterSpacing="0.08em" style={{ textTransform: 'uppercase' }}>{d.deviceName}</text>
              <text x={COL_DPU + 12} y={yMid + 9} fill={HUES.battery} fontSize="21" fontWeight="700" fontFamily="ui-monospace">
                {fmtW(totalW)}
              </text>
              <text x={COL_DPU + 12} y={yMid + 25} fill={CHART.axis} fontSize="10">total in</text>

              {/* DPU → battery */}
              <FlowSegment
                x1={COL_DPU + 150}
                y1={yMid}
                x2={COL_BAT}
                y2={yMid}
                watts={totalW}
                color={HUES.battery}
                period={period(totalW)}
                strokeW={strokeW(totalW)}
              />
            </g>
          );
        })}

        {/* Battery cluster (right) */}
        <rect x={COL_BAT} y={TOP - 12} width={92} height={drawn.length * ROW_H + 24} rx={6} fill={CHART.tooltipBg} stroke={HUES.soc} strokeOpacity={0.9} strokeWidth={1.5} />
        <text x={COL_BAT + 46} y={TOP + 8} textAnchor="middle" fill={CHART.axis} fontSize="11" fontWeight="600" letterSpacing="0.08em" style={{ textTransform: 'uppercase' }}>batteries</text>
        <text x={COL_BAT + 46} y={TOP + (drawn.length * ROW_H) / 2 + 14} textAnchor="middle" fill={HUES.soc} fontSize="26" fontWeight="700">
          ⚡
        </text>
      </svg>
    </div>
  );
}

function FlowSegment({
  x1, y1, x2, y2, watts, color, period, strokeW,
}: { x1: number; y1: number; x2: number; y2: number; watts: number; color: string; period: number; strokeW: number }) {
  const cx = (x1 + x2) / 2;
  const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={strokeW} />
      {period > 0 && (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray="6 10"
          strokeLinecap="round"
          style={{ animation: `pvflow ${period}s linear infinite` }}
        />
      )}
    </g>
  );
}

function DpuSolarCard({ d }: { d: DeviceSnapshot & { projection: DpuProjection } }) {
  const p = d.projection;
  return (
    <div className="card">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-xs text-muted">{d.productName}</div>
          <div className="text-lg font-semibold">{d.deviceName}</div>
          <div className="text-[10px] font-mono text-muted/80">{d.sn}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-muted">PV total</div>
          <div className="text-xl font-semibold tabular-nums text-warn">{fmtW(p.pvTotalWatts)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <MpptChannelTile
          label="HV MPPT"
          watts={p.pvHighWatts}
          volts={p.pvHighVolts}
          amps={p.pvHighAmps}
          temp={p.mpptHvTemp}
          errCode={p.pvHighErrCode}
          accent={HUES.solar}
        />
        <MpptChannelTile
          label="LV MPPT"
          watts={p.pvLowWatts}
          volts={p.pvLowVolts}
          amps={p.pvLowAmps}
          temp={p.mpptLvTemp}
          errCode={p.pvLowErrCode}
          accent="#c2410c"
        />
      </div>
    </div>
  );
}

/**
 * Classify an MPPT channel's operating state from W/V/errCode so the tile
 * can explain a 0 W reading instead of looking broken (v0.9.79; watt-based
 * + fault-only-when-producing since v0.9.81).
 *
 *  - producing — making real WATTS (above the floor).
 *  - fault     — an error code WHILE producing. A non-zero code on an idle
 *                string is EcoFlow's benign standby/shutdown status (live
 *                proof: at sunset every core reported HV=457 / LV=177 with
 *                strings at 0 W) — that is NOT a fault, so we must not paint
 *                idle strings red.
 *  - idle      — string voltage present but ~0 W. Panels wired and showing
 *                open-circuit voltage, but the MPPT isn't harvesting —
 *                battery full/curtailing (sheds LV first) or sunset wind-down.
 *  - dark      — no meaningful voltage: night, deep shade, or disconnected.
 */
const CH_VOLT_PRESENT = 10;   // V — above this the string is "connected/lit"
const CH_WATT_FLOOR = 20;     // W — below this the string isn't meaningfully producing

type ChannelState = 'fault' | 'producing' | 'idle' | 'dark';
function channelState(
  watts: number | null,
  volts: number | null,
  errCode: number | null,
): ChannelState {
  const producing = watts != null && watts > CH_WATT_FLOOR;
  // A code only means "fault" when the string is actually producing — an
  // idle/dark string carrying a code is in benign standby.
  if (producing) return (errCode ?? 0) !== 0 ? 'fault' : 'producing';
  if (volts != null && volts > CH_VOLT_PRESENT) return 'idle';
  return 'dark';
}

const CHANNEL_BADGE: Record<ChannelState, { label: string; cls: string; note: string | null }> = {
  producing: { label: 'producing', cls: 'badge-ok', note: null },
  idle:      { label: 'idle', cls: 'badge-warn', note: 'String lit but not harvesting — battery full / curtailing.' },
  dark:      { label: 'no sun', cls: 'badge-muted', note: null },
  fault:     { label: 'fault', cls: 'badge-bad', note: null },
};

function MpptChannelTile({
  label, watts, volts, amps, temp, errCode, accent,
}: {
  label: string;
  watts: number | null;
  volts: number | null;
  amps: number | null;
  temp: number | null;
  errCode: number | null;
  accent: string;
}) {
  // Effective resistance (V / A) for the operating point — interesting metric for power tracking
  const ohms = volts != null && amps != null && amps > 0.05 ? volts / amps : null;
  const computed = volts != null && amps != null ? volts * amps : null;
  const state = channelState(watts, volts, errCode);
  const badge = CHANNEL_BADGE[state];
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs uppercase tracking-widest" style={{ color: accent }}>{label}</span>
        <span className={`badge ${badge.cls} text-[10px]`} title={badge.note ?? undefined}>
          {state === 'fault' ? `err ${errCode}` : badge.label}
        </span>
      </div>
      <div className="text-2xl font-semibold tabular-nums" style={{ color: accent }}>{fmtW(watts)}</div>
      {/* Explain a 0 W reading inline so it doesn't read as a malfunction. */}
      {badge.note && <div className="text-[10px] text-muted mb-1 leading-snug">{badge.note}</div>}
      <div className="grid grid-cols-1 gap-y-1 text-xs mt-1">
        <div className="kv"><span className="kv-k">Voltage</span><span className="kv-v">{volts?.toFixed(1) ?? '—'} V</span></div>
        <div className="kv"><span className="kv-k">Current</span><span className="kv-v">{amps?.toFixed(2) ?? '—'} A</span></div>
        <div className="kv"><span className="kv-k">V × A</span><span className="kv-v">{fmtW(computed)}</span></div>
        <div className="kv"><span className="kv-k">MPPT temp</span><span className="kv-v">{fmtTemp(temp)}</span></div>
        <div className="kv"><span className="kv-k">String Ω</span><span className="kv-v">{ohms != null ? `${ohms.toFixed(1)} Ω` : '—'}</span></div>
        <div className="kv"><span className="kv-k">Error code</span><span className="kv-v">{errCode ?? 0}</span></div>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}
