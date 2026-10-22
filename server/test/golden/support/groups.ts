/**
 * Golden groups G1, G2, G4–G8 (G3 lives in ./g3.ts): characterisation captures of what the code
 * computes TODAY on this install's settings, taken on the unchanged tree. Each group is a function
 * returning plain data; the capture CLI runs it in a child process with TZ=America/Phoenix and
 * writes the encoded JSON, and golden.test.ts runs the same function the same way and compares.
 *
 * Nothing here asserts what the value SHOULD be. The point is that the consolidation lanes
 * (site time, tariff, PV, devices, limits) must leave every figure identical while the new
 * options are unset.
 *
 * Fixture ids are placeholders (…XXX00XXX00NN). The only real literals these groups touch are the
 * bench-spare serials in shp2Membership.ts, which are IMPORTED and replaced by `<SPARE_n>` tokens
 * before anything is written.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { extractDecls } from './extract.js';
import { CURTAIL_TAPER_BAND_PCT, saturationThresholdPct } from '../../../src/chargeTaper.js';
import { withEnv, type EnvPatch } from './env.js';
import {
  apsREvModelFromEnv, buildApsREvModel, apsOffPeakHolidays, APS_OFF_PEAK_HOLIDAYS, APS_SUMMER_MONTHS,
  rateAt, seasonAt, localParts, onPeakWindowStrings, flatTariffModel, cheapPeriodIdOf,
} from '../../../src/tariff.js';
import { nightScheduleOf } from '../../../src/nightSchedule.js';
import { cheapNightOf } from '../../../src/chargeWindows.js';
import { noonPhoenixIso } from '../../../src/haStatistics.js';
import { fmtSiteHm, fmtSiteClock, fmtSiteWeekday, siteMinuteOfDay } from '../../../src/siteTime.js';
import { phoenixYmd } from '../../../src/nightChargeGate.js';
import { startOfLocalDayMs } from '../../../src/aggregator.js';
import {
  fmtPhoenixDayHm, nightWindowBounds, resolveCheapWindow, nextFullCheapWindow, longGapAhead,
  eveningBasisDefers, LONG_GAP_MS,
  PRE_PEAK_SURPLUS_MAX_HOURS, DEFAULT_COST_MAX_SOC_PCT, DEFAULT_OUTAGE_CUSHION_HOURS,
  DEFAULT_ISLANDED_LOAD_SAFETY, nightChargeStateFields, type NightChargePlan,
} from '../../../src/nightChargeAdvisor.js';
import { SCORE_SPAN_AFTER_CLOSE_MS } from '../../../src/nightLedgerScoring.js';
import {
  FORCE_CHARGE_CEILING_MIN_PCT, FORCE_CHARGE_CEILING_MAX_PCT, FORCE_CHARGE_MIN_RUN_MS,
  FORCE_CHARGE_PLAN_RATE_KW, FORCE_CHARGE_MIN_RATE_KW, FORCE_CHARGE_PROVEN_KW_PER_SLOT,
  LEGACY_CHARGE_CAP_KW, FORCE_CHARGE_JIT_BUFFER_MS, FORCE_CHARGE_MAX_RUN_MS, planChargeCapKw,
} from '../../../src/nightForceCharge.js';
import { RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT } from '../../../src/nightChargeActuator.js';
import { physicsPmax, PHOENIX_SITE, solarPosition } from '../../../src/physics/clearSky.js';
import { bridgeSite, sunUp } from '../../../src/energyBridge.js';
import {
  SPARE_DPU_SNS, isBenchSpareSn, benchSpareSns, isExpectedOfflineSpare, homeCoreCoverage,
  isHomePoolDpu, isOutsideHomePool, housePoolFallbackCoverage, housePoolFallbackSoc,
  shp2ConnectedDpuSns, setLastKnownHomeRoster, resetLastKnownHomeRoster,
} from '../../../src/shp2Membership.js';
import { resolveDeviceName, type DeviceSnapshot } from '../../../src/snapshot.js';
import { projectByProduct } from '../../../src/ecoflow/project.js';
import { dpuNum as mathDpuNum } from '../../../src/analytics/mathHelpers.js';
import { coreNumberFromName } from '../../../src/topology.js';
import {
  SENSORS, BINARY_SENSORS, DEVICE_INFO, sensorDiscoveryConfig, planCircuitDiscovery, discoveryUniqueIds,
  legacyUniqueIdsFor, alertSwitchStateTopic, alertSwitchCommandTopic,
} from '../../../src/mqttDiscovery.js';
import { ALARM_PRIORITY_ORDER, ALARM_PRIORITY_META } from '../../../src/alertPriority.js';
import { resolveRetentionDays } from '../../../src/retention.js';
import { DEFAULT_SELF_HEAL_CONFIG } from '../../../src/sessionSelfHeal.js';
import { BATTERY_SOC_THRESHOLDS } from '../../../src/batterySocAlarm.js';
import { limits } from '../../../src/limits.js';
import { PACK_NOMINAL_V, CAPACITY_SCALE_MIN, CAPACITY_SCALE_MAX, PACK_FULL_CAP_MAX_OF_DESIGN } from '../../../src/poolEnergyBasis.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = resolve(HERE, '../../../src');
const src = (f: string) => resolve(SRC, f);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const round = (n: number, d = 6) => (Number.isFinite(n) ? Number(n.toFixed(d)) : n);

/** The capture's clock: everything that formats "now" is fed from this list, never Date.now(). */
const YEARS = [2025, 2026, 2027];
function* hoursOf(years: number[]): Generator<number> {
  const start = Date.UTC(years[0], 0, 1);
  const end = Date.UTC(years[years.length - 1] + 1, 0, 1);
  for (let t = start; t < end; t += HOUR_MS) yield t;
}
function* daysOf(years: number[]): Generator<string> {
  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 1; d <= n; d++) yield `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
}
/** Run-length encode consecutive equal JSON values: [[value, count], …]. */
function rle<T>(values: T[]): Array<[T, number]> {
  const out: Array<[T, number]> = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && JSON.stringify(last[0]) === JSON.stringify(v)) last[1] += 1;
    else out.push([v, 1]);
  }
  return out;
}

/** Replace the imported bench-spare serials with stable tokens in any captured structure. */
export function redactSpares<T>(v: T): T {
  const spares = [...SPARE_DPU_SNS].sort();
  const text = JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? `__nonfinite_${String(x)}` : x));
  let out = text;
  spares.forEach((sn, i) => { out = out.split(sn).join(`<SPARE_${i}>`); });
  return JSON.parse(out, (_k, x) => (typeof x === 'string' && x.startsWith('__nonfinite_') ? Number(x.slice(12)) : x)) as T;
}

/* ───────────────────────────── G1 clock ───────────────────────────── */

interface IndexClockHelpers {
  fmtPhoenixClock(ms: number): string;
  fmtPhoenixWeekday(ms: number): string;
  fmtDeadlineSpoken(ms: number, nowMs: number): string;
  fmtDeadlineSpokenEs(ms: number, nowMs: number): string;
  phoenixMinuteOfDay(ms: number): number;
}

export async function G1(): Promise<unknown> {
  // v1.191.0 (lane A, T2/T3) — index.ts's private fmtPhoenixClock / fmtPhoenixWeekday / phoenixMinuteOfDay
  // (and the Spanish weekday map) moved to siteTime.ts as fmtSiteClock / fmtSiteWeekday /
  // siteMinuteOfDay; the deadline formatters stay in index.ts and are extracted with that import. The
  // probes are re-pointed; the golden is not re-captured.
  const deadline = await extractDecls<Pick<IndexClockHelpers, 'fmtDeadlineSpoken' | 'fmtDeadlineSpokenEs'>>(src('index.ts'),
    ['HOUR_MS', 'fmtDeadlineSpoken', 'fmtDeadlineSpokenEs'],
    `import { fmtSiteClock, fmtSiteWeekday } from '${pathToFileURL(src('siteTime.ts')).href}';`);
  const idx: IndexClockHelpers = {
    fmtPhoenixClock: fmtSiteClock, fmtPhoenixWeekday: (ms) => fmtSiteWeekday(ms), phoenixMinuteOfDay: siteMinuteOfDay,
    fmtDeadlineSpoken: deadline.fmtDeadlineSpoken, fmtDeadlineSpokenEs: deadline.fmtDeadlineSpokenEs,
  };
  // v1.191.0 (lane A, T5) — nightChargeAdvisor's private fmtPhoenixHm moved to siteTime.ts fmtSiteHm (the
  // site zone); the probe is re-pointed at it, the golden is not re-captured.
  const nca = { fmtPhoenixHm: fmtSiteHm };
  const an = await import('../../../src/analytics.js');

  // Explicit hourly rows through the unmemoized Intl formatters: the clock text, HH:MM, the Phoenix
  // day key three ways, hour/dow, minute-of-day at :00 and :30, the host's getHours
  // (TZ=America/Phoenix in the capture), the idle-floor UTC-day bucket and the host's start of local
  // day (as hours before the instant). One pipe-joined string per hour keeps the file readable.
  // Each `new Intl.DateTimeFormat` in those helpers costs ~0.5 ms of wall time at this volume, so
  // they run for every hour of every third day of 2026 plus both US DST-transition days and the year
  // boundaries (the zone math itself is proved for every hour of 2025–2027 below, through the
  // memoized localParts path).
  const hourRow = (t: number): string => {
    const lp = localParts(t, 'America/Phoenix');
    return [
      idx.fmtPhoenixClock(t), nca.fmtPhoenixHm(t), lp.ymd, lp.hour, lp.dow, phoenixYmd(t),
      lp.hour * 60, idx.phoenixMinuteOfDay(t + 30 * 60_000),
      new Date(t).getHours(), Math.floor(t / DAY_MS), (startOfLocalDayMs(new Date(t)) - t) / HOUR_MS,
    ].join('|');
  };
  const sampledDays = new Set(['2026-01-01', '2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02', '2026-12-31']);
  let dayIndex = 0;
  for (const ymd of daysOf([2026])) { if (dayIndex % 3 === 0) sampledDays.add(ymd); dayIndex += 1; }
  const hours2026: string[] = [];
  for (const t of hoursOf([2026])) if (sampledDays.has(localParts(t, 'America/Phoenix').ymd)) hours2026.push(hourRow(t));
  // Every hour of 2025–2027 through the memoized/cheap paths (localParts, the host clock, the idle
  // bucket, startOfLocalDayMs), pinned per year by hash: a mismatch names the year, and the 2026
  // vector above names the hour.
  const cheapRow = (t: number): string => {
    const lp = localParts(t, 'America/Phoenix');
    return `${lp.ymd}|${lp.hour}|${lp.dow}|${new Date(t).getHours()}|${Math.floor(t / DAY_MS)}|${(startOfLocalDayMs(new Date(t)) - t) / HOUR_MS}`;
  };
  const cheapHoursSha256: Record<string, string> = {};
  for (const y of YEARS) {
    const rows: string[] = [];
    for (const t of hoursOf([y])) rows.push(cheapRow(t));
    cheapHoursSha256[String(y)] = sha256(rows.join('\n'));
  }
  // Per day: the fixed-offset day start (index.ts:833 / nightChargeAdvisor nightWindowBounds), the
  // statistics noon, the MPC midnight formula (index.ts:2114-2116) evaluated at that day's noon,
  // and the announcement deadline text for a 21:30 plan whose write lands at 23:55.
  const days: Record<string, unknown> = {};
  for (const ymd of daysOf(YEARS)) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dayStart = Date.UTC(y, m - 1, d, 7, 0, 0);
    const noon = dayStart + 12 * HOUR_MS;
    const PHX_OFFSET_MS = 7 * HOUR_MS;
    const phxMidnightUtcMs = Math.floor((noon - PHX_OFFSET_MS) / DAY_MS) * DAY_MS + PHX_OFFSET_MS;
    const bounds = nightWindowBounds(ymd)!;
    const at2130 = dayStart + 21 * HOUR_MS + 30 * 60_000;
    const deadline = bounds.windowStartMs + 55 * 60_000;
    // Two instants a day through the weekday and day-qualified formatters (00:00 and 23:30).
    const samples = [0, 23 * HOUR_MS + 30 * 60_000].map((off) => {
      const t = dayStart + off;
      return `${idx.fmtPhoenixWeekday(t)}|${idx.phoenixMinuteOfDay(t)}|${fmtPhoenixDayHm(t, t - HOUR_MS)}|${fmtPhoenixDayHm(t, t - 25 * HOUR_MS)}`;
    });
    days[ymd] = {
      dayStart, noonIso: noonPhoenixIso(ymd), phxMidnightUtcMs, weekday: idx.fmtPhoenixWeekday(noon), samples,
      deadlineEn: idx.fmtDeadlineSpoken(deadline, at2130), deadlineEs: idx.fmtDeadlineSpokenEs(deadline, at2130),
      deadlineFarEn: idx.fmtDeadlineSpoken(deadline + 2 * DAY_MS, at2130), deadlineFarEs: idx.fmtDeadlineSpokenEs(deadline + 2 * DAY_MS, at2130),
    };
  }
  // The idle-floor bucketing itself, on a two-night fixture (local 19:00 → 06:00 lands in one UTC day).
  const series: Array<{ ts: number; w: number }> = [];
  const base = Date.UTC(2026, 5, 10, 7); // 2026-06-10 00:00 Phoenix
  for (let i = 0; i < 48; i++) series.push({ ts: base + i * HOUR_MS, w: 300 + (i % 12) * 10 });
  const idle = an.dailyIdleFloors(series, 3);
  // CA17: the worker thread computes the same buckets from the same environment.
  const workerIdle = await inWorker<Array<{ ts: number; value: number }>>(
    `const { dailyIdleFloors } = await import(${JSON.stringify(new URL('../../../src/analytics.ts', import.meta.url).href)});
     parentPort.postMessage(dailyIdleFloors(workerData, 3));`, series);
  return { tz: process.env.TZ, hours2026, cheapHoursSha256, days, idleFloors: idle, idleFloorsWorker: workerIdle, idleFloorsSame: JSON.stringify(idle) === JSON.stringify(workerIdle) };
}

async function inWorker<T>(body: string, data: unknown): Promise<T> {
  const code = `import { parentPort, workerData } from 'node:worker_threads';\n${body}`;
  const w = new Worker(code, { eval: true, workerData: data, execArgv: ['--import', 'tsx'] });
  return new Promise<T>((res, rej) => {
    w.once('message', (m) => { res(m as T); void w.terminate(); });
    w.once('error', rej);
  });
}

/* ───────────────────────────── G2 tariff ───────────────────────────── */

/** The environment matrix the tariff readers are captured under. */
export const TARIFF_ENV_MATRIX: Record<string, EnvPatch> = {
  defaults: {
    TARIFF_APS_ONPEAK_SUMMER_CENTS: '', TARIFF_APS_ONPEAK_WINTER_CENTS: '', TARIFF_APS_OFFPEAK_SUMMER_CENTS: '',
    TARIFF_APS_OFFPEAK_WINTER_CENTS: '', TARIFF_APS_OVERNIGHT_CENTS: '', TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '',
    TARIFF_APS_RATES_CONFIRMED: 'false', TARIFF_FLAT_CENTS_PER_KWH: undefined, TARIFF_ON_PEAK_CENTS: undefined,
    TARIFF_OFF_PEAK_CENTS: undefined, TARIFF_ON_PEAK_CENTS_PER_KWH: undefined, TARIFF_OFF_PEAK_CENTS_PER_KWH: undefined,
    TARIFF_ON_PEAK_HOURS: undefined, TARIFF_ON_PEAK_DAYS: undefined,
  },
  confirmed: {
    TARIFF_APS_ONPEAK_SUMMER_CENTS: '31.17', TARIFF_APS_ONPEAK_WINTER_CENTS: '22.47', TARIFF_APS_OFFPEAK_SUMMER_CENTS: '16.91',
    TARIFF_APS_OFFPEAK_WINTER_CENTS: '15.07', TARIFF_APS_OVERNIGHT_CENTS: '12.59', TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '8.2',
    TARIFF_APS_RATES_CONFIRMED: 'true',
  },
  flatOverride: { TARIFF_APS_RATES_CONFIRMED: 'false', TARIFF_FLAT_CENTS_PER_KWH: '21' },
  twoTierAnalyticsNames: { TARIFF_APS_RATES_CONFIRMED: 'false', TARIFF_ON_PEAK_CENTS: '30', TARIFF_OFF_PEAK_CENTS: '10' },
  twoTierMpcNames: { TARIFF_APS_RATES_CONFIRMED: 'false', TARIFF_ON_PEAK_CENTS_PER_KWH: '30', TARIFF_OFF_PEAK_CENTS_PER_KWH: '10' },
};

export async function G2(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  const periodCode: Record<string, string> = { on_peak: 'P', super_off_peak: 'S', overnight: 'N', off_peak: 'F' };
  // Structure (period, season, on-peak flag) does not depend on the cents: capture it once.
  const structure: string[] = [];
  const model0 = buildApsREvModel();
  for (const t of hoursOf(YEARS)) {
    const r = rateAt(model0, t);
    structure.push(`${periodCode[r.periodId] ?? '?'}${r.season === 'summer' ? 's' : 'w'}${r.isOnPeak ? '!' : ''}`);
  }
  out.structure = structure.join('');
  out.holidays = Object.fromEntries(Array.from({ length: 31 }, (_, i) => 2015 + i).map((y) => [y, apsOffPeakHolidays(y)]));
  out.holidaysTable = APS_OFF_PEAK_HOLIDAYS;
  out.summerMonths = APS_SUMMER_MONTHS;
  out.onPeakWindow = onPeakWindowStrings(model0);
  out.flatModel = flatTariffModel(17);
  out.flatModelNull = flatTariffModel(null);

  const perVariant: Record<string, unknown> = {};
  for (const [name, patch] of Object.entries(TARIFF_ENV_MATRIX)) {
    perVariant[name] = await withEnv({ ...TARIFF_ENV_MATRIX.defaults, ...patch }, async () => {
      // analytics.ts reads TARIFF_FLAT_CENTS_PER_KWH / ON_PEAK_HOURS / DAYS at module load: a fresh copy per variant.
      const an = await import(`../../../src/analytics.ts?g2=${name}`) as typeof import('../../../src/analytics.js');
      const model = apsREvModelFromEnv();
      const cents: Array<number | null> = [];
      const hourly: number[] = [];
      const onPeakHour: boolean[] = [];
      const fallback = an.resolveTariffCents(Date.UTC(2026, 0, 15, 19));
      for (const t of hoursOf([2026])) {
        cents.push(rateAt(model, t).centsPerKwh);
        hourly.push(an.hourlyRateCents(t, fallback));
        onPeakHour.push(an.isOnPeakHour(t));
      }
      const samples: Record<string, unknown> = {};
      for (const ymd of ['2026-01-15', '2026-04-01', '2026-07-04', '2026-09-30', '2026-10-01', '2026-12-25']) {
        const [y, m, d] = ymd.split('-').map(Number);
        const noon = Date.UTC(y, m - 1, d, 19);
        samples[ymd] = {
          resolveTariffCents: an.resolveTariffCents(noon),
          season: seasonAt(model, noon),
          apsSeasonIsSummer: an.apsSeasonIsSummer(noon),
          pricingView: an.tariffPricingView(model, noon, an.resolveTariffCents(noon), { hours: process.env.TARIFF_ON_PEAK_HOURS ?? '15-20', days: process.env.TARIFF_ON_PEAK_DAYS ?? '1-5' }),
        };
      }
      // index.ts:2099-2118 — the MPC tariff vector for one day, built from the fixed-offset midnight.
      const flatCents = Number(process.env.TARIFF_FLAT_CENTS_PER_KWH ?? 17);
      const onPeak = Number(process.env.TARIFF_ON_PEAK_CENTS_PER_KWH ?? flatCents);
      const offPeak = Number(process.env.TARIFF_OFF_PEAK_CENTS_PER_KWH ?? flatCents);
      const PHX_OFFSET_MS = 7 * HOUR_MS;
      const now = Date.UTC(2026, 2, 10, 21); // 2026-03-10 14:00 Phoenix
      const phxMidnightUtcMs = Math.floor((now - PHX_OFFSET_MS) / DAY_MS) * DAY_MS + PHX_OFFSET_MS;
      const mpcVector = Array.from({ length: 24 }, (_, h) => an.hourlyRateCents(phxMidnightUtcMs + h * HOUR_MS, { onPeak, offPeak }));
      // /api/tariff → analytics.report('tariff') → computeTariffReport on an empty recorder.
      const { makeRecorderStub } = await import('../../helpers/recorderStub.js');
      const report = an.computeTariffReport({}, makeRecorderStub(), 7) as unknown as Record<string, unknown>;
      delete report.generatedAt;
      return {
        model, cents: rle(cents), hourlyRateCents: rle(hourly), isOnPeakHour: rle(onPeakHour), samples,
        mpc: { flatCents, onPeak, offPeak, phxMidnightUtcMs, vector: mpcVector },
        report,
      };
    });
  }
  out.variants = perVariant;
  return out;
}

/* ───────────────────────────── G4 schedule ───────────────────────────── */

interface IndexScheduleHelpers { clampInt(v: number, lo: number, hi: number, dflt: number): number }

export async function G4(): Promise<unknown> {
  // v1.191.0 (W1, S6) — the cheap period is the model's own (tariff.ts cheapPeriodIdOf; it was index.ts's
  // NIGHT_CHEAP_PERIOD_ID constant) and the schedule is nightSchedule.ts's (the APS constants on the
  // preset); the probe reads them there. The values the golden holds are unchanged.
  const idx = await extractDecls<IndexScheduleHelpers>(src('index.ts'), ['clampInt']);
  const model = apsREvModelFromEnv();
  const periodIdAt = (ts: number): string => rateAt(model, ts).periodId;
  const cheap = cheapPeriodIdOf(model)!;
  // v1.191.0 (review) — the night bound index.ts passes (chargeWindows.ts cheapNightOf): none on the preset.
  const night = cheapNightOf(model);
  if (night !== null) throw new Error('G4: the APS R-EV preset has no night bound');
  const schedOf = (fireMin: number) => nightScheduleOf(model, { hour: Math.floor(fireMin / 60), minute: fireMin % 60 });
  const sched = schedOf(21 * 60 + 30);
  const days: Record<string, unknown> = {};
  for (const ymd of daysOf(YEARS)) {
    const b = nightWindowBounds(ymd, sched.fallbackNight)!;
    const dayStart = b.windowStartMs - 23 * HOUR_MS;
    const at2130 = dayStart + 21 * HOUR_MS + 30 * 60_000;
    const win = resolveCheapWindow(periodIdAt, at2130, cheap, 30, night);
    const nextFull = win ? nextFullCheapWindow(periodIdAt, win.endMs, cheap, 120, sched.fullWindowMinMs, night) : null;
    const nextWin = win ? resolveCheapWindow(periodIdAt, win.endMs + HOUR_MS, cheap, 96, night) : null;
    days[ymd] = {
      bounds: b,
      window: win,
      nextFull,
      nextWindow: nextWin,
      longGapAhead: longGapAhead(win, nextFull, sched.fullWindowMinMs),
      morningEndMs: win ? win.endMs + 14 * HOUR_MS : null, // index.ts:3591
      latestCompleteAt2130: phoenixYmd(at2130 - sched.fallbackNight.completeMin * 60_000), // nightChargeGate.ts:248
      latestCompleteAt0600: phoenixYmd(dayStart + 6 * HOUR_MS - sched.fallbackNight.completeMin * 60_000),
      midWindowResolve: resolveCheapWindow(periodIdAt, b.windowStartMs + 2 * HOUR_MS, cheap, 30, night),
    };
  }
  // The evening-job decisions on a 15-minute grid for the default (21:30) and a non-default
  // (20:00) notify time: too early / fire / missed (index.ts runNightChargeEveningJobInner), stale-basis
  // deferral (nightChargeAdvisor.ts eveningBasisDefers at the schedule's deferral end).
  const grid: Record<string, unknown> = {};
  for (const [label, fire] of [['default-2130', 21 * 60 + 30], ['nondefault-2000', 20 * 60]] as const) {
    const sc = schedOf(fire);
    const fireMin = sc.notify.fireMin;
    const rows: string[] = [];
    for (let nowMin = 18 * 60; nowMin < 24 * 60; nowMin += 15) {
      const cutoffMin = sc.eveningCutoffMin;
      const decision = nowMin < fireMin ? 'early' : nowMin >= cutoffMin ? 'missed' : 'fire';
      const deferTransient = eveningBasisDefers({ basisComplete: false, basisTransient: true }, nowMin, sc.staleDeferUntilMin);
      const deferNull = eveningBasisDefers(null, nowMin, sc.staleDeferUntilMin);
      const deferPersistent = eveningBasisDefers({ basisComplete: false, basisTransient: false }, nowMin, sc.staleDeferUntilMin);
      rows.push(`${nowMin}:${decision}:${deferTransient ? 'D' : '-'}${deferNull ? 'D' : '-'}${deferPersistent ? 'D' : '-'}`);
    }
    grid[label] = rows;
  }
  const notifyClamp: Record<string, unknown> = {};
  for (const raw of [undefined, '', 'null', '21', '22', '23', '0', '-1', '7.6', 'abc']) {
    const hour = idx.clampInt(Number(raw ?? 21), 0, 22, 21);
    const minute = idx.clampInt(Number(raw ?? 30), 0, 59, 30);
    const n = nightScheduleOf(model, { hour, minute }).notify;
    notifyClamp[raw === undefined ? '<unset>' : raw] = { hour: n.hour, minute: n.minute };
  }
  return {
    cheapPeriodId: cheap,
    constants: {
      NIGHT_PLAN_STALE_DEFER_UNTIL_MIN: sched.staleDeferUntilMin, FULL_CHEAP_WINDOW_MIN_MS: sched.fullWindowMinMs, LONG_GAP_MS, PRE_PEAK_SURPLUS_MAX_HOURS,
      SCORE_SPAN_AFTER_CLOSE_MS, FORCE_CHARGE_MAX_RUN_MS: sched.forceChargeMaxRunMs, eveningCutoffMin: sched.eveningCutoffMin,
      DEFAULT_COST_MAX_SOC_PCT, DEFAULT_OUTAGE_CUSHION_HOURS, DEFAULT_ISLANDED_LOAD_SAFETY,
    },
    notifyClamp, grid, days,
  };
}

/* ───────────────────────────── G5 physics ───────────────────────────── */

export async function G5(): Promise<unknown> {
  // v1.189.0 — the taper band and threshold moved from private declarations in analytics.ts to the
  // exported chargeTaper.ts; the probe is re-pointed at the export (imported above), the golden is not.
  const an = { CURTAIL_TAPER_BAND_PCT, saturationThresholdPct };
  const analytics = await import('../../../src/analytics.js');
  const hourly: string[] = [];
  for (const t of hoursOf([2026])) {
    const r = physicsPmax(t, 30, PHOENIX_SITE);
    hourly.push([round(r.pMaxW, 3), round(r.poaIrradiance, 3), round(r.ghi, 3), round(r.cellTempC, 4), round(r.solarElevation, 5), r.notes].join('|'));
  }
  const sites = {
    default: bridgeSite({ forecastLat: 33.4484, forecastLon: -112.074 }),
    custom: bridgeSite({ forecastLat: 52.52, forecastLon: 13.405 }),
    nan: bridgeSite({ forecastLat: NaN, forecastLon: -112.074 }),
    outOfRange: bridgeSite({ forecastLat: 91, forecastLon: 0 }),
  };
  const sunUpSamples: Record<string, boolean[]> = {};
  for (const ymd of ['2026-03-20', '2026-06-21', '2026-12-21']) {
    const [y, m, d] = ymd.split('-').map(Number);
    sunUpSamples[ymd] = Array.from({ length: 24 }, (_, h) => sunUp(Date.UTC(y, m - 1, d, 7) + h * HOUR_MS, sites.default));
  }
  const noonPos = solarPosition(new Date(Date.UTC(2026, 5, 21, 19, 30)), PHOENIX_SITE.lat, PHOENIX_SITE.lon);
  return {
    site: PHOENIX_SITE,
    BAYES_OBS_SIGMA2: analytics.BAYES_OBS_SIGMA2,
    curtailment: { taperBandPct: an.CURTAIL_TAPER_BAND_PCT, thresholds: Object.fromEntries([null, 0, 80, 90, 95, 100].map((c) => [String(c), an.saturationThresholdPct(c)])) },
    bridgeSites: sites,
    sunUpSamples,
    noonSolarPosition: { elevation: round(noonPos.elevation), azimuth: round(noonPos.azimuth), cosZenith: round(noonPos.cosZenith) },
    pmaxHourly2026: hourly,
  };
}

/* ───────────────────────────── G6 topology ───────────────────────────── */

const FIX = {
  panel: 'HD31XXX00XXX0001',
  cores: ['Y711XXX00XXX0001', 'Y711XXX00XXX0002', 'Y711XXX00XXX0003'],
  bench: 'Y711XXX00XXX0004', // a bench unit the literal does not name
  generic: 'KT21XXX00XXX0005',
};

function dpu(sn: string, name: string, o: { online?: boolean; soc?: number | null } = {}): DeviceSnapshot {
  return {
    sn, deviceName: name, productName: 'DELTA Pro Ultra', online: o.online ?? true, lastUpdated: 1_800_000_000_000,
    projection: { kind: 'dpu', soc: o.soc === undefined ? 50 : o.soc } as unknown as DeviceSnapshot['projection'],
  } as unknown as DeviceSnapshot;
}
function shp2(sn: string, connected: string[], o: { online?: boolean; noProjection?: boolean } = {}): DeviceSnapshot {
  const d: Record<string, unknown> = { sn, deviceName: 'Panel', productName: 'Smart Home Panel 2', online: o.online ?? true, lastUpdated: 1_800_000_000_000 };
  if (!o.noProjection) {
    d.projection = {
      kind: 'shp2', sources: connected.map((c, i) => ({ slot: i + 1, sn: c, isConnected: true, hwConnect: true })),
      backupBatPercent: 50, circuits: [],
    };
  }
  return d as unknown as DeviceSnapshot;
}
const byId = (list: DeviceSnapshot[]): Record<string, DeviceSnapshot> => Object.fromEntries(list.map((d) => [d.sn, d]));

export async function G6(): Promise<unknown> {
  const snap = await extractDecls<{ guessProductFromName(n: string): string }>(src('snapshot.ts'), ['guessProductFromName']);
  // v1.191.0 (lane D) — alerts.ts's private dpuNum copy is gone: alerts.ts numbers a named Core with
  // topology.ts coreNumberFromName (through coreNumber), so that is what the `alerts` column runs. The
  // console's two helpers and the repair card's predicate now call topology.ts, imported by the prelude;
  // their own text still runs.
  const al = { dpuNum: coreNumberFromName };
  const topologyImport = `import { coreNumberFromName, isDpuProduct, isShp2Product } from '${pathToFileURL(src('topology.ts')).href}';`;
  const tui = await extractDecls<{ dpuNum(n: string): number; generatorNumber(n: string, i: number): number }>(src('telnet/plant/data.ts'), ['dpuNum', 'generatorNumber'], topologyImport);
  const rep = await extractDecls<{ isCoreOrShp2(p: string): boolean }>(src('repairIssues.ts'), ['isCoreOrShp2'], topologyImport);
  const spares = [...SPARE_DPU_SNS].sort();
  const allDpus = [...FIX.cores, FIX.bench, ...spares];
  const devicesWith = (connected: string[], o: { panel?: 'live' | 'dark' | 'none' | 'noProjection' } = {}): Record<string, DeviceSnapshot> => {
    const list = allDpus.map((sn, i) => dpu(sn, spares.includes(sn) ? `Core ${4 + spares.indexOf(sn)}` : `Core ${i + 1}`, { online: !spares.includes(sn) && sn !== FIX.bench }));
    if (o.panel === 'live' || o.panel === undefined) list.push(shp2(FIX.panel, connected));
    else if (o.panel === 'dark') list.push(shp2(FIX.panel, [], { online: false }));
    else if (o.panel === 'noProjection') list.push(shp2(FIX.panel, [], { noProjection: true }));
    return byId(list);
  };
  // The roster matrix: live panel naming the three home Cores (one of which the literal calls a
  // spare), the same panel cloud-dark with and without a remembered roster, a cold boot with no
  // panel at all (CA5), and a panel whose quota has not hydrated.
  const homeRoster = [FIX.cores[0], FIX.cores[1], spares[1] ?? FIX.cores[2]];
  const cases: Record<string, { devices: Record<string, DeviceSnapshot>; remembered: string[] | null }> = {
    livePanel: { devices: devicesWith(homeRoster), remembered: null },
    darkPanelRemembered: { devices: devicesWith([], { panel: 'dark' }), remembered: homeRoster },
    darkPanelNoRoster: { devices: devicesWith([], { panel: 'dark' }), remembered: null },
    coldBootNoPanel: { devices: devicesWith([], { panel: 'none' }), remembered: null },
    coldBootRemembered: { devices: devicesWith([], { panel: 'none' }), remembered: homeRoster },
    panelNoProjection: { devices: devicesWith([], { panel: 'noProjection' }), remembered: null },
  };
  const matrix: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cases)) {
    const remembered = c.remembered ? new Set(c.remembered) : null;
    for (const published of [false, true]) {
      resetLastKnownHomeRoster();
      if (published && remembered) setLastKnownHomeRoster(remembered);
      const connected = shp2ConnectedDpuSns(c.devices);
      const perSn: Record<string, unknown> = {};
      for (const sn of allDpus) {
        perSn[sn] = {
          isBenchSpareSn: isBenchSpareSn(sn, published ? undefined : remembered),
          isExpectedOfflineSpare: isExpectedOfflineSpare(sn, c.devices, published ? undefined : remembered),
          isHomePoolDpu: isHomePoolDpu(sn, c.devices, published ? undefined : remembered),
          isOutsideHomePool: isOutsideHomePool(sn, c.devices),
        };
      }
      matrix[`${name}${published ? '/published' : '/explicit'}`] = {
        connected: [...connected].sort(),
        benchSpareSns: benchSpareSns(published ? undefined : remembered),
        homeCoreCoverage: homeCoreCoverage(c.devices, published ? undefined : remembered),
        housePoolFallbackCoverage: housePoolFallbackCoverage(c.devices, published ? undefined : remembered),
        housePoolFallbackSoc: housePoolFallbackSoc(c.devices, published ? undefined : remembered),
        perSn,
      };
    }
  }
  resetLastKnownHomeRoster();
  const nameCorpus = ['Core 3', 'core 12', 'Core12', 'DELTA-PRO-ULTRA-3', 'Garage Core', 'Y711XXX00XXX0007', '7', 'Panel', '', 'Core 0', 'Core -2', 'Core 3 (bench)'];
  const dpuNums = Object.fromEntries(nameCorpus.map((n) => [n, { alerts: al.dpuNum(n), mathHelpers: mathDpuNum(n), tui: tui.dpuNum(n), generatorNumber: tui.generatorNumber(n, 2) }]));
  const productCorpus = ['DELTA Pro Ultra', 'delta pro ultra', 'Smart Home Panel 2', 'Smart Home Panel', 'PowerInsight', 'DELTA 3 Plus', 'RIVER 3 Plus', 'EVSE', 'Car Charger', 'WAVE 2', 'Smart Generator 3000', 'Core 5', 'core x', 'Unknown', ''];
  const productKinds = Object.fromEntries(productCorpus.map((p) => [p, {
    guessProductFromName: snap.guessProductFromName(p),
    projectByProduct: projectByProduct(p, {}).kind,
    isCoreOrShp2: rep.isCoreOrShp2(p),
    includesDeltaProUltra: p.toLowerCase().includes('delta pro ultra'),
    includesSmartHomePanel: p.toLowerCase().includes('smart home panel'),
  }]));
  const names = [
    ['Core 1', 'DELTA Pro Ultra', FIX.cores[0]], ['', 'DELTA Pro Ultra', FIX.cores[0]], [FIX.cores[0], 'DELTA Pro Ultra', FIX.cores[0]],
    [` ${FIX.cores[0]} `, '', FIX.cores[0]], [null, null, FIX.generic], ['  Padded  ', 'WAVE 2', FIX.generic],
  ] as const;
  const resolvedNames = names.map(([n, p, sn]) => ({ in: [n, p, sn], out: resolveDeviceName(n, p, sn) }));
  // index.ts:859 — the warranty export's default serial, pinned by hash so the literal is never copied.
  const indexSrc = readFileSync(src('index.ts'), 'utf8');
  const warranty = /req\.query\.sn \?\? '([A-Z0-9]{16})'/.exec(indexSrc);
  // The image alias file (snapshot.ts:16-25): keys by hash, values verbatim.
  const aliases = JSON.parse(readFileSync(resolve(SRC, '../device-aliases.json'), 'utf8')) as { aliases: Record<string, string> };
  return {
    spareLiteralCount: spares.length,
    spareLiteralSha256: spares.map(sha256),
    matrix, dpuNums, productKinds, resolvedNames,
    warrantyDefaultSha256: warranty ? sha256(warranty[1]) : null,
    aliasFile: Object.entries(aliases.aliases).map(([sn, name]) => ({ snSha256: sha256(sn), name })),
  };
}

/* ───────────────────────────── G7 MQTT discovery ───────────────────────────── */

export async function G7(): Promise<unknown> {
  const mq = await extractDecls<{ STATE_TOPIC: string; AVAILABILITY_TOPIC: string; AVAILABILITY_BASE: Record<string, unknown>; EXPIRE_AFTER_S: number; SWITCH_ON: string; SWITCH_OFF: string }>(
    src('mqttDiscovery.ts'), ['STATE_TOPIC', 'AVAILABILITY_TOPIC', 'AVAILABILITY_BASE', 'EXPIRE_AFTER_S', 'SWITCH_ON', 'SWITCH_OFF']);
  const prefix = 'homeassistant';
  const sensors = SENSORS.map((s) => ({ topic: `${prefix}/sensor/${s.unique_id}/config`, cfg: sensorDiscoveryConfig(s) }));
  // mqttDiscovery.ts publishDiscovery: the binary-sensor and switch configs, mirrored field for field.
  const binaries = BINARY_SENSORS.map((s) => ({
    topic: `${prefix}/binary_sensor/${s.unique_id}/config`,
    cfg: { ...s, state_topic: mq.STATE_TOPIC, ...mq.AVAILABILITY_BASE, expire_after: s.expire_after ?? mq.EXPIRE_AFTER_S, device: DEVICE_INFO },
  }));
  const switches = ALARM_PRIORITY_ORDER.map((p) => {
    const meta = ALARM_PRIORITY_META[p];
    const uniqueId = `ecoflow_alerts_${p}`;
    return {
      topic: `${prefix}/switch/${uniqueId}/config`,
      cfg: {
        unique_id: uniqueId, object_id: `ecoflow_alarms_${p}_${meta.isa.toLowerCase()}`, name: `Alarms — ${meta.label} (${meta.isa})`,
        state_topic: alertSwitchStateTopic(p), command_topic: alertSwitchCommandTopic(p), ...mq.AVAILABILITY_BASE,
        payload_on: mq.SWITCH_ON, payload_off: mq.SWITCH_OFF, optimistic: false, icon: 'mdi:bell-ring', entity_category: 'config', device: DEVICE_INFO,
      },
    };
  });
  const circuits = [
    { ch: 1, name: 'East Wing' }, { ch: 2, name: 'Kitchen' }, { ch: 3, name: 'Range L1', linkCh: 4, linkMark: true },
    { ch: 4, name: 'Circuit 4', linkCh: 3, linkMark: true }, { ch: 5, name: null }, { ch: 6, name: 'EV Charger' },
  ];
  const circuitPlan = planCircuitDiscovery(prefix, [7, 8], circuits);
  // The night-charge window strings HA automations gate on (nightChargeAdvisor.ts nightChargeStateFields).
  const nowMs = Date.UTC(2026, 2, 7, 4, 30); // Fri 2026-03-06 21:30 Phoenix
  const plan = (startMs: number, endMs: number, generatedAt: number): NightChargePlan => ({
    generatedAt, basisComplete: true, chargeTonight: true, setpointSocPct: 45, targetSocPct: 62, buyKwh: 18.5, expectedBuyKwh: 15.2,
    window: { startMs, endMs },
  } as unknown as NightChargePlan);
  const stateFields = {
    tonight: nightChargeStateFields(plan(nowMs + 1.5 * HOUR_MS, nowMs + 7.5 * HOUR_MS, nowMs), nowMs),
    saturdayPlanMondayWindow: nightChargeStateFields(plan(nowMs + DAY_MS + 25.5 * HOUR_MS, nowMs + DAY_MS + 31.5 * HOUR_MS, nowMs), nowMs),
    stale: nightChargeStateFields(plan(nowMs + 1.5 * HOUR_MS, nowMs + 7.5 * HOUR_MS, nowMs - 13 * HOUR_MS), nowMs),
    none: nightChargeStateFields(null, nowMs),
  };
  return {
    device: DEVICE_INFO,
    topics: { state: mq.STATE_TOPIC, availability: mq.AVAILABILITY_TOPIC },
    counts: { sensors: SENSORS.length, binaries: BINARY_SENSORS.length, switches: switches.length },
    uniqueIds: discoveryUniqueIds(circuits),
    legacyIds: Object.fromEntries(SENSORS.slice(0, 12).map((s) => [s.unique_id, legacyUniqueIdsFor(s.unique_id)])),
    sensors, binaries, switches, circuitPlan, stateFields,
  };
}

/* ───────────────────────────── G8 limits ───────────────────────────── */

interface AnalyticsLimits {
  EV_MAX_LOAD_W: number; EV_PLATEAU_MIN_W: number; DEFAULT_GRID_CO2_LB_PER_MWH: number; LB_PER_MWH_TO_KG_PER_KWH: number; KG_CO2_PER_MILE: number;
  FORECAST_NIGHT_START_HOUR: number; FORECAST_NIGHT_END_HOUR: number; DEFAULT_OPPORTUNISTIC_LOADS: unknown[];
  FORECAST_RECENT_LOAD_WINDOW_MS: number; FORECAST_NIGHT_OVERPREDICT_RATIO: number; FORECAST_NIGHT_BLEND: number; FORECAST_NIGHT_MAX_TRIM: number;
}
const LIMIT_NAMES = ['EV_MAX_LOAD_W', 'EV_PLATEAU_MIN_W', 'DEFAULT_GRID_CO2_LB_PER_MWH', 'LB_PER_MWH_TO_KG_PER_KWH', 'KG_CO2_PER_MILE',
  'FORECAST_NIGHT_START_HOUR', 'FORECAST_NIGHT_END_HOUR', 'DEFAULT_OPPORTUNISTIC_LOADS', 'FORECAST_RECENT_LOAD_WINDOW_MS',
  'FORECAST_NIGHT_OVERPREDICT_RATIO', 'FORECAST_NIGHT_BLEND', 'FORECAST_NIGHT_MAX_TRIM'];

/** v1.191.0 — the module the extracted limit constants read (analytics.ts, batterySocAlarm.ts). */
const LIMITS_PRELUDE = `import { limits, SOC_HEALTHY_BASELINE_PCT } from ${JSON.stringify(pathToFileURL(src('limits.ts')).href)};`;

/** The environment-only knobs lane E bridges, captured unset and set (the set values take effect today). */
export const LIMITS_ENV_MATRIX: Record<string, EnvPatch> = {
  unset: {
    EV_MAX_LOAD_W: undefined, EV_PLATEAU_MIN_W: undefined, RUNWAY_POOL_OVERHEAD_FLOOR_W: undefined, RUNWAY_CORE_OVERHEAD_W: undefined,
    RUNWAY_DRAIN_MARGINAL_EFFICIENCY: undefined, RUNWAY_DISCHARGE_EFFICIENCY: undefined, BMS_RESEED_MIN_GAP_WH: undefined, BMS_RESEED_SUSTAINED_ROLLUPS: undefined,
    GRID_CO2_INTENSITY_LB_PER_MWH: undefined, CYCLING_BASE_WEAR_USD_PER_KWH: undefined, FORECAST_NIGHT_START_HOUR: undefined, FORECAST_NIGHT_END_HOUR: undefined,
    SELF_HEAL_MIN_DEVICES: undefined, BATTERY_SOC_MAX_DROP_PCT: undefined, DISPATCH_ROUND_TRIP_EFFICIENCY: undefined, MPC_ROUND_TRIP_EFFICIENCY: undefined,
    TARIFF_EXPORT_CENTS_PER_KWH: undefined, ARB_GRID_INPUT_CAP_KW: undefined, ARB_CHARGE_CAP_KW: undefined,
  },
  set: {
    EV_MAX_LOAD_W: '7200', EV_PLATEAU_MIN_W: '4000', RUNWAY_POOL_OVERHEAD_FLOOR_W: '180', RUNWAY_CORE_OVERHEAD_W: '60.5',
    RUNWAY_DRAIN_MARGINAL_EFFICIENCY: '0.9', RUNWAY_DISCHARGE_EFFICIENCY: '0.9', BMS_RESEED_MIN_GAP_WH: '30000', BMS_RESEED_SUSTAINED_ROLLUPS: '3',
    GRID_CO2_INTENSITY_LB_PER_MWH: '800', CYCLING_BASE_WEAR_USD_PER_KWH: '0.02', FORECAST_NIGHT_START_HOUR: '22', FORECAST_NIGHT_END_HOUR: '6',
    SELF_HEAL_MIN_DEVICES: '3', BATTERY_SOC_MAX_DROP_PCT: '30', DISPATCH_ROUND_TRIP_EFFICIENCY: '0.9', MPC_ROUND_TRIP_EFFICIENCY: '0.85',
    TARIFF_EXPORT_CENTS_PER_KWH: '5', ARB_GRID_INPUT_CAP_KW: '19', ARB_CHARGE_CAP_KW: '12',
  },
  invalid: {
    EV_MAX_LOAD_W: '-5', EV_PLATEAU_MIN_W: '-1', RUNWAY_POOL_OVERHEAD_FLOOR_W: '9000', RUNWAY_CORE_OVERHEAD_W: 'abc',
    RUNWAY_DRAIN_MARGINAL_EFFICIENCY: '2', RUNWAY_DISCHARGE_EFFICIENCY: '0.5', BMS_RESEED_MIN_GAP_WH: 'abc', BMS_RESEED_SUSTAINED_ROLLUPS: '',
    GRID_CO2_INTENSITY_LB_PER_MWH: '', CYCLING_BASE_WEAR_USD_PER_KWH: 'x', FORECAST_NIGHT_START_HOUR: '25', FORECAST_NIGHT_END_HOUR: '-3',
    SELF_HEAL_MIN_DEVICES: '', BATTERY_SOC_MAX_DROP_PCT: 'abc', DISPATCH_ROUND_TRIP_EFFICIENCY: '2', MPC_ROUND_TRIP_EFFICIENCY: 'abc',
    TARIFF_EXPORT_CENTS_PER_KWH: 'abc', ARB_GRID_INPUT_CAP_KW: '0', ARB_CHARGE_CAP_KW: '-1',
  },
};

export async function G8(): Promise<unknown> {
  // v1.191.0 — gridInputCapKwFromEnv reads its config.ts row (lane E); the extract imports `option`.
  const idx = await extractDecls<{ gridInputCapKwFromEnv(): number | null }>(src('index.ts'), ['gridInputCapKwFromEnv'],
    `import { option } from ${JSON.stringify(pathToFileURL(src('config.ts')).href)};`);
  const variants: Record<string, unknown> = {};
  for (const [name, patch] of Object.entries(LIMITS_ENV_MATRIX)) {
    variants[name] = await withEnv({ ...LIMITS_ENV_MATRIX.unset, ...patch }, async () => {
      // v1.191.0 — the limit constants read limits.ts (lane E); the extract imports it, nothing else changes.
      const an = await extractDecls<AnalyticsLimits>(src('analytics.ts'), LIMIT_NAMES, LIMITS_PRELUDE);
      const analytics = await import(`../../../src/analytics.ts?g8=${name}`) as typeof import('../../../src/analytics.js');
      // v1.191.0 (S5) — the two round-trip efficiencies are named in limits.ts (DECISION 9) and read once at
      // its load, so a fresh copy per variant (analytics.ts re-exports the cached one); mpc.ts reads the flat
      // and export cents through tariff.ts legacyTariffFromEnv (a per-call reader). Re-pointed, not re-captured.
      // (limitsMod: this variant's copy of limits.ts; the `limits` getters lane E reads below are per access.)
      const limitsMod = await import(`../../../src/limits.ts?g8=${name}`) as typeof import('../../../src/limits.js');
      const mpc = await extractDecls<{ ROUND_TRIP_EFFICIENCY: number; EXPORT_TARIFF_CENTS: number; TARIFF_FALLBACK_CENTS: number; MAX_C_RATE: number }>(
        src('dispatch/mpc.ts'), ['ROUND_TRIP_EFFICIENCY', 'EXPORT_TARIFF_CENTS', 'TARIFF_FALLBACK_CENTS', 'MAX_C_RATE'],
        `import { legacyTariffFromEnv } from '${pathToFileURL(src('tariff.ts')).href}';\nimport { MPC_ROUND_TRIP_EFFICIENCY } from '${pathToFileURL(src('limits.ts')).href}?g8=${name}';`);
      const bat = await extractDecls<{ MAX_PLAUSIBLE_DROP_PCT: number; HEALTHY_BASELINE_PCT: number }>(src('batterySocAlarm.ts'), ['MAX_PLAUSIBLE_DROP_PCT', 'HEALTHY_BASELINE_PCT'], LIMITS_PRELUDE);
      const selfHeal = await import(`../../../src/sessionSelfHeal.ts?g8=${name}`) as typeof import('../../../src/sessionSelfHeal.js');
      const evCap = analytics.evLoadByHour([{ ts: 0, durationHours: 1, watts: 99_999 }]).get(0);
      const overheadTable: Record<string, number> = {};
      for (const cores of [0, 1, 2, 3, 4]) for (const reported of [true, false]) overheadTable[`${cores}/${reported}`] = analytics.runwayPoolOverheadW(cores, reported);
      const chargeCap: Record<string, number> = {};
      const optionKw = Number(process.env.ARB_CHARGE_CAP_KW ?? 0);
      for (const slots of [null, 0, 1, 2, 3, 4]) chargeCap[String(slots)] = planChargeCapKw(optionKw, slots, Math.sqrt(limitsMod.DISPATCH_ROUND_TRIP_EFFICIENCY));
      // recorder.ts — the reseed gap is read inside createRecorder. v1.191.0: through limits.ts (lane E),
      // read here from the same getters (before: the expression mirrored).
      const RESEED_MIN_GAP_WH = limits.bmsReseedMinGapWh;
      const RESEED_SUSTAINED_ROLLUPS = limits.bmsReseedSustainedRollups;
      const cyclingBaseWear = limits.cyclingBaseWearUsdPerKwh; // index.ts:2134 — v1.191.0: its reader (limits.ts), was mirrored
      return {
        ev: { EV_MAX_LOAD_W: an.EV_MAX_LOAD_W, evLoadByHourCap: evCap, EV_PLATEAU_MIN_W: an.EV_PLATEAU_MIN_W },
        runway: {
          RUNWAY_DISCHARGE_EFFICIENCY: analytics.RUNWAY_DISCHARGE_EFFICIENCY, RUNWAY_POOL_OVERHEAD_FLOOR_W: analytics.RUNWAY_POOL_OVERHEAD_FLOOR_W,
          RUNWAY_CORE_OVERHEAD_W: analytics.RUNWAY_CORE_OVERHEAD_W, RUNWAY_DRAIN_MARGINAL_EFFICIENCY: analytics.RUNWAY_DRAIN_MARGINAL_EFFICIENCY, overheadTable,
        },
        chargeCaps: { optionKw, chargeCap, gridInputCapKw: idx.gridInputCapKwFromEnv() },
        reseed: { RESEED_MIN_GAP_WH, RESEED_SUSTAINED_ROLLUPS },
        co2: { DEFAULT_GRID_CO2_LB_PER_MWH: an.DEFAULT_GRID_CO2_LB_PER_MWH, LB_PER_MWH_TO_KG_PER_KWH: an.LB_PER_MWH_TO_KG_PER_KWH, KG_CO2_PER_MILE: an.KG_CO2_PER_MILE, cyclingBaseWear },
        nightHours: { FORECAST_NIGHT_START_HOUR: an.FORECAST_NIGHT_START_HOUR, FORECAST_NIGHT_END_HOUR: an.FORECAST_NIGHT_END_HOUR },
        forecastNight: { FORECAST_RECENT_LOAD_WINDOW_MS: an.FORECAST_RECENT_LOAD_WINDOW_MS, FORECAST_NIGHT_OVERPREDICT_RATIO: an.FORECAST_NIGHT_OVERPREDICT_RATIO, FORECAST_NIGHT_BLEND: an.FORECAST_NIGHT_BLEND, FORECAST_NIGHT_MAX_TRIM: an.FORECAST_NIGHT_MAX_TRIM },
        quorum: selfHeal.DEFAULT_SELF_HEAL_CONFIG,
        ladder: { thresholds: BATTERY_SOC_THRESHOLDS, MAX_PLAUSIBLE_DROP_PCT: bat.MAX_PLAUSIBLE_DROP_PCT, HEALTHY_BASELINE_PCT: bat.HEALTHY_BASELINE_PCT },
        loads: an.DEFAULT_OPPORTUNISTIC_LOADS,
        efficiencies: { DISPATCH_ROUND_TRIP_EFFICIENCY: limitsMod.DISPATCH_ROUND_TRIP_EFFICIENCY, MPC_ROUND_TRIP_EFFICIENCY: mpc.ROUND_TRIP_EFFICIENCY, MPC_MAX_C_RATE: mpc.MAX_C_RATE, EXPORT_TARIFF_CENTS: mpc.EXPORT_TARIFF_CENTS, TARIFF_FALLBACK_CENTS: mpc.TARIFF_FALLBACK_CENTS },
      };
    });
  }
  return {
    variants,
    constants: {
      capacity: { PACK_NOMINAL_V, CAPACITY_SCALE_MIN, CAPACITY_SCALE_MAX, PACK_FULL_CAP_MAX_OF_DESIGN },
      forceCharge: {
        FORCE_CHARGE_CEILING_MIN_PCT, FORCE_CHARGE_CEILING_MAX_PCT, FORCE_CHARGE_MIN_RUN_MS, FORCE_CHARGE_PLAN_RATE_KW, FORCE_CHARGE_MIN_RATE_KW,
        FORCE_CHARGE_PROVEN_KW_PER_SLOT, LEGACY_CHARGE_CAP_KW, FORCE_CHARGE_JIT_BUFFER_MS, FORCE_CHARGE_MAX_RUN_MS,
      },
      reserve: { RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT },
      quorumDefault: DEFAULT_SELF_HEAL_CONFIG,
      retention: Object.fromEntries([undefined, '', 'null', '30', '7', '6', '3650', '4000', '12.6', 'abc'].map((r) => [r === undefined ? '<unset>' : r, resolveRetentionDays(r)])),
    },
  };
}

export const GROUPS: Record<string, () => Promise<unknown>> = { G1, G2, G4, G5, G6, G7, G8 };
