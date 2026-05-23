import { useEffect, useRef, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';

interface Point {
  ts: number;
  value: number;
}

export interface SparklineProps {
  sn: string;
  metric: string;
  windowMs?: number;        // default last hour
  refreshMs?: number;       // default 30 s
  color?: string;           // CSS color
  height?: number;
  minY?: number;
  maxY?: number;
}

export function Sparkline({ sn, metric, windowMs = 60 * 60 * 1000, refreshMs = 30_000, color = '#0e7490', height = 40, minY, maxY }: SparklineProps) {
  const [points, setPoints] = useState<Point[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: number | null = null;
    const load = async () => {
      const since = Date.now() - windowMs;
      try {
        const r = await fetch(`/api/history?sn=${encodeURIComponent(sn)}&metric=${encodeURIComponent(metric)}&since=${since}`);
        if (!r.ok) return;
        const data = (await r.json()) as { points: Point[] };
        if (mountedRef.current) setPoints(data.points);
      } catch {
        /* ignore */
      }
    };
    load();
    timer = window.setInterval(load, refreshMs);
    return () => {
      mountedRef.current = false;
      if (timer) window.clearInterval(timer);
    };
  }, [sn, metric, windowMs, refreshMs]);

  if (points.length < 2) {
    return <div className="text-[10px] text-muted" style={{ height }}>collecting…</div>;
  }
  return (
    <div style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <YAxis hide domain={[minY ?? 'dataMin', maxY ?? 'dataMax']} />
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
