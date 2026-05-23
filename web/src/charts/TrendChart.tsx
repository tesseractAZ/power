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

interface Series {
  sn: string;
  metric: string;
  label: string;
  color: string;
  /** Render as a dashed line — used to pair a related metric with a solid one. */
  dashed?: boolean;
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
          const url = `/api/history?sn=${encodeURIComponent(s.sn)}&metric=${encodeURIComponent(s.metric)}&since=${since}${bucketSec ? `&bucket=${bucketSec}` : ''}`;
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
    const all = new Set<number>();
    for (const s of series) {
      const pts = dataBySeries[`${s.sn}|${s.metric}`] ?? [];
      for (const p of pts) all.add(p.ts);
    }
    const sortedTs = Array.from(all).sort((a, b) => a - b);
    const lastBy: Record<string, number | null> = {};
    for (const s of series) lastBy[`${s.sn}|${s.metric}`] = null;
    return sortedTs.map((ts) => {
      const row: Record<string, number | string | null> = { ts };
      for (const s of series) {
        const key = `${s.sn}|${s.metric}`;
        const pts = dataBySeries[key] ?? [];
        const pt = pts.find((p) => p.ts === ts);
        if (pt) lastBy[key] = pt.value;
        row[s.label] = lastBy[key];
      }
      return row;
    });
  }, [series, dataBySeries]);

  return (
    <div className="card col-span-full">
      <div className="card-title">{title}</div>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
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
            <YAxis tick={{ fill: '#586474', fontSize: 10 }} width={48} unit={unit ? ` ${unit}` : ''} />
            <Tooltip
              contentStyle={{ background: '#ffffff', border: '1px solid #9aa3b0', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#586474' }}
              labelFormatter={(t) => new Date(t as number).toLocaleString()}
              formatter={(v) => (typeof v === 'number' ? `${Math.round(v * 10) / 10}${unit ? ` ${unit}` : ''}` : v)}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#586474' }} />
            {series.map((s, i) => (
              <Area
                key={i}
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
