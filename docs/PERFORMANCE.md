# System Performance Record (living document)

This document is the runtime-evidence companion to [`DOCS.md`](../ecoflow_panel/DOCS.md): where the engine reference specifies what the system does, this records **how it is doing** — measured event rates, realized forecast accuracy, learning-gate progress, and fleet health, taken from the production deployment's own durable ledgers. It is refreshed when the underlying data changes and snapshotted at each release; numbers are not projections and are never carried forward past their as-of stamp. All figures are measured on a **single production deployment** (one SHP2, three wired Delta Pro Ultra Cores of five packs each, two bench spares) and generalize only as an existence proof, not a distribution. Timestamps are America/Phoenix (MST, UTC−7, no DST). Where a metric has no data yet, this document says so and states when accrual began — null over fabrication, the same rule the engines themselves follow.

Evidence sources: the cleared-alert ledger (`/api/alerts/history`, cap `CLEARED_LOG_MAX = 1500`), the night-charge ledger (`night_charge_ledger` via `/api/night-charge/status`, which mirrors **every** ledger column), the write-readiness gate (`readiness.metrics` on the same route), the probabilistic-band diagnostics (`/api/forecast/probabilistic`), the confirmed-defect register (`/api/defective-packs`), and the live snapshot. Current data-as-of: **2026-09-11 08:56 MST** across §1–§4, measured against the deployment running **v1.148.0** (`ref 5b53041`, verified live). The 2026-09-06 figures they replace are not carried forward; where an earlier number is shown it is labelled as the prior reading, for trend only.

---

## 1. Alarm engine — audible-event discipline

The design goal (DOCS.md §8, §10) is a steep annunciation pyramid: a wide base of visible-but-silent conditions, a narrow band of push notifications, and audible broadcast reserved for standing critical conditions — at most one voice alarm per escalation. The cleared-alert ledger measures whether that holds. It is **at its `CLEARED_LOG_MAX = 1500` cap**, so its span (2026-07-06 07:22 → 2026-09-11 08:56 MST) is truncated at the front and totals over the full span are lower bounds; the trailing-7-day window below is complete.

**Trailing 7 days** (2026-09-04 08:56 → 2026-09-11 08:56 MST; the ledger records rises that stood ≥ `DEBOUNCE_MS` = 60 s and then cleared, so sub-minute flaps and still-standing alerts are additional to these counts):

| Metric | 2026-09-11 | Prior reading (2026-09-06) |
|---|---|---|
| Alert rises cleared through the ledger | **97** (≈14/day) | 113 (≈16/day) |
| — info severity | **0** | 0 |
| — warning severity | **96** (99%) | 111 (98%) |
| — critical severity | **1 cleared** | 2 cleared |
| Unique alert subjects (`alert.id`) | **30** | 36 |
| Learned/anomaly-source share | 36 (37%) | 47 (42%) |
| Median standing duration | **26.0 min** (p90 ≈ 7.5 h) | 51.3 min (p90 ≈ 6.2 h) |
| Short clears (≤ 10 min) | **22** (23%) | 12 (11%) |
| By category | Battery 34 · Connectivity 31 · Thermal 26 · SHP2 6 | Battery 60 · Thermal 25 · Connectivity 20 · SHP2 6 · Grid 2 |

**The distribution became more bimodal, not uniformly calmer.** The median standing duration halved (51.3 → 26.0 min) while the p90 *rose* (6.2 → 7.5 h), and short clears doubled as a share (11% → 23%). A falling median alongside a rising tail is two populations moving in opposite directions, not one population improving. This is a measurement; no cause is attributed here.

**The info tier is still empty, for a second consecutive reading.** The prior snapshot flagged a zero info count as worth watching precisely because "the base is quiet" and "the base stopped being recorded" are indistinguishable from the outside. Two readings five days apart have now both read zero, which narrows nothing — a detector that stopped recording would also read zero twice. It remains unresolved and is deliberately repeated here rather than dropped.

**Criticals cleared in the window: 1.**

| Cleared (MST) | Subject | Duration |
|---|---|---|
| 2026-09-05 10:08 | `dpu-err-Y711ZABA9H3T0489` — the Core 4 inverter error carrying the migrated defective pack (§4) | 3.3 min |

This is the same event the prior snapshot recorded; it falls inside both seven-day windows. No new critical has cleared since.

**Top subjects in the window** — 97 rises collapse onto 30 subjects, and **the head has changed completely**. The prior window was led by the Core 3 pack-1 voltage cluster (`peer-voldiff-…J234000-1` ×13, `vdiff-warn-…J234000-1` ×13, `dpu-imbalance-…J234000` ×8); **none of those three appears in this window's head at all**. The head is now the telemetry-rate family, spread across three separate DPUs:

| Count | Subject |
|---|---|
| 9 | `msg-rate-floor-HD31ZASAHH120432` |
| 8 | `baseline-mppt_hv_temp-…J234000` (Core 3) |
| 7 | `msg-rate-floor-…GBC0314` (Core 1) |
| 6 | `baseline-mppt_lv_temp-…GBC0314` (Core 1) |
| 6 | `shp2-below-reserve` |
| 6 | `msg-rate-floor-…G9P0090` |
| 5 | `vdiff-warn-…H3T0489-4` (Core 4, pack **4**) |
| 5 | `baseline-mppt_lv_temp-…J234000` (Core 3) |

Two things are worth stating precisely, because both invite a wrong reading:

- **`msg-rate-floor` on three DPUs (22 of 97 rises) is the single largest family.** It is a telemetry-cadence signal, not a battery one — which is also why the Connectivity category rose (20 → 31) while Battery fell (60 → 34). The category shift is largely this one family moving to the head, not a fleet-wide change in battery behaviour.
- **`vdiff-warn-…H3T0489-4` is Core 4 pack _4_ — not the confirmed defective pack**, which is Core 4 pack **1** (§4). Adjacent serial, adjacent chassis, different slot. The confirmed defect's own subject is absent from this window's head.

**Broadcast path**, live at time of writing: `enabled`, `targetCount` **3** (2 Music Assistant + 1 SIP cordless — the SIP leg became visible on this route only in v1.131.0; before that it reported 2 of 3), `audibleReachable: true`, last delivery `yellow`/`success`, `stormSuppressedCount` 0.

**Outcome telemetry exists; a false-positive rate does not.** Unchanged from the prior reading: `/api/alerts/outcomes/stats` computes per-family precision as `(ack+failed)/(ack+failed+dismiss)`, which is **response telemetry, not a measured false-positive rate** — unacknowledged alerts are unlabeled, `resolved` is excluded as ambiguous, and coverage is operator-effort-bound. No precision figure is published until the labeled fraction is large enough to mean something.

---

## 2. Forecast accuracy

The day-ahead PV forecast wraps its deterministic P50 in a self-calibrating P10/P90 band (formulas in DOCS.md §3.6). Values as of **2026-09-11**:

| Diagnostic | 2026-09-11 | Prior (2026-09-06) | What it measures |
|---|---|---|---|
| `calScoredDays` | **29** | 19 | Scored calibration days inside the `PV_BAND_CAL_WINDOW_DAYS = 30` window. ≥ `PV_BAND_CAL_MIN_DAYS = 14`, so the calibration is **active**. |
| `realizedDailyErrHalfFrac` | **0.657** | 0.256 | Empirical daily half-width required for expected coverage ≥ 80%. **2.6× the prior reading.** |
| `bandSigmaCal` | **1.00** — basis `saturated` | 0.50 | Shrink multiplier, `Math.min(1, Math.max(0.4, realizedHalfFrac / producedHalfFrac))`. Now **clamped at its ceiling**. |
| `bandRealizedCoveragePct` | **72** | 84 | Share of scored days whose realized daily error fell inside the band's daily half-width. **Below the 78% basis gate.** |

### ★ The band calibration inverted, and it stopped the night-charge engine

This is the most consequential change in this refresh, and it is not visible in the `bandSigmaCal` number alone — which is the reason a new field exists to read it.

**The calibrator is shrink-only.** `bandCal = Math.min(1, Math.max(PV_BAND_CAL_FLOOR, realizedHalfFrac / producedHalfFrac))` (`analytics.ts:8009`). It can narrow a band that proves too wide; it has **no authority to widen one that proves too narrow**. The raw band is the deliberately conservative default and 1.0 is the ceiling.

Five days ago the ratio sat at 0.50: realized error was half the produced half-width, the band was comfortably too wide, and the calibrator was actively narrowing it. Today realized error is **0.657** and the ratio has gone to or past 1. The calibrator has found the band **too narrow** and is pinned at "do not shrink", which is the most it can do. Coverage is 72% against a nominal target of ≥ 80%.

**The consequence reached the operator the same day.** `basisComplete` requires `bandCoverageFrac ≥ BASIS_MIN_BAND_COVERAGE = 0.78`. At 72% it is false, and the live plan is null:

> No plan — forecast/telemetry basis incomplete (**PV band coverage 72% < 78%** (forecast present, tier=forecast, calDays 29/14)); nothing will be charged.

Three of the four basis gates pass. The miss is six points on one of them. That the rationale says so at all is v1.148.0's `basisBlockedBy`; before it, this read as a bare "basis incomplete" and reconstructing which gate had closed took an hour of live probing.

**★ A `bandSigmaCal` of 1 was ambiguous across five states, and this document walked into it.** The prior snapshot inspected this exact field, read 0.50, and asserted: *"Still **above its 0.4 floor** — data-driven, not floor-pinned."* That checked the **floor** ambiguity. It did not occur to the reading that the *ceiling* carried an ambiguity too — and the ceiling is where the field went. A published 1 is emitted when:

1. the calibration is active and **saturated** (today's state — band too narrow, no authority to widen);
2. the calibration **never engaged** for want of scored days — the real v1.23.0 defect, which sat pinned at exactly 1 in production;
3. the ratio lands exactly on 1;
4. an operator override happens to be 1;
5. (until v1.149.0) there was **no probabilistic forecast at all**, and the ledger wrote `?? 1`.

States 1 and 2 are opposites — "the calibration is working and telling you something is wrong" versus "the calibration is not running" — and they published the identical number. **v1.149.0 adds `bandSigmaCalBasis`** (`operator-override` / `shrunk` / `floor-pinned` / `saturated` / `uncalibrated`) beside it, the same companion-field shape as `strikesMeasurable` and `underBuyMeasurable`, and changes the ledger's missing-forecast value from `1` to `null`. Seven mutants in `scripts/mutate-band-cal-basis.mjs` hold it, including one that collapses `saturated` back into `uncalibrated`.

*Recording the sequence, because it is the point of this document: the ambiguity was not found by reading code. It was found by refreshing a table, seeing a number move to a boundary, and asking what the boundary meant — five days after this same document had inspected the same field and pronounced it healthy.*

**What is NOT established here.** Why realized error rose 2.6× in five days is not answered. Candidate causes — a weather regime change, monsoon-season variance, soiling, a model regression, or the `calScoredDays` window rolling from 19 to 29 and admitting a rougher stretch — have not been separated, and the 29-day window makes a single bad week arithmetically capable of this on its own. No attribution is asserted.

**Component accuracy from the readiness gate** (`readiness.metrics`, **18** verdict-bearing captured forecast nights) — these are the numbers the gate itself judges, and they separate PV from load:

| Metric | 2026-09-11 | Prior (2026-09-06) | Reading |
|---|---|---|---|
| `pvMae` / `pvBias` | **0.064** / **−0.021** | 0.078 / −0.022 | PV forecast is accurate and near-unbiased; both improved. |
| `loadMae` / `loadBias` | **0.149** / **−0.062** | 0.178 / −0.082 | Load error is **2.3× PV error**, still biased toward over-forecast, but improved on both axes. |
| `pvBandCoverage` | **1.00** | 1.00 | Every scored night's PV landed inside the band. |
| `loadBandCoverage` | **0.833** | 0.769 | Still the binding half of `bandCoveragePct` — but now **inside** the gate's [78%, 92%] target. |

### ★ Two band-coverage numbers now disagree, and each is correct

`/api/forecast/probabilistic` reports **72%**. `readiness.metrics.bandCoveragePct` reports **83.3%**. Both are live, from the same deployment, minutes apart. They are not in conflict — they measure different populations:

| | Probabilistic route | Readiness gate |
|---|---|---|
| Population | scored **calibration days** in the rolling `PV_BAND_CAL_WINDOW_DAYS = 30` window | verdict-bearing **captured forecast nights** (18) |
| Quantity | daily PV error inside the band's daily half-width | per-marginal PV *and* load coverage, graded separately since v1.106.0 |
| Consumed by | the advisor's `basisComplete` gate | the write-readiness gate's graduation criteria |

**The operational result is a near-perfect inversion of the prior snapshot.** Then: the readiness gate's band criterion was the binding blocker at 76.9% (below its 78% floor) while the advisor's basis gate was satisfied at 84% and plans were being sized. Now: the readiness gate's band criterion has come **inside** its target at 83.3%, and the advisor's basis gate has **closed** at 72%.

That inversion has a coupling worth naming explicitly, because it is not obvious from either number alone: **the advisor is no longer producing plans, so no further actuated nights can accrue.** The readiness gate needs ≥ 21 scored actuated nights and has 15. The mechanism that produces them is the mechanism that just stopped. Band coverage recovering above 78% is now a precondition for the *learning ledger* advancing at all — not merely for tonight's buy.

### ★ The load over-forecast signature resolved without intervention

The prior snapshot recorded load over-forecast by **19–39 kWh (17–32%) on five consecutive nights** (2026-08-31 → 09-03) and concluded: *"Five nights is not a distribution; it is a consistent enough signature to name and watch, not to correct blindly."* That was the right call, and this refresh is the reason it was:

| Plan night | Net forecast miss | Load forecast → actual | Direction |
|---|---|---|---|
| 2026-09-04 | −30.79 kWh | 120.55 → 81.84 | over-forecast 38.7 |
| 2026-09-05 | −19.36 kWh | 115.01 → 94.63 | over-forecast 20.4 |
| 2026-09-06 | **+13.06 kWh** | 110.01 → 119.35 | **under**-forecast 9.3 |
| 2026-09-07 | −1.98 kWh | 110.28 → 107.42 | over-forecast 2.9 |
| 2026-09-08 | **+5.39 kWh** | 110.08 → 116.45 | **under**-forecast 6.4 |
| 2026-09-09 | **+3.44 kWh** | 113.45 → 116.76 | **under**-forecast 3.3 |

The last four nights alternate sign at a fraction of the magnitude, and the aggregate agrees: `loadMae` 0.178 → **0.149**, `loadBias` −0.082 → **−0.062**. The systematic one-directional over-forecast is not present in the current sample.

**Nothing was changed to achieve this.** No load-forecast correction was applied between the two snapshots. Had the prior reading been "corrected blindly" — a bias factor fitted to five nights of a transient — the correction would now be actively wrong, pushing an already-unbiased forecast in the under-forecast direction, which is the *unsafe* direction for sizing a buy. This is recorded as a positive result for the document's own discipline: a signature named and watched rather than fitted.

Load remains the weaker of the two forecasts (`loadMae` is still ~2.3× `pvMae`) and `loadBandCoverage` is still the binding marginal. It is no longer *biased*; it is merely *noisier*.

---

## 3. Night-charge advisor

**Scored actuated nights: 15** (prior snapshot: 11). Four more nights accrued — and then the supply stopped: the advisor has produced no plan since 2026-09-09 because the basis gate closed (§2).

**Recent ledger rows** (`/api/night-charge/status` → `recentOutcomes`, all `posture=supervised`, `algo_version=3`):

| Plan night | objective | buy → delivered (kWh) | binding cap | actuated | ceiling basis | Notes |
|---|---|---|---|---|---|---|
| 2026-09-04 | `none` | 0 → — | `evContention` | — | — | Friday: a **1-hour** window against a whole-pool requirement. Correct hold, not a defect (§6). |
| 2026-09-05 | `cost_arbitrage` | 36 → — | `chargePower` | — | `max-soc` | First night cost mode engaged. |
| 2026-09-06 | `cost_arbitrage` | 22.48 → **34.87** | `evContention` | 1 | `pv-headroom` | window import 52.54 kWh |
| 2026-09-07 | `cost_arbitrage` | 22.34 → **33.09** | `evContention` | 1 | `pv-headroom` | window import 61.68 kWh |
| 2026-09-08 | `cost_arbitrage` | 22.16 → **32.81** | `evContention` | 1 | `pv-headroom` | window import 61.73 kWh |
| 2026-09-09 | `cost_arbitrage` | 21.74 → **32.16** | `evContention` | 1 | `pv-headroom` | window import 61.54 kWh |
| 2026-09-10 | `none` | 0 → — | — | — | — | **`cushion_shortfall = 0`** — the first such row (see below). |

What this table establishes, updating the prior reading point by point:

- **Cost mode is now the standing objective, not a first sighting.** The prior snapshot caught `cost_arbitrage` on its first contributing night (2026-09-05, `cost_ceiling_basis = max-soc`). Every row since reads `cost_arbitrage` with the ceiling basis settled on **`pv-headroom`** — a different binding ceiling than the first night's, and the column that distinguishes them is the one v1.132.0 added.
- **★ Delivery exceeds the buy by ~48–55% on every actuated night**, consistently: 22.48→34.87, 22.34→33.09, 22.16→32.81, 21.74→32.16. This is a **+10 kWh** systematic over-delivery against a readiness criterion that requires delivery bias in **[0, 5] kWh**. It is not currently measured as a bias, because `buyBiasKwh` reads `null` — all fifteen actuated nights are excluded from the sizing judgement as disclosed cushion shortfalls (below). **A criterion the gate would fail on is being exempted from evaluation by a different criterion's exemption.** No conclusion is drawn from six nights; it is named here so that if the exemption ever lifts, this is already on the record as the thing to look at first.
- **`binding_cap` is `evContention` on every actuated night**, unchanged from the prior reading. With `ARB_GRID_INPUT_CAP_KW = 17` and the EVSE drawing ~11.5 kW, the packs are left ~5.5 kW against a 7.2 kW `ARB_CHARGE_CAP_KW`. EV contention remains the routine limiter on a weeknight buy.
- **`cushion_shortfall` finally read 0 — once.** The prior snapshot recorded it as `1` on *every* row and called the cushion unsatisfiable. 2026-09-10 is the first `0`. It is also a `none`-objective row with no window, no actuation and `scored = null`, so it is **not** evidence the cushion became satisfiable on a night that mattered; it is a night the planner never sized. Recorded because the prior text said "every row" and that is no longer literally true — not because the constraint has changed.
- **`actual_onpeak_import_kwh` is 0 on every scored night**, unchanged. The on-peak displacement value that would justify a cost-mode reorder is still absent (§6).

**Write-readiness (gate v2, as of 2026-09-11): `LEARNING`, `writeReady = false`.** The criteria have moved in both directions since the prior reading:

| Criterion | 2026-09-11 | Prior (2026-09-06) | Required |
|---|---|---|---|
| Scored actuated nights | **15** (`effectiveN` 18) | 11 | ≥ 21 |
| Under-buy rate | **`null` — 15 of 15 nights excluded** | `null` — 11 of 11 | ≤ 0.10 |
| Delivery bias | **`null`** (`buyBiasKwh` unmeasured) | `null` | [0, 5] kWh |
| Band coverage | **83.3%** over **18** nights — now **inside** the target | 76.9% over 13 | [78%, 92%] over ≥ 14 |
| Engine-fault strikes | `activeStrikes` 0, **`strikesMeasurable` 1** — now countable | 0 / **`strikesMeasurable` 0** | 0 |

Two criteria genuinely improved and one did not move:

- **Band coverage cleared its floor** (76.9% → 83.3% over 18 nights) and is no longer blocking. It was the binding forecast constraint in the prior snapshot; it is not now.
- **★ `strikesMeasurable` went 0 → 1.** The prior snapshot listed `activeStrikes: 0` alongside `strikesMeasurable: 0` under "a `0` that means *cannot count*". The strike detector can now count, so **`activeStrikes: 0` has become an actual zero** — a real absence of faults rather than an inability to look. This is the first of that family of items to resolve, and it resolved the right way: by the measurement becoming possible, not by the zero being reinterpreted.
- **The under-buy criterion is unchanged and still structurally unreachable.**

★ **The gate states, in its own blocking text, that it cannot open:**

> "under-buy rate UNREACHABLE, not merely thin — all 15 of 15 actuated night(s) disclosed a cushion shortfall and are therefore exempt from the sizing judgement. The cushion requirement is not satisfiable on this plant (the worst-case day drains more than the pool holds), so the flag is a constant and more nights will not change this. Re-scoping the cushion is an owner decision; until then this criterion cannot be met and the gate stays closed."

This is still the single most important line in this document. **Accruing more nights will not graduate `auto` mode** — and, as of this refresh, more nights are not accruing either, because the advisor stopped planning when the basis gate closed (§2). The gate now has two independent reasons it cannot advance, where the prior snapshot had one. The v1.125.0 cushion re-scope onto an islanded-outage basis (4 h × measured islanded load × safety factor ≈ 23 kWh, versus the legacy whole-house band) was intended to make the cushion satisfiable; the ledger shows `cushion_shortfall = 1` on every **sized** row since, so **either the re-scope did not resolve it or a second cause is now binding**. That is not established here and should not be assumed either way. (2026-09-10 reads `0`, but it is a `none`-objective row the planner never sized — see §3; it is not a counter-example.)

*The prior version of this paragraph closed by warning that `activeStrikes: 0` sat beside `strikesMeasurable: 0` and therefore carried no information. **That is no longer true** — `strikesMeasurable` is now 1, as the table above records. The sentence is corrected rather than deleted because leaving it would have reproduced the v1.131.2 defect exactly: a refreshed measurement contradicting the surrounding prose that was never re-read.*

**Actuation integrity.** The supervised write path applies, verifies against device readback, retries, and escalates. v1.131.0 extended readback verification to the **revert** side, which had been closing on a cloud ACK — the exact evidence v1.79.0 ruled insufficient on the apply side. It was exercised on live state within minutes of deploying: the 2026-09-03 night was found reverted-but-unverified, the panel was read at 16%, and `revertVerifiedAtMs` was stamped.

**An over-promise, logged here at 10:39 MST and FIXED in v1.133.1 the same day.** The plan
rationale — which feeds the 21:30 notification and the spoken broadcast — printed
`setpointSocPct` un-clamped, so an armed plan announced *"The reserve is set to 100%"* while
`clampReserveTarget` wrote **50**. The announced number was not the number sent to the device.

It now names three quantities for what each is: what the device is **told**, what the
requirement **asked for** when the envelope truncated it, and what the window is expected to
**reach**. Verified live on the identical case — `setpointSocPct` still resolves to 100, and the
announcement reads:

> The reserve is set to **50%** — the resilience requirement asks for 100%, but the panel only
> accepts a backup reserve up to 50%, and the window is only expected to reach ~29.6%.

The truncation clause appears only when the envelope actually bit, so an ordinary night reads as
before. The `[10, 50]` bound also stopped being an anonymous literal in two places and became
`RESERVE_WRITE_MIN_PCT` / `RESERVE_WRITE_MAX_PCT` — that anonymity is how `ARB_COST_MAX_SOC_PCT`
came to ship with a schema minimum equal to the write maximum (§6).

*Recording the sequence because it is the point of this document: the defect was found by
reading a live plan, not by reading code; it was logged here as unfixed while it was unfixed;
and this paragraph itself sat stale for the several hours between the fix shipping and someone
asking whether it had.*

---

## 4. Fleet health summary

**The Core 3 Pack 1 episode resolved into a confirmed pack defect, and it moved.** The 2026-08-20 physical swap relocated pack `Y712ZABA4H350037` from Core 3 to **Core 4**, and the fault followed the pack. That is the discriminating evidence: the chassis is clean, the pack is defective. `/api/defective-packs` as of 2026-09-11 — **byte-identical to the prior reading**:

| Field | Value |
|---|---|
| `packSn` | `Y712ZABA4H350037` |
| Host now | **Core 4** (`Y711ZABA9H3T0489`) — was Core 3 before the 2026-08-20 swap |
| `socPct` vs `siblingMedianSocPct` | **1%** vs **86%** |
| `packAbsW` vs `siblingMedianAbsW` | **1 W** vs **350 W** |
| `deviantCell` | **31** |
| `deltaMv` | **−115 mV** |
| Confirmed at | 2026-05-23 (epoch 1787637702587) |

The signature is unchanged from the July trace — SoC pinned near zero while siblings cycle, one deviant cell, spread latched — but it is now attached to a serial number rather than a chassis position. `confirmedAtMs` is identical across both snapshots, which is the expected reading for a latched confirmation and the one that would have shown a spurious re-confirmation had one occurred.

**Update — the Core 3 voltage cluster has left the head of the subject list.** The prior snapshot recorded the Core 3 chassis, holding a *different* pack since the swap, producing the head of the 7-day list (`peer-voldiff-…J234000-1` ×13, `vdiff-warn-…J234000-1` ×13, `dpu-imbalance-…J234000` ×8) and correctly called it a separate condition rather than the migrated defect. **None of those three subjects appears in the current window's head at all** (§1). Core 3 is still represented — by `baseline-mppt_hv_temp` ×8 and `baseline-mppt_lv_temp` ×5, which are thermal-baseline subjects, not voltage ones.

Whether the voltage cluster resolved or merely fell below the window's head is **not established**: the 7-day window is a head-of-list ranking, not a presence test, and this document does not have the per-subject trend series that would settle it. It is recorded because the prior snapshot made a specific claim about that chassis which is no longer supported by the current measurement. The alert surface for the confirmed defect itself remains live: `dpu-err-Y711ZABA9H3T0489` cleared a **critical** on 2026-09-05 (3.3 min, §1).

**Warranty status:** the vendor's own diagnosis names two candidate causes — a short circuit **or** a voltage-sampling module fault. Both are pack-side. Error 533 titles as "Inverter error" but the 5xx family is battery/BMS; it has stood since 2026-07-20. A claim bundle is exportable via `/api/warranty-export`.

**Cell-spread norms and pack vitals across the wired fleet are not re-measured in this refresh.** The July figures (3–6 mV at-rest spread on healthy packs, `actSoh` 95.0–99.0% at 104–147 cycles, 29–33 °C) are **not carried forward** — they are stated here only as the prior reading, and this document's rule is that unrefreshed numbers do not become current by repetition. A fleet-wide re-measure is the obvious next addition to this section.

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
| 2026-08-20 | Membership-change defect cluster, prompted by the physical Core 3 → Core 4 pack swap | Cluster confirmed: the app assumed fleet membership never changes | v1.92.0 → v1.100.0, all live. Lesson pinned: an **event-keyed repair is unreachable if you missed the event** — trigger on state. |
| 2026-09-03 | Whole-system audit | **21 findings** | v1.120.0 → v1.123.0, all live and mutation-verified |
| 2026-09-04 → 09-05 | Detailed log audit + remediation | 16 confirmed | v1.124.x (HA-native notifications; push reached **nobody** before this — `persistent_notification` only, no `mobile_app` reference in the repo), v1.125.x (cushion re-scope), v1.129.x, v1.130.0 (restart integrity), v1.131.0 |
| 2026-09-05 | v1.130.0 release post-mortem | **1, process** | The release **silently did not happen**: the merge carried the code and CHANGELOG but not the `config.yaml` bump, and `tag-release.yml` is paths-filtered on that one file — so no tag, no image, no release, and every workflow green. Guard shipped: `scripts/check-release-pr.py`, verified against the tree that failed. |
| 2026-09-05 | Five unearned signals | **5 confirmed** | v1.131.0. Each was a detector or status field that **could not report what it claimed**: inverter standby ANDed off against a whole-house gate no occupied house satisfies; the night-charge revert closing on a cloud ACK; the rate-collapse detector never sampling a silent device; the alert-telemetry exemplar pairing one device's title with another's id; a dead push channel reporting no failures. 16/16 mutants. |
| 2026-09-05 | Live verification of v1.131.0 | **1** | v1.131.1/.2. The standby fix was **necessary and not sufficient** — `ac_out` reads 0 on all five Cores because the DPUs feed the house through the SHP2 link, not their own AC output port. Shipped an honest empty state (`blockedReason`) rather than an improvised re-point; the new field then **contradicted the release note that introduced it**, corrected in v1.131.2. |
| 2026-09-06 | Weekend-arbitrage investigation — 171 agents, every claim faced 3 adversarial verifiers | **23 survived, 32 refuted, 25 unresolved** | Refutation rate is the point: more claims died than survived. Confirmed the Friday 0 kWh buy was correct, quantified the weekend gap at **~$25–42/yr** (all weekend hours are off-peak, so the spread is 1.77 c/kWh — not an on-peak displacement problem), and established that a Thursday top-off **cannot** help (68.2 kWh usable band vs ~105 kWh/day draw). Six legibility fixes → v1.132.0, 8/8 mutants. |
| 2026-09-07 | Engine/UI review cycle F1–F12, shipped in two authorised batches | F1–F6 then F7–F12 confirmed | v1.134.0 → v1.144.0. Headline: the Energy page could finally show money; the DB snapshot says how old it is; the discovery table stopped lying about what it published. v1.141.1 was a same-day **correction** — v1.141.0's `object_id` was inert because HA mints the entity id from the *name*, so the rename never reached the twelve circuit sensors. |
| 2026-09-08 | False "EcoFlow data restored" push — root-caused from the log ring | **1 critical attribution defect** | The device went OFFLINE at 15:52:31.591 and the "restored" push fired at 15:52:31.893 — **302 ms later**. `lastUpdated: 0` for that SN proved no quota fetch had ever succeeded: the push was announcing recovery of telemetry that had never arrived. v1.138.0 fixed the attribution (`refreshAll` now returns `{attemptedSns, failedSns}`); v1.139.0 **deleted the doorbell entirely** after the owner settled that error 1006 is product-class, with a build-failing pin so it cannot return. |
| 2026-09-10 | Cloud-shadow investigation — settled statically, then measured | **1 confirmed, mechanism established** | The EcoFlow cloud can serve a **stale shadow**: a 200 OK carrying a byte-identical replay of the previous body. Every freshness gate keyed on "the request succeeded" was therefore disarmed. Settled by reading the mechanism (`setDeviceQuota` replaces wholesale; no cache/ETag; MQTT translation is DPU-only) and then measuring a 12-channel witness vector across 1,558 minutes. v1.142.0 added `contentStaleSinceMs` + the shadow witness; v1.143.0 carried the sticky clocks through the 60-s rebuild. |
| 2026-09-10 | Log audit round 2 — 6 families, adversarial verification | 83 raw → **27 survived**, 22 refuted | v1.145.0–v1.148.0. The refutation rate is again the point. Headline finds: the log ring **is** the incident window (~53 h reach) and one status family was 84% of all push volume; a per-poll success line was 32.5% of log bytes and became a periodic p50/p95/max summary; `basisBlockedBy` now names which basis gate closed. ★ **A claim of mine was falsified in this cycle**: two releases had been justified by a forensic-reach argument that required `LOG_LEVEL=debug` to be off, and my own earlier notes recorded it as standing. |
| 2026-09-11 | Documentation freshness + GitHub surface audit | **2 doc-correctness defects, 1 engine defect** | v1.149.0. DOCS.md stated the advisor's basis gate as `≥ 0.9` — the identical error `PERFORMANCE.md` had **found and corrected in its own text on 2026-09-06**, while the normative reference it was measured against went untouched for five days. DOCS.md also listed two of `poll_health`'s three reasons. The engine defect is the `bandSigmaCal` five-way ambiguity in §2, found by refreshing a table rather than by reading code. Six README claims had silently rotted; `scripts/check-doc-claims.mjs` now fails CI on any of them. |

The pattern this table exists to preserve: findings are only counted after independent adversarial verification; safety-direction findings (under-buy, optimistic runway, silenced alarms) ship with regression tests pinning the failure; and reviews of fixes have repeatedly found real defects (the 07-20 second pass, the v1.26 in-review catch, the v1.131.1 live check), so post-merge review remains part of the pipeline, not a formality.

**What the 2026-09 cycle added to that pattern.** Three of its findings shared a shape worth naming, because it defeats review: *silence and correctness are indistinguishable from outside*. A release that never ran, a detector that never fired, and a ledger row that filed an impossible night as a quiet one all presented as healthy, and all survived because there was nothing to disagree with. Two of them were caught only by **querying the device after shipping a fix that reviewed as correct**. The countermeasure now in the codebase is to make empty states say which empty they are (`blockedReason`, `arm_disposition`, `cost_ceiling_basis`, `standbyBlockedReason`) rather than rendering blank.

**Committed mutation harnesses: 30, with 203 anchors** (prior reading: 17 harnesses / 102 anchors), validated in CI by `scripts/check-mutant-anchors.mjs` — which exists because a harness whose anchors stop matching does not fail, it stops running, and an aborted harness reads exactly like a clean one. Two harnesses recorded a **removed** mutant with its reasoning (one provably equivalent, one requiring a state the suite cannot construct) rather than leaving a permanent false survivor in the count.

★ **A harness result is meaningless against a red tree.** Twice in the 2026-09 cycle a harness reported a full kill count while two tests were already failing — a red baseline kills every mutant for free, and the number reads identically to a genuine clean sweep. Confirming `0 fail` before reading any harness result is now part of the procedure, not a courtesy.

---

## 6. Known limitations & data-gated features

Conditions below read as gaps by design. They are listed so an `unknown`/null reading is not misdiagnosed as a fault — and, where a limitation has since been resolved or reclassified, that is stated rather than the old text being quietly deleted.

- **Expected-unknown sensors on a near-new fleet** (DOCS.md §6) — *unchanged*: `..._soonest_pack_eol`, coulombic efficiency, predictive SoH and the immature internal-resistance trend all publish `unknown` until genuine aging signal exists; `..._runway_to_reserve_if_shed` is null whenever no shed scenario is advisable. Null over a fabricated number, in every case.
- **~~Tariff rates unconfirmed~~ — RESOLVED.** The prior snapshot recorded every dollar field as null pending rates from a bill. The APS R-EV rates are now entered and confirmed: overnight super-off-peak **13.1 ¢/kWh**, off-peak **17.0 ¢**, summer on-peak **41.6 ¢**, winter on-peak **39.5 ¢**, winter super-off-peak **8.2 ¢**. On-peak is **Mon–Fri 16:00–19:00 only**; every weekend hour is off-peak. At `DISPATCH_ROUND_TRIP_EFFICIENCY = 0.86` (charge leg `√0.86 = 0.9274`, discharge leg 0.94, product 0.872) stored overnight energy delivers at **15.02 ¢/kWh** — cheaper than off-peak by 1.98 ¢ and than on-peak by 26.6 ¢. **Rates are manual and carry no expiry check**; a tariff change would be silently stale.
- **Inverter standby is not measurable on this topology** — *new, v1.131.1*. The Delta Pro Ultras feed the house through the SHP2 link rather than their own AC output port, so `ac_out` reads 0 (with `acOutVol` 0) in normal grid-tied operation and kilowatts while islanding — a bimodal register with no idle plateau, because an inverter that is off reports 0 rather than its own self-consumption. `idleWatts` therefore publishes null with an explicit `blockedReason` (`ac-output-stage-idle` on Core 4, `insufficient-idle-samples` on the rest) instead of rendering blank. Recovering standby draw would mean inferring it from pack drain (`bat_amp × bat_vol` while PV is dark and output is zero) — a different measurement, not a re-point.
- **The write-readiness gate cannot open on current inputs — and now has a SECOND, independent blocker** — *the most consequential item here*. See §3: the gate's own blocking text reports the under-buy criterion as **UNREACHABLE**, not thin, because all 15 actuated nights disclose a cushion shortfall and are exempt from the sizing judgement. More nights will not change it. **As of 2026-09-11 more nights are also not arriving**: the advisor's basis gate closed at 72% band coverage, so no plan is being produced and no night can be actuated or scored. The two blockers are unrelated in cause and independent in remedy — clearing one leaves the other. This is an owner decision (re-scope the cushion) rather than a data-accrual wait. *The owner took that decision on 2026-09-06 — a 10% total protected floor with the cushion disabled — and v1.133.0 made the engine able to express it; the settings are deliberately not yet applied, pending the rate-aware objective. When they are, expect this block to clear — and note that it will clear because the standard was **lowered**, not because it was met.*
- **~~A zero outage cushion silently became the legacy band~~ — RESOLVED v1.133.0.** Setting
  `ARB_OUTAGE_CUSHION_HOURS: 0` did not disable the cushion: the guard folded `outageHours <= 0`
  into the same branch as *"no islanded-load measurement available"*, so a deliberate zero
  returned the flat 15%-of-pool band (13.8 kWh here). The option was accepted, the config
  validator passed, and the setting did not take effect. It was worse than inert — the legacy
  basis also switches the cushion test to the whole-house forward trough, which is harsher, so
  **asking for no cushion made the requirement larger**. There is now a distinct `disabled`
  basis, checked before the unmeasurable branch, and a disabled cushion announces itself in the
  rationale rather than reading as a floor-plus-cushion that was comfortably covered. Malformed
  values (negative, `NaN`, `Infinity`) still fall back conservatively. Listed here rather than
  deleted because it is the same shape as the three items below: work that was done, plumbed
  somewhere it could not take effect, with nothing failing to say so.
- **~~A `0` that means "cannot count"~~ — RESOLVED 2026-09-11 for strikes; the caution still stands generally.** `strikesMeasurable` has gone **0 → 1**, so `activeStrikes: 0` now reports a genuine absence of engine faults rather than an inability to look. It resolved the right way — the measurement became possible, rather than the zero being reinterpreted. The general caution is unchanged and still load-bearing: any zero in `readiness.metrics` whose companion `*Measurable` field is also zero is an inability to count, and `underBuyMeasurable` is still **0**.
- **`grid_home` coverage gate** — *unchanged*: whole-home grid accounting trusts `grid_home_w` only at `GRID_HOME_MIN_COVERAGE = 0.9` of panel-load coverage; below that the KPIs fall back to the DPU-side basis and `grid_home_coverage_frac` reads null. Cloud-offline SHP2 windows are the dominant cause. All six recent ledger rows read coverage 1.0.
- **★ Band coverage vs. the advisor — RECLASSIFIED A SECOND TIME, and now BINDING.** This item has now been wrong in both directions in five days, which is itself the finding. The 2026-07-21 snapshot said a 90% gate held every plan at null; the 2026-09-06 snapshot corrected the gate to **0.78**, reported 84% coverage, and concluded *"the basis is satisfied; plans are sized"*, naming `loadBandCoverage` (0.769) as the genuinely binding constraint. Both halves of that have since flipped: **PV band coverage fell to 72% and the basis gate is now closed**, while `loadBandCoverage` rose to 0.833 and is no longer binding anything. The advisor produces no plan at all (§2). The threshold (0.78) was the only part of the 09-06 entry that survived — and it survived because it was read from the source rather than inferred from behaviour.
- **The weekend arbitrage gap is real and small** — *new, quantified 2026-09-06*. Friday's overnight window is 1 hour, Saturday has none, Sunday 5 h, Mon–Thu 6 h. Because every weekend hour is off-peak, the only weekend arbitrage is carrying 13.1 ¢ energy into 17.0 ¢ hours: **1.77 ¢ per delivered kWh**, ≈ **$0.50–0.80 per weekend** (hard physical ceiling $1.28), ≈ **$25–42/yr**. A Thursday pre-buy cannot close it — the usable 16→90% band is 68.2 kWh against ~105 kWh/day of draw, so Friday consumes it before Saturday starts. **Open question with a cheap answer:** whether APS treats Fri 23:00 → Sat 05:00 as one overnight block. The code flags this in three places; one bill settles it, and it is the difference between a 1-hour and a 6-hour Friday.
- **`ARB_COST_MAX_SOC_PCT = 90` is not deliverable above 50** — *confirmed 2026-09-06*. The actuator's only write is the backup-reserve setpoint, capped at 50 in two independent places: `clampReserveTarget` (`nightChargeActuator.ts`) and `setBackupReserveSoc`'s own range check (`ecoflow/commands.ts`), which refuses out-of-range before any network call. The option's schema is `int(50,100)` — **its minimum equals the write's maximum**, so every legal value produces the identical instruction. Live corroboration: an armed plan carrying `setpointSocPct = 100` produced an actuation `targetPct = 50`, and the 2026-09-03 delivery of 33.25 kWh matches a 16%→50% charge on a ~92 kWh pool. Charge power binds first regardless — a six-hour weeknight tops out near **60% SoC** even with the clamp removed — so 90% is unreachable by two independent limits. Raising the ceiling would need a force-charge write path; `setChannelForceCharge` exists but is only ever called with `on: false`. **Unresolved:** whether the SHP2 firmware would accept a setpoint above 50 at all. No probe exists in the repo and it cannot be answered from code.
- **★ `bandSigmaCal = 1` was ambiguous across five states** — *new, found and fixed 2026-09-11*. The published shrink multiplier read `1` whether the calibration was **saturated** (active, band too narrow, `Math.min(1, …)` forbidding a widen), **uncalibrated** (never engaged — the v1.23.0 production defect), exactly 1 by coincidence, an operator override of 1, or — in the durable ledger column — simply absent, via an `?? 1` fallback. The prior snapshot inspected this field and checked only the *floor* ambiguity. v1.149.0 publishes `bandSigmaCalBasis` beside it and writes `null` rather than `1` for a missing forecast; `scripts/mutate-band-cal-basis.mjs` holds it with 7 mutants. Full account in §2.
- **Delivery over-shoot is real but formally unmeasured** — *new, 2026-09-11*. Every actuated night in the current sample delivered **48–55% more** than the sized buy (~+10 kWh), against a readiness criterion requiring delivery bias in [0, 5] kWh. `buyBiasKwh` nonetheless reads `null`, because all fifteen nights are exempted from the sizing judgement as disclosed cushion shortfalls. One criterion's exemption is suppressing another criterion's measurement. Six nights is not a distribution and no conclusion is drawn — this is recorded so that if the cushion exemption ever lifts, the over-shoot is already on the record as the first thing to examine.
- **The load over-forecast signature resolved on its own** — *closed 2026-09-11*. The prior snapshot recorded 19–39 kWh of one-directional load over-forecast on five consecutive nights and declined to fit a correction to it. The current sample alternates sign at a fraction of the magnitude and the aggregate bias improved without intervention (§2). Had a bias factor been fitted to the transient, it would now be pushing an unbiased forecast in the **unsafe** direction. Listed as a closed item rather than deleted, because the value was in the restraint.
- **★★★ A third of the fleet went dark for nine days and nothing said so** — *new, 2026-09-11; partially fixed v1.150.0*. Core 2 (`Y711ZAB59GBC0482`) recorded **zero samples of every metric from 2026-08-11 to 2026-08-19**. No log line, no alert, no telemetry-gap record. The gap detector sets `sawHomeInsert` on **any** non-bench home SN, so Cores 1 and 3 writing normally reset the fleet clock on every batch and a single-core blackout was invisible to it *by construction*. It surfaced six weeks later only as a second-order effect — fleet PV sums across that window returned **32%** of true production, and the resulting phantom forecast misses closed the night-charge basis gate. v1.150.0 adds a per-device staleness sweep (6 h threshold, one record per blackout, bench spares exempt). **What is still open:** nothing reconciles a dark window against the vendor's own daily totals, which *did* show the disagreement the whole time — `driftSolarPct` read **+47%** through the episode and has **zero consumers** anywhere in the codebase.
- **★ The forecast-skill scorer applies TODAY's fleet membership to 30 days of history** — *new, 2026-09-11, DELIBERATELY NOT YET FIXED*. `computeForecastSkill` resolves the roster once at report time (`analytics.ts:5251`) and applies it retroactively to every hindcast day. Core 3 was a home-pool core through 2026-08-19 with **18.2–22.8 kWh/day sitting in the recorder**, and is excluded from those days purely because it is on the bench *today*. The coverage gate that should have caught the result was disarmed by v1.94.0's `skipBeforeJoin`, which infers *"had not joined yet"* from *"has no recorder rows yet"* — **the identical signal a blackout produces**. This is the same membership-change defect family as the v1.92.0–v1.100.0 cluster, in a new place. It is not fixed in v1.150.0 for a stated reason: correcting it nulls the eight bad days, which reopens the basis gate *and* narrows the published band **3.5×** (`producedHalfFrac` 0.5549 → 0.3998) in one step. The condition self-clears as the block ages out of the 30-day window; the fix belongs after that, measured against a clean baseline, not on top of a live artifact.
- **★ Robustifying the band quantile would make the gate WORSE, measured** — *new, 2026-09-11*. The obvious response to eight outlier days is a trimmed or median-based estimator. Tested against the live 29 errors with the exact `producedHalfFrac` 0.5549: median → **66%**, 20% trimmed mean → **66%**, median+1.282·MAD → **69%**, P80-of-clean-days → **66%** — every one *below* the current 72%. Coverage does not read the quantile; it counts errors under `producedHalfFrac × bandCal`, and the quantile only sets `bandCal`. A **high** quantile saturates `bandCal` at 1, which makes the threshold as wide as it can be; a smaller quantile floor-pins `bandCal` at 0.4 and collapses the threshold, ejecting two legitimate days. Recorded because the intuition is strong and wrong, and acting on it would have been a regression in a life-safety gate.
- **★ The basis gate is effectively a SATURATION detector, not a coverage test** — *new, 2026-09-11*. Derived and verified: in the `shrunk` regime the threshold equals `realizedHalfFrac = errs[k-1]`, and in `floor-pinned` it exceeds it, so coverage ≥ `k/n` = `ceil(0.8(n+1))/n`, which is **83–86% for every n in [14,30]** — always above the 0.78 bar. The gate can therefore fail **only** when `bandSigmaCalBasis == 'saturated'`. The coverage percentage is downstream of that flag rather than an independent measure of forecast quality, which is what v1.149.0's `bandSigmaCalBasis` makes visible.
- **`chronicNoiseSilenced` (Rule 3) cannot fire for the case it is named for** — *new, 2026-09-11, NOT FIXED BY DESIGN*. The rule exists for *"the condition exists but the user has accepted it … they're not going to do anything"* (`alertMonitor.ts:679-683`). Its numerator, `neverClearedCount`, is incremented **only inside `recordClear`** — it counts long-duration **clears**, not long **active** time. A genuinely standing chronic alert therefore has `riseCount` 1 and `neverClearedCount` 0, ratio **0.0**, and also fails the `riseCount >= 10` floor: **the longer the condition actually stands, the further it is from firing.** Across all 52 live families no non-exempt family with `riseCount >= 10` exceeds **0.0897**, so Rule 3 has fired zero times. The threshold is *not* unreachable — `shp2-below-reserve` reads 0.5909 right now and is spared only by the `ENERGY_STATE_FAMILIES` exemption — so lowering 0.5 would not help. **Deliberately left unfixed:** repairing Rule 3 makes an alarm-**suppression** rule fire *more*, which is the unsafe direction on a life-safety path. Whether to silence standing chronic alerts is an owner decision, not a maintenance one.
- **Cost mode is rate-blind** — *new*. `costModeTargetKwh` reads no tariff. "Cost" means *fill further*, on the premise that overnight energy is the cheapest the day offers; it does not optimise against the rate table. The tariff model informs the *window*, not the *target*.
- **The comfortable-hold case is rare on this plant** — *measured 2026-09-06*. The no-shortfall hold returns before `ARB_OBJECTIVE` is read, so on a night whose trough already clears floor+cushion the objective has no effect. Over the trailing seven ledger rows exactly **one** held, and it held because a one-hour Friday window could not serve the requirement — not because the night was comfortable. Moving the objective check earlier would therefore address a near-empty population; the reorder was investigated on 2026-09-06 and **not shipped** for that reason. `actual_onpeak_import_kwh` is **0 on every scored night**, so the on-peak displacement value that would justify it is also absent.

