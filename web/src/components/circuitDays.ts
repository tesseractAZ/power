/**
 * circuitDays.ts — the CircuitModal's day arithmetic (v1.191.0, lane A, CA25). PURE.
 *
 * "Today" is the SITE's today: the day the server's /api/circuit/history marks `isToday`, computed in
 * the site zone (server/src/siteTime.ts). The browser's own midnight is never used, so a viewer in a
 * different zone from the site sums and labels the same day the server does.
 */
import type { CircuitHistory } from '../types';
import { calendarDaysBetween } from '../siteTime';

export interface Point { ts: number; value: number }

/** The site's today: the date of the day the server's history marks isToday (site zone). */
export function siteTodayYmd(history: CircuitHistory | null): string | null {
  return history?.days.find((d) => d.isToday)?.date ?? null;
}

/** Today's Wh from the 24 h series, from the site day start the server's history reports; null
 *  until that history has loaded. PURE. */
export function todayWhFrom(points: ReadonlyArray<Point>, history: CircuitHistory | null): number | null {
  const dayStart = history?.days.find((d) => d.isToday)?.dayStartMs;
  if (dayStart == null || !Number.isFinite(dayStart)) return null;
  const todayPts = points.filter((p) => p.ts >= dayStart);
  let wh = 0;
  const MAX_GAP = 10 * 60 * 1000;
  for (let i = 1; i < todayPts.length; i++) {
    const dt = todayPts[i].ts - todayPts[i - 1].ts;
    if (dt <= 0 || dt > MAX_GAP) continue;
    wh += ((todayPts[i].value + todayPts[i - 1].value) / 2) * (dt / 3_600_000);
  }
  return wh;
}

/** "Today", "Yest", "Wed", "5/12" — context-sensitive day label, counted from the SITE's today
 *  (v1.191.0, CA25: it was the browser's). PURE. */
export function dayLabel(ymd: string, todayYmd: string | null): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const diffDays = todayYmd ? calendarDaysBetween(ymd, todayYmd) : NaN;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yest';
  if (diffDays > 1 && diffDays < 7) return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
  return `${m}/${d}`;
}
