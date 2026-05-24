import type { DeviceSnapshot } from './snapshot.js';
import type { DpuPack, DpuProjection, Shp2Projection } from './ecoflow/project.js';
import type { Alert } from './alerts.js';
import type { Recorder } from './recorder.js';
import { getWeather, type WeatherHour } from './weather.js';
import { integrateWh, startOfLocalDayMs } from './aggregator.js';

/**
 * Learned alerting — phase 1: peer-comparison anomaly detection.
 *
 * The 5 battery packs inside a DPU are wired in parallel, identical age and
 * identical duty — so they SHOULD read nearly the same. A pack that deviates
 * from its 4 siblings is a strong early-failure signal that static thresholds
 * miss (a pack 8°F hotter than its peers isn't "hot" by an absolute limit, but
 * it's clearly the odd one out).
 *
 * Method: robust statistics — median + MAD (median absolute deviation) and a
 * modified z-score. Robust to the very outlier we're hunting, unlike mean/stdev.
 * An absolute floor per metric suppresses noise when all packs are nearly equal.
 *
 * Peer anomalies cap at "warning" severity — an outlier means "investigate,"
 * not "emergency." Genuine danger is still caught by the static thresholds.
 */

const cToF = (c: number) => c * 1.8 + 32;

/** Extract the Core (DPU) number from a device name like "Core 3". */
function dpuNum(name: string): number | null {
  const m = name.match(/core\s*(\d+)/i) ?? name.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
/** Capitalize the first letter. */
function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

const Z_INFO = 3.5;
const Z_WARN = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mad(xs: number[], med: number): number {
  return median(xs.map((x) => Math.abs(x - med)));
}

interface PeerMetric {
  key: string;
  label: string;
  category: Alert['category'];
  floor: number; // minimum absolute deviation (display units) worth flagging
  get: (pk: DpuPack) => number | null;
  fmt: (v: number) => string;
}

// Getters return DISPLAY units so medians/deviations are uniform (temp in °F).
const PEER_METRICS: PeerMetric[] = [
  {
    key: 'temp',
    label: 'temperature',
    category: 'Thermal',
    floor: 5,
    get: (pk) => {
      const c = pk.maxCellTemp ?? pk.temp;
      return c == null ? null : cToF(c);
    },
    fmt: (v) => `${Math.round(v)}°F`,
  },
  {
    key: 'voldiff',
    label: 'cell-voltage spread',
    category: 'Battery',
    floor: 10,
    get: (pk) => pk.maxVolDiffMv,
    fmt: (v) => `${Math.round(v)} mV`,
  },
  {
    key: 'soh',
    label: 'state of health',
    category: 'Battery',
    floor: 2,
    get: (pk) => pk.actSoh ?? pk.soh,
    fmt: (v) => `${v.toFixed(1)}%`,
  },
  {
    key: 'soc',
    label: 'state of charge',
    category: 'Battery',
    floor: 5,
    get: (pk) => pk.soc,
    fmt: (v) => `${Math.round(v)}%`,
  },
];

/** Phase 1 learned alerts: per-DPU pack peer comparison. */
export function computeLearnedAlerts(devices: Record<string, DeviceSnapshot>): Alert[] {
  const out: Alert[] = [];
  const dpus = Object.values(devices).filter(
    (d) => d.online && d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  for (const d of dpus) {
    const packs = d.projection.packs;
    if (packs.length < 3) continue; // need a real peer group

    for (const metric of PEER_METRICS) {
      const sample = packs
        .map((pk) => ({ pk, v: metric.get(pk) }))
        .filter((x): x is { pk: DpuPack; v: number } => x.v != null && Number.isFinite(x.v));
      if (sample.length < 3) continue;

      const values = sample.map((x) => x.v);
      const med = median(values);
      const m = mad(values, med);

      for (const { pk, v } of sample) {
        const absDev = Math.abs(v - med);
        if (absDev < metric.floor) continue; // within normal scatter — ignore

        // Modified z-score; when MAD is ~0 (siblings identical) a past-floor
        // deviation is itself the signal, so treat it as at least Z_WARN.
        const z = m > 0 ? Math.abs((0.6745 * (v - med)) / m) : Z_WARN;
        if (z < Z_INFO) continue;

        const severity = z >= Z_WARN ? 'warning' : 'info';
        const dir = v > med ? 'higher than' : 'lower than';
        out.push({
          id: `peer-${metric.key}-${d.sn}-${pk.num}`,
          severity,
          category: metric.category,
          source: 'learned',
          device: d.deviceName,
          coreNum: dpuNum(d.deviceName),
          packNum: pk.num,
          title: `${cap(metric.label)} — peer outlier`,
          detail: `${d.deviceName} Pack ${pk.num} ${metric.label} is ${metric.fmt(v)}, ${metric.fmt(absDev)} ${dir} the sibling-pack median of ${metric.fmt(med)} (peer z-score ${z.toFixed(1)}).`,
          facts: [
            { label: 'This pack', value: metric.fmt(v) },
            { label: 'Sibling median', value: metric.fmt(med) },
            { label: 'Deviation', value: `${v > med ? '+' : '-'}${metric.fmt(absDev)}` },
            { label: 'Peer z-score', value: z.toFixed(1) },
            { label: 'Flag threshold', value: `info z≥${Z_INFO} · warning z≥${Z_WARN}` },
          ],
        });
      }
    }
  }
  return out;
}

/* ===================================================================
 * Learned alerting — phase 2: self-baseline anomaly detection.
 *
 * Each sensor learns its OWN normal range from history, bucketed by
 * hour-of-day (a ±1-hour window) so daily cycles don't false-alarm.
 * The current reading is compared to that sensor's typical value for
 * this time of day — catching "unusual for itself" deviations the
 * static thresholds and peer comparison both miss. Naturally cancels
 * positional bias (a pack that's always warm has a warm baseline).
 * =================================================================== */

const BASELINE_TTL_MS = 5 * 60 * 1000;        // recompute at most every 5 min
const BASELINE_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;
const BASELINE_MIN_SPAN_MS = 2 * 24 * 60 * 60 * 1000; // need ≥2 days to baseline
const BASELINE_MIN_SAMPLES = 8;               // min samples in the hour-window

interface BaselineTarget {
  sn: string;
  metric: string;                    // recorder metric name
  device: string;
  label: string;
  category: Alert['category'];
  coreNum: number | null;            // Core (DPU) number when applicable
  packNum: number | null;            // pack number when pack-scoped
  live: number | null;               // current value, in DISPLAY units
  floor: number;                     // min deviation worth flagging (display units)
  transform: (raw: number) => number; // history raw value → display units
  fmt: (v: number) => string;
}

const tempFmt = (v: number) => `${Math.round(v)}°F`;
const wattFmt = (v: number) => `${Math.round(v)} W`;

function buildBaselineTargets(devices: Record<string, DeviceSnapshot>): BaselineTarget[] {
  const targets: BaselineTarget[] = [];
  for (const d of Object.values(devices)) {
    if (!d.online || !d.projection) continue;
    if (d.projection.kind === 'dpu') {
      const p = d.projection;
      const core = dpuNum(d.deviceName);
      const mppt = (metric: string, label: string, c: number | null) =>
        targets.push({ sn: d.sn, metric, device: d.deviceName, label, category: 'Thermal', coreNum: core, packNum: null, live: c == null ? null : cToF(c), floor: 9, transform: cToF, fmt: tempFmt });
      mppt('mppt_hv_temp', 'HV MPPT temperature', p.mpptHvTemp);
      mppt('mppt_lv_temp', 'LV MPPT temperature', p.mpptLvTemp);
      for (const pk of p.packs) {
        targets.push({ sn: d.sn, metric: `pack${pk.num}_temp`, device: d.deviceName, label: 'cell temperature', category: 'Thermal', coreNum: core, packNum: pk.num, live: pk.temp == null ? null : cToF(pk.temp), floor: 9, transform: cToF, fmt: tempFmt });
        targets.push({ sn: d.sn, metric: `pack${pk.num}_board`, device: d.deviceName, label: 'BMS board temperature', category: 'Thermal', coreNum: core, packNum: pk.num, live: pk.hwBoardTemp == null ? null : cToF(pk.hwBoardTemp), floor: 11, transform: cToF, fmt: tempFmt });
      }
    } else if (d.projection.kind === 'shp2') {
      const sp = d.projection as Shp2Projection;
      for (const pc of sp.pairedCircuits) {
        targets.push({ sn: d.sn, metric: `pair${pc.primaryCh}_w`, device: d.deviceName, label: `${pc.name} load`, category: 'SHP2', coreNum: null, packNum: null, live: pc.watts, floor: 500, transform: (x) => x, fmt: wattFmt });
      }
    }
  }
  return targets;
}

let baselineCache: { ts: number; alerts: Alert[] } | null = null;

/** Phase 2 learned alerts: per-sensor self-baseline. Cached ~5 min. */
export function computeBaselineAlerts(devices: Record<string, DeviceSnapshot>, recorder: Recorder): Alert[] {
  if (baselineCache && Date.now() - baselineCache.ts < BASELINE_TTL_MS) {
    return baselineCache.alerts;
  }
  const out: Alert[] = [];
  const now = Date.now();
  const curHour = new Date().getHours();
  const windowHours = new Set([(curHour + 23) % 24, curHour, (curHour + 1) % 24]);

  for (const t of buildBaselineTargets(devices)) {
    if (t.live == null || !Number.isFinite(t.live)) continue;
    const pts = recorder.query(t.sn, t.metric, now - BASELINE_HISTORY_MS, now);
    if (pts.length < BASELINE_MIN_SAMPLES) continue;
    if (pts[pts.length - 1].ts - pts[0].ts < BASELINE_MIN_SPAN_MS) continue; // not enough span

    // Samples within ±1 hour of the current hour-of-day
    const bucket = pts
      .filter((p) => windowHours.has(new Date(p.ts).getHours()))
      .map((p) => t.transform(p.value))
      .filter((v) => Number.isFinite(v));
    if (bucket.length < BASELINE_MIN_SAMPLES) continue;

    const med = median(bucket);
    const m = mad(bucket, med);
    const absDev = Math.abs(t.live - med);
    if (absDev < t.floor) continue;

    const z = m > 0 ? Math.abs((0.6745 * (t.live - med)) / m) : Z_WARN;
    if (z < Z_INFO) continue;

    const severity = z >= Z_WARN ? 'warning' : 'info';
    const dir = t.live > med ? 'above' : 'below';
    const spanDays = ((pts[pts.length - 1].ts - pts[0].ts) / 86_400_000).toFixed(1);
    const subj = t.packNum != null ? `${t.device} Pack ${t.packNum}` : t.device;
    out.push({
      id: `baseline-${t.metric}-${t.sn}`,
      severity,
      category: t.category,
      source: 'learned',
      device: t.device,
      coreNum: t.coreNum,
      packNum: t.packNum,
      title: `${cap(t.label)} unusual for the hour`,
      detail: `${subj} ${t.label} is ${t.fmt(t.live)} — ${t.fmt(absDev)} ${dir} its typical ${t.fmt(med)} for this hour (baseline: ${spanDays} days of history, ${bucket.length} samples; z ${z.toFixed(1)}).`,
      facts: [
        { label: 'Current reading', value: t.fmt(t.live) },
        { label: 'Typical (this hour)', value: t.fmt(med) },
        { label: 'Deviation', value: `${t.live > med ? '+' : '-'}${t.fmt(absDev)}` },
        { label: 'Baseline window', value: `${spanDays} d, ${bucket.length} samples` },
        { label: 'z-score', value: z.toFixed(1) },
      ],
    });
  }

  // Don't cache a result computed before any device projections exist.
  if (Object.values(devices).some((d) => d.projection)) baselineCache = { ts: now, alerts: out };
  return out;
}

/* ===================================================================
 * Learned alerting — phase 3: degradation & runtime forecasting.
 *
 * Runtime: regress the SHP2 backup % over a trailing window → a depletion
 * forecast based on the actual recent average draw (steadier than EcoFlow's
 * instantaneous estimate). Degradation: regress per-pack SoH and cell-imbalance
 * history → project when each crosses a threshold. Degradation needs weeks of
 * data; it is hard-gated and stays silent until the trend is real.
 * =================================================================== */

const FORECAST_TTL_MS = 10 * 60 * 1000;
const FORECAST_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;
const RUNTIME_TRAIL_MS = 3 * 60 * 60 * 1000;        // trailing window for discharge rate
const DEGRADE_MIN_SPAN_MS = 5 * 24 * 60 * 60 * 1000; // need ≥5 days for a degradation trend
const DEGRADE_MIN_R2 = 0.25;                         // trend must explain ≥25% of variance

interface LinFit {
  slopePerMs: number;
  intercept: number;        // fitted y at x = pts[0].ts
  r2: number;
  n: number;
  slopeStdErrPerMs: number; // standard error of the slope — drives projection confidence bands
}

/** Ordinary least-squares fit; x is ms epoch (normalized internally). */
function linregress(pts: Array<{ ts: number; value: number }>): LinFit | null {
  const n = pts.length;
  if (n < 8) return null;
  const x0 = pts[0].ts;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const x = p.ts - x0;
    const y = p.value;
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  const sxxCentered = sxx - (sx * sx) / n;
  const r2 = ssTot > 0 ? Math.min(1, (slope * slope * sxxCentered) / ssTot) : 0;
  // Standard error of the slope: √( residual variance ÷ Sxx ). A noisy or thin
  // trend yields a large SE — which the EOL projection turns into a wide range
  // rather than a falsely-precise date.
  const ssRes = Math.max(0, ssTot - slope * slope * sxxCentered);
  const slopeStdErrPerMs =
    n > 2 && sxxCentered > 0 ? Math.sqrt(ssRes / (n - 2) / sxxCentered) : 0;
  return { slopePerMs: slope, intercept, r2, n, slopeStdErrPerMs };
}

let forecastCache: { ts: number; alerts: Alert[] } | null = null;

/** Phase 3 learned alerts: runtime forecast + degradation projections. Cached ~10 min. */
export function computeForecastAlerts(devices: Record<string, DeviceSnapshot>, recorder: Recorder): Alert[] {
  if (forecastCache && Date.now() - forecastCache.ts < FORECAST_TTL_MS) {
    return forecastCache.alerts;
  }
  const out: Alert[] = [];
  const now = Date.now();
  const list = Object.values(devices);
  const shp2 = list.find((d) => d.online && d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const dpus = list.filter((d) => d.online && d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;

  // --- Runtime forecast — trailing backup-% decline rate ---
  if (shp2 && shp2.projection.backupBatPercent != null) {
    const sp = shp2.projection;
    const pts = recorder.query(shp2.sn, 'backup_pct', now - RUNTIME_TRAIL_MS, now);
    const fit = linregress(pts);
    if (fit) {
      const pctPerHour = fit.slopePerMs * 3_600_000;
      const reserve = sp.backupReserveSoc ?? 15;
      const cur = sp.backupBatPercent;
      if (cur != null && pctPerHour < -0.05 && cur > reserve) {
        const hoursToReserve = (cur - reserve) / -pctPerHour;
        let severity: 'warning' | 'info' | null = null;
        if (hoursToReserve < 6) severity = 'warning';
        else if (hoursToReserve <= 18) severity = 'info';
        if (severity) {
          const hrs = Math.floor(hoursToReserve);
          const mins = Math.round((hoursToReserve - hrs) * 60);
          out.push({
            id: `forecast-runtime-${shp2.sn}`,
            severity,
            category: 'SHP2',
            source: 'learned',
            device: shp2.deviceName,
            title: `Projected runtime ≈ ${hrs}h ${mins}m to reserve`,
            detail: `Backup pool ${cur}% draining ${(-pctPerHour).toFixed(1)}%/h (3h average) — projected to reach the ${reserve}% reserve floor in about ${hrs}h ${mins}m. Forecast assumes current load continues; daily-cycle modelling comes with solar/load forecasting.`,
            facts: [
              { label: 'Backup pool now', value: `${cur}%` },
              { label: 'Decline rate', value: `${(-pctPerHour).toFixed(2)} %/h` },
              ...(sp.backupFullCapWh != null
                ? [{ label: 'Implied draw', value: `${Math.round((-pctPerHour / 100) * sp.backupFullCapWh)} W avg` }]
                : []),
              { label: 'Trailing window', value: '3 h regression' },
              { label: 'Fit quality (R²)', value: fit.r2.toFixed(2) },
              { label: 'Reserve floor', value: `${reserve}%` },
              { label: 'Time to reserve', value: `${hrs}h ${mins}m` },
              {
                label: 'Reaches reserve at',
                value: new Date(now + hoursToReserve * 3_600_000).toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                }),
              },
              { label: 'Regression samples', value: String(fit.n) },
            ],
          });
        }
      }
    }
  }

  // --- Degradation projections — per pack, hard-gated on data span + fit quality ---
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      const tag = `${d.deviceName} Pack ${pk.num}`;
      const subject = { coreNum: dpuNum(d.deviceName), packNum: pk.num };

      // SoH decline → projected date to reach 85%
      const sohPts = recorder.query(d.sn, `pack${pk.num}_soh`, now - FORECAST_HISTORY_MS, now);
      const curSoh = pk.actSoh ?? pk.soh;
      if (sohPts.length >= 8 && curSoh != null) {
        const span = sohPts[sohPts.length - 1].ts - sohPts[0].ts;
        const fit = linregress(sohPts);
        if (span >= DEGRADE_MIN_SPAN_MS && fit && fit.r2 >= DEGRADE_MIN_R2) {
          const sohPerDay = fit.slopePerMs * 86_400_000;
          if (sohPerDay < -0.001) {
            const daysTo85 = (curSoh - 85) / -sohPerDay;
            if (daysTo85 > 0 && daysTo85 < 365 * 3) {
              const months = (daysTo85 / 30.4).toFixed(daysTo85 < 90 ? 1 : 0);
              out.push({
                id: `forecast-soh-${d.sn}-${pk.num}`,
                severity: 'info',
                category: 'Battery',
                source: 'learned',
                device: d.deviceName,
                coreNum: subject.coreNum,
                packNum: subject.packNum,
                title: 'State of health declining',
                detail: `${tag} SoH ${curSoh.toFixed(1)}% declining ~${(-sohPerDay * 30.4).toFixed(2)}%/month — projected to reach 85% in about ${months} month(s). (R² ${fit.r2.toFixed(2)}, ${(span / 86_400_000).toFixed(0)} days of data.)`,
                facts: [
                  { label: 'Current SoH', value: `${curSoh.toFixed(1)}%` },
                  { label: 'Decline rate', value: `${(-sohPerDay * 30.4).toFixed(2)} %/month` },
                  { label: 'Projected to 85%', value: `~${months} month(s)` },
                  { label: 'Fit quality (R²)', value: fit.r2.toFixed(2) },
                  { label: 'Data span', value: `${(span / 86_400_000).toFixed(0)} days` },
                ],
              });
            }
          }
        }
      }

      // Cell-imbalance rising → projected date to reach 50 mV
      const imbPts = recorder.query(d.sn, `pack${pk.num}_vol_diff_mv`, now - FORECAST_HISTORY_MS, now);
      if (imbPts.length >= 8 && pk.maxVolDiffMv != null) {
        const span = imbPts[imbPts.length - 1].ts - imbPts[0].ts;
        const fit = linregress(imbPts);
        if (span >= DEGRADE_MIN_SPAN_MS && fit && fit.r2 >= DEGRADE_MIN_R2) {
          const mvPerWeek = fit.slopePerMs * 604_800_000;
          if (mvPerWeek > 0.5 && pk.maxVolDiffMv < 50) {
            const weeksTo50 = (50 - pk.maxVolDiffMv) / mvPerWeek;
            if (weeksTo50 > 0 && weeksTo50 < 52) {
              out.push({
                id: `forecast-imbalance-${d.sn}-${pk.num}`,
                severity: 'warning',
                category: 'Battery',
                source: 'learned',
                device: d.deviceName,
                coreNum: subject.coreNum,
                packNum: subject.packNum,
                title: 'Cell imbalance trending up',
                detail: `${tag} cell spread ${pk.maxVolDiffMv} mV rising ~${mvPerWeek.toFixed(1)} mV/week — projected to reach 50 mV in about ${Math.round(weeksTo50)} week(s). (R² ${fit.r2.toFixed(2)}, ${(span / 86_400_000).toFixed(0)} days of data.)`,
                facts: [
                  { label: 'Cell spread now', value: `${pk.maxVolDiffMv} mV` },
                  { label: 'Rise rate', value: `${mvPerWeek.toFixed(1)} mV/week` },
                  { label: 'Projected to 50 mV', value: `~${Math.round(weeksTo50)} week(s)` },
                  { label: 'Fit quality (R²)', value: fit.r2.toFixed(2) },
                  { label: 'Data span', value: `${(span / 86_400_000).toFixed(0)} days` },
                ],
              });
            }
          }
        }
      }
    }
  }

  if (Object.values(devices).some((d) => d.projection)) forecastCache = { ts: now, alerts: out };
  return out;
}

/* ===================================================================
 * Learned alerting — phase 4: solar & load day-ahead forecasting,
 * tuned to YOUR equipment.
 *
 * Rather than a generic cloud-derate, this learns each array's actual
 * response: it pairs historical PV output with Open-Meteo's historical
 * solar radiation (GHI), per hour-of-day, and fits a response coefficient
 * — watts produced per W/m² of sunlight. That coefficient empirically
 * captures panel size, orientation, inverter clipping, AND time-of-day
 * shading (a tree that shades the array at 8 AM gives 8 AM a low
 * coefficient even on clear days). The forecast then applies the learned
 * per-hour coefficient to the forecast GHI.
 * =================================================================== */

export interface ForecastHour {
  ts: number;
  forecastPvW: number;
  forecastLoadW: number;
  cloudCoverPct: number | null;
  ghiWm2: number | null;
  projectedSocPct: number | null;
  modelled: boolean; // true = used the learned response model; false = fallback
}

export interface HourResponse {
  hour: number;             // 0-23 local hour-of-day
  coeff: number | null;     // learned W of PV per W/m² of GHI; null = insufficient data
  r2: number;               // fit quality 0-1
  samples: number;
  observedMaxPvW: number;   // historical peak PV at this hour (clipping clamp)
}

export interface SolarResponseModel {
  hourly: HourResponse[];   // length 24
  peakCoeff: number;        // best coefficient across the day (reference for shading %)
  pairCount: number;        // total (GHI, PV) hourly pairs the fit used
  historyDays: number;
}

export interface DeviceSolarModel {
  sn: string;
  device: string;
  model: SolarResponseModel; // whole-inverter PV (pv_total)
  hv: SolarResponseModel;    // high-voltage MPPT string
  lv: SolarResponseModel;    // low-voltage MPPT string
}

/** PV soiling estimate — recent clear-sky response vs the cleanest day on record. */
export interface SoilingEstimate {
  dropPct: number;        // % the recent clear-sky coefficient is below baseline
  baselineCoeff: number;  // best clear-sky W per W/m² observed (≈ clean panels)
  recentCoeff: number;    // recent clear-sky W per W/m²
  cleanDays: number;      // number of clear-sky days the estimate used
}

export interface DayForecast {
  generatedAt: number;
  hasWeather: boolean;
  historyDays: number;
  reserveSoc: number;
  hours: ForecastHour[];
  forecastPvWhNext24: number;
  typicalPvWhPerDay: number;
  minProjectedSoc: number | null;
  minProjectedSocTs: number | null;
  solarModel: SolarResponseModel;       // fleet-wide learned response
  deviceModels: DeviceSolarModel[];     // per-DPU — reveals placement/shading differences
  soiling: SoilingEstimate | null;      // null until ≥6 clear-sky days are recorded
}

const FORECAST_DAY_TTL_MS = 30 * 60 * 1000;
const TYPICAL_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_RESPONSE_PAIRS = 2;   // min daylight (GHI,PV) pairs to fit an hour
const DAYLIGHT_GHI = 20;        // W/m² — below this is night/near-night

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Hour-of-day average curve (24 values) for a metric, plus the history span. */
function hourCurve(
  recorder: Recorder,
  sn: string,
  metric: string,
  sinceMs: number,
  nowMs: number,
): { curve: number[]; spanMs: number } {
  const pts = recorder.query(sn, metric, sinceMs, nowMs);
  const buckets: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of pts) buckets[new Date(p.ts).getHours()].push(p.value);
  return {
    curve: buckets.map((b) => mean(b)),
    spanMs: pts.length > 1 ? pts[pts.length - 1].ts - pts[0].ts : 0,
  };
}

/** Average a PV metric into hourly buckets keyed by hour-epoch (floor(ts/1h)). */
function pvHourlyByEpoch(
  recorder: Recorder,
  sn: string,
  metric: string,
  sinceMs: number,
  nowMs: number,
): Map<number, number> {
  const pts = recorder.query(sn, metric, sinceMs, nowMs);
  const buckets = new Map<number, number[]>();
  for (const p of pts) {
    const he = Math.floor(p.ts / 3_600_000);
    let arr = buckets.get(he);
    if (!arr) buckets.set(he, (arr = []));
    arr.push(p.value);
  }
  const out = new Map<number, number>();
  for (const [he, vs] of buckets) out.set(he, mean(vs));
  return out;
}

/**
 * Fit the learned solar-response model: pair hourly PV with hourly GHI, group
 * by hour-of-day, fit a through-origin slope (W per W/m²) for each hour.
 */
function buildSolarResponse(
  pvByEpoch: Map<number, number>,
  ghiByEpoch: Map<number, number>,
): SolarResponseModel {
  const groups: Array<Array<{ ghi: number; pv: number }>> = Array.from({ length: 24 }, () => []);
  let minEpoch = Infinity;
  let maxEpoch = -Infinity;
  for (const [he, pv] of pvByEpoch) {
    const ghi = ghiByEpoch.get(he);
    if (ghi == null) continue;
    groups[new Date(he * 3_600_000).getHours()].push({ ghi, pv });
    if (he < minEpoch) minEpoch = he;
    if (he > maxEpoch) maxEpoch = he;
  }
  const hourly: HourResponse[] = [];
  let peakCoeff = 0;
  let pairCount = 0;
  for (let h = 0; h < 24; h++) {
    const g = groups[h];
    pairCount += g.length;
    const observedMax = g.length ? Math.max(...g.map((p) => p.pv)) : 0;
    const day = g.filter((p) => p.ghi > DAYLIGHT_GHI);
    if (day.length < MIN_RESPONSE_PAIRS) {
      hourly.push({ hour: h, coeff: null, r2: 0, samples: day.length, observedMaxPvW: Math.round(observedMax) });
      continue;
    }
    // Through-origin least squares: coeff = Σ(pv·ghi) / Σ(ghi²)
    let sgg = 0, spg = 0;
    for (const p of day) {
      sgg += p.ghi * p.ghi;
      spg += p.pv * p.ghi;
    }
    const coeff = sgg > 0 ? spg / sgg : 0;
    // Fit quality via Pearson correlation²
    const mg = mean(day.map((p) => p.ghi));
    const mp = mean(day.map((p) => p.pv));
    let cov = 0, vg = 0, vp = 0;
    for (const p of day) {
      cov += (p.ghi - mg) * (p.pv - mp);
      vg += (p.ghi - mg) ** 2;
      vp += (p.pv - mp) ** 2;
    }
    // r² is only meaningful with ≥3 points (2 points always fit a line perfectly).
    const r2 = day.length >= 3 && vg > 0 && vp > 0 ? (cov * cov) / (vg * vp) : 0;
    if (coeff > peakCoeff) peakCoeff = coeff;
    hourly.push({ hour: h, coeff, r2, samples: day.length, observedMaxPvW: Math.round(observedMax) });
  }
  const historyDays = maxEpoch > minEpoch ? (maxEpoch - minEpoch) / 24 : 0;
  return { hourly, peakCoeff, pairCount, historyDays };
}

/**
 * PV soiling detection. The learned GHI→PV response should be stable on clear
 * days; a sustained drop means the panels are producing less per unit of
 * sunlight than they physically can — almost always dust/soiling (Phoenix).
 * Compares the recent clear-sky coefficient to the best (cleanest) day on
 * record. Only clear daytime hours (low cloud, real sun) are used.
 */
function computeSoiling(
  pvByEpoch: Map<number, number>,
  wxByHour: Map<number, WeatherHour>,
): SoilingEstimate | null {
  const byDay = new Map<string, number[]>();
  for (const [he, pv] of pvByEpoch) {
    const wx = wxByHour.get(he);
    if (!wx || wx.cloudCoverPct > 25 || wx.radiationWm2 < 250) continue; // clear daytime only
    const coeff = pv / wx.radiationWm2;
    if (!Number.isFinite(coeff) || coeff <= 0) continue;
    const day = new Date(he * 3_600_000).toDateString();
    const arr = byDay.get(day);
    if (arr) arr.push(coeff);
    else byDay.set(day, [coeff]);
  }
  const days = [...byDay.entries()]
    .filter(([, v]) => v.length >= 3) // ≥3 clear hours to trust the day
    .map(([day, v]) => ({ t: new Date(day).getTime(), coeff: median(v) }))
    .sort((a, b) => a.t - b.t);
  if (days.length < 6) return null;
  const baselineCoeff = Math.max(...days.map((d) => d.coeff));
  const recentCoeff = median(days.slice(-3).map((d) => d.coeff));
  const dropPct = baselineCoeff > 0 ? Math.round(((baselineCoeff - recentCoeff) / baselineCoeff) * 1000) / 10 : 0;
  return { dropPct, baselineCoeff, recentCoeff, cleanDays: days.length };
}

let dayForecastCache: { ts: number; value: DayForecast } | null = null;

/** Phase 4: equipment-tuned day-ahead PV / load / SoC forecast. Cached ~30 min. */
export async function getDayForecast(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  log: (m: string) => void = () => {},
): Promise<DayForecast> {
  if (dayForecastCache && Date.now() - dayForecastCache.ts < FORECAST_DAY_TTL_MS) {
    return dayForecastCache.value;
  }
  const now = Date.now();
  const since = now - TYPICAL_HISTORY_MS;
  const list = Object.values(devices);
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;

  // Typical-day fleet PV curve (fallback when the model lacks an hour) + load curve.
  const pvCurve = new Array(24).fill(0);
  let pvSpan = 0;
  for (const d of dpus) {
    const { curve, spanMs } = hourCurve(recorder, d.sn, 'pv_total', since, now);
    for (let h = 0; h < 24; h++) pvCurve[h] += curve[h];
    pvSpan = Math.max(pvSpan, spanMs);
  }
  const loadRes = shp2
    ? hourCurve(recorder, shp2.sn, 'panel_load', since, now)
    : { curve: new Array(24).fill(0), spanMs: 0 };
  const historyDays = Math.max(pvSpan, loadRes.spanMs) / 86_400_000;

  const weather = await getWeather(log);
  const hasWeather = !!weather && weather.hours.length > 0;
  const wxByHour = new Map<number, WeatherHour>();
  const ghiByEpoch = new Map<number, number>();
  if (weather)
    for (const wh of weather.hours) {
      const he = Math.floor(wh.ts / 3_600_000);
      wxByHour.set(he, wh);
      ghiByEpoch.set(he, wh.radiationWm2);
    }

  // Learn each array's GHI→PV response from history — whole-inverter and per
  // MPPT string (HV / LV), which can face different directions.
  const fleetPvByEpoch = new Map<number, number>();
  const deviceModels: DeviceSolarModel[] = [];
  for (const d of dpus) {
    const pvE = pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now);
    for (const [he, pv] of pvE) fleetPvByEpoch.set(he, (fleetPvByEpoch.get(he) ?? 0) + pv);
    deviceModels.push({
      sn: d.sn,
      device: d.deviceName,
      model: buildSolarResponse(pvE, ghiByEpoch),
      hv: buildSolarResponse(pvHourlyByEpoch(recorder, d.sn, 'pv_high', since, now), ghiByEpoch),
      lv: buildSolarResponse(pvHourlyByEpoch(recorder, d.sn, 'pv_low', since, now), ghiByEpoch),
    });
  }
  const solarModel = buildSolarResponse(fleetPvByEpoch, ghiByEpoch);

  // Recent historical clearness — for the cloud-derate fallback only.
  let clearnessHist = 1;
  if (weather) {
    const past = weather.hours.filter((h) => h.ts < now && h.radiationWm2 > 50);
    if (past.length) clearnessHist = Math.max(0.2, 1 - (0.75 * mean(past.map((h) => h.cloudCoverPct))) / 100);
  }

  const fullWh = shp2?.projection.backupFullCapWh ?? null;
  let socWh = shp2?.projection.backupRemainWh ?? null;
  const reserveSoc = shp2?.projection.backupReserveSoc ?? 15;

  const hours: ForecastHour[] = [];
  const startHour = Math.ceil(now / 3_600_000) * 3_600_000;
  let minSoc: number | null = null;
  let minSocTs: number | null = null;
  let pvSum = 0;
  for (let k = 0; k < 24; k++) {
    const ts = startHour + k * 3_600_000;
    const clock = new Date(ts).getHours();
    const wx = wxByHour.get(Math.floor(ts / 3_600_000)) ?? null;
    const cloud = wx ? wx.cloudCoverPct : null;
    const ghi = wx ? wx.radiationWm2 : null;
    const resp = solarModel.hourly[clock];

    let pv: number;
    let modelled = false;
    if (resp.coeff != null && ghi != null) {
      // Equipment-tuned: learned response × forecast sunlight, capped at observed peak.
      pv = Math.min(resp.coeff * ghi, resp.observedMaxPvW * 1.05);
      modelled = true;
    } else {
      // Fallback: typical-day curve × cloud derate.
      const basePv = pvCurve[clock];
      pv = cloud != null ? basePv * Math.max(0.1, Math.min(1.3, (1 - (0.75 * cloud) / 100) / clearnessHist)) : basePv;
    }
    const load = loadRes.curve[clock];
    pvSum += pv;
    let socPct: number | null = null;
    if (fullWh && fullWh > 0 && socWh != null) {
      socWh = Math.max(0, Math.min(fullWh, socWh + (pv - load)));
      socPct = (socWh / fullWh) * 100;
      if (minSoc == null || socPct < minSoc) {
        minSoc = socPct;
        minSocTs = ts;
      }
    }
    hours.push({
      ts,
      forecastPvW: Math.round(pv),
      forecastLoadW: Math.round(load),
      cloudCoverPct: cloud,
      ghiWm2: ghi == null ? null : Math.round(ghi),
      projectedSocPct: socPct == null ? null : Math.round(socPct * 10) / 10,
      modelled,
    });
  }

  const value: DayForecast = {
    generatedAt: now,
    hasWeather,
    historyDays: Math.round(historyDays * 10) / 10,
    reserveSoc,
    hours,
    forecastPvWhNext24: Math.round(pvSum),
    typicalPvWhPerDay: Math.round(pvCurve.reduce((a, b) => a + b, 0)),
    minProjectedSoc: minSoc == null ? null : Math.round(minSoc * 10) / 10,
    minProjectedSocTs: minSocTs,
    solarModel,
    deviceModels,
    soiling: weather ? computeSoiling(fleetPvByEpoch, wxByHour) : null,
  };
  if (dpus.length > 0 && historyDays > 0) dayForecastCache = { ts: now, value };
  return value;
}

/** Forecast-driven alerts derived from a DayForecast. */
export function forecastDayAlerts(df: DayForecast): Alert[] {
  const out: Alert[] = [];
  if (df.minProjectedSoc != null && df.minProjectedSocTs != null && df.minProjectedSoc < df.reserveSoc) {
    const when = new Date(df.minProjectedSocTs).toLocaleString([], { weekday: 'short', hour: 'numeric' });
    out.push({
      id: 'forecast-soc-dip',
      severity: 'warning',
      category: 'SHP2',
      source: 'learned',
      device: 'System',
      title: 'Projected battery dip below reserve',
      detail: `Forecast has the backup pool reaching ~${df.minProjectedSoc}% around ${when} — below the ${df.reserveSoc}% reserve. Based on the typical-day load curve and the cloud-aware solar forecast.`,
      facts: [
        { label: 'Projected low SoC', value: `${df.minProjectedSoc}%` },
        { label: 'Reserve floor', value: `${df.reserveSoc}%` },
        { label: 'Expected at', value: when },
        { label: 'Solar next 24h', value: `${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh` },
        { label: 'History depth', value: `${df.historyDays} days` },
      ],
    });
  }
  if (df.hasWeather && df.typicalPvWhPerDay > 0 && df.forecastPvWhNext24 < 0.6 * df.typicalPvWhPerDay) {
    out.push({
      id: 'forecast-low-solar',
      severity: 'info',
      category: 'Solar',
      source: 'learned',
      device: 'System',
      title: 'Low solar forecast',
      detail: `Next-24h solar forecast ~${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh — well below the typical ~${(df.typicalPvWhPerDay / 1000).toFixed(1)} kWh/day, due to cloud cover in the forecast.`,
      facts: [
        { label: 'Solar next 24h', value: `${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh` },
        { label: 'Typical per day', value: `${(df.typicalPvWhPerDay / 1000).toFixed(1)} kWh` },
        { label: 'Forecast vs typical', value: `${Math.round((df.forecastPvWhNext24 / df.typicalPvWhPerDay) * 100)}%` },
      ],
    });
  }
  // PV soiling — clear-sky output drifting below the clean-panel baseline.
  if (df.soiling && df.soiling.cleanDays >= 6 && df.soiling.dropPct >= 12) {
    out.push({
      id: 'soiling-pv',
      severity: df.soiling.dropPct >= 22 ? 'warning' : 'info',
      category: 'Solar',
      source: 'learned',
      device: 'System',
      title: 'Solar output below clean-panel baseline',
      detail: `On clear-sky hours the arrays are producing ~${df.soiling.dropPct}% less per unit of sunlight than the cleanest day on record — consistent with panel soiling (dust/pollen). Washing the panels should recover most of it.`,
      facts: [
        { label: 'Output drop', value: `${df.soiling.dropPct}%` },
        { label: 'Clean baseline', value: `${df.soiling.baselineCoeff.toFixed(1)} W per W/m²` },
        { label: 'Recent clear-sky', value: `${df.soiling.recentCoeff.toFixed(1)} W per W/m²` },
        { label: 'Clear days analysed', value: String(df.soiling.cleanDays) },
        { label: 'Method', value: 'recent vs best clear-sky response' },
      ],
    });
  }
  return out;
}

/* ===================================================================
 * Learned analytics — battery degradation: capacity-fade → end-of-life.
 *
 * Every pack's BMS reports State of Health (SoH) — measured usable
 * capacity against the pack's original design capacity. SoH falls
 * slowly as the cells age. This regresses each pack's recorded SoH over
 * its full history and extrapolates the decline to the 80%-SoH
 * end-of-life mark.
 *
 * The projection is reported HONESTLY. The regression's slope standard
 * error becomes a confidence band, so a thin or noisy trend produces a
 * wide EOL range rather than a falsely-precise date. A parallel cycle-
 * count regression gives usage intensity (cycles/year) and lets the
 * fade rate be re-expressed per 100 cycles — comparable to a spec
 * sheet. Finally each pack's fade rate is compared against the fleet
 * with the same robust median+MAD test the peer-anomaly engine uses,
 * surfacing a pack wearing abnormally fast for its peer group.
 * =================================================================== */

const EOL_SOH = 80;                                          // % — conventional LFP end-of-life
const DEGRADE_REPORT_TTL_MS = 30 * 60 * 1000;
const DEGRADE_REPORT_HISTORY_MS = 400 * 24 * 60 * 60 * 1000;  // regress over up to ~13 months
const DEGRADE_BUCKET_SEC = 6 * 3600;                          // 6-hour buckets — de-noise SoH jitter
const EOL_MIN_SPAN_MS = 7 * 24 * 60 * 60 * 1000;              // ≥1 week of data before dating an EOL
const EOL_MIN_R2 = 0.3;                                       // trend must explain ≥30% of variance
const EOL_MAX_YEARS = 40;                                     // beyond this, "EOL not in sight"
const PACK_MAH_TO_KWH = (51.2 * 2) / 1_000_000;               // single-string mAh → pack kWh
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export type DegradeStatus = 'projecting' | 'stable' | 'learning' | 'no-data';

export interface PackDegradation {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  status: DegradeStatus;
  // Current state
  currentSoh: number | null;            // %
  currentCapacityKwh: number | null;    // measured full capacity now
  designCapacityKwh: number | null;     // original design capacity
  capacityFadeKwh: number | null;       // design − current
  cycles: number | null;                // equivalent full cycles to date
  lifetimeThroughputKwh: number | null; // energy ever cycled through the pack
  // Learned fade trend
  fadePctPerYear: number | null;        // calendar fade (positive = losing SoH)
  fadeUncertaintyPct: number | null;    // ± 1 SE on the fade rate
  cyclesPerYear: number | null;         // usage intensity
  fadePctPer100Cycles: number | null;   // fade re-expressed per 100 cycles
  r2: number | null;
  dataSpanDays: number;
  samples: number;
  // Projection to end-of-life
  yearsToEol: number | null;
  yearsToEolLow: number | null;         // lower bound — fast-fade scenario
  yearsToEolHigh: number | null;        // upper bound — slow-fade scenario (null = indefinite)
  eolDate: number | null;               // epoch ms at the central estimate
  projectedCyclesAtEol: number | null;
  // Fleet context
  peerFadeRatio: number | null;         // this pack's fade ÷ fleet median fade
  peerOutlier: boolean;                 // fading abnormally fast for its peer group
  // Arrhenius temperature-corrected fade (v0.5.0)
  avgPackTempC: number | null;          // pack temp avg across the SoH window
  arrheniusFactor: number | null;       // 2^((avgTemp − 25)/10) — fade-acceleration factor
  fadePctPerYearAt25C: number | null;   // fade normalized to the 25 °C reference
  coolingBenefitYears: number | null;   // extra service-years if avg pack temp dropped by 5 °C
  summary: string;                      // one-line plain-language verdict
}

export interface FleetDegradation {
  generatedAt: number;
  eolSoh: number;
  packs: PackDegradation[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Regress one pack's SoH history and project it to end-of-life. */
function analysePack(
  d: DeviceSnapshot & { projection: DpuProjection },
  pk: DpuPack,
  recorder: Recorder,
  since: number,
  now: number,
): PackDegradation {
  const currentSoh = pk.actSoh ?? pk.soh;
  const currentCapacityKwh = pk.fullCapMah != null ? pk.fullCapMah * PACK_MAH_TO_KWH : null;
  const designCapacityKwh = pk.designCapMah != null ? pk.designCapMah * PACK_MAH_TO_KWH : null;
  const throughputMah = pk.accuDsgMah ?? pk.accuChgMah;

  /** Build a complete record from the shared fields plus per-status extras. */
  const mk = (
    extra: Partial<PackDegradation> & { status: DegradeStatus; summary: string },
  ): PackDegradation => ({
    sn: d.sn,
    device: d.deviceName,
    coreNum: dpuNum(d.deviceName),
    packNum: pk.num,
    currentSoh: currentSoh != null ? round2(currentSoh) : null,
    currentCapacityKwh: currentCapacityKwh != null ? round2(currentCapacityKwh) : null,
    designCapacityKwh: designCapacityKwh != null ? round2(designCapacityKwh) : null,
    capacityFadeKwh:
      currentCapacityKwh != null && designCapacityKwh != null
        ? Math.max(0, round2(designCapacityKwh - currentCapacityKwh))
        : null,
    cycles: pk.cycles,
    lifetimeThroughputKwh: throughputMah != null ? Math.round(throughputMah * PACK_MAH_TO_KWH) : null,
    fadePctPerYear: null,
    fadeUncertaintyPct: null,
    cyclesPerYear: null,
    fadePctPer100Cycles: null,
    r2: null,
    dataSpanDays: 0,
    samples: 0,
    yearsToEol: null,
    yearsToEolLow: null,
    yearsToEolHigh: null,
    eolDate: null,
    projectedCyclesAtEol: null,
    peerFadeRatio: null,
    peerOutlier: false,
    avgPackTempC: null,
    arrheniusFactor: null,
    fadePctPerYearAt25C: null,
    coolingBenefitYears: null,
    ...extra,
  });

  const sohPts = recorder.query(d.sn, `pack${pk.num}_soh`, since, now, DEGRADE_BUCKET_SEC);
  const spanMs = sohPts.length > 1 ? sohPts[sohPts.length - 1].ts - sohPts[0].ts : 0;
  const spanDays = round1(spanMs / 86_400_000);

  // No usable history.
  if (sohPts.length < 8 || currentSoh == null) {
    return mk({
      status: 'no-data',
      dataSpanDays: spanDays,
      samples: sohPts.length,
      summary: 'No SoH history recorded yet — a projection appears once enough data accumulates.',
    });
  }

  const fit = linregress(sohPts);
  const fadePctPerYear = fit ? -fit.slopePerMs * YEAR_MS : null;
  const fadeUncertaintyPct = fit ? fit.slopeStdErrPerMs * YEAR_MS : null;

  // Parallel cycle-count regression → usage intensity.
  const cycFit = linregress(recorder.query(d.sn, `pack${pk.num}_cycles`, since, now, DEGRADE_BUCKET_SEC));
  const cyclesPerYear =
    cycFit && cycFit.slopePerMs > 0 ? round1(cycFit.slopePerMs * YEAR_MS) : null;

  // Pack-temperature average over the same window. LFP capacity-fade roughly
  // doubles per 10 °C above the 25 °C reference, so we use this to compute an
  // Arrhenius acceleration factor and a temperature-corrected fade rate.
  const tempPts = recorder.query(d.sn, `pack${pk.num}_temp`, since, now, DEGRADE_BUCKET_SEC);
  const tempVals = tempPts.map((p) => p.value).filter((v) => Number.isFinite(v));
  const avgPackTempC =
    tempVals.length > 0 ? tempVals.reduce((s, v) => s + v, 0) / tempVals.length : null;
  const arrheniusFactor =
    avgPackTempC != null ? Math.pow(2, (avgPackTempC - 25) / 10) : null;

  // Trend not yet trustworthy → "learning": preliminary numbers, no dated EOL.
  if (!fit || spanMs < EOL_MIN_SPAN_MS || fit.r2 < EOL_MIN_R2) {
    return mk({
      status: 'learning',
      fadePctPerYear: fadePctPerYear != null ? round2(fadePctPerYear) : null,
      fadeUncertaintyPct: fadeUncertaintyPct != null ? round2(fadeUncertaintyPct) : null,
      cyclesPerYear,
      r2: fit ? round2(fit.r2) : null,
      dataSpanDays: spanDays,
      samples: sohPts.length,
      summary: `Gathering data — ${spanDays} day(s) recorded; a dated end-of-life projection needs a longer, cleaner SoH trend (have R² ${fit ? fit.r2.toFixed(2) : '—'}, need ≥ ${EOL_MIN_R2}).`,
    });
  }

  const headroom = currentSoh - EOL_SOH;
  const yearsToEol = fadePctPerYear != null && fadePctPerYear > 0 ? headroom / fadePctPerYear : Infinity;

  // Flat / improving / already at EOL / EOL beyond a working lifetime.
  if (fadePctPerYear == null || fadePctPerYear < 0.1 || currentSoh <= EOL_SOH || yearsToEol > EOL_MAX_YEARS) {
    const summary =
      currentSoh <= EOL_SOH
        ? `SoH ${currentSoh.toFixed(1)}% is already at the ${EOL_SOH}% end-of-life mark — plan a pack replacement.`
        : fadePctPerYear == null || fadePctPerYear < 0.1
          ? `No measurable capacity fade across ${spanDays} days of data — end-of-life is not in sight.`
          : `Fade is only ~${fadePctPerYear.toFixed(2)}%/yr — end-of-life is ${EOL_MAX_YEARS}+ years out, effectively not a concern.`;
    return mk({
      status: 'stable',
      fadePctPerYear: fadePctPerYear != null ? round2(fadePctPerYear) : null,
      fadeUncertaintyPct: fadeUncertaintyPct != null ? round2(fadeUncertaintyPct) : null,
      cyclesPerYear,
      r2: round2(fit.r2),
      dataSpanDays: spanDays,
      samples: sohPts.length,
      avgPackTempC: avgPackTempC != null ? round1(avgPackTempC) : null,
      arrheniusFactor: arrheniusFactor != null ? round2(arrheniusFactor) : null,
      summary:
        summary +
        (avgPackTempC != null
          ? ` Avg pack temp ${Math.round(avgPackTempC)} °C across the window.`
          : ''),
    });
  }

  // Projecting — central fade plus a ±1-SE confidence band on the EOL date.
  const se = fadeUncertaintyPct ?? 0;
  const fadeFast = fadePctPerYear + se;            // faster fade → sooner EOL
  const fadeSlow = Math.max(0.02, fadePctPerYear - se);
  const yearsToEolLow = headroom / fadeFast;
  const yearsToEolHighRaw = headroom / fadeSlow;
  const yearsToEolHigh =
    fadeSlow <= 0.05 || yearsToEolHighRaw > EOL_MAX_YEARS ? null : yearsToEolHighRaw;
  const eolDate = now + yearsToEol * YEAR_MS;

  const projectedCyclesAtEol =
    cycFit && cycFit.slopePerMs > 0 && pk.cycles != null
      ? Math.round(pk.cycles + cycFit.slopePerMs * yearsToEol * YEAR_MS)
      : null;
  const fadePctPer100Cycles =
    cyclesPerYear != null && cyclesPerYear >= 5
      ? round2((fadePctPerYear / cyclesPerYear) * 100)
      : null;

  const rangeNote =
    yearsToEolHigh != null
      ? ` (range ${round1(yearsToEolLow)}–${round1(yearsToEolHigh)} yr, ±1σ)`
      : ` (at least ${round1(yearsToEolLow)} yr)`;

  // Arrhenius temperature correction — what the calendar-fade would be at the
  // 25 °C reference, and how many extra years cooling 5 °C would buy.
  const COOLING_DELTA_C = 5;
  const fadePctPerYearAt25C =
    arrheniusFactor != null && arrheniusFactor > 0
      ? round2(fadePctPerYear / arrheniusFactor)
      : null;
  let coolingBenefitYears: number | null = null;
  if (arrheniusFactor != null && avgPackTempC != null) {
    const cooledFactor = Math.pow(2, (avgPackTempC - COOLING_DELTA_C - 25) / 10);
    const cooledFade = fadePctPerYear * (cooledFactor / arrheniusFactor);
    if (cooledFade >= 0.01) {
      const cooledYearsToEol = headroom / cooledFade;
      const delta = cooledYearsToEol - yearsToEol;
      if (delta > 0.05) coolingBenefitYears = round1(delta);
    }
  }
  const arrheniusNote =
    avgPackTempC != null && fadePctPerYearAt25C != null && coolingBenefitYears != null
      ? ` Avg pack temp ${Math.round(avgPackTempC)} °C → Arrhenius-equivalent to ~${fadePctPerYearAt25C} %/yr at 25 °C; cooling the cells ${COOLING_DELTA_C} °C would extend service life by ~${coolingBenefitYears} years.`
      : avgPackTempC != null
        ? ` Avg pack temp ${Math.round(avgPackTempC)} °C across the window.`
        : '';

  return mk({
    status: 'projecting',
    fadePctPerYear: round2(fadePctPerYear),
    fadeUncertaintyPct: round2(se),
    cyclesPerYear,
    fadePctPer100Cycles,
    r2: round2(fit.r2),
    dataSpanDays: spanDays,
    samples: sohPts.length,
    yearsToEol: round1(yearsToEol),
    yearsToEolLow: round1(yearsToEolLow),
    yearsToEolHigh: yearsToEolHigh != null ? round1(yearsToEolHigh) : null,
    eolDate: Math.round(eolDate),
    projectedCyclesAtEol,
    avgPackTempC: avgPackTempC != null ? round1(avgPackTempC) : null,
    arrheniusFactor: arrheniusFactor != null ? round2(arrheniusFactor) : null,
    fadePctPerYearAt25C,
    coolingBenefitYears,
    summary: `SoH ${currentSoh.toFixed(1)}% fading ~${fadePctPerYear.toFixed(1)}%/yr — projected to reach the ${EOL_SOH}% end-of-life mark around ${new Date(eolDate).getFullYear()}, about ${round1(yearsToEol)} years out${rangeNote}.${arrheniusNote}`,
  });
}

let degradationCache: { ts: number; value: FleetDegradation } | null = null;

/** Per-pack capacity-fade → end-of-life projection, with fleet peer comparison.
 *  Cached ~30 min (the underlying SoH trend moves on a scale of weeks). */
export function computeDegradation(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): FleetDegradation {
  if (degradationCache && Date.now() - degradationCache.ts < DEGRADE_REPORT_TTL_MS) {
    return degradationCache.value;
  }
  const now = Date.now();
  const since = now - DEGRADE_REPORT_HISTORY_MS;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  // Pass 1 — regress and project every pack independently.
  const packs: PackDegradation[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) packs.push(analysePack(d, pk, recorder, since, now));
  }

  // Pass 2 — fleet peer comparison: which pack is wearing fast for its group.
  // Robust median + MAD, modified z-score — the same test the peer-anomaly
  // engine uses. Needs ≥3 packs with a real fade trend to form a peer group.
  const projecting = packs.filter(
    (p): p is PackDegradation & { fadePctPerYear: number } =>
      p.status === 'projecting' && p.fadePctPerYear != null,
  );
  if (projecting.length >= 3) {
    const rates = projecting.map((p) => p.fadePctPerYear);
    const med = median(rates);
    const m = mad(rates, med);
    for (const p of projecting) {
      p.peerFadeRatio = med > 0 ? round2(p.fadePctPerYear / med) : null;
      const z = m > 0 ? Math.abs((0.6745 * (p.fadePctPerYear - med)) / m) : 0;
      if (p.fadePctPerYear > med && z >= Z_INFO) {
        p.peerOutlier = true;
        p.summary += ` It is fading about ${(p.peerFadeRatio ?? 1).toFixed(1)}× the fleet-median rate — the fastest-wearing pack in its peer group.`;
      }
    }
  }

  // Worst-first ordering: soonest projected EOL leads; healthy/quiet packs trail.
  const rank: Record<DegradeStatus, number> = { projecting: 0, learning: 1, stable: 2, 'no-data': 3 };
  packs.sort((a, b) => {
    const r = rank[a.status] - rank[b.status];
    if (r !== 0) return r;
    if (a.status === 'projecting') return (a.yearsToEol ?? 1e9) - (b.yearsToEol ?? 1e9);
    return (a.coreNum ?? 999) - (b.coreNum ?? 999) || a.packNum - b.packNum;
  });

  const value: FleetDegradation = { generatedAt: now, eolSoh: EOL_SOH, packs };
  if (dpus.length > 0) degradationCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Live off-grid runway — hours until the backup pool hits reserve and
 * empty, given the last-hour load and the next-24h forecast PV.
 * =================================================================== */

const RUNWAY_LOAD_WINDOW_MS = 60 * 60 * 1000;   // average load over the last hour
const RUNWAY_HORIZON_HOURS = 24;
const RUNWAY_TTL_MS = 60 * 1000;                // recompute at most once per minute

export interface RunwayProjection {
  generatedAt: number;
  backupRemainingKwh: number | null;
  backupReserveKwh: number | null;
  backupFullKwh: number | null;
  recentLoadWatts: number;
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  reserveAtMs: number | null;
  emptyAtMs: number | null;
  forecastPvUsedKwh: number;
  loadHorizonKwh: number;
  horizonHours: number;
  unavailable: string | null;
}

let runwayCache: { ts: number; value: RunwayProjection } | null = null;

const emptyRunway = (now: number, reason: string, extra: Partial<RunwayProjection> = {}): RunwayProjection => ({
  generatedAt: now,
  backupRemainingKwh: null,
  backupReserveKwh: null,
  backupFullKwh: null,
  recentLoadWatts: 0,
  hoursToReserve: null,
  hoursToEmpty: null,
  reserveAtMs: null,
  emptyAtMs: null,
  forecastPvUsedKwh: 0,
  loadHorizonKwh: 0,
  horizonHours: 0,
  unavailable: reason,
  ...extra,
});

/** Project hour-by-hour: backup state ± (forecast PV − recent load) per hour;
 *  record when the trajectory crosses the reserve floor and zero. */
export function computeRunway(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  forecast: DayForecast | null,
): RunwayProjection {
  if (runwayCache && Date.now() - runwayCache.ts < RUNWAY_TTL_MS) return runwayCache.value;
  const now = Date.now();
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  if (!shp2 || shp2.projection.backupRemainWh == null || shp2.projection.backupFullCapWh == null) {
    return emptyRunway(now, 'SHP2 backup-pool capacity not yet reported');
  }

  const backupRemainingKwh = shp2.projection.backupRemainWh / 1000;
  const backupFullKwh = shp2.projection.backupFullCapWh / 1000;
  const reservePct = shp2.projection.backupReserveSoc ?? 15;
  const backupReserveKwh = (backupFullKwh * reservePct) / 100;

  // Recent load — average SHP2 panel_load over the last hour. (Loads wired
  // directly to a DPU AC outlet bypass SHP2 and won't appear here; on this
  // setup that's just the EVSE on Core 4, which only runs occasionally.)
  const loadPts = recorder.query(shp2.sn, 'panel_load', now - RUNWAY_LOAD_WINDOW_MS, now);
  if (loadPts.length < 2) {
    return emptyRunway(now, 'panel-load history insufficient — wait a few minutes', {
      backupRemainingKwh: round2(backupRemainingKwh),
      backupReserveKwh: round2(backupReserveKwh),
      backupFullKwh: round2(backupFullKwh),
    });
  }
  const loadAvgWatts = loadPts.reduce((s, p) => s + p.value, 0) / loadPts.length;

  const pvByHour: number[] = [];
  if (forecast) {
    for (const h of forecast.hours.slice(0, RUNWAY_HORIZON_HOURS)) {
      pvByHour.push((h.forecastPvW ?? 0) / 1000);
    }
  }
  while (pvByHour.length < RUNWAY_HORIZON_HOURS) pvByHour.push(0);

  let stateKwh = backupRemainingKwh;
  let hoursToReserve: number | null = null;
  let hoursToEmpty: number | null = null;
  const loadKwhPerHour = loadAvgWatts / 1000;
  let totalForecastPv = 0;
  let totalLoad = 0;
  for (let h = 0; h < RUNWAY_HORIZON_HOURS; h++) {
    const pvKwh = pvByHour[h];
    totalForecastPv += pvKwh;
    totalLoad += loadKwhPerHour;
    const delta = pvKwh - loadKwhPerHour;
    const nextState = stateKwh + delta;
    if (hoursToReserve == null && stateKwh > backupReserveKwh && nextState <= backupReserveKwh) {
      const frac = delta < 0 ? (stateKwh - backupReserveKwh) / -delta : 1;
      hoursToReserve = h + Math.min(1, Math.max(0, frac));
    }
    if (hoursToEmpty == null && stateKwh > 0 && nextState <= 0) {
      const frac = delta < 0 ? stateKwh / -delta : 1;
      hoursToEmpty = h + Math.min(1, Math.max(0, frac));
    }
    stateKwh = Math.max(0, nextState);
  }

  const value: RunwayProjection = {
    generatedAt: now,
    backupRemainingKwh: round2(backupRemainingKwh),
    backupReserveKwh: round2(backupReserveKwh),
    backupFullKwh: round2(backupFullKwh),
    recentLoadWatts: Math.round(loadAvgWatts),
    hoursToReserve: hoursToReserve != null ? round1(hoursToReserve) : null,
    hoursToEmpty: hoursToEmpty != null ? round1(hoursToEmpty) : null,
    reserveAtMs: hoursToReserve != null ? Math.round(now + hoursToReserve * 3_600_000) : null,
    emptyAtMs: hoursToEmpty != null ? Math.round(now + hoursToEmpty * 3_600_000) : null,
    forecastPvUsedKwh: round2(totalForecastPv),
    loadHorizonKwh: round2(totalLoad),
    horizonHours: RUNWAY_HORIZON_HOURS,
    unavailable: null,
  };
  runwayCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Round-trip efficiency — energy retrieved from packs ÷ energy stored
 * into packs, over a rolling 7-day window. Healthy LFP ≈ 95–97 %; a
 * slow drift down is the cleanest "the whole stack is aging" signal.
 * Uses per-pack input/output integrals so PV-direct passthrough doesn't
 * contaminate the ratio. Cached ~5 min.
 * =================================================================== */

const RTE_TTL_MS = 5 * 60 * 1000;

export interface RoundTripDay {
  date: string;
  chargedKwh: number;
  dischargedKwh: number;
  efficiencyPct: number | null;
}

export interface RoundTripEfficiency {
  generatedAt: number;
  windowDays: number;
  daysWithData: number;
  totalChargedKwh: number;
  totalDischargedKwh: number;
  efficiencyPct: number | null;
  perDay: RoundTripDay[];
}

let rteCache: { ts: number; key: string; value: RoundTripEfficiency } | null = null;

export function computeRoundTripEfficiency(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  windowDays = 7,
): RoundTripEfficiency {
  const key = `d${windowDays}`;
  if (rteCache && rteCache.key === key && Date.now() - rteCache.ts < RTE_TTL_MS) return rteCache.value;
  const now = Date.now();
  const todayStart = startOfLocalDayMs();
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  const localDateStr = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const perDay: RoundTripDay[] = [];
  let totalCharged = 0;
  let totalDischarged = 0;
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayStart = todayStart - i * 86_400_000;
    const dayEnd = i === 0 ? now : dayStart + 86_400_000;
    let chargedKwh = 0;
    let dischargedKwh = 0;
    for (const d of dpus) {
      for (const pk of d.projection.packs) {
        const inPts = recorder.query(d.sn, `pack${pk.num}_in`, dayStart, dayEnd);
        const outPts = recorder.query(d.sn, `pack${pk.num}_out`, dayStart, dayEnd);
        chargedKwh += integrateWh(inPts, dayStart, dayEnd).wh / 1000;
        dischargedKwh += integrateWh(outPts, dayStart, dayEnd).wh / 1000;
      }
    }
    totalCharged += chargedKwh;
    totalDischarged += dischargedKwh;
    const dayEff = chargedKwh > 0.5 ? (dischargedKwh / chargedKwh) * 100 : null;
    perDay.push({
      date: localDateStr(dayStart),
      chargedKwh: round2(chargedKwh),
      dischargedKwh: round2(dischargedKwh),
      efficiencyPct: dayEff != null ? Math.round(dayEff * 10) / 10 : null,
    });
  }
  const effPct = totalCharged > 1 ? (totalDischarged / totalCharged) * 100 : null;
  const value: RoundTripEfficiency = {
    generatedAt: now,
    windowDays,
    daysWithData: perDay.filter((d) => d.efficiencyPct != null).length,
    totalChargedKwh: round2(totalCharged),
    totalDischargedKwh: round2(totalDischarged),
    efficiencyPct: effPct != null ? Math.round(effPct * 10) / 10 : null,
    perDay,
  };
  if (dpus.length > 0) rteCache = { ts: now, key, value };
  return value;
}
