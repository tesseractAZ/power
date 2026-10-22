/**
 * siteClockFallbackProbe.ts — run by test/siteClockFallback.test.ts in a child process whose
 * environment sets SITE_TIMEZONE, TZ and a tariff (the site zone and the legacy on-peak window are
 * read once, when siteTime.ts and analytics.ts load). Prints one JSON object: for each hour of one
 * site-local week, what the unconfirmed-rate fallback answers (onPeakAt, isOnPeakHour, the hourly
 * rate) beside the tariff model's own window, and the alert clock text of a few instants.
 *
 *   node --import tsx test/helpers/siteClockFallbackProbe.ts
 */
import { siteTimeZone, zonedWallTimeMs, addDaysYmd } from '../../src/siteTime.js';
import { tariffModelFromEnv, rateAt } from '../../src/tariff.js';
import { onPeakAt, isOnPeakHour, hourlyRateCents, resolveTariffCents, mpcFallbackPair } from '../../src/analytics.js';
import { fmtClock } from '../../src/alerts.js';

const zone = siteTimeZone();
const model = tariffModelFromEnv();
const firstDay = '2026-10-19'; // a Monday
const hours: Array<{ ymd: string; hour: number; onPeakAt: boolean; isOnPeakHour: boolean; modelOnPeak: boolean; cost: number; mpc: number }> = [];
for (let d = 0; d < 7; d++) {
  const ymd = addDaysYmd(firstDay, d);
  for (let hour = 0; hour < 24; hour++) {
    const t = zonedWallTimeMs(ymd, hour, 30, zone);
    hours.push({
      ymd, hour,
      onPeakAt: onPeakAt(t),
      isOnPeakHour: isOnPeakHour(t),
      modelOnPeak: rateAt(model, t).isOnPeak,
      cost: hourlyRateCents(t, resolveTariffCents(t)),
      mpc: hourlyRateCents(t, mpcFallbackPair(t)),
    });
  }
}
const clock = Object.fromEntries(['2026-10-21T14:00', '2026-10-21T15:05', '2026-01-15T23:59'].map((k) => {
  const [ymd, hm] = k.split('T');
  const [h, m] = hm.split(':').map(Number);
  return [k, fmtClock(zonedWallTimeMs(ymd, h, m, zone))];
}));
process.stdout.write(JSON.stringify({
  zone, planId: model.planId, ratesConfirmed: model.ratesConfirmed, hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hours, clock,
}));
