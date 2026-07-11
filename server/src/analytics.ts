import type { DeviceSnapshot } from './snapshot.js';
import { liveGridBackstop } from './gridState.js';
import type { DpuPack, DpuProjection, Shp2Projection } from './ecoflow/project.js';
import type { Alert } from './alerts.js';
import type { Recorder } from './recorder.js';
import { getWeather, type WeatherHour, type WeatherForecast } from './weather.js';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership.js';
import { sliceByTsInclusive } from './backtest.js';
import { integrateWh, startOfLocalDayMs } from './aggregator.js';
import { getNwsAlerts, isNwsEnabled, nwsEventWindow, type NwsAlert } from './nws.js';
import { PHOENIX_SITE } from './physics/clearSky.js';
import { cToF, dpuNum, cap, median, mad, robustZ, linregress, mean, round1, round2, clamp01, type LinFit } from './analytics/mathHelpers.js';
import { allDpus, homeConnectedDpus } from './analytics/fleet.js';
import { singleFlight } from './singleFlight.js';

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

const Z_INFO = 3.5;
const Z_WARN = 5;

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
    // v0.13.2 — raised 5 → 8. Normal parallel-pack rebalancing scatters
    // SoC by 5-6% during/after a charge or discharge cycle; the old 5%
    // floor caught that routine spread as an "outlier", which (combined
    // with the MAD-zero shortcut below) flapped 1103× over a 7-day audit,
    // clearing in 2-9 min each time. 8% sits above normal rebalance noise.
    floor: 8,
    get: (pk) => pk.soc,
    fmt: (v) => `${Math.round(v)}%`,
  },
];

/**
 * v0.13.2 — hysteresis for the learned peer-outlier path.
 *
 * The learned path had NO debounce/hysteresis of its own (unlike the
 * baseline dpu-imbalance/vdiff families, which use the v0.9.80 'sustained'
 * gate). Combined with the MAD-zero shortcut, a single cycle past the floor
 * with zero peer scatter fired a warning that cleared minutes later — the
 * peer-SoC family flapped 1103× over a 7-day audit. We now require the same
 * outlier to persist for >=3 consecutive eval cycles (~60s at the 20s cadence)
 * before EMITTING. A key that misses a cycle resets to zero, so a normal
 * rebalance blip never accumulates to the emit threshold.
 *
 * Keyed per (metric.key, sn, packNum). State lives at module scope because
 * computeLearnedAlerts is called fresh each eval cycle.
 */
const PEER_HIT_EMIT_MIN = 3;
const peerHitCounts = new Map<string, number>();

/** v0.13.2 — exported for tests. The smallest unit of the hysteresis gate:
 * bump the consecutive-hit count for `key` and report whether it has reached
 * the emit threshold (>=3 consecutive cycles). Callers must also call
 * `prunePeerHitCounts` once per cycle to reset keys that did NOT hit. */
export function bumpPeerHit(key: string): { count: number; emit: boolean } {
  const count = (peerHitCounts.get(key) ?? 0) + 1;
  peerHitCounts.set(key, count);
  return { count, emit: count >= PEER_HIT_EMIT_MIN };
}

/** v0.13.2 — drop any peer-hit key NOT in `seen` this cycle, so a condition
 * that lapses for even one cycle has to re-earn its >=3 consecutive hits. */
export function prunePeerHitCounts(seen: Set<string>): void {
  for (const key of peerHitCounts.keys()) {
    if (!seen.has(key)) peerHitCounts.delete(key);
  }
}

/** v0.13.2 — test seam: clear all hysteresis state between test cases. */
export function _resetPeerHitCounts(): void {
  peerHitCounts.clear();
}

/** Phase 1 learned alerts: per-DPU pack peer comparison. */
export function computeLearnedAlerts(devices: Record<string, DeviceSnapshot>): Alert[] {
  const out: Alert[] = [];
  // v0.13.2 — keys that crossed the floor+z gate THIS cycle. Used to advance
  // the consecutive-hit hysteresis and to prune lapsed keys afterward.
  const seenHits = new Set<string>();
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
        // deviation is itself the signal.
        // v0.13.2 — MAD-zero fallback Z_WARN → Z_INFO. With zero peer scatter,
        // ANY deviation past the floor was forced to z=Z_WARN=5 and emitted as
        // a *warning*; a bare floor-cross with no sibling spread isn't strong
        // enough for warning. Starting it at Z_INFO makes it surface as INFO
        // (still visible) until real scatter pushes the true z-score up.
        // v1.1.0 — that only patched MAD === 0 exactly; MAD → 0⁺ still blew z up to the
        // hundreds. robustZ() floors MAD so a floor-sized deviation with no scatter scores
        // exactly Z_INFO — the continuous form of the same rule (see mathHelpers.robustZ).
        const z = robustZ(v, med, m, metric.floor, Z_INFO);
        if (z < Z_INFO) continue;

        // v0.13.2 — hysteresis: this pack crossed the gate, but the learned
        // path lacks the baseline 'sustained' protection. Require >=3
        // consecutive cycles before emitting so normal rebalance transients
        // (which clear within a cycle or two) never reach the user. The
        // baseline dpu-imbalance/vdiff families are untouched — this gate
        // lives only on the peer-outlier path.
        const hitKey = `${metric.key}-${d.sn}-${pk.num}`;
        seenHits.add(hitKey);
        const gate = bumpPeerHit(hitKey);
        if (!gate.emit) continue;

        const dir = v > med ? 'higher than' : 'lower than';
        // v0.93.0 (audit #14) — thermal peer-outlier warnings gate to the HOT
        // side only. A below-typical temperature on a heat-generating MPPT/pack
        // is benign (better cooling / lower duty), so the direction-agnostic |z|
        // must not raise a WARNING for a cold excursion. Demote cold-side thermal
        // outliers to INFO (still surfaced); non-thermal metrics keep the
        // symmetric |z| rule. Diagnostic path only — no alarm/safety consumer.
        const isThermal = metric.category === 'Thermal';
        const warnEligible = isThermal ? v > med : true;
        const severity = z >= Z_WARN && warnEligible ? 'warning' : 'info';
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
  // v0.13.2 — reset hysteresis for any (metric,sn,pack) that did NOT cross the
  // gate this cycle, so a lapsed condition must re-earn its 3 consecutive hits.
  prunePeerHitCounts(seenHits);
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
// v0.9.80 — sustained-excursion gate for duty-cycled load circuits. Bimodal
// loads (AC compressors) and the May→summer seasonal ramp leave the hour-of-
// day baseline dominated by the off/low state, so a single instantaneous
// compressor-on reading lands far outside it and the detector re-fired on
// every cycle (42h log: "East Air conditioner load unusual for the hour" ×13,
// West ×8). For flagged load targets, require the excursion to PERSIST across
// the recent real-time window before flagging: a stuck/faulted circuit holds;
// a normal compressor cycle does not. Thermal/SoC targets are unaffected.
const BASELINE_SUSTAINED_MS = 30 * 60 * 1000;   // excursion must hold this long
const BASELINE_SUSTAINED_FRAC = 0.6;            // ≥60% of recent samples past floor
const BASELINE_SUSTAINED_MIN_RECENT = 3;        // need ≥N recent samples to gate

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
  // v0.9.80 — when true, require the excursion to be SUSTAINED over the recent
  // real-time window (BASELINE_SUSTAINED_MS) before flagging. Set on bursty
  // duty-cycled SHP2 load circuits so AC compressor cycling doesn't re-fire.
  sustained?: boolean;
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
        targets.push({ sn: d.sn, metric: `pair${pc.primaryCh}_w`, device: d.deviceName, label: `${pc.name} load`, category: 'SHP2', coreNum: null, packNum: null, live: pc.watts, floor: 500, transform: (x) => x, fmt: wattFmt, sustained: true });
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
          sustained: true,
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

    // v0.9.80 — sustained-excursion gate for bursty load circuits. The hour-of-
    // day bucket is dominated by the off/low state, so a single compressor-on
    // reading reads as a huge outlier and re-fires every cycle. Require the
    // excursion to PERSIST: a majority of the recent real-time samples (NOT the
    // hour-of-day bucket — the actual last BASELINE_SUSTAINED_MS of readings)
    // must sit on the same side of the median, past the floor. A stuck/faulted
    // circuit clears this; a normal AC compressor cycle does not. Filtered by
    // timestamp so recorder row order is irrelevant.
    if (t.sustained) {
      const dirSign = Math.sign(t.live - med);
      const recent = pts.filter((p) => p.ts >= now - BASELINE_SUSTAINED_MS);
      if (recent.length >= BASELINE_SUSTAINED_MIN_RECENT) {
        const agree = recent.filter((p) => {
          const v = t.transform(p.value);
          return Number.isFinite(v) && Math.sign(v - med) === dirSign && Math.abs(v - med) >= t.floor;
        }).length;
        if (agree < Math.ceil(recent.length * BASELINE_SUSTAINED_FRAC)) continue;
      }
    }

    // v1.1.0 — MAD-floored modified z. The hour-of-day bucket for a steady circuit has a
    // near-zero MAD (an AC idling at 135 W), so the raw statistic blew up: an operator-facing
    // HA notification literally read "z 610.4". That also COLLAPSED this severity gate —
    // every past-floor deviation landed far above Z_WARN, so `z` stopped discriminating and
    // only `t.floor` did any work. Flooring MAD makes a floor-sized deviation with zero
    // scatter score exactly Z_INFO (matching the peer path's v0.13.2 reasoning: a bare
    // floor-cross is INFO, not a warning), and a warning now needs ~1.43× the floor — or
    // real scatter. Absolute-threshold alarms (alerts.ts CELL_TEMP etc.) are untouched.
    const z = robustZ(t.live, med, m, t.floor, Z_INFO);
    if (z < Z_INFO) continue;

    // t_selfbaseline — cap severity at INFO for sustained/bursty duty-cycled
    // load circuits (t.sustained: AC compressors etc, set in buildBaselineTargets
    // on SHP2 pairedCircuits/per-circuit loads). The BASELINE_SUSTAINED_* gate
    // above already proves the excursion is real, but for a bimodal on/off
    // circuit the hour-of-day median sits near the OFF state, so a normal
    // on-cycle during hot weather scores a huge z (observed 19-48 in
    // production, EVERY compressor cycle) and always clears Z_WARN. A
    // duration-based gate cannot fix this: a genuinely long hot-day AC run
    // duty-cycles identically to a stuck circuit, so widening the sustain
    // window only delays the same flood, it doesn't stop it. Circuit-level
    // faults on these same circuits are already covered by the dedicated
    // absolute-threshold `circuit-overload-<ch>` alert (alerts.ts, breaker-
    // capacity based, duty-cycle agnostic), so demoting this statistical
    // family to INFO for bursty targets loses no safety coverage — the
    // anomaly stays fully visible (facts + z-score intact) at INFO, it just
    // stops competing for warning-severity attention. Thermal/SoC
    // self-baseline targets (t.sustained unset) are unaffected and keep the
    // normal z >= Z_WARN rule.
    const severity = t.sustained ? 'info' : (z >= Z_WARN ? 'warning' : 'info');
    // Finding #31 — the printed deviation must reconcile with the printed live/
    // typical figures. absDev is full-precision, but t.fmt() (tempFmt/wattFmt)
    // rounds live and med INDEPENDENTLY for display, so |round(live)-round(med)|
    // can differ from round(absDev) by ±1 (e.g. "101°F — 12°F above … 90°F"
    // where 101-90=11). Derive the displayed deviation from the SAME rounded
    // figures the reader sees, not from the unrounded absDev, so the three
    // numbers always add up. Detection (the floor gate above and z-score) still
    // uses the full-precision absDev/med — only display changes here.
    const dispLive = Math.round(t.live);
    const dispMed = Math.round(med);
    const dispAbsDev = Math.abs(dispLive - dispMed);
    const dir = dispLive >= dispMed ? 'above' : 'below';
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
      detail: `${subj} ${t.label} is ${t.fmt(t.live)} — ${t.fmt(dispAbsDev)} ${dir} its typical ${t.fmt(med)} for this hour (baseline: ${spanDays} days of history, ${bucket.length} samples; z ${z.toFixed(1)}).`,
      facts: [
        { label: 'Current reading', value: t.fmt(t.live) },
        { label: 'Typical (this hour)', value: t.fmt(med) },
        { label: 'Deviation', value: `${dispLive >= dispMed ? '+' : '-'}${t.fmt(dispAbsDev)}` },
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
// v0.54.3 — the SoH-decline forecast (forecast-soh) uses its OWN, tighter gates than the
// shared ones above. The shared gates still drive the cell-imbalance forecast — a faster-
// moving signal that must KEEP its 5-day early-warning span (a rising imbalance can cross
// 50 mV in weeks). SoH/EOL is the opposite: it must NOT be projected from a fortnight of
// early-life BMS fullCap settling, so it needs a long baseline + a clear fit.
const SOH_FORECAST_HISTORY_MS = 120 * 24 * 60 * 60 * 1000; // 120d baseline (vs 14d) — a real LFP fade (~2-3%/yr) is far below the SoH quantization noise over a fortnight
const SOH_DEGRADE_MIN_SPAN_MS = 45 * 24 * 60 * 60 * 1000;  // ≥45 days of span before any EOL projection (vs 5d)
const SOH_DEGRADE_MIN_R2 = 0.5;                            // the decline must explain ≥50% of variance (vs 0.25)
// Physically-plausible SoH fade ceiling. Real LFP degrades ~2-3 %/yr; a regression implying a
// faster fade is BMS fullCap-recalibration settling / quantization noise, not a trustworthy EOL
// trajectory. With this ceiling + the noise floor (sohSignalBelowFloor) + the <3yr-to-85% gate,
// forecast-soh fires only on an ABNORMAL, sustained ~6-10 %/yr decline. By design it does NOT
// alert on a pack's normal, healthy 2-3 %/yr aging — that would be alarm fatigue, the SoH
// threshold alarm backstops the absolute level, and a >10 %/yr "fade" is settling/noise.
const MAX_SOH_FADE_PCT_PER_YEAR = 10;

/** v0.55.0 — physical ceiling on predicted EV-charging load per hour. The home has a SINGLE
 *  EVSE; a residential charger tops out near 11.5 kW (48 A × 240 V). Configurable for a
 *  different charger / a future second EVSE. */
const EV_MAX_LOAD_W = Math.max(0, Number(process.env.EV_MAX_LOAD_W ?? 11520));

/**
 * v0.55.0 — fold predicted EV-charging sessions into a per-hour watt map for the load forecast.
 * The home has ONE EVSE, so overlapping predicted sessions are ALTERNATIVES (uncertainty about
 * which recurring window fires), not two cars at once — so each covered hour takes the MAX
 * single-session watts, not the SUM. The old SUM stacked long overlapping windows into a
 * physically-impossible ~17 kW (one Tesla session is ≤11.5 kW), which projected the overnight
 * pool to 0% and inflated the forecast-soc-dip warning (latent false runway-critical if islanded).
 * Each session is also hard-capped at `maxW` so a single anomalous recorded session can't inflate it.
 * v0.56.0 — each session is also weighted by its recurrence `probability` (expected-value load):
 * a charger seen on only 3 of ~28 days contributes ~11% of its watts, so a sometimes-charger no
 * longer hard-projects an overnight 0%. (Omitted probability ⇒ 1.0, so existing callers/tests are
 * unchanged.) The cap is applied to the REAL session first (a physical ceiling), THEN the weight.
 */
export function evLoadByHour(
  sessions: Array<{ ts: number; durationHours: number; watts: number; probability?: number }>,
  maxW: number = EV_MAX_LOAD_W,
): Map<number, number> {
  const byHour = new Map<number, number>();
  for (const sess of sessions) {
    const wholeHours = Math.max(1, Math.ceil(sess.durationHours));
    const w = Math.min(sess.watts, maxW) * clamp01(sess.probability ?? 1);
    for (let i = 0; i < wholeHours; i++) {
      const heKey = Math.floor((sess.ts + i * 3_600_000) / 3_600_000);
      byHour.set(heKey, Math.max(byHour.get(heKey) ?? 0, w));
    }
  }
  return byHour;
}

let forecastCache: { ts: number; alerts: Alert[]; depletionGate: boolean } | null = null;
/** Test seam — clear the forecast-alert cache so successive scenarios recompute. */
export function resetForecastAlertsCache(): void { forecastCache = null; }

/** Phase 3 learned alerts: runtime forecast + degradation projections. Cached ~10 min. */
export function computeForecastAlerts(devices: Record<string, DeviceSnapshot>, recorder: Recorder, forecast?: DayForecast): Alert[] {
  const list = Object.values(devices);
  const shp2 = list.find((d) => d.online && d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  // v0.41.0 — the runtime depletion alert is gated on whether the diurnal day-forecast
  // ALSO projects reaching the reserve floor, so the emitted alert set now depends on
  // `forecast`. The time-based cache therefore has to key on that gate too: without it, a
  // call within the TTL carrying a different forecast (or `undefined`) would return alerts
  // computed under the PREVIOUS forecast and wrongly suppress/emit the runtime alert
  // (flagged in the v0.41.0 Copilot review). We key on the gate BOOLEAN — not the raw
  // minProjectedSoc — so the cache still survives the per-cycle forecast jitter and only
  // invalidates when the depletion verdict actually flips.
  const reserveForGate = shp2?.projection.backupReserveSoc ?? 15;
  // v0.41.0 (Copilot follow-up) — compare against the forecast's OWN reserve floor when it
  // carries one: `minProjectedSoc` was projected relative to `forecast.reserveSoc` (see
  // getDayForecast, which sets reserveSoc = backupReserveSoc ?? 15). Falling back to the live
  // SHP2 reserve keeps the gate self-consistent even if a caller passes a forecast that
  // doesn't exactly match the current SHP2 snapshot (stale/synthetic inputs). The comparison
  // is STRICTLY below reserve (`<`) — matching getDayForecast's own depletion alert
  // (`df.minProjectedSoc < df.reserveSoc`); a projection that merely touches the floor must
  // NOT flip this gate while the forecast card still reads "stays above the reserve floor"
  // (that exact-boundary mismatch would re-introduce the cross-card contradiction this fixes).
  const diurnalConfirmsDepletion =
    forecast != null &&
    forecast.minProjectedSoc != null &&
    forecast.minProjectedSoc < (forecast.reserveSoc ?? reserveForGate);
  if (
    forecastCache &&
    forecastCache.depletionGate === diurnalConfirmsDepletion &&
    Date.now() - forecastCache.ts < FORECAST_TTL_MS
  ) {
    return forecastCache.alerts;
  }
  const out: Alert[] = [];
  const now = Date.now();
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
      // v0.41.0 — gate the trailing-3h runtime alert on the DEPLETION-AWARE diurnal
      // forecast (`diurnalConfirmsDepletion`, computed above so it can also key the
      // cache). The flat trailing-decline extrapolation projects a false overnight
      // depletion (it ignores dawn solar recovery); only surface this alert when the
      // hour-by-hour PV-minus-load forecast ALSO projects reaching the reserve floor.
      // (Audit fix: removed the "reserve at 3 AM" / bogus "implied draw" false positive
      // that contradicted /api/runway hoursToReserve=null on the same page.)
      // NB: `reserve` here == `reserveForGate` above (same SHP2 reserve) — kept local for
      // the alert content (hoursToReserve / detail text).
      if (cur != null && pctPerHour < -0.05 && cur > reserve && diurnalConfirmsDepletion) {
        const hoursToReserve = (cur - reserve) / -pctPerHour;
        let severity: 'warning' | 'info' | null = null;
        if (hoursToReserve < 6) severity = 'warning';
        else if (hoursToReserve <= 18) severity = 'info';
        // v0.95.0 (re-audit #3) — grid-aware, matching forecast-soc-dip and the runway
        // audible gate: while the grid is backstopping the home, a projected runtime to
        // the reserve floor is INFORMATIONAL ("if islanded"), never a warning — the SHP2
        // just transfers to mains at the floor. This was the only reserve/runtime alert
        // still keyed on hours-only; its siblings already downgrade on grid.
        const gridBackstopping = liveGridBackstop(devices).backstopping === true;
        if (severity === 'warning' && gridBackstopping) severity = 'info';
        if (severity) {
          // v0.26.0 — derive hrs+mins from ONE rounding so a fractional hour
          // ≥ 59.5/60 carries into the hour instead of rendering "14h 60m"
          // (the old independent floor + round produced mins=60 with no carry).
          const totalMin = Math.round(hoursToReserve * 60);
          const hrs = Math.floor(totalMin / 60);
          const mins = totalMin % 60;
          out.push({
            id: `forecast-runtime-${shp2.sn}`,
            severity,
            category: 'SHP2',
            source: 'learned',
            device: shp2.deviceName,
            title: `Projected runtime ≈ ${hrs}h ${mins}m to reserve`,
            detail: `Backup pool ${cur}% draining ${(-pctPerHour).toFixed(1)}%/h (3h average) — projected to reach the ${reserve}% reserve floor in about ${hrs}h ${mins}m. Forecast assumes current load continues; daily-cycle modelling comes with solar/load forecasting.${gridBackstopping ? ' The grid is backstopping the home now, so this is informational — it applies only if you island.' : ''}`,
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
      const sohPts = recorder.query(d.sn, `pack${pk.num}_soh`, now - SOH_FORECAST_HISTORY_MS, now);
      const curSoh = pk.actSoh ?? pk.soh;
      if (
        sohPts.length >= 8 && curSoh != null
        // v0.54.3 — reuse the dated-EOL path's BMS-recalibration guards. A near-new pack
        // settling its measured fullCap over the first weeks reads as a clean linear "fade";
        // without these, the Predictive tab filled with false "declining → 85% in ~1.5 mo"
        // alerts on packs sitting at 97–100% SoH. sohStepDominated rejects a quantization
        // staircase; sohSignalBelowFloor rejects a net move under the SoH quantization noise.
        && !sohStepDominated(sohPts) && !sohSignalBelowFloor(sohPts)
      ) {
        const span = sohPts[sohPts.length - 1].ts - sohPts[0].ts;
        const fit = linregress(sohPts);
        if (span >= SOH_DEGRADE_MIN_SPAN_MS && fit && fit.r2 >= SOH_DEGRADE_MIN_R2) {
          const sohPerDay = fit.slopePerMs * 86_400_000;
          // v0.54.3 — reject an implausibly-fast fade. Real LFP degrades ~2–3 %/yr; a slope
          // implying more than MAX_SOH_FADE_PCT_PER_YEAR is settling/noise, not a trustworthy
          // EOL trajectory (a genuine fast failure trips the SoH threshold alarm separately).
          if (sohPerDay < -0.001 && -sohPerDay * 365.25 <= MAX_SOH_FADE_PCT_PER_YEAR) {
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

  if (Object.values(devices).some((d) => d.projection)) forecastCache = { ts: now, alerts: out, depletionGate: diurnalConfirmsDepletion };
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
  // v0.56.0 — this is the EXPECTED-VALUE (recurrence-weighted) EV load: a session's full
  // watts × its P(fires). The raw full-confidence watts + probability stay in /api/ev-window-prediction.
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
  peakCoeff: number;        // best (r²/sample-gated) hourly coefficient — diagnostic headline only
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
  recentCovered?: boolean; // v0.54.0 — recent window has clear-hour coverage ~ the cleanest days. When false, recentCoeff is built from a data-gap-thinned window and the soiling alert is suppressed (estimate still shown).
  // v0.54.1 — read-only diagnostics (surfaced by /api/debug/soiling, NOT on the
  // MQTT/ha-state path). Lets the operator see WHY dropPct is what it is: the
  // full per-day clear-sky coeff distribution + matching clear-hour counts and
  // the coverage bar, so an inflated baseline (one outlier "best day") vs a
  // genuinely depressed recent window can be told apart.
  dayCoeffs?: number[];
  dayHours?: number[];
  covBar?: number;
}

export interface DayForecast {
  generatedAt: number;
  hasWeather: boolean;
  historyDays: number;
  /** v0.77.0 — true when the forecast was built on an incomplete basis (cold
   *  load/PV history, no SoC basis because the SHP2/backup pool is absent or
   *  incoherent, or zero history days). Surfaced as a diagnostic sensor so a
   *  degraded projection (e.g. while home Cores are cloud-wedged) is
   *  operator-visible; the runway/projected-SoC numbers should be read with
   *  appropriate skepticism when this is true. */
  structurallyIncomplete?: boolean;
  reserveSoc: number;
  hours: ForecastHour[];
  forecastPvWhNext24: number;
  typicalPvWhPerDay: number;
  // v1.4.3 (audit #22) — the SAME alarm-facing bias-correction factor (v0.93.0
  // computePvBiasCorrection) that was folded into forecastPvWhNext24/hours[].forecastPvW
  // above. 1.0 (no-op) until the hindcast has ≥3 mature weather-covered days; clamped
  // [0.5, 1.2] otherwise. typicalPvWhPerDay (above) is a RAW historical hour-of-day
  // average and is NEVER bias-corrected — surfaced here so forecastDayAlerts'
  // forecast-low-solar narrative can put both sides of its comparison on the same
  // basis instead of comparing a bias-corrected figure against a non-bias-corrected one.
  pvBiasFactor?: number;
  // v0.13.1 — 24-slot typical-day PV curve (Wh per hour-of-day, index 0=midnight).
  // Sums to typicalPvWhPerDay. Exposed so the forecast backtest can use a diurnal
  // baseline (night≈0, noon≈peak) via diurnalBaselinePredictor() instead of a flat
  // typicalPvWhPerDay/24 — the flat line scored R²≈0 against real diurnal PV (P3-4).
  // Optional: getDayForecast always sets it; consumers fall back to a flat curve.
  typicalPvCurveWhPerHour?: number[];
  // v0.14.1 — the array's clear-sky PV ceiling (W): the max over the day's
  // modelled hours of observedMaxPvW × 1.05. The probabilistic P90 band is clamped
  // to this so the best-case band can't exceed what the panels can physically
  // produce. Undefined when no hour was equipment-modelled (fallback curve only).
  pvCeilingW?: number;
  minProjectedSoc: number | null;
  minProjectedSocTs: number | null;
  solarModel: SolarResponseModel;       // fleet-wide learned response
  deviceModels: DeviceSolarModel[];     // per-DPU — reveals placement/shading differences
  soiling: SoilingEstimate | null;      // null until ≥6 clear-sky days are recorded
  // v0.75.0 — home-core coverage basis for this forecast (same counts the
  // SelfConsumption KPI surfaces). When a wired home Core is cloud-offline the
  // day-ahead PV / projected-low-SoC is computed from a degraded basis (e.g. 1 of
  // 3 Cores reporting); the web surfaces a calm "Forecast basis: N of M home Cores
  // reporting" caveat when homeDpusCoveragePartial is true. Mirrors
  // selfConsumptionCoverage(); display-only, never gates a number.
  homeDpusConnected: number;
  homeDpusReporting: number;
  homeDpusCoveragePartial: boolean;
  // v0.78.0 — RESTORED display-only PV basis. When a wired home Core is cloud-wedged
  // it drops out of the LIVE device map, so the alarm-facing fields above
  // (forecastPvWhNext24 / typicalPvWhPerDay / typicalPvCurveWhPerHour / solarModel /
  // hours[].forecastPvW) collapse to the reporting cores' PV — deflating the DISPLAY
  // tiles to ~1 of 3 Cores. These parallel *Display fields sum each SHP2-CONNECTED SN's
  // OWN recorder history (all 3 authoritative home Cores, present or wedged) so the
  // dashboard shows the true full-fleet PV. They NEVER feed the runway alarm: computeRunway
  // reads ONLY hours[].forecastPvW (the conservative reporting-only series), which is left
  // untouched. `restoredSolarModel` carries the restored fleet fit so computeClipping can
  // publish a full-fleet arrayPeak / observedW without disturbing the alarm's solarModel.
  // Anti-fabrication: built by SUMMING real recorded values by SN only — never scaled,
  // multiplied, or extrapolated. A connected SN with no recorder history contributes 0. When
  // the connected set equals the live-present set (all Cores reporting) or the SHP2 is
  // absent (empty connected set), these equal the reporting-basis fields exactly.
  forecastPvWhNext24Display: number;
  typicalPvWhPerDayDisplay: number;
  typicalPvCurveWhPerHourDisplay?: number[];
  restoredSolarModel: SolarResponseModel;
}

const FORECAST_DAY_TTL_MS = 30 * 60 * 1000;
// v0.73.0 — short negative-cache TTL for a STRUCTURALLY-INCOMPLETE forecast (audit
// finding #1). When the SHP2 is cloud-offline the forecast comes back incomplete
// (socBasisMissing / loadCold) and the full-TTL cache gate below NEVER populates,
// so every /api/ha-state poll re-ran the >30 s cold recorder scan on the single
// analytics worker → 30 s client timeout → retry → ~60 s → HTTP 500. We now STILL
// cache the incomplete value but tag it `incomplete:true` and only serve it for this
// short window, bounding the cold re-scan to once per ~150 s instead of every call.
// CRUCIAL: this is alarm-neutral — the SoC/floor alarms read backupBatPercent off the
// LIVE snapshot (not the forecast) and computeRunway short-circuits to emptyRunway when
// the SHP2 is absent regardless of forecast content, so serving an incomplete forecast
// from cache feeds the SAME alarm decision the uncached one would. And it self-heals:
// once the SHP2 returns, the next call is structurally complete → it recomputes and
// overwrites the cache with incomplete:false + full TTL (see the cache-write gate).
// Read lazily (per call) so a test can flip the window to 0 to exercise expiry without a
// module reload; production sets it once via env (or the 150 s default).
function incompleteForecastTtlMs(): number {
  return Math.max(0, Number(process.env.INCOMPLETE_FORECAST_TTL_MS ?? 150 * 1000));
}
const TYPICAL_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_RESPONSE_PAIRS = 2;   // min daylight (GHI,PV) pairs to fit an hour
const DAYLIGHT_GHI = 20;        // W/m² — below this is night/near-night

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

/** Average an already-fetched bucketed PV series into hourly buckets keyed by
 *  hour-epoch (floor(ts/1h)). Split out of pvHourlyByEpoch (v0.25.0) so a caller
 *  that batched several metrics through ONE queryMulti can reuse this without a
 *  second query — the bucketing is byte-identical to the single-query path. */
function pvHourlyFromPts(pts: Array<{ ts: number; value: number }>): Map<number, number> {
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

/** Average a PV metric into hourly buckets keyed by hour-epoch (floor(ts/1h)). */
function pvHourlyByEpoch(
  recorder: Recorder,
  sn: string,
  metric: string,
  sinceMs: number,
  nowMs: number,
): Map<number, number> {
  return pvHourlyFromPts(recorder.query(sn, metric, sinceMs, nowMs, HOUR_CURVE_BUCKET_SEC));
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
    // v0.41.0 — only a well-fit, multi-sample hour may set the headline peak coeff.
    // Low-GHI dawn hours produce numerically unstable PV/GHI slopes (e.g. an r²≈0.02,
    // GHI≈25 W/m² hour falsely winning "peak") that mislabel a south array as east-facing.
    if (r2 >= 0.2 && day.length >= 3 && coeff > peakCoeff) peakCoeff = coeff;
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
export function computeSoiling(
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
    .map(([day, v]) => ({ t: new Date(day).getTime(), coeff: median(v), hours: v.length }))
    .sort((a, b) => a.t - b.t);
  if (days.length < 6) return null;
  // v0.54.2 — clean-panel baseline = the 90th-percentile clear-day response, NOT
  // the single all-time MAX. A freak cool-clear-day peak (live: 11.16 vs a 9.8
  // median) inflated dropPct; p90 is a robust "best clean day" reference.
  const sortedAsc = days.map((d) => d.coeff).sort((a, b) => a - b);
  const baselineCoeff = sortedAsc[Math.floor(0.9 * (sortedAsc.length - 1))];
  // recentCoeff is built from well-covered recent days only (v0.54.0: a data-gap
  // day with few clear hours has a sparse/partial coeff and is excluded via the
  // coverage bar; recentCovered=false suppresses the alert when we can't build a
  // trustworthy window). v0.54.2: widen the window to the last 5 well-covered
  // days (was 3) — two transient/gap-depressed FULL-coverage days (live: 6.68,
  // 6.65 vs a 9.8 norm, NOT real fleet-wide soiling) swung the last-3 median to
  // a false 40% drop. A 5-day median rejects 1–2 low outliers; a SUSTAINED real
  // drop (most recent days all low) still lowers the median and fires.
  const covBar = Math.max(3, Math.round(Math.max(...days.map((d) => d.hours)) * 0.5));
  const wellCovered = days.filter((d) => d.hours >= covBar);
  const recentCovered = wellCovered.length >= 3;
  const recentPool = (recentCovered ? wellCovered : days).slice(-5);
  const recentCoeff = median(recentPool.map((d) => d.coeff));
  const dropPct = baselineCoeff > 0 ? Math.round(((baselineCoeff - recentCoeff) / baselineCoeff) * 1000) / 10 : 0;
  return {
    dropPct, baselineCoeff, recentCoeff, cleanDays: days.length, recentCovered,
    dayCoeffs: days.map((d) => Math.round(d.coeff * 1000) / 1000),
    dayHours: days.map((d) => d.hours),
    covBar,
  };
}

/**
 * v0.63.0 — fleet soiling derived from the PER-CORE estimates (median of each
 * home Core's own clear-sky drop), NOT the summed-fleet coefficient.
 *
 * Why this exists: `computeSoiling(fleetPvByEpoch)` DEFLATES the fleet coefficient
 * when one home Core has a zero/missing `pv_total` on a clear hour (an EcoFlow-
 * cloud telemetry gap — these Cores drop cloud session intermittently). The
 * PER-CORE path discards that Core's own zero hour via the `coeff <= 0` filter,
 * but the FLEET SUM stays positive (the other Cores still produce), so the hour
 * is NOT discarded — it is merely counted ~1/N short, which reads as a false
 * fleet-wide ~(1/N) "soiling". Live: three home Cores, one with recent cloud-gap
 * clear hours → a phantom ~35% fleet drop while every array was really ~3-6%.
 *
 * Real soiling dims every array roughly uniformly and shows up EQUALLY per-Core,
 * so the per-Core median is the trustworthy fleet figure and is immune to the
 * coverage-deflation artifact. Coverage gate: only Cores with a trustworthy
 * (recentCovered) estimate contribute, and ≥2 must contribute (a single Core
 * can't represent the fleet) — otherwise null (no alert). Pure + exported for tests.
 */
export function fleetSoilingFromDevices(
  homeCorePvMaps: ReadonlyArray<Map<number, number>>,
  wxByHour: Map<number, WeatherHour>,
): SoilingEstimate | null {
  const ests = homeCorePvMaps
    .map((m) => computeSoiling(m, wxByHour))
    .filter((e): e is SoilingEstimate => e != null);
  if (ests.length === 0) return null;
  // Prefer the well-covered estimates; fall back to all valid ones only if fewer
  // than two are well-covered (so a transient gap doesn't drop us to one Core).
  const covered = ests.filter((e) => e.recentCovered);
  const pool = covered.length >= 2 ? covered : ests;
  if (pool.length < 2) return null; // need ≥2 home Cores for a fleet view
  // Median per-Core drop = the typical array's soiling, robust to one odd Core.
  const dropPct = Math.round(median(pool.map((e) => e.dropPct)) * 10) / 10;
  // Representative coeffs + diagnostics from the median-drop Core, for display.
  const repr = [...pool].sort((a, b) => a.dropPct - b.dropPct)[Math.floor((pool.length - 1) / 2)];
  return {
    dropPct,
    baselineCoeff: repr.baselineCoeff,
    recentCoeff: repr.recentCoeff,
    cleanDays: Math.min(...pool.map((e) => e.cleanDays)),
    recentCovered: pool.every((e) => e.recentCovered),
    dayCoeffs: repr.dayCoeffs,
    dayHours: repr.dayHours,
    covBar: repr.covBar,
  };
}

// v0.73.0 — `incomplete` tags a structurally-incomplete forecast (SHP2 cloud-offline:
// no SoC basis / cold load history). A complete forecast (incomplete:false) is served
// for the full FORECAST_DAY_TTL_MS; an incomplete one only for INCOMPLETE_FORECAST_TTL_MS,
// so the cold re-scan is bounded to once per short window rather than every call, and a
// complete forecast supersedes it the moment real data returns.
let dayForecastCache: { ts: number; value: DayForecast; incomplete: boolean } | null = null;
// v0.73.0 — true while the current cache entry is still fresh for its TTL. A complete
// entry uses the full 30-min TTL; an incomplete one decays after INCOMPLETE_FORECAST_TTL_MS
// (a short negative-cache window). Centralising the rule keeps getDayForecast and the
// inside-flight re-check in lock-step.
function dayForecastCacheFresh(now: number): boolean {
  if (!dayForecastCache) return false;
  const ttl = dayForecastCache.incomplete ? incompleteForecastTtlMs() : FORECAST_DAY_TTL_MS;
  return now - dayForecastCache.ts < ttl;
}
// v0.69.0 — coalesce concurrent cold-cache callers onto one forecast scan (the
// heaviest analytics computation; see singleFlight.ts).
const dayForecastFlight = singleFlight<DayForecast>();
// v0.60.0 — throttle the "structurally incomplete" rebuild log. A cold post-boot
// worker can hit this on every read for several minutes (the 4-min warm cycle +
// per-request rebuilds), flooding the log with ~70 identical lines; the gate is
// working as designed, so log it at most once per window.
let lastForecastIncompleteLogMs = 0;
const FORECAST_INCOMPLETE_LOG_THROTTLE_MS = 5 * 60 * 1000;

// v0.59.0 — overnight-load realism. The typical-day load curve over-predicts the
// idle/overnight floor ~2x on this house (curve ~6kW vs ~3.2kW actually drawn),
// which pinned projected_low_soc at 0%. When a projected hour's curve value is
// implausibly above the RECENT measured load, pull it partway toward recent
// actual — only ever TRIMS an over-prediction, never raises load (so a real
// daytime peak or a legitimately busy night is untouched). Env-tunable; same
// trailing-hour window the runway projection already uses (RUNWAY_LOAD_WINDOW_MS).
// v0.59.0 — trailing window for the recent-load anchor. 3h (not 1h) so a brief
// gap between cycling loads (e.g. the pool pump finishing) doesn't make a busy
// night look idle and mis-trim the curve. Env-tunable.
const FORECAST_RECENT_LOAD_WINDOW_MS = Math.max(0, Number(process.env.FORECAST_RECENT_LOAD_WINDOW_MS ?? 3 * 60 * 60 * 1000));
const FORECAST_NIGHT_OVERPREDICT_RATIO = Math.max(1, Number(process.env.FORECAST_NIGHT_OVERPREDICT_RATIO ?? 1.5));
const FORECAST_NIGHT_BLEND = Math.min(1, Math.max(0, Number(process.env.FORECAST_NIGHT_BLEND ?? 0.6)));
// Cap the downward trim: blendNightLoad never reduces the curve below
// (1 - MAX_TRIM)×raw. 0.5 fully corrects the observed ~2x over-prediction (curve
// → recent actual) but no further, so a pathologically-quiet recent window can't
// gut a well-calibrated curve. Env-tunable.
const FORECAST_NIGHT_MAX_TRIM = Math.min(1, Math.max(0, Number(process.env.FORECAST_NIGHT_MAX_TRIM ?? 0.5)));
// v0.59.0 — the blend is GATED to overnight/idle hours only. The ~2x over-predict
// it corrects is the idle floor; during the day a curve hour legitimately runs
// >1.5x a brief recent dip (a cloud cutting AC), so applying the trim there would
// under-predict the real afternoon peak. Overnight band = [START..23] ∪ [0..END].
const FORECAST_NIGHT_START_HOUR = Math.min(23, Math.max(0, Math.round(Number(process.env.FORECAST_NIGHT_START_HOUR ?? 21))));
const FORECAST_NIGHT_END_HOUR = Math.min(23, Math.max(0, Math.round(Number(process.env.FORECAST_NIGHT_END_HOUR ?? 5))));

/** v0.59.0 — trim a stale-high forecast load-curve hour toward recent measured
 *  load. Only ever REDUCES load (an over-prediction); returns rawBase unchanged
 *  when recent load is unknown (null) or the curve is plausibly close to actual
 *  (<= ratio×recent). The trim is FLOOR-CAPPED at (1 - FORECAST_NIGHT_MAX_TRIM)×raw
 *  so a pathologically-quiet recent window can't gut a well-calibrated curve. The
 *  caller gates this to overnight hours (see FORECAST_NIGHT_START/END_HOUR). Pure
 *  + exported for tests. */
export function blendNightLoad(
  rawBase: number,
  recentLoadW: number | null,
  ratio = FORECAST_NIGHT_OVERPREDICT_RATIO,
  blend = FORECAST_NIGHT_BLEND,
  maxTrim = FORECAST_NIGHT_MAX_TRIM,
): number {
  if (recentLoadW == null || rawBase <= recentLoadW * ratio) return rawBase;
  const blended = rawBase * (1 - blend) + recentLoadW * blend;
  return Math.max(blended, rawBase * (1 - maxTrim));
}

/**
 * v1.4.2 (daytime-review) — anchor the projected-SoC sim's near-term hours UPWARD to the
 * observed load, the same fix computeRunway got in v0.15.17. `hoursAhead` is the hour index
 * from now (0 = current hour); only the first `blendHours` are anchored, with a linearly
 * decaying weight (1, .75, .5, .25 for blendHours=4). `Math.max` so a lighter-than-modelled
 * day never becomes MORE optimistic, and a brief burst decays out of the far horizon. Units
 * are whatever the caller uses (whole-panel watts here); returns baseLoad unchanged past the
 * window or with no recent sample. Pure + exported for tests, mirroring blendNightLoad.
 */
export function anchorNearTermLoad(
  baseLoad: number,
  recentLoadW: number | null,
  hoursAhead: number,
  blendHours: number,
): number {
  if (recentLoadW == null || hoursAhead >= blendHours || hoursAhead < 0) return baseLoad;
  const w = 1 - hoursAhead / blendHours;
  return Math.max(baseLoad, recentLoadW * w + baseLoad * (1 - w));
}

/** v0.59.0 — true for the overnight/idle band the load-blend is restricted to. */
export function isForecastNightHour(clockHour: number): boolean {
  return clockHour >= FORECAST_NIGHT_START_HOUR || clockHour <= FORECAST_NIGHT_END_HOUR;
}

/**
 * v0.78.0 — the single per-hour PV projection, extracted VERBATIM from
 * getDayForecast's main loop so the alarm-facing series and the restored
 * display-basis 24 h PV sum use byte-identical math. Given the hour's learned
 * response, forecast GHI + cloud, the fallback typical-day curve value, and the
 * historical clearness, returns the projected PV watts and whether it was
 * equipment-modelled. Pure — no I/O.
 */
function forecastHourPvW(
  resp: HourResponse,
  ghi: number | null,
  cloud: number | null,
  fallbackCurveW: number,
  clearnessHist: number,
): { pv: number; modelled: boolean } {
  if (resp.coeff != null && ghi != null) {
    // Equipment-tuned: learned response × forecast sunlight, capped at observed peak.
    const hourCeil = resp.observedMaxPvW * 1.05;
    return { pv: Math.min(resp.coeff * ghi, hourCeil), modelled: true };
  }
  // Fallback: typical-day curve × cloud derate.
  const pv =
    cloud != null
      ? fallbackCurveW * Math.max(0.1, Math.min(1.3, (1 - (0.75 * cloud) / 100) / clearnessHist))
      : fallbackCurveW;
  return { pv, modelled: false };
}

/** Phase 4: equipment-tuned day-ahead PV / load / SoC forecast. Cached ~30 min. */
export async function getDayForecast(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  log: (m: string) => void = () => {},
): Promise<DayForecast> {
  if (dayForecastCache && dayForecastCacheFresh(Date.now())) {
    return dayForecastCache.value;
  }
  // v0.69.0 — coalesce concurrent cold-cache callers. The 30-min TTL cache above
  // memoizes the value but not the in-flight promise; during a cold boot every
  // concurrent caller re-ran this full multi-device scan + weather fetch (the
  // analytics worker timed out 9x). The forecast is a slowly-varying day-ahead
  // projection, so callers within one cold window safely share one computation —
  // exactly the semantics the 30-min TTL already implies once warm.
  return dayForecastFlight.run(() => computeDayForecastUncached(devices, recorder, log));
}

async function computeDayForecastUncached(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
  log: (m: string) => void,
): Promise<DayForecast> {
  if (dayForecastCache && dayForecastCacheFresh(Date.now())) {
    return dayForecastCache.value; // a prior flight may have populated it while we queued
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
  const homeDpus = homeConnectedDpus(dpus, connected);
  // v0.75.0 — home-core coverage basis for this forecast. Same counts the
  // SelfConsumption KPI uses; threaded onto DayForecast so the web can show a calm
  // "Forecast basis: N of M home Cores reporting" caveat when a wired Core is
  // cloud-offline (degraded PV/projected-SoC basis). Display-only; gates no number.
  const forecastCoverage = selfConsumptionCoverage(connected, homeDpus, devices, shp2 != null);

  // Typical-day fleet PV curve (fallback when the model lacks an hour) + load curve.
  const pvCurve = new Array(24).fill(0);
  let pvSpan = 0;
  for (const d of homeDpus) {
    const { curve, spanMs } = hourCurve(recorder, d.sn, 'pv_total', since, now);
    for (let h = 0; h < 24; h++) pvCurve[h] += curve[h];
    pvSpan = Math.max(pvSpan, spanMs);
  }

  // v0.78.0 — RESTORED display-basis PV curve. `pvCurve` above only sums home Cores
  // that are LIVE-present in the device map, so a cloud-wedged Core (absent from the
  // map but still an authoritative SHP2-connected source) silently deflates the
  // display tiles to ~1 of 3 Cores. Start from a copy of the reporting curve and ADD
  // each CONNECTED-but-ABSENT SN's OWN recorder pv_total history (anti-fabrication: a
  // real recorded sum, read by SN; an absent Core with no recorder history adds 0).
  // When the connected set equals the live-present set (all Cores reporting) OR the
  // SHP2 is absent (empty connected set → isShp2Connected true for all, so every home
  // DPU is already in homeDpus and there are no missing SNs), this equals pvCurve
  // exactly — edge cases (a)+(b) are byte-identical. Never feeds the alarm.
  const presentHomeSns = new Set(homeDpus.map((d) => d.sn));
  const missingConnectedSns = [...connected].filter((sn) => !presentHomeSns.has(sn));
  const restoredPvCurve = pvCurve.slice();
  for (const sn of missingConnectedSns) {
    const { curve } = hourCurve(recorder, sn, 'pv_total', since, now);
    for (let h = 0; h < 24; h++) restoredPvCurve[h] += curve[h];
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
  // v0.13.1 — durable GHI backfill. The solar-model training and soiling both
  // run over TYPICAL_HISTORY_MS (30 days), but the in-memory weather cache only
  // spans `past_days` (7) — so PV from days 8-30 had no GHI to pair with and was
  // silently dropped from the fit. Seed from the recorder-persisted ghi_wm2 /
  // cloud_pct series first (whole window), then let the live cache OVERWRITE
  // recent hours (it's the freshest, with tempC + ensemble metadata).
  mergeRecorderWeather(
    wxByHour, ghiByEpoch,
    recorder.query('weather', 'ghi_wm2', since, now, 3600),
    recorder.query('weather', 'cloud_pct', since, now, 3600),
  );
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
  // v0.63.0 — keep each home Core's OWN pv map so soiling is derived from the
  // per-Core estimates (immune to the fleet-sum coverage-deflation artifact),
  // not the summed-fleet coefficient. See fleetSoilingFromDevices.
  const homeCorePvMaps: Map<number, number>[] = [];
  const deviceModels: DeviceSolarModel[] = [];
  for (const d of dpus) {
    // v0.25.0 — one queryMulti for all three PV metrics over the IDENTICAL
    // (sn, since, now, HOUR_CURVE_BUCKET_SEC) window instead of three separate
    // recorder.query round-trips. queryMulti is the proven batched-equivalent
    // primitive (byte-identical bucketed SQL — see recorderQueryMultiEquivalence
    // test); pv_total is fetched once and reused for the fleet sum + the model,
    // and the fleetPvByEpoch accumulation order is unchanged (dpus order, pv_total).
    const pvM = recorder.queryMulti(d.sn, ['pv_total', 'pv_high', 'pv_low'], since, now, HOUR_CURVE_BUCKET_SEC);
    const pvE = pvHourlyFromPts(pvM.get('pv_total') ?? []);
    if (isShp2Connected(d.sn, connected)) {
      for (const [he, pv] of pvE) fleetPvByEpoch.set(he, (fleetPvByEpoch.get(he) ?? 0) + pv);
      homeCorePvMaps.push(pvE); // v0.63.0 — per-Core soiling source
    }
    deviceModels.push({
      sn: d.sn,
      device: d.deviceName,
      model: buildSolarResponse(pvE, ghiByEpoch),
      hv: buildSolarResponse(pvHourlyFromPts(pvM.get('pv_high') ?? []), ghiByEpoch),
      lv: buildSolarResponse(pvHourlyFromPts(pvM.get('pv_low') ?? []), ghiByEpoch),
    });
  }
  const solarModel = buildSolarResponse(fleetPvByEpoch, ghiByEpoch);

  // v0.78.0 — RESTORED display-basis fleet solar model. `fleetPvByEpoch` above only
  // sums LIVE-present home Cores (the loop iterates `dpus`), so a cloud-wedged Core
  // is absent and the fleet model — and thus the pv_array_peak / clipping tiles that
  // read solarModel.hourly[].observedMaxPvW — collapses to the reporting Cores. Add
  // each CONNECTED-but-ABSENT SN's OWN recorded pv_total epochs onto a copy of the
  // reporting map and refit (anti-fabrication: real recorded PV summed by SN only).
  // `solarModel` (above) stays reporting-only and remains the ALARM-facing model that
  // hours[].forecastPvW is built from; `restoredSolarModel` is display/clipping-only.
  // With no missing SNs this refits an identical map → equals solarModel.
  const restoredFleetPvByEpoch = new Map(fleetPvByEpoch);
  for (const sn of missingConnectedSns) {
    const pvE = pvHourlyByEpoch(recorder, sn, 'pv_total', since, now);
    for (const [he, pv] of pvE) restoredFleetPvByEpoch.set(he, (restoredFleetPvByEpoch.get(he) ?? 0) + pv);
  }
  const restoredSolarModel = buildSolarResponse(restoredFleetPvByEpoch, ghiByEpoch);

  // v0.93.0 (audit #3) — ALARM-FACING PV bias correction. Hindcast the reporting-only
  // `solarModel` against the last 7 days of actual home-Core PV (same home DPUs that
  // built the model — v0.9.76) to derive a clamped bias factor, then apply it to the
  // alarm-facing forecastPvW BELOW so computeRunway/computeMultiDayForecast/probabilistic
  // consume BIAS-CORRECTED PV. In the field the model over-predicts on cloudy days
  // (factor ≈0.62); correcting toward it SHORTENS runway — the safe islanded direction.
  // Self-activating + no-op until ≥3 mature weather-covered days exist (see
  // computePvBiasCorrection): factor stays 1.0 (raw PV, unchanged behaviour) otherwise.
  const biasTodayStart = startOfLocalDayMs();
  const biasWindowStart = biasTodayStart - 7 * 86_400_000;
  const pvBySnForBias = new Map<string, Array<{ ts: number; value: number }>>();
  for (const d of homeDpus) {
    pvBySnForBias.set(d.sn, recorder.query(d.sn, 'pv_total', biasWindowStart, biasTodayStart));
  }
  const pvBiasFactor = computePvBiasCorrection(solarModel, ghiByEpoch, pvBySnForBias, biasTodayStart);

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
  let pvCeilingW = 0; // v0.14.1 — clear-sky array ceiling (max observedMaxPvW × 1.05)

  // v0.9.3 — lift predicted EV-charging sessions into the load curve. The EVSE
  // window-prediction pattern detector runs separately; this folds its upcoming-24h
  // forecast into each hour a session covers.
  // v0.55.0 — single EVSE ⇒ overlapping predicted sessions are ALTERNATIVES (which recurring
  // window will fire), not two cars at once, so evLoadByHour takes the MAX watts per covered
  // hour (capped at the charger max), NOT the SUM. The old SUM stacked long overlapping windows
  // into a physically-impossible ~17 kW, projecting a false overnight depletion to 0%.
  const evPredictions = computeEvWindowPrediction(devices, recorder);
  const evByHourEpoch = evLoadByHour(evPredictions.upcomingNext24h);

  // v0.59.0 — recent measured whole-home load (trailing window), used to TRIM a
  // stale-high overnight curve. Computed once. Stays null (the no-trim signal) on a
  // cold/empty window. The `avg > 0` guard is load-bearing: besides NaN from an
  // empty mean, a confirmed all-zero average would otherwise feed recentLoadW=0 →
  // blendNightLoad(raw, 0) trims every hour to (1-blend)×raw — a spurious over-trim.
  let recentLoadW: number | null = null;
  if (shp2) {
    const recentPts = recorder.query(shp2.sn, 'panel_load', now - FORECAST_RECENT_LOAD_WINDOW_MS, now);
    if (recentPts.length >= 2) {
      const avg = recentPts.reduce((s, p) => s + p.value, 0) / recentPts.length;
      if (Number.isFinite(avg) && avg > 0) recentLoadW = avg;
    }
  }

  for (let k = 0; k < 24; k++) {
    const ts = startHour + k * 3_600_000;
    const clock = new Date(ts).getHours();
    const wx = wxByHour.get(Math.floor(ts / 3_600_000)) ?? null;
    const cloud = wx ? wx.cloudCoverPct : null;
    const ghi = wx ? wx.radiationWm2 : null;
    const resp = solarModel.hourly[clock];

    // v0.78.0 — via the shared forecastHourPvW helper (byte-identical to the
    // former inline math). This is the ALARM-FACING PV series (reporting-only
    // solarModel/pvCurve); computeRunway reads hours[].forecastPvW downstream.
    const { pv, modelled } = forecastHourPvW(resp, ghi, cloud, pvCurve[clock], clearnessHist);
    // v0.93.0 (audit #3) — bias-correct the alarm-facing PV. pvBiasFactor is 1.0
    // (no-op) until ≥3 mature weather-covered hindcast days exist; when the model
    // over-predicts it is < 1, deflating forecastPvW/pvSum and the projected-SoC
    // slope so the runway alarm reads CONSERVATIVE (shorter). Clamped [0.5,1.2].
    // v1.3.1 (audit rank 11) — RE-CLAMP after the bias multiply. forecastHourPvW already caps a
    // modelled hour at the observed physical ceiling, but pvBiasFactor is clamped [0.5, 1.2], so
    // an UNDER-predicting model (bias > 1) multiplied straight back past that ceiling: the
    // alarm-facing series could project more PV than the array has ever produced in that hour.
    // That inflates the projected-SoC slope and makes the runway alarm read LONGER — the unsafe
    // direction here. Deflation (bias < 1) stays unclamped; it is the conservative one.
    const hourCeil = modelled ? resp.observedMaxPvW * 1.05 : null;
    const pvAlarm = hourCeil != null ? Math.min(pv * pvBiasFactor, hourCeil) : pv * pvBiasFactor;
    if (hourCeil != null && hourCeil > pvCeilingW) pvCeilingW = hourCeil; // v0.14.1 — clear-sky ceiling for the P90 clamp
    // Day-of-week-aware load: pick weekday vs weekend curve for the projected
    // hour. Mon–Fri at 5pm looks nothing like Sat at 5pm in this house.
    const projDow = new Date(ts).getDay();
    const isWeekend = projDow === 0 || projDow === 6;
    const rawBase = useSplitLoad
      ? (isWeekend ? loadRes.weekend[clock] : loadRes.weekday[clock])
      : loadRes.combined[clock];
    // v0.59.0 — trim a stale-high curve hour toward recent measured load, but ONLY
    // for overnight/idle hours: the ~2x over-prediction is the idle floor, whereas
    // a DAYTIME curve hour legitimately runs far above a brief recent dip (a cloud
    // momentarily cutting AC load), so trimming there would under-predict the real
    // afternoon peak and make the islanded SoC slope over-optimistic. Only ever reduces.
    const trimmed = isForecastNightHour(clock) ? blendNightLoad(rawBase, recentLoadW) : rawBase;
    // v1.4.2 (daytime-review) — then anchor the near-term hours UPWARD to observed load, the
    // v0.15.17 fix computeRunway got but that was never ported to this sibling minProjectedSoc
    // sim. Without it, a SUSTAINED daytime load far above the modelled hour (an AC compressor
    // pulling 5–10 kW against a ~1 kW typical hour) left the projected-SoC slope — and thus
    // projected_low_soc_at and the forecast-soc-dip "Expected at" text — hours too optimistic vs.
    // the correctly-anchored runway sensors, an on-screen contradiction during a real anomaly.
    const baseLoad = anchorNearTermLoad(trimmed, recentLoadW, k, RUNWAY_BLEND_HOURS);
    // v0.9.3 — add any predicted EV-charging session that covers this hour.
    // The historical load curve already includes PAST EV sessions, but for
    // FUTURE hours we don't want the day-of-week average to flatten a known
    // recurring spike. The EV predictor surfaces those spikes; we add them
    // explicitly here for hours where one is predicted.
    const evLoad = evByHourEpoch.get(Math.floor(ts / 3_600_000)) ?? 0;
    const load = baseLoad + evLoad;
    // v0.93.0 (audit #3) — pvSum, the projected-SoC sim, and forecastPvW all consume
    // the BIAS-CORRECTED pvAlarm (never the raw pv), so the alarm-facing reporting
    // next-24h, the projected-SoC slope, and the per-hour series stay mutually
    // consistent and conservative. The DISPLAY basis (restoredPvSum below) stays raw.
    pvSum += pvAlarm;
    let socPct: number | null = null;
    if (fullWh && fullWh > 0 && socWh != null) {
      socWh = Math.max(0, Math.min(fullWh, socWh + (pvAlarm - load)));
      socPct = (socWh / fullWh) * 100;
      if (minSoc == null || socPct < minSoc) {
        minSoc = socPct;
        minSocTs = ts;
      }
    }
    hours.push({
      ts,
      forecastPvW: Math.round(pvAlarm),
      forecastLoadW: Math.round(load),
      cloudCoverPct: cloud,
      ghiWm2: ghi == null ? null : Math.round(ghi),
      projectedSocPct: socPct == null ? null : Math.round(socPct * 10) / 10,
      modelled,
      predictedEvLoadW: evLoad > 0 ? Math.round(evLoad) : undefined,
    });
  }

  // v0.78.0 — RESTORED display-basis next-24h PV sum. Re-runs the SAME per-hour PV
  // projection (forecastHourPvW) over the identical GHI/cloud/clearness inputs, but
  // with the RESTORED solar model + typical curve (all SHP2-connected Cores, wedged
  // included). This is what the display tiles publish; the alarm-facing pvSum above
  // (built from the reporting-only series that computeRunway consumes) is untouched.
  // When there are no missing SNs, restoredSolarModel/restoredPvCurve equal their
  // reporting counterparts, so restoredPvSum === pvSum exactly.
  let restoredPvSum = 0;
  for (let k = 0; k < 24; k++) {
    const ts = startHour + k * 3_600_000;
    const clock = new Date(ts).getHours();
    const wx = wxByHour.get(Math.floor(ts / 3_600_000)) ?? null;
    const cloud = wx ? wx.cloudCoverPct : null;
    const ghi = wx ? wx.radiationWm2 : null;
    const { pv } = forecastHourPvW(restoredSolarModel.hourly[clock], ghi, cloud, restoredPvCurve[clock], clearnessHist);
    restoredPvSum += pv;
  }

  const value: DayForecast = {
    generatedAt: now,
    hasWeather,
    historyDays: Math.round(historyDays * 10) / 10,
    reserveSoc,
    hours,
    forecastPvWhNext24: Math.round(pvSum),
    typicalPvWhPerDay: Math.round(pvCurve.reduce((a, b) => a + b, 0)),
    // v1.4.3 (audit #22) — see the DayForecast interface doc on this field.
    pvBiasFactor,
    typicalPvCurveWhPerHour: pvCurve.map((w) => Math.round(w)), // v0.13.1 — for diurnal backtest baseline
    // v0.78.0 — restored display basis (all SHP2-connected Cores; see interface docs).
    forecastPvWhNext24Display: Math.round(restoredPvSum),
    typicalPvWhPerDayDisplay: Math.round(restoredPvCurve.reduce((a, b) => a + b, 0)),
    typicalPvCurveWhPerHourDisplay: restoredPvCurve.map((w) => Math.round(w)),
    restoredSolarModel,
    pvCeilingW: pvCeilingW > 0 ? Math.round(pvCeilingW) : undefined, // v0.14.1 — P90 clamp
    minProjectedSoc: minSoc == null ? null : Math.round(minSoc * 10) / 10,
    minProjectedSocTs: minSocTs,
    solarModel,
    deviceModels,
    soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps, wxByHour) : null,
    homeDpusConnected: forecastCoverage.homeDpusConnected,
    homeDpusReporting: forecastCoverage.homeDpusReporting,
    homeDpusCoveragePartial: forecastCoverage.coveragePartial,
  };
  // v0.15.21 — never CACHE a forecast whose load curve came back empty: the
  // post-boot analytics worker can race the recorder and read zero panel_load
  // rows, and a cached all-zero curve then starves computeRunway (and the SoC
  // projection) for the full 30-min TTL — observed live as 35–90 min of
  // "999 / no depletion" runway blindness after every restart. Serve the value
  // (callers still get PV/weather) but rebuild on the next request.
  // v0.57.0 — widen the v0.15.21 "don't cache an empty forecast" gate. The old
  // `loadCurveEmpty = !!shp2 && loadRes.spanMs === 0` had a hole: its `!!shp2`
  // guard short-circuits to false when the SHP2 is ABSENT from the snapshot (a
  // cold worker right after a restart, or an SHP2 cloud-offline window) — the
  // emptiest case of all — so a forecast built on the all-zero load fallback with
  // no capacity basis (fullWh null → minProjectedSoc null) latched for the full
  // 30-min TTL. Observed live as ~10 min of SoC/runway blindness after the v0.56.1
  // deploy restart. Gate on INPUT SPANS / basis presence, never on output values:
  // a real zero-PV night legitimately yields all-zero forecastPvW for every hour
  // while still having a non-zero pvSpan from daytime history, and must still
  // cache. Still SERVE the partial forecast (PV + weather stay useful).
  // v0.73.0 — instead of NOT caching an incomplete forecast (which made every
  // /api/ha-state poll re-run the >30 s cold recorder scan on the single analytics
  // worker → 30 s timeout → retry → ~60 s → HTTP 500 whenever the SHP2 was cloud-
  // offline), give it a SHORT NEGATIVE-CACHE TTL: still cache the partial value but
  // tag it `incomplete:true` so it's served only for INCOMPLETE_FORECAST_TTL_MS
  // (~150 s) before re-scanning. This bounds the cold re-scan to once per ~150 s
  // rather than every call, while a structurally COMPLETE forecast (incomplete:false)
  // still caches for the full 30-min TTL and SUPERSEDES the incomplete entry the
  // moment real data returns — so a stale incomplete forecast can never get stuck.
  // Alarm-neutral: the SoC/floor alarms read the LIVE snapshot's backupBatPercent
  // (not the forecast) and computeRunway short-circuits to emptyRunway when the SHP2
  // is absent regardless of forecast content, so caching the incomplete forecast
  // feeds the SAME alarm decision the uncached one would.
  const loadCold = loadRes.spanMs === 0;              // no panel_load history (also true when the SHP2 is absent → zero-span fallback)
  const pvCold = homeDpus.length > 0 && pvSpan === 0; // home DPUs present but their PV recorder is cold
  const socBasisMissing = fullWh == null;             // no SHP2, or an incoherent backup pool → no SoC/runway projection
  const structurallyIncomplete = loadCold || pvCold || socBasisMissing || historyDays <= 0;
  if (structurallyIncomplete && now - lastForecastIncompleteLogMs >= FORECAST_INCOMPLETE_LOG_THROTTLE_MS) {
    lastForecastIncompleteLogMs = now;
    log(`forecast: structurally incomplete (loadCold=${loadCold} pvCold=${pvCold} socBasisMissing=${socBasisMissing} historyDays=${historyDays.toFixed(2)}) — negative-caching for ${incompleteForecastTtlMs() / 1000}s then rebuilding (throttled ${FORECAST_INCOMPLETE_LOG_THROTTLE_MS / 60000}m)`);
  }
  // v0.77.0 — surface the same flag on the value so ha-state / MQTT can publish a
  // diagnostic "forecast basis incomplete" sensor (the flag drove only the cache
  // TTL before). Set before caching so the cached value carries it too.
  value.structurallyIncomplete = structurallyIncomplete;
  // Cache whenever ≥1 DPU is present (so a totally-empty fleet still doesn't latch),
  // tagging the entry incomplete so the TTL fast-path uses the short negative-cache
  // window. A complete forecast overwrites it with incomplete:false + full TTL.
  if (dpus.length > 0) dayForecastCache = { ts: now, value, incomplete: structurallyIncomplete };
  return value;
}

/** Forecast-driven alerts derived from a DayForecast. */
export function forecastDayAlerts(df: DayForecast, grid?: { backstopping: boolean; reason?: string }): Alert[] {
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
  // Clear-sky PV envelope: sum each daylight hour's observed-max PV (the cleanest
  // recorded output for that hour-of-day) into an idealized "clear-day" total.
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
    // v0.59.0 — grid-aware. When the grid is actively backstopping the load, a
    // projected dip below reserve is informational ("if islanded"), not actionable —
    // the same downgrade the floor alarm (runwayAlarm.classifyRunway) already applies.
    // The numeric sensors stay continuous; only this NARRATIVE's severity/wording change.
    const onGrid = grid?.backstopping === true;
    out.push({
      id: 'forecast-soc-dip',
      severity: onGrid ? 'info' : 'warning',
      category: 'SHP2',
      source: 'learned',
      device: 'System',
      title: 'Projected battery dip below reserve',
      detail: onGrid
        ? `Forecast has the backup pool dipping to ~${df.minProjectedSoc}% around ${when} (below the ${df.reserveSoc}% reserve) IF islanded — the grid is backstopping the load now (${grid?.reason ?? 'grid present'}), so no action is needed. ${why}`
        : `Forecast has the backup pool reaching ~${df.minProjectedSoc}% around ${when} — below the ${df.reserveSoc}% reserve. ${why}`,
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
  // v1.4.3 (audit #22) — forecastPvWhNext24 is the bias-corrected alarm-facing PV sum
  // (v0.93.0 pvBiasFactor, clamped [0.5, 1.2], applied for runway safety — see the
  // getDayForecast loop above); typicalPvWhPerDay is a RAW historical hour-of-day
  // average that is NEVER bias-corrected. Comparing them directly compared a
  // bias-corrected figure against a non-bias-corrected one: when the hindcast is
  // deflating the forecast (factor < 1 — the common case in the field per the v0.93.0
  // note, ≈0.62), that mechanical deflation alone could trip the "<60% of typical"
  // trigger and inflate shortfallPct even on an otherwise-typical day, and the
  // cloud-only driver text below then misattributed the gap to weather/equipment
  // ("check for soiling, shading, or under-performing MPPT strings") instead of the
  // model recalibration. Put both sides on the SAME basis for this comparison by
  // applying the identical factor to the typical baseline here — typicalPvWhPerDay
  // itself stays untouched for its other consumers (PV telnet/web tiles, the
  // backtest's diurnal baseline).
  const lowSolarBiasFactor = df.pvBiasFactor ?? 1;
  const typicalBiasAdjusted = df.typicalPvWhPerDay * lowSolarBiasFactor;
  if (df.hasWeather && typicalBiasAdjusted > 0 && df.forecastPvWhNext24 < 0.6 * typicalBiasAdjusted) {
    const shortfallPct = Math.round((1 - df.forecastPvWhNext24 / typicalBiasAdjusted) * 100);
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
      detail: `Next-24h solar forecast ~${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh — ${shortfallPct}% below the typical ~${(df.typicalPvWhPerDay / 1000).toFixed(1)} kWh/day${lowSolarBiasFactor !== 1 ? ` (comparison bias-corrected ×${lowSolarBiasFactor.toFixed(2)} to match the forecast basis)` : ''}. ${why}`,
      facts: [
        { label: 'Solar next 24h', value: `${(df.forecastPvWhNext24 / 1000).toFixed(1)} kWh` },
        { label: 'Typical per day', value: `${(df.typicalPvWhPerDay / 1000).toFixed(1)} kWh` },
        { label: 'Forecast vs typical', value: `${Math.round((df.forecastPvWhNext24 / typicalBiasAdjusted) * 100)}%` },
        { label: 'Avg cloud cover', value: `${Math.round(driverCloud)}%` },
        { label: 'Hours modelled', value: `${driverModelled}/${driverTotal}` },
        ...(lowSolarBiasFactor !== 1 ? [{ label: 'Model bias correction', value: `×${lowSolarBiasFactor.toFixed(2)}` }] : []),
      ],
    });
  }
  // PV soiling — clear-sky output drifting below the clean-panel baseline.
  if (df.soiling && df.soiling.cleanDays >= 6 && df.soiling.recentCovered !== false && df.soiling.dropPct >= 12) {
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
// v0.9.80 — cap at the recorder's 30-day retention (recorder.ts RETAIN_MS).
// The samples table is pruned to 30 days, so any window beyond that is pure
// dead index-scan range — the SoH regression has no rows older than 30 days
// to fit. The previous 400-day lower bound made degradation scan ~370 days of
// empty range per pack, every cache cycle; on a synchronous SQLite store this
// serialized the cache-warmer's "parallel" cohort (runway + RTE + degradation
// all blocked on it), producing the 4-5.6 s slow cycles in the 42h log. Output
// is byte-for-byte identical (no rows beyond 30 days exist to regress).
const DEGRADE_REPORT_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;   // = recorder RETAIN_MS
const DEGRADE_BUCKET_SEC = 6 * 3600;                          // 6-hour buckets — de-noise SoH jitter
// v0.14.2 — require ≥3 weeks of trend before DATING a multi-year EOL. A 17-day
// window produced a false-precise "0.9 yr / EOL 2027" projection from a steep
// 19.6 %/yr fade at r² 0.46 — extrapolating a multi-year trend from half a month.
// Below this span the pack stays in "learning" (fade rate + Arrhenius still
// shown, just no dated EOL) until enough history accrues to date it credibly.
const EOL_MIN_SPAN_DAYS = 21;
const EOL_MIN_SPAN_MS = EOL_MIN_SPAN_DAYS * 24 * 60 * 60 * 1000;
const EOL_MIN_R2 = 0.3;                                       // trend must explain ≥30% of variance
// v0.32.0 — minimum net SoH decline (percentage points) actually OBSERVED across
// the window before a dated EOL is trustworthy. The BMS reports SoH quantized in
// ~0.5-pt steps, so a near-new pack can "wobble" ~1 pt across a month purely from
// recalibration/quantization, which OLS happily fits as a confident multi-%/yr
// fade. You cannot extrapolate an ~18-pt decline-to-EOL from a ~1-pt signal; this
// floor (~3 quantization steps) holds such packs at "learning". See sohSignalBelowFloor.
const SOH_MIN_OBSERVED_DROP_PTS = 1.5;
// v0.64.0 — implausible-fade ceiling for the DATED-EOL projection. Mirrors the
// forecast-soh ALERT path's MAX_SOH_FADE_PCT_PER_YEAR: real LFP fades ~2-3 %/yr, so an
// OLS slope implying a faster annual fade is early-life BMS fullCap recalibration
// settling, NOT a trustworthy EOL trajectory. The alert path already rejected this, but
// the projection path did not — so a near-new pack whose month-long fullCap settle
// exceeded the sohSignalBelowFloor floor (>1.5 pt net) still dated a false ~0.4 yr EOL
// (live: Core 3 packs 4 & 5, 95 % SoH, fit 39-43 %/yr). A genuine fast failure is caught
// by the absolute SoH threshold alarm separately. ALIASED from the alert-path constant
// so the two paths can never silently drift apart.
const EOL_MAX_FADE_PCT_PER_YEAR = MAX_SOH_FADE_PCT_PER_YEAR;  // = 10 %/yr
const EOL_MAX_YEARS = 40;                                     // beyond this, "EOL not in sight"
// v0.42.0 — pack mAh → kWh conversion. Each DPU pack is 32S1P (~104 V nominal;
//   32 series cells whose mV sum to packVoltageMv). fullCap is single-string mAh.
//   Wh = mAh × (32 × 3.2 V) / 1000 = mAh × 0.1024  →  kWh = (32 × 3.2) × mAh / 1_000_000.
//   (Numerically identical to the old (51.2 × 2) form — both equal 0.1024 — but the
//   "two 51.2 V strings in parallel" derivation was WRONG; the pack is one 32-cell string.)
// Sanity check against live data: pack fullCapMah ≈ 58804 at 99 % SoH →
//   58804 × (32 × 3.2) / 1_000_000 = 6.02 kWh, matching the EcoFlow 6.144 kWh
//   nameplate spec for a 99 %-SoH pack.
// Identical constant exists at recorder.ts (`PACK_MAH_TO_WH = (32 * 3.2) / 1_000`) and
// telnet/screens.ts (`MAH_TO_WH`); same value, same derivation.
const PACK_MAH_TO_KWH = (32 * 3.2) / 1_000_000;               // single-string mAh → pack kWh
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

/**
 * v0.28.0 — detect a SoH series that is one or two flat segments joined by a BMS
 * RECALIBRATION step rather than a genuine fade trend. A fleet-wide BMS SoH
 * recalibration shows up as a long flat run then a 1–2-sample cliff; OLS fits
 * that staircase as a CONFIDENT slope (its r² reflects only the segment geometry,
 * and the slope's SIGN is just the step direction), so any fade rate / dated EOL
 * / r² derived from it is an artifact — a down-step fabricated a "replace in
 * 0.7 yr", an equal up-step read as "stable, no fade", and the synchronized fleet
 * step inflated both the peer-fade baseline and the confidence median-r².
 * Returns true (→ route to 'learning', suppress the projection) when ANY holds:
 *   • < 3 distinct values (no resolution for a trend);
 *   • the largest contiguous flat run covers > 70% of samples (long-flat-then-step);
 *   • the ≤ 3 step transitions all fall in the final 20% of the window (terminal recal).
 * Re-arms automatically once a real multi-point trend accumulates past the step.
 */
export function sohStepDominated(pts: Array<{ ts: number; value: number }>): boolean {
  if (pts.length < 4) return true;
  const vals = pts.map((p) => p.value);
  const EPS = 0.01; // SoH resolution ~0.01 %
  const distinct = new Set(vals.map((v) => Math.round(v * 100))).size;
  if (distinct < 3) return true;
  let maxRun = 1;
  let run = 1;
  const transitions: number[] = [];
  for (let i = 1; i < vals.length; i++) {
    if (Math.abs(vals[i] - vals[i - 1]) < EPS) {
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 1;
      transitions.push(i);
    }
  }
  if (maxRun / vals.length > 0.7) return true;
  if (transitions.length > 0 && transitions.length <= 3 && transitions[0] >= vals.length * 0.8) return true;
  return false;
}

/**
 * v0.32.0 — companion to sohStepDominated for the OTHER recalibration-artifact
 * shape: a shallow, multi-step decline whose total observed signal is below the
 * BMS SoH quantization-noise floor. sohStepDominated catches the clean staircase
 * (few distinct values / one terminal cliff); this catches the case where SoH is
 * smeared across enough quantized values to look like a gentle trend but has only
 * moved a fraction of a percent overall.
 *
 * Net decline is measured as mean(first quartile) − mean(last quartile), which is
 * robust to a lone quantization spike and to an up-then-down wiggle (a genuine
 * fade shows a sustained early→late drop; noise does not). Returns true when that
 * net drop is below SOH_MIN_OBSERVED_DROP_PTS — i.e. there isn't enough real
 * signal to date an end-of-life, regardless of the OLS r².
 */
export function sohSignalBelowFloor(pts: Array<{ ts: number; value: number }>): boolean {
  if (pts.length < 4) return true;
  const vals = pts.map((p) => p.value);
  const q = Math.max(1, Math.floor(vals.length / 4));
  const firstMean = vals.slice(0, q).reduce((a, b) => a + b, 0) / q;
  const lastMean = vals.slice(-q).reduce((a, b) => a + b, 0) / q;
  return firstMean - lastMean < SOH_MIN_OBSERVED_DROP_PTS;
}

/**
 * v0.64.0 — true when an OLS-fit fade rate is too fast to be real LFP degradation
 * (≈2-3 %/yr) and is therefore early-life BMS fullCap-recalibration settling, not a
 * trustworthy EOL trajectory. Mirror of the forecast-soh ALERT path's
 * MAX_SOH_FADE_PCT_PER_YEAR test so the dated-EOL projection cannot outrun the alert.
 * Exported so it can be unit-tested in isolation, like sohStepDominated /
 * sohSignalBelowFloor. null (no fit) and flat/improving packs return false.
 */
export function fadeExceedsPlausibleCeiling(fadePctPerYear: number | null): boolean {
  return fadePctPerYear != null && fadePctPerYear > EOL_MAX_FADE_PCT_PER_YEAR;
}

/** Regress one pack's SoH history and project it to end-of-life. */
function analysePack(
  d: DeviceSnapshot & { projection: DpuProjection },
  pk: DpuPack,
  recorder: Recorder,
  since: number,
  now: number,
): PackDegradation {
  // v0.14.1 — clamp displayed/projected SoH to 100%. A freshly-calibrated BMS can
  // report >100% (e.g. 100.6%), which reads oddly on the dashboard and inflates the
  // EOL headroom. SoH is bounded by definition; the fade SLOPE still comes from the
  // regressed history (sohPts below), so only the current value + headroom are capped.
  const rawSoh = pk.actSoh ?? pk.soh;
  const currentSoh = rawSoh == null ? null : Math.min(100, rawSoh);
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
    // v0.15.12 — clamp to nameplate like currentSoh: fresh packs measure a
    // hair over design capacity, and the unclamped smoother published
    // 100.45/100.56 beside a clamped currentSoh=100. The EOL headroom math
    // below uses the clamped value too — a ≤0.6 % haircut on a fresh pack.
    kalmanSmoothedSoh = kf.smoothedSoh != null ? Math.min(100, round2(kf.smoothedSoh)) : null;
    // v0.93.0 (audit #16) — mirror the OLS fade-ceiling guard on the Kalman
    // years-to-EOL path. Without it, a Kalman fade rate above the physical LFP
    // ceiling (early-life BMS fullCap settling) could publish a false dated
    // kalmanYearsToEol / kalmanEolDate even when the OLS path correctly rejected
    // it. fadeExceedsPlausibleCeiling is the same helper the OLS path uses, so
    // the two can never drift apart. Diagnostic parallel projection — no
    // alarm/safety consumer.
    if (
      kalmanSmoothedSoh != null &&
      kalmanFadePctPerYear != null &&
      kalmanFadePctPerYear > 0.1 &&
      !fadeExceedsPlausibleCeiling(kalmanFadePctPerYear)
    ) {
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
      // v0.10.4 — clamp to a PHYSICAL band. Coulombic efficiency cannot exceed
      // 100% (you can't discharge more than you charged); healthy LFP runs
      // 99–99.9%. The old 50–110% band let counter quirks surface impossible
      // values like Core 3's 101%+. 100.5% tolerates counter rounding; a true
      // <90% would be a hard fault — but it's far more often a counter-reset
      // artifact, so we drop it rather than alarm on a phantom.
      // v0.41.0 — clamp to the physical 100% ceiling: coulombic efficiency cannot
      // exceed 100% (you can't discharge more than you charged). The 100.5% admission
      // band still tolerates counter rounding, but the displayed value never reads >100%.
      if (ratio >= 90 && ratio <= 100.5) coulombicEffPct = Math.min(100, round2(ratio));
    }
  }

  // v0.28.0 — reject a BMS-recalibration staircase BEFORE it can drive a fade /
  // dated EOL / r² / peer-fade. Route to 'learning' with NULL fade + NULL r² so it
  // neither projects a false EOL, reads as "stable: no fade", seeds the peer-fade
  // baseline (the pool filters status==='projecting'), nor pollutes the confidence
  // median-r² (degR2s filters non-null). Suppress the Kalman EOL too (same
  // artifact). Thermal/Arrhenius context stays visible.
  if (sohStepDominated(sohPts)) {
    return mk({
      status: 'learning',
      fadePctPerYear: null,
      fadeUncertaintyPct: null,
      cyclesPerYear,
      r2: null,
      dataSpanDays: spanDays,
      samples: sohPts.length,
      avgPackTempC: avgPackTempC != null ? round1(avgPackTempC) : null,
      arrheniusFactor: arrheniusFactor != null ? round2(arrheniusFactor) : null,
      coulombicEffPct,
      kalmanSmoothedSoh,
      kalmanFadePctPerYear: null,
      kalmanFadeStdevPctPerYear,
      kalmanYearsToEol: null,
      kalmanEolDate: null,
      summary:
        `SoH history looks like a BMS recalibration step on otherwise-flat data, not a measurable fade trend — holding off on a dated end-of-life projection until a real multi-point trend accumulates.` +
        (avgPackTempC != null
          ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F${arrheniusFactor != null && arrheniusFactor > 1.1 ? ` — ~${arrheniusFactor.toFixed(1)}× the calendar-fade rate vs 77 °F` : ''}.`
          : ''),
    });
  }

  // v0.32.0 — the SECOND recalibration-artifact shape sohStepDominated misses: a
  // shallow multi-step decline whose net observed signal is below the BMS SoH
  // quantization-noise floor. Live: device Y711FAB59J234000 packs 2 & 3 read
  // 98.6 % / 98.8 % SoH but moved only ~0.3–0.5 pt across the 27-day window (SoH
  // smeared over 5 quantized values), which OLS fit as a confident 12–16 %/yr fade
  // → a false "replace in ~1.2 yr" on two near-new packs. A fleet this new (all
  // packs ≥ 96.7 % SoH) should have NO dated EOLs yet. Hold at 'learning' (null
  // fade/EOL — does not seed the peer-fade pool or pollute the median-r²) until a
  // real multi-point decline clears the noise floor.
  if (sohSignalBelowFloor(sohPts)) {
    return mk({
      status: 'learning',
      fadePctPerYear: null,
      fadeUncertaintyPct: null,
      cyclesPerYear,
      r2: null,
      dataSpanDays: spanDays,
      samples: sohPts.length,
      avgPackTempC: avgPackTempC != null ? round1(avgPackTempC) : null,
      arrheniusFactor: arrheniusFactor != null ? round2(arrheniusFactor) : null,
      coulombicEffPct,
      kalmanSmoothedSoh,
      kalmanFadePctPerYear: null,
      kalmanFadeStdevPctPerYear,
      kalmanYearsToEol: null,
      kalmanEolDate: null,
      summary:
        `SoH has moved only a fraction of a percent across the recorded window — below the BMS recalibration/quantization noise floor — so a dated end-of-life would be extrapolating from noise. Holding at "learning" until a clear multi-point decline accumulates.` +
        (avgPackTempC != null
          ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F${arrheniusFactor != null && arrheniusFactor > 1.1 ? ` — ~${arrheniusFactor.toFixed(1)}× the calendar-fade rate vs 77 °F` : ''}.`
          : ''),
    });
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
      // v0.10.4 — surface thermal state even while "learning". These were
      // computed (avgPackTempC/arrheniusFactor) but dropped ONLY in this
      // branch, hiding ~1.7× Arrhenius calendar-aging at ~33 °C for every pack
      // without a long-enough SoH trend yet (i.e. most of the fleet today).
      avgPackTempC: avgPackTempC != null ? round1(avgPackTempC) : null,
      arrheniusFactor: arrheniusFactor != null ? round2(arrheniusFactor) : null,
      coulombicEffPct,
      kalmanSmoothedSoh,
      kalmanFadePctPerYear,
      kalmanFadeStdevPctPerYear,
      // v0.93.x (t_kalman) — mirror the OLS maturity/min-history gate (span ≥
      // EOL_MIN_SPAN_MS, r² ≥ EOL_MIN_R2) onto the Kalman DATED EOL fields.
      // kalmanFilterSoh only requires 3 points and carries no span/quality gate
      // of its own, so a pack with just enough history to clear the top-of-
      // function no-data check (≥8 buckets — as little as ~2 days at the 6-hour
      // bucket size) could otherwise publish a confidently-dated
      // kalmanYearsToEol/kalmanEolDate here even while OLS is correctly held at
      // "learning" (no dated EOL) for the identical pack. The preliminary
      // kalmanFadePctPerYear/kalmanSmoothedSoh stay visible, exactly like OLS's
      // own preliminary fadePctPerYear above — only the DATED projection is
      // withheld until the trend clears the maturity bar.
      kalmanYearsToEol: null,
      kalmanEolDate: null,
      summary:
        `Gathering data — ${spanDays} day(s) recorded; a dated end-of-life projection needs ≥ ${EOL_MIN_SPAN_DAYS} days of trend at R² ≥ ${EOL_MIN_R2} (have ${spanDays} d, R² ${fit ? fit.r2.toFixed(2) : '—'}).` +
        (avgPackTempC != null
          ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F${arrheniusFactor != null && arrheniusFactor > 1.1 ? ` — ~${arrheniusFactor.toFixed(1)}× the calendar-fade rate vs a 77 °F reference` : ''}.`
          : ''),
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
          ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F across the window.`
          : ''),
    });
  }

  // v0.64.0 — implausible-fast-fade guard. The gates above (sohStepDominated /
  // sohSignalBelowFloor / span+r² / stable) admit a near-new pack whose early-life
  // BMS fullCap settling produced a multi-point SoH drop over the window that OLS
  // annualizes into a physically-impossible fade (real LFP ≈ 2-3 %/yr). The forecast-soh
  // ALERT path already rejected fades > MAX_SOH_FADE_PCT_PER_YEAR; this mirrors it so the
  // DATED EOL can't outrun the alert. Route to 'learning' with NULL fade/EOL (does NOT
  // seed the peer-fade pool, the confidence median-r², or degradation_soonest_eol_years
  // → HA sensor stays 'unknown'). Re-arms automatically once a real, plausibly-paced
  // multi-year trend accumulates. fadePctPerYear is already non-null here (the 'stable'
  // branch returned on null), so the summary's .toFixed is safe.
  if (fadeExceedsPlausibleCeiling(fadePctPerYear)) {
    return mk({
      status: 'learning',
      fadePctPerYear: null,
      fadeUncertaintyPct: null,
      cyclesPerYear,
      r2: null,
      dataSpanDays: spanDays,
      samples: sohPts.length,
      avgPackTempC: avgPackTempC != null ? round1(avgPackTempC) : null,
      arrheniusFactor: arrheniusFactor != null ? round2(arrheniusFactor) : null,
      coulombicEffPct,
      kalmanSmoothedSoh,
      kalmanFadePctPerYear: null,
      kalmanFadeStdevPctPerYear,
      kalmanYearsToEol: null,
      kalmanEolDate: null,
      summary:
        `SoH fit implies ~${fadePctPerYear.toFixed(1)}%/yr fade — faster than the ${EOL_MAX_FADE_PCT_PER_YEAR}%/yr physical ceiling for healthy LFP, so this is early-life BMS recalibration settling, not a real fade trend. Holding at "learning" — no dated end-of-life — until a plausibly-paced multi-year trend accumulates.` +
        (avgPackTempC != null
          ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F${arrheniusFactor != null && arrheniusFactor > 1.1 ? ` — ~${arrheniusFactor.toFixed(1)}× the calendar-fade rate vs 77 °F` : ''}.`
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
      ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F → Arrhenius-equivalent to ~${fadePctPerYearAt25C} %/yr at 77 °F; cooling the cells ${Math.round(COOLING_DELTA_C * 1.8)} °F would extend service life by ~${coolingBenefitYears} years.`
      : avgPackTempC != null
        ? ` Avg pack temp ${Math.round(cToF(avgPackTempC))} °F across the window.`
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
  const dpus = allDpus(devices);

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
    //
    // v1.1.x — this used to be a hand-rolled `m > 0 ? |0.6745·dev/m| : 0` modified
    // z-score: unbounded as MAD → 0 (a matched fleet where every connected pack
    // fades at nearly the same rate has MAD ≈ 0, so a fraction-of-a-%/yr deviation
    // scored in the hundreds — the same failure mode robustZ() exists to fix, see
    // mathHelpers.robustZ) and it also silently never fired at MAD === 0 exactly.
    // Floor MAD the same way the peer-anomaly engine does above (line ~168): below
    // FADE_PEER_Z_FLOOR_PCT_PER_YEAR — the same 0.1 %/yr "no measurable capacity
    // fade" noise floor already used a few hundred lines up to call a fade rate
    // indistinguishable from flat — a deviation of exactly that size with zero peer
    // scatter is defined to score exactly Z_INFO; real scatter above the floor still
    // yields the true modified z-score, unchanged.
    const FADE_PEER_Z_FLOOR_PCT_PER_YEAR = 0.1;
    for (const p of projecting) {
      p.peerFadeRatio = med > 0 ? round2(p.fadePctPerYear / med) : null;
      const z = robustZ(p.fadePctPerYear, med, m, FADE_PEER_Z_FLOOR_PCT_PER_YEAR, Z_INFO);
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
// v0.15.17 — how many leading sim hours are anchored to the observed load
// (decaying max() blend into the day-of-week curve; see computeRunway).
const RUNWAY_BLEND_HOURS = 4;
// v0.15.21 — a forecast load curve averaging below this is data failure (an
// occupied home idles ≥ ~300 W), not a real model. See the degenerate-curve
// guard in computeRunway.
const LOAD_CURVE_MIN_PLAUSIBLE_KW = 0.05;

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
  /** v0.15.21 — true when the forecast load curve was implausibly empty and the
   *  whole horizon ran on the observed load instead (post-boot worker race). */
  loadModelDegraded: boolean;
}

let runwayCache: { ts: number; value: RunwayProjection } | null = null;

// v0.60.0 — asymmetric hysteresis on the to-EMPTY → 999 sentinel transition only.
// A finite empty-crossing sits at the far edge of the 24h horizon, so minute-to-
// minute load/PV jitter tips it across the boundary ~30×/window, churning the
// recorder + any history UI. Latch the last finite hoursToEmpty for N consecutive
// no-crossing recomputes before releasing to "no depletion". ONLY damps the
// optimistic (finite→none) direction — a real depletion (none→finite) is published
// immediately, so this can never delay a depletion warning.
const RUNWAY_EMPTY_CLEAR_SAMPLES = Math.max(1, Math.round(Number(process.env.RUNWAY_EMPTY_CLEAR_SAMPLES ?? 3)));
const runwayEmptyState: { streak: number; lastFinite: number | null } = { streak: 0, lastFinite: null };

/** v0.60.0 — asymmetric hysteresis on the to-EMPTY → "no depletion" transition.
 *  A finite crossing publishes immediately + arms the latch; the optimistic
 *  finite→none direction holds the last finite reading and releases to null only on
 *  the `clearSamples`-th consecutive no-crossing recompute (i.e. holds through the
 *  first clearSamples-1, clears on the clearSamples-th). ONLY damps the optimistic
 *  direction — a real depletion (none→finite) is published immediately, so this can
 *  never delay a depletion warning. Mutates `state`. Pure + exported for tests. */
export function applyEmptyHysteresis(
  hoursToEmpty: number | null,
  state: { streak: number; lastFinite: number | null },
  clearSamples = RUNWAY_EMPTY_CLEAR_SAMPLES,
): number | null {
  if (hoursToEmpty != null) { state.streak = 0; state.lastFinite = hoursToEmpty; return hoursToEmpty; }
  if (state.lastFinite != null) {
    if (++state.streak < clearSamples) return state.lastFinite; // hold
    state.lastFinite = null; // streak satisfied → release to the sentinel
  }
  return null;
}

/** Test/bench seam. NOTE: resets the state in THIS module instance only — effective
 *  for unit tests that call computeRunway (or applyEmptyHysteresis) directly. In
 *  production computeRunway runs in the analytics WORKER thread, which holds its own
 *  module copy of runwayEmptyState/runwayCache; this main-thread reset does not touch
 *  it (a worker respawn would reset the worker's copy, harmlessly releasing any hold). */
export function resetRunwayCache(): void { runwayCache = null; runwayEmptyState.streak = 0; runwayEmptyState.lastFinite = null; }

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
  loadModelDegraded: false,
  ...extra,
});

/** v0.15.11 — sentinel hours for a runway sensor that is HEALTHY but projects NO
 *  depletion within the horizon (net-charging / sunny forecast). hoursToReserve/
 *  Empty are legitimately null there, but publishing bare null makes HA render
 *  'unknown' — indistinguishable from a telemetry outage on an islanded home.
 *  Publish a large finite sentinel for the healthy-no-depletion case so 'unknown'
 *  uniquely means data-loss; automations comparing `runway < threshold` still
 *  correctly read "plenty of runway". When the projection is genuinely
 *  unavailable (no data), keep null so HA shows unknown. */
export const RUNWAY_NO_DEPLETION_SENTINEL_H = 999;
export function runwayHoursForPublish(
  hours: number | null,
  unavailable: string | null,
): number | null {
  if (hours != null) return hours;
  return unavailable == null ? RUNWAY_NO_DEPLETION_SENTINEL_H : null;
}

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
  let loadAvgWatts: number;
  if (loadPts.length >= 2) {
    loadAvgWatts = loadPts.reduce((s, p) => s + p.value, 0) / loadPts.length;
  } else {
    // v0.15.8/v0.15.11 — a sparse post-restart recorder window (< 2 persisted
    // panel_load samples in the last hour) used to return emptyRunway → the
    // runway sensors went null → HA 'unknown' → (after the 120 s expire_after)
    // 'unavailable', flapping for ~1 h while the window refilled. On an islanded
    // home that masquerades as a telemetry outage. Fall back, in order, to: the
    // LIVE SHP2 panel load (sum of circuit watts, available from MQTT
    // immediately), a single recent recorded sample, or the last good
    // recentLoadWatts — so the sensors stay numeric. Only give up if none exists.
    const liveLoadWatts = (shp2.projection.circuits ?? []).reduce((s, c) => s + (c.watts ?? 0), 0);
    const fallback =
      liveLoadWatts > 0 ? liveLoadWatts
        : loadPts.length === 1 ? loadPts[0].value
          : (runwayCache?.value.recentLoadWatts ?? 0) > 0 ? runwayCache!.value.recentLoadWatts
            : null;
    if (fallback == null || !Number.isFinite(fallback) || fallback <= 0) {
      return emptyRunway(now, 'panel-load history insufficient — wait a few minutes', {
        backupRemainingKwh: round2(backupRemainingKwh),
        backupReserveKwh: round2(backupReserveKwh),
        backupFullKwh: round2(backupFullKwh),
      });
    }
    loadAvgWatts = fallback;
  }

  // ★★ ALARM-SAFETY INVARIANT (v0.78.0) — DO NOT VIOLATE. The runway depletion sim
  // (hoursToReserve / hoursToEmpty → runwayAlarm.classifyRunway) MUST be driven by the
  // CONSERVATIVE reporting-only PV series ONLY. pvByHour reads exclusively
  // forecast.hours[h].forecastPvW, which getDayForecast builds from the reporting-only
  // solarModel (live-present home Cores). The RESTORED, higher display basis added in
  // v0.78.0 (forecast.forecastPvWhNext24Display / typicalPvWhPerDayDisplay /
  // restoredSolarModel) exists SOLELY for the ha-state / MQTT display tiles. A higher PV
  // input lengthens runway (fewer deficit hours ⇒ later/never reserve+empty crossings),
  // so wiring any restored / estimated / scaled PV in here would UNDER-ALARM during a
  // wedge — exactly the failure this split prevents. NEVER read a *Display field or
  // restoredSolarModel below. See runwayPvBasisGuard.test.ts, which pins that computeRunway
  // is byte-identical before/after the display restore and monotonic in forecastPvW.
  const pvByHour: number[] = [];
  const loadByHour: number[] = [];
  if (forecast) {
    for (const h of forecast.hours.slice(0, RUNWAY_HORIZON_HOURS)) {
      pvByHour.push((h.forecastPvW ?? 0) / 1000);
      // v0.14.0 — drive the depletion sim with the forecast's per-hour load curve
      // (the same diurnal / day-of-week shape getDayForecast feeds into
      // projectedSocPct) instead of a single flat trailing-hour average. The
      // trailing average over-weights transient bursts (a recent EVSE/AC spike can
      // make it ~2× the real draw), which produced an alarming hoursToEmpty that
      // flatly contradicted the forecast's own never-empty projection for the same
      // horizon. Fall back to the trailing-hour average only when a forecast hour
      // carries no modelled load.
      // v0.15.21 — strip the PREDICTED-EV layer from the alarm path. The forecast
      // folds computeEvWindowPrediction's speculative sessions into forecastLoadW
      // (right for the planning/SoC view) — but this sim treated "the car usually
      // charges tonight" as certain load, roughly DOUBLING the modelled draw on
      // nights the EV never plugged in (observed live Jun 12 02:18Z: base ~5 kW +
      // predicted EV ~6.9 kW → a false red voice alarm to the household). If the
      // car IS charging, the observed-load anchor below carries the real draw and
      // the 60 s recompute keeps it current; depletion ALARMS stay evidence-based.
      loadByHour.push(
        (Number.isFinite(h.forecastLoadW)
          ? Math.max(0, h.forecastLoadW - (h.predictedEvLoadW ?? 0))
          : loadAvgWatts) / 1000,
      );
    }
  }
  while (pvByHour.length < RUNWAY_HORIZON_HOURS) pvByHour.push(0);
  while (loadByHour.length < RUNWAY_HORIZON_HOURS) loadByHour.push(loadAvgWatts / 1000);

  const loadAvgKw = loadAvgWatts / 1000;

  // v0.15.21 — degenerate-curve guard. A post-boot analytics worker can race
  // the recorder and build the day forecast from ZERO panel_load rows: every
  // forecastLoadW comes back a finite 0, the sim trusts "the house draws 0 W",
  // and the projection publishes the healthy-no-depletion sentinel during a
  // genuine overnight deficit (observed live: 999 for 35–90 min after each
  // restart while the pool fell ~5 %/h, with only the 4 blended anchor hours
  // carrying any load). No real occupied home averages < 50 W — treat such a
  // curve as data failure and run the whole horizon on the observed load.
  const curveMeanKw = loadByHour.reduce((a, b) => a + b, 0) / loadByHour.length;
  const loadModelDegraded = curveMeanKw < LOAD_CURVE_MIN_PLAUSIBLE_KW;
  if (loadModelDegraded) loadByHour.fill(loadAvgKw);

  // v0.15.17 — anchor the sim's near-term hours to the OBSERVED load. The
  // day-of-week curve (v0.14.0) prevents transient-spike alarmism, but it also
  // let the sim ignore a SUSTAINED real load far above the modelled curve:
  // observed live (Jun 10, June-heat evening) the house drew 5–9 kW against a
  // ~3 kW modelled hour, and a post-restart recompute flipped "reserve in 6 h"
  // to "no depletion in horizon" — muting the escalating runway alarms while
  // the pool fell ~5 %/h. Each of the first RUNWAY_BLEND_HOURS takes at least
  // a decaying blend of the observed average into the curve (max(), so a
  // lighter-than-modelled day never becomes MORE optimistic, and a brief
  // burst still cannot dominate the far horizon — it decays out by hour 4).
  for (let h = 0; h < RUNWAY_BLEND_HOURS && h < loadByHour.length; h++) {
    const w = 1 - h / RUNWAY_BLEND_HOURS; // 1, .75, .5, .25
    loadByHour[h] = Math.max(loadByHour[h], loadAvgKw * w + loadByHour[h] * (1 - w));
  }

  let stateKwh = backupRemainingKwh;
  let hoursToReserve: number | null = null;
  let hoursToEmpty: number | null = null;
  let totalForecastPv = 0;
  let totalLoad = 0;
  for (let h = 0; h < RUNWAY_HORIZON_HOURS; h++) {
    const pvKwh = pvByHour[h];
    const loadKwhPerHour = loadByHour[h];
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

  // v0.60.0 — asymmetric hysteresis (this point is only reached on a HEALTHY
  // compute; the unavailable cases early-return via emptyRunway before here, so a
  // real outage publishes null immediately and never latches). A briefly-held stale
  // finite is pessimistic (over-warns), never optimistic.
  const pubHoursToEmpty = applyEmptyHysteresis(hoursToEmpty, runwayEmptyState);

  const value: RunwayProjection = {
    generatedAt: now,
    backupRemainingKwh: round2(backupRemainingKwh),
    backupReserveKwh: round2(backupReserveKwh),
    backupFullKwh: round2(backupFullKwh),
    recentLoadWatts: Math.round(loadAvgWatts),
    hoursToReserve: hoursToReserve != null ? round1(hoursToReserve) : null,
    hoursToEmpty: pubHoursToEmpty != null ? round1(pubHoursToEmpty) : null,
    reserveAtMs: hoursToReserve != null ? Math.round(now + hoursToReserve * 3_600_000) : null,
    emptyAtMs: pubHoursToEmpty != null ? Math.round(now + pubHoursToEmpty * 3_600_000) : null,
    forecastPvUsedKwh: round2(totalForecastPv),
    loadHorizonKwh: round2(totalLoad),
    horizonHours: RUNWAY_HORIZON_HOURS,
    unavailable: null,
    loadModelDegraded,
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

// v0.9.82 — 15 min (was 5). The cache-warmer staggers the heavy recomputes
// (this + self-consumption + tariff) one group per 4-min cycle, so each
// refreshes every ~12 min; a 15-min TTL keeps that inside the window (no
// v0.9.11 cold window) while letting the warmer recompute it on only 1 in 3
// cycles instead of every cycle. RTE is a 7-day rolling aggregate feeding an
// HA sensor — 15-min freshness is ample.
const RTE_TTL_MS = 15 * 60 * 1000;
// v0.65.0 - extended-lookback window for the RTE backstop. When the primary round-trip
// window has NO balanced day (a sustained net-discharge drawdown - every day's
// discharge/charge ratio falls outside the [0.80, 1.05] band), the gated aggregate is
// null and the sensor would read 'unknown' while the home is plainly still cycling.
// Rather than fabricate a number, the lookback EXTENDS to this many days and reports RTE
// from the most recent REAL balanced cycles (stateless, honest, never >100%, self-heals
// the instant a balanced day re-enters the primary window). Only the degenerate path
// pays the heavier query, and that wide pass uses coarser buckets.
const RTE_EXTENDED_WINDOW_DAYS = Math.max(7, Math.round(Number(process.env.RTE_EXTENDED_WINDOW_DAYS ?? 30)));

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
  const dpus = allDpus(devices);

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
  const homeDpus = homeConnectedDpus(dpus, connected);
  const packSeries = new Map<string, { in: Array<{ ts: number; value: number }>; out: Array<{ ts: number; value: number }> }>();
  for (const d of homeDpus) {
    const metricsNeeded: string[] = [];
    for (const pk of d.projection.packs) {
      metricsNeeded.push(`pack${pk.num}_in`, `pack${pk.num}_out`);
    }
    // v0.65.0 - coarser buckets for the wide extended-lookback pass (5x less data to
    // integrate); the primary <=10-day pass keeps 60 s resolution so the per-day
    // coverage gate is unchanged. Daily balanced-day detection is robust to 300 s buckets.
    const byMetric = recorder.queryMulti(d.sn, metricsNeeded, fullStart, fullEnd, windowDays > 10 ? 300 : 60);
    for (const pk of d.projection.packs) {
      packSeries.set(`${d.sn}|${pk.num}`, {
        in: byMetric.get(`pack${pk.num}_in`) ?? [],
        out: byMetric.get(`pack${pk.num}_out`) ?? [],
      });
    }
  }

  // v0.13.3 — RTE per-day gated on ABSOLUTE energy (chargedKwh>0.5), not on
  // coverage. On a partial-boot day (~49 min of data) a residual sample paired
  // with a tiny charge integral produced a discharge/charge ratio of a
  // physically impossible 130.8%, which then poisoned the aggregate so it
  // disagreed with self-consumption (discharge 298.88 vs 336.25 kWh). Fix: gate
  // each day on integrateWh COVERAGE — the fraction of the day we actually had
  // samples to integrate. The pre-fetched packSeries already anchors interior
  // midnights (integrateWh's lastBefore sample lives inside the [fullStart,
  // fullEnd] slice), so the only day the boot partial can skew is the one whose
  // coverage is <50%; excluding it from per-day efficiencyPct AND from the
  // aggregate totals lands RTE back in the credible ~93-96% band and brings it
  // into agreement with self-consumption (which integrates the same packs over
  // the same days). The coverage of the charge series stands in for the pair —
  // in/out share the DPU poll cadence, so they gain/lose coverage together.
  const RTE_MIN_DAY_COVERAGE = 0.5; // need ≥50% of the day measured to trust the ratio
  // v0.14.1 — RTE is only meaningful on days that are an actual round trip (the
  // pool returns near its starting SoC). On a net-charge / bulk-fill day the pool
  // ends much higher than it started, so dischargedKwh << chargedKwh and the
  // ratio (e.g. 25/72 = 35%) isn't an efficiency at all — it just measures how
  // much of the day's charge stayed in the battery. Including those days dragged
  // the headline to ~80% vs the ~95–96% the balanced days actually show. A
  // genuine LFP round trip lands at ~0.95 (discharge ≈ charge − losses); require
  // the day's discharge/charge ratio to sit in a plausible round-trip band before
  // it counts toward the per-day number or the aggregate. Net-fill (<0.80) and
  // net-drain / anomalous (>1.05) days are excluded from the efficiency (they're
  // still listed with their charged/discharged kWh, just no efficiencyPct).
  const RTE_ROUNDTRIP_MIN_FRAC = 0.8;
  const RTE_ROUNDTRIP_MAX_FRAC = 1.05;
  const perDay: RoundTripDay[] = [];
  let totalCharged = 0;
  let totalDischarged = 0;
  const packCount = homeDpus.reduce((n, d) => n + d.projection.packs.length, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayStart = todayStart - i * 86_400_000;
    const dayEnd = i === 0 ? now : dayStart + 86_400_000;
    let chargedKwh = 0;
    let dischargedKwh = 0;
    let coverageMsSum = 0;
    const dayMs = Math.max(1, dayEnd - dayStart);
    for (const d of homeDpus) {
      for (const pk of d.projection.packs) {
        const s = packSeries.get(`${d.sn}|${pk.num}`);
        if (!s) continue;
        const inR = integrateWh(s.in, dayStart, dayEnd);
        chargedKwh += inR.wh / 1000;
        dischargedKwh += integrateWh(s.out, dayStart, dayEnd).wh / 1000;
        coverageMsSum += inR.coverageMs;
      }
    }
    // Average coverage across packs (each pack's charge series spans the day).
    const coverage = packCount > 0 ? coverageMsSum / (packCount * dayMs) : 0;
    const sufficient = coverage >= RTE_MIN_DAY_COVERAGE;
    // v0.14.1 — only genuine round-trip days count toward the efficiency.
    const ratio = chargedKwh > 0.5 ? dischargedKwh / chargedKwh : null;
    const roundTrip =
      ratio != null && ratio >= RTE_ROUNDTRIP_MIN_FRAC && ratio <= RTE_ROUNDTRIP_MAX_FRAC;
    const include = sufficient && roundTrip;
    if (include) {
      totalCharged += chargedKwh;
      totalDischarged += dischargedKwh;
    }
    // v0.44.0 — clamp the SURFACED per-day efficiency to ≤100%. The integration
    // (trapezoidal `integrateWh`, with the day boundary SHARED as a sample
    // endpoint — verified no interval is double-counted across the inclusive
    // [dayStart, dayEnd] bounds) is correct, but the round-trip band above
    // intentionally admits days up to RTE_ROUNDTRIP_MAX_FRAC (1.05) so a genuine
    // round trip whose last charge/discharge interval is still in-flight at the
    // window edge isn't discarded. You can't get more energy OUT of a battery
    // than you put IN, so the published number must never exceed 100%: clamp it
    // here (and on the aggregate below). This is a display backstop on top of a
    // correct integral — `ratio` can legitimately sit a hair over 1.0 from a
    // partial edge interval; we report 100.0, not the impossible 103%.
    const dayEff = include ? Math.min(100, ratio! * 100) : null;
    perDay.push({
      date: localDateStr(dayStart),
      chargedKwh: round2(chargedKwh),
      dischargedKwh: round2(dischargedKwh),
      efficiencyPct: dayEff != null ? Math.round(dayEff * 10) / 10 : null,
    });
  }
  // v0.44.0 — aggregate RTE = energy_out / energy_in over the window, in (0,100]%.
  // Guard zero/near-zero charge → null (never Infinity/NaN), and clamp ≤100% for
  // the same reason as the per-day value: the summed per-day ratios (each in the
  // 0.8..1.05 band) can roll up just over unity, which is physically impossible
  // to PUBLISH. The integration fix isn't needed here (it was already correct);
  // this clamp is the legitimate backstop for the in-flight-edge-interval case.
  const effPct =
    totalCharged > 1 ? Math.min(100, (totalDischarged / totalCharged) * 100) : null;
  const value: RoundTripEfficiency = {
    generatedAt: now,
    windowDays,
    daysWithData: perDay.filter((d) => d.efficiencyPct != null).length,
    totalChargedKwh: round2(totalCharged),
    totalDischargedKwh: round2(totalDischarged),
    efficiencyPct: effPct != null ? Math.round(effPct * 10) / 10 : null,
    perDay,
  };
  // v0.65.0 - extended-lookback backstop. If the primary window found NO balanced
  // round-trip day (effPct null - typically a sustained net-discharge drawdown where
  // every day's discharge/charge ratio left the [0.80, 1.05] band), re-run over a wider
  // window and report the most recent REAL balanced cycles instead of going 'unknown'.
  // Stateless and honest: only genuine balanced-day ratios are ever published (<=100%),
  // and if even the wide window has none (a very long drawdown / fresh install) we keep
  // the honest null. The wider call self-terminates (its windowDays == EXTENDED is not
  // < EXTENDED, so no further recursion) and uses coarser buckets.
  let out = value;
  if (out.efficiencyPct == null && windowDays < RTE_EXTENDED_WINDOW_DAYS) {
    const extended = computeRoundTripEfficiency(devices, recorder, RTE_EXTENDED_WINDOW_DAYS);
    if (extended.efficiencyPct != null) out = extended;
  }
  if (dpus.length > 0) rteCache = { ts: now, key, value: out };
  return out;
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
  // v0.13.3 — disambiguate "no shade found" from "couldn't look". An empty
  // hours[] with status 'healthy' means we had enough clear-sky history and
  // found no obstructed hour (the normal, good outcome). status
  // 'insufficient-data' means we bailed before the analysis (no DPUs, no
  // weather, or too few clear-sky days) — the empty list says nothing about
  // shade. UI should read 'healthy' as a green check, not a broken engine.
  status: 'healthy' | 'insufficient-data';
  hours: ShadeHour[];
  estTotalKwhPerYear: number;  // rough annualised shortfall summed across shaded hours
}

let shadeCache: { ts: number; value: ShadeReport } | null = null;

// v0.93.0 (audit #9) — shade shortfall + kWh/yr rebuilt PER-CORE, mirroring
// fleetSoilingFromDevices. The pre-v0.63.0 path summed every home Core's pv_total
// into ONE fleetPvByEpoch and built BOTH the p90 clean-day refCoeff AND the observed
// shortfall from that sum — the exact coverage-deflation the v0.63.0 soiling comment
// warns about: a wedged Core's missing clear hour makes the fleet sum drop ~1/N but
// stay positive, so the hour is NOT discarded (as computeSoiling's coeff<=0 filter
// would per-Core) — it is merely counted ~1/N short and reads as a phantom fleet-wide
// 58-91% "shortfall" (bogus kWh/yr) while every array was really fine. Deriving the
// shortfall PER-CORE (each Core's own p90 refCoeff vs its own observed) makes each
// Core's zero/gap hour drop out of its OWN pairs, so it can't deflate anyone else.
//
// Fleet aggregation, per hour-of-day:
//   - shortfallPct = MEDIAN of the per-Core shortfalls (real shade dims arrays
//     roughly uniformly and shows up per-Core; one Core's gap can't move the median),
//     gated >= SHADE_DROP_THRESHOLD like the old fleet path.
//   - expectedW / observedW = SUM across the contributing Cores, so the DISPLAYED
//     watts stay whole-fleet-scale (same units the old output carried).
//   - clearDays = min across contributing Cores (the honest floor).
//   - estTotalKwhPerYear = SUM of each Core's OWN annual shortfall over its OWN
//     shaded hours — fleet-scale kWh, each Core self-consistent, no cross-Core
//     deflation. Diagnostic/UI only; no alarm consumer. Pure + exported for tests.
interface CoreShadeAgg { shortfall: number; observed: number; expected: number; days: number }
export function shadeHoursFromCorePvMaps(
  homeCorePvMaps: ReadonlyArray<Map<number, number>>,
  wxByHourEpoch: Map<number, WeatherHour>,
): { hours: ShadeHour[]; estTotalKwhPerYear: number } {
  // Per-Core shortfall by hour-of-day, plus each Core's own annual kWh shortfall.
  const perCoreHourShortfall: Array<Map<number, CoreShadeAgg>> = [];
  let annualKwhShortfall = 0;
  for (const pvByEpoch of homeCorePvMaps) {
    const byHour: Array<Array<{ predicted: number; observed: number; day: string }>> =
      Array.from({ length: 24 }, () => []);
    // This Core's own p90 clean-day refCoeff per hour-of-day. Built ONLY from this
    // Core's clear hours (coeff>0 there by construction), so a missing/zero hour is
    // simply absent — it can't deflate the reference the way a fleet sum's still-
    // positive short hour does.
    const clearByHour = new Map<number, number[]>();
    for (const [he, pv] of pvByEpoch) {
      const wx = wxByHourEpoch.get(he);
      if (!wx || wx.cloudCoverPct > 20 || wx.radiationWm2 < 200) continue;
      const coeff = pv / wx.radiationWm2;
      if (!Number.isFinite(coeff) || coeff <= 0) continue; // drop this Core's gap hour
      const hod = new Date(he * 3_600_000).getHours();
      const arr = clearByHour.get(hod) ?? [];
      arr.push(coeff);
      clearByHour.set(hod, arr);
    }
    const refCoeffByHour = new Map<number, number>();
    for (const [h, arr] of clearByHour) {
      if (arr.length < 3) continue;
      const sorted = arr.slice().sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
      refCoeffByHour.set(h, p90);
    }
    for (const [he, pv] of pvByEpoch) {
      const wx = wxByHourEpoch.get(he);
      if (!wx || wx.cloudCoverPct > 20 || wx.radiationWm2 < 200) continue;
      const hod = new Date(he * 3_600_000).getHours();
      const ref = refCoeffByHour.get(hod);
      if (ref == null) continue;
      byHour[hod].push({ predicted: ref * wx.radiationWm2, observed: pv, day: new Date(he * 3_600_000).toDateString() });
    }
    const coreHours = new Map<number, CoreShadeAgg>();
    for (let h = 0; h < 24; h++) {
      const pairs = byHour[h];
      const days = new Set(pairs.map((p) => p.day));
      if (days.size < SHADE_MIN_CLEAR_DAYS) continue;
      const obsMed = median(pairs.map((p) => p.observed));
      const predMed = median(pairs.map((p) => p.predicted));
      if (predMed < 100) continue;
      const shortfall = (predMed - obsMed) / predMed;
      coreHours.set(h, { shortfall, observed: obsMed, expected: predMed, days: days.size });
      // This Core's own annual shortfall over its own shaded hours (fleet-scale sum).
      if (shortfall >= SHADE_DROP_THRESHOLD) annualKwhShortfall += ((predMed - obsMed) / 1000) * 365;
    }
    perCoreHourShortfall.push(coreHours);
  }

  const hours: ShadeHour[] = [];
  for (let h = 0; h < 24; h++) {
    const contrib = perCoreHourShortfall
      .map((m) => m.get(h))
      .filter((v): v is CoreShadeAgg => v != null);
    if (contrib.length === 0) continue;
    // MEDIAN per-Core shortfall — robust to a single Core's odd hour, unlike the
    // fleet-sum path where one Core's gap deflated the shared coefficient.
    const shortfall = median(contrib.map((c) => c.shortfall));
    if (shortfall < SHADE_DROP_THRESHOLD) continue;
    const observedW = contrib.reduce((s, c) => s + c.observed, 0);
    const expectedW = contrib.reduce((s, c) => s + c.expected, 0);
    hours.push({
      hour: h,
      observedW: Math.round(observedW),
      expectedW: Math.round(expectedW),
      shortfallPct: Math.round(shortfall * 1000) / 10,
      clearDays: Math.min(...contrib.map((c) => c.days)),
    });
  }
  return { hours, estTotalKwhPerYear: Math.round(annualKwhShortfall) };
}

export async function computeShadeReport(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): Promise<ShadeReport> {
  if (shadeCache && Date.now() - shadeCache.ts < SHADE_TTL_MS) return shadeCache.value;
  const now = Date.now();
  const since = now - SHADE_OBSERVE_HISTORY_MS;
  // v0.13.3 — early bail-outs (no DPUs / no weather) are 'insufficient-data':
  // we couldn't run the analysis, so an empty hours[] must NOT read as "no
  // shade". The populated path below returns 'healthy'.
  const empty = (): ShadeReport => ({ generatedAt: now, status: 'insufficient-data', hours: [], estTotalKwhPerYear: 0 });

  const dpus = allDpus(devices);
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
  const homeDpus = homeConnectedDpus(dpus, connected);
  // v0.93.0 (audit #9) — keep each home Core's OWN pv_total map (NOT one summed
  // fleetPvByEpoch) so the shade shortfall + refCoeff are derived per-Core and can't
  // be deflated by a wedged Core's still-positive-but-short fleet hour. See
  // shadeHoursFromCorePvMaps (mirrors the v0.63.0 fleetSoilingFromDevices pattern).
  const homeCorePvMaps = homeDpus.map((d) => pvHourlyByEpoch(recorder, d.sn, 'pv_total', since, now));

  const { hours, estTotalKwhPerYear } = shadeHoursFromCorePvMaps(homeCorePvMaps, wxByHourEpoch);

  const value: ShadeReport = {
    generatedAt: now,
    // We ran the full clear-sky analysis; an empty hours[] here means no hour
    // crossed the shade threshold — a healthy array, not missing data.
    status: 'healthy',
    hours,
    estTotalKwhPerYear,
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

  const dpus = allDpus(devices);

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
  const homeDpus = homeConnectedDpus(dpus, connected);
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
const STRING_MISMATCH_WINDOW_DAYS = 14;
// v1.1.0 — smallest ratio deviation worth flagging before robustZ's variance floor
// (mathHelpers.robustZ) takes over. 0.05 == a string producing 5 percentage points
// below the fleet-median ratio (e.g. 0.95× vs 1.00×) is the smallest gap operators
// care about; anything smaller is normal panel-to-panel / shade scatter.
const STRING_MISMATCH_RATIO_FLOOR = 0.05;

export interface DeviceProductionRatio {
  sn: string;
  device: string;
  coreNum: number | null;
  recentMedianW: number | null;
  fleetMedianW: number | null;
  ratio: number | null;          // device / fleet
  modifiedZ: number | null;
  outlier: boolean;
  // v0.13.3 — renamed `samples` → `hourBuckets`. This count is the number of
  // hour-of-day buckets (0-23) where BOTH this device and the fleet had a
  // daytime median to compare — NOT a raw sample count. "samples:14" read as
  // "only 14 readings" when it actually meant up to 14 daylight hours over the
  // full window. windowDays (below) supplies the missing denominator.
  hourBuckets: number;
}

export interface StringMismatchReport {
  generatedAt: number;
  windowDays: number;   // v0.13.3 — span the per-device hourBuckets were drawn from
  devices: DeviceProductionRatio[];
}

let stringMismatchCache: { ts: number; value: StringMismatchReport } | null = null;
/** Test seam — clear the string-mismatch cache so successive scenarios recompute. */
export function resetStringMismatchCache(): void { stringMismatchCache = null; }

export function computeStringMismatch(
  devices: Record<string, DeviceSnapshot>,
  recorder: Recorder,
): StringMismatchReport {
  if (stringMismatchCache && Date.now() - stringMismatchCache.ts < STRING_MISMATCH_TTL_MS) {
    return stringMismatchCache.value;
  }
  const now = Date.now();
  const since = now - STRING_MISMATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const dpus = allDpus(devices);

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
      if (meds[h] <= 0) continue;
      // v0.41.0 — LEAVE-ONE-OUT fleet median: compare this device to the median of the
      // OTHER home-connected DPUs for this hour, never including itself. The old
      // all-devices median (which counted the device) mechanically pulled every ratio
      // toward 1.0 and is degenerate with only 2 reporting cores (median([a,b])=(a+b)/2).
      // Spare/offline DPUs are still EVALUATED against the connected baseline (their own
      // output isn't part of it) — mirroring computeDegradation's v0.9.75 pattern.
      const others: number[] = [];
      for (const o of dpus) {
        if (o.sn === d.sn || !isShp2Connected(o.sn, connected)) continue;
        const om = perDevicePerHour.get(o.sn)?.[h];
        if (om != null && om > 0) others.push(om);
      }
      if (others.length < 1) continue; // need ≥1 OTHER connected DPU to compare against
      const fleetMed = median(others);
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
      hourBuckets: ratioSamples.length, // v0.13.3 — hour-of-day buckets compared, not raw samples
    });
    if (ratio != null) deviceAvgRatios.push(ratio);
  }
  if (deviceAvgRatios.length >= 3) {
    const med = median(deviceAvgRatios);
    const m = mad(deviceAvgRatios, med);
    for (const r of ratios) {
      if (r.ratio == null) continue;
      // v1.1.0 — MAD-floored modified z (mathHelpers.robustZ), matching the peer-outlier
      // (v0.13.2) and hour-of-day baseline (v1.1.0) alarm paths in this file. The raw
      // `0.6745·|x−med|/MAD` statistic is unbounded as MAD → 0, which is exactly what
      // happens when only a few connected strings report and their averaged ratios sit
      // within a hair of each other — a trivial wobble could otherwise score in the
      // hundreds (the same failure mode documented for the peer/baseline paths) and
      // swamp the Z_INFO/Z_WARN gate below; the old `m > 0 ? … : 0` fallback was worse,
      // silently disabling outlier detection whenever the baseline was perfectly flat.
      // Flooring MAD makes a floor-sized ratio deviation with zero scatter score exactly
      // Z_INFO; real scatter above the floor is unaffected.
      const z = robustZ(r.ratio, med, m, STRING_MISMATCH_RATIO_FLOOR, Z_INFO);
      r.modifiedZ = round2(z);
      if (r.ratio < med && z >= Z_INFO) r.outlier = true;
    }
  }
  const value: StringMismatchReport = { generatedAt: now, windowDays: STRING_MISMATCH_WINDOW_DAYS, devices: ratios };
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
  probability: number;      // v0.56.0 — P(session fires) = recurrences / observed-day denominator, 0..1
}

export interface EvWindowPrediction {
  generatedAt: number;
  sessionsObserved: number;
  patterns: EvSessionPattern[];
  upcomingNext24h: Array<{ ts: number; durationHours: number; watts: number; dayOfWeek: number; probability: number }>;
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

  // v0.56.0 — recurrence-probability denominator. Distinct calendar days on which ANY EV
  // session was observed in the window; a pattern seen on N of these days fired ~N/observedDays
  // of the time, so we confidence-weight its projected watts (expected-value load) rather than
  // assume it fires every night. A ~10 kW session seen 3 of ~28 days contributes ~1.1 kW.
  const observedDayKeys = new Set(sessions.map((s) => new Date(s.startTs).toDateString()));
  const observedDays = Math.max(1, observedDayKeys.size);
  const observedDaysByDow = new Map<number, number>(); // for weekday-keyed patterns: a Tue charger can only fire on observed Tuesdays
  for (const k of observedDayKeys) {
    const dow = new Date(k).getDay();
    observedDaysByDow.set(dow, (observedDaysByDow.get(dow) ?? 0) + 1);
  }

  // Round each session's start to the nearest hour boundary once, up front —
  // both the weekday bucketing (below) and the v0.13.3 daily detector key off
  // it. (minutes >= 30 ⇒ +1 hour, else current hour.)
  const roundedHourOf = (startTs: number): { dow: number; hr: number } => {
    const d = new Date(startTs);
    const rd = new Date(startTs + (d.getMinutes() >= 30 ? 1 : 0) * 3_600_000);
    return { dow: rd.getDay(), hr: rd.getHours() };
  };

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
    const { dow, hr } = roundedHourOf(s.startTs);
    const key = `${s.sn}|${s.circuit}|${dow}|${hr}`;
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
      // v0.56.0 — fired on `recurrences` of the observed days of THIS weekday.
      probability: clamp01(g.records.length / Math.max(1, observedDaysByDow.get(Number(dowS)) ?? 0)),
    });
  }

  // v0.13.3 — PARALLEL daily detector. The weekday+hour buckets above miss a
  // *daily* charger: a 6pm-every-day habit spreads its sessions across all 7
  // weekday buckets, so each weekday-hour bucket can sit below MIN_RECURRENCES=3
  // and the engine emits 0 patterns despite 55 observed sessions (audit P2-4).
  // This second pass buckets by (sn, circuit, hour) ONLY and emits a pattern for
  // any hour-bucket that recurs on ≥MIN_RECURRENCES DISTINCT days, OR covers
  // ≥50% of the days we observed any session (a sparse-but-consistent habit).
  // Gating on distinct DAYS — not raw session count — is what stops a single
  // calendar day's burst of sessions at one hour from masquerading as a daily
  // pattern (its distinctDays is 1). Weekday becomes descriptive metadata (the
  // modal weekday). We skip any (sn, circuit, hour) the weekday path already
  // emitted so the forecast lift (which keys on startHour) isn't double-counted.
  const weekdayCovered = new Set(patterns.map((p) => `${p.sn}|${p.circuit}|${p.startHour}`));
  const hourGroups = new Map<string, { records: typeof sessions; }>();
  for (const s of sessions) {
    const { hr } = roundedHourOf(s.startTs);
    const key = `${s.sn}|${s.circuit}|${hr}`;
    const g = hourGroups.get(key) ?? { records: [] };
    g.records.push(s);
    hourGroups.set(key, g);
  }
  // `dailyHourKeys` records (sn|circuit|hour) buckets that fired as a DAILY
  // habit — these project on every day of the forecast (not just one weekday).
  const dailyHourKeys = new Set<string>();
  for (const [key, g] of hourGroups) {
    if (weekdayCovered.has(key)) continue; // already surfaced by the weekday path
    const distinctDays = new Set(g.records.map((r) => new Date(r.startTs).toDateString())).size;
    // v0.13.3 — require the habit to recur on ≥MIN_RECURRENCES DISTINCT days. An
    // earlier "OR coverage ≥50% of observed days" shortcut false-fired on a sparse
    // window: with only 1–2 observed days, a single day's burst of sessions
    // trivially hit 100% coverage and masqueraded as a daily pattern. Distinct-day
    // recurrence is the honest gate — and still catches a real every-day charger,
    // whose distinctDays grows with the observation window.
    if (distinctDays < EV_WINDOW_MIN_RECURRENCES) continue;
    const [sn, chS, hrS] = key.split('|');
    const dowCounts = new Map<number, number>();
    for (const r of g.records) {
      const { dow } = roundedHourOf(r.startTs);
      dowCounts.set(dow, (dowCounts.get(dow) ?? 0) + 1);
    }
    let modalDow = 0, modalCount = -1;
    for (const [dow, c] of dowCounts) if (c > modalCount) { modalDow = dow; modalCount = c; }
    const durHours = median(g.records.map((r) => (r.endTs - r.startTs) / 3_600_000));
    const watts = median(g.records.map((r) => r.avgWatts));
    const kwh = median(g.records.map((r) => r.energyKwh));
    dailyHourKeys.add(key);
    patterns.push({
      sn,
      circuit: Number(chS),
      dayOfWeek: modalDow,
      startHour: Number(hrS),
      typicalDurationHours: round1(durHours),
      typicalWatts: Math.round(watts),
      recurrences: g.records.length,
      energyKwh: round1(kwh),
      // v0.56.0 — a "daily" habit projects onto EVERY day, so its confidence is the fraction of
      // observed days it actually fired (distinct-days, not raw session count → a multi-session
      // day can't inflate it). A 3-of-28-days charger projects at ~0.11, not 1.0.
      probability: clamp01(distinctDays / observedDays),
    });
  }

  // Project forward 24 h. v0.13.3 — two projection rules, deduped per future
  // hour so a given start-hour is emitted at most once (v0.55.0: the consumer
  // takes the MAX watts per covered hour, not the SUM — so a duplicate emit
  // would no longer double the load, but de-duping here keeps the output clean):
  //   • Weekday-keyed patterns keep their original semantics — they fire only on
  //     the matching (dayOfWeek, hour). A Tuesday-only charger still lifts only
  //     Tuesdays.
  //   • Daily-detector patterns fire on the matching hour EVERY day, so a daily
  //     charger lifts tomorrow regardless of weekday.
  // When both could fire for the same future hour we take the larger watts.
  const upcoming: EvWindowPrediction['upcomingNext24h'] = [];
  for (let h = 0; h < 24; h++) {
    const ts = now + h * 3_600_000;
    const d = new Date(ts);
    const dow = d.getDay();
    const hr = d.getHours();
    let best: EvSessionPattern | null = null;
    for (const p of patterns) {
      if (p.startHour !== hr) continue;
      const isDaily = dailyHourKeys.has(`${p.sn}|${p.circuit}|${p.startHour}`);
      const applies = isDaily || p.dayOfWeek === dow;
      if (!applies) continue;
      if (best == null || p.typicalWatts > best.typicalWatts) best = p;
    }
    if (best) {
      upcoming.push({ ts, durationHours: best.typicalDurationHours, watts: best.typicalWatts, dayOfWeek: dow, probability: best.probability });
    }
  }

  const value: EvWindowPrediction = {
    generatedAt: now,
    sessionsObserved: sessions.length,
    patterns,
    upcomingNext24h: upcoming,
  };
  // v0.56.1 — do NOT cache an empty (0-session) result. Post-restart the first compute can catch
  // the analytics worker's recorder read cold and find no sessions; with the 1 h TTL that empty
  // would then suppress the EV forecast for an HOUR. Only cache a real prediction; an empty one
  // recomputes on the next call (mirrors the v0.15.21 no-cache-empty-forecast precedent).
  if (value.sessionsObserved > 0) evWindowCache = { ts: now, value };
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
  const dpus = allDpus(devices);

  const packs: ChargeCurvePack[] = [];
  for (const d of dpus) {
    for (const pk of d.projection.packs) {
      // v0.20.0 — one round-trip instead of three (same ts-ASC per-metric rows).
      const byMetric = recorder.queryMulti(
        d.sn, [`pack${pk.num}_soc`, `pack${pk.num}_vol_max_mv`, `pack${pk.num}_in`], since, now,
      );
      const socPts = byMetric.get(`pack${pk.num}_soc`) ?? [];
      const vMaxPts = byMetric.get(`pack${pk.num}_vol_max_mv`) ?? [];
      const inPts = byMetric.get(`pack${pk.num}_in`) ?? [];
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
      // v0.10.4 — anchor the "fresh" baseline to the OLDEST sample actually
      // recorded, not the fixed 200-days-ago `since`. The DB is only weeks old,
      // so `since + 14d` landed at ~now−186d — before ANY data existed — and
      // the baseline came up empty on every run, so drift never computed. The
      // first 14 days of real data is the correct fresh reference.
      const firstTs = enriched.length > 0 ? enriched[0].ts : since;
      const baselineCutoff = firstTs + CHARGE_BASELINE_WINDOW_MS;
      const recentCutoff = now - 14 * 24 * 60 * 60 * 1000;
      // Drift is only meaningful once the recent window clears the baseline
      // window. Until ~28 days of span accumulate they overlap, so we hold at
      // 'baseline' rather than diff overlapping periods (noise read as aging).
      const windowsSeparated = recentCutoff > baselineCutoff;
      const checkpointResults = CHARGE_CHECKPOINTS.map((target) => {
        const baseline: number[] = [];
        const recent: number[] = [];
        for (const e of enriched) {
          if (Math.abs(e.soc - target) > CHARGE_CHECKPOINT_TOLERANCE_PCT) continue;
          if (e.inW < 100) continue;
          if (e.ts <= baselineCutoff) baseline.push(e.vMv);
          else if (windowsSeparated && e.ts >= recentCutoff) recent.push(e.vMv);
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
// v0.13.3 — widened 60_000 → 120_000. At a 10-60 s poll cadence the old bound
// sat right on the poll boundary, so most adjacent pairs fell outside it and
// produced 0 samples. 120 s admits one-poll-apart pairs at the slow end of the
// cadence. NOTE: this is a mild improvement, NOT a fix — dV/dI over 10-120 s is
// dominated by OCV/SoC drift, not the pack's Ohmic R, so this engine cannot
// truly converge from a polled series. Honest reporting (insufficient-cadence,
// below) does the rest; real IR needs high-rate capture (deferred).
const IR_DELTA_T_MAX_MS = 120_000;
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
// v0.10.4 — the original 1 A/s bound was self-defeating: with sub-second DPU
// sampling, the candidate ≥5 A step's OWN settling ramps the surrounding ±5 s
// windows well past 1 A/s, so essentially every valid step was rejected and
// the engine produced 0 samples (stuck "learning" indefinitely). 3 A/s still
// rejects the violent transients we care about (inverter load-steps and motor
// inrush run 10+ A/s) while admitting normal post-step settling; the 3 s
// window narrows the neighborhood we require to be quiet.
const IR_STEADY_WINDOW_MS = 3_000;
const IR_STEADY_DIDT_MAX_A_PER_S = 3;
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
  // v0.13.3 — 'insufficient-cadence' is the HONEST terminal state: we have raw
  // V/A history but the 10-60 s poll cadence yields no clean dV/dI pairs, so
  // this will never converge at the current sampling rate. Distinct from
  // 'learning' (has some samples, accumulating toward the ≥10 threshold) so the
  // UI stops showing a perpetual spinner for a measurement that can't complete.
  status: 'tracking' | 'learning' | 'insufficient-cadence' | 'no-data';
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
  const dpus = allDpus(devices);

  const out: InternalResistanceDevice[] = [];
  for (const d of dpus) {
    // v0.20.0 — one round-trip instead of two (queryMulti returns the same
    // ts-ASC rows per metric; the V/A snapping depends only on that ordering).
    const byMetric = recorder.queryMulti(d.sn, ['bat_vol', 'bat_amp'], since, now);
    const vPts = byMetric.get('bat_vol') ?? [];
    const aPts = byMetric.get('bat_amp') ?? [];
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
    // v0.13.3 — track how many adjacent pairs were even close enough in time to
    // be a candidate. If almost none are (the poll cadence is wider than
    // IR_DELTA_T_MAX_MS), the engine is cadence-starved, not "learning".
    const rSamples: Array<{ ts: number; rMilli: number }> = [];
    let pairsWithinCadence = 0;
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1];
      const b = series[i];
      if (b.ts - a.ts > IR_DELTA_T_MAX_MS) continue;
      pairsWithinCadence++;
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
      // v0.13.3 — honest stopgap. We have ≥30 raw V/A samples (else 'no-data'
      // above), but too few clean dV/dI pairs. If the poll cadence itself
      // starves the candidate set — fewer than a handful of adjacent pairs even
      // landed within IR_DELTA_T_MAX_MS — this will NOT converge at the current
      // sampling rate, so report 'insufficient-cadence' rather than a perpetual
      // 'learning' that never finishes. (Real IR needs high-rate capture, which
      // is deferred to a future release.) If pairs WERE within cadence but got
      // rejected as transient/out-of-band, we're genuinely still accumulating →
      // keep 'learning'.
      const IR_MIN_CANDIDATE_PAIRS = 5;
      const status = pairsWithinCadence < IR_MIN_CANDIDATE_PAIRS ? 'insufficient-cadence' : 'learning';
      out.push({
        sn: d.sn, device: d.deviceName, coreNum: dpuNum(d.deviceName),
        recentMilliohms: null, baselineMilliohms: null, trendMilliohmsPerMonth: null,
        samples: rSamples.length, status,
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
  // v0.13.1 — false when the day had ZERO GHI coverage (no weather irradiance
  // for any hour). Such a day can't be hindcast — predictedKwh collapses to 0
  // and errorPct would read a phantom -100%. The UI should show "no data", not
  // a -100% miss. Days 4-7 used to be uncovered once the in-memory weather
  // cache (3-day window) was the only GHI source; the recorder ghi_wm2 series
  // now backfills a week, but a true gap still flags weatherCovered:false.
  weatherCovered: boolean;
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

/**
 * v0.13.1 — durable GHI lookup keyed by hour-epoch (ms/3.6e6).
 *
 * The in-memory weather cache only spans `past_days` (now 7) and is wiped on
 * restart / refetch, so any consumer that hindcasts more than a few days back
 * lost its irradiance. The recorder now persists `ghi_wm2` under the pseudo-SN
 * "weather" (change-detected, ~24 rows/day), surviving the cache window. Prefer
 * that series; fall back to the live `weather.hours` cache when the recorder is
 * sparse (cold start, before the first persisted fetch). The two are merged so
 * a recorder gap inside the window is patched by whatever the cache still holds.
 *
 * Pure + exported so the per-consumer "did this day have ANY GHI?" check is
 * unit-testable without standing up a real recorder/weather fetch.
 */
export function buildGhiByEpoch(
  recorderRows: Array<{ ts: number; value: number }>,
  cacheHours: WeatherHour[],
): Map<number, number> {
  const out = new Map<number, number>();
  // Cache first, recorder second — the persisted series is the source of truth
  // and overwrites cache entries for the same hour where both exist.
  for (const wh of cacheHours) {
    if (wh.radiationWm2 > 0) out.set(Math.floor(wh.ts / 3_600_000), wh.radiationWm2);
  }
  for (const row of recorderRows) {
    if (row.value > 0) out.set(Math.floor(row.ts / 3_600_000), row.value);
  }
  return out;
}

/**
 * v0.13.1 — backfill `wxByHour` + `ghiByEpoch` (keyed by hour-epoch) from the
 * recorder-persisted ghi_wm2 / cloud_pct series, so consumers that fit over a
 * window wider than the live weather cache (solar-model training + soiling,
 * 30 days vs a 7-day cache) get irradiance for the older hours.
 *
 * Mutates in place (only sets hours not already present is NOT done here on
 * purpose — the caller layers the live cache on top afterward so fresh hours
 * win). cloud_pct is optional; default 0 (treated as clear) when absent, which
 * matches Open-Meteo's "no cloud reported" and keeps soiling's clear-sky gate
 * permissive. Pure + exported for unit testing.
 */
export function mergeRecorderWeather(
  wxByHour: Map<number, WeatherHour>,
  ghiByEpoch: Map<number, number>,
  ghiRows: Array<{ ts: number; value: number }>,
  cloudRows: Array<{ ts: number; value: number }>,
): void {
  const cloudByEpoch = new Map<number, number>();
  for (const c of cloudRows) cloudByEpoch.set(Math.floor(c.ts / 3_600_000), c.value);
  for (const g of ghiRows) {
    const he = Math.floor(g.ts / 3_600_000);
    ghiByEpoch.set(he, g.value);
    wxByHour.set(he, {
      ts: he * 3_600_000,
      radiationWm2: g.value,
      cloudCoverPct: cloudByEpoch.get(he) ?? 0,
      tempC: 0, // not persisted — soiling/training don't read tempC
    });
  }
}

/** v0.13.1 — true when ANY hour of the local day [dayStart, dayStart+24h) has GHI. */
export function dayHasGhiCoverage(ghiByEpoch: Map<number, number>, dayStartMs: number): boolean {
  const startEpoch = Math.floor(dayStartMs / 3_600_000);
  for (let h = 0; h < 24; h++) if (ghiByEpoch.has(startEpoch + h)) return true;
  return false;
}

/**
 * v0.13.1 — P3-4: diurnal baseline predictor for the forecast backtest.
 *
 * The old "typical-day-baseline" backtester predicted a FLAT
 * typicalPvWhPerDay/24 for every hour — including 2am. Against real PV (≈0 all
 * night, a midday hump) that flat line has essentially no correlation with the
 * actual shape, so R² came out ≈0 (a measured r2≈-0.0006). A solar baseline
 * that doesn't know night from noon isn't a baseline worth scoring against.
 *
 * Given the 24-slot typical-day PV curve (Wh per hour-of-day, e.g.
 * DayForecast.pvCurve / the per-hour buckets that already sum to
 * typicalPvWhPerDay), return predict(hourStartMs) → pvCurve[hourOfDay]. Night
 * slots are ≈0 and the noon slot ≈peak, so the baseline tracks the diurnal
 * shape and yields a real (positive) R². Pure + exported so the backtest route
 * can build the predictor from the curve instead of a scalar.
 */
export function diurnalBaselinePredictor(pvCurveWhPerHour: number[]): (hourStartMs: number) => number {
  // Defensive copy + normalize to 24 finite slots so a short/NaN curve can't
  // poison the predictor (it's fed across a worker boundary).
  const curve = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    const v = pvCurveWhPerHour[h];
    curve[h] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return (hourStartMs: number) => curve[new Date(hourStartMs).getHours()];
}

/**
 * v0.93.0 (audit #3) — ALARM-FACING PV bias correction.
 *
 * The forecast-skill hindcast computes a biasFactor = sum(actual)/sum(predicted)
 * over mature weather-covered days (≈0.62 in the field: the GHI→PV model
 * OVER-predicts on cloudy days). Before this fix that factor fed the confidence
 * report ONLY — the alarm-facing forecast.hours[].forecastPvW series (which
 * computeRunway, computeMultiDayForecast, and computeProbabilistic all consume)
 * used the RAW model PV. Over-predicted PV shrinks the runway deficit → latent
 * islanding UNDER-alarm.
 *
 * This helper recomputes that factor from the SAME solar model + GHI + actual PV
 * the caller already has in scope, then returns a CLAMPED, GUARDED scalar to
 * multiply forecast PV by BEFORE the alarm consumers see it:
 *   • clamp(factor, [0.5, 1.2]) — never trust an extreme hindcast ratio; a
 *     factor < 1 (over-prediction) shortens runway = the SAFE islanded direction,
 *     and the 1.2 ceiling caps any runway-LENGTHENING (under-prediction) correction.
 *   • REQUIRE ≥ 3 mature weather-covered days before activating — same maturity
 *     gate the skill stats use (predKwh/actKwh non-degenerate). Fewer ⇒ 1.0.
 *   • FALL BACK to 1.0 (no-op) whenever the ratio is null/degenerate.
 * Self-activating: a no-op until the hindcast data matures, so it is safe to ship.
 *
 * Pure + exported so the guard test can pin the gate/clamp without a live recorder.
 */
export const PV_BIAS_CLAMP_LO = 0.5;
export const PV_BIAS_CLAMP_HI = 1.2;
export const PV_BIAS_MIN_MATURE_DAYS = 3;

export function computePvBiasCorrection(
  solarModel: SolarResponseModel,
  ghiByEpoch: Map<number, number>,
  pvBySn: Map<string, Array<{ ts: number; value: number }>>,
  todayStartMs: number,
  windowDays = 7,
): number {
  let totalPred = 0, totalAct = 0, matureDays = 0;
  for (let i = windowDays; i >= 1; i--) {
    const dayStart = todayStartMs - i * 86_400_000;
    // Same "day had ANY irradiance" coverage gate the skill hindcast uses.
    if (!dayHasGhiCoverage(ghiByEpoch, dayStart)) continue;
    let predWh = 0, actWh = 0;
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * 3_600_000;
      const he = Math.floor(hourStart / 3_600_000);
      const ghi = ghiByEpoch.get(he);
      const resp = solarModel.hourly[new Date(hourStart).getHours()];
      if (ghi != null && resp.coeff != null) predWh += resp.coeff * ghi;
      for (const pts of pvBySn.values()) {
        const slice = sliceByTsInclusive(pts, hourStart, hourStart + 3_600_000);
        if (slice.length === 0) continue;
        actWh += slice.reduce((s, p) => s + p.value, 0) / slice.length;
      }
    }
    const predKwh = predWh / 1000;
    const actKwh = actWh / 1000;
    // Identical maturity gate to computeForecastSkill's biasFactor accumulation.
    if (predKwh > 0.5 && actKwh > 0.5 && predKwh >= 0.25 * actKwh) {
      totalPred += predKwh; totalAct += actKwh; matureDays++;
    }
  }
  // Insufficient mature coverage OR degenerate ratio ⇒ no-op.
  if (matureDays < PV_BIAS_MIN_MATURE_DAYS || totalPred <= 0.5) return 1.0;
  const raw = totalAct / totalPred;
  if (!Number.isFinite(raw) || raw <= 0) return 1.0;
  return Math.min(PV_BIAS_CLAMP_HI, Math.max(PV_BIAS_CLAMP_LO, raw));
}

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
  // v0.21.0 — scope the actuals to SHP2-connected home DPUs, matching the
  // predictor (the solar model + typical-PV curve are built from home DPUs
  // only — v0.9.76). The hindcast previously summed actual PV over EVERY DPU
  // including bench spares, biasing the skill metric on a fleet with spare
  // panels. (No-op when no SHP2 is observed: isShp2Connected returns true for
  // all, so the empty-membership fallback keeps every DPU.)
  const connected = shp2ConnectedDpuSns(devices);
  const dpus = Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu' && isShp2Connected(d.sn, connected),
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
  if (dpus.length === 0) return emptyVal();

  // Hindcast: model.coeff[h] × GHI(h) for each past hour → predicted W.
  // Integrate hourly across each past day. Compare with actual hourly PV avg.
  const todayStart = startOfLocalDayMs();
  // v0.13.1 — GHI from the DURABLE recorder series first, the 3-day in-memory
  // cache as fallback. The cache only spans `past_days` and is wiped on restart,
  // so days 4-7 had ZERO irradiance and hindcast to predKwh=0 → a phantom
  // errorPct=-100%. The recorder persists ghi_wm2 under SN "weather" over the
  // whole window, so days >3 ago now have real GHI to hindcast against.
  const windowStart = todayStart - windowDays * 86_400_000;
  const ghiRows = recorder.query('weather', 'ghi_wm2', windowStart, now, 3600);
  const ghiByEpoch = buildGhiByEpoch(ghiRows, weather.hours);

  // v0.21.0 — fetch each DPU's full pv_total series ONCE for the whole hindcast
  // window, then slice each hour in memory (was one SQLite query per hour per
  // DPU = windowDays×24×DPUs synchronous calls per cold recompute). The
  // inclusive slice reproduces the recorder's bounds, so the per-hour mean
  // below is bit-identical.
  const pvBySn = new Map<string, Array<{ ts: number; value: number }>>();
  for (const d of dpus) {
    pvBySn.set(d.sn, recorder.query(d.sn, 'pv_total', windowStart, todayStart));
  }

  const days: ForecastSkillDay[] = [];
  let totalPred = 0, totalAct = 0, errSum = 0, errCount = 0;
  for (let i = windowDays; i >= 1; i--) {
    const dayStart = todayStart - i * 86_400_000;
    // v0.13.1 — a day with no irradiance for ANY hour can't be hindcast.
    // Emit errorPct:null + weatherCovered:false instead of a predictedKwh=0 /
    // errorPct=-100 row, and keep it out of the MAE/bias stats (which were
    // already correct — they gate on predKwh/actKwh below).
    const weatherCovered = dayHasGhiCoverage(ghiByEpoch, dayStart);
    let predWh = 0, actWh = 0;
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * 3_600_000;
      const he = Math.floor(hourStart / 3_600_000);
      const ghi = ghiByEpoch.get(he);
      const hod = new Date(hourStart).getHours();
      const resp = forecast.solarModel.hourly[hod];
      if (ghi != null && resp.coeff != null) predWh += resp.coeff * ghi;
      let act = 0;
      for (const d of dpus) {
        const pts = sliceByTsInclusive(pvBySn.get(d.sn) ?? [], hourStart, hourStart + 3_600_000);
        if (pts.length === 0) continue;
        act += pts.reduce((s, p) => s + p.value, 0) / pts.length;
      }
      actWh += act;
    }
    const predKwh = predWh / 1000;
    const actKwh = actWh / 1000;
    const errKwh = predKwh - actKwh;
    const errPct = weatherCovered && actKwh > 0.5 ? Math.round((errKwh / actKwh) * 1000) / 10 : null;
    const date = new Date(dayStart);
    days.push({
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      predictedKwh: round2(predKwh),
      actualKwh: round2(actKwh),
      errorKwh: round2(errKwh),
      errorPct: errPct,
      weatherCovered,
    });
    // Uncovered days never feed the stats — there's no prediction to score.
    if (!weatherCovered) continue;
    // v0.10.4 — only "mature" days feed the skill stats. Warmup days, where
    // the solar model was barely trained and under-predicted grossly (predKwh
    // a small fraction of actual), passed the old `>0.5` gate and dragged
    // biasFactor to a phantom 1.47 (steady-state ≈1.15) — and inflated MAE.
    // Require the prediction to be a non-degenerate fraction of actual.
    if (predKwh > 0.5 && actKwh > 0.5 && predKwh >= 0.25 * actKwh) {
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
  const dpus = allDpus(devices);
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

const SELF_CONSUMPTION_TTL_MS = 15 * 60 * 1000; // v0.9.82 — staggered warm; 7-day aggregate, 15-min freshness ample

export interface SelfConsumption {
  generatedAt: number;
  windowDays: number;
  pvKwh: number;           // total PV generated across the fleet
  loadKwh: number;         // total household consumption (panel load + DPU AC-out passthrough)
  batteryChargeKwh: number;
  batteryDischargeKwh: number;
  gridImportKwh: number;   // DPU ac_in — grid that CHARGED the DPUs (a subset of total home grid)
  /** v0.34.0 — total whole-home grid import metered at the SHP2 main (grid_home_w
   *  = wattInfo.gridWatt). Unlike gridImportKwh (DPU ac_in), this captures grid
   *  that serves home loads directly through the panel — the term that closes the
   *  load energy balance. Reads ~0 until the new metric accumulates history. */
  gridToHomeKwh: number;
  pvToLoadKwh: number;     // estimate: PV that went straight to load (PV − battery-charge − export)
  pvToBatteryKwh: number;  // estimate: PV that charged the battery
  solarFractionOfLoadPct: number | null; // (loadKwh − gridForKpiKwh) ÷ loadKwh — share of load not served by grid; null when grid can't be trusted (see gridForKpiKwh)
  directUseRatioPct: number | null;      // pvToLoad ÷ pvKwh
  /** v0.40.0 — the coverage-GATED grid term used for solarFraction & carbon:
   *  max(gridToHomeKwh, gridImportKwh) when grid_home_w covers the load window;
   *  null when an SHP2 home's grid_home_w hasn't accumulated enough history yet
   *  (so the KPIs read "unknown" rather than an impossible value); gridImportKwh on
   *  a DPU-only install with no SHP2 main. */
  gridForKpiKwh: number | null;
  /** v0.40.0 — grid_home_w measured coverage as a fraction of panel_load coverage
   *  over the window (0..1). Below GRID_HOME_MIN_COVERAGE the whole-home grid term
   *  is not trusted. */
  gridHomeCoverageFrac: number;
  /** v0.69.0 — # of DPU cores the SHP2 reports wired into its connector slots
   *  (non-spare home cores). The PV/charge/discharge integral sums over these. */
  homeDpusConnected: number;
  /** v0.69.0 — # of those connected home cores actually CONTRIBUTING fresh telemetry
   *  to this window (live projection + not cloud-offline). When < homeDpusConnected a
   *  connected core's own PV/charge metrics are missing from the integral, so pvKwh /
   *  solarFractionOfLoadPct undercount — consumers should flag the KPI as partial
   *  coverage rather than authoritative. (The backup-pool capacity is unaffected: it
   *  comes from the SHP2's own aggregate, not these per-core sums.) */
  homeDpusReporting: number;
  /** v0.69.0 — true when the self-consumption KPIs are computed over partial home-core
   *  coverage and should be discounted: an SHP2 is present but a wired home core isn't
   *  contributing, OR the SHP2 itself reported zero connectors (cloud-offline → the
   *  home-only integral scope is gone). A DPU-only install (no SHP2) is never partial. */
  homeDpusCoveragePartial: boolean;
}

let selfConsumptionCache: { ts: number; key: string; value: SelfConsumption } | null = null;

/* v0.9.84 — per-calendar-day energy memoization. computeSelfConsumption
 * re-integrated 7 full days of raw samples every 12-min warm cycle even
 * though only the trailing minutes changed — the lone function still
 * blocking the Pi's event loop (~1.9 s after v0.9.83's bucket coarsening).
 * A COMPLETED calendar day's energy totals are immutable, so we compute
 * each once and cache it; only the two moving boundary partials (the tail
 * of the window's first day + today-so-far) are re-integrated per call.
 * Per-call scan drops from 7 days to ~2 → ~0.5 s, while preserving the
 * exact rolling [now-7d, now] window: sum of day-segments equals the
 * whole-window integral to <0.1 % (each segment is queried with a small
 * lookback so integrateWh anchors its start like the continuous integral
 * does at interior midnights). The cache deliberately SURVIVES the
 * result-cache reset — the result recomputes every cycle but reuses the
 * cached day-integrals. Keyed by `${localDayStartMs}|${sn}`, pruned to
 * ~10 days. */
const dailyEnergyWhCache = new Map<string, Map<string, number>>();
const DAILY_ENERGY_LOOKBACK_MS = 10 * 60 * 1000;   // = integrateWh maxGap, anchors each segment start
const DAILY_ENERGY_RETAIN_MS = 10 * 24 * 60 * 60 * 1000;

/** Local midnight starting the next calendar day (+25 h then snap → DST-safe). */
function startOfNextLocalDayMs(t: number): number {
  return startOfLocalDayMs(new Date(startOfLocalDayMs(new Date(t)) + 25 * 60 * 60 * 1000));
}

/** Sum the Wh integral of each metric over [since, now], memoizing the
 *  energy of each completed calendar day (immutable) and re-integrating
 *  only the boundary partials. Returns Wh per metric. */
export function windowedEnergyWh(
  recorder: Recorder,
  sn: string,
  metrics: string[],
  since: number,
  now: number,
  bucketSec: number,
  todayStartMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of metrics) out.set(m, 0);
  let cur = since;
  while (cur < now) {
    const dayStart = startOfLocalDayMs(new Date(cur));
    const nextMid = startOfNextLocalDayMs(cur);
    const end = Math.min(nextMid, now);
    const cacheable = cur === dayStart && end === nextMid && end <= todayStartMs; // completed past day
    // v0.15.10 — the memo key MUST include the requested metric set. Keyed only
    // by (day, sn), a call with metric set A would return a cached Map missing
    // the metrics of a later call with set B for the same (day, sn) → those
    // metrics silently resolve to 0. Currently the two callers use distinct SNs
    // so it isn't triggered, but this is a latent correctness trap; pin the
    // metrics dimension so it can never collide.
    const ck = `${dayStart}|${sn}|${[...metrics].sort().join(',')}`;
    let segWh = cacheable ? dailyEnergyWhCache.get(ck) : undefined;
    if (!segWh) {
      // Lookback lets integrateWh anchor this segment's start with the last
      // sample before it — matching the continuous integral at interior
      // midnights. Integration is still clipped to [cur, end].
      const byMetric = recorder.queryMulti(sn, metrics, cur - DAILY_ENERGY_LOOKBACK_MS, end, bucketSec);
      segWh = new Map();
      for (const m of metrics) segWh.set(m, integrateWh(byMetric.get(m) ?? [], cur, end).wh);
      if (cacheable) dailyEnergyWhCache.set(ck, segWh);
    }
    for (const m of metrics) out.set(m, (out.get(m) ?? 0) + (segWh.get(m) ?? 0));
    cur = end;
  }
  if (dailyEnergyWhCache.size > 256) {
    const cutoff = now - DAILY_ENERGY_RETAIN_MS;
    for (const k of [...dailyEnergyWhCache.keys()]) {
      if (Number(k.split('|')[0]) < cutoff) dailyEnergyWhCache.delete(k);
    }
  }
  return out;
}

/** Test/bench seam: clear the per-day energy memo. */
export function resetDailyEnergyCache(): void { dailyEnergyWhCache.clear(); }

/** v0.40.0 — minimum grid_home_w coverage (as a fraction of panel_load coverage over
 *  the window) required before the whole-home grid term is trusted for the
 *  solarFraction / carbon KPIs. The grid term is differenced against load, so it must be
 *  measured wherever load is; below this the metric spans only part of the load window
 *  and its integral undercounts grid, inflating the KPIs. */
const GRID_HOME_MIN_COVERAGE = 0.9;

/** v0.69.0 — self-consumption home-core coverage. The KPIs integrate each home core's
 *  OWN pv_total/ac_in/pack* metrics, so a SHP2-wired core that goes cloud-offline (or
 *  loses its projection) silently drops out of the sum and deflates solar_fraction.
 *  This reports how many wired home cores are actually contributing, and whether
 *  coverage is partial.
 *
 *  Crucially: when the SHP2 ITSELF is cloud-offline it reports ZERO connectors
 *  (connected.size === 0) — the home-only scope is gone and the KPI is LEAST trustworthy
 *  — so that case is flagged partial too (whenever an SHP2 exists at all). Deriving the
 *  flag from a naive `reporting < connected` would read `N < 0 = false` ("fine") in
 *  exactly that window, masking unknown as OK. A genuine DPU-only install (no SHP2) is
 *  never partial: ac_in is the grid measure and there's no SHP2 membership to miss.
 *  Exported for unit testing. */
export function selfConsumptionCoverage(
  connected: Set<string>,
  homeDpus: ReadonlyArray<{ sn: string }>,
  devices: Record<string, { online?: boolean } | undefined>,
  shp2Present: boolean,
): { homeDpusConnected: number; homeDpusReporting: number; coveragePartial: boolean } {
  const homeDpusConnected = connected.size;
  const homeDpusReporting = homeDpusConnected === 0
    ? 0 // SHP2 reported no connectors (offline/absent) → no authoritative roster
    : homeDpus.filter((d) => devices[d.sn]?.online !== false).length;
  const coveragePartial =
    shp2Present && (homeDpusConnected === 0 || homeDpusReporting < homeDpusConnected);
  return { homeDpusConnected, homeDpusReporting, coveragePartial };
}

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
  //
  // v0.9.83 — 300 s bucket (was 60). Live logs proved self-consumption is the
  // single heaviest every-cycle function — ~3.5 s on the Pi's slow disk (12
  // metrics × ~10 k 60 s-buckets × 3 home DPUs ≈ 360 k rows transferred +
  // integrated), the lone cycle still tripping the >3 s slow-cycle log after
  // the v0.9.82 stagger. Coarsening to 300 s returns 5× fewer rows; benchmark
  // (3.1 M-row DB) measured 1.8× faster (the SQL scan of raw rows dominates,
  // so the bucket only shrinks the output+integrate cost) with a 0.003 %
  // change to every kWh total — far inside the 0.1 % rounding. 3.5 s → ~1.9 s
  // pushes it under the log threshold. 5-min resolution is standard for a
  // 7-day rolling energy aggregate.
  const ANALYTICS_BUCKET_SEC = 300;
  // v0.9.76 — sum PV / charge / discharge / grid-import over SHP2-connected
  // DPUs only. The denominator (loadKwh) is SHP2 panel_load — intrinsically
  // home-only — so the numerator MUST match scope or the ratio is wrong.
  // Pre-fix bug: solarFractionOfLoadPct came out 127 % (physically impossible)
  // because spare-Core PV + bench-charge cycles inflated the home numerator
  // against the home-only load denominator.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = homeConnectedDpus(dpus, connected);
  // v0.69.0 — coverage telemetry (see selfConsumptionCoverage). The KPIs integrate each
  // home core's OWN pv_total/ac_in/pack* metrics, so a SHP2-wired core that goes
  // cloud-offline / loses its projection silently drops out and deflates the KPIs.
  // Surface the gap (we deliberately DON'T gate the cache: on this fleet home cores go
  // cloud-offline for hours, and gating would disable the heaviest analytics fn for that
  // whole window; the value is equally deflated cached-or-not, so visibility is the fix).
  const { homeDpusConnected, homeDpusReporting, coveragePartial: homeDpusCoveragePartial } =
    selfConsumptionCoverage(connected, homeDpus, devices, shp2 != null);
  // v0.9.84 — integrate via windowedEnergyWh: completed calendar days are
  // memoized (immutable), so only today + the window's leading partial are
  // re-scanned. Benchmark: 7.4× faster warm, output identical to whole-window
  // to 0.011 %. todayStart marks which days are "completed" (cacheable).
  const todayStart = startOfLocalDayMs();
  let pvKwh = 0, batteryChargeKwh = 0, batteryDischargeKwh = 0, gridImportKwh = 0;
  for (const d of homeDpus) {
    const metricsNeeded = ['pv_total', 'ac_in'];
    for (const pk of d.projection.packs) {
      metricsNeeded.push(`pack${pk.num}_in`, `pack${pk.num}_out`);
    }
    const wh = windowedEnergyWh(recorder, d.sn, metricsNeeded, since, now, ANALYTICS_BUCKET_SEC, todayStart);
    pvKwh += (wh.get('pv_total') ?? 0) / 1000;
    gridImportKwh += (wh.get('ac_in') ?? 0) / 1000;
    for (const pk of d.projection.packs) {
      batteryChargeKwh += (wh.get(`pack${pk.num}_in`) ?? 0) / 1000;
      batteryDischargeKwh += (wh.get(`pack${pk.num}_out`) ?? 0) / 1000;
    }
  }
  // v0.78.0 — RESTORE the display basis for the KPIs. The loop above integrates only
  // LIVE-present home Cores, so a cloud-wedged Core (absent from the device map but still
  // an authoritative SHP2-connected source) silently deflates pvKwh → solarFraction /
  // directUseRatio. Add each CONNECTED-but-ABSENT SN's OWN recorded window integral. A
  // wedged Core isn't in `devices`, so we can't read d.projection.packs for its pack list;
  // instead enumerate the pack{N}_in/out metrics that ACTUALLY EXIST in the recorder for
  // that SN via listMetrics — the anti-fabrication safety valve (real recorded metrics
  // only; an SN with no history contributes 0 and adds nothing). Order-independent sums.
  const presentHomeSns = new Set(homeDpus.map((d) => d.sn));
  const missingConnectedSns = [...connected].filter((sn) => !presentHomeSns.has(sn));
  for (const sn of missingConnectedSns) {
    const recorded = recorder.listMetrics(sn);
    const packInMetrics = recorded.filter((m) => /^pack\d+_in$/.test(m));
    const packOutMetrics = recorded.filter((m) => /^pack\d+_out$/.test(m));
    const metricsNeeded = ['pv_total', 'ac_in', ...packInMetrics, ...packOutMetrics];
    const wh = windowedEnergyWh(recorder, sn, metricsNeeded, since, now, ANALYTICS_BUCKET_SEC, todayStart);
    pvKwh += (wh.get('pv_total') ?? 0) / 1000;
    gridImportKwh += (wh.get('ac_in') ?? 0) / 1000;
    for (const m of packInMetrics) batteryChargeKwh += (wh.get(m) ?? 0) / 1000;
    for (const m of packOutMetrics) batteryDischargeKwh += (wh.get(m) ?? 0) / 1000;
  }
  const shp2Wh = shp2
    ? windowedEnergyWh(recorder, shp2.sn, ['panel_load', 'grid_home_w'], since, now, ANALYTICS_BUCKET_SEC, todayStart)
    : new Map<string, number>();
  const loadKwh = (shp2Wh.get('panel_load') ?? 0) / 1000;
  // v0.34.0 — total whole-home grid import (SHP2 main). This is the authoritative
  // superset: it captures grid that serves home loads directly through the panel,
  // not just grid that charged the DPUs (ac_in). There's no back-fill, so on a
  // fresh install (or any window before v0.34.0) it reads ~0 until grid_home_w
  // accumulates history.
  const gridToHomeKwh = (shp2Wh.get('grid_home_w') ?? 0) / 1000;
  // v0.40.0 — COVERAGE GATE (corrects the v0.39.0 "no gate needed" assumption).
  // integrateWh reports a metric's partial integral as a full-window total — the
  // pre-instrumentation span just counts as 0 Wh. grid_home_w was instrumented in
  // v0.34.0 with NO back-fill, so for ~7 days after the update it covers only the TAIL
  // of the window while panel_load covers all of it → the grid term is a gross undercount
  // and solarFraction / carbon come out impossibly inflated (observed live 2026-06-21:
  // solar_fraction_of_load = 91.8 %, vs a ~46 % PV/load ceiling). max() cannot rescue
  // this — both args undercount. Gate on grid_home_w coverage RELATIVE TO panel_load
  // coverage (not the raw window): the grid term is differenced against load, so it must
  // be measured wherever load is. This passes a genuinely-short-but-complete history (and
  // test fixtures), and only trips during the instrument-ramp asymmetry that causes the bug.
  let gridHomeCoverageFrac = 0;
  if (shp2) {
    const cov = recorder.queryMulti(
      shp2.sn, ['panel_load', 'grid_home_w'], since - DAILY_ENERGY_LOOKBACK_MS, now, ANALYTICS_BUCKET_SEC,
    );
    const loadCovMs = integrateWh(cov.get('panel_load') ?? [], since, now).coverageMs;
    const gridCovMs = integrateWh(cov.get('grid_home_w') ?? [], since, now).coverageMs;
    gridHomeCoverageFrac = loadCovMs > 0 ? Math.min(1, gridCovMs / loadCovMs) : 0;
  }
  const gridHomeTrusted = !!shp2 && gridHomeCoverageFrac >= GRID_HOME_MIN_COVERAGE;
  // Grid term for the grid-displacement KPIs (solarFraction, carbon):
  //  • SHP2 home + grid_home_w covers the load window → whole-home superset max(…).
  //  • SHP2 home + grid_home_w does NOT yet cover it → null: this home's grid flows
  //    through the SHP2 main, which the DPU ac_in is structurally blind to, so without
  //    grid_home_w we cannot honestly measure grid — publish unknown over a wrong number.
  //  • No SHP2 (DPU-only install) → ac_in IS the grid measure (loadKwh≈0 there anyway).
  const gridForKpiKwh: number | null =
    !shp2 ? gridImportKwh
      : gridHomeTrusted ? Math.max(gridToHomeKwh, gridImportKwh)
        : null;

  // Charge fed by PV is what the PV produced beyond what went to load — the rest
  // came from grid. On an off-grid system gridImportKwh ≈ 0 and PV ≈ load+charge.
  // v0.93.0 (audit #4) — on an SHP2 home the DPU `ac_in` (gridImportKwh) reads ~0
  // while real grid flows through the SHP2 main (gridForKpiKwh, the coverage-gated
  // term used for solarFraction). Subtracting only ac_in credited ALL battery charge
  // to PV even while the SHP2 charged the pool from grid at the floor, over-stating
  // direct-use. Apportion the TRUSTED grid load-first (the SHP2 carries the home from
  // grid and tops the pool at the ~10% floor): grid beyond the load is what charged
  // the battery from grid; the remaining charge is PV. Fall back to ac_in for a
  // DPU-only install or when grid_home_w isn't trusted yet (gridForKpiKwh null).
  const gridToBatteryKwh = (shp2 && gridForKpiKwh != null)
    ? Math.max(0, gridForKpiKwh - loadKwh)
    : gridImportKwh;
  const pvToBatteryKwh = Math.max(0, batteryChargeKwh - gridToBatteryKwh);
  const pvToLoadKwh = Math.max(0, pvKwh - pvToBatteryKwh);
  const value: SelfConsumption = {
    generatedAt: now,
    windowDays,
    pvKwh: round2(pvKwh),
    loadKwh: round2(loadKwh),
    batteryChargeKwh: round2(batteryChargeKwh),
    batteryDischargeKwh: round2(batteryDischargeKwh),
    gridImportKwh: round2(gridImportKwh),
    gridToHomeKwh: round2(gridToHomeKwh),
    pvToLoadKwh: round2(pvToLoadKwh),
    pvToBatteryKwh: round2(pvToBatteryKwh),
    // v0.10.4 — solar fraction = share of load NOT met by grid import.
    // Prior `(pvToLoad + batteryDischarge)/load` double-counted PV that
    // transited the battery (counted at charge AND again at discharge),
    // yielding an impossible 104.5% while importing 76 kWh of grid. The
    // grid-displacement form caps at 100% by construction.
    // v0.40.0 — null when gridForKpiKwh is untrusted (grid_home_w ramp on an SHP2 home).
    solarFractionOfLoadPct: (loadKwh > 0.5 && gridForKpiKwh != null)
      ? Math.max(0, Math.round(((loadKwh - gridForKpiKwh) / loadKwh) * 1000) / 10)
      : null,
    directUseRatioPct: pvKwh > 0.5 ? Math.round((pvToLoadKwh / pvKwh) * 1000) / 10 : null,
    gridForKpiKwh: gridForKpiKwh != null ? round2(gridForKpiKwh) : null,
    gridHomeCoverageFrac: Math.round(gridHomeCoverageFrac * 1000) / 1000,
    homeDpusConnected,
    homeDpusReporting,
    homeDpusCoveragePartial,
  };
  // v0.15.13 — require a structurally complete fleet (≥1 DPU AND the SHP2)
  // before caching. The v0.15.11-era guard accepted any DPU, but during the
  // post-restart warm a snapshot with one polled DPU and no SHP2 yet computed
  // loadKwh=0 / partial pvKwh and served it for the full TTL (observed live
  // after the v0.15.12 update: loadKwh=0, pvKwh=184 of 527). An incomplete
  // snapshot may be returned, but never latched.
  if (dpus.length > 0 && shp2 != null) selfConsumptionCache = { ts: now, key, value };
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
// v0.14.2 — cap at the recorder's 30-day retention (recorder.ts RETAIN_MS), like
// DEGRADE_REPORT_HISTORY_MS. The samples table is pruned to 30 days, so the old
// 400-day window scanned ~370 days of empty index range per pack every cache
// cycle on the synchronous SQLite store — the same dead-range scan the
// degradation path was fixed for in v0.9.80. Output is identical (no rows older
// than 30 days exist to count).
const THERMAL_EVENT_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const THERMAL_THRESHOLD_C_INFO = (96 - 32) / 1.8;   // ≈ 35.6 °C
const THERMAL_THRESHOLD_C_WARN = (113 - 32) / 1.8;  // 45 °C
const THERMAL_THRESHOLD_C_CRIT = (131 - 32) / 1.8;  // 55 °C
const THERMAL_HYSTERESIS_C = 1.5; // must fall back this far before re-arming
// v0.14.x — recorder gap cap for time-above-threshold accounting. The recorder
// only guarantees a sample at least every 5 min (recorder.ts MAX_INTERVAL_MS)
// while telemetry is actually flowing; a wider inter-sample dt means the
// recorder/telemetry was down for that span, not that the pack sat hot the
// whole time. Mirrors the GAP_THRESHOLD_MS = 3× heartbeat convention recorder.ts
// already uses for telemetry-gap detection. Any dt beyond this cap is dropped
// from warm/hot/overheat accounting instead of being credited to the pre-gap band.
const THERMAL_SAMPLE_GAP_CAP_MS = 15 * 60 * 1000; // 15 min = 3 × 5-min heartbeat

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
  const dpus = allDpus(devices);

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
        // Time-above-threshold — credit the interval between this sample and
        // the last to whichever band the previous reading sat in, UNLESS that
        // interval is wider than a few recorder heartbeats: a wide dt means a
        // recorder/telemetry gap sat in between, and the gap span must not be
        // attributed to the pre-gap band (a pack reading hot right before a
        // multi-hour outage should not be scored as hot for the whole outage).
        if (prevTs != null && prevTemp != null) {
          const dt = p.ts - prevTs;
          if (dt <= THERMAL_SAMPLE_GAP_CAP_MS) {
            if (prevTemp >= THERMAL_THRESHOLD_C_INFO) warmMs += dt;
            if (prevTemp >= THERMAL_THRESHOLD_C_WARN) hotMs += dt;
            if (prevTemp >= THERMAL_THRESHOLD_C_CRIT) overheatMs += dt;
          }
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
  recentEffPct: number | null;     // v0.13.1 — register-consistency ratio (W vs V·A), capped 100%; median over the recent window
  baselineEffPct: number | null;   // register-consistency ratio (W vs V·A), capped 100%; median over the earliest 30% of history
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

/**
 * v0.13.1 — median register-consistency ratio (W vs V·A), capped at 100%.
 * The per-sample gate in ratioSeries already drops >100.5%, but the median can
 * still land at 100.x from rounding — and a >100% headline reads as a broken
 * "efficiency". Returns null for an empty input. Pure + exported for testing.
 */
export function cappedMedianEffPct(effs: number[]): number | null {
  return effs.length ? Math.min(100, median(effs)) : null;
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
    // v0.13.1 — register-consistency ratio (W vs V·A), capped 100%. This is
    // NOT a real conversion efficiency — W, V, and A are independent registers
    // that should agree to ~100%; >100% means a measurement/register skew, not
    // physics. Tightened 105→100.5 to mirror the v0.10.4 coulombic-eff fix
    // (~analytics.ts:1356-1362): the old 105 band let register quirks surface
    // impossible >100% medians. 100.5 tolerates rounding; drop the rest.
    if (eff < 50 || eff > 100.5) continue; // clamp pathological / register-skew outliers
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
  const dpus = allDpus(devices);

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
      // v0.13.1 — cap the rendered median at 100% (see cappedMedianEffPct).
      // Even with the per-sample 100.5 gate above, the median can land at 100.x
      // from rounding; this is a register-consistency ratio, so a >100% headline
      // reads as broken. The drift (recent − baseline) is computed from the
      // CAPPED medians so the alert threshold (-3pp) keys off a consistent series.
      const recentEff = cappedMedianEffPct(recent);
      const baselineEff = cappedMedianEffPct(baseline);
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
  // v0.99.0 — injectable clock for the ELAPSED-HOUR / local-day determination only.
  // Defaults to Date.now() in production; tests pass a deterministic mid-day timestamp so
  // the per-hour assertions never depend on wall-clock time-of-day (in the first ~30 min
  // after local midnight no hour's midpoint has elapsed, so perHour would be empty). The
  // cache-TTL freshness check + the cache `ts` stay on the REAL clock (see below).
  nowMs: number = Date.now(),
): Promise<ClippingEstimate> {
  if (clippingCache && Date.now() - clippingCache.ts < CLIPPING_TTL_MS) {
    return clippingCache.value;
  }
  const now = nowMs;
  const empty = (): ClippingEstimate => ({
    generatedAt: now,
    todayKwh: 0,
    perHour: [],
    arrayPeakW: 0,
    hoursAtPeak: 0,
  });
  if (!forecast) return empty();

  const dpus = allDpus(devices);
  if (dpus.length === 0) return empty();
  // v0.9.76 — clipping is "home array hit inverter ceiling". Use only
  // SHP2-connected DPUs so a spare with bench panels doesn't either
  // inflate `observedW` (false-negative clipping) or pollute the
  // `arrayPeakW` ceiling derived from the now-also-filtered solar model.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = homeConnectedDpus(dpus, connected);
  // v0.78.0 — RESTORE the display basis. Clipping is a display KPI ("did the home
  // array hit its inverter ceiling today?"), so it reads the SAME restored basis as the
  // forecast tiles: iterate ALL SHP2-connected SNs (live-present home Cores + any
  // cloud-wedged Core that's absent from the device map but still an authoritative
  // connected source), and use restoredSolarModel for the arrayPeak ceiling + per-hour
  // model coeff. observedW/arrayPeak/modelW are read straight from each SN's OWN recorded
  // pv_total — anti-fabrication: real recorded values summed by SN, never scaled. Old
  // cached forecasts predating this field fall back to solarModel (== reporting basis).
  const restoredModel = forecast.restoredSolarModel ?? forecast.solarModel;
  const presentHomeSns = new Set(homeDpus.map((d) => d.sn));
  const missingConnectedSns = [...connected].filter((sn) => !presentHomeSns.has(sn));
  const clippingSns = [...homeDpus.map((d) => d.sn), ...missingConnectedSns];
  // A wedge that hides EVERY home Core still leaves connected sources with recorder
  // history — proceed on those. Only bail when there's genuinely nothing to read.
  if (clippingSns.length === 0) return empty();

  const arrayPeakW = Math.max(0, ...restoredModel.hourly.map((h) => h.observedMaxPvW));
  if (arrayPeakW <= 0) return empty();

  // Today's per-hour GHI lives in the weather cache (Open-Meteo returns the
  // past 3 days alongside the forecast). getWeather() is cached and cheap.
  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHour = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHour.set(Math.floor(wh.ts / 3_600_000), wh);

  const todayStart = startOfLocalDayMs(new Date(nowMs));
  // v0.9.29 — pull pv_total ONCE per DPU for today's full window, then
  // bucket by hour in JS. Was 24 × dpus = 96 round-trips per call; now
  // dpus = 4 round-trips. The bucket-sec=60 averages within a minute so
  // the per-hour mean we ultimately compute is identical to the previous
  // raw-sample mean to within rounding (each minute bucket already holds
  // the within-minute average, which matters more for accuracy than the
  // arithmetic mean of raw 10-second readings).
  const dpuPvByHour: Map<string, number[][]> = new Map(); // sn → 24 arrays of bucket values
  for (const sn of clippingSns) {
    const pts = recorder.query(sn, 'pv_total', todayStart, now, 60);
    const hourBuckets: number[][] = Array.from({ length: 24 }, () => []);
    for (const p of pts) {
      const h = Math.floor((p.ts - todayStart) / 3_600_000);
      if (h >= 0 && h < 24) hourBuckets[h].push(p.value);
    }
    dpuPvByHour.set(sn, hourBuckets);
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
    // v0.13.3 — iterate the SHP2-connected scope only (dpuPvByHour is populated
    // exactly for clippingSns above), so a spare DPU's PV never inflates observedW.
    // v0.78.0 — clippingSns = live-present home Cores + cloud-wedged connected Cores,
    // so a wedge no longer deflates the observed fleet PV to the reporting Cores.
    for (const sn of clippingSns) {
      const bucket = dpuPvByHour.get(sn)?.[h] ?? [];
      if (bucket.length === 0) continue;
      observedW += bucket.reduce((s, x) => s + x, 0) / bucket.length;
      totalPts += bucket.length;
    }
    if (totalPts === 0) continue;
    const wx = wxByHour.get(Math.floor(hourStart / 3_600_000));
    const hod = new Date(hourStart).getHours();
    const resp = restoredModel.hourly[hod];
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
  // v0.99.0 — cache freshness is REAL wall-clock (decoupled from the injectable compute
  // clock `now`), so an injected mid-day `nowMs` in tests can't poison a later real call's
  // TTL. In production `nowMs === Date.now()` so this is a no-op change.
  clippingCache = { ts: Date.now(), value };
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

const CURTAIL_TTL_MS = 5 * 60 * 1000;         // v0.9.82 — 5 min (was 1). The 7-day history walk is the cost; the alert monitor reads this cache, 5-min freshness is fine and halves its recompute frequency.
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
// 100% in normal operation (the packs run to a configured ceiling, not full).
// Storm Guard / outage-prep raises that ceiling to 100% — and because it
// does so by changing `chgMaxSoc` itself, reading the field live means we
// automatically track whatever mode is active without needing a separate
// storm-guard flag.
//
// v0.9.79 — curtailment doesn't begin AT the ceiling, it begins in the
// CV/absorption taper BELOW it. As the LFP packs approach full, charge
// acceptance falls and the DPU backs off its MPPTs to match (load +
// dwindling charge current) — shedding the LV string first. Live evidence
// from the operator's Core 3 (ceiling 100): the LV MPPT held ~900-1060 W all day,
// then collapsed 698 W → 0 W as SoC climbed 88 → 90 %, while HV only
// throttled partially. So real PV rejection starts ~10 % below the
// ceiling, not 2 %. The saturation threshold is therefore `ceiling − band`
// with a 10-point taper band. The downstream guards still prevent false
// positives: the expected-vs-actual gap must exceed MIN_SURPLUS_W (so we
// only fire when PV is genuinely being rejected, not merely tapering into
// a battery that's still absorbing), and the PV-matched-to-load check
// rejects bulk-charge hours where PV >> load.
const CURTAIL_TAPER_BAND_PCT = 10;   // SoC band below the ceiling where shedding begins

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

/** The SoC at/above which the pool enters the charge-taper band where PV
 *  shedding begins (curtailment can occur): `ceiling − taper band`. When no
 *  ceiling is reported we assume 100 (the EcoFlow default), so the fallback
 *  threshold is 90 — consistent with the taper-aware model rather than the
 *  old fixed 96. */
function saturationThresholdPct(ceiling: number | null): number {
  const eff = ceiling != null && ceiling > 0 ? ceiling : 100;
  return Math.max(0, eff - CURTAIL_TAPER_BAND_PCT);
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
    current: { socAvg: 0, pvActualW: 0, pvExpectedW: null, loadW: 0, ghiWm2: null, bayesianSamples: 0, chargeCeilingPct: null, saturationThresholdPct: saturationThresholdPct(null) },
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

  const dpus = allDpus(devices);
  if (dpus.length === 0) return empty;
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = homeConnectedDpus(dpus, connected);
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
  // v0.24.3 — batch each home DPU's three per-hour metrics (soc, chg_max_soc,
  // pv_total) into ONE recorder.queryMulti instead of three separate query()
  // calls. queryMulti is the established batched-equivalent primitive (9 other
  // analytics call sites) and, with the IDENTICAL [hourStart, hourEnd, 60]
  // bounds, returns byte-identical per-metric buckets — so every mean below is
  // unchanged; it just cuts ~13 synchronous SQLite round-trips/hour to ~5 in the
  // analytics worker. Deliberately stays PER-HOUR (not a cross-hour prefetch):
  // slicing bucketed series is NOT byte-identical at the inclusive hour boundary
  // (see backtest.ts:119), and curtailment kWh must stay exact.
  const dpuMetrics = new Map<string, Map<string, Array<{ ts: number; value: number }>>>();
  for (const d of homeDpus) {
    dpuMetrics.set(d.sn, recorder.queryMulti(d.sn, ['soc', 'chg_max_soc', 'pv_total'], hourStart, hourEnd, 60));
  }
  const meanInWindow = (sn: string, metric: string): number | null => {
    // Home DPUs are served from the batched map (queryMulti returns an empty
    // array, never undefined, for a no-data metric); the SHP2's panel_load
    // (a different SN) falls through to a single query. `?? ` only fires on a
    // genuinely-absent SN/metric, so an empty array still correctly yields null.
    const pts = dpuMetrics.get(sn)?.get(metric) ?? recorder.query(sn, metric, hourStart, hourEnd, 60);
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
    // v0.15.11 — was Math.min(μ*900, μ*1000), which for any positive μ is just
    // μ*900 (the *1000 operand was dead, leftover from a refactor). Write the
    // intent directly: the 900 W/m² hard cap.
    expectedW = post.posteriorMean * 900;
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
    // Event window uses onset→ends (the storm's real span). `expires` is only the
    // NWS message-refresh deadline (~30 min out) and must NOT be shown as the event
    // end — pairing onset with expires made a future storm read start-after-end.
    // Window resolution is the pure, unit-tested nwsEventWindow() (nws.ts).
    const win = nwsEventWindow(a, Date.now());
    const beginsDate = win.beginsMs != null ? new Date(win.beginsMs) : null;
    const endsDate = win.endsMs != null ? new Date(win.endsMs) : null;
    // inEffectNow is true whenever beginsMs is null, so the else branch always has
    // a non-null beginsDate — but keep an explicit guard for the type-checker.
    const inEffectNow = win.inEffectNow;
    const whenStr = inEffectNow || !beginsDate
      ? (endsDate ? `now through ${endsDate.toLocaleString([], { weekday: 'short', hour: 'numeric' })}` : 'now')
      : `${beginsDate.toLocaleString([], { weekday: 'short', hour: 'numeric' })}${endsDate ? ` through ${endsDate.toLocaleString([], { weekday: 'short', hour: 'numeric' })}` : ''}`;
    out.push({
      id: `storm-${a.id || a.event}`.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 96),
      severity: sev,
      category: 'Grid',
      source: 'learned',
      device: 'System',
      title: `${a.event} — pre-charge recommended`,
      // Charge advice must not say "before it begins" for an event already in
      // effect (whenStr = "now …"); use present-tense advice in that case.
      detail: `NWS has issued a ${a.event} for ${a.areaDesc ?? 'your area'}, in effect ${whenStr}. ${
        inEffectNow
          ? 'Charge the backup pool to 100% now so grid loss leaves you in a strong position.'
          : 'Charge the backup pool to 100% before it begins so grid loss leaves you in a strong position.'
      } ${a.headline ?? ''}`,
      facts: [
        { label: 'Event', value: a.event },
        { label: 'Severity', value: a.severity },
        { label: 'Urgency', value: a.urgency },
        { label: 'Begins', value: beginsDate ? (inEffectNow ? 'In effect now' : beginsDate.toLocaleString()) : '—' },
        { label: 'Ends', value: endsDate ? endsDate.toLocaleString() : '—' },
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

const CARBON_TTL_MS = 15 * 60 * 1000; // v0.9.82 — reuses self-consumption; staggered with it
const DEFAULT_GRID_CO2_LB_PER_MWH = Number(process.env.GRID_CO2_INTENSITY_LB_PER_MWH ?? 1100);
// 1 lb/MWh = 0.4536 kg / 1000 kWh = 0.0004536 kg/kWh
const LB_PER_MWH_TO_KG_PER_KWH = 0.4536 / 1000;
// EPA: avg US passenger car emits ~0.404 kg CO2 per mile.
const KG_CO2_PER_MILE = 0.404;

export interface CarbonReport {
  generatedAt: number;
  gridCo2IntensityKgPerKwh: number;
  windowDays: number;
  // Recent rolling window. v0.40.0 — null when the whole-home grid term isn't trusted
  // yet (grid_home_w ramp on an SHP2 home); the lifetime fields below are unaffected.
  pvToLoadKgAvoided: number | null;
  batteryDischargeKgAvoided: number | null;
  totalKgAvoided: number | null;
  equivMilesNotDriven: number | null;
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

  // v0.10.4 — CO2 avoided = the grid you DIDN'T pull = (load − whole-home grid).
  // Prior `pvToLoad + batteryDischarge` double-counted PV that cycled through
  // the battery (~23% overstatement / ~50 kg). Cap the battery-served
  // component to the remainder so the parts still sum to the honest total.
  // v0.40.0 — reuse the COVERAGE-GATED grid term from self-consumption. When the SHP2
  // whole-home grid metric (grid_home_w) doesn't yet span the load window, gridForKpiKwh
  // is null and we cannot honestly compute grid displaced → null the WINDOW carbon rather
  // than overstate it ~1.7× (the lifetime figures below derive from lifetime PV and are
  // unaffected). Mirrors the solarFractionOfLoadPct gate.
  const gridDisplacedKwh = sc.gridForKpiKwh != null ? Math.max(0, sc.loadKwh - sc.gridForKpiKwh) : null;
  const totalKg = gridDisplacedKwh != null ? gridDisplacedKwh * intensity : null;
  const pvToLoadKg = totalKg != null ? Math.min(sc.pvToLoadKwh * intensity, totalKg) : null;
  const batteryDischargeKg = totalKg != null && pvToLoadKg != null ? Math.max(0, totalKg - pvToLoadKg) : null;
  const lifetimeKg = pvLifetimeKwh * intensity; // lifetime PV ≈ grid kWh avoided

  const value: CarbonReport = {
    generatedAt: Date.now(),
    gridCo2IntensityKgPerKwh: Math.round(intensity * 10000) / 10000,
    windowDays,
    pvToLoadKgAvoided: pvToLoadKg != null ? round2(pvToLoadKg) : null,
    batteryDischargeKgAvoided: batteryDischargeKg != null ? round2(batteryDischargeKg) : null,
    totalKgAvoided: totalKg != null ? round2(totalKg) : null,
    equivMilesNotDriven: totalKg != null ? Math.round(totalKg / KG_CO2_PER_MILE) : null,
    lifetimePvKwh: round2(pvLifetimeKwh),
    lifetimeKgAvoided: Math.round(lifetimeKg),
    lifetimeMilesNotDriven: Math.round(lifetimeKg / KG_CO2_PER_MILE),
  };
  // v0.15.11 — do NOT poison-cache zeros. When the snapshot is transiently empty
  // (no DPUs/SHP2 — e.g. a Core in the EcoFlow cloud-offline state) every
  // integral sums to 0; caching that serves 0 for the full TTL even after data
  // recovers. Match the sibling engines (selfConsumption/RTE/degradation): only
  // cache a device-present result, otherwise return the (uncached) zero so the
  // next tick recomputes from real data.
  // v0.15.13 — require BOTH kinds (was `some(dpu || shp2)`): during the
  // post-restart warm a single polled DPU satisfied the v0.15.11 guard while
  // the SHP2 was still absent, latching a partial-fleet carbon figure for the
  // TTL. An incomplete snapshot may be returned, but never latched.
  const deviceList = Object.values(devices);
  const fleetComplete =
    deviceList.some((d) => d.projection?.kind === 'dpu') &&
    deviceList.some((d) => d.projection?.kind === 'shp2');
  if (fleetComplete) carbonCache = { ts: Date.now(), value };
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

const TARIFF_TTL_MS = 15 * 60 * 1000; // v0.9.82 — staggered warm; 7-day cost aggregate
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

  const dpus = allDpus(devices);
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
  const homeDpus = homeConnectedDpus(dpus, connected);
  const dpuAcInSeries = new Map<string, Array<{ ts: number; value: number }>>();
  for (const d of homeDpus) {
    dpuAcInSeries.set(d.sn, recorder.query(d.sn, 'ac_in', since, now, 60));
  }
  const loadSeries = shp2 ? recorder.query(shp2.sn, 'panel_load', since, now, 60) : [];

  // v0.93.0 (audit #5) — whole-home grid term for the tariff cost, coverage-gated,
  // mirroring computeSelfConsumption's gridForKpiKwh / gridHomeTrusted pattern. On an
  // SHP2 home the DPU `ac_in` reads ~0 while real grid flows through the SHP2 main
  // (grid_home_w), so a cost built only from ac_in reported gridImportCost=$0 and
  // credited ALL panel_load as solar value. When grid_home_w is measured wherever
  // panel_load is (coverage ≥ GRID_HOME_MIN_COVERAGE) we take the whole-home superset
  // max(grid_home_w, ac_in) per hour; otherwise (DPU-only install, or the post-instrument
  // ramp before grid_home_w spans the window) we keep ac_in exactly as before.
  const gridHomeSeries = shp2 ? recorder.query(shp2.sn, 'grid_home_w', since, now, 60) : [];
  let gridHomeTrusted = false;
  if (shp2) {
    const cov = recorder.queryMulti(
      shp2.sn, ['panel_load', 'grid_home_w'], since - DAILY_ENERGY_LOOKBACK_MS, now, 300,
    );
    const loadCovMs = integrateWh(cov.get('panel_load') ?? [], since, now).coverageMs;
    const gridCovMs = integrateWh(cov.get('grid_home_w') ?? [], since, now).coverageMs;
    const gridHomeCoverageFrac = loadCovMs > 0 ? Math.min(1, gridCovMs / loadCovMs) : 0;
    gridHomeTrusted = gridHomeCoverageFrac >= GRID_HOME_MIN_COVERAGE;
  }

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
      // v0.93.0 (audit #5) — take the whole-home grid superset when trusted (see the
      // gridHomeTrusted derivation above). max() keeps the DPU-charging ac_in if it ever
      // exceeds the SHP2 main for the hour; on a DPU-only install or the untrusted ramp
      // this branch never runs, so ac_in is used unchanged.
      if (shp2 && gridHomeTrusted) {
        gridWh = Math.max(gridWh, integrateWh(gridHomeSeries, t, tEnd).wh);
      }
      gridCost += (gridWh / 1000) * rate;
      // v0.10.4 — value only the solar+battery-served load (subtract grid),
      // not the entire panel_load. Prior code credited grid-served kWh as
      // "solar value", inflating net savings ~$13 over the window.
      loadValue += (Math.max(0, loadWh - gridWh) / 1000) * rate;
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
  // v0.15.11 — don't poison-cache zeros on a transient empty snapshot (Core in
  // EcoFlow cloud-offline state → no DPUs/SHP2 → every $ integral is 0). Match the
  // sibling engines: only cache a device-present result.
  // v0.15.13 — `&&`, not `||`: tariff needs PV (DPUs) and load (SHP2); a
  // boot-partial snapshot with only one of them computes a misleading figure
  // (observed: net_savings −$4.36 from grid-import cost with no solar value).
  if (dpus.length > 0 && shp2 != null) tariffCache = { ts: now, value };
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
  // kWh/pack. The operator's ~4 DPUs × 5 × 6.144 ≈ 122.88 kWh — the prior code's
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
    // v0.14.1 — clamp the best-case band to the array's clear-sky ceiling so P90
    // can't exceed what the panels can physically produce. P50 is already capped
    // upstream at observedMaxPvW×1.05 and P10 is floored at 0, but P90 was
    // unbounded — yielding a peak ~14 kW vs the array's observed ~10.85 kW.
    const pvCeil = forecast.pvCeilingW ?? 0;
    const p90raw = p50 * (1 + Z10 * sigmaFrac);
    const p90 = pvCeil > 0 ? Math.min(p90raw, pvCeil) : p90raw;
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

  // v1.4.4 (finding #50/#22) — index the day-ahead forecast's hours by
  // absolute hour-epoch. Each ForecastHour already carries getDayForecast's
  // FULL basis (weekday/weekend load split, predicted EV load, near-term
  // trim/anchor, and the v0.93.0/v1.3.1 PV bias-correction + re-clamp) for
  // that EXACT timestamp, so any multi-day hour the 24h forecast covers
  // reuses it verbatim below instead of a re-derived approximation.
  const forecastByHourEpoch = new Map<number, ForecastHour>();
  for (const fh of forecast.hours) forecastByHourEpoch.set(Math.floor(fh.ts / 3_600_000), fh);

  // v0.9.58 — hour-of-day fallback load lookup, kept as the fallback of last
  // resort below (see useSplitLoad) for hours beyond the 24h forecast window
  // when there isn't enough live weekday/weekend recorder history to trust
  // the day-of-week-aware split. Was previously the ONLY basis for every
  // out-of-window hour, which held day-0's weekday/weekend mix constant
  // across every day of the horizon regardless of that day's actual
  // day-of-week — see hourCurveByWeekday below for the real fix.
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

  // v1.4.4 (finding #50/#22) — day-of-week-aware load curve, the SAME basis
  // getDayForecast uses (hourCurveByWeekday + the WEEKDAY_MIN_SAMPLES=24
  // trust gate), so hours beyond the 24h forecast window (days 2-3 of a
  // 3-day rollup) pick up an ACTUAL weekend curve on a Saturday instead of
  // repeating whatever weekday/weekend mix happened to land in the single
  // day-ahead forecast (loadByHod above).
  const since = now - TYPICAL_HISTORY_MS;
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
  const WEEKDAY_MIN_SAMPLES = 24;
  const useSplitLoad =
    loadRes.weekdaySamples >= WEEKDAY_MIN_SAMPLES && loadRes.weekendSamples >= WEEKDAY_MIN_SAMPLES;
  // v1.4.4 (finding #50/#22) — reuse getDayForecast's already-derived
  // alarm-facing PV bias-correction factor (see computePvBiasCorrection) for
  // the climatology-based PV projection below, instead of raw uncorrected PV.
  const pvBiasFactor = forecast.pvBiasFactor ?? 1;

  // v1.4.4 (finding #50/#22) — predicted EV-charging load, the same source
  // getDayForecast folds in (see evByHourEpoch there). The window predictor
  // only projects the next 24h, so this mostly applies to hours already
  // covered by forecastByHourEpoch above; any spillover into the start of
  // day 2 is still added here, matching getDayForecast's own horizon.
  const evPredictions = computeEvWindowPrediction(devices, recorder);
  const evByHourEpoch = evLoadByHour(evPredictions.upcomingNext24h);

  // v0.10.4 — radiation climatology for hours BEYOND the weather window.
  // Open-Meteo's hourly radiation typically reaches only ~48 h out, so day-3
  // hours had no `wx` entry → pv computed as 0 → a phantom PV-blackout that
  // drained projected SoC to a false 0% and fired bogus "battery dead in 3
  // days" panic. Build a per-hour-of-day mean radiation from the hours we DO
  // have and reuse it past the window so day-3 reflects a typical day.
  const radClimoSum = new Array(24).fill(0);
  const radClimoCount = new Array(24).fill(0);
  for (const wh of weather.hours) {
    if (wh.radiationWm2 > 0) {
      const hod = new Date(wh.ts).getHours();
      radClimoSum[hod] += wh.radiationWm2;
      radClimoCount[hod]++;
    }
  }
  const climoRadiationWm2 = (hod: number) => (radClimoCount[hod] > 0 ? radClimoSum[hod] / radClimoCount[hod] : 0);

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
      const hourEpoch = Math.floor(t / 3_600_000);
      const hod = new Date(t).getHours();
      const fh = forecastByHourEpoch.get(hourEpoch);
      let pv: number;
      let load: number;
      if (fh) {
        // v1.4.4 — hour is inside the 24h day-ahead forecast: reuse its exact
        // bias-corrected PV and weekday/EV/trim-aware load basis verbatim.
        pv = fh.forecastPvW;
        load = fh.forecastLoadW;
      } else {
        const wx = wxByHour.get(hourEpoch);
        const resp = forecast.solarModel.hourly[hod];
        // v0.10.4 — real weather where available, else the radiation climatology
        // (see above) so day-3 doesn't collapse to a phantom 0 kWh / 0% SoC.
        const radiationWm2 = wx ? wx.radiationWm2 : climoRadiationWm2(hod);
        pv = 0;
        if (resp.coeff != null && radiationWm2 > 0) {
          const ceilW = resp.observedMaxPvW * 1.05;
          // v1.4.4 (finding #50/#22) — same v0.93.0/v1.3.1 alarm-facing bias
          // correction getDayForecast applies: clamp to the physical ceiling,
          // apply the bias factor, then RE-CLAMP (an under-predicting bias > 1
          // could otherwise push the projection past the array's observed
          // ceiling — the unsafe, runway-lengthening direction).
          pv = Math.min(Math.min(resp.coeff * radiationWm2, ceilW) * pvBiasFactor, ceilW);
        }
        // v1.4.4 (finding #50/#22) — prefer the live day-of-week-aware curve;
        // fall back to the v0.9.58 flat per-HoD mix (loadByHod above) only when
        // there isn't enough weekday/weekend history to trust the split.
        const dow = new Date(t).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const baseLoad = useSplitLoad
          ? (isWeekend ? loadRes.weekend[hod] : loadRes.weekday[hod])
          : (loadHodFilled[hod] ? loadByHod[hod] : fallbackLoad);
        const evLoad = evByHourEpoch.get(hourEpoch) ?? 0;
        load = baseLoad + evLoad;
      }
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
  const dpus = allDpus(devices);
  if (dpus.length === 0) return empty();

  const weather = await getWeather();
  if (!weather) return empty();
  const wxByHourEpoch = new Map<number, WeatherHour>();
  for (const wh of weather.hours) wxByHourEpoch.set(Math.floor(wh.ts / 3_600_000), wh);

  // Fleet PV per hour-epoch. v0.9.76 — Bayesian posterior is the
  // home's GHI→PV response; including a spare's bench-charge PV would
  // bias the prior shift away from what the connected arrays produce.
  const connected = shp2ConnectedDpuSns(devices);
  const homeDpus = homeConnectedDpus(dpus, connected);
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
  const dpus = allDpus(devices);

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

/* v0.9.82 — scoped resetters so the cache-warmer can STAGGER the heavy
 * recomputes instead of nulling all five every cycle. Benchmark (3.7M-row
 * 30-day DB) showed a real warm cycle = self-consumption 229ms + RTE 178ms +
 * tariff 32ms + curtailment 39ms (carbon reuses the warm self-consumption
 * cache → ~0ms), ≈479ms on SSD → ~3-4.5s on the Pi's slow disk. Clipping is
 * fc-derived (~0ms) so it stays every-cycle; the three heavy groups rotate
 * one per cycle. Paired with the 15-min TTLs, each refreshes every ~12 min
 * (no v0.9.11 cold window) and no single cycle re-walks all of them. */
export function resetClippingCache(): void { clippingCache = null; }
export function resetRteCache(): void { rteCache = null; }
// v0.76.0 — pack-risk cache reset seam (the 30-min riskCache had no reset export,
// forcing pack-risk tests into a single call; this lets them drive multiple inputs).
export function resetRiskCache(): void { riskCache = null; }
export function resetTariffCache(): void { tariffCache = null; }
// v0.10.4 — IR cache is a single module global NOT keyed by the device fleet
// (fine in prod where the fleet is constant, but tests with distinct fixtures
// inherit the prior run's row). Exported so a test can force a fresh compute.
export function resetIrCache(): void { irCache = null; }
// v0.13.3 — EV-window cache is likewise a single unkeyed module global with a
// 60-min TTL, so distinct test fixtures in one process inherit the first run's
// result. Exported so a test can force a fresh compute between scenarios.
export function resetEvWindowCache(): void { evWindowCache = null; }
/** Carbon recomputes self-consumption internally; null both so carbon
 *  re-pulls the freshly-warmed self-consumption rather than a stale one. */
export function resetSelfConsumptionCache(): void {
  selfConsumptionCache = null;
  carbonCache = null;
}

/** Test-only seam: clear forecast-related caches so each test starts cold. */
export function resetForecastCachesForTesting(): void {
  dayForecastCache = null; // v0.57.0 — was missing; needed to force a cold first compute when testing the structural-incompleteness latch gate
  probabilisticCache = null;
  multiDayCache = null;
  forecastSkillCache = null;
  bayesCache = null;
  ambientThermalCache = null;
  dispatchCache = null;
  curtailmentCache = null;
  baselineCache = null;
  dailyEnergyWhCache.clear();
}

/** Test-only seam: pin a Bayesian model into the cache so computeCurtailment
 *  can be exercised without a full recorder + weather walk. */
export function setBayesianModelForTesting(value: BayesianSolarModel | null): void {
  bayesCache = value ? { ts: Date.now(), value } : null;
}
