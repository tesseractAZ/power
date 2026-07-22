# System Performance Record (living document)

This document is the runtime-evidence companion to [`DOCS.md`](../ecoflow_panel/DOCS.md): where the engine reference specifies what the system does, this records **how it is doing** — measured event rates, realized forecast accuracy, learning-gate progress, and fleet health, taken from the production deployment's own durable ledgers. It is refreshed when the underlying data changes and snapshotted at each release; numbers are not projections and are never carried forward past their as-of stamp. All figures are measured on a **single production deployment** (one SHP2, three wired Delta Pro Ultra Cores of five packs each, two bench spares) and generalize only as an existence proof, not a distribution. Timestamps are America/Phoenix (MST, UTC−7, no DST). Where a metric has no data yet, this document says so and states when accrual began — null over fabrication, the same rule the engines themselves follow.

Evidence sources: the cleared-alert ledger (`/api/alerts/history`, cap `CLEARED_LOG_MAX = 1500`), the night-charge ledger (`night_charge_ledger` via `/api/night-charge/status`), the probabilistic-band diagnostics (`/api/forecast/probabilistic`), and the live snapshot. Current data-as-of: **2026-07-21 17:05 MST**.

---

## 1. Alarm engine — audible-event discipline

The design goal (DOCS.md §8, §10) is a steep annunciation pyramid: a wide base of visible-but-silent conditions, a narrow band of push notifications, and audible broadcast reserved for standing critical conditions — at most one voice alarm per escalation. The cleared-alert ledger (durable, epoch-ms; spans 2026-07-05 21:04 MST → present, 1,007 entries) measures whether that holds in practice.

**Trailing 7 days** (2026-07-14 17:05 → 2026-07-21 17:05 MST; the ledger records rises that stood ≥ `DEBOUNCE_MS` = 60 s and then cleared, so sub-minute flaps and still-standing alerts are additional to these counts):

| Metric | Value |
|---|---|
| Alert rises cleared through the ledger | **322** (≈ 46/day; daily range 12–65) |
| — info severity | 207 (64%) |
| — warning severity | 115 (36%) |
| — critical severity | 0 cleared (3 raised, all still standing — §5) |
| Unique alert subjects (`alert.id`) | 60 |
| Learned/anomaly-source share | 178 (55%) |
| Median standing duration | ~34 min (p90 ≈ 5.6 h) |
| Short clears (≤ 10 min) | 60 (19%) |
| By category | Battery 118 · SHP2 117 · Thermal 54 · Connectivity 21 · Solar 10 · Grid 2 |
| **Audible broadcasts delivered** | **1** (58 s verified playback — the Core 3 event, §5) |

**Criticals raised vs. audible: 3 → 1.** All three standing criticals belong to the single Core 3 Pack 1 event (§5). One 58 s audible broadcast covered the entire episode: the escalation crossed the critical line inside the configured quiet window (`BROADCAST_QUIET_HOURS`, default `"22-06"`) with `CRITICAL_BREAKS_QUIET_HOURS=false` (the deployed setting), so both the audible path and the push channel held the critical for the morning digest (DOCS.md §8.4.2, §10.2). The standing red condition does not re-annunciate: the broadcast storm gates (`SAME_LEVEL_GAP_MS` = 2 min, `SAME_MESSAGE_GAP_MS` = 10 min, bypassed only by genuine escalation) and the new-critical-only re-fire rule (`crit > prevCrit`) keep one event at one voice alarm.

Over the full ledger span (16 days), exactly **2 critical rises cleared**: an SHP2 source-error transient (2026-07-12, 60 s — the debounced reconnect-blip class) and an NWS Flash Flood pre-charge advisory (2026-07-13, 20 min). The storm critical's short lifetime was itself a defect — the `message_type=alert`-only NWS query dropped a product from the feed at its first `Update` — corrected in v1.40.0 (storm alerts now survive product updates and key on the event name).

**Dedupe and auto-silence, observed.** 322 rises collapse onto 60 subjects; the two chattiest (a paired-circuit air-conditioner load baseline, `baseline-pair*_w`) account for 83 rises — all info-tier, all gated by the 8-minute sustain window (`BASELINE_LOAD_SUSTAIN_MS`), none pushed or spoken. The backup-SoC ladder produced 39 rises, owned by its dedicated `announce()` path and exempt (as an `ENERGY_STATE_FAMILIES` member) from auto-silencing, since its fast clears are genuine recoveries. Critical is never silenced or demoted by any auto-tune rule (DOCS.md §8.4.4).

**Outcome telemetry exists; a false-positive rate does not.** `POST /api/alerts/outcome` records operator verdicts (`ack`/`dismiss`/`failed`/`resolved`) against fire-time feature snapshots, and `/api/alerts/outcomes/stats` computes per-family precision as `(ack+failed)/(ack+failed+dismiss)`. This is **response telemetry, not a measured false-positive rate**: unacknowledged alerts are unlabeled (not negatives), `resolved` is excluded as ambiguous, and coverage of the alert stream is operator-effort-bound. No precision figure is published here until the labeled fraction is large enough to mean something.

---

## 2. Forecast accuracy

The day-ahead PV forecast wraps its deterministic P50 in a self-calibrating P10/P90 band (formulas in DOCS.md §3.6). Four published diagnostics make the band's coverage claim continuously measurable. Values as of 2026-07-21:

| Diagnostic | Value | What it measures |
|---|---|---|
| `calScoredDays` | **17** | Scored calibration days inside the `PV_BAND_CAL_WINDOW_DAYS = 30` calendar window. ≥ `PV_BAND_CAL_MIN_DAYS = 14`, so the calibration is **active**, not dormant. |
| `realizedDailyErrHalfFrac` | **0.269** | The order statistic `errs[k], k = ceil(0.8·(n+1))` of bias-adjusted daily PV error fractions `|actual − pred·biasFactor| / (pred·biasFactor)` — the empirical daily half-width required for expected coverage ≥ 80%. With n = 17, k = 15. |
| `bandSigmaCal` | **0.52** | The shrink multiplier applied to the raw per-hour sigma: `clamp(0.4, 1, realizedHalfFrac / producedHalfFrac)`. At 0.52 the calibration sits **above its 0.4 floor** — genuinely data-driven, not floor-pinned. The night-charge ledger shows it moving 0.40 → 0.43 → 0.52 across 2026-07-17 → 07-21 as monsoon-season days entered the scored sample: the band is widening in honest response to realized error, the designed direction. |
| `bandRealizedCoveragePct` | **88** | Share of the 17 scored days whose realized daily error fell inside the current band's daily half-width (15/17 = 88%). |

Two different thresholds consume that 88%:

- **The band's own regression threshold is 80%** (DOCS.md §3.6): the band targets "≥ 80% coverage, deliberately conservative"; a reading trending toward 80% is the signal to revisit the calibration floor, below 80% is a regression. At 88% the band is inside its healthy envelope.
- **The night-charge advisor's basis gate is 90%** (`buildNightChargeInputs`: `basisComplete` requires `bandCoverageFrac ≥ 0.9` alongside `calScoredDays ≥ 14` and a non-climatology confidence tier). At 88% the advisor **refuses to size a buy** and emits a null plan ("No plan — forecast/telemetry basis incomplete") rather than planning on a band it cannot fully trust — the observed behavior of every ledger row since 2026-07-18 (§3). The gap between the two thresholds is intentional: display-grade coverage is not buy-sizing-grade coverage.

The calibrator's known structural caveats (current-model hindcast basis, censored tail days, weather-forecast error not included) are documented at the formula site in DOCS.md §3.6 and are the reason the 0.4 floor exists; out-of-sample scoring against the archived issued forecasts (`forecast/pv_next24_wh`, v1.31.0) is the planned successor basis.

---

## 3. Night-charge advisor

**Scored nights: 0.** This is the honest count, not an omission. The v1.37.0–v1.38.3 advisory stack recorded plans from night one, but its outcome scorer fired mid-charge-window and froze truncated actuals into the ledger; v1.39.0 (2026-07-20) replaced it with **completion-gated scoring** — a night is outcome-captured only after its full scored span elapses, paired to the plan's own frozen charge window (`window_start_ms`/`window_end_ms`), with a one-time boot repair that reset the prematurely captured rows. The first night that can be planned, completed, and scored end-to-end under the repaired scorer is **2026-07-21**.

The ledger's four rows to date, with their dispositions:

| Plan night | Plan | Disposition |
|---|---|---|
| 2026-07-17 | Hold — projected shortfall 0.59 kWh below the 1 kWh minimum-buy threshold (`ARB_MIN_BUY_KWH`) | Captured, `scored=0`: pre-v1.39.0 row with no stored charge window; actuals cannot be paired to the real window, so the night is honestly unscoreable rather than cross-span-scored. |
| 2026-07-18 | Null plan — basis incomplete (band coverage under the 90% gate, §2) | Captured, `scored=0`, same pre-v1.39.0 reason. |
| 2026-07-19 | Null plan — basis incomplete | Captured, `scored=0`, same reason. |
| 2026-07-20 | Null plan — basis incomplete | Capture **pending** its completion gate at the time of writing (the first row recorded under v1.39.0 scoring rules). |

**Write-readiness: `LEARNING`**, `writeReady=false` — the fail-closed posture while zero scored nights exist. The gate's current quantitative blockers (`nightChargeGate.ts`, thresholds pre-registered and frozen):

- 0 scored forecast-backed nights; **≥ 60** required (`MIN_SCORED_ELIGIBLE_DAYS`).
- Record spans 0 days; **≥ 90 in-season days** required (`REQUIRED_IN_SEASON_DAYS`, fail-closed).
- Effective-N 0.0; **≥ 45** autocorrelation-adjusted independent nights required (`MIN_EFFECTIVE_N`).
- Under-buy rate uncomputable (no scored buy errors); must reach **≤ 0.10**.
- Buy bias unmeasured; must land in the slight-over-buy band **[0, 5] kWh**.
- PV and load day-ahead accuracy unmeasured; each requires **MAE ≤ 0.20 and |bias| ≤ 0.10** (fractions of actual).
- Band coverage unmeasured at gate granularity; must land in **[78%, 92%]**.
- MNAR exclusion at **100%**, above the **35% cap** — expected while every row is an unscoreable pre-repair or pending night, since the denominator deliberately counts *expected* nights (v1.39.0) so downtime cannot shrink it.

The advisory surfaces (HA `night_charge_*` sensors, the 21:30 notification, `/api/night-charge/status`) run regardless; no write path exists in the codebase. Every dollar field in the ledger emits null because tariff rates are unconfirmed (§6).

---

## 4. Fleet health summary

**Cell-spread norms.** Across the three wired Cores, healthy packs hold a 3–6 mV cell-voltage spread at rest (Core 1: 3–4 mV across all five packs; Core 2: 3–4 mV; Core 3 packs 2–5: 4–6 mV), against alert thresholds of ≥ 24 mV fire / ≥ 20 mV hold (warning) and ≥ 50 mV (critical; relaxed to 90 mV above 85% SoC where the benign LFP top-of-charge plateau lives, v0.58.0). Transient spread warnings over the full ledger span: Core 1 ×12, Core 2 ×8, Core 3 ×21. Pack `actSoh` runs 95.0–99.0% at 104–147 cycles; pack temperatures 29–33 °C.

**Case study — Core 3 Pack 1 BMS-latch event (2026-07-18 → present), as a severity-ladder trace:**

| Time (MST) | Observation | Annunciation |
|---|---|---|
| 07-18 17:31 | First Pack 1 cell-spread warning of the episode (21 mV; stood 9 min) | Silent (warning tier) |
| 07-18 20:28 → 07-19 06:02 | Recurring Pack 1 spread warnings at the 20 mV hold line (21–66 min each) | Silent |
| 07-20 02:51 | Pack 1 spread 47 mV | Silent |
| 07-20 03:15 | The Pack 1 spread warning clears from the ledger, coincident with escalation past the 50 mV critical line inside the 22:00–06:00 quiet window — audible and push both held; the morning digest carried the critical | Held (quiet hours) |
| 07-20 03:31 | Sympathetic spread warnings on Packs 3 and 4 (22 / 20 mV, ~4 h) | Silent |
| Post-quiet | One red-condition broadcast, **58 s** of verified playback; storm gates prevent re-annunciation of the standing red | **1 audible** |
| 07-21 17:05 (time of writing) | Standing criticals: cell spread **74 mV**, inverter system error **533**, and the mirrored SHP2 slot source-error. Pack 1 SoC frozen at 10% while sibling packs cycle 50–54% (peer z-scores 17.9 SoC / 23.8 spread); pack-to-pack SoC spread 44% (warn ≥ 15%); unit at 101.9 V, below the 103.8–106.8 V parallel-operation window | On-screen + HA sensors |

Cumulatively, **33 warning-severity Battery rises on Core 3** cleared through the ledger between 07-18 00:00 and 07-21 17:05 (pack-SoC-low ladder ×18, EMS-voltage window ×3, spread and peer-outlier warnings, pack imbalance), with 5 more standing — every one silent by design. Pack 1's own vitals are unremarkable (`actSoh` 98.1%, 147 cycles, 33 °C, `balanceState` 0): the signature — SoC frozen low while siblings cycle, spread latched high, unit voltage pushed under the EMS window — is consistent with the pack's BMS isolating it from the parallel bus, not with cell failure. The episode is the discipline working as specified: three days of accumulating silent evidence, one suppressed-then-digested critical, one 58-second voice alarm.

---

## 5. Review & audit history

Adversarial multi-agent review is the standing quality gate for this codebase; its cycles and their dispositions are compressed here. Full finding-by-finding detail lives in `CHANGELOOG`-entry provenance (current `CHANGELOG.md` + `CHANGELOG-ARCHIVE.md`).

| Date | Scope | Findings confirmed | Resolution |
|---|---|---|---|
| 2026-07-10 | 21-dimension adversarial audit of the live system | 79 raised, **58 survived verification** | v1.3.0–v1.5.x (alarm integrity, engines/physics, TUI display clusters) |
| 2026-07-12 | 30-day ground-truth engine review — 72 agents against the recorder DB + alert telemetry | Findings **F1–F31**; F1 (quiet-hours critical break-through + mobile push) deferred by operator decision — the only finding left open | v1.8.0 → v1.23.0 (remediation completed 2026-07-14) |
| 2026-07-13 | Adversarial review of the v1.12/v1.13 diff | 4 (fabrication, defer-race, stale-push, eviction-bypass) | v1.14.0 |
| 2026-07-15 | Whole-system log + performance + math audit — 24 agents, 11 dimensions | 6 raw → **3 confirmed** (1 alarm-delivery, 2 display honesty) | v1.24.0 |
| 2026-07-15 | Ground-truth accuracy assessment — 25 agents; every predictive engine cross-validated against GHI archive, array physics, energy conservation | System graded **A−**; **1 confirmed defect** — runway sim missing the DC→AC discharge loss, in the optimistic direction | v1.26.0 (+ v1.27.0 dispatch companion) |
| 2026-07-17 | P10/P90 band calibration audit + statistical follow-ups | Calibration found dormant since v1.23.0; 4 deeper statistical findings; 1 review-round defect | v1.30.0 (activation), v1.31.0 (integrity) |
| 2026-07-17 | Cross-model constant re-derivation — 21 agents over the v1.24–v1.27 energy math | Dispatch round-trip constant defective (0.945 → **0.86**, `DISPATCH_ROUND_TRIP_EFFICIENCY`) + 3 companions | v1.32.0 |
| 2026-07-18 | Night-charge pre-merge reviews (per-increment): tariff model ×13 agents, sizing brain ×13, advisory stack ×18 | Tariff: hardening set (ICU-independent DOW, rate-confirm gate); sizing: **2 critical safety-direction** (deep-shortfall under-buy, clamp-erased lift); stack: **9** (4 high, incl. non-atomic EV de-dup, inert readiness gate) | v1.36.0, v1.37.0, v1.38.0 — all fixed pre-ship |
| 2026-07-20 | Post-merge adversarial review of the shipped v1.37.0–v1.38.3 stack, plus a second pass attacking the fix diff itself | **18 confirmed (4 high)** + **10 on the fix diff** = 28 — headline: mid-window outcome capture froze truncated actuals, permanently starving the readiness gate | v1.39.0; live-verification hotfix v1.39.1 (ICU locale fallback) |

The pattern this table exists to preserve: findings are only counted after independent adversarial verification; safety-direction findings (under-buy, optimistic runway, silenced alarms) ship with regression tests pinning the failure; and reviews of fixes have repeatedly found real defects (the 07-20 second pass, the v1.26 in-review catch), so post-merge review remains part of the pipeline, not a formality.

---

## 6. Known limitations & data-gated features

Conditions below read as gaps by design. They are listed so a `unknown`/null reading is not misdiagnosed as a fault.

- **Expected-unknown sensors on a near-new fleet** (DOCS.md §6): `..._soonest_pack_eol` (a fade fit > `EOL_MAX_FADE_PCT_PER_YEAR` = 10 %/yr is early-life BMS `fullCap` settling and routes to `learning`, nulling the date), coulombic efficiency, predictive SoH, and the immature internal-resistance trend all publish `unknown` until genuine aging signal exists. `..._runway_to_reserve_if_shed` is null whenever no shed scenario is advisable. The panel emits null rather than a fabricated number in every such case.
- **Tariff rates unconfirmed**: the APS R-EV tariff model ships `ratesConfirmed=false` with all per-period `centsPerKwh` null until effective rates are entered from a bill (`tariff.ts`, v1.36.0). Every dollar field downstream — tariff cost report, night-charge `realized_cost_cents`/`realized_savings_cents` — is therefore null. Period *structure* (on-peak/overnight/super-off-peak windows) resolves regardless.
- **`grid_home` coverage gate**: whole-home grid accounting trusts the SHP2's `grid_home_w` series only when its recorded coverage reaches `GRID_HOME_MIN_COVERAGE = 0.9` of the panel-load coverage (DOCS.md §7); below that, self-consumption/solar-fraction KPIs fall back to the DPU-side basis and the night ledger's `grid_home_coverage_frac` reads null. Cloud-offline windows on the SHP2 are the dominant cause; the gate exists precisely so short history cannot fabricate an impossible solar fraction.
- **Band coverage vs. the advisor** (§2): at the current 88% realized band coverage the night-charge advisor's 90% basis gate holds every plan at null. This is the designed interaction, not a stall — the gate re-opens as scored days accrue.
- **Outcome telemetry is not a false-positive rate** (§1): per-family precision from operator acks is published, but unlabeled alerts make it response telemetry only.