## Appendix A — Feature Inventory (evidence linkage)

Purpose: a pruning-oriented ledger of every substantive feature/engine, what math it runs, which field signals feed it, and — decisive for keeping it — **what actually consumes its output**. Consumer columns were verified by grepping the pinned source revision (`git grep … HEAD -- server/src web/src`), not by reading intent from comments. Evidence status is one of:

- **measured-and-active** — output is consumed by at least one live surface (alarm, HA sensor, UI card, TUI screen, or another engine) and the math has operated on real field data.
- **data-gated (…)** — wired and correct, but a stated gate holds the output at `null`/inactive until the field record satisfies it; the parenthetical names what unlocks it.
- **advisory-dormant** — deliberately advisory or deliberately not wired (documented posture, not an accident).
- **weak-linkage candidate** — no consumer beyond its own ad-hoc endpoint, or math that has never received field validation; one-line justification given. These are the removal-review set collected at the end.

Diagnostic endpoints with a documented validation role (e.g. the forecast backtest) are not flagged merely for lacking an automated consumer; endpoint-only engines with no validation role are.

### A.1 Ingest, storage & threading (§1, §2)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| `SnapshotStore` dual-schema ingest | Two caches (REST `rawBySn`, MQTT `mqttFlatBySn`), single `change` fan-out with `frameSeq` (§1.1, §1.3) | REST `/device/list`+`/quota/all` (60 s poll); MQTT `/open/{user}/{sn}/quota`,`/status` | recorder, analytics worker, `/ws`, alert monitor, MQTT discovery — every downstream | measured-and-active |
| DPU MQTT→REST translation | `translateDpuMqtt()` cmdId schema → `hs_yj751_*` quota shape; only DPUs drive live projection from MQTT (§2) | DPU cmdId frames (`bpInfo[].*`) | `SnapshotStore` projection refresh | measured-and-active |
| Product projections | `projectByProduct()` → typed dpu/shp2/generic `Projection` (§2) | Raw quota maps | Every engine, UI, sensors | measured-and-active |
| Backup-pool grace-hold + slew guard | `backupPoolWithGraceHold` holds last-good pool through transient nulls; slew-limits implausible jumps (§2) | SHP2 `backupIncreInfo.*` (aggregate `backup{Remain,FullCap}Wh`, `backupBatPercent`) | Runway, SoC alarm, HA `backup_pool` sensors | measured-and-active |
| SQLite recorder | `record(extract(snap))` with dedupe/heartbeat, retention, WAL; read-only worker twin `readRecorder.ts` byte-parity-tested (§1.4) | All projected metrics | Every history-driven engine | measured-and-active |
| Lifetime accumulators | `rollupLifetime()` monotonic Wh counters; micro-dip clamp `clampLifetimeDip` (§1.4.6, §7.2). The steady-state RTE clamp this row used to name was removed in v0.45.0 — `charge == discharge` is NOT an invariant (see §1.4.6) | `pv_total`, `panel_load`, `ac_in`, `grid_home_w`, pack in/out | `/api/lifetime-energy`, HA Energy Dashboard `*_lifetime_kwh` | measured-and-active |
| Telemetry-gap detection | Recorder gap scan → outage/gap events (§1.4.7) | Sample timestamps | `/api/telemetry-gaps`, `outageAlerts()`, HA `system_outage_*` / `system_telemetry_gap_count_24h` / `system_device_gap_count_24h` | measured-and-active |
| Trapezoidal integration | `integrateWh` gap-aware trapezoid; shared day-boundary endpoint (§1.5, §7.0.1) | Any W-metric series | selfConsumption, RTE, tariff, carbon, totals, circuit history | measured-and-active |
| Analytics worker + report registry | Worker thread, `BUILDERS` registry, coalesce + TTL cache, `WARM_REPORTS` self-warm (§1.6, §1.8) | — (infrastructure) | All `/api/<report>` routes, MQTT state, TUI | measured-and-active |
| `lastUpdated` freshness contract | SHP2 MQTT chatter must not touch the freshness clock; REST owns non-DPU freshness (§1.7) | Message arrival times | Staleness alerts, grace-holds | measured-and-active |

### A.2 Cloud protocol & HA wiring (§2)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| REST client + HMAC signing | `ecoflow/sign.ts` HMAC-SHA256 request signing (§2) | Cloud credentials (env) | Poll loop | measured-and-active |
| MQTT client (`param`-not-`params` fix) | Per-device quota/status subscription; corrected payload key (§2) | Broker frames | Ingest | measured-and-active |
| SHP2 membership + spare roster | Core↔SHP2 from `backupIncreInfo.Energy{1,2,3}Info`, not positional; explicit spare-SN allowlist (§2, §8.8) | SHP2 energy-info slots; `SPARE_DPU_SNS` env | Zombie gate, selfConsumption scope, degradation peer baselines | measured-and-active |
| Cloud-wedge vs outage classifier | `deviceLink.ts` pure classifier: LAN-reachable + cloud-silent = wedge, both-dark = outage (§2) | LAN ICMP ping, MQTT/REST freshness | Offline alerts, HA `ecoflow_cloud_wedge_count` | measured-and-active |
| HA service layer | `haService.ts` `callHaService` — total, never throws (§2, §10.10) | HA supervisor API | Broadcast, shed registry, hostPower, haStateCache | measured-and-active |
| MQTT discovery entity set | 78 sensors + 10 binary sensors in the static tables, plus two per-circuit sensors (energy and power) and the four per-priority alarm switches, availability + expiry, honest-null templating (§2) | `buildState()` composition | Home Assistant | measured-and-active |
| Energy Dashboard counters | `total_increasing` lifetime kWh set incl. dynamic per-circuit discovery (§2) | Lifetime accumulators | HA Energy | measured-and-active |
| Alarm-priority switches | Bidirectional `switch` per ISA priority; `parseAlertSwitchCommand` no-op on unknown payload (§2) | HA command topic | `alertSettings`, alarm gating | measured-and-active |
| `refreshShp2CloudPresence` write | One of the audited device writes. The others are the night-charge reserve write, force-charge and its `foceChargeHight` ceiling (§15.8b), the Charge Now responder's OFF, and the owner `/api/reserve-floor` write; audited (`writeLog.ts`), rate-limited, `requireWriteAuth` (§2, §12) | Operator action | Web `RefreshCloudButton`, cooldown endpoint | measured-and-active |
| `debugSendCommand` | Arbitrary-command escape hatch; off unless write-debug env + token (§2, §12) | Operator action | `/api/device/send-command` | advisory-dormant (disabled by default, by design) |

### A.3 Solar & PV forecast (§3)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| GHI→PV response model | Per-hour through-origin OLS `β = Σ(pv·ghi)/Σ(ghi²)`; `peakCoeff` gated on GHI ≥ 300 W/m² + ≥3 samples (§3.1) | Recorder `pv_total`, Open-Meteo GHI | `getDayForecast`, `SolarResponseCard`, backtest | measured-and-active |
| Full-coverage fitting gate | `fullCoverageFleetPv` excludes cloud-gap hours from fitting (§3.1) | Per-Core coverage | Response model | measured-and-active |
| Day-ahead forecast | Per-hour `forecastPvW`/`forecastLoadW`; PV bias correction; structural-incompleteness gate; restored display basis (§3.2) | Response model, weather, load history, EV prediction | Runway, runway/forecast alarms, HA sensors, cards, TUI, calendar, MPC | measured-and-active |
| PV bias correction | `pvBiasFactor = Σactual/Σpredicted` multiplier (§3.3) | Forecast vs recorded PV | Day-ahead forecast, `/api/confidence` | measured-and-active |
| EV-window prediction | `computeEvWindowPrediction` expected-value `evLoadByHour`; subtracted from the alarm load (safety invariant §5.1.5) | EVSE circuit history | Forecast load, runway (subtraction), calendar, insights cards | measured-and-active |
| Forecast skill | Day-level replay MAE/bias/r² over covered days (§3.4) | Forecast archive vs actuals | Probabilistic band calibration, `/api/confidence.forecastDayR2`, repair issues, insights | measured-and-active |
| Confidence snapshot | Medians of engine r² + forecast bias/MAE (§3.5, §8.10) | degradation, thermal, skill reports | `/api/confidence`, insights cards | measured-and-active |
| Probabilistic P10/P90 SoC band | Per-hour sigma + coherent SoC ensemble; F30 self-calibrating shrink over `PV_BAND_CAL_WINDOW_DAYS = 30` (§3.6) | Forecast + skill | `/api/forecast/probabilistic`, MPC P10 envelope | measured-and-active; band **calibration** data-gated (needs ≥14 scored days in the 30-day window) |
| Multi-day horizon | `computeMultiDayForecast` extends PV/SoC 2–3 days on typical-day curves (§3.7) | Forecast + weather | `/api/forecast/multi-day` **and** the night-charge planner (`index.ts` requests it at `days: 4` and maps it into `dayRollups`) | measured-and-active |
| Open-Meteo ingestion | GHI + temp hourly fetch, cached (§3.8) | Open-Meteo API | Forecast, curtailment, thermal, shade | measured-and-active |
| NWS NDFD ensemble | Opt-in second cloud source + disagreement metric (§3.8) | NWS NDFD (`NWS_ENABLED`) | `/api/weather/ensemble`, insights cards | data-gated (off unless `NWS_ENABLED`) |
| NWS storm alerts | CAP alert fetch → alert/calendar/broadcast context (§8.3.4) | NWS CAP feed | `forecastDayAlerts`, calendar, insights cards | data-gated (off unless `NWS_ENABLED`) |
| Forecast backtest | `backtestPvForecast` RMSE/MAE/bias/R² replay incl. the alarm-facing predictor (F24) (§1.8) | 168 h recorder actuals | `/api/backtest/forecast` (operator-invoked validation harness) | measured-and-active (validation instrument; no automated consumer by design) |

### A.4 Physics & Bayesian tier (§4)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Clear-sky PV model | Solar geometry → `clearSkyGHI` → POA → cell-temp derate → `physicsPmax`; `physicsScore = realized/theoretical` (§4.1) | Site constants, ambient temp, live PV | `/api/physics/pv-pmax` only (referee role is manual; `PHOENIX_SITE.pNamplate` is separately load-bearing in `BAYES_OBS_SIGMA2`) | **weak-linkage candidate** — no automated cross-check consumes `physicsScore` |
| LFP OCV→SoC + rest tracker | OCV lookup on rested packs (`REST_CURRENT_THRESHOLD_A = 0.5`, 60 s tick) → `socDriftPct` vs BMS (§4.2) | `bmsMaster` volts/amps per pack | `/api/physics/lfp-soc` only | **weak-linkage candidate** — drift feeds no alarm/engine; tick runs regardless |
| Hierarchical Bayes pack SoH | Partial pooling `fitHierarchical` + `findOutliers(z ≥ 2.0)` (§4.3) | Per-pack SoH cross-section | `/api/models/hierarchical-pack-soh` only | **weak-linkage candidate** — endpoint-only; near-new fleet has produced no outlier to validate against |
| Recursive Bayesian solar model | Per-hour Gaussian posterior over GHI→PV slope with `agreementWithOls` (§4.4) | Recorder pv/GHI pairs | **Curtailment expected-PV** (`predictExpectedPv`), `/api/forecast/bayesian` | measured-and-active |
| Kalman SoH filter | 2-state constant-velocity filter (`R = 0.05`) run side-by-side with OLS fade; mirrors every OLS gate (§6.8) | `sohPts` per pack | `kalman*` fields inside `/api/degradation` | measured-and-active (parallel diagnostic inside a consumed report) |

### A.5 Runway, depletion & SoC alarms (§5) — safety-critical

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Runway depletion simulation | DC-bus drain `delta = pv − runwayDrainW(load)` (`max(load/η, overhead + load/η_m)`) on the packs' measured capacity (v1.187.19), interpolated reserve/empty crossings, 4 h observed-load `max()` blend, 50 W degenerate-curve guard (§5.1) | SHP2 pool fields, `panel_load` history, day-ahead forecast, `backupReserveSoc` | Audible alarm, HA runway sensors, `RunwayCard`, fleet-card, TUI, shed advisor | measured-and-active |
| Empty hysteresis | `applyEmptyHysteresis` de-flaps the published hours-to-empty (§5.1.6) | Raw crossing | Published runway | measured-and-active |
| Runway severity ladder | `classifyRunway(p, grid)` bands + grid-aware null while backstopping; islanded re-escalation (§5.2) | Runway + grid backstop | Alarm state machine, shed advisor, TUI banners | measured-and-active |
| Runway alarm state machine | `createRunwayAlarm` edge-triggered spoken alarms (§5.2.4) | Severity band | Audible path, notify | measured-and-active |
| Battery-SoC floor alarm | Ladder 50/40/30/20/15/10/8/4/2 % with arming hysteresis + coherence guard (% vs `remainWh/fullCapWh`) against transient zeros (§5.3) | `backupBatPercent`, pool Wh | Audible path, HA alert counts, banding helpers | measured-and-active |
| SHP2-blind failover | Fleet-median DPU SoC drives the ladder when the SHP2 aggregate is absent (§5.3.7) | Per-DPU `soc` | SoC alarm | measured-and-active |
| Grid backstop resolver | `resolveGridBackstop`/`liveGridBackstop` combine `gridSta` (0/1/2), grid watts, staleness fail-safe; `backstopping` stricter than `present` (§5.4) | SHP2 `pd303_mc.masterIncreInfo.gridSta`, `grid_home_w` | Alarms, `off_grid` sensor, lighting posture, TUI, analytics | measured-and-active |
| Grid-aware SoC dispatch | `socGridCrossDecision` downgrade on-grid + `reEscalateGridDrop` on islanding (§5.4.5) | SoC bands + backstop | SoC alarm tick | measured-and-active |
| Load-shed advisor | Upper-bound counterfactual `computeRunwayWithShedOffset` (`shedKw/η` on pool basis); recommends only in actionable band with ≥ 0.25 h benefit (§5.5) | Runway, HA entity watts (`haStateCache`), SHP2 circuits | `load_shed_recommended*` sensors, `/api/load-shedding/status`, `runway_to_reserve_if_shed_hours` | data-gated (inactive until `LOAD_SHEDDING_SHED_ENTITIES` allowlist is configured; advisory-only by design) |
| Load-shed registry | Candidate composition: SHP2 circuit → HA sensor → estimate; phantom-entity flagging (§5.5) | Allowlist + HA states | Shed advisor, StrategyPanel/TUI priority displays | data-gated (same allowlist) |

### A.6 Battery & PV health (§6)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| SoH fade + EOL projection | OLS fade `−slope×YEAR_MS` ±1 SE, Arrhenius `2^((T−25)/10)`, 7-state gate chain, `EOL_SOH = 80` (§6.1) | `actSoh`/`soh`, `pack{n}_temp`, cycles | HA `..._soonest_pack_eol`, `DegradationCard`, battery-card, TUI, pack-risk, confidence, repair issues | measured-and-active; dated EOL data-gated (fade gates on near-new fleet — `unknown` by design) |
| Peer fade comparison | Robust median+MAD z on projecting, connected packs; spares scored, never baseline (§6.1) | Fade rates | Degradation summaries | data-gated (needs ≥3 projecting packs) |
| Coulombic efficiency (F17) | 7-day counter-edge ratio with span/full-window/consistency triple gate (§6.2) | `pack{n}_lifetime_{chg,dsg}_mah` edges | `coulombicEffPct` in degradation; pack-risk feature 3 | data-gated (all three F17 gates; null on current counters by design) |
| Round-trip efficiency | Day-level `discharged/charged` in [0.8, 1.05] with ≥50 % coverage; ≤100 clamp; v0.65.0 extended-lookback backstop (§6.3) | Pack in/out integrals | HA RTE sensor, `DegradationCard`, battery-card, MPC cycling cost | measured-and-active |
| Internal resistance | Steady-state-filtered `dV/dI` (≥5 A steps, sign-checked F27), median recent vs baseline, gated trend (§6.4) | `bmsMaster` V/A pairs | `/api/internal-resistance`, insights, pack-risk feature | data-gated (trend needs r² ≥ 0.3, 14 d span; currently immature by design) |
| Charge-curve fingerprint | Median V drift at SoC checkpoints [40, 60, 80, 95] % during active charge; baseline vs recent 14 d windows (§6.5) | V + SoC + input W | `/api/charge-curve`, insights, pack-risk feature 5 | measured-and-active (holds at `baseline` until ~28 d span) |
| Ambient-thermal forecast | 2-var least squares `pack_temp ~ ambient + load`; 24 h predicted peak (§6.6) | `pack{n}_temp`, weather, in/out | `/api/ambient-thermal-forecast`, insights, `thermalMedianR2` | measured-and-active |
| Thermal-event counter | Rising-edge events at 35.6/45/55 °C with 1.5 °C hysteresis; gap-capped time-above; `hardLifeScore` (§6.7) | `pack{n}_temp` raw | `/api/thermal-events`, insights, pack-risk feature | measured-and-active |
| Pack-risk v1 heuristic | Weighted six-feature composite (fade, thermal, IR, CE, curve-drift, cycles) (§6.9) | Health reports above | `/api/pack-risk` + input to v2 only | **weak-linkage candidate** — no alarm/UI/sensor reads either pack-risk endpoint |
| Pack-risk v2 ML | Logistic regression + novelty + auto-downgrade gate; heuristic-pinned below `PACK_RISK_MIN_TRAINING_SAMPLES = 100` (§6.10, §9) | LR features + shadow model | `/api/pack-risk/v2` only | **weak-linkage candidate** — endpoint-only AND gate-pinned (≥100 labeled outcomes required); no field validation event yet |
| String mismatch | Per-DPU PV ratio vs fleet at same hour, robust median+MAD (§6.11) | Per-Core `pv_total` | `/api/string-mismatch`, insights cards | measured-and-active |
| Soiling decomposition | Per-Core soiling estimate; published fleet figure = per-Core **median** (v0.63.0 anti-deflation); F29 multi-week weather backfill (§6.12) | Per-Core PV, GHI | `/api/soiling-decomposition`, `/api/debug/soiling`, insights, solar-card, repair issues | measured-and-active (validated against a real soiling event and a false-alarm fix) |
| Shade report | Recurring same-hour shortfall vs clear-day reference, `SHADE_DROP_THRESHOLD = 0.18`, ≥`SHADE_MIN_CLEAR_DAYS = 5`, per-Core median (§6.12 note) | Per-Core PV, weather | `/api/shade-report`, insights, solar-card | measured-and-active |
| Inverter clipping | Flat-top detection vs forecast peak (§6.13, §7.7) | `pv_total`, forecast | HA clipping sensor, solar-card | measured-and-active |
| Equipment health | MPPT ratio series + inverter standby `cappedMedianEffPct` (§6.14) | MPPT in/out, standby W | `/api/equipment-health`, insights, repair issues (−3 pp MPPT drift gate) | measured-and-active |

### A.7 Energy accounting, cost & dispatch (§7)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Self-consumption / solar fraction | Grid-displacement form `(load − gridForKpi)/load`; PV↔battery↔grid apportionment; coverage gate `GRID_HOME_MIN_COVERAGE = 0.9` (§7.1) | `pv_total`, `panel_load`, `ac_in`, `grid_home_w`, pack in/out | HA sensors, insights, carbon, tariff | measured-and-active |
| Two-grid-quantities discipline | `gridImport` (DPU `ac_in`) vs `gridToHome` (SHP2 `grid_home_w`); KPI picks trusted superset (§7.0.2) | Both grid metrics | selfConsumption, tariff, HA Energy wiring | measured-and-active |
| Carbon accounting | `gridDisplacedKwh × 0.4990 kg/kWh` (`GRID_CO2_INTENSITY_LB_PER_MWH = 1100`); capped part-sum (§7.3) | selfConsumption output | `/api/carbon`, HA carbon sensor | measured-and-active |
| Legacy tariff report | Hourly `onPeakAt` walk; `TARIFF_FLAT_CENTS_PER_KWH = 17` default; whole-home superset (audit #5) (§7.4) | Grid + load integrals | `/api/tariff`, HA `tariff_*` sensors | measured-and-active |
| Greedy dispatch plan | Per-hour charge/discharge/import branches, `legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY` (0.86 → ≈0.927), reserve guard on drawn amount (§7.5) | SoC, forecast, tariff constants | `/api/dispatch-plan` only — no card, sensor, or engine consumer | **weak-linkage candidate** — advisory-only by design; `computeDispatchPlan` has exactly one caller (the route) |
| MPC dispatch recommender | Rolling DP over 24 h with P10 risk branch, degrade detection, `reserveDipPenaltyUsdPerKwh = 1.0` (§7.6) | Forecast, probabilistic band, RTE, legacy flat-tariff env (not `tariff.ts`) | `/api/dispatch/recommend` only — no card, sensor, or engine | **weak-linkage candidate** — endpoint-only; tariff basis diverges from the canonical R-EV model |
| SoC-saturation curtailment | Bayesian expected-PV gap vs live PV above dynamic charge ceiling `homeChargeCeilingPct()`; surplus W + kWh history (§7.8, §14.2) | SoC, `pv_total`, GHI, circuits | `pv_curtailment_*` sensors, `CurtailmentCard`, lighting posture `surplus` trigger, curtailment alerts | measured-and-active |

### A.8 Alerts, incidents & learning loop (§8, §9)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Alert taxonomy + ISA priority | `Alert` shape; ISA-18.2/IEC 62682 priority derivation (§8.1) | — | Everything alert-adjacent | measured-and-active |
| Threshold alerts | `computeAlerts()` temp/SoC/offline/reserve bands incl. LFP top-of-charge relaxation (§8.2) | Projections, connectivity, grid | Monitor → notify/audible/sensors/UI | measured-and-active |
| Outage events | `outageAlerts()` power-loss vs telemetry-gap vs per-device-gap events (§8.2.3) | Gap detection | Monitor, HA outage sensors | measured-and-active |
| Peer-comparison learned alerts | Robust median+MAD cross-fleet outliers (§8.3.1) | Fleet projections | Monitor | measured-and-active |
| Self-baseline alerts | Per-device baseline drift (§8.3.2) | Recorder history | Monitor | measured-and-active |
| Degradation/runtime forecast alerts | Trailing-3h runtime + SoH-decline with `SOH_FORECAST_*` gates (§8.3.3) | Degradation, forecast | Monitor | measured-and-active |
| Day-ahead solar/load alerts | `forecastDayAlerts(df, grid)` incl. storm context (§8.3.4) | Forecast, NWS | Monitor | measured-and-active |
| Alert monitor | 20 s eval; rising-edge debounce, dwell, dispatch decision (§8.4) | All alert sources | notify, broadcast, incidents, persistence | measured-and-active |
| Quiet hours + morning digest | `NOTIFY_QUIET_HOURS` (default `22-06`), `CRITICAL_BREAKS_QUIET_HOURS` (default false), digest at `NOTIFY_DIGEST_HOUR = 7` (§8.4.2) | Wall clock | notify queue | measured-and-active |
| Incident clustering | `buildIncidents(alerts)` correlation grouping (§8.4.3) | Live alerts | `/api/incidents`, insights cards | measured-and-active |
| Cooldown auto-silence | Churn detection → temporary silence (§8.4.4) | Fire history | Monitor | measured-and-active |
| Notification delivery | HA drawer card + `notify.mobile_app_*` push, dedupe, digest (§8.5) | Monitor decisions | Operator push | measured-and-active |
| Feature snapshots | `featureSnapshot.ts` captures LR feature vector once per rise (§8.6, §9.1) | degradation/thermal/IR/chargeCurve reports | Outcome→LR training join | measured-and-active (scaffolding for the gated loop) |
| Outcome capture | `POST /api/alerts/outcome` labels + family precision rollups (§8.6, §9.2) | Operator button presses (web dashboard) | LR update, `/api/alerts/outcomes/stats` | measured-and-active |
| Online LR (SGD) | `updateFromOutcome` shadow-only step + prequential loss (§9.3) | Snapshots + labels | Shadow model → pack-risk v2 gate | data-gated (gate floor 100 samples; no promotion path by design) |
| Model health + gate | `computeGateDecision` samples/drift/precision policing (§9.4) | Shadow model state | `/api/models/health`; gate applied inside `computePackRiskV2` | data-gated (same floor; report endpoint has no other consumer) |
| Machine alert telemetry | `alertTelemetry.ts` structured fire/resolve log (§8.6) | Monitor events | `/api/alert-telemetry` only | **weak-linkage candidate** — machine-readable diagnostic no tool ingests |
| Repair issues | `computeRepairIssues` composes degradation+soiling+equipmentHealth+skill into repair cards (§8.7) | Those four reports | `/api/repair-issues` only — no UI/HA surface renders it | **weak-linkage candidate** — endpoint-only composition of already-surfaced engines |
| Zombie gate | Spare-DPU offline-alert gate via explicit SN allowlist (§8.8) | `SPARE_DPU_SNS` | Offline alerting | measured-and-active |
| Root-cause map | `rootCausesFor(alertId)` static cause suggestions (§8.9) | Alert id | `/api/root-cause` only | **weak-linkage candidate** — no UI passes an alert id to it |
| Annunciation settings | `alertSettings.ts` per-priority enable, MQTT-bidirectional (§8.11) | Operator toggles | Alert Console, HA switches, broadcast gating | measured-and-active |

### A.9 Audible broadcast & TTS (§10)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| Condition derivation + tick | `conditionFromAlerts` → level; 10 s tick with boot-grace, priority and settings gates (§10.2) | Live alerts | Speaker/SIP announcements | measured-and-active |
| Alarm-storm gates | Identical-message and per-rung repeat suppression; repeat-warning identity gate; one re-present of a refused de-escalation or of a refused same-level transition carrying a new alert; escalations always play (§10.2.3) | Broadcast history | Tick loop | measured-and-active |
| MA + SIP dispatch | Media-player pre-flight + verification; per-target volume pin; `BROADCAST_SIP_TARGETS` side-channel (§10.3) | HA media players, SIP endpoint | Household audible path | measured-and-active |
| Announcement renderer | Chime + TTS layout, per-language terminator, content-keyed cache (§10.4) | Level + message | Broadcast, browser/speaker test paths | measured-and-active |
| Tone library | Five rung klaxons + named built-ins, version-gated regeneration (§10.5) | — | Renderer | measured-and-active |
| Operator tones + per-rung assignment | `chimeStore.ts` uploads; `chimeConfig.ts` rung→chime map + legacy migration (§10.6–10.7) | Operator uploads | Alert Console, renderer | measured-and-active |
| TTS build + verbalizer | `buildAlertMessage` → `verbalizeForTts` (idempotent normalizer); optional second-language pass (§10.8) | Alert facts | Renderer | measured-and-active (second language data-gated on config) |
| Wyoming/Piper client | Raw-PCM synth over Wyoming protocol, `en_US-lessac-medium` (§10.9) | Piper add-on | Renderer | measured-and-active |
| Runtime config two-layer | Env baseline + live override file; `resolveAnnounceVolume` (§10.11) | Operator PUT | Broadcast | measured-and-active |
| Audible-delivery health | `broadcastHealth.ts` reachability probes → `audible_channel_status` + self-alert (§10.13) | MA/SIP probe results | HA sensors, alert monitor | measured-and-active |

### A.10 Night-charge engine stack (v1.36–v1.187 — `tariff.ts`, `nightChargeAdvisor.ts`, `nightChargeGate.ts`, `nightChargeActuator.ts`, `nightForceCharge.ts`, `nightLedgerScoring.ts`; chapter §15)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| APS R-EV tariff model | `buildApsREvModel`/`rateAt`: 4-period, 2-season, weekday-literal windows; unconfirmed rates resolve to `null` cents (fail-safe) | Env rate config (`apsREvRatesFromEnv()`; no price API exists) | Night-charge advisor + gate | measured-and-active |
| Night-charge plan | `computeNightChargePlan`: deep-shortfall buy sized by **bisection against a clamp-exact with-buy re-sim trough** (never additive offset); `legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY ≈ 0.927` | Day forecast, probabilistic band, SoC/pool, tariff windows, EV commitments | Evening notify (bypasses quiet hours as a plan advisory), HA `charge_tonight` sensors, `/api/night-charge/status`, `NightChargeCard` | measured-and-active (write posture per `NIGHT_CHARGE_MODE`: advisory default; supervised = one announced, cancellable, bounded, auto-reverting `backupReserveSoc` write per charge night — §8b) |
| Plan staleness fail-safe | `nightChargeStateFields`: `charge_tonight` strictly `false` unless plan < 12 h old (`PLAN_STALENESS_MS`) | Latest plan timestamp | HA sensors, `/api/ha-state` | measured-and-active |
| Night ledger + outcome scorer | Never-pruned `night_charge_ledger`/`_calibration`; `scoreNightOutcome` against the ledger's **stored per-plan window** (weekend windows are disjoint from weekday 23:00–05:00); premature-capture repair; grid-import-propped baselines refused a score | Recorder actuals over the plan window | Readiness gate, status endpoint, card | measured-and-active |
| Write-readiness gate (v2) | `computeNightChargeReadiness`: ≥21 scored **actuated** nights, under-buy ≤ 10 %, sizing bias 0–5 kWh, band coverage 0.78–0.92 (≥14 verdict nights), zero uncleared engine-fault strikes (45-day window, 14-night clean-streak clearing, `cushionShortfall`-disclosed breaches exempt) | Ledger rows | HA `write_ready` flag (strictly false on failure), status endpoint | data-gated (`writeReady` unlocks AUTO only; supervised mode is an explicit owner action — §8b) |
| Force-charge | `nightForceCharge.ts`: just-in-time per-channel force-charge to the announced cost ceiling on a verified reserve-write night; software stop, OFF on window end/cancel/revert/grid loss, wall-clock deadline, `foceChargeHight` backstop | Live pool SoC, house load, grid presence, slot readbacks | SHP2 `ch{n}ForceCharge` writes, notifications, status `actuation` | measured-and-active (cost mode, `ARB_COST_MAX_SOC_PCT` > 50) |

### A.11 Safety & operational plumbing (§13)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| `processGuard` | Top-level crash classification + survival policy (§13.1) | Uncaught errors | Process lifetime (safety-critical) | measured-and-active |
| `hostPower` | Pi under-voltage interpretation with `HOST_POWER_MAX_AGE_MS = 120 000` staleness (§13.2) | HA entity named by `HOST_POWER_ENTITY` | Self-alert via `alerts.ts` | data-gated (inert until `HOST_POWER_ENTITY` is configured) |
| `haStateCache` | TTL-gated entity-watts cache + `extractEntityWatts` (§13.3) | HA states API | Shed advisor, hostPower | measured-and-active |
| `alertOnset` | Restart-persistent alarm onset timestamps, clear-then-rise semantics (§13.4) | Alert edges | Monitor, TUI ALM screen | measured-and-active |
| Message-rate floor | Per-SN hour-of-day EWMA baselines; collapse < 0.2× baseline sustained 20 min → edge-triggered P3 alert. **v1.95.0**: the dwell is chosen from the device's OWN profile — a FLAT device (cv ≤ `MSG_RATE_FLOOR_FLATNESS_MAX_CV` = 0.15 across ≥ 18 mature hour buckets, e.g. the SHP2 at cv ≈ 0.022) fires on `MSG_RATE_FLOOR_FLAT_COLLAPSE_MIN` = 4 min instead. The 20-min dwell exists only to separate legitimate Core idle (4.4 msg/min) from a collapse (2.1-2.9), a 1.5× problem created by the Cores' 13× diurnal swing; a flat device has no such ambiguity, and making it wait 20 min let the SHP2 run at 0.20 msg/min for ~17 min with nothing firing (5 instances in 4 days). Flatness must be EARNED — thin evidence keeps the conservative dwell. **v1.95.0** also gates on presence: a device that is actually OFFLINE no longer surfaces a collapse (the offline/stale alert owns that; the detector's subject is "barely reporting while still appearing FRESH"). Eligibility from a 7-day-half-life high-water mark (`eligibilityPeak`) so a collapse cannot disarm the detector; a fired collapse clears only on dwelled traffic ≥ max(0.2× baseline, `minBaselineRate`) — losing eligibility is never reported as recovery (§13.5) | Cumulative MQTT message counters | Alert monitor self-alert (defeats the "looks fresh" wedge trap) | measured-and-active |
| Log/format hygiene | `logCoalesce` storm suppression, `logSanitize` bounds, `mqttStartClassify` boot-grace levels, `haPayloadFmt` shared formatting (§13.6) | Log/publish paths | All logging + HA payloads | measured-and-active |

### A.12 UI surfaces & automation posture (§11, §14)

| Feature | Core math / mechanism | Field-data inputs | Consumers | Evidence status |
|---|---|---|---|---|
| `/ws` snapshot spine | Full-snapshot frame on connect and on every store change (body serialized once per change) (§11, "The shared data spine") | SnapshotStore | Web dashboard, wsConsole | measured-and-active |
| Web dashboard (React PWA) | Tabs: Dashboard/Solar/Battery/Strategy/Alerts/Console (§11.1) | `/ws` + 30+ `/api/*` | Operator | measured-and-active |
| Telnet TUI | Plant Operator + Summary consoles, DoS-hardened, port 2323 (§11.2) | dataProvider (`totals`/`forecast`/`degradation`) + snapshot | Operator | measured-and-active |
| HACS Lovelace cards | REMOVED in v1.47.0 (duplicated the web dashboard; consumer had pinned a stale CDN snapshot) | — | — | removed |
| Lighting posture | `rawPosture` ladder (critical/red ≤ 4 h/amber/conserve < 35 % dawn/surplus/normal) + asymmetric 15-min de-escalation hold + 10-min `normal↔surplus` dwell + restart persistence; null when its reports are missing (§14.1) | Runway, dawn-min SoC, reserve, curtailment, grid backstop | HA `lighting_posture`(+`_reason`) sensors → HA-side automations | measured-and-active |
| Surplus / opportunistic loads | Curtailment surplus vs hardcoded load catalog (`fitsInSurplus = surplus ≥ estimatedW`) (§14.2) | Curtailment report | Curtailment endpoint/card fields | measured-and-active (catalog hardcoded; `haServiceHint` always `null` — Phase-2 actuation not implemented) |
| HVAC posture | Two `category:'hvac'` catalog entries only; no posture sensor, no thermostat actuation (§14.3) | — | — | advisory-dormant (documented DORMANT) |

### Candidates for removal review

Consumers verified at the pinned revision; deleting an engine also deletes its listed route/fields. Items are candidates for *review*, not verdicts — each line states the linkage failure.

1. ~~`server/src/analytics.ts:computeMultiDayForecast`~~ — **NOT a candidate; do not remove.** `recomputeNightChargePlan()` requests `multiDayForecast` at `days: 4` and maps it into `dayRollups`, which feed the night-charge plan (§15.2 shows this). ★★★ Analytics reports dispatch **by string**, so dropping the builder compiles clean, throws at runtime, and is swallowed by the caller's `.catch(() => null)` — `dayRollups` silently degrades to `[]` inside the engine that actuates a device write. Any future removal audit must grep the report NAME, not just the symbol.
2. `server/src/dispatch/mpc.ts:recommendDispatch` (entire module + `/api/dispatch/recommend`) — endpoint-only; duplicates dispatch-plan territory on a legacy flat-tariff basis that diverges from `tariff.ts`.
3. `server/src/analytics.ts:computePackRiskScores` + `server/src/ml.ts:computePackRiskV2` (+ `/api/pack-risk`, `/api/pack-risk/v2`) — nothing reads either endpoint. Removing v2 orphans the chain `server/src/models/onlineLR.ts` + `server/src/models/modelHealth.ts` + the LR-vector portion of `featureSnapshot.ts`; outcome capture itself should stay (it powers `/api/alerts/outcomes/stats` precision accounting).
4. `server/src/models/hierarchicalBayes.ts:fitHierarchical` (+ `/api/models/hierarchical-pack-soh`) — endpoint-only referee; no automated cross-check.
5. `server/src/physics/clearSky.ts:physicsPmax`/`physicsScore` (+ `/api/physics/pv-pmax`) — endpoint-only. **`PHOENIX_SITE` must survive any removal** (consumed by `BAYES_OBS_SIGMA2` in `analytics.ts`).
6. `server/src/physics/lfpOcv.ts:analyzePackLfp` + `server/src/physics/restTracker.ts` (+ `/api/physics/lfp-soc` and the 60 s rest-tracker interval) — `socDriftPct` feeds no alarm or engine; the tick costs cycles regardless.
7. `server/src/repairIssues.ts:computeRepairIssues` (+ `/api/repair-issues`) — recomposes four already-surfaced engines into cards nothing renders.
8. `server/src/analytics.ts:rootCausesFor` (+ `/api/root-cause`) — no caller passes an alert id.
9. `server/src/alertTelemetry.ts` (+ `/api/alert-telemetry`) — marginal: machine-readable fire/resolve log with no ingesting tool; cheapest to keep, first to cut if the file grows.

Not candidates despite thin linkage: the forecast backtest (`/api/backtest/forecast`) is the validation instrument for the alarm-facing PV model; `debugSendCommand` and the HVAC-posture stub are documented deliberate postures, not orphans.
