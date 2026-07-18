/**
 * Shared, periodically-refreshed data caches for the control-room TUI.
 *
 * v0.67.0 — extracted from `telnet/server.ts`. The energy integration, the
 * day-ahead forecast, and the capacity-fade degradation report are all too
 * heavy to recompute on every 1 Hz frame, so they're refreshed on timers and
 * the latest cached value is handed to each render. Pulling this out lets the
 * telnet TCP server and the browser WebSocket console (`wsConsole.ts`) share
 * ONE set of refresh timers instead of each spinning up its own.
 *
 * The refresh cadence / fast-retry / degraded-result-never-clobbers-good
 * behaviour is byte-for-byte the same as the original inline implementation.
 */

import type { SnapshotStore } from '../snapshot.js';
import type { Recorder } from '../recorder.js';
import { getAnalytics } from '../analyticsClient.js';
import { startOfLocalDayMs } from '../aggregator.js';
import type { FleetEnergyTotals } from '../aggregator.js';
import type { DayForecast, FleetDegradation } from '../analytics.js';
import type { TuiDataProvider } from './session.js';
// v1.38.0 (night-charge advisory, WS4) — the TUI's TONIGHT'S PLAN block reads
// the advisor's in-process holder synchronously (design §4.3). Unlike the
// totals/forecast/degradation caches above — which recompute a HEAVY analytics
// report on a timer — the night-charge plan is already a live, synchronous
// module holder (`getLatestNightChargePlan`, set by the ~21:30 evening job in
// this same process). So the "cached accessor" here is a read-through with a
// fail-safe staleness gate: a dead/wedged advisor's last plan is dropped to
// null rather than rendered as if current (matches nightChargeStateFields' 12h
// guard and the house rule: null over a fabricated number).
import { getLatestNightChargePlan, type NightChargePlan } from '../nightChargeAdvisor.js';

/** Staleness horizon for the TUI plan holder — identical to the 12 h guard in
 *  `nightChargeStateFields` so the terminal and the HA entities never disagree
 *  about whether tonight's plan is still live. */
const NIGHT_CHARGE_STALE_MS = 12 * 60 * 60 * 1000; // 43_200_000

/**
 * PURE fail-safe freshness gate (design §4.3 / I12): return the plan only when
 * it is present, its basis is complete, and it was generated within the last
 * 12 h; otherwise null. Kept pure (no holder/clock reads) so the TUI's
 * "unavailable vs. live" decision is unit-testable without wiring the advisor.
 */
export function nightChargePlanIfFresh(
  plan: NightChargePlan | null | undefined,
  nowMs: number,
): NightChargePlan | null {
  if (!plan) return null;
  if (!plan.basisComplete) return null;
  if (!Number.isFinite(plan.generatedAt)) return null;
  if (nowMs - plan.generatedAt >= NIGHT_CHARGE_STALE_MS) return null;
  return plan;
}

/**
 * Synchronous cached accessor for tonight's night-charge plan, mirroring the
 * shape of the `totals()/forecast()/degradation()` accessors: return the latest
 * cached value or null. The cache IS the advisor's in-process holder, so this is
 * a read-through — always reflecting the freshest plan and never holding a
 * leaked timer. Fail-safe: stale / incomplete / absent → null (grey line).
 */
export function nightChargePlan(nowMs: number = Date.now()): NightChargePlan | null {
  return nightChargePlanIfFresh(getLatestNightChargePlan(), nowMs);
}

export interface CreateTuiDataProviderOptions {
  store: SnapshotStore;
  recorder: Recorder;
  log: (msg: string) => void;
}

/**
 * Start the shared refresh timers and return a `{ provider, stop }` pair. The
 * provider's `totals()/forecast()/degradation()` accessors return the latest
 * cached value (or null until the first refresh lands). Call `stop()` to clear
 * every timer.
 */
export function createTuiDataProvider(opts: CreateTuiDataProviderOptions): {
  provider: TuiDataProvider;
  stop: () => void;
} {
  const { store, recorder, log } = opts;
  // Captured once at start so the Plant header can show SYS.UPTIME.
  const serverStartedAt = Date.now();

  let totals: FleetEnergyTotals | null = null;
  let forecast: DayForecast | null = null;
  let degradation: FleetDegradation | null = null;
  let stopped = false;
  let forecastTimer: NodeJS.Timeout | null = null;
  let degradationTimer: NodeJS.Timeout | null = null;

  const storeReady = () => Object.keys(store.get().devices).length > 0;

  const refreshTotals = async () => {
    if (!storeReady()) return; // leave totals null until the fleet is discovered
    try {
      totals = await getAnalytics().report('totals', { sinceMs: startOfLocalDayMs(), untilMs: Date.now() });
    } catch (e: any) {
      log(`telnet: totals refresh failed: ${e?.message ?? e}`);
    }
  };

  // The day-ahead forecast is heavy and needs the device list + recorder
  // history ready, so it self-schedules: fast retries until the first usable
  // result lands, then a relaxed 5-minute cadence. A degraded result (no
  // history yet) never clobbers a good one.
  const refreshForecast = async (): Promise<boolean> => {
    if (!storeReady()) return false;
    try {
      const f = await getAnalytics().report('forecast');
      if (f.historyDays > 0 || forecast == null) forecast = f;
      return f.historyDays > 0;
    } catch (e: any) {
      log(`telnet: forecast refresh failed: ${e?.message ?? e}`);
      return false;
    }
  };
  const scheduleForecast = (delayMs: number) => {
    forecastTimer = setTimeout(async () => {
      if (stopped) return;
      const good = await refreshForecast();
      if (!stopped) scheduleForecast(good ? 5 * 60_000 : 30_000);
    }, delayMs);
  };

  // Async-aware degradation refresh — same self-scheduling shape as forecast.
  // computeDegradation's internal cache is 30 min, so a 5 min poll is the right
  // balance: a fresh value soon after each cache expiry while staying inside
  // the analytics layer's intended cadence.
  const refreshDegradation = async (): Promise<boolean> => {
    if (!storeReady()) return false;
    try {
      degradation = await getAnalytics().report('degradation');
      return true;
    } catch (e: any) {
      log(`telnet: degradation refresh failed: ${e?.message ?? e}`);
      return false;
    }
  };
  const scheduleDegradation = (delayMs: number) => {
    degradationTimer = setTimeout(async () => {
      if (stopped) return;
      const good = await refreshDegradation();
      if (!stopped) scheduleDegradation(good ? 5 * 60_000 : 30_000);
    }, delayMs);
  };

  void refreshTotals();
  const totalsTimer = setInterval(() => { void refreshTotals(); }, 15_000);
  scheduleForecast(2_000);
  scheduleDegradation(3_000);

  const provider: TuiDataProvider = {
    store,
    recorder,
    totals: () => totals,
    forecast: () => forecast,
    degradation: () => degradation,
    serverStartedAt,
  };

  return {
    provider,
    stop: () => {
      stopped = true;
      clearInterval(totalsTimer);
      if (forecastTimer) clearTimeout(forecastTimer);
      if (degradationTimer) clearTimeout(degradationTimer);
    },
  };
}
