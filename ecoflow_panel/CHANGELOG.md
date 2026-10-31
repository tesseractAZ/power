## 1.196.0

### The overnight write charges to the line the plan is sized on; the no-plan and force-charge warnings say why; the cost ceiling counts the measured sun

**Night charge**

- With the islanded-outage cushion (or the cushion disabled), the overnight reserve write is now solved on the test the plan is sized on: the pack at the window close against the reserve floor plus the outage cushion. It was solved on a whole-house walk to the next charge window. On this plant that walk falls below the line from any starting level, so every charge night asked for about 73-100% and wrote the 50% maximum. A resilience night now writes the cushion line, rounded up to the next whole percent. For example, a 16% floor with a 4 h, 2.62 kW, x1.25 cushion now writes 32% where it wrote 50%, and the expected draw falls from about 27.9 kWh to about 10 kWh. `ARB_OUTAGE_CUSHION_HOURS` is unchanged.
- A cost night writes its cost target where that is higher than the line, so a ceiling under 50% is written as itself (40% for a 40.3% ceiling, where it wrote 50%). A night limited by the charge rate writes the target, never the lower arrival the window can reach. The legacy band, the outage backup leg and the mid-day leg's reserve are unchanged.
- Of the 1,104 recorded plan cases, 431 setpoints move, all on the islanded-outage cushion. 157 resilience charge nights write a lower reserve (median 13 points), 17 cost charge nights write lower (median 7 points), and 5 cost nights limited by the charge rate write higher (their cost target). No charge night writes under its line, or under 50% where its line is higher. No buy and no requirement changes.
- The cushion is counted on the panel's nameplate pool, and the reserve percent is a share of the packs' measured capacity (about 0.944 of nameplate). The written line therefore holds about that share of the counted cushion above the reserve (options guide; reference chapter 15 part 1).
- The reserve sentence says the panel accepts a backup reserve only up to 50% only when the ask is above 50%. Before, it was also printed for asks such as 40.3% or 44.2% that were written as 40% or 44%.
- The force-charge failure warning, and its log line, now name the Core in each slot that did not take Charge Now. They say when that Core is offline in the cloud, and name its work mode or its own backup reserve when that differs from the other Cores driven that night. For example: "slot(s) 3 (Core 5 — work mode 3 (time-of-use), where the other Cores read 0 (default); its own backup reserve 60%, where the other Cores read 50%)". The warning then suggests comparing those settings in the EcoFlow app. Labels never contain serial digits. The slot-to-Core mapping comes from the fresh panel reading; the settings are each Core's last report. The morning summary keeps slot numbers.
- The "Night-charge: no plan tonight" push names what refused the plan. For example: "the forecast/telemetry basis is incomplete: PV band coverage 72% < 78% (…)", or "SoC telemetry incoherent (% vs remaining/full mismatch)". A night with no panel reading says the panel's pool readings are unavailable. The reason is on the plan as `basisBlockedBy`, which was declared but never set; it is now set on every refused plan and absent on a complete one. The mid-day preview's "not armed" line and its "no plan" push carry it too.

**Write-readiness gate**

- The realized half of the engine-fault strike is now graded on what the plan claims. With the islanded-outage cushion (or the cushion disabled), the plan claims only that the pool at the window close holds the reserve floor plus the cushion it sized (`cushion_line_soc_pct`). The verdict was the lowest pool over the 16 hours after the close against the reserve floor plus `ARB_OUTAGE_CUSHION_PCT`, measured after the reserve has reverted to the floor. With the write at the line, that verdict would have counted almost every actuated resilience night as a strike and held the gate at `BLOCKED`. On the 2026-10-12 fixture the 32% write has a P50 morning low of about 23.6%, against 16 + 15 = 31%; with a 2.0 kW island the 28% write is under 31% at the close itself.
- On such a night `cushion_breached` is now the pool measured at the window close (new ledger column `window_close_soc_pct`, the median reading over the window's last 15 minutes) under the line, with 0.05 points allowed for rounding. Without that reading the night is clean when the lowest pool after the close holds the line; otherwise the verdict is unknown. The gate derives the verdict again from the row's columns and keeps the stored flag where the columns cannot decide (fail-closed). It counts the stored flags it overrules in `realizedStrikesSetAside`. A night whose line is above the panel's 50% reserve maximum, with no force-charge to carry the pool past it, now reads as breached: the plan claims a cushion the write cannot reach, because `cushionShortfall` does not count the write envelope (4 of the year fixture's 199 islanded evening charges with no disclosed shortfall; the old rule passed them). The legacy band, the mid-day two-leg row and rows without a recorded line keep the earlier verdict. `score_notes` states the reading against the line. `CURRENT_ALGO_VERSION` is unchanged, so no night leaves the readiness count.

**Night charge (cost mode)**

- The cost ceiling's morning-solar headroom now de-biases the median PV as well as the house load. It uses the median realized/forecast PV ratio from the night ledger (1 + `pv_err_frac`), over forecast-tier nights whose PV verdict stands, whose forecast was at least 5 kWh, and whose pool did not reach the charge taper. On those days output is curtailed, so their actual PV measures nothing.
- Like the load factor, the PV factor only widens the headroom (at least x1, at most x1.3). It needs 5 nights and takes full effect at 10. It never raises an hour's median PV past that hour's P90. On the 2026-10-12 fixture, ten nights at x1.095 lower the ceiling and the force-charge stop from 56.6% to 50.4%, and the expected buy from about 11.6 to 5.1 kWh.
- New plan fields: `costSurplusPvFactor`, `costSurplusPvSamples`. New ledger columns: `cost_surplus_pv_factor`, `cost_surplus_pv_samples`, `actual_max_soc_pct` and `pv_saturated`. When only the PV term is de-biased, the load factor is recorded as 1 with its nights.

**Unchanged**

- The runway, SoC and floor alarms do not read the write setpoint. The reserve write still reverts at the window close. Cost mode with a ceiling of 50% or more still writes 50% plus force-charge. The analytics PV forecast that feeds the runway and the alarms is unchanged.
- Charge and hold plans carry no `basisBlockedBy` key (cost-mode plans gain only the two PV-factor fields above).

**Tests**

- New: `setpointOneTest.test.ts`, `forceChargeFailedCore.test.ts`, `noPlanReason.test.ts`, `costCeilingPvDebias.test.ts` and `realizedCushionAtClose.test.ts` (an M5 resilience night, written 32% with a ~23.6% morning low, through the gate: no strike; a pool under its line at the close still strikes, including a line above the 50% envelope). `middayAnnounce.test.ts` covers the mid-day "no plan" reason.
- `legacyIdentity.golden.json` is regenerated on purpose, with an `_amended` note: 870 of 1,104 digests move against 1.195.0, by the setpoints (431), the refused plans' `basisBlockedBy` (132) and the cost plans' PV-factor keys (563). The truncation sentence alone moves no case. `overnightTextGolden.json` is regenerated in its evening entries only, and one reserve-only "toward" case is added.
- The 1.194.0 test that holds the charge leg to its direction now compares against the planner without the charge leg but with this release's setpoint (new `legacyIdentity.withoutChargeLeg.figures.json`), because 1.192.0's setpoints on the islanded-outage cushion were a walk. Every assertion holds. 95 buys rise and one hold becomes a charge, as before. 108 expected buys rise and 64 setpoints move, 5 of them down; when 1.194.0 measured them against 1.192.0 the figures were 118, 264 and 16. A new test checks the release against 1.192.0: no buy and no requirement falls. 85 expected buys rise; the 122 that fall, and the 381 setpoints that fall, are all on the islanded-outage cushion.
- New harness `scripts/mutate-v1196-night.mjs` (68 mutants; 17 on the realized verdict). Anchors are re-pointed in `mutate-v1187-1f.mjs`, `mutate-ledger-legibility.mjs`, `mutate-zero-cushion.mjs` and `mutate-readiness-gate.mjs`.

### The forecast skill measures each past day on that day's Cores

**Forecast skill (PV band, night-charge basis gate)**

- On the forecast-skill path, a home Core with no readings on a day now makes that day a coverage gap, as it already did for the PV bias factor. The hindcast used to take a Core's first reading inside the 30-day window as the day it joined (v1.93.0/v1.94.0). A Core already dark when the window began, or Cores returning on different days after a fleet-wide outage, then had their missing share scored as a forecast miss: +50% a day with one of three Cores dark, +200% with two. On a 7-day fixture with one of three Cores dark for the first three days, MAE and bias now read 0 kWh and 1.00 (were 1.93 kWh and 0.86).
- Each past day is now measured on the Cores the pool membership record (`membership-history.json`) shows as wired that day, not on today's Cores applied to 30 days of history. The recorder now stores the panel's slot table with each entry.
  - A day before a like-for-like swap (a Core moved into the slot a departing Core held, taking over its PV array) is scored on that day's own Cores and marked `predecessorCores`.
  - A day on which the pool lacked a current Core's array is marked `offRoster` and left out of the error, the bias factor and the PV band calibration. This covers days before a Core was added through an empty slot, a swap recorded before slot tables existed, and the day of a change.
  - Membership flickers under 15 minutes are ignored.
  - Days before the record are scored on telemetry coverage alone and counted in `unrecordedRosterDays`.
- A pre-swap day is scored on the departed Core only if a fresh panel reading confirmed the record through that day. The recorder stamps the newest entry (`confirmedMs`) on a fresh reading of every panel, at most once an hour. A swap made while the panel was cloud-offline or the add-on was stopped is recorded only when the panel next reads fresh. The days in between are `offRoster`, not scored on the departed Core's bench rows.
- After a Core is added, the night-charge basis gate counts only days measured on the new set of Cores, so it stays closed until 14 such days are scored (at least two weeks). A like-for-like swap loses the day of the swap and any unconfirmed day before it. A removal loses none.

**Unchanged**

- The PV bias factor on the runway and alarm paths: its coverage call and its output are unchanged.
- `membership-history.json` keeps its format. The new `slots` and `confirmedMs` fields are optional. The newest existing entry gains its slot table on the first rollup after the update, and its stamp on the first fresh panel reading. Neither is a membership change for the curtailment freeze or the pack-DC round-trip check.

**Tests**

- `skillRoster.test.ts` (new) covers:
  - a dark Core and staggered returns, which are gaps;
  - swaps scored on that day's Cores, including a departed Core dark on a pre-swap day;
  - additions, which pause;
  - a swap hidden behind a stale panel, which is `offRoster`;
  - flicker folding, superset pools and days before the record;
  - the production reader and the confirmation stamp;
  - the recorder writing the slot table, and stamping only on a fresh panel reading.
- The tests in `pvCoverageGate.test.ts` and `darkCoreCoverage.test.ts` that asserted the join exemption now assert a gap.
- `mutate-skill-roster.mjs` (new): 29 mutants. `mutate-dark-core.mjs` drops mutants v and vi, whose guard is gone.

## 1.195.0

### The forecast cards show the restored solar while Cores are offline; a held panel's circuits are no longer the house load; cell-spread mutes below 85% are bounded

**Dashboard**

- While home Cores were offline in the EcoFlow cloud, the 24-hour forecast card and the Predictive Insights forecast showed 0 kWh of solar, a projected low of 0% and a "Tight" outlook. Those are the figures the runway alarm uses, and they count only the Cores reporting live.
- The cards now show the solar and the projected state of charge rebuilt from each offline Core's own recorded production. This is the figure Home Assistant's forecast solar sensor already shows. The rebuilt state of charge starts from the same pool, carries the same hourly load and steps through the same function as the alarm's projection, the charge leg included, so with every Core reporting the two are equal hour by hour.
- A badge labels them: "Solar restored from N offline Cores' records". At a restart, while a Core listed online has not sent its first reading, it reads "Solar from N Cores' records (first reading pending)". Beside them:
  - the runway alarm's own figures: "Runway alarm basis (reporting Cores only): X kWh solar, low Y%"
  - its state-of-charge path, as a dashed line on the chart
  - an "Alarm-basis SoC" column in the hourly table
- Each hourly row's model / typical badge names the model that produced the figure shown.
- An offline Core with no recorded solar is not counted as restored. With no solar history at all, the solar tiles read "—" / "no PV history".
- `GET /api/forecast` gains `hoursDisplay`, `minProjectedSocDisplay`, `minProjectedSocTsDisplay` and `restoredCoreCount`.

**Runway**

- Before, when the panel's readings were held (a cloud replay or a stalled feed) and no load had been recorded for an hour, the runway took the panel's held circuit watts as the live house load, for as long as the hold lasted.
  - Circuits held at 9 kW projected the reserve floor in 2.8 h instead of 8.2 h: a false high-priority alarm.
  - Circuits held at 600 W hid a 6 kW draw: low instead of medium.
- Held readings are no longer used. The last recorded hour's load is carried for up to 2 h, as before. After that the runway reads unavailable until the panel reports again.
- While the house runway reads unavailable, the runway alarm keeps its state, as the other panels' runway alarms already did. Before, it re-armed: the hourly reminder stopped for the rest of the outage, and a short outage was followed by a fresh announcement.
- The load-shed advisor also keeps its last recommendation while the runway is unavailable. Before, it reported the runway healthy and cleared `load_shed_recommended` in the middle of a depletion.

**Cell spread (alarm path)**

- Below the 85% plateau, and with no SoC reading, a cell-spread critical silenced while the BMS balances now speaks 20 minutes after the spread first reached the line.
  - Before, the mute had no limit there. A 50-149 mV spread on a balancing pack stayed silent for as long as the BMS balanced. So did a spread alternating 55 / 45 / 45 mV, and a pack whose SoC read 84 / 85% on alternate readings.
  - Dips under the line do not restart the 20 minutes; only 20 minutes seen under 50 mV ends the session.
  - The session is carried across reading gaps of up to 60 minutes and across a restart. `vdiff-knee-state.json` gains `offFromMs`, `offQuietSinceMs` and `offKnee`, each written only while set.
- A 50-149 mV spread on a pack at 15% charge or less, within 10 points of its sibling packs, no longer sounds red at once.
  - On the steep bottom of the LFP curve, the cell with the least charge falls away and closes back on recharge. In the 2026-08-20 case, a healthy pack's red cleared in 6.7 minutes.
  - The critical stays on the card ("Low-charge cell spread."), is not pushed or sounded, and speaks after 20 minutes.
  - These get no low-charge grace:
    - a pack 10 or more points below its siblings (the alert names its charge and the sibling median)
    - a session that reached the line on any other reading
  - They page at once while the BMS is idle. While it reports balancing they are held by the balancing mute, and speak 20 minutes after the first crossing, like any balancing critical below 85%.
  - A spread of 150 mV or more pages at once, balancing or not.

**Unchanged**

- The runway alarm, the projected-dip and forecast-runtime alerts, the calendar's battery-dip event and Home Assistant's projected-low-SoC sensors still count only the Cores reporting live.
- Cell spread at 85% charge and above. The SoC ladder, the floor alarm and the stale alarms. "Reserve alarm blind" changes only across a restart (below).

**Tests**

- New: `forecastDisplayBasis.test.ts` covers the restored series and its SoC walk, isolation from every alarm input (by behaviour and by source), the restored model's flag, the restored-Core count, the cards' view and its wiring, the badge while a first reading is pending at a restart, and the charge leg on the restored walk (3,750 W restored against a 1,865.7 W drain stores 1,747.4 Wh an hour: 61.5% after the first hour, 94.9% after 24, against 97.7% at unity).
- New: `runwayHeldPanelLoad.test.ts` covers the live-load gate, the carry limit across a hold, and the runway alarm and load-shed advisor holding while the runway is unavailable.
- New: `cellSpreadOffPlateauSession.test.ts` covers the off-plateau session, the low-charge knee (a stranded pack while the BMS balances included), and both across a restart.
- The dark-fleet forecast golden gains the four display fields only; every earlier field is unchanged. `runwayChargeLegPins.test.ts` pins the charge leg inside the shared step and both walks' calls to it.
- New harnesses, all mutants killed:
  - `mutate-forecast-display-basis.mjs` (24)
  - `mutate-held-panel-load.mjs` (8)
  - `mutate-cell-spread-off-plateau.mjs` (19)
- Anchors re-pointed in older harnesses: `mutate-runway-card.mjs`, `mutate-v1187-1.mjs`, `mutate-v1187-2.mjs`, `mutate-v1187-19.mjs`, `mutate-v1187-a.mjs`, `mutate-v1191-1.mjs`, and `mutate-charge-leg.mjs` C-ii (the day walk's charge leg, now in the shared step).

### After a restart an owed all-clear is announced; a critical nobody heard is named when it returns; an announcement kept behind another alarm's retry is spoken

**After a restart**

- **An all-clear that was due when the add-on stopped is announced after the restart.** When an alarm the house had heard cleared, the add-on waits three minutes before announcing the all-clear (up to 16 minutes after a restart, and longer while a muted cell-imbalance critical holds it). A restart during that wait lost the all-clear. The add-on started with the alarm recorded as not heard and took the clear condition in silence, so the alarm stayed the last words. The wait is now saved with the condition record (`conditionHeldFrom` / `conditionHeldAt` in `broadcast-last.json`, and `conditionHeldFrom` in `/api/broadcast/status`). After a restart within an hour of the wait's start, the all-clear is announced once the condition has stayed clear for three minutes on a complete alert picture. If the picture is still incomplete when the post-restart decision closes, the clear condition is taken in silence, as for an alarm heard before a restart. These alarms all count as heard: one heard only as the tone (its speech failed), one heard only on the cordless, and one first heard during the wait itself (it cleared while its announcement was still playing, or its retry played during the wait). An alarm first heard during the wait no longer marks the record as heard while its clearing is held. A warning standing below it is therefore announced after a restart, not taken as its continuation. A condition that cleared while the add-on was stopped is still not announced.
- **"Reserve alarm blind" keeps its age for a panel dark more than a week.** A pool unreadable for more than 7 days lost its saved onset at a restart. The alarm disappeared for 15 minutes and came back as a warning for an hour, even when it had been critical. Only an onset claiming more than a year is now set aside, since it comes from a clock that was not set or an edited file. A panel that has not reported since the restart holds the post-restart decisions only until its own reserve-blind alarm is raised. The house panel has no reserve-blind alarm while it reports nothing, so it holds them until it reports.
- **A read-only data folder no longer carries an old "Reserve alarm blind" time.** On a read-only or failing disk, the saved time could be neither updated nor removed. A pool that read again after the last save was then carried after a restart as unreadable since before, and could raise a critical alarm with an inflated age. When the folder cannot be written at start-up, the saved times are not carried and never written back, and the log says so (`backup-pool: N pool-unknown onset(s) on file are not carried — …`). Each panel's reserve-blind clock then starts in the new process. The post-restart decisions wait by the same rule as above: for the house panel until it reports, and for any other panel until it reports or its own alarm is raised.

**Announcements**

- **A critical alarm nobody heard is announced when it comes back.** During one alarm, a critical that took another's place was treated as heard, even though only the first one was heard and the new one never reached the speakers. When it cleared and came back within three minutes, it was not announced again and was never named. A return is now announced when the alarm its words would name has not been heard during that alarm. A return refused by the two-minute gap is announced when the gap expires. Two alarms that return together, when the words name the one already heard, are still taken as a flicker. After a restart, an alarm found already announced counts as heard only the critical that announcement named. Another critical that stood beside it and returns alone is announced, as it would be without the restart.
- **An announcement that waited behind another alarm's retry is announced when that retry is done.** When the speakers could not play and a more serious announcement was already waiting to be retried, a less serious condition announcement was dropped. This lost a warning under a held critical, or a warning or an all-clear behind a battery-level or runway alarm. The same happened in the other order: a battery-level or runway alarm that failed while the condition announcement's own retry was waiting took that retry's place. The dropped announcement is now made once, when the other retry has played or given up, if the condition has not been committed at another level since. After a more serious condition alarm it waits the usual two minutes. Only one such announcement is kept at a time: the newest, unless the one already kept is more serious. A dedicated announcement kept the same way is not re-announced as a condition.

**Tests**

- `restartRecoveryAllClear.test.ts`:
  - A restart inside the dwell of a heard red, a heard yellow or a tone-only red announces the all-clear on a settled set. So does one after a red first made audible inside its own dwell: cleared while its announcement played (spoken or tone only), or with its retry played in the dwell.
  - A warning that stood below such a red is spoken after the restart, and the red flickering back restores its heard flag.
  - The critical back after the restart is the klaxon, with no all-clear before it.
  - A warning below the cleared red is spoken, whether it stands at the first tick or appears after it. At the first tick the owed hold is dropped at once, and the warning's clearing is an ordinary transition.
  - A warning re-committed under a resumed hold and never delivered is presented again when it returns inside the dwell.
  - On an unsettled set, the green is adopted silently when the decision closes.
  - Two restarts inside the hold still owe the all-clear, and the hold's age counts from its original start.
  - Nothing is owed after the green commits, or after the red flickers back, spoken or tone only (the cleared record is written to disk).
  - `restoredHeldDeescalation` checked by hand.
- `conditionRetryNewestWins.test.ts`:
  - A warning kept behind a red retry (held critical) is spoken after the gap. One behind a dedicated critical's retry is spoken with no gap.
  - An all-clear behind a dedicated warning's retry is spoken.
  - A warning, and an all-clear, whose own retry a dedicated alarm superseded are spoken.
  - A warning behind the dedicated alarm does not displace the more severe condition red kept before it. That red is named when its critical reads loud again.
  - A kept deferral is dropped when the condition has moved, and re-presented at once when the higher retry gives up.
  - A fired retry still queued plays first.
  - A dedicated notice is not re-presented.
  - `keptDeferralRepresent` checked by hand.
  - A critical that took a heard one's place undelivered is named when it returns, including after a gap refusal.
  - Still absorbed: a heard critical's flicker, two criticals returning together whose words name the heard one, and a red adopted by the red replay gate. A critical counted beside the adopted one and never named is spoken when it returns alone.
  - What was named audible resets with each red episode.
- `poolUnknownCarry.test.ts`:
  - A panel dark 7 days and an hour keeps its onset across a restart: critical "unreadable for 7 d" at once, carried at its first projection.
  - The pending rule ends when the dark panel's alarm is raised (inclusive at 15 min), and never for the pinned house panel. `darkPanelBlindRaised` tested.
  - A read-only directory carries nothing, keeps the panel pending, logs once, and writes nothing back once it is writable again. These tests skip only when a write probe of the directory succeeds, not on `poolUnknownDirWritable`'s answer.
  - `poolUnknownDirWritable`, the 366-day bound, and the alert monitor's wiring.
- New harness `scripts/mutate-restart-leftovers.mjs`: 42 mutants (F-i…F-xvi, N-i…N-viii, P-i…P-vii, D-i…D-v, O-i…O-vi).
- Re-pointed anchors: `mutate-v1187-4.mjs` H-i, H-ii, U-iii, U-iv, U-v, U-vii, U-viii, C-ix, C-xvi, C-xx, C-xxiii; `mutate-v1187-3h.mjs` B-i, B-ii; `mutate-v1187-b.mjs` xxiii, xxxv; `mutate-multi-panel.mjs` r11; `mutate-alert-monitor.mjs` xxiii; `mutate-broadcast.mjs` vii; `mutate-v1187-10-g3.mjs` C1-i.

## 1.194.0

### Solar surplus counts at the charge efficiency in the runway, the forecasts and the night-charge plan

**Runway and forecasts**

- The runway, the 24-hour and multi-day state-of-charge projections and the confidence band added solar energy beyond the house load to the battery pool in full. Charging the packs loses energy: on 29 measured sunny spans the pool gained 2–7% less than projected. A surplus now counts at the charge efficiency, the square root of `DISPATCH_ROUND_TRIP_EFFICIENCY` (0.927 by default), so a projection across a sunny day reads shorter. On a day with 44 kWh of surplus, the reserve crossing comes about 1 h sooner (22.8 h instead of 23.8 h) and the pool ends 3.2 kWh lower. An 18 kWh pool with two sunny hours ahead now reaches the reserve in 5.9 h instead of 6.1 h, which raises the medium runway alarm instead of the low one. The runway, forecast-runtime and forecast-soc-dip alerts can come up to about an hour earlier on a horizon that crosses a sunny day.
- The confidence band applies the charge efficiency to each path after its spread is added, and reads the trajectory's capacity with the same step.
- `DISPATCH_ROUND_TRIP_EFFICIENCY` (environment only, clamped 0.8–1) now also sets the alarm path's charge efficiency. Setting it to 1 puts the runway's and the projections' surplus credit back at unity; it also makes the night-charge and dispatch plans' charging lossless, so they buy less than before. No setting makes a projection longer than before.

**Night charge**

- The plan's walks count a surplus the same way: the worst-case sizing walk, the window walk, the expected-buy walks (expected carry, solar credit, force-charge timing) and the mid-day preview's held-import estimate. A trough that follows a sunny day's 31 kWh of surplus sits 2.25 kWh lower, and the buy that holds the line is 2.43 kWh larger.
- Of 1,104 recorded plan cases, 95 worst-case buys rise by up to 2.84 kWh (mean 0.44 kWh), 118 expected buys rise by up to 6.76 kWh (mean 1.17 kWh), and one hold becomes a 1.49 kWh charge. No buy, expected buy or requirement falls. 264 setpoints move, by −1.8 to +2.7 points. The 16 that fall are either charges limited by the window whose requirement rose, or holds whose projected arrival without a buy is now lower.
- The readiness gate keeps algorithm version 3, so nights already scored still count. `buy_err_kwh` keeps its formula. A miss in an hour with a surplus, solar or load, now reads about 7.8% larger against the plan's own sizing than before, in either direction: a solar miss there reads 7.8% larger than the plan's sizing (it read exactly), and a load miss there about 1.4% larger (it read about 6% smaller). A cloudier day or a heavier daytime house than forecast scores as a deeper under-buy, which makes the gate more likely to block. Only misses in hours without a surplus are scored as before.

**Unchanged**

- Hours without a surplus, the alarm thresholds, the grid-backstop mute of the audible runway alarm, the dispatch plan (which already counted the charge efficiency) and the MPC optimiser. There is no new option.

**Tests**

- `runwayChargeLeg.test.ts`: the step, the efficiency, the runway's change of alarm tier, the sunny-day runway, a horizon with no surplus, the planner's sizing trough, window walk, expected carry (+2.782 kWh for an hour of 5 kW sun over a 1.88 kW house, was +3.000) and force-charge start, and the ledger's `buy_err_kwh` against the planner's own re-sizing for a solar and a load miss in a surplus hour and in a deficit hour, all worked by hand. A further case shows that at `DISPATCH_ROUND_TRIP_EFFICIENCY` = 1 the planner buys 0.80 kWh below the earlier default. `runwayChargeLegPins.test.ts`: every walk calls the step, the option's descriptions name the alarm path, and the `buy_err_kwh` notes (the gate's and chapter 15-2's) name the surplus-hour load miss.
- The legacy identity golden is regenerated on purpose (472 of 1,104 plan digests move). A new direction test checks every case against the plans recorded on 1.192.0, which 1.193.0 plans identically (`legacyIdentity.v1192.figures.json`).
- The `middayPlan`, `nightChargeExpectedBuy`, `heldImport`, `middayShadow`, `poolEnergyBasis` and `runwayBasisContracts` figures are re-derived for the charge efficiency; `runwayBasisContracts` gains a reference-band test across a sunny stretch to the full rail.
- New `mutate-charge-leg.mjs`: 19 mutants, all killed; one of them stores only the PV at the charge efficiency in the sizing walk, so a surplus hour's house load skips the step. Ten anchors in `mutate-v1187-19.mjs`, `mutate-v1187-22c.mjs` and `mutate-midday-plan.mjs` are repointed.

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
