> [!NOTE]
> Historical, and frozen: section 4a of the performance record, the runway replay backtest of
> 2026-10-11 and its live check of 2026-10-15, moved here unedited on 2026-11-09 to keep
> `docs/PERFORMANCE.md` under its size limit. A later release may have superseded what it says;
> the [current record](../PERFORMANCE.md) keeps a summary. This file is not part of the printable
> manual.

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
at √0.86 = 0.927, below all 29 spans. Since v1.202.0 the night-charge planner's walks are on the measured capacity too and drain the 270 W overhead wherever the grid is not charging the pool, the load still at `load/0.94` (its line moved there in v1.199.0, its cushion's hours counted the overhead in v1.201.0) (reference chapter 5, [1.3a The measured energy basis](reference/05-runway-and-soc-alarms.md#13a-the-measured-energy-basis-v118719)).

### Live check on three nights (measured 2026-10-15)

The live model (`/api/runway` on v1.188.0, unchanged since v1.187.19: `backupFullKwh` 86.99, `capacityScale` 0.944, `overheadW` 270) against the three pack-only spans the recorder holds since 10-12, selected by the same rule as the 30 spans above; `grid_home_w` read 0 W in every row of all three. Method A is the per-source step-pinning above, so its error is step timing only (±0.3–0.7 % per night); method C step-pins Home Assistant's integer pool reading instead.

| Span (MST) | Hours | Load kW | Model / measured (A) | Implied overhead | Runway-hours error | Method C |
|---|---|---|---|---|---|---|
| 10-12 17:23 → 10-13 06:39 (reserve 16% all night) | 12.95 | 1.98 | 0.985 | 306 W | +1.5 % | 0.983 |
| 10-13 17:30 → 23:00 (ends at the night-charge write) | 5.08 | 2.16 | 0.975 | 336 W | +2.6 % | 0.983 |
| 10-14 17:32 → 23:54 (ends at a telemetry loss) | 5.69 | 1.91 | 1.002 | 266 W | −0.2 % | 1.004 |

Hours are method A's mean step window. Pooled, the model gives 56.96 kWh against 57.74 measured, **0.986**, and every night is inside the ±3 % backtest gate; the 10-14 span cut at 23:00, before its reserve write, reads 0.998 at 1.87 kW. The implied overhead averages 303 W (266–336) against the 270-W constant and the 267-W fit above (residual sd 40 W). Without the overhead term the same nights read 0.873 / 0.872 / 0.884, and the old basis (nameplate, `load/0.94`) would have overstated the hours by +21.3 / +21.5 / +19.8 % — consistent with the backtest's trend at about 2 kW. Home Assistant's integer endpoints (method B) carry ±1 % of the pool per night (±0.87 kWh) and read 0.989, 0.988 and 1.020 with bounds of 0.93–1.09, which is why the step-pinned figures are the primary ones. A shorter span after the SHP2 returned on 10-15 (04:17 → 06:25, under 3.5 h, the Cores' side unverifiable) reads 0.989 (A) at 1.10 kW, the lowest load yet replayed, with an implied overhead of 286 W. The Cores' recorder data after 10-15 01:55 are held values (§6) and are excluded.
