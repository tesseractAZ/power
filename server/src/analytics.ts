import type { DeviceSnapshot } from './snapshot.js';
import type { DpuPack, DpuProjection, Shp2Projection } from './ecoflow/project.js';
import type { Alert } from './alerts.js';
import type { Recorder } from './recorder.js';
import { getWeather, type WeatherHour, type WeatherForecast } from './weather.js';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership.js';
import { integrateWh, startOfLocalDayMs } from './aggregator.js';
import { getNwsAlerts, isNwsEnabled, type NwsAlert } from './nws.js';
import { PHOENIX_SITE } from './physics/clearSky.js';

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
      // v0.6.0 — per-circuit baseline anomaly. Skip circuits already covered
      // by a paired-circuit aggregate target. Same robust median+MAD test
      // against each circuit's own hour-of-day history; catches operational
      // anomalies like "fridge running 3 kW for 6 h when typical is 200 W"
      // without per-circuit thresholds.
      const pairedChs = new Set<number>();
      for (const pc of sp.pairedCircuits) {
        pairedChs.add(pc.primaryCh);
        if (pc.secondaryCh != null) pairedChs.add(pc.secondaryCh);
      }
      for (const c of sp.circuits) {
        if (pairedChs.has(c.ch)) continue;
        if (c.watts == null) continue;
        targets.push({
          sn: d.sn,
          metric: `ch${c.ch}_w`,
          device: d.deviceName,
          label: `${c.name || `Circuit ${c.ch}`} load`,
          category: 'SHP2',
          coreNum: null,
          packNum: null,
          live: c.watts,
          floor: 500,
          transform: (x) => x,
          fmt: wattFmt,
        });
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
  // v0.9.3 — predicted EV-charging load lifted from computeEvWindowPrediction
  // and folded into the load curve. 0 when no EV session is predicted.
  predictedEvLoadW?: number;
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

// v0.9.29 — 5-min SQL bucketing on long-window hour-of-day helpers. All
// three (hourCurve, hourCurveByWeekday, pvHourlyByEpoch) feed per-hour
// means/medians, where the within-hour distribution is dominated by
// natural variance, not by which 10 s sample we hit. 5-min pre-averaging
// drops query rowcount ~30× without measurable change in the output
// curve. Saves ~250 ms on cold-start of the day-forecast cache.
const HOUR_CURVE_BUCKET_SEC = 300;

/** Hour-of-day average curve (24 values) for a metric, plus the history span. */
function hourCurve(
  recorder: Recorder,
  sn: string,
  metric: string,
  sinceMs: number,
  nowMs: number,
): { curve: number[]; spanMs: number } {
  const pts = recorder.query(sn, metric, sinceMs, nowMs, HOUR_CURVE_BUCKET_SEC);
  const buckets: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of pts) buckets[new Date(p.ts).getHours()].push(p.value);
  return {
    curve: buckets.map((b) => mean(b)),
    spanMs: pts.length > 1 ? pts[pts.length - 1].ts - pts[0].ts : 0,
  };
}

/**
 * Day-of-week-aware hourly curve. Returns separate 24-hour profiles for
 * weekdays (Mon–Fri) and weekends (Sat–Sun) so forecasts pick up the obvious
 * pattern that EV charging / HVAC duty / appliances run on a different
 * schedule when nobody's at work. Falls back to the combined curve when
 * either bucket is too thin to trust.
 */
function hourCurveByWeekday(
  recorder: Recorder,
  sn: string,
  metric: string,
  sinceMs: number,
  nowMs: number,
): { weekday: number[]; weekend: number[]; combined: number[]; spanMs: number; weekdaySamples: number; weekendSamples: number } {
  const pts = recorder.query(sn, metric, sinceMs, nowMs, HOUR_CURVE_BUCKET_SEC);
  const weekdayBuckets: number[][] = Array.from({ length: 24 }, () => []);
  const weekendBuckets: number[][] = Array.from({ length: 24 }, () => []);
  const combinedBuckets: number[][] = Array.from({ length: 24 }, () => []);
  let weekdaySamples = 0;
  let weekendSamples = 0;
  for (const p of pts) {
    const d = new Date(p.ts);
    const h = d.getHours();
    const dow = d.getDay(); // 0 = Sun, 6 = Sat
    combinedBuckets[h].push(p.value);
    if (dow === 0 || dow === 6) {
      weekendBuckets[h].push(p.value);
      weekendSamples++;
    } else {
      weekdayBuckets[h].push(p.value);
      weekdaySamples++;
    }
  }
  const combined = combinedBuckets.map((b) => mean(b));
  // If a bucket has no samples for a given hour, fall back to the combined
  // hour — keeps the curve continuous when one weekday/weekend group is thin.
  const weekday = weekdayBuckets.map((b, h) => (b.length ? mean(b) : combined[h]));
  const weekend = weekendBuckets.map((b, h) => (b.length ? mean(b) : combined[h]));
  return {
    weekday,
    weekend,
    combined,
    spanMs: pts.length > 1 ? pts[pts.length - 1].ts - pts[0].ts : 0,
    weekdaySamples,
    weekendSamples,
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
  const pts = recorder.query(sn, metric, sinceMs, nowMs, HOUR_CURVE_BUCKET_SEC);
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
  // v0.9.76 — only DPUs wired into the SHP2 contribute PV to the home.
  // Spare cores may have panels for bench-charging but their PV doesn't
  // reach the home power bus, so they shouldn't inflate forecasts that
  // drive runway / MPC / projected SoC / clipping detection.
  // `homeDpus` is used for fleet PV sums; `dpus` stays for per-device
  // diagnostic models below (the operator still wants spare-array visibility
  // per-Core, just not contaminating the fleet model).
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));

  // Typical-day fleet PV curve (fallback when the model lacks an hour) + load curve.
  const pvCurve = new Array(24).fill(0);
  let pvSpan = 0;
  for (const d of homeDpus) {
    const { curve, spanMs } = hourCurve(recorder, d.sn, 'pv_total', since, now);
    for (let h = 0; h < 24; h++) pvCurve[h] += curve[h];
    pvSpan = Math.max(pvSpan, spanMs);
  }
  // v0.6.0 — separate weekday vs weekend load curves. EV charging,
  // dishwasher, laundry, and home-office HVAC duty all run on visibly
  // different schedules; collapsing them into a single 24h average blurs
  // both. Fall back to the combined curve when a bucket is too thin.
  const loadRes = shp2
    ? hourCurveByWeekday(recorder, shp2.sn, 'panel_load', since, now)
    : {
        weekday: new Array(24).fill(0),
        weekend: new Array(24).fill(0),
        combined: new Array(24).fill(0),
        spanMs: 0,
        weekdaySamples: 0,
        weekendSamples: 0,
      };
  // Need at least ~24 weekday and ~24 weekend hourly samples to trust the
  // split (one rep of every hour); otherwise project from the combined curve.
  const WEEKDAY_MIN_SAMPLES = 24;
  const useSplitLoad =
    loadRes.weekdaySamples >= WEEKDAY_MIN_SAMPLES &&
    loadRes.weekendSamples >= WEEKDAY_MIN_SAMPLES;
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
  // v0.9.76 — fleetPvByEpoch sums ONLY home-connected DPUs (drives the
  // solarModel used by forecast/runway/MPC). deviceModels still iterates
  // every DPU so spares get per-Core diagnostics on the Solar page.
  const fleetPvByEpoch = new Map<number, number>();
  const deviceModels: DeviceSolarModel[] = [];
  for (const d of dpus) {
    const pvE = pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now);
    if (isShp2Connected(d.sn, connected)) {
      for (const [he, pv] of pvE) fleetPvByEpoch.set(he, (fleetPvByEpoch.get(he) ?? 0) + pv);
    }
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

  // v0.9.3 — lift predicted EV-charging sessions into the load curve. The
  // EVSE window-prediction pattern detector already runs separately; this
  // just folds its upcoming-24h forecast into each hour the session covers.
  // Build a per-hour-epoch map of predicted EV watts (constant across each
  // session's `durationHours` from the session start). When two predicted
  // sessions overlap (rare but possible if multiple EVs / circuits), they
  // sum.
  const evPredictions = computeEvWindowPrediction(devices, recorder);
  const evByHourEpoch = new Map<number, number>();
  for (const sess of evPredictions.upcomingNext24h) {
    const wholeHours = Math.max(1, Math.ceil(sess.durationHours));
    for (let i = 0; i < wholeHours; i++) {
      const heKey = Math.floor((sess.ts + i * 3_600_000) / 3_600_000);
      evByHourEpoch.set(heKey, (evByHourEpoch.get(heKey) ?? 0) + sess.watts);
    }
  }

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
    // Day-of-week-aware load: pick weekday vs weekend curve for the projected
    // hour. Mon–Fri at 5pm looks nothing like Sat at 5pm in this house.
    const projDow = new Date(ts).getDay();
    const isWeekend = projDow === 0 || projDow === 6;
    const baseLoad = useSplitLoad
      ? (isWeekend ? loadRes.weekend[clock] : loadRes.weekday[clock])
      : loadRes.combined[clock];
    // v0.9.3 — add any predicted EV-charging session that covers this hour.
    // The historical load curve already includes PAST EV sessions, but for
    // FUTURE hours we don't want the day-of-week average to flatten a known
    // recurring spike. The EV predictor surfaces those spikes; we add them
    // explicitly here for hours where one is predicted.
    const evLoad = evByHourEpoch.get(Math.floor(ts / 3_600_000)) ?? 0;
    const load = baseLoad + evLoad;
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
      predictedEvLoadW: evLoad > 0 ? Math.round(evLoad) : undefined,
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
  // v0.8.0 — counterfactual driver analysis. Decompose the forecast PV
  // shortfall into "how much is cloud cover" vs "how much is everything
  // else (shading, soiling, model error)". Helps the user understand WHY,
  // not just THAT, the forecast is low.
  const driverCloud = df.hours.length
    ? df.hours.reduce((s, h) => s + (h.cloudCoverPct ?? 0), 0) / df.hours.length
    : 0;
  const driverModelled = df.hours.filter((h) => h.modelled).length;
  const driverTotal = df.hours.length;
  // Hypothetical: what the forecast would be under perfectly clear skies?
  // The solarModel.peakCoeff × the historical max-GHI for each daylight hour
  // gives a clear-sky envelope; sum to get an idealized "clear-day" PV.
  const clearDayKwh = df.solarModel.hourly.reduce(
    (s, h) => s + (h.observedMaxPvW || 0),
    0,
  ) / 1000;
  if (df.minProjectedSoc != null && df.minProjectedSocTs != null && df.minProjectedSoc < df.reserveSoc) {
    const when = new Date(df.minProjectedSocTs).toLocaleString([], { weekday: 'short', hour: 'numeric' });
    const why = driverCloud > 50
      ? `Driven primarily by tomorrow's high cloud cover (~${Math.round(driverCloud)}% avg). Under typical Phoenix-clear sky (~20% cloud) the projection would stay above reserve.`
      : driverCloud > 30
        ? `Driven by elevated cloud cover (~${Math.round(driverCloud)}% avg) AND typical-load curve. Sunny conditions would lift the projection ~${Math.round((clearDayKwh - df.forecastPvWhNext24 / 1000))} kWh.`
        : `Cloud cover is moderate (~${Math.round(driverCloud)}% avg); the dip is driven mostly by load pattern + current battery starting point.`;
    out.push({
      id: 'forecast-soc-dip',
      severity: 'warning',
      category: 'SHP2',
      source: 'learned',
      device: 'System',
      title: 'Projected battery dip below reserve',
      detail: `Forecast has the backup pool reaching ~${df.minProjectedSoc}% around ${when} — below the ${df.reserveSoc}% reserve. ${why}`,
      facts: [
        { label: 'Projected low SoC', value: `${df.minProjectedSoc}%` },
        { label: 'Reserve floor', value: `${df.reserveSoc}%` },
        { label: 'Expected at', value: when },
        { label: 'Solar next 24h', value: `${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh` },
        { label: 'Clear-sky ceiling', value: `${clearDayKwh.toFixed(1)} kWh` },
        { label: 'Avg cloud cover', value: `${Math.round(driverCloud)}%` },
        { label: 'History depth', value: `${df.historyDays} days` },
      ],
    });
  }
  if (df.hasWeather && df.typicalPvWhPerDay > 0 && df.forecastPvWhNext24 < 0.6 * df.typicalPvWhPerDay) {
    const shortfallPct = Math.round((1 - df.forecastPvWhNext24 / df.typicalPvWhPerDay) * 100);
    const why = driverCloud > 60
      ? `Cloud cover ~${Math.round(driverCloud)}% (vs typical ~30%) is the dominant driver — this is weather, not equipment.`
      : driverCloud > 40
        ? `Cloud cover ~${Math.round(driverCloud)}% explains most of the gap. Some shortfall (~${Math.max(0, shortfallPct - Math.round(driverCloud * 0.6))} pp) is unaccounted-for — check the soiling estimate.`
        : `Cloud cover is modest (~${Math.round(driverCloud)}%); the shortfall is unexpected. Check for soiling, shading, or under-performing MPPT strings.`;
    out.push({
      id: 'forecast-low-solar',
      severity: 'info',
      category: 'Solar',
      source: 'learned',
      device: 'System',
      title: 'Low solar forecast',
      detail: `Next-24h solar forecast ~${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh — ${shortfallPct}% below the typical ~${(df.typicalPvWhPerDay / 1000).toFixed(1)} kWh/day. ${why}`,
      facts: [
        { label: 'Solar next 24h', value: `${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh` },
        { label: 'Typical per day', value: `${(df.typicalPvWhPerDay / 1000).toFixed(1)} kWh` },
        { label: 'Forecast vs typical', value: `${Math.round((df.forecastPvWhNext24 / df.typicalPvWhPerDay) * 100)}%` },
        { label: 'Avg cloud cover', value: `${Math.round(driverCloud)}%` },
        { label: 'Hours modelled', value: `${driverModelled}/${driverTotal}` },
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
// v0.9.58 — VERIFIED CORRECT (looks suspicious but isn't):
//   pack nominal voltage = 51.2 V; ×2 because the BMS reports per-single-string mAh
//   while the pack actually has TWO LFP strings in parallel.
//   Wh = V × Ah = 51.2 × (mAh × 2) / 1000  →  kWh = (51.2 × 2) × mAh / 1_000_000.
// Sanity check against live data: pack fullCapMah ≈ 58804 at 99 % SoH →
//   58804 × (51.2 × 2) / 1_000_000 = 6.02 kWh, matching the EcoFlow 6.144 kWh
//   nameplate spec for a 99 %-SoH pack. The `× 2` is correct; do NOT drop it.
// Identical pattern exists at recorder.ts:412 (`PACK_MAH_TO_WH = (51.2 * 2) / 1_000`);
// same justification applies — leave it alone.
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
  // Coulombic efficiency (v0.6.0) — discharge mAh ÷ charge mAh from the
  // pack's lifetime counters across a recent window. Healthy LFP ≈ 99.5+%;
  // a falling number is an early sign of side-reaction losses inside a cell.
  coulombicEffPct: number | null;
  // v0.9.3 — Kalman side-by-side projection. Same SoH history fed through
  // the constant-velocity Kalman filter from v0.9.0. OLS remains the
  // canonical projection (above fields) so this is purely additional data
  // for side-by-side comparison. When kalmanYearsToEol diverges from
  // yearsToEol the user should weight more recent data more heavily.
  kalmanSmoothedSoh: number | null;
  kalmanFadePctPerYear: number | null;
  kalmanFadeStdevPctPerYear: number | null;  // posterior stdev of drift
  kalmanYearsToEol: number | null;
  kalmanEolDate: number | null;
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
    coulombicEffPct: null,
    kalmanSmoothedSoh: null,
    kalmanFadePctPerYear: null,
    kalmanFadeStdevPctPerYear: null,
    kalmanYearsToEol: null,
    kalmanEolDate: null,
    ...extra,
  });

  // v0.9.50 — batch the three bucketed pack metrics (soh / cycles / temp)
  // into a single SQL round-trip. `node:sqlite` is fully synchronous, so
  // each separate `recorder.query()` blocks the event loop while it runs.
  // Across the user's ~20 packs the per-pack 3 calls add up to ~60 blocking
  // queries per cache-warmer cycle; queryMulti collapses that to ~20.
  const packMetrics = recorder.queryMulti(
    d.sn,
    [`pack${pk.num}_soh`, `pack${pk.num}_cycles`, `pack${pk.num}_temp`],
    since,
    now,
    DEGRADE_BUCKET_SEC,
  );
  const sohPts = packMetrics.get(`pack${pk.num}_soh`) ?? [];
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
  const cycFit = linregress(packMetrics.get(`pack${pk.num}_cycles`) ?? []);
  const cyclesPerYear =
    cycFit && cycFit.slopePerMs > 0 ? round1(cycFit.slopePerMs * YEAR_MS) : null;

  // Pack-temperature average over the same window. LFP capacity-fade roughly
  // doubles per 10 °C above the 25 °C reference, so we use this to compute an
  // Arrhenius acceleration factor and a temperature-corrected fade rate.
  const tempPts = packMetrics.get(`pack${pk.num}_temp`) ?? [];
  const tempVals = tempPts.map((p) => p.value).filter((v) => Number.isFinite(v));
  const avgPackTempC =
    tempVals.length > 0 ? tempVals.reduce((s, v) => s + v, 0) / tempVals.length : null;
  const arrheniusFactor =
    avgPackTempC != null ? Math.pow(2, (avgPackTempC - 25) / 10) : null;

  // v0.9.3 — Kalman side-by-side projection. Same SoH history fed through
  // the constant-velocity filter from v0.9.0. OLS remains the canonical
  // projection (above); this is parallel data for comparison. The Kalman
  // smoothed SoH is generally less noise-sensitive than a freshly-fit
  // OLS slope on a short window, and the posterior stdev is a tighter
  // uncertainty estimate than the t-statistic CI.
  const kf = kalmanFilterSoh(sohPts);
  let kalmanFadePctPerYear: number | null = null;
  let kalmanFadeStdevPctPerYear: number | null = null;
  let kalmanSmoothedSoh: number | null = null;
  let kalmanYearsToEol: number | null = null;
  let kalmanEolDate: number | null = null;
  if (kf) {
    // Kalman returns drift as %/yr where negative = SoH fading. Convert to
    // a positive "fade rate %/yr" to match the OLS convention used above.
    kalmanFadePctPerYear = kf.driftPerYear != null ? round2(-kf.driftPerYear) : null;
    kalmanFadeStdevPctPerYear = kf.driftPerYearStdev != null ? round2(kf.driftPerYearStdev) : null;
    kalmanSmoothedSoh = kf.smoothedSoh != null ? round2(kf.smoothedSoh) : null;
    if (kalmanSmoothedSoh != null && kalmanFadePctPerYear != null && kalmanFadePctPerYear > 0.1) {
      const headroom = kalmanSmoothedSoh - EOL_SOH;
      const yrs = headroom / kalmanFadePctPerYear;
      if (yrs > 0 && yrs <= EOL_MAX_YEARS) {
        kalmanYearsToEol = round1(yrs);
        kalmanEolDate = Math.round(now + yrs * YEAR_MS);
      }
    }
  }

  // Coulombic efficiency — discharged mAh ÷ charged mAh across a recent
  // window using the BMS lifetime counters. Both are monotone-rising
  // counters, so Δ(end − start) over the window is the energy moved in/out
  // during that period. Healthy LFP cells stay well above 99%; a downward
  // drift means side reactions are consuming charge that doesn't come back
  // out, an early sign of cell degradation that fade-by-SoH alone misses.
  const CE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const ceSince = now - CE_WINDOW_MS;
  // v0.9.50 — same batching reasoning: lifetime chg + dsg counters share
  // (sn, window, no-bucket) so one queryMulti collapses the pair.
  const lifetimeMetrics = recorder.queryMulti(
    d.sn,
    [`pack${pk.num}_lifetime_chg_mah`, `pack${pk.num}_lifetime_dsg_mah`],
    ceSince,
    now,
  );
  const chgPts = lifetimeMetrics.get(`pack${pk.num}_lifetime_chg_mah`) ?? [];
  const dsgPts = lifetimeMetrics.get(`pack${pk.num}_lifetime_dsg_mah`) ?? [];
  let coulombicEffPct: number | null = null;
  if (chgPts.length >= 2 && dsgPts.length >= 2) {
    const chgDelta = chgPts[chgPts.length - 1].value - chgPts[0].value;
    const dsgDelta = dsgPts[dsgPts.length - 1].value - dsgPts[0].value;
    // Require meaningful throughput in the window (≥ ~1 kWh worth of mAh on
    // a single 102.4V string ≈ 10k mAh) — tiny deltas produce noisy ratios.
    if (chgDelta >= 10_000 && dsgDelta > 0) {
      const ratio = (dsgDelta / chgDelta) * 100;
      // Clamp to a sane band — counter resets or topology quirks otherwise
      // dump a >120% or negative number into the UI.
      if (ratio >= 50 && ratio <= 110) coulombicEffPct = round2(ratio);
    }
  }

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
      coulombicEffPct,
      kalmanSmoothedSoh,
      kalmanFadePctPerYear,
      kalmanFadeStdevPctPerYear,
      kalmanYearsToEol,
      kalmanEolDate,
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
      coulombicEffPct,
      kalmanSmoothedSoh,
      kalmanFadePctPerYear,
      kalmanFadeStdevPctPerYear,
      kalmanYearsToEol,
      kalmanEolDate,
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
    coulombicEffPct,
    kalmanSmoothedSoh,
    kalmanFadePctPerYear,
    kalmanFadeStdevPctPerYear,
    kalmanYearsToEol,
    kalmanEolDate,
    summary: `SoH ${currentSoh.toFixed(1)}% fading ~${fadePctPerYear.toFixed(1)}%/yr — projected to reach the ${EOL_SOH}% end-of-life mark around ${new Date(eolDate).getFullYear()}, about ${round1(yearsToEol)} years out${rangeNote}.${arrheniusNote}`,
  });
}

let degradationCache: { ts: number; value: FleetDegradation } | null = null;

/** Per-pack capacity-fade → end-of-life projection, with fleet peer comparison.
 *  Cached ~30 min (the underlying SoH trend moves on a scale of weeks).
 *
 *  v0.9.50 — async so we can yield the event loop after every pack. Each
 *  `analysePack` issues a handful of synchronous `node:sqlite` queries that
 *  block the loop for tens of ms; across the user's ~20 packs the
 *  uninterrupted run starves other cache-warmer tasks (runway / RTE / HTTP
 *  handlers) running on the same turn. A `setImmediate` yield per pack lets
 *  those interleave, which is what the cache-warmer's `Promise.all` design
 *  actually wanted in the first place. */
export async function computeDegradation(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<FleetDegradation> {
  if (degradationCache && Date.now() - degradationCache.ts < DEGRADE_REPORT_TTL_MS) {
    return degradationCache.value;
  }
  const now = Date.now();
  const since = now - DEGRADE_REPORT_HISTORY_MS;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  // Pass 1 — regress and project every pack independently. Yield to the
  // event loop after each pack so concurrent work (other cache-warmer
  // tasks, HTTP handlers, the telnet draw loop) isn't starved while we
  // grind through the full fleet.
  const packs: PackDegradation[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      packs.push(analysePack(d, pk, recorder, since, now));
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  // Pass 2 — fleet peer comparison: which pack is wearing fast for its group.
  // Robust median + MAD, modified z-score — the same test the peer-anomaly
  // engine uses. Needs ≥3 packs with a real fade trend to form a peer group.
  //
  // v0.9.75 — restrict the peer-median baseline to SHP2-connected packs.
  // Spare cores (the operator's Cores 4 + 5) cycle very differently from the home-
  // serving cores: they may sit at storage SoC for months, charge once on
  // the bench, etc. Letting their fade rates into the baseline drags the
  // fleet median in the wrong direction and either suppresses legitimate
  // outlier flags (if spare's fade is high) or causes false-positive
  // flags on healthy connected packs (if spare's fade is low).
  //
  // Per-pack analysis (Pass 1 above) still runs for every pack including
  // spares — the operator still wants visibility into the spare hardware's
  // calendar fade. The only change is which packs DEFINE the baseline
  // that any single pack gets compared against.
  const connected = shp2ConnectedDpuSns(devices);
  const projecting = packs.filter(
    (p): p is PackDegradation & { fadePctPerYear: number } =>
      p.status === 'projecting' && p.fadePctPerYear != null,
  );
  const baselinePool = projecting.filter((p) => p.sn == null || isShp2Connected(p.sn, connected));
  if (baselinePool.length >= 3) {
    const rates = baselinePool.map((p) => p.fadePctPerYear);
    const med = median(rates);
    const m = mad(rates, med);
    // Tag outliers across ALL projecting packs (including spares) against
    // the connected-only baseline. That way a spare pack with abnormal
    // fade still shows up as peerOutlier=true — useful operator info even
    // though the spare isn't powering the home today.
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

  // v0.9.29 — query each metric ONCE for the full window instead of
  // windowDays separate per-day queries. Before this change, RTE made
  // (windowDays × dpus × packs × 2) = 280 SQL round-trips per cycle on a
  // typical fleet; now it makes (dpus × packs × 2) = 40 round-trips and
  // does the per-day bucketing in JS off the already-fetched bucket
  // points. `integrateWh` is happy to be called repeatedly on the same
  // input with different (sinceMs, untilMs) windows — it filters
  // internally and picks up the right "lastBefore" sample for each day,
  // which actually improves accuracy at day boundaries vs the old per-day
  // query path (where lastBefore couldn't see across the boundary).
  const fullStart = todayStart - (windowDays - 1) * 86_400_000;
  const fullEnd = now;
  // For each (sn, pack), pull in + out series once at 60 s bucketing.
  // batched queryMulti: one SQL call returns both metrics for the pack.
  // v0.9.76 — RTE is "the home's battery round-trip efficiency". Spare
  // cores cycle differently (storage SoC, bench top-ups) and contaminate
  // both numerator and discharge denominator. Pre-fix: 88.8 % live;
  // healthy band per the header comment is 95-97 %.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  const packSeries = new Map<string, { in: Array<{ ts: number; value: number }>; out: Array<{ ts: number; value: number }> }>();
  for (const d of homeDpus) {
    const metricsNeeded: string[] = [];
    for (const pk of d.projection.packs) {
      metricsNeeded.push(`pack${pk.num}_in`, `pack${pk.num}_out`);
    }
    const byMetric = recorder.queryMulti(d.sn, metricsNeeded, fullStart, fullEnd, 60);
    for (const pk of d.projection.packs) {
      packSeries.set(`${d.sn}|${pk.num}`, {
        in: byMetric.get(`pack${pk.num}_in`) ?? [],
        out: byMetric.get(`pack${pk.num}_out`) ?? [],
      });
    }
  }

  const perDay: RoundTripDay[] = [];
  let totalCharged = 0;
  let totalDischarged = 0;
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayStart = todayStart - i * 86_400_000;
    const dayEnd = i === 0 ? now : dayStart + 86_400_000;
    let chargedKwh = 0;
    let dischargedKwh = 0;
    for (const d of homeDpus) {
      for (const pk of d.projection.packs) {
        const s = packSeries.get(`${d.sn}|${pk.num}`);
        if (!s) continue;
        chargedKwh += integrateWh(s.in, dayStart, dayEnd).wh / 1000;
        dischargedKwh += integrateWh(s.out, dayStart, dayEnd).wh / 1000;
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

/* ===================================================================
 * Shade event detection (v0.7.5).
 *
 * The learned GHI→PV model says "this hour, with this much sun, the
 * array should produce X". A shaded panel doesn't break that — it
 * just contributes a recurring shortfall at the same hour-of-day,
 * every day, regardless of cloud cover. We scan clear-sky hours (low
 * cloud, real GHI) across history, compute predicted vs actual per
 * hour-of-day, and flag any hour whose median shortfall sits past a
 * threshold AND has accumulated over many days — that's a physical
 * obstruction, not weather variance.
 *
 * Cached 30 min. Fleet-level (combined PV) since per-DPU shade is the
 * province of computeStringMismatch.
 * =================================================================== */

const SHADE_TTL_MS = 30 * 60 * 1000;
const SHADE_MIN_CLEAR_DAYS = 5;
const SHADE_DROP_THRESHOLD = 0.18;   // ≥ 18% under model = "shaded"
const SHADE_OBSERVE_HISTORY_MS = 45 * 24 * 60 * 60 * 1000;

export interface ShadeHour {
  hour: number;             // 0-23 local
  observedW: number;        // median observed PV across clear-sky days
  expectedW: number;        // median predicted PV across the same days
  shortfallPct: number;     // (expected − observed) / expected × 100
  clearDays: number;        // distinct clear-sky days contributing
}

export interface ShadeReport {
  generatedAt: number;
  hours: ShadeHour[];
  estTotalKwhPerYear: number;  // rough annualised shortfall summed across shaded hours
}

let shadeCache: { ts: number; value: ShadeReport } | null = null;

export async function computeShadeReport(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<ShadeReport> {
  if (shadeCache && Date.now() - shadeCache.ts < SHADE_TTL_MS) return shadeCache.value;
  const now = Date.now();
  const since = now - SHADE_OBSERVE_HISTORY_MS;
  const empty = (): ShadeReport => ({ generatedAt: now, hours: [], estTotalKwhPerYear: 0 });

  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  if (dpus.length === 0) return empty();

  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHourEpoch = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHourEpoch.set(Math.floor(wh.ts / 3_600_000), wh);

  // Fleet hourly PV — v0.9.76 restricts to SHP2-connected DPUs. Shade
  // detection projects "annual kWh shortfall to the home"; including a
  // spare's bench-charge PV would either deflate the model (spare
  // reports 0 W → fleet under-shoots clear-sky) or inflate observed
  // (spare with panels → fleet over-reports baseline), both of which
  // throw off the shade-shortfall projection.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  const fleetPvByEpoch = new Map<number, number>();
  for (const d of homeDpus) {
    const pvE = pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now);
    for (const [he, pv] of pvE) fleetPvByEpoch.set(he, (fleetPvByEpoch.get(he) ?? 0) + pv);
  }

  // Per hour-of-day: collect (predicted, observed) pairs across clear-sky hours.
  const byHour: Array<Array<{ predicted: number; observed: number; day: string }>> =
    Array.from({ length: 24 }, () => []);
  // Build a quick GHI-keyed model: for each hour-of-day, the best (largest)
  // ratio of observed PV to GHI on a clear day = the "no-shade" reference.
  // We approximate predicted from the cleanest day's response.
  const clearByHour: Map<number, Array<{ coeff: number }>> = new Map();
  for (const [he, pv] of fleetPvByEpoch) {
    const wx = wxByHourEpoch.get(he);
    if (!wx || wx.cloudCoverPct > 20 || wx.radiationWm2 < 200) continue;
    const hod = new Date(he * 3_600_000).getHours();
    const arr = clearByHour.get(hod) ?? [];
    arr.push({ coeff: pv / wx.radiationWm2 });
    clearByHour.set(hod, arr);
  }
  const refCoeffByHour = new Map<number, number>();
  for (const [h, arr] of clearByHour) {
    if (arr.length < 3) continue;
    // 90th-percentile coeff = the "clean / unshaded" benchmark for this hour
    const sorted = arr.map((p) => p.coeff).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
    refCoeffByHour.set(h, p90);
  }

  for (const [he, pv] of fleetPvByEpoch) {
    const wx = wxByHourEpoch.get(he);
    if (!wx || wx.cloudCoverPct > 20 || wx.radiationWm2 < 200) continue;
    const hod = new Date(he * 3_600_000).getHours();
    const ref = refCoeffByHour.get(hod);
    if (ref == null) continue;
    const predicted = ref * wx.radiationWm2;
    const day = new Date(he * 3_600_000).toDateString();
    byHour[hod].push({ predicted, observed: pv, day });
  }

  const hours: ShadeHour[] = [];
  let annualKwhShortfall = 0;
  for (let h = 0; h < 24; h++) {
    const pairs = byHour[h];
    const days = new Set(pairs.map((p) => p.day));
    if (days.size < SHADE_MIN_CLEAR_DAYS) continue;
    const obsMed = median(pairs.map((p) => p.observed));
    const predMed = median(pairs.map((p) => p.predicted));
    if (predMed < 100) continue;
    const shortfall = (predMed - obsMed) / predMed;
    if (shortfall < SHADE_DROP_THRESHOLD) continue;
    hours.push({
      hour: h,
      observedW: Math.round(obsMed),
      expectedW: Math.round(predMed),
      shortfallPct: Math.round(shortfall * 1000) / 10,
      clearDays: days.size,
    });
    annualKwhShortfall += ((predMed - obsMed) / 1000) * 365;
  }

  const value: ShadeReport = {
    generatedAt: now,
    hours,
    estTotalKwhPerYear: Math.round(annualKwhShortfall),
  };
  shadeCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Soiling decomposition (v0.7.5) — extends the fleet-wide soiling
 * estimate with a per-DPU breakdown and a per-hour shape. Lets the
 * user answer "do I wash everything, or just the east-facing run?"
 * Cached 30 min.
 * =================================================================== */

const SOILING_DECOMP_TTL_MS = 30 * 60 * 1000;

export interface SoilingPerDevice {
  sn: string;
  device: string;
  coreNum: number | null;
  dropPct: number | null;
  cleanDays: number;
  recentCoeff: number | null;
  baselineCoeff: number | null;
}

export interface SoilingDecomposition {
  generatedAt: number;
  perDevice: SoilingPerDevice[];
  perHour: Array<{ hour: number; dropPct: number; samples: number }>;
}

let soilingDecompCache: { ts: number; value: SoilingDecomposition } | null = null;

export async function computeSoilingDecomposition(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<SoilingDecomposition> {
  if (soilingDecompCache && Date.now() - soilingDecompCache.ts < SOILING_DECOMP_TTL_MS) {
    return soilingDecompCache.value;
  }
  const now = Date.now();
  const since = now - 60 * 24 * 60 * 60 * 1000;
  const empty = (): SoilingDecomposition => ({ generatedAt: now, perDevice: [], perHour: [] });
  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHour = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHour.set(Math.floor(wh.ts / 3_600_000), wh);

  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  const perDevice: SoilingPerDevice[] = [];
  for (const d of dpus) {
    const pvE = pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now);
    const est = computeSoiling(pvE, wxByHour);
    perDevice.push({
      sn: d.sn,
      device: d.deviceName,
      coreNum: dpuNum(d.deviceName),
      dropPct: est?.dropPct ?? null,
      cleanDays: est?.cleanDays ?? 0,
      recentCoeff: est?.recentCoeff != null ? round2(est.recentCoeff) : null,
      baselineCoeff: est?.baselineCoeff != null ? round2(est.baselineCoeff) : null,
    });
  }

  // Per-hour shape — fleet-level, similar logic but bucketed by hour-of-day.
  // v0.9.76 — `perDevice` above keeps every DPU (spare-array diagnostics).
  // `perHour` is fleet-level and only home-connected DPUs should contribute.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  const fleetPvE = new Map<number, number>();
  for (const d of homeDpus) {
    const pvE = pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now);
    for (const [he, pv] of pvE) fleetPvE.set(he, (fleetPvE.get(he) ?? 0) + pv);
  }
  const recentMs = 7 * 24 * 60 * 60 * 1000;
  const byHour: Array<{ baseline: number[]; recent: number[] }> =
    Array.from({ length: 24 }, () => ({ baseline: [], recent: [] }));
  for (const [he, pv] of fleetPvE) {
    const wx = wxByHour.get(he);
    if (!wx || wx.cloudCoverPct > 25 || wx.radiationWm2 < 250) continue;
    const coeff = pv / wx.radiationWm2;
    if (!Number.isFinite(coeff) || coeff <= 0) continue;
    const ts = he * 3_600_000;
    const hod = new Date(ts).getHours();
    if (ts >= now - recentMs) byHour[hod].recent.push(coeff);
    else byHour[hod].baseline.push(coeff);
  }
  const perHour = [];
  for (let h = 0; h < 24; h++) {
    const { baseline, recent } = byHour[h];
    if (baseline.length < 3 || recent.length < 1) continue;
    const base = Math.max(...baseline);
    const rec = median(recent);
    const drop = base > 0 ? ((base - rec) / base) * 100 : 0;
    perHour.push({
      hour: h,
      dropPct: Math.round(drop * 10) / 10,
      samples: baseline.length + recent.length,
    });
  }

  const value: SoilingDecomposition = { generatedAt: now, perDevice, perHour };
  if (dpus.length > 0) soilingDecompCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * String mismatch / per-DPU underperformance (v0.7.5).
 *
 * Same robust median+MAD test as the peer-anomaly engine, but applied
 * to per-DPU PV output relative to the fleet median at the same
 * hour-of-day. A persistently low DPU is either a shaded panel, a
 * failed optimizer, or string mismatch — all worth surfacing.
 * Cached 15 min.
 * =================================================================== */

const STRING_MISMATCH_TTL_MS = 15 * 60 * 1000;

export interface DeviceProductionRatio {
  sn: string;
  device: string;
  coreNum: number | null;
  recentMedianW: number | null;
  fleetMedianW: number | null;
  ratio: number | null;          // device / fleet
  modifiedZ: number | null;
  outlier: boolean;
  samples: number;
}

export interface StringMismatchReport {
  generatedAt: number;
  devices: DeviceProductionRatio[];
}

let stringMismatchCache: { ts: number; value: StringMismatchReport } | null = null;

export function computeStringMismatch(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): StringMismatchReport {
  if (stringMismatchCache && Date.now() - stringMismatchCache.ts < STRING_MISMATCH_TTL_MS) {
    return stringMismatchCache.value;
  }
  const now = Date.now();
  const since = now - 14 * 24 * 60 * 60 * 1000;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  // Per-DPU per-hour median PV. v0.9.29 — 5-min SQL bucketing. We're
  // already taking the per-hour median across many samples; the 5-min
  // bucket pre-averaging doesn't change the distribution's median in any
  // meaningful way (each pre-averaged bucket carries 30+ raw samples on
  // a typical 10 s sample interval). Drops the per-metric rowcount on a
  // 14-day window by ~30× — from ~100 k raw rows per DPU to ~4 k bucketed,
  // and from 4 × 100 k JS objects materialized per cycle to 4 × 4 k.
  // v0.9.76 — string-mismatch baseline (fleet hourly median) uses only
  // SHP2-connected DPUs. Same pattern as v0.9.75's computeDegradation
  // peer-baseline fix: a spare's odd PV profile (storage trickle,
  // bench charge from a different panel angle) was structurally able
  // to bias the median that connected Cores are compared against.
  // Today's spares report 0 W (no panels), so the `meds[h] > 0` guard
  // accidentally filtered them out — fix is now explicit + defensive
  // against future spare configurations.
  const connected = shp2ConnectedDpuSns(devices);
  const perDevicePerHour = new Map<string, number[]>(); // sn → 24-bucket medians (averaged)
  const fleetPerHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const d of dpus) {
    const buckets: number[][] = Array.from({ length: 24 }, () => []);
    for (const p of recorder.query(d.sn, 'pv_total', since, now, 300)) {
      // Only consider daytime samples — night samples are zero and would skew the median.
      const h = new Date(p.ts).getHours();
      if (p.value < 100) continue;
      buckets[h].push(p.value);
    }
    const meds = buckets.map((b) => (b.length ? median(b) : 0));
    perDevicePerHour.set(d.sn, meds);
    // Only home-connected DPUs build the fleet-median baseline; spare
    // DPUs still get evaluated against that baseline below (so a spare
    // with anomalously different output still surfaces as an outlier
    // — mirroring computeDegradation's v0.9.75 pattern).
    if (isShp2Connected(d.sn, connected)) {
      for (let h = 0; h < 24; h++) if (meds[h] > 0) fleetPerHour[h].push(meds[h]);
    }
  }

  // For each device, compute the ratio of its hourly median to the fleet median
  // for the same hour, then average across daytime hours.
  const ratios: DeviceProductionRatio[] = [];
  const deviceAvgRatios: number[] = [];
  for (const d of dpus) {
    const meds = perDevicePerHour.get(d.sn) ?? [];
    const ratioSamples: number[] = [];
    let deviceMedW = 0, fleetMedW = 0, hoursWithFleet = 0;
    for (let h = 0; h < 24; h++) {
      if (meds[h] <= 0 || fleetPerHour[h].length < 2) continue;
      const fleetMed = median(fleetPerHour[h]);
      if (fleetMed <= 0) continue;
      ratioSamples.push(meds[h] / fleetMed);
      deviceMedW += meds[h]; fleetMedW += fleetMed; hoursWithFleet++;
    }
    const ratio = ratioSamples.length ? median(ratioSamples) : null;
    ratios.push({
      sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
      recentMedianW: hoursWithFleet > 0 ? Math.round(deviceMedW / hoursWithFleet) : null,
      fleetMedianW: hoursWithFleet > 0 ? Math.round(fleetMedW / hoursWithFleet) : null,
      ratio: ratio != null ? round2(ratio) : null,
      modifiedZ: null, outlier: false,
      samples: ratioSamples.length,
    });
    if (ratio != null) deviceAvgRatios.push(ratio);
  }
  if (deviceAvgRatios.length >= 3) {
    const med = median(deviceAvgRatios);
    const m = mad(deviceAvgRatios, med);
    for (const r of ratios) {
      if (r.ratio == null) continue;
      const z = m > 0 ? Math.abs((0.6745 * (r.ratio - med)) / m) : 0;
      r.modifiedZ = round2(z);
      if (r.ratio < med && z >= Z_INFO) r.outlier = true;
    }
  }
  const value: StringMismatchReport = { generatedAt: now, devices: ratios };
  if (dpus.length > 0) stringMismatchCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * EV-charging window prediction (v0.7.5).
 *
 * Scans SHP2 paired-circuit history for recurring high-power sessions
 * — "the EVSE pulls ~7 kW for ~2 h every Tuesday evening". Looks for
 * sustained periods above a power floor, buckets by weekday + start-
 * hour, requires N recurrences over the window before reporting.
 * Output is consumed by getDayForecast to lift tomorrow's load curve
 * during predicted EV charging windows. Cached 1 h.
 * =================================================================== */

const EV_WINDOW_TTL_MS = 60 * 60 * 1000;
const EV_WINDOW_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const EV_WINDOW_MIN_WATTS = 2000;     // above this counts as a "charging" sample
const EV_WINDOW_MIN_DURATION_MS = 30 * 60 * 1000; // sustained ≥ 30 min
const EV_WINDOW_MIN_RECURRENCES = 3;  // need ≥3 weeks of the same pattern

interface EvSessionRaw {
  startTs: number;
  endTs: number;
  avgWatts: number;
  energyKwh: number;
}

export interface EvSessionPattern {
  sn: string;
  circuit: number;
  dayOfWeek: number;        // 0=Sun
  startHour: number;
  typicalDurationHours: number;
  typicalWatts: number;
  recurrences: number;
  energyKwh: number;        // typical per-session
}

export interface EvWindowPrediction {
  generatedAt: number;
  sessionsObserved: number;
  patterns: EvSessionPattern[];
  upcomingNext24h: Array<{ ts: number; durationHours: number; watts: number; dayOfWeek: number }>;
}

let evWindowCache: { ts: number; value: EvWindowPrediction } | null = null;

function extractEvSessions(points: Array<{ ts: number; value: number }>): EvSessionRaw[] {
  if (points.length < 2) return [];
  const out: EvSessionRaw[] = [];
  let inSession = false;
  let sessStart = 0;
  let sessLastTs = 0;
  let energyWhAcc = 0;
  let wattsAcc = 0;
  let wattsCount = 0;
  let prevTs: number | null = null;
  let prevW: number | null = null;
  for (const p of points) {
    if (p.value >= EV_WINDOW_MIN_WATTS) {
      if (!inSession) {
        inSession = true;
        sessStart = p.ts;
        energyWhAcc = 0;
        wattsAcc = 0;
        wattsCount = 0;
      }
      if (prevTs != null && prevW != null) {
        const dtH = (p.ts - prevTs) / 3_600_000;
        energyWhAcc += ((prevW + p.value) / 2) * dtH;
      }
      wattsAcc += p.value;
      wattsCount++;
      sessLastTs = p.ts;
    } else if (inSession) {
      // End of a session — accept only if it ran long enough.
      if (sessLastTs - sessStart >= EV_WINDOW_MIN_DURATION_MS) {
        out.push({
          startTs: sessStart,
          endTs: sessLastTs,
          avgWatts: wattsCount > 0 ? wattsAcc / wattsCount : 0,
          energyKwh: energyWhAcc / 1000,
        });
      }
      inSession = false;
    }
    prevTs = p.ts;
    prevW = p.value;
  }
  if (inSession && sessLastTs - sessStart >= EV_WINDOW_MIN_DURATION_MS) {
    out.push({
      startTs: sessStart,
      endTs: sessLastTs,
      avgWatts: wattsCount > 0 ? wattsAcc / wattsCount : 0,
      energyKwh: energyWhAcc / 1000,
    });
  }
  return out;
}

export function computeEvWindowPrediction(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): EvWindowPrediction {
  if (evWindowCache && Date.now() - evWindowCache.ts < EV_WINDOW_TTL_MS) return evWindowCache.value;
  const now = Date.now();
  const since = now - EV_WINDOW_HISTORY_MS;

  const sessions: Array<EvSessionRaw & { sn: string; circuit: number }> = [];
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  if (shp2) {
    for (const pc of shp2.projection.pairedCircuits) {
      const pts = recorder.query(shp2.sn, `pair${pc.primaryCh}_w`, since, now);
      for (const s of extractEvSessions(pts)) {
        sessions.push({ ...s, sn: shp2.sn, circuit: pc.primaryCh });
      }
    }
  }

  // Bucket by (sn, circuit, dayOfWeek, startHour) and count recurrences.
  //
  // v0.9.62 fix (audit finding from v0.9.61): real-world EV start times
  // jitter ±10-20 min around the user's habitual time. The previous
  // implementation used `d.getHours()` directly, so sessions at 17:55 and
  // 18:05 landed in different hour buckets — neither reached the
  // EV_WINDOW_MIN_RECURRENCES=3 threshold and no pattern was emitted.
  //
  // Fix: round the start time to the nearest hour boundary
  // (minutes >= 30 ⇒ +1 hour, else current hour). Exactly :30 rounds UP to
  // the next hour, matching standard "round half up" semantics. When the
  // rounding pushes past 23:59, dayOfWeek advances too (handled by feeding
  // the rounded timestamp back through Date).
  const groups = new Map<string, { records: typeof sessions; }>();
  for (const s of sessions) {
    const d = new Date(s.startTs);
    const roundedHourBoundaryMs = s.startTs + (d.getMinutes() >= 30 ? 1 : 0) * 3_600_000;
    const rd = new Date(roundedHourBoundaryMs);
    const key = `${s.sn}|${s.circuit}|${rd.getDay()}|${rd.getHours()}`;
    const g = groups.get(key) ?? { records: [] };
    g.records.push(s);
    groups.set(key, g);
  }
  const patterns: EvSessionPattern[] = [];
  for (const [key, g] of groups) {
    if (g.records.length < EV_WINDOW_MIN_RECURRENCES) continue;
    const [sn, chS, dowS, hrS] = key.split('|');
    const durHours = median(g.records.map((r) => (r.endTs - r.startTs) / 3_600_000));
    const watts = median(g.records.map((r) => r.avgWatts));
    const kwh = median(g.records.map((r) => r.energyKwh));
    patterns.push({
      sn,
      circuit: Number(chS),
      dayOfWeek: Number(dowS),
      startHour: Number(hrS),
      typicalDurationHours: round1(durHours),
      typicalWatts: Math.round(watts),
      recurrences: g.records.length,
      energyKwh: round1(kwh),
    });
  }

  // Project forward 24 h: any pattern whose (DoW, hour) falls in the window
  // becomes an upcoming session.
  const upcoming: EvWindowPrediction['upcomingNext24h'] = [];
  for (let h = 0; h < 24; h++) {
    const ts = now + h * 3_600_000;
    const d = new Date(ts);
    const dow = d.getDay();
    const hr = d.getHours();
    for (const p of patterns) {
      if (p.dayOfWeek === dow && p.startHour === hr) {
        upcoming.push({ ts, durationHours: p.typicalDurationHours, watts: p.typicalWatts, dayOfWeek: dow });
      }
    }
  }

  const value: EvWindowPrediction = {
    generatedAt: now,
    sessionsObserved: sessions.length,
    patterns,
    upcomingNext24h: upcoming,
  };
  evWindowCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Charge-curve fingerprinting (v0.7.5).
 *
 * During a full-charge cycle the pack voltage rises through a
 * characteristic V-vs-SoC plateau shape. The plateau drifts as the
 * cells age — often visible months before SoH does. We record the
 * voltage at SoC checkpoints (40 / 60 / 80 / 95 %) on every full
 * charge and compare today's most-recent fingerprints against a
 * "fresh" baseline laid down in the earliest weeks of recording.
 *
 * Cached 1 h.
 * =================================================================== */

const CHARGE_CURVE_TTL_MS = 60 * 60 * 1000;
const CHARGE_CURVE_HISTORY_MS = 200 * 24 * 60 * 60 * 1000;
const CHARGE_CHECKPOINTS = [40, 60, 80, 95];
const CHARGE_CHECKPOINT_TOLERANCE_PCT = 1.5; // record V whenever SoC is within ±this of a checkpoint
const CHARGE_BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // first 14 days = baseline

export interface ChargeCurvePack {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  checkpoints: Array<{
    soc: number;
    baselineV: number | null;
    recentV: number | null;
    driftMv: number | null;       // (recent − baseline) × 1000
    baselineSamples: number;
    recentSamples: number;
  }>;
  // Mean absolute drift across checkpoints — single-number summary
  meanDriftMv: number | null;
  status: 'baseline' | 'tracking' | 'no-data';
}

export interface ChargeCurveReport {
  generatedAt: number;
  packs: ChargeCurvePack[];
}

let chargeCurveCache: { ts: number; value: ChargeCurveReport } | null = null;

export function computeChargeCurveFingerprint(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): ChargeCurveReport {
  if (chargeCurveCache && Date.now() - chargeCurveCache.ts < CHARGE_CURVE_TTL_MS) return chargeCurveCache.value;
  const now = Date.now();
  const since = now - CHARGE_CURVE_HISTORY_MS;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  const packs: ChargeCurvePack[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      const socPts = recorder.query(d.sn, `pack${pk.num}_soc`, since, now);
      const vMaxPts = recorder.query(d.sn, `pack${pk.num}_vol_max_mv`, since, now);
      const inPts = recorder.query(d.sn, `pack${pk.num}_in`, since, now);
      if (socPts.length < 50 || vMaxPts.length < 50) {
        packs.push({
          sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), packNum: pk.num,
          checkpoints: CHARGE_CHECKPOINTS.map((soc) => ({
            soc, baselineV: null, recentV: null, driftMv: null,
            baselineSamples: 0, recentSamples: 0,
          })),
          meanDriftMv: null, status: 'no-data',
        });
        continue;
      }
      // Snap V and IN to nearest SoC sample.
      let vi = 0, ii = 0;
      const enriched: Array<{ ts: number; soc: number; vMv: number; inW: number }> = [];
      for (const s of socPts) {
        while (vi + 1 < vMaxPts.length && Math.abs(vMaxPts[vi + 1].ts - s.ts) < Math.abs(vMaxPts[vi].ts - s.ts)) vi++;
        while (ii + 1 < inPts.length && Math.abs(inPts[ii + 1].ts - s.ts) < Math.abs(inPts[ii].ts - s.ts)) ii++;
        const v = vMaxPts[vi];
        const i = inPts[ii];
        if (!v) continue;
        enriched.push({ ts: s.ts, soc: s.value, vMv: v.value, inW: i?.value ?? 0 });
      }
      // For each checkpoint, collect baseline (first window) and recent (last 14d) V samples
      // taken DURING ACTIVE CHARGE (inW > 100 to avoid resting voltage).
      const baselineCutoff = since + CHARGE_BASELINE_WINDOW_MS;
      const recentCutoff = now - 14 * 24 * 60 * 60 * 1000;
      const checkpointResults = CHARGE_CHECKPOINTS.map((target) => {
        const baseline: number[] = [];
        const recent: number[] = [];
        for (const e of enriched) {
          if (Math.abs(e.soc - target) > CHARGE_CHECKPOINT_TOLERANCE_PCT) continue;
          if (e.inW < 100) continue;
          if (e.ts <= baselineCutoff) baseline.push(e.vMv);
          else if (e.ts >= recentCutoff) recent.push(e.vMv);
        }
        const baselineV = baseline.length >= 3 ? median(baseline) : null;
        const recentV = recent.length >= 3 ? median(recent) : null;
        const driftMv = baselineV != null && recentV != null
          ? Math.round((recentV - baselineV))
          : null;
        return {
          soc: target,
          baselineV: baselineV != null ? Math.round(baselineV) : null,
          recentV: recentV != null ? Math.round(recentV) : null,
          driftMv,
          baselineSamples: baseline.length,
          recentSamples: recent.length,
        };
      });
      const drifts = checkpointResults.map((c) => c.driftMv).filter((d): d is number => d != null);
      const meanDriftMv = drifts.length
        ? Math.round(drifts.reduce((s, v) => s + Math.abs(v), 0) / drifts.length)
        : null;
      const status: ChargeCurvePack['status'] =
        meanDriftMv != null ? 'tracking' : checkpointResults.some((c) => c.baselineSamples >= 3) ? 'baseline' : 'no-data';
      packs.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), packNum: pk.num,
        checkpoints: checkpointResults,
        meanDriftMv,
        status,
      });
    }
  }
  const value: ChargeCurveReport = { generatedAt: now, packs };
  if (dpus.length > 0) chargeCurveCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Internal-resistance trending (v0.7.5).
 *
 * dV/dI ≈ effective internal resistance. Take pairs of (V, I) samples
 * spaced ≤ 60 s apart with a meaningful ΔI; the slope is the pack's
 * effective resistance. Aggregate to a per-pack milliohm number, trend
 * over time. Rising R precedes SoH decay by months on LFP.
 *
 * Pack voltage isn't recorded today (pack-voltage is the SHP2-bus
 * voltage at the inverter), so we derive R at the inverter-bus level:
 * use the DPU's `bat_vol` and `bat_amp` series. That gives ONE R per
 * DPU — not per pack — but it's a real, rising-R signal.
 *
 * Cached 30 min.
 * =================================================================== */

const IR_TTL_MS = 30 * 60 * 1000;
const IR_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const IR_DELTA_I_MIN_A = 5;     // require ≥ 5 A change for a clean dV/dI
const IR_DELTA_T_MAX_MS = 60_000;
// v0.9.59 — steady-state windowing. A clean dV/dI sample needs the bus to be
// in a quiet operating point on BOTH sides of the step — otherwise we're
// measuring a transient (motor inrush, MPPT chase after a cloud, inverter
// load-step) and the "resistance" we compute is dominated by the slew
// dynamics, not the pack's actual cell + interconnect Ohmic loss.
//
// Heuristic: for each candidate (V,A) pair (i, i+1), scan all samples within
// the prior 5 s ending at i and the following 5 s starting at i+1. If any
// consecutive |dA|/Δt within either window exceeds IR_STEADY_DIDT_MAX_A_PER_S,
// reject the pair as transient. This filters out the very class of step
// events that contaminate the trend most badly (a 30-day median is robust
// against a single outlier but a single noisy day still walks the line).
const IR_STEADY_WINDOW_MS = 5_000;
const IR_STEADY_DIDT_MAX_A_PER_S = 1;
// Tightened sanity band: > 100 mΩ is a failed pack (not a measurement worth
// median-aging into the trend); < 2 mΩ is below the resolution of the
// inverter-bus dV/dI signal. Was [1, 500] mΩ — let through bus-noise.
const IR_R_MIN_MILLI = 2;
const IR_R_MAX_MILLI = 100;

export interface InternalResistanceDevice {
  sn: string;
  device: string;
  coreNum: number | null;
  recentMilliohms: number | null;
  baselineMilliohms: number | null;
  trendMilliohmsPerMonth: number | null;
  samples: number;
  status: 'tracking' | 'learning' | 'no-data';
}

export interface InternalResistanceReport {
  generatedAt: number;
  devices: InternalResistanceDevice[];
}

let irCache: { ts: number; value: InternalResistanceReport } | null = null;

export function computeInternalResistance(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): InternalResistanceReport {
  if (irCache && Date.now() - irCache.ts < IR_TTL_MS) return irCache.value;
  const now = Date.now();
  const since = now - IR_HISTORY_MS;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  const out: InternalResistanceDevice[] = [];
  for (const d of dpus) {
    const vPts = recorder.query(d.sn, 'bat_vol', since, now);
    const aPts = recorder.query(d.sn, 'bat_amp', since, now);
    if (vPts.length < 30 || aPts.length < 30) {
      out.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
        recentMilliohms: null, baselineMilliohms: null, trendMilliohmsPerMonth: null,
        samples: 0, status: 'no-data',
      });
      continue;
    }
    // Snap V and A on common timestamps.
    let ai = 0;
    const series: Array<{ ts: number; v: number; a: number }> = [];
    for (const v of vPts) {
      while (ai + 1 < aPts.length && Math.abs(aPts[ai + 1].ts - v.ts) < Math.abs(aPts[ai].ts - v.ts)) ai++;
      const a = aPts[ai];
      if (!a) continue;
      if (Math.abs(a.ts - v.ts) > 30_000) continue;
      series.push({ ts: v.ts, v: v.value, a: a.value });
    }
    // v0.9.59 — steady-state check. Walks from the anchor sample backwards
    // (or forwards) collecting consecutive snaps within `windowMs` and
    // verifies every adjacent |dA|/Δt under the slew bound. Returns false
    // if any pair in the window busts the bound (i.e. the bus was moving).
    // Empty windows count as steady (rare edge case at series ends — better
    // to keep the sample than discard at endpoints).
    const steadyOn = (anchorIdx: number, direction: -1 | 1): boolean => {
      const anchorTs = series[anchorIdx].ts;
      let j = anchorIdx;
      let prev = series[anchorIdx];
      while (true) {
        const next = series[j + direction];
        if (!next) return true;                // ran off the end → call it steady
        if (Math.abs(next.ts - anchorTs) > IR_STEADY_WINDOW_MS) return true; // out of window
        const dtSec = Math.abs(next.ts - prev.ts) / 1000;
        if (dtSec > 0) {
          const slew = Math.abs(next.a - prev.a) / dtSec;
          if (slew >= IR_STEADY_DIDT_MAX_A_PER_S) return false;
        }
        prev = next;
        j += direction;
      }
    };
    // Pairs with significant ΔI: ΔV / ΔI = R (volts / amps). Convert to mΩ.
    const rSamples: Array<{ ts: number; rMilli: number }> = [];
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1];
      const b = series[i];
      if (b.ts - a.ts > IR_DELTA_T_MAX_MS) continue;
      const dI = b.a - a.a;
      if (Math.abs(dI) < IR_DELTA_I_MIN_A) continue;
      // v0.9.59 — reject pairs where either endpoint sits inside a transient.
      // The whole point of this filter is that a 5 A step is a real IR signal
      // only if the bus was quiet before AND after — otherwise we're aging
      // inverter dynamics into our resistance trend.
      if (!steadyOn(i - 1, -1)) continue;
      if (!steadyOn(i, +1)) continue;
      const dV = b.v - a.v;
      const r = (dV / dI) * 1000; // mΩ
      if (!Number.isFinite(r)) continue;
      // R must be positive (V drops as current draw rises) and within a sane LFP band.
      const rAbs = Math.abs(r);
      if (rAbs < IR_R_MIN_MILLI || rAbs > IR_R_MAX_MILLI) continue;
      rSamples.push({ ts: b.ts, rMilli: rAbs });
    }
    if (rSamples.length < 10) {
      out.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
        recentMilliohms: null, baselineMilliohms: null, trendMilliohmsPerMonth: null,
        samples: rSamples.length, status: 'learning',
      });
      continue;
    }
    const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const recent = rSamples.filter((p) => p.ts >= recentCutoff).map((p) => p.rMilli);
    const baseline = rSamples.slice(0, Math.max(10, Math.floor(rSamples.length * 0.3))).map((p) => p.rMilli);
    const fit = linregress(rSamples.map((p) => ({ ts: p.ts, value: p.rMilli })));
    out.push({
      sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
      recentMilliohms: recent.length ? round2(median(recent)) : null,
      baselineMilliohms: baseline.length ? round2(median(baseline)) : null,
      trendMilliohmsPerMonth: fit ? round2(fit.slopePerMs * 30 * 86_400_000) : null,
      samples: rSamples.length, status: 'tracking',
    });
  }
  const value: InternalResistanceReport = { generatedAt: now, devices: out };
  if (dpus.length > 0) irCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Forecast-skill calibration (v0.7.5).
 *
 * We never actually persisted yesterday's forecast, but the learned
 * solarModel coefficient × historical GHI IS a hindcast — apply the
 * model to the past 7 days of GHI to derive "what the model would
 * have predicted" and compare with what actually happened. Reports
 * mean absolute error, bias, and per-day breakdown — and exposes a
 * bias factor (sum(actual) / sum(predicted)) that callers can apply
 * to today's forecast as a correction.
 *
 * Cached 1 h.
 * =================================================================== */

const FORECAST_SKILL_TTL_MS = 60 * 60 * 1000;

export interface ForecastSkillDay {
  date: string;
  predictedKwh: number;
  actualKwh: number;
  errorKwh: number;
  errorPct: number | null;
}

export interface ForecastSkillReport {
  generatedAt: number;
  days: ForecastSkillDay[];
  meanAbsErrorKwh: number | null;
  meanAbsErrorPct: number | null;
  biasFactor: number | null;       // sum(actual) / sum(predicted), or null if predicted ≈ 0
  windowDays: number;
}

let forecastSkillCache: { ts: number; value: ForecastSkillReport } | null = null;

export async function computeForecastSkill(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  forecast: DayForecast | null,
  windowDays = 7,
): Promise<ForecastSkillReport> {
  if (forecastSkillCache && Date.now() - forecastSkillCache.ts < FORECAST_SKILL_TTL_MS) return forecastSkillCache.value;
  const now = Date.now();
  const emptyVal = (): ForecastSkillReport => ({
    generatedAt: now, days: [], meanAbsErrorKwh: null, meanAbsErrorPct: null,
    biasFactor: null, windowDays,
  });
  if (!forecast) return emptyVal();
  const weather = await getWeather();
  if (!weather) return emptyVal();
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  if (dpus.length === 0) return emptyVal();

  // Hindcast: model.coeff[h] × GHI(h) for each past hour → predicted W.
  // Integrate hourly across each past day. Compare with actual hourly PV avg.
  const wxByHourEpoch = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHourEpoch.set(Math.floor(wh.ts / 3_600_000), wh);

  const todayStart = startOfLocalDayMs();
  const days: ForecastSkillDay[] = [];
  let totalPred = 0, totalAct = 0, errSum = 0, errCount = 0;
  for (let i = windowDays; i >= 1; i--) {
    const dayStart = todayStart - i * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    let predWh = 0, actWh = 0;
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * 3_600_000;
      const he = Math.floor(hourStart / 3_600_000);
      const wx = wxByHourEpoch.get(he);
      const hod = new Date(hourStart).getHours();
      const resp = forecast.solarModel.hourly[hod];
      if (wx && resp.coeff != null) predWh += resp.coeff * wx.radiationWm2;
      let act = 0;
      for (const d of dpus) {
        const pts = recorder.query(d.sn, 'pv_total', hourStart, hourStart + 3_600_000);
        if (pts.length === 0) continue;
        act += pts.reduce((s, p) => s + p.value, 0) / pts.length;
      }
      actWh += act;
    }
    const predKwh = predWh / 1000;
    const actKwh = actWh / 1000;
    const errKwh = predKwh - actKwh;
    const errPct = actKwh > 0.5 ? Math.round((errKwh / actKwh) * 1000) / 10 : null;
    const date = new Date(dayStart);
    days.push({
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      predictedKwh: round2(predKwh),
      actualKwh: round2(actKwh),
      errorKwh: round2(errKwh),
      errorPct: errPct,
    });
    if (predKwh > 0.5 && actKwh > 0.5) {
      totalPred += predKwh; totalAct += actKwh;
      errSum += Math.abs(errKwh); errCount++;
    }
  }
  const mae = errCount > 0 ? errSum / errCount : null;
  const meanActual = errCount > 0 ? totalAct / errCount : 0;
  const value: ForecastSkillReport = {
    generatedAt: now, days,
    meanAbsErrorKwh: mae != null ? round2(mae) : null,
    meanAbsErrorPct: mae != null && meanActual > 0.5 ? Math.round((mae / meanActual) * 1000) / 10 : null,
    biasFactor: totalPred > 0.5 ? round2(totalAct / totalPred) : null,
    windowDays,
  };
  if (dpus.length > 0) forecastSkillCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Ambient-coupled thermal forecast (v0.7.5).
 *
 * Pack temperature drives degradation. It follows ambient temp +
 * heat-dissipation from charging/discharging. Regress per-pack temp
 * against (outdoor temp, recent load) → predict peak pack temp for
 * the next 24 h. Outdoor temp comes from Open-Meteo's hourly
 * tempC forecast. Cached 1 h.
 * =================================================================== */

const AMBIENT_THERMAL_TTL_MS = 60 * 60 * 1000;
const AMBIENT_THERMAL_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const AMBIENT_THERMAL_MIN_PAIRS = 30;

export interface AmbientThermalPack {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  ambientCoeff: number | null;     // °C pack per °C ambient
  loadCoeff: number | null;        // °C pack per kW load
  intercept: number | null;
  r2: number | null;
  samples: number;
  predictedPeak24hC: number | null;
  predictedPeakAtMs: number | null;
}

export interface AmbientThermalReport {
  generatedAt: number;
  packs: AmbientThermalPack[];
}

let ambientThermalCache: { ts: number; value: AmbientThermalReport } | null = null;

/** Two-variable least-squares: y = β0 + β1·x1 + β2·x2. Returns null on near-singular. */
function lstsq2(rows: Array<{ x1: number; x2: number; y: number }>): { b0: number; b1: number; b2: number; r2: number } | null {
  const n = rows.length;
  if (n < AMBIENT_THERMAL_MIN_PAIRS) return null;
  let sx1 = 0, sx2 = 0, sy = 0, sx1x1 = 0, sx2x2 = 0, sx1x2 = 0, sx1y = 0, sx2y = 0;
  for (const r of rows) {
    sx1 += r.x1; sx2 += r.x2; sy += r.y;
    sx1x1 += r.x1 * r.x1; sx2x2 += r.x2 * r.x2; sx1x2 += r.x1 * r.x2;
    sx1y += r.x1 * r.y; sx2y += r.x2 * r.y;
  }
  // Normal equations: [n sx1 sx2; sx1 sx1x1 sx1x2; sx2 sx1x2 sx2x2] · β = [sy; sx1y; sx2y]
  const A = [
    [n, sx1, sx2],
    [sx1, sx1x1, sx1x2],
    [sx2, sx1x2, sx2x2],
  ];
  const b = [sy, sx1y, sx2y];
  // Gaussian elimination, 3×3.
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[pivot][i])) pivot = j;
    if (Math.abs(A[pivot][i]) < 1e-9) return null;
    if (pivot !== i) { [A[i], A[pivot]] = [A[pivot], A[i]]; [b[i], b[pivot]] = [b[pivot], b[i]]; }
    for (let j = i + 1; j < 3; j++) {
      const f = A[j][i] / A[i][i];
      for (let k = i; k < 3; k++) A[j][k] -= f * A[i][k];
      b[j] -= f * b[i];
    }
  }
  const beta = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < 3; j++) s -= A[i][j] * beta[j];
    beta[i] = s / A[i][i];
  }
  // Compute r²
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const r of rows) {
    const yHat = beta[0] + beta[1] * r.x1 + beta[2] * r.x2;
    ssTot += (r.y - yMean) ** 2;
    ssRes += (r.y - yHat) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { b0: beta[0], b1: beta[1], b2: beta[2], r2 };
}

export async function computeAmbientThermalForecast(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<AmbientThermalReport> {
  if (ambientThermalCache && Date.now() - ambientThermalCache.ts < AMBIENT_THERMAL_TTL_MS) return ambientThermalCache.value;
  const now = Date.now();
  const since = now - AMBIENT_THERMAL_HISTORY_MS;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  const empty = (): AmbientThermalReport => ({ generatedAt: now, packs: [] });
  if (dpus.length === 0) return empty();

  const weather = await getWeather();
  if (!weather) return empty();
  const ambientByHe = new Map<number, number>();
  for (const wh of weather.hours) ambientByHe.set(Math.floor(wh.ts / 3_600_000), wh.tempC);

  const packs: AmbientThermalPack[] = [];
  // v0.9.14 — every consumer of these arrays just buckets to the hour anyway
  // (`Math.floor(p.ts / 3_600_000)`), so we let SQLite do the hour-bucket
  // averaging directly. AMBIENT_THERMAL_HISTORY_MS is 7 days → 168 rows per
  // metric instead of 60 k+. The pack_temp loop below uses the same bucket.
  const HOUR_BUCKET_SEC = 3600;
  for (const d of dpus) {
    // Use total_in + total_out as a proxy for "thermal-generating duty".
    const tinPts = recorder.query(d.sn, 'total_in', since, now, HOUR_BUCKET_SEC);
    const toutPts = recorder.query(d.sn, 'total_out', since, now, HOUR_BUCKET_SEC);
    const tinByHe = new Map<number, number[]>();
    const toutByHe = new Map<number, number[]>();
    for (const p of tinPts) {
      const he = Math.floor(p.ts / 3_600_000);
      const arr = tinByHe.get(he) ?? [];
      arr.push(p.value); tinByHe.set(he, arr);
    }
    for (const p of toutPts) {
      const he = Math.floor(p.ts / 3_600_000);
      const arr = toutByHe.get(he) ?? [];
      arr.push(p.value); toutByHe.set(he, arr);
    }
    for (const pk of d.projection.packs) {
      const tPts = recorder.query(d.sn, `pack${pk.num}_temp`, since, now, HOUR_BUCKET_SEC);
      const tByHe = new Map<number, number[]>();
      for (const p of tPts) {
        const he = Math.floor(p.ts / 3_600_000);
        const arr = tByHe.get(he) ?? [];
        arr.push(p.value); tByHe.set(he, arr);
      }
      const rows: Array<{ x1: number; x2: number; y: number }> = [];
      for (const [he, tArr] of tByHe) {
        const amb = ambientByHe.get(he);
        if (amb == null) continue;
        const tinArr = tinByHe.get(he) ?? [];
        const toutArr = toutByHe.get(he) ?? [];
        const loadW = (tinArr.length ? mean(tinArr) : 0) + (toutArr.length ? mean(toutArr) : 0);
        rows.push({ x1: amb, x2: loadW / 1000, y: mean(tArr) });
      }
      const fit = lstsq2(rows);
      let predictedPeak: number | null = null;
      let predictedPeakAt: number | null = null;
      if (fit) {
        // Predict next 24 h using forecast ambient + most-recent average load.
        const recentLoad = (mean(tinPts.slice(-24).map((p) => p.value)) +
                            mean(toutPts.slice(-24).map((p) => p.value))) / 1000;
        for (const wh of weather.hours) {
          if (wh.ts < now || wh.ts > now + 24 * 3_600_000) continue;
          const pred = fit.b0 + fit.b1 * wh.tempC + fit.b2 * recentLoad;
          if (predictedPeak == null || pred > predictedPeak) {
            predictedPeak = pred;
            predictedPeakAt = wh.ts;
          }
        }
      }
      packs.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), packNum: pk.num,
        ambientCoeff: fit ? round2(fit.b1) : null,
        loadCoeff: fit ? round2(fit.b2) : null,
        intercept: fit ? round2(fit.b0) : null,
        r2: fit ? round2(fit.r2) : null,
        samples: rows.length,
        predictedPeak24hC: predictedPeak != null ? round1(predictedPeak) : null,
        predictedPeakAtMs: predictedPeakAt,
      });
    }
  }
  const value: AmbientThermalReport = { generatedAt: now, packs };
  if (dpus.length > 0) ambientThermalCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Confidence trend (v0.7.5).
 *
 * R² across the panel's projections (SoH fade, ambient-thermal,
 * GHI→PV) collected at this snapshot. A week-over-week increasing R²
 * means "trust this week's projections more than last week's". This
 * one is computed on demand from current state — no caching needed.
 * =================================================================== */

export interface ConfidenceSnapshot {
  generatedAt: number;
  degradationMedianR2: number | null;
  solarModelMedianR2: number | null;
  thermalMedianR2: number | null;
  forecastSkillBiasFactor: number | null;
  forecastSkillMaePct: number | null;
}

export function computeConfidenceSnapshot(
  degradation: FleetDegradation,
  forecast: DayForecast | null,
  thermal: AmbientThermalReport,
  skill: ForecastSkillReport,
): ConfidenceSnapshot {
  const degR2s = degradation.packs
    .map((p) => p.r2)
    .filter((r): r is number => r != null);
  const solarR2s = forecast
    ? forecast.solarModel.hourly.map((h) => h.r2).filter((r) => r > 0)
    : [];
  const thermalR2s = thermal.packs.map((p) => p.r2).filter((r): r is number => r != null);
  return {
    generatedAt: Date.now(),
    degradationMedianR2: degR2s.length ? round2(median(degR2s)) : null,
    solarModelMedianR2: solarR2s.length ? round2(median(solarR2s)) : null,
    thermalMedianR2: thermalR2s.length ? round2(median(thermalR2s)) : null,
    forecastSkillBiasFactor: skill.biasFactor,
    forecastSkillMaePct: skill.meanAbsErrorPct,
  };
}

/* ===================================================================
 * Self-consumption ratio (v0.7.5) — what fraction of generated PV
 * actually does household work (powering the load directly, or
 * charging the battery to feed the load later). On an off-grid setup
 * with no export path the answer is structurally 100% as long as
 * production ≤ demand+headroom; the more useful number is the
 * breakdown: kWh-direct-to-load, kWh-to-battery, kWh-from-battery, and
 * grid-imported kWh — and the "solar fraction of load" (% of household
 * consumption that was met by solar, directly or via battery).
 * Rolling 7-day window by default. Cached 5 min.
 * =================================================================== */

const SELF_CONSUMPTION_TTL_MS = 5 * 60 * 1000;

export interface SelfConsumption {
  generatedAt: number;
  windowDays: number;
  pvKwh: number;           // total PV generated across the fleet
  loadKwh: number;         // total household consumption (panel load + DPU AC-out passthrough)
  batteryChargeKwh: number;
  batteryDischargeKwh: number;
  gridImportKwh: number;
  pvToLoadKwh: number;     // estimate: PV that went straight to load (PV − battery-charge − export)
  pvToBatteryKwh: number;  // estimate: PV that charged the battery
  solarFractionOfLoadPct: number | null; // (pvToLoad + batteryDischarge) ÷ loadKwh
  directUseRatioPct: number | null;      // pvToLoad ÷ pvKwh
}

let selfConsumptionCache: { ts: number; key: string; value: SelfConsumption } | null = null;

export function computeSelfConsumption(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  windowDays = 7,
): SelfConsumption {
  const key = `d${windowDays}`;
  if (selfConsumptionCache && selfConsumptionCache.key === key && Date.now() - selfConsumptionCache.ts < SELF_CONSUMPTION_TTL_MS) {
    return selfConsumptionCache.value;
  }
  const now = Date.now();
  const since = now - windowDays * 86_400_000;
  const list = Object.values(devices);
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;

  // v0.9.14 — bucket to 60 s in SQLite. Over a 7-day window, raw samples
  // typically number 60-120 k per metric; the 60 s bucket cuts that to 10 k
  // without meaningfully changing the Wh integration (trapezoidal area between
  // adjacent minute-mean samples differs from the raw integral by <1% on a
  // signal with normal noise, well inside the 0.1 % rounding we already apply).
  //
  // v0.9.29 — batch all metrics per device into ONE SQL call via queryMulti.
  // For a 4-DPU fleet with 5 packs each, the loop used to issue 49 separate
  // SQL round-trips ((2 + 5×2) × 4 DPUs + 1 SHP2). Now it issues 5 —
  // one queryMulti per device. The query planner walks the (sn, metric, ts)
  // index once per device and emits already-grouped rows, which we sort
  // into per-metric arrays in a single linear pass through the result set.
  const ANALYTICS_BUCKET_SEC = 60;
  // v0.9.76 — sum PV / charge / discharge / grid-import over SHP2-connected
  // DPUs only. The denominator (loadKwh) is SHP2 panel_load — intrinsically
  // home-only — so the numerator MUST match scope or the ratio is wrong.
  // Pre-fix bug: solarFractionOfLoadPct came out 127 % (physically impossible)
  // because spare-Core PV + bench-charge cycles inflated the home numerator
  // against the home-only load denominator.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  let pvKwh = 0, batteryChargeKwh = 0, batteryDischargeKwh = 0, gridImportKwh = 0;
  for (const d of homeDpus) {
    const metricsNeeded = ['pv_total', 'ac_in'];
    for (const pk of d.projection.packs) {
      metricsNeeded.push(`pack${pk.num}_in`, `pack${pk.num}_out`);
    }
    const byMetric = recorder.queryMulti(d.sn, metricsNeeded, since, now, ANALYTICS_BUCKET_SEC);
    pvKwh += integrateWh(byMetric.get('pv_total') ?? [], since, now).wh / 1000;
    gridImportKwh += integrateWh(byMetric.get('ac_in') ?? [], since, now).wh / 1000;
    for (const pk of d.projection.packs) {
      batteryChargeKwh += integrateWh(byMetric.get(`pack${pk.num}_in`) ?? [], since, now).wh / 1000;
      batteryDischargeKwh += integrateWh(byMetric.get(`pack${pk.num}_out`) ?? [], since, now).wh / 1000;
    }
  }
  const loadKwh = shp2
    ? integrateWh(recorder.query(shp2.sn, 'panel_load', since, now, ANALYTICS_BUCKET_SEC), since, now).wh / 1000
    : 0;

  // Charge fed by PV is what the PV produced beyond what went to load — the rest
  // came from grid. On an off-grid system gridImportKwh ≈ 0 and PV ≈ load+charge.
  const pvToBatteryKwh = Math.max(0, batteryChargeKwh - gridImportKwh);
  const pvToLoadKwh = Math.max(0, pvKwh - pvToBatteryKwh);
  const solarToLoadKwh = pvToLoadKwh + batteryDischargeKwh;
  const value: SelfConsumption = {
    generatedAt: now,
    windowDays,
    pvKwh: round2(pvKwh),
    loadKwh: round2(loadKwh),
    batteryChargeKwh: round2(batteryChargeKwh),
    batteryDischargeKwh: round2(batteryDischargeKwh),
    gridImportKwh: round2(gridImportKwh),
    pvToLoadKwh: round2(pvToLoadKwh),
    pvToBatteryKwh: round2(pvToBatteryKwh),
    solarFractionOfLoadPct: loadKwh > 0.5 ? Math.round((solarToLoadKwh / loadKwh) * 1000) / 10 : null,
    directUseRatioPct: pvKwh > 0.5 ? Math.round((pvToLoadKwh / pvKwh) * 1000) / 10 : null,
  };
  if (dpus.length > 0) selfConsumptionCache = { ts: now, key, value };
  return value;
}

/* ===================================================================
 * Thermal-event counter (v0.7.5) — cumulative count of times each
 * pack crossed each elevated-temperature threshold (96°F / 113°F /
 * 131°F). Rising-edge only — sustained heat counts as one event, not
 * one per sample. Multiplies the EOL projection as a "hard life"
 * indicator: 200 events at 131°F is a lot more damage than 200 at
 * 96°F, even if the SoH regression looks the same.
 *
 * Scans the full per-pack temperature history. Cached 30 min.
 * =================================================================== */

const THERMAL_EVENT_TTL_MS = 30 * 60 * 1000;
const THERMAL_EVENT_HISTORY_MS = 400 * 24 * 60 * 60 * 1000;
const THERMAL_THRESHOLD_C_INFO = (96 - 32) / 1.8;   // ≈ 35.6 °C
const THERMAL_THRESHOLD_C_WARN = (113 - 32) / 1.8;  // 45 °C
const THERMAL_THRESHOLD_C_CRIT = (131 - 32) / 1.8;  // 55 °C
const THERMAL_HYSTERESIS_C = 1.5; // must fall back this far before re-arming

export interface ThermalEventCounts {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  warmEvents: number;       // crossings above 96 °F
  hotEvents: number;        // crossings above 113 °F
  overheatEvents: number;   // crossings above 131 °F
  warmHours: number;        // total hours spent above 96 °F
  hotHours: number;
  overheatHours: number;
  dataSpanDays: number;
  hardLifeScore: number;    // 1×warm + 4×hot + 16×overheat events, per year
}

export interface FleetThermalEvents {
  generatedAt: number;
  packs: ThermalEventCounts[];
}

let thermalEventsCache: { ts: number; value: FleetThermalEvents } | null = null;

export function computeThermalEvents(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): FleetThermalEvents {
  if (thermalEventsCache && Date.now() - thermalEventsCache.ts < THERMAL_EVENT_TTL_MS) {
    return thermalEventsCache.value;
  }
  const now = Date.now();
  const since = now - THERMAL_EVENT_HISTORY_MS;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  const packs: ThermalEventCounts[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      const pts = recorder.query(d.sn, `pack${pk.num}_temp`, since, now);
      if (pts.length === 0) {
        packs.push({
          sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
          packNum: pk.num, warmEvents: 0, hotEvents: 0, overheatEvents: 0,
          warmHours: 0, hotHours: 0, overheatHours: 0, dataSpanDays: 0, hardLifeScore: 0,
        });
        continue;
      }
      let warmEvents = 0, hotEvents = 0, overheatEvents = 0;
      let warmMs = 0, hotMs = 0, overheatMs = 0;
      let warmArmed = true, hotArmed = true, overheatArmed = true;
      let prevTs: number | null = null;
      let prevTemp: number | null = null;
      for (const p of pts) {
        // Rising-edge with hysteresis: a sustained high spell counts as ONE
        // event; the threshold "re-arms" once temp falls THERMAL_HYSTERESIS_C
        // back below the trigger.
        if (warmArmed && p.value >= THERMAL_THRESHOLD_C_INFO) { warmEvents++; warmArmed = false; }
        if (!warmArmed && p.value < THERMAL_THRESHOLD_C_INFO - THERMAL_HYSTERESIS_C) warmArmed = true;
        if (hotArmed && p.value >= THERMAL_THRESHOLD_C_WARN) { hotEvents++; hotArmed = false; }
        if (!hotArmed && p.value < THERMAL_THRESHOLD_C_WARN - THERMAL_HYSTERESIS_C) hotArmed = true;
        if (overheatArmed && p.value >= THERMAL_THRESHOLD_C_CRIT) { overheatEvents++; overheatArmed = false; }
        if (!overheatArmed && p.value < THERMAL_THRESHOLD_C_CRIT - THERMAL_HYSTERESIS_C) overheatArmed = true;
        // Time-above-threshold — credit the gap between this sample and the
        // last to whichever band the previous reading sat in.
        if (prevTs != null && prevTemp != null) {
          const dt = p.ts - prevTs;
          if (prevTemp >= THERMAL_THRESHOLD_C_INFO) warmMs += dt;
          if (prevTemp >= THERMAL_THRESHOLD_C_WARN) hotMs += dt;
          if (prevTemp >= THERMAL_THRESHOLD_C_CRIT) overheatMs += dt;
        }
        prevTs = p.ts; prevTemp = p.value;
      }
      const spanMs = pts[pts.length - 1].ts - pts[0].ts;
      const spanDays = Math.max(1, spanMs / 86_400_000);
      // Hard-life score, normalized per-year — useful as a peer-compare lens
      // even when packs have different recording histories.
      const hardLifeScore = ((warmEvents + 4 * hotEvents + 16 * overheatEvents) / spanDays) * 365;
      packs.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), packNum: pk.num,
        warmEvents, hotEvents, overheatEvents,
        warmHours: Math.round(warmMs / 3_600_000),
        hotHours: Math.round(hotMs / 3_600_000),
        overheatHours: Math.round(overheatMs / 3_600_000),
        dataSpanDays: round1(spanDays),
        hardLifeScore: Math.round(hardLifeScore * 10) / 10,
      });
    }
  }
  const value: FleetThermalEvents = { generatedAt: now, packs };
  if (dpus.length > 0) thermalEventsCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * MPPT efficiency drift + inverter standby loss (v0.7.5).
 *
 * Each MPPT reports both DC-side (V × A) and AC-side (W) — the ratio
 * is the conversion efficiency. Healthy MPPTs sit 96–99%; a sustained
 * drop is earliest-detectable electronics aging. Computed per-DPU per-
 * string (HV + LV) as a 7-day average plus a regression slope.
 *
 * Inverter standby loss: ac_out residual when PV is dark and load
 * is near zero — the inverter's own idle draw. Trended week-over-week.
 * =================================================================== */

const MPPT_EFF_TTL_MS = 10 * 60 * 1000;

export interface MpptString {
  sn: string;
  device: string;
  coreNum: number | null;
  string: 'HV' | 'LV';
  recentEffPct: number | null;     // median ratio over the recent window
  baselineEffPct: number | null;   // median ratio over the earliest 30% of history
  driftPctPts: number | null;      // recent − baseline (positive = healthy/improving, negative = drift)
  samples: number;
  spanDays: number;
}

export interface InverterStandby {
  sn: string;
  device: string;
  coreNum: number | null;
  idleWatts: number | null;       // recent median ac_out when PV<20W and panel-load<20W
  baselineIdleWatts: number | null;
  trendWattsPerWeek: number | null;
  samples: number;
}

export interface EquipmentHealth {
  generatedAt: number;
  mpptStrings: MpptString[];
  inverterStandby: InverterStandby[];
}

let equipmentHealthCache: { ts: number; value: EquipmentHealth } | null = null;

// v0.9.29 — equipment-health used to pull THREE 60-day unbucketed series
// per MPPT string × two strings × 4 DPUs = 24 unbucketed 60-day reads per
// cycle. On a typical fleet that's ~450 k rows per metric — ten million
// objects materialized in JS per warm cycle, ~500 ms by itself in field
// timings.
//
// 5-min bucketing collapses that to ~17 k rows per metric (60 days ×
// 24 h × 12 buckets/h) with no signal loss for our two consumers here:
// median efficiency (slow-moving) and trend (linear fit over weeks).
// queryMulti additionally cuts 3 SQL round-trips per string to 1.
const EQ_HEALTH_BUCKET_SEC = 300; // 5 min — see note above

function ratioSeries(
  recorder: Recorder,
  sn: string,
  watts: string, volts: string, amps: string,
  since: number, now: number,
): Array<{ ts: number; eff: number }> {
  const byMetric = recorder.queryMulti(sn, [watts, volts, amps], since, now, EQ_HEALTH_BUCKET_SEC);
  const wPts = byMetric.get(watts) ?? [];
  if (wPts.length === 0) return [];
  const vPts = byMetric.get(volts) ?? [];
  const aPts = byMetric.get(amps) ?? [];
  // Snap V and A to nearest W timestamp using two-pointer merge. Allowed
  // skew widens to the bucket size (samples in the same 5-min bucket
  // align exactly — different bucket centers can be 5 min apart).
  const SNAP_TOLERANCE_MS = EQ_HEALTH_BUCKET_SEC * 1000;
  const out: Array<{ ts: number; eff: number }> = [];
  let vi = 0, ai = 0;
  for (const w of wPts) {
    while (vi + 1 < vPts.length && Math.abs(vPts[vi + 1].ts - w.ts) < Math.abs(vPts[vi].ts - w.ts)) vi++;
    while (ai + 1 < aPts.length && Math.abs(aPts[ai + 1].ts - w.ts) < Math.abs(aPts[ai].ts - w.ts)) ai++;
    const v = vPts[vi];
    const a = aPts[ai];
    if (!v || !a) continue;
    if (Math.abs(v.ts - w.ts) > SNAP_TOLERANCE_MS || Math.abs(a.ts - w.ts) > SNAP_TOLERANCE_MS) continue;
    const dc = v.value * a.value;
    if (dc < 50) continue; // ignore near-dark; ratio is dominated by noise
    if (w.value < 20) continue;
    const eff = (w.value / dc) * 100;
    if (eff < 50 || eff > 105) continue; // clamp pathological / measurement-aligned outliers
    out.push({ ts: w.ts, eff });
  }
  return out;
}

export function computeEquipmentHealth(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): EquipmentHealth {
  if (equipmentHealthCache && Date.now() - equipmentHealthCache.ts < MPPT_EFF_TTL_MS) {
    return equipmentHealthCache.value;
  }
  const now = Date.now();
  const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
  const BASELINE_MS = 60 * 24 * 60 * 60 * 1000;
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  const mpptStrings: MpptString[] = [];
  for (const d of dpus) {
    for (const [name, w, v, a] of [
      ['HV', 'pv_high', 'pv_high_v', 'pv_high_a'],
      ['LV', 'pv_low', 'pv_low_v', 'pv_low_a'],
    ] as Array<['HV' | 'LV', string, string, string]>) {
      const series = ratioSeries(recorder, d.sn, w, v, a, now - BASELINE_MS, now);
      if (series.length < 20) {
        mpptStrings.push({
          sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), string: name,
          recentEffPct: null, baselineEffPct: null, driftPctPts: null,
          samples: series.length, spanDays: 0,
        });
        continue;
      }
      const spanMs = series[series.length - 1].ts - series[0].ts;
      const recent = series.filter((p) => p.ts >= now - RECENT_MS).map((p) => p.eff);
      const earliestCount = Math.max(10, Math.floor(series.length * 0.3));
      const baseline = series.slice(0, earliestCount).map((p) => p.eff);
      const recentEff = recent.length ? median(recent) : null;
      const baselineEff = baseline.length ? median(baseline) : null;
      mpptStrings.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), string: name,
        recentEffPct: recentEff != null ? round2(recentEff) : null,
        baselineEffPct: baselineEff != null ? round2(baselineEff) : null,
        driftPctPts: recentEff != null && baselineEff != null ? round2(recentEff - baselineEff) : null,
        samples: series.length,
        spanDays: round1(spanMs / 86_400_000),
      });
    }
  }

  // Inverter standby: ac_out when PV is dark (<20W) and panel_load is dark.
  // Snap on the AC-out series; check PV at the same ts (within 5 min, the
  // bucket size). v0.9.29 — same 5-min bucketing as ratioSeries; load
  // pulled once per cycle and reused across DPUs.
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const baselineSinceForLoad = now - BASELINE_MS;
  const loadPts = shp2
    ? recorder.query(shp2.sn, 'panel_load', baselineSinceForLoad, now, EQ_HEALTH_BUCKET_SEC)
    : [];
  const inverterStandby: InverterStandby[] = [];
  for (const d of dpus) {
    const baselineSince = now - BASELINE_MS;
    // queryMulti — one SQL call for both ac_out + pv_total per DPU.
    const byMetric = recorder.queryMulti(d.sn, ['ac_out', 'pv_total'], baselineSince, now, EQ_HEALTH_BUCKET_SEC);
    const aoPts = byMetric.get('ac_out') ?? [];
    const pvPts = byMetric.get('pv_total') ?? [];
    if (aoPts.length === 0) {
      inverterStandby.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
        idleWatts: null, baselineIdleWatts: null, trendWattsPerWeek: null, samples: 0,
      });
      continue;
    }
    const idleSeries: Array<{ ts: number; w: number }> = [];
    let pvi = 0, li = 0;
    for (const ao of aoPts) {
      while (pvi + 1 < pvPts.length && Math.abs(pvPts[pvi + 1].ts - ao.ts) < Math.abs(pvPts[pvi].ts - ao.ts)) pvi++;
      while (li + 1 < loadPts.length && Math.abs(loadPts[li + 1].ts - ao.ts) < Math.abs(loadPts[li].ts - ao.ts)) li++;
      const pv = pvPts[pvi]?.value ?? 0;
      const load = loadPts[li]?.value ?? 0;
      if (pv < 20 && load < 20 && ao.value > 0 && ao.value < 200) {
        idleSeries.push({ ts: ao.ts, w: ao.value });
      }
    }
    if (idleSeries.length < 10) {
      inverterStandby.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
        idleWatts: null, baselineIdleWatts: null, trendWattsPerWeek: null, samples: idleSeries.length,
      });
      continue;
    }
    const recent = idleSeries.filter((p) => p.ts >= now - RECENT_MS).map((p) => p.w);
    const baseline = idleSeries.slice(0, Math.max(5, Math.floor(idleSeries.length * 0.3))).map((p) => p.w);
    const fit = linregress(idleSeries.map((p) => ({ ts: p.ts, value: p.w })));
    inverterStandby.push({
      sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
      idleWatts: recent.length ? round1(median(recent)) : null,
      baselineIdleWatts: baseline.length ? round1(median(baseline)) : null,
      trendWattsPerWeek: fit ? round2(fit.slopePerMs * 604_800_000) : null,
      samples: idleSeries.length,
    });
  }

  const value: EquipmentHealth = { generatedAt: now, mpptStrings, inverterStandby };
  if (dpus.length > 0) equipmentHealthCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Inverter clipping quantifier (v0.6.0).
 *
 * On bluebird-clear summer days the arrays can produce more DC than the
 * MPPT charge controllers + inverter can handle, and the system simply
 * caps the output at its hardware ceiling — "clipping". The energy that
 * SHOULD have arrived but couldn't is silently lost.
 *
 * This estimates how much by walking each elapsed daylight hour today:
 *   - hardware ceiling     ← highest hourly-average PV ever observed
 *   - observed PV (hour)   ← average pv_total summed across DPUs
 *   - "would-have" PV       ← learned-coefficient × actual GHI from weather
 *
 * An hour is flagged as "at peak" when the observed PV reaches 95% of the
 * ceiling. If the model thinks the array could have produced more than
 * what we recorded during that hour, the difference is the clipped energy
 * for that hour. Sum across the day → kWh-lost-to-clipping today.
 * =================================================================== */

export interface ClippingHour {
  hour: number;           // 0-23 local hour-of-day
  observedW: number;      // fleet-total average PV that hour
  modelW: number | null;  // what the learned model says the array could have made
  clippedW: number;       // modelW − observedW (when at peak and modelW > observedW)
}

export interface ClippingEstimate {
  generatedAt: number;
  todayKwh: number;       // kWh lost to clipping so far today
  perHour: ClippingHour[];
  arrayPeakW: number;     // hardware ceiling — highest hourly PV ever observed
  hoursAtPeak: number;    // hours today where observed PV ≥ 0.95 × ceiling
}

const CLIPPING_TTL_MS = 5 * 60 * 1000;
const CLIPPING_PEAK_FRAC = 0.95;        // "at peak" threshold relative to the ceiling
let clippingCache: { ts: number; value: ClippingEstimate } | null = null;

/** Estimate kWh lost to inverter clipping so far today. Cached ~5 min. */
export async function computeClipping(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  forecast: DayForecast | null,
): Promise<ClippingEstimate> {
  if (clippingCache && Date.now() - clippingCache.ts < CLIPPING_TTL_MS) {
    return clippingCache.value;
  }
  const now = Date.now();
  const empty = (): ClippingEstimate => ({
    generatedAt: now,
    todayKwh: 0,
    perHour: [],
    arrayPeakW: 0,
    hoursAtPeak: 0,
  });
  if (!forecast) return empty();

  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  if (dpus.length === 0) return empty();
  // v0.9.76 — clipping is "home array hit inverter ceiling". Use only
  // SHP2-connected DPUs so a spare with bench panels doesn't either
  // inflate `observedW` (false-negative clipping) or pollute the
  // `arrayPeakW` ceiling derived from the now-also-filtered solar model.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  if (homeDpus.length === 0) return empty();

  const arrayPeakW = Math.max(0, ...forecast.solarModel.hourly.map((h) => h.observedMaxPvW));
  if (arrayPeakW <= 0) return empty();

  // Today's per-hour GHI lives in the weather cache (Open-Meteo returns the
  // past 3 days alongside the forecast). getWeather() is cached and cheap.
  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHour = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHour.set(Math.floor(wh.ts / 3_600_000), wh);

  const todayStart = startOfLocalDayMs();
  // v0.9.29 — pull pv_total ONCE per DPU for today's full window, then
  // bucket by hour in JS. Was 24 × dpus = 96 round-trips per call; now
  // dpus = 4 round-trips. The bucket-sec=60 averages within a minute so
  // the per-hour mean we ultimately compute is identical to the previous
  // raw-sample mean to within rounding (each minute bucket already holds
  // the within-minute average, which matters more for accuracy than the
  // arithmetic mean of raw 10-second readings).
  const dpuPvByHour: Map<string, number[][]> = new Map(); // sn → 24 arrays of bucket values
  for (const d of homeDpus) {
    const pts = recorder.query(d.sn, 'pv_total', todayStart, now, 60);
    const hourBuckets: number[][] = Array.from({ length: 24 }, () => []);
    for (const p of pts) {
      const h = Math.floor((p.ts - todayStart) / 3_600_000);
      if (h >= 0 && h < 24) hourBuckets[h].push(p.value);
    }
    dpuPvByHour.set(d.sn, hourBuckets);
  }

  const perHour: ClippingHour[] = [];
  let clippedKwh = 0;
  let hoursAtPeak = 0;
  for (let h = 0; h < 24; h++) {
    const hourStart = todayStart + h * 3_600_000;
    if (hourStart >= now) break;
    const hourEnd = Math.min(hourStart + 3_600_000, now);
    let observedW = 0;
    let totalPts = 0;
    for (const d of dpus) {
      const bucket = dpuPvByHour.get(d.sn)?.[h] ?? [];
      if (bucket.length === 0) continue;
      observedW += bucket.reduce((s, x) => s + x, 0) / bucket.length;
      totalPts += bucket.length;
    }
    if (totalPts === 0) continue;
    const wx = wxByHour.get(Math.floor(hourStart / 3_600_000));
    const hod = new Date(hourStart).getHours();
    const resp = forecast.solarModel.hourly[hod];
    let modelW: number | null = null;
    if (wx && resp.coeff != null && wx.radiationWm2 > DAYLIGHT_GHI) {
      modelW = resp.coeff * wx.radiationWm2;
    }
    const atPeak = observedW >= CLIPPING_PEAK_FRAC * arrayPeakW;
    let clippedW = 0;
    if (atPeak && modelW != null && modelW > observedW) {
      clippedW = modelW - observedW;
      // Partial-hour at the current hour: weight by the elapsed fraction.
      const elapsedHrs = (hourEnd - hourStart) / 3_600_000;
      clippedKwh += (clippedW / 1000) * elapsedHrs;
    }
    if (atPeak) hoursAtPeak++;
    perHour.push({
      hour: hod,
      observedW: Math.round(observedW),
      modelW: modelW != null ? Math.round(modelW) : null,
      clippedW: Math.round(clippedW),
    });
  }

  const value: ClippingEstimate = {
    generatedAt: now,
    todayKwh: Math.round(clippedKwh * 100) / 100,
    perHour,
    arrayPeakW: Math.round(arrayPeakW),
    hoursAtPeak,
  };
  clippingCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * Solar curtailment / SoC-saturation detection (v0.9.77).
 *
 * Distinct from `computeClipping` (which catches the inverter HARDWARE
 * ceiling). Curtailment here is the OPPOSITE situation: batteries are
 * already full, home load is low, so the DPUs throttle their MPPTs to
 * match (load + standby losses). The panels could produce more, but
 * there's nowhere for the energy to go — it gets rejected at the array.
 *
 * The signal is observable but indirect — we never see the curtailed
 * watts directly. The chain of reasoning:
 *   1. Bayesian model (computeBayesianSolarModel) gives expected PV per
 *      W/m² of GHI for each hour-of-day, learned from historical
 *      clear-sky observations against the SHP2-connected arrays.
 *   2. Open-Meteo gives current GHI.
 *   3. Expected PV now = μ[hour] × GHI.
 *   4. If actual PV is well below expected AND SoC is near 100% AND
 *      actual PV ≈ home load (panels matched to load) → that gap is the
 *      curtailed surplus.
 *
 * Sensitivity to wrong attribution:
 *   - A cloud band dropping GHI mid-hour will briefly satisfy (actual
 *     << expected) without curtailment. The match-load check filters
 *     this: under cloud, PV drops below load, batteries start
 *     discharging, SoC slips off 100%. So the "SoC ≥ 96 AND PV matched
 *     to load" guard keeps us from labeling clouds as curtailment.
 *   - At sunrise the Bayesian μ for early hours is noisy (low sample
 *     count, small denominator from low-GHI observations). We require
 *     the per-hour posterior to have ≥3 samples before trusting it.
 *
 * Lifetime kWh: this version computes today's kWh by walking today's
 * past hours with weather data, and 7-day kWh by walking the past 7
 * daylight hours of each day. Open-Meteo retains 3 days of history in
 * the past_days=3 query (see weather.ts), so days 1-3 are weather-
 * verified and days 4-7 fall back to the heuristic (SoC ≥ 96% AND PV
 * matched to load AND solar should be high for this hour of day).
 *
 * Opportunistic loads: the report includes a static list of loads the
 * user could activate to absorb surplus. v0.9.77 ships an informational
 * list; future versions will hook into HA service calls (pool pump max
 * speed, EV charging trigger, etc.) so the panel can ACT on curtailment
 * instead of just naming it. The static list comes with sensible
 * Phoenix-home defaults; override planned via config.yaml in a later
 * release.
 * =================================================================== */

export interface OpportunisticLoad {
  id: string;
  name: string;
  estimatedW: number;
  category: 'pool' | 'ev' | 'water' | 'hvac' | 'other';
  description: string;
  /** True when current surplus ≥ estimatedW. */
  fitsInSurplus: boolean;
  /** Implementation hint for future HA automation; null until wired. */
  haServiceHint: string | null;
}

export interface CurtailmentHour {
  hour: number;           // 0-23 local hour-of-day
  surplusW: number;       // mean curtailed power in this hour
  curtailedKwh: number;   // surplusW × hour fraction we walked
  socAvg: number;         // mean SoC across home DPUs during this hour
  pvActualW: number;
  pvExpectedW: number;
  loadW: number;
  weatherVerified: boolean; // true when GHI was available for the hour
}

export interface CurtailmentReport {
  generatedAt: number;
  /** Is the system actively curtailing right now? */
  active: boolean;
  /** Current surplus estimate (W). 0 when not active. */
  currentSurplusW: number;
  /** Live state at compute time. */
  current: {
    socAvg: number;
    pvActualW: number;
    pvExpectedW: number | null;
    loadW: number;
    ghiWm2: number | null;
    bayesianSamples: number;   // posterior samples for the current hour
    /** Configured charge ceiling (mean chgMaxSoc across home DPUs), or
     *  null when no DPU reports one. This is the SoC the pool charges to
     *  — Storm Guard raises it to 100, normal mode sits lower. */
    chargeCeilingPct: number | null;
    /** SoC at/above which we treat the pool as saturated = ceiling − margin
     *  (or the fallback constant when ceiling is null). */
    saturationThresholdPct: number;
  };
  /** Reason curtailment is NOT firing right now (null when active). */
  inactiveReason:
    | null
    | 'soc-too-low'
    | 'pv-too-low'
    | 'no-daylight'
    | 'no-model'
    | 'small-gap'
    | 'pv-exceeds-load'
    | 'no-shp2'
    | 'no-home-dpus';
  /** Today's curtailment so far (per hour walked + total kWh). */
  todayKwh: number;
  todayHours: CurtailmentHour[];
  /** Past 7 days of curtailment (weather-verified where possible). */
  recent7dKwh: number;
  recent7dHoursCount: number;
  /** Hour-of-day histogram across the past 7 days — useful for siting
   *  opportunistic loads (run pool pump from 10-14 if that's the cluster). */
  hourlyHistogram: Array<{ hour: number; avgSurplusW: number; samples: number }>;
  /** Loads we suggest to absorb the surplus. */
  opportunisticLoads: OpportunisticLoad[];
}

const CURTAIL_TTL_MS = 60 * 1000;            // 1 min — short, real-time tile
const CURTAIL_MIN_PV_W = 200;                // panels actually producing
const CURTAIL_MIN_SURPLUS_W = 300;           // meaningful gap before we call it curtailment
const CURTAIL_MIN_GHI_WM2 = 100;             // daylight floor
const CURTAIL_MIN_BAYES_SAMPLES = 3;         // require posterior support
// Curtailment match-load check: when truly throttling, PV ≈ load + standby
// (~50 W per online DPU baseline). PV > load × this factor disqualifies.
const CURTAIL_PV_MATCH_LOAD_FACTOR = 2.0;
const CURTAIL_HISTORY_DAYS = 7;

// v0.9.78 — the "battery full" threshold is NOT a fixed 96%. EcoFlow
// DPUs charge to a *configured ceiling* (`chgMaxSoc`) that's well below
// 100% in normal operation (the operator runs his packs to a setting, not full).
// Storm Guard / outage-prep raises that ceiling to 100% — and because it
// does so by changing `chgMaxSoc` itself, reading the field live means we
// automatically track whatever mode is active without needing a separate
// storm-guard flag. Curtailment begins when SoC reaches the ceiling
// (charge current → 0, excess PV rejected), so the saturation threshold
// is `ceiling − margin`. The margin catches the approach + measurement
// jitter; the PV-matched-to-load guard downstream is what actually
// prevents false positives during bulk charge.
const CURTAIL_SATURATION_MARGIN_PCT = 2;     // how far below the ceiling counts as "saturated"
// Only used when NO DPU reports a ceiling (field missing / cold boot).
// Mirrors the pre-v0.9.78 hardcoded behavior so a setup that doesn't
// surface chgMaxSoc still gets sensible "near full" detection.
const CURTAIL_SOC_FALLBACK_PCT = 96;

/**
 * Effective charge ceiling (%) for the home pool: mean of the
 * SHP2-connected DPUs' configured `chgMaxSoc`. Returns null when no DPU
 * reports one. Mean (not min) is the physically correct pool aggregate —
 * we compare it against mean SoC, and the pool is "saturated" only when
 * the average has reached the average ceiling (i.e. every DPU is at its
 * own limit). In the common case all DPUs share one ceiling, so mean =
 * that value.
 */
function homeChargeCeilingPct(
  homeDpus: Array<DeviceSnapshot & { projection: DpuProjection }>,
): number | null {
  const ceilings = homeDpus
    .map((d) => d.projection.chgMaxSoc)
    .filter((v): v is number => v != null && v > 0);
  if (ceilings.length === 0) return null;
  return ceilings.reduce((s, v) => s + v, 0) / ceilings.length;
}

/** The SoC at/above which the pool is treated as saturated (curtailment
 *  can begin). Derived from the live ceiling minus the approach margin,
 *  falling back to the legacy constant when no ceiling is reported. */
function saturationThresholdPct(ceiling: number | null): number {
  return ceiling != null
    ? Math.max(0, ceiling - CURTAIL_SATURATION_MARGIN_PCT)
    : CURTAIL_SOC_FALLBACK_PCT;
}

// Phoenix off-grid home opportunistic loads. Estimated wattages are
// based on the operator's setup (~16.8 kWp array, pool pump on a SHP2 circuit,
// EVSE Level-2, electric tank heater). Update via config in a later rev.
const DEFAULT_OPPORTUNISTIC_LOADS: Omit<OpportunisticLoad, 'fitsInSurplus' | 'haServiceHint'>[] = [
  { id: 'pool_pump_high',
    name: 'Pool pump (max speed)',
    estimatedW: 1800,
    category: 'pool',
    description: 'Run pool pump on high — increases filter turnover and skimmer reach. Already a SHP2 circuit, future automation can step it through speed presets.' },
  { id: 'dehumidifier',
    name: 'Dehumidifier',
    estimatedW: 700,
    category: 'hvac',
    description: 'Reduces moisture load the AC has to remove later — banks comfort into the building envelope.' },
  { id: 'ac_precool',
    name: 'AC pre-cool (-5°F)',
    estimatedW: 3500,
    category: 'hvac',
    description: 'Drop the thermostat ~5°F now to bank thermal mass for evening hours when SoC is dropping.' },
  { id: 'water_heater',
    name: 'Electric water heater',
    estimatedW: 4500,
    category: 'water',
    description: 'Resistive tank element — heats a tank of water that holds 4-6 hours of latent capacity.' },
  { id: 'ev_charge_full',
    name: 'EV charge (full rate)',
    estimatedW: 7200,
    category: 'ev',
    description: 'Switch EVSE to max amperage. Largest single sink available and stores well for off-peak driving.' },
];

let curtailmentCache: { ts: number; value: CurtailmentReport } | null = null;

/** Resolve the GHI at the current local hour from the weather cache. */
function currentHourGhi(weather: WeatherForecast | null, now: number): number | null {
  if (!weather) return null;
  const hourEpoch = Math.floor(now / 3_600_000);
  const wh = weather.hours.find((h) => Math.floor(h.ts / 3_600_000) === hourEpoch);
  return wh ? wh.radiationWm2 : null;
}

/**
 * Predict expected PV (W) from the Bayesian posterior given an hour-of-day
 * and current GHI. Returns null when the posterior doesn't have enough
 * support to be trusted.
 */
function predictExpectedPv(
  bayes: BayesianSolarModel,
  hourOfDay: number,
  ghiWm2: number,
): { w: number; samples: number } | null {
  const post = bayes.hourly.find((h) => h.hour === hourOfDay);
  if (!post || post.samples < CURTAIL_MIN_BAYES_SAMPLES) return null;
  return { w: post.posteriorMean * ghiWm2, samples: post.samples };
}

/** Estimate kWh lost to SoC-saturation curtailment. Cached 1 min. */
export async function computeCurtailment(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<CurtailmentReport> {
  if (curtailmentCache && Date.now() - curtailmentCache.ts < CURTAIL_TTL_MS) {
    return curtailmentCache.value;
  }
  const now = Date.now();
  const empty: CurtailmentReport = {
    generatedAt: now,
    active: false,
    currentSurplusW: 0,
    current: { socAvg: 0, pvActualW: 0, pvExpectedW: null, loadW: 0, ghiWm2: null, bayesianSamples: 0, chargeCeilingPct: null, saturationThresholdPct: CURTAIL_SOC_FALLBACK_PCT },
    inactiveReason: 'no-home-dpus',
    todayKwh: 0,
    todayHours: [],
    recent7dKwh: 0,
    recent7dHoursCount: 0,
    hourlyHistogram: [],
    opportunisticLoads: DEFAULT_OPPORTUNISTIC_LOADS.map((o) => ({
      ...o, fitsInSurplus: false, haServiceHint: null,
    })),
  };

  const allDpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  if (allDpus.length === 0) return empty;
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = allDpus.filter((d) => isShp2Connected(d.sn, connected));
  if (homeDpus.length === 0) return empty;
  const shp2 = Object.values(devices).find(
    (d) => d.projection?.kind === 'shp2',
  ) as (DeviceSnapshot & { projection: Shp2Projection }) | undefined;
  if (!shp2) {
    curtailmentCache = { ts: now, value: { ...empty, inactiveReason: 'no-shp2' } };
    return curtailmentCache.value;
  }

  // 1) Live state. The expensive cached calls (weather, Bayesian) run in
  // parallel — both are usually already warm from the cache-warmer.
  const [weather, bayes] = await Promise.all([
    getWeather(),
    computeBayesianSolarModel(devices, recorder),
  ]);

  const socAvg = homeDpus.reduce((s, d) => s + (d.projection.soc ?? 0), 0) / homeDpus.length;
  const pvActualW = homeDpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);
  const loadW = shp2.projection.circuits.reduce((s, c) => s + (c.watts ?? 0), 0);
  const ghi = currentHourGhi(weather, now);
  const hod = new Date(now).getHours();
  const expected = ghi != null && ghi >= CURTAIL_MIN_GHI_WM2 ? predictExpectedPv(bayes, hod, ghi) : null;
  // v0.9.78 — saturation threshold tracks the live configured charge
  // ceiling, NOT a fixed 96%. A pool set to charge to 80% curtails at 80;
  // Storm Guard raising the ceiling to 100 pushes the threshold up with it.
  const chargeCeiling = homeChargeCeilingPct(homeDpus);
  const socThreshold = saturationThresholdPct(chargeCeiling);

  let active = false;
  let currentSurplusW = 0;
  let inactiveReason: CurtailmentReport['inactiveReason'] = null;
  if (socAvg < socThreshold) inactiveReason = 'soc-too-low';
  else if (pvActualW < CURTAIL_MIN_PV_W) inactiveReason = 'pv-too-low';
  else if (ghi == null || ghi < CURTAIL_MIN_GHI_WM2) inactiveReason = 'no-daylight';
  else if (expected == null) inactiveReason = 'no-model';
  else {
    const gap = expected.w - pvActualW;
    if (gap < CURTAIL_MIN_SURPLUS_W) inactiveReason = 'small-gap';
    else if (loadW > 100 && pvActualW > loadW * CURTAIL_PV_MATCH_LOAD_FACTOR) {
      // PV is meaningfully ABOVE load → it's actually feeding the load or
      // marginally charging — not curtailing. Only matters when load isn't
      // ~0 (nighttime base load); a near-zero loadW would make the ratio
      // useless, so we require loadW > 100W to trigger this disqualifier.
      inactiveReason = 'pv-exceeds-load';
    } else {
      active = true;
      currentSurplusW = Math.round(gap);
    }
  }

  // 2) Today's per-hour walk using weather data + Bayesian model.
  const todayStart = startOfLocalDayMs();
  const todayHours: CurtailmentHour[] = [];
  let todayKwh = 0;
  for (let h = 0; h < 24; h++) {
    const hourStart = todayStart + h * 3_600_000;
    if (hourStart >= now) break;
    const hourEnd = Math.min(hourStart + 3_600_000, now);
    const sample = await sampleCurtailmentHour(
      homeDpus, shp2, recorder, weather, bayes, hourStart, hourEnd, h, chargeCeiling,
    );
    if (sample) {
      todayHours.push(sample);
      todayKwh += sample.curtailedKwh;
    }
  }

  // 3) Past 7-day walk. Days within Open-Meteo's past_days window are
  // weather-verified; older days use the heuristic-only path inside
  // sampleCurtailmentHour (signaled by weatherVerified=false).
  const recent7dHours: CurtailmentHour[] = [];
  let recent7dKwh = 0;
  const ONE_DAY = 24 * 3_600_000;
  for (let d = 1; d <= CURTAIL_HISTORY_DAYS; d++) {
    const dayStart = todayStart - d * ONE_DAY;
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * 3_600_000;
      const hourEnd = hourStart + 3_600_000;
      const sample = await sampleCurtailmentHour(
        homeDpus, shp2, recorder, weather, bayes, hourStart, hourEnd, h, chargeCeiling,
      );
      if (sample) {
        recent7dHours.push(sample);
        recent7dKwh += sample.curtailedKwh;
      }
    }
  }

  // 4) Hour-of-day histogram across the past 7 days + today.
  const histAccum = Array.from({ length: 24 }, () => ({ sumW: 0, n: 0 }));
  for (const sample of [...todayHours, ...recent7dHours]) {
    if (sample.surplusW <= 0) continue;
    const bucket = histAccum[sample.hour];
    bucket.sumW += sample.surplusW;
    bucket.n++;
  }
  const hourlyHistogram = histAccum.map((b, hour) => ({
    hour,
    avgSurplusW: b.n > 0 ? Math.round(b.sumW / b.n) : 0,
    samples: b.n,
  }));

  // 5) Opportunistic-load suggestions sized against current surplus.
  const opportunisticLoads: OpportunisticLoad[] = DEFAULT_OPPORTUNISTIC_LOADS.map((o) => ({
    ...o,
    fitsInSurplus: currentSurplusW >= o.estimatedW,
    haServiceHint: null, // Phase 2 — wire to HA service.call here.
  }));

  const report: CurtailmentReport = {
    generatedAt: now,
    active,
    currentSurplusW,
    current: {
      socAvg: Math.round(socAvg * 10) / 10,
      pvActualW: Math.round(pvActualW),
      pvExpectedW: expected ? Math.round(expected.w) : null,
      loadW: Math.round(loadW),
      ghiWm2: ghi != null ? Math.round(ghi) : null,
      bayesianSamples: expected?.samples ?? 0,
      chargeCeilingPct: chargeCeiling != null ? Math.round(chargeCeiling) : null,
      saturationThresholdPct: Math.round(socThreshold),
    },
    inactiveReason,
    todayKwh: Math.round(todayKwh * 100) / 100,
    todayHours,
    recent7dKwh: Math.round(recent7dKwh * 100) / 100,
    recent7dHoursCount: recent7dHours.length,
    hourlyHistogram,
    opportunisticLoads,
  };
  curtailmentCache = { ts: now, value: report };
  return report;
}

/**
 * Walk one historical hour and decide whether it was curtailing.
 * Returns null when conditions for curtailment weren't met in this hour.
 *
 * - Weather-verified path: GHI ≥ daylight + Bayesian μ has support →
 *   expected PV is real; surplus = expected − actual when SoC reached the
 *   charge ceiling + PV matched to load.
 * - Heuristic-only path: weather missing (older than Open-Meteo's
 *   past_days window) → assume curtailment ONLY when SoC reached the
 *   ceiling + PV actually = load (within tolerance) + actual PV ≥ MIN_PV.
 *   Surplus is estimated as μ[hour] × (typical clear-sky GHI for that
 *   hour). This is more conservative than weather-verified — false
 *   negatives are acceptable, false positives are not.
 *
 * v0.9.78 — the saturation threshold is the *configured* charge ceiling,
 * not a fixed 96%. We prefer the per-hour recorded `chg_max_soc` (so a
 * day when Storm Guard pushed the ceiling to 100 is judged against 100,
 * and a normal-mode day against e.g. 80), and fall back to the live
 * `currentCeiling` when no historical ceiling was recorded for that hour
 * (e.g. hours before v0.9.78 started recording the metric).
 */
async function sampleCurtailmentHour(
  homeDpus: Array<DeviceSnapshot & { projection: DpuProjection }>,
  shp2: DeviceSnapshot & { projection: Shp2Projection },
  recorder: Recorder,
  weather: WeatherForecast | null,
  bayes: BayesianSolarModel,
  hourStart: number,
  hourEnd: number,
  hourOfDay: number,
  currentCeiling: number | null,
): Promise<CurtailmentHour | null> {
  const meanInWindow = (sn: string, metric: string): number | null => {
    const pts = recorder.query(sn, metric, hourStart, hourEnd, 60);
    if (pts.length === 0) return null;
    return pts.reduce((s, p) => s + p.value, 0) / pts.length;
  };

  // SoC: mean across home DPUs over the hour.
  const socs = homeDpus.map((d) => meanInWindow(d.sn, 'soc')).filter((v): v is number => v != null);
  if (socs.length === 0) return null;
  const socAvg = socs.reduce((s, v) => s + v, 0) / socs.length;

  // Per-hour charge ceiling: prefer the recorded chg_max_soc (averaged
  // across the home DPUs that reported it this hour), else the live
  // ceiling, else the legacy fallback. This makes the threshold track the
  // mode that was actually in effect during the historical hour.
  const recordedCeilings = homeDpus
    .map((d) => meanInWindow(d.sn, 'chg_max_soc'))
    .filter((v): v is number => v != null && v > 0);
  const hourCeiling = recordedCeilings.length > 0
    ? recordedCeilings.reduce((s, v) => s + v, 0) / recordedCeilings.length
    : currentCeiling;
  if (socAvg < saturationThresholdPct(hourCeiling)) return null;

  // PV: sum across home DPUs.
  const pvs = homeDpus.map((d) => meanInWindow(d.sn, 'pv_total')).filter((v): v is number => v != null);
  if (pvs.length < homeDpus.length / 2) return null;  // need at least half the home cores reporting
  const pvActualW = pvs.reduce((s, v) => s + v, 0);
  if (pvActualW < CURTAIL_MIN_PV_W) return null;

  // Load: panel_load from the SHP2 over the hour.
  const loadW = meanInWindow(shp2.sn, 'panel_load') ?? 0;

  // Weather-verified path?
  const wh = weather?.hours.find(
    (h) => Math.floor(h.ts / 3_600_000) === Math.floor(hourStart / 3_600_000),
  );
  let expectedW: number | null = null;
  let weatherVerified = false;
  if (wh && wh.radiationWm2 >= CURTAIL_MIN_GHI_WM2) {
    const e = predictExpectedPv(bayes, hourOfDay, wh.radiationWm2);
    if (e) { expectedW = e.w; weatherVerified = true; }
  }
  if (expectedW == null) {
    // Heuristic-only: only count when PV ≈ load (panels throttled to match).
    // Without weather we don't know how clear the day was. The Bayesian μ
    // multiplied by the *historical* typical clear-sky GHI for this hour
    // gives a conservative ceiling on what we'd have produced.
    if (loadW < 100 || pvActualW > loadW * CURTAIL_PV_MATCH_LOAD_FACTOR) return null;
    const post = bayes.hourly.find((h) => h.hour === hourOfDay);
    if (!post || post.samples < CURTAIL_MIN_BAYES_SAMPLES) return null;
    // Approximate typical clear-sky GHI from posteriorMean's inverse:
    // we know μ_W_per_GHI; the observed daily peak PV history implies a
    // typical GHI. Hard-cap at 900 W/m² (Phoenix mid-summer clear-sky
    // ceiling) — over-estimating surplus on a cloudy day is the failure
    // mode we're guarding against.
    expectedW = Math.min(post.posteriorMean * 900, post.posteriorMean * 1000);
  }

  // Weather-verified disqualifier: PV meaningfully exceeds load → not curtailing.
  if (weatherVerified && loadW > 100 && pvActualW > loadW * CURTAIL_PV_MATCH_LOAD_FACTOR) return null;

  const surplusW = expectedW - pvActualW;
  if (surplusW < CURTAIL_MIN_SURPLUS_W) return null;

  const elapsedHrs = (hourEnd - hourStart) / 3_600_000;
  const curtailedKwh = (surplusW / 1000) * elapsedHrs;

  return {
    hour: hourOfDay,
    surplusW: Math.round(surplusW),
    curtailedKwh: Math.round(curtailedKwh * 1000) / 1000,
    socAvg: Math.round(socAvg * 10) / 10,
    pvActualW: Math.round(pvActualW),
    pvExpectedW: Math.round(expectedW),
    loadW: Math.round(loadW),
    weatherVerified,
  };
}

/**
 * Emit a single learned-info alert when curtailment is active. The alert
 * stays on `info` severity (the panel is healthy; we just have nowhere to
 * put the energy) and includes a fact-line with the magnitude + the
 * opportunistic loads that would fit. The alert monitor's debounce
 * handles flapping (a fast-moving cloud shouldn't fire/clear in seconds).
 */
export async function computeCurtailmentAlerts(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<{ id: string; severity: 'info'; category: 'Solar'; device: string; title: string; detail: string; source: 'learned'; facts: Array<{ label: string; value: string }> }[]> {
  try {
    const r = await computeCurtailment(devices, recorder);
    if (!r.active) return [];
    const fits = r.opportunisticLoads.filter((o) => o.fitsInSurplus);
    const fitsLine = fits.length === 0
      ? 'None of the configured opportunistic loads fit this surplus.'
      : `Could absorb with: ${fits.map((o) => `${o.name} (${(o.estimatedW / 1000).toFixed(1)} kW)`).join(', ')}.`;
    // The "full" point is the configured charge ceiling, not 100%. Word the
    // alert so it's clear the batteries are at their *limit*, not at 100%.
    const ceiling = r.current.chargeCeilingPct;
    const ceilingPhrase = ceiling != null
      ? `at their ${ceiling}% charge limit`
      : 'full';
    return [{
      id: 'pv-curtailment-active',
      severity: 'info',
      category: 'Solar',
      device: 'System',
      title: `Solar curtailment — batteries ${ceilingPhrase}`,
      detail:
        `Estimated ${r.currentSurplusW} W of PV is being rejected at the panels: ` +
        `batteries ${ceilingPhrase} (${r.current.socAvg}% SoC), arrays producing ${r.current.pvActualW} W ` +
        `(expected ${r.current.pvExpectedW} W at ${r.current.ghiWm2} W/m² GHI). ${fitsLine} ` +
        `Today's lost-to-curtailment estimate: ${r.todayKwh.toFixed(2)} kWh. ` +
        (ceiling != null && ceiling < 100
          ? `Raising the charge limit (or enabling Storm Guard) would let the pool absorb more before curtailing.`
          : ''),
      source: 'learned',
      facts: [
        { label: 'Surplus', value: `${r.currentSurplusW} W` },
        { label: 'SoC', value: `${r.current.socAvg}%` },
        { label: 'Charge limit', value: ceiling != null ? `${ceiling}%` : 'unknown' },
        { label: 'PV actual', value: `${r.current.pvActualW} W` },
        { label: 'PV expected', value: `${r.current.pvExpectedW ?? '—'} W` },
        { label: 'GHI', value: r.current.ghiWm2 != null ? `${r.current.ghiWm2} W/m²` : '—' },
        { label: 'Today lost', value: `${r.todayKwh.toFixed(2)} kWh` },
        { label: 'Past 7d lost', value: `${r.recent7dKwh.toFixed(2)} kWh` },
        { label: 'Opportunistic fit', value: fits.length === 0 ? 'none' : fits.map((o) => o.name).join(', ') },
      ],
    }];
  } catch {
    return [];
  }
}

/* ===================================================================
 * NWS storm-preparedness signal (v0.7.5).
 *
 * Pulls active alerts.weather.gov alerts within ~50 mi of the panel's
 * configured coordinates and emits a learned-warning to pre-charge to
 * 100% before forecast severe weather. Off by default — opt in with
 * NWS_ENABLED=1 (US-only).
 * =================================================================== */

const STORM_PREP_TTL_MS = 10 * 60 * 1000;
const STORM_SEVERE_EVENTS = new Set([
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Winter Storm Warning',
  'Blizzard Warning',
  'Ice Storm Warning',
  'High Wind Warning',
  'Hurricane Warning',
  'Hurricane Watch',
  'Tropical Storm Warning',
  'Tropical Storm Watch',
  'Flash Flood Warning',
  'Excessive Heat Warning',
]);

let stormPrepCache: { ts: number; value: Alert[] } | null = null;

export async function stormPrepAlerts(_devices: Record<string, DeviceSnapshot>): Promise<Alert[]> {
  if (!isNwsEnabled()) return [];
  if (stormPrepCache && Date.now() - stormPrepCache.ts < STORM_PREP_TTL_MS) return stormPrepCache.value;
  const feed = await getNwsAlerts();
  if (!feed || feed.alerts.length === 0) {
    stormPrepCache = { ts: Date.now(), value: [] };
    return [];
  }
  const out: Alert[] = [];
  for (const a of feed.alerts) {
    const severe = STORM_SEVERE_EVENTS.has(a.event) || a.severity === 'Severe' || a.severity === 'Extreme';
    if (!severe) continue;
    const sev: Alert['severity'] = a.severity === 'Extreme' || a.urgency === 'Immediate' ? 'critical' : 'warning';
    const onsetDate = a.onset ? new Date(a.onset) : null;
    const whenStr = onsetDate
      ? onsetDate.toLocaleString([], { weekday: 'short', hour: 'numeric' })
      : 'soon';
    out.push({
      id: `storm-${a.id || a.event}`.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 96),
      severity: sev,
      category: 'Grid',
      source: 'learned',
      device: 'System',
      title: `${a.event} — pre-charge recommended`,
      detail: `NWS has issued a ${a.event} for ${a.areaDesc ?? 'your area'} ${whenStr}. Charge the backup pool to 100% before onset so grid loss leaves you in a strong position. ${a.headline ?? ''}`,
      facts: [
        { label: 'Event', value: a.event },
        { label: 'Severity', value: a.severity },
        { label: 'Urgency', value: a.urgency },
        { label: 'Onset', value: onsetDate ? onsetDate.toLocaleString() : '—' },
        { label: 'Expires', value: a.expires ? new Date(a.expires).toLocaleString() : '—' },
        { label: 'Area', value: a.areaDesc ?? '—' },
      ],
    });
  }
  stormPrepCache = { ts: Date.now(), value: out };
  return out;
}

export async function getActiveNwsAlerts(): Promise<NwsAlert[]> {
  if (!isNwsEnabled()) return [];
  const feed = await getNwsAlerts();
  return feed?.alerts ?? [];
}

/* ===================================================================
 * v0.8.0 — Sustainability: carbon offset accounting.
 *
 * The two "useful kWh" you produced are PV-direct-to-load and
 * battery-discharge (most of which was originally charged from PV on
 * an off-grid setup). Multiplied by the regional grid CO2 intensity
 * (default: AZ average ≈ 1100 lb/MWh = 0.500 kg/kWh), this is the kg
 * of CO2 you avoided by NOT pulling those kWh from the grid.
 *
 * Lifetime: integrates over the whole self-consumption window plus
 * the lifetime PV counter from the recorder. Configurable via env
 * GRID_CO2_INTENSITY_LB_PER_MWH.
 * =================================================================== */

const CARBON_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GRID_CO2_LB_PER_MWH = Number(process.env.GRID_CO2_INTENSITY_LB_PER_MWH ?? 1100);
// 1 lb/MWh = 0.4536 kg / 1000 kWh = 0.0004536 kg/kWh
const LB_PER_MWH_TO_KG_PER_KWH = 0.4536 / 1000;
// EPA: avg US passenger car emits ~0.404 kg CO2 per mile.
const KG_CO2_PER_MILE = 0.404;

export interface CarbonReport {
  generatedAt: number;
  gridCo2IntensityKgPerKwh: number;
  windowDays: number;
  // Recent rolling window
  pvToLoadKgAvoided: number;
  batteryDischargeKgAvoided: number;
  totalKgAvoided: number;
  equivMilesNotDriven: number;
  // Lifetime (since the persistent lifetime accumulator started recording)
  lifetimePvKwh: number;
  lifetimeKgAvoided: number;
  lifetimeMilesNotDriven: number;
}

let carbonCache: { ts: number; value: CarbonReport } | null = null;

export function computeCarbonReport(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  windowDays = 7,
): CarbonReport {
  if (carbonCache && Date.now() - carbonCache.ts < CARBON_TTL_MS) return carbonCache.value;
  const intensity = DEFAULT_GRID_CO2_LB_PER_MWH * LB_PER_MWH_TO_KG_PER_KWH;
  const sc = computeSelfConsumption(devices, recorder, windowDays);
  const lifetimeTotals = recorder.getLifetimeTotals();
  const pvLifetimeWh =
    (lifetimeTotals['fleet_pv_wh']?.persistedWh ?? 0) +
    (lifetimeTotals['fleet_pv_wh']?.pendingWh ?? 0);
  const pvLifetimeKwh = pvLifetimeWh / 1000;

  const pvToLoadKg = sc.pvToLoadKwh * intensity;
  const batteryDischargeKg = sc.batteryDischargeKwh * intensity;
  const totalKg = pvToLoadKg + batteryDischargeKg;
  const lifetimeKg = pvLifetimeKwh * intensity; // lifetime PV ≈ grid kWh avoided

  const value: CarbonReport = {
    generatedAt: Date.now(),
    gridCo2IntensityKgPerKwh: Math.round(intensity * 10000) / 10000,
    windowDays,
    pvToLoadKgAvoided: round2(pvToLoadKg),
    batteryDischargeKgAvoided: round2(batteryDischargeKg),
    totalKgAvoided: round2(totalKg),
    equivMilesNotDriven: Math.round(totalKg / KG_CO2_PER_MILE),
    lifetimePvKwh: round2(pvLifetimeKwh),
    lifetimeKgAvoided: Math.round(lifetimeKg),
    lifetimeMilesNotDriven: Math.round(lifetimeKg / KG_CO2_PER_MILE),
  };
  carbonCache = { ts: Date.now(), value };
  return value;
}

/* ===================================================================
 * v0.8.0 — TOU tariff cost estimation.
 *
 * Many off-grid setups still draw modest grid power overnight or
 * during winter shoulders. This estimates the dollars actually spent
 * AND the dollars saved (the price you'd have paid for the load you
 * served from solar+battery instead).
 *
 * Hour-of-day on-peak / off-peak windows from env. Defaults are a
 * common APS-Saver-style schedule (3 PM–8 PM on-peak Mon-Fri); set
 * TARIFF_ON_PEAK_HOURS=15-20 + TARIFF_ON_PEAK_DAYS=1-5 to match.
 * =================================================================== */

const TARIFF_TTL_MS = 5 * 60 * 1000;
// v0.9.58 — default to a FLAT rate (the operator's APS plan is flat $0.17/kWh — no TOU
// split). The prior 25¢/8¢ split implied a TOU plan most APS customers don't
// have, which silently overstated both grid-import cost and solar-load value
// during on-peak hours. The on/off-peak logic below is preserved unchanged for
// users who DO have a TOU plan: they can set TARIFF_ON_PEAK_CENTS and
// TARIFF_OFF_PEAK_CENTS independently. For flat-rate users, the single override
// `TARIFF_FLAT_CENTS_PER_KWH` sets both at once.
const TARIFF_FLAT_CENTS = Number(process.env.TARIFF_FLAT_CENTS_PER_KWH ?? 17);
const TARIFF_ON_PEAK_CENTS = Number(process.env.TARIFF_ON_PEAK_CENTS ?? TARIFF_FLAT_CENTS);
const TARIFF_OFF_PEAK_CENTS = Number(process.env.TARIFF_OFF_PEAK_CENTS ?? TARIFF_FLAT_CENTS);
const TARIFF_ON_PEAK_HOURS_ENV = process.env.TARIFF_ON_PEAK_HOURS ?? '15-20';
const TARIFF_ON_PEAK_DAYS_ENV = process.env.TARIFF_ON_PEAK_DAYS ?? '1-5';

/** Exported for tests. */
export function parseRange(s: string): [number, number] | null {
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}
/** Exported for tests. */
export function onPeakAt(ts: number): boolean {
  const d = new Date(ts);
  const h = d.getHours();
  const dow = d.getDay() === 0 ? 7 : d.getDay(); // 1=Mon..7=Sun
  const hourRange = parseRange(TARIFF_ON_PEAK_HOURS_ENV);
  const dayRange = parseRange(TARIFF_ON_PEAK_DAYS_ENV);
  if (!hourRange || !dayRange) return false;
  const [hStart, hEnd] = hourRange;
  const [dStart, dEnd] = dayRange;
  const dayOk = dStart <= dEnd ? dow >= dStart && dow <= dEnd : dow >= dStart || dow <= dEnd;
  const hourOk = hStart <= hEnd ? h >= hStart && h < hEnd : h >= hStart || h < hEnd;
  return dayOk && hourOk;
}

export interface TariffReport {
  generatedAt: number;
  onPeakCents: number;
  offPeakCents: number;
  onPeakHours: string;
  onPeakDays: string;
  // Last 7 days
  windowDays: number;
  gridImportCostDollars: number;
  solarLoadValueDollars: number;     // what you'd have paid had solar+battery not served the load
  netSavingsDollars: number;
  // Today running
  todayGridImportCostDollars: number;
  todaySolarLoadValueDollars: number;
}

let tariffCache: { ts: number; value: TariffReport } | null = null;

export function computeTariffReport(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  windowDays = 7,
): TariffReport {
  if (tariffCache && Date.now() - tariffCache.ts < TARIFF_TTL_MS) return tariffCache.value;
  const now = Date.now();
  const since = now - windowDays * 86_400_000;
  const todayStart = startOfLocalDayMs();

  const dpus = Object.values(devices).filter((d) => d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;

  // v0.9.29 — prefetch each metric ONCE for the full 7-day window at 60 s
  // bucketing; then call integrateWh hourly off the cached array. Was
  // ~960 SQL round-trips per cycle (168 hours × 5 metrics × ~1 each);
  // now (dpus + 1) = 5 round-trips. The hourly integrateWh calls each
  // self-filter to the hour window in O(n) over a single 10 k-row
  // bucketed array, which is well-cached in V8 and runs in microseconds.
  const HOUR = 3_600_000;
  // v0.9.76 — only count grid-import on SHP2-connected DPUs. A spare core
  // charging from a wall outlet shows up in ac_in but isn't house grid
  // usage. Without this filter the on-peak cost dollars include spare-Core
  // bench-charging — small today ($0.40 live) but the bug is real and
  // grows if Cores 4/5 see heavier wall charging.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  const dpuAcInSeries = new Map<string, Array<{ ts: number; value: number }>>();
  for (const d of homeDpus) {
    dpuAcInSeries.set(d.sn, recorder.query(d.sn, 'ac_in', since, now, 60));
  }
  const loadSeries = shp2 ? recorder.query(shp2.sn, 'panel_load', since, now, 60) : [];

  const tally = (sinceMs: number) => {
    let gridCost = 0;
    let loadValue = 0;
    for (let t = sinceMs; t < now; t += HOUR) {
      const tEnd = Math.min(t + HOUR, now);
      const rate = (onPeakAt(t) ? TARIFF_ON_PEAK_CENTS : TARIFF_OFF_PEAK_CENTS) / 100;
      let gridWh = 0;
      let loadWh = 0;
      for (const d of homeDpus) {
        gridWh += integrateWh(dpuAcInSeries.get(d.sn) ?? [], t, tEnd).wh;
      }
      if (shp2) {
        loadWh += integrateWh(loadSeries, t, tEnd).wh;
      }
      gridCost += (gridWh / 1000) * rate;
      loadValue += (loadWh / 1000) * rate;
    }
    return { gridCost, loadValue };
  };

  const windowTally = tally(since);
  const todayTally = tally(todayStart);
  const value: TariffReport = {
    generatedAt: now,
    onPeakCents: TARIFF_ON_PEAK_CENTS,
    offPeakCents: TARIFF_OFF_PEAK_CENTS,
    onPeakHours: TARIFF_ON_PEAK_HOURS_ENV,
    onPeakDays: TARIFF_ON_PEAK_DAYS_ENV,
    windowDays,
    gridImportCostDollars: round2(windowTally.gridCost),
    solarLoadValueDollars: round2(windowTally.loadValue),
    netSavingsDollars: round2(windowTally.loadValue - windowTally.gridCost),
    todayGridImportCostDollars: round2(todayTally.gridCost),
    todaySolarLoadValueDollars: round2(todayTally.loadValue),
  };
  tariffCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * v0.8.0 — Probabilistic forecasts (P10/P50/P90).
 *
 * Today's day-ahead forecast returns a single deterministic line.
 * v0.8.0 derives a percentile distribution per hour from two
 * uncertainty sources:
 *   1) **Cloud variance** — historical cloud-cover stdev for the
 *      same hour-of-day. High-cloud-variance hours get wider bands.
 *   2) **Model residual** — forecast-skill MAE expressed as a
 *      relative fraction. Applied as a constant ±N% band per hour.
 *
 * Combined into a Gaussian-equivalent P10/P50/P90 band per hour, then
 * propagated into the projected-SoC trajectory by simulating low/mid/
 * high PV scenarios in parallel.
 * =================================================================== */

export interface ForecastBand {
  ts: number;
  p10W: number;       // 10th-percentile PV (worst case, cloudy)
  p50W: number;       // median (matches existing forecastPvW)
  p90W: number;       // 90th-percentile (best case, clear)
  p10SocPct: number | null;
  p50SocPct: number | null;
  p90SocPct: number | null;
}

export interface ProbabilisticForecast {
  generatedAt: number;
  hours: ForecastBand[];
  // Confidence summary
  pAboveReservePct: number | null;     // probability projected SoC stays ≥ reserve through 24h
  pFullCharge: number | null;          // probability SoC reaches 100% during the window
  uncertaintyKwhStdev: number;         // typical ±band width over the window (kWh stdev)
}

let probabilisticCache: { ts: number; value: ProbabilisticForecast } | null = null;
const PROB_TTL_MS = 15 * 60 * 1000;

/** Normal-distribution shortcut: P10 ≈ μ−1.282σ, P90 ≈ μ+1.282σ. */
const Z10 = 1.282;

export async function computeProbabilisticForecast(
  forecast: DayForecast | null,
  skill: ForecastSkillReport | null,
): Promise<ProbabilisticForecast> {
  if (probabilisticCache && Date.now() - probabilisticCache.ts < PROB_TTL_MS) return probabilisticCache.value;
  const now = Date.now();
  const empty = (): ProbabilisticForecast => ({
    generatedAt: now, hours: [], pAboveReservePct: null, pFullCharge: null, uncertaintyKwhStdev: 0,
  });
  if (!forecast) return empty();

  const weather = await getWeather();
  // Compute per-hour-of-day cloud variance from any historical weather window
  // we have. Higher variance → wider band.
  const cloudVarByHour: number[] = new Array(24).fill(0.25); // 25% baseline fallback
  if (weather && weather.hours.length > 0) {
    const cloudsByHour: number[][] = Array.from({ length: 24 }, () => []);
    for (const wh of weather.hours) cloudsByHour[new Date(wh.ts).getHours()].push(wh.cloudCoverPct);
    for (let h = 0; h < 24; h++) {
      const arr = cloudsByHour[h];
      if (arr.length < 3) continue;
      const m = arr.reduce((s, v) => s + v, 0) / arr.length;
      const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
      cloudVarByHour[h] = Math.min(0.6, Math.sqrt(v) / 100); // cap at 60% stdev
    }
  }
  // v0.9.2 — per-hour ensemble disagreement (Open-Meteo vs NWS cloud cover)
  // is a direct uncertainty signal: when the two sources disagree by 20pp
  // on tomorrow's cloud cover, our forecast confidence band should widen
  // proportionally. Key by hour-epoch and apply per-hour.
  const disagreeByHourEpoch = new Map<number, number>();
  if (weather) {
    for (const wh of weather.hours) {
      if (wh.ensembleDisagreementPct != null) {
        disagreeByHourEpoch.set(Math.floor(wh.ts / 3_600_000), wh.ensembleDisagreementPct);
      }
    }
  }

  // Model residual fraction: how off the model historically is.
  // If MAE = 20% and we believe it's roughly Gaussian, that ≈ 1σ ≈ 20%.
  const skillFrac = skill?.meanAbsErrorPct != null ? skill.meanAbsErrorPct / 100 : 0.15;

  const reserveSoc = forecast.reserveSoc;
  const bands: ForecastBand[] = [];
  // v0.9.58 — back out the live backup-pool full capacity from the base
  // forecast's own projected SoC trajectory. The forecast was generated against
  // `shp2.projection.backupFullCapWh` via `socWh += (pv - load); socPct = socWh /
  // fullWh * 100`, so for any two consecutive hours where deltaSoc is non-zero
  // and SoC hasn't clamped at 0/100:
  //     fullKwh = (pv - load) [kWh] / (deltaSocPct / 100)
  // Pick the hour with the largest |deltaSocPct| that isn't clamped — that
  // maximises numerical conditioning. If no usable hour exists (e.g. the
  // forecast was generated with no SHP2 projection so projectedSocPct is null
  // throughout), fall back to a fleet estimate: DPU count × 5 packs × 6.144
  // kWh/pack. the operator's ~4 DPUs × 5 × 6.144 ≈ 122.88 kWh — the prior code's
  // hard-coded "1 kWh ≈ 0.5 %" implied a 200 kWh pool (or worse, a single 20
  // kWh DPU) and badly understated the P10/P90 band width.
  const PACK_KWH_NAMEPLATE = 6.144;
  const PACKS_PER_DPU = 5;
  let fullKwh: number | null = null;
  let bestAbsDSocPct = 0;
  for (let i = 1; i < forecast.hours.length; i++) {
    const prev = forecast.hours[i - 1];
    const cur = forecast.hours[i];
    if (prev.projectedSocPct == null || cur.projectedSocPct == null) continue;
    const dSocPct = cur.projectedSocPct - prev.projectedSocPct;
    if (Math.abs(dSocPct) < 0.05) continue;                 // too small to invert reliably
    if (prev.projectedSocPct <= 0.5 || prev.projectedSocPct >= 99.5) continue; // clamped
    if (cur.projectedSocPct <= 0.5 || cur.projectedSocPct >= 99.5) continue;   // clamped
    const kwhDelta = (cur.forecastPvW - cur.forecastLoadW) / 1000;
    if (Math.abs(kwhDelta) < 0.05) continue;
    const candidate = kwhDelta / (dSocPct / 100);           // kWh per 100 % SoC = full capacity
    if (candidate < 5 || candidate > 1000) continue;        // sanity guard
    if (Math.abs(dSocPct) > bestAbsDSocPct) {
      bestAbsDSocPct = Math.abs(dSocPct);
      fullKwh = candidate;
    }
  }
  if (fullKwh == null) {
    const dpuCount = Math.max(1, forecast.deviceModels.length);
    fullKwh = dpuCount * PACKS_PER_DPU * PACK_KWH_NAMEPLATE;
  }
  // Simulate three parallel SoC trajectories starting from the same SoC.
  // We don't know the initial SoC here, but we do know the projected curve
  // from the base forecast — derive starting SoC from the first hour.
  let p10Soc = forecast.hours[0]?.projectedSocPct ?? null;
  let p50Soc = p10Soc;
  let p90Soc = p10Soc;
  let aboveReserveCount = 0;
  let fullChargeCount = 0;
  let stdevAccum = 0;
  // v0.9.59 — anchor the horizon to the first forecast hour so the band-widening
  // multiplier below grows monotonically across the window regardless of when
  // the forecast was generated relative to wall-clock `now`.
  const forecastStartTs = forecast.hours[0]?.ts ?? now;
  for (const h of forecast.hours) {
    const hod = new Date(h.ts).getHours();
    const cloudStdev = cloudVarByHour[hod];
    // v0.9.2 — fold per-hour ensemble disagreement into the band. When
    // Open-Meteo and NWS disagree by N pp on cloud cover, treat that as an
    // additional N/100 fraction of PV uncertainty (proportional contribution).
    const disagreementFrac = (disagreeByHourEpoch.get(Math.floor(h.ts / 3_600_000)) ?? 0) / 100;
    // Wider band when cloud cover varies historically AND when the ensemble
    // disagrees AND when the model itself is biased. Quadrature-sum.
    const baseSigmaFrac = Math.sqrt(
      cloudStdev * cloudStdev + skillFrac * skillFrac + disagreementFrac * disagreementFrac,
    );
    // v0.9.59 — widen the band with horizon. The base sigmaFrac above is
    // entirely "what-time-of-day-is-it" structure; it gives hour-24 the same
    // band as hour-1 even though further-out forecasts are physically less
    // certain (atmospheric chaos compounds with time). Multiply by a sqrt-
    // shaped horizon factor: an h-hours-out forecast carries roughly
    // sqrt(1 + h/24) more uncertainty than the immediate one. Hour 0 stays
    // at 1.0×; hour 24 widens by ~1.41×; a 48-hour horizon by ~1.73×. The
    // sqrt scaling (rather than linear) is the right shape for a random-
    // walk-of-clouds process — variance grows linearly with time, stdev as
    // sqrt(time).
    const horizonHours = Math.max(0, (h.ts - forecastStartTs) / 3_600_000);
    const horizonFactor = Math.sqrt(1 + horizonHours / 24);
    const sigmaFrac = baseSigmaFrac * horizonFactor;
    const p50 = h.forecastPvW;
    const p10 = Math.max(0, p50 * (1 - Z10 * sigmaFrac));
    const p90 = p50 * (1 + Z10 * sigmaFrac);
    // SoC propagation: use the load as deterministic, vary PV.
    const dP10 = (p10 - h.forecastLoadW) / 1000;
    const dP50 = (p50 - h.forecastLoadW) / 1000;
    const dP90 = (p90 - h.forecastLoadW) / 1000;
    void dP50;
    // Convert delta watts to SoC% using the rough pack capacity (whatever
    // resolves the projected p50 trajectory). Derive from the base forecast:
    // if base SoC moved X% under dP50 kWh, that's the conversion factor.
    if (p50Soc != null) {
      const baseNext = h.projectedSocPct;
      // Step the deterministic curve forward without re-deriving it (we trust
      // forecast.hours[i].projectedSocPct as the p50 trajectory).
      p50Soc = baseNext ?? p50Soc;
      // v0.9.58 — scale the (P90-P10) kWh half-range to SoC% via the live full
      // capacity backed out from the deterministic projection above. Was:
      //   socStepPct = socStep * 5   // implied ~20 kWh pack — wrong for a
      //                              // ~120 kWh fleet, badly narrow bands.
      const socStep = (dP90 - dP10) / 2; // kWh half-range
      const socStepPct = (socStep / fullKwh) * 100;
      p10Soc = Math.max(0, (p50Soc ?? 0) - socStepPct);
      p90Soc = Math.min(100, (p50Soc ?? 0) + socStepPct);
    }
    if (p10Soc != null && p10Soc >= reserveSoc) aboveReserveCount++;
    if (p90Soc != null && p90Soc >= 99) fullChargeCount++;
    stdevAccum += sigmaFrac * p50;
    bands.push({
      ts: h.ts,
      p10W: Math.round(p10), p50W: Math.round(p50), p90W: Math.round(p90),
      p10SocPct: p10Soc != null ? Math.round(p10Soc * 10) / 10 : null,
      p50SocPct: p50Soc != null ? Math.round(p50Soc * 10) / 10 : null,
      p90SocPct: p90Soc != null ? Math.round(p90Soc * 10) / 10 : null,
    });
  }
  const total = bands.length || 1;
  const value: ProbabilisticForecast = {
    generatedAt: now,
    hours: bands,
    pAboveReservePct: Math.round((aboveReserveCount / total) * 100),
    pFullCharge: Math.round((fullChargeCount / total) * 100),
    uncertaintyKwhStdev: Math.round((stdevAccum / 1000) * 100) / 100,
  };
  probabilisticCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * v0.8.0 — Counterfactual alert explanations & root-cause graph.
 *
 * Static causal DAG, hand-curated from the EcoFlow LFP architecture:
 *
 *    cell imbalance ─┐
 *    high cell temp ─┼─► fade rate ──► capacity loss ──► EOL
 *    high R         ─┘
 *
 *    high MPPT temp ──► MPPT efficiency drop ──► PV underperformance
 *    high cloud cover ──► PV shortfall ──► low forecast
 *    high load ──► load anomaly ──► low forecast
 *
 *    grid disconnect ──► off-grid → battery draw ──► reserve depletion
 *
 * The traversal walks an alert ID backwards through the DAG to surface
 * likely upstream causes the user might want to investigate.
 * =================================================================== */

interface CauseLink { from: string; to: string; description: string; }

const CAUSE_GRAPH: CauseLink[] = [
  { from: 'peer-temp-hot', to: 'fade-rate', description: 'persistent thermal stress accelerates capacity fade' },
  { from: 'peer-volt-diff', to: 'fade-rate', description: 'cell imbalance correlates with cell-level damage' },
  { from: 'forecast-imbalance', to: 'fade-rate', description: 'trending cell-spread predicts pack wear' },
  { from: 'soh-projection', to: 'eol', description: 'sustained SoH fade dates the end-of-life' },
  { from: 'forecast-low-solar', to: 'forecast-soc-dip', description: 'forecast shortfall pulls down the projected SoC trajectory' },
  { from: 'soiling-pv', to: 'forecast-low-solar', description: 'soiled panels reduce per-W/m² output, lowering the forecast' },
  { from: 'mppt-temp-hot', to: 'mppt-efficiency-drop', description: 'hot MPPTs lose conversion efficiency' },
  { from: 'mppt-efficiency-drop', to: 'forecast-low-solar', description: 'lower conversion efficiency reduces realised PV' },
  { from: 'baseline-pv', to: 'soiling-pv', description: 'a per-hour PV anomaly may be early-stage soiling' },
  { from: 'baseline-load', to: 'forecast-soc-dip', description: 'unusually high load reduces the projected SoC trajectory' },
  { from: 'storm-prep', to: 'forecast-soc-dip', description: 'forecast storms degrade tomorrow\'s solar generation' },
  { from: 'cloud-session-stale', to: 'offline', description: 'a stale EcoFlow cloud session can mask devices as offline' },
];

/** Walk the DAG one hop backwards from an alert ID, return upstream cause IDs and their descriptions. */
export function rootCausesFor(alertId: string): Array<{ id: string; description: string }> {
  // Match alert by ID prefix family (alert IDs include device-specific suffixes).
  const family = alertId.split('-').slice(0, 2).join('-');
  const reverse: Array<{ id: string; description: string }> = [];
  for (const link of CAUSE_GRAPH) {
    if (link.to === family || alertId.startsWith(link.to + '-') || link.to === alertId) {
      reverse.push({ id: link.from, description: link.description });
    }
  }
  return reverse;
}

/* ===================================================================
 * v0.8.0 — Multi-day forecast horizon.
 *
 * Open-Meteo's free tier supports up to forecast_days=16. We extend
 * the 24h horizon to 3 days with per-day rollups (PV kWh, load kWh,
 * min projected SoC + ts) so the UI can show "tomorrow ⨯ Tue ⨯ Wed".
 * =================================================================== */

export interface DayRollup {
  date: string;
  pvKwh: number;
  loadKwh: number;
  minProjectedSoc: number | null;
  minProjectedSocTs: number | null;
}

export interface MultiDayForecast {
  generatedAt: number;
  days: DayRollup[];
}

let multiDayCache: { ts: number; value: MultiDayForecast } | null = null;
const MULTI_DAY_TTL_MS = 30 * 60 * 1000;

export async function computeMultiDayForecast(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  forecast: DayForecast | null,
  horizonDays = 3,
): Promise<MultiDayForecast> {
  if (multiDayCache && Date.now() - multiDayCache.ts < MULTI_DAY_TTL_MS) return multiDayCache.value;
  const now = Date.now();
  const empty = (): MultiDayForecast => ({ generatedAt: now, days: [] });
  if (!forecast) return empty();
  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHour = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHour.set(Math.floor(wh.ts / 3_600_000), wh);

  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const fullWh = shp2?.projection.backupFullCapWh ?? null;
  let socWh = shp2?.projection.backupRemainWh ?? null;

  // v0.9.58 — index the day-ahead forecast's load curve by hour-of-day. Was:
  //   const load = forecast.hours[0]?.forecastLoadW ?? 0;
  // which held the load constant at hour-0's value for EVERY hour of the
  // 3-day horizon. With hour-0 typically a low-load overnight slot (~800 W),
  // total day load came out to ~19 kWh — vs the operator's real 30-90 kWh daily
  // load. The forecast.hours[] entries are ordered chronologically starting
  // from `Math.ceil(now / 3_600_000)` (see getDayForecast), so we can't index
  // by `[h % 24]` directly; build an explicit hour-of-day lookup and fall
  // back to the chronological first hour for any HoD slot the 24-h forecast
  // window doesn't cover.
  const loadByHod = new Array(24).fill(0);
  const loadHodFilled = new Array(24).fill(false);
  for (const fh of forecast.hours) {
    const hod = new Date(fh.ts).getHours();
    if (!loadHodFilled[hod]) {
      loadByHod[hod] = fh.forecastLoadW;
      loadHodFilled[hod] = true;
    }
  }
  const fallbackLoad = forecast.hours[0]?.forecastLoadW ?? 0;

  const days: DayRollup[] = [];
  const todayStart = startOfLocalDayMs();
  for (let dayIdx = 0; dayIdx < horizonDays; dayIdx++) {
    const dayStart = todayStart + dayIdx * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    let pvWh = 0;
    let loadWh = 0;
    let minSoc: number | null = null;
    let minSocTs: number | null = null;
    for (let t = dayStart; t < dayEnd; t += 3_600_000) {
      if (t < now && dayIdx === 0) continue; // skip past hours today
      const wx = wxByHour.get(Math.floor(t / 3_600_000));
      const hod = new Date(t).getHours();
      const resp = forecast.solarModel.hourly[hod];
      let pv = 0;
      if (resp.coeff != null && wx) {
        pv = Math.min(resp.coeff * wx.radiationWm2, resp.observedMaxPvW * 1.05);
      }
      // v0.9.58 — per-HoD load (see loadByHod above), not constant-from-hour-0.
      const load = loadHodFilled[hod] ? loadByHod[hod] : fallbackLoad;
      pvWh += pv;
      loadWh += load;
      if (fullWh && fullWh > 0 && socWh != null) {
        socWh = Math.max(0, Math.min(fullWh, socWh + (pv - load)));
        const socPct = (socWh / fullWh) * 100;
        if (minSoc == null || socPct < minSoc) {
          minSoc = socPct;
          minSocTs = t;
        }
      }
    }
    const date = new Date(dayStart);
    days.push({
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      pvKwh: Math.round(pvWh / 100) / 10,
      loadKwh: Math.round(loadWh / 100) / 10,
      minProjectedSoc: minSoc != null ? Math.round(minSoc * 10) / 10 : null,
      minProjectedSocTs: minSocTs,
    });
  }
  const value: MultiDayForecast = { generatedAt: now, days };
  multiDayCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * v0.8.0 — Energy dispatch planner (compute-only).
 *
 * Greedy 24h hour-by-hour schedule given forecast PV + load + tariff
 * + current SoC + reserve floor. For each hour:
 *
 *   - If PV > load:  charge battery with the surplus (up to full).
 *   - If PV < load AND we're on-peak: discharge battery (down to reserve).
 *   - If PV < load AND we're off-peak AND SoC < target_pre_peak: import grid.
 *   - Otherwise: discharge battery.
 *
 * Output is a recommended schedule — DO NOT auto-apply. Surfacing
 * only; user can mirror these decisions manually via the EcoFlow
 * mobile app or HA automations.
 * =================================================================== */

export interface DispatchHour {
  ts: number;
  pvW: number;
  loadW: number;
  socStartPct: number;
  socEndPct: number;
  onPeak: boolean;
  action: 'charge_from_pv' | 'discharge_to_load' | 'grid_import' | 'hold';
  flowW: number;          // magnitude of the chosen flow
  hourlyCostDollars: number;
}

export interface DispatchPlan {
  generatedAt: number;
  horizon: number;
  hours: DispatchHour[];
  estimatedSavingsDollars: number;   // vs a "all-grid" baseline
  targetPrePeakSocPct: number;       // SoC target before peak hours
}

let dispatchCache: { ts: number; value: DispatchPlan } | null = null;
const DISPATCH_TTL_MS = 30 * 60 * 1000;

export function computeDispatchPlan(
  devices: Record<string, DeviceSnapshot>,
  forecast: DayForecast | null,
): DispatchPlan {
  if (dispatchCache && Date.now() - dispatchCache.ts < DISPATCH_TTL_MS) return dispatchCache.value;
  const now = Date.now();
  const empty = (): DispatchPlan => ({
    generatedAt: now, horizon: 0, hours: [], estimatedSavingsDollars: 0, targetPrePeakSocPct: 80,
  });
  if (!forecast) return empty();
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const fullKwh = shp2?.projection.backupFullCapWh != null ? shp2.projection.backupFullCapWh / 1000 : null;
  let socKwh = shp2?.projection.backupRemainWh != null ? shp2.projection.backupRemainWh / 1000 : null;
  const reservePct = shp2?.projection.backupReserveSoc ?? 15;
  if (!fullKwh || socKwh == null) return empty();
  const reserveKwh = (fullKwh * reservePct) / 100;
  const targetPrePeakSocPct = 80;
  const targetPrePeakKwh = (fullKwh * targetPrePeakSocPct) / 100;

  const hours: DispatchHour[] = [];
  let allGridCost = 0;
  let plannedCost = 0;
  for (const h of forecast.hours) {
    const pvKwh = h.forecastPvW / 1000;
    const loadKwh = h.forecastLoadW / 1000;
    const onPeak = onPeakAt(h.ts);
    const rate = (onPeak ? TARIFF_ON_PEAK_CENTS : TARIFF_OFF_PEAK_CENTS) / 100;
    const socStartPct = (socKwh / fullKwh) * 100;

    let action: DispatchHour['action'] = 'hold';
    let flowKwh = 0;
    let hourlyCost = 0;

    if (pvKwh > loadKwh) {
      // Surplus PV → charge battery
      const surplus = pvKwh - loadKwh;
      const room = fullKwh - socKwh;
      flowKwh = Math.min(surplus, room);
      socKwh += flowKwh;
      action = 'charge_from_pv';
    } else {
      // Deficit
      const deficit = loadKwh - pvKwh;
      if (onPeak && socKwh - deficit >= reserveKwh) {
        // Discharge battery during peak hours (saves the most $)
        flowKwh = deficit;
        socKwh -= flowKwh;
        action = 'discharge_to_load';
      } else if (!onPeak && socKwh < targetPrePeakKwh) {
        // Off-peak charge from grid to top off before peak
        const need = Math.min(deficit + (targetPrePeakKwh - socKwh) * 0.1, deficit + 1);
        hourlyCost = need * rate;
        action = 'grid_import';
        flowKwh = need;
        socKwh = Math.min(fullKwh, socKwh + (need - deficit));
      } else if (socKwh - deficit >= reserveKwh) {
        flowKwh = deficit;
        socKwh -= flowKwh;
        action = 'discharge_to_load';
      } else {
        // Forced grid import (battery at reserve)
        hourlyCost = deficit * rate;
        action = 'grid_import';
        flowKwh = deficit;
      }
    }
    allGridCost += loadKwh * rate;
    plannedCost += hourlyCost;
    hours.push({
      ts: h.ts,
      pvW: h.forecastPvW,
      loadW: h.forecastLoadW,
      socStartPct: Math.round(socStartPct * 10) / 10,
      socEndPct: Math.round((socKwh / fullKwh) * 1000) / 10,
      onPeak,
      action,
      flowW: Math.round(flowKwh * 1000),
      hourlyCostDollars: round2(hourlyCost),
    });
  }
  const value: DispatchPlan = {
    generatedAt: now,
    horizon: hours.length,
    hours,
    estimatedSavingsDollars: round2(allGridCost - plannedCost),
    targetPrePeakSocPct,
  };
  dispatchCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * v0.9.0 — Bayesian recursive GHI→PV update (per hour-of-day).
 *
 * The OLS approach in buildSolarResponse fits a coefficient β per
 * hour over a rolling window of (GHI, PV) pairs. That works, but
 * the uncertainty it reports (Pearson r² and sample count) isn't a
 * proper credible interval, and a new bad sample distorts the
 * coefficient more than it should at high sample counts.
 *
 * This replaces that with a recursive Bayesian update: prior on β
 * is Gaussian N(μ, τ²); each new observation (GHI=g, PV=p) with
 * observation noise σ² yields the conjugate posterior
 *
 *   1/τ_new² = 1/τ² + g²/σ²
 *   μ_new    = τ_new² · (μ/τ² + g·p/σ²)
 *
 * — closed form, no matrix algebra needed. The 95% credible interval
 * for β is μ ± 1.96·τ. Samples just naturally accumulate; no rolling
 * window needed. Weak prior (large τ²) means the first observation
 * dominates; later observations refine.
 *
 * Computed lazily from the recorder's full history per call (we
 * don't persist the posterior — recomputing from raw samples lets
 * us survive recorder DB resets cleanly).
 * =================================================================== */

export interface BayesianHourPosterior {
  hour: number;
  posteriorMean: number;       // μ — point estimate (W per W/m²)
  posteriorStdev: number;      // τ — uncertainty on β
  ci95Low: number;             // μ − 1.96τ
  ci95High: number;            // μ + 1.96τ
  samples: number;
}

export interface BayesianSolarModel {
  generatedAt: number;
  hourly: BayesianHourPosterior[];
  // Aggregate fit-quality summary
  totalSamples: number;
  medianStdev: number;
  // Comparison with the legacy OLS model so consumers can spot disagreement
  agreementWithOls: number;    // 0-1 fraction of hours within 1σ of OLS coeff
}

const BAYES_TTL_MS = 30 * 60 * 1000;
const BAYES_HISTORY_MS = 60 * 24 * 60 * 60 * 1000;
const BAYES_PRIOR_MU = 0;        // start from "no clue"
const BAYES_PRIOR_TAU2 = 1000;   // huge prior variance → first obs dominates
// v0.9.59 — observation noise re-derived from the actual fleet PV signal scale.
// The v0.9.0 placeholder (σ² = 50 → σ ≈ 7 W stdev) was off by ~2.5 orders of
// magnitude relative to the real signal (0..16,800 W nameplate). At σ ≈ 7 W
// each new observation effectively pins the posterior to itself: the
// information weight g²/σ² for a daylight GHI of 500 W/m² becomes 500²/50 = 5 000,
// which swamps any prior precision in a single update and collapses the
// posterior onto the latest sample. That defeats the whole point of the
// recursive Bayesian filter.
//
// Physical re-tune: pick σ as a fixed FRACTION of nameplate, on the theory
// that a "typical" daylight-hour PV residual (modeled minus measured) is a
// few percent to ~10% of peak — clouds, soiling, thermal derate, MPPT
// imperfections. 10% of the operator's 16.8 kW array → σ ≈ 1 680 W → σ² ≈ 2.82e6.
// Same g=500 W/m² update now contributes precision 500²/2.82e6 ≈ 0.089, so
// the prior (1/1000 = 0.001) is overwritten over dozens of observations
// rather than a single one. That's how the filter is meant to behave.
export const BAYES_OBS_SIGMA2 = (0.10 * PHOENIX_SITE.pNamplate) ** 2;
// ≈ 2.82e6 for the operator's ~16.8 kWp; σ ≈ 1 680 W (10% of peak PV output).

let bayesCache: { ts: number; value: BayesianSolarModel } | null = null;

/** Recursive Bayesian update of N(μ, τ²) by an observation (g, p) with noise σ². */
export function bayesUpdate(mu: number, tau2: number, g: number, p: number, sigma2: number): { mu: number; tau2: number } {
  const newPrec = 1 / tau2 + (g * g) / sigma2;
  const newTau2 = 1 / newPrec;
  const newMu = newTau2 * (mu / tau2 + (g * p) / sigma2);
  return { mu: newMu, tau2: newTau2 };
}

export async function computeBayesianSolarModel(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<BayesianSolarModel> {
  if (bayesCache && Date.now() - bayesCache.ts < BAYES_TTL_MS) return bayesCache.value;
  const now = Date.now();
  const since = now - BAYES_HISTORY_MS;
  const empty = (): BayesianSolarModel => ({
    generatedAt: now, hourly: [], totalSamples: 0, medianStdev: 0, agreementWithOls: 0,
  });
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  if (dpus.length === 0) return empty();

  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHourEpoch = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHourEpoch.set(Math.floor(wh.ts / 3_600_000), wh);

  // Fleet PV per hour-epoch. v0.9.76 — Bayesian posterior is the
  // home's GHI→PV response; including a spare's bench-charge PV would
  // bias the prior shift away from what the connected arrays produce.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));
  const fleetPvByEpoch = new Map<number, number>();
  for (const d of homeDpus) {
    const pvE = pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now);
    for (const [he, pv] of pvE) fleetPvByEpoch.set(he, (fleetPvByEpoch.get(he) ?? 0) + pv);
  }

  // Per hour-of-day: start from the prior, fold in observations in time order.
  const byHour: Array<{ mu: number; tau2: number; samples: number }> =
    Array.from({ length: 24 }, () => ({ mu: BAYES_PRIOR_MU, tau2: BAYES_PRIOR_TAU2, samples: 0 }));

  const entries = [...fleetPvByEpoch.entries()].sort((a, b) => a[0] - b[0]);
  for (const [he, pv] of entries) {
    const wx = wxByHourEpoch.get(he);
    if (!wx || wx.radiationWm2 < DAYLIGHT_GHI) continue;
    const hod = new Date(he * 3_600_000).getHours();
    const s = byHour[hod];
    const updated = bayesUpdate(s.mu, s.tau2, wx.radiationWm2, pv, BAYES_OBS_SIGMA2);
    s.mu = updated.mu;
    s.tau2 = updated.tau2;
    s.samples++;
  }

  // Compare with the OLS solar model (which also runs on the same history)
  // so consumers know when the two disagree.
  let agreement = 0;
  let agreementDenom = 0;
  const olsForCompare = buildSolarResponse(fleetPvByEpoch, new Map([...wxByHourEpoch.entries()].map(([k, v]) => [k, v.radiationWm2])));
  const hourly: BayesianHourPosterior[] = [];
  let totalSamples = 0;
  const stdevs: number[] = [];
  for (let h = 0; h < 24; h++) {
    const s = byHour[h];
    if (s.samples < 2) continue;
    const stdev = Math.sqrt(s.tau2);
    hourly.push({
      hour: h,
      posteriorMean: round2(s.mu),
      posteriorStdev: round2(stdev),
      ci95Low: round2(s.mu - 1.96 * stdev),
      ci95High: round2(s.mu + 1.96 * stdev),
      samples: s.samples,
    });
    totalSamples += s.samples;
    stdevs.push(stdev);
    const olsCoeff = olsForCompare.hourly[h]?.coeff;
    if (olsCoeff != null) {
      agreementDenom++;
      if (Math.abs(olsCoeff - s.mu) <= stdev) agreement++;
    }
  }
  const value: BayesianSolarModel = {
    generatedAt: now,
    hourly,
    totalSamples,
    medianStdev: stdevs.length ? round2(median(stdevs)) : 0,
    agreementWithOls: agreementDenom > 0 ? round2(agreement / agreementDenom) : 0,
  };
  bayesCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * v0.9.0 — Kalman filter for pack SoH + drift rate.
 *
 * Replaces the OLS regression in analysePack with a proper 2-state
 * Kalman filter (state = [SoH, dSoH/dt]) under a constant-velocity
 * transition model. BMS-reported SoH is the observation.
 *
 *   x_{t+1} = F · x_t + w,  w ~ N(0, Q)
 *   z_t     = H · x_t + v,  v ~ N(0, R)
 *   F = [[1, dt], [0, 1]],  H = [1, 0]
 *
 * The filter integrates all observations in time order, returning
 * the final smoothed state + covariance. The slope `dSoH/dt`
 * extracted from the posterior is the estimated fade rate, with
 * uncertainty derived directly from the posterior covariance — no
 * t-statistic approximation.
 *
 * Process noise Q is tuned to reflect "SoH drifts slowly"; observation
 * noise R is tuned to the BMS's ~0.5 % SoH reporting jitter.
 * =================================================================== */

// Time unit: DAYS internally so dt stays O(1) — using ms gave dt² ~ 1e16,
// which blew up the F·P·Fᵀ predict step and made the off-diagonal covariance
// too small to couple rate updates with SoH observations.
const KALMAN_MS_PER_DAY = 24 * 60 * 60 * 1000;
const KALMAN_DAYS_PER_YEAR = 365.25;
// Q (process noise) per-day variance:
const KALMAN_Q_SOH = 1e-4;            // ~ (0.01% SoH change per day not explained by drift)
const KALMAN_Q_RATE_PER_DAY = 1e-7;   // ~ ( ±√1e-7 = 3e-4 %/day stdev wander per day)
// R (observation noise) variance — BMS reports ~ ±0.5 %, so R ≈ 0.25
// v0.9.59 — corrected for bucket-averaged inputs. `analysePack` feeds the
// filter pack-SoH samples that have already been averaged over 6-hour buckets
// (DEGRADE_BUCKET_SEC = 21 600 s, see line ~1061) by the SQL GROUP BY in
// recorder.queryMulti — each "sample" passed to kalmanFilterSoh is therefore
// the mean of ~360 raw 60-second observations (6 h × 60 min / 1 min per sample).
//
// For independent observations the variance of the mean shrinks by 1/N, so
// the true variance of each bucket-averaged sample is ~0.25 / 360 ≈ 7e-4 —
// roughly 350× smaller than the raw-observation R. In practice the raw
// samples within a bucket are NOT fully independent (the BMS-reported SoH
// only changes meaningfully across cycles, not seconds), so the effective
// variance reduction is much less than the theoretical bound.
//
// We use R = 0.05 — 5× smaller than the raw R, deliberately conservative
// versus the 350× theoretical floor. This gives the filter the extra
// confidence it deserves on bucket-averaged inputs (driftPerYearStdev now
// shrinks proportionally as more buckets arrive) without trusting the
// inputs so much that a single noisy bucket whip-saws the smoothed SoH.
//
// The alternative — feeding raw 60-second points + R = 0.25 — would be
// strictly more correct but a much larger refactor (60-day raw history for
// ~20 packs is ~17 M rows per pass, vs. ~480 buckets today). Deferred.
const KALMAN_R_OBS = 0.05;
// Initial covariance — broad enough that early observations dominate but not
// so broad that the predict step blows up.
const KALMAN_INIT_VAR_SOH = 100;        // (10% prior stdev — first obs anchors quickly)
const KALMAN_INIT_VAR_RATE_PER_DAY = 0.01; // (0.1 %/day stdev = ~36 %/yr — broad)

export interface KalmanSohResult {
  smoothedSoh: number | null;             // posterior mean of SoH at last sample
  smoothedSohVar: number | null;
  driftPerYear: number | null;            // posterior mean of dSoH/dt scaled to %/yr
  driftPerYearStdev: number | null;
  samples: number;
  observationVariance: number;            // R used
}

/**
 * 2-state Kalman with constant-velocity transition over the SoH/fade-rate
 * state. Returns the final posterior. Operates internally in DAYS for
 * numerical conditioning — input timestamps are still ms.
 */
export function kalmanFilterSoh(pts: Array<{ ts: number; value: number }>): KalmanSohResult | null {
  if (pts.length < 3) return null;
  // Initial state: take the first observation as SoH; zero drift.
  let x0 = pts[0].value;
  let x1 = 0; // dSoH per DAY
  // Initial covariance.
  let p00 = KALMAN_INIT_VAR_SOH;
  let p01 = 0;
  let p10 = 0;
  let p11 = KALMAN_INIT_VAR_RATE_PER_DAY;
  let lastTs = pts[0].ts;

  for (let i = 1; i < pts.length; i++) {
    const ts = pts[i].ts;
    const dtMs = ts - lastTs;
    if (dtMs <= 0) continue;
    lastTs = ts;
    const dt = dtMs / KALMAN_MS_PER_DAY;

    // Predict — apply constant-velocity transition F = [[1, dt], [0, 1]].
    x0 = x0 + dt * x1;
    //   F P     = [[p00 + dt*p10, p01 + dt*p11], [p10, p11]]
    //   F P F^T = [[(p00 + dt*p10) + dt*(p01 + dt*p11), (p01 + dt*p11)], [p10 + dt*p11, p11]]
    const np00 = p00 + dt * p10 + dt * (p01 + dt * p11);
    const np01 = p01 + dt * p11;
    const np10 = p10 + dt * p11;
    const np11 = p11;
    // Process noise scales with dt (the longer the gap, the more uncertainty
    // we accumulate). Using dt as a multiplier instead of treating Q as a
    // per-step constant.
    p00 = np00 + KALMAN_Q_SOH * dt;
    p01 = np01;
    p10 = np10;
    p11 = np11 + KALMAN_Q_RATE_PER_DAY * dt;

    // Update — H = [1, 0], so innovation = z − x0; S = p00 + R; K = [p00, p10] / S
    const z = pts[i].value;
    const y = z - x0;
    const S = p00 + KALMAN_R_OBS;
    if (S <= 0) continue;
    const k0 = p00 / S;
    const k1 = p10 / S;
    x0 = x0 + k0 * y;
    x1 = x1 + k1 * y;
    // P = (I − K H) P. K H = [[k0, 0], [k1, 0]] so (I − KH) = [[1 − k0, 0], [−k1, 1]]
    // v0.9.58 — fix p10 asymmetry. With H = [1, 0], the closed-form covariance
    // update collapses to:
    //   p00 ← (1 − k0) p00
    //   p01 ← (1 − k0) p01
    //   p10 ← (1 − k0) p10           ← was `−k1 · p00 + p10` (asymmetric, wrong)
    //   p11 ← p11 − k1 · p01
    // The prior `−k1·p00 + p10` form is what you'd get by expanding
    // (I − KH) row-by-row WITHOUT canceling the zero column of KH on the
    // right; it left p10 drifting away from p01 step after step. Over hundreds
    // of Kalman updates that asymmetry compounded into an overconfident EOL
    // projection (drift uncertainty understated, smoothed SoH biased high).
    // p01 already updates correctly via the (1 − k0)·p01 line above — it's
    // the symmetric partner.
    const up00 = (1 - k0) * p00;
    const up01 = (1 - k0) * p01;
    const up10 = (1 - k0) * p10;
    const up11 = -k1 * p01 + p11;
    p00 = up00; p01 = up01; p10 = up10; p11 = up11;
  }

  return {
    smoothedSoh: round2(x0),
    smoothedSohVar: round2(p00),
    driftPerYear: round2(x1 * KALMAN_DAYS_PER_YEAR),
    driftPerYearStdev: round2(Math.sqrt(Math.max(0, p11)) * KALMAN_DAYS_PER_YEAR),
    samples: pts.length,
    observationVariance: KALMAN_R_OBS,
  };
}

/* ===================================================================
 * v0.9.0 — PackRiskScore (heuristic-weighted v1).
 *
 * NOT a trained ML model — we don't have a labeled dataset of pack
 * failures. This is a hand-tuned weighted sum of engineered risk
 * features, calibrated against domain knowledge of LFP failure modes.
 * The output API is the same shape a trained classifier would yield
 * (0-100 score, tier, contributing factors), so a model swap-in is
 * a drop-in replacement later.
 *
 * Features (each normalized to 0..1 where 1 = high risk):
 *   - Peer fade ratio (this pack vs fleet-median fade rate)
 *   - Internal-R trend (mΩ/month — rising R precedes SoH decay)
 *   - Coulombic efficiency (% — falling CE = side reactions)
 *   - Thermal hard-life score (per-year — Arrhenius-equivalent stress)
 *   - Charge-curve drift (mV at SoC checkpoints — voltage plateau aging)
 *   - Capacity fade rate (%/yr — direct SoH erosion)
 *
 * Weighted-sum + sigmoid → 0..100. Tier breakpoints chosen so most
 * healthy packs sit < 25 (low) and a clearly-failing pack sits > 75
 * (critical). The exposed `contributingFactors` list lets the user
 * see WHY their score is what it is — model interpretability matters
 * even more for a heuristic than for a trained model.
 * =================================================================== */

export interface RiskFactor {
  name: string;
  rawValue: number | null;
  rawUnit: string;
  normalized01: number;
  weight: number;
  weightedScore: number;        // normalized × weight × 100, signed
  comment: string;
}

export interface PackRiskScore {
  sn: string;
  device: string;
  coreNum: number | null;
  packNum: number;
  score0to100: number;
  tier: 'low' | 'moderate' | 'elevated' | 'critical' | 'no-data';
  topFactors: RiskFactor[];      // sorted by weightedScore desc; up to 3
  allFactors: RiskFactor[];
  generatedAt: number;
  modelVersion: string;          // "heuristic-v1" — for swap-in tracking
}

export interface FleetRiskReport {
  generatedAt: number;
  modelVersion: string;
  packs: PackRiskScore[];
}

/** Clamp x into [0, 1]. */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

let riskCache: { ts: number; value: FleetRiskReport } | null = null;
const RISK_TTL_MS = 30 * 60 * 1000;
const RISK_MODEL_VERSION = 'heuristic-v1';

export function computePackRiskScores(
  devices: Record<string, DeviceSnapshot>,
  degradation: FleetDegradation,
  thermalEvents: FleetThermalEvents,
  internalR: InternalResistanceReport,
  chargeCurve: ChargeCurveReport,
): FleetRiskReport {
  if (riskCache && Date.now() - riskCache.ts < RISK_TTL_MS) return riskCache.value;
  const now = Date.now();
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu',
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;

  // Build a lookup of features per (sn, packNum).
  const out: PackRiskScore[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      const sn = d.sn;
      const packNum = pk.num;

      // Look up each feature source
      const deg = degradation.packs.find((p) => p.sn === sn && p.packNum === packNum);
      const therm = thermalEvents.packs.find((p) => p.sn === sn && p.packNum === packNum);
      const ir = internalR.devices.find((p) => p.sn === sn); // bus-level (DPU), shared by all packs on a DPU
      const cc = chargeCurve.packs.find((p) => p.sn === sn && p.packNum === packNum);

      // Feature 1: peer fade ratio. 1.0 = average; >1.5 = bad.
      // Normalization: clamp(((ratio - 1) / 1.0), 0, 1). So ratio=2 → 1.0; ratio=1 → 0.
      const peerFade = deg?.peerFadeRatio ?? null;
      const peerFadeNorm = peerFade != null ? clamp01((peerFade - 1) / 1.0) : 0;

      // Feature 2: internal-R trend (mΩ per month). A rising trend > 1 mΩ/month is bad.
      const rTrend = ir?.trendMilliohmsPerMonth ?? null;
      const rTrendNorm = rTrend != null ? clamp01(rTrend / 3) : 0;  // 3 mΩ/mo = max risk

      // Feature 3: coulombic efficiency. Healthy ≥ 99.0%; below 98% = bad.
      const ce = deg?.coulombicEffPct ?? null;
      const ceNorm = ce != null ? clamp01((99 - ce) / 2) : 0;  // 97% = max risk

      // Feature 4: thermal hard-life score. 0 = ideal; > 200/yr = bad.
      const hardLife = therm?.hardLifeScore ?? null;
      const hardLifeNorm = hardLife != null ? clamp01(hardLife / 300) : 0;

      // Feature 5: charge-curve mean drift (mV). 0 = baseline; > 30 mV = aging.
      const ccDrift = cc?.meanDriftMv ?? null;
      const ccDriftNorm = ccDrift != null ? clamp01(Math.abs(ccDrift) / 50) : 0;

      // Feature 6: capacity fade rate (%/yr). Healthy < 2 %/yr; > 5 %/yr = bad.
      const fade = deg?.fadePctPerYear ?? null;
      const fadeNorm = fade != null ? clamp01((fade - 1) / 5) : 0;

      // Weights — sum to 1. Reflects domain priors:
      //   - Peer-fade ratio is the strongest single signal (peers control for fleet drift)
      //   - Internal-R + coulombic-eff are early warnings (lead SoH decay)
      //   - Thermal hard-life is a multiplier on all the above
      const weights = {
        peerFade: 0.25,
        rTrend: 0.15,
        ce: 0.15,
        hardLife: 0.15,
        ccDrift: 0.10,
        fade: 0.20,
      };

      const factors: RiskFactor[] = [
        {
          name: 'Peer-fade ratio',
          rawValue: peerFade,
          rawUnit: '×',
          normalized01: peerFadeNorm,
          weight: weights.peerFade,
          weightedScore: peerFadeNorm * weights.peerFade * 100,
          comment: peerFade == null
            ? 'no fleet-comparison data yet'
            : peerFade > 1.5 ? 'fading much faster than peers'
            : peerFade > 1.2 ? 'fading faster than peers'
            : 'on-par with peers',
        },
        {
          name: 'Internal-R trend',
          rawValue: rTrend,
          rawUnit: 'mΩ/mo',
          normalized01: rTrendNorm,
          weight: weights.rTrend,
          weightedScore: rTrendNorm * weights.rTrend * 100,
          comment: rTrend == null
            ? 'no internal-R trend yet'
            : rTrend > 2 ? 'resistance climbing fast — leading SoH decay'
            : rTrend > 0.5 ? 'resistance trending up'
            : 'resistance stable',
        },
        {
          name: 'Coulombic efficiency',
          rawValue: ce,
          rawUnit: '%',
          normalized01: ceNorm,
          weight: weights.ce,
          weightedScore: ceNorm * weights.ce * 100,
          comment: ce == null
            ? 'no CE data yet'
            : ce < 98 ? 'side-reactions consuming charge — early cell aging'
            : ce < 99 ? 'CE slightly below healthy LFP band'
            : 'CE healthy',
        },
        {
          name: 'Thermal hard-life',
          rawValue: hardLife,
          rawUnit: 'events/yr',
          normalized01: hardLifeNorm,
          weight: weights.hardLife,
          weightedScore: hardLifeNorm * weights.hardLife * 100,
          comment: hardLife == null
            ? 'no thermal-event data yet'
            : hardLife > 200 ? 'high cumulative thermal stress — accelerates fade'
            : hardLife > 100 ? 'moderate thermal stress history'
            : 'low thermal stress',
        },
        {
          name: 'Charge-curve drift',
          rawValue: ccDrift,
          rawUnit: 'mV',
          normalized01: ccDriftNorm,
          weight: weights.ccDrift,
          weightedScore: ccDriftNorm * weights.ccDrift * 100,
          comment: ccDrift == null
            ? 'no charge-curve baseline yet'
            : Math.abs(ccDrift) > 30 ? 'voltage plateau drifting from baseline'
            : 'charge curve close to baseline',
        },
        {
          name: 'Capacity fade rate',
          rawValue: fade,
          rawUnit: '%/yr',
          normalized01: fadeNorm,
          weight: weights.fade,
          weightedScore: fadeNorm * weights.fade * 100,
          comment: fade == null
            ? 'no fade trend yet'
            : fade > 5 ? 'fading well above LFP typical'
            : fade > 2.5 ? 'fading faster than typical LFP'
            : 'fade rate healthy',
        },
      ];

      // Composite score: weighted sum then sigmoid-flatten so extreme features
      // don't dominate. Result naturally in 0..100.
      const linearScore = factors.reduce((s, f) => s + f.weightedScore, 0);
      // Sigmoid-flatten around 50 with steepness chosen so linear=70 → score ~ 80.
      const score0to100 = Math.round(100 / (1 + Math.exp(-(linearScore - 50) / 12)));

      // Tier based on score
      let tier: PackRiskScore['tier'];
      const hasAnyData = factors.some((f) => f.rawValue != null);
      if (!hasAnyData) tier = 'no-data';
      else if (score0to100 < 25) tier = 'low';
      else if (score0to100 < 50) tier = 'moderate';
      else if (score0to100 < 75) tier = 'elevated';
      else tier = 'critical';

      const topFactors = factors
        .filter((f) => f.rawValue != null)
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 3);

      out.push({
        sn, device: d.deviceName, coreNum: dpuNum(d.deviceName), packNum,
        score0to100,
        tier,
        topFactors,
        allFactors: factors,
        generatedAt: now,
        modelVersion: RISK_MODEL_VERSION,
      });
    }
  }

  // Sort: critical first, then elevated, then moderate, then low, then no-data.
  // Within tier, highest score first.
  const tierRank: Record<PackRiskScore['tier'], number> = {
    critical: 0, elevated: 1, moderate: 2, low: 3, 'no-data': 4,
  };
  out.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.score0to100 - a.score0to100);

  const value: FleetRiskReport = { generatedAt: now, modelVersion: RISK_MODEL_VERSION, packs: out };
  if (dpus.length > 0) riskCache = { ts: now, value };
  return value;
}

/* ===================================================================
 * v0.9.11 — cache-warmer support.
 *
 * The short-TTL caches (5 min) used by /api/ha-state — RTE, clipping,
 * self-consumption, carbon, tariff — follow the standard pattern:
 *
 *   if (cache && !expired) return cache.value;   // cache.ts NOT updated
 *   ...compute, then assign cache = { ts: now, value };
 *
 * That means a cache-warmer call hitting a still-warm cache returns
 * cached without refreshing `ts`. The TTL still expires 5 min after
 * the original cold-compute, leaving a 1-3 min cold window before the
 * next 4-min warm cycle actually does the work.
 *
 * Fix: the warmer calls this resetter at the start of each cycle,
 * which nulls the caches so the subsequent compute calls are guaranteed
 * to actually do the work and re-stamp `ts` to "now". TTL-management
 * for the cached values themselves is unchanged.
 * =================================================================== */
export function resetHaStateShortLivedCaches(): void {
  rteCache = null;
  selfConsumptionCache = null;
  clippingCache = null;
  carbonCache = null;
  tariffCache = null;
}

/** Test-only seam: clear forecast-related caches so each test starts cold. */
export function resetForecastCachesForTesting(): void {
  probabilisticCache = null;
  multiDayCache = null;
  forecastSkillCache = null;
  bayesCache = null;
  ambientThermalCache = null;
  dispatchCache = null;
  curtailmentCache = null;
}

/** Test-only seam: pin a Bayesian model into the cache so computeCurtailment
 *  can be exercised without a full recorder + weather walk. */
export function setBayesianModelForTesting(value: BayesianSolarModel | null): void {
  bayesCache = value ? { ts: Date.now(), value } : null;
}
