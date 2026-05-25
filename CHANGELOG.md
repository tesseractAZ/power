# Changelog

All notable changes to this add-on are listed here. Versioning follows
[Semantic Versioning](https://semver.org).

## 0.9.2 — 2026-05-24

Multi-source weather ensemble — Phoenix-specific value.

### Feature

- **NWS NDFD as a second cloud-cover source.** When `NWS_ENABLED=1`
  (US-only), the weather client now fetches the NWS gridpoint
  `skyCover` array alongside the existing Open-Meteo pull, ensembles
  the two cloud-cover signals, and computes per-hour disagreement.
  Open-Meteo remains the source of shortwave GHI (NWS doesn't expose
  it directly); only cloud cover ensembles.

  Two-step NWS fetch: `/points/{lat},{lon}` → `{office, gridX, gridY}`
  (24 h cache), then `/gridpoints/{office}/{x},{y}` (2 h cache). The
  `skyCover.values` array carries `validTime` durations like
  `PT3H` / `P1DT6H` — expanded to per-hour rows and merged with
  Open-Meteo on hour-epoch keys.

- **Disagreement widens the probabilistic forecast bands.** The
  v0.8.0 probabilistic forecast combines cloud variance + model
  residual in quadrature. v0.9.2 adds per-hour ensemble disagreement
  as a third quadrature term — when Open-Meteo and NWS disagree by
  20 pp on tomorrow noon's cloud cover, the P10/P90 band on that
  hour's PV widens by ~20% / Z10. **Disagreement IS the uncertainty
  signal** — Phoenix monsoon clouds are notoriously hard for any
  single global model, so when two independent models concur the
  forecast is trustworthy; when they don't, the band correctly
  reflects that.

### API

- **`/api/weather/ensemble`** — returns the full hourly forecast
  with per-hour `ensembleSources` (1 or 2) + `disagreementPct`.
  Summary fields: `sourcesCount`, `avgDisagreementPct`,
  `enrichedHourCount` / `hourCount`.

### UI

- New **"Weather ensemble"** section in the Advanced Insights card:
  source count, average disagreement, status indicator
  (tight bands / wide bands), and ensemble-coverage percentage.
  Hidden when only one source is active (NWS disabled or
  unreachable).

### Notes

- US-only — NWS doesn't cover other countries. Outside the US,
  set `NWS_ENABLED=0` and the panel transparently falls back to
  Open-Meteo only.
- The NWS gridpoint endpoint is `User-Agent`-gated; we send a
  descriptive UA per their TOS.
- Failures on the NWS side are non-fatal — Open-Meteo continues
  working alone, with a single log line noting the fall-through.

## 0.9.1 — 2026-05-24

Hotfix — actually ship the HACS card source committed in v0.9.0.

### Bug fix

- **`.gitignore` was eating `lovelace/dist/`.** The global `dist/`
  pattern that catches `web/dist` and `server/dist` (those ARE built
  artifacts) also caught `lovelace/dist/ecoflow-panel-card.js` (which
  is NOT — it's the source-of-truth, hand-written Web Component, no
  build step). v0.9.0's commit dropped the card silently. HACS would
  find `hacs.json` + `README.md` but `404` on the card itself.
- **Fix:** added `!lovelace/dist/` exception to `.gitignore`, committed
  the missing file. HACS install now works end-to-end.

## 0.9.0 — 2026-05-24

**Predictive Engine v2.5.** Three previously-deferred research-grade
features ship plus an HA-native UI surface plus a config-side-effect
cleanup. 5 features, 5 new tests, 0 vulnerabilities.

### Features

- **Bayesian recursive GHI→PV update.** Replaces the OLS-on-rolling-
  window approach with a proper conjugate Gaussian update per
  hour-of-day. Each new (GHI, PV) observation refines the posterior
  N(μ, τ²) on the response coefficient β via closed-form:

  ```
  1/τ'² = 1/τ² + g²/σ²
  μ'    = τ'² · (μ/τ² + g·p/σ²)
  ```

  Output: per-hour posterior mean + stdev + 95% credible interval.
  Side-by-side `agreementWithOls` field reports how often the OLS
  point estimate sits inside the Bayesian 1σ band — drift between
  the two flags model brittleness. New endpoint:
  `/api/forecast/bayesian`.
- **Kalman filter for pack SoH.** 2-state constant-velocity filter
  (state = [SoH, dSoH/dt]) over BMS-reported SoH observations.
  Operates internally in days to keep the dt² term in F·P·Fᵀ
  numerically conditioned. Process noise tuned so SoH drifts slowly
  and fade rate is near-constant; observation noise matches BMS's
  ±0.5% reporting jitter. Output: smoothed SoH + drift rate (%/yr)
  + uncertainty derived directly from posterior covariance — no
  t-statistic approximation. Available as `kalmanFilterSoh()`,
  ready to swap into `analysePack` in a follow-up (left out of the
  main projection path for v0.9.0 so we can compare its output
  against the existing OLS in real history before fully migrating).
- **PackRiskScore (heuristic-weighted v1).** NOT a trained ML
  model — we don't have a labeled dataset of pack failures, and
  shipping a half-trained model would be malpractice. Instead: a
  hand-tuned weighted combination of 6 engineered features (peer-
  fade ratio, internal-R trend, coulombic efficiency, thermal
  hard-life score, charge-curve drift, capacity fade rate). Each
  normalized to 0..1; weighted sum → sigmoid → 0..100 risk score.
  Tier: low / moderate / elevated / critical. Output includes the
  ranked **contributing factors** so the user can see exactly what's
  driving each pack's score. The output shape mirrors what a trained
  classifier would produce — `modelVersion: "heuristic-v1"` lets a
  future swap-in stay drop-in-compatible. New endpoint:
  `/api/pack-risk`.
- **HACS Lovelace card.** Self-contained Web Component (no Lit /
  framework dep) that lives under `lovelace/dist/`. Fetches
  `/api/ha-state` from the add-on, renders 12 headline numbers
  inside HA (PV / load / backup / runway / projected SoC / grid /
  PV-lifetime + CO2 / RTE / tariff savings / alerts / soonest EOL /
  clipped today) with status colour-coding, plus three action
  buttons: Open dashboard, Repair issues, Calendar feed. Packaged
  with `hacs.json` so HACS detects it as a Plugin-type repository.
  Manual install via `/local/` also documented. README under
  `lovelace/README.md` walks both install paths.

### Bug fix / hygiene

- **`config.ts` lazy-getter refactor.** Previously
  `accessKey: need('ECOFLOW_ACCESS_KEY')` threw at module-load time
  — any test/script that transitively imported `config.ts` would
  crash before doing anything else. v0.8.1's test gate caught this
  the first time it ran in CI; v0.8.2 patched with dummy env vars.
  v0.9.0 removes the root cause: `accessKey` and `secretKey` are now
  lazy getters that throw on FIRST ACCESS rather than at import. Any
  test/REPL/script context can import `config.ts` cleanly; the
  validation still fires loudly on first real use. The v0.8.2 CI
  env-var workaround is removed.

### Tests

- **5 new tests** for `kalmanFilterSoh`: returns null on insufficient
  data, recovers known slope from clean synthetic data, smoothed SoH
  tracks observations, uncertainty shrinks with more samples,
  doesn't diverge on noisy data.
- Total server tests: **41/41 passing**.

### API

New endpoints:
- `/api/forecast/bayesian` — Bayesian per-hour solar response model
  with credible intervals.
- `/api/pack-risk` — heuristic-weighted pack risk scores with
  contributing factors.

### Notes / what's explicitly NOT in v0.9.0

- **No trained ML model.** PackRiskScore is the framework + the
  heuristic surface. When a labeled failure dataset eventually
  exists (months/years out), swap the weighted-sum-+-sigmoid with
  a gradient-boosted tree and bump `modelVersion`.
- **Kalman not yet replacing OLS in `analysePack`.** The Kalman
  filter is exposed via `kalmanFilterSoh()` and tested, but
  `analysePack` still uses `linregress` to project EOL. Swap-in
  is planned for a follow-up release after side-by-side comparison
  on real Pi data confirms the Kalman gives equivalent-or-better
  projections.
- **HACS card is the "stats card", not a full dashboard rebuild.**
  Replicating the entire React dashboard in Lit/Web Components
  would be multi-week work for marginal benefit (the PWA already
  installs as a native app). The card is scoped to headline numbers
  + one-click to the PWA.

## 0.8.2 — 2026-05-24

Patch — fix the CI test job from v0.8.1.

### Bug fix

- **CI: provide dummy ECOFLOW credentials to the test job.** v0.8.1's
  test gate caught a real CI integration issue on its first run:
  two test files (`alertMonitor.test.ts`, `analytics.test.ts`)
  transitively import `src/config.ts`, which calls
  `need('ECOFLOW_ACCESS_KEY')` at module-load time and throws if the
  env var isn't set. Locally `.env` provides them; CI doesn't.
  Fix: set `ECOFLOW_ACCESS_KEY=test-access-key` /
  `ECOFLOW_SECRET_KEY=test-secret-key` in the test job env. The tests
  themselves never call the EcoFlow API — they exercise pure
  functions — so the placeholders are inert. **All 36 tests now pass
  in CI.**
- **TODO (future):** refactor `config.ts` so `accessKey` /
  `secretKey` use lazy getters that throw on first access rather
  than at import time. Eliminates this class of import-side-effect
  footgun for future test additions.

### Validation

- v0.8.1 release-pipeline run succeeded only as far as `Resolve
  version`; `Server tests` failed, and `Build & push` + `Cut GitHub
  Release` were correctly skipped (no broken image got pushed).
  Behaves exactly as the gate was designed.

## 0.8.1 — 2026-05-24

Polish patch — security fix, bundle splitting, and the first
automated tests in the codebase.

### Security

- **Bumped `@fastify/static` from `^8.0.4` → `^9.1.3`.** Fixes two
  Dependabot-reported moderate vulnerabilities:
  - GHSA-???-???-??? — path traversal in directory listing
  - GHSA-???-???-??? — route guard bypass via encoded path separators
  `npm audit` now reports **0 vulnerabilities**. Usage in the codebase
  is the minimal `register(fastifyStatic, { root, wildcard: false })`
  shape, so the major-version bump was a drop-in.

### Performance — route-level code splitting

Initial Dashboard bundle:

| | v0.8.0 | v0.8.1 | Reduction |
|---|---|---|---|
| Initial JS | 698.54 kB | **60.87 kB** | 11.5× smaller |
| Initial gzip | 202.62 kB | **17.62 kB** | 11.5× smaller |

`recharts` (~543 kB minified) split into a lazy vendor chunk that
only loads when the user visits a chart-heavy page (Solar, Battery,
EVSE, Strategy, Predictive). All non-Dashboard pages converted to
`React.lazy()` + `<Suspense>` so each loads on first navigation.
`TrendChart` lazy-loaded too (only loads when the user toggles
"show history" on the Dashboard).

### Tests

- **36 server-side unit tests** added under `server/test/`, run via
  Node 22's built-in `node:test` runner through `tsx` (no new
  runtime deps). Coverage:
  - `aggregator.test.ts` — `integrateWh` trapezoidal correctness, gap
    behavior, leading anchor, trailing extension, partial coverage,
    `startOfLocalDayMs`
  - `alertMonitor.test.ts` — `parseQuietHours` (valid/invalid/empty),
    `inQuietWindow` (non-wrapping and wrap-past-midnight),
    `buildIncidents` (pack-clustering, core-clustering, thermal-
    cascade naming, severity sorting)
  - `analytics.test.ts` — `rootCausesFor` graph traversal,
    `parseRange`, `onPeakAt` (TOU classification with weekday/weekend
    semantics), `forecastDayAlerts` (counterfactual cloud-cover fact,
    soiling threshold gating, no false positives on healthy forecast)
  - `calendar.test.ts` — RFC5545 envelope, line-folding, comma /
    semicolon escaping, EV-session events, SoC-dip events
- **`npm test` script** wired into `server/package.json`.
- **CI test job** added to `.github/workflows/images.yml` — runs
  `npm test` + `tsc --noEmit` on every release tag and **blocks the
  image build on test failure**.

### Bug fix found by tests

- **Calendar feed cache was un-keyed.** `buildCalendarIcs` had a
  module-level 5-min cache that locked the calendar content for the
  first 5 min regardless of input changes — any new SoC dip or NWS
  storm wouldn't appear until cache expiry. Removed the function-
  level cache; replaced with `Cache-Control: public, max-age=300` on
  the `/api/calendar.ics` HTTP response (correct architecture —
  upstream data sources already cache internally).

## 0.8.0 — 2026-05-24

"Big push" release — full HA-native integration surface + predictive
engine v2 (uncertainty-aware, multi-day, counterfactual, dispatch).
13 features in one release. Everything is **read-only** by explicit
user request — no write actions to EcoFlow devices in this release.

### Features — HA integration

- **Per-circuit lifetime kWh.** The persistent `lifetime_totals`
  accumulator from v0.7.6 now maintains one row per SHP2 circuit
  (`circuit_<ch>_wh`). Each circuit appears as its own
  `state_class: total_increasing` sensor under HA Energy
  Dashboard → **Individual devices** — water heater, EVSE, HVAC,
  pool pump, etc. broken out cleanly. MQTT Discovery auto-publishes
  one sensor per detected SHP2 circuit.
- **Carbon offset / sustainability reporting.** New
  `computeCarbonReport` multiplies PV-direct-to-load + battery
  discharge by the regional grid CO2 intensity (default 1100 lb/MWh
  for AZ; configurable via `GRID_CO2_INTENSITY_LB_PER_MWH`) to
  derive kg CO2 avoided. Equivalent miles-not-driven via the EPA
  passenger-car number. Surfaced as 4 new HA sensors:
  CO2 avoided (7d / lifetime), miles not driven (lifetime), grid
  intensity.
- **TOU tariff cost tracking.** Configurable on-peak / off-peak
  rates + hour-of-day windows + day-of-week mask
  (`TARIFF_ON_PEAK_CENTS`, `TARIFF_OFF_PEAK_CENTS`,
  `TARIFF_ON_PEAK_HOURS=15-20`, `TARIFF_ON_PEAK_DAYS=1-5`). Computes
  grid-import cost today + 7d, solar-load value (what the load
  would have cost from grid), net savings. APS-Saver-style defaults.
- **Calendar ICS feed** at `/api/calendar.ics` (RFC5545). HA's
  `generic_ics_calendar` integration can subscribe. Surfaces SHP2
  TOU charge windows, predicted EV charging sessions, projected
  SoC dips below reserve, active NWS storm windows — your
  EcoFlow events appear in any iOS / Google / HA calendar app.
- **Repair issues feed** at `/api/repair-issues`. Curated subset
  of alerts where the user can take physical action — wash panels,
  power-cycle zombie devices, inspect peer-outlier packs, etc.
  Each issue has stable id, severity, summary, ordered fix steps,
  and a category. Persistent first-seen tracking lets HA show
  "active for N hours".
- **Diagnostic entity recategorization.** Markers like `PV Array
  Peak Watts` now carry `entity_category: diagnostic` so they hide
  from the main HA UI but remain available for automations.

### Features — Predictive engine v2

- **Probabilistic forecasts (P10/P50/P90).** Replaces the single-
  line PV curve with a confidence band per hour. Variance sources:
  per-hour-of-day cloud-cover stdev (from history) + model residual
  fraction (forecast skill MAE). Combined in quadrature into a
  Gaussian-equivalent band; propagated into the SoC trajectory.
  Output: `/api/forecast/probabilistic` returns per-hour P10/P50/P90
  bands plus headline numbers: P(SoC stays above reserve through
  24 h), P(full charge), kWh stdev. Enables risk-aware automations
  rather than "trust the point estimate".
- **Multi-day forecast horizon (3 days).** Extends the 24 h horizon
  to 72 h with per-day rollups: PV kWh, load kWh, min projected
  SoC + ts. `/api/forecast/multi-day`. Lets you answer "should I
  run the dryer Wed or Sat?" or "will I make it to the weekend
  before the storm?".
- **Counterfactual alert explanations.** The `forecast-soc-dip`
  and `forecast-low-solar` alerts now include a `why` decomposition
  in their detail — cloud cover vs typical, hypothetical clear-sky
  ceiling, hours-modelled count. Stops being "X is wrong" and
  starts being "X is wrong BECAUSE Y".
- **Root-cause graph for alerts.** Hand-curated causal DAG mapping
  alert families to likely upstream causes (cell imbalance →
  thermal stress → fade rate; soiling → low forecast; etc.).
  `/api/root-cause?alertId=...` walks one hop back. AdvancedInsights
  card surfaces upstream candidates next to each alert.
- **Energy dispatch planner (compute-only).** Greedy 24 h hour-by-
  hour schedule given forecast PV, load, tariff, current SoC,
  reserve floor: charge from PV when surplus, discharge to load
  during on-peak hours, top off from grid during off-peak before
  the next peak. Output: recommended schedule + estimated savings
  vs all-grid baseline. **Compute-only — does NOT auto-apply** (user
  explicitly held write actions). Mirror manually via the EcoFlow
  mobile app or HA automations.

### Features — PWA

- **PWA installable.** Web UI now ships a `manifest.webmanifest` +
  service worker. Add-to-Home-Screen on iOS / Android / desktop
  Chrome works cleanly — your panel launches as a standalone app
  with no browser chrome. Static shell is stale-while-revalidate
  cached; `/api` and `/ws` traffic always hits the network so
  telemetry stays live. Custom-themed icon (sun-over-battery on
  dashboard slate).

### API

- **New endpoints:** `/api/carbon`, `/api/tariff`,
  `/api/forecast/probabilistic`, `/api/forecast/multi-day`,
  `/api/dispatch-plan`, `/api/root-cause`, `/api/calendar.ics`,
  `/api/repair-issues`.
- **`/api/ha-state`** gains 12+ new fields: per-circuit lifetime
  kWh (one per SHP2 circuit), 4 carbon fields, 7 tariff fields.
- **MQTT Discovery** publishes 6 new aggregate sensors (CO2, miles,
  costs, savings) + dynamically generates one Energy-Dashboard
  sensor per SHP2 circuit on connect.

### Docs

- DOCS.md walkthrough for: TOU tariff config, NWS opt-in, MQTT
  Discovery setup, HA Energy Dashboard hookup (5+ slots), repair-
  issues consumption, calendar subscription, PWA install on iOS.

### Notes / explicitly deferred

User held all write-to-device features for a later release. Also
deferred to v1.0+ (genuine multi-week research scope, would be
malpractice to half-ship in a single batch):

- Bayesian GHI→PV update (replacing OLS with proper posterior)
- Kalman state-space SoC/SoH estimator
- ML failure-mode classifier (needs training infrastructure)
- Self-tuning anomaly z-score thresholds
- HACS Lovelace frontend card (full Web Components rebuild)
- LAN-direct EcoFlow protocol (reverse engineering)
- Multi-site federation (requires backend infra)

These remain on the roadmap and will be tackled in a focused way
when they're the priority. For now: v0.8.0 ships the read-only
side of the v2.0 roadmap.

## 0.7.7 — 2026-05-24

Diagnostics patch — actionable offline alerts plus per-SN connectivity
logging so the next "why is X offline" investigation is one log grep,
not a code spelunk.

### Features

- **Cloud-session-stale alert.** Track `lastDeviceListAttemptAt` and
  `lastDeviceListSuccessAt` separately in the snapshot store. When
  attempts continue but the most recent success was > 5 min ago,
  fire a top-level "EcoFlow Cloud session stale" warning explaining
  that all per-device online/offline indicators below reflect the
  last successful poll, NOT current state. Stops misleading the user
  into power-cycling devices when the issue is the cloud session.
- **Enriched offline-device alert.** What used to be
  `"<device> is not reporting to EcoFlow"` now reads
  `"<device> is flagged offline by EcoFlow's /device/list. We
  previously received N MQTT message(s) this session; last data 47
  min ago via MQTT. The device is likely in the 'EcoFlow zombie'
  state — connected to LAN but MQTT TCP session wedged. Power-cycle
  the device to force a clean reconnect."` Three facts attached:
  reported-by, last-data (with source: MQTT/REST + age), MQTT
  msg-count. Action hint scales to the data-age (just dropped /
  stale-but-recent / 30+ min zombie).
- **Per-SN state-transition logging.** `setDeviceList` and
  `setDeviceOnline` (in `snapshot.ts`) now emit one info-level log
  line on every online/offline transition: `device-list: Core 4
  (Y7…) → OFFLINE per EcoFlow Cloud`. First-sight inaugural state
  is also logged. Diagnosed from the user's 10k-line log audit
  where zero such lines existed and the cause had to be inferred.
- **Periodic fleet-status dump.** Every 10 min, one log line summarising
  every device's online state + MQTT msg-count + age since last data:
  `fleet-status [device-list last success 23s ago]: SHP2=ON/4521msg/3s
  · Core 1=ON/8210msg/2s · Core 4=OFF/0msg/∞ · …`. Makes "which
  device stopped reporting and when" answerable from a grep alone.

### Notes

- No new env vars; nothing to configure. The Cloud-session-stale
  alert uses a fixed 5-min threshold (twice the default 60 s poll
  interval), and the fleet-status dump is on by default at 10 min
  cadence (cheap, one log line per dump).
- The "EcoFlow zombie" pattern (device alive on LAN but cloud says
  offline) is genuinely an EcoFlow-side issue — there's nothing we
  can do to fix it from the panel side. But the new alert text now
  says so directly, with a power-cycle hint, instead of a generic
  "is not reporting" that left the user wondering whether to debug
  the dashboard or the device.

## 0.7.6 — 2026-05-24

Patch + feature — full **Home Assistant Energy Dashboard** integration.

### Features

- **Persistent lifetime energy counters.** New `lifetime_totals` table
  inside `/data/ecoflow.db` accumulates integrated Wh per metric under a
  watermark — every 5 min we integrate `(watermark, now]` from the
  rolling 30-day `samples` table, add the result to the persisted Wh,
  then advance the watermark. Pruning of raw samples can't decrement the
  counter; a server restart can't decrement it (boot seeds the floor
  from the persisted row); a transient negative sample can't decrement
  it (clamped at zero). Five counters maintained:
  - `fleet_pv_wh` — sum of every DPU's `pv_total` watts integrated over time
  - `fleet_load_wh` — SHP2 `panel_load` watts integrated
  - `fleet_grid_import_wh` — sum of grid-tied DPUs' `ac_in` watts integrated
  - `fleet_battery_charge_wh` — sourced directly from the **BMS
    `accuChgMah` lifetime counters** across all packs, converted to Wh
    at 102.4 V nominal. Authoritative since pack manufacture.
  - `fleet_battery_discharge_wh` — same from `accuDsgMah`.
- **HA Energy Dashboard wiring.** Five new sensors with
  `state_class: total_increasing` + `device_class: energy` so Home
  Assistant can ingest them into the Energy Dashboard's hourly /
  daily / monthly statistics: PV Production, Home Consumption, Grid
  Import (lifetime), Battery Energy In, Battery Energy Out.

### API

- **`/api/lifetime-energy`** — returns the five lifetime kWh values
  plus a `details` block exposing `persistedWh` + `pendingWh` +
  `watermarkMs` per metric (useful for diagnosing the rollup).
- **`/api/ha-state`** gains 5 new lifetime kWh fields:
  `pv_lifetime_kwh`, `load_lifetime_kwh`, `grid_import_lifetime_kwh`,
  `battery_charge_lifetime_kwh`, `battery_discharge_lifetime_kwh`.

### MQTT Discovery

- 5 additional auto-discovered sensors when
  `MQTT_DISCOVERY_ENABLED=1` is set — the Energy Dashboard slots fill
  themselves with no YAML edits.

### Docs

- New **HA Energy Dashboard** subsection in `DOCS.md` walks through
  the Settings → Dashboards → Energy hookup (one sensor per slot)
  and documents the persistence design + reset semantics.

### Notes

- The recorder's existing 30-day retention on raw samples is
  unchanged — `lifetime_totals` is a separate, lightweight, never-
  pruned table (one row per metric).
- On first install, the watermark seeds 60 s before boot so the
  initial rollup doesn't try to integrate years of empty history;
  numbers grow from there as live data arrives.
- The `close()` shutdown path now does a final rollup before closing
  the DB so we don't lose the trailing minute of energy.

## 0.7.5 — 2026-05-24

The "drain the roadmap" release. Every remaining roadmap item from
v0.7.0 + v0.8.0+ + external/infrastructure is shipped here in a single
batch — 17 features across analytics, alerting, and integration.
Pre-existing functionality is unchanged; everything new is purely
additive (new endpoints, new optional modules, one new card on the
Predictive Insights page).

### Features — Anomaly engine v2 (finish)

- **Alert clustering ("incidents").** Simultaneous alerts on the same
  Core / Pack are grouped into one Incident with one notification —
  a "Core 3 thermal cascade" with 5 contributing alerts now fires
  once, not five times. The Incident keeps every member alert ID so
  the detailed view still drills down. Exposed via new
  `/api/incidents` and surfaced in the v0.7.5 Advanced Insights card.
- **Internal-resistance trending.** `dV/dI ≈ effective R` derived
  from snapshot pairs of bus voltage + bus current (≥ 5 A swing, ≤ 60 s
  apart). Per-Core (DPU-level) tracking — recent vs baseline mΩ and a
  trend rate per month. Rising R precedes SoH decay by months on LFP.
  `/api/internal-resistance`.

### Features — Sharper forecasts

- **Forecast-skill calibration.** Hindcast: apply the learned solar
  model coefficients to the past 7 days of GHI to derive "what the
  model would have predicted" and compare with what actually happened
  per day. Reports MAE (kWh and %), bias factor (sum(actual) ÷
  sum(predicted)), and a per-day breakdown — bias factor is the
  correction the user can apply to today's forecast.
  `/api/forecast-skill`.
- **Ambient-coupled thermal forecast.** Two-variable least-squares
  regression of pack temperature against outdoor temperature + recent
  load. Predicts each pack's peak temperature in the next 24 h with
  an R² fit quality, using Open-Meteo's hourly tempC forecast.
  Surfaces "Core 3 Pack 2 will hit 108 °F tomorrow at 3 PM" before
  it happens. `/api/ambient-thermal-forecast`.

### Features — Insights requiring accumulated history

- **Shade-event detection.** Walks clear-sky hours across 45 days of
  history, builds a per-hour reference coefficient from the 90th-
  percentile of observed-PV ÷ GHI ratios, and flags hours whose
  recurring shortfall vs that reference exceeds 18% — physical
  obstruction, not weather. Annualised kWh-loss estimate.
  `/api/shade-report`.
- **Soiling decomposition.** Splits the existing fleet-wide soiling
  drop% per-DPU (each device drifts independently) and per-hour-of-day
  (some hours are more affected — e.g. east-facing morning sun).
  Answers "wash everything vs just the east-facing run?". `/api/soiling-decomposition`.
- **String mismatch / per-DPU production.** Compares each DPU's
  per-hour median PV to the fleet median for the same hour. Robust
  median + MAD + modified-z flags persistent underperformers — string
  mismatch, shaded panel, failing optimizer. `/api/string-mismatch`.
- **EV-charging window prediction.** Scans SHP2 paired-circuit
  history (where the EVSE lives) for sustained ≥ 2 kW sessions ≥ 30
  min, buckets by (weekday, start-hour), requires ≥ 3 recurrences to
  declare a pattern. Projects next 24 h. `/api/ev-window-prediction`.
- **Charge-curve fingerprinting.** Records `pack${N}_vol_max_mv` at
  SoC checkpoints (40 / 60 / 80 / 95 %) during *active charge*
  (`pack${N}_in > 100 W`), then compares today's medians against a
  baseline laid down in the first 14 days of recording. Mean drift in
  mV per pack — catches aging that SoH lags by months. `/api/charge-curve`.

### Features — External / infrastructure

- **NWS storm-preparedness signal.** Opt-in (`NWS_ENABLED=1`,
  US-only). Pulls active alerts.weather.gov alerts within ~50 mi of
  the configured forecast coordinates. Severe events (Tornado,
  Severe Thunderstorm, Hurricane, Excessive Heat, …) emit a
  learned-warning recommending pre-charge to 100% before onset.
  `/api/nws-alerts`.
- **Thermal-event counter.** Cumulative per-pack count of rising-edge
  crossings of three temperature thresholds (96 / 113 / 131 °F) with
  hysteresis so a sustained spell counts as one event. Tracks total
  hours-above-threshold per band and a "hard-life score" (1×warm +
  4×hot + 16×overheat, per year) that's directly comparable across
  packs with different recording histories. `/api/thermal-events`.
- **MPPT efficiency drift + inverter standby losses.** Per-string
  (HV + LV) per-Core: V·A vs reported W ratio (clamped to a sane
  band), recent median vs earliest-30%-of-history median, and a drift
  in percentage points. Inverter standby: ac_out residual when PV
  and panel load are both < 20 W; reports recent idle watts, baseline,
  and a weekly trend. Both in `/api/equipment-health`.
- **Confidence trends.** R² aggregator across the panel's main
  projections (degradation fade, solar response model, ambient
  thermal forecast) plus the forecast-skill bias factor and MAE %.
  Single endpoint snapshot: `/api/confidence`.
- **Notification timing intelligence.** Quiet-hours window
  (`NOTIFY_QUIET_HOURS=22-06` by default) queues warning + info
  alerts during the configured nighttime band; critical alerts
  always go through. At `NOTIFY_DIGEST_HOUR` (default 7) a single
  morning digest fires with the queued list. No more
  "you have 12 notifications about a brief cloud blip at 3 AM".
- **Alert-action telemetry.** Per-alert-ID rise count, longest
  duration, median duration, and short-clear fraction (cleared
  within 10 min). Info-severity alerts that rise ≥ 5 times AND
  short-clear in ≥ 70% of cases get auto-downgraded (silenced).
  `/api/alert-telemetry`.
- **Self-consumption ratio.** Rolling 7-day breakdown of PV
  generation, household load, battery in/out, grid import, and
  the derived solar fraction of load (% of consumption met by
  solar directly or via battery) and direct-use ratio (PV that
  went straight to load). `/api/self-consumption`.
- **MQTT discovery for HA entities.** Opt-in
  (`MQTT_DISCOVERY_ENABLED=1` + `MQTT_DISCOVERY_HOST`). Connects to
  the user's HA MQTT broker (e.g. the official `core-mosquitto`
  add-on), publishes 23 sensor + 1 binary_sensor `homeassistant/...`
  discovery topics with full device-info grouping, and pushes one
  big retained state JSON every 30 s. Drops the YAML-snippet
  requirement entirely for users who already run an MQTT broker.

### API

Fifteen new endpoints — one per feature surface:
`/api/self-consumption`, `/api/thermal-events`,
`/api/equipment-health`, `/api/shade-report`,
`/api/soiling-decomposition`, `/api/string-mismatch`,
`/api/ev-window-prediction`, `/api/charge-curve`,
`/api/internal-resistance`, `/api/forecast-skill`,
`/api/ambient-thermal-forecast`, `/api/confidence`,
`/api/nws-alerts`, `/api/incidents`, `/api/alert-telemetry`.

`/api/ha-state` gains 7 new fields covering self-consumption.

### UI

- New **AdvancedInsightsCard** added to the bottom of the
  Predictive Insights page — one section per analytics family,
  hides sections that have nothing to show yet. Fetches 14
  endpoints on a 60 s interval.

### Docs

- `DOCS.md` HA REST-sensor snippet gains 7 new sensors for the
  self-consumption + clipping numbers. Includes an MQTT-discovery
  setup note covering the opt-in env vars.
- README roadmap collapses: every v0.7.0, v0.8.0+, and
  external/infrastructure item is now shipped. Only WAVE 2 / Smart
  Generator schemas remain in the "Standing" section (blocked on
  EcoFlow shipping the IoT Open API spec).

### Notes

- Every new analytics function is **off the hot path** (cached
  5 – 60 min) and **silently degrades** when its prerequisites are
  missing (no weather, no history, no MQTT broker). No new
  required configuration — every opt-in feature ships off by default.
- MQTT discovery and NWS use `undici`/`mqtt` modules already in
  the dependency tree. No new runtime dependencies.

## 0.6.0 — 2026-05-24

Half-the-roadmap batch — four learned-analytics features tightened
around battery longevity, day-ahead forecasting accuracy, and
identifying solar capacity left on the table.

### Features — Anomaly engine v2

- **Per-circuit baseline anomaly detection.** Until now, each SHP2
  circuit's watts contributed to the panel total but had no
  self-baseline of its own — only paired (split-phase) totals and
  fleet-aggregate metrics had learned baselines. v0.6.0 wires every
  *unpaired* SHP2 circuit into the learned-baseline engine, so an
  individual outlet, freezer, well pump, or office sub-panel that
  starts pulling well outside its own median can fire a learned
  warning. Paired-circuit aggregates already cover the split-phase
  loads (water heater, AC, EV charger), so the per-circuit pass skips
  any channel that's part of a pair to avoid double-counting.

### Features — Forecasting accuracy

- **Day-of-week-aware load curve.** The day-ahead forecast used to
  collapse all weekday and weekend hours into a single hour-of-day
  average — but EV charging, dishwasher / laundry cycles, and
  home-office HVAC duty run on visibly different schedules Mon–Fri
  vs Sat–Sun. The new `hourCurveByWeekday` helper splits the typical
  load into a 24-hour weekday curve and a 24-hour weekend curve;
  `getDayForecast` picks the appropriate curve for each *projected*
  hour. Requires ≥ 24 hourly samples on both sides before the split
  is trusted; otherwise it falls back to the combined curve so a
  fresh install doesn't get whiplash.

### Features — Battery longevity v3

- **Per-pack coulombic efficiency.** Discharge mAh ÷ charge mAh over
  a rolling 7-day window, using the BMS lifetime counters
  (`pack${N}_lifetime_chg_mah`, `pack${N}_lifetime_dsg_mah`). Healthy
  LFP stays well above 99%; a downward drift signals side-reaction
  losses inside a cell that SoH alone may not yet show, and is an
  independent early-warning channel for cell degradation. Surfaced
  as a new fact tile in every pack's expanded view inside the
  degradation card.

### Features — Solar capacity

- **Inverter clipping quantifier.** New `computeClipping` analytics
  function estimates kWh-lost-to-clipping today by walking each
  elapsed daylight hour: an hour is flagged as "at peak" when
  observed PV reaches 95% of the hardware ceiling (highest hourly
  average PV ever observed across the fleet); if the learned
  GHI→PV model says the array could have produced more than what we
  recorded that hour, the difference is the clipped energy. Sum
  across the day → kWh lost to clipping today. The current hour is
  prorated by elapsed fraction. Cached 5 min.

### API

- **`/api/clipping`** — `ClippingEstimate` (today-kWh-lost,
  per-hour breakdown, array peak watts, hours-at-peak).
- **`/api/ha-state`** gains `pv_clipped_kwh_today`,
  `pv_array_peak_watts`, `pv_hours_at_peak_today`.

### Docs / roadmap

- DOCS.md HA snippet adds three new sensors (clipped-kWh-today,
  array-peak-watts, hours-at-peak-today). Total: 20 sensors + 1
  binary_sensor.
- README roadmap: removes the four shipped items, promotes the
  remaining anomaly-engine work (alert clustering) and the sharper-
  forecasts items (forecast-skill calibration) into the v0.7.0
  bucket.

## 0.5.1 — 2026-05-23

Patch fix — web UI / API now binds dual-stack, mirroring v0.3.1's telnet fix.

- `config.ts` + run script: changed the Fastify `HOST` default from
  `0.0.0.0` (IPv4 only) to `::` (Node dual-stack). macOS resolves
  `homeassistant.local` to both an IPv4 and several IPv6 addresses with
  IPv6 listed first; browser happy-eyeballs would race both, the IPv6
  connect would RST against the unbound v6 listener inside the
  add-on's port mapping, and `http://homeassistant.local:8787/` would
  stall or fail. Verified `curl -6 http://homeassistant.local:8787/api/health`
  returned HTTP 000 in ~13ms (TCP RST) while `-4` returned HTTP 200.
  With `::`, both protocols land on the same Fastify listener.

## 0.5.0 — 2026-05-23

### Features — Battery longevity v2

- **Temperature-corrected SoH fade (Arrhenius).** Each projecting or
  stable pack now reports `avgPackTempC` (across the SoH regression
  window), the resulting Arrhenius factor, the **calendar fade
  re-expressed at the 25 °C reference**, and an estimated
  **years-of-life-gained-if-cooled-5 °C** number. Three new fact-tiles
  per pack in the degradation card; the per-pack summary sentence
  appends the Arrhenius note when the data supports it. Direct answer
  to "would moving these to a cooler garage save me X years?" for
  Phoenix-class climates.

- **Round-trip efficiency, rolling 7-day.** Integrates per-pack input
  vs output watts across all DPUs over the last 7 days; ratio shows in
  a new tile on the degradation-card header and as the
  `ecoflow_round_trip_efficiency` HA sensor. Healthy LFP sits 95–97%;
  a slow drift down is the cleanest "the whole stack is aging" signal
  that no single-pack metric catches. Cached 5 min.

### Features — Operational

- **Live off-grid runway.** New prominent card at the top of the
  Dashboard: hours to reserve and hours to empty, projected hour-by-hour
  from the last-hour panel load and the next-24-hour forecast PV.
  Headline colour shifts **red < 4h / amber < 12h / neutral ≥ 12h**.
  Also surfaces the clock times ("Reserve floor reached around Sat
  9 PM") and a breakdown of the assumptions (backup now, reserve floor,
  recent load, forecast PV vs load over the horizon). Exposed as
  `ecoflow_runway_to_reserve_hours` and `ecoflow_runway_to_empty_hours`
  HA sensors. Cached 60 s.

### API

- **`/api/runway`** — RunwayProjection.
- **`/api/round-trip-efficiency?days=N`** — RoundTripEfficiency (days
  capped 1–30, default 7).
- **`/api/ha-state`** gains `runway_to_reserve_hours`,
  `runway_to_empty_hours`, `runway_recent_load_watts`,
  `runway_forecast_pv_used_kwh`, `round_trip_efficiency_percent`,
  `round_trip_charged_kwh_7d`, `round_trip_discharged_kwh_7d`.

### Docs / roadmap

- DOCS.md HA snippet adds three new sensors (runway-to-reserve,
  runway-to-empty, round-trip-efficiency). Total: 17 sensors + 1
  binary_sensor.
- README roadmap expanded to a multi-release plan (v0.6.0 anomaly
  engine v2, v0.7.0 sharper forecasts, v0.8.0+ pattern detection with
  history, plus external-integration and standing buckets).

## 0.4.0 — 2026-05-23

### Features

- **Per-circuit multi-day kWh comparison on the circuit modal.** Click
  any SHP2 circuit on the Dashboard → in addition to the live "now",
  "peak (24h)", "average (24h)", "today" tiles and the 24h watt chart,
  there's a new **Last 7 days** panel: a bar chart of daily kWh totals
  for the past week, with **today highlighted in accent** as a partial /
  running total, the **peak day color-coded amber**, days with no data
  rendered dim, and a **dashed reference line at the 7-day average**.
  Hovering any bar shows that day's total kWh, peak watts, when the
  peak hit, and a "partial day" caveat for incomplete windows. Three
  summary tiles below the chart: average per day (with "N/7 days w/
  data" coverage note), peak day, and quietest day.

- **New `/api/circuit/history?sn=<SN>&ch=<N>&days=<N>` endpoint.**
  Returns per-day trapezoidal kWh + peak watts + peak timestamp +
  coverage, plus a summary block (average, peak day, min day). Day
  windows are local-midnight to next local-midnight (or `now` for the
  in-progress day). Days capped at 30 to keep recorder queries bounded;
  default is 7.

## 0.3.1 — 2026-05-23

Patch fix for the telnet TUI over `homeassistant.local`.

- **Telnet binds dual-stack** — changed the `TELNET_HOST` default from
  `0.0.0.0` (IPv4 only) to `::` (Node dual-stack: listens on both IPv4
  and IPv6 on one socket; Node leaves `IPV6_V6ONLY` off so IPv4 clients
  still connect via mapped addresses). macOS resolves
  `homeassistant.local` to both an IPv4 and several IPv6 addresses with
  IPv6 listed first; `getaddrinfo` (which `nc`/`telnet`/`python socket`
  all use) picks IPv6, so `nc homeassistant.local 2323` was reaching the
  HA host's IPv6 stack — which had no listener for the add-on's port —
  and the TCP handshake completed only to be immediately RST'd
  ("Connection reset by peer"). The IPv4 path always worked
  (`nc -4 hostname`, or `nc <IP>`) but it wasn't discoverable. With `::`,
  both protocols land on the same telnet listener.

## 0.3.0 — 2026-05-23

### Features

- **Home Assistant entities integration** — new `/api/ha-state` endpoint
  returns a flat key-value JSON designed for HA's `rest:` integration. One
  HTTP call surfaces ~13 sensors + 1 binary_sensor (backup pool %, panel
  load, AC import, off-grid status, day-ahead forecast, soonest-EOL pack,
  alert counts, peer-outlier count, etc.). Forecast + degradation are
  reused from their internal caches, so HA polling every 30s is
  essentially free. See `DOCS.md` → "Home Assistant entities" for the
  copy-pasteable `configuration.yaml` snippet and example automations
  (backup-pool-low, critical-alert, projected-SoC-dip).

### Chores

- `dependabot.yml`: ignore major version bumps. The first batch of
  Dependabot PRs was all majors (React 18→19, Tailwind 3→4, TS 5→6,
  Vite 6→8, Fastify ecosystem majors, Node 22→26) — each one needed
  deliberate migration work, none was auto-mergeable. All seven closed;
  going forward only minor/patch updates auto-PR.

- README: moved "HA service integration" from Roadmap to Phase 7
  (shipped). Dropped the "Pre-built multi-arch GHCR images" roadmap line
  (shipped in Phase 6). New roadmap entry: MQTT discovery for HA
  entities, to auto-register sensors without a YAML snippet.

## 0.2.3 — 2026-05-22

Runtime fix for the start crash loop.

- `config.yaml`: added `init: false`. HA's `init: true` default wraps the
  container with Docker's tini, making tini PID 1. The HA base image
  already ships its own s6-overlay `/init`; with tini in front, the
  base's `s6-overlay-suexec` saw it wasn't PID 1 and refused to start,
  producing the crash-loop log:
  ```
  s6-overlay-suexec: fatal: can only run as pid 1
  ```
  Setting `init: false` disables tini so our `/init` (s6) runs as PID 1 —
  the standard pattern for any add-on built on the official HA base
  images.

## 0.2.2 — 2026-05-22

Schema fix for the Configuration → Save flow.

- `config.yaml`: relaxed the schema for `NOTIFY_NTFY_SERVER` and
  `NOTIFY_WEBHOOK_URL` from `url?` to `str?`. Voluptuous (HA's schema
  validator) treats `url?` as "may be absent **or** a valid URL" — but
  both fields ship with empty defaults that only get filled when the
  matching `NOTIFY_CHANNEL` is in use. With the strict `url?` type, the
  first **Save** always failed with `Failed to save: expected a URL.
  Got {…}` (voluptuous dumps the whole options dict instead of the
  failing path). The runtime notify code validates each URL at the
  moment it actually uses the channel, so the schema relaxation is safe.

## 0.2.1 — 2026-05-22

Patch fix for two issues that hit on the first `v0.2.0` push.

- **Dockerfile multi-stage ARG**: moved `ARG BUILD_FROM` (and the other
  `BUILD_*` args) to the **global scope** (above every `FROM`) so the
  runtime stage's `FROM ${BUILD_FROM}` substitutes correctly. Declared
  inside the previous stage, `BUILD_FROM` was scoped to that stage and
  evaluated to empty in the runtime `FROM`, so the docker smoke build
  (CI) and `Publish images` (on tag) both failed instantly with
  `ERROR: failed to build: failed to solve: base name (${BUILD_FROM})
  should not be blank`.
- **`server/src/telnet/server.ts`**: cast the socket `data` event payload
  to `Buffer` at the call site. `@types/node` ≥ 22.19 narrowed the event
  payload to `string | Buffer`, and the inner `onData(data: Buffer)`
  signature rejected the union. (Local working tree had `@types/node@22.10`
  cached, so it only surfaced when CI's fresh `npm ci` pulled the latest
  patch.) The runtime never sets a socket encoding, so the cast is
  type-only — no behavior change.

## 0.2.0 — 2026-05-22

### Distribution
- **Pre-built multi-arch images on GHCR** (aarch64 + amd64). Installing this
  version on the Pi pulls a ready-made image instead of building the
  container from source — install time drops from minutes to seconds, and
  the Pi stops having to do `npm ci` over a slow connection.
- `config.yaml` now declares
  `image: ghcr.io/tesseractaz/{arch}-ecoflow-panel`; HA Supervisor substitutes
  `{arch}` with the host's CPU architecture.

### CI / release pipeline
- **Docker smoke build in CI** (`ci.yml`) — every push and PR builds the
  container (amd64, cached) so a broken Dockerfile is caught before it
  reaches the Pi.
- **Split release flow** — `release.yml` cuts the tag and pushes; the new
  `images.yml` workflow takes over on tag push, builds + pushes amd64 and
  aarch64 images to GHCR in parallel, then creates the GitHub Release. **The
  Release appearing on GitHub is now the "go ahead and update" signal.**
- **Dependabot** configured for npm (server + web), GitHub Actions, and the
  Dockerfile base images — weekly Monday PRs, grouped by production /
  development to cut PR noise.

### Notes
- One-time setup after the first `images.yml` run: open
  <https://github.com/tesseractAZ?tab=packages>, find `amd64-ecoflow-panel` and
  `aarch64-ecoflow-panel`, and change each from Private → Public so HA
  Supervisor can pull anonymously.

## 0.1.0 — 2026-05-22

Initial Home Assistant add-on release. Packages the existing EcoFlow Panel app
(Fastify + Vite/React + telnet TUI) as a single supervised container that runs
on a Raspberry Pi or any 64-bit Home Assistant host.

### Features
- **Live dashboard** at `http://<ha-host>:8787/` — energy-flow diagram, today's
  totals, day-ahead forecast, per-DPU detail, SHP2 backup pool + circuits.
- **Solar page** — fleet PV, per-DPU MPPT HV/LV detail, equipment-tuned
  response model, 24h production chart. Renders 10-panel HV + 4-panel LV
  strings per array DPU.
- **Battery page** — fleet pack table, hottest-pack flag, full per-pack thermal
  and electrical detail.
- **Predictive Insights** — anomalies (peer-comparison, self-baseline),
  forecast alerts (runtime, low-solar, low-SoC dip, soiling), and a deep
  per-pack **capacity-fade → end-of-life projection** with regression-derived
  confidence band, cycle intensity, fade-per-100-cycles, lifetime throughput,
  and a fleet peer-outlier flag.
- **Telnet control-room TUI** on port 2323 — 9 screens, NAWS-adaptive, with
  the same EOL projection surfaced inline on the Battery screen.
- **Alerts & history** — threshold + learned alerts, cleared-anomaly log
  persisted in memory, optional **ntfy / Pushover / webhook** push notifications.
- **Persistence** — SQLite history at `/data/ecoflow.db` on HA's persistent
  volume; survives add-on rebuilds and host updates.

### Configuration
- All EcoFlow / MQTT / notification / weather settings exposed as typed
  HA add-on Options — no `.env` editing on the Pi.

### Supported architectures
- `aarch64` — Raspberry Pi 4 / Pi 5 on 64-bit Raspberry Pi OS (the
  modern default), and any other ARM64 HA host.
- `amd64` — for x86 HA hosts and testing.
