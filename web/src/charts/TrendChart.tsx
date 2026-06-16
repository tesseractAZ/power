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
import { apiUrl } from '../api';

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

  // Merge series onto a shared timeline, taking the per-series last-known value.
  const merged = useMemo(() => {
    // v0.22.0 — pre-index each series by ts so the row build is O(rows × series)
    // instead of O(rows × series × points): the old `pts.find(p => p.ts === ts)`
    // was a fresh linear scan for every cell. First-write-wins on a duplicate ts
    // mirrors Array.find exactly (it returns the first match), and probing by
    // key PRESENCE — `idx.has(ts)`, not the value — reproduces `if (pt)` even for
    // a hypothetical undefined value. So the merged rows are byte-for-byte the
    // same and the rendered chart is unchanged.
    const all = new Set<number>();
    const indexBySeries: Record<string, Map<number, number>> = {};
    for (const s of series) {
      const key = `${s.sn}|${s.metric}`;
      const idx = new Map<number, number>();
      for (const p of dataBySeries[key] ?? []) {
        all.add(p.ts);
        if (!idx.has(p.ts)) idx.set(p.ts, p.value);
      }
      indexBySeries[key] = idx;
    }
    const sortedTs = Array.from(all).sort((a, b) => a - b);
    const lastBy: Record<string, number | null> = {};
    for (const s of series) lastBy[`${s.sn}|${s.metric}`] = null;
    return sortedTs.map((ts) => {
      const row: Record<string, number | string | null> = { ts };
      for (const s of series) {
        const key = `${s.sn}|${s.metric}`;
        const idx = indexBySeries[key];
        if (idx.has(ts)) lastBy[key] = idx.get(ts)!;
        row[s.label] = lastBy[key];
      }
      return row;
    });
  }, [series, dataBySeries]);

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
            <CartesianGrid stroke="#c4cad3" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fill: '#586474', fontSize: 10 }}
              tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            />
            <YAxis yAxisId="left" tick={{ fill: '#586474', fontSize: 10 }} width={48} unit={unit ? ` ${unit}` : ''} />
            {hasRight && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: '#586474', fontSize: 10 }}
                width={44}
                unit={rightUnit ? ` ${rightUnit}` : ''}
              />
            )}
            <Tooltip
              contentStyle={{ background: '#ffffff', border: '1px solid #9aa3b0', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#586474' }}
              labelFormatter={(t) => new Date(t as number).toLocaleString()}
              formatter={(v, name) => {
                const u = unitFor(String(name));
                return typeof v === 'number' ? `${Math.round(v * 10) / 10}${u ? ` ${u}` : ''}` : v;
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#586474' }} />
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
                connectNulls
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
