## 4. Physics-Based & Bayesian Model Tier

> **Track C (physics-informed hybrid) + Track D (hierarchical Bayes).** A set of
> *first-principles* models that run **alongside** the learned engines (the OLS
> solar-response model and the Kalman SoH filter). They exist to give the panel a
> ground-truth yardstick the learned engines can be scored against: "what does
> physics say *should* be happening right now?" When the learned model and the
> physics model disagree, that disagreement is itself a signal — mis-tuned
> forecast, BMS SoH miscalibration, a drifting cell, or a soiled array.

This tier is composed of four independent modules, each exposed as its own
read-only endpoint:

| Module | File | Endpoint | Purpose |
| --- | --- | --- | --- |
| Clear-sky PV ceiling | `server/src/physics/clearSky.ts` | `/api/physics/pv-pmax` | Theoretical max PV for the site + time; realized/ideal score |
| LFP OCV → SoC | `server/src/physics/lfpOcv.ts` + `physics/restTracker.ts` | `/api/physics/lfp-soc` | Physics SoC from rested pack voltage vs BMS-reported SoC |
| Hierarchical pack SoH | `server/src/models/hierarchicalBayes.ts` | `/api/models/hierarchical-pack-soh` | Partial-pooled per-pack SoH + 2σ outlier flags |
| Recursive Bayesian solar | `computeBayesianSolarModel` in `server/src/analytics.ts` | `/api/forecast/bayesian` | Bayesian GHI→PV response posterior, cross-checked vs OLS |

All four are **honest-null** by design: they emit `null` / empty rather than a
fabricated number whenever their preconditions aren't met (sun below horizon,
pack not rested, no observations, no weather).

---

### 1. Clear-Sky PV Physical Model (`clearSky.ts`)

#### WHAT + why

Computes the **theoretical maximum PV output** for a specific site and instant,
assuming a cloudless sky and applying cell-temperature derating. The realized
fleet PV is then divided by this ceiling to produce a **physics score** — the
fraction of "physics-max" the array is actually making right now.

The value of this is *normalization*: "we're making 12.8 kW today" is
uninterpretable (depends on time of day, season, weather). "We're making 90% of
what clear-sky physics says is possible at this exact moment" is directly
interpretable and comparable across days, and it is the reference the Bayesian /
cloud-aware forecast should predict close to. If the forecast diverges from the
realized physics fraction, the forecast is mis-tuned.

#### INPUTS

- `ts` — the instant (epoch ms), taken as `Date.now()` at the endpoint.
- `ambientC` — ambient air temperature (°C). The endpoint currently passes a
  **placeholder constant `30`** (`// °C — placeholder; real call would use weather.ts`).
- `site: SiteParams` — defaults to `PHOENIX_SITE` (the operator's plant).
- `realizedW` — summed live `pvTotalWatts` across online DPUs (endpoint side).

#### PHOENIX_SITE constants (the real, in-code values)

```
PHOENIX_SITE = {
  lat:        33.4484,        // Phoenix, AZ
  lon:       -112.074,
  pNamplate:  16_800 W,       // 42 panels × 400 W = 16.8 kWp nameplate
  tilt:       25°,            // roof mount, approximate
  azimuth:    180°,           // due south
  noct:       45 °C,          // Nominal Operating Cell Temperature
  tempCoeff: -0.0035 /°C,     // Pmax temp coefficient, crystalline silicon
  derate:     0.85,           // wiring + inverter + soiling-clean baseline
}
```

Global constant: `DEG = Math.PI / 180`.

#### THE CALCULATION (step by step)

The pipeline is a 5-stage physical chain. `physicsPmax(ts, ambientC, site)`:

**Step 1 — Solar position (Spencer 1971).** `solarPosition(d, lat, lon)`:

- Day-of-year `doy(d)` and the seasonal angle `B = 2π·(doy − 1) / 365`.
- **Equation of time** (minutes), Spencer Fourier series:

  ```
  EoT = 229.18 · (0.000075 + 0.001868·cosB − 0.032077·sinB
                  − 0.014615·cos2B − 0.040849·sin2B)
  ```

- **Declination** (degrees), Spencer series:

  ```
  δ = (180/π) · (0.006918 − 0.399912·cosB + 0.070257·sinB
                 − 0.006758·cos2B + 0.000907·sin2B
                 − 0.002697·cos3B + 0.001480·sin3B)
  ```

- **Hour angle**: true solar time `tst = utcMin + 4·lon + EoT`, then
  `ha = tst/4 − 180` (degrees; negative before noon).
- **Zenith / elevation**:

  ```
  cos(z) = sin(lat)·sin(δ) + cos(lat)·cos(δ)·cos(ha)
  elevation = 90 − acos(clamp(cos z, −1, 1))·(180/π)
  cosZenith = max(cos z, 0)          // 0 if sun below horizon
  ```

- Azimuth via the standard `atan2(sinA, cosA)` formula (from north, clockwise).

**Step 2 — Clear-sky GHI (Haurwitz model).** `clearSkyGHI(cosZenith)`:

```
GHI = 0                                    if cosZenith ≤ 0  (night)
GHI = 1098 · cosZenith · exp(−0.057 / cosZenith)   [W/m²]
```

Constants `1098` and `0.057` are the canonical Haurwitz coefficients — a simple,
fast model that is documented in-code as **±10%** of more sophisticated models,
which is fine for a scoring baseline.

**Step 3 — Plane-of-array (POA) irradiance.**
`plantOfArrayIrradiance(ghi, elev, azimuth, tilt, panelAzimuth)`:

```
cosθ  = sin(elev)·cos(tilt) + cos(elev)·sin(tilt)·cos(sunAz − panelAz)
cosZ  = sin(elev)
POA   = ghi · (cosθ / cosZ)
```

Guards: returns `0` if `ghi ≤ 0`, `elev ≤ 0`, `cosθ ≤ 0` (sun behind panel), or
`cosZ < 0.05` (horizon clipping, avoids divide-by-near-zero blowup).

**Step 4 — Cell temperature (NOCT estimator).** `cellTemp(ambientC, poa, noct)`:

```
T_cell = T_amb + ((NOCT − 20) / 800) · POA        [°C]
```

**Step 5 — Pmax.** With `tempFactor = 1 + tempCoeff·(T_cell − 25)`:

```
Pmax = max(0, pNamplate · derate · (POA / 1000) · tempFactor)   [W]
```

POA is normalized to STC irradiance (1000 W/m²); `tempFactor` derates for cells
hotter than 25 °C at the `−0.0035/°C` coefficient.

#### The physics score

`physicsScore(realizedW, theoreticalW)`:

```
null                             if theoreticalW ≤ 0   (night / no ceiling)
clamp(realizedW / theoreticalW, 0, 1)   otherwise
```

`1.0` = clear sky, no soiling, no shade. `< 1.0` = cloud, dust, dirt, or shade.

#### TRACE (inputs → outputs)

- **In:** `realizedW = Σ (d.projection.pvTotalWatts)` over `onlineDpus(...)`;
  `ambient = 30` (placeholder); `ts = Date.now()`.
- **Compute:** `physicsPmax(ts, ambient, PHOENIX_SITE)` → `physicsScore(...)`.
- **Out:** HTTP `GET /api/physics/pv-pmax`, cached 30 s.

#### OUTPUT shape (`/api/physics/pv-pmax`)

```jsonc
{
  "ts": 1752607200000,
  "pMaxW": 14210.5,          // theoretical clear-sky ceiling
  "poaIrradiance": 905.2,    // W/m²
  "ghi": 870.1,              // W/m² Haurwitz
  "cellTempC": 51.3,
  "solarElevation": 71.2,    // degrees
  "notes": "clear-sky",      // 'night' | 'sun-not-on-panel' | 'clear-sky'
  "realizedW": 12800,        // summed live fleet PV
  "score": 0.90              // realized / theoretical (null at night)
}
```

#### CONFIG knobs + defaults

There are **no environment-variable knobs** for this module. Site parameters are
the compile-time `PHOENIX_SITE` constant; `SiteParams` can be overridden at the
call site if the add-on is ever shipped to another operator. The ambient
temperature is a hardcoded `30 °C` placeholder in the endpoint.

#### EDGE CASES / guards / honest-null

- **Night / sun below horizon** → `cosZenith = 0` → `ghi = 0` → `poa = 0` →
  `pMaxW = 0`, `notes = 'night'`, and `physicsScore` returns **`null`** (no
  ceiling to score against).
- **Sun behind the panel plane** (`cosθ ≤ 0`) → `poa = 0`, `notes = 'sun-not-on-panel'`.
- **Horizon clipping** (`cosZ < 0.05`) → POA forced to 0 to avoid the
  `cosθ/cosZ` singularity near sunrise/sunset.
- **`acos` domain safety** via `clamp(cosZ, −1, 1)`.
- Ambient is a placeholder — cell-temp derate is approximate until `weather.ts`
  is wired in.

---

### 2. LFP Open-Circuit-Voltage → SoC (`lfpOcv.ts` + `restTracker.ts`)

#### WHAT + why

The Delta Pro Ultra packs are **LFP** (lithium iron phosphate) chemistry, whose
discharge curve is famously **flat**. Flatness makes SoC-from-voltage hard in
general — but it also makes small deviations from the canonical curve
*diagnostic*. Two signals fall out:

1. **OCV-vs-reported-SoC mismatch** — physics-implied SoC (from rested voltage)
   drifting from BMS-reported SoC → SoH miscalibration in the BMS.
2. **Cell drift** — one cell's voltage diverging from siblings → imbalance /
   per-cell capacity fade.

Crucially, OCV → SoC is only valid at **rest**: under load the IR drop adds
50–200 mV, so a rested estimate requires the pack to have been idle long enough
for the terminal voltage to settle to true OCV. That gating is the whole reason
`restTracker.ts` exists.

#### INPUTS (`LfpAnalysisInputs`)

- `packVoltageMv` — pack terminal voltage (mV). Endpoint uses
  `pk.packVoltageMv ?? pk.adBatVoltageMv ?? null`.
- `reportedSoCPct` — BMS SoC (`pk.soc`).
- `cellVoltagesMv[]` — per-cell voltages (`pk.cellVoltagesMv`).
- `packCurrentA` — derived, not measured (see below).
- `lastNonRestingAtMs` — from the rest tracker, keyed on pack serial.
- `nowMs` — defaults to `Date.now()`.

#### The OCV lookup table (real values)

21 points, single-cell OCV at 25 °C, rested, in 5% SoC increments
(`LFP_OCV_TABLE_25C`). Notice the extreme flatness across the midrange:

| SoC% | V/cell | SoC% | V/cell | SoC% | V/cell |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0  | 2.50 | 35 | 3.29 | 70 | 3.33 |
| 5  | 3.15 | 40 | 3.30 | 75 | 3.33 |
| 10 | 3.20 | 45 | 3.30 | 80 | 3.34 |
| 15 | 3.22 | 50 | 3.31 | 85 | 3.35 |
| 20 | 3.25 | 55 | 3.31 | 90 | 3.36 |
| 25 | 3.27 | 60 | 3.32 | 95 | 3.40 |
| 30 | 3.28 | 65 | 3.32 | 100 | 3.55 |

Key constants:

```
CELLS_IN_SERIES            = 32     // DPU pack is 32S1P (~102.4 V nominal = 32 × 3.2 V)
RESTING_CURRENT_THRESHOLD_A = 0.5   // |I| ≤ 0.5 A = electrically at rest
RESTING_AGE_MIN_MS          = 10 min // OCV must have settled this long
```

#### THE CALCULATION

**Voltage → SoC (`socFromOcv`).** Pack voltage is divided by 32 to get per-cell,
then bracketed in the table and **linearly interpolated**:

```
frac = (v_cell − v1) / (v2 − v1)
soc  = soc1 + frac · (soc2 − soc1)
```

Clamped: `v_cell ≤ 2.50 → 0`; `v_cell ≥ 3.55 → 100`.

**The plateau-midpoint fix (v1.3.1, audit rank 51).** The flat midrange holds
one voltage across two SoC points (e.g. 3.30 V at both 40% and 45%). A cell
sitting exactly on a plateau matches the *rising* bracket into it first
(`[35, 3.29] → [40, 3.30]`), whose endpoints differ, so it silently returned
`frac = 1` → the plateau's **low** end, biasing `socDriftPct` low by up to 5
points. The fix: when `v_cell === v2`, walk forward over the full run of table
entries sharing that voltage and return the **midpoint** of the ambiguity band:

```
if v_cell === v2:
    extend `last` while table[last+1].v === v2
    if last > i:  return (soc2 + table[last].soc) / 2   // honest centre
```

The `if (v2 === v1) return (soc1+soc2)/2` guard is retained only for a
hypothetical descending table; it is unreachable with the current ascending
table (documented in-code).

**Rest gating (`analyzePackLfp`).**

```
lowCurrent      = packCurrentA != null && |packCurrentA| ≤ 0.5 A
idleLongEnough  = lastNonRestingAtMs != null && (now − lastNonRestingAtMs) ≥ 10 min
isResting       = lowCurrent && idleLongEnough

physicsSoCPct   = isResting && packVoltageMv != null
                    ? socFromOcv(packVoltageMv / 1000)
                    : null
socDriftPct     = (physicsSoCPct != null && reportedSoCPct != null)
                    ? physicsSoCPct − reportedSoCPct     // + = BMS under-reports
                    : null
```

**Cell spread + deviations** (always computed, no rest needed): sort cell
voltages, `cellSpreadMv = max − min`, `cellDeviationsMv[i] = v[i] − median`.

**Confidence (0..1):**

```
+0.5  if isResting
+0.3  if we have ≥ CELLS_IN_SERIES/2 (=16) cell deviations
+0.2  if packVoltageMv != null
confidence = min(1, sum)
```

#### The rest tracker (`restTracker.ts`) — why it exists

`analyzePackLfp` needs `lastNonRestingAtMs`, but nothing produced it — the
endpoint used to hardcode `null`, so `isResting` was false on **every one of the
15 live packs forever**, and `physicsSoCPct` was permanently null. `restTracker.ts`
supplies that timestamp:

- **`packCurrentAmps(outputWatts, inputWatts, packVoltageMv)`** — derives current
  from power, because the projection has no direct current field:

  ```
  netW = (outputWatts ?? 0) − (inputWatts ?? 0)     // + = discharging
  A    = netW / (packVoltageMv / 1000)
  ```

  Returns `null` if `packVoltageMv` is null/≤0 or both power fields are null.

- **`observePackRest(packKey, packCurrentA, nowMs)`** — called every poll. A pack
  is "moving" if `packCurrentA == null` (unreadable current is **not** evidence
  of stillness) **or** `|I| > 0.5 A`. It sets `lastNonRestingAt[packKey] = now`
  on every moving observation **and on first sight** (the seeding rule).
- **`packRestKey(dpuSn, pack)`** — keys on the pack hardware serial
  (`pack:<packSn>`), falling back to `slot:<dpuSn>:<num>`, so rest history
  survives pack renumbering / DPU reordering.
- **`retainPacks(keys)`** — drops packs no longer present so a removed / re-serialled
  pack cannot pin memory.

**The seeding rule (deliberately conservative).** On first sight the tracker
does *not* know how long the pack has already been idle — rest may have begun
before the add-on started. It seeds `lastNonRestingAt = now`, forcing a full
freshly-observed 10 minutes of rest before it will claim `isResting`. This
**under-claims** rest rather than fabricating an OCV SoC from an unverified
assumption — the same "emit null over a fabricated number" rule the panel
applies everywhere.

#### TRACE

- **Poll loop** (`restTrackerTick` in `index.ts`, every `POLL_INTERVAL_MS`; the tick is skipped while host pressure is critical, `degradedMode()`):
  for every online DPU pack, `observePackRest(packRestKey(d.sn, pk),
  packCurrentAmps(pk.outputWatts, pk.inputWatts, pk.packVoltageMv ?? pk.adBatVoltageMv), now)`,
  then `retainPacks(keys)`.
- **Endpoint** (`/api/physics/lfp-soc` in `index.ts`): for every online DPU
  pack, build `LfpAnalysisInputs` (voltage, reported SoC, cell voltages, derived
  current, and `lastNonRestingAtMs(packRestKey(...))`) → `analyzePackLfp(...)`.
- **Out:** cached 30 s.

#### OUTPUT shape (`/api/physics/lfp-soc`)

```jsonc
{
  "packs": [
    {
      "device": "Core 1",
      "packNum": 2,
      "analysis": {
        "physicsSoCPct": 62.5,     // null unless resting
        "reportedSoCPct": 61,
        "socDriftPct": 1.5,        // + = BMS under-reports
        "isResting": true,
        "packVoltageMv": 104425,
        "cellSpreadMv": 18,
        "cellDeviationsMv": [ -3, 2, ... ],
        "confidence": 1.0,
        "notes": [ ... ]
      }
    }
  ],
  "generatedAt": 1752607200000
}
```

#### EDGE CASES / guards / honest-null

- **Pack not rested** → `physicsSoCPct = null`, `socDriftPct = null`; only the
  cell-spread signals remain.
- **Current unreadable** (`packCurrentA == null`) → note "pack current not
  reported — cannot confirm rest" (v0.95.0 re-audit #12 fixed a prior bug that
  printed a bogus "current undefined A > 0.5 A threshold"). Counts as non-resting.
- **Plateau ambiguity** → midpoint of the shared-voltage run (v1.3.1), never the
  low end.
- **No cell readings** → note "no per-cell voltage readings available",
  `cellSpreadMv`/`cellDeviationsMv` null.
- **Non-finite voltage** → `socFromOcv` returns null.

---

### 3. Hierarchical Bayesian Pack SoH (`models/hierarchicalBayes.ts`)

#### WHAT + why

Each DPU carries up to 5 packs, and the fit takes every pack of every online DPU that
reports a SoH (spares included). Estimating each pack's SoH **in
isolation** is noisy; **fully pooling** them gives a precise fleet mean but
erases individual signal. The right answer is **partial pooling** — every pack
"borrows strength" from its siblings, drifting toward the group mean when its own
measurement is noisy but standing its ground when its measurement is tight. This
is exactly what catches a genuinely-failing pack without chasing measurement
noise, and it feeds a principled **2σ outlier** flag.

#### The model

A closed-form **three-level Gaussian** (no MCMC):

```
y_pack  ~ Normal(μ_dpu,   σ²_pack)      one observation per pack
μ_dpu   ~ Normal(μ_fleet, σ²_dpu)       DPU-level prior
μ_fleet ~ Normal(μ_global,σ²_fleet)     fleet-level prior
```

Conjugate Gaussian precision-weighted mean (applied up the levels):

```
posterior_mean = (prior_mean · prior_precision + y · obs_precision)
               / (prior_precision + obs_precision)
```

#### INPUTS (`HBPackObs[]`)

- `packKey` = `<dpu-sn>:<pack-num>`, `dpuKey` = `<dpu-sn>`.
- `value` — the pack's SoH observation (`pk.actSoh ?? pk.soh`).
- `obsSigma` — per-observation 1σ. The endpoint derives it from cycle count so
  that **newer packs are treated as noisier**:

  ```
  sigma = max(0.3, 3.0 − min(2.5, cycles / 500))
  ```

  A 0-cycle pack → σ = 3.0; a ≥1250-cycle pack → σ = 0.5. The outer
  `max(0.3, …)` never binds, because `min(2.5, …)` already stops σ at 0.5. Packs with `actSoh == null && soh == null` are skipped.

#### THE CALCULATION (`fitHierarchical`)

1. **Group** observations by DPU.

2. **Within-DPU σ (empirical, winsorized).** Collect squared deviations of each
   pack from its DPU mean, but **10%-winsorize** them: sort, cap the top 10% at
   the 90th-percentile value, then

   ```
   σ_withinDpu = sqrt( trimmedSum / N )
   ```

   Winsorization is load-bearing: without it a single large outlier *inflates* σ,
   which then *suppresses* the very shrinkage that should catch it. The in-code
   example: one 25-point outlier in 25 obs → naïve σ ≈ 4.5 → shrinkage ≈ 4%
   (outlier ignored); winsorized σ ≈ 2.2 → shrinkage ≈ 16% (outlier meaningfully
   pulled toward its DPU mean).

3. **DPU raw means** (simple average) and **between-DPU σ**:

   ```
   σ_withinFleet = sqrt( Σ(dpuMean − fleetMean)² / nDpu )
   ```

   `fleetMean` is the plain empirical average of DPU means (uninformative top prior).

4. **Posterior DPU means** — shrink each DPU mean toward the fleet mean:

   ```
   likPrec  = n / σ_withinDpu²          (n = packs in the DPU)
   priorPrec = 1 / σ_withinFleet²
   μ_dpu_post = (likPrec·dpuRaw + priorPrec·fleetMean) / (likPrec + priorPrec)
   ```

5. **Posterior pack means** — shrink each pack toward its DPU posterior mean:

   ```
   likPrec   = 1 / max(1e-3, obsSigma)²
   priorPrec = 1 / σ_withinDpu²
   μ_pack_post = (likPrec·value + priorPrec·μ_dpu_post) / (likPrec + priorPrec)
   σ_pack_post = 1 / sqrt(likPrec + priorPrec)
   shrinkageToDpu = clamp( (value − μ_pack_post) / (value − μ_dpu_post), 0, 1 )
   ```

   `shrinkageToDpu` = 0 (pack unchanged, trusted its own data) … 1 (fully pulled
   to the DPU mean).

#### Outlier rule (`findOutliers(fit, zThreshold = 2.0)`)

A pack is an outlier when its **posterior** sits ≥ z·σ_withinDpu from its DPU
posterior mean:

```
z = |μ_pack_post − μ_dpu_post| / max(1e-9, σ_withinDpu)
outlier  ⇔  z ≥ 2.0
```

Because shrinkage already pulls noisy packs inward, a pack that *stays* far out
after shrinkage is one whose own (tight) data genuinely disagrees with its
siblings — the exact thing worth flagging.

#### TRACE

- **In:** `/api/models/hierarchical-pack-soh` (in `index.ts`) iterates online
  DPU packs, building `HBPackObs` from `actSoh/soh` + cycle-derived σ.
- **Compute:** `fitHierarchical(obs)` → `findOutliers(fit, 2.0)`.
- **Out:** cached **300 s**.

#### OUTPUT shape (`/api/models/hierarchical-pack-soh`)

```jsonc
{
  "generatedAt": 1752607200000,
  "metric": "pack_soh_pct",
  "packs": [
    {
      "packKey": "XXX0015:1", "dpuKey": "XXX0015",
      "rawValue": 98.0, "rawSigma": 3.0,
      "posteriorMean": 97.4, "posteriorSigma": 1.2,
      "shrinkageToDpu": 0.31
    }
  ],
  "dpuMeans": { "XXX0015": 97.6, "XXX0002": 98.1 },
  "fleetMean": 97.8,
  "sigmaWithinDpu": 1.1,
  "sigmaWithinFleet": 0.4,
  "outlierPackKeys": [ "XXX0002:4" ]
}
```

#### CONFIG knobs + defaults

No env knobs. The z-threshold is a call-time argument (`2.0` at the endpoint);
the per-obs σ formula (`max(0.3, 3.0 − min(2.5, cycles/500))`) and the 10%
winsorization fraction are compile-time.

#### EDGE CASES / guards / honest-null

- **No observations** → empty fit (`packs: []`, `fleetMean: 0`, σ's 0).
- **No DPU with ≥2 packs** → `σ_withinDpu` falls back to `1`; **a single DPU** →
  `σ_withinFleet` falls back to `1` (a spread cannot be estimated from one point). A
  single-pack DPU alongside multi-pack DPUs simply contributes no squared deviation to
  `σ_withinDpu`.
- **σ = 0 observation** → clamped to a 1e-3 floor (avoids infinite precision
  pinning), and all precisions floor divisors at `1e-9`.
- **Null SoH packs skipped**, never fabricated to 0.

---

### 4. Recursive Bayesian Solar Model (`computeBayesianSolarModel`)

#### WHAT + why

A **recursive Bayesian** estimate of the array's GHI→PV response coefficient β
(watts of PV per W/m² of irradiance), maintained **per hour-of-day**. It answers
the same question as the learned OLS solar-response model, but with a full
posterior (mean + variance + 95% CI) instead of a point slope — and it
explicitly reports how often it **agrees with OLS**, so a divergence between the
two is a visible signal that one of them is mis-fit.

#### The prior and the observation model

Per hour-of-day slot, the coefficient β is `Normal(μ, τ²)`, seeded with a
deliberately vague prior so the first observations dominate:

```
BAYES_PRIOR_MU   = 0        // "no clue"
BAYES_PRIOR_TAU2 = 1000     // huge prior variance → first obs dominates
```

Each daylight hour contributes one observation: measured PV `p` at irradiance
`g` (GHI). The observation model is `p ≈ β·g` with Gaussian noise σ². The
observation noise is pinned to the **signal scale** (10% of nameplate), which is
the whole reason the filter behaves like a filter:

```
BAYES_OBS_SIGMA2 = (0.10 · PHOENIX_SITE.pNamplate)²
                 = (0.10 · 16 800)² = 1 680² ≈ 2.82e6      (σ ≈ 1 680 W)
```

The in-code note (v0.9.59) explains why: the original placeholder σ² = 50 (σ ≈ 7 W)
made every single observation's information weight `g²/σ²` swamp the prior in one
update — e.g. at GHI 500, `500²/50 = 5000` — collapsing the posterior onto the
latest sample and defeating the point of a recursive filter. At σ² ≈ 2.82e6 the
same update contributes precision `500²/2.82e6 ≈ 0.089`, so the prior
(`1/1000 = 0.001`) is overwritten over *dozens* of observations, not one.

#### THE CALCULATION

**The recursive update (`bayesUpdate`)** — conjugate Gaussian precision update
for the through-origin regression coefficient:

```
newPrecision = 1/τ² + g²/σ²
newTau2      = 1 / newPrecision
newMu        = newTau2 · ( μ/τ² + (g·p)/σ² )
```

(The `g²` weighting is the linear-model twist: a high-irradiance observation is
more informative about the *slope* β than a low-irradiance one.)

**`computeBayesianSolarModel(devices, recorder)`:**

1. Pull the live weather cache (`getWeather()`) and build `wxByHourEpoch`, keyed by the
   recorder hour each value COVERS: provider label − 1 h (`RADIATION_LABEL_LAG_HOURS = 1`,
   v1.186.2), because Open-Meteo's hourly `shortwave_radiation` is the average of the
   preceding hour. Curtailment pairs hours the same way. Return empty if there are no DPUs
   or no weather.
2. Build **fleet PV per hour-epoch** from the recorder, summed over the
   **home-connected DPUs only** (`homeConnectedDpus`) — a spare's bench-charge PV
   would bias the prior away from what the connected arrays actually produce (v0.9.76).
3. Initialize 24 hour-of-day slots at the prior `(μ=0, τ²=1000)`.
4. Walk observations in **time order**; for each, skip if no weather or
   `GHI < DAYLIGHT_GHI` (20 W/m²); else fold in with `bayesUpdate` into that
   slot, incrementing `samples`.
5. For each hour with `samples ≥ 2`, emit the posterior: `stdev = sqrt(τ²)`,
   `ci95 = μ ± 1.96·stdev`.
6. **Cross-check vs OLS**: build the OLS response over the same history
   (`buildSolarResponse`) and count a slot as "agreeing" when
   `|olsCoeff − μ| ≤ stdev`; report the fraction.

#### THE CALCULATION — history + cache constants

```
BAYES_HISTORY_MS = 60 days
BAYES_TTL_MS     = 30 min           // in-process cache
DAYLIGHT_GHI     = 20 W/m²          // shared night gate
```

#### TRACE

- **In:** recorder PV history (`pv_total` per home DPU, 60-day query) + GHI from the
  live weather cache only (`getWeather()`, `past_days=7`; the recorder's GHI series is not
  read), so the posterior, recomputed from the prior on each build, folds in at most the
  ~7 past days the cache covers.
- **Compute:** `computeBayesianSolarModel` (registered as the `bayesianSolar`
  report in `reports.ts`: `bayesianSolar: (ctx) => computeBayesianSolarModel(...)`).
- **Out:** `GET /api/forecast/bayesian` → `analytics.report('bayesianSolar')`,
  HTTP-cached 60 s (module-level cache 30 min). Also consumed internally by the
  curtailment report (`computeCurtailment` in `analytics.ts`) to derive `pvExpectedW` /
  `bayesianSamples`.

#### OUTPUT shape (`/api/forecast/bayesian`)

```jsonc
{
  "generatedAt": 1752607200000,
  "hourly": [
    {
      "hour": 12,
      "posteriorMean": 26.4,     // μ — W of PV per W/m² of GHI
      "posteriorStdev": 3.1,     // sqrt(τ²)
      "ci95Low": 20.3,           // μ − 1.96τ
      "ci95High": 32.5,          // μ + 1.96τ
      "samples": 47
    }
  ],
  "totalSamples": 512,
  "medianStdev": 3.4,
  "agreementWithOls": 0.83       // fraction of hours within 1σ of OLS coeff
}
```

#### CONFIG knobs + defaults

No env knobs; all five `BAYES_*` constants (`BAYES_TTL_MS`, `BAYES_HISTORY_MS`,
`BAYES_PRIOR_MU`, `BAYES_PRIOR_TAU2`, `BAYES_OBS_SIGMA2`) and `DAYLIGHT_GHI` are
compile-time.
`BAYES_OBS_SIGMA2` is *derived* from `PHOENIX_SITE.pNamplate`, so it automatically
tracks the site nameplate.

#### EDGE CASES / guards / honest-null

- **No DPUs / no weather** → `empty()` (empty `hourly`, zero aggregates).
- **Hours with `< 2` samples** are omitted entirely — no low-confidence slot is
  published.
- **Night / near-night** (`GHI < 20`) observations are dropped.
- **`agreementWithOls`** is 0 when no OLS coefficient exists to compare against
  (`agreementDenom = 0`), not a fabricated value.

---

### 5. How the physics/Bayesian tier cross-checks the learned engines

The physics tier is not a replacement for the learned engines — it is their
**referee**. The relationships:

| Physics / Bayesian model | Learned counterpart | Cross-check |
| --- | --- | --- |
| Clear-sky `physicsScore` (realized / clear-sky max) | Cloud-aware / probabilistic PV **forecast** | The forecast's predicted PV fraction *should* track the realized physics fraction; a persistent gap means the forecast is mis-tuned (as documented in `clearSky.ts`). |
| Bayesian GHI→PV posterior (`bayesianSolar`) | **OLS** solar-response (`buildSolarResponse`, through-origin `Σ(pv·ghi)/Σ(ghi²)`) | `agreementWithOls` = fraction of hours whose OLS slope lies within 1σ of the Bayesian μ. Low agreement flags a modeling problem in one of them; the Bayesian version adds calibrated uncertainty the OLS point slope lacks. |
| LFP OCV physics SoC (`socDriftPct`) | **BMS-reported SoC** / Kalman SoH filter | A rested physics SoC that persistently disagrees with reported SoC (`socDriftPct ≠ 0`) points at BMS SoH miscalibration — the same fade the Kalman filter (`kalmanFilterSoh`, 2-state constant-velocity, `R = 0.05`) tracks from a different angle (reported-SoH time series). |
| Hierarchical Bayes pack SoH (partial pooling + 2σ outliers) | **Kalman per-pack SoH** and heuristic PackRiskScore | The hierarchical fit is a *cross-sectional* (fleet-at-one-instant) view that flags a pack anomalous **relative to its siblings**; the Kalman filter is a *longitudinal* (single-pack-over-time) view of the same SoH. Agreement between "outlier now" and "declining over time" is strong corroboration; disagreement warrants a look. |

The unifying design rule across the whole tier — stated repeatedly in the source
(`restTracker.ts`, `lfpOcv.ts` plateau fix, `hierarchicalBayes.ts` null-skip,
`computeBayesianSolarModel` empty-return) — is **emit `null` / omit rather than
fabricate**: a physics estimate is only published when its physical
preconditions (sun up, pack rested, ≥2 samples, non-null SoH) are actually met.


---

