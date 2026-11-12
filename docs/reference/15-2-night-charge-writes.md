### 8. The write-readiness gate (`computeNightChargeReadiness`, `nightChargeGate.ts:217`)

A pure reduction over the ledger (no I/O, `nowMs` injected) into one of three states — `LEARNING` / `READY_TO_CONSIDER_WRITES` / `BLOCKED` — plus `writeReady` and a human-readable `blocking[]` list. It gates **only on physically-measured prediction accuracy**: there is deliberately *no* savings term (no valid counterfactual exists pre-write, so a savings gate would certify a number the system cannot observe). Recomputed over `readNightLedger(400)` on every tick, evening job, and warm-up.

**Thresholds are pre-registered and frozen** — never tuned on the season they gate (garden-of-forking-paths); a re-tune bumps `CURRENT_ALGO_VERSION` (currently **3**: v1.105.0 redefined `buy_err_kwh` onto the planner-sizing basis, so v2 rows' values are not comparable and are excluded, resetting the evidence clock; v2 was the v1.49.0 charge-only-cap sizing correction, which invalidated every v1 row) and resets the readiness clock. A planner physics change that leaves every scored column's formula and sign as they were keeps the version — the v1.125.0 cushion, the v1.187.22 expected-buy walks, R2, v1.194.0's charge leg and v1.199.0's cushion line on the packs' measured capacity all kept 3. Rows are filtered to the current algo version by **string** comparison (`recordNightPlan` persists `algo_version` as SQLite TEXT; a numeric compare never matched a real row and left the gate permanently stuck). Prior-version rows are *excluded*, not tagged.

**The v2 evidence base is ACTUATED nights** (v1.50.0). The v1 gate scored a night only on a "clean islanded baseline" (near-zero window import) — on a grid-tied home the SHP2 carries the house on grid at the floor and imports every night, so `scoredDays` was structurally 0 and the gate could never open. v2 splits the evidence into two pools:

- **Actuated pool** — current-algo rows with `actuated=1` ∧ `scored=1` (a bounded reserve write was applied, §8b, and its delivery measured, §7). Feeds the under-buy rate, the sizing bias, and the graduation night count.
- **Forecast pool** — current-algo, outcome-captured, `confidence_tier='forecast'` rows. Feeds PV/load accuracy and band coverage (those columns are recorded on every captured night regardless of the realized-need `scored` flag). v1.187.0: the PV figures (`pvMae`, `pvBias`, `pvBandCoverage`, the effective-N residual series) and the verdict-bearing sample (`coverageNights`, the informational joint) read only rows whose `pv_verdict_set_aside` is NULL — a band built for other Cores than the actuals is not forecast-skill evidence (§6 "PV EVIDENCE"). Such rows are counted in `pvVerdictsSetAside`; the load figures are unaffected. **An incomplete-basis night is not set aside for that alone**: a plan refused for a lasting forecast failure (2026-09-11: "PV band coverage 72% < 78%") is exactly the evidence this gate grades, and dropping those nights would raise PV coverage by survivorship. On the 2026-09-29 ledger the one set-aside row moves PV coverage 33/36 (0.917) to 32/35 (0.914) and `coverageNights` 36 to 35; no verdict changes.
- **★★★ v1.204.0 — rows on the panel's own readings are kept apart** (`panelApart`): a row whose `pv_basis` is `panel` or `mixed`, or whose `actual_pv_basis` names a panel slot, is out of the actuated pool (so out of the under-buy rate, the sizing bias and the graduation count) and out of the PV statistics, whatever its tag. Its PV verdict is set aside first (`pvVerdictSetAside`'s panel rule, counted in `pvVerdictsSetAside`). Why apart, by failure direction: a high reading raises the actual, lowers the realized need and hides an under-buy, moving every PV criterion toward graduating, and no independent meter vouches for it while the Cores are dark. Its strikes still count (the realized cushion verdict reads the pool only), and a panel night does not count toward the strike-free streak that clears one. Counted as `panelApartNights`; `panelBasisUnderBuyNights` publishes those whose `buy_err_kwh` reads an under-buy of more than 0.5 kWh (a diagnostic: it decides nothing). `CURRENT_ALGO_VERSION` stays 3. No write effect today: `auto` runs as `supervised` while the gate is not ready.

**HARD failures ⇒ `BLOCKED`** (evaluated first):

| Gate | Rule |
|---|---|
| Engine-fault strikes | A strike requires the plan to have **claimed hold** (`cushion_shortfall` falsy — a NULL/legacy row still counts as claimed, fail-closed) AND either the plan's own simulated trajectory breached floor+cushion (forecast-tier rows, §3.3) or an actuated night's **realized** outcome breached (`cushion_breached`, any tier — a delivered buy that still breached is fault evidence regardless of forecast basis). **v1.196.0 — the realized outcome is graded on the claim the plan made** (`realizedCushionBreach`, `nightChargeGate.ts`). On an overnight row whose recorded line (`cushion_line_soc_pct`) is not the legacy band, which covers the islanded-outage and disabled bases, the plan claims only that the pack at the window close holds that line. The verdict there is the pool measured at the close (`window_close_soc_pct`: the median `backup_pct` over the window's last 15 minutes) under the line, less 0.05 points (half the reading's 0.1 step). A row without the reading (captured before v1.196.0, or with no reading in those minutes) is clean when its lowest pool after the close holds the line, because that span starts at the close. Otherwise the verdict is unknown, and the gate keeps the stored flag (fail-closed). The gate derives the verdict again from the columns, and counts the stored flags it overrules in `realizedStrikesSetAside`. A night whose line is above the panel's 50% reserve maximum read as breached until v1.200.0, the plan claiming a cushion the 50% write could not reach (4 of 199 islanded evening charges on nameplate, 6 of 212 at 0.944; `measuredCushionLine.test.ts`). Since v1.200.0 every such charge plan is carried by the night force-charge (`cushion_line_force_charge_pct`; where its sizing held, a close under the line is a strike) or disclosed (`cushion_envelope_shortfall` = 1); a row with `cushion_shortfall` = 1 is exempt unless its armed force-charge never switched on and it closed under: "The outage line above the reserve envelope", below. The legacy band, a mid-day two-leg row and a row without its line keep the lowest pool over the scored span against `reserve_floor_pct + cushion_pct`. Before v1.196.0 every row was graded that way: after the close, with the reserve back at the floor. The 50% write masked the mismatch until v1.196.0 wrote the line itself. On the 2026-10-12 fixture a resilience night then writes 32% for a 31.13% line, with a P50 morning low of about 23.6% against 16 + 15 = 31. With a 2.0 kW island the write is 28%, already under 31% at the close. Every actuated resilience night would have been a strike, and the gate would have stayed `BLOCKED`. A plan that honestly disclosed `cushionShortfall` is physics, not fault — exempt. Strikes count within a rolling `STRIKE_WINDOW_DAYS = 45` window and clear after `STRIKE_CLEAR_STREAK = 14` consecutive strike-free actuated nights — escapable by demonstrated performance, never by waiting alone. |
| `buy_err_kwh` basis | **v1.105.0 (algo v3)** — the PLANNER-SIZING basis: `buy_err = planBuy − (planBuy + netMiss/legEff) = −netMiss/legEff`, where `netMiss = (forecastPv − actualPv) + (actualLoad − forecastLoad)`. It answers exactly one question — *did the planner size the buy correctly?* — and contains no delivered term, no trough and no reserve setpoint. The prior definition was `planBuy − (delivered + troughDeficit)`, the difference of two questions: it counted the actuator's by-design over-delivery (29-41 kWh against 21-22 kWh plans) as under-buy, and anchored on a 16 h post-window trough that is really the reverted `backupReserveSoc` (a fixed −14.9 kWh at a 10 % trough). Across four live nights that was −62.13 kWh of residual, 52 % over-delivery / 48 % trough, producing a 56 % under-buy rate no forecast change could move. Actuated and advisory nights share the basis — one column, one meaning. Delivery quality is a separate question. **v1.194.0:** the formula is unchanged, but the planner now stores a surplus hour's whole net, `pv − load/dischargeEff`, at `legEff`, so a miss inside a surplus hour, solar or load, reads `1/legEff` (about 7.8 %) larger against the planner's own re-sizing than it did before, in both directions. A PV miss there moves the planner's buy by 1 kWh per kWh missed while the column converts it at `1/legEff`: `buy_err_kwh` reads it 7.8 % larger (it read it exactly). A load miss there moves the buy by `1/dischargeEff` per kWh: the column reads it about 1.4 % larger (it read it about 6 % smaller). A cloudier day or a heavier daytime house than forecast scores a deeper under-buy than before, so the under-buy rate errs toward blocking; a sunnier or lighter one a larger over-buy. Only misses in deficit hours read as before: a PV miss exactly, a load miss about 6 % small. |
| Under-buy rate | With ≥ `MIN_NIGHTS_TO_JUDGE_UNDERBUY = 5` actuated nights: fraction of `buy_err_kwh < −UNDERBUY_DEADBAND_KWH` (0.5, **v1.105.0** — an untoleranced `< 0` scored a −0.01 kWh rounding residual as a life-safety miss) must be ≤ `MAX_UNDERBUY_RATE = 0.10` (under-buy is the asymmetric safety miss). Below 5 nights this is still LEARNING, not BLOCKED. **v1.104.0** — the pool EXCLUDES nights whose plan disclosed a cushion shortfall (`cushion_shortfall`), matching the exemption the strike rule already applies ("disclosed — physics, not fault"): a plan that declared up front it could not meet the cushion, because charge and pool caps prevent it, is not evidence that the engine under-bought. `underBuyExcluded` reports how many were dropped. Removing bad evidence leaves NO evidence, so the rate becomes null and the state falls to LEARNING — fail-closed, never READY. (The hybrid-residual limitation recorded here before algo v3 — delivered energy added back into realized need, a trough anchored on the reverted setpoint — was removed by v1.105.0; see the basis row above.) |

**Graduation criteria** (adopted 2026-07-31) — *any* unmet or uncomputable metric ⇒ fail-closed `LEARNING` (design I13; missing/thin/young data is never null-as-ready):

| Metric | Threshold | Constant |
|---|---|---|
| Scored actuated nights | ≥ 21 | `MIN_ACTUATED_NIGHTS = 21` |
| Under-buy rate (actuated pool) | ≤ 0.10 | `MAX_UNDERBUY_RATE` |
| Signed sizing bias (mean `buy_err_kwh`, actuated pool — the P50 PV/load forecast miss in kWh; delivered energy is not part of it) | in `[0, 5]` kWh | `BUY_BIAS_MIN_KWH = 0`, `BUY_BIAS_MAX_KWH = 5` — never net under, never gross over. v1.187.10: the blocker reads "sizing bias … (mean buy_err_kwh: the P50 PV/load forecast miss in kWh; delivered energy is not part of it)"; it read "delivery bias", which pointed at the actuator when the live 22.27 kWh was load over-forecast |
| Realized band coverage — **v1.106.0: PER MARGINAL** (`pvBandCoverage`, `loadBandCoverage`), each in `[P10,P90]`, forecast pool | each in `[0.78, 0.92]` over ≥ 14 verdict-bearing nights | `BAND_COVERAGE_MIN/MAX`, `MIN_COVERAGE_NIGHTS = 14` — too high means the band is uselessly wide, too low means unsafe. Previously the **AND** of the two was graded against this marginal target: for two independent 80 %-calibrated marginals the joint is 0.64 and the Fréchet bounds put it in `[0.60, 0.80]`, so the upper half of the target was UNREACHABLE by construction and a perfectly calibrated pair could never pass. It also hid WHICH input was broken — the live joint read 9.5 % while the marginals were PV 57 % / load 14 %. The joint is retained as an informational figure only, and the blocking line names both marginals. |
| Load band construction — **v1.106.0** | `calibratedLoadBandFactor`: nearest-rank 80th percentile of realized \|`load_err_frac`\|, FLOORED at the historical hand-set 1.15 and capped (default 2.0) | The band was `P50 ÷ 1.15` / `P50 × 1.15` — a fixed ±15 % sizing multiplier that nothing estimated from data, yet named P10/P90 and graded as a calibrated 80 % interval; it contained the actual **14 %** of the time. The floor makes the change monotone: it can only WIDEN. Only `loadP90W` feeds sizing (the projected drain), so a wider band buys more — the safe direction for an asymmetric under-buy miss. Below 10 samples it returns the floor with `basis: 'default'` rather than calibrating on noise. |
| Zero engine-fault strikes | active (uncleared, in-window) strikes = 0 | `STRIKE_WINDOW_DAYS`, `STRIKE_CLEAR_STREAK` |

PV/load MAE and signed bias, the autocorrelation-adjusted effective N, and the MNAR exclusion fraction remain computed and published as diagnostics (same definitions as v1) but no longer gate — the five criteria above are the graduation contract. Accuracy remains **normalized MAE + a separate signed bias, deliberately not r²**: r² is variance-driven and inflated by monsoon swings — a +15–20% biased-but-correlated forecast passes r² ≥ 0.80 yet mis-sizes the buy.

**Effective N** (`effectiveSampleSize`, `nightChargeGate.ts:172`): `n·(1−r₁)/(1+r₁)` with lag-1 autocorrelation `r₁` computed over the PV residual series (fallback: load residuals, then the raw count), clamped to `[0, 0.99]` — a cloudy stretch is several *correlated* bad nights, so raw count over-counts evidence; negative autocorrelation is clamped to 0 so it can only ever reduce, never inflate.

**The MNAR denominator is *expected* nights, not captured rows** (v1.39.0): nights that never produced a ledger row at all — add-on down at the evening job, SHP2 cloud-offline, the documented *adverse* failure modes — must count as exclusions; keying the fraction on captured rows let exactly those nights vanish from both numerator and denominator. Expected range = every site-time calendar date from the first current-algo plan (bounded to a trailing 120 days) through the most recent *completed* night — the site date of `now − 45 h` on the preset (plan `D` completes at `D+1 21:00`; another plan passes its schedule's completion, `completeAfterMs`). `exclusionFrac = max(0, expected − distinct scored plan-dates in range)/expected`. Site dates (`siteYmd`) are built from `en-US` `formatToParts` (v1.39.1) — the `en-CA` `format()` shortcut silently falls back to a non-ISO shape on a small-ICU Node, cascading into a swallowed throw and a permanently-null readiness.

`nightChargeGateFields` flattens the result for the state payloads; on a null readiness it emits `night_charge_readiness: 'unknown'`, **`night_charge_write_ready` strictly `false`**, and every diagnostic null. v2 note: `night_charge_plan_nights_scored` counts scored **actuated** nights.

---

### 8b. Supervised write mode (`nightChargeActuator.ts`, v1.50.0)

When `NIGHT_CHARGE_MODE` is `supervised` (or `auto`), each charge night runs one bounded, announced, cancellable, auto-reverting reserve write. The decision core is pure (`decideActuation` — all clocks injected, unit-tested against every guard); the integrator executes decisions through the audited write helper and persists every transition to a restart-surviving state file (`.night-charge-actuation.json`, atomic write, in-memory mirror).

**The nightly flow:**

1. **Announce + arm (~21:30, inside the evening job).** When the recorded plan is a charge with a complete basis, a resolved window, and a positive buy, the actuation candidate is computed **from the announced plan** — a fresher recompute never silently substitutes a different buy, because the owner's cancel window runs against the announced numbers. The evening notification names the write, the clamped target, and the cancel deadline; the audible broadcast channel announces the same (no phone-push dependency). The armed state **persists only after at least one announcement channel confirms delivery** (`NOTIFY_CHANNEL` other than `none`, or a successful audible announce) — a write the owner never heard about cannot fire; an undelivered night stays advisory and logs at error level, and (v1.187.22) the evening job records it like a refused arm ("the announcement could not be delivered", `eveningNotArmedReason`) so the card leads with "Planned charge not armed tonight — the announcement could not be delivered." — unless the record left in place is an arm for the same window that will still write (Saturday's arm for the Monday window Saturday and Sunday share). Since v1.187.22 the arm also stamps whether force-charge rides the night (`forceChargeRides`: force-charge enabled and the armed ceiling above the reserve maximum — the evening push's condition, and the gate the plan's expected figure was made with); the evening push names the force-charge from that stamp, and the morning push reads it back. The arm also stamps the start of the on-peak period that follows the window open (`nextOnPeakStartMs`, from `chargeWindows.nextOnPeakStartMs` on the same tariff model the window comes from), the anchor of the on-peak guard (item 3). A cushion-only plan (v1.203.0, part 1) arms as any charge, with no cost ceiling but a cost-mode long-gap night's. Arming is refused while a prior night is unresolved (applied-unreverted, or an unconfirmed attempt not provably un-applied — a raised reserve is never orphaned or buried); a night whose reserve settled as someone else's (the foreign rule, item 3) is resolved.
2. **Apply (at the window open, tolerance +30 min).** v1.187.0: `APPLY_LEAD_MS` is 0 (it was 5 min). The reserve raise is a grid charge the moment it exceeds the pool, and the panel takes the write within seconds (2026-09-28: 1.12 kWh at the off-peak rate before the 23:00 overnight rate). The write moment is also the announced cancel deadline, so the owner's cancel window now runs to the window open. Force-charge keeps its order (reserve applied → readback-verified → ceiling synced → ON, never before the window opens); its ceiling sync already waited for the open, so it follows the verified reserve one tick (~1 min) later than before. The attempt is a **write-ahead intent**: the state file records the attempt and its pre-write baseline BEFORE the device call. One write raises `backupReserveSoc` to the plan's setpoint (a line's whole percent and the panel's point since v1.203.0, part 1) rounded into `[10, 50]` (`clampReserveTarget(setpointSocPct)`; `RESERVE_WRITE_MAX_PCT` = 50, the SHP2's own reserve ceiling — proven on the device 2026-09-16, v1.164.0) — validated (not silently clamped) into the `[10, 50]` write envelope by `setBackupReserveSoc` (`ecoflow/commands.ts`), which imports the bound from `nightChargeActuator.ts` so there is exactly one definition, the same documented `PD303_APP_SET` shape the cloud-presence refresh has round-tripped since v0.9.10, audit-logged under `night-charge-reserve` with a 5-min retry cooldown. Every apply guard fails closed: advisory mode, a cancelled night, red host vitals (`vitalsRed`: this add-on's own process struggling, not an alert condition), an incoherent SoC read (I11), an unknown/out-of-range current reserve, a missed window, the on-peak guard (from `ON_PEAK_RAISE_GUARD_MS`, 60 min, before the stamped on-peak start: `onPeakGuardActive`), or a target at/below the current reserve ⇒ no write. The apply's re-issues stop the same way: none within `APPLY_VERIFY_AFTER_MS` of `writeWindowEndMs`, the window close or the guard, whichever is sooner. The row is stamped `actuated=1` at write time. **Lost-confirmation adoption:** when an attempted write reports failure but the live reserve later reads back exactly the attempted target (≠ the attempt baseline), the write is proven applied — the actuator adopts it (applied state stamped from the attempt baseline) and the normal auto-revert takes over. **Device-ceiling adoption (v1.161.0):** when the reserve reads back *between* the attempt baseline and the target and still does after `APPLY_VERIFY_AFTER_MS`, the panel took the write but settled short — of its own accord, or because the owner moved the slider. That is a real partial actuation, so `deviceCeilingPct` adopts the achieved value AS `targetPct` (the original ask is preserved in `requestedPct`) and stamps the apply verified. Without it a short readback is indistinguishable from the 2026-08-16 phantom: both retries burn and the night ends on `applyFailed`, which pages "tonight's buy is forfeited" and corrects the ledger to `actuated:0` — while the reserve is genuinely raised and the buy is genuinely happening. A reserve that did **not** move still takes the phantom path, unchanged.

   **v1.79.0 — apply readback:** the actuator no longer treats a cloud ACK as an
   actuation. An applied night carries `applyVerifiedAtMs` (device readback matched
   the target), up to 2 re-issues on readback failure (5-min windows, never into a
   closing charge window), and a once-per-night operator warning + `actuated: 0`
   ledger correction on exhaustion. Grid loss during an applied window reverts
   immediately (`gridLossAbort`). v1.187.22: that warning (`buildNightChargeApplyFailure`) and
   the info push sent when an applied night's reserve is restored
   (`buildNightChargeMorningSummary`) state the expected figure read back from the armed day's
   ledger row (`expected_buy_kwh`, `ledgerExpectedBuyKwh`) — "(~34.9 kWh expected)" — or, a row
   with none, no kWh at all. The morning push states what the force-charge did, from the
   actuation record (`forceChargeNightOutcome`): "reserve raised to 50%, and force-charge ran
   toward ~80% (~34.9 kWh expected); the reserve is restored to 16%" when a readback proved the
   ON (`forceChargeOnVerifiedAtMs`, a late apply included); "force-charge toward ~80% was switched
   ON but did not take effect" (`forceChargeOnFailedAtMs`) — or, when the failure covered only
   some of our slots (`forceChargeOnFailedSlots`, the slots the ON-failure warning named, fewer
   than `forceChargeSlots`; `partialForceChargeOnFailureSlots`), "… was switched ON but did not
   take effect on slot(s) 2 (the buy above the reserve did not happen on those slot(s))", as the
   warning said "on those slot(s)"; "… was switched ON but the panel never confirmed it", or
   "force-charge toward ~80% never started" (armed to ride, no ON stamped — `decideForceCharge`
   declined every tick, or the option was switched off by a restart). Whether force-charge rode
   the night is the arm-time stamp (`forceChargeRides`), not the option at the restore: a restart
   mid-night with the option changed turned an armed-to-ride night into "reserve raised to 50%
   (~34.9 kWh expected)" — a figure counting the force-charge leg beside a reserve-only account. A
   record armed before the stamp reads the option, as before. The expected figure is named only
   beside an account of the legs it counts (`expectedLeg`): reserve only with a figure that counts
   no force-charge leg, or a force-charge that ran with one that counts it — never beside a
   reserve-only account whose figure may count the leg (a record from before the stamp with the
   armed ceiling above the reserve maximum), nor beside a force-charge that ran on a night armed
   without it. The
   force-charge ON-failure warning (`buildNightForceChargeOnFailure`, "Night-charge: force-charge
   did not take effect") names where the force-charge stops — "Tonight's buy above the 50% reserve
   (toward ~80%) will not happen" (`forceChargeStopPct`) — and
   adds "on those slot(s)" on a partial failure. Since v1.196.0 it names each failed slot's Core
   (`forceChargeSlotCores`: the slot's DPU from the panel's source list, labelled `coreLabel`, a
   never-named Core by its slot — never serial digits), says "offline in the cloud" when the cloud
   does not have that Core (its settings are then its last report), and names the Core's work mode
   (`sysWordMode`: 0 default, 1 self-powered, 2 scheduled, 3 time-of-use) and its own backup
   reserve (`sysBackupSoc`) where those are known and differ from every other Core of ours
   (`forceChargeFailedSlotsText`): "still reads slot(s) 3 (Core 5 — work mode 3 (time-of-use),
   where the other Cores read 0 (default); its own backup reserve 60%, where the other Cores read
   50%) OFF", and then "…check the SHP2 cloud link, and compare that Core's work mode and backup
   reserve with the other Cores' in the EcoFlow app". The slot → Core join comes from the same fresh
   panel readback the ON verify read; each Core's work mode and reserve are its last reported DPU
   settings. The "force-charge ON NEVER TOOK EFFECT" log line names the slots the same
   way; the morning push keeps slot numbers. A night
   expected to charge nothing reads "the reserve was held at 50% overnight as a floor (no charge
   was expected)", and the apply-failure warning calls it a reserve hold. A restore that ended the night early is not reported as completed: an owner
   cancel after the write ("Night-charge: cancelled — reserve restored to 16%") and a grid-loss
   abort ("Night-charge: stopped (grid lost) — …") say so, with no figure. The armed record's
   `buyKwh` is the worst case and is never pushed;
   only the log lines name it, labelled (`buyFiguresLogText`).
   Harness: `scripts/mutate-actuation-readback.mjs` (5 mutants).

3. **Revert (at the window close, or immediately on a post-apply cancel or a grid loss).** v1.187.0: `REVERT_LAG_MS` is 0 (it was 5 min): a pack still under its target at the close kept grid-charging at the off-peak rate until the restore. The revert readback verification and the settling grace (`REVERT_VERIFY_AFTER_MS`, `REVERT_READBACK_GRACE_MS`) are measured from the revert itself and do not move. **Force-charge's OFF goes first on that tick** (`actuationStepOrder`, nightForceCharge.ts): whenever a force-charge OFF is due on the night's own record — window closed, no window, cancelled, or reserve already reverted (`forceChargeOffDueNow`) — the tick runs the force-charge step before the reserve step; otherwise the reserve step runs first, so the START still rides the reserve it just verified. Each step runs in its own try (`runActuationSteps`), in either order. Without this the OFF waited behind the revert PUT (writes carry no timeout of their own; undici's 300 s default applies) and the morning summary while the Cores kept grid-charging at 16–19 kW. Both are OFF-direction writes, so neither order can raise a charge. The restore stamps `actuation_reverted_at_ms` on the ledger row (the delivered-energy span's end, §7). The prior reserve value is restored. The revert path is mode-independent — it runs even if the owner flips the option back to advisory mid-night — and refuses an invalid restore value. After `REVERT_ESCALATE_AFTER = 3` consecutive CLOUD-REJECTED writes it annunciates a critical (audible + HA notification) once and keeps retrying; the floor/runway/SoC alarm spine is fully independent throughout. A successful revert sends a morning summary notification — not awaited (v1.187.0): an info push (5 s headers + 10 s body per target) never holds the tick. **v1.189.0 (review):** the summary no longer goes on the restore's cloud ACK, where it said "reserve restored to 16%" and a restore that then did not read back was paged critical half an hour later, both cards standing. It goes once (`restoreSummaryDue`, stamped `restoreSummaryAtMs` before it is sent): on the tick the restore reads back (`revertVerifiedAtMs`), in the words above ("restored"); or, when the restore's readback grace (`REVERT_VERIFY_AFTER_MS`, 5 min from the ACK) runs with no readback, saying the restore was sent and acknowledged and the panel has not read it back yet ("Night-charge: reserve restore to 16% sent"), with no "restored" anywhere. After a restart with no reading yet, the owed summary first waits for this process's first reserve reading, at most `REVERT_DEADLINE_HOLD_MAX_MS` (10 min; `restoreSummaryAwaitsFirstReading`, stamped `restoreSummaryHeldAtMs`, v1.190.1), so a restore that reading confirms gets one "restored" card. A grid-loss abort is kept on the record with the restore (`revertGridLossAbort`), so the later summary still says the grid was lost. A record from before the field reads back as already summarised (its summary went on the ACK), so an update never sends a second one.

   **v1.131.0 — revert readback.** `revertedAtMs` is stamped on the cloud's ACK, the evidence
   v1.79.0 ruled insufficient on the apply side. A restore the SHP2 accepted then ignored would
   leave the reserve raised with a clean ledger: the expensive end state, where the panel holds
   it as its floor and buys grid at on-peak, and the floor alarm reads a false AT-RESERVE-FLOOR
   posture. A reverted night verifies against the DEVICE: reading the restored floor stamps
   `revertVerifiedAtMs`; still reading the RAISED target after `REVERT_VERIFY_AFTER_MS`
   (= `REVERT_READBACK_GRACE_MS` = 5 min, so a verdict can never be reached inside the
   settling window `isRevertSettling` exists to cover) re-issues the restore up to
   `REVERT_MAX_RETRIES = 2`, then escalates once — critical announce plus a critical HA push
   naming the manual fix. Strict equality on both sides: a reading that is *neither* the
   restore target nor the raised target means the owner moved the floor themselves, and the
   actuator falls through rather than overwriting their change (the same "never guess"
   discipline as adoption). Guards are mutation-proven load-bearing
   (`scripts/mutate-detector-honesty.mjs`, mutants ix–xii).

   **On-peak guard.** A raise left standing into the on-peak period is the expensive end
   state, so every raise stops, and every restore falls due, `ON_PEAK_RAISE_GUARD_MS` (60 min)
   before the stamped on-peak start. The restore falls due at `revertDueMs` = min(window close,
   that moment); the force-charge ceiling sync, ON and ON re-issue stop, and its OFF falls due,
   at `writeWindowEndMs`, the same min (OFF reason `onPeakGuard` when the guard binds). The
   overnight window closes at 05:00, eleven hours before the 16:00 on-peak start, so on a night
   that goes to plan none of this moves: `onPeakGuard.test.ts` replays a year of overnight
   nights, tick by tick, and every decision is the one the window-only schedule makes. A record
   armed before the stamp keeps the window-only schedule.

   **The foreign rule.** A reserve someone else set during the night (the EcoFlow app, Storm
   Guard) is theirs. Once the write has read back, a reading that is an in-envelope whole number
   and neither the target nor the value the restore writes is recorded (`foreignSeen`); the same
   value read again `FOREIGN_RESERVE_SETTLE_MS` (5 min) or more later settles the night as
   foreign (`foreignSettled`, `foreignStep`). The add-on's own values are never foreign
   (`isOwnReserveValue`): the target, the value the restore writes and — on a night the panel
   granted only in part (device-ceiling adoption: `requestedPct` was asked, `targetPct` is what it
   settled at) — every whole value above the attempt-time baseline up to the request. A partly
   granted write the panel later moves within that band, up to the request itself, is adopted as
   the target (`ceilingMoved`, `ceilingMovedPct`), so the restore, its readback, the deadline page
   and the money detectors' hold compare against what the panel holds. After the restore was sent
   such a reading is the raise that has not come down (`readsOwnRaise`), never the restore nor
   someone else's setting: the readback adopts it the same way, so the re-issue and its failure
   verdict compare against it, and the deadline pages, the arm refusal, the retry wording and the
   hold read it as the raise directly on a tick before the adoption. On a settled night
   nothing more is written to the reserve, the force-charge riding the write switches OFF
   (reason `foreign`), the night is resolved for the next
   arm, the posture no longer reads it as raised by the add-on, and a push says what the
   reserve reads. A different value restarts the count; one of the add-on's own values clears
   it; a null or out-of-envelope reading is no evidence either way, and the clock-driven restore
   goes ahead blind over it. One sighting does not hold the restore. After the restore was sent,
   the same rule ends the wait for it to read back. Before the write reads back, a short reading
   stays the apply ladder's (device-ceiling adoption) — and after the restore of a write that
   never read back, the panel's partial answer to it, never foreign. Cancel answers 409 on a
   settled night.

   **revertDeadline.** Every other revert escalation needs evidence: three cloud-rejected
   writes, or the raised target read back after the re-issues. A panel whose readback goes dark
   at the close gives neither. `decideRevertDeadline` needs only the clock: while a write of ours
   may still hold the reserve (`revertOutstanding`: applied, or attempted and never confirmed;
   restore not read back; not foreign) it has two stages, `revertDeadlineMs` = min(window close +
   `REVERT_DEADLINE_AFTER_WINDOW_MS` (30 min), on-peak start − `ON_PEAK_PAGE_LEAD_MS` (30 min))
   and the on-peak start. Each is decided ONCE, on the first tick at or after its moment
   (`revertDeadlineStageDue`): it pages when the live reading is the raise (`readsOwnRaise`: the
   target, or on a partly granted night another value within what it asked for, which the words
   then name as what the reserve still reads) or no reserve setting,
   and passes on any other setting — the restore itself, a value someone else set — stamped
   `revertDeadlinePassedAtMs` / `revertDeadlineOnPeakPassedAtMs`, so a stale reading hours later
   pages nothing. A reading that is not a reserve setting (`isReserveSetting`: a whole number in
   the 10–50 envelope) — a reconnect 0, a fraction, a value outside the envelope — counts as no
   reading, as it does for the foreign rule: it never decides a stage without a page. The deadline
   stage lasts until the on-peak start (which then stands for it), the on-peak stage for
   `REVERT_PAGE_STAGE_SPAN_MS` (3 h, the on-peak period); a stage past its span is dropped, never
   paged days later. The deadline stage waits while the restore has not had its chance
   (`restoreAwaitingFirstChance`: a process down across the deadline): due and never attempted,
   with a valid prior and the panel in the device list (the same tick sends it), or accepted under
   `REVERT_VERIFY_AFTER_MS` ago; or, for an attempt never confirmed, with the panel listed and
   reading its target from a valid baseline (`attemptAdoptable`, the adopt rule: the same tick
   adopts it and the next sends its restore — a crash inside the write call, down past the
   deadline, paged a failed restore before one was sent); or, v1.189.0 (review), for an accepted
   restore with no reading while the process has read no reserve setting since it started
   (`readSinceBoot`, index.ts `nightReserveReadSinceBoot`: down from just after the 05:00 ACK to
   past the deadline, its readback grace spent and its first readback not yet fresh, it paged "could
   not be confirmed" a tick before the restore read back); the wait is stamped `revertDeadlineHeldAtMs` and lasts at most
   `REVERT_DEADLINE_HOLD_MAX_MS` (10 min), so the page goes out on a later tick only when that
   restore is rejected, does not read back, or cannot be sent. A restore sent at the close is long
   past its grace at the deadline; the on-peak stage never waits. An attempt never confirmed that a
   live reading shows at its attempt-time baseline once its apply ladder is over (past the apply
   window, or cancelled, and 5 minutes after the last attempt) never landed
   (`attemptProvedUnlanded`, stamped `attemptUnlandedAtMs`): it is no longer outstanding, and the
   next arm no longer needs a live reading to prove it (`attemptNeverLanded`). The same holds for a
   write the cloud ACK'd whose apply ladder ended in `applyFailed` with the panel still reading the
   baseline 5 minutes after the last re-issue (`applyProvedUnlanded`, stamped `applyUnlandedAtMs`):
   its restore is a no-op, so it is not outstanding — until a later reading verifies the write,
   which outranks the stamp. The page is a critical announce in English and Spanish
   (`revertDeadlineSpoken`) and a critical push (`buildNightChargeRevertDeadline`); with no reading
   both say the restore could not be confirmed, never that the reserve reads raised. At the
   deadline stage both name the on-peak start's weekday when it is not the page's own date
   (`chargeText.onPeakDayWords`: a Friday window's page at 12:30 AM Saturday says "on Monday at
   4:00 PM", a holiday eve's the day after the holiday), and the bare clock otherwise; the
   unconfirmed page then says what to do compactly to stay within the spoken bound.
   The push says the add-on keeps retrying the restore only while one will still be sent
   (`revertRetryPending`: a restore the cloud has not accepted, re-sent every tick; or an accepted
   one whose readback re-issues are not spent, with the panel reading the raise). v1.189.0
   (review): with no reading it says what the restore waits on (`revertResendOnReport`) — "The
   add-on sends the restore if the panel still reads the raised reserve once it reports again" for an accepted restore
   whose re-issues are not spent, or an attempt never confirmed (`retryRevert`, or the adopt rule,
   on the first reading of the raise), and "The add-on sends the restore once the panel reports
   again" for a restore the cloud has not accepted with the panel missing from the device list
   (sent on the first tick it is listed); it said "not re-sending" there, and then re-sent it.
   Otherwise it says the add-on is not re-sending it. Each stage is stamped on the record before it is said
   (`revertDeadlinePagedAtMs`, `revertDeadlineOnPeakPagedAtMs`), and it is decided ahead of the
   no-panel return, so a panel missing from the device list still pages. Broadcast quiet hours
   apply to the spoken page as to every critical announce; overnight the 05:30 page is pushed, and
   the on-peak page is spoken. A restore that has not read back while the panel still reads the
   raise (or nothing) also refuses the next arm (`restoreUnconfirmed`, an `armOpenItem`): a
   Friday window's record carries Monday's on-peak page and the money detectors' hold, and
   Saturday's arm for the shared Monday window would otherwise have replaced it.

   **heldByChargeWrite.** The on-peak money detectors stay silent near the reserve, because near
   the owner's floor buying on-peak is outage protection. A restore that did not take leaves the
   night's target as the panel's reserve; past the restore's readback grace (`chargeWriteHold`'s
   `heldFromMs`: `REVERT_VERIFY_AFTER_MS` after the restore was accepted, or after it fell due
   while none has been — an acceptance after that point does not move it), with the panel still
   reading that target (or, on a partly granted night, another value within what it asked for: the
   hold carries `requestedPct` and the attempt-time baseline), both detectors measure against the prior floor
   (`moneyDetectorReservePct`; energy and cost chapter, the grid-to-battery and idle-pool
   notices). A restore that goes to plan reads back inside the grace and never engages it, so the
   alert monitor's "heldByChargeWrite" line is a failure-path line only. The runway and
   below-reserve alarms are unchanged.
4. **Score.** The scorer's actuated branch (§7) measures the delivered buy as the energy into the home Cores on the house panel's source channels (`deliveredIntoCores`, v1.187.3; window grid import minus the concurrent house load before it) and records `delivered_kwh` with `delivered_basis`, read by the buy de-bias learner (§15.12). v1.187.0: over the span the write was held (`deliveredHoldSpan`), which ends at the restore the actuator stamps on the row (`actuation_reverted_at_ms`, a ledger column since v1.187.0, NULL before it) plus the device settle — §7 "Realized cost" / "Delivered energy". *(`actuatedRealizedNeedBuyKwh`, `nightChargeAdvisor.ts`, is **not on the scoring path** — corrected v1.132.0; only tests exercise it.)*

**Deadline phrasing (v1.51.2).** The announced cancel deadline is **day-qualified beyond 24 h** (e.g. "on Monday at 12:00 AM"; since v1.187.0 the deadline is the window open, `APPLY_LEAD_MS = 0`) in both the notification and the spoken broadcast: weekend tariff semantics routinely resolve a Saturday-evening plan's window to Monday 00:00, putting the write moment ~28 h out, where a bare clock time would read as tonight. The spoken text also carries the `cushionShortfall` disclosure whenever the plan discloses one — the audible channel is never quieter about residual risk than the text channel.

**Disabling the outage cushion (`ARB_OUTAGE_CUSHION_HOURS: 0`) — v1.133.0.**

`outageCushionKwh` returns a `CushionBasis` of `islanded-outage`, `legacy-pct` or
**`disabled`**, and the three are genuinely different states that one number cannot
distinguish:

| basis | meaning | trough test |
|---|---|---|
| `islanded-outage` | sized from a measured islanded load over a bounded outage — the intended path | pack **at window close** (outage onset) |
| `legacy-pct` | no usable islanded-load measurement; the flat percentage-of-pool band stands in | whole-house **forward trough** (harsher) |
| `disabled` | the owner set the cushion to zero — the plan stops sizing for an outage entirely | pack **at window close** |

**An exact `0` is a decision, not a fallback.** Before v1.133.0 it fell into the "no measurement
available" branch and delivered the legacy band, whose whole-house trough made **asking for no
cushion raise the requirement**. An exact `0` is honoured,
and is checked FIRST — a disabled cushion does not depend on an islanded-load reading, so a
missing measurement cannot resurrect the legacy band underneath it. Anything else nonsensical
(negative, `NaN`, `Infinity`) still falls back: fail toward more cushion, never less.

**A disabled cushion announces itself in the rationale** — "the N% reserve floor alone — the
outage cushion is DISABLED, so nothing is held back for an outage". Without that, a night with
no outage margin reads as one whose floor+cushion was comfortably covered, which is a standard
that was lowered being reported as one that was met. Note also that `cushionShortfall` changes
meaning under `disabled`: with the cushion at zero it fires only when the pack cannot hold the
**reserve floor itself**, which is a stronger and rarer signal than the pre-v1.133.0 flag.
Guards are mutation-proven load-bearing (`scripts/mutate-zero-cushion.mjs`, 6/6).

**Objective mode: resilience vs cost (`ARB_OBJECTIVE`, `ARB_COST_MAX_SOC_PCT`) — v1.127.0, documented v1.132.1.**

The planner sizes a buy against one of two objectives, selected by `ARB_OBJECTIVE`
(`resilience` | `cost`, default `resilience`):

- **`resilience`** — buy exactly enough that the post-window trough holds the reserve floor
  plus the outage cushion. The buy is a *requirement*; anything beyond it is waste.
- **`cost`** — the resilience answer is a **floor**, not a target. `costModeTargetKwh`
  (`nightChargeAdvisor.ts`) raises the target toward `min(ARB_COST_MAX_SOC_PCT % of pool,
  pool − morning-PV surplus)` and records which of the two bound it in the ledger's
  `cost_ceiling_basis` column (`'max-soc'` | `'pv-headroom'`; `'pv-curtail'` on a mid-day leg,
  which nothing plans yet: the solar headroom under the charge taper). The morning surplus is the
  P50 (the P90 stands in when the P50 is unknown; a long-gap night uses the pre-peak P10),
  computed on a **de-biased load** where the ledger shows the load forecast running high, and
  since v1.196.0 a **de-biased P50 PV** where it shows the sun running over its forecast
  (§15.13 "Cost-ceiling load and PV de-bias"; never on a `cushionShortfall` night);
  `costCeilingSurplusKwh` is the figure used and `costCeilingSurplusRawKwh` the one on the
  forecast load as is (ledger `cost_surplus_kwh` / `cost_surplus_raw_kwh`). It is bounded below by the
  resilience target, so **the safety margin can never shrink when the objective changes**;
  the only direction cost mode moves a buy is up. Every physical cap downstream — charge
  power, pool headroom, EV contention — is re-applied unchanged.

Three properties an operator needs before setting these:

1. **`ARB_COST_MAX_SOC_PCT` above 50 is delivered by force-charge, not by the reserve write.**
   The reserve write is capped at 50, the SHP2's own ceiling (`RESERVE_WRITE_MAX_PCT`).
   v1.161.0 raised the bound to 90, the device settled the 2026-09-16 write at 50, and v1.164.0
   restored 50. Both `clampReserveTarget` (`nightChargeActuator.ts`) and `setBackupReserveSoc`'s
   range check (`ecoflow/commands.ts`) enforce it.

   Since v1.165.0, force-charge runs on a night whose reserve write is applied and
   readback-verified, with `ARB_OBJECTIVE: cost` and `ARB_COST_MAX_SOC_PCT` above 50.
   `nightForceCharge.ts` switches the panel's per-channel force-charge (`setChannelForceCharge`,
   `ch{n}ForceCharge`) ON just in time to reach the announced economic ceiling,
   `min(ARB_COST_MAX_SOC_PCT, full − the morning solar surplus)`. It switches it OFF at that
   target or at the window close, or an hour before on-peak if that is sooner (the on-peak guard,
   item 3 of the nightly flow). The panel's `foceChargeHight` ceiling is synced as a backstop and restored
   afterwards. Its wall-clock OFF deadline (the later of the first OFF + 30 min and the window
   close + 60 min) is capped `ON_PEAK_PAGE_LEAD_MS` (30 min) before on-peak; blind OFF re-sends
   (no readback, after the escalation) stop 12 h after the first OFF or at the next charge
   window's open, whichever is first (`blindResendStopMs`): the next cost leg of the charge cycle,
   else the latest plan's window (`nextForceChargeOpenMs`; a backup leg never force-charges, so an
   OFF sent inside its window cuts nothing of ours). Force-charge is per leg
   (`forceChargeOn(role)`, `legForceChargeEligible`, `chargeWindows.ts`): a resilience-only
   backup leg ahead of a mid-day buy never force-charges. Every leg armed today is the overnight
   cost leg.

   Setting `ARB_COST_MAX_SOC_PCT` to 50 disables the **cost** force-charge. Since v1.200.0 it does
   not stop the line force-charge (below); `NIGHT_CHARGE_MODE: advisory` or the night's cancel does.
2. **Cost mode is rate-blind.** `costModeTargetKwh` reads no tariff. "Cost" here means *fill
   further*, on the premise that overnight energy is the cheapest the day will offer — not
   that the planner optimises against the rate table. The tariff model informs the *window*,
   not the *target*.
3. **Cost mode is asked before it holds (v1.174.0).** The resilience hold returns early only in
   `resilience` mode. In `cost` mode, a night whose no-buy trough already clears floor + cushion
   still evaluates the cost target. It holds only when the pack already sits at or above the
   night's cost ceiling, or when the window can deliver less than the minimum buy toward it.
   The hold rationale names which case applied, and the ledger records the ceiling the night
   was measured against.

**The outage line above the reserve envelope (v1.200.0).**

The panel accepts a backup reserve of at most 50% (`RESERVE_WRITE_MAX_PCT`), so a line above it cannot be
written.

- **Which plans qualify** (`nightChargeAdvisor.ts`): an islanded-outage charge plan, not economic-only
  (`requiredExtraKwh > 0`), whose line's whole percent ⌈L⌉ (`askOf`) and, since v1.203.0, the panel's point
  is above 50 (`lineNeedsForceCharge`: a 50% reserve holds 49, so a line in (49, 50] too; part 1, "The
  panel's point"). A legacy-pct or disabled cushion, a hold, and a night whose pack already holds the line
  without a buy never qualify. On the year fixture 30 plans qualify on nameplate and 44 at 0.944.
- **Armed, carried or disclosed.** Where the line force-charge is eligible (`lineForceChargeEligible`:
  supervised or auto mode, never the backup leg) the plan arms it whatever the ask (`forceChargeLine
  { askPct: max(⌈L⌉, 51), linePct: L }`), unless the reserve reads above the write, or a mid-day leg's reads it. It is **carried** only where ⌈L⌉ + 10 ≤ 100 and, with the sizing met,
  its own walk closes at or above L − 0.05 (`lineWalkHolds`). Otherwise it **discloses**:
  `cushionShortfall`, cause `'envelope'` (`'envelope+caps'` with a sizing shortfall), reason `advisory`,
  `backupLeg`, `reserveAtTarget`, `armedNoLine` or `startClosed` (nothing armed), `nearFull` (⌈L⌉ + 10 > 100), `closeUnder` or (v1.205.0) `lateStart` (the median walk holds, the walk with the at-open allowance does not: 15-1, "The line claim"), the last three still armed. The flag is OR-ed in **after** the cost block, so the cost ceiling and its de-bias bound
  read the sized flag alone. `cushionTroughSocPct` stays the sized trough. The written reserve and every sizing figure
  equal v1.199.1's for the same inputs; with no eligibility input the plan is byte for byte.
- **A standing reserve (v1.200.1).** The plan-time reading decides words only (`lineStanding`, `lineReserveStands`): the ask stays on the record, so a reserve lowered by the open gets its
  write and rides it, at the ask sized on 50 (high, cost only: about 28 points over that reserve's own line, ~18 kWh; a strike there is at the recorded line, no exemption). A record with an ask reading
  the target behind every apply guard, with no attempt, stamps `reserveStandingAtMs` (not under a write block), or with the grid read lost `gridLostAtMs` for good. That writes nothing and no restore follows: `appliedAtMs`,
  `applyVerifiedAtMs` and `priorReservePct` stay null. The ON and the ceiling sync need the stamp and the same tick's fresh reading (`reserveRideReady`, `ForceChargeOpts.reservePct`). Then the foreign
  rule runs to the close (any change, the floor route's too), and a grid read lost stamps `gridLostAtMs`, one-way with no dwell: no ride after a return, the ceiling back at once, pushed. The OFFs read no
  write. The close is the morning summary (`standing`). No `actuated`: `RESERVE_STOOD_DISPOSITION`, a loss at the stamp's too, grades it (`lineReserveStood`), a cancel before any ON rewrites it, and a plant that only stands
  gives no graduation evidence. A cost-dominant night with an ask gets an ON in cost mode. At a standing 50 Charge Now reads ON a mean 116-176 minutes a night (4-20 h), its outage behaviour unproven;
  the re-entry band at 50 is unmeasured, so no hold rule. Emulated: nothing here has run on the plant.
- **The two modes** (`forceChargeModeOf`, `nightForceCharge.ts`). The armed record keeps the line's ask
  in its own field (`forceChargeLineAskPct`) beside the cost ceiling (`forceChargeCeilingPct`, whose
  meaning is unchanged). Each tick composes the mode from the **live** gates: the cost force-charge
  (`forceChargeEnabled`) and the line (`lineForceChargeEnabled`: any write mode). It is **cost** mode,
  today's force-charge exactly, when no line rides or when the cost stop already reaches ⌈L⌉ + 10. It
  is **line** mode otherwise, with target max(cost ceiling where it rides, ⌈L⌉). An option change
  (and its restart) acts at once, either way. With the cost gate off, a line night drives to ⌈L⌉, never to the cost ceiling.
- **The start.** It is timed to reach the start target, max(target, ⌈L⌉ + 5), at the window close less
  20 minutes (`forceChargeLineStartAtMs`: `forceChargeStartAtMs` counted back from close −
  `FORCE_CHARGE_MIN_RUN_MS`). That is ⌈L⌉ + 5, a riding cost ceiling between ⌈L⌉ + 5 and ⌈L⌉ + 10, or 95 where ⌈L⌉ + 10 > 100
  (ceiling 100, so the re-ON keeps a band under it). A one-point lift still starts outside the "not worth starting" dead zone. A pool above the line but under the panel ceiling still gets its final segment ON.
- **To the close.** The add-on has no software stop in line mode: it switches Charge Now off at the
  window close (or the on-peak guard, a grid loss, both gates off, a reserve set outside the add-on, or the run backstop). While Charge
  Now is ON under the panel ceiling the house and an EV ride the grid, so a load that starts after the start cannot draw the pool under the line.
- **The panel's own stop, and the re-ON.** At its ceiling the panel switches a slot's Charge Now off by
  itself and leaves it off, read per slot with the panel-side classifier on 2026-09-23 (ch1 04:19, ch3
  04:30) and 2026-10-02 (slots 2 and 1, 04:24-04:25). Below the ceiling the house and an
  EV draw the pool again. A start pulled early by a predicted EV reaches the ceiling hours before
  the close, and a real EV arriving later can draw the pool under the line: emulated, 8 of 200 year
  nights with a 20 kWh EV predicted and a 7 kW one arriving 90 minutes out. So on a line night whose ON verified, when the pool reads under the start target and
  slots of ours read OFF (connected, their Core under the ceiling), the tick switches them back ON
  (`lineReOnDue`), under the start's own gates (the grid known present, healthy vitals, a coherent pool reading, a live slot readback and a live panel ceiling the pool is
  under), at most twice a night (`FORCE_CHARGE_LINE_REON_MAX`), 15 minutes apart, and never in the last
  20 minutes (a re-ON shares each slot's command cooldown with the close's OFF). The budget is counted
  write-ahead (`forceChargeLineReOns`). Each re-ON is read back 15 minutes after it, as the ON is
  (`lineReOnCheckDue`): slots still reading OFF, their Cores under the ceiling, are counted not applied (`forceChargeLineReOnsNotApplied`), and the budget's next re-ON is the retry. A
  slot switched off in the app reads the same and is switched back on within that budget. The expected walk models both.
- **The panel ceiling** is `desiredForceChargeCeilingPct(max(target, ⌈L⌉ + 10))`: 80 for any ask up to
  70, then ask + 10, at most 100. The value written is kept (`forceChargeCeilingSyncedPct`) for the ON verify's
  at-the-ceiling exemption and the settings-drift own-write list. The ON stamps the mode's
  ceiling too (`forceChargeOnStamp`): a night whose panel already read it had no sync, and its verify would read the cost ceiling's
  value. While ON in line mode a synced ceiling above the mode's own is lowered to it, once
  (`lineCeilingLoweringDue`): the cost gate gone off mid-run on a cost-dominant night would
  leave the cost ceiling (90) the only stop. It lowers only what
  the panel holds, a live readback inside 80-100 above the mode's ceiling, so it runs under red vitals too, as the OFFs do.
- **The morning refresh** (`morningRefresh.ts`) lowers or drops the cost ceiling only; the line ask rides through.
- **The surfaces** state one level, the expected close of the line walk (`expectedBuyFromPlan` in line
  mode, `expectedForceChargeMode: 'line'`): rationale, push, card and spoken
  notice, which adds "The panel keeps only 50 percent in reserve." The line sentence appears only in line mode. A window-bound walk's close is capped at the window's reach and floored at
  the 50% reserve (chapter 15 part 1). A walk that reaches the panel ceiling (`expectedLineCeilingStop`) is worded by the panel's stop and the re-ON on the rationale, push and
  card, never "stays on until the window closes"; a run with no re-ON left says so (`armedLineNoReOn`); a run on (`armedLineRunOn`, served plan) walks from now, named as on. A pool expected at or
  above the panel ceiling reads armed "but is not expected to start". Nothing armed reads "and no
  force-charge runs in advisory mode" (the backup leg: "the outage backup leg writes the reserve only"),
  "so the cushion is not fully held — residual risk remains". `reserveAtTarget` says "no write is due while it does, and no force-charge runs without one"; `armedNoLine`, a recompute of a window whose record has no line ask, "no write armed for this window carries a force-charge for it", each "so the cushion is not assured": a reserve lowered later can get its write, with no force-charge for the line. `startClosed` (a record with its ask, `armedLineStartClosed`, a run a cancel or an OFF ended too, an ON warned of on any slot, or all slots off with no re-ON left; or no record with no evening job left, `noArm`, pushed once): the key's words, on the served plan only; the ledger keeps the ask, and with no verified write standing, or a partial ON, the card leads with them. An armed night keeps its line sentence and adds a NOTE (`lineNotHeldOf`; the 21:30 log "Line NOT held") where its walk closes
  under the line, above 100% "above a full
  pool", and on a `nearFull` walk that holds "cannot hold it with its usual margin"; never "no
  force-charge". The "charge/pool caps" note needs a sizing that fell short.
- **At run time** a night with a line ask, a cost-dominant one too, pushes when anything but the clock or the pool holds its start. Causes (`forceChargeBlockerClass`): the ceiling refused or unread, Charge Now already on, the grid unknown or absent, red vitals, no slot read back or connected, an incoherent SoC, and a stood night's reserve moved or unread. Each pushes once a night, after 10 minutes unbroken (`lineDeclinedPushTick`), recorded first (`forceChargeLineDeclinedPushed`). The push quotes a latest start erring early on every input (`lineDeclinedLatestStartMs`: ⌈L⌉ by the close with a 15-minute buffer, never the last 20 minutes, from at most the reserve, at the lower of the live and slot-bounded plan rates, with the EV's energy), e.g. "If it has not started by ~04:24, the pool may close under the line"; no time gone by the push: "The later it starts, the lower the pool may close, perhaps under the line". An ON that took on no slot says that, unless it applies late, the add-on adds nothing above the reserve and the pool may close under the line; one that failed on some slots, that the pool may close short of it (`forceChargeOnFailureNight`). Both say what can still lift the pool (Charge Now on for those slots, switched off at the close), never "no action needed". A reserve write never read back on such a night says it keeps its own reserve, under the line, until the panel reads 50%, and to set 50% in the app now: the last start, the close less 20 minutes, may close under the line. With no start left (`forceChargeStartClosed`: cancelled, too late) it and its logs say why none starts. A write missing its apply window pushes too (`missedApplyDue`): an attempt in those words (no reading: the force-charge waits on one),
  none issued naming Charge Now by hand. A write-blocked ON or ceiling sync is a held start.
- **The line at risk** (`lineAtRiskPushDue`). After the verified ON the re-ON is the only remedy, so a line lost another way (a re-ON not applied or spent, its gates holding, a late load taking the grid cap, the ON-reading latch below) pushes once a night, stamped before it goes (`forceChargeLineAtRiskPushedAtMs`). It needs a line ask (a cost-dominant one too) and the line gate on, no OFF issued (its own stop too), over 20 minutes before the add-on's close OFF (`FORCE_CHARGE_LINE_AT_RISK_LEAD_MS`, the re-ON's cutoff), a fresh, coherent pool under the start target (⌈L⌉ + 5 on a cost-dominant night) and below a reading at least 10 minutes older, or level with it at or under ⌈L⌉, with no slot off only once the time left no longer covers ⌈L⌉ at the slot-bounded plan rate (`lineFlatPushHeld`; `FORCE_CHARGE_LINE_TREND_MS`, the two-sample trail `lineNightObservations` stamps first, with the panel's own stop, anew after a re-ON or a slot seen ON; `lineTrendReference`
  takes only a reading 15 minutes or more after the last ON or re-ON, past one checked not applied, or a
  slot seen ON again that no ON of ours explains, `forceChargeLineOnSeenAtMs`, or an ON verified late), and no re-ON due nor a
  rate-limited one's retry due a full tick before the cutoff (else `reOnRefused`, judged on its own tick and after a ceiling lowering; "may try once more" only where a tick can). Above a 95% line the re-ON and the push key on 95, under the line; emulated, the push reaches no near-full night that closes under. It names the slots: reading OFF, Charge Now on can still lift the pool; reading ON, the pool not rising, stopping a large load may let it rise; with none on, off and on again may restart the charge. A cost-dominant night's push names ⌈L⌉ + 5 by its margin over the
  line, and its cost force-charge as not switched back on. No write rests on the ON-reading shape; seen (slots of ours ON, their Cores under the ceiling, the pool falling against
  `lineTrendReference`) one warning is logged a night (`lineOnReadingShape`), never on the measured latch. A `gridLoss` OFF no abort reports is pushed (`lineGridOffPushDue`).
- **The morning account** of a night with a line ask says it "ran to the window close
  for the 55.6% outage line" only when its OFF was the window's; any other OFF says when and why ("until
  3:30am (switched off: …)"), and the panel's own stop "until the panel's own stop switched Charge Now off at 3:10am". It names the re-ONs ("after
  the panel's own stop" only with it on record) and those a check found off. The stop ended the charge
  unless a re-ON after it took (`forceChargeLineReOnAppliedAtMs`) or a slot read ON again; with the last
  re-ON taking on no slot and none reading ON after it, Charge Now "read off" before the close. The close reading follows, "under the 55.6% outage line"
  when under, "the pool was not read at the close" with no fresh reading; over 15 minutes late, the pool "now", no verdict (`lineCloseReadingLate`); a grid loss or cancel gives the reading then. A write never read back is told so, not "raised", there and on the banner (`lineWriteUnreadStatus`). A night with nothing to restore (no write, a foreign reserve) has its own account at the close (`lineCloseAccountDue`), a stood night the summary's. A night with no line ask
  reads as v1.199.1, word for word (`fixtures/lineNightCostTexts.v1199.json`).
- **Strikes.** A carried night whose sizing held (`cushion_shortfall` = 0) is clean at or above its line and
  a strike, fail-closed, under it (a run-time refusal, an ON that never took, a slow pack, a late load taking
  the grid cap, below). A row with `cushion_shortfall` = 1 (disclosed, or carried with its caps note) is
  exempt unless it is armed, actuated and never switched on (`force_charge_on_at_ms` NULL) with a close
  under min(line, 100): a strike, an owner's cancel after the apply too (no cancel column). An ON that never took leaves it exempt (no ON-verified
  column). A write that never held it (`actuated` 0, a missed apply) is graded as actuated (`lineWriteNeverHeld`). A verify after `applyFailed` stamps `actuated` 1. `lineForceChargeStrikes` counts the strikes with an ask in the window. The ledger
  records `cushion_line_force_charge_pct` (the ask armed), `cushion_envelope_shortfall` (1/0) and, at the ON, `force_charge_mode` ('cost' or
  'line'). `CURRENT_ALGO_VERSION` stays 3: no scored column's formula or sign moved.
- **The exposure.** On a line night in a write mode, Charge Now is ON from the timed start
  to the close or the panel's own stop, whatever `ARB_OBJECTIVE` says: new to a resilience-objective
  plant. Emulated over the year's line shapes
  (`lineForceChargeClose.test.ts`), a slot reads Charge Now ON for 74 minutes on
  average, 142 for lines of 70-90%, and 138 with a 20 kWh EV
  predicted, the panel's own OFF counted. A line within 10 points of full: 182 minutes (224 and 335 with a
  predicted EV); the panel's own stop at 100% is unmeasured, and how a slot with Charge Now ON behaves
  when the grid fails is not established. The off switches are
  `NIGHT_CHARGE_MODE: advisory`, the per-night cancel, a reserve set in the app, or a cushion whose line is at or under 50%. Before
  a resilience plant runs line nights, an attended test is recommended: one slot ON, main breaker open,
  backed-up loads up, the pack discharging.
- **The close guarantee** (`lineForceChargeClose.test.ts`, the real `decideForceCharge` in a
  minute-by-minute plant, emulated). The plant models the panel's OFF at its ceiling (the latch as
  measured), and the tick's `evDisplacedKwh` from a predicted EV as `index.ts` passes it. The year's line
  shapes (50.45-65.95%), houses of 0.6-3.6 kW and rate factors of 0.9-1.25 close at or above the line on
  every night under each of these, one at a time: rounded or floored readings, 0.27 kW of Core
  standby, an ON 5 minutes late, a reading 3 minutes stale, a 7 kW EV starting 15, 25, 30, 60 or 90
  minutes before the close, a pack taking 60% or 70% of the rate, and a pool of 60% or 77% at the open.
  So do the predicted-EV nights, at lines of 70-90% too: 20-36 kWh predicted, or predicted exactly,
  with a 7, 11 or 11.52 kW EV arriving 60-180 minutes out, the other stresses combined too. That
  rests on the re-ON; without it up to 65 of 200 year nights close under (36 kWh predicted, an 11.52 kW
  EV from 90 minutes). The cost: an overshoot of about 13 points on average, stored, not lost.
- **What it does not carry** (pinned exactly). The start is timed on the live
  rate, so an **unpredicted** load that takes the grid cap after the start leaves the pack short. Of
  the year's 200 nights, rounded readings first and floored second:
  - an 11.52 kW EV (`EV_MAX_LOAD_W`'s default) from 90 minutes before the close: 73 and 82 close under;
  - the same EV from 120 minutes: 55 and 61;
  - a 7 kW EV from 120 minutes: 5 and 8;
  - an ON 5 minutes late with a 7 kW EV from 90 minutes: 1 and 4.

  A pack taking 85% of the rate with that EV closes 1 and 3 of 50 under. For lines of 70-90% the window
  cannot always deliver the lift to a slow pack: with rounded readings 8 of 35 nights at 70% of the
  rate, 30 of 35 at 60%, and 1 of 140 with an EV from 90 minutes out (floored: 11, 33 and 10). A
  **cost-dominant** night (a cost stop at ⌈L⌉ + 10 or above, today's cost force-charge with its software
  stop) with a late EV can close under a line of 70-90%: with a cost ceiling at ⌈L⌉ + 10, 5 of 140 with a
  7 kW EV from 60 minutes and 15 with an 11.52 kW one; no year line (≤ 65.95%) closes under there.
  Stresses combined, 89 close under, and the line-at-risk push, which ends at the cost stop, reaches 30. **The ON-reading latch** (a slot that stops importing at its ceiling and keeps reading
  ON) is unmeasured on this plant; no re-ON keys on it, so per predicted-EV cell 0-65 of 200 year nights
  close under (0-72 floored) and 52-140 of 140 at lines of 70-90% (variant `onLatch`, `PIN_ON_LATCH`).
  The line-at-risk push reaches every one of them at least 20 minutes before the close, after the latch;
  on the measured latch it goes on none of the 3,740 predicted-EV nights. With re-ONs accepted but never applied (unmeasured, `reOnInert`) it reaches 174 of 390 year nights
  under, 2,334 of 2,615 at 70-90%. A late apply, a glitch at the check or a person's ON log no
  shape. Of the unpredicted
  11.52 kW EV from 90 minutes it reaches 69 of 73 (70 of 82); a load that only slows the charge (7 kW from 120 minutes, an ON 5 minutes late) leaves the pool
  rising, not pushed.

**Manual cancel:** `POST /api/night-charge/cancel` (write-auth; a button on the `NightChargeCard`). Before the apply moment it disarms; after a successful apply it reverts on the next actuator tick. The card offers it in every shape, because a write armed from the announced plan stands whatever a later recompute says: beside a charge plan, a hold, or a plan incomplete or stale (`actuationBannerState`: "Cancel tonight" while armed, "Cancel & revert" once applied). Beside a hold or a missing plan the card then says the armed write stands, where it would otherwise say nothing will be charged (`writeStands`). When the status itself cannot be read (an error, or no answer within 15 s), the card offers the same cancel without knowing what is armed; a 409 answer reads "Nothing to cancel" with the server's reason (`cancelOutcome`). A cancel the server confirmed shows at once, for that write only (`actuationKey`, keyed by plan date, leg and window), until the status poll carries it. The route takes an optional body `{ leg: 'cost' | 'backup' }` (`cancelLeg`, below): with no leg named it cancels the cost leg, active or pending, else the active leg; any other `leg` is a 400. The card's banner names its own leg; the status-blind Cancel names none. A night whose reserve settled as someone else's shows no Cancel: "The reserve was set to 30% outside the add-on — tonight's write no longer holds it." (`actuationBannerState`), where the server would answer 409. A line night's closed start says why (`lineStartClosedStatus`), with no Cancel once no write can come.

**`auto` semantics:** `effectiveActuationMode(mode, writeReady)` is the binding enforcement point — `auto` is structurally demoted to `supervised` while the readiness gate has not graduated, and any future auto-only relaxation (e.g. dropping the evening cancel checkpoint) must branch on the demoted mode, never the raw config value. `advisory` remains the default; enabling a write mode is an explicit owner action in the add-on configuration.

#### The charge cycle record (`chargeCycle.ts`)

The evening job arms a charge CYCLE: the legs one evening's plan holds (chapter 15 part 1, "The charge cycle: overnight or mid-day"). Every cycle the add-on arms today is one leg, tonight's overnight cost leg, and with one leg the record, the arm, the cancel, the drift attribution and every push are what they were before the cycle record; the second leg exists only in the pure module and its tests until the mid-day switch.

- **The record.** Each leg is the per-night actuation record plus its name (`leg`: `cost` or `backup`; `windowKind`; the announced level and expected kWh, the consent ceiling a morning refresh may lower; the refresh and missed-apply stamps), so every per-night rule holds per leg. One leg is ACTIVE — the one the actuator ticks drive, held in the same in-memory record every reader always used. The file keeps the active leg at its top level, in the shape every earlier release reads, plus `pendingLegs` (armed, nothing written) and `trailing` (below). A release from before the cycle record reads the top level and ignores the rest: rolled back, it still finds, reverts and switches off the active leg, and drops only a pending leg (dropping it can only cancel a write) and a trailing leg (an OFF already sent, waiting to be read back). A file it writes back reads as a one-leg cycle. The coerce fails closed: a leg name it does not know reads as the backup, which never force-charges; a pending leg of another plan date is dropped.
- **`legResolved`** lets the next leg go: the leg is finished (cancelled, restored, settled as someone else's reserve, or past its apply window with no write), it holds nothing of ours on the device (`armOpenItem`: no applied write unrestored, no restore unread back while the panel reads the target or nothing, no force-charge ON with its OFF unverified, no attempt confirmed neither way unless it is proven never to have landed), and its restore and force-charge OFF have read back. `armOpenItem` is the refusal `armFromPlan` makes and the first thing `armRefusalReason` names, one function, so promotion within a cycle and arming the next one refuse on the same facts. An unconfirmed write therefore blocks promotion, and the active leg's ADOPT can still revert it. The panel's force-charge ceiling is not a condition: an original not yet restored travels on to the next leg (`carryCeilingPrior`), as armFromPlan has carried it to the next night since force-charge shipped.
- **Promotion** (`promoteCycle`, the cycle step at the start of each actuation tick, on a fresh reserve readback): a resolved active leg hands over to the first pending one; a trailing leg that has resolved leaves first. A leg whose apply window passed with no write is resolved at the moment its missed-apply push falls due, so it is promoted only once that push is stamped: it never leaves the cycle unannounced. A leg still unresolved when the next one's apply window passes leaves that one missed.
- **`armCycle`** arms the legs against the record in place. The first leg is armFromPlan against the active leg, so a one-leg cycle refuses exactly what armFromPlan refuses, with `armRefusalReason`'s words, and carries the ceiling original it carries; later legs arm from an empty record and the first armed leg owns the ceiling's restore. A backup leg never force-charges: its cost ceiling is dropped and force-charge never rides it (and the force-charge step reads the option per leg). The whole cycle persists only once an announcement channel delivered it, as the one-leg arm always has, with the trailing leg as the ticks left it while the announcement was awaited (`withLiveTrailing`).
- **Trailing.** A backup leg is reserve-only, so a prior leg whose only open item is its force-charge OFF does not stop it arming: that leg moves to `trailing`, which keeps its OFF verification, its re-sends and its ceiling restore, driven each tick by the same decision (`decideForceCharge`) with force-charge disabled — it can only switch off — and with its own escalation record. The cost leg waits for it, and an open trailing leg refuses the next cycle. With no SHP2 or with the master switch off it is still driven, as the active leg's OFF is.
- **Supersede** compares legs (`supersededLegs`): the active leg by the rule the evening job has always applied, and a pending leg only before its apply window passes; a pending leg's `superseded` disposition is stamped once the cycle replacing it is persisted. A prior arm cancelled by tonight's hold takes its pending legs with it.
- **The missed apply** (`missedApplyDue`): a leg the overnight-only cycle never had — a mid-day leg, or the backup before one — whose apply window passes with no write sends one info push, "Today's 10am–3pm charge did not start — the panel did not report its backup reserve. Nothing was written; the reserve stays at 16%." (`buildNightChargeMissedApply`; the reason is `missedApplyReason`: the leg before it still holding the reserve, then the apply guards in `decideActuation`'s order). It is stamped on the leg before it goes, whatever the guard readings say, and recorded as the leg's `arm_disposition`. An overnight backup's push says "Tonight's 12am–5am outage backup did not start". An overnight cost leg with no line ask keeps its single warning for a write that never took effect.
- **Drift attribution per leg** (`legDriftActive`): the overnight leg keeps the rule settings-drift has always applied (applied and unrestored, armed and uncancelled, or restored within 15 minutes), but for a night whose reserve settled as someone else's, whose later changes are theirs. A mid-day leg is armed at 21:30 for a 10:00 write, so its armed span is not attributed: only its apply window, from 10 minutes before the open to 30 after, and its write from the attempt to 15 minutes after the last restore attempt. The trailing leg's force-charge re-sends are attributed like the active leg's. A leg that leaves the cycle — the leg a promotion moves on from, or a trailing leg done — leaves on the tick its restore or OFF reads back, a drift tick or two before settings-drift confirms that change; it is kept for `DRIFT_TAIL_MS` after it left (`DepartedLeg`, in memory), in both the reserve attribution (`cycleDriftLeg`) and the force-charge one (`forceChargeDriftLeg`), so the add-on's own restore or OFF is not pushed as an external change. With one leg nothing departs.
- **The ledger, per leg** (`legLedgerFields`): the row's own stamps hold the cost leg; a backup leg's apply, restore and disposition go to `backup_actuated`, `backup_applied_at_ms`, `backup_reverted_at_ms` and `backup_arm_disposition` — the evening job's supersede and stale-cancel stamps of the active leg included, so a backup leg's disposition and its cost leg's keep their own columns. The cost leg's force-charge stamps and its first revert-deadline page are recorded too (chapter 15 part 3, "The learning ledger").

#### The mid-day cycle in shadow (`middayShadow.ts`)

Until the mid-day switch the add-on arms the overnight cycle only, and computes the winter mid-day cycle beside it so the mid-day cycle can be judged on real days before it writes anything. Nothing of the shadow is armed, written, pushed or spoken; it has no device, push or speech path to call.

- **When.** A minute tick (`runMiddayShadowTick`, single-flight) runs once the evening job has latched the day, inside the evening job's window (21:30–23:00 on the preset). It asks the chooser with the mid-day window and the configured objective and cost ceiling (`shadowCycleConfig`). A cycle that is not mid-day — Friday, Saturday, a holiday eve, summer, the season grace, a configuration without a cost objective or with `ARB_COST_MAX_SOC_PCT` at or below 50 — is recorded with its reason and nothing is sized.
- **The legs** (`runMiddayShadowEvening`). The backup leg is sized first on option A (`backupLegSizing`): its walk runs from its close to the next overnight open, and it arms when that walk dips under reserve + cushion (chapter 15 part 1, "The leg"). The cost leg is then sized from the pool the backup protects — the backup's hold only when the backup would arm — with C_mid under the Cores' charge taper and its PV surplus from the close to the on-peak start (`costLegSizing`). Both use the planner the live plan uses (`recomputeNightChargePlan` with a shadow leg), which for a shadow leg returns the plan only: it sets no plan holder, writes no plan snapshot and logs no calibration change, so the night-charge entities, the card and the status keep the live overnight plan.
- **Would it arm** (`shadowArmProbe`): `armCycle` against the cycle record in place, on the backup alone and then on both legs, the way the evening job would arm them. `armCycle` is pure and its cycle is dropped; only the verdict leaves (which legs armed, and the refusal words of those that did not). In `advisory` mode nothing is armed, and the record says so. A cost leg the planner held on the re-entry line (chapter 15 part 1, "The leg") is recorded as held for it, with its level and the line.
- **What a held reserve sends to the grid** (v1.192.0, `heldImportEstimate`). The SHP2 does not discharge the pool below its backup reserve, so while a leg's write holds it — from the write at the window open to the restore (`heldSpan`: the close, or the on-peak guard when that is sooner) — house load the pool would have carried down to the owner's reserve comes from the grid, at that hour's rate. Each sized leg is walked twice over its hold on the median load and PV of the band it was planned on, the way the planner's grid-present carry walks the pool (PV into the pack, load out of it over the discharge efficiency, clamped to the floor and to full): once held at the reserve it would write (lifted to it at the open), once at the owner's reserve, from the pool expected at the open. The load the held pool's floor turns away beyond the other's is the held import, in house kWh; the lift itself is the leg's own draw and is not in it. It is priced hour by hour at the tariff's rates, and credited with what the next charge no longer buys: the energy the pool kept (not what a full pool spilled), over the charge leg's efficiency, at the cycle's cost window rate. Their difference is what the hold adds to the bill. On the overnight-only cycle the hold and the charge share one cheap window and the difference is small; on the mid-day cycle option A's backup (written 50, held 23:00–05:00) puts house load on the 12.59¢ overnight rate that the 8.2¢ mid-day charge would otherwise have bought back — on the 2026-10-14 fixture about 9.3 kWh and $0.30 a weeknight, against about 0.6 kWh and $0.02 for option B (written 40), while the mid-day leg's own hold under the sun sends nothing. The figure is an estimate on the median forecast and nothing measures it yet: on a shadow night no hold is written (the live overnight leg runs instead), so the night's metered import cannot grade it until a hold is actually written. A leg that writes nothing, or a hold the band does not cover hour for hour, has none, and with rates not confirmed the energy is stated and nothing is priced.
- **Option B beside A** (v1.192.0): the backup is sized a second time on option B (`backupLegSizing` with the cost window's open as its horizon), after both legs, so the backup-horizon choice is made on real nights: its reserve, its draw, its walk and its held import. It is never probed, armed or announced, it anchors nothing (the cost leg is sized from option A's hold), and a planner that has nothing for it leaves it null rather than deferring the evening.
- **The morning refresh, computed** (`refreshLeg`): from 30 minutes before the cost window opens, on a fresh panel reading, the cost leg is sized again. What the evening announced is the consent ceiling of every written value, the level and the reserve held from the open: the refresh may lower or cancel, never raise — a refreshed level or reserve above the announced level, or a refreshed T_mid above the announced one, is recorded `capped` with every figure as announced (the worst case too: the re-plan's was sized on a level or reserve that will not be written) and no expected draw (the rule the live refresh uses, `refreshLeg` for both); otherwise the refreshed stop and T_mid, at most the announced ones (a figure the re-plan does not give stays as announced); a hold is `cancelled`. No refresh by 5 minutes before the open records `stood` (the evening plan stands). When the live overnight leg of the same evening wrote to the panel (its reserve raise applied, or its force-charge switched on: `liveOvernightWrote`), the 09:30 pool is not the one a mid-day cycle would have had — the live leg has filled it toward its own ceiling, often 30 points or more above a mid-day 10:00 open — so the refresh is not re-sized: it is recorded `not-comparable`, with no refreshed figures and that reason, and the entities and the card keep the evening's figures. Since v1.205.1 a cycle the evening would not arm (a write mode whose arm probe refused the cost leg, `shadowCycleRefusal` — the cycle whose 21:30 words say the add-on will not charge) is never re-sized, whatever the live leg did: from 30 minutes before the open its refresh is recorded `not-armed` (`notArmedRefresh`), with no push and the reason "the evening cycle would not arm (…), so there was nothing to refresh"; the record keeps the evening's figures, which the `shadow_refreshed_*` columns and the entities carry beside the `not-armed` disposition (`shadow_refresh_disposition`, `midday_charge_refresh`), but no word says they stand: they are the figures of a cycle that was not armed, so the log line states none and the card's row reads "Morning refresh 09:30: none — the evening cycle would not arm (…), so there was nothing to refresh"; before it, from the evening, the card's row reads "none" rather than "due" and `midday_charge_refresh` reads `not-armed` rather than `pending`, in either write mode; it used to be re-sized like any other, and could log "a live refresh would push this" beside a refresh push ending "Cancel from the charge card before 10:00 AM". A re-sized refresh records whether a live refresh would push (a cancel, a changed written value, a cap, or an expected draw moved by more than 25%), and pushes nothing. The record is re-read after the planner's await and persisted before it is logged. A re-sized refresh also records how old the weather it was sized on was (`weatherAgeS`, the ledger's `shadow_refresh_weather_age_s`): the shadow asks the analytics worker for no particular age, so it sees the worker's cache as it stands (weather up to 2 hours old), where the live refresh asks for at most 45 minutes (below).
- **The words it would say** (`middayShadowPreview`, chargeText.ts through chargeAnnounce.ts). The evening's record is turned into the 21:30 push and spoken notice the mid-day switch would send for it, and the refresh into the push a live refresh would send. Both are logged — "the 21:30 push would read (not sent)", "the notice would be spoken (not spoken; N of 560 characters)", "the refresh push would read (not sent)" — and the evening's is served on the status as `middayShadowPreview`, whose title the card's read-only section shows. None of them is sent or spoken.
- **Where it goes.** Its own file (`.night-charge-midday-shadow.json`, beside the database); the log, every line tagged `night-charge[midday-shadow]:` (each leg's line and the refresh's end "Shadow only", the preview lines say "not sent"); the evening's ledger row, as the `shadow_*` columns (only onto a row the evening job recorded — a shadow never creates one); the `ecoflow_midday_charge_*` entities (section 9); and the card's read-only section.

#### The mid-day words (`chargeText.ts`, `chargeAnnounce.ts`)

A day-aware formatter reads every time a mid-day text states from the leg's resolved window, never a literal: the window as "tomorrow 10am–3pm" or "tonight 11pm–5am" (named from the moment the text is written — "tonight" for a window that opens this evening or in the small hours after it, so Sunday's Monday 00:00 backup is tonight; "today" and "tomorrow" by the site-time calendar; the weekday beyond), the refresh time (the open − 30 minutes), the cancel deadline (the write moment), the restore (the close, or an hour before on-peak if that is sooner) and the on-peak span from the tariff ("4–7pm"). `chargeAnnounce.ts` routes by the leg's window kind: an overnight leg — every leg until the mid-day switch, and every record from before the cycle record — gets the overnight words, built by the same builders with the same arguments as before; only a super off-peak leg gets these. A golden test holds every overnight shape (the 21:30 push and speech in each shape, the summary for every force-charge outcome, the revert-deadline page in every stage, and the missed-apply push, whose clocks are now the formatter's) to the words captured before the formatter existed (`overnightTextGolden.test.ts`).

- **The 21:30 push.** "Charge plan: charging to ~90% tomorrow 10am–3pm, about 34 kWh"; the body names the window and the period, the expected draw, the 9:30 AM refresh ("it can only lower or cancel this charge"), the supervised write ("at 10:00 AM the backup reserve is held at 50% and Charge Now switches on just in time; both are restored at 3:00 PM, before the 4–7pm on-peak") and the cancel deadline, then the outage backup's own line when it arms ("Tonight 11pm–5am, outage backup: reserve held at 50%, about 2 kWh expected; cancel it separately on the card before 11:00 PM."), the cushion note when a leg cannot hold it (since v1.205.1 a leg's "the outage line is above … and no force-charge carries it on this leg" — or "on the backup leg" — is worded by that leg's own line, as the overnight envelope note is: a line at or below 50 (49.00–50.00 on the fixture year's plans) is above "the 49% the panel holds the pool at under the 50% it accepts as a reserve", each leg by its own line and never the other leg's, the backup leg's line reaching the words from the record's `cushionLineSocPct` (`MiddayBackupText.linePct`); above 50, or a record with no figure, word for word as before; the shadow's evening log line for the backup leg alike), and last a labelled sizing-basis line with the islanded worst case of each leg. A reserve held with no charge expected, "toward" a level the window cannot reach, advisory ("recommended", nothing armed), refused (nothing armed and why — and "there is no outage backup tonight because …"; since v1.205.0 a leg with a line ask says there "this leg's outage line is above the 50% the panel accepts as a reserve, and nothing is armed to carry it" — beside the 49% the panel holds for a line in (49, 50]: "above the 49% the panel holds the pool at under the 50% it accepts as a reserve" — in either write mode, never the armed leg's note; since v1.205.1 a cost leg with no line ask and no envelope note whose cushion asked for energy says "NOTE: nothing is armed to hold this leg's 31.3% floor+cushion line — residual risk remains." — the line the record carries for it, `cushionAskedLinePct` (optional: a record from before it reads as before) — after the caps note and before the backup leg's), a daytime hold with or without the backup, and an incomplete basis each have their own shape. Since v1.196.0 the incomplete-basis shape names the gate that refused the cost leg's plan, as the overnight push does ("No charge plan for tomorrow 10am–3pm — the forecast/telemetry basis is incomplete: PV band coverage 72% < 78% (…), so nothing will be charged."): the shadow record keeps it on the leg (`basisBlockedBy`, beside the disposition's "not armed — the plan basis is incomplete (…)"), and a record from before v1.196.0 reads as before.
- **The spoken notice** (English, then the Spanish second pass), within the 560-character bound in every shape: the daytime charge alone ("Charge notice. Tomorrow from 10 AM to 3 PM, charging the backup pool to about 90 percent, about 34 kilowatt hours. Cancel on the Power panel before 10 AM tomorrow.", 359 characters with the Spanish); with a backup expected to draw under 5 kWh, one clause more ("Tonight the reserve is held at 50 percent as outage backup.", 485); with a larger backup, both legs with their windows and both cancel times (501), where "toward" stands for a window-bound charge. The cushion clause is spoken whenever a leg cannot hold the cushion. A shape that would run over the bound drops, in order, the window clause and the backup's energy figure (or says the backup clause compactly), and the last shape (no energy figure, no window clause) is within the bound by construction; none drops a level, a cancel time or the cushion clause. A figure there is not is left unsaid, never spoken as a placeholder: the level falls back to the reserve the write holds, as the overnight notice's does. Nothing is spoken when nothing arms.
- **The refresh push** (never spoken): "Charge plan updated: still ~90% today 10am–3pm, now about 22 kWh (announced last night: about 34 kWh) — the morning solar forecast for the window is higher (~14 kWh, was ~9 kWh)." — lowered, capped ("a refresh never raises an announced charge"; a cap from the reserve alone: "calls for a higher reserve (45%) … with the reserve held at 30% from the open"), cancelled ("nothing will be written, and the reserve stays at 16%"); none when the refresh would not push.
- **The summary** at the restore: "Charge (Thu 10am–3pm) completed: reserve held at 50%, and Charge Now switched off at ~90% at 2:41 PM (about 34 kWh expected); the reserve was restored to 16% at 3:00 PM, before the 4–7pm on-peak." The expected figure rides only beside the legs it counts, as the overnight summary's does; a cancel or a grid-loss stop is not a completed charge. It goes when the restore reads back, as the overnight summary does (v1.189.0 review, `restoreSummaryDue`); with no readback once the grace has run, it says "the restore to 16% was sent at 3:00 PM … (the EcoFlow cloud acknowledged it), and the panel has not read it back yet".
- **The critical page** for a restore that has not read back: "Critical. The 10 AM to 3 PM charge could not be confirmed stopped: the panel is not reporting its reserve, and on-peak pricing starts at 4 PM. Set the backup reserve to 16 percent and switch Charge Now off in the EcoFlow app." — Charge Now only when its OFF has not read back; within the bound in every stage (the on-peak page with a reading is said compactly, and a last shape, the reserve to set and why in the fewest words, is within it by construction).

Until the switch the 21:30 words reach only the shadow's preview; the summary and the critical page are wired ahead of the overnight calls for a super off-peak leg, which nothing arms. The missed-apply push (above) shares the formatter's clocks.

#### The morning refresh (`morningRefresh.ts`)

The live refresh of an armed mid-day cost leg, built and inert until the mid-day switch: `liveRefreshDue` finds a leg only when the cycle's active leg is a super off-peak cost leg, and nothing arms one — every overnight leg, of every shape, is refused at its first test, and the minute tick (`runMorningRefreshTick`, single-flight) returns there.

1. **When.** From 30 to 5 minutes before the open, for an announced leg with nothing attempted, not cancelled and not refreshed, with no trailing leg still open (a cost leg still pending behind an unresolved backup is not refreshed). From 5 minutes before the open with no refresh made, the evening's arm stands, stamped once.
2. **The forecast.** The leg is re-planned on its own window (the planner's pinned leg: the plan is returned only — no plan holder, no snapshot) on a fresh panel reading, and on a forecast built on weather at most 45 minutes old (`REFRESH_MAX_WEATHER_AGE_MS`). The analytics worker keeps its own caches (weather 2 hours, the day forecast 30 minutes, the band 15 minutes); the planner's `forecast` and `probabilisticForecast` reports therefore take `maxWeatherAgeMs`, which re-fetches older weather (`getWeather`'s `maxAgeMs`) and rebuilds a cached forecast built on other weather (`getDayForecast`'s `maxWeatherAgeMs`), and the forecast and the band say when their weather was fetched (`weatherFetchedAtMs`). A request without it — every other caller — is served exactly as before. A failed fetch leaves the stale weather in place; a forecast whose weather is older than 45 minutes (or of unknown age) defers the refresh to the next minute.
3. **Re-read** after the await (`refreshAborted`): a leg re-armed, cancelled, attempted or already refreshed meanwhile is not refreshed. The await can outlast the minute it started in, so everything after it reads the clock after it: an answer that arrives 5 minutes or less before the open is dropped unwritten (`refreshPastDeadline`), and the next tick stamps the arm standing.
4. **Lower only** (`liveRefreshOutcome`, `refreshLeg` against the announced level, the armed reserve and the announced expected draw). What the evening announced caps every written value, the reserve as well as the level, since the push said what the reserve is held at: a hold cancels the leg; a lower need lowers the written reserve and the force-charge ceiling (dropped when the re-plan needs none); a higher level or a higher reserve is recorded `capped` and writes nothing, its expected draw is not stated and its worst case (`refreshed_buy_kwh`) is the armed one (both re-plan figures were sized on values that will not be written) — `refreshLeg`'s rule, so the shadow records what this refresh would do; a leg with no announced level stands. Whether it pushes is judged on the values it will actually write. It never re-arms: an arm would erase a cancel.
5. **Stamped before it speaks.** `refreshedAtMs` — with a lowered reserve and ceiling, or the cancel — is persisted with the leg before anything is pushed, so it runs once, across a restart too; the ledger's `refreshed_at_ms`, `refreshed_level_pct`, `refreshed_reserve_pct`, `refreshed_buy_kwh`, `refresh_disposition` and `refresh_weather_age_s` are stamped on the evening's row.
6. **A push, never speech**, on a cancel, a changed written value, a cap or an expected draw moved by more than 25% either way (the refresh push above).

---

