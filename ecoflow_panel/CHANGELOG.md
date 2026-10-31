## 1.197.1

### The house panel's reserve-blind alarm stands while the panel has no reading after a restart

**Alarms**

- The house panel's "Reserve alarm blind" now stands when the panel has had no reading at all since the add-on restarted (the EcoFlow cloud has not returned its data). Before, the house pool had no reserve-blind alarm in that state. The house panel is pinned on every plant, and a pinned panel with no reading was left out on both paths: the house panel's own alarm needs a reading, and the dark-panel alarm (1.185.0) covers only the other panels. The only alert was the "Running off-grid" info. Since 1.195.0 the alert set waited for that panel to report, so no false all-clear followed, but nothing said the reserve alarm could not see the house pool.
- It is the house panel's own alarm: the same id (`reserve-alarm-blind`), wording, family, push and audible rules. It counts from the onset the add-on carried across the restart, or else from the panel's first listing after it. A pool blind before a restart and still dark after it is therefore critical at once off-grid, not absent for 15 minutes. On a cold boot it waits 15 minutes from the first listing, the same grace as any other panel's dark alarm, so a first reading that is merely slow raises nothing. It turns critical after 60 minutes while the house pool's own grid is not backing it up, and stays a warning while it is. On a two-panel plant it reads the house pool's own grid and its own Cores.
- A panel dark since a cold boot keeps its onset across a second restart. The add-on now saves the time it first listed a panel that has not reported since, the onset that panel's alarm counts from. Before, nothing was saved for it, so a second restart while the panel stayed dark started the clock again: the critical was absent for 15 minutes (the boot sweep sent "Resolved"), then a warning until an hour after the new listing. This held for a dark secondary panel too. The panel's first reading retires the saved onset at once when the pool reads.
- The panel's first reading hands over without a break. A pool that still reads unknown keeps the onset the alarm was counting from. Before, the clock restarted at that reading, so the alarm cleared with a "Resolved" push, came back 15 minutes later and stayed a warning until an hour after that reading, even when it had been critical. A dark secondary panel's alarm hands over the same way. A pool that reads ends the alarm.
- The hand-over also holds when the first reading arrives while the alert monitor is refreshing its Home Assistant states. The monitor read the panel as dark before that wait and as reporting after it, so the alarm was missing for one pass: a "Resolved" push, then the alarm again 20 seconds later. The monitor now reads both after the wait.
- Once the alarm stands, the panel no longer holds the alert set unsettled. Any other dark panel already worked this way since 1.195.0. Before, a house panel dark for a week kept the set unsettled for the whole week.
- On a one-panel plant, a dark house panel left out of three device lists in a row stays the house panel. Before, it became a second panel for the alarms: its alarm switched to `reserve-alarm-blind-<serial>` and back once the panel was listed again, with a "Resolved" push and a new critical at each switch. A house panel with a reading is unaffected: it was already found as the house panel.
- The alarm now names its panel, as a secondary panel's alarm does. When the alarm leaves the set while that panel sends no fresh data, the alert monitor holds it instead of sending "Resolved". A dark house panel that leaves the account on a two-panel plant therefore no longer sends "Resolved: Reserve alarm blind" while the pool is still unread.

**Unchanged**

- A pinned house panel that has left the account while another panel is on it still raises the critical "House panel not on the account". No reserve-blind alarm is added for it, and it holds the alert set unsettled until it reports.
- A one-panel plant raises no "House panel not on the account" when its panel drops off the device lists, as before. Night charge is not paused there.
- With no house panel pinned, a dark panel raises its own `reserve-alarm-blind-<serial>`, as before. A house panel with a reading is unchanged.
- On a read-only `/data` nothing is saved or carried, as since 1.195.0.
- Not covered: a one-panel plant whose pinned panel is missing from every device list after a restart. That panel is not in the device map at all, so neither this alarm nor the "not on the account" critical stands.

**Tests**

- New: `houseReserveBlindDark.test.ts` covers the reproduction (pinned, dark across a restart, off-grid: critical at once), the cold-boot grace, the hand-over, the pending rule, a pin missing from the account, no pin, two panels and the monitor wiring. Two tests in `poolUnknownCarry.test.ts` that pinned the old behaviour now assert the new one: the house panel had no alarm while dark and stayed pending.
- New: `houseReserveBlindCarry.test.ts` covers a second and third restart while a panel stays dark since a cold boot (house and secondary panel), a restart inside the cold-boot grace, the saved onset retired or kept at the first reading, a normal boot writing no file, the one-panel plant's pin with its panel off the lists (dark and reporting), two panels off the lists, and the alarm's panel serial on every path.
- New: `houseReserveBlindMonitor.test.ts` runs the real alert monitor with Home Assistant mocked. It covers a first reading that lands during the Home Assistant refresh, a dark house panel leaving the account on a two-panel plant, and a second restart, where the boot sweep must not resolve the alarm. A source check pins the order of the monitor's pass.
- New harness `scripts/mutate-house-blind.mjs` (25 mutants). Anchors are re-pointed in `mutate-restart-leftovers.mjs` (D-iii, now a pin missing from the account), `mutate-v1187-4.mjs` (C-i, C-xxiii) and `mutate-multi-panel.mjs` (r3).

## 1.197.0

### One Core's own alarms can be shelved for a set maintenance window

**Alarms**

- A maintenance window shelves one Core's own alerts for 15 minutes to 4 hours. The card offers 30 minutes, 1, 2 and 4 hours, with 2 hours by default; a request outside the limits is refused, never clamped. The alerts stay on the card and in the alert list, marked shelved, and are neither pushed nor spoken. An extension cannot pass the window's start plus 4 hours; a longer job ends one window and starts another.
- The window ends:
  - at its time;
  - once the Core, seen abnormal during the window, has been back to normal (reporting, and no new warning or critical of its own) for 15 minutes;
  - when ended from the card, `POST /api/maintenance/end` or Home Assistant's End All Maintenance button;
  - if the clock steps back before its start, its span is over the limit, or the Core leaves the account.
- Whatever is still active when the window ends is pushed and announced. That includes a warning the window held across a restart, and an alert standing on a Core whose window ran out while the add-on was down.
- A window never shelves:
  - a pool alarm: the reserve floor, near reserve, the runway, the battery-level ladder, the reserve-blind and telemetry-blind alarms;
  - grid loss, a panel alert or any plant-level alert, even when the shelved Core causes it;
  - an overheating pack, a cell at the over-voltage line, a confirmed-defective pack or the multi-panel guard.
- The panel cannot be shelved, and a window naming any device but a Core has no effect.
- On a plant with more than one home Core, a start that would leave none of them with its alarms is refused. A Core off the panel roster while it is re-wired still counts.
- 'All clear' is not spoken while a shelved critical stands. That includes the all-clear a restart inside a clearing owes (1.195.0): a window that starts while its Core's red stands makes the red read clear with the fault still on the card, and after a restart in that dwell the green is adopted in silence.
- The all-clear a shelved critical holds back is owed, not dropped. Two cases needed this: a red heard before its Core was shelved and then fixed inside the window, and a red that cleared while another Core's critical was shelved. Dropped, the all-clear would never be said in either case, and the last words in the house would stay a red that had cleared. The all-clear is now said once no shelved critical stands and the all-clear gate has been open for 3 minutes. That covers the transition's own all-clear and its storm-gated re-present, spoken retry and deferred retry. A shelved critical that returns for one reading restarts the 3 minutes. Quiet hours apply, as to any all-clear.
  - If the window ends with its critical still standing, the critical is announced, and its own clearing gets the next all-clear.
  - If the reserve floor or the held telemetry-blind alarm is what still blocks the all-clear, it is dropped, as before.
  - The owed all-clear survives a restart within 4 hours of when it became owed. After a restart it is said only once the alert set has settled.
- A per-device telemetry gap that began inside a window stays held for as long as its alert stands.
- A setting changed on a shelved Core is listed in the window's end push instead of being pushed on its own. The panel's reserve floor is always pushed.
- There is one push at the start, listing what still sounds, and one at the end, listing every alert held, what is still active and the settings changed. Each start, extension and end is in the write log (`maintenance-start`, `maintenance-extend`, `maintenance-end`) and in the add-on log.
- Background: on 2026-08-20 a planned reconfiguration of two Cores produced 42 pushes and 7 broadcasts, three of them red. The only runtime control was the per-priority switch in Alert Settings. It applies to the whole plant, including the battery-level ladder and the runway, and does not expire.

**Fail closed**

- An unreadable windows file shelves nothing, and a start whose save fails is refused. An end that cannot be saved removes the file, so a restart shelves nothing.
- The end time and the 4-hour limit are checked each time an alert is stamped. A window that has run out but has not yet been stepped is ended before a start or an End now acts.

**Home Assistant and API**

- New entities:
  - the binary sensor Maintenance Active (`ecoflow_maintenance_active`);
  - the sensor Cores in Maintenance (`ecoflow_maintenance_devices`, attribute `cores`);
  - the button End All Maintenance (`ecoflow_maintenance_end_all`).
- New state keys `maintenance_active`, `maintenance_count` and `maintenance_summary`, in the MQTT payload and `/api/ha-state`. Nothing over MQTT starts a window.
- New routes `GET /api/maintenance`, `POST /api/maintenance` (start or extend; write-gated) and `POST /api/maintenance/end`. `/api/snapshot` and `/api/health` carry the windows in force.
- `GET /api/broadcast/status` has `shelvedAllClearOwedAt`: when an all-clear held back by a shelved critical became owed, or null. `broadcast-last.json` keeps it across a restart.
- The windows are kept in `/data/maintenance-windows.json`. `MAINTENANCE_STATE_PATH` overrides that path, for tests and development only; it is not an add-on option.

**Web**

- Each Core card has **Shelve this Core's alarms…**. While a window runs, an amber strip shows its end, the time left and what it has held, with **End now**. The alert list badges a held alert "shelved — maintenance until HH:MM".

**Documentation**

- `docs/screenshots/dashboard.png` is re-rendered from the synthetic fleet with the maintenance control on each Core card; the other four images are unchanged.
- The operator guide describes shelving a Core under Alerts and phone notifications. The alert monitor reference (section 4.7) gives the rules in full, and the alerts, broadcast, runway, Home Assistant, user-interface and security chapters, the feature inventory and the entity reference are updated.
- The Home Assistant wiring chapter and the feature inventory give the new discovery counts: 88 sensors, 12 binary sensors, four switches and one button, which is 105 retained publishes, plus the per-circuit pairs.

**Unchanged**

- The Alert Settings switches, the bench-spare and off-panel mutes, and the Home Assistant alert counts, which include shelved alerts.

**Tests**

- `maintenanceWindow.test.ts` (41), `maintenanceWiring.test.ts` (9: the real alert monitor, with flapping held, a restart mid-window, a window that expired while down, the early end on return to normal and a forged panel window), `maintenanceMqtt.test.ts` (2: End All Maintenance through the real MQTT discovery and a broker run inside the test) and `maintenanceWebMirror.test.ts` (3: the card's copies of the server's limits and list).
- `maintenanceOwedAllClear.test.ts` (12) runs the real broadcast monitor. Across a restart inside a red's clearing: with the critical cleared, the owed all-clear is spoken; with the critical held by a window, no all-clear is spoken, the critical is announced when the window ends, and its clearing gets one all-clear. The all-clear a shelved critical holds back is said once the critical is fixed inside the window, including a flicker of it, for a red on another Core, after a restart inside the window (never on an unsettled set), and for the all-clear's storm-gated re-present, spoken retry and deferred retry; it is dropped behind the reserve floor. Three cases pin the pure parts.
- Additions to the `settingsDrift`, `settingsDriftHold` and `mqttDiscovery` tests; `docsLayout` counts the button and pins the discovery counts the engineering reference states.
- The MQTT discovery golden (G7) is re-captured with `scripts/golden-capture.mts`. The change only adds: the binary sensor's and the sensor's configs, the binary sensor and sensor counts (11 to 12, 87 to 88), and the three unique ids. No other golden changes.
- The README-screenshot fixture lists `api/maintenance` and `api/maintenance/end` as write-only paths of the Core card. `screenshotFixture.test.ts` counts 43 API paths in the web UI, was 41.
- New harness `mutate-maintenance-window.mjs` (39 mutants, twelve of them on the owed all-clear). `mutate-settings-drift.mjs` gains 1 mutant, and `mutate-blind-remediation.mjs` mutant xii is re-pointed to the all-clear gate's new line.

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

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
