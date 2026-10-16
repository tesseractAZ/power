### 8. The write-readiness gate (`computeNightChargeReadiness`, `nightChargeGate.ts:219`)

A pure reduction over the ledger (no I/O, `nowMs` injected) into one of three states — `LEARNING` / `READY_TO_CONSIDER_WRITES` / `BLOCKED` — plus `writeReady` and a human-readable `blocking[]` list. It gates **only on physically-measured prediction accuracy**: there is deliberately *no* savings term (no valid counterfactual exists pre-write, so a savings gate would certify a number the system cannot observe). Recomputed over `readNightLedger(400)` on every tick, evening job, and warm-up.

**Thresholds are pre-registered and frozen** — never tuned on the season they gate (garden-of-forking-paths); a re-tune bumps `CURRENT_ALGO_VERSION` (currently **3**: v1.105.0 redefined `buy_err_kwh` onto the planner-sizing basis, so v2 rows' values are not comparable and are excluded, resetting the evidence clock; v2 was the v1.49.0 charge-only-cap sizing correction, which invalidated every v1 row) and resets the readiness clock. Rows are filtered to the current algo version by **string** comparison (`recordNightPlan` persists `algo_version` as SQLite TEXT; a numeric compare never matched a real row and left the gate permanently stuck). Prior-version rows are *excluded*, not tagged.

**The v2 evidence base is ACTUATED nights** (v1.50.0). The v1 gate scored a night only on a "clean islanded baseline" (near-zero window import) — on a grid-tied home the SHP2 carries the house on grid at the floor and imports every night, so `scoredDays` was structurally 0 and the gate could never open. v2 splits the evidence into two pools:

- **Actuated pool** — current-algo rows with `actuated=1` ∧ `scored=1` (a bounded reserve write was applied, §8b, and its delivery measured, §7). Feeds the under-buy rate, the sizing bias, and the graduation night count.
- **Forecast pool** — current-algo, outcome-captured, `confidence_tier='forecast'` rows. Feeds PV/load accuracy and band coverage (those columns are recorded on every captured night regardless of the realized-need `scored` flag). v1.187.0: the PV figures (`pvMae`, `pvBias`, `pvBandCoverage`, the effective-N residual series) and the verdict-bearing sample (`coverageNights`, the informational joint) read only rows whose `pv_verdict_set_aside` is NULL — a band built for other Cores than the actuals is not forecast-skill evidence (§6 "PV EVIDENCE"). Such rows are counted in `pvVerdictsSetAside`; the load figures are unaffected. **An incomplete-basis night is not set aside for that alone**: a plan refused for a lasting forecast failure (2026-09-11: "PV band coverage 72% < 78%") is exactly the evidence this gate grades, and dropping those nights would raise PV coverage by survivorship. On the 2026-09-29 ledger the one set-aside row moves PV coverage 33/36 (0.917) to 32/35 (0.914) and `coverageNights` 36 to 35; no verdict changes.

**HARD failures ⇒ `BLOCKED`** (evaluated first):

| Gate | Rule |
|---|---|
| Engine-fault strikes | A strike requires the plan to have **claimed hold** (`cushion_shortfall` falsy — a NULL/legacy row still counts as claimed, fail-closed) AND either the plan's own simulated trajectory breached floor+cushion (forecast-tier rows, §3.3) or an actuated night's **realized** outcome breached (`cushion_breached`, any tier — a delivered buy that still breached is fault evidence regardless of forecast basis). A plan that honestly disclosed `cushionShortfall` is physics, not fault — exempt. Strikes count within a rolling `STRIKE_WINDOW_DAYS = 45` window and clear after `STRIKE_CLEAR_STREAK = 14` consecutive strike-free actuated nights — escapable by demonstrated performance, never by waiting alone. |
| `buy_err_kwh` basis | **v1.105.0 (algo v3)** — the PLANNER-SIZING basis: `buy_err = planBuy − (planBuy + netMiss/legEff) = −netMiss/legEff`, where `netMiss = (forecastPv − actualPv) + (actualLoad − forecastLoad)`. It answers exactly one question — *did the planner size the buy correctly?* — and contains no delivered term, no trough and no reserve setpoint. The prior definition was `planBuy − (delivered + troughDeficit)`, the difference of two questions: it counted the actuator's by-design over-delivery (29-41 kWh against 21-22 kWh plans) as under-buy, and anchored on a 16 h post-window trough that is really the reverted `backupReserveSoc` (a fixed −14.9 kWh at a 10 % trough). Across four live nights that was −62.13 kWh of residual, 52 % over-delivery / 48 % trough, producing a 56 % under-buy rate no forecast change could move. Actuated and advisory nights share the basis — one column, one meaning. Delivery quality is a separate question. |
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

**Effective N** (`effectiveSampleSize`, `nightChargeGate.ts:174`): `n·(1−r₁)/(1+r₁)` with lag-1 autocorrelation `r₁` computed over the PV residual series (fallback: load residuals, then the raw count), clamped to `[0, 0.99]` — a cloudy stretch is several *correlated* bad nights, so raw count over-counts evidence; negative autocorrelation is clamped to 0 so it can only ever reduce, never inflate.

**The MNAR denominator is *expected* nights, not captured rows** (v1.39.0): nights that never produced a ledger row at all — add-on down at the evening job, SHP2 cloud-offline, the documented *adverse* failure modes — must count as exclusions; keying the fraction on captured rows let exactly those nights vanish from both numerator and denominator. Expected range = every Phoenix calendar date from the first current-algo plan (bounded to a trailing 120 days) through the most recent *completed* night — the Phoenix date of `now − 45 h` (plan `D` completes at `D+1 21:00`). `exclusionFrac = max(0, expected − distinct scored plan-dates in range)/expected`. Phoenix dates are built from `en-US` `formatToParts` (v1.39.1) — the `en-CA` `format()` shortcut silently falls back to a non-ISO shape on a small-ICU Node, cascading into a swallowed throw and a permanently-null readiness.

`nightChargeGateFields` flattens the result for the state payloads; on a null readiness it emits `night_charge_readiness: 'unknown'`, **`night_charge_write_ready` strictly `false`**, and every diagnostic null. v2 note: `night_charge_plan_nights_scored` counts scored **actuated** nights.

---

### 8b. Supervised write mode (`nightChargeActuator.ts`, v1.50.0)

When `NIGHT_CHARGE_MODE` is `supervised` (or `auto`), each charge night runs one bounded, announced, cancellable, auto-reverting reserve write. The decision core is pure (`decideActuation` — all clocks injected, unit-tested against every guard); the integrator executes decisions through the audited write helper and persists every transition to a restart-surviving state file (`.night-charge-actuation.json`, atomic write, in-memory mirror).

**The nightly flow:**

1. **Announce + arm (~21:30, inside the evening job).** When the recorded plan is a charge with a complete basis, a resolved window, and a positive buy, the actuation candidate is computed **from the announced plan** — a fresher recompute never silently substitutes a different buy, because the owner's cancel window runs against the announced numbers. The evening notification names the write, the clamped target, and the cancel deadline; the audible broadcast channel announces the same (no phone-push dependency). The armed state **persists only after at least one announcement channel confirms delivery** (`NOTIFY_CHANNEL` other than `none`, or a successful audible announce) — a write the owner never heard about cannot fire; an undelivered night stays advisory and logs at error level, and (v1.187.22) the evening job records it like a refused arm ("the announcement could not be delivered", `eveningNotArmedReason`) so the card leads with "Planned charge not armed tonight — the announcement could not be delivered." — unless the record left in place is an arm for the same window that will still write (Saturday's arm for the Monday window Saturday and Sunday share). Since v1.187.22 the arm also stamps whether force-charge rides the night (`forceChargeRides`: force-charge enabled and the armed ceiling above the reserve maximum — the evening push's condition, and the gate the plan's expected figure was made with); the evening push names the force-charge from that stamp, and the morning push reads it back. The arm also stamps the start of the on-peak period that follows the window open (`nextOnPeakStartMs`, from `chargeWindows.nextOnPeakStartMs` on the same tariff model the window comes from), the anchor of the on-peak guard (item 3). Arming is refused while a prior night is unresolved (applied-unreverted, or an unconfirmed attempt not provably un-applied — a raised reserve is never orphaned or buried); a night whose reserve settled as someone else's (the foreign rule, item 3) is resolved.
2. **Apply (at the window open, tolerance +30 min).** v1.187.0: `APPLY_LEAD_MS` is 0 (it was 5 min). The reserve raise is a grid charge the moment it exceeds the pool, and the panel takes the write within seconds: on 2026-09-28 the write landed at 22:55:28 and the Cores took ~5.2 kW each from 22:55:42 — 1.12 kWh at the off-peak rate before the 23:00 overnight rate (09-22: ~0.85 kWh). The write moment is also the announced cancel deadline, so the owner's cancel window now runs to the window open. Force-charge keeps its order (reserve applied → readback-verified → ceiling synced → ON, never before the window opens); its ceiling sync already waited for the open, so it follows the verified reserve one tick (~1 min) later than before. The attempt is a **write-ahead intent**: the state file records the attempt and its pre-write baseline BEFORE the device call. One write raises `backupReserveSoc` to `min(round(targetSocPct), RESERVE_WRITE_MAX_PCT)` (`clampReserveTarget`; `RESERVE_WRITE_MAX_PCT` = 50, the SHP2's own reserve ceiling — proven on the device 2026-09-16, v1.164.0) — validated (not silently clamped) into the `[RESERVE_WRITE_MIN_PCT, RESERVE_WRITE_MAX_PCT]` = `[10, 50]` write envelope by `setBackupReserveSoc` (`ecoflow/commands.ts`), which imports the bound from `nightChargeActuator.ts` so there is exactly one definition, the same documented `PD303_APP_SET` shape the cloud-presence refresh has round-tripped since v0.9.10, audit-logged under `night-charge-reserve` with a 5-min retry cooldown. Every apply guard fails closed: advisory mode, a cancelled night, a red alert condition, an incoherent SoC read (I11), an unknown/out-of-range current reserve, a missed window, the on-peak guard (from `ON_PEAK_RAISE_GUARD_MS`, 60 min, before the stamped on-peak start: `onPeakGuardActive`), or a target at/below the current reserve ⇒ no write. The apply's re-issues stop the same way: none within `APPLY_VERIFY_AFTER_MS` of `writeWindowEndMs`, the window close or the guard, whichever is sooner. The row is stamped `actuated=1` at write time. **Lost-confirmation adoption:** when an attempted write reports failure but the live reserve later reads back exactly the attempted target (≠ the attempt baseline), the write is proven applied — the actuator adopts it (applied state stamped from the attempt baseline) and the normal auto-revert takes over. **Device-ceiling adoption (v1.161.0):** when the reserve reads back *between* the attempt baseline and the target and still does after `APPLY_VERIFY_AFTER_MS`, the panel took the write but settled short — of its own accord, or because the owner moved the slider. That is a real partial actuation, so `deviceCeilingPct` adopts the achieved value AS `targetPct` (the original ask is preserved in `requestedPct`) and stamps the apply verified. Without it a short readback is indistinguishable from the 2026-08-16 phantom: both retries burn and the night ends on `applyFailed`, which pages "tonight's buy is forfeited" and corrects the ledger to `actuated:0` — while the reserve is genuinely raised and the buy is genuinely happening. A reserve that did **not** move still takes the phantom path, unchanged.

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
   without it. It used to name "force-charge toward ~80%" from the armed ceiling and the
   option alone (`armedForceChargeStopPct`), on nights the force-charge never ran. The
   force-charge ON-failure warning (`buildNightForceChargeOnFailure`, "Night-charge: force-charge
   did not take effect") names where the force-charge stops — "Tonight's buy above the 50% reserve
   (toward ~80%) will not happen" (`forceChargeStopPct`), where it named the 80.4% ceiling — and
   adds "on those slot(s)" on a partial failure. A night
   expected to charge nothing reads "the reserve was held at 50% overnight as a floor (no charge
   was expected)", and the apply-failure warning calls it a reserve hold. A restore that ended the night early is not reported as completed: an owner
   cancel after the write ("Night-charge: cancelled — reserve restored to 16%") and a grid-loss
   abort ("Night-charge: stopped (grid lost) — …") say so, with no figure. The armed record's
   `buyKwh` is the worst case and is never pushed;
   only the log lines name it, labelled (`buyFiguresLogText`). The `vitalsRed` gate is HOST-vitals (struggling
   process), not alert-condition — documented as such after the 08-17 audit.
   Harness: `scripts/mutate-actuation-readback.mjs` (5 mutants).

3. **Revert (at the window close, or immediately on a post-apply cancel or a grid loss).** v1.187.0: `REVERT_LAG_MS` is 0 (it was 5 min): a pack still under its target at the close kept grid-charging at the off-peak rate until the restore. The revert readback verification and the settling grace (`REVERT_VERIFY_AFTER_MS`, `REVERT_READBACK_GRACE_MS`) are measured from the revert itself and do not move. **Force-charge's OFF goes first on that tick** (`actuationStepOrder`, nightForceCharge.ts): whenever a force-charge OFF is due on the night's own record — window closed, no window, cancelled, or reserve already reverted (`forceChargeOffDueNow`) — the tick runs the force-charge step before the reserve step; otherwise the reserve step runs first, so the START still rides the reserve it just verified. Each step runs in its own try (`runActuationSteps`), in either order. Without this the OFF waited behind the revert PUT (writes carry no timeout of their own; undici's 300 s default applies) and the morning summary while the Cores kept grid-charging at 16–19 kW. Both are OFF-direction writes, so neither order can raise a charge. The restore stamps `actuation_reverted_at_ms` on the ledger row (the delivered-energy span's end, §7). The prior reserve value is restored. The revert path is mode-independent — it runs even if the owner flips the option back to advisory mid-night — and refuses an invalid restore value. After `REVERT_ESCALATE_AFTER = 3` consecutive CLOUD-REJECTED writes it annunciates a critical (audible + HA notification) once and keeps retrying; the floor/runway/SoC alarm spine is fully independent throughout. A successful revert sends a morning summary notification — not awaited (v1.187.0): an info push (5 s headers + 10 s body per target) never holds the tick.

   **v1.131.0 — revert readback.** The revert stamped `revertedAtMs` the moment the cloud
   ACK'd, which is exactly the evidence v1.79.0 ruled insufficient on the apply side, and
   the revert branch is gated on `revertedAtMs == null` — so the stamp also stopped the
   actuator looking at the panel at all. A restore the SHP2 accepted-then-ignored therefore
   left the reserve pinned at the raised target with the ledger recording a clean, completed
   night. That is the expensive end state: the panel holds the raised value as its floor, so
   it buys grid at on-peak instead of discharging the pack the plan had just paid overnight
   rates to fill, and the floor alarm reads a false AT-RESERVE-FLOOR posture. A reverted
   night now verifies against the DEVICE: reading the restored floor stamps
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
   foreign (`foreignSettled`, `foreignStep`): nothing more is written to the reserve, the force-
   charge riding the write switches OFF (reason `foreign`), the night is resolved for the next
   arm, the posture no longer reads it as raised by the add-on, and an info push says what the
   reserve reads. A different value restarts the count; one of the add-on's own values clears
   it; a null or out-of-envelope reading is no evidence either way, and the clock-driven restore
   goes ahead blind over it. One sighting does not hold the restore. After the restore was sent,
   the same rule ends the wait for it to read back. Before the write reads back, a short reading
   stays the apply ladder's (device-ceiling adoption). Cancel answers 409 on a settled night.

   **revertDeadline.** Every other revert escalation needs evidence: three cloud-rejected
   writes, or the raised target read back after the re-issues. A panel whose readback goes dark
   at the close gives neither. `decideRevertDeadline` needs only the clock: while a write of ours
   may still hold the reserve (`revertOutstanding`: applied, or attempted and never confirmed;
   restore not read back; not foreign) and the live reading is the target or nothing, it pages
   once at `revertDeadlineMs` = min(window close + `REVERT_DEADLINE_AFTER_WINDOW_MS` (30 min),
   on-peak start − `ON_PEAK_PAGE_LEAD_MS` (30 min)) and once more at the on-peak start. Any other
   reading is the owner's and pages nothing. The page is a critical announce in English and
   Spanish (`revertDeadlineSpoken`) and a critical push (`buildNightChargeRevertDeadline`); with
   no reading both say the restore could not be confirmed, never that the reserve reads raised.
   Each stage is stamped on the record before it is said (`revertDeadlinePagedAtMs`,
   `revertDeadlineOnPeakPagedAtMs`), and it is decided ahead of the no-panel return, so a panel
   missing from the device list still pages. Broadcast quiet hours apply to the spoken page as to
   every critical announce; overnight the 05:30 page is pushed, and the on-peak page is spoken.

   **heldByChargeWrite.** The on-peak money detectors stay silent near the reserve, because near
   the owner's floor buying on-peak is outage protection. A restore that did not take leaves the
   night's target as the panel's reserve; past the restore (`chargeWriteHold`), with the panel
   still reading exactly that target, both detectors measure against the prior floor
   (`moneyDetectorReservePct`; energy and cost chapter, the grid-to-battery and idle-pool
   notices). The runway and below-reserve alarms are unchanged.
4. **Score.** The scorer's actuated branch (§7) measures the delivered buy as the energy into the home Cores on the house panel's source channels (`deliveredIntoCores`, v1.187.3; window grid import minus the concurrent house load before it) and records `delivered_kwh` with `delivered_basis`, read by the buy de-bias learner (§15.12). v1.187.0: over the span the write was held (`deliveredHoldSpan`), which ends at the restore the actuator stamps on the row (`actuation_reverted_at_ms`, a ledger column since v1.187.0, NULL before it) plus the device settle — §7 "Realized cost" / "Delivered energy". *(Corrected v1.132.0: this previously also described deriving the realized-need counterfactual via `actuatedRealizedNeedBuyKwh`. That helper still exists in `nightChargeAdvisor.ts` but is **no longer on the scoring path** — it is exercised only by tests. Do not reason about live scoring from it.)*

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

**Before v1.133.0 an exact `0` was not a decision, it was a fallback.** The guard folded
`outageHours <= 0` into the same branch as "no measurement available", so setting the option
to 0 silently delivered the legacy band (15% of pool ≈ 13.8 kWh on this plant) — the option
was accepted, `validate-addon-config` passed, and the setting did not take effect. It was
worse than inert: the legacy basis also switches the cushion test to the whole-house forward
trough, so **asking for no cushion made the requirement larger**. An exact `0` is now honoured,
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
  computed on a **de-biased load** where the ledger shows the load forecast running high
  (§15.13 "Cost-ceiling load de-bias"; never on a `cushionShortfall` night);
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

   Setting `ARB_COST_MAX_SOC_PCT` to 50 disables force-charge.
2. **Cost mode is rate-blind.** `costModeTargetKwh` reads no tariff. "Cost" here means *fill
   further*, on the premise that overnight energy is the cheapest the day will offer — not
   that the planner optimises against the rate table. The tariff model informs the *window*,
   not the *target*.
3. **Cost mode is asked before it holds (v1.174.0).** The resilience hold returns early only in
   `resilience` mode. In `cost` mode, a night whose no-buy trough already clears floor + cushion
   still evaluates the cost target. It holds only when the pack already sits at or above the
   night's cost ceiling, or when the window can deliver less than the minimum buy toward it.
   The hold rationale names which case applied, and the ledger records the ceiling the night
   was measured against. Before v1.174.0 the hold returned ahead of the objective in both
   modes, so a high-pack night, including the long-gap 90% ceiling, never bought toward the
   cost ceiling.

**Manual cancel:** `POST /api/night-charge/cancel` (write-auth; surfaced as a button on the `NightChargeCard`). Before the apply moment it disarms; after a successful apply it triggers an immediate revert on the next actuator tick. The card offers it in every shape it takes, because a write armed from the announced plan stands whatever a later recompute says: beside a charge plan, beside a hold, beside a plan whose basis was incomplete or that has gone stale (`actuationBannerState`: "Cancel tonight" while armed, "Cancel & revert" once applied). Beside a hold or a missing plan the card then says the armed write stands, where it would otherwise say nothing will be charged (`writeStands`). When the status itself cannot be read (an error, or no answer within 15 s), the card offers the same cancel without knowing what is armed; a 409 answer reads "Nothing to cancel" with the server's reason (`cancelOutcome`), as it does on a night whose reserve settled as someone else's. A cancel the server confirmed shows at once, for that write only (`actuationKey`, keyed by plan date, leg and window), until the status poll carries it. The route takes an optional body `{ leg: 'cost' | 'backup' }` (`cancelLeg`, below): with no leg named it cancels the cost leg wherever it is, active or pending, and otherwise the active leg — with one leg, tonight's write, as it always has; any other `leg` is a 400. The card's banner names its own leg; the status-blind Cancel names none. A night whose reserve settled as someone else's shows no Cancel: "The reserve was set to 30% outside the add-on — tonight's write no longer holds it." (`actuationBannerState`), where the server would answer 409.

**`auto` semantics:** `effectiveActuationMode(mode, writeReady)` is the binding enforcement point — `auto` is structurally demoted to `supervised` while the readiness gate has not graduated, and any future auto-only relaxation (e.g. dropping the evening cancel checkpoint) must branch on the demoted mode, never the raw config value. `advisory` remains the default; enabling a write mode is an explicit owner action in the add-on configuration.

#### The charge cycle record (`chargeCycle.ts`)

The evening job arms a charge CYCLE: the legs one evening's plan holds (chapter 15 part 1, "The charge cycle: overnight or mid-day"). Every cycle the add-on arms today is one leg, tonight's overnight cost leg, and with one leg the record, the arm, the cancel, the drift attribution and every push are what they were before the cycle record; the second leg exists only in the pure module and its tests until the mid-day switch.

- **The record.** Each leg is the per-night actuation record plus its name (`leg`: `cost` or `backup`; `windowKind`; the announced level and expected kWh, the consent ceiling a morning refresh may lower; the refresh and missed-apply stamps), so every per-night rule holds per leg. One leg is ACTIVE — the one the actuator ticks drive, held in the same in-memory record every reader always used. The file keeps the active leg at its top level, in the shape every earlier release reads, plus `pendingLegs` (armed, nothing written) and `trailing` (below). A release from before the cycle record reads the top level and ignores the rest: rolled back, it still finds, reverts and switches off the active leg, and drops only a pending leg (dropping it can only cancel a write) and a trailing leg (an OFF already sent, waiting to be read back). A file it writes back reads as a one-leg cycle. The coerce fails closed: a leg name it does not know reads as the backup, which never force-charges; a pending leg of another plan date is dropped.
- **`legResolved`** lets the next leg go: the leg is finished (cancelled, restored, settled as someone else's reserve, or past its apply window with no write), it holds nothing of ours on the device (`armOpenItem`: no applied write unrestored, no force-charge ON with its OFF unverified, no attempt confirmed neither way unless the live reading proves it never landed), and its restore and force-charge OFF have read back. `armOpenItem` is the refusal `armFromPlan` makes and the first thing `armRefusalReason` names, one function, so promotion within a cycle and arming the next one refuse on the same facts. An unconfirmed write therefore blocks promotion, and the active leg's ADOPT can still revert it. The panel's force-charge ceiling is not a condition: an original not yet restored travels on to the next leg (`carryCeilingPrior`), as armFromPlan has carried it to the next night since force-charge shipped.
- **Promotion** (`promoteCycle`, the cycle step at the start of each actuation tick, on a fresh reserve readback): a resolved active leg hands over to the first pending one; a trailing leg that has resolved leaves first. A leg whose apply window passed with no write is resolved at the moment its missed-apply push falls due, so it is promoted only once that push is stamped: it never leaves the cycle unannounced. A leg still unresolved when the next one's apply window passes leaves that one missed.
- **`armCycle`** arms the legs against the record in place. The first leg is armFromPlan against the active leg, so a one-leg cycle refuses exactly what armFromPlan refuses, with `armRefusalReason`'s words, and carries the ceiling original it carries; later legs arm from an empty record and the first armed leg owns the ceiling's restore. A backup leg never force-charges: its cost ceiling is dropped and force-charge never rides it (and the force-charge step reads the option per leg). The whole cycle persists only once an announcement channel delivered it, as the one-leg arm always has, with the trailing leg as the ticks left it while the announcement was awaited (`withLiveTrailing`).
- **Trailing.** A backup leg is reserve-only, so a prior leg whose only open item is its force-charge OFF does not stop it arming: that leg moves to `trailing`, which keeps its OFF verification, its re-sends and its ceiling restore, driven each tick by the same decision (`decideForceCharge`) with force-charge disabled — it can only switch off — and with its own escalation record. The cost leg waits for it, and an open trailing leg refuses the next cycle. With no SHP2 or with the master switch off it is still driven, as the active leg's OFF is.
- **Supersede** compares legs (`supersededLegs`): the active leg by the rule the evening job has always applied, and a pending leg only before its apply window passes; a pending leg's `superseded` disposition is stamped once the cycle replacing it is persisted. A prior arm cancelled by tonight's hold takes its pending legs with it.
- **The missed apply** (`missedApplyDue`): a leg the overnight-only cycle never had — a mid-day leg, or the backup before one — whose apply window passes with no write sends one info push, "Today's 10am–3pm charge did not start — the panel did not report its backup reserve. Nothing was written; the reserve stays at 16%." (`buildNightChargeMissedApply`; the reason is `missedApplyReason`: the leg before it still holding the reserve, then the apply guards in `decideActuation`'s order). It is stamped on the leg before it goes, whatever the guard readings say (a reading that cannot be taken leaves the generic reason), and recorded as the leg's `arm_disposition`. An overnight backup's push says "Tonight's 12am–5am outage backup did not start". The overnight cost leg keeps its single warning for a write that never took effect.
- **Drift attribution per leg** (`legDriftActive`): the overnight leg keeps the rule settings-drift has always applied (applied and unrestored, armed and uncancelled, or restored within 15 minutes). A mid-day leg is armed at 21:30 for a 10:00 write, so its armed span is not attributed: only its apply window, from 10 minutes before the open to 30 after, and its write from the attempt to 15 minutes after the last restore attempt. The trailing leg's force-charge re-sends are attributed like the active leg's.
- **The ledger, per leg** (`legLedgerFields`): the row's own stamps hold the cost leg; a backup leg's apply, restore and disposition go to `backup_actuated`, `backup_applied_at_ms`, `backup_reverted_at_ms` and `backup_arm_disposition`. The cost leg's force-charge stamps and its first revert-deadline page are recorded too (chapter 15 part 1, "The learning ledger").

#### The mid-day cycle in shadow (`middayShadow.ts`)

Until the mid-day switch the add-on arms the overnight cycle only, and computes the winter mid-day cycle beside it so the mid-day cycle can be judged on real days before it writes anything. Nothing of the shadow is armed, written, pushed or spoken; it has no device, push or speech path to call.

- **When.** A minute tick (`runMiddayShadowTick`, single-flight) runs once the evening job has latched the day, inside the same 21:30–23:00 window. It asks the chooser with the mid-day window and the configured objective and cost ceiling (`shadowCycleConfig`). A cycle that is not mid-day — Friday, Saturday, a holiday eve, summer, the season grace, a configuration without a cost objective or with `ARB_COST_MAX_SOC_PCT` at or below 50 — is recorded with its reason and nothing is sized.
- **The legs** (`runMiddayShadowEvening`). The backup leg is sized first on option A (`backupLegSizing`): its walk runs from its close to the next overnight open, and it arms when that walk dips under reserve + cushion (chapter 15 part 1, "The leg"). The cost leg is then sized from the pool the backup protects — the backup's hold only when the backup would arm — with C_mid under the Cores' charge taper and its PV surplus from the close to the on-peak start (`costLegSizing`). Both use the planner the live plan uses (`recomputeNightChargePlan` with a shadow leg), which for a shadow leg returns the plan only: it sets no plan holder, writes no plan snapshot and logs no calibration change, so the night-charge entities, the card and the status keep the live overnight plan.
- **Would it arm** (`shadowArmProbe`): `armCycle` against the cycle record in place, on the backup alone and then on both legs, the way the evening job would arm them. `armCycle` is pure and its cycle is dropped; only the verdict leaves (which legs armed, and the refusal words of those that did not). In `advisory` mode nothing is armed, and the record says so.
- **The morning refresh, computed** (`refreshLeg`): from 30 minutes before the cost window opens, on a fresh panel reading, the cost leg is sized again. The announced level is the consent ceiling: the refresh may lower or cancel, never raise — stop = min(announced level, refreshed level), reserve = min(50, announced level, refreshed T_mid), a higher need recorded `capped`, a hold `cancelled`. No refresh by 5 minutes before the open records `stood` (the evening plan stands). It records whether a live refresh would push (a cancel, a changed written value, a cap, or an expected draw moved by more than 25%), and pushes nothing. The record is re-read after the planner's await and persisted before it is logged.
- **Where it goes.** Its own file (`.night-charge-midday-shadow.json`, beside the database); the log, each line tagged `night-charge[midday-shadow]:` and ending "Shadow only"; the evening's ledger row, as the `shadow_*` columns (only onto a row the evening job recorded — a shadow never creates one); the `ecoflow_midday_charge_*` entities (section 9); and the card's read-only section.

---

### 9. Delivery surfaces

**State payloads.** `nightChargeStateFields(plan, now)` + `nightChargeGateFields(readiness)` are spread into **both** the MQTT state payload (`mqttDiscovery.ts:1498`) and `/api/ha-state` (`index.ts:1791`) — deliberate MQTT/REST parity. A plan is *fresh* only when `basisComplete && age < PLAN_STALENESS_MS` (12 h = 43 200 000 ms, design I12): numeric fields are null and `charge_tonight` strictly `false` otherwise, so a dead or wedged advisor (the host power-cycles daily) can never leave a stale ON. The window strings are informational (published whenever the plan carries a window) and **day-qualified beyond 24 h** via `fmtPhoenixDayHm` — `"23:00"` within a day, `"Mon 00:00"` beyond — so a Saturday plan resolving Monday's window is never presented as tonight's (v1.39.0).

**HA MQTT-discovery entities** (all carry `expire_after = 90 000 s` (~25 h) so the once-nightly cadence doesn't trip expiry but a dead add-on flips them to `unavailable` — a retained `charge_tonight=ON` from a dead advisor would be worse):

| Entity | Type | Content |
|---|---|---|
| `ecoflow_night_charge_recommended` | binary_sensor | `charge_tonight` — the single flag an owner automation gates on |
| `ecoflow_night_charge_target_soc` | sensor (%) | The reserve SETPOINT for the advisory automation to write — `plan.setpointSocPct` clamped to the actuator's `[10, 50]` envelope (`clampReserveTarget`); not a predicted SoC (v1.62.0 ask/forecast split) |
| `ecoflow_night_charge_expected_soc` | sensor (%) | The pool SoC at window close projected on the islanded worst case the plan is sized on (`plan.targetSocPct`, contention-derated; the rationale's "projecting ~X% by the window close"), not the charge the write is expected to make (that is `ecoflow_night_charge_expected_buy_kwh` and the push's level). Its value is unchanged by v1.187.22, and its friendly name is "Night-Charge Arrival SoC (Worst Case)" (was "Night-Charge Expected SoC"); the unique_id, the config topic, the value key and the value are the same and no `object_id` is published, so Home Assistant keeps the entity_id it minted at first discovery |
| `ecoflow_night_charge_buy_kwh` | sensor (kWh) | The meter-side buy the plan is sized on — the islanded worst case (`plan.buyKwh`); its value is unchanged by v1.187.22, and its friendly name is "Night-Charge Buy (Worst Case)" (was "Night-Charge Buy"). The unique_id, the config topic and the value are the same and no `object_id` is published, so Home Assistant keeps the entity_id it minted at first discovery: history and automations carry over (a fresh install mints one from the new name) |
| `ecoflow_night_charge_expected_buy_kwh` | sensor (kWh) | v1.187.22 — what the armed write is expected to draw from the expected window-open SoC (`plan.expectedBuyKwh`, §5 "Expected buy"); `unknown` with no P50 basis |
| `ecoflow_night_charge_window_start` / `_end` | sensor (string) | Day-qualified Phoenix `HH:MM` window bounds |
| `ecoflow_night_charge_readiness` | sensor (diagnostic) | `LEARNING` / `READY_TO_CONSIDER_WRITES` / `BLOCKED` |
| `ecoflow_night_charge_write_ready` | binary_sensor (diagnostic) | Fail-closed gate boolean |
| `ecoflow_night_charge_role` | sensor (string) | What tonight's overnight window is for in the cycle the add-on runs (`nightChargeRoleFields`): `cost` (it carries the cost buy — every cycle until the mid-day switch) or `backup` (the outage backup ahead of a mid-day charge); null under the entities' freshness rule. The entities above stay bound to the overnight leg |
| `ecoflow_midday_charge_recommended` | binary_sensor | ON only when a LIVE mid-day leg is armed to charge (`middayChargeStateFields`). Nothing arms one before the switch, so it is strictly OFF while the mid-day cycle runs in shadow: a shadow is never a recommendation an automation may act on |
| `ecoflow_midday_charge_target_soc` / `_reserve_hold` | sensor (%) | The mid-day cost leg's level (`chargeLevelPct`) and its reserve, T_mid — the refreshed figures once the morning refresh ran, null after a cancel |
| `ecoflow_midday_charge_expected_buy_kwh` / `_buy_kwh` | sensor (kWh) | Its expected draw, and the worst case it is sized on |
| `ecoflow_midday_charge_window_start_at` / `_end_at` | sensor (timestamp) | The mid-day window, ISO instants |
| `ecoflow_midday_charge_refresh` | sensor (string) | `pending`, then the refresh's disposition: `unchanged`, `lowered`, `capped`, `cancelled` or `stood` |

The mid-day entities read the shadow record while it is current — computed within 25 hours and its window not yet closed (`shadowServed`) — and null otherwise, with the same `expire_after`.

Buy, expected SoC and the window come from the latest plan, recomputed every 30 min: before the window they can differ from the announced and armed figures (`GET /api/night-charge/status` → `actuation`), and inside it the buy is what is still needed and reaches 0 once the target is met. The armed buy is not an actuation input — force-charge stops on the frozen SoC target.

The remaining gate diagnostics (`night_charge_under_buy_rate`, `night_charge_band_coverage_pct`, `night_charge_plan_nights_scored`, `night_charge_effective_n`, `night_charge_forecast_basis_pct`, `night_charge_exclusion_fraction`) ride the same payloads without dedicated discovery entities.

**`GET /api/night-charge/status`**: `{ enabled, mode, reserveWriteMaxPct, window, reserveFloorPercent, confidence, notify:{hour,minute,lastNotifyDay}, plan, armRefusal, readiness, actuation, recentOutcomes }`. `armRefusal` (v1.187.22) is why a supervised or auto mode refused to arm this plan (`armRefusalReason`) — or "the announcement could not be delivered" when the arm reached no announcement channel (`eveningNotArmedReason`, §8b) — recorded by the evening job with the notify latch, keyed by the refused plan's window, and served (`servedArmRefusal`) while the served plan is a charge plan for that window, in a write mode, until the window closes; null otherwise. An evening that misses its notify window latches the day and keeps a standing record: Saturday's refusal for the Monday window Saturday and Sunday share still leads the card on Sunday night. `mode` is the resolved `NIGHT_CHARGE_MODE`. `reserveWriteMaxPct` (v1.182.0) is the panel's reserve maximum, so the card shows what will actually be written. `actuation` is tonight's supervised-write record: armed/applied/cancelled/reverted, the force-charge fields, `cancelDeadlineMs`, and `forceChargeOnVerify` (v1.186.0, whether the force-charge ON was read back) (§8b). `legs` lists the charge cycle's legs in order — a trailing leg, the active one (the `actuation` record), the pending ones — each with its role, window kind, position, state (`armed`, `applied`, `restoring`, `completed`, `cancelled`, `missed`, `foreign`, `forceChargeOff`), window, cancel deadline and write stamps (`cycleLegsStatus`); one entry with one leg. `middayShadow` is the mid-day cycle computed in shadow while it is current (the record above, `shadowServed`), else null. `reserveFloorPercent` is read live from `projection.backupReserveSoc` — the same field the floor alarm defends. `recentOutcomes` is an in-memory mirror of the last 7 ledger days refreshed by the timers, so the request handler never touches the DB inline (CWE-770). No auth: read-only, exposes no secrets, actuates nothing.

**Notification** (`buildNightChargeMessage`, `notify.ts:383`): three shapes — `charge` (since v1.187.22 the charge the write arms, never the worst case it is sized on (§5 "What is stated"): the title "Night-charge: charging to ~80% tonight (~34.9 kWh)" — "charge to ~50% recommended tonight" in advisory mode — and the body "Charging the backup pool to ~80% overnight, ~34.9 kWh of grid energy expected.", no kWh with no expected figure; the whole-house island troughs without vs with the charge, labelled "Whole-house island projection (if the grid were lost)" because with the grid present the SHP2 holds the reserve; the floor+cushion line the plan is sized on (`floorCushionLinePct`, §5), confidence, honest shortfall/over-buy notes, and the advisory automation contract or the supervised write, whose force-charge clause names where it stops (`forceChargeStopPct`) and when it is expected to start (§5); on a night expected to charge nothing, "Night-charge: reserve held at 50% tonight — no charge expected" (§5); "toward" the level when the window cannot reach it (§5); when a supervised or auto mode REFUSED to arm the plan (`armRefusalReason`, armFromPlan's checks in its order — an unresolved prior write, a force-charge OFF not verified, a window already more than 30 minutes under way), "Night-charge: planned charge NOT armed tonight" with the reason and no level or kWh, never the advisory recommendation of a write nothing will make — on a night expected to charge nothing, "Night-charge: planned reserve hold NOT armed tonight" ("Tonight's plan holds the backup reserve at 50% overnight as a floor, with no charge expected, but the supervised write was not armed — `<reason>`. The add-on will not raise the reserve tonight."), and "the write" rather than "the supervised write" in auto mode), `hold` (nothing is charged; since v1.187.22 it says which hold, on the figure the hold was decided on: "No overnight charge needed — even if the grid were lost overnight, the pack would close the charge window at ~37.5%, at or above the 31.1% floor+cushion line" — the trough the cushion test judged, `cushionTroughSocPct` against `cushionLineSocPct`, labelled as the islanded case it is (the whole-house low on the `legacy-pct` basis), never the unlabelled whole-house island trough it used to state as "the projected overnight low SoC (0%)"; "the need is under the minimum buy"; "no charge tonight (the window cannot cover the cushion)" with the shortfall disclosed, where it used to say "No overnight charge needed"; or no window resolved), and `insufficient_basis` (sent so the *absence* of a plan is explicit — the owner never wonders if the job died; a null plan can only ever render this shape regardless of the requested one). All severity `info` with a single `dedupId: 'night_charge_plan'` so the nightly message lands in **one updating card**, and dispatched via a *direct* `sendNotification` that bypasses quiet-hours and min-severity (design I10) — a plan queued past the charge-window open is worse than none. `NIGHT_CHARGE_NOTIFY_ON_HOLD=false` suppresses hold-night sends (still latching the day). On a supervised arm the spoken advisory (`nightChargeSpokenNotice`, bilingual) states, since v1.187.22, the level and the expected draw — "Night charge notice. Charging the backup pool to about 80 percent, about 35 kilowatt hours, in the charge window that opens at 00:00. Cancel on the Power panel before then." — with no energy figure when there is no expected one, and "less than 1 kilowatt hour" rather than "about 0"; a night expected to charge nothing is spoken as the reserve held, "… ; no charge is expected." (§5). The time is the window's, not "starting at": a pool that opens above the reserve is not charged at the open (the house draws it until the just-in-time force-charge).

**Web**: `NightChargeCard` on the Strategy panel — zero-prop, self-fetching `/api/night-charge/status` on a 60 s poll, with its own matching 12 h client-side staleness guard; a null/incomplete/stale plan renders the grey "unavailable" shape, never a fabricated number. Since v1.187.22 its headline is the charge the write arms — the expected draw and the level ("34.9 kWh — expected charge to ~80%"), or the level alone with no expected figure (`chargeFigureParts`, nightChargeText.ts) — and the worst case appears once, in the sizing line beneath it (`sizingLine`, the server's `sizingBasisText` wording, the calibration beside the figure it multiplies). The stats label the sizing figures as such — "Worst-case arrival" (`targetSocPct`, sub "sizing basis", was "Expected SoC") and "Island low, no charge" / "Island low, with charge" (sub "if the grid were lost") — and a hold night shows the push's hold shape (`holdSummary`). A night expected to charge nothing leads with the reserve the write holds ("50% — reserve held as a floor — no charge expected"); a night a write mode refused to arm (the status's `armRefusal`) leads with "Planned charge not armed tonight — `<reason>`." and no level or kWh (`refusedArmLead`), as the push does — "Planned reserve hold not armed tonight — `<reason>`." on a night expected to charge nothing, and "the write" in auto mode; on a force-charge night with no start expected the headline states the reserve the night reaches ("expected charge to ~50%", §5); a night expected to charge nothing shows no EV-contention line; the "Island low, with charge" stat states the line the plan is sized on (`floorCushionLinePct`). Beneath every shape whose status is known, a read-only section shows the mid-day cycle computed in shadow (`middayShadowView`): the outage backup, the 10:00–15:00 charge and its morning refresh, each with whether it would arm, and a closing note that nothing of it is armed, written or announced. It has no control, and shows nothing with no mid-day leg.

---

### 10. Configuration

Add-on options (`config.yaml` → env):

| Option | Default | Range | Meaning |
|---|---|---|---|
| `NIGHT_CHARGE_ADVISOR_ENABLED` | `true` | bool | Master switch for the timers + surfaces (env compare is `!== 'false'`) |
| `NIGHT_CHARGE_MODE` | `advisory` | list(advisory\|supervised\|auto) | Write posture (v1.50.0). `advisory` never writes; `supervised` runs the announced, cancellable, bounded, auto-reverting reserve write per charge night. In `cost` mode with `ARB_COST_MAX_SOC_PCT` above 50 it adds a force-charge that rides the verified write to the night's ceiling (v1.165.0) (§8b); `auto` is honored only after gate graduation and operates as supervised until then. Unknown values fail closed to `advisory`. |
| `ARB_OUTAGE_CUSHION_PCT` | `15` | int 0–40 | Legacy fallback only: the cushion as % of pool, tested against the whole-house forward trough. It is used only when no islanded-load measurement exists. The primary cushion is `ARB_OUTAGE_CUSHION_HOURS` × 7-day mean islanded load × `ARB_ISLANDED_LOAD_SAFETY` ÷ discharge efficiency (v1.125.0). Never changes the independent floor alarm |
| `ARB_MIN_BUY_KWH` | `1` | float 0–50 | Below this recommended buy, the night is a "hold" |
| `ARB_CHARGE_CAP_KW` | `0` | float 0–50 | Grid-side charge-power ceiling for the feasibility cap. `0` = AUTO (v1.173.0): connected Cores × `FORCE_CHARGE_PROVEN_KW_PER_SLOT` ÷ √RTE (~5.9 kW per Core); > 0 is a fixed override. Home load comes off separately via `ARB_GRID_INPUT_CAP_KW`. Sizing only, no device is ever set |
| `ARB_LOAD_P90_FACTOR` | `1.15` | float 1–2 | Floor of the calibrated load-band multiplier (`calibratedLoadBandFactor`, v1.106.0): the band can only widen above it, and it is the factor itself below 10 ledger samples |
| `NIGHT_CHARGE_NOTIFY_HOUR` / `_MINUTE` | `21` / `30` | runtime-clamped int 0–**22** / 0–59 | Evening-job fire time; hour is clamped to ≤ 22 because the catch-up window is `[fire, 23:00)` — hour 23 made it the empty set (v1.39.0) |
| `NIGHT_CHARGE_NOTIFY_ON_HOLD` | `true` | bool | Send the nightly advisory even on hold nights (consistent "the job ran" confirmation) |
| `TARIFF_APS_*_CENTS` ×6 | `""` | str | Per-period effective ¢/kWh from a bill (§3 table); empty = unconfirmed |
| `TARIFF_APS_RATES_CONFIRMED` | `false` | bool | While false, **every** `$` output is null regardless of entered rates |
| `ARB_OUTAGE_CUSHION_HOURS` | `4` | float 0–72 | Outage length the cushion carries the measured islanded load through (v1.125.0); `0` disables the cushion (basis `disabled`, v1.133.0) |
| `ARB_ISLANDED_LOAD_SAFETY` | `1.25` | float 1–5 | Multiplier on the 7-day mean islanded (panel) load in the cushion; raising it buys more |
| `ARB_OBJECTIVE` | `resilience` | list(resilience\|cost) | Sizing objective (§8b) |
| `ARB_COST_MAX_SOC_PCT` | `90` | int 50–100 | Cost-mode fill ceiling; above 50 it is reached by force-charge (v1.165.0); `50` disables force-charge |
| `ARB_GRID_INPUT_CAP_KW` | `17` | float 0–100 | The panel's total grid-input envelope shared by house load and charging; sets the live force-charge rate and the planner's contention cap (≤ 0 disables contention modelling) |

Env-only knobs (not in the options form): `NIGHT_CHARGE_LATCH_PATH`, `NIGHT_CHARGE_PLANSNAP_PATH`, `NIGHT_CHARGE_ACTUATION_PATH` (latch, persisted pre-window plan and actuation-state files; all default beside the DB), `EV_MAX_LOAD_W` (default `11520` — the per-hour EV block cap, shared with the EV detection engine), `ARB_LOAD_P90_CAP` (default `2.0`, `index.ts:3547` — the upper bound of the load-band widening; **if this is ever added to the options schema it MUST ship an `options:` default**, because `Number('')` is `0` and an unset option would pin the load band to zero), and the shared efficiency seams `DISPATCH_ROUND_TRIP_EFFICIENCY` (default `0.86`, clamped [0.8, 1]; the advisor's charge leg is its square root ≈ 0.927) and `RUNWAY_DISCHARGE_EFFICIENCY` (default `0.94`, clamped [0.8, 1]) — both injected from `analytics.ts`, never re-declared.

---

### 11. Failure modes & known limitations

- **Basis-completeness gate.** No plan is sized unless the probabilistic band exists, the confidence tier is not climatology, `calScoredDays ≥ 14`, *and* realized band coverage ≥ 0.78 (`BASIS_MIN_BAND_COVERAGE`). On a young install (or after a forecast-model reset) the advisor publishes the explicit `insufficient_basis` shape nightly — this is by design, not a fault.
- **SHP2 offline / missing battery fields** ⇒ `recomputeNightChargePlan` returns null and the holder keeps the prior plan until the 12 h staleness guard nulls the surfaces and the ~25 h `expire_after` flips the HA entities to `unavailable`. The scorer likewise cannot source actuals while the SHP2 projection is absent; affected nights land as MNAR exclusions, which the gate's expected-nights denominator counts against readiness.
- **Weekend tariff boundary (open question).** The model's per-instant weekday gating makes Friday's window Fri 23:00–24:00 only (Sat 00:00–05:00 is weekend off-peak) with the next window opening Mon 00:00 — a ~48 h carry sized against a 1-hour charge window (charge-power capped, `cushionShortfall` honestly flagged) on a mostly `mixed`-tier basis that never enters gate eligibility. Whether real APS billing extends Friday's overnight into Saturday morning can only be settled from a bill; if it does, the correction belongs in `tariff.ts` weekday gating. Rates are null until confirmed, so no `$` output depends on the answer.
- **Hardware charge envelope.** Measured 2026-09-16/18: grid import pins at ~19.1 kW and the pack takes (19.1 − house) × ~0.93, up to ~17 kW across three Cores. Since v1.173.0 `ARB_CHARGE_CAP_KW` = 0 derives the cap from the connected Cores; the old 7.2 kW (`chChargeWatt`) under-stated every plan.
- **Write posture is mode-gated and fail-closed.** In `advisory` (the default) the add-on performs no night-charge writes; `supervised` performs one announced, cancellable, bounded, auto-reverting reserve write per charge night, plus in `cost` mode above 50% a force-charge that rides the verified write and is switched OFF at the target, the window close, a revert, a cancel or a grid loss (§8b), and `auto` is demoted to supervised until the gate graduates (§8). On non-actuated nights the realized-need counterfactual is defensible only on clean (near-zero-import) nights, so grid-propped nights are excluded from scoring rather than fabricated; actuated nights score from the measured delivered charge instead.
- **A ledger row with no stored window** is unscoreable, and **v1.132.0 distinguishes the two reasons**: a *pre-v1.39.0* row predates the window columns (a data-vintage problem), while a current-`algo_version` row with no window simply had **no cheap window to resolve that night** — normal on a tariff day that offers none, e.g. Saturday on this plan. Both capture as `scored=0`, now with different `score_notes`; calling the second a "pre-v1.39.0 row" sent readers hunting a migration bug that was not there. Nights whose raw telemetry has aged past the configured samples retention (default 30 days) capture honestly unscored rather than staying open forever.
- **The calibration table is not yet live.** The `night_charge_calibration` table (seasonal cushion, buy de-bias, EV-tail inflation) exists as schema and API only and nothing reads or writes it. Three ledger-driven calibrations do run, computed directly from `night_charge_ledger` rows:
  - the announced-buy de-bias (§15.12);
  - the load-band factor (§8);
  - the cost-ceiling load de-bias (§15.13).

  Since v1.125.0 the cushion is sized from the measured islanded load (`ARB_OUTAGE_CUSHION_HOURS` / `ARB_ISLANDED_LOAD_SAFETY`). `ARB_OUTAGE_CUSHION_PCT` is only its legacy fallback.

---

### 12. Announced-buy de-bias (`calibratedBuyDebiasFactor`, v1.112.0)

The 08-26/27 night announced "buy ~21.6 kWh" and delivered ~35.8 — a 1.66×
under-prediction. Actuation is bounded by the reserve setpoint so nothing
unsafe happened, but the announcement is the advisory's product. The factor is
the MEDIAN of `delivered_kwh / buy_kwh` over eligible ledger nights (actuated,
scored, no disclosed cushion shortfall, plan ≥ 3 kWh), FLOOR 1.0 (only ever
raises the announcement — the raw physics estimate is the lower bound), CAP
1.75, minSamples 7. It multiplies the ANNOUNCED figure only: `plan.buyKwh`
stays raw and is what the ledger records (★ the self-reference guard — feeding
the debiased figure back would collapse each night's ratio to ~1 and the
learner would eat its own output), and `chargeTonight` thresholds on the raw
figure so learned data can never flip the decision, only the disclosure.
v1.187.22: the factor multiplies the worst-case figure only, which no spoken or
pushed line states; the rationale's sizing sentence and the card's sizing line name
the de-biased figure with the calibration beside it, and the expected buy (§5) is
never de-biased. New plan fields `buyKwhDebiased` / `buyDebiasFactor`; the rationale
and the card disclose the calibration when active. This is the first live
producer/consumer for the design §3.4 "buy de-bias" lane.

**One delivered basis (v1.187.3).** A night is a sample only when its
`delivered_basis` is `DELIVERED_BASIS` (`source-charge`, §6 "DELIVERED ENERGY").
Rows captured before v1.187.3 hold the import-minus-house-load estimate, which
under-counts any night the SHP2 carried the house from the pack inside the hold
(2026-09-30: a 0.26 delivered/planned ratio for a true ~1.1); they are kept as
recorded, never samples, and counted in the result's `setAside`. Until seven
nights on the current basis exist the factor is 1.0 with basis `default`, and the
`announced-buy calibration UNMEASURED (N eligible night(s), M set aside …)` line
says so on change. `plan.buyDebiasBasis` / `plan.buyDebiasSamples` report the
learner's own basis and sample count; before v1.187.3 `buildNightChargeInputs`
copied only the factor, so every plan reported `default` / 0 whatever the learner
said (the 09-30 log counted 6 eligible nights while the plan said 0).

**One stratum per window kind.** A mid-day leg charges beside the sun and an overnight one in
the dark, so their delivered/planned ratios are not one population: the factor reads only the
rows of the leg's window kind (`ledgerRowWindowKind`: a row written before the charge cycle record
is overnight), and the planned figure is the morning refresh's worst case (`refreshed_buy_kwh`)
when the row has one. Every row is overnight until the mid-day switch, so the overnight factor is
the one it always was. The load band and the cost-ceiling load factor stay pooled: they learn the
forecast load over the 24 hours from issue, which does not depend on the window, and a thin mid-day
stratum would sit on their floors.

### 13. Cost-ceiling load de-bias (`costSurplusLoadFactor`, v1.187.1)

The cost ceiling leaves room for the morning surplus, Σ max(0, P50 PV − load) over window
close → +14 h. The load forecast is the panel's hour-of-day history curve, and on every ledger
night `/api/night-charge/status` shows on 2026-09-30 (09-23..29) it ran above the measured load
(`load_err_frac` −0.29 to −0.43, the actual under the load P10 on all seven). Every kW of
over-forecast load is a kW of sun the ceiling leaves no room for: the 09-29 ceiling of 77.7%
bought ~18.9 kWh, the pool was full by 13:00 on 09-30 and ~9-12 kWh of PV was curtailed until
~16:00.

The surplus the cost ceiling uses is computed on a de-biased load by `buildCostSurplusLoad`
(`nightChargeAdvisor.ts`; `index.ts` supplies the ledger read, the hourly panel-load query and
the tariff timezone's clock hour as callbacks):

- **Builder** (`buildCostSurplusLoad`): the hours are those of the raw morning surplus (window
  close → +14 h, an hour with no day-ahead load skipped). It returns null — the planner keeps
  the raw surplus — in resilience mode, with no morning hour, under 5 ledger nights, or with a
  factor of 1. A ledger read that throws counts as no nights. The panel-load query runs only
  when a de-bias can apply; a query that fails or returns nothing leaves every hour on its
  forecast. A change of factor, sample count or floor coverage is logged once
  (`night-charge: cost-ceiling surplus counts the house load at ×…`).
- **Factor** (`costSurplusLoadFactor`): the median of `1 + load_err_frac` over the ledger rows
  of the last `COST_SURPLUS_LOAD_LOOKBACK_DAYS` (14) days (rows with no finite error, or an
  actual of 0 or less, are not samples). Capped at **1** — the load is only ever lowered, so
  the ceiling can only fall. Under `COST_SURPLUS_LOAD_MIN_SAMPLES` (5) nights it is 1; from
  there the correction ramps in linearly (`n / COST_SURPLUS_LOAD_FULL_SAMPLES`, whole at 10).
  Bounded below at `COST_SURPLUS_LOAD_FACTOR_MIN` (0.6): `actual_load_kwh` skips telemetry
  gaps, so a broken night under-counts the actual.
- **Physical floor** (`measuredHourlyLoadFloorW`): per local clock hour, the least hourly-mean
  panel load over the trailing `COST_SURPLUS_FLOOR_DAYS` (7) days, read in hourly buckets; an
  hour seen on fewer than `COST_SURPLUS_FLOOR_MIN_DAYS` (4) days has no floor.
- **Per hour** (`costSurplusLoadW`): the expected-value EV block (`predictedEvLoadW`) is kept
  whole; the rest is `max(rest × factor, min(floor, rest))` — never below the floor, never above
  the forecast. An hour with no floor keeps its forecast.
- **Use** (`debiasedCostSurplusKwh`): the de-biased P50 (or P90 stand-in) replaces the raw one
  only where it is **larger**, and never so large that the ceiling falls below the pack the
  resilience lift arrives at (`targetPackKwh`; the force-charge stops at the ceiling) — unless
  the raw ceiling already sat below it. Raw unknown ⇒ raw. **A `cushionShortfall` night keeps
  the raw surplus**: there the arrival is derated (charge rate, a predicted EV sharing the grid
  input, a clamp) below the requirement, and a stop bounded by it could fall under the cushion
  line the raw stop cleared — a 10 kW islanded load (line 73.71%), a 12 kW grid input and a
  40 kWh session predicted at window open give an arrival of 21.5%, a raw stop of 77.7% and a
  de-biased one of 72.8%, and a car that never plugs in lets the force-charge run at full rate
  to that stop. On any other night the arrival holds the line: on the islanded cushion it is
  the trough itself, and on the legacy band its whole-house trough clears the line.

Scope: cost mode only, and only the `p50` / `p90` bases — a long-gap night keeps its
pessimistic P10 pre-peak surplus. The P90 over-buy flag, the resilience sizing, the setpoint
requirement, the islanded cushion, the solar model, the runway and every alarm read the
forecast load as before. The PV side of the surplus is unchanged: the solar fit and
`pvBiasFactor` still include hours when the pool was full (curtailed output), and those feed
the alarm-facing forecast. Plan fields `costCeilingSurplusRawKwh`, `costSurplusLoadFactor`,
`costSurplusLoadSamples` (cost mode); when the de-bias widened the headroom the rationale
gives both figures. Ledger columns (`costSurplusLedgerColumns`, written with each plan row):
`cost_surplus_kwh` (the headroom used), `cost_surplus_raw_kwh` (on the forecast load as is),
`cost_surplus_load_factor`, `cost_surplus_load_samples`; NULL in resilience mode and on rows
before v1.187.1, used = raw where the de-bias did not widen the headroom.

Reconstructed on the 2026-09-29 night (the hourly shape of the 09-30 band, P50 PV scaled to
the recorded 20.55 kWh surplus) with the six rows scored before it that the status still shows
(09-23..28, ×0.793): ceiling 77.7% → 72.8%. The deployed planner reads up to 14 days of the
ledger, the correction whole at ten nights, including rows the status no longer shows, so the
factor it applies differs and the log line above states it; the same morning at ×0.70 gives
70.7%. Harness: `scripts/mutate-v1187-1f.mjs` (53).

