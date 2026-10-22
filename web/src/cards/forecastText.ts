/**
 * forecastText.ts — the hour labels of the Solar page's forecast cards (ForecastDetail.tsx).
 *
 * The server computes the forecast and the learned response table on the site clock: the table's
 * rows are site hours, and GET /api/forecast stamps the zone it worked in (`siteTimeZone`, v1.191.1).
 * An instant the page labels (an hourly projection row, the projected low) is written in that zone,
 * so it names the same hour as the table and the server's own text. Pure, so the server suite runs
 * it (server/test/webSiteTime.test.ts).
 */

import { zonedHourIn } from '../siteTime';

/** "12 AM", "11 AM", "2 PM" for an hour of the day (any integer; wrapped into 0–23). */
export function fmtHour(h: number): string {
  const hr = ((h % 24) + 24) % 24;
  if (hr === 0) return '12 AM';
  if (hr === 12) return '12 PM';
  return hr < 12 ? `${hr} AM` : `${hr - 12} PM`;
}

/** v1.191.1 — the hour label of an instant in the site zone `zone`; it read the browser's clock.
 *  '—' without a zone (an older server) or for an invalid instant: no hour rather than the browser's. */
export function tsHourIn(ts: number, zone: string | null | undefined): string {
  const h = zonedHourIn(ts, zone);
  return h == null ? '—' : fmtHour(h);
}
