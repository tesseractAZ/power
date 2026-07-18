# Night-Charge TOU Arbitrage — Design & Plan

_Generated 2026-07-17 by a 12-agent design dive (7 design + 3 adversarial critics + synthesis + red-team) reconciled with a 4-agent APS-EV/EcoFlow verification. Advisory-first, no-write; write toggled on only after the learning record proves accuracy. Not yet implemented._

> **Confirmed post-dive:** Plan = APS **R-EV**, **no demand charge** (pure energy arbitrage — the ~40%% demand-charge conditional branch collapses). Tariff source = **manual** (EcoFlow API exposes no rates). EcoFlow **smartBackupMode=2**, not self-scheduling → we own the optimization, gated on `smartBackupMode`+`TimeTaskCfg1.isEnable`.

---

# Night-Charge TOU Arbitrage — Consolidated Implementation & Structuring Plan

## 0. Objective, posture, and the two decisions that gate everything

**What the owner asked for.** On days a shortfall is anticipated, buy the *right* amount of grid energy in the cheap super-off-peak overnight window so the home (a) never imports at the 4–7pm M-F peak and (b) keeps an **outage cushion above the 10% reserve floor**. This is **as much a resilience feature as a cost feature.** Posture is **advisory / NO-WRITE now**; write is toggled on **only after Eric AND the system have verified accuracy, history, performance, and value.** Accuracy is mission-critical to a life-safety off-grid home. The system must **learn and record from day one.**

**Design spine (unchanged from the safety dimension, reinforced by all three critics): the feature is a subordinate of the safety spine, never a peer.** The two independent alarms — runway (`classifyRunway` runwayAlarm.ts:104) and SHP2 floor/SoC (`shp2-below-reserve` batterySocAlarm.ts:49-50) — plus outage fusion (`resolveGridBackstop` gridState.ts:224) remain the untouched safety authority. The advisor only *reads* the projections those alarms read; it never produces state they depend on.

### 0.1 The two contradictions the critics forced, resolved

Both the life-safety adversary and the architecture critic flagged the same internal contradiction between `writepath` (Dim 6) and `safety` (Dim 7). **Both are resolved in favor of `safety`:**

1. **Reserve-raise as the charge lever is BANNED in all dimensions (Invariant I1, binding).** `setBackupReserve`, `revertBackupReserve`, `verifyReserveWrite`, `chargeBoostState.ts`, and `effectiveReserveFloorPct()` are **deleted from the plan before they are written.** Rationale, now doubly grounded:
   - **Alarm coupling:** `backupReserveSoc` is read live as the reserve floor at ~8 sites (alerts.ts:661/815, analytics.ts:535/569/1615/2995/8061, gridState.ts:353, index.ts:1657). A decoupling shim that reroutes every one of those reads through a new holder is *surgery on the safety spine*; the shim's own failure (holder wedges, `boost.active` stuck true, `expiresAt` not honored) silently corrupts every alarm floor at once. A shim cannot be trusted to defend the thing it modifies.
   - **Power-cycle coupling (the decisive one):** the Pi power-cycles daily 84–187 min. Reserve-raise leaves the elevated reserve *persisted on the device* while the revert logic lives only in add-on RAM. A restart mid-boost drops the holder → alarms fall back to reading the elevated device reserve → false-critical cascade + ~35% of the 92.16 kWh pool stranded. If a grid **outage** lands during the dark window, no revert fires and the SHP2 defends a 45% floor *through the outage* → home dark with a third of the battery unused. This is the exact inverse of the resilience goal.
   - **Verify primitive is unfit:** `refreshShp2CloudPresence` re-sends the *current projected* `backupReserveSoc`; using it to "un-wedge" a boost of 45 would re-send the stale 10 and fight the boost.

   **The only admissible charge mechanism is the device-native `CHARGE_TIME_TASK` (`pd303_mc.TimeTaskCfg1`): a 144-slot/10-min window bitmap + `chChargeWatt` + `hightBattery` ceiling SoC, which charges to a ceiling while leaving the reserve floor untouched, and whose window is *enforced and ended by SHP2 firmware*.** A dead or rebooting add-on therefore always leaves the owner floor intact with zero add-on involvement. This write spelling is **UNPROVEN** via public IoT-Open `PD303_APP_SET` (reboot analogues were rejected 8524/1008). **If it cannot be probe-proven, the feature is advisory-forever — there is no reserve-raise fallback.**

2. **One durable, never-pruned ledger table, not the synthetic-SN `samples` pattern.** The `learning` dimension's analysis is correct and binding: `samples` is pruned unconditionally at 30 days (recorder.ts:808) with no SN exemption, so the FORECAST_SN synthetic-SN archive rows are *also* pruned at 30 days. The `writepath` and `safety` proposals to store the multi-month ledger under that pattern would **silently destroy the exact verification record the whole feature exists to build** — and worse, a gate reading a 30-day-truncated ledger as "N consecutive clean nights" could green-light writes on a record that only *looks* complete. **The ledger lives in dedicated tables created alongside `lifetime_totals` (recorder.ts:400 region), never referenced by the prune.** Synthetic-SN `samples` is used *only* for optional disposable 30-day chart overlays, and only that SN is added to `restartGapExcludedSns` (recorder.ts:555).

### 0.2 One planner, scored == actuated (resolves the "gate is theater" critique)

Four planners were in play (greedy `computeDispatchPlan`, MPC `dispatch/mpc.ts`, the proposed `nightChargeAdvisor`, and the eventual write path). The greedy planner hardcodes 80% target and throttles grid to ~1 kWh/h — it *structurally cannot express a sized bulk night buy*. MPC's physics is broken (lossless `simulateHour`, `MAX_C_RATE=0.25` ≈ 23 kWh/h vs real ~7 kW, wrong env names, hardcoded window). The gate must not certify predictions from a module that never drives the recommendation.

**Resolution: build ONE physics-correct `nightChargeAdvisor.ts` as the single source of truth. It is the module the gate scores, the module every surface renders, and the module the eventual write actuates from.** It reuses the *multi-day hourly sim* (analytics.ts:7906-7958) and the *verified efficiency constants* (`DISPATCH_ROUND_TRIP_EFFICIENCY=0.86`, per-leg √0.86≈0.927; `RUNWAY_DISCHARGE_EFFICIENCY≈0.94`), not either legacy planner's control logic. Greedy and MPC are left untouched and out of this feature's path. **Planner physics-correctness (RTE 0.86, real ~7.2 kW charge cap, real super-off-peak tier via `rateAt`, America/Phoenix resolution) is a hard precondition of entering the LEARNING phase — the readiness evaluator refuses to score a planner it knows is unsound.** A change to the advisor's algorithm version is a regression trigger that *excludes* (not merely tags) all prior-version ledger rows and resets the in-season counter.

### 0.3 The decision-critical demand-charge question

If the APS EV plan carries an on-peak ($/kW) demand charge on the 4–7pm M-F interval, the objective flips from energy time-shift to a hard "guarantee ~zero on-peak import" pre-positioning constraint, and the peak-avoidance metric flips from an energy sum to a **MAX 15-min interval kW guarantee** — a far less forgiving prediction whose *entire scored sample must be recomputed under the new objective* before any prior eligibility credit carries over. **This is one bill lookup that collapses ~40% of the conditional machinery.** It must be answered before any objective is treated as well-posed. Until then: `demand?` is an *inert optional field* in the `TariffModel` type; no `mpc` surcharge term, no `aps_tou_demand` planId, no interval-kW metric is written. The 4–7pm no-charge guard is enforced regardless of the answer (see §5), because an accidental peak import is bad under either plan.

---

## 1. Tariff & rate model (tariff.ts) — the real, verified win

APS R-EV structure is *verified* (aps.com + tou.tools, effective 2024-03-08); **cent values are owner-to-confirm placeholders and every $ output emits `null` until `ratesConfirmed=true`.** The multi-period + seasonal model is the genuine improvement and kills the verified analytics/MPC split-brain, so it ships now — but *lean*, per the architecture critic.

**New file `server/src/tariff.ts`** exporting a declarative `TariffModel` (period list with season/weekday/hour gating, `offPeakDefaultId`, `holidayCalendar`, inert `demand?`, informational `fixed?`, `ratesConfirmed`) and:
- `rateAt(model, ts): RateSlice` — resolves month/dow/hour **explicitly in America/Phoenix** via `Intl.DateTimeFormat` (Phoenix has no DST → fixed UTC-7 acceptable), season = summerMonths.includes(month), weekend/holiday → off-peak, else highest-priority matching period. Reuses the proven wrap-range test lifted from `onPeatAt` (analytics.ts:7112-7113) into `inRange(v,[a,b])`.
- `loadTariffModel()` (memoized), `isHoliday`, `seasonAt`.

**Structure (verified) / cents (CONFIRM):** on-peak 16:00–19:00 M-F both seasons; overnight super-off-peak 23:00–05:00 M-F year-round; winter-only daytime super-off-peak 10:00–15:00 M-F (the *cheapest* tier — a naive buy-overnight heuristic over-buys at the wrong window in winter, so the advisor picks the cheapest *feasible* window from `rateAt` across the horizon, never a hardcoded 23–05); off-peak default elsewhere; weekends + holidays all-off-peak. Summer = May–Oct, Winter = Nov–Apr.

**Holidays: start as a static, confirmed-from-bill date list** (weekends+holidays all-off-peak is what matters for the Fri→Mon horizon). Defer the floating nth-weekday computation and the Christmas-Eve/NYE-on-weekday rule until observance rules are pinned.

**Kill the split-brain.** Both `analytics.ts` and the MPC feed import `rateAt`/`loadTariffModel`. Delete the divergent env reads at index.ts:1629-1634 (hardcoded `h>=15&&h<20`, no DOW/season) and the analytics.ts:7090-7094 const block. `onPeakAt(ts)` is retained as `rateAt(loadTariffModel(),ts).isOnPeak` — callers unchanged; the tally rate lookup at analytics.ts:7195 becomes `rateAt(model,t).centsPerKwh` (2-tier is the degenerate case, byte-identical on the live flat-17¢ config).

**Config-form (56-option pattern):** `TARIFF_PLAN` (list flat|aps_ev|custom, default flat), per-season on/off-peak cents, the two super-off-peak cents, `TARIFF_BASIC_SERVICE_USD_MONTH`, `TARIFF_RATES_CONFIRMED` (bool default false). `TARIFF_DEMAND_USD_PER_KW` is exposed but consumed by nothing until the plan is confirmed. Old env names accepted as aliases for one release with a deprecation log. Unset cents on a chosen preset → `ratesConfirmed` forced false → all $ outputs null (house rule: null over fabricated).

**Boundary unit tests (America/Phoenix, explicit):** season flip (Apr30/May1, Oct31/Nov1), on-peak edges (15:59/16:00/18:59/19:00), overnight wrap (22:59/23:00/04:59/05:00), weekend/holiday all-off-peak, and a Fri-23:00→Sat-05:00 DOW-crossing. These tests are load-bearing: an hour-wrong resolution bleeds a charge or its end into 16:00–19:00, which under a demand plan sets a costly monthly peak.

---

## 2. The night-charge advisor (nightChargeAdvisor.ts) — one physics-correct planner

Mirror `loadShedAdvisor.ts` exactly: pure `computeNightChargePlan(opts)` → module `latest` holder with get/set → `createNightChargeAdvisor(deps)` → `nightChargeStateFields(plan, nowMs?)`. Stateless recompute, no ack/resolve machine. **Emit `null` (never a fabricated number) whenever any input basis is incomplete; `charge_tonight` defaults `false`, never null-as-true.** This module is read-only and must not touch the floor/runway alarm spine.

### 2.1 Objective — lexicographic, not additive (from the sizing dimension, kept)

The three goals collapse into one hard constraint + a sourcing choice + a ceiling:
1. **HARD constraint (resilience == demand-avoidance):** the projected pool trajectory, simulated with **P10 PV and P90 load**, must satisfy `pool(t) ≥ reserveFloorKwh + cushionKwh` for every hour from window-end (05:00) to the next reliable recharge. Holding this line means the battery served all peak load (near-zero 4–7pm import → demand avoided if present) *and* left cushion above the floor for an unexpected outage.
2. **ARBITRAGE (sourcing):** of the energy needed for (1), source it in the cheapest feasible window from `rateAt`, not by daytime/peak import. Savings ≈ `N_delivered × (avoidedRate − cheapWindowRate/legEff)`. Arbitrage and shortfall-coverage coincide — you only "buy N" on a genuine net-deficit day.
3. **CEILING (over-buy guard):** bound the buy so a too-full pack doesn't clip next-morning PV.

### 2.2 Sizing math (verified efficiency seams)

`fullKwh = backupFullCapWh/1000` (~92.16); `legEff = √0.86 ≈ 0.927`; `η = RUNWAY_DISCHARGE_EFFICIENCY ≈ 0.94`.
1. Project window-start SoC by carrying `SoC_now` through overnight house load to 23:00 → `startPackKwh`.
2. Run the **existing multi-day hourly sim** (analytics.ts:7906-7958) from 05:00 forward under **P10 PV / P90 load, no grid buy**; record `minProjectedPackKwh` over [05:00, nextRecharge].
3. `requiredExtraPackKwh = max(0, (reserveKwh + cushionKwh) − minProjectedPackKwh)` (linear-bucket lift; **re-run the sim with the buy applied when `startPackKwh + X` nears `fullKwh`** so near-saturation nonlinearity is exact).
4. `targetPackKwh = startPackKwh + requiredExtraPackKwh`; `targetSocPct = 100·targetPackKwh/fullKwh`.
5. `N = requiredExtraPackKwh / legEff` (meter sees more than the pack stores).

**Caps — N = min of requirement and:** charge power (`chargeCapKw × windowHours` minus overnight house load; `chChargeWatt` live 7200 W ≈ 43 kWh over 6 h — the *real* SHP2 grid-charge ceiling is an open hardware datum, flagged); pool headroom (`targetPackKwh ≤ fullKwh`); **over-buy ceiling** (`targetPackKwh ≤ fullKwh − P90_nextMorningPvSurplusKwh` — deliberate asymmetry: floor sized with **P10** PV so we never under-buy, ceiling with **P90** PV so we never over-buy into clipping); and the `hightBattery` ceiling (live 90%) once the write path exists. Report `bindingCap` so the operator and calibration ledger see *why* N is what it is. On a genuinely tight day where floor+cushion collides with the morning-PV headroom, **resilience floor wins, accept the clip, surface `bindingCap='overBuy'`.**

### 2.3 Conservative worst-case inputs (under-buy is a SAFETY miss)

The life-safety critic's reclassification is binding: **under-buy is not "a cost miss" — the outage cushion is the owner's explicit resilience requirement, so a confident under-sized buy leaves the home at the floor with no cushion when an outage hits. That is a life-safety miss.** Therefore:
- **P10 PV** from the 24 h band; beyond 24 h synthesize daily P10 from `DayRollup.pvKwh × (1 − realizedDailyErrHalfFrac × √daysAhead)`.
- **P90 load**, plus the committed-EV correction using **`p90SessionKwh`** (live ≈26.2, analytics.ts:3933/4211) placed as a block in the predicted charging hour — *not* `predictedEvLoadW`'s prob-weighted expected value (~2.8 kW for a real 10.3 kW session), which systematically under-projects a committed charge.
- **Guard the EV double-count:** the base weekday/weekend curve already embeds historical EV (analytics.ts:1737-1743), then predicted EV is added on top. Inject the p90 EV block into an **EV-clean base curve** (or subtract the embedded component) so N is not inflated on EV nights. Clamp per-hour EV at `EV_MAX_LOAD_W=11520`. Unit-test buy size on a known EV night vs a non-EV night. Because the double-count can flip an over-buy into an under-buy depending on which side the de-dup errs, this test is a correctness gate, not a nicety.
- **Any thin / climatology-only / low-coverage basis → NULL (no charge, status-quo 10% floor), never a best-effort small buy the owner might trust as cushion.**

### 2.4 Weekend / multi-day horizon

Horizon runs from tonight's 05:00 to the next window that can economically refill. Friday's super-off-peak is weekday-only, so Friday sizes **Fri 23:00 → Mon 05:00** (~72 h). Tag every plan `confidenceTier ∈ {forecast, mixed, climatology}`; widen daily P10/P90 by `realizedDailyErrHalfFrac × √daysAhead`. **Prerequisite fixes (shared, land once — see Phase 1):** (i) `multiDayCache` is not keyed by `horizonDays` (analytics.ts:7887) so a Friday `?days=4` silently returns a cached 3-day result, truncating the weekend and under-sizing the carry-to-Monday buy — ~2-line fix, MUST land before weekend logic is trusted; (ii) the multi-day payload must expose the hourly `{ts,pv,load,soc}` series (already computed in the loop, currently discarded) so the advisor can find the trough and the 05:00/16:00 anchors; (iii) bump `weather.ts` `forecast_days` 2→4 (Open-Meteo supports 16) so the weekend uses real forecast where available. Weekend plans that remain climatology-backed can **never** reach write-eligibility.

---

## 3. Learning & recording subsystem — one durable table, learn from day one

### 3.1 Persistence (binding decision)

**Two dedicated, never-pruned tables in `/data/ecoflow.db`, created in the same `CREATE TABLE IF NOT EXISTS` block as `lifetime_totals` (recorder.ts:400), never referenced by the prune (recorder.ts:808).** ~1 row/night ⇒ negligible. This replaces all four competing schemas (`arb_ledger`, `plan_nights`, synthetic-SN `charge_plan`, synthetic-SN `night_charge`). Optional disposable 30-day chart overlays may ride a synthetic SN `'night_charge'` in `samples` — and *only that SN* is added to `restartGapExcludedSns` (recorder.ts:555) so its off-cadence writes don't mask telemetry-stall detection.

**`night_charge_ledger`** — PRIMARY KEY `plan_date` (YYYY-MM-DD America/Phoenix). One row/night, upserted.
- **PLAN columns (frozen ~21:30 the evening before, immutable):** `issued_at_ms`, `algo_version` (so a re-learn/physics-fix is attributable and prior rows are excludable), `posture` ('advisory'), `objective` ('resilience_cushion'|'energy_arb'|'peak_avoidance'|'none'), `rationale`, `confidence_tier`, `horizon_hours`, `soc_now_pct`, `soc_at_window_start_pct`, `target_soc_pct`, `buy_kwh`, `required_extra_kwh`, `reserve_floor_pct`, `cushion_pct`, `cushion_kwh`, `binding_cap`, `pv_p10/p50/p90_kwh`, `load_p10/p50/p90_kwh`, `ev_p90_session_kwh`, `ev_session_count` (tail-sufficiency), `min_proj_soc_pct` + `_ts_ms` (from the **simulated plan trajectory**), `pool_full_kwh`, `band_sigma_cal`, `cal_scored_days`, `forecast_basis`, `weather_covered`, `tariff_snapshot` (JSON: plan/season/periodId/centsByTier/`ratesConfirmed`/`demandUsdPerKw|null`/effectiveDate — so a later APS rate change is attributable and old scores are never silently rebased).
- **OUTCOME columns (NULL until ~21:30 next evening, once charge window + 4–7pm both closed):** `outcome_captured_at_ms`, `actual_pv_kwh`, `actual_load_kwh`, `actual_window_import_kwh` (grid_home_w 23:00–05:00), `actual_grid_to_battery_kwh` (`computeSelfConsumption.gridToBatteryKwh` — exact night-charge attribution), `actual_onpeak_import_kwh` (grid_home_w 16:00–19:00 M-F), `onpeak_import_occurred`, `actual_min_soc_pct` + `_ts_ms`, `plan_traj_floor_breached` (**simulated plan trajectory** would-have breached — see §3.3), `cushion_breached`, `grid_home_coverage_frac`, `outage_during_day`, `scored` (0 when coverage<0.9 or excluded), `score_notes`.
- **SCORE columns:** `pv_err_frac`, `pv_in_band`, `load_err_frac`, `load_in_band`, `buy_err_kwh` (signed, +over-bought), `soc_min_err_pct`, `realized_cost_cents` (measured), `counterfactual_cost_cents` (**flagged ESTIMATE**), `realized_savings_cents` (**flagged UNVALIDATED projection pre-write**), `demand_charge_savings_cents` (nullable), `would_have_peak_imported`.

**`night_charge_calibration`** — singleton (id=1 CHECK), upserted; history reconstructable from the ledger. Holds the seasonally-stratified cushion learner and de-bias state (§3.4).

Recorder additions (prepared statements, `BEGIN/COMMIT` like `recordWeatherGhi` recorder.ts:1796): `recordNightPlan`, `recordNightOutcome(planDate, fields)` via `INSERT … ON CONFLICT(plan_date) DO UPDATE`, `readNightLedger(sinceDays)`, `readNightCalibration`, `upsertNightCalibration`. Read stubs in `readRecorder.ts`.

### 3.2 One evening job, one latch (collapses the five duplicated jobs)

A single ~21:30 America/Phoenix job (clone the DIGEST_HOUR hour-latch alertMonitor.ts:1654-1664, but **minute-granular and day-keyed**, with restart-persistent state in a `.night-charge-latch.json` sidecar via `atomicWriteFileSync` because the Pi power-cycles daily). It does, in order: **recompute fresh plan → record plan row → score yesterday's outcome (now that its window + 4–7pm have closed) → send notification.** Latch on a local day-stamp so it fires at most once per calendar day regardless of reboots; catch-up window [21:30, 23:00); past 23:00 with no send, log-and-latch (a plan pushed after charging should begin is worse than none). Phoenix has no DST → the day-key latch never double-fires or skips on a DST edge.

### 3.3 Floor-breach scored on the SIMULATED plan trajectory (critical fix)

The learning skeptic's first critical is binding: in advisory phase the home runs *without* the pre-buy, so raw `grid_home_w`/min-SoC telemetry measures the **un-actuated baseline**, not the plan's trajectory. The plan's whole purpose is to add energy. **`plan_traj_floor_breached` is evaluated on the module's own simulated hourly `{ts,pv,load,soc}` series with the planned buy applied** (the module already computes it), not on baseline telemetry. Raw telemetry is still stored for the coverage gate and the counterfactual, but the safety verdict is the counterfactual-of-the-plan.

### 3.4 Calibration — seasonally-stratified, non-shrinking, fail-safe

Mirror the PV-band calibrator (`pvBandRealizedHalfFrac` analytics.ts:7389) shape, but with the skeptic's fixes:
- **Cushion learner** collects undershoot `u_i = max(0, min_proj_soc_pct_i − actual_min_soc_pct_i)` over scored days and takes the rank `ceil(0.9·(n+1))` one-sided upper quantile. **Stratified by season (summer/winter/monsoon)** and **floored by a long-horizon / EVT season-worst value**, so a benign 30-day clear-sky window can *never* shrink the active cushion below the worst credible storm undershoot. Clamped `[ARB_CUSHION_FLOOR_PCT=5, ARB_CUSHION_CEIL_PCT=25]`; below `ARB_CAL_MIN_DAYS=14` scored days, held at a conservative default (15%).
- **Calendar-prior regime handling (leads, not lags):** Phoenix monsoon (~Jun 15–Sep 30) and APS summer/winter boundaries are calendar-known — hard-coded dates pre-emptively widen the cushion and drop the readiness tier **before** any variance detector confirms onset. The PV-CoV / EV-cadence variance detectors are secondary tripwires only. This prevents the first monsoon storm (highest breach risk) from being scored under a clear-sky-tuned cushion.
- **Buy de-bias** = median signed `buy_err_kwh`, **regime-stratified, applied to the CENTRAL forecast only** — it never narrows the P90 sizing tail and never reduces the cushion (energy accuracy and safety margin are separate levers).
- **EV tail sufficiency:** `ev_session_count` is a calibration precondition — until enough sessions exist to estimate the right tail, apply a conservative inflation on `p90SessionKwh` rather than trust a noisy empirical order statistic.
- **Fail-safe invariant:** any NaN / insufficient-data / low-coverage / MNAR path resolves to the conservative side (bigger cushion, lower confidence, posture stays advisory). The calibrator can only ADD margin above the operator floor; the independent floor/runway spine is never modified.

### 3.5 MNAR exclusion cap (critical fix)

SHP2 cloud-offline is correlated with storms and the daily power-cycle, so the ~36% of excluded days are exactly the adverse high-shortfall nights — the same nights dropped from the savings ledger, the coverage calibration, AND the cushion learner. **Reporting the exclusion fraction does not correct the bias.** Therefore: hard-cap the tolerated exclusion fraction and **refuse readiness credit above it**; compare the weather/load distribution of excluded vs included days and block if they diverge; treat excluded storm nights as conservative-worst, never as absent.

---

## 4. Advisory delivery surfaces — one namespace, fail-safe, LWT-guarded

All surfaces read one holder `getLatestNightChargePlan()`. **One HA namespace `night_charge_*`, one primary status endpoint.**

### 4.1 HA entities (both builders + availability)

`nightChargeStateFields(plan, nowMs?)` with a **12 h staleness guard** (`fresh = plan && plan.basisComplete && nowMs − generatedAt < 12h`): `charge_tonight` strictly `false` on null/incomplete/stale; numeric fields null unless fresh. Wire the spread into **BOTH** `mqttDiscovery.buildState()` (mqttDiscovery.ts:817) **AND** `/api/ha-state` (index.ts:1203-1392) in the *same* change as the SENSORS/BINARY_SENSORS entries (the load-shed advisory is MQTT-only today; adding to both is the deliberate parity fix, matching the pv_curtailment / grid_to_home_lifetime precedents). Test asserts every `night_charge_*` value_template key exists in buildState output.

**Critical fix (life-safety critic #5): MQTT availability/LWT + `expire_after`.** `charge_tonight` publishes to the single *retained* `ecoflow_panel/state` topic. The 12 h in-process guard only works while the process keeps republishing `false`; if the advisor dies (daily power-cycle, crash, wedge) the broker serves the last retained `charge_tonight=ON` forever. **Add an MQTT availability/LWT topic and `expire_after` on the discovery configs so HA marks the night-charge entities UNAVAILABLE when the add-on drops offline, rather than trusting a retained ON.**

**Sensors:** `ecoflow_night_charge_target_soc` (%), `ecoflow_night_charge_buy_kwh` (kWh, **no** `device_class:energy` — a target that goes up/down, not an accumulation), `ecoflow_night_charge_readiness` (string enum), `night_charge_window_start/_end`. **Binary:** `ecoflow_night_charge_recommended` (value_json.charge_tonight, **no device_class**, clone of `ecoflow_load_shed_recommended` mqttDiscovery.ts:330).

**Owner automation contract (documented):** trigger on `charge_tonight ON` **AND** `night_charge_readiness == 'ready'` **AND** entity availability == online **AND** honor `night_charge_window_start/_end`. **Never gate on `charge_tonight` alone.** Publishing the window sensors is what stops the automation misreading `charge_tonight` as "charge NOW" instead of "charge during the window."

### 4.2 The ~21:30 notification (part of the single evening job)

Direct `sendNotification` (bypasses NOTIFY_QUIET_HOURS 22–06 and minSeverity — those gates live only in alertMonitor's evaluate loop, not notify.ts:137). Severity `info`, `dedupId:'night_charge_plan'` (one updating HA card). Recompute fresh at send time. Three shapes: `charge` (buy X kWh to Y%, tomorrow's dip without/with, floor+cushion context, confidence+reason, "advisory only — wire your automation to `charge_tonight` gated on readiness+window"), `hold` ("no overnight charge needed, projected min SoC stays above floor+cushion"), `insufficient_basis` ("no plan tonight — basis incomplete, nothing will be charged" — sending this makes the *absence* explicit so Eric never wonders if the job died). `NIGHT_CHARGE_NOTIFY_ON_HOLD` default true.

### 4.3 Web + TUI

`web/src/cards/NightChargeCard.tsx` cloned from `RunwayCard.tsx` (memo, zero-prop, 60 s self-poll of `/api/night-charge/status`), mounted in `StrategyPanel.tsx`; renders the RunwayCard "unavailable" shape on null/incomplete. TUI: a `TONIGHT'S PLAN` block in `bodyStrategy()` (screens.ts:1059) inserted before the existing `CHARGE SCHEDULE` block — the two must not be confused (`CHARGE SCHEDULE` shows the SHP2's native `timeTask` config; `TONIGHT'S PLAN` shows the advisor's recommendation). Reads the holder synchronously; null → single grey line.

### 4.4 Status endpoint

`GET /api/night-charge/status` (no auth, read-only) → `{ enabled, mode:'advisory', window, reserveFloorPercent, confidence, notify:{hour,minute,lastNotifyDay}, plan: NightChargePlan|null, recentOutcomes }`. Mirrors `/api/load-shedding/status` (index.ts:2257). `reserveFloorPercent` sourced from `shp2.projection.backupReserveSoc` — the same field the floor alarm defends, never a divergent copy.

---

## 5. Write-readiness gate — pure predicate, physically-measured, out-of-sample

Per the architecture critic, for v1 the gate is **NOT** a 4-state machine with a 0–100 weighted score, regime-diversity bonus, hysteresis, and supervised-ramp module — none of that is observable for months (WRITE-ELIGIBLE is unreachable during the first in-season sample anyway). It is a **pure reduction over the one ledger table**, surfaced as one boolean + a "what's blocking" list. Per the learning skeptic, it gates **only on physically-measured prediction accuracy** — savings-agreement is removed because there is no valid counterfactual pre-write.

### 5.1 Gated metrics (each independently pass its own pre-registered threshold-with-CI; no composite score for eligibility)

- **Plan-trajectory floor safety (HARD):** zero `plan_traj_floor_breached` across the scored window, evaluated on the **simulated plan trajectory** (§3.3). State an explicit binomial reliability target (e.g. breach ≤ 1-in-1000 nights) and **size the sample from the rule-of-three** — 45 nights of observed-zero only bounds per-night breach probability at ~6.7% (95%), far too loose for a life-safety event, so the required sample is much larger. A single would-have-breached plan-night → not ready.
- **Sizing under-buy (HARD, asymmetric):** on ≥90% of plan-nights the recommended kWh ≥ realized need (never under-bought). Signed bias constrained to a slight over-buy. Fed by `p90SessionKwh`, not the weighted EV curve. This is the crux — under-buy is a safety miss.
- **PV & load day-ahead accuracy:** **normalized MAE/RMSE in kWh relative to buy size, plus a separate signed-bias term** — *not* r² (variance-driven, inflated by monsoon swings, meaningless on clear-sky runs; a +15–20% biased-but-correlated forecast passes r²≥0.80 yet mis-sizes the buy). r² kept for human dashboards only.
- **Band coverage:** realized fraction in [78%, 92%], but the verdict is held at "insufficient" until the **effective-independent** sample is large enough that the Wilson CI half-width is below the accept-band tolerance (n=14 gives ±~21 pts — cannot distinguish safe 80% from dangerous 60%). Requires ~a full season / ≥~90 effective days.
- **Forecast-basis:** the standard weekday plan-night must be fully forecast-backed; climatology-backed weekend plans can never reach eligibility until `weather.ts` horizon is extended and re-scored.

### 5.2 Out-of-sample enforcement (critical fixes)

- **Genuine walk-forward off the matured FORECAST_SN='forecast' archive** (the gate is the consumer that archive was built for; the band-cal comment analytics.ts:7346-7362 explicitly defers to it maturing). Each plan-night scored with prediction and coefficients **frozen at issue**, never re-scored with improved coefficients, with an explicit **purge/embargo gap** between the fit window and the scored night.
- **Autocorrelation-adjusted effective sample size** is what the gate reads, not raw night count — a cloudy stretch yields several correlated bad nights, so "45 nights" may be single-digit independent evidence, compounded by the ~64% MNAR coverage.
- **Today's band diagnostics are NOT treated as day-ahead-validated** (they still hindcast realized GHI, so live 94% coverage overstates true day-ahead coverage).
- **Pre-registered, frozen, versioned thresholds** — no tuning on the season the gate gates (garden of forking paths). A later re-tune resets the readiness clock. The first full season is pure shadow/learning; eligibility is unreachable during it by the in-season sample gate anyway.
- **Planner/algo `version` change is a regression trigger:** prior-version rows are *excluded* (not tagged) and the in-season counter resets. The MPC/physics precondition means a fix *will* happen mid-shadow-season and reset the meaning of every prior row.

### 5.3 Minimal state (v1)

Persist only the current `ReadinessState` (v1: `LEARNING` | `READY_TO_CONSIDER_WRITES` | `BLOCKED`) + a small consecutive-scored-days hysteresis counter, so advancement requires sustained evidence across restarts; everything else is a pure reduction over the ledger on boot. The full LEARNING→ADVISORY_TRUSTED→WRITE_ELIGIBLE→SUSPENDED machine, weighted score, regime-diversity math, and supervised ramp are **deferred to the write-enable release**. The gate fails-closed to `LEARNING`/`BLOCKED` if the ledger's oldest scored row is younger than the required in-season window.

**HA:** `ecoflow_night_charge_write_ready` binary (fail-closed false, never null-as-true) + diagnostic sub-metric sensors (under-buy rate, plan-trajectory cushion adequacy %, peak-avoidance %, band coverage %, plan-nights scored, effective-n, days-in-regime, forecast-basis %, exclusion fraction), null when basis incomplete.

---

## 6. The dormant, toggle-ready write path — deferred, CHARGE_TIME_TASK only

**No `commands.ts` actuation helper is built until the device-native mechanism is probe-proven.** The advisory v1 must not depend on any write primitive.

### 6.1 Probe (owner-clicked, task DISABLED, read-back diff)

`scripts/probe-shp2-charge-task.sh` cloned from `probe-shp2-reboot.sh`, driving `/api/device/send-command` (requireWriteAuth + WRITE_DEBUG_TOKEN + `cmdSetAllowed` already contains `PD303_APP_SET`), per-attempt confirm, audit-logged: (1) `getQuotaAll` baseline snapshot of `pd303_mc.TimeTaskCfg1.*`; (2) write candidate shapes with **`isEnabled:false`** (derived from tolwi/hassio-ecoflow-cloud's reverse-engineered setters) — an accepted write does not actuate a charge; (3) read-back diff `TimeTaskCfg1` before/after (`code:0` + field reflects write ⇒ spelling proven; `8524`/`1008` ⇒ try next); (4) revert to captured baseline, verify. Everything reversible, bounded, audited. **If no spelling is proven, the feature is advisory-forever — no reserve-raise fallback.**

### 6.2 Write actuation (only after probe proven + gate matured + owner toggle)

New `writeLog` action `'night-charge-task'` (NOT the pre-named `boost-reserve` slot, which is BANNED by I1). Verify via a read-back of `TimeTaskCfg1` specifically with bounded retry that never re-issues a stale value (do not overload the cloud-presence refresh no-op). **Defense-in-depth 4–7pm guard AT the actuation primitive:** reject any `CHARGE_TIME_TASK` slot overlapping 16:00–19:00 M-F, resolved in America/Phoenix — not only in the planner, so a bad window from any caller cannot bleed a charge into the peak. Write-failure notice uses direct `sendNotification` (survives quiet hours) with a per-SN dedupId.

### 6.3 Enablement ladder

Tier 0 advisory+learning (now). Tier 1 `NIGHT_CHARGE_MODE` config flag armed (fires nothing). Tier 2 **owner one-click "Apply tonight"** (RefreshCloudButton + confirm-modal), inert unless `night_charge_write_ready` true, runs ~21:30, never scheduler-fired. Supervised ramp (first ~10 writes owner-confirmed) before any Tier 3. Tier 3 opt-in scheduler is a *separate later release* behind its own `CHARGE_WRITE_AUTOSCHEDULE=false` flag. Every write passes `requireWriteAuth` and appends to writes.log.

---

## 7. Safety invariants (binding) + fail-safe decision table

**Invariants:**
- **I1** The feature NEVER writes `backupReserveSoc`. Only device-self-expiring `CHARGE_TIME_TASK` is admissible, probe-proven, else advisory-forever.
- **I2** Size from worst-case (P10 PV / P90 load / `p90SessionKwh`); under-buy is a **safety** miss.
- **I3** `targetSoc ≤ hightBattery` ceiling AND ≤ `fullKwh − P90 morning PV headroom`; `buyKwh` capped by feasibility AND ceiling-headroom.
- **I4** Write precondition requires `resolveGridBackstop().present===true`; any outage signal → hard NO-WRITE; the outage alarm always wins within <25 s.
- **I5** SHP2 offline / `gridConnected===null` / stale telemetry → advisory null, NO-WRITE.
- **I6** Forecast collapse / climatology-only window / `calScoredDays < N_MIN` / coverage <0.9 → null + NO-WRITE.
- **I7** EV clamped `EV_MAX_LOAD_W`; sized from de-duplicated load (no double-count).
- **I8** 4–7pm M-F is an absolute no-write blackout for any import-inducing action, enforced at the actuation primitive; if a demand charge is confirmed the objective becomes hard zero-import pre-positioning.
- **I9** Idempotency: one plan row per local date; restart-persistent latch; write phase adds a read-back "already set for tonight?" check.
- **I10** Time-sensitive delivery at ~21:30 via direct `sendNotification`, never the 06:00 digest queue.
- **I11** SoC coherence guard (% vs remainWh/fullCapWh) before sizing; else null.
- **I12 (new, MQTT):** availability/LWT + `expire_after` so a dead advisor's retained `charge_tonight=ON` is marked UNAVAILABLE, not trusted.
- **I13 (new, ledger):** the readiness reduction fails-closed to LEARNING if the oldest scored row is younger than the required in-season window; prior-`algo_version` rows are excluded.

**Fail-safe decision table (write phase — every cell defaults NO-WRITE; any single amber/red → NO-WRITE, advisory-or-null, spine wins):**

| Guard | Green condition | Source |
|---|---|---|
| G1 Actuator proven | CHARGE_TIME_TASK spelling probe- & read-back-verified | probe (UNPROVEN today) |
| G2 Owner enabled | write toggle ON + this plan owner-confirmed | requireWriteAuth index.ts:215 |
| G3 No alarm | runway + floor + SoC alarms all green | runwayAlarm.ts:104, batterySocAlarm.ts:49 |
| G4 Grid present | `resolveGridBackstop().present===true` | gridState.ts:224 |
| G5 SHP2 online & coherent | online + gridConnected!==null + SoC coherent | gridState.ts:173-179 |
| G6 Basis trusted | 24 h real band, calScoredDays≥N_MIN, coverage≥0.9, not climatology | analytics prob-forecast |
| G7 Window safe | now ∈ super-off-peak, plan end <16:00, no 4–7pm overlap (resolved in Phoenix) | I8 |
| G8 Sizing bounded | 0 < buyKwh ≤ min(feasible, ceiling-headroom) | I2/I3 |
| G9 Idempotent | no CHARGE_TIME_TASK already set tonight | read-back, I9 |
| G10 Reserve untouched | write does NOT alter backupReserveSoc | I1 |
| G11 Gate matured | readiness=READY, effective-n & in-season sample met, exclusion cap ok | §5 |
| G12 Availability | advisor online, no stale retained state | I12 |

The table is fail-closed: absence of a signal is treated as red, exactly like gridState's absent-node handling.

---

## 8. Phasing summary

Advisory v1 = Phases 1–5 (all writes: **none**). The dormant write path (Phases 6–8) is deferred and gated on the probe + a matured out-of-sample gate + an owner toggle. Phase 0 lands the shared preconditions and the one decision (the bill lookup) that collapses ~40% of conditional machinery. Detailed per-phase deliverables in the `phases` field.
