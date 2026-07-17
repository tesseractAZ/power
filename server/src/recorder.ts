import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection, GenericProjection } from './ecoflow/project.js';
import { integrateWh } from './aggregator.js';
import { SPARE_DPU_SNS, shp2ConnectedDpuSns } from './shp2Membership.js';

interface MetricSample {
  sn: string;
  metric: string;
  value: number;
}

const MIN_INTERVAL_MS = 10_000;   // never record same metric more than once / 10s
const MAX_INTERVAL_MS = 300_000;  // heartbeat: record at least every 5 min even if unchanged
// v1.12.0 (review F9) — the lifetime rollup integrates each window [watermark → now]
// but its query was `ts >= watermark`, so integrateWh() never received a sample from
// BEFORE the watermark and its boundary-hold (which value-holds the last pre-window
// reading forward to `sinceMs`) could not engage — the head segment of EVERY window
// was silently dropped, under-counting every total_increasing lifetime counter 13-18%
// (worst on steady-telemetry days). Widen the fetch lower bound by integrateWh's own
// maxGap so the pre-window boundary sample is returned; the integration WINDOW stays
// [watermark, now] (integrateWh clips), so this only recovers the lost head — no
// double-count (adjacent windows share the boundary instant, not an interval).
const LIFETIME_ROLLUP_LOOKBACK_MS = 10 * 60 * 1000; // == integrateWh default maxGapMs
const VALUE_EPSILON = 0.5;        // ignore wiggle smaller than this (watts/percent)

// v0.76.0 — gate the routine per-minute sample-count heartbeat to debug. Set
// LOG_LEVEL=debug (or trace) to restore the line; errors/gaps/anomalies are
// unaffected (they log at their own levels regardless).
const RECORDER_DEBUG = /^(debug|trace)$/i.test(config.logLevel);

/**
 * v0.30.0 — a persisted record of a telemetry blackout: a stretch where the
 * recorder wrote NO home-device samples for far longer than the heartbeat,
 * meaning upstream telemetry stalled (an MQTT session drop / broker reconnect,
 * or the process being down). All fields are ms epochs.
 */
export interface TelemetryGap {
  startMs: number;     // last home-device sample before the silence
  endMs: number;       // first home-device sample after the silence
  durationMs: number;  // endMs − startMs
  detectedAt: number;  // == endMs (when the gap was recognised)
  /** v0.80.0 — present (true) only when the gap was detected AT STARTUP by
   * comparing the newest persisted sample against the boot clock: the silence
   * spans a process restart (host power loss / add-on stop), so `endMs` is the
   * boot-time detection instant, not a resumed write. Optional + additive so
   * every existing reader of the sidecar / /api/telemetry-gaps is unaffected. */
  restartSpanning?: boolean;
  /** v1.14.0 — present (true) only on a restart-spanning gap whose pre-boot
   * anchor matches a clean-shutdown marker: the stop was DELIBERATE (add-on
   * update/restart/deploy), not a power loss. Optional + additive. */
  graceful?: boolean;
}

/**
 * Pure gap predicate. A gap counts only when there was a prior insert
 * (`lastInsertMs > 0`, so the very first boot write never trips it) and the
 * silence exceeds the threshold. Separate + exported so it's unit-testable.
 */
export function detectTelemetryGap(lastInsertMs: number, nowMs: number, thresholdMs: number): boolean {
  return lastInsertMs > 0 && nowMs - lastInsertMs > thresholdMs;
}

/**
 * v1.13.0 (review F10 + F22) — decide what the BOOT-time restart-gap check should
 * do, as a pure function so the (subtle) clock-skew branch is unit-testable.
 *
 * A restart-spanning gap is the time between the newest persisted home sample
 * (`maxTs`) and the boot clock (`bootMs`). Unlike an in-process stall it spans a
 * process DEATH, so there is no heartbeat-jitter confound — the gap IS the dark
 * time — which is why it warrants a TIGHTER floor (`restartFloorMs`, one heartbeat
 * interval) than the 15-min in-process threshold that structurally hid sub-15-min
 * blackouts (an 11-min deploy outage, a restart-erased 16-min stall).
 *
 * Three outcomes:
 *  - `record`: the boot clock is ≥ floor past the last sample → trustworthy, real
 *    downtime; ledger it now.
 *  - `defer`:  the boot clock is BEHIND the last sample (RTC-less Pi before NTP
 *    steps forward → negative delta). We cannot measure the gap at this instant,
 *    and the pre-fix code SILENTLY DROPPED it. Instead, defer to the first
 *    in-process insert after the clock corrects (see the record() path).
 *  - `none`:   0 ≤ delta < floor → a quick clean restart with negligible dark
 *    time (routine deploy), or no prior sample at all.
 */
export type RestartGapDecision =
  | { kind: 'record'; startMs: number; endMs: number }
  | { kind: 'defer'; anchorMs: number }
  | { kind: 'none' };

export function classifyRestartGap(
  maxTs: number | null,
  bootMs: number,
  restartFloorMs: number,
): RestartGapDecision {
  // v1.14.0 (review) — `maxTs <= 0` restores the old detectTelemetryGap
  // `lastInsertMs > 0` guard this classifier replaced: a corrupt/hand-imported
  // ts=0 row must not ledger a multi-decade "restart-spanning" gap.
  if (maxTs == null || !Number.isFinite(maxTs) || maxTs <= 0) return { kind: 'none' };
  const deltaMs = bootMs - maxTs;
  if (deltaMs >= restartFloorMs) return { kind: 'record', startMs: maxTs, endMs: bootMs };
  if (deltaMs < 0) return { kind: 'defer', anchorMs: maxTs };
  return { kind: 'none' };
}

/**
 * v1.14.0 (review of F10's defer path) — resolve a DEFERRED restart-gap check,
 * pure so the clock-skew branches are unit-testable.
 *
 * The v1.13.0 defer resolved on the first insert whose wall clock crossed the
 * anchor — but an RTC-less Pi's skewed clock DRIFTS past the anchor within
 * seconds (the anchor is only clock-file-save-lag ahead of the boot clock), so
 * if any insert landed before NTP stepped, the gap was measured as ~seconds and
 * silently discarded: the exact 5-15-min blackout class F10/F22 shipped to fix.
 *
 * The robust signal is MONOTONIC elapsed time, which no NTP step can touch:
 *   estBootWallMs = nowWallMs − monoElapsedMs
 * is the process-boot instant expressed in the CURRENT wall clock. Before NTP
 * steps it equals the (skewed) boot clock and darkMs stays ~0 — so we HOLD.
 * After NTP steps it is the true boot instant no matter when the step happened
 * — darkMs becomes the true pre-boot dark time, and we RECORD if it clears the
 * floor. If nothing has cleared the floor by `settleMs` of process uptime, the
 * clock was never meaningfully skewed and there is no material dark time: DISARM.
 */
export type DeferredRestartGapResolution =
  | { action: 'record'; startMs: number; endMs: number }
  | { action: 'disarm' }
  | { action: 'hold' };

export function resolveDeferredRestartGap(inputs: {
  anchorMs: number;       // pre-boot MAX(ts) — where the dark window starts
  nowWallMs: number;      // wall clock at this insert
  monoElapsedMs: number;  // monotonic ms since recorder construction (NTP-immune)
  floorMs: number;        // RESTART_GAP_FLOOR_MS
  settleMs: number;       // uptime budget to wait for the NTP step
}): DeferredRestartGapResolution {
  const estBootWallMs = inputs.nowWallMs - inputs.monoElapsedMs;
  const darkMs = estBootWallMs - inputs.anchorMs;
  if (darkMs >= inputs.floorMs) {
    return { action: 'record', startMs: inputs.anchorMs, endMs: inputs.anchorMs + darkMs };
  }
  if (inputs.monoElapsedMs >= inputs.settleMs) return { action: 'disarm' };
  return { action: 'hold' };
}

// v0.13.1 — pseudo-device + metric names for the persisted weather-irradiance
// series (the durable GHI backfill, see recordWeatherGhi). Stored under SN
// "weather" so it shares the samples table + query() path with real devices
// but never collides with a hardware SN.
const WEATHER_SN = 'weather';
// v1.31.0 — day-ahead forecast archive series (see recordForecastArchive).
const FORECAST_SN = 'forecast';
const FORECAST_PV_NEXT24_METRIC = 'pv_next24_wh';
const WEATHER_GHI_METRIC = 'ghi_wm2';     // global horizontal irradiance, W/m²
const WEATHER_CLOUD_METRIC = 'cloud_pct'; // cloud cover, %

/* ─── Lifetime-energy persistence (v0.7.6) ─────────────────────────────────
 * HA's Energy Dashboard expects monotonically-increasing kWh counters
 * (`state_class: total_increasing`). The samples table only retains 30
 * days, so a naive "integrate everything in samples" would DECREASE as old
 * samples prune — HA would see that as a reset and double-count.
 *
 * Fix: keep a separate `lifetime_totals` table that accumulates integrated
 * Wh under a per-metric watermark. On every rollup we integrate the window
 * (watermark, now], add to the accumulator, advance the watermark. Survives
 * pruning, server restarts, and DB downsizing.
 *
 * The watt-based metrics we track (PV / panel-load / AC-in) are integrated
 * from the samples table. Battery in/out has authoritative lifetime mAh
 * counters from the BMS — those go straight in without integration. */

export interface LifetimeTotals {
  /** Persisted accumulator (Wh). Increments forever. */
  persistedWh: number;
  /** Integral of the current window past the watermark (also Wh) — added to the live total. */
  pendingWh: number;
  /** Watermark — last ts up to which we've already accumulated. */
  watermarkMs: number;
}

/**
 * v0.15.14 — lifetime micro-dip clamp (pure, testable core).
 *
 * The live total (persisted + pending) is re-estimated on every call, so it
 * can dip a few Wh below the previously emitted total (rollup persistence vs
 * live trapezoid rounding). HA `total_increasing` sensors interpret ANY
 * decrease as a meter reset, so those micro-dips registered as phantom
 * Energy-Dashboard resets. Returns the pendingWh to emit: held so the total
 * never dips by ≤ maxDipWh, while a larger drop (a genuine operator reset,
 * e.g. the v0.13.0 re-zero) passes through untouched so reset semantics work.
 */
export function clampLifetimeDip(
  prevEmittedTotalWh: number | undefined,
  persistedWh: number,
  pendingWh: number,
  maxDipWh = 50,
): number {
  if (prevEmittedTotalWh == null) return pendingWh;
  const total = persistedWh + pendingWh;
  const dip = prevEmittedTotalWh - total;
  if (dip > 0 && dip <= maxDipWh) return prevEmittedTotalWh - persistedWh;
  return pendingWh;
}

// v0.13.0 — per-pack lifetime baseline (absolute factory-register snapshot
// captured the first time a (sn, packNum) pair is seen). Home totals use
// the DELTA from this baseline, not the absolute register. See
// computeBmsBatteryTotals / packDeltaWh.
export interface PackBaseline {
  /** accuChgMah at first sight of this pack. */
  chgMah: number;
  /** accuDsgMah at first sight of this pack. */
  dsgMah: number;
}

/**
 * v0.13.0 — pure baseline-subtraction math (exported for unit testing).
 *
 * Convert one pack's BMS lifetime registers into the home-relative Wh that
 * have flowed since `base` was captured. Returns 0 for a missing register
 * (BMS readback dropout) or a missing baseline (caller hasn't captured one
 * yet). Deltas are floored at 0 so a register that reads BELOW its baseline
 * — only possible from a corrupt/rolled-back BMS read — can't decrement the
 * home counter. Because both registers are re-zeroed at the same instant,
 * `dsgWh ≤ chgWh` holds whenever the underlying deltas do, so the RTE clamp
 * downstream stops firing on healthy data.
 */
/**
 * v0.79.0 — fail-safe probe for the one-time reset marker files. Reads the
 * marker (no existsSync→write TOCTOU pair), but ONLY a confirmed-absent file
 * (ENOENT) reads as "not yet claimed". Any other failure — EIO from a
 * corrupted inode after an unclean power-off (this host's dominant reboot
 * cause), EISDIR, EACCES — means something occupies the marker path, so the
 * destructive one-time counter reset must be SKIPPED, never re-run: the `wx`
 * marker re-write would EEXIST silently and the reset would repeat every boot,
 * feeding HA's total_increasing Energy sensors a meter reset per boot.
 * Exported for tests.
 */
export function markerPresentProbe(flagPath: string): boolean {
  try {
    readFileSync(flagPath);
    return true;
  } catch (e: any) {
    return e?.code !== 'ENOENT';
  }
}

export function packDeltaWh(
  pk: { accuChgMah: number | null; accuDsgMah: number | null },
  base: PackBaseline | undefined,
  mahToWh: number,
): { chgWh: number; dsgWh: number } {
  if (!base) return { chgWh: 0, dsgWh: 0 };
  const chgDelta = pk.accuChgMah != null ? pk.accuChgMah - base.chgMah : 0;
  const dsgDelta = pk.accuDsgMah != null ? pk.accuDsgMah - base.dsgMah : 0;
  return {
    chgWh: Math.max(0, chgDelta) * mahToWh,
    dsgWh: Math.max(0, dsgDelta) * mahToWh,
  };
}

export interface Recorder {
  insertSnapshot: (snap: FleetSnapshot) => void;
  query: (sn: string, metric: string, sinceMs: number, untilMs: number, bucketSec?: number) => Array<{ ts: number; value: number }>;
  /** v1.19.0 (engine-review F17 perf) — boundary-point fetch: the first and
   * last raw sample inside [sinceMs, untilMs] (0, 1, or 2 points; 1 when a
   * single sample is both). Two LIMIT-1 index seeks on (sn, metric, ts)
   * instead of materializing the whole window — delta-of-counters consumers
   * (coulombic efficiency) only read the window edges, and the raw 30-day
   * counter window is ~28k rows (~150 ms of Pi event-loop stall per pack).
   * OPTIONAL so lightweight test stubs keep compiling; callers must fall
   * back to query() when absent. */
  queryFirstLast?: (sn: string, metric: string, sinceMs: number, untilMs: number) => Array<{ ts: number; value: number }>;
  /** v0.9.29 — batched read: one SQL call returns rows for many (sn, metric)
   * pairs, keyed by metric. Cuts per-query overhead (statement-bind +
   * page-cache lookups) by ~6× when the caller has many metrics to pull
   * for a single device, e.g. equipment-health pulling pv_high + pv_high_v
   * + pv_high_a together. Result is a Map<metric, Array<{ts, value}>>; a
   * metric with no rows appears as an empty array, never missing. */
  queryMulti: (
    sn: string,
    metrics: string[],
    sinceMs: number,
    untilMs: number,
    bucketSec?: number,
  ) => Map<string, Array<{ ts: number; value: number }>>;
  listMetrics: (sn: string) => string[];
  /** v0.30.0 — durable record of detected telemetry blackouts (home-feed
   * silences longer than the heartbeat). Bounded ring, persisted across
   * restarts; surfaced at /api/telemetry-gaps. */
  telemetryGaps: () => TelemetryGap[];
  /** v0.13.1 — persist hourly weather irradiance (GHI) + cloud cover under
   * the pseudo-device SN "weather" so the historical series survives beyond
   * the 2h in-memory weather cache / 7-day fetch window. Change-detected and
   * idempotent: re-writing an already-stored hour is a no-op. Consumers
   * (forecast-skill, soiling, solar-model training) read it back via
   * query("weather", "ghi_wm2"|"cloud_pct", since, until). */
  recordWeatherGhi: (
    hours: Array<{ epochMs: number; radiationWm2: number | null; cloudCoverPct: number | null }>,
  ) => void;
  /** v1.31.0 — archive the issued next-24h PV forecast (Wh) for out-of-sample scoring. */
  recordForecastArchive: (pvNext24Wh: number, issuedAtMs: number) => void;
  close: () => void;
  /** Force a lifetime-rollup tick (used by tests / on shutdown). */
  rollupLifetime: () => void;
  /** Snapshot of every lifetime counter (fleet + per-circuit). Keys are the metric_key strings. */
  getLifetimeTotals: () => Record<string, LifetimeTotals>;
  /** v0.40.3 — every persisted lifetime metric_key from the `lifetime_totals` table,
   *  independent of the current snapshot. Unlike getLifetimeTotals (whose key set is
   *  snapshot-gated via allLifetimeKeys → no per-circuit keys until an SHP2 projection is
   *  fetched), this returns the persisted keys directly, so the MQTT state payload can emit
   *  per-circuit lifetime keys at startup — before the first poll populates the snapshot —
   *  matching the retained HA per-circuit sensors from the prior run. */
  listLifetimeKeys: () => string[];
  /** v0.45.0 — READ-ONLY observability for the lifetime battery counters. Returns the
   *  unclamped charge/discharge floors, the emitted totals (persisted + pending split),
   *  the informational deficit (what the removed clamp would have shaved), the per-pack
   *  breakdown (filter membership + held-from-offline carry), and which SHP2 members are
   *  being carried while their packs are absent from the current snapshot. Performs ZERO
   *  writes and ZERO mutation of the emitted counters. Surfaced at /api/debug/battery-lifetime. */
  batteryLifetimeDebug: () => BatteryLifetimeDebug;
}

/** v0.45.0 — per-pack lifetime in/out detail, shared by batteryLifetimeDebug()
 *  and the internal computeBmsBatteryDetail() return shape. */
interface PackLifetimeDetail {
  sn: string;
  num: number;
  present: boolean;
  passesFilter: boolean;
  baselineChgMah: number | null;
  baselineDsgMah: number | null;
  accuChgMah: number | null;
  accuDsgMah: number | null;
  chgWh: number;
  dsgWh: number;
  heldFromLastKnown: boolean;
  /** v0.48.0 — true when this pack's held value was reconstructed from recorder
   *  register history this rollup (offline-at-deploy backfill), not a live sighting. */
  backfilledFromHistory: boolean;
}

/** v0.45.0 — shape of recorder.batteryLifetimeDebug() (read-only diagnostics). */
export interface BatteryLifetimeDebug {
  rawChargeFloorWh: number;
  rawDischargeFloorWh: number;
  emittedChargeWh: number;
  emittedDischargeWh: number;
  charge: { persistedWh: number; pendingWh: number };
  discharge: { persistedWh: number; pendingWh: number };
  /** max(0, rawDischargeFloor − rawChargeFloor): what the removed clamp would have shaved. */
  deficitWh: number;
  packs: PackLifetimeDetail[];
  /** sourceSns members whose packs are absent this snapshot but carried via held last-known. */
  offlineHeldMembers: string[];
}

export function createRecorder(store: SnapshotStore, log: (m: string) => void): Recorder {
  const dbPath = resolve(process.cwd(), config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  log(`recorder: opening ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- v0.9.14 — 32 MB page cache (negative N = KiB). Default is 2 MB, which
    -- is too small once the samples table grows past ~50 MB on disk: cold
    -- queries hit disk for index + data pages. 32 MB easily holds the
    -- working set (recent few days) for our typical fleet (~13 devices,
    -- ~30 metrics each). Trivial cost on a HA host.
    PRAGMA cache_size = -32768;
    -- mmap_size: let SQLite memory-map up to 256 MB of the db file for
    -- read paths. Reads from mmap'd pages skip the syscall overhead of
    -- pread/pwrite. Has no effect if the db is smaller; bounded so we
    -- don't surprise resource-constrained hosts.
    PRAGMA mmap_size = 268435456;
    -- temp_store: in-memory for temp B-trees used by GROUP BY (our new
    -- SQL-side bucketing query relies on these). The default (0) maps
    -- to "file" on some platforms - explicit MEMORY is faster + safer.
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS samples (
      ts INTEGER NOT NULL,
      sn TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_sn_metric_ts ON samples (sn, metric, ts);
    -- v_t_retidx — dedicated single-column index on ts so the hourly retention
    -- DELETE (WHERE ts < ?, see prune below) can seek instead of full-scanning
    -- the whole samples table. The composite (sn, metric, ts) index above is
    -- unusable for that predicate: it has no equality/bound on the leading
    -- (sn) column, so the planner can't range-scan on ts through it. Without
    -- this, every hourly prune scans the entire table while holding SQLite's
    -- write lock, serializing against the near-continuous insert() writes from
    -- live telemetry recording. Additive: does not change/replace the existing
    -- composite index used by query()/queryMulti(); ANALYZE below covers both.
    CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);
    CREATE TABLE IF NOT EXISTS lifetime_totals (
      metric_key TEXT PRIMARY KEY,
      wh REAL NOT NULL DEFAULT 0,
      last_integrated_ts INTEGER NOT NULL DEFAULT 0
    );
  `);

  // v0.9.29 — refresh query-planner statistics. Without this, after a fresh
  // install (samples table empty when ANALYZE last ran), SQLite assumes the
  // composite index is uniform and may pick a less-efficient plan once
  // samples skew (e.g. one metric having 50× the rows of another). ANALYZE
  // on every startup is cheap on a single index — single-digit ms even at
  // millions of rows — and lets the planner keep pace with growth.
  try {
    db.exec(`ANALYZE samples;`);
  } catch (e: any) {
    log(`recorder: ANALYZE skipped (${e?.message ?? e})`);
  }

  const insert = db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);

  // Last-recorded state per (sn,metric) for dedupe
  type Last = { ts: number; value: number };
  const last: Map<string, Last> = new Map();

  function shouldRecord(sn: string, metric: string, value: number, now: number): boolean {
    const k = `${sn}|${metric}`;
    const prev = last.get(k);
    if (!prev) return true;
    const dt = now - prev.ts;
    if (dt < MIN_INTERVAL_MS) return false;
    if (dt >= MAX_INTERVAL_MS) return true;
    return Math.abs(value - prev.value) >= VALUE_EPSILON;
  }

  // v0.30.0 — telemetry-gap detection. record() runs ONLY in response to a
  // store 'change' event; nothing fires when upstream telemetry STOPS. So a
  // silent blackout (one 132-min MQTT stall in the 7-day log) wrote zero rows
  // and left zero trace — only discoverable by scanning /api/history. Track the
  // last HOME-device insert (spares are excluded so a bench unit can't mask a
  // home-feed stall) and, when writes resume after a long silence, persist a
  // durable marker (NOT synthetic samples — those would corrupt the
  // byte-identical history + energy integration). Surfaced at /api/telemetry-gaps.
  const GAP_THRESHOLD_MS = 3 * MAX_INTERVAL_MS;   // 15 min — comfortably above the 5-min heartbeat
  // v1.13.0 (review F10 + F22) — the RESTART path uses a tighter floor: a restart
  // that lost even one full heartbeat interval of coverage is real, operator-
  // relevant dark time the 15-min in-process threshold hid. In-process stalls keep
  // GAP_THRESHOLD_MS so a benign cloud/MQTT blip never trips a false outage.
  const RESTART_GAP_FLOOR_MS = MAX_INTERVAL_MS;   // 5 min — one heartbeat interval
  const GAPS_MAX = 50;                            // bounded persisted ring
  const gapsPath = resolve(dirname(dbPath), 'telemetry-gaps.json');
  let lastHomeInsertTs = 0;
  // v1.13.0 (review F10b) — set when the boot-time gap check could NOT run because
  // the boot clock was BEHIND the newest persisted sample (RTC-less Pi before NTP
  // steps forward). We can't measure the gap then, so we DEFER to the in-process
  // insert path, which resolves via resolveDeferredRestartGap (v1.14.0: monotonic
  // uptime, immune to the skewed clock drifting past the anchor). Cleared once resolved.
  let pendingRestartGap = false;
  let restartGapAnchorMs = 0;
  // v1.14.0 — monotonic zero-point for the deferred resolution: performance.now()
  // is unaffected by NTP steps, so (wall now − monotonic elapsed) is the process
  // boot instant expressed in the CURRENT wall clock.
  const bootMonoMs = performance.now();
  const RESTART_GAP_SETTLE_MS = 10 * 60 * 1000; // NTP-step wait budget (uptime)
  // v1.14.0 (review of F10b) — graceful-shutdown marker. close() (reached via the
  // index.ts SIGTERM/SIGINT handler on every add-on stop/update) stamps this
  // sidecar; the next boot reads+deletes it, and a restart gap whose pre-boot
  // anchor matches the marker is a DELIBERATE stop (deploy/update/restart), not a
  // power loss — so the operator alert says so instead of recommending a UPS, and
  // the power-outage trend counter isn't poisoned by routine deploys.
  const cleanShutdownPath = resolve(dirname(dbPath), '.clean-shutdown');
  function readCleanShutdownMarker(): number | null {
    try {
      const ts = Number(readFileSync(cleanShutdownPath, 'utf8').trim());
      try { unlinkSync(cleanShutdownPath); } catch { /* best-effort */ }
      return Number.isFinite(ts) && ts > 0 ? ts : null;
    } catch { return null; }
  }
  let pendingRestartGraceful = false;
  const telemetryGapsLog: TelemetryGap[] = (() => {
    try {
      const arr = JSON.parse(readFileSync(gapsPath, 'utf8'));
      return Array.isArray(arr) ? (arr as TelemetryGap[]).slice(-GAPS_MAX) : [];
    } catch { return []; }
  })();

  function recordTelemetryGap(startMs: number, endMs: number, opts?: { restartSpanning?: boolean; graceful?: boolean }) {
    // v0.80.0 — an ONGOING blackout re-detects at EVERY boot with the same
    // startMs (no home sample landed in between), e.g. consecutive restarts
    // inside one multi-hour power outage. Extend the existing record in place
    // instead of appending an overlapping duplicate, so the sidecar counts one
    // outage exactly once (with its true, growing duration). In-process gaps
    // can't collide this way (lastHomeInsertTs advances past each one).
    const prior = opts?.restartSpanning
      ? telemetryGapsLog.find((g) => g.restartSpanning === true && g.startMs === startMs)
      : undefined;
    const gap: TelemetryGap = prior ?? { startMs, endMs, durationMs: endMs - startMs, detectedAt: endMs };
    if (prior) {
      prior.endMs = endMs;
      prior.durationMs = endMs - startMs;
      prior.detectedAt = endMs;
    } else {
      if (opts?.restartSpanning) gap.restartSpanning = true;
      if (opts?.graceful) gap.graceful = true;
      telemetryGapsLog.push(gap);
    }
    if (telemetryGapsLog.length > GAPS_MAX) telemetryGapsLog.splice(0, telemetryGapsLog.length - GAPS_MAX);
    try {
      writeFileSync(gapsPath, JSON.stringify(telemetryGapsLog), { mode: 0o644 });
    } catch (e: any) {
      log(`recorder: failed to persist telemetry gap (${e?.message ?? e})`);
    }
    const mins = Math.round(gap.durationMs / 60_000);
    const range = `${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`;
    // Both variants share the "TELEMETRY GAP — no home-device samples for N min"
    // stem so log scanners bucket them together; only the tail distinguishes a
    // restart-spanning blackout (v0.80.0) from an in-process stall (v0.30.0).
    if (opts?.restartSpanning) {
      const cause = opts?.graceful ? 'a deliberate add-on stop/update' : 'host down or add-on stopped';
      log(`recorder: ⚠ TELEMETRY GAP — no home-device samples for ${mins} min (${range}) spanning a restart (${cause}); history in that window is unrecoverable`);
    } else {
      log(`recorder: ⚠ TELEMETRY GAP — no home-device samples for ${mins} min (${range}); writes resumed`);
    }
  }

  // v0.80.0 — restart-spanning telemetry-gap detection (startup, OBSERVABILITY
  // ONLY). detectTelemetryGap only compares consecutive IN-PROCESS inserts, so a
  // blackout that spans a process restart is invisible by construction: the
  // process boots, lastHomeInsertTs re-seeds to 0, and the outage is never
  // accounted (a 68.9h log review found 3 host power losses, 88–193 min each —
  // ~6.4h / ~9.3% of history silently missing with ZERO "TELEMETRY GAP" lines).
  // At startup, compare the newest persisted sample against the boot clock and
  // record through the SAME recordTelemetryGap path (same sidecar, same log-line
  // stem) marked restartSpanning. Exclusions mirror the in-process detector's
  // semantics: the "weather" pseudo-SN is stamped with forecast-hour epochs (not
  // wall clock — a future-stamped row would mask a real outage) and spares are
  // excluded for the v0.30.0 reason (a bench unit must not mask a home-feed stall).
  // Fail-open: this is a diagnostic; it must never block startup.
  //
  // v1.13.0 (review F10 + F22) — two fixes to the decision, both in classifyRestartGap:
  //  (1) use RESTART_GAP_FLOOR_MS (5 min), not GAP_THRESHOLD_MS (15 min) — an
  //      11-min deploy blackout and a restart-erased 16-min stall previously fell
  //      below 15 min and were NEVER ledgered, so every outage tile read zero.
  //  (2) clock skew (boot clock BEHIND the last sample, RTC-less Pi pre-NTP) used
  //      to yield a negative delta that was SILENTLY DROPPED. Now it DEFERS: seed
  //      lastHomeInsertTs to the pre-boot anchor so the first in-process insert
  //      (post-NTP) records it. In the `record` case lastHomeInsertTs stays 0, so
  //      the first insert starts fresh and cannot double-log the same gap.
  try {
    // v1.31.0 — FORECAST_SN joins the exclusion: the forecast-archive tick
    // writes wall-clock-stamped rows even while the device feeds are wedged
    // (the forecast is computable from the cached model + weather), so its
    // rows would pull MAX(ts) past the last real home sample and mask the
    // pre-crash stall this detector exists to ledger. Same invariant as
    // WEATHER_SN/spares: only HOME-FEED writers may anchor the gap.
    const restartGapExcludedSns = [WEATHER_SN, FORECAST_SN, ...SPARE_DPU_SNS];
    const row = db.prepare(
      `SELECT MAX(ts) AS maxTs FROM samples WHERE sn NOT IN (${restartGapExcludedSns.map(() => '?').join(',')})`,
    ).get(...restartGapExcludedSns) as { maxTs: number | bigint | null } | undefined;
    const maxTs = row?.maxTs == null ? null : Number(row.maxTs);
    // v1.14.0 — a clean-shutdown marker within a heartbeat of the pre-boot anchor
    // means the preceding stop was deliberate (deploy/update), not a power loss.
    const markerTs = readCleanShutdownMarker();
    const graceful = markerTs != null && maxTs != null && Math.abs(markerTs - maxTs) <= MAX_INTERVAL_MS;
    const decision = classifyRestartGap(maxTs, Date.now(), RESTART_GAP_FLOOR_MS);
    if (decision.kind === 'record') {
      recordTelemetryGap(decision.startMs, decision.endMs, { restartSpanning: true, graceful });
    } else if (decision.kind === 'defer') {
      restartGapAnchorMs = decision.anchorMs;
      pendingRestartGraceful = graceful;
      pendingRestartGap = true;
    }
  } catch (e: any) {
    // Diagnostic-only: swallow and continue startup (debug-gated breadcrumb).
    if (RECORDER_DEBUG) log(`recorder: restart-spanning gap check skipped (${e?.message ?? e})`);
  }

  // v0.50.0 — persist the per-key emit high-water across restarts. The micro-dip
  // clamp (clampLifetimeDip) keys on lifetimeEmitHighWater, an in-memory Map that
  // previously reset every process restart. With no baseline after a restart the
  // FIRST emit re-derives the live trapezoid a few Wh below what HA last recorded
  // pre-restart, so HA's total_increasing sensors logged "state is not strictly
  // increasing" (e.g. circuit_8_energy 269.538 → 269.53). This sidecar is the
  // emit high-water analogue of the persisted battery floor: it restores the
  // clamp's baseline so per-circuit (and all watt-integrated) lifetime sensors
  // never emit below HA's last value. It is ADVISORY — a missing/corrupt file
  // yields an empty map (exactly the pre-v0.50.0 behavior), so it can only help,
  // never regress, and must never block startup. It stores ONLY a flat
  // { [key]: Wh } of high-water values; no battery / floor / value semantics
  // change (the battery counters clamp off bmsChargeFloor/bmsDischargeFloor, NOT
  // this map). Mirrors the dirname(dbPath) sidecar pattern of the flag/gaps files.
  const emitHighWaterPath = resolve(dirname(dbPath), '.emit-highwater.json');
  const loadEmitHighWater = (): Map<string, number> => {
    try {
      const obj = JSON.parse(readFileSync(emitHighWaterPath, 'utf8'));
      const m = new Map<string, number>();
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number' && Number.isFinite(v)) m.set(k, v);
        }
      }
      return m;
    } catch {
      return new Map<string, number>(); // missing/corrupt → empty (pre-v0.50.0 behavior)
    }
  };
  const persistEmitHighWater = () => {
    try {
      writeFileSync(emitHighWaterPath, JSON.stringify(Object.fromEntries(lifetimeEmitHighWater)), { mode: 0o644 });
    } catch (e: any) {
      log(`recorder: failed to persist emit high-water (${e?.message ?? e})`);
    }
  };

  function record(samples: MetricSample[]) {
    if (samples.length === 0) return;
    const now = Date.now();
    const tx = db.prepare('BEGIN');
    tx.run();
    let written = 0;
    let sawHomeInsert = false;
    try {
      for (const s of samples) {
        if (typeof s.value !== 'number' || !Number.isFinite(s.value)) continue;
        if (!shouldRecord(s.sn, s.metric, s.value, now)) continue;
        insert.run(now, s.sn, s.metric, s.value);
        last.set(`${s.sn}|${s.metric}`, { ts: now, value: s.value });
        written++;
        if (!SPARE_DPU_SNS.has(s.sn)) sawHomeInsert = true;
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    // v0.30.0 — fleet telemetry-gap heartbeat. A home-device write just landed;
    // if the previous home write was long ago, telemetry was silent in between.
    if (sawHomeInsert) {
      if (pendingRestartGap) {
        // v1.14.0 (review of F10b's defer) — the v1.13.0 resolution fired on the
        // first insert whose wall clock crossed the anchor, but a skewed clock
        // DRIFTS past the anchor within seconds (long before NTP steps), so the
        // gap measured ~0 and the blackout was silently discarded. Resolve via
        // monotonic uptime instead (resolveDeferredRestartGap): (wall − monotonic
        // elapsed) is the boot instant in the CURRENT clock, so the true pre-boot
        // dark time appears exactly when NTP steps, whenever that is. While armed
        // the ≥15-min in-process detector is suspended — an NTP step mid-stream
        // would otherwise read as a false "MQTT stall" even though samples were
        // flowing on the skewed clock; the defer resolution accounts the dark.
        const res = resolveDeferredRestartGap({
          anchorMs: restartGapAnchorMs,
          nowWallMs: now,
          monoElapsedMs: performance.now() - bootMonoMs,
          floorMs: RESTART_GAP_FLOOR_MS,
          settleMs: RESTART_GAP_SETTLE_MS,
        });
        if (res.action === 'record') {
          recordTelemetryGap(res.startMs, res.endMs, { restartSpanning: true, graceful: pendingRestartGraceful });
          pendingRestartGap = false;
        } else if (res.action === 'disarm') {
          pendingRestartGap = false; // clock never stepped materially — no material dark time
        }
        lastHomeInsertTs = now;
      } else {
        if (detectTelemetryGap(lastHomeInsertTs, now, GAP_THRESHOLD_MS)) {
          recordTelemetryGap(lastHomeInsertTs, now);
        }
        lastHomeInsertTs = now;
      }
    }
    // v0.9.74 — silence per-tick chatter. The previous "wrote N samples"
    // line fired every 10 s under normal load (~44 lines/min, ~88 % of
    // log volume). Aggregate to a once-per-minute heartbeat that
    // surfaces total + peak burst, and only when there's activity.
    recordedSamplesSinceTick += written;
    recordedSamplesPeak = Math.max(recordedSamplesPeak, written);
    const tickNowMs = Date.now();
    if (tickNowMs - lastSampleLogAt >= 60_000) {
      // v0.76.0 — this once-per-minute heartbeat carries no signal in steady
      // state (it fires whenever ANY sample lands, ~7687 lines over 52h). Demote
      // routine activity to debug; an actual telemetry GAP / record failure /
      // BMS anomaly is logged separately above & below and keeps its own level.
      if (recordedSamplesSinceTick > 0 && RECORDER_DEBUG) {
        log(`recorder: ${recordedSamplesSinceTick} samples in last ${Math.round((tickNowMs - lastSampleLogAt) / 1000)}s (peak burst ${recordedSamplesPeak})`);
      }
      recordedSamplesSinceTick = 0;
      recordedSamplesPeak = 0;
      lastSampleLogAt = tickNowMs;
    }
  }
  // v0.9.74 — sample-write log throttling state. See recordSamples() above.
  let recordedSamplesSinceTick = 0;
  let recordedSamplesPeak = 0;
  let lastSampleLogAt = Date.now();

  function extract(snap: FleetSnapshot): MetricSample[] {
    const out: MetricSample[] = [];
    for (const d of Object.values(snap.devices)) {
      const p = d.projection;
      if (!p) continue;
      const push = (metric: string, v: number | null | undefined) => {
        if (v == null || !Number.isFinite(v)) return;
        out.push({ sn: d.sn, metric, value: v });
      };
      if (p.kind === 'dpu') {
        const dpu = p as DpuProjection;
        push('soc', dpu.soc);
        push('pv_total', dpu.pvTotalWatts);
        push('pv_high', dpu.pvHighWatts);
        push('pv_low', dpu.pvLowWatts);
        push('pv_high_v', dpu.pvHighVolts);
        push('pv_high_a', dpu.pvHighAmps);
        push('pv_low_v', dpu.pvLowVolts);
        push('pv_low_a', dpu.pvLowAmps);
        push('ac_in', dpu.acInWatts);
        push('ac_out', dpu.acOutWatts);
        push('total_in', dpu.totalInWatts);
        push('total_out', dpu.totalOutWatts);
        push('bat_vol', dpu.batVol);
        push('bat_amp', dpu.batAmp);
        push('mppt_hv_temp', dpu.mpptHvTemp);
        push('mppt_lv_temp', dpu.mpptLvTemp);
        // v0.9.78 — record the configured charge ceiling so the
        // curtailment engine can judge each historical hour against the
        // ceiling that was actually in effect (Storm Guard raises it to
        // 100; normal mode sits lower). Slow-changing setting, but the
        // recorder's change-detection only writes when it moves, so this
        // costs ~nothing in steady state.
        push('chg_max_soc', dpu.chgMaxSoc);
        for (const pk of dpu.packs) {
          push(`pack${pk.num}_soc`, pk.soc);
          push(`pack${pk.num}_temp`, pk.temp);
          push(`pack${pk.num}_in`, pk.inputWatts);
          push(`pack${pk.num}_out`, pk.outputWatts);
          push(`pack${pk.num}_cell_max`, pk.maxCellTemp);
          push(`pack${pk.num}_cell_min`, pk.minCellTemp);
          push(`pack${pk.num}_mos_max`, pk.maxMosTemp);
          push(`pack${pk.num}_board`, pk.hwBoardTemp);
          push(`pack${pk.num}_vol_diff_mv`, pk.maxVolDiffMv);
          push(`pack${pk.num}_vol_max_mv`, pk.maxCellVoltageMv);
          push(`pack${pk.num}_vol_min_mv`, pk.minCellVoltageMv);
          push(`pack${pk.num}_balancing`, pk.balanceState != null && pk.balanceState !== 0 ? 1 : 0);
          // Battery health — slow-changing, but worth long-term trending
          push(`pack${pk.num}_soh`, pk.actSoh ?? pk.soh);
          push(`pack${pk.num}_cycles`, pk.cycles);
          push(`pack${pk.num}_full_cap_mah`, pk.fullCapMah);
          push(`pack${pk.num}_remain_cap_mah`, pk.remainCapMah);
          push(`pack${pk.num}_lifetime_chg_mah`, pk.accuChgMah);
          push(`pack${pk.num}_lifetime_dsg_mah`, pk.accuDsgMah);
        }
      } else if (p.kind === 'shp2') {
        const shp = p as Shp2Projection;
        push('backup_pct', shp.backupBatPercent);
        push('backup_remain_min', shp.backupDischargeTimeMin);
        push('backup_charge_min', shp.backupChargeTimeMin);
        let panelLoad = 0;
        for (const c of shp.circuits) {
          if (c.watts == null) continue;
          panelLoad += c.watts;
          push(`ch${c.ch}_w`, c.watts);
        }
        push('panel_load', panelLoad);
        // v0.34.0 — total grid power into the home at the SHP2 main. Distinct from
        // DPU ac_in (grid charging the DPUs): this captures grid that serves home
        // loads DIRECTLY through the panel, the term the self-consumption/carbon
        // energy balance was missing.
        push('grid_home_w', shp.gridWatt);
        // Paired (split-phase 240V) load totals — the canonical wattage for each "circuit"
        for (const pc of shp.pairedCircuits) {
          if (pc.watts != null) push(`pair${pc.primaryCh}_w`, pc.watts);
        }
        for (const s of shp.sources) {
          push(`src${s.slot}_pct`, s.batteryPercentage);
          push(`src${s.slot}_temp`, s.emsBatTemp);
        }
        for (let i = 0; i < shp.sourceWatts.length; i++) {
          push(`src${i + 1}_w`, shp.sourceWatts[i]);
        }
      } else {
        const g = p as GenericProjection;
        push('soc', g.soc);
        push('in_watts', g.inWatts);
        push('out_watts', g.outWatts);
        push('pv_watts', g.pvWatts);
        push('ac_in', g.acInWatts);
        push('ac_out', g.acOutWatts);
        push('temp', g.temp);
      }
    }
    return out;
  }

  // Subscribe to store changes, but coalesce: bursts of MQTT messages → one extract per tick.
  let pending = false;
  store.on('change', () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      try {
        record(extract(store.get()));
      } catch (e: any) {
        log(`recorder: record failed ${e?.message ?? e}`);
      }
    });
  });

  // Retention sweep every hour: drop samples > 30 days old.
  const prune = db.prepare(`DELETE FROM samples WHERE ts < ?`);
  const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const cutoff = Date.now() - RETAIN_MS;
      const res = prune.run(cutoff);
      if (res.changes && Number(res.changes) > 0) log(`recorder: pruned ${res.changes} old samples`);
    } catch (e: any) {
      log(`recorder: prune failed ${e?.message ?? e}`);
    }
  }, 60 * 60 * 1000).unref();

  const queryStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
  );
  // v1.19.0 (F17 perf) — window-edge seeks; both ride the (sn, metric, ts)
  // composite index, O(log n) each vs the full-window scan.
  const queryFirstStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1`,
  );
  const queryLastStmt = db.prepare(
    `SELECT ts, value FROM samples WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
  );
  // v0.9.14 — SQL-side bucketing. Before this, query() read every raw sample
  // (potentially tens of thousands over a 7-day window) and the caller bucketed
  // in JS. Now the GROUP BY happens in SQLite, returning ~one row per bucket
  // and slashing both wire-bytes and JS work for chart queries. The bucket key
  // is `floor(ts / bucketMs) * bucketMs` (the canonical bucket-start timestamp)
  // so output matches the legacy JS implementation byte-for-byte.
  const queryBucketedStmt = db.prepare(
    `SELECT CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value
       FROM samples
      WHERE sn = ? AND metric = ? AND ts >= ? AND ts <= ?
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC`,
  );
  const metricsStmt = db.prepare(`SELECT DISTINCT metric FROM samples WHERE sn = ? ORDER BY metric ASC`);

  // v0.9.29 — multi-metric batched fetch. Single statement, IN-list bound at
  // call time. The query planner uses the composite (sn, metric, ts) index
  // and walks each metric's segment in turn; the result set comes back
  // already grouped by metric (within metric, by ts ASC). The hot callers
  // (equipment-health, self-consumption) used to do one db.prepare().all()
  // per metric — 6 round-trips per device — and now do one. We cache the
  // prepared statement per (metricCount, bucketed) tuple because `node:sqlite`
  // re-prepares on every new SQL string, and ratioSeries always uses the
  // same shape (3 metrics, unbucketed or 5-min-bucketed).
  const queryMultiStmtCache = new Map<string, ReturnType<typeof db.prepare>>();
  const getQueryMultiStmt = (metricCount: number, bucketed: boolean) => {
    const key = `${metricCount}|${bucketed ? 'b' : 'r'}`;
    let stmt = queryMultiStmtCache.get(key);
    if (stmt) return stmt;
    const placeholders = new Array(metricCount).fill('?').join(',');
    const sql = bucketed
      ? `SELECT metric, CAST((ts / ?) AS INTEGER) * ? AS bucket_ts, AVG(value) AS value
           FROM samples
          WHERE sn = ? AND metric IN (${placeholders}) AND ts >= ? AND ts <= ?
          GROUP BY metric, bucket_ts
          ORDER BY metric ASC, bucket_ts ASC`
      : `SELECT metric, ts, value
           FROM samples
          WHERE sn = ? AND metric IN (${placeholders}) AND ts >= ? AND ts <= ?
          ORDER BY metric ASC, ts ASC`;
    stmt = db.prepare(sql);
    queryMultiStmtCache.set(key, stmt);
    return stmt;
  };

  // ─── Lifetime energy accumulator ────────────────────────────────────────
  const lifetimeReadStmt = db.prepare(
    `SELECT wh, last_integrated_ts FROM lifetime_totals WHERE metric_key = ?`,
  );
  const lifetimeUpsertStmt = db.prepare(
    `INSERT INTO lifetime_totals (metric_key, wh, last_integrated_ts) VALUES (?, ?, ?)
     ON CONFLICT(metric_key) DO UPDATE SET wh = excluded.wh, last_integrated_ts = excluded.last_integrated_ts`,
  );
  // v0.40.3 — persisted lifetime keys, snapshot-independent (see Recorder.listLifetimeKeys).
  const lifetimeKeysStmt = db.prepare(`SELECT metric_key FROM lifetime_totals`);
  const listLifetimeKeys = (): string[] =>
    (lifetimeKeysStmt.all() as Array<{ metric_key: string }>).map((r) => r.metric_key);
  // Watt-integrated metrics: we sum these across all (sn,metric) pairs in
  // the current snapshot. Battery in/out comes from BMS counters directly
  // so it's NOT in this list (handled by computeBmsBatteryTotals).
  const LIFETIME_KEYS = [
    'fleet_pv_wh',
    'fleet_load_wh',
    'fleet_grid_import_wh',
    // v0.34.0 — total whole-home grid import metered at the SHP2 main
    // (grid_home_w = wattInfo.gridWatt). The existing fleet_grid_import_wh
    // (DPU ac_in) only counts grid charging the DPUs; this is the authoritative
    // total that makes the home-load energy balance close. Kept additive so the
    // existing HA Energy Dashboard grid counter is undisturbed.
    'fleet_grid_home_wh',
    'fleet_battery_charge_wh',
    'fleet_battery_discharge_wh',
  ] as const;
  // v0.8.0 — per-circuit watt-integrated lifetime counters. Dynamic key
  // shape `circuit_<chNum>_wh` populated from buildContributors using
  // each SHP2 circuit's `ch${ch}_w` watt metric. Pruning of raw samples
  // can't decrement these; same watermark guarantees as the fleet keys.

  const readLifetime = (key: string): { wh: number; ts: number } => {
    const r = lifetimeReadStmt.get(key) as { wh: number; last_integrated_ts: number } | undefined;
    return r ? { wh: r.wh, ts: r.last_integrated_ts } : { wh: 0, ts: 0 };
  };
  const writeLifetime = (key: string, wh: number, ts: number) => {
    lifetimeUpsertStmt.run(key, wh, ts);
  };
  // v1.4.4 — see migrateLifetimeKey below: deletes a legacy row once its value
  // has been copied forward under the new stable key, so it can never be
  // rediscovered later as a second, stale contributor (double-count risk).
  const lifetimeDeleteStmt = db.prepare(`DELETE FROM lifetime_totals WHERE metric_key = ?`);
  /**
   * v1.4.4 — one-time migration for a lifetime_totals row moving from a legacy
   * key shape to a new one (used to re-key per-pack BMS lifetime state off the
   * positional BMS-bus slot number onto the pack's stable hardware serial —
   * see packBaseKey/packLastWhKey). Copies the legacy row's (wh, ts) forward
   * VERBATIM — never resets to 0 — because these feed HA `total_increasing`
   * sensors and a reset reads as a meter rollback. Deletes the legacy row in
   * the SAME transaction so it's never rediscovered as a stale second
   * contributor. No-op if there's nothing to migrate or the new key already
   * has data (idempotent — safe to call on every read).
   */
  const migrateLifetimeKey = (oldKey: string, newKey: string): void => {
    const old = readLifetime(oldKey);
    if (old.ts === 0) return;
    if (readLifetime(newKey).ts !== 0) return;
    const tx = db.prepare('BEGIN');
    tx.run();
    try {
      writeLifetime(newKey, old.wh, old.ts);
      lifetimeDeleteStmt.run(oldKey);
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  };

  /**
   * Build per-snapshot lists of (sn, metric) pairs that contribute to each
   * fleet-level lifetime metric. Filters by topology (grid-tied DPUs only
   * for AC-in; SHP2-only for panel_load).
   */
  // v0.52.0 — the SHP2 `sources` SN set (home-fleet membership), used by both
  // buildContributors (lifetime-key contributor wiring) and
  // computeBmsBatteryDetail (per-pack home-member filter).
  //
  // v1.0.0 — now delegates to the canonical `shp2ConnectedDpuSns`, which additionally
  // requires `isConnected`. The former inline copy took EVERY slot that merely reported an
  // SN, so a slot the SHP2 itself no longer counts as connected (a Core dropped off the
  // home bus while still listed) kept feeding the HA Energy LIFETIME counters
  // (fleet_pv_wh / fleet_load_wh / fleet_grid_*_wh) and the per-pack BMS detail. Those are
  // total_increasing counters, so a stale contributor silently inflates them forever. Using
  // one membership definition everywhere also means the recorder can no longer disagree
  // with aggregateFleetFlow / the live sensors about which Cores are "the home fleet".
  // (Live today: all 3 slots report isConnected=true, so this is a no-op hardening.)
  const sourceSnsOf = (snap: FleetSnapshot): Set<string> => shp2ConnectedDpuSns(snap.devices);

  const buildContributors = (snap: FleetSnapshot): Record<string, Array<{ sn: string; metric: string }>> => {
    const out: Record<string, Array<{ sn: string; metric: string }>> = {
      fleet_pv_wh: [],
      fleet_load_wh: [],
      fleet_grid_import_wh: [],
      fleet_grid_home_wh: [], // v0.34.0 — SHP2-metered total home grid import
    };
    const devices = Object.values(snap.devices);
    const sourceSns = sourceSnsOf(snap);
    for (const d of devices) {
      const p = d.projection;
      if (!p) continue;
      if (p.kind === 'dpu') {
        // v0.9.74 — fleet_pv_wh is the HA Energy Dashboard "lifetime PV
        // production" counter. Only SHP2-connected DPUs deliver power
        // to the home, so only their PV contributes. A spare core
        // charging from an outdoor solar string is still genuine PV
        // production but it isn't "the home's PV" until it's wired in.
        // (Same gating logic as fleet_grid_import_wh below — the
        // sourceSns.size === 0 fallback keeps DPU-only setups working.)
        if (sourceSns.size === 0 || sourceSns.has(d.sn)) {
          out.fleet_pv_wh.push({ sn: d.sn, metric: 'pv_total' });
          out.fleet_grid_import_wh.push({ sn: d.sn, metric: 'ac_in' });
        }
      } else if (p.kind === 'shp2') {
        out.fleet_load_wh.push({ sn: d.sn, metric: 'panel_load' });
        // v0.34.0 — total home grid import metered at the SHP2 main (the term the
        // self-consumption / carbon balance was missing). Integrated like the
        // other watt metrics; gridWatt ≥ 0 so the accumulator is monotone.
        out.fleet_grid_home_wh.push({ sn: d.sn, metric: 'grid_home_w' });
        // v0.8.0 — one lifetime key per circuit so each appears as an HA
        // Energy Dashboard "Individual device".
        for (const c of (p as Shp2Projection).circuits ?? []) {
          const key = `circuit_${c.ch}_wh`;
          out[key] = [{ sn: d.sn, metric: `ch${c.ch}_w` }];
        }
      }
    }
    return out;
  };

  /** Resolve the active list of lifetime keys (fixed fleet keys + dynamic per-circuit). */
  const allLifetimeKeys = (snap: FleetSnapshot): string[] => {
    const keys: string[] = [...LIFETIME_KEYS];
    const shp2 = Object.values(snap.devices).find((d) => d.projection?.kind === 'shp2');
    if (shp2 && shp2.projection?.kind === 'shp2') {
      for (const c of (shp2.projection as Shp2Projection).circuits ?? []) {
        keys.push(`circuit_${c.ch}_wh`);
      }
    }
    return keys;
  };

  /**
   * Battery in/out from BMS: sum `accuChgMah` and `accuDsgMah` across all
   * packs on all DPUs, convert mAh → Wh using the same conversion used by
   * analytics. The BMS counters are themselves monotone so we just store
   * the latest snapshot value (with a "monotone-or-stay" floor so a brief
   * BMS readback hiccup doesn't drop the count).
   */
  // Each pack is 32S1P (~104 V nominal; 32 series cells whose mV sum to packVoltageMv).
  // fullCap is single-string mAh; Wh = mAh × (32 × 3.2 V) / 1000 = mAh × 0.1024.
  const PACK_MAH_TO_WH = (32 * 3.2) / 1_000;   // = 0.1024 Wh/mAh (was (51.2 * 2)/1_000, same value)

  // v0.13.0 — per-pack baseline capture. The accu* registers are FACTORY-
  // lifetime counters: packs ship with accuDsgMah > accuChgMah from bench
  // cycling, so summing the ABSOLUTE values gave a permanent discharge-
  // favoring offset (~44→121 kWh in the audit window). That made lifetime
  // discharge always exceed charge, tripping the clamp below 926× and
  // flat-lining HA's discharge tile. Fix: subtract a per-(sn,packNum)
  // baseline captured once at install so DELTAS — the energy that's
  // actually flowed since we started watching — drive the home totals.
  // Both counters zero at install, so discharge ≤ charge holds naturally.
  // v1.4.4 — ANTI-FOOTGUN FIX: the positional BMS-bus slot (`num`, aka
  // hs_yj751_bms_slave_addr.N — see project.ts DpuPack) is NOT a stable pack
  // identity; it can renumber on a BMS rescan or a pack reseat. Keying
  // persisted lifetime state on (sn, num) alone let a renumbered/reseated pack
  // silently inherit — and corrupt — whatever OTHER pack previously occupied
  // that slot's baseline/held row (double-count or lost history). Mirrors the
  // v1.2.0 restTracker.packRestKey precedent: prefer the pack's own hardware
  // serial (`packSn`), which survives renumbering; fall back to the legacy
  // slot-numbered shape ONLY when packSn hasn't been reported yet (unchanged
  // format — no migration needed for that case).
  const packIdentity = (sn: string, pk: { packSn?: string | null; num: number }): string | null =>
    pk.packSn ? `${sn}:${pk.packSn}` : null;
  const packCacheKey = (sn: string, pk: { packSn?: string | null; num: number }): string =>
    packIdentity(sn, pk) ?? `${sn}|${pk.num}`;
  const legacyPackBaseKey = (sn: string, num: number, kind: 'chg' | 'dsg') => `pack_base_${sn}_${num}_${kind}`;
  const packBaseKey = (sn: string, pk: { packSn?: string | null; num: number }, kind: 'chg' | 'dsg'): string => {
    const id = packIdentity(sn, pk);
    return id ? `pack_baseid_${id}_${kind}` : legacyPackBaseKey(sn, pk.num, kind);
  };
  const bmsBaselines: Map<string, PackBaseline> = new Map();
  const loadPackBaseline = (sn: string, pk: { packSn?: string | null; num: number }, mutate: boolean): PackBaseline | undefined => {
    const cacheKey = packCacheKey(sn, pk);
    const cached = bmsBaselines.get(cacheKey);
    if (cached) return cached;
    let chg = readLifetime(packBaseKey(sn, pk, 'chg'));
    let dsg = readLifetime(packBaseKey(sn, pk, 'dsg'));
    if (chg.ts === 0 && dsg.ts === 0 && pk.packSn) {
      // v1.4.4 migration source: this pack's serial is now known but nothing is
      // persisted yet under its stable key — it may still have a baseline under
      // the pre-packSn slot key. Read it (works read-only too); only WRITE the
      // migration (copy-forward + delete legacy row) on the mutating path.
      const legacyChg = readLifetime(legacyPackBaseKey(sn, pk.num, 'chg'));
      const legacyDsg = readLifetime(legacyPackBaseKey(sn, pk.num, 'dsg'));
      if (legacyChg.ts !== 0 || legacyDsg.ts !== 0) {
        chg = legacyChg; dsg = legacyDsg;
        if (mutate) {
          migrateLifetimeKey(legacyPackBaseKey(sn, pk.num, 'chg'), packBaseKey(sn, pk, 'chg'));
          migrateLifetimeKey(legacyPackBaseKey(sn, pk.num, 'dsg'), packBaseKey(sn, pk, 'dsg'));
          log(`recorder: v1.4.4 migrated pack baseline to packSn key sn=${sn} packSn=${pk.packSn} (was slot ${pk.num})`);
        }
      }
    }
    // ts === 0 on both means no baseline has been persisted yet.
    if (chg.ts === 0 && dsg.ts === 0) return undefined;
    const base: PackBaseline = { chgMah: chg.wh, dsgMah: dsg.wh };
    bmsBaselines.set(cacheKey, base);
    return base;
  };
  const savePackBaseline = (sn: string, pk: { packSn?: string | null; num: number }, base: PackBaseline) => {
    const now = Date.now();
    writeLifetime(packBaseKey(sn, pk, 'chg'), base.chgMah, now);
    writeLifetime(packBaseKey(sn, pk, 'dsg'), base.dsgMah, now);
    bmsBaselines.set(packCacheKey(sn, pk), base);
    log(`recorder: v0.13.0 captured BMS baseline sn=${sn} pack=${pk.num}${pk.packSn ? ` packSn=${pk.packSn}` : ''} baseChg=${base.chgMah.toFixed(0)}mAh baseDsg=${base.dsgMah.toFixed(0)}mAh`);
  };

  // v0.45.0 — per-pack last-known home-relative Wh (charge/discharge deltas),
  // held across an SHP2-connected pack's cloud-offline gap. When a core goes
  // offline its packs leave the snapshot sum; without this the fleet BMS sum
  // dropped below the monotone floor and BOTH counters froze (HA "Battery
  // in/out today = 0 kWh"). We carry each connected pack's last good delta so
  // one offline core can't drag the fleet sum down. Keyed `${sn}|${num}`.
  //
  // PERSISTED (pack_lastwh_<sn>_<num>_chg/_dsg, mirroring savePackBaseline) so
  // a restart-while-offline — the operator's CURRENT condition (Core 1 offline)
  // plus routine add-on restarts — does NOT re-freeze the counters. These keys
  // are INTERNAL (like pack_base_*) and are excluded from the surfaced lifetime
  // key sets (allLifetimeKeys / getLifetimeTotals).
  const legacyPackLastWhKey = (sn: string, num: number, kind: 'chg' | 'dsg') => `pack_lastwh_${sn}_${num}_${kind}`;
  const packLastWhKey = (sn: string, pk: { packSn?: string | null; num: number }, kind: 'chg' | 'dsg'): string => {
    const id = packIdentity(sn, pk);
    return id ? `pack_lastwhid_${id}_${kind}` : legacyPackLastWhKey(sn, pk.num, kind);
  };
  const bmsLastPackWh: Map<string, { chgWh: number; dsgWh: number }> = new Map();
  const loadPackLastWh = (sn: string, pk: { packSn?: string | null; num: number }, mutate: boolean): { chgWh: number; dsgWh: number } | undefined => {
    const cacheKey = packCacheKey(sn, pk);
    const cached = bmsLastPackWh.get(cacheKey);
    if (cached) return cached;
    let chg = readLifetime(packLastWhKey(sn, pk, 'chg'));
    let dsg = readLifetime(packLastWhKey(sn, pk, 'dsg'));
    if (chg.ts === 0 && dsg.ts === 0 && pk.packSn) {
      // v1.4.4 migration source — see loadPackBaseline for the full rationale.
      const legacyChg = readLifetime(legacyPackLastWhKey(sn, pk.num, 'chg'));
      const legacyDsg = readLifetime(legacyPackLastWhKey(sn, pk.num, 'dsg'));
      if (legacyChg.ts !== 0 || legacyDsg.ts !== 0) {
        chg = legacyChg; dsg = legacyDsg;
        if (mutate) {
          migrateLifetimeKey(legacyPackLastWhKey(sn, pk.num, 'chg'), packLastWhKey(sn, pk, 'chg'));
          migrateLifetimeKey(legacyPackLastWhKey(sn, pk.num, 'dsg'), packLastWhKey(sn, pk, 'dsg'));
          log(`recorder: v1.4.4 migrated pack held-Wh to packSn key sn=${sn} packSn=${pk.packSn} (was slot ${pk.num})`);
        }
      }
    }
    // ts === 0 on both means nothing persisted yet for this pack.
    if (chg.ts === 0 && dsg.ts === 0) return undefined;
    const held = { chgWh: chg.wh, dsgWh: dsg.wh };
    bmsLastPackWh.set(cacheKey, held);
    return held;
  };
  const savePackLastWh = (sn: string, pk: { packSn?: string | null; num: number }, held: { chgWh: number; dsgWh: number }) => {
    const now = Date.now();
    writeLifetime(packLastWhKey(sn, pk, 'chg'), held.chgWh, now);
    writeLifetime(packLastWhKey(sn, pk, 'dsg'), held.dsgWh, now);
    bmsLastPackWh.set(packCacheKey(sn, pk), held);
  };
  // v0.45.0 — corrupt-read guard: a single rollup may never advance a pack's
  // contribution by more than one full pack's capacity worth of Wh (a
  // physically-impossible jump only a garbage BMS read could produce). Removing
  // the old discharge≤charge invariant also removed its incidental protection
  // against such a read permanently inflating the floor, so this caps it. Once-
  // per-pack warn throttle keyed `${sn}|${num}` so a stuck read doesn't spew.
  const FALLBACK_FULL_PACK_WH = 6200; // ~one DPU pack when fullCap is unavailable
  const bmsCorruptWarned: Set<string> = new Set();
  // v0.81.0 — the v0.45.0 corrupt-read guard (above) can't tell a one-poll garbage
  // spike from a GENUINE multi-day reconnect: both look like fresh jumping > one
  // pack capacity above held. For a transient the next poll returns to normal; for
  // a reconnect the gap is permanent, so `suspect` latches true FOREVER, held stays
  // frozen, and every post-reconnect kWh is silently dropped from HA Energy (the
  // live operator condition: Cores 1+2 offline for days, then back). We disambiguate
  // by PERSISTENCE: count consecutive suspect rollups per pack; once a pack has been
  // suspect for REBASELINE_SUSPECT_ROLLUPS in a row it's a real reconnect, so we
  // re-baseline the pack (base := register − held) making fresh == held again — the
  // unobservable offline throughput is dropped (never injected as an HA
  // total_increasing spike) and live counting resumes from `held`. In-memory only:
  // a restart re-detects the same still-frozen pack and re-heals within N rollups.
  const bmsSuspectStreak: Map<string, number> = new Map();
  const REBASELINE_SUSPECT_ROLLUPS = Math.max(1, Number(process.env.BMS_REBASELINE_SUSPECT_ROLLUPS ?? 3));

  /**
   * v0.45.0 — per-pack detail for one snapshot (the single source of truth for
   * both the fleet sum and batteryLifetimeDebug). For EVERY pack on EVERY DPU we
   * report whether it PASSES THE EXACT live-sum filter (`kind==='dpu'` AND
   * sourceSns membership AND a captured baseline), its fresh baseline-subtracted
   * delta (when it passes), and whether the contribution this snapshot came from
   * a HELD last-known value (offline carry). A pack that fails the sourceSns
   * filter (a spare core, the v0.9.74 exclusion) is NEVER carried and NEVER
   * summed — `passesFilter:false`, contributes 0. `mutate:false` makes this safe
   * for the read-only debug endpoint (no baseline capture, no held-value write).
   */
  const computeBmsBatteryDetail = (
    snap: FleetSnapshot,
    // mutate: persist baselines / held (rollup AND the hot getLifetimeTotals read
    // path both mutate — the offline-freeze fix advances held on reads too).
    // rollup: TRUE only from rollupLifetime's periodic cadence — it gates the
    // v0.81.0 reconnect re-baseline so its per-pack suspect STREAK counts real
    // rollups, NOT reads (getLifetimeTotals calls this twice per read; counting
    // those would trip the re-baseline in a few milliseconds on a single bad poll).
    opts: { mutate: boolean; rollup?: boolean },
  ): {
    chargeWh: number;
    dischargeWh: number;
    packs: PackLifetimeDetail[];
    offlineHeldMembers: string[];
  } => {
    // v0.9.74 — only SHP2-connected packs count toward the home's lifetime
    // battery in/out totals. A spare core's BMS counts up every time it's
    // charged on the bench but that energy never reaches the home. Without this
    // filter the HA Energy Dashboard "battery charged / discharged" tile was
    // ~67% overstated for setups with spare cores.
    const devices = Object.values(snap.devices);
    const sourceSns = sourceSnsOf(snap);
    // v0.45.0 — "is this pack a home-fleet member?" uses the EXACT same predicate
    // as the live sum: a DPU passing the sourceSns filter. The empty-set fallback
    // (DPU-only setups / SHP2 not yet seen) matches the live sum's behavior. A
    // pack that fails this is a spare — never held, never resurrected.
    const isHomeMember = (sn: string) => sourceSns.size === 0 || sourceSns.has(sn);

    const packs: PackLifetimeDetail[] = [];
    // Keys passing the filter THIS snapshot (fresh delta path) — used to avoid
    // double-counting them via the held-offline carry below.
    const passedThisSnapshot = new Set<string>();
    let chargeWh = 0;
    let dischargeWh = 0;

    for (const d of devices) {
      if (d.projection?.kind !== 'dpu') continue;
      const member = isHomeMember(d.sn);
      for (const pk of (d.projection as DpuProjection).packs) {
        const cacheKey = packCacheKey(d.sn, pk);
        // v0.13.0 — a newly-seen pack (install, pack-swap, hot-add) captures its
        // own baseline lazily so its absolute factory offset never leaks into
        // the home totals. Only members capture a baseline (mirrors the live
        // sum's filter; a spare must never seed home-fleet state).
        let base = loadPackBaseline(d.sn, pk, opts.mutate);
        if (!base && member && (pk.accuChgMah != null || pk.accuDsgMah != null)) {
          base = { chgMah: pk.accuChgMah ?? 0, dsgMah: pk.accuDsgMah ?? 0 };
          // Persist the baseline only on the mutating (rollup/live) path; the
          // read-only debug path uses the just-derived value without writing.
          if (opts.mutate) savePackBaseline(d.sn, pk, base);
        }
        // The live-sum filter, applied identically here: DPU kind (already true)
        // AND sourceSns membership AND non-null register AND a captured baseline.
        const hasRegister = pk.accuChgMah != null || pk.accuDsgMah != null;
        const passesFilter = member && hasRegister && !!base;
        const fresh = passesFilter ? packDeltaWh(pk, base, PACK_MAH_TO_WH) : { chgWh: 0, dsgWh: 0 };

        if (passesFilter) {
          passedThisSnapshot.add(cacheKey);
          // v0.45.0 corrupt-read guard: a single rollup may not advance a pack's
          // contribution past its held value by more than one full pack capacity.
          const held = bmsLastPackWh.get(cacheKey) ?? loadPackLastWh(d.sn, pk, opts.mutate);
          const capWh = (pk.fullCapMah != null ? pk.fullCapMah * PACK_MAH_TO_WH : FALLBACK_FULL_PACK_WH);
          let useChg = fresh.chgWh;
          let useDsg = fresh.dsgWh;
          let suspect = false;
          if (held) {
            if (fresh.chgWh - held.chgWh > capWh || fresh.dsgWh - held.dsgWh > capWh) {
              suspect = true;
              useChg = held.chgWh;
              useDsg = held.dsgWh;
            }
          }
          // v0.81.0 — persistence-based reconnect escape. A one-poll garbage read
          // clears on the next rollup (streak never reaches the threshold); a
          // genuine multi-day reconnect stays suspect EVERY rollup, which is how the
          // v0.45.0 guard used to freeze the counters forever. Once a pack has been
          // suspect for REBASELINE_SUSPECT_ROLLUPS consecutive ROLLUPS (and both
          // registers are present), we re-baseline base := register − held so
          // packDeltaWh(pk, base) == held from now on: this rollup still reports the
          // frozen `held` (NO total_increasing spike into HA), the unobservable
          // offline throughput is dropped, and the NEXT rollup's fresh grows from
          // `held` → live counting resumes. Gated on opts.rollup (NOT opts.mutate):
          // getLifetimeTotals mutates on every read and would otherwise pump the
          // streak to threshold in milliseconds on a single bad poll. Streak is
          // in-memory (a restart re-detects the still-frozen pack and re-heals within
          // N rollups). Debug/read paths never re-baseline nor advance the streak.
          if (suspect && opts.rollup && held) {
            const streak = (bmsSuspectStreak.get(cacheKey) ?? 0) + 1;
            bmsSuspectStreak.set(cacheKey, streak);
            if (streak >= REBASELINE_SUSPECT_ROLLUPS && base && pk.accuChgMah != null && pk.accuDsgMah != null) {
              const rebased: PackBaseline = {
                chgMah: pk.accuChgMah - held.chgWh / PACK_MAH_TO_WH,
                dsgMah: pk.accuDsgMah - held.dsgWh / PACK_MAH_TO_WH,
              };
              savePackBaseline(d.sn, pk, rebased);
              base = rebased;                 // reported baseline reflects the reset
              useChg = held.chgWh;            // this rollup: exactly held, no spike
              useDsg = held.dsgWh;
              suspect = false;                // resolved — counting resumes next tick
              bmsSuspectStreak.delete(cacheKey);
              bmsCorruptWarned.delete(cacheKey);
              log(`recorder: v0.81.0 re-baselined reconnected pack sn=${d.sn} pack=${pk.num} after ${streak} suspect rollups — dropped unobserved offline gap, resume from held (heldChg=${held.chgWh.toFixed(0)} heldDsg=${held.dsgWh.toFixed(0)} Wh; newBaseChg=${rebased.chgMah.toFixed(0)} newBaseDsg=${rebased.dsgMah.toFixed(0)} mAh)`);
            }
          } else if (!suspect && opts.rollup) {
            bmsSuspectStreak.delete(cacheKey);
          }
          if (suspect && opts.mutate && !bmsCorruptWarned.has(cacheKey)) {
            bmsCorruptWarned.add(cacheKey);
            log(`recorder: v0.45.0 WARN suspect BMS read sn=${d.sn} pack=${pk.num} — single-rollup jump exceeds one pack capacity (${capWh.toFixed(0)} Wh); holding previous (freshChg=${fresh.chgWh.toFixed(0)} heldChg=${held!.chgWh.toFixed(0)} freshDsg=${fresh.dsgWh.toFixed(0)} heldDsg=${held!.dsgWh.toFixed(0)} Wh)`);
          } else if (!suspect) {
            bmsCorruptWarned.delete(cacheKey);
          }
          // MONOTONE-HOLD: a lower reconnect register read never de-syncs the
          // floor — store the max of held vs the (guard-applied) fresh value.
          const newHeld = {
            chgWh: Math.max(held?.chgWh ?? 0, useChg),
            dsgWh: Math.max(held?.dsgWh ?? 0, useDsg),
          };
          // Mutating path persists + caches the advanced hold; read-only debug
          // path leaves bmsLastPackWh untouched so it can never influence the
          // next rollup's monotone-hold (strictly read-only). Finding #29 — only
          // hit SQLite when the held value actually advanced; getLifetimeTotals
          // runs this mutating pass on every read (each poll), and re-writing an
          // unchanged hold was pure write amplification. bmsLastPackWh is already
          // correct either way (loadPackLastWh/savePackLastWh both keep it in
          // sync), so skipping the write changes nothing observable.
          const heldAdvanced = !held || newHeld.chgWh !== held.chgWh || newHeld.dsgWh !== held.dsgWh;
          if (opts.mutate && heldAdvanced) savePackLastWh(d.sn, pk, newHeld);
          chargeWh += newHeld.chgWh;
          dischargeWh += newHeld.dsgWh;
          packs.push({
            sn: d.sn,
            num: pk.num,
            present: true,
            passesFilter: true,
            baselineChgMah: base ? base.chgMah : null,
            baselineDsgMah: base ? base.dsgMah : null,
            accuChgMah: pk.accuChgMah,
            accuDsgMah: pk.accuDsgMah,
            chgWh: newHeld.chgWh,
            dsgWh: newHeld.dsgWh,
            heldFromLastKnown: false,
            backfilledFromHistory: false,
          });
        } else {
          // Present in the snapshot but fails the filter (spare, or no baseline/
          // register yet). Contributes nothing; reported for observability.
          packs.push({
            sn: d.sn,
            num: pk.num,
            present: true,
            passesFilter: false,
            baselineChgMah: base ? base.chgMah : null,
            baselineDsgMah: base ? base.dsgMah : null,
            accuChgMah: pk.accuChgMah,
            accuDsgMah: pk.accuDsgMah,
            chgWh: 0,
            dsgWh: 0,
            heldFromLastKnown: false,
            backfilledFromHistory: false,
          });
        }
      }
    }

    // v0.48.0 — offline-at-deploy backfill (MUTATE PATH ONLY). When v0.45.0
    // deployed with a member core ALREADY cloud-offline, that core's packs were
    // absent from every snapshot AND never got a pack_lastwh_* row (the held
    // hold is only written on a live sighting). It DID, however, get a v0.13.0
    // pack_base_* baseline (captured pre-deploy) plus recorded
    // pack{N}_lifetime_chg_mah/_dsg_mah register history. Without a held value
    // the offline-carry loop below skips it, so the live 2-core sum stays below
    // the boot-seeded floor and BOTH counters freeze. We reconstruct each such
    // pack's held delta ONCE from its LAST recorded register, persist it via
    // savePackLastWh, and let the EXISTING carry loop do the summing (we do NOT
    // add it to chargeWh/dischargeWh here — that would double-count). Guards:
    //   • mutate path only (read-only debug must never backfill or write);
    //   • current sourceSns member only (never a spare — isHomeMember);
    //   • pack ABSENT from this snapshot (not in passedThisSnapshot — a present
    //     pack already owns the fresh path / its own hold);
    //   • NO existing held value (not in bmsLastPackWh, no persisted
    //     pack_lastwh_* row) — so it runs at most once per pack; afterwards the
    //     pack_lastwh_* row exists and the carry loop / monotone hold own it.
    const backfilledThisCall = new Set<string>();
    if (opts.mutate) {
      const BACKFILL_WINDOW_MS = 40 * 24 * 60 * 60 * 1000; // ~40 days of register history
      const nowMs = Date.now();
      for (const baseKey of listLifetimeKeys()) {
        // Discover pack baselines via their _chg key; the _dsg key is the same pack.
        const m = baseKey.match(/^pack_base_(.+)_(\d+)_chg$/);
        if (!m) continue;
        const sn = m[1];
        const num = Number(m[2]);
        const cacheKey = `${sn}|${num}`;
        // Member-only (never a spare), absent this snapshot, and not already held.
        if (!isHomeMember(sn)) continue;
        if (passedThisSnapshot.has(cacheKey)) continue;
        if (bmsLastPackWh.has(cacheKey)) continue;
        // v1.4.4 — this discovery loop only ever finds LEGACY (slot-numbered)
        // baseline rows (the regex above requires a numeric slot); pass
        // packSn: null explicitly so it reads/writes that same legacy shape, as
        // it always has. A pack whose baseline now lives under the new packSn
        // key was, by construction, seen live in this same mutating call and
        // already got a held row written alongside it — it can never reach
        // this backfill path.
        if (loadPackLastWh(sn, { packSn: null, num }, true)) continue; // also populates bmsLastPackWh; harmless
        const base = loadPackBaseline(sn, { packSn: null, num }, true);
        if (!base) continue; // no baseline → nothing to subtract from
        // Last recorded register values before this pack went offline.
        const chgPts = queryStmt.all(sn, `pack${num}_lifetime_chg_mah`, nowMs - BACKFILL_WINDOW_MS, nowMs) as Array<{ ts: number; value: number }>;
        const dsgPts = queryStmt.all(sn, `pack${num}_lifetime_dsg_mah`, nowMs - BACKFILL_WINDOW_MS, nowMs) as Array<{ ts: number; value: number }>;
        if (chgPts.length === 0 && dsgPts.length === 0) continue; // no history → skip
        const lastChgMah = chgPts.length ? chgPts[chgPts.length - 1].value : null;
        const lastDsgMah = dsgPts.length ? dsgPts[dsgPts.length - 1].value : null;
        if (lastChgMah == null && lastDsgMah == null) continue; // registers null → skip
        const held = {
          chgWh: lastChgMah != null ? Math.max(0, lastChgMah - base.chgMah) * PACK_MAH_TO_WH : 0,
          dsgWh: lastDsgMah != null ? Math.max(0, lastDsgMah - base.dsgMah) * PACK_MAH_TO_WH : 0,
        };
        // PERSIST the held value only — the carry loop below sums it this same
        // rollup (cacheKey is now in bmsLastPackWh + has a pack_lastwh_* row).
        savePackLastWh(sn, { packSn: null, num }, held);
        backfilledThisCall.add(cacheKey);
        log(`recorder: v0.48.0 backfilled offline-at-deploy hold sn=${sn} pack=${num} from history (lastChg=${lastChgMah ?? 'null'}mAh lastDsg=${lastDsgMah ?? 'null'}mAh base=${base.chgMah.toFixed(0)}/${base.dsgMah.toFixed(0)} → held=${held.chgWh.toFixed(0)}/${held.dsgWh.toFixed(0)} Wh)`);
      }
    }

    // v0.45.0 — held-offline carry. Any pack we've previously held (in memory or
    // persisted) whose pack is NOT passing the filter THIS snapshot contributes
    // its HELD delta exactly once. This covers a member core going cloud-offline
    // (its packs vanish from the snapshot). A pack failing the sourceSns filter
    // this snapshot — e.g. a spare — must NEVER be carried; we only carry keys
    // that aren't currently spare-excluded. Since a spare never enters
    // bmsLastPackWh (only members are ever stored), the held set is members-only,
    // so this is safe. We still re-confirm membership defensively.
    const offlineHeldMembers: string[] = [];
    const heldKeys = new Set<string>(bmsLastPackWh.keys());
    // Also surface persisted-but-not-yet-loaded held keys (restart-while-offline):
    // a member that was offline at boot has no snapshot row, so loadPackBaseline
    // never ran for it — but its persisted pack_lastwh_* row must still carry.
    // v1.4.4 — two persisted shapes to discover: the legacy slot-numbered key
    // (cache key `<sn>|<num>`) and the new packSn-stable key (cache key
    // `<sn>:<packSn>`, see packIdentity/packCacheKey). migrateLifetimeKey
    // deletes the legacy row in the same transaction it writes the new one, so
    // a pack is never discoverable under BOTH shapes at once (no double-count).
    // Device/pack serials never contain ':' or '|', so the two shapes never
    // collide with each other.
    for (const key of listLifetimeKeys()) {
      const legacy = key.match(/^pack_lastwh_(.+)_(\d+)_chg$/);
      if (legacy) { heldKeys.add(`${legacy[1]}|${Number(legacy[2])}`); continue; }
      const stable = key.match(/^pack_lastwhid_(.+)_chg$/);
      if (stable) heldKeys.add(stable[1]); // "<sn>:<packSn>"
    }
    for (const cacheKey of heldKeys) {
      if (passedThisSnapshot.has(cacheKey)) continue; // already summed via fresh path
      const stableSep = cacheKey.lastIndexOf(':');
      const legacySep = cacheKey.lastIndexOf('|');
      const isStable = stableSep !== -1 && stableSep > legacySep;
      const sn = isStable ? cacheKey.slice(0, stableSep) : cacheKey.slice(0, legacySep);
      const packSn = isStable ? cacheKey.slice(stableSep + 1) : null;
      const num = isStable ? NaN : Number(cacheKey.slice(legacySep + 1));
      // Never resurrect a spare: if the SHP2 currently excludes this SN, skip it.
      if (!isHomeMember(sn)) continue;
      const held = bmsLastPackWh.get(cacheKey) ?? loadPackLastWh(sn, { packSn, num }, opts.mutate);
      if (!held) continue;
      chargeWh += held.chgWh;
      dischargeWh += held.dsgWh;
      offlineHeldMembers.push(cacheKey);
      packs.push({
        sn,
        num,
        present: false,
        passesFilter: false,
        baselineChgMah: bmsBaselines.get(cacheKey)?.chgMah ?? null,
        baselineDsgMah: bmsBaselines.get(cacheKey)?.dsgMah ?? null,
        accuChgMah: null,
        accuDsgMah: null,
        chgWh: held.chgWh,
        dsgWh: held.dsgWh,
        heldFromLastKnown: true,
        backfilledFromHistory: backfilledThisCall.has(cacheKey),
      });
    }

    return { chargeWh, dischargeWh, packs, offlineHeldMembers };
  };

  const computeBmsBatteryTotals = (
    snap: FleetSnapshot,
    opts: { rollup?: boolean } = {},
  ): { chargeWh: number; dischargeWh: number } => {
    const { chargeWh, dischargeWh } = computeBmsBatteryDetail(snap, { mutate: true, rollup: opts.rollup });
    return { chargeWh, dischargeWh };
  };

  // v0.9.74 — one-time reset for the SHP2-membership filter rollover.
  //
  // The previous code summed BMS counters across every DPU on the
  // EcoFlow account, including spare cores. Now we filter to SHP2-
  // connected only, which means the live `bms.chargeWh` value drops
  // ~67% (in the operator's 3-of-5-connected setup). Without a reset, the
  // persisted floor (from the 5-DPU sum) stays pinned and the HA
  // Energy Dashboard battery counters never advance again.
  //
  // We also reset the watt-integrated PV and grid-import counters for
  // the same reason — their persisted base is overstated by the
  // spare cores' historical contributions. The marker file at
  // `${DATA_DIR}/.shp2-filter-v1.flag` ensures this resets exactly
  // once per install. HA's state_class: total_increasing treats the
  // resulting one-time drop as a meter reset; the next day's delta
  // (and every day thereafter) is correct.
  // dbPath = /data/ecoflow.db, dirname → /data (the persistent volume).
  //
  // TOCTOU hardening (CodeQL js/file-system-race): probe the one-time markers
  // by READING them instead of existsSync — an exists→write pair on the same
  // path is the flagged check/use race. ONLY a confirmed-absent marker (ENOENT)
  // means "not yet claimed"; any OTHER read failure (EIO from a corrupted inode
  // after an unclean power-off, EISDIR, …) means SOMETHING occupies the marker
  // path and must be treated as CLAIMED — otherwise a present-but-unreadable
  // marker would re-run the destructive lifetime-counter reset on EVERY boot
  // (the `wx` re-write below EEXISTs silently, so it would never self-repair).
  // This matches the old existsSync gate's fail-safe direction. Pinned by
  // recorder oneTimeMarkerPresent tests.
  const oneTimeMarkerPresent = markerPresentProbe;
  const SHP2_FILTER_FLAG = resolve(dirname(dbPath), '.shp2-filter-v1.flag');
  if (!oneTimeMarkerPresent(SHP2_FILTER_FLAG)) {
    log('recorder: v0.9.74 first run — resetting fleet lifetime counters for SHP2-membership filter');
    for (const key of ['fleet_battery_charge_wh', 'fleet_battery_discharge_wh', 'fleet_pv_wh', 'fleet_grid_import_wh']) {
      writeLifetime(key, 0, Date.now());
    }
    try {
      mkdirSync(dirname(SHP2_FILTER_FLAG), { recursive: true });
      // `wx` — exclusive create. If a concurrent starter raced us to the
      // marker, the reset already ran and EEXIST is success (matches the old
      // silent overwrite); anything else keeps the noisy-but-non-fatal log.
      writeFileSync(SHP2_FILTER_FLAG, `reset at ${new Date().toISOString()}\n`, { mode: 0o644, flag: 'wx' });
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        log(`recorder: could not write reset marker ${SHP2_FILTER_FLAG}: ${e?.message ?? e} (next boot will reset again — non-fatal but noisy)`);
      }
    }
  }

  // v0.13.0 — one-time re-zero to per-pack baselines.
  //
  // Before this, computeBmsBatteryTotals summed the ABSOLUTE accu* factory
  // registers. DPU packs ship with accuDsgMah > accuChgMah (bench cycling),
  // so the home discharge total permanently exceeded charge — the RTE clamp
  // below fired on every rollup (926× in the 7-day audit) and pinned HA's
  // discharge tile. Re-zeroing math now lives in packDeltaWh; this block
  // performs the install-time capture exactly once, gated by a marker file
  // like the v0.9.74 one above so it never re-runs.
  //
  // We (a) capture each currently-visible pack's baseline from the live
  // snapshot and (b) reset the surfaced fleet battery counters to 0 so the
  // freshly-zeroed deltas drive them from here on. HA treats the one-time
  // drop as a meter reset (state_class: total_increasing); every subsequent
  // day's delta is correct. Packs not visible right now capture their
  // baseline lazily on first sight (see computeBmsBatteryTotals).
  const BMS_BASELINE_FLAG = resolve(dirname(dbPath), '.bms-baseline-v1.flag');
  if (!oneTimeMarkerPresent(BMS_BASELINE_FLAG)) {
    log('recorder: v0.13.0 first run — capturing per-pack BMS baselines and re-zeroing fleet battery counters');
    try {
      const snap = store.get();
      for (const d of Object.values(snap.devices)) {
        if (d.projection?.kind !== 'dpu') continue;
        for (const pk of (d.projection as DpuProjection).packs) {
          if (pk.accuChgMah == null && pk.accuDsgMah == null) continue;
          if (loadPackBaseline(d.sn, pk, true)) continue; // already captured
          savePackBaseline(d.sn, pk, { chgMah: pk.accuChgMah ?? 0, dsgMah: pk.accuDsgMah ?? 0 });
        }
      }
    } catch (e: any) {
      log(`recorder: v0.13.0 baseline capture deferred (snapshot not ready: ${e?.message ?? e}) — packs baseline lazily on first sight`);
    }
    for (const key of ['fleet_battery_charge_wh', 'fleet_battery_discharge_wh']) {
      writeLifetime(key, 0, Date.now());
    }
    try {
      mkdirSync(dirname(BMS_BASELINE_FLAG), { recursive: true });
      // `wx` — see the SHP2 filter marker above; EEXIST = a racing starter
      // already claimed it, which is success.
      writeFileSync(BMS_BASELINE_FLAG, `baselined at ${new Date().toISOString()}\n`, { mode: 0o644, flag: 'wx' });
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        log(`recorder: could not write baseline marker ${BMS_BASELINE_FLAG}: ${e?.message ?? e} (next boot will re-capture — non-fatal but noisy)`);
      }
    }
  }

  // Track the highest BMS lifetime ever observed across this process so a
  // momentary readback dropout (BMS returns 0 / null mid-poll) doesn't
  // appear as a "battery emptied" event to HA's Energy Dashboard.
  let bmsChargeFloor = 0;
  let bmsDischargeFloor = 0;
  // v0.45.0 — deficit-transition latch (formerly the clamp latch). The clamp is
  // gone; this now only rate-limits the INFORMATIONAL "discharge exceeds charge"
  // log in rollupLifetime to one line per transition into the (expected) deficit
  // state. Starts false so the first deficit, if any, logs once.
  let bmsClampActive = false;
  // Seed the floors from whatever was last persisted (a fresh process must
  // not regress the persisted Wh number; HA reads that with state_class:
  // total_increasing and would treat a step-down as a reset).
  {
    const seedC = readLifetime('fleet_battery_charge_wh');
    const seedD = readLifetime('fleet_battery_discharge_wh');
    bmsChargeFloor = seedC.wh;
    bmsDischargeFloor = seedD.wh;
  }

  /**
   * Roll up watt-based lifetime metrics from the samples table. Each metric
   * accumulates integrate(samples, watermark, now); battery counters come
   * from the BMS. Designed to be cheap enough to run every minute, but the
   * default cadence is 5 min.
   */
  const rollupLifetime = () => {
    const now = Date.now();
    const snap = store.get();
    const contributors = buildContributors(snap);

    // Watt-integrated metrics — fleet + per-circuit keys.
    const wattKeys = Object.keys(contributors); // fleet_pv/load/grid + circuit_<N>
    for (const key of wattKeys) {
      const prev = readLifetime(key);
      // On first run (ts === 0) start the watermark 60 s back so we don't try
      // to integrate the whole history (which would be huge and rotational).
      const since = prev.ts === 0 ? Math.max(now - 60_000, 0) : prev.ts;
      if (since >= now) continue;
      let addedWh = 0;
      for (const c of contributors[key] ?? []) {
        // v1.12.0 (review F9) — fetch from `since - lookback` so integrateWh gets the
        // pre-window boundary sample; it still integrates only [since, now].
        const pts = queryStmt.all(c.sn, c.metric, since - LIFETIME_ROLLUP_LOOKBACK_MS, now) as Array<{ ts: number; value: number }>;
        const r = integrateWh(pts, since, now);
        addedWh += r.wh;
      }
      // Negative values are physically impossible for the metrics we track
      // (PV / load / grid-in / circuits); clamp to zero so a transient sign
      // flip from a bad sample can't decrement the lifetime counter.
      if (addedWh < 0) addedWh = 0;
      writeLifetime(key, prev.wh + addedWh, now);
    }

    // BMS-sourced battery counters — store max(BMS, persistedFloor). rollup:true so
    // the v0.81.0 reconnect re-baseline advances its suspect streak on THIS periodic
    // cadence only (getLifetimeTotals mutates on reads but must NOT drive the streak).
    const bms = computeBmsBatteryTotals(snap, { rollup: true });
    if (bms.chargeWh > bmsChargeFloor) bmsChargeFloor = bms.chargeWh;
    if (bms.dischargeWh > bmsDischargeFloor) bmsDischargeFloor = bms.dischargeWh;
    // v0.45.0 — REMOVED the discharge≤charge clamp. accuChgMah/accuDsgMah are
    // COULOMB counters; over an OPEN window (v0.13.0 baseline → now) that ends
    // at a LOWER SoC than baseline (the pool sits at ~30% now), cumulative
    // discharge LEGITIMATELY exceeds cumulative charge. HA never requires in≥out
    // — it ingests fleet_battery_charge_wh and fleet_battery_discharge_wh as two
    // INDEPENDENT total_increasing sensors. The clamp protected no RTE sensor
    // (RTE = analytics.computeRoundTripEfficiency, windowed, with its own ≤100%
    // clamp). The old clamp pinned discharge to charge, freezing the true (~+45
    // kWh higher) battery-out total. We now emit both monotone floors UNCLAMPED.
    // The discharge floor steps up to its true value on the first post-deploy
    // rollup — a one-time, intended, honest correction to HA's battery-out tile.
    //
    // Informational (NOT a clamp): if discharge exceeds charge by a wide margin
    // log it ONCE per transition into the deficit state, worded as the EXPECTED
    // open-window deficit. bmsClampActive is reused purely as the transition
    // latch to keep this to one line, not a per-rollup spew.
    const deficitWh = bmsDischargeFloor - bmsChargeFloor;
    const inDeficit = deficitWh > 1000;
    if (inDeficit && !bmsClampActive) {
      log(`recorder: v0.45.0 lifetime battery discharge exceeds charge by ${deficitWh.toFixed(0)} Wh — EXPECTED for an open accumulation window ending below the baseline SoC (NOT a fault, NOT clamped; the two HA total_increasing sensors are independent)`);
    } else if (!inDeficit && bmsClampActive) {
      log(`recorder: v0.45.0 lifetime battery discharge no longer exceeds charge by >1000 Wh (charge=${bmsChargeFloor.toFixed(0)} discharge=${bmsDischargeFloor.toFixed(0)} Wh)`);
    }
    bmsClampActive = inDeficit;
    writeLifetime('fleet_battery_charge_wh', bmsChargeFloor, now);
    writeLifetime('fleet_battery_discharge_wh', bmsDischargeFloor, now);
    // v0.50.0 — piggyback the emit high-water persist on the 5-min rollup cadence
    // (NOT on the hot getLifetimeTotals path). Advisory: a failed write is logged
    // and ignored — the in-memory map stays authoritative for this process.
    persistEmitHighWater();
  };

  // Roll up every 5 min — fast enough that HA sees fresh totals each poll,
  // cheap enough that the integration query is bounded to one 5-min window.
  const LIFETIME_ROLLUP_INTERVAL_MS = 5 * 60 * 1000;
  const lifetimeTimer = setInterval(() => {
    try { rollupLifetime(); }
    catch (e: any) { log(`recorder: lifetime rollup failed ${e?.message ?? e}`); }
  }, LIFETIME_ROLLUP_INTERVAL_MS);
  lifetimeTimer.unref();
  // First rollup ~30 s after boot so the snapshot store has populated.
  setTimeout(() => {
    try { rollupLifetime(); }
    catch (e: any) { log(`recorder: lifetime initial rollup failed ${e?.message ?? e}`); }
  }, 30_000).unref();

  // v0.15.14 — last emitted total per key, for the jitter clamp below.
  // v0.50.0 — seeded from the persisted sidecar so the clamp keeps its baseline
  // across restarts (load is try/catch → empty on missing/corrupt). Seeded HERE,
  // before any getLifetimeTotals call can emit, so the very first post-restart
  // emit clamps against HA's last-recorded value rather than starting blind.
  const lifetimeEmitHighWater = loadEmitHighWater();

  /** Snapshot of every counter (fleet + per-circuit), including live integral past the watermark. */
  const getLifetimeTotals = (): Record<string, LifetimeTotals> => {
    const now = Date.now();
    const snap = store.get();
    const contributors = buildContributors(snap);
    const out: Record<string, LifetimeTotals> = {};
    const allKeys = allLifetimeKeys(snap);
    // Finding #29 — memoized across the loop below so the mutating BMS pack
    // pass (computeBmsBatteryTotals → computeBmsBatteryDetail) runs at most
    // ONCE per getLifetimeTotals() call instead of once per battery key.
    let bmsBatteryTotals: { chargeWh: number; dischargeWh: number } | undefined;
    for (const key of allKeys) {
      const prev = readLifetime(key);
      const watermark = prev.ts === 0 ? now : prev.ts;
      let pendingWh = 0;
      if (key === 'fleet_battery_charge_wh' || key === 'fleet_battery_discharge_wh') {
        // v0.45.0 — each battery counter emits persistedWh + max(0, liveBmsWh −
        // persisted), UNCLAMPED. The persisted value reflects the most-recent
        // rollup; the current snapshot (with offline-held carry) may read a hair
        // higher, so we add the live remainder. out > in is PHYSICAL for a
        // net-discharged window (coulomb counters over an open window ending
        // below baseline SoC) — the discharge counter is NOT pinned to charge.
        // Finding #29 — computeBmsBatteryTotals runs the mutating per-pack BMS
        // pass; both battery keys land in this branch on the SAME allKeys loop,
        // so memoize it lazily here rather than re-running the full pass (and
        // its unconditional-write side effects) a second time for the second key.
        if (!bmsBatteryTotals) bmsBatteryTotals = computeBmsBatteryTotals(snap);
        const liveBmsWh = key === 'fleet_battery_charge_wh' ? bmsBatteryTotals.chargeWh : bmsBatteryTotals.dischargeWh;
        const persisted = prev.wh;
        pendingWh = Math.max(0, liveBmsWh - persisted);
      } else if (watermark < now) {
        for (const c of contributors[key] ?? []) {
          // v1.12.0 (review F9) — same head-segment fix as rollupLifetime: fetch the
          // pre-watermark boundary sample so integrateWh's value-hold engages.
          const pts = queryStmt.all(c.sn, c.metric, watermark - LIFETIME_ROLLUP_LOOKBACK_MS, now) as Array<{ ts: number; value: number }>;
          pendingWh += integrateWh(pts, watermark, now).wh;
        }
        if (pendingWh < 0) pendingWh = 0;
      }
      // v0.15.14 — micro-dip clamp. The live `pendingWh` trapezoid estimate is
      // re-derived each call, so consecutive totals can dip by a few Wh (e.g.
      // a rollup persisting slightly less than the previous live estimate).
      // HA's `total_increasing` sensors read any decrease as a meter RESET, so
      // 1-6 Wh of jitter produced phantom Energy-Dashboard resets ("state is
      // not strictly increasing", 21× in the HA core log). Hold the previous
      // total across small dips; a LARGE drop is a genuine operator reset
      // (v0.13.0 re-zero) and must pass through unclamped.
      pendingWh = clampLifetimeDip(
        lifetimeEmitHighWater.get(key),
        prev.wh,
        pendingWh,
      );
      lifetimeEmitHighWater.set(key, prev.wh + pendingWh);
      out[key] = { persistedWh: prev.wh, pendingWh, watermarkMs: watermark };
    }
    // v0.45.0 — REMOVED the emit-path discharge≤charge clamp. The two battery
    // counters are surfaced independently (each = persistedWh + max(0, liveBmsWh
    // − persisted)); out > in is physical for a net-discharged window and HA
    // ingests them as two independent total_increasing sensors. The per-key
    // micro-dip clamp (clampLifetimeDip) and per-key lifetimeEmitHighWater above
    // are correct and retained — they protect each counter's own monotonicity
    // without coupling discharge to charge.
    return out;
  };

  /**
   * v0.45.0 — read-only diagnostics for the lifetime battery counters. Mirrors
   * the math getLifetimeTotals uses for the two battery keys but writes NOTHING:
   * computeBmsBatteryDetail({ mutate:false }) skips savePackBaseline /
   * savePackLastWh and the corrupt-read warn, and we read the persisted floors
   * via readLifetime without ever calling writeLifetime. The lifetime_totals
   * table is byte/row-identical before and after this call.
   */
  const batteryLifetimeDebug = (): BatteryLifetimeDebug => {
    const snap = store.get();
    const detail = computeBmsBatteryDetail(snap, { mutate: false });
    const chargePersisted = readLifetime('fleet_battery_charge_wh').wh;
    const dischargePersisted = readLifetime('fleet_battery_discharge_wh').wh;
    // Emitted = persisted + max(0, liveBms − persisted), matching getLifetimeTotals.
    const chargePending = Math.max(0, detail.chargeWh - chargePersisted);
    const dischargePending = Math.max(0, detail.dischargeWh - dischargePersisted);
    // Raw unclamped floors: the in-memory floors advanced by rollups, lifted to
    // the live reading if the snapshot currently reads higher (never persisted here).
    const rawChargeFloorWh = Math.max(bmsChargeFloor, detail.chargeWh);
    const rawDischargeFloorWh = Math.max(bmsDischargeFloor, detail.dischargeWh);
    return {
      rawChargeFloorWh,
      rawDischargeFloorWh,
      emittedChargeWh: chargePersisted + chargePending,
      emittedDischargeWh: dischargePersisted + dischargePending,
      charge: { persistedWh: chargePersisted, pendingWh: chargePending },
      discharge: { persistedWh: dischargePersisted, pendingWh: dischargePending },
      deficitWh: Math.max(0, rawDischargeFloorWh - rawChargeFloorWh),
      packs: detail.packs,
      offlineHeldMembers: detail.offlineHeldMembers,
    };
  };

  // ─── Weather irradiance persistence (v0.13.1) ───────────────────────────
  // Durable backfill of hourly GHI + cloud cover under SN "weather". Unlike
  // the device samples (which are stamped with Date.now() and deduped by a
  // wall-clock interval), each weather row is stamped with the FORECAST
  // HOUR's own epoch so the series lines up with the device history it's
  // correlated against. Idempotency + change-detection are therefore keyed
  // on (sn, metric, ts): we skip a write when a row already exists at that
  // hour, and skip an unchanged value relative to the previous stored hour
  // (so a flat-irradiance night collapses to ~1 row, ~24 rows/day overall).
  const weatherExistsStmt = db.prepare(
    `SELECT 1 FROM samples WHERE sn = ? AND metric = ? AND ts = ? LIMIT 1`,
  );
  const weatherPrevStmt = db.prepare(
    `SELECT value FROM samples WHERE sn = ? AND metric = ? AND ts < ? ORDER BY ts DESC LIMIT 1`,
  );
  const recordWeatherGhi = (
    hours: Array<{ epochMs: number; radiationWm2: number | null; cloudCoverPct: number | null }>,
  ) => {
    if (!hours || hours.length === 0) return;
    // Write chronologically so the "previous stored value" change-detection
    // sees the just-written earlier hour within the same batch.
    const sorted = [...hours].sort((a, b) => a.epochMs - b.epochMs);
    const tx = db.prepare('BEGIN');
    tx.run();
    let written = 0;
    try {
      for (const h of sorted) {
        if (!Number.isFinite(h.epochMs)) continue;
        // Snap to the top of the hour so re-fetches that report the same hour
        // with a different sub-hour offset still dedupe to one row.
        const ts = Math.floor(h.epochMs / 3_600_000) * 3_600_000;
        const pairs: Array<[string, number | null]> = [
          [WEATHER_GHI_METRIC, h.radiationWm2],
          [WEATHER_CLOUD_METRIC, h.cloudCoverPct],
        ];
        for (const [metric, value] of pairs) {
          if (value == null || !Number.isFinite(value)) continue;
          // Idempotent: a row already at this exact hour is a no-op.
          if (weatherExistsStmt.get(WEATHER_SN, metric, ts)) continue;
          // Change-detection: skip if the most-recent earlier hour already
          // holds this value (within epsilon) — flat stretches collapse.
          const prev = weatherPrevStmt.get(WEATHER_SN, metric, ts) as { value: number } | undefined;
          if (prev && Math.abs(value - prev.value) < VALUE_EPSILON) continue;
          insert.run(ts, WEATHER_SN, metric, value);
          written++;
        }
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    if (written > 0) log(`recorder: v0.13.1 persisted ${written} weather GHI/cloud rows`);
  };

  // ─── Day-ahead forecast archive (v1.31.0) ────────────────────────────────
  // Durable record of the ISSUED next-24h PV forecast (the bias-corrected
  // alarm-facing total, forecastPvWhNext24) under pseudo-SN "forecast". The
  // band calibrator currently scores CURRENT-MODEL HINDCASTS against realized
  // GHI — a basis that (a) is rewritten whenever the model re-learns and
  // (b) omits the weather-forecast component of true day-ahead error. This
  // series is the raw material for genuinely out-of-sample scoring: once ~14+
  // days exist, the calibrator can compare each day's actual PV against the
  // value that was PUBLISHED at the time (the row nearest that day's local
  // midnight). Scoring switch is data-gated — this release only writes.
  // Same conventions as recordWeatherGhi: hour-snapped ts (≤24 rows/day),
  // idempotent per hour, change-detected (relative 0.5%) so stable forecasts
  // collapse to a few rows/day.
  const recordForecastArchive = (pvNext24Wh: number, issuedAtMs: number) => {
    if (!Number.isFinite(pvNext24Wh) || pvNext24Wh < 0 || !Number.isFinite(issuedAtMs)) return;
    const ts = Math.floor(issuedAtMs / 3_600_000) * 3_600_000;
    if (weatherExistsStmt.get(FORECAST_SN, FORECAST_PV_NEXT24_METRIC, ts)) return;
    const prev = weatherPrevStmt.get(FORECAST_SN, FORECAST_PV_NEXT24_METRIC, ts) as
      | { value: number }
      | undefined;
    if (prev && Math.abs(pvNext24Wh - prev.value) < Math.max(VALUE_EPSILON, 0.005 * Math.abs(prev.value))) return;
    insert.run(ts, FORECAST_SN, FORECAST_PV_NEXT24_METRIC, pvNext24Wh);
  };

  return {
    insertSnapshot: (snap) => record(extract(snap)),
    query: (sn, metric, sinceMs, untilMs, bucketSec) => {
      if (!bucketSec || bucketSec <= 0) {
        return queryStmt.all(sn, metric, sinceMs, untilMs) as Array<{ ts: number; value: number }>;
      }
      // v0.9.14 — bucketing happens in SQLite now (see queryBucketedStmt).
      // The returned `bucket_ts` is already the canonical bucket-start ts; we
      // just rename it to `ts` to match the legacy interface.
      const bucketMs = bucketSec * 1000;
      const rows = queryBucketedStmt.all(bucketMs, bucketMs, sn, metric, sinceMs, untilMs) as Array<{ bucket_ts: number; value: number }>;
      return rows.map((r) => ({ ts: r.bucket_ts, value: r.value }));
    },
    queryFirstLast: (sn, metric, sinceMs, untilMs) => {
      const first = queryFirstStmt.get(sn, metric, sinceMs, untilMs) as { ts: number; value: number } | undefined;
      if (!first) return [];
      const last = queryLastStmt.get(sn, metric, sinceMs, untilMs) as { ts: number; value: number } | undefined;
      return last && last.ts !== first.ts ? [first, last] : [first];
    },
    queryMulti: (sn, metrics, sinceMs, untilMs, bucketSec) => {
      const out = new Map<string, Array<{ ts: number; value: number }>>();
      if (metrics.length === 0) return out;
      // Pre-seed empty arrays so callers can rely on `out.get(metric)` never
      // returning undefined for a known metric.
      for (const m of metrics) out.set(m, []);
      const bucketed = !!bucketSec && bucketSec > 0;
      const stmt = getQueryMultiStmt(metrics.length, bucketed);
      const rows = bucketed
        ? (stmt.all(bucketSec! * 1000, bucketSec! * 1000, sn, ...metrics, sinceMs, untilMs) as Array<{ metric: string; bucket_ts: number; value: number }>)
        : (stmt.all(sn, ...metrics, sinceMs, untilMs) as Array<{ metric: string; ts: number; value: number }>);
      for (const r of rows) {
        const arr = out.get(r.metric);
        if (!arr) continue; // metric not in requested list (shouldn't happen — defensive)
        arr.push({ ts: bucketed ? (r as any).bucket_ts : (r as any).ts, value: r.value });
      }
      return out;
    },
    listMetrics: (sn) => (metricsStmt.all(sn) as Array<{ metric: string }>).map((r) => r.metric),
    telemetryGaps: () => telemetryGapsLog.slice(),
    recordWeatherGhi,
    recordForecastArchive,
    close: () => {
      clearInterval(lifetimeTimer);
      // Final rollup so we don't lose the trailing minute of energy on shutdown.
      // rollupLifetime persists the emit high-water itself; if it throws before
      // reaching that, persist once more directly so the sidecar reflects the
      // last emitted values on a graceful restart.
      try { rollupLifetime(); } catch { /* ignore on shutdown */ }
      try { persistEmitHighWater(); } catch { /* ignore on shutdown */ }
      // v1.14.0 — stamp the clean-shutdown marker (reached via index.ts's
      // SIGTERM/SIGINT handler on every add-on stop/update) so the next boot can
      // classify the restart gap as deliberate rather than a power loss.
      try { writeFileSync(cleanShutdownPath, String(Date.now()), { mode: 0o644 }); } catch { /* best-effort */ }
      db.close();
    },
    rollupLifetime,
    getLifetimeTotals,
    listLifetimeKeys,
    batteryLifetimeDebug,
  };
}
