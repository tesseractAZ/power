# System Performance Record (living document)

This document is the runtime-evidence companion to [`DOCS.md`](../ecoflow_panel/DOCS.md): where the engine reference specifies what the system does, this records **how it is doing** — measured event rates, realized forecast accuracy, learning-gate progress, and fleet health, taken from the production deployment's own durable ledgers. It is refreshed when the underlying data changes and snapshotted at each release; numbers are not projections and are never carried forward past their as-of stamp. All figures are measured on a **single production deployment** (one SHP2, three wired Delta Pro Ultra Cores of five packs each, two bench spares) and generalize only as an existence proof, not a distribution. Timestamps are America/Phoenix (MST, UTC−7, no DST). Where a metric has no data yet, this document says so and states when accrual began — null over fabrication, the same rule the engines themselves follow.

Evidence sources: the cleared-alert ledger (`/api/alerts/history`, cap `CLEARED_LOG_MAX = 1500`), the night-charge ledger (`night_charge_ledger` via `/api/night-charge/status`, which mirrors **every** ledger column), the write-readiness gate (`readiness.metrics` on the same route), the probabilistic-band diagnostics (`/api/forecast/probabilistic`), the confirmed-defect register (`/api/defective-packs`), and the live snapshot. Current data-as-of: **2026-09-06 08:02 MST** across §1–§4, measured against the deployment running **v1.132.0**. The 2026-07-21 / 2026-08-01 figures they replace are not carried forward; where a July number is shown it is labelled as the prior reading, for trend only.

---

## 1. Alarm engine — audible-event discipline

The design goal (DOCS.md §8, §10) is a steep annunciation pyramid: a wide base of visible-but-silent conditions, a narrow band of push notifications, and audible broadcast reserved for standing critical conditions — at most one voice alarm per escalation. The cleared-alert ledger measures whether that holds. It is **at its `CLEARED_LOG_MAX = 1500` cap**, so its span (2026-07-05 21:04 → 2026-09-06 08:02 MST) is truncated at the front and totals over the full span are lower bounds; the trailing-7-day window below is complete.

**Trailing 7 days** (2026-08-30 08:02 → 2026-09-06 08:02 MST; the ledger records rises that stood ≥ `DEBOUNCE_MS` = 60 s and then cleared, so sub-minute flaps and still-standing alerts are additional to these counts):

| Metric | 2026-09-06 | Prior reading (2026-07-21) |
|---|---|---|
| Alert rises cleared through the ledger | **113** (≈16/day) | 322 (≈46/day) |
| — info severity | **0** | 207 (64%) |
| — warning severity | **111** (98%) | 115 (36%) |
| — critical severity | **2 cleared** | 0 cleared (3 standing) |
| Unique alert subjects (`alert.id`) | **36** | 60 |
| Learned/anomaly-source share | 47 (42%) | 178 (55%) |
| Median standing duration | **51.3 min** (p90 ≈ 6.2 h) | ~34 min (p90 ≈ 5.6 h) |
| Short clears (≤ 10 min) | **12** (11%) | 60 (19%) |
| By category | Battery 60 · Thermal 25 · Connectivity 20 · SHP2 6 · Grid 2 | Battery 118 · SHP2 117 · Thermal 54 · Connectivity 21 · Solar 10 · Grid 2 |

**The rate fell by ~65% and the info tier vanished from the ledger entirely.** Both are measurements, not explanations: this document does not attribute them. Candidate causes span the v1.92.0–v1.132.0 releases (auto-tune demotion, the v1.130.0 boot-retrack fix that stopped counting a restart as a rising edge, and the SHP2-category collapse from 117 to 6 which is the largest single category change) and none has been isolated. **A zero info count is itself worth watching**: the pyramid's wide silent base is the design, and an empty base is equally consistent with "the base is quiet" and "the base stopped being recorded". Not resolved here.

**Criticals cleared in the window: 2.**

| Cleared (MST) | Subject | Duration |
|---|---|---|
| 2026-08-30 21:10 | `storm-Severe_Thunderstorm_Warning` (NWS pre-charge advisory) | 20.2 min |
| 2026-09-05 10:05 | `dpu-err-Y711ZABA9H3T0489` — the Core 4 inverter error carrying the migrated defective pack (§4) | 3.3 min |

**Top subjects in the window** — 113 rises collapse onto 36 subjects, and the head is the Core 3 pack-1 voltage cluster: `peer-voldiff-…J234000-1` ×13, `vdiff-warn-…J234000-1` ×13, `dpu-imbalance-…J234000` ×8, then `baseline-mppt_lv_temp` (Core 1) ×6, `shp2-below-reserve` ×6, and `msg-rate-floor-…G9P0090` ×6.

**Broadcast path**, live at time of writing: `enabled`, `targetCount` **3** (2 Music Assistant + 1 SIP cordless — the SIP leg became visible on this route only in v1.131.0; before that it reported 2 of 3), `audibleReachable: true`, last delivery `yellow`/`success`, `stormSuppressedCount` 0.

**Outcome telemetry exists; a false-positive rate does not.** Unchanged from the prior reading: `/api/alerts/outcomes/stats` computes per-family precision as `(ack+failed)/(ack+failed+dismiss)`, which is **response telemetry, not a measured false-positive rate** — unacknowledged alerts are unlabeled, `resolved` is excluded as ambiguous, and coverage is operator-effort-bound. No precision figure is published until the labeled fraction is large enough to mean something.

---

## 2. Forecast accuracy

The day-ahead PV forecast wraps its deterministic P50 in a self-calibrating P10/P90 band (formulas in DOCS.md §3.6). Values as of **2026-09-06**:

| Diagnostic | 2026-09-06 | Prior (2026-07-21) | What it measures |
|---|---|---|---|
| `calScoredDays` | **19** | 17 | Scored calibration days inside the `PV_BAND_CAL_WINDOW_DAYS = 30` window. ≥ `PV_BAND_CAL_MIN_DAYS = 14`, so the calibration is **active**. |
| `realizedDailyErrHalfFrac` | **0.256** | 0.269 | Empirical daily half-width required for expected coverage ≥ 80%. |
| `bandSigmaCal` | **0.50** | 0.52 | Shrink multiplier, `clamp(0.4, 1, realizedHalfFrac / producedHalfFrac)`. Still **above its 0.4 floor** — data-driven, not floor-pinned. |
| `bandRealizedCoveragePct` | **84** | 88 | Share of scored days whose realized daily error fell inside the band's daily half-width. |

**Correction to the prior snapshot: the advisor's basis gate is 0.78, not 0.90.** The 2026-07-21 entry stated the night-charge advisor "refuses to size a buy" below 90% band coverage and attributed every null plan since 2026-07-18 to that gate. The live threshold is `bandCoverageFrac >= 0.78` (`nightChargeAdvisor.ts:1409`). At 84% the basis is **satisfied**, and plans are being sized — which is why §3 now shows real buys where the prior snapshot showed nulls. Whether the gate was 0.90 in July and was later relaxed, or the prior entry was wrong when written, is not established from the current tree; only the present value is asserted here.

**Component accuracy from the readiness gate** (`readiness.metrics`, 13 verdict-bearing captured forecast nights) — these are the numbers the gate itself judges, and they separate PV from load:

| Metric | Value | Reading |
|---|---|---|
| `pvMae` / `pvBias` | **0.078** / **−0.022** | PV forecast is accurate and near-unbiased. |
| `loadMae` / `loadBias` | **0.178** / **−0.082** | Load error is **2.3× PV error**, biased in the over-forecast direction. |
| `pvBandCoverage` | **1.00** | Every scored night's PV landed inside the band. |
| `loadBandCoverage` | **0.769** | The load band misses ~1 night in 4 — and it is the binding half of `bandCoveragePct` (76.9%). |

**Load, not PV, is the weak forecast.** The scorer's per-night notes carry the same signature on five consecutive nights (2026-08-31 → 09-03): `net forecast miss −23.52 kWh (PV 57.28→61.83, load 110.63→91.66)`, `−29.63 (PV 57.58→62.22, load 131.51→106.52)`, `−19.02 (PV 51.13→55.76, load 114.77→100.38)`, `−29.63 (PV 57.19→54.97, load 124.89→93.04)`, `−30.79 (PV 55.47→47.55, load 120.55→81.84)`. Load is over-forecast by **19–39 kWh (17–32%)** every night in the sample; PV is under-forecast on four of five. Since the buy is sized against forecast load, a systematically high load forecast inflates the requirement — the effect is in the **conservative** (over-buy) direction for safety, and in the costly direction for the bill. Five nights is not a distribution; it is a consistent enough signature to name and watch, not to correct blindly.

---

## 3. Night-charge advisor

**Scored actuated nights: 11** (prior snapshot: 0). The engine has moved from "no evidence" to "evidence accruing", and the supervised write path has been exercised on real nights.

**Recent ledger rows** (`/api/night-charge/status` → `recentOutcomes`, all `posture=supervised`, `algo_version=3`):

| Plan night | objective | buy → delivered (kWh) | binding cap | actuated | Notes |
|---|---|---|---|---|---|
| 2026-08-31 | `resilience_cushion` | 15.71 → **0** | `evContention` | 1 (applied) | Window import **16.54 kWh** at full coverage, pack min **48%** — the import served the house, not the pack. Not a failed write and not a measurement gap; `delivered_kwh` measures **storage**, and 0 is the correct storage answer. |
| 2026-09-01 | `resilience_cushion` | 21.6 → 25.32 | `evContention` | 1 | window import 51.6 kWh |
| 2026-09-02 | `resilience_cushion` | 16.19 → 23.36 | `evContention` | 1 | window import 44.41 kWh |
| 2026-09-03 | `resilience_cushion` | 21.6 → 33.25 | `evContention` | 1 | window import 50.21 kWh |
| 2026-09-04 | `none` | 0 → — | `evContention` | — | Friday: a **1-hour** window against a whole-pool requirement. Correct hold, not a defect (§6). |
| 2026-09-05 | **`cost_arbitrage`** | 36 → — | `chargePower` | — | First night cost mode engaged; `cost_ceiling_basis = max-soc`. |

Three things this table establishes that were previously unanswerable:

- **Cost mode first contributed on 2026-09-05.** Every prior row reads `objective = resilience_cushion` with `cost_ceiling_basis` null. The column that discriminates a *configured* cost mode from a *contributing* one shipped in v1.132.0; before it, `objective` alone could not answer this.
- **`binding_cap` is `evContention` on five consecutive nights.** With `ARB_GRID_INPUT_CAP_KW = 17` and the EVSE drawing ~11.5 kW, the packs are left ~5.5 kW against a 7.2 kW `ARB_CHARGE_CAP_KW`. EV contention, not window length or pool headroom, is the routine limiter on a weeknight buy.
- **`required_extra_kwh` reads 92.16 on every row** — the `!meetable` whole-pool placeholder — and **`cushion_shortfall = 1` on every row**. The cushion is not being met on any night in the sample.

**Write-readiness (gate v2, as of 2026-09-06): `LEARNING`, `writeReady = false`.** Four criteria block it, and one of them is blocked *structurally*:

| Criterion | Measured | Required |
|---|---|---|
| Scored actuated nights | **11** | ≥ 21 |
| Under-buy rate | **`null` — 11 of 11 nights excluded** | ≤ 0.10 |
| Delivery bias | **`null`** (`buyBiasKwh` unmeasured) | [0, 5] kWh |
| Band coverage | **76.9%** over **13** nights | [78%, 92%] over ≥ 14 |
| Engine-fault strikes | `activeStrikes` 0, but **`strikesMeasurable` 0** | 0 |

★ **The gate states, in its own blocking text, that it cannot open:**

> "under-buy rate UNREACHABLE, not merely thin — all 11 of 11 actuated night(s) disclosed a cushion shortfall and are therefore exempt from the sizing judgement. The cushion requirement is not satisfiable on this plant (the worst-case day drains more than the pool holds), so the flag is a constant and more nights will not change this. Re-scoping the cushion is an owner decision; until then this criterion cannot be met and the gate stays closed."

This is the single most important line in this document. **Accruing more nights will not graduate `auto` mode.** The v1.125.0 cushion re-scope onto an islanded-outage basis (4 h × measured islanded load × safety factor ≈ 23 kWh, versus the legacy whole-house band) was intended to make the cushion satisfiable; the ledger shows `cushion_shortfall = 1` on every row since, so **either the re-scope did not resolve it or a second cause is now binding**. That is not established here and should not be assumed either way. Note also that `activeStrikes: 0` reads as "no faults" but `strikesMeasurable: 0` means the strike detector **cannot count** — a zero that carries no information, the same shape as the blank rows v1.131.1/v1.132.0 exist to make legible.

**Actuation integrity.** The supervised write path applies, verifies against device readback, retries, and escalates. v1.131.0 extended readback verification to the **revert** side, which had been closing on a cloud ACK — the exact evidence v1.79.0 ruled insufficient on the apply side. It was exercised on live state within minutes of deploying: the 2026-09-03 night was found reverted-but-unverified, the panel was read at 16%, and `revertVerifiedAtMs` was stamped.

**A known over-promise, unfixed at time of writing.** The plan rationale — which feeds the 21:30 notification and the spoken broadcast — prints `setpointSocPct` un-clamped. Tonight's armed plan announces *"The reserve is set to 100%"* while `clampReserveTarget` writes **50** (`nightChargeActuator.ts:183`, `Math.min(50, …)`). The announced number is not the number sent to the device. Logged here because it is the same defect family as §5's v1.132.0 work and has not yet been corrected.

---

## 4. Fleet health summary

**The Core 3 Pack 1 episode resolved into a confirmed pack defect, and it moved.** The 2026-08-20 physical swap relocated pack `Y712ZABA4H350037` from Core 3 to **Core 4**, and the fault followed the pack. That is the discriminating evidence: the chassis is clean, the pack is defective. `/api/defective-packs` as of 2026-09-06:

| Field | Value |
|---|---|
| `packSn` | `Y712ZABA4H350037` |
| Host now | **Core 4** (`Y711ZABA9H3T0489`) — was Core 3 before the 2026-08-20 swap |
| `socPct` vs `siblingMedianSocPct` | **1%** vs **86%** |
| `packAbsW` vs `siblingMedianAbsW` | **1 W** vs **350 W** |
| `deviantCell` | **31** |
| `deltaMv` | **−115 mV** |
| Confirmed at | 2026-05-23 (epoch 1787637702587) |

The signature is unchanged from the July trace — SoC pinned near zero while siblings cycle, one deviant cell, spread latched — but it is now attached to a serial number rather than a chassis position. The matching alert surface is live: `dpu-err-Y711ZABA9H3T0489` cleared a **critical** on 2026-09-05 (3.3 min, §1), and the Core 3 chassis, now holding a different pack, still produces the head of the 7-day subject list (`peer-voldiff-…J234000-1` ×13, `vdiff-warn-…J234000-1` ×13, `dpu-imbalance-…J234000` ×8) — a separate condition on the same chassis, not the migrated defect.

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

The pattern this table exists to preserve: findings are only counted after independent adversarial verification; safety-direction findings (under-buy, optimistic runway, silenced alarms) ship with regression tests pinning the failure; and reviews of fixes have repeatedly found real defects (the 07-20 second pass, the v1.26 in-review catch, the v1.131.1 live check), so post-merge review remains part of the pipeline, not a formality.

**What the 2026-09 cycle added to that pattern.** Three of its findings shared a shape worth naming, because it defeats review: *silence and correctness are indistinguishable from outside*. A release that never ran, a detector that never fired, and a ledger row that filed an impossible night as a quiet one all presented as healthy, and all survived because there was nothing to disagree with. Two of them were caught only by **querying the device after shipping a fix that reviewed as correct**. The countermeasure now in the codebase is to make empty states say which empty they are (`blockedReason`, `arm_disposition`, `cost_ceiling_basis`, `standbyBlockedReason`) rather than rendering blank.

**Committed mutation harnesses: 17, with 102 anchors**, validated in CI by `scripts/check-mutant-anchors.mjs` — which exists because a harness whose anchors stop matching does not fail, it stops running, and an aborted harness reads exactly like a clean one. Two harnesses in this cycle recorded a **removed** mutant with its reasoning (one provably equivalent, one requiring a state the suite cannot construct) rather than leaving a permanent false survivor in the count.

---

## 6. Known limitations & data-gated features

Conditions below read as gaps by design. They are listed so an `unknown`/null reading is not misdiagnosed as a fault — and, where a limitation has since been resolved or reclassified, that is stated rather than the old text being quietly deleted.

- **Expected-unknown sensors on a near-new fleet** (DOCS.md §6) — *unchanged*: `..._soonest_pack_eol`, coulombic efficiency, predictive SoH and the immature internal-resistance trend all publish `unknown` until genuine aging signal exists; `..._runway_to_reserve_if_shed` is null whenever no shed scenario is advisable. Null over a fabricated number, in every case.
- **~~Tariff rates unconfirmed~~ — RESOLVED.** The prior snapshot recorded every dollar field as null pending rates from a bill. The APS R-EV rates are now entered and confirmed: overnight super-off-peak **13.1 ¢/kWh**, off-peak **17.0 ¢**, summer on-peak **41.6 ¢**, winter on-peak **39.5 ¢**, winter super-off-peak **8.2 ¢**. On-peak is **Mon–Fri 16:00–19:00 only**; every weekend hour is off-peak. At `DISPATCH_ROUND_TRIP_EFFICIENCY = 0.86` (charge leg `√0.86 = 0.9274`, discharge leg 0.94, product 0.872) stored overnight energy delivers at **15.02 ¢/kWh** — cheaper than off-peak by 1.98 ¢ and than on-peak by 26.6 ¢. **Rates are manual and carry no expiry check**; a tariff change would be silently stale.
- **Inverter standby is not measurable on this topology** — *new, v1.131.1*. The Delta Pro Ultras feed the house through the SHP2 link rather than their own AC output port, so `ac_out` reads 0 (with `acOutVol` 0) in normal grid-tied operation and kilowatts while islanding — a bimodal register with no idle plateau, because an inverter that is off reports 0 rather than its own self-consumption. `idleWatts` therefore publishes null with an explicit `blockedReason` (`ac-output-stage-idle` on Core 4, `insufficient-idle-samples` on the rest) instead of rendering blank. Recovering standby draw would mean inferring it from pack drain (`bat_amp × bat_vol` while PV is dark and output is zero) — a different measurement, not a re-point.
- **The write-readiness gate cannot open on current inputs** — *new, and the most consequential item here*. See §3: the gate's own blocking text reports the under-buy criterion as **UNREACHABLE**, not thin, because all 11 actuated nights disclose a cushion shortfall and are exempt from the sizing judgement. More nights will not change it. This is an owner decision (re-scope the cushion) rather than a data-accrual wait, and until it is taken, `auto` mode cannot graduate.
- **A `0` that means "cannot count"** — *new*. `activeStrikes: 0` sits alongside `strikesMeasurable: 0`; the engine-fault strike detector is not reporting an absence of faults, it is reporting an inability to count. The same caution applies to any zero in `readiness.metrics` whose companion `*Measurable` field is also zero.
- **`grid_home` coverage gate** — *unchanged*: whole-home grid accounting trusts `grid_home_w` only at `GRID_HOME_MIN_COVERAGE = 0.9` of panel-load coverage; below that the KPIs fall back to the DPU-side basis and `grid_home_coverage_frac` reads null. Cloud-offline SHP2 windows are the dominant cause. All six recent ledger rows read coverage 1.0.
- **~~Band coverage vs. the advisor~~ — RECLASSIFIED.** The prior snapshot described the 90% basis gate holding every plan at null. The gate is **0.78** (§2) and at 84% coverage the basis is satisfied; plans are sized. The genuinely binding forecast constraint is now `loadBandCoverage` at 0.769, which is what holds `bandCoveragePct` (76.9%) below the gate's [78%, 92%] readiness band.
- **The weekend arbitrage gap is real and small** — *new, quantified 2026-09-06*. Friday's overnight window is 1 hour, Saturday has none, Sunday 5 h, Mon–Thu 6 h. Because every weekend hour is off-peak, the only weekend arbitrage is carrying 13.1 ¢ energy into 17.0 ¢ hours: **1.77 ¢ per delivered kWh**, ≈ **$0.50–0.80 per weekend** (hard physical ceiling $1.28), ≈ **$25–42/yr**. A Thursday pre-buy cannot close it — the usable 16→90% band is 68.2 kWh against ~105 kWh/day of draw, so Friday consumes it before Saturday starts. **Open question with a cheap answer:** whether APS treats Fri 23:00 → Sat 05:00 as one overnight block. The code flags this in three places; one bill settles it, and it is the difference between a 1-hour and a 6-hour Friday.
- **`ARB_COST_MAX_SOC_PCT = 90` may be unreachable** — *open, under investigation at time of writing*. The only actuation is a `backupReserveSoc` write clamped to **[10, 50]** (`nightChargeActuator.ts:183`). Tonight's armed plan carries `setpointSocPct = 100` against an actuation `targetPct = 50`, and the 2026-09-03 delivery of 33.25 kWh is consistent with a 16%→50% charge on a ~92 kWh pool. If 50% is the true ceiling, the configured 90% is inert above it. Not yet confirmed; a force-charge path (`chXForceCharge`) exists in the vendor API and is currently read but not written by this engine.

