import { useEffect, useMemo, useState } from 'react';
import { compactTick } from './axisFormat';
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
import { apiUrl } from '../api';
import { mergeTrendSeries, trendGapMs } from './trendMerge';
import { CHART } from '../theme';

interface Series {
  sn: string;
  metric: string;
  label: string;
  color: string;
  /** Render as a dashed line — used to pair a related metric with a solid one. */
  dashed?: boolean;
  /** v0.24.2 — which Y axis to scale against. Default 'left'. Put a series with
   *  a DIFFERENT unit/magnitude (e.g. a 0–100 % alongside a kW load) on 'right'
   *  so it gets its own axis instead of being squashed flat on the shared one. */
  axis?: 'left' | 'right';
  /** v0.24.2 — per-series unit for the tooltip + that series' axis label.
   *  Falls back to the chart-level `unit`. */
  unit?: string;
}

interface Point {
  ts: number;
  value: number;
}

export function TrendChart({
  title,
  series,
  windowMs = 24 * 60 * 60 * 1000,
  refreshMs = 60_000,
  unit = '',
  height = 240,
  bucketSec,
}: {
  title: string;
  series: Series[];
  windowMs?: number;
  refreshMs?: number;
  unit?: string;
  height?: number;
  bucketSec?: number;
}) {
  const [dataBySeries, setDataBySeries] = useState<Record<string, Point[]>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const since = Date.now() - windowMs;
      const results: Record<string, Point[]> = {};
      await Promise.all(
        series.map(async (s) => {
          const url = apiUrl(`api/history?sn=${encodeURIComponent(s.sn)}&metric=${encodeURIComponent(s.metric)}&since=${since}${bucketSec ? `&bucket=${bucketSec}` : ''}`);
          try {
            const r = await fetch(url);
            if (!r.ok) return;
            const j = (await r.json()) as { points: Point[] };
            results[`${s.sn}|${s.metric}`] = j.points;
          } catch {
            /* ignore */
          }
        }),
      );
      if (!cancelled) setDataBySeries(results);
    };
    load();
    const timer = window.setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [JSON.stringify(series), windowMs, refreshMs, bucketSec]);

  // Merge series onto a shared timeline. v1.188.1 (review) — a series' last value is carried only
  // inside a stretch with no gap (trendMerge.ts): a device with no rows for longer (offline in the
  // EcoFlow cloud, so nothing was recorded) shows a break, not its last reading painted flat.
  const merged = useMemo(
    () => mergeTrendSeries(series.map((s) => ({ key: `${s.sn}|${s.metric}`, label: s.label })), dataBySeries, trendGapMs(bucketSec)),
    [series, dataBySeries, bucketSec],
  );

  // v0.24.2 — dual-axis support: any series tagged axis:'right' gets its own
  // right-hand Y axis so a small-magnitude series (e.g. 0–100 %) isn't flattened
  // against a large one (e.g. kW) sharing one scale. The right axis takes that
  // series' unit; tooltips show each series' own unit.
  const hasRight = series.some((s) => s.axis === 'right');
  const rightUnit = series.find((s) => s.axis === 'right')?.unit ?? unit;
  const unitFor = (label: string) => series.find((s) => s.label === label)?.unit ?? unit;

  return (
    <div className="card col-span-full">
      <div className="card-title">{title}</div>
      <div style={{ width: '100%', height }}>
        {/* v0.12.0 — minWidth={0}/minHeight silence recharts' 0-size warning
            when the parent measures 0 at mount; fixed px height unchanged. */}
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={height}>
          <AreaChart data={merged} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              {/* id must be space-free — series labels have spaces, which
                  break url(#...) and silently fall back to a black fill. */}
              {series.map((s, i) => (
                <linearGradient id={`tcg-${i}`} key={i} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0} />
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
            {/* v1.183.0 — compact ticks, unit as the axis label (a per-tick unit wrapped onto a stray line). */}
            <YAxis yAxisId="left" tick={{ fill: CHART.axis, fontSize: 10 }} width={48} tickFormatter={compactTick} label={unit ? { value: unit, angle: -90, position: 'insideLeft', fill: CHART.axis, fontSize: 10 } : undefined} />
            {hasRight && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: CHART.axis, fontSize: 10 }}
                width={44}
                tickFormatter={compactTick}
                label={rightUnit ? { value: rightUnit, angle: 90, position: 'insideRight', fill: CHART.axis, fontSize: 10 } : undefined}
              />
            )}
            <Tooltip
              contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: CHART.axis }}
              labelFormatter={(t) => new Date(t as number).toLocaleString()}
              formatter={(v, name) => {
                const u = unitFor(String(name));
                return typeof v === 'number' ? `${Math.round(v * 10) / 10}${u ? ` ${u}` : ''}` : v;
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: CHART.axis }} />
            {series.map((s, i) => (
              <Area
                key={i}
                yAxisId={s.axis ?? 'left'}
                type="monotone"
                dataKey={s.label}
                stroke={s.color}
                strokeDasharray={s.dashed ? '5 4' : undefined}
                fill={`url(#tcg-${i})`}
                fillOpacity={s.dashed ? 0.3 : 0.7}
                strokeWidth={1.6}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
