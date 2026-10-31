# System Performance Record (living document)

> [!NOTE]
> A record of the reference plant: every measurement here comes from the reference deployment,
> one grid-tied home in Arizona with its own Cores, array, loads and tariff. It shows how the
> engines perform there, not figures another home should expect.

This document is the runtime-evidence companion to the [engineering reference](reference/README.md): where the engine reference specifies what the system does, this records **how it is doing** — measured event rates, realized forecast accuracy, learning-gate progress, and fleet health, taken from the production deployment's own durable ledgers. Each section carries its own as-of stamp; numbers are not projections and are never carried forward past that stamp. All figures are measured on a **single production deployment** (one SHP2, three wired Delta Pro Ultra Cores of five packs each, two bench spares) and generalize only as an existence proof, not a distribution. Timestamps are America/Phoenix (MST, UTC−7, no DST). Where a metric has no data yet, this document says so and states when accrual began — null over fabrication, the same rule the engines themselves follow.

Evidence sources: the cleared-alert ledger (`/api/alerts/history`, cap `CLEARED_LOG_MAX = 1500`), the night-charge ledger (`night_charge_ledger` via `/api/night-charge/status`, which mirrors **every** ledger column), the write-readiness gate (`readiness.metrics` on the same route), the probabilistic-band diagnostics (`/api/forecast/probabilistic`), the confirmed-defect register (`/api/defective-packs`), the pack routes (`/api/degradation`, `/api/pack-risk`), the recorder, the add-on's own log, and the live snapshot. §1–§4 data-as-of: **2026-10-15 17:56 MST**, measured against the deployment running **v1.188.0** (`ref 111247f`, verified live on `/api/version`). The 2026-09-11 figures they replace are not carried forward; where an earlier number is shown it is labelled with its date, for trend only.

**Revision of 2026-10-15 (v1.188.0).** Every live read was read-only (GET requests, the database opened read-only). Re-measured, with the window each covers:

- **§1** — the cleared-alert ledger at its 1,500-row cap: complete for criticals; complete for warnings from 2026-09-25 20:03 except the unpushed warnings of the three auto-tuned peer families, which are evicted at any age (an estimated 47 are missing, so those families' counts are lower bounds and the figures derived from the rise counts describe the held rows); and for info only from 10-12 22:34 (trailing 7 days 10-08 17:56 → 10-15 17:56). Also the add-on log, 10-13 18:06 → 10-15 17:56; the broadcast speaker's Home Assistant history, 09-11 → 10-15; and the learned-warning sensor's history with the add-on's persisted alert-telemetry log, 09-25 → 10-15.
- **§2** — the probabilistic route (17:53), the forecast-skill route (30 days, 09-15 → 10-14), the night-charge ledger (86 rows, plan dates 07-17 → 10-14; 52 graded forecast nights, 08-23 → 10-13), and the hourly backtest route, whose live 168-h window (10-08 17:56 → 10-15 16:56) takes in 17 held hours of 10-15 and is therefore re-scored offline on the 151 hours ending by 10-15 01:55. Every figure computed from the current forecast model rests on a 30-day fit that takes in the held daylight hours of 10-15, and is in-sample (§2).
- **§3** — the same ledger, the readiness route, and the readiness sensor's history, 09-20 → 10-15.
- **§4** — the pack routes (each Core's last live reading, about 10-14 23:50) and the recorder's pack full-charge series from 08-15.
- **§4a** — a live check on three nights, 10-12 → 10-14; the 30-span table of 2026-10-11 is not re-run.
- **§4c** — the Supervisor's add-on log, 10-13 18:06 → 10-15 17:52 (47.8 h, two boots), and probes at 17:56–18:08.
- **§7** — suite and harness runs at 111247f, 2026-10-15 17:56–18:30, and four later full-suite runs the same day on the same code, ending 18:52–19:23.

Not re-measured: §4b (2026-09-11), the §4a span table, §4's cell-spread norms, the §7.2 full sweep and every harness time but three, and each §6 item that names an earlier date. §5 adds the review cycles of 2026-10-11 → 10-14. ★ At the time of measurement all five Cores had been offline per the EcoFlow cloud since 10-15 01:55, after a 122-minute name-resolution outage, and the recorder kept writing their last values as fresh samples (§6); the SHP2 was offline with them until 04:16 and its series were held the same way. No measured figure here uses the Cores' recorder data after 10-15 01:55 or the SHP2's for 01:55 → 04:16, except these, each stated where it appears: §6, §3's account of the 10-14 night and §4c's recorder-intake figure use the held rows as evidence of the hold; §4c's database size counts them among its samples; §3 quotes the 10-14 night's scorer coverage, which counts them, beside its live coverage; and every figure computed from the current forecast model — §2's probabilistic diagnostics and the 10-15 plan's basis reading that uses them, the forecast-skill route, the hourly backtest route and its offline re-score, and §6 where it quotes them — rests on a 30-day solar-response fit that takes in the Cores' held 0-W daylight hours of 10-15, and is in-sample besides (§2). §2's night-charge ledger figures, graded from forecasts issued before the hold, carry neither. Read-back checks made at 18:45–19:32 (the held rows themselves, the backtest's actuals, the ledger's coverage column and the 10-14 row's PV coverage) cover fixed, elapsed windows, except the 10-14 row's PV coverage, which §6 dates.

**Revision of 2026-10-26.** §4e is new (the remaining dark-fleet rebuilds, a replay on synthetic databases, v1.191.2 → v1.191.3); §4b moves, unedited, to `docs/history/` to make room. Nothing else is re-measured.

**Revision of 2026-10-23.** §4d gains the Pi after the update. **2026-10-22:** §4d is new (the live host and a replay, v1.191.1 → v1.191.2); §4c gains a note. Nothing else is re-measured.

---

## 1. Alarm engine — audible-event discipline

The design goal (reference [chapter 8](reference/08-1-alerts.md#8-alerts-anomaly-detection-incidents--learning-loop) and [chapter 10](reference/10-audible-broadcast.md#10-audible-broadcast-chimes--text-to-speech)) is a steep annunciation pyramid: a wide base of visible-but-silent conditions, a narrow band of push notifications, and audible broadcast reserved for standing critical conditions — at most one voice alarm per escalation. The cleared-alert ledger measures whether that holds, and since v1.187.1 each row also records whether its rise was pushed.

**What the capped ledger still holds.** At the 2026-10-15 17:56 fetch the ledger was at its `CLEARED_LOG_MAX = 1500` cap: 1,275 warning, 95 critical and 130 info rows (100 plain info and 30 `ems-volt` rows, which are evicted as warnings), cleared 2026-07-12 05:36 → 10-15 16:54. Since v1.187.10 the cap no longer just cuts the front of the span; it evicts by tier, so each severity is complete over a different window:

- **Criticals** are evicted last: every critical since 07-12 is held.
- **Info** keeps only its newest-100 reserve, which reaches back to 10-12 22:34 — 2.81 days at 37.8 info clears a day.
- **Warnings** are whole from the v1.186.0 restart (2026-09-25 20:03) to the fetch, with one exception: unpushed warnings of the three auto-tuned noise families (`peer-voldiff`, `peer-soc`, `peer-temp`) are evicted first at any age, and none is held — only their 8 pushed warnings are. An estimated **47** are missing from the window (13–16 of them in the trailing 7 days): peer episodes of at least 140 s in the add-on's persisted alert-telemetry log that rose within 150 s of a rise of Home Assistant's learned-warning sensor and match no held row. The estimate is an inference from those two sources, not a ledger count.
- **Before 09-25 the warning record is incomplete.** The noise tier in force before v1.186.0 (it flagged `vdiff-warn`, `balancing`, `dpu-pvh-err` and others) evicted rows from inside the window: the 2026-09-04 → 09-11 window counted 97 rows on 2026-09-11 and holds 52 now. Ordinary oldest-first eviction has not reached that far (the oldest ordinary warning held cleared 07-26 14:23). Home Assistant's warning-count sensor does not corroborate the eviction: from 09-04 to 09-16 its daily rises ran 1.2–23× the ledger's warning rows (5.0× over the span), but over the same span the critical-count sensor ran 2–14× above the critical rows on the days that hold one, and criticals are never evicted (09-04: 29 rises against none). From 09-23 the totals are close (341 rises against 375 rows), with 15 of 23 days within 3 rows and the ledger 2.7× and 2.5× above the sensor on 09-27 and 09-28.

Rates are therefore taken over **2026-09-25 20:03 → 10-15 17:56 (19.91 days; "the complete window" below)** for warnings and criticals, and from 10-12 22:34 for info; inside it the peer families' warning counts are lower bounds (above). A count over any earlier window is a lower bound, not a rate change against the 2026-09-11 reading. As in that reading, a row is one rise that stood ≥ `DEBOUNCE_MS` = 60 s and then cleared, keyed on `clearedAt`; sub-minute flaps and still-standing alerts are additional.

**Trailing 7 days** (2026-10-08 17:56 → 10-15 17:56 MST; warnings and criticals unless stated):

| Metric | 2026-10-15 | 2026-09-11 reading | Prior 7 days (10-01 → 10-08) |
|---|---|---|---|
| Alert rises cleared through the ledger | **83** (11.9/day): 73 warning, 10 critical | 97 (96 warning, 1 critical) | 119 (116 warning, 3 critical) |
| Info rows | **119**, 19 of them `ems-volt` (a warning in September); a lower bound | 0 | 11 |
| Unique alert subjects (`alert.id`) | **42** | 30 | 35 |
| Learned/anomaly-source share | **4 (5%)** of the held rows; about 18–20% with the evicted peer warnings (below). The learned MPPT-temperature baselines now emit info | 36 (37%) | 6 (5%) of the held rows |
| Median standing duration | **21.0 min** (p90 1.70 h) | 26.0 min (p90 ≈ 7.5 h) | 11.1 min (p90 0.96 h) |
| Short clears (≤ 10 min) | **28** (34%) | 22 (23%) | 54 (45%) |
| By category | Battery 57 · Connectivity 25 · Grid 1 (Thermal is all info now: 47 rows) | Battery 34 · Connectivity 31 · Thermal 26 · SHP2 6 | Battery 102 · Connectivity 17 |

The warning counts leave out the evicted unpushed peer warnings — an estimated 13–16 in the trailing 7 days, which would put the 83 at about 96–99 — and the 2026-09-11 reading counted under the pre-v1.186.0 noise tier, a different eviction basis, so 83 against 97 is not a measured fall. The same holds for every figure the table derives from the rise counts, in the trailing and the prior 7 days alike: the subject counts are lower bounds, and the share, durations, short clears and categories describe the held rows only. The learned share moves most. The evicted warnings are learned-source — the estimate matches each to a rise of the learned-warning sensor — so with them the share would be about 17–20 of 96–99 rises (18–20%), not 5%; the fall from 37% on 2026-09-11 is smaller than the held rows show, and that reading was on the other eviction basis.

**★ Over the complete window the held rate is 17.3 rises a day, and one family is half of it.** 344 rises in 19.91 days: 322 warnings (16.2/day) and 22 criticals (1.1/day), on 70 subjects — a lower bound for the peer families; with the estimated 47 evicted peer warnings it would be about 391 rises (19.6/day) on about 80 subjects. Over the held rows, median standing is 12.8 min, p90 1.97 h, with 128 short clears (37%). By family: `vdiff-warn` 173 (8.7/day, 76 of them short), `dpu-imbalance` 43 (36 on Core 3, a roster-muted bench unit), `msg-rate-floor` 25, `ems-volt` 22, `baseline-mppt_hv_temp` 16, `telemetry-blind` 15, `baseline-mppt_lv_temp` 11, `peer-voldiff` 8, `peer-soh` 8, `vdiff-crit` 7. Since v1.187.1, 91 of the 202 held warning and critical rows (45%) are roster-muted. By week (Monday start): 156 held rises in the week of 09-28 (22.3/day), 137 in the week of 10-05 (19.6/day), 23 in the week of 10-12 through Thursday (6.1/day) — the eviction estimate adds about 25, 20 and 1; `vdiff-warn` fell from 3–24 rows a day (10-01 → 10-10) to 5, 3, 1, 1 and 0 (10-11 → 10-15). No cause is attributed to either fall here.

Over the full span since the last reading (2026-09-11 08:56 → 10-15 17:56, 34.38 days) 843 rows are held — 650 warning, 63 critical, 130 info — and only the criticals are complete: **63, 1.83 a day** (`telemetry-blind` 46, `vdiff-crit` 15, `dpu-err` 2).

**★ The info tier is recorded; the 2026-09-11 zero was the ledger's eviction order (resolved v1.187.10).** The 2026-09-11 reading found the info tier empty for a second consecutive reading and declined to decide whether the base was quiet or had stopped being recorded. It was recorded and then evicted on arrival: at the cap, eviction took the oldest info row first, and once none was left the oldest was the one just added (at the 2026-10-03 log review the capped ledger held 0 info rows over 85 days). v1.187.10 reserves the newest info rows, up to one in 15 (100 of 1,500). Over the reserve window the largest info families are the MPPT-temperature baselines (`baseline-mppt_hv_temp` 28, `baseline-mppt_lv_temp` 18), `peer-voldiff` 12 (auto-tuned to info on 10-14), `baseline-pair6_w` 11 and `peer-soc` 10.

**Criticals cleared in the trailing 7 days: 10.**

| Cleared (MST) | Subject | Duration |
|---|---|---|
| 10-09 22:28 → 10-14 00:05, six rows | `telemetry-blind` — "Panel data is stale — grid presence unknown" | 1.7–2.4 min each |
| 2026-10-10 04:02–04:10, three rows | `vdiff-crit` on Core 3 packs 1, 2 and 4 (bench, roster-muted) | 9.0–15.0 min |
| 2026-10-15 04:16 | `telemetry-blind` — "Alarm system is blind — no telemetry", raised 10-14 23:57 | 259.7 min |

In the complete window 14 of the 15 `telemetry-blind` criticals are the stale-panel kind (median 2.0 min), and 13 of the 15 were raised between 18:00 and 00:59. Every critical cleared since 10-01 (13 of 13) is recorded as not pushed; the field records only the fire push of a cleared episode, so an overnight critical held for the morning digest that clears before 06:00 — as the 10-14/15 blind episode did — reads not pushed. Why the two-minute stale-panel criticals were not pushed is not established here.

**Top subjects in the window** — 83 held rises on 42 subjects (the evicted peer warnings are not in it):

| Count | Subject |
|---|---|
| 10 | `dpu-imbalance` on Core 3 (bench, roster-muted) |
| 7 | `telemetry-blind` |
| 7 | `msg-rate-floor` on the SHP2 |
| 4 | `vdiff-warn` on Core 1 pack 1 |
| 3 | `vdiff-warn` on Core 1 pack 3 |
| 3 | `vdiff-warn` on Core 4 pack 1 |
| 3 | `vdiff-warn` on Core 4 pack 2 |

Of the 2026-09-11 head, `msg-rate-floor` now leads only on the SHP2, and the MPPT-temperature baselines have left the warning tier: they emit info.

**Pushes.** The ledger's `pushed` field exists from v1.187.1. From 10-01 19:20 to the fetch (13.94 days) it records **36 fire pushes, 2.58 a day, all warnings**: `vdiff-warn` 19, `peer-voldiff` 8, `offline` 3, `system-audible-unreachable` 2, `msg-rate-floor` 2, `storm` 1, `system-outage` 1. By release: v1.187.1–.11 2.23/day; v1.187.12–.13 13 in 1.12 days, 12 of them cell-spread pushes on 10-10 16:20–16:50; v1.187.14–.20 1.60/day; v1.187.21 one (`system-audible-unreachable` at the 10-12 22:04 host reboot); v1.187.22 onward one. The field undercounts what reaches a phone: it leaves out resolve pushes, the morning digest and the night-charge notices. The add-on log covers those for 10-13 18:06 → the fetch (1.99 days): **five pushes delivered**, about 2.5 a day — one alert push and its resolve (a peer cell-spread outlier, 10-14 15:24 and 16:06), one morning digest (10-15 06:00, 7 alerts and 9 resolved) and two night-charge evening advisories — and one failed: the 10-15 05:00 night-charge morning summary (a Home Assistant push timeout).

**Spoken events.** The add-on keeps no audible history, so this comes from two sources that agree where they overlap.

- **Exact, from the add-on log (10-13 18:06 → the fetch, 1.99 days): 4 broadcasts delivered, 2.0 a day** — the SoC ladder twice (30% at 10-13 19:37, 20% at 22:27) and the night-charge notice twice. The alert-condition path delivered none; broadcast quiet hours (23:00–05:00, critical break-through off) held three: a yellow, a red (the telemetry-blind critical, 00:02:39) and another yellow. Storm suppressions: 0.
- **Speaker proxy, from Home Assistant's recorder history of the Music Assistant target** — playing episodes of 120 s or less outside music sessions; it reproduces the log exactly in the overlap (4 of 4). Over the complete window: **76 plays, 3.82 a day** — the night-charge notice 18 (0.90/day), the SoC ladder 17 (0.85/day), other 41 (2.06/day, 19 of which match no ledger event). Over the full span since 09-11: 212 plays, 6.17 a day, 52 of them on 09-21 alone. By release: up to v1.187.12 6.77/day; v1.187.12–.20 3.02/day; v1.187.21 6.53/day (six SoC-ladder plays as the pool fell 50 → 20%); v1.187.22 onward 0.66/day (one play, the night-charge notice). The proxy cannot see the SIP (cordless) leg, counts speaker tests, previews and any other caller of the same speaker, separates music by a heuristic, and reads both speakers the target has used (it moved around 09-22/24).

**Behaviour after the named releases.** The post-fix samples are small — v1.187.22 has 1.52 days and two boots, and neither of its failure conditions has recurred — so "0 events" below is not yet evidence that a fix works.

- **Cell spread push-only (v1.187.12, .14).** On 10-10, 12 cell-spread episodes were pushed in 30 minutes while the speaker was silent from 14:02 to 22:33. `vdiff-warn` pushed twice after v1.187.14 and not at all after v1.187.21.
- **Peer outlier push-only (v1.187.21).** Before it, the speaker played about 10 minutes after a `peer-voldiff` rise (the cell-spread speak hold) on 10-04, 10-08 and 10-12. After it: 13 `peer-voldiff` episodes (11 now info, after the 10-14 auto-tune demotion), 1 push and no speaker play.
- **Boot SoC false alarm (v1.187.22).** The two boots since (10-14 05:22 and 20:32) withheld the ladders for 12 and 11 ticks until the first poll settled (523 and 546 ms after start); neither was followed by an SoC line or a play. The pre-fix reference is a 33-s play at 10-12 22:05:59 with no pool crossing behind it. Neither boot had a slow-hydrating SHP2, so the fixed path has not been exercised.
- **Audible-unreachable debounce (v1.187.22).** Two episodes in the complete window (10-04, 1.7 min; 10-12 at the host reboot, 1.6 min), both pushed; Home Assistant's audible-channel sensor read UNREACHABLE exactly those two times since 09-01. None since v1.187.22, and no broadcast failed at either boot.

**Broadcast path** at the fetch: `enabled`, 1 Music Assistant target and 1 SIP target (`targetCount` 2; 3 on 2026-09-11), `audibleReachable: true`, usable 1 of 1, not degraded.

**Outcome telemetry exists; a false-positive rate does not.** `/api/alerts/outcomes/stats` holds 52 labelled outcomes across 11 families, every one an acknowledgement and none a dismissal, and publishes precision `null` for every family; the last label is from 2026-09-15. Its precision is `(ack+failed)/(ack+failed+dismiss)`, which is **response telemetry, not a measured false-positive rate** — unacknowledged alerts are unlabelled, `resolved` is excluded as ambiguous, and coverage is operator-effort-bound. No precision figure is published until the labelled fraction is large enough to mean something.

---

## 2. Forecast accuracy

The day-ahead PV forecast wraps its deterministic P50 in a self-calibrating P10/P90 band (formulas in reference chapter 3, [6. Probabilistic P10/P90 SoC band](reference/03-solar-forecast.md#6-probabilistic-p10p90-soc-band-computeprobabilisticforecast)).

**★ Every model-based figure in this section carries the held hours of 10-15 and is in-sample.** The forecast model's solar-response fit runs over the 30 days to each read (`TYPICAL_HISTORY_MS`, `computeDayForecastUncached`), and on 10-15 it took the Cores' held 0-W daylight hours (§6) as observations: in the forecast generated at 17:33 (read at 18:11), each hour slot from 08:00 to 16:00 has 30 pairs in its through-origin fit, one of them 10-15's at 0 W, which lowers that slot's coefficient by that hour's share of the slot's Σ GHI² — by how much is not measured here. The `pvBiasFactor` that rescales the fit (1.1658) is Σmeasured ÷ Σpredicted against that same fit over the seven days before 10-15, so over those days it largely absorbs the pull. The probabilistic diagnostics below (and the 10-15 plan's basis reading, which uses them), the forecast-skill route, and the hourly backtest with its offline re-score are all computed from this fit, and each scores days the fit was built on — every one but 09-15, whose daylight precedes the fit's window. The night-charge ledger's day-ahead figures, graded from forecasts issued before 10-15, carry neither.

Values as of **2026-10-15 17:53** (`/api/forecast/probabilistic`), on that fit:

| Diagnostic | 2026-10-15 | 2026-09-11 | What it measures |
|---|---|---|---|
| `calScoredDays` | **30** | 29 | Scored calibration days inside the `PV_BAND_CAL_WINDOW_DAYS = 30` window. ≥ `PV_BAND_CAL_MIN_DAYS = 14`, so the calibration is **active**. |
| `realizedDailyErrHalfFrac` | **0.257** | 0.657 | Empirical daily half-width required for expected coverage ≥ 80%. |
| `bandSigmaCal` | **0.41** — basis `shrunk` | 1.00 — basis `saturated` | Shrink multiplier, `Math.min(1, Math.max(0.4, realizedHalfFrac / producedHalfFrac))`. |
| `bandRealizedCoveragePct` | **83** | 72 | Share of scored days whose realized daily error fell inside the band's daily half-width. The advisor's basis gate is 78%. |

**★ The calibration is back in its narrowing regime, and its 83% is arithmetic, not evidence.** Realized error — the fit's own hindcast error, so in-sample — is now well inside the band's produced half-width (implied `producedHalfFrac` ≈ 0.627, with the calibrator's `pvBiasFactor` 1.1658), so the calibrator is shrinking the band again, close to its 0.4 floor. Replicated offline from the scored errors: n = 30, rank k = ⌈0.8 · 31⌉ = 25, coverage 25/30 = 83.3% — exactly k/n, the value the saturation-detector derivation in §6 says the shrunk regime must produce. The 83 says the calibration is not saturated; it says nothing further about forecast quality. Per plan night in the ledger, `band_sigma_cal` read 1.0 on 09-10 → 09-13 (basis gate closed); since 09-14 (31 nights) it sat at the 0.40 floor on 22, shrunk above it on 8, and read 1.0 once — 09-27, the restart partial-map forecast that v1.186.5 fixed.

**PV hindcast skill** (`/api/forecast-skill`, on realized irradiance under the current model, so in-sample, and on the fit that takes in the held hours): over 30 days (09-15 → 10-14) MAE **6.18 kWh / 13.5%**, `biasFactor` 1.07, `forecastDayR2` 0.65; over 7 days MAE 6.39 kWh / 15.9%, `biasFactor` 1.17. Bias-adjusted calibration errors average |e| 0.151; the largest is 0.672 on 09-28 (predicted 26.76 kWh, actual 10.22). The out-of-sample, day-ahead figures are the ledger's, below.

### ★ 2026-09-11: the band calibration inverted, and it stopped the night-charge engine

This was the most consequential change in the 2026-09-11 refresh, and it was not visible in the `bandSigmaCal` number alone — which is the reason a new field exists to read it.

**The calibrator is shrink-only.** `bandCal = Math.min(1, Math.max(PV_BAND_CAL_FLOOR, realizedHalfFrac / producedHalfFrac))` (`computeProbabilisticForecast`, `analytics.ts`). It can narrow a band that proves too wide; it has **no authority to widen one that proves too narrow**. The raw band is the deliberately conservative default and 1.0 is the ceiling.

On 2026-09-06 the ratio sat at 0.50: realized error was half the produced half-width, the band was comfortably too wide, and the calibrator was actively narrowing it. On 2026-09-11 realized error was **0.657** and the ratio had gone to or past 1. The calibrator had found the band **too narrow** and was pinned at "do not shrink", which is the most it can do. Coverage was 72% against a nominal target of ≥ 80%.

**The consequence reached the operator the same day.** `basisComplete` requires `bandCoverageFrac ≥ BASIS_MIN_BAND_COVERAGE = 0.78`. At 72% it was false, and the live plan was null:

> No plan — forecast/telemetry basis incomplete (**PV band coverage 72% < 78%** (forecast present, tier=forecast, calDays 29/14)); nothing will be charged.

Three of the four basis gates passed. The miss was six points on one of them. That the rationale said so at all is v1.148.0's `basisBlockedBy`; before it, this read as a bare "basis incomplete" and reconstructing which gate had closed took an hour of live probing.

**★ A `bandSigmaCal` of 1 was ambiguous across five states, and this document walked into it.** The 2026-09-06 snapshot inspected this exact field, read 0.50, and asserted: *"Still **above its 0.4 floor** — data-driven, not floor-pinned."* That checked the **floor** ambiguity. It did not occur to the reading that the *ceiling* carried an ambiguity too — and the ceiling is where the field went. A published 1 is emitted when:

1. the calibration is active and **saturated** (the 2026-09-11 state — band too narrow, no authority to widen);
2. the calibration **never engaged** for want of scored days — the real v1.23.0 defect, which sat pinned at exactly 1 in production;
3. the ratio lands exactly on 1;
4. an operator override happens to be 1;
5. (until v1.149.0) there was **no probabilistic forecast at all**, and the ledger wrote `?? 1`.

States 1 and 2 are opposites — "the calibration is working and telling you something is wrong" versus "the calibration is not running" — and they published the identical number. **v1.149.0 adds `bandSigmaCalBasis`** (`operator-override` / `shrunk` / `floor-pinned` / `saturated` / `uncalibrated`) beside it, the same companion-field shape as `strikesMeasurable` and `underBuyMeasurable`, and changes the ledger's missing-forecast value from `1` to `null`. Seven mutants in `scripts/mutate-band-cal-basis.mjs` hold it, including one that collapses `saturated` back into `uncalibrated`.

*Recording the sequence, because it is the point of this document: the ambiguity was not found by reading code. It was found by refreshing a table, seeing a number move to a boundary, and asking what the boundary meant — five days after this same document had inspected the same field and pronounced it healthy.*

**What was not established on 2026-09-11.** Why realized error rose 2.6× in five days was not answered. Candidate causes — a weather regime change, monsoon-season variance, soiling, a model regression, or the `calScoredDays` window rolling from 19 to 29 and admitting a rougher stretch — were not separated, and the 29-day window made a single bad week arithmetically capable of this on its own. No attribution was asserted.

★ **Established the same day — see §6, "A third of the fleet went dark".** Core 2 recorded nothing from 2026-08-11 to 2026-08-19, fleet PV sums over that window read 32% of true production, and the forecast-skill scorer applied the current fleet membership to those days, so eight phantom forecast misses sat inside the 30-day calibration window. Nulling them was measured to narrow the published band 3.5× and to reopen the basis gate. The paragraph above is kept as written because, when it was written, the cause had not been separated.

★ **Reopened 2026-09-14 (measured 2026-10-15).** The basis gate refused 09-10, 09-11 (72%), 09-12 (72%) and 09-13 (76%), and the advisor sized its first plan since 09-09 on 09-14 (`band_sigma_cal` 0.85). The only refusal since was 09-27 (7%, the restart partial-map forecast). In October (10-01 → 10-14) there were 12 `cost_arbitrage` plans, one EV-contention hold (10-09), one night with no cheap window (10-10) and no basis refusal; the 10-15 plan (pre-issue, 17:32) reads `basisComplete` true, on the calibration of the fit that takes in the held hours (above). What reopened the gate on 09-14 is not established here.

**Component accuracy from the readiness gate** (`readiness.metrics`: 52 captured algo-v3 forecast-tier nights, plan dates 08-23 → 10-13; 49 PV-coverage nights, 1 PV verdict set aside) — these are the numbers the gate itself judges, and they separate PV from load. Recomputed offline from the ledger they reproduce the live values exactly, and restricted to plan dates ≤ 09-09 they reproduce the 2026-09-11 column exactly:

| Metric | 2026-10-15 | 2026-09-11 (18 nights) | Reading |
|---|---|---|---|
| `pvMae` / `pvBias` | **0.089** / **+0.005** | 0.064 / −0.021 | PV day-ahead stays accurate and unbiased. |
| `loadMae` / `loadBias` | **0.220** / **−0.173** | 0.149 / −0.062 | Load error is 2.5× PV error and **biased toward over-forecast** again (below). |
| `pvBandCoverage` | **0.939** (46/49) | 1.00 | **Above** the gate's 92% ceiling: the PV band is wider than its day-ahead error. |
| `loadBandCoverage` | **0.608** (31/51) | 0.833 | **Below** the 78% floor. |
| `bandCoveragePct` (joint; informational since v1.106.0) | **61.2** | 83.3 | |

Since 09-10: `pvMae` 0.103, PV coverage 28/31; `loadMae` 0.258, `loadBias` −0.233 (median −0.29), load coverage 16/33. October plan dates (10-01 → 10-13): `pvMae` 0.094, `pvBias` +0.015, PV coverage 11/11; `loadMae` 0.178, `loadBias` −0.158 (median −0.10), load coverage 7/12. Day-ahead PV error against the band: since 09-28 (14 nights) the |error| median is 0.06 and its 80th percentile 0.14, against a band half-width of 0.259 of P50, with 14 of 14 in band (October: 0.16 against 0.237, 11 of 11).

### ★ Two band-coverage numbers still disagree, and each is correct

`/api/forecast/probabilistic` reports **83%**. `readiness.metrics` reports PV **93.9%** and load **60.8%** (joint 61.2%). Both are live, from the same deployment, minutes apart, and they measure different populations:

| | Probabilistic route | Readiness gate |
|---|---|---|
| Population | scored **calibration days** in the rolling `PV_BAND_CAL_WINDOW_DAYS = 30` window (30) | captured **forecast nights**: 49 for PV, 51 for load |
| Quantity | daily PV hindcast error inside the band's daily half-width | per-marginal day-ahead PV *and* load coverage, graded separately since v1.106.0 |
| Consumed by | the advisor's `basisComplete` gate | the write-readiness gate's graduation criteria |

**The 2026-09-11 position has reversed.** Then the advisor's basis gate had closed at 72% while the readiness gate's band criterion sat inside its target at 83.3%, and with no plan no actuated night could accrue. Now the basis gate is open and actuated nights accrue again (35 scored, against 15), while the readiness gate's band criterion fails on both marginals in opposite directions: the PV band is too wide for the day-ahead error and the load band too narrow.

### ★ The load over-forecast signature returned

The 2026-09-06 reading recorded load over-forecast by 19–39 kWh on five consecutive nights (08-31 → 09-03) and declined to fit a correction to it; the 2026-09-11 reading saw the next four nights alternate sign at a fraction of the magnitude and called the signature resolved without intervention. That conclusion was drawn from four nights — the same kind of sample the earlier reading had declined to fit — and it no longer holds. Since 09-10 load was over-forecast on **29 of 33** nights, and all 17 load-band misses fell below P10 (none above P90):

| Week of (Monday) | Nights | Load P50 → actual (kWh/24 h) | Mean error |
|---|---|---|---|
| 09-07 | 7 | 119.0 → 111.5 | −0.04 |
| 09-14 | 7 | 107.1 → 69.5 | −0.35 |
| 09-21 | 7 | 90.4 → 63.5 | −0.30 |
| 09-28 | 7 | 73.5 → 55.7 | −0.23 |
| 10-05 | 6 | 69.5 → 64.1 | −0.08 |
| 10-12 | 2 | 65.2 → 41.3 | −0.37 |

**It is a step in the load, measured and not attributed.** Mean `panel_load` over the 24 h after each plan fell from 114.7 kWh (plans to 09-13) to 64.2 kWh (from 09-14); one paired circuit that peaks near 4.1 kW went from 36.3 to 0.6 kWh per 24 h at the same step. The trailing load forecast took about three weeks to follow. October's bias is smaller (−0.158, median −0.10), and the two nights of the week of 10-12 are large misses again. Load actuals agree with Home Assistant's `panel_load` history to within 0.4 kWh on the three nights checked.

**The load band is narrower than its own label.** Its factor is **1.35** = 1 + the 80th-percentile |error| over 80 ledger rows, applied as P10 = P50/1.35 and P90 = P50 × 1.35, so the band admits errors from −0.259 to +0.350 — and only 45 of its own 80 errors (56%) fall inside it. The add-on log line reads "±35%". Over-forecast misses land on the narrow side.

**Sensitivity.** Five Friday rows (08-28, 09-04, 09-11, 09-18, 09-25) have actuals covering only 18.7–18.9 of the 24 h; `score_notes` tags them and the gate still counts them. Excluding them, all algo-v3 nights give `loadBias` −0.146 and load coverage 0.674; re-integrated over the full 24 h, −0.139 and 0.686. They inflate the bias by about three points; the signature persists either way.

No load-forecast correction was applied between the readings, and none is proposed here. A step followed by a lagging trailing forecast is a different shape from the five-night transient of 2026-09-06; which correction suits it is a design question, not a measurement.

**Hourly backtest** (`/api/backtest/forecast`, 168 h; not tracked here before). Both of its predictors come from the live forecast — the alarm-facing model, and a typical-day curve built over the same 30 days, held hours included — so it is an in-sample hindcast on the fit above, like the skill route. The route also scores each hour against the home Cores' recorder `pv_total` without checking that they are reporting, so its live window (10-08 17:56 → 10-15 16:56) takes in 17 hours of 10-15 whose actuals are the held 0 W (§6), against 52.3 kWh predicted; its published r² 0.206, MAE 1,022 Wh/h and bias +314 Wh/h for the alarm-facing predictor carry held data in the fit and in the actuals, and are mostly the held actuals' artifact. Re-scored offline from the recorder on the 151 hours ending by 10-15 01:55, with the live fit and factor (the 168-h reproduction matches the route to within 0.5 Wh/h), the alarm-facing predictor reads r² 0.567 and MAE 791 Wh/h, and the typical-day baseline r² 0.709, MAE 737 Wh/h and bias +232 Wh/h: the held actuals are out, but the figures are still in-sample on the fit that takes in the held hours, so they are not clean skill. The alarm-facing predictor's aggregate bias on those hours, +2.3 Wh/h (228.9 kWh predicted against 228.5 kWh measured), is not a skill figure at all: its `pvBiasFactor` is Σmeasured ÷ Σpredicted over 10-08 → 10-14, and six of those seven days are the re-scored window's daylight, so the near-zero bias is mostly the factor's own fit. Without the factor the same predictor under-forecasts by 213 Wh/h on those hours (measured ÷ predicted 1.164, within 0.002 of the factor itself), partly through the held day's pull on the coefficients, by an amount not measured here. That is the direction of the skill route's `biasFactor` above 1, on the same fit, so the route's +314 over-forecast is the held actuals' sign, not a disagreement between the two routes.

---

## 3. Night-charge advisor

**Scored actuated nights: 35** (2026-09-11: 15) — by plan month August 8, September 19, October 8; `effectiveN` 37.36. The 10-14 night is actuated and not yet captured (capture is due about 10-15 21:31). Supply resumed after the 2026-09-11 reading: 09-10 → 09-13 were `none` rows on an incomplete basis (§2), planning resumed on 09-14, and the posture has been `auto` since — which the gate runs as supervised while it is not ready (below).

**Ledger rows 2026-09-10 → 10-14** (35 rows, all `algo_version=3`): 26 `cost_arbitrage`, 9 `none`. 21 are actuated; their binding cap is `requirement` on 12 and `evContention` on 9, and their ceiling basis `pv-headroom` on 19 and `max-soc` on 2 (09-17, and 09-24 at 90%). The scored actuated rows (`buy` is the islanded worst-case sizing figure; "opens at" is the measured window-open SoC against the plan's islanded start):

| Plan night | Cap | Target % | Opens at: measured / sized (%) | Buy → delivered (kWh) | Ratio | Delivered basis |
|---|---|---|---|---|---|---|
| 09-14 | `evContention` | 32.8 | 16 / 0 | 32.55 → 34.90 | 1.07 | legacy |
| 09-15 | `evContention` | 36.2 | 38 / 23.3 | 34.26 → 11.34 | 0.33 | legacy |
| 09-16 | `evContention` | 34.2 | 16 / 0 | 33.96 → 31.98 | 0.94 | legacy |
| 09-17 | `evContention` | 41.2 | 44 / 26.9 | 35.11 → 43.38 | 1.24 | legacy (`max-soc`) |
| 09-20 | `evContention` | 33.3 | 16.5 / 0 | 33.12 → 67.04 | 2.02 | legacy |
| 09-21 | `requirement` | 75.8 | 62 / 57.9 | 32.37 → 16.03 | 0.50 | legacy |
| 09-22 | `evContention` | 71.9 | 49 / 36.6 | 55.40 → 23.37 | 0.42 | legacy |
| 09-23 | `requirement` | 81.6 | 63 / 51.5 | 37.38 → 18.17 | 0.49 | legacy |
| 09-24 | `evContention` | 88.5 | 66 / 52.2 | 56.82 → 23.64 | 0.42 | legacy (`max-soc` 90%) |
| 09-28 | `evContention` | 70.7 | 26 / 6.5 | 63.82 → 46.26 | 0.72 | legacy |
| 09-29 | `requirement` | 77.7 | 71 / 66.5 | 27.56 → 7.23 | 0.26 | legacy |
| 09-30 | `requirement` | 76.0 | 75 / 77.4 | 18.32 → 4.71 | 0.26 | legacy |
| 10-01 | `requirement` | 86.6 | 78.5 / 65.9 | 32.01 → 22.82 | 0.71 | source-charge |
| 10-02 | `requirement` | 73.1 | 65 / 65.1 | 9.13 → 10.08 | 1.10 | source-charge |
| 10-04 | `requirement` | 69.7 | 38.5 / 14.9 | 57.00 → 23.49 | 0.41 | source-charge |
| 10-05 | `requirement` | 68.5 | 52 / 37.9 | 39.12 → 19.20 | 0.49 | source-charge |
| 10-06 | `requirement` | 65.7 | 65 / 65 | 19.45 → 2.68 | 0.14 | source-charge |
| 10-07 | `requirement` | 66.2 | 58 / 56.9 | 25.06 → 11.99 | 0.48 | source-charge |
| 10-08 | `evContention` | 77.5 | 40.5 / 39.5 | 59.37 → 40.95 | 0.69 | source-charge |
| 10-13 | `requirement` | 61.8 | 19 / 4 | 60.33 → 41.54 | 0.69 | source-charge |

Rows without a delivery: superseded 09-19, 10-03 and 10-11; cancelled by the next plan 09-26; no cheap window 10-10 (Saturday — Monday 10-12 was an APS off-peak holiday, so the 30-hour scan found no overnight hour); cancelled by hand 10-12 (below). "Legacy" rows, through 09-30, hold the delivered estimate captured before v1.187.3 (window import minus house load); the source-charge basis starts 10-01.

What this establishes, updating the 2026-09-11 reading point by point:

- **Cost mode is the standing objective** — 26 of 35 rows. Every `none` row since 09-14 is a Friday hold (09-18, 09-25, 10-09), the night with no cheap window (10-10), or the 09-27 restart forecast (§2).
- **★ Delivery runs below the worst-case buy, not above it.** The 2026-09-11 reading recorded 48–55% over-delivery on four nights (09-06 → 09-09), all on the legacy estimate. On the source-charge basis the 8 nights the learner counts give delivered/buy median **0.590** (mean 0.589, IQR 0.41–0.69, range 0.14–1.10); re-measured on the source-channel method, all 20 scored actuated nights since 09-14 give median 0.656 (mean 0.736). The largest measured reason the worst case overstates the charge is the start: the window opened a median **14.0 points** above the plan's islanded start (n = 22, IQR 4.1–16.0; about 12.9 kWh of the pool). That this gap explains most of the ratio is an inference from those figures, not a fitted model. The learner's own statistic is 0.689 over 8 nights, floored to 1.0 (`buyDebiasFactor` 1, basis `measured`). ★ *Corrected (v1.187.10): the [0, 5] kWh readiness criterion does not judge delivery. Since algo v3 `buy_err_kwh` = −netMiss/legEff, the P50 PV/load forecast miss; its label read "delivery bias" until then and now reads "sizing bias".*
- **`binding_cap` is no longer EV contention by default:** `requirement` binds on 12 of the 21 actuated nights and `evContention` on 9. Targets since 09-21 run 59.8–88.5%, above the panel's 50% reserve ceiling, which the force-charge path reaches. ★ *Since v1.173.0 `ARB_CHARGE_CAP_KW` defaults to 0 = AUTO: connected Cores × the proven per-slot force-charge rate ÷ √RTE, about 5.9 kW per Core.*
- **★ `cushion_shortfall` is 0 on every buy row from 09-21.** The 2026-09-11 reading recorded 1 on every sized row and called the cushion unsatisfiable; among actuated rows it read 1 only on 09-14, 09-15, 09-16 and 09-20. The cushion was not removed: every row since 09-12 reads a 16% reserve floor and a cushion of 12.19–25.94 kWh. It shrank from 25.94 kWh (09-14) to 16.06 kWh (09-21) and 12–17 kWh since, in step with the load fall in §2. That the shortfall cleared because the cushion shrank is an inference from the two series, not a tested cause.
- **On-peak import is 0 kWh on all 10 governed rows** (`onpeak_basis = 'governed'`, 09-29 → 10-13). The 2026-09-11 reading's zero `actual_onpeak_import_kwh` was measured on the pre-v1.187.0 plan-day anchor, which never measured the on-peak each plan governed (reference chapter 15, [6. The learning ledger](reference/15-1-night-charge-planning.md#6-the-learning-ledger-night_charge_ledger-recorderts-v1380)); the governed rows are the corrected measure.
- **Cost.** `realized_cost_cents` is on 12 rows (09-29 → 10-13). It is energy only, from window open to close + 16 h, and not a bill. The 10 actuated rows run 168.11–633.55¢ (median 332.7¢); on each, cost minus window import × 12.59¢ (the overnight rate in the ledger's `tariff_snapshot` from the 09-07 plan on, and on `/api/tariff` now; §6) is 0.43¢ or less, except 09-29 (+4.24¢), 10-04 (+16.61¢) and 10-05 (+15.40¢), so the metered cost of each scored span was essentially the overnight buy itself. The counterfactual and savings columns are NULL on all 86 rows, by design.
- **Whole-home grid coverage** (`grid_home_coverage_frac`) reads 0.98–1.0 on every captured row with a charge window from 09-10 to 10-13 (33 of 34). The 10-10 row, which had no cheap window to pair actuals to, reads null for that reason, not the low-coverage fallback.

**★ 2026-10-12: a cancelled arm is filed as superseded.** Worst-case buy 64.19 kWh toward 80.4%, sized from an islanded start of 16.9%; armed, then cancelled by hand at 21:54:38 (recorded by the 2026-10-13 log review; that log line has since rotated out). What is still measurable agrees: the backup reserve held 16% through the Tue 00:00–05:00 window and the window imported 0 kWh; the pool opened it at a measured 47% and ran down to 34% on the pack; over the scored span `realized_cost_cents` is 0, governed on-peak import 0 kWh and the minimum SoC 25%. The row's `arm_disposition` nevertheless reads "superseded by the 2026-10-13 plan — Sat/Sun share one Monday window". The supersede stamp at plan issue (`index.ts`) checks neither the cancel flag nor whether the two windows match, and the cancel route writes no disposition, so a cancelled arm that a later plan follows is filed as superseded.

**2026-10-14, the first live expected-buy night (v1.187.22/.23).** Expected buy **3.32 kWh**, beside an islanded worst case of 12.99 kWh; required extra 0, so the buy was economic only; target 59.8%. The window was expected to open at 71.9% and measured 77% (islanded sizing start 61.5%). The reserve went 16 → 50% at 23:00:59 (verified 23:01:59) and reverted at 05:00:00 (verified 05:01:00); force-charge never started ("already at tonight's 59.8% target"); SoC was 64% at 05:00. Delivered and grid import were both 0.00 kWh where the SHP2's telemetry was live: 23:00 → 23:52 and 04:17 → 05:00, 95 minutes or 26% of the window (25–29% of its 5-minute buckets, by metric); the source channels read negative and `grid_home_w` 0 W throughout both. Between them lie a 122-minute telemetry gap (23:52:57 → 01:54:59) and the SHP2's held rows of 01:55 → 04:16 (§6), which repeat 75% SoC and fixed source values while the live SoC went from 75% before the gap to 65–66% at 04:17. For that stretch no charge is an inference from the fall, not a measurement. The scorer's sample-timestamp coverage counts the held rows and reads 64–66% (source channels 0.658, `grid_home_w` 0.639). The 05:00 morning-summary push failed (a Home Assistant push timeout). By the scorer's rules the row should capture unscored, with delivered NULL (coverage under 90%) — a projection, to be read back after capture.

**Write-readiness (gate v2, as of 2026-10-15 17:56): `BLOCKED` (HARD), `writeReady = false`**, so `auto` runs as supervised.

| Criterion | 2026-10-15 | 2026-09-11 | Required |
|---|---|---|---|
| Scored actuated nights | **35** (`effectiveN` 37.36) | 15 (18) | ≥ 21 |
| Under-buy rate | **12.5%** — 2 of 16 measurable nights (19 excluded); `underBuyMeasurable` 1 | `null` — 15 of 15 excluded | ≤ 0.10 |
| Sizing bias (`buyBiasKwh`) | **+16.17 kWh** | `null` | [0, 5] kWh |
| Band coverage | PV **93.9%** over 49 nights, load **60.8%** over 51 (joint 61.2%) | 83.3% over 18 | each marginal in [78%, 92%] over ≥ 14 |
| Engine-fault strikes | `activeStrikes` 0, `strikesMeasurable` 1 (5 trajectory strikes set aside) | 0, `strikesMeasurable` 1 | 0 |

- **The block is the under-buy rate.** The two under-buys are 10-01 (`buy_err` −2.26 kWh) and 10-08 (−7.14; load 71.98 → 79.64 kWh). The minimum SoC on those nights was 72% and 65%, with no cushion breach. The rate falls to the cap at 2 of 20, four more measurable nights without an under-buy.
- **Behind it, three criteria would still hold the gate at `LEARNING`:** sizing bias outside [0, 5], PV coverage above 92% and load coverage below 78%. `BLOCKED` returns before the graduation criteria run, so the blocking text names only the under-buy.
- **History** (Home Assistant's readiness sensor): `BLOCKED` until 09-25 20:04 (the phantom strikes v1.186.0 removed), `LEARNING` from then, `BLOCKED` 10-02 21:24 (the 10-01 capture), `LEARNING` 10-03 16:08 (the 10-02 capture), `BLOCKED` 10-09 21:31 (the 10-08 capture), and still `BLOCKED` at the fetch.

★ **The `UNREACHABLE` wording no longer fires.** On 2026-09-11 the gate's own blocking text called the under-buy criterion *"UNREACHABLE, not merely thin"*: all 15 actuated nights disclosed a cushion shortfall and were exempt from the sizing judgement, more nights could not change that, and with the basis gate closed none were arriving. Both conditions have gone — plans resumed on 09-14 and no buy row since 09-21 discloses a shortfall — and the criterion now has a value. It fails: the planner under-bought on 2 of 16 measurable nights, above the 10% cap, while the sizing bias (+16.17 kWh) says it over-buys on average. Neither under-buy night came near the cushion. The 2026-09-06 policy settings (a 10% floor with the cushion disabled, §6) are still not applied: every row since 09-12 reads a 16% floor and a cushion.

★ **v1.186.0 (2026-09-24 log review): a third blocker, introduced by the gate itself.** The gate judged every cost-mode night against a whole-house projection kept only for disclosure (always 0% in cost mode), so each such night counted as an engine fault, the gate read BLOCKED, and `auto` ran as `supervised` every night. Plans now record the trough and line they were sized against and the gate scores those; nights that never recorded them no longer count as faults, and the readiness sensor read `LEARNING` from 09-25 20:04.

**Actuation integrity.** The supervised write path applies, verifies against device readback, retries, and escalates. v1.131.0 extended readback verification to the **revert** side, which had been closing on a cloud ACK — the exact evidence v1.79.0 ruled insufficient on the apply side. It was exercised on live state within minutes of deploying: the 2026-09-03 night was found reverted-but-unverified, the panel was read at 16%, and `revertVerifiedAtMs` was stamped. On 2026-10-14 both the apply and the revert verified against readback within a minute (above).

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

Measured 2026-10-15 17:57–18:02 MST. All five Cores had been offline per the EcoFlow cloud since 01:55 that morning (§6), so the pack routes report each Core's last live reading, from about 10-14 23:50; state of health, full-charge capacity and cycle counts move slowly enough for that reading to stand. 24 packs are tracked: 15 home (Cores 1, 2 and 5, five each) and 9 bench (Core 3 ×5, Core 4 ×4).

**The confirmed defective pack has left the fleet, and the registry is empty.** On 2026-09-11 `/api/defective-packs` held one confirmed pack. The 2026-08-20 physical swap had moved it from Core 3 to Core 4 and the fault followed it — SoC pinned at 1% against a sibling median of 86%, 1 W against 350 W, cell 31 at −115 mV — which was the discriminating evidence that the chassis was clean and the pack defective. The vendor's diagnosis named two pack-side causes, a short circuit or a voltage-sampling module fault (error 533, which titles as "Inverter error" although the 5xx family is battery/BMS). The pack was pulled for warranty on 2026-09-20 and Core 4 renumbered its remaining four packs as slots 1–4 (CHANGELOG 1.172.0). A confirmation retires after 48 h of absence (`DEFECTIVE_PACK_ABSENT_RETIRE_MS`), and the registry was empty on 2026-10-11 and again on 2026-10-15. Core 4 is an off-panel bench unit, so the home pool is unchanged: 15 packs on Cores 1, 2 and 5, 92.16 kWh nameplate.

**Full-charge capacity against nameplate.** Two capacity figures exist and they measure different things. The pool capacity the panel reports (`backupFullCapWh`, 92,160 Wh) is the sum of its three sources' `fullCap`, 30,720 Wh each = five packs × 6,144 Wh: the nameplate sum, which does not move with pack health. Each pack's battery-management system reports a measured full-charge capacity (`fullCapMah` against `designCapMah` 60,000 mAh), and the home packs' figure is what `/api/runway` now uses (§4a):

| Home pool, 15 packs | 2026-09-11 12:00 (recorder) | 2026-10-15 |
|---|---|---|
| Full-charge / design | 0.9809 = 882,791 mAh ≈ 90.40 kWh | **0.9440** = 849,556 mAh ≈ **86.99 kWh** |
| Per pack | 95.45–99.80%, median 98.27% | 90.78–98.60%, median 94.19%, mean 94.40% |

kWh at the 102.4 V nominal. By Core on 2026-10-15: Core 1 92.87–94.94% (138–182 cycles), Core 2 90.78–92.64% (143–179 cycles), Core 5 96.27–98.60% (47–59 cycles); pack temperatures 28.4–33.1 °C. Bench: Core 3 91.53–100% (29–33 cycles), Core 4 98.43–98.62%.

**★ The −3.7 points came in three synchronized BMS recalibrations, not a slope.** On 2026-09-18 11:38–12:23, 12 packs on all three home Cores stepped down at once; on 09-29 15:32–15:43, the packs of Cores 1 and 5; on 09-30 13:55–13:58, the packs of Core 2, by 3.4 to 6.0 points each. Nothing has moved since 09-30. These steps are the 0.981 / 0.970 / 0.959 / 0.944 capacity regimes of the §4a table. A BMS full-charge figure re-calibrates in steps like these, so each reading is a dated level, not a point on a trend.

**Degradation engine.** 1 of 24 packs is `projecting`: Core 1 pack 4, fading 9.97 ± 0.23 %/yr (r² 0.82 over 105 days), which reaches the 80% end of life in about 1.4 years (2028-03). The other 23 are `learning`; Core 2 pack 1 has a 13.32 %/yr fit at r² 0.27 and is not projected. Both fits run across the recalibration steps above. Peer outliers: 0.

**Pack risk** (`heuristic-v1`): all 24 packs are tier `low`. Home scores run 2–10 (median 2); the highest are Core 2 pack 1 (10) and Core 1 pack 4 (8), both driven by the fade fit. Three factors — peer fade, internal resistance and coulombic efficiency — have no data on any of the 24 packs and together carry 0.55 of the weight; internal resistance is `learning` on every Core. A pack's score does not equal the sum of its weighted factors (Core 1 pack 4's add to 21 and it scores 8); that is not investigated here.

**Cell-spread norms across the wired fleet are not re-measured.** The July figure (3–6 mV at-rest spread on healthy packs) is **not carried forward** — it is stated here only as the prior reading, and this document's rule is that unrefreshed numbers do not become current by repetition.

---

## 4a. Runway replay backtest (measured 2026-10-11, v1.187.19; live check 2026-10-15)

**What was measured.** The runway's hours against the pool's actual discharge, on 30 clean
pack-only spans from the recorder (2026-09-02 → 10-11): every minute with the house drawing
power, `|grid_home_w|` < 50 W, each home Core's PV and AC input < 30 W and the packs' summed
input < 60 W, in runs of at least 3.5 h. Each connected source's first and last 1 % step
inside the span pins that source's SoC exactly; the pool's drop rate is the mean of the three
per-source rates and the load is `panel_load` averaged over the same windows. The aggregated
spans are `server/test/fixtures/runwayReplaySpans.json` (no device identifiers);
`runwayReplayBacktest.test.ts` replays each one through the real `computeRunway` — a pool at
the span's start, its measured end as the floor, its mean load, no PV — so the projected reserve
crossing is the prediction of how long the measured drop took.

| Span (MST) | Pool % | Load kW | FCC ratio | Actual h | Old runway h | Measured basis h |
|---|---|---|---|---|---|---|
| 09-02 18:41 → 22:52 | 54.0 → 26.0 | 5.38 | 0.981 | 4.19 | 4.51 (+7.8 %) | 4.23 (+0.9 %) |
| 09-04 18:37 → 22:06 | 36.3 → 16.7 | 4.48 | 0.981 | 3.50 | 3.80 (+8.5 %) | 3.52 (+0.7 %) |
| 09-08 18:20 → 22:28 | 39.0 → 15.7 | 4.51 | 0.981 | 4.13 | 4.48 (+8.6 %) | 4.16 (+0.8 %) |
| 09-15 18:20 → 22:48 | 64.7 → 37.9 | 4.86 | 0.981 | 4.46 | 4.78 (+7.0 %) | 4.45 (-0.2 %) |
| 09-17 18:18 → 22:42 | 62.3 → 43.6 | 3.34 | 0.981 | 4.39 | 4.85 (+10.4 %) | 4.42 (+0.7 %) |
| 09-18 18:01 → 06:18 | 90.3 → 42.5 | 3.02 | 0.970 | 12.29 | 13.71 (+11.5 %) | 12.27 (-0.2 %) |
| 09-19 18:04 → 06:27 | 71.0 → 27.4 | 2.68 | 0.970 | 12.38 | 14.12 (+14.0 %) | 12.51 (+1.0 %) |
| 09-20 18:13 → 22:01 | 46.7 → 16.0 | 6.44 | 0.970 | 3.79 | 4.12 (+8.8 %) | 3.85 (+1.5 %) |
| 09-21 18:17 → 22:49 | 92.0 → 62.0 | 5.31 | 0.970 | 4.53 | 4.90 (+8.2 %) | 4.53 (+0.2 %) |
| 09-22 18:16 → 22:52 | 74.0 → 48.1 | 4.52 | 0.970 | 4.61 | 4.97 (+7.8 %) | 4.56 (-1.0 %) |
| 09-23 01:35 → 06:23 | 81.7 → 63.0 | 3.03 | 0.970 | 4.80 | 5.33 (+11.1 %) | 4.77 (-0.6 %) |
| 09-23 18:14 → 22:50 | 80.7 → 62.5 | 3.10 | 0.970 | 4.60 | 5.07 (+10.3 %) | 4.55 (-1.1 %) |
| 09-24 17:52 → 22:48 | 84.0 → 65.7 | 2.90 | 0.970 | 4.93 | 5.47 (+10.8 %) | 4.88 (-1.1 %) |
| 09-25 18:02 → 06:24 | 93.0 → 49.9 | 2.68 | 0.970 | 12.36 | 13.93 (+12.7 %) | 12.34 (-0.1 %) |
| 09-26 18:00 → 01:28 | 53.7 → 16.4 | 3.93 | 0.970 | 7.47 | 8.22 (+10.1 %) | 7.49 (+0.3 %) |
| 09-27 18:02 → 22:06 | 41.7 → 21.1 | 3.96 | 0.970 | 4.07 | 4.50 (+10.7 %) | 4.10 (+0.9 %) |
| 09-29 18:20 → 22:49 | 83.0 → 69.9 | 2.18 | 0.959 | 4.48 | 5.20 (+16.0 %) | 4.47 (-0.4 %) |
| 09-30 18:10 → 03:09 | 93.3 → 54.8 | 3.28 | 0.944 | 8.98 | 10.17 (+13.2 %) | 8.91 (-0.8 %) |
| 10-01 17:57 → 02:54 | 92.7 → 63.1 | 2.45 | 0.944 | 8.94 | 10.47 (+17.1 %) | 8.95 (+0.1 %) |
| 10-02 18:20 → 22:55 | 81.7 → 64.1 | 2.88 | 0.944 | 4.60 | 5.27 (+14.7 %) | 4.57 (-0.5 %) |
| 10-02 23:58 → 06:46 | 72.3 → 51.7 | 2.22 | 0.944 | 6.80 | 8.07 (+18.6 %) | 6.83 (+0.5 %) |
| 10-03 17:56 → 01:47 | 84.7 → 55.5 | 2.79 | 0.944 | 7.85 | 9.06 (+15.3 %) | 7.84 (-0.2 %) |
| 10-04 17:33 → 23:55 | 64.3 → 37.4 | 3.19 | 0.944 | 6.37 | 7.32 (+14.9 %) | 6.40 (+0.5 %) |
| 10-05 17:41 → 22:59 | 74.0 → 50.9 | 3.33 | 0.944 | 5.30 | 5.99 (+13.1 %) | 5.26 (-0.8 %) |
| 10-06 18:06 → 22:58 | 89.3 → 63.4 | 4.15 | 0.944 | 4.87 | 5.40 (+10.9 %) | 4.81 (-1.3 %) |
| 10-07 17:43 → 23:00 | 82.0 → 56.3 | 3.82 | 0.944 | 5.28 | 5.82 (+10.1 %) | 5.15 (-2.6 %) |
| 10-08 17:45 → 22:58 | 87.7 → 37.3 | 7.68 | 0.944 | 5.22 | 5.68 (+9.0 %) | 5.19 (-0.4 %) |
| 10-09 01:58 → 06:28 | 79.3 → 65.7 | 2.22 | 0.944 | 4.50 | 5.32 (+18.2 %) | 4.51 (+0.1 %) |
| 10-09 17:44 → 06:37 | 83.0 → 23.5 | 3.52 | 0.944 | 12.89 | 14.63 (+13.5 %) | 12.88 (-0.0 %) |
| 10-10 23:14 → 06:40 | 98.0 → 76.9 | 2.06 | 0.944 | 7.44 | 8.84 (+18.7 %) | 7.43 (-0.2 %) |

**Result.** The old runway (nameplate kWh, drain `load/0.94`) overstated the hours in **all 30
spans, +7.0 % to +18.7 %** (mean +12 %), worst at low load and in the lowest capacity regime. The
measured basis (`poolEnergyBasis.ts` capacity scale × the panel's nameplate, drain `max(load/0.94,
270 W + load/0.94)`) predicts **all 30 within −2.6 % to +1.5 %** (mean −0.1 %).
The 270 W overhead was fitted on these spans (267 W; residual sd 40 W); a leave-one-out fit
stays within −2.6 % to +1.6 %, and an overhead fitted on the 18 September spans alone (≈ 278 W)
predicts the 12 October spans within −2.8 % to +0.3 %. The 270 W is a pool figure — every span
had the same three Cores — and each Core's own stream (`Σ pack_out − ac_out/0.94`, single cadence,
readable only while islanded) puts it at 41 / 52 / 175 W on slots 1 / 2 / 3 (means; 269 W in
all). Because most of it sits on one slot, the runway keeps 270 W as a floor when a Core leaves
rather than dropping 90 W per Core. The test gate is ±3 % on every span
for the new basis and a > 5 % miss for the old one.

**What it means for the alarms (perfect-foresight islanded replay, not the live forecast).**
Re-running each span minute by minute from its live pool percent against the recorded load and
PV of the following 24 h, with the 16 % reserve floor: the medium tier (reserve within 6 h) is
reached on 9 of the 30 nights instead of 6 (three new nights: 09-15, 10-04, 10-08, first at
22:10–23:23), and 0–40 min earlier on the other six (0 where both already read medium at the
span's start); the high tier (empty within 8 h) on the same
6 nights, up to 90 min earlier (mean 38 min); the low tier (any reserve crossing in the horizon)
on 16 nights instead of 14, up to 4.3 h earlier (mean 61 min). The two nights that reached the
floor (09-04, 09-08) reach the critical tier 10–30 min earlier. The ladder's thresholds and
cadence are unchanged; while the grid is backstopping the audible ladder stays silent as before.

**The charge leg (modelled since v1.194.0).** In 29 PV-surplus spans of the same history (no grid, PV at
least 1.5 kW above the load, pool 25–85 %) the pool charged 8–19 % less than `pv − load/0.94`
predicts on the measured capacity, and 2–7 % less with the 270 W overhead subtracted (why the
overhead applies in every hour). Every pool walk except the MPC optimiser's now stores a surplus
at √0.86 = 0.927, below all 29 spans. The night-charge planner keeps the nameplate basis and `load/0.94` (unchanged by design; reference chapter 5, [1.3a The measured energy basis](reference/05-runway-and-soc-alarms.md#13a-the-measured-energy-basis-v118719)).

### Live check on three nights (measured 2026-10-15)

The live model (`/api/runway` on v1.188.0, unchanged since v1.187.19: `backupFullKwh` 86.99, `capacityScale` 0.944, `overheadW` 270) against the three pack-only spans the recorder holds since 10-12, selected by the same rule as the 30 spans above; `grid_home_w` read 0 W in every row of all three. Method A is the per-source step-pinning above, so its error is step timing only (±0.3–0.7 % per night); method C step-pins Home Assistant's integer pool reading instead.

| Span (MST) | Hours | Load kW | Model / measured (A) | Implied overhead | Runway-hours error | Method C |
|---|---|---|---|---|---|---|
| 10-12 17:23 → 10-13 06:39 (reserve 16% all night) | 12.95 | 1.98 | 0.985 | 306 W | +1.5 % | 0.983 |
| 10-13 17:30 → 23:00 (ends at the night-charge write) | 5.08 | 2.16 | 0.975 | 336 W | +2.6 % | 0.983 |
| 10-14 17:32 → 23:54 (ends at a telemetry loss) | 5.69 | 1.91 | 1.002 | 266 W | −0.2 % | 1.004 |

Hours are method A's mean step window. Pooled, the model gives 56.96 kWh against 57.74 measured, **0.986**, and every night is inside the ±3 % backtest gate; the 10-14 span cut at 23:00, before its reserve write, reads 0.998 at 1.87 kW. The implied overhead averages 303 W (266–336) against the 270-W constant and the 267-W fit above (residual sd 40 W). Without the overhead term the same nights read 0.873 / 0.872 / 0.884, and the old basis (nameplate, `load/0.94`) would have overstated the hours by +21.3 / +21.5 / +19.8 % — consistent with the backtest's trend at about 2 kW. Home Assistant's integer endpoints (method B) carry ±1 % of the pool per night (±0.87 kWh) and read 0.989, 0.988 and 1.020 with bounds of 0.93–1.09, which is why the step-pinned figures are the primary ones. A shorter span after the SHP2 returned on 10-15 (04:17 → 06:25, under 3.5 h, the Cores' side unverifiable) reads 0.989 (A) at 1.10 kW, the lowest load yet replayed, with an implied overhead of 286 W. The Cores' recorder data after 10-15 01:55 are held values (§6) and are excluded.

---

## 4b. Runtime cost of the analytics path (measured 2026-09-11)

Moved unedited to [`history/performance-record-1.md`](history/performance-record-1.md) on
2026-10-26, to keep this record under its size limit: the first end-to-end latency measurement of
the analytics worker on the live host. One report, `/api/equipment-health`, held the single-threaded
worker for 9,007 ms per 10-min recompute (a head-of-line block, not a threading problem: load 0.22,
98.8% idle), and v1.151.0 brought it to 96 ms.

---

## 4c. Runtime latency on the live host (measured 2026-10-13 → 10-15)

Taken from the add-on's own log lines on the reference deployment (a 4-core Raspberry Pi,
Home Assistant OS, Node 22.22.2 with SQLite 3.48.0 in the add-on image). The source is the
Supervisor's add-on log, which spans containers: **2026-10-13 18:06:09 → 10-15 17:52:59 MST
(47.8 h, the journal's retention)**, across three processes — one already running at the start,
v1.187.23 from 10-14 05:22 and v1.188.0 from 10-14 20:32. (`docker logs` returns only the
current container; for it the two feeds match line for line.) Probes were sent at 17:56–18:08 on
10-15, one request in flight at a time.

**★ A regime break inside the window.** At 10-15 01:54:59, when a 122-minute name-resolution
outage (23:53 → 01:54) ended, the EcoFlow cloud's device list marked the SHP2 and all five Cores
offline. The SHP2 came back at 04:16:49 through its MQTT status topic and streamed from then on;
the Cores stayed off to the end of the window. `refreshAll` polls only the devices the list
reports online, so after the break a poll no longer fetches the Cores. Recorder intake, 165–290
samples a minute before the break, read 121–176 a minute in the 30-minute summaries from 02:08
to 04:34 and a steady 125–126 from the 05:04 summary on (one 144, at 10:38). Poll figures after
the break are reported separately and are not comparable.

**Boots** (two in the window):

| Measure | 10-14 05:22 (v1.187.23) | 10-14 20:32 (v1.188.0) |
|---|---|---|
| API gap, shutdown → listening | 8,596 ms | 8,639 ms |
| Start script → server listening | 3.18 s | 3.35 s |
| — of which tsx start-up and imports | 2,485 ms | 2,485 ms |
| Recorder boot phases, total (seed) | 32 ms (24 ms) | 32 ms (24 ms) |
| `ANALYZE` at boot | 0 ms | 0 ms |
| First alarm evaluation (first poll settled) | 674 ms | 735 ms |
| SoC-ladder gate opened | 523 ms, 12 ticks withheld | 546 ms, 11 ticks withheld |
| Alert set settled, after the first poll | 199 s | 199 s |
| Analytics report timeouts in the first 40 min | 0 | 0 |

- The recorder figures fall in the fast group of the 2026-10-11 reading, which put seven of ten
  boots (v1.187.3 → v1.187.14) at 31–42 ms with a seed of 23–36 ms and the other three at
  134–164 ms; what made those three slower is still not established. Before v1.163.0 the boot
  `ANALYZE` alone took **9,725–12,374 ms** (about 99.7% of `createRecorder`); `PRAGMA optimize`
  still plans none.
- The first evaluation is inside the 2026-10-11 range of 558–819 ms. Before v1.186.0 the first
  full alarm pass waited on four analytics reports and took **63–105 s** (CHANGELOG 1.186.0).
- The 199 s is a design floor, not compute: the alert set is trusted after a 180-s boot debounce
  from the first poll, plus at most one 20-s evaluation tick.
- ★ **The analytics alerts do not merge within 2.5 s.** The 2026-10-11 reading said they did;
  2.5 s is the per-pass wait budget. On the 05:22 boot the four analytics alert feeds first
  delivered 22.4–29.9 s after the server started listening. The 20:32 boot logged no
  first-delivery line for any feed, although it logged their cold reads and a set settled on a
  hydrated store, and the code logs a first delivery after a cold read; per-feed delivery cannot be
  read from that boot, and why the lines are missing is not established.

**The analytics worker is cold after a start.** Measured 2026-09-04: a `selfConsumption` report
requested at +0 s and +15 s resolved with no usable load figure and without an error; at +75 s
it returned 4.35 kW. On the 2026-10-11 boot four reports timed out at +30 s and were retried
once. A boot-time consumer of an analytics report must retry and check the field it needs; a
`try/catch` sees nothing wrong. In this window there was one report timeout in 47.8 h —
`report:degradation` at 10-15 03:33:59, 2 min 21 s after the nightly backup window (03:30:32 →
03:31:38, 66 s); the proximity is timing only, and no cause is established. For trend: until
v1.171.0 the hourly charge-curve scan pinned the worker for **16–20 s every hour** (CHANGELOG
1.171.0).

**REST poll duration** — one poll of every listed-online device per 60 s (`POLL_INTERVAL_MS`),
and, at debug log level, one summary per 30 successful polls (`poll duration over last 30
poll(s): p50 … p95 … max …`):

| Part (MST) | Summaries (polls) | p50 range (median) | p95 range (median) | Worst single poll |
|---|---|---|---|---|
| Cores online, 10-13 18:06 → 10-14 23:31 | 59 (1,770) | 438–789 ms (**632 ms**) | 484–2,139 ms (**842 ms**) | 3,440 ms |
| — the process before the 05:22 restart | 23 (690) | 603–789 ms (638 ms) | 700–2,139 ms (877 ms) | 3,440 ms |
| — v1.187.23 | 30 (900) | 438–682 ms (616.5 ms) | 484–1,715 ms (799 ms) | 2,146 ms |
| — v1.188.0 | 6 (180) | 635–691 ms (659 ms) | 744–1,087 ms (899 ms) | 1,562 ms |
| Cores offline, 10-15 02:03 → 17:34 (not comparable) | 32 (960) | 415–688 ms (566 ms) | 635–1,680 ms (812.5 ms) | 6,132 ms |
| *2026-10-11 reading, normal regime* | *51 (1,530)* | *568–912 ms (629 ms)* | *639–1,655 ms (886 ms)* | *3,137 ms* |
| *2026-10-11 reading, elevated (one v1.187.13 process, 10-10)* | *18 (540)* | *792–1,523 ms (1,064 ms)* | *1,325–2,086 ms (1,773 ms)* | *2,202 ms* |

The medians are unchanged from the 2026-10-11 normal regime, and there is **no elevated regime**
this time: no summary in 47.8 h had a p50 above 789 ms, across three processes. Three summaries
went past the earlier p95 range (2,139, 1,715 and 1,680 ms). The worst poll, 6,132 ms at 06:21 on
10-15, is the only "poll slow" line in the window, and a "clock sample rejected (rtt-inflated)"
line 0.4 s before it places the delay in the cloud round-trip. The cause of the 10-10 elevated
regime remains unestablished.

**Poll failures: 123.** 122 fall in 23:53 → 01:54 (118 name-resolution failures, 4 connect
timeouts) and one at 02:21; polls recovered in 609 and 1,369 ms. A failed poll never enters a
summary, so the summary logged at 02:03 covers 152 minutes.

**Slow requests** (`slow request`, over 1 s): **50 lines in 4 bursts, every one a dashboard load.**

| Burst (MST) | Requests | Range | Slowest |
|---|---|---|---|
| 10-13 21:31 | 13 | 1,474–8,540 ms | `/api/confidence` 8,540 ms |
| 10-14 18:53 | 6 | 1,562–1,908 ms | `/api/history` 1,908 ms |
| 10-14 19:11–19:13 | 25 | 1,694–6,606 ms | `/api/internal-resistance` 6,606 ms |
| 10-14 19:23 | 6 | 1,755–2,110 ms | `/api/confidence` 2,110 ms |

By endpoint, `/api/history` 24 and `/api/confidence` 6. Requests in a burst finish within
14–16 ms of each other: `/api/history` is served on the same single analytics worker as the
report builds, so this is the head-of-line block of §4b. During one dashboard session the
process handled about 73 requests a minute. The v1.188.0 process logged no slow line, which shows
only that no dashboard load was seen. Probed one request at a time at 18:01–18:03, 19 endpoints
including a one-hour `/api/history` answered in **9.5–19.7 ms** (median 12.7; two calls each,
equal, so every cache was warm) and `/api/summary/today` in 48.5 / 50.8 ms.

**Documentation tab and Changelog dialog** (10 GETs each through the Supervisor, 17:56): the
documentation is 28,151 B, served in 2.84 / 3.46 / 6.12 ms (min / median / max), and the
changelog 23,302 B, in 3.39 / 3.47 / 4.03 ms; both are byte-identical to `DOCS.md` and
`CHANGELOG.md` at 111247f. A same-moment control on the same Supervisor served 580,588 B in
5.9 ms and files up to 32 KB in 2.5–2.9 ms. Serving was therefore never the cost the two cuts
removed. v1.188.0 took the documentation from 1,171,496 B at the deployed v1.187.23 to 28,151 B
(41.6×); the changelog cut was v1.187.22's, 329,715 → 20,909 B (15.8×), and v1.188.0 grew it
from 21,747 to 23,302 B. By the control's slope (about 2.5 ms plus 5.5 µs per KB) the old
documentation would serve in about 9 ms and the old changelog in about 4 ms, so what the cuts
removed was on the browser's side, rendering the whole file on every open, which is not measured
here.

**Resources** (one moment, 18:05–18:08): container CPU median 0.43% of a core (max 6.42%, 12
samples); host 95.7% idle, load average 0.25–0.86 on 4 cores, 4,015 of 7,952 MB used. The server
process is 291 MiB resident (peak 1.09 GiB since the 20:32 start, time unknown); `docker stats`
reports 1.63–1.85 GiB for the container, most of it SQLite page cache (285 MB anonymous against
2.13 GB file cache). For trend, §4b (2026-09-11): load 0.22, 98.8% idle, 3.7 GB used.

★ *2026-10-22 (§4d): this process started before the Cores went dark; one started while they
were dark held its worker at about 37% of a core until v1.191.2.*

**Database size.** The live database is 3,350,618,112 B (write-ahead log 7.6 MB, about 18.9
million samples; samples retention 1,825 days). The `/share` snapshot published by
`VACUUM INTO` is 2,475,077,632 B and dated 2026-09-27: 14 days old at the 2026-10-11 boot and 18
days old on 10-15. A 1,917,849,600-B `analyze-probe.db` dated 2026-09-12 sits beside it; if
`/share` is in the Home Assistant backups, it adds 1.92 GB to each. (§4b's 1.72 GB is a
September copy.)

---

## 4d. The day forecast rebuilt on every read while every Core was dark (measured 2026-10-22 → 10-23)

The reference Pi (§4c) ran **v1.191.1** from 14:23 MST on 10-22, with all five Cores listed offline
by the EcoFlow cloud since 10-15 01:55. Read-only: per-thread CPU time (`docker top` every 30 s,
16:44:54 → 16:54:54), GETs one at a time (16:49:51 → 16:51:41), and the add-on log.

- Analytics worker: **36.7% of a core** (220 s in 600 s; the main thread 2 s). §4c's 0.43% came
  from a process started before the Cores went dark: projections survive a cloud-offline
  transition, so it kept its cached forecast.
- `/api/forecast`, `/api/forecast-skill`, `/api/confidence`, `/api/runway`: **1.60–1.62 s** each;
  `/api/ha-state` 3.03 and 3.64 s; reads that need no forecast queued behind a rebuild for up to
  2.97 s.
- **84** `slow request` lines in 2 h 29 min (§4c: 50 in 47.8 h): a dashboard load at the start (23,
  up to 5.2 s), then the dashboard's and Home Assistant's reads, `/api/ha-state` up to 5.2 s.

**Cause.** `computeDayForecastUncached` cached only with a projected Core (`dpus.length > 0`).
Projections live in memory and a Core the cloud lists offline is never polled, so a process started
with every Core dark had none, although its forecast was complete (the panel's load and each
connected Core's own recorded PV). Every forecast-dependent report paid a rebuild, about 13 a minute
from the alarm monitor, MQTT, the runway ticks and the self-warm, and the caches keyed on its
`generatedAt` never hit. Not a regression: v1.188.1 to v1.191.1 replay at 10.6–11.1% alike.

**Replay**: the real worker and client on an APFS clone of the `/share` snapshot (data to 10-18
19:01 MST), the live device snapshot moved to that clock, the production schedule, a 300-s window;
Apple M5, Node 26.0.0, where a rebuild takes 0.48 s against the Pi's 1.6 s. The control projects
the panel's Cores.

| Replay | v1.191.1, dark | v1.191.2, dark | Control, before → after |
|---|---|---|---|
| Worker CPU | **10.63%** | **0.46%** | 0.15% → 0.15% |
| `forecastAlerts` feed, mean / max (budget 2.5 s) | 943 / **1,496 ms** | 13 / 186 ms | 14 / 186 → 14 / 185 ms |
| Slowest MQTT report, mean / max | 1,489 / 1,776 ms | 107 / 150 ms | 12 / 102 → 12 / 103 ms |
| Eight forecast-dependent reports, one warm pass | **3,960 ms** | 40 ms | 38 → 38 ms |
| One forecast build, warm | 480–486 ms | 267–273 ms | cached |

v1.191.2 also caches on the projected house panel and rebuilds when the re-added dark Cores change
or a Core's first reading turns pending; each dark Core's PV is read once per build.
Built at a frozen instant, the dark and control forecasts are byte-identical to v1.191.1's.

**The Pi after the update** (v1.191.2 from 21:25 MST on 10-22, every Core still dark; read-only as above):

- Analytics worker: **1.80% of a core** (21 min 50 s of CPU in 20 h 12 min, to 17:37 on 10-23); the
  replay's 0.46% scales to about 1.5% on the Pi.
- `/api/forecast`, `/api/forecast-skill`, `/api/confidence`, `/api/runway`: **10–15 ms**; `/api/ha-state` 17 ms.
- **No** `slow request` line from the start to 17:37 on 10-23, against 84 in 2 h 29 min before.

## 4e. Self-consumption, carbon and tariff while every Core is dark (measured 2026-10-26)

After v1.191.2 (§4d) three reports were still rebuilt on every read with every Core dark, each
about 2.2 times a minute: self-consumption (cached only with a projected Core, v0.15.13; read
again inside carbon), carbon and tariff (cached only with one, as their `basisComplete` says).

**Method.** No live read. Synthetic recorder databases, placeholder serials, read through the
real read-only recorder and the worker's report chokepoint; a frozen clock stepped through 10
min of the production schedule after one uncounted warm pass; Apple M5, Node 26, the Pi about
3.3 times slower (§4d); replay figures are the mean of two runs. `dense11`: 45 days, 7.1 M
samples at 10–30 s, the Cores silent for 11 days; `dense0`: the Cores recorded to the end;
`dark11`: 120 days at the base cadence, silent for 11 days.

| `dense11` / `dense0` / `dark11`, every Core dark | v1.191.2 | v1.191.3 |
|---|---|---|
| One tariff rebuild (median of 21) | 52.6 / 39.7 / 39.2 ms | 33.1 / 32.6 / 20.1 ms |
| One self-consumption rebuild | 19.9 / 41.4 / 11.3 ms | cached |
| Replay, worker ms a minute | **207** / 274 / 143 | **80** / 77 / 49 |
| Replay with self-consumption cached, the tariff unchanged | — | 123 / 92 / 94 |

The control (`dense11`, every Core projected) stays at 9.4 ms a minute. With one Core leaving
and rejoining the source list every 30 s, a projected fleet goes from 767 to 807 ms a minute:
the day forecast already rebuilt on each change (§4d), and self-consumption now does too
(38 ms a minute) where v1.191.2 served the entry from before the change for up to 15 min; the
same flapping on the dark fleet falls from 388 to 295. Self-consumption, carbon and tariff are
byte-identical to v1.191.2's (`darkFleetEnergyIdentity.test.ts`).

**Expected on the Pi**, scaled from `dense11`: 127 ms a minute less is about 0.7% of a Pi core,
so with every Core still dark the worker's 1.80% (§4d) should fall to about 1.1%. Measured
there after the release: 0.73% (4:44 of CPU over 10 h 45 min, 2026-10-27), from 1.6–1.7%.

**Reading a report's own cache before the forecast: declined.** The forecast read is a cache hit
since v1.191.2, 0.45 µs over a bare await (M5); 300 random-phase 2-h runs of the schedule give
4.00 forecast builds per 2 h in either order. Only a variant that serves a skill, band or
multi-day entry scored on a superseded forecast (up to 4,380 s of 7,200 s in that simulation)
saves a recompute, against the v1.186.5 rule.

---

## 5. Review & audit history

Adversarial multi-agent review is the standing quality gate for this codebase; its cycles and their dispositions are compressed here. Full finding-by-finding detail lives in the CHANGELOG entries (`ecoflow_panel/CHANGELOG.md` + `CHANGELOG-ARCHIVE.md`).

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
| 2026-09-05 | v1.130.0 release post-mortem | **1, process** | The release **silently did not happen**: the merge carried the code and CHANGELOG but not the `config.yaml` bump, and `tag-release.yml` was then paths-filtered on that one file — so no tag, no image, no release, and every workflow green. Guard shipped: `scripts/check-release-pr.py`, verified against the tree that failed. Since 2026-10-11 `tag-release.yml` runs on every push to `main` and fails a `Release vX` merge that changed no version. |
| 2026-09-05 | Five unearned signals | **5 confirmed** | v1.131.0. Each was a detector or status field that **could not report what it claimed**: inverter standby ANDed off against a whole-house gate no occupied house satisfies; the night-charge revert closing on a cloud ACK; the rate-collapse detector never sampling a silent device; the alert-telemetry exemplar pairing one device's title with another's id; a dead push channel reporting no failures. 16/16 mutants. |
| 2026-09-05 | Live verification of v1.131.0 | **1** | v1.131.1/.2. The standby fix was **necessary and not sufficient** — `ac_out` reads 0 on all five Cores because the DPUs feed the house through the SHP2 link, not their own AC output port. Shipped an honest empty state (`blockedReason`) rather than an improvised re-point; the new field then **contradicted the release note that introduced it**, corrected in v1.131.2. |
| 2026-09-06 | Weekend-arbitrage investigation — 171 agents, every claim faced 3 adversarial verifiers | **23 survived, 32 refuted, 25 unresolved** | Refutation rate is the point: more claims died than survived. Confirmed the Friday 0 kWh buy was correct, quantified the weekend gap at **~$25–42/yr** (all weekend hours are off-peak, so the spread is 1.77 c/kWh — not an on-peak displacement problem), and established that a Thursday top-off **cannot** help (68.2 kWh usable band vs ~105 kWh/day draw). Six legibility fixes → v1.132.0, 8/8 mutants. |
| 2026-09-07 | Engine/UI review cycle F1–F12, shipped in two authorised batches | F1–F6 then F7–F12 confirmed | v1.134.0 → v1.144.0. Headline: the Energy page could finally show money; the DB snapshot says how old it is; the discovery table stopped lying about what it published. v1.141.1 was a same-day **correction** — v1.141.0's `object_id` was inert because HA mints the entity id from the *name*, so the rename never reached the twelve circuit sensors. |
| 2026-09-08 | False "EcoFlow data restored" push — root-caused from the log ring | **1 critical attribution defect** | The device went OFFLINE at 15:52:31.591 and the "restored" push fired at 15:52:31.893 — **302 ms later**. `lastUpdated: 0` for that SN proved no quota fetch had ever succeeded: the push was announcing recovery of telemetry that had never arrived. v1.138.0 fixed the attribution (`refreshAll` now returns `{attemptedSns, failedSns}`); v1.139.0 **deleted the doorbell entirely** after the owner settled that error 1006 is product-class, with a build-failing pin so it cannot return. |
| 2026-09-10 | Cloud-shadow investigation — settled statically, then measured | **1 confirmed, mechanism established** | The EcoFlow cloud can serve a **stale shadow**: a 200 OK carrying a byte-identical replay of the previous body. Every freshness gate keyed on "the request succeeded" was therefore disarmed. Settled by reading the mechanism (`setDeviceQuota` replaces wholesale; no cache/ETag; MQTT translation is DPU-only) and then measuring a 12-channel witness vector across 1,558 minutes. v1.142.0 added `contentStaleSinceMs` + the shadow witness; v1.143.0 carried the sticky clocks through the 60-s rebuild. |
| 2026-09-10 | Log audit round 2 — 6 families, adversarial verification | 83 raw → **27 survived**, 22 refuted | v1.145.0–v1.148.0. The refutation rate is again the point. Headline finds: the log ring **is** the incident window (~53 h reach) and one status family was 84% of all push volume; a per-poll success line was 32.5% of log bytes and became a periodic p50/p95/max summary; `basisBlockedBy` now names which basis gate closed. ★ **A claim made earlier in this cycle was falsified**: two releases had been justified by a forensic-reach argument that required `LOG_LEVEL=debug` to be off, and the earlier review notes recorded it as standing. |
| 2026-09-11 | Documentation freshness + GitHub surface audit | **2 doc-correctness defects, 1 engine defect** | v1.149.0. DOCS.md stated the advisor's basis gate as `≥ 0.9` — the identical error `PERFORMANCE.md` had **found and corrected in its own text on 2026-09-06**, while the normative reference it was measured against went untouched for five days. DOCS.md also listed two of `poll_health`'s three reasons. The engine defect is the `bandSigmaCal` five-way ambiguity in §2, found by refreshing a table rather than by reading code. Six README claims had silently rotted; `scripts/check-doc-claims.mjs` now fails CI on any of them. |
| 2026-09-13 → 09-15 | Six-lens log audit — 15 agents, every finding adversarially verified | **4 confirmed** | v1.158.0 fixed three notification defects (headline: a held message-rate collapse on an idle pack still paged after the session had already recovered); the fourth is recorded. |
| 2026-09-17 | Force-charge past the 50% reserve ceiling — 28-agent adversarial review before first run | **4 defects fixed before it ever ran** | v1.165.0. Headline: the first cut stopped re-issuing the OFF after ~18 min, which could have left force-charge on into the 16:00 on-peak; the OFF is now re-issued every 15 min while it reads on, and its escalation is spoken. |
| 2026-09-20 | Log audit | Findings shipped in two releases | v1.171.0 (the hourly pack scan pinned the analytics worker 16–20 s every hour) and v1.171.1 (a prior night's arm could fire against tonight's decision; an EcoFlow "success with no data" wiped every Core's quota and pushed a false all-clear). |
| 2026-09-22 | Dashboard audit | All findings shipped | v1.175.0 → v1.183.0 (e.g. the LIVE pill read green through a cloud outage; "Comfortable" was shown when nothing had been projected). |
| 2026-09-24 | Production log review | Confirmed findings shipped | v1.186.0. Headline: the readiness gate counted every cost-mode night as an engine fault, so `auto` could never act (§3); the first alarm pass after a start waited 63–105 s on analytics (§4c). |
| 2026-10-03 | Production log review | Confirmed findings shipped | v1.187.10: October priced at winter rates (billing-cycle seasons), a cloud "offline" flag held while the Core's data still flows, a frozen panel reading published as unknown, pack end-of-life dated again, the info tier no longer evicted on arrival (§1). |
| 2026-10-10 | Mutation-harness conversion to the parallel runner (PR #509) | **1 lost pin found** | Running every harness again surfaced `mutate-analytics-worker` xi as an equivalent mutant: v1.187.10 had moved the guard it pinned into `publishReadiness`. Re-pointed; 12/12. ★ A release that moves a guard can silently turn its mutant equivalent — rerun the harnesses after one. |
| 2026-10-11 | AppArmor profile review — complain-mode profiling of the running add-on and of an isolated boot | Profile narrowed | v1.187.15: two capabilities instead of ten, socket families limited to those in use, `/etc`, `/package`, `/command` and persistent `/var` subtrees write-locked; pinned by `apparmorProfile.test.ts` and `mutate-v1187-15.mjs`. |
| 2026-10-11 | Documentation and security review — README, SECURITY.md, DOCS.md and `docs/` read against the code | 2 write routes without the write gate, 3 workflow steps on a floating action tag, 1 anchor-checker blind spot; ~375 documentation corrections | v1.187.16: `POST /api/alerts/outcome` and `POST /api/energy-history/backfill` gated, and every write route pinned by `writeRoutesGated.test.ts` (harness `mutate-v1187-16.mjs`); the last three actions pinned to commit SHAs; `check-mutant-anchors.mjs` reads `.txt` targets, so the AppArmor harness's anchors are checked in CI; DOCS.md chapter 12 reassembled from its scattered addenda. |
| 2026-10-11 → 10-12 | Reviews of v1.187.17–v1.187.19: the workflow action pins (four lenses); fleet shape, the worker's boot basis and the release reconciler (three lenses each, the last two re-reviewed); the runway's measured basis (three lenses, then a final review). A skeptic per finding | 62 raw → **50 confirmed**, 12 refuted | v1.187.17–v1.187.19. Both headlines were caught before merge: the boot-basis fix as first written reset the runway's carried recent load, so a reset during a panel-load gap made the runway unavailable and re-armed an active runway alarm; and the reconciler's downgrade check fired only on the push that changed the version, so later pushes stayed green while `main` still offered a downgrade. |
| 2026-10-12 | Production log review, 10-10 18:07 → 10-12 10:10 (three lenses: warnings, boots, Supervisor; a skeptic per finding), two-lens reviews of each fix over two rounds, an integration review of the merged tree, and a same-day follow-up to 19:35 | Log: 10 raw → **7 confirmed** (4 defects, two of them raised by two lenses, and 1 configuration item), 3 refuted. Fixes: **13**, then **3**. Integration: **7** (1 high). Follow-up: **1**, and its release review 1 (low). In all 36 raw → 31 confirmed | v1.187.20: a settings-drift push held for quiet hours was lost to a restart; a 59-s host-load spike during a Home Assistant update was spoken (now a 5-min dwell); the charge-curve cold build overran its 30-s budget at every start; hot backups copied the live WAL database unquiesced. The integration high: the backup journal sized its file by path and then renamed it, which failed the required CodeQL check (`js/file-system-race`) on the release PR — the fix branch had no PR of its own, so CodeQL first saw it there, and it took two rounds. v1.187.21: a learned peer cell-spread warning was spoken at 18:32 for a pack whose own cell-spread warning has been push-only since v1.187.12; it is now pushed, not announced. |
| 2026-10-13 → 10-14 | Production log review, 10-12 19:30 → 10-13 16:50 (a host reboot at 22:02; a night charge armed on its worst-case figure and then cancelled). Fixes A–D, each with a three-lens review and a skeptic per finding; an integration review; a final four-lens review of the merged tree (combined, life-safety, release, and an audit of every spoken and pushed advisory) | 3 defects + 1 requested change. Reviews: 60 raw → **55 confirmed** (a finding raised by two lenses counts twice), 5 refuted | v1.187.22: (A) after the reboot the SoC ladder averaged the one Core of three that had reported (49% against a 52% pool) and spoke a false 50%; it now waits for a hydrated store. (B) Three audible-health probes in 31 s put a push and its "Resolved" 20 s apart; confirmation now spans two probe periods. (C) The announced "Buy ~64.2 kWh" was the islanded worst case the target is sized on (delivered/buy median 0.49 over 7 nights); every spoken, pushed and card line now states only the charge the write makes, and the worst case appears once, labelled as the sizing basis. (D) The Changelog dialog rendered the whole 329,715-B file; it is now kept ≤ 32 KiB. Of the final review's 11 (6 from the advisory audit, 5 on the release), 8 were fixed in v1.187.22 and 3 shipped as v1.187.23. |
| 2026-10-13 → 10-14 | Documentation restructure: planning (12 agents, ending in a completeness critic and a revision), five commits, then a five-lens review (fact-check against the code, loss audit, links and rendering, public register, CI/CodeQL/harness) with a skeptic per finding, one fix round and a recheck | Plan: **16 critic gaps**, all closed in the revision. Review: 15 raw → **13 confirmed** (12 distinct, 4 medium), 2 refuted; the recheck closed all 13 | v1.188.0: the Documentation tab went from the 1,171,496-B manual to a 28,151-B operator guide (§4c); the reference moved to `docs/reference` (656 of 665 sections byte-identical, the rest declared edits) and the release log to a frozen, hash-pinned `docs/history`; `check-docs` D1–D11 runs in CI. Headline: the write-list rule (D11) passed on prose, so writer rows could be deleted with the check green. |
| 2026-10-14 | Live verification of v1.187.23 (deployed 05:22) and log review to 18:13; then the first arm with an expected figure, 21:32 under v1.188.0 | **0 defects** | The SoC ladders withheld 12 ticks and opened 523 ms after start; the alert set settled 199 s after the first poll; no warning or error line, and nothing spoken. At 21:32, after the 20:32 v1.188.0 deploy (whose changes to the night-charge actuator and force-charge files are comments only), the first plan armed with an expected figure — the v1.187.22/.23 feature — logged ≈3.3 kWh expected toward 59.8%, beside an islanded worst case of ≈13 kWh (§3). |
| 2026-10-14 | Design: winter cost charging moved to the tariff's 10:00–15:00 super off-peak window, with overnight kept as an outage-backup leg. 12 agents: 5 code maps, 2 competing designs, 2 judges (safety, operator), synthesis, a completeness critic, revision | **15 critic gaps**, all closed in the revision | No code then; shadow since v1.189.0. The judges split — safety for two separate tracks, operator for one cycle of typed legs — and the synthesis took the typed-leg cycle. It ships in slices that write nothing at mid-day first; the write switch waits for at least 5 winter weekdays of shadow running, a re-entry replay and an attended device test. |

The pattern this table exists to preserve: findings are only counted after independent adversarial verification; safety-direction findings (under-buy, optimistic runway, silenced alarms) ship with regression tests pinning the failure; and reviews of fixes have repeatedly found real defects (the 07-20 second pass, the v1.26 in-review catch, the v1.131.1 live check), so post-merge review remains part of the pipeline, not a formality.

**What the 2026-09 cycle added to that pattern.** Three of its findings shared a shape worth naming, because it defeats review: *silence and correctness are indistinguishable from outside*. A release that never ran, a detector that never fired, and a ledger row that filed an impossible night as a quiet one all presented as healthy, and all survived because there was nothing to disagree with. Two of them were caught only by **querying the device after shipping a fix that reviewed as correct**. The countermeasure now in the codebase is to make empty states say which empty they are (`blockedReason`, `arm_disposition`, `cost_ceiling_basis`, `standbyBlockedReason`) rather than rendering blank.

**What the 2026-10 cycle added.** Its most consequential finding was correct code under a wrong label: the night-charge figure announced on 10-12 was computed as designed — the worst case the target is sized on — and was presented as the purchase. The fix changed no sizing value, only what each line states; the final review then audited every spoken and pushed number against the quantity the system acts on and found six more. Two findings were checks that could not fail: the documentation write-list rule passed on prose, and the v1.187.21 control test passed on cases other than the one it named. Across the cycle 173 raw findings went to a skeptic and 24 (14%) were refuted, against 32 of 80 and 22 of 83 in the September audits above.

**Committed mutation harnesses: 107, with 2,529 anchors at v1.188.0** (prior readings: 91 / 1,867 at v1.187.16, 90 / 1,861 at v1.187.15, 30 / 203 on 2026-09-11, 17 / 102 before that; the CI-checked current figure is the one in `README.md`), validated in CI by `scripts/check-mutant-anchors.mjs` — which exists because a harness whose anchors stop matching does not fail, it stops running, and an aborted harness reads exactly like a clean one. Two harnesses recorded a **removed** mutant with its reasoning (one provably equivalent, one requiring a state the suite cannot construct) rather than leaving a permanent false survivor in the count. Since 2026-10-10 every harness runs its mutants in parallel, each in a private copy of the tree (§7).

★ **A harness result is meaningless against a red tree.** Twice in the 2026-09 cycle a harness reported a full kill count while two tests were already failing — a red baseline kills every mutant for free, and the number reads identically to a genuine clean sweep. Confirming `0 fail` before reading any harness result is now part of the procedure, not a courtesy.

---

## 6. Known limitations & data-gated features

Conditions below read as gaps by design. They are listed so an `unknown`/null reading is not misdiagnosed as a fault — and, where a limitation has since been resolved or reclassified, that is stated rather than the old text being quietly deleted.

- **Expected-unknown sensors on a near-new fleet** (reference [chapter 6](reference/06-health-engines.md#6-battery--pv-health-engines-soh-eol-pack-risk-resistance-rte-thermal-soiling)) — *unchanged*: `..._soonest_pack_eol`, coulombic efficiency, predictive SoH and the immature internal-resistance trend all publish `unknown` until genuine aging signal exists; `..._runway_to_reserve_if_shed` is null whenever no shed scenario is advisable. Null over a fabricated number, in every case. ★ *2026-10-15: peer fade, internal resistance and coulombic efficiency have no data on any of the 24 packs (0.55 of the pack-risk weight), and internal resistance is `learning` on every Core (§4).*
- **~~Tariff rates unconfirmed~~ — RESOLVED.** The prior snapshot recorded every dollar field as null pending rates from a bill. The APS R-EV rates are entered and confirmed; the figures in this sentence are an earlier configuration, dated in the 2026-10-15 note below: overnight (23:00–05:00) **13.1 ¢/kWh**, off-peak **17.0 ¢**, summer on-peak **41.6 ¢**, winter on-peak **39.5 ¢**, winter super off-peak (10:00–15:00) **8.2 ¢**. On-peak is **Mon–Fri 16:00–19:00 only**; every weekend hour is off-peak. At `DISPATCH_ROUND_TRIP_EFFICIENCY = 0.86` (charge leg `√0.86 = 0.9274`, discharge leg 0.94, product 0.872) stored overnight energy delivers at **15.02 ¢/kWh** — cheaper than off-peak by 1.98 ¢ and than on-peak by 26.6 ¢. **Rates are manual and carry no expiry check**; a tariff change would be silently stale. ★ *v1.187.10: seasons follow APS billing cycles — by usage month, April–September summer and October–March winter (calendar months had been read as bills, so October usage was priced as summer). v1.187.13: the R-EV schedule's off-peak holidays are off-peak all day — no on-peak, overnight or super-off-peak hours. Rates are still manual and still carry no expiry check.* ★ *2026-10-15: the 13.1 / 17.0 / 41.6 ¢ figures are the ledger's `tariff_snapshot` from the 2026-08-11 plan to 09-06, and the 15.02 ¢ is derived at 13.1 ¢. From the 09-07 plan the snapshot reads overnight 12.59, off-peak 16.91 and summer on-peak 44.2 ¢; from 10-05 (winter) overnight 12.59, off-peak 17.0, on-peak 39.5 and super-off-peak 8.2 ¢, which `/api/tariff` reads now. At 12.59 ¢ stored overnight energy delivers at 14.44 ¢/kWh, 2.56 ¢ below off-peak and 25.1 ¢ below the winter on-peak. One option sets the overnight rate for both seasons.*
- **Inverter standby is not measurable on this topology** — *new, v1.131.1*. The Delta Pro Ultras feed the house through the SHP2 link rather than their own AC output port, so `ac_out` reads 0 (with `acOutVol` 0) in normal grid-tied operation and kilowatts while islanding — a bimodal register with no idle plateau, because an inverter that is off reports 0 rather than its own self-consumption. `idleWatts` therefore publishes null with an explicit `blockedReason` (`ac-output-stage-idle` on Core 4, `insufficient-idle-samples` on the rest) instead of rendering blank. Recovering standby draw would mean inferring it from pack drain (`bat_amp × bat_vol` while PV is dark and output is zero) — a different measurement, not a re-point.
- **~~The write-readiness gate cannot open on current inputs~~ — SUPERSEDED 2026-10-15: it is `BLOCKED` on a measured under-buy rate.** On 2026-09-11 it had two independent blockers: the gate's own text called the under-buy criterion **UNREACHABLE** because all 15 actuated nights disclosed a cushion shortfall, and the advisor's basis gate had closed at 72% band coverage, so no night could be actuated or scored. Both have cleared — plans resumed on 2026-09-14 and no buy row since 09-21 discloses a shortfall — and the criterion now measures **12.5%** (2 of 16 measurable nights) against a 10% cap, a HARD block; sizing bias and both band marginals would still hold the gate at `LEARNING` behind it (§3). *The 2026-09-06 policy decision — a 10% total protected floor with the cushion disabled — is still not applied: every ledger row since 09-12 reads a 16% floor and a cushion of 12–26 kWh. The shortfall cleared with the standard unchanged while the cushion shrank with the measured load; that the second caused the first is an inference, not a tested cause.* ★ *v1.186.0 removed a third, unrelated blocker — the gate counting every cost-mode night as an engine fault (§3).*
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
- **~~A `0` that means "cannot count"~~ — RESOLVED for strikes (2026-09-11) and for under-buy (by 2026-10-15); the caution still stands generally.** `strikesMeasurable` went **0 → 1** by 2026-09-11, so `activeStrikes: 0` reports a genuine absence of engine faults, and `underBuyMeasurable` now reads **1**, with 16 of 35 actuated nights measurable. Both resolved the right way — the measurement became possible, rather than the zero being reinterpreted — and the under-buy rate, once measurable, has read over its cap since 10-09 (§3). The general caution is unchanged and still load-bearing: any zero in `readiness.metrics` whose companion `*Measurable` field is also zero is an inability to count.
- **`grid_home` coverage gate** — *unchanged*: whole-home grid accounting trusts `grid_home_w` only at `GRID_HOME_MIN_COVERAGE = 0.9` of panel-load coverage; below that the KPIs fall back to the DPU-side basis and `grid_home_coverage_frac` reads null. Cloud-offline SHP2 windows are the dominant cause. Every captured ledger row with a charge window from 2026-09-10 to 10-13 reads coverage 0.98–1.0 (33 of 34); the 10-10 row reads null because that night had no cheap window to pair actuals to, not because coverage was low.
- **★ Band coverage vs. the advisor — RECLASSIFIED A THIRD TIME: the basis gate is open, and the binding band constraint is the readiness gate's.** This item has been wrong in both directions, which is itself the finding. The 2026-07-21 snapshot said a 90% gate held every plan at null; the 2026-09-06 snapshot corrected the gate to **0.78**, reported 84% coverage and concluded *"the basis is satisfied; plans are sized"*, naming `loadBandCoverage` (0.769) as the binding constraint; on 2026-09-11 PV band coverage fell to 72%, the basis gate closed and the advisor produced no plan, while `loadBandCoverage` rose to 0.833. By 2026-10-15 it has turned over again: the basis gate reopened on 09-14 and has refused only 09-27 since (the restart partial-map forecast), the probabilistic route reads 83% in the `shrunk` regime, and the binding band constraint is the readiness gate's — PV coverage 93.9%, above its 92% ceiling, and load 60.8%, below its 78% floor (§2). The threshold (0.78) is the only part of the 2026-09-06 entry that has survived every reading — because it was read from the source rather than inferred from behaviour.
- **The weekend arbitrage gap is real and small** — *new, quantified 2026-09-06*. Friday's overnight window is 1 hour, Saturday has none, Sunday 5 h, Mon–Thu 6 h. Because every weekend hour is off-peak, the only weekend arbitrage is carrying 13.1 ¢ energy into 17.0 ¢ hours: **1.77 ¢ per delivered kWh**, ≈ **$0.50–0.80 per weekend** (hard physical ceiling $1.28), ≈ **$25–42/yr**. A Thursday pre-buy cannot close it — the usable 16→90% band is 68.2 kWh against ~105 kWh/day of draw, so Friday consumes it before Saturday starts. **Open question with a cheap answer:** whether APS treats Fri 23:00 → Sat 05:00 as one overnight block. The code flags this in three places; one bill settles it, and it is the difference between a 1-hour and a 6-hour Friday. ★ *Still open at v1.187.15 (`tariff.ts` header). The design document's "~$312/yr" Friday estimate was withdrawn in v1.187.0 — Friday's on-peak precedes Friday's window, so it is not evidence about the truncation. Since v1.187.13 an APS off-peak holiday has no overnight window at all.*
- **~~`ARB_COST_MAX_SOC_PCT = 90` is not deliverable above 50~~ — RESOLVED v1.164.0 / v1.165.0.** ★ *The firmware question is settled: the panel's own reserve ceiling is 50, proven on the device on 2026-09-16 (v1.164.0). v1.165.0 added the force-charge path: on a supervised/auto night with `ARB_OBJECTIVE=cost` and `ARB_COST_MAX_SOC_PCT` above 50, `nightForceCharge.ts` syncs the panel's force-charge ceiling (`setForceChargeCeiling`) and switches the per-channel force-charge ON (`setChannelForceCharge({ on: true })`) in the last stretch of an applied, verified reserve write, and OFF — verified off — at the target or the window close. The "near 60%" charge-power limit in the original entry was superseded by measurement: on 2026-09-16 the pack took ~15 kW and reached 49% by 01:00, and on 2026-09-18 force-charge reached 90% at 03:30.* Original entry, *confirmed 2026-09-06*: The actuator's only write is the backup-reserve setpoint, capped at 50 in two independent places: `clampReserveTarget` (`nightChargeActuator.ts`) and `setBackupReserveSoc`'s own range check (`ecoflow/commands.ts`), which refuses out-of-range before any network call. The option's schema is `int(50,100)` — **its minimum equals the write's maximum**, so every legal value produces the identical instruction. Live corroboration: an armed plan carrying `setpointSocPct = 100` produced an actuation `targetPct = 50`, and the 2026-09-03 delivery of 33.25 kWh matches a 16%→50% charge on a ~92 kWh pool. Charge power binds first regardless — a six-hour weeknight tops out near **60% SoC** even with the clamp removed — so 90% is unreachable by two independent limits. Raising the ceiling would need a force-charge write path; `setChannelForceCharge` exists but is only ever called with `on: false`. **Resolved 2026-09-16:** the cloud accepts a setpoint above 50 and the SHP2 settles it at 50 (v1.164.0), so the `[10, 50]` bound is the device's own.
- **★ `bandSigmaCal = 1` was ambiguous across five states** — *new, found and fixed 2026-09-11*. The published shrink multiplier read `1` whether the calibration was **saturated** (active, band too narrow, `Math.min(1, …)` forbidding a widen), **uncalibrated** (never engaged — the v1.23.0 production defect), exactly 1 by coincidence, an operator override of 1, or — in the durable ledger column — simply absent, via an `?? 1` fallback. The prior snapshot inspected this field and checked only the *floor* ambiguity. v1.149.0 publishes `bandSigmaCalBasis` beside it and writes `null` rather than `1` for a missing forecast; `scripts/mutate-band-cal-basis.mjs` holds it with 7 mutants. Full account in §2.
- **~~Delivery over-shoot is real but formally unmeasured~~ — SUPERSEDED 2026-10-15.** On 2026-09-11 every actuated night in the sample had delivered 48–55% more than the sized buy (~+10 kWh), and `buyBiasKwh` read `null` because every night was exempted as a cushion shortfall. Those rows held the legacy delivered estimate (window import minus house load). On the source-charge basis (from 2026-10-01) delivery runs **below** the islanded worst-case buy — median 0.590 over the 8 nights the learner counts, 0.656 over all 20 scored actuated nights since 09-14 re-measured on the same method — largely because the window opens above the plan's islanded start (§3). ★ **Corrected (v1.187.10):** the [0, 5] kWh criterion is the planner's sizing (forecast) error, not delivery; now measurable, it reads +16.17 kWh, an over-buy consistent with the load over-forecast (§2).
- **★ The load over-forecast signature returned** — *closed 2026-09-11, REOPENED 2026-10-15*. The 2026-09-06 reading recorded 19–39 kWh of one-directional load over-forecast on five nights and declined to fit a correction; the 2026-09-11 reading saw four alternating nights and closed the item. Since 2026-09-10 load has been over-forecast on 29 of 33 nights (`loadBias` −0.173 over all algo-v3 nights, −0.233 since 09-10), after a measured step in the house load around 09-14 that the trailing forecast took about three weeks to follow, and the load band (P50 ÷ 1.35 to P50 × 1.35, logged as "±35%") admits only −25.9% on the side where the misses fall (§2). The restraint of 2026-09-06 still stands — no correction is fitted here; the closure of 2026-09-11, drawn from four nights, does not.
- **★★★ A third of the fleet went dark for nine days and nothing said so** — *new, 2026-09-11; partially fixed v1.150.0*. Core 2 recorded **zero samples of every metric from 2026-08-11 to 2026-08-19**. No log line, no alert, no telemetry-gap record. The gap detector sets `sawHomeInsert` on **any** non-bench home SN, so Cores 1 and 3 writing normally reset the fleet clock on every batch and a single-core blackout was invisible to it *by construction*. It surfaced six weeks later only as a second-order effect — fleet PV sums across that window returned **32%** of true production, and the resulting phantom forecast misses closed the night-charge basis gate. v1.150.0 adds a per-device staleness sweep (6 h threshold, one record per blackout, bench spares exempt). **What is still open:** nothing reconciles a dark window against the vendor's own daily totals, which *did* show the disagreement the whole time — `driftSolarPct` read **+47%** through the episode and has **no alert or engine consumer** — it reaches only the vendor-history log line. *(Corrected 2026-10-11: this read "zero consumers anywhere in the codebase"; that log line has read it since v1.82.0.)* ★ *2026-10-15: the opposite failure — an offline Core's last values recorded as fresh samples — is the last item below.*
- **★ The forecast-skill scorer applies TODAY's fleet membership to 30 days of history** — *new, 2026-09-11, DELIBERATELY NOT YET FIXED*. `computeForecastSkill` resolves the roster once at report time (`computeForecastSkill`, `analytics.ts`, via `shp2ConnectedDpuSns`) and applies it retroactively to every hindcast day. Core 3 was a home-pool core through 2026-08-19 with **18.2–22.8 kWh/day sitting in the recorder**, and is excluded from those days purely because it is on the bench *today*. The coverage gate that should have caught the result was disarmed by v1.94.0's `skipBeforeJoin`, which infers *"had not joined yet"* from *"has no recorder rows yet"* — **the identical signal a blackout produces**. This is the same membership-change defect family as the v1.92.0–v1.100.0 cluster, in a new place. It is not fixed in v1.150.0 for a stated reason: correcting it nulls the eight bad days, which reopens the basis gate *and* narrows the published band **3.5×** (`producedHalfFrac` 0.5549 → 0.3998) in one step. The condition self-clears as the block ages out of the 30-day window; the fix belongs after that, measured against a clean baseline, not on top of a live artifact. ★ *The eight affected days left the 30-day window around 2026-09-19 (date arithmetic, not re-measured). The retroactive membership is still in the code — since v1.186.5 the scorer pairs the forecast's solar model with the actual PV of the **current** home Cores — so the next membership change will reproduce the artifact.*
- **★ Robustifying the band quantile would make the gate WORSE, measured** — *new, 2026-09-11*. The obvious response to eight outlier days is a trimmed or median-based estimator. Tested against the live 29 errors with the exact `producedHalfFrac` 0.5549: median → **66%**, 20% trimmed mean → **66%**, median+1.282·MAD → **69%**, P80-of-clean-days → **66%** — every one *below* the current 72%. Coverage does not read the quantile; it counts errors under `producedHalfFrac × bandCal`, and the quantile only sets `bandCal`. A **high** quantile saturates `bandCal` at 1, which makes the threshold as wide as it can be; a smaller quantile floor-pins `bandCal` at 0.4 and collapses the threshold, ejecting two legitimate days. Recorded because the intuition is strong and wrong, and acting on it would have been a regression in a life-safety gate.
- **★ The basis gate is effectively a SATURATION detector, not a coverage test** — *new, 2026-09-11*. Derived and verified: in the `shrunk` regime the threshold equals `realizedHalfFrac = errs[k-1]`, and in `floor-pinned` it exceeds it, so coverage ≥ `k/n` = `ceil(0.8(n+1))/n`, which is **83–86% for every n in [14,30]** — always above the 0.78 bar. The gate can therefore fail **only** when `bandSigmaCalBasis == 'saturated'`. The coverage percentage is downstream of that flag rather than an independent measure of forecast quality, which is what v1.149.0's `bandSigmaCalBasis` makes visible. ★ *Re-measured 2026-10-15: n = 30, k = 25, coverage 25/30 = 83.3% in the `shrunk` regime, exactly k/n (§2).*
- **`chronicNoiseSilenced` (Rule 3) cannot fire for the case it is named for** — *new, 2026-09-11, NOT FIXED BY DESIGN*. The rule exists for *"the condition exists but the user has accepted it … they're not going to do anything"* (the Rule 3 comment in `alertMonitor.ts`, beside `CHRONIC_NOISE_NEVER_CLEAR_FRAC`). Its numerator, `neverClearedCount`, is incremented **only inside `recordClear`** — it counts long-duration **clears**, not long **active** time. A genuinely standing chronic alert therefore has `riseCount` 1 and `neverClearedCount` 0, ratio **0.0**, and also fails the `riseCount >= 10` floor: **the longer the condition actually stands, the further it is from firing.** Across all 52 live families no non-exempt family with `riseCount >= 10` exceeds **0.0897**, so Rule 3 has fired zero times. The threshold is *not* unreachable — `shp2-below-reserve` reads 0.5909 right now and is spared only by the `ENERGY_STATE_FAMILIES` exemption — so lowering 0.5 would not help. **Deliberately left unfixed:** repairing Rule 3 makes an alarm-**suppression** rule fire *more*, which is the unsafe direction on a life-safety path. Whether to silence standing chronic alerts is a policy decision, not a maintenance one.
- **Cost mode is rate-blind** — *new*. `costModeTargetKwh` reads no tariff. "Cost" means *fill further*, on the premise that overnight energy is the cheapest the day offers; it does not optimise against the rate table. The tariff model informs the *window*, not the *target*.
- **The comfortable-hold case is rare on this plant** — *measured 2026-09-06*. The no-shortfall hold returns before `ARB_OBJECTIVE` is read, so on a night whose trough already clears floor+cushion the objective has no effect. Over the trailing seven ledger rows exactly **one** held, and it held because a one-hour Friday window could not serve the requirement — not because the night was comfortable. Moving the objective check earlier would therefore address a near-empty population; the reorder was investigated on 2026-09-06 and **not shipped** for that reason (★ **superseded v1.174.0:** it has since shipped — cost mode is now asked before the no-shortfall hold, which returns early only in `resilience` mode; reference chapter 15, [8b. Supervised write mode](reference/15-2-night-charge-writes.md#8b-supervised-write-mode-nightchargeactuatorts-v1500)). `actual_onpeak_import_kwh` is **0 on every scored night**, so the on-peak displacement value that would justify it is also absent. ★ **Qualified (v1.187.0):** that column was measured on the pre-v1.187.0 **plan-day anchor** — each weekday row integrated the 16:00–19:00 *before* its own ~21:30 plan existed (the previous night's outcome), and Saturday/Sunday rows counted off-peak afternoons as zeros — so it never measured the on-peak each plan governed (Monday 2026-09-28 imported 4.27 kWh on-peak). It is not evidence that governed on-peak import is zero; the corrected measure is the rows with `onpeak_basis = 'governed'` (reference chapter 15, [6. The learning ledger](reference/15-1-night-charge-planning.md#6-the-learning-ledger-night_charge_ledger-recorderts-v1380)). *On 2026-10-15 those rows read 0 kWh on all 10 (2026-09-29 → 10-13).*
- **★★ An offline Core's last values are recorded as fresh samples** — *new, 2026-10-15; fixed in v1.188.1, deployed 2026-10-18*. The EcoFlow cloud marked all five Cores offline at 10-15 01:55, after a name-resolution outage. From 02:00 to the 17:56 fetch the recorder wrote 14,742 rows across 78 home-Core metrics and not one metric took a second value: the Cores' SoC read a constant 79 / 72 / 74% while the SHP2 reported 58–100% for the same three sources, and PV read 0 W all day (194 samples per Core, one distinct value) on a day the pool charged from 60% to 95.7% between 07:00 and 15:00. The SHP2's own series were held the same way from 01:55 until it returned at 04:16. The likely path is the recorder's 5-min heartbeat (`MAX_INTERVAL_MS`), which re-writes each metric's last value while other devices keep the store changing. Nothing flagged it: `/api/telemetry-gaps` shows `device_gap_count` 0 — the per-device sweep keys on the last insert, which keeps arriving — and `/api/forecast` and `/api/self-consumption` show only `homeDpusReporting` 0 and partial coverage. *Projected, not measured:* the 10-14 ledger row captures after 10-15 21:30. Its grid coverage over the charge window is final at 0.64 (46 of 72 buckets), under the 0.9 gate, so it captures unscored with `buy_err_kwh` NULL, and neither the under-buy rate nor the sizing bias can see it. The PV columns are written whether or not a row is scored, and the readiness gate's forecast pool takes every captured forecast-tier row. The per-Core PV coverage gate, built on sample timestamps, is borderline: at 19:32 each Core had 238 of 265 elapsed buckets, and passing needs 260 of 288, at most one more missed. If it passes, the row records PV ≈ 0 kWh against a P50 of 53.43 kWh, `pv_err_frac` ≈ −1.0 and `pv_in_band` 0, and enters `pvMae`, `pvBias` and `pvBandCoverage` in a ledger that is never pruned; if it misses, the PV columns are NULL. The skill scorer drops days with ≤ 0.5 kWh actual, so a fully zero 10-15 stays out of the band calibration's scored days (not out of the 30-day solar-response fit they are hindcast with, §2); a partially held day would not. It is the same evidence-contamination class as the nine-day Core 2 blackout above, in the opposite form: there the rows stopped, here they keep arriving. v1.188.1 (deployed 2026-10-18 02:11) fixed it. The recorder writes a device's readings only while they are fresh, so a held projection no longer reaches `samples`. Its first scan moved the rows already written, 241,447 across six frozen stretches (the five Cores and the panel from 10-15 01:55, and one August stretch of Core 2), to `held_samples` in 196 s; none were deleted. The night ledger then reset the 10-14 and 10-15 rows for re-capture and withheld their PV actuals as held telemetry.

---

## 7. Build, test and mutation-harness cost (measured 2026-10-15; earlier readings 2026-10-10 → 10-11)

These are developer-side measurements. The 2026-10-15 figures are runs at 111247f (v1.188.0)
on an Apple M5 Mac with 10 cores and 32 GB under Node 26.0.0; the earlier rows come from the
release-gate runs for v1.187.14 to v1.187.16 and from the 2026-10-10 harness conversion (PR #509),
on a 10-core Apple-silicon Mac with 32 GB. They are not runtime figures and say nothing about the
Pi. Background load was not controlled on 2026-10-15: real-time malware scanning was on and
Spotlight was indexing the new worktree, together using 78–247 CPU-seconds during a suite run.
The quietest run is therefore the like-for-like figure, and a change against the earlier rows
mixes code growth with machine state.

### 7.1 The server test suite

| Gate | Node | Tests | Result | Wall time |
|---|---|---|---|---|
| v1.188.0 (2026-10-15, three `npm test` runs) | 26.0.0 | 4,555 | 4,555 pass, 0 fail | **80.2 s** quietest (85.1, 94.3) |
| v1.187.16 | 26.0.0 | 4,115 | 4,115 pass, 0 fail | **72.5 s** |
| v1.187.15 | 26.0.0 | 4,114 | 4,114 pass, 0 fail | **72.7 s** |
| v1.187.15 | 22 | 4,114 | 4,114 pass, 0 fail | **71.2 s** |
| v1.187.14 | 26.0.0 | 4,108 | 4,108 pass, 0 fail | 85.7 s |

`npm test` runs `node --import tsx --test` over the test files (418 at v1.188.0, 382 at
v1.187.16, 381 at v1.187.15), which Node runs concurrently. All eight measurement runs at
111247f (17:56–18:30) — three canonical, five with a reporter or a timing preload — passed 4,555
with 0 failures, in 79.4–94.5 s (median 85.0 s). Four later full runs the same day, on the same
code with only this document changed, were not all green: the first two took 192.9 s and
198.1 s, more than twice the earlier wall time, and each failed one real-timer test —
`bootSequencing` ("a cloud outage at boot does not hold the alarms") and `conditionRetryWords`
(a retry's failed spoken render against a pending alarm retry) — and the next two passed in 86.4 s
and 82.0 s. Both files passed when run together on their own (41 of 41, 38.6 s). This is the
timing failure under load that §7.2's baseline rule exists to catch. Against v1.187.16 that is +440 tests (+10.7%), +36 files and +7.7 s
(+11%) on the quietest canonical run. Summed per-test time in that run is **341.4 s**, about 4.3×
overlap (256.5 s and 3.6× in the v1.187.15 Node 22 run), and the time is still concentrated:
**106 tests of 4,555 take ≥ 1 s and account for 218.2 s (63.9%)**, against 79 tests and 161.9 s
(63%) before. The slowest single test still takes 8.5 s (`restartRecoverySettledSet`, "a feed
that lands after the green began"). The ≥ 1-s time sits in the condition-retry, restart-recovery
and broadcast test files, which wait out real timers, and in the release-script tests that start
git or python subprocesses (`releasePrCheck`, `tagRelease*`, `docsLayout`), which slow down most
under background load. The same suite runs in CI on Node 22, and again at the tag before an image
is built; CI durations are not measured here.

★ **One file sets the suite's wall time.** A preload stamped each test process's start and exit
on a clock the tests' mocked timers cannot fake. `node:test` starts files in strict alphabetical
order, nine at a time. `restartRecoveryAllClear.test.ts` — 72 tests run one after another in one
process — is file 326 of 418: it starts at 25.1 s, runs for 54.4 s and exits at 79.4 s, the end
of the suite. The other 417 files have all exited by 46.3 s, so for the last 33 s (about 42% of
the wall time) that one process is the only thing running. The file has not changed since
2026-10-06; at v1.187.16 302 files ran ahead of it and now 325 do, so it starts later as the
suite grows. Listing it first on the command line changes nothing, because `node:test` sorts
the list (wall time 84.6 s in that run). What splitting or renaming it would save is not measured.

### 7.2 The mutation harnesses

At v1.188.0, **107 harnesses** (`scripts/mutate-*.mjs`) hold **2,529 anchor-asserted
mutants**, every one of which `scripts/check-mutant-anchors.mjs` resolves in CI (0.38 s; 0
skipped, 0 dead). At v1.187.15 the checker resolved `.ts`/`.tsx`/`.mjs`/`.js`/`.yml` targets
only, so it reported `scripts/mutate-v1187-15.mjs` (4 mutants against `ecoflow_panel/apparmor.txt`)
as "no resolvable target" and checked none of its anchors; v1.187.16 added `.txt`. By tag (the
checker's own pattern over each tag's tree; only the v1.188.0 count went through the checker):

| Tag | Harnesses | Anchors |
|---|---|---|
| v1.187.16 | 91 | 1,867 |
| v1.187.19 | 96 | 2,021 |
| v1.187.21 | 101 | 2,145 |
| v1.187.23 | 106 | 2,435 |
| v1.188.0 | 107 | 2,529 |

The 16 new harnesses add 671 anchors and the older ones lost 9 net: `mutate-v1187-a` went from
66 to 56 when its mutants xxx–xxxix (the peer top-of-charge gate) were retired at v1.187.21, where
`mutate-v1187-21` replaces them. Options in use at v1.188.0: `fullSuite: false` in 19 harnesses,
`typecheck: true` in 13, `perMutantTests` in 2.

**The runner.** Since PR #509 (2026-10-10) every harness — 107 of 107 at v1.188.0 — runs through
`scripts/lib/mutateParallel.mjs`:

- Each worker owns a private copy of the repository (`rsync`, `node_modules`
  symlinked), so mutants run side by side and the real working tree is never
  written. A harness used to edit the shared tree one mutant at a time.
- The verdict procedure is unchanged — each mutant runs the harness's subset, and the
  full suite on a subset pass — only the scheduling changed.
- The unmutated baseline runs in **every** worker at once, under the load the mutants
  will see. A timing-sensitive test that fails under that load would otherwise count
  as a free kill and hide a survivor, so any baseline failure aborts the harness.
- Default workers: **cores − 2** (`MUTATE_CONCURRENCY` overrides). A harness can cap
  its own count; only `mutate-v1187-3h.mjs` does, at **6**.

**Why cores − 2.** In the first full run, at one worker per core (10), the baselines of
three harnesses failed under load — `v1187-3h` in 3 of 10 workers, `v1187-4` and
`v1187-b` in 1 of 10 each — and all three aborted rather than report. At 8 workers
`v1187-4` and `v1187-b` pass; `v1187-3h` needed 6.

**Measured times, 2026-10-15** (wall time includes building the worker copies, the unmutated
typecheck where set, and the baselines; the two large runs went back to back beside about 1.9
cores of background scanning, with a load average of 17–20 during `v1188-0`, so both are upper
bounds):

| Harness | Mutants | Workers | Result | Mutant phase | Wall |
|---|---|---|---|---|---|
| `v1187-21` | 6 | 4 | 6/6 killed | 12 s | 21.1 s |
| `v1188-0` | 94 | 8 (default) | 94/94 killed | 395 s | 433.9 s — about 33.6 worker-seconds per mutant |
| `absence-evidence` | 18 | 10 | 18/18 killed | 356 s | 365.2 s — 251 s on 2026-10-10 (+45%) |

`absence-evidence` and its subset files are unchanged since 2026-10-10. A mutant that survives
its subset goes on to the full suite, which has grown 10.7% since; counts of the temporary
directories the tests left behind suggest 4 of its 18 mutants did (an inference, not harness
output).

**Measured times, 2026-10-10** (same definition of wall time):

| Harness | Mutants | Workers | Time |
|---|---|---|---|
| `v1187-3h` | 99 | serial (old runner) → 6 | over 3 h → **~23 min** |
| `v1187-c` — the longest | 41 | 10 | 1,518 s mutant phase, **30.4 min** wall |
| `v1187-4` | 67 | 8 | 619 s mutant phase (~11 min wall) |
| `v1187-10-g2` | 40 | 10 | 445 s wall |
| `v1187-d` | 61 | 10 | 412 s wall (62 s of it the mutant phase; the rest is setup and the baselines) |
| `v1187-5` | 62 | 10 | 377 s wall |
| `v1187-b` | 52 | 8 | 265 s mutant phase (~5 min wall) |
| `absence-evidence` | 18 | 10 | 251 s wall |

**One full sweep** — 87 harnesses run back to back on 2026-10-10, each at up to 10
workers — took **5,964 s (99 min)** of wall time, 30 min of it `v1187-c`. It killed every
mutant except one declared known survivor (`mutate-rate-table` v) and one mutant that
had become equivalent (`mutate-analytics-worker` xi, §5 2026-10-10), and aborted the three
harnesses above on their load baselines; those three then passed at 8 and 6 workers. The sweep
was not re-run on 2026-10-15, so the 99-minute figure is not re-measured for 107 harnesses.

★ **A harness result is still meaningless against a red tree**, and the parallel
runner keeps that rule mechanically: a failing baseline aborts the harness instead of
crediting every mutant as killed.
