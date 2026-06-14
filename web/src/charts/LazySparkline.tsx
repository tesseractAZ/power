import { lazy, Suspense } from 'react';
import type { SparklineProps } from './Sparkline';

/**
 * v0.22.0 — defer recharts off the dashboard's first-paint critical path.
 *
 * Sparkline pulls in recharts (~540 kB minified). DpuCard/Shp2Card render
 * sparklines eagerly on the dashboard, so a STATIC `import { Sparkline }`
 * makes recharts a static dependency of the entry chunk — the browser then
 * fetches all 540 kB before first paint even though `manualChunks` already
 * splits recharts into its own file. Wrapping Sparkline behind React.lazy
 * turns that into a dynamic import(): the dashboard shell paints immediately
 * and the recharts chunk streams in a beat later for the sparklines, behind a
 * height-matched placeholder identical to Sparkline's own "collecting…" state
 * (so there is no layout shift when the real chart swaps in).
 */
const Sparkline = lazy(() => import('./Sparkline').then((m) => ({ default: m.Sparkline })));

export function LazySparkline(props: SparklineProps) {
  const h = props.height ?? 40;
  return (
    <Suspense fallback={<div className="text-[10px] text-muted" style={{ height: h }}>collecting…</div>}>
      <Sparkline {...props} />
    </Suspense>
  );
}
