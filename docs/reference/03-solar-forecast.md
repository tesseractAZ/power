## 3. Solar & PV Forecast Engine

This cluster covers everything that turns weather irradiance + recorded telemetry
into a day-ahead (and multi-day) projection of PV generation, house load, and
battery State-of-Charge (SoC). It is the analytical backbone the runway alarm,
the MPC dispatch planner, and the Solar/Forecast dashboard tiles all consume.

All code lives in `server/src/analytics.ts` unless noted. Weather ingestion is
`server/src/weather.ts` (Open-Meteo GHI) and `server/src/nws.ts` (NWS cloud
ensemble). Everything here is deterministic + pure where marked, and heavily
guarded against the "missing telemetry read as darkness" class of bug.

Pipeline at a glance:

```
Open-Meteo (GHI, cloud, temp) ─┐
NWS NDFD cloud (opt-in) ────────┼─► getWeather() ─► ghiByEpoch / wxByHour
                                │
recorder pv_total / panel_load ─┴─► buildSolarResponse() ─► SolarResponseModel (per hour-of-day β)
                                        │
                                        ├─► computePvBiasCorrection() ─► pvBiasFactor [0.5,1.2]
                                        ▼
                            computeDayForecastUncached() ─► DayForecast (24h PV+load+projectedSoc)
                                        │
             ┌──────────────────────────┼──────────────────────────────┐
             ▼                          ▼                               ▼
   computeForecastSkill()   computeProbabilisticForecast()    computeMultiDayForecast()
   (/api/forecast-skill,     (/api/forecast/probabilistic)    (/api/forecast/multi-day)
    /api/confidence)
```

---

### 1. The GHI→PV response model (`buildSolarResponse`)

#### What it does + why

The core physical model is a learned linear map from **Global Horizontal
Irradiance** (GHI, W/m²) to **PV output** (watts), fit separately **for each
hour-of-day (0–23)** of the site clock (`siteHour`: `SITE_TIMEZONE`, else the container's `TZ`,
else `America/Phoenix`; every hour-of-day slot and weekday in this chapter is the site's). Splitting by hour-of-day captures the sun's changing
angle-of-incidence and any per-hour shading, so a 9 AM W/m² and a 1 PM W/m²
produce different watts even at equal irradiance. It is fit for the
whole-inverter `pv_total` (the fleet-facing model) and, per DPU, for the two
MPPT strings `pv_high` (HV) and `pv_low` (LV), which may face different
directions.

#### Inputs

| Input | Source | Notes |
|---|---|---|
| `pvByEpoch` | recorder `pv_total` / `pv_high` / `pv_low` bucketed to hour-epochs | `Map<hourEpoch, meanWatts>`, hour-epoch = `floor(ts/3_600_000)` |
| `ghiByEpoch` | Open-Meteo `shortwave_radiation` + recorder-persisted GHI, realized-first: `ghi_wm2_realized` where captured, else the first-write forecast `ghi_wm2`, hour by hour (v1.173.0) | `Map<hourEpoch, W/m²>` |

PV is pre-averaged into 5-min SQL buckets (`HOUR_CURVE_BUCKET_SEC = 300`) then
into hourly means before pairing — a ~30× rowcount reduction with no material
curve change.

#### The calculation

For each hour-of-day `h`, pairs `{ghi, pv}` whose `ghi > DAYLIGHT_GHI (20 W/m²)`
are collected (below that is night/near-night and is discarded). If fewer than
`MIN_RESPONSE_PAIRS = 2` daylight pairs exist, that hour's `coeff = null`
(honest "no fit").

Otherwise a **through-origin least-squares slope** (line forced through 0,0 —
zero sun = zero watts) is fit:

```
coeff (β) = Σ(pv·ghi) / Σ(ghi²)          // W of PV per W/m² of GHI
```

`observedMaxPvW` is the historical peak PV at that hour (a physical clipping
clamp used downstream). A Pearson r² is also computed:

```
r² = cov(ghi,pv)² / (var(ghi)·var(pv))    // only when day.length ≥ 3, vg>0, vp>0; else 0
```

> **r² is DIAGNOSTIC ONLY (v1.20.0, F21).** Within-slot r² tracks the *weather
> regime*, not the array: in a low-variance clear-sky climate (the reference plant's) per-slot
> GHI is near-constant, so r² degenerates to ~0.00–0.15 even for an excellent
> model (whose *day-level* replay scores r²≈0.94). **Nothing may gate on
> within-slot r².**

#### `peakCoeff` (the headline "Peak response")

`peakCoeff` is the best hourly slope across the day, used as a single headline
number. Its gate was moved off r² (v1.20.0, F21) onto **brightness + samples**:

```
if (meanGhiWm2 ≥ PEAK_RESPONSE_MIN_GHI_WM2 && day.length ≥ 3 && coeff > peakCoeff)
    peakCoeff = coeff
```

`PEAK_RESPONSE_MIN_GHI_WM2` defaults to **300 W/m²** (env-overridable; NaN/empty
safe) — far above the dawn-instability regime (~25 W/m²) where a poorly
conditioned slope could otherwise win, and below any productive mid-morning
slot. `peakGateMinGhiWm2` is published in the model so frontend mirrors gate on
the same threshold rather than hardcoding 300.

> **No Bayesian recursive update.** The natural question is whether one exists — it does
> not. The model is a plain batched OLS refit over the trailing 30-day window on
> each forecast build. There is no per-observation Kalman/Bayes state.

#### Output shape (`SolarResponseModel`)

```ts
interface HourResponse {
  hour: number;            // 0-23, site hour
  coeff: number | null;    // β = W per W/m²; null = insufficient data
  r2: number;              // DIAGNOSTIC ONLY
  samples: number;
  observedMaxPvW: number;  // historical peak PV this hour (×1.05 = ceiling)
  meanGhiWm2?: number;     // mean daylight GHI of the slot (feeds the peak gate)
}
interface SolarResponseModel {
  hourly: HourResponse[];  // length 24
  peakCoeff: number;
  peakGateMinGhiWm2: number;
  pairCount: number;       // total (GHI,PV) pairs used
  historyDays: number;
}
```

#### Constants

| Constant | Value | Meaning |
|---|---|---|
| `DAYLIGHT_GHI` | 20 W/m² | below = night, pair discarded |
| `MIN_RESPONSE_PAIRS` | 2 | min daylight pairs to fit an hour |
| `PEAK_RESPONSE_MIN_GHI_WM2` | 300 (env) | brightness floor for the peak headline |
| `HOUR_CURVE_BUCKET_SEC` | 300 | 5-min pre-average bucket |
| `TYPICAL_HISTORY_MS` | 30 days | training window |

#### Full-coverage fitting gate (`fullCoverageFleetPv`, v1.10.0 F11)

The **alarm-facing** fleet model is NOT fit on the naive fleet sum. The 30-day
review found 31% of training pairs were missing ≥1 home Core (a cloud blackout),
and pairing full GHI against a partial-fleet PV sum deflated coefficients 11–23%
(noon 8.25 vs 9.44 full-coverage) — a chronic ~-21% clear-day under-forecast.

`fullCoverageFleetPv(perCore)` sums per-core hourly PV maps using **only
hour-epochs where every contributing core reported** (the intersection). Cores
dark for the whole window are skipped from the requirement. If fewer than
`SOLAR_FIT_MIN_FULL_COVERAGE_HOURS = 72` (~3 days) full-coverage hours exist, it
falls back to the ungated union sum (pre-v1.10.0 behavior). The returned `map`
feeds `solarModel = buildSolarResponse(fleetFit.map, ghiByEpoch)`.

A separate **restored** model (`restoredSolarModel`) is fit from the ungated
union *plus* each SHP2-connected-but-live-absent Core's own recorded `pv_total`, but
only while such a Core exists. With every connected Core reporting, `restoredSolarModel`
IS `solarModel` (v1.177.0): the earlier refit on the ungated union diverged from the
F11-gated alarm model after any partial-fleet day in the window, so the display and the
alarm disagreed on a fully reporting fleet. It is DISPLAY/clipping-only and never feeds
the alarm.

---

### 2. Day-ahead forecast (`getDayForecast` / `computeDayForecastUncached`)

#### What it does + why

Builds the 24-hour ahead per-hour series of PV watts, load watts, and projected
battery SoC%. This is the object every downstream forecast/alarm consumer reads.
`getDayForecast` is the cached + single-flighted entry point;
`computeDayForecastUncached` does the work.

#### Caching & single-flight

- `FORECAST_DAY_TTL_MS = 30 min` for a **complete** forecast.
- `INCOMPLETE_FORECAST_TTL_MS ≈ 150 s` (env `INCOMPLETE_FORECAST_TTL_MS`, default
  150000) for a **structurally-incomplete** forecast (SHP2 cloud-offline: no SoC
  basis / cold load history). This short negative-cache window bounds the >30 s
  cold recorder rescan to once per ~150 s instead of every `/api/ha-state` poll
  (which previously cascaded to 30 s client timeout → retry → HTTP 500).
- `dayForecastFlights` coalesces concurrent cold-cache callers onto one computation (v0.69.0),
  one in-flight build per device basis (`reportBasisKey`, v1.187.18): a caller on another device
  map never joins a build started on an older one.
- A fresh cached forecast is reused only while its `solarModelSns` (the sorted SNs of the
  home Cores its solar model was fitted on) equals the current map's home Cores
  (`dayForecastCacheUsable`, v1.186.5). A forecast fitted on a boot-time map that had not
  yet seen every Core is rebuilt instead of standing for the full 30-min TTL.
- A forecast is cached only when the map gives it a basis: a projected Core or (v1.191.2) the
  projected house panel; the boot device list, with neither, never latches. The panel clause
  covers a process started while every home Core is cloud-dark: projections live in memory and an
  offline Core is never polled, so no Core is projected, while the forecast, built on the panel's
  load and each connected Core's own recorded PV, is complete. The entry records the connected but
  unprojected Cores it re-added and whether a home Core's first reading was pending
  (`homeBasisPending`); `dayForecastCacheUsable` rejects it when the first differs from the
  current map's, or when the map is pending and the entry was not.
- Each connected but unprojected Core's 30-day `pv_total` is read once per build, for both the
  restored display curve and the restored fleet model (v1.191.2).
- Every forecast records when the weather it was built on was fetched (`weatherFetchedAtMs`,
  carried onto the probabilistic band). A caller may ask for weather at most so old
  (`maxWeatherAgeMs`, the `forecast` and `probabilisticForecast` reports' argument): the 2 h
  weather cache is re-fetched when older (`getWeather`'s `maxAgeMs`), and a cached or in-flight
  forecast built on other weather is rebuilt; a failed fetch leaves the stale weather, and the
  forecast says so. Only the live morning refresh of an armed mid-day charge asks, and it is inert
  while the mid-day charge is a preview (chapter 15 part 2, "The morning refresh"); every other
  caller is served as before.

#### Inputs

| Input | Source |
|---|---|
| Home DPU `pv_total` / `pv_high` / `pv_low` | recorder, 30-day window, home-connected DPUs only (`shp2ConnectedDpuSns`) |
| SHP2 `panel_load` | recorder, weekday/weekend split via `hourCurveByWeekday` |
| GHI / cloud | `getWeather()` (live) + recorder backfill: GHI realized-first (`ghi_wm2_realized`, else first-write `ghi_wm2`, v1.173.0); `cloud_pct` is still the first-write forecast |
| Backup pool | `shp2.projection.backupFullCapWh` / `backupRemainWh` / `backupReserveSoc` |
| EV load | `computeEvWindowPrediction` → `evLoadByHour` (expected-value watts): each session capped at `EV_MAX_LOAD_W` (11 520 W unset) × its recurrence probability; overlapping sessions take the MAX with one charger (`EV_CHARGER_COUNT` unset), the SUM capped at count × `EV_MAX_LOAD_W` with 2–4 chargers; with 0 no circuit is classed as EV |
| Recent load | recorder `panel_load` over `FORECAST_RECENT_LOAD_WINDOW_MS` (3 h) |

#### The per-hour calculation

Loop over `k = 0..23`, `ts = ceil(now/1h) + k·1h`, `clock = siteHour(ts)` (the weekday is
`siteDow(ts)`):

**(a) PV projection** — via `forecastHourPvW(resp, ghi, cloud, fallbackCurveW, clearnessHist)`:

```
if resp.coeff != null and ghi != null:          // equipment-modelled
    pv = min(resp.coeff · ghi, resp.observedMaxPvW · 1.05)   // capped at physical ceiling
    modelled = true
else:                                            // fallback: typical-day curve × cloud derate
    pv = cloud != null
       ? fallbackCurveW · clamp(0.1, 1.3, (1 − 0.75·cloud/100) / clearnessHist)
       : fallbackCurveW
    modelled = false
```

`clearnessHist = max(0.2, 1 − 0.75·mean(pastCloud)/100)` — recent historical
clearness normalizer for the fallback derate only.

**(b) PV bias correction + re-clamp** (v0.93.0 #3 / v1.3.1 rank 11):

```
hourCeil = modelled ? resp.observedMaxPvW · 1.05 : null
pvAlarm  = hourCeil != null ? min(pv · pvBiasFactor, hourCeil) : pv · pvBiasFactor
```

The re-clamp matters: `pvBiasFactor` is clamped to `[0.5, 1.2]`, so an
UNDER-predicting model (factor >1) could otherwise multiply straight past the
observed ceiling and inflate the SoC slope → runway reads LONG (unsafe).
Deflation (factor <1) stays unclamped — it is the conservative direction.

**(c) Load projection**:

```
rawBase = useSplitLoad ? (isWeekend ? weekend[clock] : weekday[clock]) : combined[clock]
trimmed = (nightTrimActive && isSameNightTrimWindow) ? blendNightLoad(rawBase, recentLoadW) : rawBase
baseLoad = anchorNearTermLoad(trimmed, recentLoadW, k, RUNWAY_BLEND_HOURS=4)
load = baseLoad + evLoad
```

- `useSplitLoad` requires ≥ `WEEKDAY_MIN_SAMPLES = 24` weekday and 24 weekend
  hourly samples; else the combined curve is used.
- **Night trim** (`blendNightLoad`) only ever REDUCES a stale-high overnight
  curve toward recent measured load, gated three ways:
  1. Overnight band only: `FORECAST_NIGHT_START_HOUR` (21) .. 23 ∪ 0 .. `FORECAST_NIGHT_END_HOUR` (5).
  2. `shouldTrimNightCurve` — the premise ("curve over-predicts nights") is
     re-checked each build against the last 7 days: enabled only when
     `meanBias > max(150 W, 25%·meanActual)` over ≥12 hindcast night-hours
     (else, with <12 pairs, the trim stays on = the original stale-curve
     regime).
  3. `isSameNightTrimWindow(anchorClock, clock, k)` — the generation-time
     anchor may only trim hours of THIS night (anchor & target in night band,
     `0 ≤ hoursAhead ≤ 9`), so a 04:00 idle anchor can't gut tomorrow evening's AC.
  Trim formula: `max(rawBase·(1−blend), rawBase·(1−maxTrim), min(rawBase, recentLoadW))`
  with `blend = FORECAST_NIGHT_BLEND (0.6)`, `maxTrim = FORECAST_NIGHT_MAX_TRIM (0.5)`,
  ratio `FORECAST_NIGHT_OVERPREDICT_RATIO (1.5)`.
- **Near-term anchor** (`anchorNearTermLoad`) pulls the first
  `RUNWAY_BLEND_HOURS = 4` hours UPWARD toward observed load with a linearly
  decaying weight `w = 1 − hoursAhead/blendHours`, `max`-combined so it never
  makes a light day more optimistic. Mirrors the v0.15.17 runway fix.

**(d) SoC integration — v1.26.0 DC-bus balance** (v1.187.19: on the measured basis, with the
Cores' overhead; v1.194.0: a surplus through the charge leg):

```
basis  = runwayEnergyBasis(devices, shp2, now)          # capacityScale, overheadW (§5.1.3a)
fullWh = backupFullCapWh · capacityScale                # published as poolFullWh
socWh  = backupRemainWh · capacityScale                 # starts at the live percent
socWh  = clamp(0, fullWh, socWh + chargeLegStep(pvAlarm − runwayDrainW(load, overheadW), η_c))
socPct = socWh / fullWh · 100
```

`chargeLegStep(net, η_c)` is `net` for a deficit and `net × η_c` for a surplus, with
`η_c = RUNWAY_CHARGE_EFFICIENCY = √DISPATCH_ROUND_TRIP_EFFICIENCY` = 0.927 — the runway's own
charge leg (chapter 5, step 6).

`runwayDrainW(load, overheadW) = max(load/η, overheadW + load/η_m)` — the same function
`computeRunway`, the multi-day sim and the probabilistic band use (§5.1.3a). The description
of η below is unchanged; the drain adds the Cores' fixed overhead to it.

`RUNWAY_DISCHARGE_EFFICIENCY` (η) defaults to **0.94** (env
`RUNWAY_DISCHARGE_EFFICIENCY`, clamped `[0.80, 1.0]`). PV enters the DC bus at
~unity; the AC load is pulled through the inverter at 1/η, so delivering 1 kWh
costs the pack ~1/η kWh. This makes the pool drain ~6% faster than the raw load
implies — the safe (shorter-runway) direction. Live-confirmed 2026-07-14: 6.22 kW
gross drew for 5.88 kW delivered (ratio 0.945, the measured pack-terminal→AC
discharge-conversion leg; v1.32.0 corrected an earlier reading of it as the 7-day RTE, a
different quantity that excludes both conversion legs). The η term applies in every hour,
not only on net-discharge hours: a deficit drains at `load/η`, and a surplus charges by only
`η_c` × the DC residual `pv − load/η` (v1.194.0: charging the cells loses energy too; on 29
measured surplus spans the pool gained 2–7 % less than the residual). Because
`η_c (pv − load/η) ≤ pv − load/η ≤ pv − load` for every surplus, the sim is never MORE
optimistic than pre-v1.26, and across a sunny day it now reads lower than before v1.194.0. The
outer `min(fullWh, …)` / `max(0, …)` is only the pool clamp.

`minProjectedSoc` / `minProjectedSocTs` track the lowest SoC over the horizon —
these feed the forecast-soc-dip narrative and are bounded by the runtime card.

#### Restored display basis (v0.78.0)

After the alarm loop, a second 24-hour loop re-runs `forecastHourPvW` with the
`restoredSolarModel` + `restoredPvCurve` (all SHP2-connected Cores including
cloud-wedged ones) to produce `forecastPvWhNext24Display` /
`typicalPvWhPerDayDisplay` / `typicalPvCurveWhPerHourDisplay`. The restored model and
curve are built by SUMMING real recorded PV by SN only, never extrapolated. Since v1.177.0
the display next-24 h sum applies the same `pvBiasFactor` and per-hour `observedMaxPvW·1.05`
re-clamp as the alarm series, so `forecastPvWhNext24Display` equals `forecastPvWhNext24`
exactly when no Core is missing (before v1.177.0 it stayed raw and differed by the bias
factor). `typicalPvWhPerDayDisplay` / `typicalPvCurveWhPerHourDisplay` stay raw, like their
reporting-basis counterparts. These NEVER feed the
runway alarm.

**Per hour, with a SoC walk (v1.195.0).** The same loop keeps each hour's restored PV
(`hoursDisplay[k].forecastPvW`, the hour's term of `forecastPvWhNext24Display`) and walks a second
SoC trajectory on it (`hoursDisplay[k].projectedSocPct`, its lowest point
`minProjectedSocDisplay` / `minProjectedSocTsDisplay`). The walk starts where the alarm walk does
(the same `socWhStart`), uses the same hourly load (EV included) and steps through the same
function, `stepSocWh(soc, full, pv, load) = max(0, min(full, soc + chargeLegStep(pv − runwayDrainW(load, overheadW), η_c)))`
(the alarm walk's step in (d) above, the charge leg included), so with every home Core reporting `hoursDisplay` equals `hours[]` (PV, SoC and the `modelled` flag)
and `minProjectedSocDisplay` equals `minProjectedSoc`, except that `minProjectedSocDisplay` is null
when `pvForecastUnavailable` (no PV history to walk on), as it is with no SoC basis. Each hour's
`modelled` is the restored model's own flag (a fitted hour, or the typical-day fallback), for the
detail card's source badge: with every Core dark the alarm model has no Core to fit on and reads the
fallback in every hour. `restoredCoreCount` is the number of connected home Cores not reporting live
whose own recorded PV the display basis adds; an offline Core with no PV history in the window (more
than one reading, the test `pvForecastUnavailable` applies) adds nothing and is not counted, so 0
means nothing was restored and the cards show the alarm basis. With every home Core dark
the alarm series is 0 W in every hour and its walk drains toward 0%; the dashboard's forecast cards
show this restored series instead, labelled, with the alarm-basis figures beside it ([chapter 11](11-user-interfaces.md), ForecastCard).
The four fields sit outside `hours[]`, so `hours[].forecastPvW` stays the one alarm series: none of
`computeRunway`, `computeForecastAlerts`, `forecastDayAlerts`, the multi-day and probabilistic
forecasts, the dispatch plan or the night-charge planner reads them, and Home Assistant's
`projected_low_soc_percent` / `projected_low_soc_at` and the calendar's battery-dip event stay on the
alarm basis (`forecastDisplayBasis.test.ts` pins this by behaviour and by source).

#### Structural-incompleteness gate

```
loadCold        = loadRes.spanMs === 0            // no panel_load history (also true when SHP2 absent)
pvCold          = homeDpus.length > 0 && pvSpan === 0
socBasisMissing = fullWh == null                  // no SHP2 / incoherent backup pool
basisPending    = homeBasisPending(devices, now)  // v1.187.10: a connected home Core listed online whose first quota has not landed (boot race; only within HOME_BASIS_PENDING_MAX_MS = 10 min of analytics start)
structurallyIncomplete = loadCold || pvCold || socBasisMissing || basisPending || historyDays <= 0
```

Surfaced as `DayForecast.structurallyIncomplete` (v0.77.0) so ha-state/MQTT can
publish a diagnostic "forecast basis incomplete" sensor; also drives the short
negative-cache TTL.

#### Output (`DayForecast`, key fields)

| Field | Meaning |
|---|---|
| `hours[]` | `{ts, forecastPvW, forecastLoadW, cloudCoverPct, ghiWm2, projectedSocPct, modelled, predictedEvLoadW?}` — the alarm-facing (bias-corrected, reporting-only) series |
| `forecastPvWhNext24` | Σ bias-corrected PV (alarm basis) |
| `typicalPvWhPerDay` | RAW historical hour-of-day avg — NEVER bias-corrected |
| `pvBiasFactor` | the applied factor (1.0 no-op until mature) |
| `typicalPvCurveWhPerHour[]` | 24-slot diurnal baseline (sums to typicalPvWhPerDay) |
| `pvCeilingW` | max `observedMaxPvW·1.05` over modelled hours (P90 clamp) |
| `minProjectedSoc` / `minProjectedSocTs` | horizon low SoC |
| `reserveSoc` | `backupReserveSoc ?? 15` |
| `solarModel` / `restoredSolarModel` | alarm vs display fleet fits |
| `deviceModels[]` | per-DPU whole-inverter + HV + LV models |
| `soiling` | `fleetSoilingFromDevices(...)` (per-Core median drop; null <6 clean days) |
| `*Display` fields | full-fleet display basis |
| `hoursDisplay[]` | v1.195.0: `{ts, forecastPvW, projectedSocPct, modelled}` — the restored display basis per hour, its SoC walk and the restored model's flag (display only; the forecast cards) |
| `minProjectedSocDisplay` / `minProjectedSocTsDisplay` | v1.195.0: the restored walk's low; null when `pvForecastUnavailable` or with no SoC basis |
| `restoredCoreCount` | v1.195.0: connected home Cores not reporting live whose own recorded PV history the display basis adds (one with none is not counted); 0 ⇒ the cards show the alarm basis |
| `homeDpusConnected/Reporting/CoveragePartial` | coverage caveat |
| `structurallyIncomplete` | basis incomplete (gate below); selects the short negative-cache TTL |
| `homeBasisPending` | v1.187.10: built while a connected home Core's first reading was pending; publishers send the PV pair and Projected Low SoC as null while it is set |
| `pvForecastUnavailable` | v1.178.0: the display basis has no PV history at all (`restoredPvSpan === 0`); publishers send null (HA "unknown") instead of a model-less 0 |
| `solarModelSns` | v1.186.5: sorted SNs of the home Cores the solar model was fitted on; gates cache reuse and forecast-skill scoring |
| `poolFullWh` | v1.187.18: the backup pool's full capacity (Wh) the SoC trajectory was integrated against; null with no SHP2 or an untrusted pool; read by the probabilistic band. v1.187.19: `backupFullCapWh × poolCapacityScale`, the packs' measured capacity (was the nameplate sum) |
| `poolCapacityScale` / `poolCapacityBasis` / `poolOverheadW` | v1.187.19 — the measured basis and the drain overhead the trajectory used (§5.1.3a); the probabilistic band reads `poolOverheadW` |
| `weatherFetchedAtMs` | v1.189.0: when the weather the forecast was built on was fetched (null without weather); the `maxWeatherAgeMs` test above reads it |

#### Endpoint

`GET /api/forecast` → `analytics.report('forecast')`, HTTP cache 60 s. The route adds `siteTimeZone` (v1.191.1), the zone the hours were computed in; the web labels each hour in it, never in the browser's zone.

---

### 3. PV bias correction (`computePvBiasCorrection`, v0.93.0 #3)

#### What + why

The GHI→PV model over-predicts on cloudy days (field factor ≈0.62). Left raw,
over-predicted PV shrinks the runway deficit → latent islanding UNDER-alarm.
This helper hindcasts the reporting-only `solarModel` against the last 7 days of
actual home-Core PV and returns a **clamped, guarded scalar** applied to the
alarm-facing PV before `computeRunway` / `computeMultiDayForecast` /
`computeProbabilisticForecast` consume it.

#### Calculation

For each of the last `windowDays = 7` days that (a) has any GHI coverage
(`dayHasGhiCoverage`) and (b) is NOT a telemetry-gap day (per
`coreCoverageByDay` — every wired core must report ≥ `PV_COVERAGE_MIN_FRAC = 80%`
of the day's daylight hours):

**One coverage rule for both consumers.** `coreCoverageByDay` holds every Core a
day is measured on to the same bar: a Core with no readings on a day is a gap that
day, whatever the reason. The pv-bias factor measures each day on every current
home Core, so a wholly dark Core fails every day and the factor degrades to its
neutral 1.0 no-op. The forecast skill (section 4) measures each day on the Cores
the membership record says were in the pool that day (`coresOn`, from
`skillRosterByDay`). Before v1.196.0 the skill path exempted a Core until its
first in-window sample (`skipBeforeJoin`, v1.93.0, made per-day in v1.94.0: "had
not joined yet"). No readings is also what a blackout already running when the
window began produces, and what Cores returning on different days after a
fleet-wide outage produce, so the dark Core's missing share was scored as a
forecast miss: +50% a day with one of three Cores dark, +200% with two. The days
2026-08-11..08-19, scored on the current Cores with the dark and not-yet-pooled
ones exempted, read as 184–258% misses until they left the window around 09-19;
PV band coverage fell to 72% < 78% and the basis gate closed anyway.

```
predWh = Σ_h  resp[hod].coeff · ghi(h)          // where coeff != null
actWh  = Σ_h  Σ_SN  mean(pv_total slice over the hour)   // per-SN hourly means are SUMMED (fleet total); an SN with no sample that hour adds 0
```

A day feeds the ratio only if **mature**: `predKwh > 0.5 && actKwh > 0.5 &&
predKwh ≥ 0.25·actKwh`. Then:

```
if matureDays < PV_BIAS_MIN_MATURE_DAYS (3) or totalPred ≤ 0.5:  return 1.0   // no-op
raw = totalAct / totalPred
return clamp(PV_BIAS_CLAMP_LO=0.5, PV_BIAS_CLAMP_HI=1.2, raw)
```

The `[0.5, 1.2]` clamp: factor <1 (over-prediction) shortens runway = safe; the
1.2 ceiling caps any runway-lengthening correction. Self-activating — a no-op
until data matures.

The per-core coverage gate (v1.10.0 F4) exists because scoring missing telemetry
as missing sunlight had crashed the factor to 0.63 (truth ~1.15) during the
06-29→07-02 cloud/wedge blackout.

---

### 4. Forecast skill (`computeForecastSkill`)

#### What + why

Backtests the model: predicted vs actual **daily PV kWh** over a trailing window,
yielding MAE and a `biasFactor`. Powers `/api/forecast-skill`,
`/api/confidence`, and (via MAE→sigma) the probabilistic band width.

#### Calculation

Window `windowDays` (default 7, clamped 1–30 at the route since v1.30.0; `/api/confidence`
and the band calibrator request 30). For each past day `i = windowDays..1`, `dayStart = todayStart − i·1d`:

First, the Cores each day is measured on (`skillRosterByDay`), from the pool
membership record (`membership-history.json`, membershipHistory.ts; the
recorder writes the connected-Core set and, since v1.196.0, the panel slot each
Core holds). Memberships held under `MEMBERSHIP_GLITCH_MS` (15 min, the
recorder's own bar for a change) are folded away (`membershipsDuring`), so a
one-poll `isConnect` flicker does not move a day. Against the current home Cores
(`solarModelSns`):

| Verdict | When | Measured on |
|---|---|---|
| `off-roster` | a current home Core was in neither form (added through a slot nobody held, or recorded before slot maps), the day's Cores changed during the day, or the day would be a `predecessor` day that no fresh panel reading confirmed | not scored: `offRoster: true`, `errorPct` null |
| `on-roster` | every current home Core was in the pool all day (a pool with more Cores, before one left, counts) | the current home Cores |
| `predecessor` | a current home Core was not yet in the pool, but the Core that then held its panel slot was: a like-for-like swap, in which the incoming Core takes over the departing Core's PV array (`standInCores`); and a fresh panel reading confirmed the record through the day (`membershipConfirmedDuring`) | that day's Cores; the day is emitted `predecessorCores: true` |
| `unrecorded` | the day starts before the record (a fresh install, a lost file, entries past the 64-entry cap) | the current home Cores, on telemetry coverage alone; counted in `unrecordedRosterDays` |

The recorder stamps the newest entry `confirmedMs` on a fresh reading of every
panel (`shp2ReadbackFresh`), at most once an hour (`MEMBERSHIP_CONFIRM_STEP_MS`).
A cloud-offline panel keeps its last projection, and a stopped add-on reads
nothing, so a swap made in such a stretch is recorded only when the panel next
reads fresh, and until then the record still names the departed Core, by then on
the bench. A stand-in day therefore needs the record confirmed through it, within
`MEMBERSHIP_CONFIRM_SLACK_MS` (75 min); otherwise it is `off-roster`. On-roster
and unrecorded days need no stamp: they are measured on the current home Cores.

```
predWh = Σ_h  forecast.solarModel.hourly[hod].coeff · ghi(h)     // coeff != null
actWh  = Σ_h  Σ_{day's Cores}  mean(pv_total slice over the hour)
predKwh, actKwh = /1000;  errKwh = predKwh − actKwh
errPct = (weatherCovered && !coverageGap && !offRoster && actKwh>0.5) ? errKwh/actKwh·100 : null
```

Day is emitted with `weatherCovered` (`dayHasGhiCoverage`), `coverageGap`
(a Core the day is measured on reported under 80% of the daylight hours, a Core
with no readings included, `coreCoverageByDay`), `offRoster` and
`predecessorCores`. Only days that are weather-covered, NOT a coverage gap, NOT
off-roster, AND mature (`predKwh>0.5 && actKwh>0.5 && predKwh ≥ 0.25·actKwh`)
feed the aggregate stats:

```
meanAbsErrorKwh = mean(|errKwh|)  over scored days
meanAbsErrorPct = mae / meanActual · 100   (when meanActual > 0.5)
biasFactor = totalActual / totalPredicted  (Σactual/Σpredicted; null if totalPred ≤ 0.5)
```

> `biasFactor` is the **multiplier convention**: >1 = model UNDER-produces (alarm
> scales PV up). This is the same quantity `computePvBiasCorrection` clamps.
> Note `/api/degradation`'s forecast bias (in `reports.ts`) is `mean(pred−actual)
> Wh/h` — the opposite-signed *additive* convention for the SAME error.

Actuals are scoped to **SHP2-connected home DPUs only** (v0.21.0), matching the
predictor's training set: the current home Cores, or on a day before a
like-for-like swap the Cores then in their slots, never a bench Core. After a
Core is ADDED (a slot nobody held), the days before it are off-roster and the
scored window rebuilds from the day it joined; a removal keeps scoring, and a
like-for-like swap loses the day of the swap and any unconfirmed day before it. Cached `FORECAST_SKILL_TTL_MS = 1 h`, keyed by
`${windowDays}:${ghiBasis}` and valid only for the forecast it was scored against
(`forecastTs === forecast.generatedAt`, v1.186.5); a structurally incomplete forecast, or
one whose model was fitted on other home Cores than the current map's
(`DayForecast.solarModelSns`), is never scored (empty, uncached).

Each report built on the forecast (skill, band, multi-day, runway, clipping, forecast alerts)
reads the forecast before its own cache. Since v1.191.2 that read is a cache hit, about
0.5 µs on the development machine, also with every home Core dark. Checking a builder's own
TTL first was evaluated for v1.191.3 and declined: it saves no forecast build (their count is
set by the 30-min forecast TTL and the alarm feed's requests) and, to save anything, it would
serve a skill, band or multi-day entry scored on a superseded forecast (the dark-fleet
rebuilds section of `docs/PERFORMANCE.md`).

**Irradiance basis (v1.173.0, GHI stage 2).** `ghi(h)` depends on the `ghiBasis`
argument. `'first-write'` is the default and matches the pre-v1.173.0 behaviour exactly:
recorder `ghi_wm2` (the first value written for each hour, a ~3–4-day-lead forecast)
wins over the live cache (`buildGhiByEpoch`). `'realized'` scores the model against
what the sun actually did. The precedence is `ghi_wm2_realized` > live cache >
`ghi_wm2` (`buildRealizedGhiByEpoch`). The cache ranks above `ghi_wm2` so that the
hours a restart leaves uncaptured use the provider's past-hour estimate, not the
forecast. A persisted realized row ranks above the cache so that a restart cannot
re-score a past day. A realized 0 removes the hour. The display report
(`/api/forecast-skill`, `/api/confidence`, the forecast-bias repair card) passes
`'realized'`. Since v1.173.1 the PV band calibrator (`probabilisticForecast`) also passes
`'realized'` (a policy decision). Its skill sets `skillFrac`, `bandSigmaCal`,
`bandRealizedCoveragePct` (the night-charge basis gate) and `realizedDailyErrHalfFrac` (the
multi-day P10/P90 widening that sizes a buy). On the realized basis the errors no longer
carry the ~3–4-day-lead weather-forecast component, and the widening narrows by about 40%
on the 2026-09 window. Neither basis is lead-matched to a day-ahead band. No current caller
uses the `'first-write'` function default. The cache key includes the basis so that a
default-basis call can never be served a realized-basis score, or the reverse. Other readers of the stored series now take it
realized-first, falling back to `ghi_wm2` hour by hour where no realized row exists:
solar-model training, the soiling decomposition and the alarm-model backtest.
Realized capture began with v1.156.0 (on the reference plant, 2026-09-06 17:00 MST), and `past_days=7` cannot backfill
earlier hours. Windows longer than about 15 days therefore mix the two bases until
the older hours age out. `cloud_pct` remains first-write. Every reader goes through
`queryRealizedGhi`, and a parser-based test pins the exact set of its callers.

#### Output (`ForecastSkillReport`)

```ts
{ generatedAt, days: ForecastSkillDay[], meanAbsErrorKwh, meanAbsErrorPct,
  biasFactor, windowDays, ghiBasis?,       // ghiBasis: 'first-write' | 'realized'
  unrecordedRosterDays? }                  // window days before the membership record
ForecastSkillDay = { date, predictedKwh, actualKwh, errorKwh, errorPct|null,
                     weatherCovered, coverageGap?, offRoster?, predecessorCores? }
```

#### Endpoint

`GET /api/forecast-skill?days=N` (N clamped 1–30, default 7) →
`analytics.report('forecastSkill', {days})`, cache 60 s.

---

### 5. Confidence snapshot (`computeConfidenceSnapshot`)

#### What + why

A small, honest "how trustworthy is each engine" headline. Aggregates
degradation, thermal, and forecast-skill diagnostics.

#### The `forecastDayR2` metric (v1.20.0 F21)

Replaces the old within-slot median r² (`solarModelMedianR2`), which read a
degenerate ~0.02 while the model's day-level replay scored ~0.94. This is the
**Pearson r² of predicted vs actual daily PV kWh** across the skill report's
scored days:

```
scored = skill.days.filter(weatherCovered && errorPct != null)
if scored.length ≥ 5:
    forecastDayR2 = cov(pred,act)² / (var(pred)·var(act))
else: null
```

`/api/confidence` deliberately requests a **30-day** skill window (the basis the
r²≈0.94 premise was validated on) — a 7-day clear-sky window gives low-variance
points whose r² is noise-dominated.

#### Output (`ConfidenceSnapshot`)

```ts
{ generatedAt, degradationMedianR2, forecastDayR2, thermalMedianR2,
  forecastSkillBiasFactor, forecastSkillMaePct }
```

#### Endpoint

`GET /api/confidence` — fetches `degradation`, `ambientThermal`, and
`forecastSkill{days:30}`, cache 60 s.

---

### 6. Probabilistic P10/P90 SoC band (`computeProbabilisticForecast`)

#### What + why

Wraps the deterministic forecast in a **coherent trajectory ensemble** that
compounds uncertainty across the horizon, producing P10/P50/P90 PV watts and SoC%
per hour plus summary event probabilities. Cached `PROB_TTL_MS = 15 min` and reused only for
the day forecast it was built on (`forecastTs === forecast.generatedAt`, v1.186.5). A band
built on a structurally incomplete forecast is served but never cached: its skill is
empty, and caching it would keep the night-charge basis gate failed for 15 min after the
forecast became complete.

#### Per-hour sigma (raw, then calibrated)

For each forecast hour:

```
cloudStdev       = cloudVarByHour[hod]        // historical hour-of-day cloud stdev (fallback 0.25, capped 0.6)
disagreementFrac = ensembleDisagreementPct/100   // Open-Meteo vs NWS (v0.9.2)
skillFrac        = skill.meanAbsErrorPct/100  (fallback 0.15)
baseSigmaFrac    = sqrt(cloudStdev² + skillFrac² + disagreementFrac²)
horizonHours     = (h.ts − forecastStartTs)/1h
sf (raw)         = baseSigmaFrac · sqrt(1 + horizonHours/24)     // hour 24 ≈ 1.41× (variance ~linear in time)
```

#### Self-calibrating band width (v1.23.0 F30)

The raw band over-covers badly (live pre-fix: 76% daily half-width vs ~7%
realized error → ~100% coverage against a nominal 80%). So the band is
**shrunk** toward the realized error spread:

```
producedHalfFrac = Σ (p90−p10)/2  /  Σ p50            // raw band's daily half-width fraction
errs             = pvBandScoredErrs(skill.days, pvBiasFactor)
                   //  v1.31.0 — per scored day: |actual − pred·biasFactor| / (pred·biasFactor)
                   //  (bias-adjusted so the errors are of the SERIES THE BAND WRAPS —
                   //   hours[].forecastPvW carries pvBiasFactor — and %-of-PREDICTED,
                   //   matching how the half-width is applied to P50)
realizedHalfFrac = errs[k],  k = ceil(0.8·(n+1))       // v1.31.0 — E[coverage] = k/(n+1) ≥ 0.8 ∀n
if env PV_BAND_SIGMA_CAL set:  bandCal = clamp(0.1, 2, env)
elif realized & produced known: bandCal = clamp(PV_BAND_CAL_FLOOR=0.4, 1, realizedHalfFrac/producedHalfFrac)
else: bandCal = 1
sigmaFrac = sfRaw · bandCal
```

`pvBandRealizedHalfFrac` returns null below `PV_BAND_CAL_MIN_DAYS = 14` scored
days (so a short clear-sky window can't collapse the band — monsoon variability
must be in the sample). The skill window feeding it is
`PV_BAND_CAL_WINDOW_DAYS = 30` **calendar** days (v1.30.0 — the gate counts
*scored* days; at realistic ~50–65% weather/telemetry coverage a 14-day window
can never reach 14 scored days, which left the calibration dormant from
v1.23.0 to v1.30.0). Shrink-only, floored at 0.4.

**Honest label:** the calibration is shrink-only (`min(1, …)`) and floored at 0.4, so
the band targets "**≥ 80% coverage, deliberately conservative**" (not "= 80%") only while
the calibrator is `shrunk` or `floor-pinned`. When realized error meets or exceeds the
produced half-width, the calibrator is `saturated`: the band is too narrow and the
calibrator cannot widen it, so coverage can fall below 80%. `bandSigmaCalBasis` (v1.149.0)
publishes which of the five states (`operator-override` / `shrunk` / `floor-pinned` /
`saturated` / `uncalibrated`) produced `bandSigmaCal`. Known gaps the floor is insurance for (v1.31.0 review): the calibrator's errors come from a *current-model hindcast against stored irradiance*, so they (a) are rewritten when the model re-learns, (b) since v1.173.1 score against realized-first irradiance (`ghi_wm2_realized`, falling back hour by hour to first-write `ghi_wm2`): they carry none of the weather-forecast error that a day-ahead band's real error contains, except on fallback hours, which still carry a ~3–4-day-lead forecast component (see §3.4, Irradiance basis, and §3.8), (c) apply `pvBiasFactor` as
a plain daily multiply while publication re-clamps per-hour at the physical
ceiling — under an *under-prediction* regime (`pvBiasFactor > 1`, ceiling
pinned) the calibrator's basis sits above the published series and its errors
under-state the published band's misses (dormant while `pvBiasFactor ≤ 1`, the
current regime), and (d) the sample censors tail days — `actualKwh ≤ 0.5`
days (errorPct null) and `adjPred ≤ 0.5` days drop rather than scoring as
≈100% misses, and a retention-truncated fragment day at the window's oldest
edge can carry a phantom error (conservative direction: it inflates q80). All
four are resolved properly by archive-based out-of-sample scoring, not by
patching the hindcast basis further. The recorder's `forecast/pv_next24_wh`
archive series (v1.31.0, written by the main process's GHI-persistence tick)
accumulates the *issued* forecasts so a future release can score genuinely
out-of-sample; the published `calScoredDays` + `bandRealizedCoveragePct`
diagnostics make the coverage claim continuously measurable — a reading
trending toward 80% is the signal to revisit the floor, below it is a
regression. **NOT an alarm input** (verified by exhaustive consumer census, v1.30.0 audit; wiring any
field into mqttDiscovery/alerts/runwayAlarm requires re-auditing the calibration).
Consumers: the display, the recommend-only MPC planner, and the night-charge advisor
(§15), which sizes a charge from the per-hour P10 PV, `realizedDailyErrHalfFrac`
(multi-day widening) and `bandRealizedCoveragePct` (basis gate). Below 14 scored
days the band published here stays the raw one (`uncalibrated`) and
`realizedDailyErrHalfFrac` is null; from 4 scored days the night-charge advisor
nevertheless plans, on a widened copy of this band's P10 that it keeps to itself —
the provisional band ([chapter 15 part 1](15-1-night-charge-planning.md)). Nothing
published here moves: the display, the alarms and the night ledger read the band as
it is, and the advisor's coverage gate reads `bandRealizedCoveragePct` on it.

#### PV band per hour

```
p50 = h.forecastPvW
p10 = max(0, p50·(1 − Z10·sigmaFrac))       Z10 = 1.282
p90raw = p50·(1 + Z10·sigmaFrac)
p90 = pvCeilingW>0 ? min(p90raw, pvCeilingW) : p90raw   // clamp best case to physical ceiling (v0.14.1)
```

#### Coherent SoC ensemble (v1.16.0 F7)

The old design reset the band per hour (overnight it collapsed to ±0.1 pt while
real nightly minima spanned 9–38%). Now `PROB_ENSEMBLE_Z` is **21
equal-probability quantiles** `Φ⁻¹((i+0.5)/21)` from −1.9808..+1.9808. Every
member draws ONE z and holds it for the whole window (forecast errors are
correlated across hours — a cloudy day is cloudy all day), so the trajectory is
monotone in z and the z=∓1.282 paths are exact P10/P90 trajectories.

**Full capacity** (`fullKwh`) — v1.187.18: a production forecast carries the capacity its
trajectory was integrated against (`DayForecast.poolFullWh`; since v1.187.19 the packs' measured
capacity, `backupFullCapWh × poolCapacityScale`), and that value is used directly. The back-out
below applies only to a forecast without it (hand-built ones): it is inverted from the forecast's
own SoC trajectory with the drain that built it — `runwayDrainW(load, poolOverheadW ?? 0)`
(v1.187.19; `netKwh` in the code), so a forecast with no overhead is read with the
pre-v1.187.19 `load/η`:

```
fullKwh = netKwh(cur.forecastPvW, cur.forecastLoadW)  /  (dSocPct/100)
rawNetKwh(pv, load) = (pv − runwayDrainW(load, poolOverheadW ?? 0)) / 1000
netKwh(pv, load)    = chargeLegStep(rawNetKwh(pv, load), η_c)    // v1.194.0: the trajectory's own charge leg
```

Read at unity across a surplus hour, the inversion would recover `poolFull / η_c` (8 % larger)
and narrow the band.

picking the hour with the largest unclamped `|dSocPct|` (best conditioning;
skips deltas <0.05 pt, SoC within 0.5 of 0/100, kwhDelta <0.05, candidate outside
[5,1000] kWh). Last resort, when there is no pool value and no hour pair yields a usable
inversion: `homeCores · PACKS_PER_DPU(5) · PACK_KWH_NAMEPLATE(6.144)`, with `homeCores =
max(1, solarModelSns.length ?? deviceModels.length)` (before v1.187.18 it counted every DPU in
`deviceModels`, bench Cores included: on the reference plant, 153.6 kWh against its 92.16 kWh pool). With no pool value
`projectedSocPct` is null throughout and `fullKwh` is never read.

**Integration** — each path (and the low/mid/high band paths) steps per hour:

```
sigmaPvKwh   = (p90 − p10)/2000/Z10
sigmaLoadKwh = PROB_LOAD_SIGMA_FRAC · max(0, forecastLoadW) / 1000    // 0.15 default (env PROB_LOAD_SIGMA_FRAC)
sigmaNetKwh  = sqrt(sigmaPvKwh² + sigmaLoadKwh²)                       // quadrature within the hour
dP50Kwh      = rawNetKwh(p50, forecastLoadW)                           // v1.26.0 DC-bus balance (v1.187.19: runwayDrainW)
stepPct(z)   = chargeLegStep(dP50Kwh + z·sigmaNetKwh, η_c)/fullKwh · 100  // v1.194.0: the leg AFTER the spread
path = clampSoc(path + stepPct(z))                                    // clamp 0..100 per path
```

The load-side sigma is essential: PV sigma is 0 at night (multiplicative on PV=0),
yet load surprise (EV, HVAC) dominates realized overnight spread.

The charge leg is applied per path, after the spread is added: a path whose net is a surplus
stores `η_c` of it, a path in deficit drains in full. Across a sunny hour the spread itself is
therefore stored at `η_c` (a band about 7 % narrower there than one stepped at unity), and the
median path reaches the full rail when the anchor does.

Published SoC anchors to the deterministic curve, band carries only the OFFSET:

```
p50SocOut = anchorSoc (= h.projectedSocPct, carried across null/NaN hours)
p10SocOut = clampSoc(anchorSoc + lowSoc − midSoc)
p90SocOut = clampSoc(anchorSoc + highSoc − midSoc)
```

The ensemble is seeded ONE deterministic step behind the anchor (using hour-0's
own `netKwh` delta) so the raw median doesn't clamp a rail an hour early.

#### Summary probabilities (v1.16.0 F23)

Min/max-over-path event probabilities over the equal-weight ensemble (replacing
the old fraction-of-hours count that read "42% above reserve" while the median
sat below reserve 11 h straight):

```
pAboveReservePct = share of paths whose per-path MIN SoC ≥ reserveSoc    (null if no trajectory)
pFullCharge      = share of paths whose per-path MAX SoC ≥ 99
uncertaintyKwhStdev = Σ per-hour sigmaNetKwh
```

A non-finite PV/load hour sets `windowUnscored` and nulls the min/max summaries
(fails safe: "never dips" is unknowable for a window not fully scored).

#### Output (`ProbabilisticForecast`)

```ts
{ generatedAt, hours: ForecastBand[], pAboveReservePct|null, pFullCharge|null,
  uncertaintyKwhStdev, bandSigmaCal?, bandSigmaCalBasis?,   // v1.149.0: which of five states produced bandSigmaCal
  realizedDailyErrHalfFrac?, calScoredDays?, bandRealizedCoveragePct?,   // v1.31.0 coverage diagnostics
  solarModelSns? }   // v1.187.0: Cores the day forecast's solar model was fitted on (null = unknown)
ForecastBand = { ts, p10W, p50W, p90W, p10SocPct|null, p50SocPct|null, p90SocPct|null }
```

#### Endpoint

`GET /api/forecast/probabilistic` → `analytics.report('probabilisticForecast')`,
cache 60 s. Also consumed by the recommend-only MPC planner (`/api/dispatch/recommend`)
for a pessimistic P10 PV envelope, and by the night-charge advisor (§15).

---

### 7. Multi-day horizon (`computeMultiDayForecast`)

#### What + why

Extends the 24 h horizon to `horizonDays` (default 3, clamped 1–7 at route) with
per-day rollups over site calendar days (`date` is the site date). Cached `MULTI_DAY_TTL_MS = 30 min`, keyed by `horizonDays` (v1.33.0:
otherwise a `days=3` UI call answered the night-charge planner's `days=4` request and
truncated its weekend lookahead).

#### Calculation

Hours **inside** the 24 h day-ahead window reuse the exact `ForecastHour`
verbatim (bias-corrected PV + weekday/EV/trim-aware load) via `forecastByHourEpoch`
(v1.4.4 #50/#22) — no re-derivation, so day-0 stays consistent with
`getDayForecast`.

Hours **beyond** the window:

```
radiationWm2 = wx ? wx.radiationWm2 : climoRadiationWm2(hod)   // per-hour-of-day mean of the live Open-Meteo cache's non-zero radiation (past and forecast hours)
pv = min(min(resp.coeff·rad, observedMaxPvW·1.05)·pvBiasFactor, ceilW)   // same bias + re-clamp
load = useSplitLoad ? (weekend?weekend[hod]:weekday[hod]) : (loadByHod[hod] ?? fallbackLoad)
       + evLoad
```

The radiation climatology (v0.10.4) prevents a horizon cliff: with the 2-day forecast
fetched at the time, day-3 hours had no `wx` → PV computed 0 → a phantom "battery dead in
3 days" panic. Since v1.35.0 the fetch requests `forecast_days=4` (UTC days), so real
forecast radiation covers days 3–4 and the climatology fills only hours past the end of
the cached forecast. `pvBiasFactor` is reused from the day-ahead
forecast (`forecast.pvBiasFactor ?? 1`).

SoC integrated with the same DC-bus balance as the day forecast — on the measured basis
(`backupFullCapWh`/`backupRemainWh × capacityScale`) with `socWh + (pv − runwayDrainW(load,
overheadW))` since v1.187.19, a surplus stored at `η_c` (`chargeLegStep`) since v1.194.0 —
clamped `[0, fullWh]`. Report-only, never an alarm gate. The
night-charge planner reads only each hour's `pvW`/`loadW` from this report, never `socPct`.

#### Output (`MultiDayForecast`)

```ts
{ generatedAt, days: DayRollup[] }
DayRollup = { date, pvKwh, loadKwh, minProjectedSoc|null, minProjectedSocTs|null,
              hours: { ts, pvW, loadW, socPct|null }[] }   // v1.34.0: per-hour trajectory for the night-charge advisor; day 0 covers future hours only
```

#### Endpoint

`GET /api/forecast/multi-day?days=N` (default 3) →
`analytics.report('multiDayForecast', {days})`, cache 60 s.

---

### 8. Weather ingestion (`weather.ts` + `nws.ts`)

#### Open-Meteo (primary — GHI source)

`getWeather()` — TTL-cached (`TTL_MS = 2 h`), single-flighted. Fetches:

```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}
  &hourly=cloud_cover,shortwave_radiation,temperature_2m&forecast_days=4&past_days=7
```

`past_days=7` (v0.13.1) so one fetch backfills a week of irradiance into the
recorder (`recordWeatherGhi`, called by the 45-minute `ghiPersistTick` in `index.ts`
(v0.13.3; skipped under critical host pressure) and on each `/api/weather/ensemble`
request), unblocking
forecast-skill days 4–7 and the soiling estimator beyond the in-memory window.
No timezone is requested, so Open-Meteo returns GMT times (`utc_offset_seconds` = 0) and `forecast_days` / `past_days` count UTC days; the offset is still applied if one is ever sent.
On fetch failure it returns the stale cache ("better than nothing").

**The stored `ghi_wm2` series is forecast irradiance, not the provider's past-hour estimate.**
`recordWeatherGhi` keeps the first value ever written for an hour, and the first
fetch that contains an hour sees it roughly 3–4 days ahead (`forecast_days=4`);
the later `past_days` value never replaces it. Before v1.173.0, recorder-backed readers
therefore saw forecast irradiance: the forecast-skill hindcast (and through it the PV band
calibration and the night-charge basis gate); for days older than the live cache,
solar-model training, the PV bias correction (the hours of its oldest local day that fall before the cache's first UTC midnight — in the local evening for installs west of UTC, e.g. from 17:00 MST) and soiling (its recent pool is the last five well-covered clear days, usually inside the cache but reaching recorder days in a cloudy week, and its p90 baseline sits mostly on the recorder); and the backtest. Measured
2026-09-11: 3,180 W/m² stored vs 5,296 in the provider's past-hour values over hours
8–15. v1.156.0 captures the past-hour values separately as `weather/ghi_wm2_realized`
— "realized" meaning Open-Meteo's own estimate after the hour, not a measurement:
only hours whose whole interval had ended at the fetch's `fetchedAt`, every hour
stored explicitly (no same-as-previous collapse), revised in place by later fetches,
and never from a value the provider did not send (flagged `radiationMissing` at
parse time; the stand-in 0 still reaches the existing consumers exactly as before).
Stage 1 read nothing from it. Stage 2 (v1.173.0) switches training, soiling, the
display skill report and the backtest to it, realized-first. The PV bias correction
hindcasts on the training map, so it is realized-first too. Since v1.173.1 the band
calibrator also reads it realized-first. This was a policy decision, because the
calibrator's basis moves the night-charge basis gate and the P10 band that sizes a
supervised reserve write (see §3.4, Irradiance basis). `past_days=7` is
the capture horizon: an hour not captured within about seven UTC days cannot be
recovered from this endpoint.

`WeatherHour = { ts, cloudCoverPct, radiationWm2, radiationMissing?, tempC, ensembleSources?, ensembleDisagreementPct? }`. When `radiationMissing` is true the provider sent no value for the hour and `radiationWm2` is a stand-in 0, not darkness.

The coordinates, for Open-Meteo and NWS alike, are `siteCoordinates()` (site.ts): the add-on
options `FORECAST_LAT` / `FORECAST_LON`, whose defaults are a placeholder city centroid (Phoenix:
33.4484, -112.074), or, with `SITE_LOCATION_FROM_HA` on, Home Assistant's home location as saved
by an earlier run. That location is read in the background after a start and applied from the next
start, so the coordinates never change while the add-on runs.

#### NWS NDFD (opt-in — cloud ensemble)

Off by default; `NWS_ENABLED=1` (or `true`). US-only. NWS does not expose
shortwave radiation, so it contributes **only cloud cover** to an ensemble:

```
h.cloudCoverPct = (openMeteoCloud + nwsCloud) / 2       // ensemble mean
h.ensembleSources = 2
h.ensembleDisagreementPct = round(|openMeteoCloud − nwsCloud|)
```

The per-hour disagreement is a direct uncertainty signal folded into the
probabilistic band's `disagreementFrac`. NWS uses `api.weather.gov/points/{lat},{lon}`
→ `gridpoints/{office}/{x},{y}`. Failure degrades gracefully to Open-Meteo only.

`GET /api/weather/ensemble` returns the forecast with ensemble metadata and
persists GHI/cloud rows to the recorder.

---

### 9. Config knobs (env / config.yaml)

"Set as" says how a knob is reached. **Add-on** is an option on the add-on's Configuration tab
(the run script exports it; an optional key with no default is exported only when set).
**Env-only** is an environment variable the add-on never exports, so on a Home Assistant install
it always holds its default; only a standalone run can set it.

| Env var | Set as | Default | Effect |
|---|---|---|---|
| `PEAK_RESPONSE_MIN_GHI_WM2` | env-only | 300 | brightness floor for `peakCoeff` headline |
| `RUNWAY_DISCHARGE_EFFICIENCY` | env-only | 0.94 (clamp 0.80–1.0) | η in DC-bus SoC balance `load/η` |
| `DISPATCH_ROUND_TRIP_EFFICIENCY` | env-only | 0.86 (clamp 0.80–1.0) | v1.194.0 — its square root (0.927) is the charge leg `η_c` a surplus hour is stored at, in the day and multi-day SoC walks and the band (and the runway) |
| `RUNWAY_POOL_OVERHEAD_FLOOR_W` | add-on (optional) | 270 (clamp 0–1500) | v1.187.19 — the pool overhead added to `load/η` never falls below this while the panel reports a pool (§5.1.3a); the reference plant's figure, fitted on three Cores |
| `RUNWAY_CORE_OVERHEAD_W` | add-on (optional) | 90 (clamp 0–500) | v1.187.19 — × connected Cores; raises the overhead above the floor for a pool of more than three Cores (§5.1.3a) |
| `RUNWAY_DRAIN_MARGINAL_EFFICIENCY` | env-only | 0.94 (clamp 0.80–1.0) | v1.187.19 — η_m in `overheadW + load/η_m`; the `max()` keeps the drain ≥ `load/η` |
| `INCOMPLETE_FORECAST_TTL_MS` | env-only | 150000 | negative-cache TTL for incomplete forecast |
| `FORECAST_RECENT_LOAD_WINDOW_MS` | env-only | 3 h | recent-load trailing window |
| `FORECAST_NIGHT_START_HOUR` | add-on (optional) | 21 | night-band start, site time |
| `FORECAST_NIGHT_END_HOUR` | add-on (optional) | 5 | night-band end, site time |
| `FORECAST_NIGHT_OVERPREDICT_RATIO` | env-only | 1.5 | night-trim trigger ratio |
| `FORECAST_NIGHT_BLEND` | env-only | 0.6 | night-trim blend weight |
| `FORECAST_NIGHT_MAX_TRIM` | env-only | 0.5 | night-trim floor cap |
| `PROB_LOAD_SIGMA_FRAC` | env-only | 0.15 | load-side 1σ fraction in the ensemble |
| `PV_BAND_SIGMA_CAL` | env-only | (auto) | manual band-cal override, clamp 0.1–2 |
| `NWS_ENABLED` | add-on | off | enable NWS cloud ensemble |
| `FORECAST_LAT` / `FORECAST_LON` | add-on | 33.4484 / -112.074 (a placeholder) | weather location |
| `SITE_LOCATION_FROM_HA` | add-on (optional) | off | weather location from Home Assistant's home, applied from the next start |
| `SITE_TIMEZONE` | add-on (optional) | the container's `TZ`, else `America/Phoenix` | zone of every hour-of-day slot, weekday and site day; resolved once at start |
| `EV_MAX_LOAD_W` / `EV_CHARGER_COUNT` | add-on (optional) | 11520 / 1 | per-charger cap and charger count for the predicted EV load (Inputs above) |

No `PV_*` option reaches the forecast: the array enters only through its recorded PV. The `PV_*`
options describe the array to the clear-sky physics model and the Bayesian noise scale (chapter 4)
and to the Solar page (`/api/site`).

Hard-coded (non-env) constants: `DAYLIGHT_GHI=20`, `MIN_RESPONSE_PAIRS=2`,
`HOUR_CURVE_BUCKET_SEC=300`, `TYPICAL_HISTORY_MS=30d`, `WEEKDAY_MIN_SAMPLES=24`,
`RUNWAY_BLEND_HOURS=4`, `SOLAR_FIT_MIN_FULL_COVERAGE_HOURS=72`,
`PV_COVERAGE_MIN_FRAC=0.8`, `PV_BIAS_CLAMP_LO/HI=0.5/1.2`,
`PV_BIAS_MIN_MATURE_DAYS=3`, `Z10=1.282`, `PV_BAND_CAL_MIN_DAYS=14`,
`PV_BAND_CAL_FLOOR=0.4`, `PACK_KWH_NAMEPLATE=6.144`, `PACKS_PER_DPU=5`,
`FORECAST_DAY_TTL_MS=30m`, `FORECAST_SKILL_TTL_MS=1h` and `PROB_TTL_MS=15m` (both bound to the forecast's `generatedAt` since v1.186.5),
`MULTI_DAY_TTL_MS=30m`, weather `TTL_MS=2h`.

---

### 10. Edge cases, guards, and honest-null behavior

- **Insufficient data → `coeff = null`, not a fabricated slope.** An hour with
  <2 daylight pairs is honestly unmodelled; `forecastHourPvW` then falls back to
  the typical-day curve × cloud derate.
- **Within-slot r² is degenerate by design** in a low-variance climate and gates
  nothing. `forecastDayR2` (day-level replay) is the honest confidence headline;
  needs ≥5 scored days else null.
- **Missing telemetry ≠ darkness** — the pervasive guard. Bias correction, skill
  scoring, and the fleet fit all EXCLUDE days/hours where a wired Core reported
  <80% of daylight hours (`coreCoverageByDay`, `fullCoverageFleetPv`), and mark
  their `errorPct`/`coverageGap` rather than scoring a phantom over-forecast. Since
  v1.196.0 the skill hindcast applies the same all-Cores rule as the bias factor
  (no exemption until a Core's first reading); which Cores a day is measured on
  comes from the membership record, not from the telemetry being checked. Since v1.188.1 the
  recorder writes no rows for a device whose readings are held (`projectionRecordable` in
  heldSamples.ts) and moves held stretches already written to `held_samples`, so a cloud-dark
  Core is a gap these gates see, not its last reading restated as new.
- **PV bias factor is a no-op (1.0) until mature** (≥3 mature covered days) and
  clamped `[0.5, 1.2]`; deflation is unclamped-safe, inflation is re-clamped to
  the physical ceiling.
- **Structural incompleteness** is surfaced (`structurallyIncomplete`) and
  short-negative-cached; the SoC/floor alarms read the live snapshot's
  `backupBatPercent`, not the forecast, so caching an incomplete forecast is
  alarm-neutral.
- **Empty/cold load curve is never cached long** (v0.15.21 / v0.57.0 / v0.73.0
  gate on input spans, never output values — a real zero-PV night still caches).
- **P90 clamped to the physical array ceiling** (`pvCeilingW`); P10 floored at 0.
- **Coherent ensemble compounds uncertainty**; a NaN/non-finite hour skips the
  step (state carries, band recovers) and nulls the safety-facing min/max
  summaries rather than scoring only the clean prefix.
- **Multi-day radiation climatology** prevents PV collapsing to 0 (phantom
  depletion panic) for hours past the end of Open-Meteo's cached forecast
  (`forecast_days=4` UTC days since v1.35.0).
- **Fleet soiling** uses the per-Core median drop (`fleetSoilingFromDevices`),
  immune to the fleet-sum coverage-deflation artifact that once produced a false
  ~35% soiling alarm; null until ≥2 home Cores each have a valid per-Core estimate (≥6 clear days of ≥3 clear
  hours each); well-covered (`recentCovered`) Cores are preferred, and all valid estimates
  are pooled only when fewer than two are well-covered.


---

