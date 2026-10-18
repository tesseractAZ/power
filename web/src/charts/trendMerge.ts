/**
 * v1.188.1 (review) — TrendChart's merge of several history series onto one timeline. PURE.
 *
 * The history endpoint returns a series' own points only, and omits a bucket with no sample. The
 * merged rows are the union of every series' timestamps, so at most rows a series has no point of
 * its own. v0.22.0's merge carried each series' last value forward into every such row with no
 * bound, and the Areas drew `connectNulls`: a Core whose readings were held (offline in the
 * EcoFlow cloud, so the recorder wrote nothing for it, v1.188.1) was painted flat at its last value
 * across the whole gap while a sibling Core kept reporting, and a one-device chart drew one
 * straight segment across it. SolarPanel.tsx fixed the same artefact in v0.44.0.
 *
 * Now a series' value is carried only between two of its own points no further apart than
 * `gapMs` (an unchanged metric is restated every 5 min, so its points can be that far apart with
 * nothing missing), and for at most `gapMs` after its newest point. Inside a longer gap it is null,
 * and a null row is added just after the gap opens, so the line breaks even when no other series
 * has a point inside it. The chart draws nulls as breaks (no `connectNulls`).
 */

export interface TrendPoint {
  ts: number;
  value: number;
}

/** Two heartbeats: the longest stretch with no point that is not a gap (integrateWh's bridge). */
export const TREND_GAP_MS = 10 * 60_000;

/** The gap for a chart whose points are bucketed: never shorter than two buckets. */
export function trendGapMs(bucketSec?: number): number {
  return Math.max(TREND_GAP_MS, 2 * (bucketSec ?? 0) * 1000);
}

export function mergeTrendSeries(
  series: ReadonlyArray<{ key: string; label: string }>,
  dataByKey: Readonly<Record<string, ReadonlyArray<TrendPoint> | undefined>>,
  gapMs: number = TREND_GAP_MS,
): Array<Record<string, number | null>> {
  const all = new Set<number>();
  // Each series' own points in ts order, first write winning on a duplicate ts (as v0.22.0).
  const pointsByKey: Record<string, TrendPoint[]> = {};
  for (const s of series) {
    const seen = new Set<number>();
    const pts: TrendPoint[] = [];
    for (const p of dataByKey[s.key] ?? []) {
      if (seen.has(p.ts)) continue;
      seen.add(p.ts);
      pts.push(p);
    }
    pts.sort((a, b) => a.ts - b.ts);
    pointsByKey[s.key] = pts;
    for (let i = 0; i < pts.length; i++) {
      all.add(pts[i].ts);
      // A gap opens after this point: a row just inside it carries null for this series.
      if (i + 1 < pts.length && pts[i + 1].ts - pts[i].ts > gapMs) all.add(pts[i].ts + 1);
    }
  }
  const sortedTs = Array.from(all).sort((a, b) => a - b);
  const cursor: Record<string, number> = {};
  for (const s of series) cursor[s.key] = -1;
  return sortedTs.map((ts) => {
    const row: Record<string, number | null> = { ts };
    for (const s of series) {
      const pts = pointsByKey[s.key];
      let i = cursor[s.key];
      while (i + 1 < pts.length && pts[i + 1].ts <= ts) i++;
      cursor[s.key] = i;
      if (i < 0) { row[s.label] = null; continue; }   // before its first point
      const at = pts[i];
      if (at.ts === ts) { row[s.label] = at.value; continue; }
      const next = pts[i + 1];
      // Carried only inside a stretch with no gap, and not past gapMs after the newest point.
      const carried = next != null ? next.ts - at.ts <= gapMs : ts - at.ts <= gapMs;
      row[s.label] = carried ? at.value : null;
    }
    return row;
  });
}
