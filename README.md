# Power — time-of-use arbitrage planning, forecasting, battery analytics and life-safety alarms for grid-tied EcoFlow homes that run with or without the grid

**Power** (Home Assistant add-on, slug `ecoflow_panel`) is an independent, open-source analytics
and planning system for a cloud-only, grid-tied EcoFlow home that runs with or without the grid —
a Smart Home Panel 2 and its Delta Pro Ultra Cores. It runs **more than 40 engines** in six
groups (forecasting, battery and PV health, energy economics and time-of-use arbitrage, alarms
and safety, learning and anomaly detection, and telemetry integrity), each a model, estimator,
planner, controller or detector with a stated method and a consumer that reads its output, and a
**battery-depletion life-safety alarm** sits at its center.
The [engine index](docs/reference/A-feature-inventory.md#a13-engine-index) lists every engine with
its method, its status (live, opt-in, advisory-only or write-capable behind a mode gate) and its
anchor in the code.

Solar is a per-hour-of-day least-squares response to forecast irradiance, learned from the home's
own array, with a recursive Bayesian posterior of the same coefficient; load is a
recency-weighted hour-of-day curve with mined EV sessions added; together they drive a
P10/P50/P90 band over solar and state of charge, whose width is checked against its own realized
error and narrowed, never widened, once 14 days are scored; 21 equal-probability quantile paths
give the chance of holding the reserve and of reaching full. Pack health
is an OLS fade regression to end of life behind a recalibration-staircase detector, with
internal-resistance trend, coulombic and round-trip efficiency, charge-curve drift and
thermal-event counts beside it. Anomalies are scored as robust median/MAD z-scores: pack, board
and MPPT temperatures and each panel circuit's load against their own hour-of-day baseline, and
packs and Cores against their siblings. A two-state Kalman SoH filter, hierarchical Bayesian
pack-SoH shrinkage, a Mahalanobis novelty score and an online-trained logistic pack-risk model
are published on the HTTP API as diagnostics; none of them acts.

**Forecast → plan → scored ledger, with an opt-in guarded write.** Every 30 minutes a
**night-charge planner** walks the battery pool hour by hour through the coming cheap window of a
time-of-use tariff (APS R-EV built in; another described by `TARIFF_PLAN`) to the start of the
next one, up to four days ahead, on P10 solar, P90 load and any predicted EV session at its P90
energy. It solves the grid buy by bisection so the pool holds its reserve floor plus an outage
cushion: by default, the energy to run the panel's backup circuits at 1.25 × their measured 7-day
mean load through a 4-hour outage. A `cost` objective fills further toward a solar-headroom or
state-of-charge ceiling; it does not price. Every recompute is published, and each evening's plan
of record is frozen in a never-pruned ledger and scored against metered PV, load, grid import and
the energy delivered into the packs; bounded calibrations learn from that record, and a
fail-closed readiness gate grades it. By default the night charge writes nothing to the devices.
With `NIGHT_CHARGE_MODE` set to `supervised` the add-on performs at most one announced,
cancellable reserve write per charge night, clamped to 10–50%, verified by readback and restored
before on-peak, and with the `cost` objective a just-in-time force charge can carry the pack
further; `auto` behaves exactly as `supervised`. Under the `cost` objective a winter mid-day
super-off-peak charge is sized and scored in shadow only. Whatever the objective, a greedy and a
dynamic-programming dispatch planner publish recommendations on the HTTP API that are never
applied.

When the pool is projected to reach its reserve floor — or a battery, cell, grid or telemetry
condition turns critical — Power raises an alarm on the dashboard and, once `BROADCAST_ENABLED`
is on, an **audible alarm** on the speakers the owner configures: a chime and a spoken
description (English, with an optional Spanish second pass) over Music Assistant and an optional
announce-capable SIP phone, retried when delivery cannot be confirmed. The runway behind it is
an islanded simulation, hours to reserve and to empty if the grid dropped now, on a pool
capacity scaled by the packs' own measured full-charge capacity.

It ingests EcoFlow IoT-Open telemetry (HMAC-SHA256-signed REST polled every 60 s, plus live MQTT)
and checks it before trusting it: a panel payload the cloud keeps replaying and a frozen reading
are kept out of the history, a collapsed message rate or a silent device is detected and
reported, and a removed pack's stale slot is hidden. It persists a per-metric SQLite
time-series. Most engines that scan recorder history, the runway simulator among them, run in
an analytics worker; the threshold alarm evaluation, the night-charge stack (its scorer and
learners read the recorder there) and the telemetry-integrity detectors run on the main thread.
Results are served four ways: a **web dashboard** (React + Tailwind CSS 4, also in the Home
Assistant sidebar through Ingress), a **control-room TUI** (in the browser, and over SSH once
`SSH_ENABLED` is on), opt-in **Home Assistant MQTT-discovery entities**
(`MQTT_DISCOVERY_ENABLED`; about 100 sensors, binary sensors and alarm-priority switches, plus a
power and an energy sensor for every Smart Home Panel 2 circuit; the energy counters feed the
Energy Dashboard), and opt-in **Home Assistant notifications** with companion-app push.

Every change ships through the test suite, and a guard that a plausible refactor could silently
disarm is held by a committed mutation harness: **131 harnesses** holding
**3808 anchor-asserted mutants**. The harness, mutant, test and reference counts, the engine
floor and group counts, and every engine-index row's code anchor are checked against the tree in
CI ([Quality & accuracy](#quality--accuracy)).

The reference deployment is a grid-tied home in Phoenix, AZ: an EcoFlow **Smart Home
Panel 2**, three home **Delta Pro Ultra** battery/inverter Cores (5 packs each:
15 × 6.144 kWh = **92.16 kWh nameplate**, the pool the panel itself reports — the
inverter units add no capacity), a **42-panel / ~16.8 kW** array, and an EVSE —
on the APS R-EV time-of-use rate. Two further Cores sit off the panel as bench
spares: they are monitored, but are not part of the backup pool. These are the
built-in values; another home sets its own tariff, array, devices, EV charging and
plant limits as options, each left unset keeping the built-in value, and the site
clock follows Home Assistant's time zone unless `SITE_TIMEZONE` names another
(America/Phoenix only when neither is set)
([setting Power up for your home](docs/guide/your-home.md)). `GET /api/site`
reports the site clock, coordinates, currency and PV array in force.

> 📖 **Documentation.** The operator guide, [`ecoflow_panel/DOCS.md`](ecoflow_panel/DOCS.md),
> is what Home Assistant shows on the add-on's Documentation tab: setup, what an alarm means
> and what to do, what Power writes to your devices, options by goal, and troubleshooting.
> Every option is in [`docs/guide/options.md`](docs/guide/options.md) and every Home
> Assistant entity in [`docs/guide/entities.md`](docs/guide/entities.md). The
> [engineering reference](docs/reference/README.md) (~12,700 lines in 19 reference files)
> documents **every** feature and engine — what each does, the exact algorithm and math it
> computes, how data traces through the pipeline, its endpoints/sensors, config knobs, and
> edge-case guards. This README is the tour; the reference is the manual.
>
> 🖨️ **Offline / printable:** a single-file **`.docx` and `.pdf`** build is attached to every
> [GitHub Release](https://github.com/tesseractAZ/power/releases). It holds this README, the
> operator guide with its setup, option and entity pages, `SECURITY.md` and the whole engineering
> reference, and a link between them jumps within the document. Nothing in the frozen
> [`docs/history/`](docs/history/) is printed, and the PDF's
> table-of-contents page is empty for now. Regenerate locally with
> `python3 -I -B scripts/build-docs-docx.py` (needs `pandoc`, which CI installs from a pinned,
> sha256-checked upstream release; the PDF additionally needs LibreOffice).

---

## Engines

An engine here is a unit with its own model, estimator, planner, controller, detector or alarm
evaluation whose output something reads: an alarm, a plan, a device write, a Home Assistant
entity, an API field or a dashboard card. Gates and filters that only pass or block another
engine's output are not counted, nor are caching and transport; a rule ladder over another
engine's output counts as part of that engine, and one algorithm counts once however many reports
call it. The
[engine index](docs/reference/A-feature-inventory.md#a13-engine-index) lists every engine with its
method, status, thread and code anchor, and CI fails when a row's file no longer declares its
anchored identifier in code; a mention left in a comment or a string does not count.

| Group | Engines | Examples |
|---|---|---|
| Forecasting | 8 | Per-hour least-squares irradiance→PV response with a recursive Bayesian posterior; recency-weighted load curves; a P10/P50/P90 solar and SoC band, narrowed (never widened) to its realized error, with 21 quantile paths for the reserve and full-charge probabilities; a forecast-skill hindcast with PV bias correction; EV-session mining and live-session detection; an ambient-coupled pack thermal forecast; a clear-sky physics ceiling (API) |
| Battery & PV health | 17 | OLS fade regression to end of life; a two-state Kalman SoH filter and hierarchical Bayesian shrinkage (API); self-validating coulombic efficiency; round-trip efficiency; charge-curve fingerprint; internal-resistance trend; thermal-event counting; soiling, shade, clipping and SoC-saturation curtailment; MPPT and standby-floor drift; LFP OCV→SoC (API); a pack-risk heuristic and an online-trained logistic regression (API) |
| Energy economics & arbitrage | 11 | The night-charge planner, its outcome scorer and its write-readiness gate; a reserve writer, a just-in-time force-charge controller and a Charge Now responder, each write-capable only behind options whose defaults never write; on-peak grid-to-battery and idle-pool detectors; energy-flow attribution with time-of-use cost accounting; greedy and dynamic-programming dispatch planners (API) |
| Alarms & safety | 11 | The islanded runway and projected-SoC simulator; the backup-pool SoC ladder; grid-backstop evidence fusion; threshold, cell-spread and defective-pack alarms; runtime and cell-imbalance trend alarms; host health; a second panel's runway; a load-shed advisor (advisory) |
| Learning & anomaly detection | 7 | Hour-of-day self-baselines (median/MAD); peer fade-rate and pack peer outliers; string mismatch; Mahalanobis pack novelty (API); an alarm-flood auto-tuner for pushes; the night-ledger calibration learners |
| Telemetry integrity | 8 | A telemetry-blind detector with a remediate-first hold; a message-rate floor with a budgeted session self-heal; frozen cloud-payload and frozen-row detection; gap and outage detection; removed-pack detection; the dark-Core energy bridge; settings drift |

Most engines are **live**: computed by default and feeding an alarm, a plan, a dashboard card or
another engine. A few reach only a channel that is off by default (`BROADCAST_ENABLED`,
`NOTIFY_CHANNEL`, `MQTT_DISCOVERY_ENABLED`). Those marked **(API)** or **(advisory)** are
computed and published but never acted on by the add-on. The three write-capable engines sit
behind mode gates; none of them starts a write under the shipped defaults, though a restore that
undoes an earlier write of its own still runs. The counts follow the index's definition; the
floor stated above holds even under the index's strict reading, which keeps only core engines
and drops the advisory-only ones.

---

## Screenshots

Rendered by the add-on's own web UI from a **synthetic fleet**: three DELTA Pro Ultra Cores
behind one Smart Home Panel 2, an EV charger and two accessory devices, one of them offline.
[`scripts/screenshots/`](scripts/screenshots/) serves the fleet at a fixed clock (a June midday
in the default site zone). Serial numbers are placeholders, circuits carry the panel's default
names and every figure is synthetic; no image shows a real installation. After
`npm --prefix web run build`, `(cd server && node --import tsx ../scripts/screenshots/capture.mts)`
re-captures all five. It writes no image when the page asks for an endpoint the fixture does
not serve, when the page's text holds a serial that is not a placeholder, or when the page's
text or an OCR read of the image holds a device name ending in a hyphen and four digits.

| | |
|---|---|
| [**Dashboard**](docs/screenshots/dashboard.png) — outage runway, energy-flow sankey, the SHP2 and every DPU Core with per-pack state, 24 h forecast, and the clustered-incident digest | [**Solar**](docs/screenshots/solar.png) — per-Core PV, the learned GHI→PV response model, and weather-normalised soiling |
| [**Battery**](docs/screenshots/battery.png) — per-pack state-of-health, end-of-life projection, internal-resistance trend and cell-spread | [**Strategy**](docs/screenshots/strategy.png) — tonight's night-charge plan, EV-window prediction, load-shed order and the TOU charge schedule |
| [**Alerts**](docs/screenshots/alerts.png) — the alert board: standing conditions by priority, the Core and pack each one concerns, and its outcome buttons; the Learned, Cleared and Alert Settings views sit behind it | |

[![Dashboard](docs/screenshots/dashboard.png)](docs/screenshots/dashboard.png)

---

## What it does — at a glance

**Telemetry & history**
- Reverse-engineered EcoFlow cloud MQTT ingest (per-SN raw merge across `cmdId`
  1/2/4/21/28) merged with a 60-second signed REST poll → a unified snapshot for
  every DPU Core, the Smart Home Panel 2 and the EVSE — including
  **SHP2-attributed data for Cores whose Wi-Fi is down**.
- **One or two Smart Home Panels.** The panel on the account at first start is
  recorded as the house panel; a panel added later never takes over, and the role
  never moves by itself. Every alarm, sensor and night-charge write resolves to the
  house panel.
- **The cloud is not taken at its word.** A 200 OK that replays a stale copy of the
  last reading is detected and published as stale, a frozen panel reading reads
  `unknown` in Home Assistant rather than as live values, and a cloud "offline" flag
  on a Core whose own data is still arriving is held for at most 3 minutes before it
  is announced. A device's readings are recorded only while they are fresh, so a Core
  left offline in the cloud leaves a gap in its history, not its last reading repeated.
- SQLite time-series (adaptive interval + value-epsilon dedup; retention set by
  `RECORDER_RETENTION_DAYS`, default 30 days, 7–3,650 accepted) and monotonic
  lifetime-energy accumulators wired into the HA Energy Dashboard. The night-charge
  ledger and lifetime totals are never pruned.

**Forecasting**
- Per-hour-of-day **GHI→PV response model** (OLS, brightness/sample-gated) fed by
  Open-Meteo, with an opt-in NWS cloud ensemble, plus a **recursive Bayesian** variant.
- Day-ahead PV + load + **projected state-of-charge** curve, a self-calibrating
  **P10/P90 probability band**, a multi-day horizon (3 days by default, up to 7),
  and a **forecast-skill** backtest (predicted-vs-actual daily kWh: MAE, bias, r²).
- A **first-principles clear-sky** PV ceiling and a realized ÷ theoretical score (API); nothing
  compares it with the learned model automatically.

**Battery & PV health engines**
- Per-pack **State-of-Health** fade regression (OLS, with a Kalman-filter track on the API),
  **end-of-life** projection (capped at a plausible fade rate to suppress false end-of-life
  dates, regressed over the configured retention clamped to 120–365 days),
  **hierarchical-Bayesian** pack-SoH shrinkage with 2σ outlier detection (API), and an
  **LFP open-circuit-voltage → SoC** estimate gated on pack rest (API).
- **Pack-risk** scoring (a heuristic score, and an advisory v2 that adds an online-trained
  logistic regression and a Mahalanobis novelty track; both on the HTTP API only),
  **internal-resistance** trend, **round-trip** and **coulombic**
  efficiency, **charge-curve** fingerprinting, ambient-coupled **thermal
  forecast** + event counter, **string-mismatch**, and per-Core weather-
  normalized **PV soiling** decomposition.
- A **confirmed-defective-pack** latch that follows the pack's serial, not its
  slot, and a **warranty evidence export**.

**Energy economics & time-of-use arbitrage**

The night-charge pipeline chains the forecasting engines into a sized, guarded and scored plan.
Every 30 minutes:

1. **Inputs are shaped to the worst case.** P10 solar comes from the calibrated probability
   band; P90 load is the day-ahead load curve scaled by a band factor learned from the ledger.
   Past 24 hours both are widened by the band's realized daily error × √(days ahead), and a
   predicted EV session is laid down at its P90 energy.
2. **The pool is simulated hour by hour** on its DC bus (pack + PV − load ÷ discharge
   efficiency, clamped to empty and full) from now, through the coming cheap window, to the
   start of the next one, up to four days ahead, so the hours after the window closes, and a
   weekend or holiday gap, are planned as one stretch. Each charging hour is capped by
   the Cores' charge rate and, where a grid-input limit is set, by that limit less the house
   load, so an overnight EV charge lowers the promised lift instead of being ignored.
3. **The buy is solved, not estimated.** Each solve is a 48-step bisection against a
   re-simulation of the pool, and a plan runs up to three: the resilience lift (against the
   trough), the cost target (against the pack at window close) and the reserve setpoint (the
   pack level at window close whose trough holds the line). The plan names the cap that bound
   it — the requirement, charge power, EV contention, pool headroom or the over-buy ceiling — and
   flags any shortfall against the cushion.
4. **Two figures are disclosed:** the worst-case buy the plan is sized on, and the median-case
   energy the night is expected to draw.
5. **Basis gates hold a thin plan.** No buy is sized on a missing or climatology-only forecast,
   with fewer than 14 scored calibration days, or with band coverage under 78%; a start-up data
   gap defers the evening decision instead of cancelling it.
6. **Every night is scored** once its window, the hours after it and the on-peak it governed
   have been metered; the ledger feeds the calibrations and the readiness gate.

The bullets below give the rate basis, the tariff model, the write modes and their guards, the
objectives, the ledger, and the planners that only advise.

- Self-consumption decomposition (solar fraction, PV→load/battery), carbon
  accounting, time-of-use tariff + cost, and clipping/curtailment. The cost
  engine and the dispatch planner share one resolved rate basis — an explicit
  override, else a **confirmed** seasonal utility table, else a flat default.
  An unconfirmed table is refused rather than assumed, and the basis in force is
  published alongside the numbers.
- **Tariffs as data:** `TARIFF_PLAN` picks a flat, two-tier or custom tariff (periods,
  rates, seasons, holidays, currency), or the built-in **APS R-EV** preset, the default,
  modelled as the bill states it: on-peak 16:00–19:00 and overnight
  23:00–05:00 Mon–Fri year-round, a 10:00–15:00 super-off-peak in winter, off-peak
  otherwise. Seasons follow **billing cycles** (by usage month, April–September
  summer and October–March winter), and the schedule's **off-peak holidays** are
  off-peak all day. Rates are owner-entered from a bill and stay null until
  confirmed; a tariff that does not parse is never replaced by the preset: every
  rate reads unknown, the cost figures fall back to the flat rate, the planner
  holds and a repair issue names the option.
- A **night-charge TOU-arbitrage engine** with an owner-selected write posture
  (`NIGHT_CHARGE_MODE`):
  - **`advisory`** (default) — never writes. Tonight's plan is published as HA
    entities, an API, an evening notification (21:30 site time by default) and the
    dashboard's night-charge card.
  - **`supervised`** — one announced, cancellable, bounded reserve write per charge
    night: armed only after an announcement channel confirms delivery, clamped to
    the panel's 10–50% reserve range, readback-verified on both the apply and the
    revert, restored at the window close (an hour before on-peak at the latest)
    or at once on a cancel or a grid loss, and audit-logged. Nothing is raised
    within an hour of on-peak or while the add-on's own host is under critical
    pressure (a restore still runs); a restore the panel does not confirm is paged
    as critical, and no later night is armed while the panel still reads the
    raised reserve. With the `cost` objective and `ARB_COST_MAX_SOC_PCT` above 50,
    the panel's own per-channel force-charge then carries the pack past the reserve
    ceiling toward the night's target: it switches on just in time, in the last
    stretch of a night whose reserve write has read back, and off — verified off —
    at the target or the window close.
  - **`auto`** — behaves exactly as `supervised`. Any behaviour of its own must
    branch on a fail-closed readiness gate that graduates only on actuated-night
    evidence (≥21 scored nights, under-buy ≤10%, sizing bias in [0, 5] kWh, band
    coverage 78–92%, zero engine-fault strikes); none exists yet.

  Each night is sized worst-case (P10 solar / P90 load) so the pack holds
  `reserve + outage cushion`, where the **outage cushion is the energy to carry
  the *islanded* load** — the Smart Home Panel's backup circuits — for a bounded
  outage (`ARB_OUTAGE_CUSHION_HOURS`, default 4; 0 disables it, and the plan says
  so). A never-pruned ledger freezes each night's plan of record, scores it
  against metered solar, load, grid import and the energy delivered into the
  batteries, and prices the night's metered import (energy only, not a bill)
  once the tariff rates are confirmed. `ARB_OBJECTIVE` selects the sizing objective:
  **`resilience`** buys exactly the requirement; **`cost`** treats it as a floor
  and fills further toward a solar-headroom or state-of-charge ceiling, so the
  safety margin can never shrink when the objective changes. Cost mode **fills
  further, it does not price** — its sizing reads no rate; see
  [`docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md`](docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md).
- A **winter mid-day charge, in shadow**: with the `cost` objective
  (`ARB_COST_MAX_SOC_PCT` above 50) and a tariff with a `super_off_peak` period
  (the APS R-EV preset's 10:00–15:00 in winter), on the evening before each winter
  weekday the planner also sizes the charge it would make in the next day's
  super-off-peak window, behind an overnight
  outage backup, and re-checks it on the morning forecast. It is published
  (Midday-Charge entities, a read-only section of the night-charge card, the log)
  and stored on the night's ledger row to be scored against the day; nothing is
  armed, written, pushed or spoken for it.
- A **Charge Now responder** notices the app's force-charge buying grid power
  on-peak and advises (default) or, when set to `supervised`, switches it off.
- Two advisory round-trip-aware dispatch planners (greedy + a model-predictive
  DP) and a load-shed advisor — compute-only, never applied.

**Alarms & learning**
- The **safety-critical runway engine**: an hour-by-hour DC-bus depletion sim
  (accounting for the DC→AC discharge loss), grid-aware severity, and a battery-
  SoC floor ladder. Below the reserve floor it says so rather than printing a
  countdown to a crossing already behind it, and while the grid stands by it states
  that every time shown is an **outage** projection, not a live countdown.
- **Cell-spread alarms** per pack: a warning from 24 mV (held down to 20 mV), and a
  critical at 50 mV — 90 mV on the top-of-charge plateau, where LFP cells spread
  naturally — with a 150 mV ceiling that sounds at any charge level. Mutes for an
  actively balancing pack or a top-of-charge knee are bounded in time and fail
  loud. A warning is never spoken and pushes only below 85% charge; a critical is
  pushed and announced at any level.
- **The add-on watches its own sight.** When telemetry stops, it first rebuilds its
  EcoFlow cloud session and only alarms if that remedy fails within a hard
  deadline; a budgeted self-heal also rebuilds a session whose message rate has
  collapsed. Host thermal and vitals self-monitoring, and an optional out-of-band
  dead-man heartbeat, cover the case where the host itself fails.
- Threshold + four families of **learned** alerts (peer-comparison, self-baseline,
  degradation/runtime forecast, solar/load forecast), an alert **monitor**
  (transition debounce, incident clustering, churn auto-silence, quiet hours),
  a **repair-issues** feed, opt-in NWS storm alerts, and an **online learning
  loop** (feature snapshots → realized outcomes → an online-updated pack-risk model, advisory and
  on the HTTP API only).
- **Notifications are Home-Assistant-native** and opt-in: with `NOTIFY_CHANNEL: ha`
  (the shipped default, `none`, sends nothing) every alert becomes a card in the HA
  notification drawer (dedupe + morning digest, dismissed when the condition clears)
  and, for each service named in `NOTIFY_HA_PUSH_TARGETS`, a real push to the
  companion app, with device serials shortened to their last six characters.
  **Critical alerts — and only critical ones — carry the companion app's
  documented critical payload**, so a genuine battery, reserve-floor or grid-loss
  emergency sounds through Do Not Disturb and the silent switch; warnings arrive as
  ordinary pushes that respect the phone's settings.

**Delivery surfaces**
- Audible **broadcast** pipeline: a chime followed by speech rendered locally by
  Piper over Wyoming (no cloud TTS) — English, then Spanish once a Spanish voice is
  set — played as
  Music Assistant announcements with per-target volume pinning, plus an optional
  **SIP** side-channel to an announce-capable phone. A built-in tone library (+ uploads,
  per-level assignment). An announcement whose delivery cannot be verified is
  retried at 30 s, 90 s and 3 min, and a retry re-checks which alarm it names
  before it plays; a failed speech render still plays the chime, and the words
  follow 90 s later.
- **Web dashboard** (Dashboard · Solar · Battery · Strategy · Alerts — the
  predictive sections live on their home pages, and the Alert Console is a
  sub-view of Alerts), built with React and Tailwind CSS 4, served on the LAN and
  through HA Ingress.
- **Control-room TUI** (Plant-Operator console, display-only) over SSH — off by
  default, password login with the console credentials — and in the browser at `/console`.
- **Data out:** a consistent SQLite snapshot published to `/share` for external
  viewers, the vendor's own daily energy ledger exported to HA long-term
  statistics, and a pack warranty evidence bundle.

See the [engineering reference](docs/reference/README.md) for the full, math-level
treatment of each of the above.

---

## Architecture (60-second version)

```
EcoFlow cloud ──▶ snapshot store ──▶ SQLite recorder ──▶ analytics worker
  (REST+MQTT)     (DeviceSnapshot)    (time-series,        forecasting, battery & PV health,
                         │             lifetime accum.,    energy accounting, runway simulator,
                         │             night ledger)       trend and self-baseline detectors
                         ▼                                         │ reports
                  main-thread engines ◀────────────────────────────┘
                  alarm evaluation, grid resolver, telemetry-integrity detectors,
                  night-charge planner → scorer → ledger → readiness gate,
                  gated writers; physics, Bayesian and ML diagnostics (API only)
                         │
                         ├─▶ HTTP API  (:8787)
                         ├─▶ HA MQTT-discovery entities (opt-in)
                         ├─▶ React web UI
                         ├─▶ SSH TUI (:2323, off by default)
                         ├─▶ audible broadcast + HA push (opt-in)
                         └─▶ bounded device writes (opt-in, audit-logged; engine writes
                             readback-verified)
```

Most engines that scan recorder history run **off the main thread** (a worker plus a client
proxy with per-report caching), the runway simulator among them. Threshold alarm evaluation, the
night-charge stack and the telemetry-integrity detectors run on the main thread; the night-charge
planner requests its forecasts from the worker. The
[engine index](docs/reference/A-feature-inventory.md#a13-engine-index) gives each engine's thread;
the recorder schema, report dependency graph, and full data-flow are in
[reference chapter 1 — System Architecture & Data Flow](docs/reference/01-architecture.md#1-system-architecture--data-flow).

---

## Install on Home Assistant (aarch64 or amd64)

For a 64-bit host running Home Assistant OS or Supervised:

1. In Home Assistant: **Settings → Add-ons → Add-on Store**, ⋮ menu → **Repositories**,
   and add `https://github.com/tesseractAZ/power`. **Power** appears in the store, and
   later releases arrive through HA's native **Update** button; continue at step 4.
   Alternatively, install it as a local add-on with steps 2–3: enable the **Advanced
   SSH & Web Terminal** add-on (or use the HA Console) and SSH in.
2. Clone this repo into the local add-ons folder:
   ```bash
   cd /addons      # HA OS default; on HA Supervised: /usr/share/hassio/addons/local
   git clone https://github.com/tesseractAZ/power.git ecoflow-panel
   ```
3. In Home Assistant: **Settings → Add-ons → Add-on Store**, ⋮ menu → **Reload**.
   **Power** appears under "Local add-ons".
4. **Install** — the Supervisor pulls the pre-built multi-arch image from GHCR
   (seconds, not a local build). Open **Configuration**, paste your EcoFlow
   `ECOFLOW_ACCESS_KEY` / `ECOFLOW_SECRET_KEY` and site location, then **Start**. Then
   set what differs from the reference plant: [your home](docs/guide/your-home.md).
5. Open the add-on's **Web UI** (HA ingress), or reach the trusted-LAN data API at
   `http://<host>:8787`. The control-room console is always available in a browser at
   `http://<host>:8787/console`; its SSH transport (`ssh -p 2323 <user>@<host>`, where `<user>`
   is `TUI_USERNAME`, `operator` when empty) is **off by default** — set `SSH_ENABLED: true` and
   a `TUI_PASSWORD` in Configuration first (every SSH login is refused until a password is set;
   the first connection shows the host key fingerprint, which is printed in the add-on log at
   every start).

Every configuration option, with its default and allowed range, is in
[`docs/guide/options.md`](docs/guide/options.md); the operator guide's
[Configuration by goal](ecoflow_panel/DOCS.md#configuration-by-goal) groups them by what you
want to do, and the add-on's Configuration tab shows each one's help text.

---

## Repository layout

| Path | What it is |
|------|-----------|
| `server/` | Node/TypeScript server — ingest, recorder, the engines (forecasting, battery and PV health, time-of-use arbitrage planning and its gated writers, alarms, anomaly detection, telemetry integrity; see the [engine index](docs/reference/A-feature-inventory.md#a13-engine-index)), HTTP API, MQTT discovery, broadcast/TTS, SSH TUI |
| `web/` | React dashboard (Vite) |
| `ecoflow_panel/` | Add-on manifest (`config.yaml`), `translations/`, `DOCS.md` (the operator guide, on the Documentation tab), `README.md` (the Info-tab card), `CHANGELOG.md` (+ archive), AppArmor profile |
| `rootfs/` | s6 service runner (`etc/services.d/ecoflow-panel/run`) — the options→env bridge that turns the add-on Configuration into the server's environment |
| `Dockerfile`, `build.yaml`, `repository.yaml` | Container build, digest-pinned per-arch base images, add-on repository manifest |
| `scripts/` | Docs builder (`build-docs-docx.py`) and CHANGELOG roller (`roll-changelog.mjs`); CI gates (`check-docs.mjs`, `check-doc-claims.mjs`, `check-mutant-anchors.mjs`, `check-npm-audit.mjs`, `check-no-secrets.py`, `check-release-pr.py`, `validate-addon-config.py`); the golden-capture tool for the frozen characterisation goldens in `server/test/golden/` (`golden-capture.mts`); the README screenshot fixture, replay server and capture tool (`screenshots/`); the mutation harnesses (`mutate-*.mjs`); device probes |
| `docs/` | `guide/` (the setup checklist for another home, every option and every Home Assistant entity), `reference/` (the engineering reference: an index and one file per chapter or part), `history/` (the engineering release log, the operations audits, the reference plant's notes and an early section of the performance record, frozen), `PERFORMANCE.md` (measured-accuracy record), `NIGHT_CHARGE_ARBITRAGE_DESIGN.md` (binding design of record for the device-write path), `ble-probe-runbook.md` |
| `.github/workflows/` | `ci.yml` (type-checks ×3, server tests + README-claim check, mutant-anchor check, personal-data scan, dependency advisories, add-on config/translation validation, Dockerfile smoke, docs `.docx`+`.pdf`) · `release-pr.yml` (release-PR version check, re-run on a title edit) · `tag-release.yml` (on every push to `main`: tags the version the add-on manifest declares, or fails when it cannot be published) · `images.yml` (tests, multi-arch GHCR publish, GitHub Release) · `release.yml` (manual dispatch) · `codeql.yml` (CodeQL analysis). Every job runs on a pinned runner image (`ubuntu-26.04`, `ubuntu-26.04-arm`; CodeQL on `ubuntu-24.04` until CodeQL supports 26.04). |

## Development

```bash
cd server && npm install && npm test     # 5,656 tests
cd server && ./node_modules/.bin/tsc --noEmit -p tsconfig.json      # src
cd server && ./node_modules/.bin/tsc --noEmit -p tsconfig.test.json # src + tests
cd web    && npm install && npm run build
```

**Release pipeline.** Bump `ecoflow_panel/config.yaml` + prepend `CHANGELOG.md` (then
`node scripts/roll-changelog.mjs`, which keeps it small for Home Assistant's Changelog dialog) →
open a PR titled `Release vX.Y.Z …` (for a one-commit PR, its commit subject too: GitHub's
squash merge lands a one-commit PR with the commit's subject, not the title). `main` is branch-
protected. CI runs the three type-checks (server, web, server tests), the test suite, the
mutation-harness anchor check, the secrets scan, the dependency-advisory gate, the add-on
config/translation validator, the Dockerfile smoke build, the docs `.docx`+`.pdf` build and
CodeQL on every pull request, and every one of them (with the release-PR version check below) is a
required status check on `main`. Every engine change also clears an **adversarial multi-agent review** before it
can reach the alarm path. Home Assistant offers whatever version `config.yaml` declares on
`main` (a lower one too, as a downgrade), so `tag-release.yml` runs on **every** push to `main`:
when that version is new and above every `vX.Y.Z` tag it creates the tag and dispatches
`images.yml` — that workflow runs the test suite, builds the multi-arch GHCR image and cuts a
GitHub Release (with the docs attached); the add-on then updates in place. Full runbook in
[reference chapter 12](docs/reference/12-configuration-deployment-security.md#release--publish-pipeline).

The release-PR check (`release-pr.yml`, `scripts/check-release-pr.py`, the required check *"Release
PR declares the version it names"*) compares the version before and after GitHub's test merge. It
fails a version change under any title but `Release v<new>`, a `Release vX` title (or one-commit
subject) that changes no version or names another one (v1.130.0 merged that way and released nothing), a downgrade, a reused or lower version
than the highest tag, a version that is not `X.Y.Z`, and a missing CHANGELOG section. An admin
merge can bypass required checks, so after the merge `tag-release.yml` fails the cases it can see
from `main` as a red run: a `Release vX` merge that changed no version, a reused number, and a
version it cannot tag. While `main` declares an older release than the newest one (a revert), every
push and dispatch is red until `main` moves above it. A bump merged under another subject is still
tagged, with a warning.

## Quality & accuracy

This is a life-safety system and is held to that bar. The measured record lives in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md). Engines are cross-validated
against **independent** ground truth — Open-Meteo GHI, first-principles array
physics, energy conservation, and the system's own forecast backtest — with
concrete results tracked over time (daily PV matches independent expectation to
~0–1%; the round-trip efficiency reconciles the conversion losses it should).
The pool capacity the panel reports is the packs' nameplate sum, not a
measurement; each pack's battery-management system measures a full-charge
capacity below nameplate, which [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) §4
records with its date.

The real guardrail is process: **every** change to an engine or the alarm path
ships through green tests **plus** an adversarial multi-agent review that
actively tries to break it. That review earns its keep — e.g. the night-charge
advisor's review caught safety-direction sizing bugs (an under-buy on charging
nights, a truncated weekend horizon) *before* they shipped. New actuation defaults
to advisory; enabling the supervised write is an explicit owner action, and
unattended (auto) operation is earned only through the learning ledger's
actuated-night evidence.

Where a guard is subtle enough that a plausible refactor could silently disarm
it, a **committed mutation harness** proves the tests would catch that exact
regression. Each harness (`scripts/mutate-*.mjs`; the counts are in the opening)
reverts a guard in the live source and requires the suite to kill it. A harness
aborts loudly rather than reporting green if an anchor
stops matching, and `scripts/check-mutant-anchors.mjs` runs in CI for exactly that
reason — a harness whose anchors have drifted does not fail, it stops running, and
an aborted harness reads identically to a clean one. A kill the full suite reports
counts only when its failing tests fail again in their own files, one suite at a
time: a failure under parallel load, or in a known teardown flake, never hides a
survivor.

The counted claims in this README are held to the tree by `scripts/check-doc-claims.mjs` in CI:
the harness, mutant and test counts, the reference size, the workflow roster and the engine
index. Every index row's file must declare the row's identifier in code (a function, class,
constant, type or similar declaration; a mention in a comment or a string does not count), the
index's count sentence (its total, thread tallies, strict reading and that reading's live and
waiting split), this README's per-group counts and its count of write-capable engines must equal
the rows, and the engine floor must sit below the index's strict reading. The same check sweeps
this README, the add-on's README, documentation and configuration, the image labels, the web
manifest and every guide and reference page for the wordings that drifted before: an engine count
that is neither the index total nor this README's floor, an approximate one ("~40", "about 40",
"40+") or one in words, and a sentence that puts the engines as a whole on one thread. The sweep
reads those known wordings, not every possible sentence; `scripts/lib/engineIndex.mjs` lists
exactly what it reads and what it does not. The repository's About description on GitHub sits
outside the tree and is updated by hand.

Dependency advisories are gated by `scripts/check-npm-audit.mjs`, which fails on
**high or critical in the production tree** and reports the rest. Waivers must carry a
reason **and an expiry date**, and an expired waiver fails the build.

*This paragraph used to justify the script by saying GitHub's own alerting was
unavailable — that `/dependabot/alerts` and `/code-scanning/alerts` both returned empty
on a private personal repository. That was true when it was written and is **false now**:
the repository is public, and both endpoints return real data (Dependabot has raised and
closed 33 advisories; CodeQL has 75 alerts, all dismissed or fixed; as of v1.149.0 every
one of the three alert surfaces is at zero open). Nothing failed when it stopped being
true, because a claim in prose about an external system has no mechanism holding it
honest — the same shape as the defects catalogued below. The script's real justification
was never the outage and survives it: **GitHub alerts notify, they do not block a merge.**
The script fails the build, enforces waiver expiry, and runs on every PR rather than on
GitHub's own schedule.* The script **self-tests its own policy before auditing**,
because a clean `npm audit` is indistinguishable from a broken gate unless the gate
has been shown to fire.

The recurring failure this codebase is built against is **silence that looks like
health**: a detector whose gate can never be true, a release that never ran, a
status field computed and then published in a shape nothing can consume. Empty
states are therefore required to say *which* empty they are — `blockedReason`,
`arm_disposition`, `cost_ceiling_basis`, `CushionBasis` — rather than rendering
blank. `docs/PERFORMANCE.md` §6 keeps a standing register of what is currently
inert or unreachable, so a quiet reading is not mistaken for a healthy one.

## Security

See [`SECURITY.md`](SECURITY.md) for the vulnerability-reporting policy and the
security posture: an AppArmor profile narrowed to two capabilities and the socket
types in use; device writes off by default (`NIGHT_CHARGE_MODE: advisory`) and,
when enabled, bounded, announced and audit-logged; every write endpoint behind
Ingress, same-origin or token authorization; the SSH TUI off by default and
refusing every login until a `TUI_PASSWORD` is set (the same read-only console is
served at `/console`, behind that login once one is set); secrets handled presence-only (never logged or echoed); and a
supply chain held by SHA-pinned actions, a digest-pinned base image, a
dependency-advisory gate and a CodeQL gate.

## Trademarks

Power is an independent open-source project. It is not affiliated with, endorsed by or
sponsored by EcoFlow. EcoFlow, Smart Home Panel 2 and Delta Pro Ultra are trademarks of their
respective owners and name only the hardware Power works with. The add-on's slug
(`ecoflow_panel`), image name and MQTT topics keep their original names, because renaming them
would break existing installs.

## License

[MIT](LICENSE) © Eric Paschal
