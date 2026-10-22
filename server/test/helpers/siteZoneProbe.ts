/**
 * siteZoneProbe.ts — run by test/siteTime.test.ts in a child process whose environment sets
 * SITE_TIMEZONE and TZ (the site zone is resolved once, when siteTime.ts loads). Prints one JSON
 * object: the resolved zone, and what the consumers of the site clock compute under it.
 *
 *   node --import tsx test/helpers/siteZoneProbe.ts
 */
import {
  siteTimeZone, siteTimeZoneSource, siteTimeZoneResolution, siteTimeZoneLogLine, siteDayStartMs, siteNoonIso, siteYmd,
} from '../../src/siteTime.js';
import { siteTimeRepairIssues } from '../../src/siteTimeHa.js';
import { buildApsREvModel, flatTariffModel } from '../../src/tariff.js';
import { nightWindowBounds } from '../../src/nightChargeAdvisor.js';
import { buildImportMessage, VENDOR_STAT_SERIES } from '../../src/haStatistics.js';
import { dailyIdleFloors, coreCoverageByDay } from '../../src/analytics.js';
import { recommendDispatch } from '../../src/dispatch/mpc.js';
import { inQuietWindow } from '../../src/alertMonitor.js';
import type { VendorDayRecord } from '../../src/energyHistory.js';

const HOUR = 3_600_000;
const days = ['2026-01-15', '2026-07-01', '2026-08-15'];

const dayStart: Record<string, number> = {};
const noon: Record<string, string> = {};
const haNoon: Record<string, string> = {};
for (const d of days) {
  dayStart[d] = siteDayStartMs(d);
  noon[d] = siteNoonIso(d);
  const rec = { day: d, homeWh: 1000, solarWh: 1, gridWh: 1, batteryInWh: 1, batteryOutWh: 1 } as unknown as VendorDayRecord;
  haNoon[d] = buildImportMessage(VENDOR_STAT_SERIES[0], [rec])!.stats[0].start;
}

// Two local nights of idle samples, 19:00 → 06:00 local each, hourly.
const series: Array<{ ts: number; w: number }> = [];
for (const night of ['2026-06-10', '2026-06-11']) {
  const start = siteDayStartMs(night) + 19 * HOUR;
  for (let h = 0; h < 12; h++) series.push({ ts: start + h * HOUR, w: 300 + h });
}
const idleNights = dailyIdleFloors(series, 3);

// CA26: the coverage map's day keys over the Berlin DST week (2026-03-26 … 2026-04-01).
const coverage = coreCoverageByDay(new Map(), new Map(), siteDayStartMs('2026-04-02'), 7);
const dstWeekStarts = [...coverage.keys()].sort((a, b) => a - b);
const dstWeekKeys = dstWeekStarts.map((t) => siteYmd(t));

// T9: the MPC's hour-of-day index. A one-hour tariff spike at hour-of-day 15; a battery too small to
// help, so every hour imports its load and the most expensive step is the spike.
const nowMs = Date.UTC(2026, 0, 15, 19);
const mpc = recommendDispatch({
  currentSocPct: 20, reserveFloorPct: 20, capacityKwh: 0.1,
  pvForecastP50: new Array(24).fill(0), pvForecastP10: new Array(24).fill(0),
  loadForecast: new Array(24).fill(2),
  tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => (h === 15 ? 500 : 10)),
  gridAvailable: true, cyclingCostUsdPerKwh: 0.02, reserveDipPenaltyUsdPerKwh: 1, nowMs,
});
let mpcSpikeStep = -1;
let best = -Infinity;
for (const s of mpc.steps) if (s.hourCostUsd > best) { best = s.hourCostUsd; mpcSpikeStep = s.hour; }

const r = siteTimeZoneResolution();
const repairs = siteTimeRepairIssues(r, null);
process.stdout.write(JSON.stringify({
  zone: siteTimeZone(), source: siteTimeZoneSource(), mappedFrom: r.mappedFrom, logLine: siteTimeZoneLogLine(),
  modelTimezone: buildApsREvModel().timezone, flatModelTimezone: flatTariffModel(17).timezone,
  dayStart, noon, haNoon,
  bounds: { '2026-07-01': nightWindowBounds('2026-07-01') },
  idleNights, dstWeekStarts, dstWeekKeys,
  hostHourAt19z: new Date(nowMs).getHours(), mpcSpikeStep,
  quietAt07z: inQuietWindow(new Date(Date.UTC(2026, 0, 15, 7)), [22, 6]),
  repairIds: repairs.map((x) => x.id), repairText: repairs.map((x) => x.summary).join(' | '),
}));
