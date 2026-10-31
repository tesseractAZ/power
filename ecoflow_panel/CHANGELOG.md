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

## 1.193.0

### Lifetime energy counters never step down or jump; panel counters no longer dip after a load drop

**Energy (Home Assistant)**

- Every lifetime counter the add-on publishes now only rises: PV Production, Home Consumption, Grid Import (Home), Grid to Battery Charge, Battery Energy In and Out, and each circuit. Home Assistant reads a value below 90 % of the previous one as a meter reset and books the whole new value again; it books any rise as energy. The membership re-seed and the floor/live gap repair used to step Battery Energy In and Out down to the new pool's sum, so each time the full counter went into the Energy statistics again (about 12,043 kWh on Battery Energy In by 2026-09-07; the Month and Year views read about 4.4 times high).
- The battery floors still re-seed against the new set of batteries. The published counters now continue from their last values, and the difference is kept as a basis shift: the `lifetime_basis` table, and `shiftWh` in `/api/lifetime-energy`.
- The floors, their shifts and the accepted set of Cores (the new `bms_membership` table) are written in one transaction, so a crash or a failed write can never pair a re-seeded floor with an old shift or roster. `bms-membership.json` is still written after each commit, for older releases. It is read only on the first start after the update, and rewritten when it disagrees with the database.
- A Core joining the pool counts from the re-seed. Its packs' history since their baselines is no longer published as one step up (+6,144 Wh in one read on the test plant). Energy it moves in the 15 minutes before the re-seed is not counted.
- Every counter now holds a drop between reads of up to 5 kWh at the last published value. Before, only two counters had this 5 kWh hold and the others held 50 Wh. A larger drop with no known cause continues from the last value and logs one warning naming the counter (`recorder: v1.193.0 WARN lifetime counter …`).
- A drop continued from that way stays owed (`owed_wh` in `lifetime_basis`). When the reading climbs back (a rise of over 5 kWh and at least half the amount owed), up to the amount owed is taken back off the shift and is not published as energy. Without this, a counter that read 0 and then its old value would publish twice its value: on 2026-06-08 every counter read 0 from 18:00 to 19:00, and Home Assistant booked PV Production about 808.6 kWh and Home Consumption about 825.1 kWh a second time. The owed amount survives a restart and expires 24 hours after the drop, so a drop that never comes back (a replaced database) cannot hide a later one's return. Once no more than 5 kWh is owed, every rise is taken back until nothing is. A drop that comes back in steps each under half the amount owed is published as it returns.
- Between rollups, Home Consumption, Grid Import (Home) and the circuits could read lower than a moment before after a sharp load drop: 64 to 223 Wh, and up to 3.2 kWh across a 10-minute silence at 19.2 kW. A read held the last panel reading forward to the moment of the read, and the next reading revised it. Home Assistant logged these as "not strictly increasing" and, across an hour boundary, booked a negative hour. Reads now integrate each series up to its newest reading only, so a published value lags that reading by at most one sample interval (up to 5 minutes for a steady load).
- `/api/lifetime-energy` `details` carry `shiftWh` and `heldWh`. `battery_baseline_deficit_kwh` is computed from the measured values, without the shifts. `/api/debug/battery-lifetime` reports each battery counter's shift. The lifetime carbon figures use PV Production with its shift.
- If reading the lifetime counters fails, the MQTT state and `/api/ha-state` publish their fields null (Home Assistant: unknown, not a reset) and the circuit fields follow the live circuits. The runway, the alert counts and every other field still publish.

**Documentation**

- The alerts reference gives the per-device telemetry-gap alert id as it has been since v1.188.1: `system-outage-device-<SN>-<alertStartMs ?? startMs>-3`.

**Unchanged**

- Statistics Home Assistant already recorded are not modified. Alarms, the runway and the night charge read none of these counters.

**Rollback**

- Once any counter shows a non-zero `shiftWh`, a release before this one publishes it without the shift. That is a step Home Assistant books as a meter reset (a step down of 10 % or more), as a negative hour (a smaller one) or as energy (a step up). Do not roll back past this release after a pool change.

**Not covered**

- An add-on restore of `/data` reverts the totals, the shifts and the high-water file together, so a restored counter publishes its older value.

**Tests**

- New: `lifetimeEmitGuard.test.ts` (replaces `lifetimeDipClamp.test.ts`), `recorderPoolContinuity.test.ts`, `recorderLifetimeReadMonotone.test.ts` and `helpers/haTotalIncreasing.ts` (Home Assistant's reset rule). `recorderPoolContinuity.test.ts` covers a leave and a rejoin, a restart, a failed floor commit on a leave and on a rejoin, a rebase in between, and a stale or unwritable roster file.
- `recorderFloorGapInvariant.test.ts` adds both floors above the live sum. `recorderLifetimeKeys.test.ts` adds the worker's shifted totals. `analyticsWorker.test.ts` adds the persisted keys failing. `haPayloadFmt.test.ts` adds the measured deficit and its wiring.
- Tests that asserted the step down, the pass-through of a large drop or read/rollup equality are changed, with the reason stated.
- `lifetimeEmitGuard.test.ts` adds the take-back rule and 1,000 random walks with drops that come back. `recorderEmitHighwater.test.ts` adds a counter that reads 0 and then its old value, in one process and across a restart. The new `recorderLifetimeTakeback.test.ts` covers Battery Energy In through the floors' transaction, the expiry after a replaced database, and the high-water file waiting for an uncommitted shift.
- `mutate-lifetime-monotone.mjs` is new (45 mutants). `mutate-energy-core-outage.mjs` re-points B-xviii, B-xli, B-xcvi, B-ciii and B-civ.

### README screenshots are rendered from a synthetic fleet, and nothing is written until the pixels are checked

**Documentation**

- All five README screenshots (`docs/screenshots/dashboard.png`, `solar.png`, `battery.png`, `strategy.png`, `alerts.png`) are re-rendered at 1280 px from a committed, fully synthetic fleet. The images they replace were captures of a live installation, masked by serial shape. That masking does not catch EcoFlow's default device name, "<product>-<last four digits of its serial>" until the device is renamed, or installation-specific names and figures. The paths are unchanged, so README links and the documentation build are unaffected.
- The fleet (`scripts/screenshots/fixture.mts`) has seven devices: one Smart Home Panel 2, three DELTA Pro Ultra Cores with 15 packs, an EV charger, a DELTA 3 Plus and an offline Smart Generator. Every serial is a placeholder, every device name is a product name, and the circuits keep the panel's default names. One minute-step plant model drives every card, chart and report, at a fixed clock (Wed 17 Jun 2026 12:30, America/Phoenix). Re-capturing an unchanged fixture gives byte-identical images.
- `scripts/screenshots/capture.mts` drives headless Chrome through the real built UI against `serve.mts` (127.0.0.1 only; writes are refused). It writes no image unless every tab passes all of these:
  - The page asked for no endpoint or history metric the fixture does not serve, including a read of a path the UI only writes to.
  - No card is still loading or reports itself unavailable.
  - The page's text holds no serial outside the fixture's placeholders.
  - Neither the page's text nor an OCR read of the image (full-size and downscaled) holds a device name ending in a hyphen and four digits. This covers a product name that ends in a model number, such as "Smart Home Panel 2-NNNN" or "DELTA 2-NNNN".
  - Each tab's positive controls are read, and an OCR read returns at least 20 lines.
  - The page text passes `check-no-secrets.py --stdin`.
  
  The serial rule is not applied to OCR, which can read a 0 as an O. The capture is run by hand on macOS (headless Chrome, Vision OCR). It is not run in CI.

**Checks**

- `scripts/check-no-secrets.py --stdin` applies the scan's shape rules, and the private value rules where configured, to text on standard input. A run with no flag is unchanged.
- `scripts/check-mutant-anchors.mjs` resolves `.mts` targets.

**Unchanged**

- The screenshot tooling changes no add-on code, option or behaviour.

**Tests**

- `screenshotFixture.test.ts` (T1–T9) covers:
  - Placeholder serials only; product names only.
  - Every API path the UI names is served, write-only or comment-only.
  - The leak gate fires on default names (a product name ending in a letter, a parenthesis or a model number) and not on dates, phone numbers or channels.
  - The replay server refuses writes, and refuses and reports a read of a write-only path.
  - One clock, and one consistent plant.
  - Each caption's element is present. The runway weekday is checked in the zone the suite runs in.
  - The capture refuses a stale bundle.
- `checkNoSecretsStdin.test.ts` runs a copy of the script in an empty directory, so a maintainer's own pattern file does not change the result.
- `mutate-screenshot-gate.mjs` is new (21 mutants).

## 1.192.0

### The mid-day charge preview states what a held reserve costs; documentation files are named Power

**Night charge (mid-day preview, nothing written)**

- The SHP2 does not discharge the pool below its backup reserve, so while a charge leg holds a raised reserve, house load the pool would have carried comes from the grid. The mid-day preview now estimates that energy for each leg it sizes, from the write at the window open to the restore, on the median load and PV the leg was planned on, and prices it: hour by hour at the tariff's rates, less what the next charge no longer buys at the mid-day rate (the energy the pool kept, over the charge efficiency). The lift to the reserve is the leg's own draw and is not counted.
- The outage backup is also sized on option B (its walk ends at the 10:00 open) beside option A (to 23:00 the next day), so the choice between them is made on real nights. Option B is a comparison only: it is never armed or announced, and the mid-day leg is still sized from option A's hold.
- On the 2026-10-14 test fixture, option A's 50% hold sends about 9.3 kWh of house load to the 12.59¢ overnight rate and adds about $0.30 a weeknight; option B's 40% hold sends about 0.6 kWh ($0.02); the mid-day leg's own hold sends nothing under the sun.
- The figures go to the evening's `night-charge[midday-shadow]:` log lines, to the preview record on the status, and to eight new ledger columns: `shadow_backup_held_import_kwh`, `shadow_backup_held_net_usd`, `shadow_cost_held_import_kwh`, `shadow_cost_held_net_usd`, `shadow_backup_b_setpoint_pct`, `shadow_backup_b_expected_buy_kwh`, `shadow_backup_b_held_import_kwh` and `shadow_backup_b_held_net_usd`. With rates not confirmed the energy is stated and nothing is priced.

**Release**

- The documentation attached to each release is named `Power-Documentation-v<version>.docx` and `.pdf`, and the files the CI documentation build produces `Power-Documentation.docx` and `.pdf` (were `EcoFlow-Panel-Documentation-…`).

**Unchanged**

- Nothing of the mid-day cycle is armed, written, pushed or spoken; the overnight charge runs as before.

**Tests**

- `heldImport.test.ts`: the held import and its price worked by hand (the lift, the discharge efficiency, a full pool's spill, the hours' rates, unpriced rates, the hold's span, the planner glue). `middayShadow.test.ts`: the evening records option A's and option B's held import on the engine's own plans, B is never probed or armed, and an older record reads back unchanged. `mutate-midday-ledger.mjs` gains ten mutants (H-i…H-x).
- The SSH console tests (`sshServer.test.ts`, `sshCaps.test.ts` and the child helper) take their host key from `generateHostKey`, as the add-on does since 1.191.7: their one shared key came from ssh2's own generator, so the 1 malformed key in 256 failed every test in the file (seen once, nine tests in one run).

## 1.191.7

### A new SSH host key is checked before it is saved

**Console**

- The SSH library (ssh2 1.17.0) drops a leading zero byte from the public half of 1 generated host key in 256, and then rejects that key as malformed. When that happened on the start that first generated the key, the SSH console stayed off for that start and the log read `console/ssh: failed to start: Malformed OpenSSH private key`; the next start replaced the key with a warning. A generated key is now read back before it is written, and one that does not parse is discarded for another (up to 8 tries). An existing host key is unaffected and keeps its fingerprint.
- The same defect failed the host-key test in about 1 CI run in 100.

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
