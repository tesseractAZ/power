## 6. Battery & PV Health Engines (SoH, EOL, pack-risk, resistance, RTE, thermal, soiling)

This cluster covers every long-horizon *health* analytic in the ecoflow-panel add-on: pack state-of-health (SoH) fade and end-of-life (EOL) projection, coulombic efficiency, internal resistance, round-trip efficiency (RTE), charge-curve fingerprinting, ambient-coupled thermal forecasting, thermal-event counting, string-mismatch / per-Core underperformance, soiling decomposition, inverter clipping, MPPT/inverter equipment health, and the two pack-risk scorers (heuristic v1 + ML v2).

All of these live in `server/src/analytics.ts` (~600 KB) except the ML risk model, which lives in `server/src/ml.ts`. They are pure(ish) compute functions fed by the `Recorder` time-series store plus the live `DeviceSnapshot` map, run on the analytics worker thread, cached with per-engine TTLs, and surfaced over `/api/*` endpoints. None of these engines is an *alarm* source (the alarm paths are documented separately); they are diagnostic/planning KPIs, and every one of them prefers an honest `null`/`no-data`/`learning` state over a fabricated number.

### Shared conventions

- **Recorder queries.** `recorder.query(sn, metric, since, now, bucketSec?)` and `recorder.queryMulti(sn, [metrics], since, now, bucketSec?)` return `Array<{ts, value}>` in ascending-ts order, optionally SQL-bucketed (GROUP BY) to a coarser interval to cut row counts. `queryMulti` collapses N per-metric round-trips to one. `node:sqlite` is fully synchronous, so several engines run `await new Promise(r => setImmediate(r))` between packs to yield the event loop. Since v1.188.1 the recorder writes no rows for a device whose readings are held (cloud-dark, its last projection kept in the store) and moves held stretches already written to `held_samples` (heldSamples.ts), so every series here has a gap where it once had restated readings.
- **Site clock.** Every hour-of-day bucket and calendar day here is the site's (`siteHour`, site day starts; `SITE_TIMEZONE`, else the container's `TZ`, else `America/Phoenix`).
- **Pack keying.** Packs are keyed `` `${sn}|${pk.num}` ``. Per-pack metric names are templated: `pack${n}_soh`, `pack${n}_cycles`, `pack${n}_temp`, `pack${n}_in`, `pack${n}_out`, `pack${n}_soc`, `pack${n}_vol_max_mv`, `pack${n}_lifetime_chg_mah`, `pack${n}_lifetime_dsg_mah`. DPU-bus metrics: `bat_vol`, `bat_amp`, `pv_total`, `total_in`, `total_out`, `panel_load`.
- **Fleet scoping.** `shp2ConnectedDpuSns(devices)` returns the SNs of DPU Cores actually wired into the SHP2 backup panel; `homeConnectedDpus(dpus, connected)` filters to them; `isShp2Connected(sn, connected)` tests membership; with no panel roster (no panel, or none reporting its sources) every DPU counts, except, since v1.191.0, a unit `BENCH_SPARE_SNS` names that the last known roster does not list. Bench-spare Cores (any DPU not on the panel's connected-source roster) are still *analyzed* per-pack but are excluded from any *baseline* that a Core is compared against (they cycle differently — storage SoC, bench top-ups). This "filter the baseline, score everyone" pattern recurs in degradation peer-fade, RTE, string-mismatch, novelty, clipping, and soiling.
- **Robust statistics.** `median(arr)`, `mad(arr, med)` (median absolute deviation), and `robustZ(x, med, mad, floor, zAtFloor)` (MAD-floored modified z-score) are shared helpers. `Z_INFO = 3.5`, `Z_WARN = 5`. `linregress(pts)` returns `{slopePerMs, slopeStdErrPerMs, r2}`; `lstsq2(rows)` returns a 2-regressor fit `{b0, b1, b2, r2}`.
- **Endpoint wrapper.** Almost all endpoints go through `analytics.report('<name>', opts?)` on the worker, then `cached(req, reply, value, seconds)` which adds a hash-ETag + `Cache-Control`.

---

### 1. State-of-Health fade + End-of-Life projection (`analysePack` / `computeDegradation`)

#### What it does + why
Regresses each pack's BMS-reported SoH history into a calendar-fade rate (%/yr), projects when it will cross the conventional LFP end-of-life mark, and compares each pack against its fleet peers to flag the fastest-wearing pack. This is the single most guard-heavy engine in the file because a raw OLS slope on early-life BMS `fullCap` settling routinely fabricates physically-impossible fades on near-new packs.

#### Inputs
| Metric | Role |
|---|---|
| `pack${n}_soh` (6-h buckets) | primary fade regression signal |
| `pack${n}_cycles` (6-h buckets) | cycle-intensity regression → `cyclesPerYear`, `projectedCyclesAtEol` |
| `pack${n}_temp` (6-h buckets) | Arrhenius temperature correction |
| `pack${n}_lifetime_chg_mah`, `pack${n}_lifetime_dsg_mah` | coulombic efficiency (see §2) |
| Device fields `pk.actSoh ?? pk.soh`, `pk.fullCapMah`, `pk.designCapMah`, `pk.accuDsgMah`/`accuChgMah`, `pk.cycles` | current-state snapshot |

`degradationWindowDays(retention)` — **v1.187.10** the report window is the configured samples retention (`RECORDER_RETENTION_DAYS`) clamped to `[DEGRADE_WINDOW_MIN_DAYS = 120, DEGRADE_WINDOW_MAX_DAYS = 365]` days (it was a fixed 30 days, under which no linear fade could pass both the 1.5-pt observed-drop floor and the 10 %/yr ceiling: the quartile means of a W-day window sit 0.75·W apart, so the floor needs a fade of 1.5 / (0.75·W/365.25) %/yr — about 24 %/yr at 30 days, 6 %/yr at 120 days, 2 %/yr at 365 days). The 120-day floor equals the forecast-soh alert's window, so the dated EOL and the alert read the same history; the 365-day cap bounds the scan on a multi-year retention. The window is computed in the analytics worker, whose environment is the main thread's at spawn. Reported as `windowDays` on the report, `DEGRADE_BUCKET_SEC = 6*3600` (6-hour buckets to de-noise SoH jitter), `DEGRADE_REPORT_TTL_MS = 30 min`.

#### Calculation — step by step

**Current state.** `rawSoh = actSoh ?? soh`; `currentSoh = min(100, rawSoh)` (v0.14.1 clamp — a freshly-calibrated BMS can read >100%). Capacity via `PACK_MAH_TO_KWH = (32 × 3.2) / 1e6` (single 32-cell, 3.2 V string mAh → kWh). `capacityFadeKwh = max(0, designCapacityKwh − currentCapacityKwh)`.

**OLS fade.** `fit = linregress(sohPts)`; `fadePctPerYear = −slopePerMs × YEAR_MS` where `YEAR_MS = 365.25 d`. `fadeUncertaintyPct = slopeStdErrPerMs × YEAR_MS` (±1 SE).

**Kalman side-by-side.** The same `sohPts` are fed to a 2-state constant-velocity `kalmanFilterSoh` (§8). It publishes `kalmanSmoothedSoh` (posterior SoH, also clamped ≤100), `kalmanFadePctPerYear` (= `−driftPerYear`), `kalmanFadeStdevPctPerYear` (posterior stdev), and a dated `kalmanYearsToEol`/`kalmanEolDate` — but only after mirroring every OLS gate (span ≥ `EOL_MIN_SPAN_MS`, r² ≥ `EOL_MIN_R2`, and `!fadeExceedsPlausibleCeiling`). OLS remains the canonical projection; Kalman is parallel comparison data.

**Arrhenius.** `avgPackTempC` = mean of `pack${n}_temp`. `arrheniusFactor = 2^((avgTemp − 25)/10)` (LFP fade roughly doubles per +10 °C). `fadePctPerYearAt25C = fadePctPerYear / arrheniusFactor`. `coolingBenefitYears` = extra service-years if avg pack temp fell 5 °C (`COOLING_DELTA_C = 5`), computed by re-running the headroom/fade math at the cooled Arrhenius factor and reporting the delta if > 0.05 yr.

**EOL projection.** `headroom = currentSoh − EOL_SOH` (`EOL_SOH = 80`). `yearsToEol = headroom / fadePctPerYear`. Confidence band: `fadeFast = fade + SE`, `fadeSlow = max(0.02, fade − SE)`; `yearsToEolLow = headroom/fadeFast`; `yearsToEolHigh = headroom/fadeSlow` (null if `fadeSlow ≤ 0.05` or the high bound exceeds `EOL_MAX_YEARS`). `eolDate = now + yearsToEol × YEAR_MS`. `fadePctPer100Cycles = (fade/cyclesPerYear)×100` only when `cyclesPerYear ≥ 5`.

#### Status gates (in evaluation order)
The function returns one of `no-data | learning | stable | projecting` via `mk(...)`. Order matters — the first matching gate wins:

1. **`no-data`** — `sohPts.length < 8` or `currentSoh == null`.
2. **`learning` (step-dominated)** — `sohStepDominated(sohPts)`: a BMS-recalibration staircase. Returns true if <3 distinct values, or the largest flat run covers >70% of samples, or ≤3 step transitions all fall in the final 20% of the window. Fade/r²/Kalman-EOL all forced null so it can't seed the peer pool or pollute the confidence median-r².
3. **`learning` (signal-below-floor)** — `sohSignalBelowFloor(sohPts)`: `mean(first quartile) − mean(last quartile) < SOH_MIN_OBSERVED_DROP_PTS (1.5)`. Catches a shallow multi-step decline smaller than BMS quantization noise.
4. **`learning` (immature)** — `!fit || spanMs < EOL_MIN_SPAN_MS (21 d) || fit.r2 < EOL_MIN_R2 (0.3)`. Preliminary fade shown; dated EOL withheld; Kalman dated EOL also nulled.
5. **`stable`** — `fade == null || fade < 0.1 || currentSoh ≤ EOL_SOH || yearsToEol > EOL_MAX_YEARS (40)`. Flat / improving / already-at-EOL / effectively-never.
6. **`learning` (implausible-fast-fade)** — `fadeExceedsPlausibleCeiling(fade)` i.e. `fade > EOL_MAX_FADE_PCT_PER_YEAR (10 %/yr, = MAX_SOH_FADE_PCT_PER_YEAR)`. Real LFP fades ~2–3 %/yr; anything faster is early-life fullCap settling. **This mirrors the forecast-soh alert ceiling so the dated EOL can never outrun the alert.** Fade/EOL nulled → HA `..._soonest_pack_eol` stays `unknown`. Until v1.187.10 the 30-day window made `projecting` unreachable for any linear fade (see the window above), so the sensor read `unknown` for every pack whatever its fade; with the retention-derived window a fade of roughly 6–10 %/yr is dated once 120 days of history exist, and slower fades as the history grows toward a year.
7. **`projecting`** — the real dated projection with confidence band + Arrhenius note.

#### Peer comparison (Pass 2 of `computeDegradation`)
Baseline pool = packs with `status==='projecting'` **and** SHP2-connected. Needs ≥3. `med = median(rates)`, `m = mad(rates, med)`. For every projecting pack: `peerFadeRatio = fade/med`; `z = robustZ(fade, med, m, FADE_PEER_Z_FLOOR_PCT_PER_YEAR (0.1), Z_INFO)`. If `fade > med && z ≥ Z_INFO` → `peerOutlier = true` and the summary gains "fading ~N× the fleet-median rate". Spares are *scored* against the connected baseline but never *define* it.

Packs are sorted worst-first (`projecting` → `learning` → `stable` → `no-data`; within projecting by soonest `yearsToEol`).

#### Outputs
`GET /api/degradation` → `FleetDegradation { generatedAt, eolSoh, windowDays, packs: PackDegradation[] }`. Each `PackDegradation` carries ~40 fields: current SoH/capacity, `fadePctPerYear`+`fadeUncertaintyPct`, `r2`, `yearsToEol`/`Low`/`High`, `eolDate`, `peerFadeRatio`/`peerOutlier`, all Arrhenius fields, `coulombicEffPct`, all five `kalman*` fields, and a plain-language `summary`. Feeds HA sensor `..._soonest_pack_eol`, the pack-risk scorers (both v1 & v2), `computeConfidenceSnapshot` (median r²), and `/api/repair-issues`.

#### Config knobs
`RUNWAY_DISCHARGE_EFFICIENCY` etc. belong to runway (separate cluster). Degradation itself is constant-driven (no env knobs); the salient constants are `EOL_SOH=80`, `EOL_MIN_SPAN_DAYS=21`, `EOL_MIN_R2=0.3`, `EOL_MAX_YEARS=40`, `EOL_MAX_FADE_PCT_PER_YEAR=10`, `SOH_MIN_OBSERVED_DROP_PTS=1.5`.

#### Edge cases / honest-null
Empty roster short-circuits (cache not stored when `dpus.length === 0`). Every "artifact" gate routes to `learning` with null fade so the artifact cannot seed the peer pool, the confidence median-r², or the HA EOL sensor. Fresh fleet → all packs `learning`/`stable` and the EOL sensor is `unknown` **by design**.

---

### 2. Coulombic efficiency (`coulombicEfficiencyFromCounters`)

#### What + why
Discharge-mAh ÷ charge-mAh over a recent window from the BMS lifetime counters. Healthy LFP stays ≥ ~99.5%; a downward drift means side reactions consuming charge — an early cell-aging signal SoH-by-itself misses. **On the reference plant the BMS counters are demonstrably unphysical, so the self-validating estimator publishes `null` for all 15 of its home packs by design** (v1.19.0 engine-review F17).

#### Inputs & the F17 self-validation
Reads only the **edge points** (first/last) of two windows for both `pack${n}_lifetime_chg_mah` and `_dsg_mah`: the full degradation window (120–365 days since v1.187.10) and the 7-day tail (`CE_WINDOW_MS = 7 d`). `mergeCounterEdges` dedups the two edge pairs by ts — provably equivalent input to reading the raw window, at four LIMIT-1 index seeks instead of ~28k rows.

Publishes the 7-day CE **only when all three gates pass**:
1. Span guard: both counters span ≥ `CE_MIN_SPAN_MS = 2 × 7 d` (a shorter history makes tail == full and the checks tautological).
2. Full-window ratio: `fullChg ≥ CE_MIN_FULL_CHG_DELTA_MAH (30 000)`, `fullDsg > 0`, and `fullRatio ∈ [CE_BAND_LO=90, CE_BAND_HI=100.5]`. A long-window ratio >100.5% *proves* the counters are artifact-ridden, so no sub-window is trustworthy.
3. 7-day ratio: `chgDelta ≥ CE_MIN_CHG_DELTA_MAH (10 000)`, `dsgDelta > 0`, ratio in the same band, **and** `|ratio − fullRatio| ≤ CE_CONSISTENCY_TOL_PP (2.0)` — real CE moves slowly; a divergence larger than the entire downstream discriminating span (99%→97% max-risk) is window noise.

Passing value is `min(100, round2(ratio))`. `null` means "unknown" and every consumer treats it neutrally (heuristic `ceNorm → 0`, LR `normalizeFeature → 0`, tile shows `—`).

#### Output / trace
Carried inside `PackDegradation.coulombicEffPct` (no dedicated endpoint). Feeds pack-risk feature 3 in both v1 and v2.

---

### 3. Round-Trip Efficiency (`computeRoundTripEfficiency`)

#### What + why
Energy retrieved from packs ÷ energy stored into packs over a rolling window (default 7 days). Healthy LFP ≈ 95–97%; a slow drift down is the cleanest "whole stack is aging" signal. Uses per-pack in/out integrals so PV-direct passthrough doesn't contaminate the ratio.

#### Inputs
Per home-connected pack: `pack${n}_in`, `pack${n}_out`, one `queryMulti` per Core at 60 s buckets (300 s buckets for the wide extended pass). `RTE_TTL_MS = 15 min`. Spares excluded (`homeConnectedDpus`).

#### Calculation
For each day in the window it integrates each pack's in/out with `integrateWh` (trapezoidal, day boundary shared as a sample endpoint so no interval is double-counted) → `chargedKwh`, `dischargedKwh`, plus per-pack `coverageMs`.

Two per-day gates decide inclusion:
- **Coverage:** `coverage = coverageMsSum / (packCount × dayMs) ≥ RTE_MIN_DAY_COVERAGE (0.5)`. A boot-partial day (<50% measured) is excluded so a tiny charge integral can't yield a 130% ratio.
- **Round-trip band:** `ratio = dischargedKwh/chargedKwh` (only if `chargedKwh > 0.5`), must sit in `[RTE_ROUNDTRIP_MIN_FRAC=0.8, RTE_ROUNDTRIP_MAX_FRAC=1.05]`. Net-fill (<0.80) and net-drain/anomalous (>1.05) days are listed with their kWh but carry no `efficiencyPct` (they aren't round trips).

Included days accumulate into `totalCharged`/`totalDischarged`. **Steady-state clamp:** both per-day (`min(100, ratio×100)`) and aggregate (`effPct = totalCharged > 1 ? min(100, (totalDischarged/totalCharged)×100) : null`) are clamped ≤100% — you can't get more energy out than in; the 1.05 band admits an in-flight edge interval, the clamp keeps the *published* number physical.

**Extended-lookback backstop (v0.65.0):** if the primary window found no balanced day (`effPct == null` — typically a sustained drawdown), it recurses once over `RTE_EXTENDED_WINDOW_DAYS` (`max(7, round(env RTE_EXTENDED_WINDOW_DAYS ?? 30))`, environment-only) at coarse buckets and reports the most-recent real balanced cycles. Stateless, self-terminating, still ≤100%, honest `null` if even the wide window has none.

#### Outputs
`GET /api/round-trip-efficiency?days=N` (N clamped 1–30, default 7) → `RoundTripEfficiency { generatedAt, windowDays, daysWithData, totalChargedKwh, totalDischargedKwh, efficiencyPct, perDay: RoundTripDay[] }`. Feeds the RTE HA sensor and (as a display annotation, *not* a divisor) informs the runway DC-drain factor. **Corrected in v1.137.0:** this previously described `/api/lifetime-energy` as reporting `charge == discharge` exactly, held there by a steady-state clamp. That clamp was removed in v0.45.0 and the claim is false — measured on the reference plant 2026-09-07, lifetime charge is 2,154.541 kWh against 2,169.44 kWh discharged, a 14.9 kWh *excess* on the discharge side. The two counters are coulomb accumulators re-zeroed at one instant and mediated by delta-SoC, so their ratio breathes with pack SoC and can sit either side of unity. Near-equality is coulombic efficiency, not an invariant; do not treat a departure from it as a defect, and do not substitute the watt integral, which measures a different quantity.

#### Config / edge cases
`RTE_EXTENDED_WINDOW_DAYS` (environment-only; the add-on never exports it). `daysWithData` counts only days with a non-null `efficiencyPct`. Cache keyed by `d${windowDays}`.

---

### 4. Internal-resistance trending (`computeInternalResistance`)

#### What + why
`dV/dI ≈` effective internal resistance at the inverter bus (pack voltage isn't recorded separately — `bat_vol`/`bat_amp` give one R per DPU, not per pack). Rising R precedes SoH decay by months on LFP. **Honest caveat baked in:** a 10–120 s polled series is OCV/SoC-drift-dominated, so this engine can't truly converge — the value of the engine is its honest terminal states, not a precise number (v1.22.0 F27 hardened it).

#### Inputs / constants
`bat_vol`, `bat_amp` over `IR_HISTORY_MS = 30 d`, `IR_TTL_MS = 30 min`. Requires ≥30 raw samples each else `no-data`.

#### Calculation
Snaps V/A onto common timestamps (rejecting pairs >30 s apart). For each adjacent pair within `IR_DELTA_T_MAX_MS = 120 000`:
- count it as a within-cadence candidate;
- require `|dI| ≥ IR_DELTA_I_MIN_A (5 A)`;
- **steady-state filter** `steadyOn`: scan the ±`IR_STEADY_WINDOW_MS (3 000 ms)` neighborhood on both sides; reject if any adjacent `|dA|/dt ≥ IR_STEADY_DIDT_MAX_A_PER_S (3 A/s)` (a transient — motor inrush, MPPT chase, inverter load-step);
- `r = (dV/dI) × 1000` mΩ; **reject wrong-signed** pairs (bat_amp is into-battery-positive, so a genuine Ohmic response has `dV/dI > 0`; F27 replaced an `abs()` that was aging OCV drift into the trend as plausible positive R); keep only `r ∈ [IR_R_MIN_MILLI=2, IR_R_MAX_MILLI=100]`.

Need ≥10 accepted samples. `recentMilliohms = median(samples in last 7 d)`. `baselineMilliohms`: drawn **only** from samples older than the 7-day recent window (needs ≥`IR_BASELINE_MIN_SAMPLES = 5` pre-recent points, then the earliest-30% slice of that older cohort).

**Trend publication (F27 gates).** `fit = linregress(rSamples)`; `slopePerMonth = slopePerMs × 30 d`. Published as `trendMilliohmsPerMonth` **only if** `fit.r2 ≥ IR_TREND_MIN_R2 (0.3)` AND `spanMs ≥ IR_TREND_MIN_SPAN_MS (14 d)` AND `|slopePerMonth| ≤ IR_TREND_MAX_ABS_MILLI_PER_MONTH (5)`. Otherwise null. `trendR2` is always published as a diagnostic so the UI can see *why* the trend was gated.

#### Terminal states
`tracking` (≥10 clean pairs), `learning` (pairs within cadence but rejected as transient/out-of-band — genuinely accumulating), `insufficient-cadence` (fewer than `IR_MIN_CANDIDATE_PAIRS = 5` pairs even landed within cadence — will never converge at this poll rate), `no-data` (<30 raw samples).

#### Output
`GET /api/internal-resistance` → `InternalResistanceReport { generatedAt, devices: InternalResistanceDevice[] }` (per-DPU: `recentMilliohms`, `baselineMilliohms`, `trendMilliohmsPerMonth`, `trendR2`, `samples`, `status`). Feeds pack-risk feature 2 (bus-level R shared by all packs on a DPU).

---

### 5. Charge-curve fingerprint (`computeChargeCurveFingerprint`)

#### What + why
Tracks how the pack's max-cell voltage at fixed SoC checkpoints drifts from its early-life baseline during active charge. A widening voltage plateau at a given SoC is a slow aging fingerprint.

#### Inputs / constants
Per pack `queryMulti` of `pack${n}_soc`, `pack${n}_vol_max_mv`, `pack${n}_in` over `CHARGE_CURVE_HISTORY_MS = 200 d`, `CHARGE_CURVE_TTL_MS = 60 min`. Needs ≥50 SoC and ≥50 V samples else `no-data`. v1.187.20 — stale-while-revalidate: from `TTL − CHARGE_CURVE_REFRESH_AHEAD_MS` (8 min = 2 × `WARM_INTERVAL_MS`) the cached value is returned at once and one background rebuild (single-flight per basis generation, run in that generation) replaces it; past expiry it is served for at most `CHARGE_CURVE_STALE_MAX_MS` (60 min), after which the request computes in the foreground. A device-basis reset nulls the cache, so no stale value crosses it.

#### Calculation
Snap V and IN to nearest SoC sample (two-pointer). Checkpoints `CHARGE_CHECKPOINTS = [40, 60, 80, 95]` %, tolerance `±CHARGE_CHECKPOINT_TOLERANCE_PCT (1.5)`. Only samples **during active charge** (`inW ≥ 100`, avoids resting voltage) count.

- Baseline window = `[firstRecordedTs, firstTs + CHARGE_BASELINE_WINDOW_MS (14 d)]` (anchored to oldest real sample, not the fixed 200-days-ago `since`, so a weeks-old DB still has a baseline).
- Recent window = last 14 days.
- `windowsSeparated = recentCutoff > baselineCutoff` — until ~28 days of span the windows overlap and the engine holds at `baseline` rather than diffing overlapping periods.

Per checkpoint: `baselineV = median(≥3 baseline samples)`, `recentV = median(≥3 recent samples)`, `driftMv = round(recentV − baselineV)`. `meanDriftMv = mean(|driftMv|)` across checkpoints. Status: `tracking` (meanDrift non-null) / `baseline` (has ≥3 baseline samples on some checkpoint) / `no-data`.

#### Output
`GET /api/charge-curve` → `ChargeCurveReport { generatedAt, packs: ChargeCurvePack[] }` (per pack: `checkpoints[]` with baseline/recent/drift/sample counts, `meanDriftMv`, `status`). Feeds pack-risk feature 5.

---

### 6. Ambient-coupled thermal forecast (`computeAmbientThermalForecast`)

#### What + why
Learns each pack's temperature as a linear function of outdoor ambient temp + DPU duty (load), then predicts the peak pack temperature over the next 24 h from the weather forecast.

#### Inputs
Weather (`getWeather()` → `wh.tempC`, `wh.ts`), per-pack `pack${n}_temp` and per-DPU `total_in`/`total_out`, all hour-bucketed (`HOUR_BUCKET_SEC = 3600`) over `AMBIENT_THERMAL_HISTORY_MS = 30 d`. `AMBIENT_THERMAL_TTL_MS = 60 min`.

#### Calculation
Per hour-epoch build a training row `{ x1 = ambientTempC, x2 = loadW/1000 (= mean total_in + mean total_out, kW), y = mean pack_temp }`. Fit `lstsq2(rows)` → `{b0 (intercept), b1 (ambientCoeff, °C pack per °C ambient), b2 (loadCoeff, °C pack per kW), r2}`. Prediction over the next 24 forecast hours: `pred = b0 + b1·tempC + b2·recentLoad` (recentLoad = mean of last 24 in/out samples, kW); tracks the max as `predictedPeak24hC` at `predictedPeakAtMs`.

#### Output
`GET /api/ambient-thermal-forecast` → `AmbientThermalReport { generatedAt, packs: AmbientThermalPack[] }` (`ambientCoeff`, `loadCoeff`, `intercept`, `r2`, `samples`, `predictedPeak24hC`, `predictedPeakAtMs`). `r2` feeds `computeConfidenceSnapshot.thermalMedianR2`. Empty (no DPUs / no weather) → empty packs.

---

### 7. Thermal-event counter (`computeThermalEvents`)

#### What + why
Counts how often and how long each pack sat in "warm / hot / overheat" temperature bands, and rolls that into a normalized per-year "hard-life score" — a lens on cumulative thermal stress even when packs have different recording histories.

#### Inputs / thresholds
`pack${n}_temp` (raw, unbucketed) over `THERMAL_EVENT_HISTORY_MS = 30 d`, `THERMAL_EVENT_TTL_MS = 30 min`. Bands (stored in °C, commented in °F):
- `THERMAL_THRESHOLD_C_INFO = (96−32)/1.8 ≈ 35.6 °C` (warm)
- `THERMAL_THRESHOLD_C_WARN = (113−32)/1.8 = 45 °C` (hot)
- `THERMAL_THRESHOLD_C_CRIT = (131−32)/1.8 = 55 °C` (overheat)
- `THERMAL_HYSTERESIS_C = 1.5` (must fall this far below the trigger to re-arm)

#### Calculation
**Event count** = rising-edge with hysteresis: crossing above a threshold counts one event and disarms; the band re-arms only once temp falls `THERMAL_HYSTERESIS_C` below the trigger — so one sustained hot spell is one event, not many.

**Time-above** credits each inter-sample interval `dt` to whichever bands the *previous* reading occupied, **but only if** `dt ≤ THERMAL_SAMPLE_GAP_CAP_MS (15 min = 3× the 5-min heartbeat)` — a wider gap is a telemetry outage and must not be scored as "hot for the whole outage".

`spanDays = max(1, spanMs/86.4e6)`. `hardLifeScore = ((warmEvents + 4·hotEvents + 16·overheatEvents) / spanDays) × 365` (weighted, per-year-normalized).

#### Output
`GET /api/thermal-events` → `FleetThermalEvents { generatedAt, packs: ThermalEventCounts[] }` (`warmEvents`/`hotEvents`/`overheatEvents`, `warmHours`/`hotHours`/`overheatHours`, `dataSpanDays`, `hardLifeScore`). Feeds pack-risk feature 4 (`hardLifeScore`). No samples → all-zero row.

---

### 8. Kalman SoH filter (`kalmanFilterSoh`)

2-state constant-velocity Kalman over `[SoH, dSoH/dt]`, run internally in **days** for conditioning (input ts are ms). Requires ≥3 points.

- Transition `F = [[1, dt],[0,1]]`; observation `H = [1, 0]`.
- Init: `x = [firstValue, 0]`, `P00 = KALMAN_INIT_VAR_SOH (100)`, `P11 = KALMAN_INIT_VAR_RATE_PER_DAY (0.01)`.
- Process noise scales with `dt`: `Q_SOH = KALMAN_Q_SOH (1e-4)`, `Q_RATE = KALMAN_Q_RATE_PER_DAY (1e-7)`.
- Observation noise `R = KALMAN_R_OBS (0.05)` — deliberately 5× smaller than raw-sample R because each 6-h bucket is already the mean of ~360 raw samples (conservative vs the ~350× theoretical variance reduction).
- Covariance update uses the symmetric `(I−KH)P` closed form (v0.9.58 fixed a `p10` asymmetry that compounded into overconfident EOL).

Returns `{smoothedSoh, smoothedSohVar, driftPerYear (= x1 × 365.25), driftPerYearStdev (= √p11 × 365.25), samples, observationVariance}`. Consumed by `analysePack` (§1) as the side-by-side projection.

---

### 9. Pack-risk v1 heuristic (`computePackRiskScores`)

#### What + why
A hand-tuned weighted-sum-then-sigmoid risk score (0–100) per pack. **Not** a trained model — there's no labeled failure dataset — but the output shape matches what a trained classifier would yield, so v2 is a drop-in. `RISK_MODEL_VERSION = 'heuristic-v1'`, `RISK_TTL_MS = 30 min`.

#### Inputs (six features, each normalized to 0..1 where 1 = high risk)
| # | Feature | Source | Normalization | Weight |
|---|---|---|---|---|
| 1 | Peer-fade ratio | `deg.peerFadeRatio` | `clamp01((r−1)/1.0)` (2.0→max) | 0.25 |
| 2 | Internal-R trend | `ir.trendMilliohmsPerMonth` (bus-level, shared per DPU) | `clamp01(r/3)` (3 mΩ/mo→max) | 0.15 |
| 3 | Coulombic efficiency | `deg.coulombicEffPct` | `clamp01((99−ce)/2)` (97%→max) | 0.15 |
| 4 | Thermal hard-life | `therm.hardLifeScore` | `clamp01(h/300)` | 0.15 |
| 5 | Charge-curve drift | `cc.meanDriftMv` | `clamp01(\|d\|/50)` | 0.10 |
| 6 | Capacity fade rate | `deg.fadePctPerYear` | `clamp01((f−1)/5)` | 0.20 |

Weights sum to 1.

#### Calculation
`linearScore = Σ (normalized × weight × 100)`. `score0to100 = round(100 / (1 + exp(−(linearScore − 50)/12)))` (sigmoid-flatten around 50 so extreme single features don't dominate; steepness 12 chosen so linear 70 → ~80). Tier: `no-data` (no feature has data), `low` (<25), `moderate` (<50), `elevated` (<75), `critical` (≥75). `topFactors` = the ≤3 highest-weightedScore factors with data. Each factor carries a plain-language `comment`. Packs sorted critical-first, highest score within tier.

#### Output
`GET /api/pack-risk` (composes degradation + thermalEvents + internalResistance + chargeCurve reports) → `FleetRiskReport { generatedAt, modelVersion, packs: PackRiskScore[] }`.

#### Edge cases
A null feature normalizes to 0 (neutral), so missing data never inflates risk. CE is null wherever the F17 gates fail (§2). The step-dominated, below-floor and implausible-fade gates null the fade (§1). Unlike v2, v1 reads `deg.fadePctPerYear` at any status, so an immature `learning` pack's preliminary fade does feed feature 6.

---

### 10. Pack-risk v2 ML (`ml.ts` — `computePackRiskV2`)

#### What + why
Three side-by-side signals per pack — the v1 heuristic, a **logistic-regression** trained track, and an unsupervised **Mahalanobis novelty** detector — plus a composite. Real inference path (learned weights, sigmoid), gated by an auto-downgrade mechanism that pins the trained track to the heuristic whenever the model can't be trusted.

#### Feature extraction (`extractFeatures` / `normalizeFeature`)
Same six features and the same normalization thresholds as v1 (`FEATURE_NAMES = [peerFadeRatio, rTrend, coulombicEffPct, hardLifeScore, ccDriftMv, fadePctPerYear]`). Crucially, **fade features are consumed only when `deg.status === 'projecting'`** (`fadeMature`); an immature early-fit slope is treated as `null → 0`, so a fresh pack with 22 %/yr fit noise is not ranked most-at-risk. Null/non-finite → 0.

#### Logistic regression (`predictRisk`, `LrModel`)
`logit = bias + Σ weight·normalizedFeature`; `probability = sigmoid(logit)`; `score0to100 = round(prob×100)`; per-feature `contributions` returned for interpretability. `trainLrModel` fits by batch gradient descent (default 2000 iters, lr 0.05, L2 0.01, BCE loss) — used offline by `scripts/train-pack-risk.ts`.

**Model source chain (`loadModel`, highest→lowest):** online-shadow file `pack-risk-lr-v1-online.json` (SGD-updated on `/api/alerts/outcome`) → trained baseline `pack-risk-lr-v1.json` → in-code `DEFAULT_MODEL` (`version 'lr-heuristic-baseline-v1-builtin'`, weights mirroring the heuristic × a sigmoid scale, bias −2.5). Cache (`MODEL_CACHE_TTL_MS = 5 min`) invalidates the instant the source file's mtime moves. `provenance` (`shadow`/`baseline`/`default`) is stamped, never persisted.

#### Novelty (`computeNovelty`)
Per-pack **Mahalanobis centroid distance**: inverse-stdev-weighted distance from the fleet centroid in 6-D normalized feature space. Centroid + per-feature stdev are built from the **SHP2-connected baseline pool only** (spares would drag the centroid and compress the spread), but every pack is *scored*. Mapped **absolutely** against a fixed chi-square cutoff `CHI2_THRESHOLD = 3.4`: `novelty0to100 = round(min(1, distance/3.4) × 100)`. A pack reads 100 only once its distance actually reaches the outlier threshold (the old divide-by-in-sample-max forced one pack to 100 even on a healthy fleet). `topFeatures` = the 3 largest scaled deviations.

#### Auto-downgrade gate (`computeGateDecision`)
Decides whether the trained track is trustworthy. Three degrade reasons:
- **`samples`** — shadow model has < `PACK_RISK_MIN_TRAINING_SAMPLES` (env, default **100**) labeled samples. The reference plant's 13-sample one-class shadow learned essentially "raise everyone's risk" (99.99% bias), inflating healthy composites 4–7×. When this fires, the composite is **heuristic-only** (novelty track also excluded).
- **`drift`** — `driftL2 > PACK_RISK_DRIFT_THRESHOLD` (env, default 2.0), the L2 distance between the shadow and the on-disk baseline (`loadBaselineModelOnly`, bypassing the shadow preference — v0.9.62 fixed a self-comparison that made drift always 0). No baseline on disk → drift is `null` (unknown), not 0.
- **`precision`** — alert-family `overallPrecision < PACK_RISK_MIN_PRECISION` (env, default 0.4) with ≥`PACK_RISK_MIN_DECIDED_OUTCOMES` (default 3) decided outcomes including ≥1 dismissal. Env parsing via `gateEnvNum` treats `''`/NaN/negative as the default (so `Number('')===0` can't silently zero a threshold).

For a mature-model degrade (drift/precision) the trained score pins to the heuristic but novelty still averages into the composite.

#### Composite
Per pack: `trainedScore = gate.degraded ? heuristic : pred.score0to100`. `composite0to100 = gate.reason === 'samples' ? heuristic : round((heuristic + trainedScore + novelty)/3)`. `featureImportances = |weight| × per-fleet-stdev` (surfaces what actually drives between-pack differences, not just the weight). Packs sorted by composite desc.

#### Output
`GET /api/pack-risk/v2` → `PackRiskV2Report { generatedAt, modelVersion, modelSource, modelTrainedAt, modelTrainingSamples, modelFinalLoss, featureImportances[], packs: PackRiskV2Entry[], degraded?, degradeReason?, gateDecision{} }`. Each entry carries `heuristic{}`, `trained{}` (with raw probability + contributions even when pinned), `novelty{}`, and `composite0to100`. `gateDecision` feeds `/api/models/health`.

---

### 11. String-mismatch / per-Core underperformance (`computeStringMismatch`)

#### What + why
Flags a DPU whose PV output is persistently low vs the fleet at the same hour-of-day — a shaded panel, failed optimizer, or string mismatch. Same robust median+MAD test as the peer-anomaly engine, applied to per-DPU PV ratios.

#### Inputs / constants
`pv_total` at 300 s buckets over `STRING_MISMATCH_WINDOW_DAYS = 14 d`, `STRING_MISMATCH_TTL_MS = 15 min`. Daytime only (`value ≥ 100 W`).

#### Calculation
Per DPU build a 24-bucket hour-of-day median. For each hour, compute a **leave-one-out** fleet median from the *other* SHP2-connected DPUs (never itself — including itself pulls every ratio toward 1.0 and is degenerate with only 2 cores). `ratioSamples.push(deviceMed / fleetMed)` when ≥1 other connected DPU reports. `ratio = median(ratioSamples)`. If ≥3 devices have a ratio: `med = median`, `m = mad`; `z = robustZ(ratio, med, m, STRING_MISMATCH_RATIO_FLOOR (0.05), Z_INFO)`; `outlier = ratio < med && z ≥ Z_INFO`.

#### Output
`GET /api/string-mismatch` → `StringMismatchReport { generatedAt, windowDays, devices: DeviceProductionRatio[] }` (per device: `recentMedianW`, `fleetMedianW`, `ratio`, `modifiedZ`, `outlier`, `hourBuckets` = # of hour-of-day buckets compared, not raw samples). Spares are evaluated against but excluded from the connected baseline.

---

### 12. Soiling decomposition (`computeSoiling` / `computeSoilingDecomposition`)

#### What + why
Extends the fleet soiling estimate into a **per-Core** breakdown ("wash everything or just the east run?") plus a **per-hour** shape. `SOILING_DECOMP_TTL_MS = 30 min`.

#### Per-Core estimate (`computeSoiling`)
Reads a Core's `pv_total` hourly map + weather + the Core's charge-taper hours. **Pairing** (`soilingClearSkyHour`, v1.187.1): the PV of the completed recorder hour [H, H+1) pairs with the radiation labelled H+1 (`coveringRadiationEpoch` — Open-Meteo's value labelled H is the average of [H−1, H)); the hour is clear only when the cloud reading at **both** labels H and H+1 is ≤ 25% (cloud cover is an instant reading; a missing label is not clear), and an hour pairs only once its covering label predates the last weather fetch (`soilingPairedUntil`: the earlier of the clock and the live cache's `fetchedAt`). The live cache overlays the recorder rows and is refetched every 2 h, so its row for a label after its own fetch was a forecast when fetched, and no realized row exists for that label yet; the hour in progress never pairs. The bound applies to the soiling callers only (the forecast's estimate and the decomposition); the solar model and its GHI map are unchanged. Clear-daytime filter: that covering `radiationWm2 ≥ 250`. `coeff = pv / GHI` (drop non-finite / ≤0).
**Charge-taper hours** (`chargeTaperHoursFromPts`, v1.187.1) are left out like cloudy ones: an hour in which the Core's own pack reached the taper band — its highest bucketed `soc` in the hour ≥ `saturationThresholdPct(ceiling)` (ceiling − 10, the curtailment engine's predicate; the hour's recorded `chg_max_soc`, else the Core's live `chgMaxSoc`, else 100) — or for which no `soc` was recorded. Near its ceiling a DPU backs its MPPTs off to the load, so the PV of such an hour is what the pack and the house take, not what the array makes; per Core, because each DPU sheds on its own pack. Leaving an hour out only loses a sample; a real fault that lowers PV keeps the packs further from full and yields more measurement hours, not fewer. The count is `taperHours` (diagnostic).
Per clear day with ≥3 clear hours, `dayCoeff = median(hour coeffs)`. A day that lost any clear hour to the taper counts (in the baseline or the recent pool) only when its remaining hours reach `covBar` — a morning sliver is not a day; `covBar` is set by the best-covered day, which always passes. Needs ≥6 clean days. When too few days remain the estimate is null or `recentCovered` false and the alert stays quiet: a maintenance estimate may fail quiet; a safety alarm may not.
- **`baselineCoeff` = p90 of the clean-day coeffs** (`sortedAsc[floor(0.9×(n−1))]`) — the robust "best clean day" reference, NOT the all-time max (v0.54.2 — a freak cool-clear peak inflated `dropPct`).
- **`recentCoeff` = median of the last 5 well-covered days** (coverage bar `covBar = max(3, round(maxDayHours × 0.5))`; with fewer than 3 well-covered days it falls back to all days). The 5-day median rejects 1–2 transient/gap-depressed outliers while a sustained real drop still lowers it.
- **`recentCovered`** = at least 3 well-covered days **and**, since v1.187.1, at least 3 of the recent pool's days began within the last 10 days (`SOILING_RECENT_WINDOW_DAYS`, judged against the clock, not the pairing bound). With full-pack days left out the last five well-covered days can reach weeks back: on 2026-09-30 one Core's were 09-03 to 09-26, mostly from before a rain, and read a 13.9% drop on panels the rain had washed; a pool that old can equally call a newly dimmed array clean. Three distinct days inside ten calendar days also put the newest within seven, and with three of up to five days inside the window the median lies within the range of those three. `dropPct` is still computed for display; only the verdict is withheld.
- `dropPct = round(((baseline − recent)/baseline) × 1000)/10`.

#### Fleet aggregation (`fleetSoilingFromDevices`)
Fleet soiling = **median** of each home Core's own `dropPct` (only Cores with a `recentCovered` estimate; needs ≥2; each Core judged on its own taper hours — the forecast's per-Core `queryMulti` carries `soc` and `chg_max_soc` for home Cores). This is immune to the coverage-deflation artifact where one Core's cloud-offline `pv_total` gap on a clear hour deflates a *summed* fleet coefficient into a phantom ~35% "soiling" while every array is ~3–6% (real soiling dims all arrays roughly uniformly and shows up equally per-Core). **This is the documented "monsoon rinse" behavior: published soiling decays toward 0 over ~a week; do not re-surface "panels want cleaning".**

#### Per-Core panel (in `computeSoilingDecomposition`)
For each DPU it emits `SoilingPerDevice { sn, device, coreNum, dropPct, cleanDays, recentCoeff, baselineCoeff, recentCovered }` from `computeSoiling` (`recentCovered` false when there is no estimate), with that DPU's own charge-taper hours (its `soc` and `chg_max_soc` over the window, live `chgMaxSoc` as the fallback ceiling) — so the wash card reads the same hours as the alert.

#### F29 multi-week weather backfill
The decomposition window (`since = now − 60 d`, a query ceiling only) seeds weather from the **recorder-persisted** series first — `recorder.query('weather', 'ghi_wm2'/'cloud_pct', since, now, 3600)`, GHI realized-first via `preferRealizedGhiRows` since v1.173.0, through `mergeRecorderWeather` — then lets the live `getWeather()` cache overwrite its freshest hours. Before F29 the baseline was paired only with `getWeather()`'s 7-day cache, so the soiling baseline **slid forward with the dirt it exists to measure** (reported 0.9–1.6% while the truth was ~10–12%). Now the weather spans the same window as the PV it's compared against (bounded by the configured samples retention — default 30 days — or the 60-day query ceiling, whichever is smaller). Bails only if neither source produced any weather.

#### Per-hour shape (fleet, home-connected only)
Sums home-Core `pv_total` per hour-epoch (`fleetPvE`). An hour in which **any** home Core was in its charge taper is left out (that Core's share of the sum is shed). Pairing, the cloud gate and the fetch bound are `soilingClearSkyHour`'s (above); filter `radiationWm2 ≥ PERHOUR_MIN_GHI_WM2 (400)` — a raised floor (v1.24.0) because at dawn/dusk the pv/GHI ratio is geometry-dominated (sun angle/tilt), not soiling (hour 18 once read an impossible 67.3% drop). Split by hour-of-day into `baseline` (older than 7 d) and `recent` (last 7 d). Need ≥3 baseline + ≥2 recent. `base = p90 of baseline` (`sorted[floor(0.9×(n−1))]`, not all-time max), `rec = median(recent)`, `dropPct = ((base−rec)/base)×100`.

#### Output
`GET /api/soiling-decomposition` → `SoilingDecomposition { generatedAt, perDevice: SoilingPerDevice[], perHour: [{hour, dropPct, samples}] }`. Per-Core medians are the honest F29 output; `perHour` is display-only (no alarm/wash-card consumer). Feeds `/api/repair-issues`.

*(Note: `computeShadeReport` / `shadeHoursFromCorePvMaps` at `/api/shade-report` is the sibling engine — recurring same-hour clear-sky shortfall = physical obstruction, `SHADE_DROP_THRESHOLD = 0.18`, `SHADE_MIN_CLEAR_DAYS = 5`, per-Core p90 refCoeff, fleet median shortfall — same per-Core anti-deflation pattern.)*

---

### 13. Inverter clipping (`computeClipping`)

#### What + why
Estimates kWh lost today because the home array hit the inverter's power ceiling — observed PV pinned at the hardware peak while the learned model says the sun could have made more. Distinct from *curtailment* (batteries full, MPPTs throttled — a separate engine).

#### Inputs / constants
Needs a `DayForecast` (for the solar model) + `getWeather()` (per-hour GHI) + per-SN `pv_total` at 60 s buckets for today. `CLIPPING_TTL_MS = 5 min`, `CLIPPING_PEAK_FRAC = 0.95`, `DAYLIGHT_GHI = 20 W/m²`. Injectable `nowMs` clock for the elapsed-hour determination (tests); cache freshness uses the real wall clock regardless.

#### Calculation
Uses the **restored display basis** (`forecast.restoredSolarModel ?? forecast.solarModel`) — clipping is a display KPI, so it iterates all SHP2-connected SNs including any cloud-wedged Core absent from the live map (`clippingSns = present home Cores + missing connected Cores`); observed watts are read straight from each SN's own recorded `pv_total` (anti-fabrication — real recorded values, never scaled).

`arrayPeakW = max(restoredModel.hourly[].observedMaxPvW)` (the hardware ceiling — highest hourly PV ever observed). For each elapsed hour since the site's midnight (each row's `hour` is the site hour, which also picks the model slot): `observedW = Σ per-SN hourly mean pv_total`; `modelW = coeff × GHI` (only when `GHI > DAYLIGHT_GHI` and the hour's model coeff exists). `atPeak = observedW ≥ 0.95 × arrayPeakW`. If `atPeak && modelW > observedW`: `clippedW = modelW − observedW`, and `clippedKwh += (clippedW/1000) × elapsedHrs` (partial current hour weighted). `hoursAtPeak` counts at-peak hours.

#### Output
`GET /api/clipping` → `ClippingEstimate { generatedAt, todayKwh, perHour: ClippingHour[], arrayPeakW, hoursAtPeak }`. `arrayPeakW ≤ 0` or no forecast/weather/DPUs → empty. Feeds the HA clipping sensor and dashboard.

---

### 14. Equipment health — MPPT + inverter standby (`computeEquipmentHealth` via `ratioSeries` / `cappedMedianEffPct`)

#### What + why
Two DPU-electronics KPIs: **MPPT conversion efficiency** (reported W ÷ reported V·A, all three MPPT-**input** registers — a register-consistency ratio, not a measured conversion efficiency, capped 100%; cabling, connector and panel losses move W and V·A together and cannot move it) per HV/LV string, and **inverter standby loss** (residual `ac_out` while that DPU's PV is dark — the inverter's own idle draw), trended week-over-week.

#### Inputs / constants
`ratioSeries` pulls `{watts, volts, amps}` per string via `queryMulti` at `EQ_HEALTH_BUCKET_SEC = 300 s` over the equipment-health history window; snaps V/A to nearest W ts within the bucket size. Per-sample ratios >100.5% are dropped; `cappedMedianEffPct(effs) = effs.length ? min(100, median(effs)) : null`. `MPPT_EFF_TTL_MS = 10 min`.

#### Output
`GET /api/equipment-health` → `EquipmentHealth { generatedAt, mpptStrings: MpptString[], inverterStandby: InverterStandby[] }`. Per string: `recentEffPct`, `baselineEffPct` (earliest 30% of history), `driftPctPts` (recent − baseline; negative = drift), `samples`, `spanDays`. Per DPU standby: `idleWatts` (recent standby FLOOR of ac_out — see below), `baselineIdleWatts`, `trendWattsPerWeek`, `samples`, `blockedReason` (**v1.131.1**; `null` when a figure is published). Feeds `/api/repair-issues`.

**v1.131.0 — the standby detector could not fire.** The idle-sample gate was
`pv < 20 W && panel_load < 20 W && 0 < ac_out < 200 W`, where `panel_load` is the
SHP2's whole-panel draw. That panel carries the backup circuits of an occupied
house and on the reference plant never drops below roughly 1.4 kW (7-day mean 1,445 W), so the
conjunct was false at every sample: `idleSeries` stayed empty, every DPU reported
`idleWatts: null`, and the Advanced-Insights card rendered as *nothing to
report* for the entire life of the feature. The surviving conditions are both
about the DPU itself — `isInverterIdleSample({pvW, acOutW})` requires only that
this DPU's PV is dark and its own AC output sits in the standby window — and the
SHP2 `panel_load` query the loop used to make is gone.

Removing the house gate changes what the window contains, so the statistic
changed with it. The (0, 200 W) window still admits small real loads, so the
headline is now the **p10 floor** of the population (`idleFloorWatts`), not its
median: on a night with three samples at the true ~45 W floor and seven on real
load, a median publishes ~140 W of household draw as inverter overhead. The
trend is likewise fitted to **one floor per day** (`dailyIdleFloors`, ≥ 3 samples
per day) rather than to raw samples, so it tracks the inverter rather than how
many small loads happened to land inside the window on a given night. A bucket
runs from 17:00 to 17:00 site time, so a local 19:00→06:00 night falls inside one
bucket in any zone, while a local-midnight bucket would split every night in two.
On the reference plant (MST, UTC−7, no DST) that bucket is exactly the UTC day,
as it was when the buckets were UTC days. Guards are
mutation-proven load-bearing (`scripts/mutate-detector-honesty.mjs`, mutants
i–v), including an exemplar that reproduces the shipped gate verbatim.

**v1.131.1 — and the register carries no standby plateau.** Live-verifying
v1.131.0 found every DPU still reporting `idleWatts: null`: `ac_out` reads **0 on
all five Cores of the reference plant, with `acOutVol` also 0**, because the Delta Pro Ultras feed the
house through the SHP2 link rather than their own AC output port, so in normal
grid-tied operation that inverter stage is not energised. A second blocker,
independent of the whole-house gate, and visible only by querying the device
rather than reasoning about the code.

**The `blockedReason` field then corrected the first version of this paragraph,
which is what it is for.** It was written asserting the register is *structurally*
zero; the live classification disagreed. Over the 60-day window only **Core 4** (reference plant)
has an all-zero series (`ac-output-stage-idle`). The other four report
`insufficient-idle-samples`, meaning at least one non-zero sample exists — the
output stage has been energised, presumably while islanding — but fewer than ten
samples land inside the (0, 200 W) standby window with PV dark. The register is
effectively bimodal: exactly 0 when grid-tied, kilowatts when islanded, with no
idle plateau in between, because an inverter that is off reads 0 rather than its
own self-consumption. The conclusion is unchanged and the reasoning behind it is
now the measured one. Standby self-consumption is real but is not exposed here; it would have to
be inferred from pack drain (`bat_amp × bat_vol` while PV is dark and output is
zero), which is a different measurement and a separate piece of work.

Until then the detector states its own blindness rather than rendering blank:
`InverterStandby.blockedReason` is `null` when a figure is published and
otherwise one of `no-ac-out-history`, `ac-output-stage-idle` (the live case), or
`insufficient-idle-samples`, and the Advanced-Insights card prints the reason in
place of the value. This is the point of the whole batch — a blank row reads
exactly like a healthy one, which is how this detector hid for its entire life.

---

### Cross-engine consumers

- **`computeConfidenceSnapshot(degradation, thermal, skill)`** → `/api/confidence`: `degradationMedianR2` (median of projecting packs' r²), `thermalMedianR2`, `forecastDayR2` (Pearson r² of predicted vs actual daily PV over the skill report's covered days, ≥5 days else null — replaced a degenerate within-slot median r²), plus forecast bias/MAE.
- **`computeRepairIssues`** → `/api/repair-issues`: composes degradation + soiling + equipmentHealth + forecastSkill into actionable repair cards.
- **Pack-risk v1/v2** consume degradation, thermalEvents, internalResistance, chargeCurve (see §9–10).

### Global honest-null / anti-footgun summary
Every engine here caches only when `dpus.length > 0`; prefers `null`/`learning`/`no-data`/`insufficient-cadence` to a fabricated number; excludes spare Cores from baselines while still scoring them; floors MAD in every robust-z test to avoid unbounded scores at zero scatter; and clamps published physical quantities (SoH ≤100, CE ≤100, RTE ≤100). The following HA sensors can read `unknown` **by design**, not because anything is broken: `..._soonest_pack_eol` (degradation — no pack has a plausible, clear-enough fade inside the window; before v1.187.10 it could never read otherwise, see §6.1), all `coulombicEffPct` (F17), predictive-SoH, and the immature IR trend.


---

