## 1.188.1

### Only fresh readings are saved; while a battery reports nothing of its own, the Energy dashboard and the energy flow read the panel's meters

**History**

- After an internet outage left the batteries offline in the EcoFlow cloud, Power kept saving each battery's last reading as if it were new, every five minutes, for as long as the cloud listed it offline. After the outage of 14–15 October that was about 1,300 rows per battery per hour in which nothing changed, with solar at 0 W through a sunny day. Power now saves a device's readings only while they are fresh: a Core's only while its readings keep changing, since the cloud can answer with an old reading as if it were new. A device that is offline in the cloud, or whose last payload the cloud keeps replaying, leaves a gap in the history, and recording resumes with its first fresh reading. After a restart a Core is saved from its first changed reading, seconds later over the live stream. The two 24-hour charts on the Dashboard page break the line across such a gap instead of drawing the last reading flat.
- The readings saved that way are moved to a separate table in the same database, so the solar forecast, the typical-day curves, the soiling, health and energy figures, the history charts and the night-charge scoring no longer read them. The 7-day energy and carbon figures and the equipment-health trends are recalculated once the rows have moved. Nothing was deleted: the rows are kept unchanged and can be moved back; rows moved back stay in the history, also when they are moved back while a check is running, and so does the rest of the same frozen stretch while the device goes on repeating those readings, until a reading changes or the device comes back from a silence of more than an hour with one reading and falls silent again. The lifetime energy totals are not rewritten, because Home Assistant would read a decrease as a meter reset; the log states how much they took in from the frozen readings.
- A battery that holds the same readings for a while after a gap is not mistaken for a frozen one: only an hour of unchanged readings that were actually saved counts. If moving the rows fails partway, the next hourly check finishes the job.
- A frozen stretch ends at its last frozen reading, so a silence of more than an hour after it is not counted as frozen, and a battery that comes back from such a silence with the same readings it last had keeps those readings, unless it goes on repeating them for an hour. A shorter break inside a frozen stretch, such as an add-on restart, does not end it, and the frozen time on both sides of the break adds up. Which readings are moved does not depend on how often the check runs, after a restart or after a failed move, with one exception: a stretch whose readings are repeated more than ten minutes apart takes longer to reach an hour of frozen readings, and if that takes more than three hours, the hourly check leaves its first readings in the history, or all of them when the readings stay that far apart throughout (the first check, which reads the whole history, moves them). The log's figure for what the lifetime totals took in counts only the hours the frozen readings cover, and each later check that moves more of a stretch states its share.
- The check reads each device's history from its first saved reading and looks up each device's frozen stretches once, in short steps between the alarm checks.

**Energy dashboard**

- While a Core wired to the panel reports nothing of its own, its battery and solar energy are now counted from the panel's own meter on its slot. Battery Energy In, Battery Energy Out and PV Production keep rising, and Grid to Battery Charge counts the Core's AC input at the slot. That covers a Core offline in the EcoFlow cloud, and one the cloud lists online whose readings have stopped changing (the cloud answers with an old reading, or not at all) or have not arrived yet after a reconnect. Through the outage that began on 14 October these counters had stayed flat: battery in and out 0 kWh and solar 0.0 kWh for 15 and 16 October, while the house ran about 48 kWh a day on the batteries. A Core the cloud lists offline whose own data still arrives keeps counting from its own figures. A Core is taken over after three minutes without a reading of its own; a shorter offline flag is not an outage. Nothing is counted while the panel itself is offline.
- The panel measures what crosses between the Core and the panel, after the Core's own conversion, so battery out reads lower than the Cores' own counters would (5–8 kWh a day lower, replayed on days the Cores reported). Solar is 0 at night (judged at `FORECAST_LAT` / `FORECAST_LON`). In daylight it is the panel's per-slot solar reading once that reading has been checked against the solar the Core demonstrably took in (its output plus the rise in its charge level); until then it is that estimate, which reads 10–17% low. The log states each check with both figures.
- Fleet PV and Battery Net, the two power sensors the dashboard's Now view rates solar and battery on, count each Core the same way and never publish an old reading as live. They had read unknown for the whole outage, so the Now view showed 0 W of power usage while the house drew about 3.4 kW. They now read unknown, never a partial sum, in three cases. One is daylight until the panel's solar reading has passed its check (all day, if it reads short). Another is a Core's first three minutes without a reading of its own. The last is while the panel's own reading is not fresh.
- When a Core reports again, the jump in its own counters is absorbed instead of landing in one hour: it covers the whole time without a reading, and the panel already counted that energy. The panel keeps counting a Core that is listed online again but has not reported yet. The log states, for each Core, what its own counters measured against what the panel counted. No published total steps down when a Core goes offline or comes back, or when the add-on restarts during an outage, apart from one crash case the entity reference describes.
- Energy from before this update is not added afterwards. If the Cores are offline when it is installed, counting starts when the add-on starts again. The hours of the outage before that stay as Home Assistant recorded them; the "(EcoFlow ledger)" series cover those days.
- A pause of up to about 10 minutes in the panel's readings (the cloud replaying its last reading, or a poll failing) no longer drops whole 5-minute stretches from Panel Load, Grid Import (Home) and the circuit energy, nor from the battery and solar of a Core the panel counts for: the counters wait for the next reading and fill the pause from the readings on both sides. Since only fresh readings are saved, each pause had lost up to 10 minutes for good, about 0.67 kWh of grid import per 5 minutes of an 8 kW night charge. A longer pause is still not filled.
- A Core the panel counts for whose own data comes back while the cloud still lists it offline now counts its battery energy from its own pack meters while the panel's reading is not fresh; only its solar did before. After a crash, a Core's battery and solar from the last update to the crash are counted however long the add-on was down. A Core listed by two panels is counted once.
- One update with a battery's slot reading disconnected (a Core switched off and on while it is reconnected) no longer resets Battery Energy In and Out: the change must hold for three updates. They had dropped by a third, which Home Assistant books as a meter reset, and jumped back at the next update. A replaced or moved battery pack no longer leaves its Core counted at the panel at once on any later offline flag.
- AC Import counts each Core as Battery Net does: a Core listed online whose readings have stopped no longer publishes its last AC input (15 kW from Cores frozen during a grid charge, against a main at 400 W), and a Core the panel counts for adds the power its slot takes in.

**Dashboard**

- With every Core offline in the cloud and the panel reporting, the energy flow drew the house as grid import. On 16 October at 20:04 the grid main read 0 W and the Cores delivered about 3.4 kW through the panel, but the card showed 3.39 kW from the grid with the batteries idle. A Core with no reading of its own is now drawn from the panel's meter on its slot while the panel's reading is live. The Batteries box counts it ("3 via panel") and reads "out" or "in" rather than "discharging" or "charging", since the slot also carries the Core's solar. The Solar box reads "—" (Cores not reporting) when no Core reports its own solar.
- A Core listed online whose readings have not changed for 5 minutes is treated the same way, and a second panel whose reading is stale freezes the card's figures as a stale house panel does. While a Core's delivery is unmeasured, the grid is never drawn larger than the main measures.
- The backup time to full and time to empty (`/api/ha-state` and the console's RUN line) no longer show a time to full while the batteries drain through the panel: the console read "CHG 38m" during that 3.4 kW drain. With a Core offline its slot meter decides which applies, allowing for the Core's own standby draw, which the slot does not see. So at the reserve, with the slots near 0 W, no time to full is shown. With nothing to decide on, only the time to empty is shown. By day, once the panel's per-slot solar reading has passed its check, that solar is taken out first, so a charge shows its time to full, as Battery Net reads it.
- The energy flow counts each Core as the Home Assistant sensors do. A Core the cloud lists offline whose own data still arrives is drawn from its own readings. Once the panel's per-slot solar reading has passed its check, the Solar box shows that solar and the Batteries box the charge itself: it had read Solar "—" and "1.50 kW out" beside a Fleet PV of 6 kW and a Battery Net charging 4.5 kW.
- The console's solar and battery figures (PV.ARRAY.P, BATT.P.NET and the flow diagram) are the ones the Home Assistant sensors publish. During that drain the console read 0 W, idle.

**Night charge**

- A night whose solar or house-load figures include an hour or more with no fresh readings is not scored, and its note says so. Nights already recorded on frozen readings (14 October, and 15 October if it was recorded before this update) are recorded again from what was measured, once.
- The note of a night recorded again names only the figures that had been calculated from frozen readings; a figure calculated across hours with no readings at all is described as such. A night too old to record again is kept as recorded, and its note says how long its readings were frozen or missing.
- Solar and house load are checked separately: a night whose solar readings are found frozen only after it was recorded, with only the panel's frozen hours noted, is recorded again. A night left unscored for frozen readings that are later moved back to the history is recorded again from them, once no other battery's readings over the night are still frozen.

**Alerts**

- A device that stays offline in the EcoFlow cloud for more than six hours while the other devices keep reporting now raises the "Device telemetry gap" warning; the repeated readings had kept it from firing. The warning gives the time of the device's last reading before its frozen ones. For a battery whose last readings the cloud keeps replaying while Power is running, the six hours are counted from that reading too, also while the replay goes on and across a restart, and the warning is raised once; a fresh reading ends the count, also one made shortly before a restart. A restart while the device is still offline does not raise a second warning while the first is still listed; once it has been listed for 24 hours, a later restart raises it again, at most once a day. Moving frozen readings back to the history keeps the warning's original time and does not add a second one, also when the replay went on after the warning was raised, and a battery whose readings were moved back is not reported dark while it goes on sending them, also when they were moved back with the add-on running; once it stops, its darkness is counted from the last reading moved back, also when the readings had been moved before a restart. Two warnings for one battery's darkness, raised before its frozen readings were found, become one. With several devices offline at once, each warning says how many were dark at the same moment, not that one device went dark. Time in which every device was silent, such as the internet outage itself, counts as a system outage and not toward any one device, so an outage of the whole system raises no warning for each device as it comes back. Batteries whose last readings the cloud keeps replaying count as silent once the hourly check has found them frozen. If the batteries are still offline when this update is installed, the warning is raised for each of them when the first check of the stored history has finished (see Updating), also for a battery that comes back while the check runs; its warning then ends when it came back. It is pushed, never spoken.
- A restart made while every device was offline in the cloud, or while the internet was down, is reported as an add-on restart, not as a power outage.
- At the reserve with the grid reported present, a Core listed online whose readings have stopped is no longer counted as reporting, so the battery-level and runway alarms stay critical while the pool may be draining, as with that Core offline. Its last reading of 0 W had lowered them to a low advisory.
- A "Telemetry gap" warning raised because every device was offline in the cloud or had its last payload replayed by the cloud names those devices, instead of blaming an MQTT/broker stall, including batteries whose replayed readings were saved and then moved out of the history. It names them only when Power kept checking the devices through the whole gap; a gap in which nothing reached Power is still reported as an MQTT/broker stall. A device that kept sending fresh data with nothing measurable in it is named as such, and the warning then does not say that every device was held.
- The offline, stale and blind alarms are unchanged.

**Solar**

- An hour in which the panel reported no house load is no longer counted as lost solar. With the panel offline in the cloud, its missing load had been read as 0 W.

**Updating**

- A minute after the update Power checks the stored history for frozen stretches, and the night-charge scoring waits for that check. Updating restarts the add-on.
- Do not go back to a version before 1.188.1 once the panel has counted battery energy for a Core: that energy is kept where only this version and later read it, and it stays there for good. An earlier version drops it from Battery Energy In and Out. Home Assistant books the drop as a negative hour, or, when it is 10% of the counter or more, as a meter reset that counts the whole total again. Updating again books a negative hour back as a positive one.

## 1.188.0

### The Documentation tab opens a short operator guide

**Documentation**

- The add-on's Documentation tab now opens a short operator guide: what Power needs, what it changes on the panel and how to turn each change off, what to do when an alarm sounds, setup by goal, and troubleshooting. It replaces the full engineering manual, which had grown past 1.1 MB, was slow to open and grew with every release.
- The Info tab now shows a short summary of the add-on, with links to the guide and the reference pages.
- Every option has a row on one page, with its default and its allowed values, and every published entity has a row on another: the [option reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/options.md) and the [entity reference](https://github.com/tesseractAZ/power/blob/main/docs/guide/entities.md).
- The full engineering reference is on GitHub in 19 files by chapter, listed in [its index](https://github.com/tesseractAZ/power/blob/main/docs/reference/README.md). Chapter and section numbers are unchanged. An old link into the manual now opens the guide, whose last section links a table of where each linked section moved.
- The per-release engineering log and the past operations audits are kept unchanged on GitHub under docs/history, and are no longer printed in the manual attached to each release. Every version's notes remain in this changelog, its archive and the Releases page.

**Updating**

- Documentation only: nothing Power monitors, announces or writes changes. Updating restarts the add-on.

## 1.187.23

### Spoken and pushed figures state what the system measured

**Notifications and announcements**

- The on-peak "battery idle while the grid is used" notice states the energy above the reserve on the batteries' measured capacity, the same basis the runway and the battery level use, instead of the panel's nameplate, which overstated it by about 6%. When no measured capacity is available, the notice says the figure is on the nameplate capacity.
- The report sent when a device returns after a day or more offline no longer ends with a fixed solar-yield prediction written for one past outage; it reports what was measured.
- Times and ranges are read aloud as ranges: "4–7pm Mon–Fri" is now spoken "4 to 7pm Mon to Fri" (Spanish "4 a 7pm"), instead of as separate numbers. Dashes between words still read as a pause.

## 1.187.22

### The night-charge notice states the charge it will make; boot-time false alarms; a fast Changelog

**Night charge**

- The evening notice, its push and the night-charge card now state what the charge will actually do: the level it charges to, the window, and about how many kilowatt hours it is expected to take from the grid. They used to state the figure the plan is sized on, a worst case that assumes the house is cut off from the grid with high load and the car charging before midnight. On 12 October that figure read "Buy ~64.2 kWh"; from the pool's real 46% at midnight the charge would have drawn about 34 kWh. The worst case is still shown on the card, labelled as the basis the target is sized on. The charge itself, its target and what it writes to the panel are unchanged.
- A night that needs no charge, because the pool is expected to stay above the level written, now says the reserve is held and no charge is expected. A night the add-on did not arm, because arming was refused or the notice reached no channel, says so on the card.
- The morning summary says what the force-charge actually did (ran, failed on some or all slots, or never started), from a record made when the charge was armed.
- New sensor "Night-Charge Expected Buy". The existing sensors are renamed "Night-Charge Buy (Worst Case)" and "Night-Charge Arrival SoC (Worst Case)"; their entity IDs and history are unchanged.
- Each night's ledger row now holds the expected buy and the pool level at the window open, so the expected figure is scored against what was delivered.

**Alarms**

- After a restart, the battery-level alarm waits for the first complete reading of the fleet, at most 30 seconds, before it can announce. On 12 October at 22:06, right after the host rebooted, it announced "50 percent" from the one Core that had reported (49%) while the pool was at 52%, then announced 50 percent again at 22:26 when the pool reached it.
- The "Audible alarm channel unreachable" notification no longer goes out for a speaker restart of a minute or two: the check now needs failing readings spread over two minutes. On 12 October, announcements that failed while Music Assistant restarted after the reboot forced three checks into 31 seconds, and the notification and its "Resolved" went out 20 seconds apart. The channel's state is also read again when the alerts are gathered for sending, after the wait on the analytics worker.
- A spoken alarm detail is no longer cut at a decimal point. Details are shortened for the speakers, and the cut was made at the last full stop in the first 200 characters, which could be the point in a number: with tariff rates confirmed, the on-peak grid-charging alarm said "about $2." for $2.19 an hour, and a host-pressure alarm could say "load1 6." for a load of 6.37. The cut is now made at the end of a sentence, or else between words, so a figure is spoken whole.
- The on-peak grid-charging notice states its cost as "about $X per hour", the on-peak cost of the energy going into the battery. It called that figure the extra over buying the same energy overnight, but the overnight rate was never subtracted, so it overstated the extra by the whole overnight cost.
- The "Reserve alarm blind" notice names the battery level the alarm is actually running on. While the panel's source list was empty it could average a different set of Cores than the alarm uses, including one not wired to the panel: with a charged bench Core counted, it could read about 20 points above the level the alarm used.

**Changelog**

- Home Assistant's Changelog dialog loads quickly again. This file now keeps only the newest releases, at most about 32 KB (it had grown to 330 KB); older ones are in CHANGELOG-ARCHIVE.md, linked at the bottom. A check stops it growing back, and every release heading is the bare version, so the update dialog shows only what changed.

**Updates**

- Server dependencies: @fastify/static 10.1.6 and @fastify/websocket 11.3.4.

## 1.187.21

### A cell-spread warning from the pack comparison is pushed, not announced

**Alarms**

- A cell-voltage spread warning from the pack-to-pack comparison is now sent to the phone and shown on its card but no longer announced on the speakers, the same as each pack's own cell-spread warning has been since 1.187.12. One was announced at 18:32 on 12 October for a spread on Core 2 pack 4. A critical cell imbalance is still announced, and the temperature, charge-level and health comparisons are unchanged.

## 1.187.20

### Log-review fixes; the build machines move to Ubuntu 26.04

**Alarms and notifications**

- The "alarm host under pressure" warning no longer speaks over the house for a load spike of a minute or two, such as a Home Assistant update or a backup (one was announced at 22:34 on 10 October for a 59-second spike). It still appears on the card at once and its notification is sent as before, and it is announced only if the pressure lasts 5 minutes. Once announced, a brief dip or an add-on restart does not produce a false "All clear" followed by the same warning again. The critical alarm is unchanged.
- A settings change made in the EcoFlow app overnight, including a reserve-floor change, is no longer lost if the add-on restarts before morning. The waiting notification is saved and goes out once when quiet hours end; a failed send is retried rather than dropped.

**Backups**

- Nightly Home Assistant backups now hold a clean copy of Power's history database. Just before the backup copies Power's files, Power pauses the database's background tidy-up, and resumes it right after, so a restored backup no longer brings back a damaged database. Power and its alarms keep running during the backup, and the pause lifts on its own 10 minutes after it was set if the backup never reports back. If the pause cannot be set in time (for example while Power is still starting), that one backup is copied as before.

**Dashboard**

- The battery charge-curve card no longer stalls for half a minute once an hour: the report is refreshed in the background before it goes stale, and the previous result is shown meanwhile.

**Build and release**

- Every build and check now runs on Ubuntu 26.04, after trial runs of every check and of both image builds on it passed. The CodeQL security scan stays on Ubuntu 24.04 until CodeQL lists 26.04 as supported.

## 1.187.19

### The battery runway counts what the batteries really hold

**Runway and alarms**

- The battery runway was overstating how long the batteries would last by 7–19 %, most on quiet nights. It counted the packs at their original rated size, where they now hold about 94 % of it, and left out the roughly 270 W the Cores use themselves. Checked against 30 recorded nights, it is now within 3 %.
- That 270 W is always counted while the panel reports the batteries, even when a Core drops off, so if the runway errs, it errs short rather than long.
- Runway warnings, the lighting posture and the projected low battery come earlier to match; in the 30-night replay, medium warnings came on 3 more nights. Alarm levels are unchanged.
- The Runway card shows the measured capacity ("of 87.0 full · measured 94% of nameplate"). Home Assistant's Backup Capacity and Backup Remaining, the battery floor alarm and the night-charge plan are unchanged.

## 1.187.18

### Real pack counts and pool size; reports rebuilt after a half-loaded start; a stricter release pipeline

**Dashboard and engines**

- A Core's card shows one tile per pack it actually holds. A Core with no direct readings (for example after a restart while it is offline) no longer shows five made-up pack tiles; it shows one line saying pack detail needs the Core's WiFi.
- After a restart, reports such as battery wear, charging curves and pack risk are no longer built from whichever Core reported first and then reused for up to an hour. They are rebuilt as the rest of the system arrives, and Home Assistant's battery-wear sensors read "unknown" for those first moments instead of wrong numbers (after the 1.187.17 restart they showed 4 packs of 24 for half an hour).
- The forecast's uncertainty band uses the real size of the home battery bank instead of a guess that also counted the bench Cores.
- The battery-dispatch suggestion answers "not available" when the panel's battery readings cannot be trusted, instead of planning for a made-up 60 kWh battery at half charge.
- The alert help text no longer says every pack has four siblings (one Core has four packs).

**Build and release**

- Every change to the main branch is checked against the published releases. A new version is published whatever the merge is titled, and a step back to an older version, a reused version number or a malformed version shows up as a failed run instead of being offered quietly to Home Assistant.
- The release pull-request check looks at what actually changes when the pull request merges, and runs again when its title is edited.
- The build machines are pinned to Ubuntu 24.04, so GitHub's switch to Ubuntu 26.04 from 19 October happens only when chosen (a trial run on 26.04 passed every check). The image build no longer downloads an emulator it never used.

**Documentation**

- The project overview no longer says the packs' measured capacity matches their rating: they measure 94.4 % of nameplate today, recorded with its date in the performance record.

**Dependencies**

- CI: setup-buildx-action 4.4.1, build-push-action 7.4.0, upload-artifact 7.0.2.

## 1.187.17

### One version of each build tool; documentation corrections

**Build and release**

- Every build and release workflow now uses the same version of each GitHub Action. The checkout and file-upload steps had drifted two and three major versions apart between workflows, and the Docker test build still used versions written for Node.js 20, a runtime GitHub has deprecated. A new check fails the build if a workflow drifts again, or if a step names a tool by a version label that can move.
- The Docker test build no longer hands two comment lines to Docker as build settings.
- The update instructions on the release workflows' run summaries name the add-on as the store shows it (**Power**) and cover store installs.

**Documentation**

- The project overview gives the home battery bank as nameplate capacity — three Cores of five packs, 92.16 kWh — rather than "usable", and notes the two bench Cores are not part of it.
- The security policy, project overview and reference manual state that every CI check is required before a change can merge.
- Comments in the build workflows, and the description of which browser origins the add-on accepts (private-network hosts on any port), corrected to match what they describe.

**Dependencies**

- Server: @fastify/websocket 11.3.3. Web tooling: vite 8.3.4, @vitejs/plugin-react 6.1.2. CI: codeql-action 4.38.3.

## 1.187.16

### Every change now needs permission; documentation reviewed

**Security**

- Two actions that worked without permission now require the same authorization as every other change: the Real / False / Failed buttons on a cleared alert, which also teach the add-on which alerts to trust, and asking the add-on to fetch past energy history from EcoFlow. Before, any device on the home network could do either. The buttons keep working when the dashboard is opened through Home Assistant.
- The last three steps of the build and release workflows that referred to a tool by a version name that can move now refer to one exact, unchangeable version, like every other step.

**Documentation**

- The documentation was checked against the code: about 375 statements corrected, and the reference manual's configuration chapter, whose later sections had ended up after the appendix, put back in order.
- Refreshed project overview, security policy and performance record. The security policy now describes the protections in detail: what can change a device setting and how each change is bounded, how the add-on is confined, and how releases are built.

## 1.187.15

### Tighter security confinement

**Security**

- The add-on's AppArmor security profile now grants only what the add-on actually uses: two system capabilities instead of ten, network access limited to the ordinary connection types it needs, and more system folders protected from being changed. Nothing the add-on does is affected; the narrowed profile was tested on the running system and on an isolated copy before release.

## 1.187.14

### Fewer cell-imbalance notifications while the batteries fill

**Alarms**

- A cell-imbalance **warning** no longer sends a phone notification while a pack is above 85% charge. Charging toward full takes every pack through a range where cell voltages naturally spread; on October 10 a top-up sent nine of these notifications in half an hour. The warning still shows on the dashboard, and below 85% it still notifies you. A **critical** cell imbalance still notifies and is announced at any charge level.

## 1.187.13

### APS holidays are priced off-peak all day

**Tariff and night charge**

- APS off-peak holidays are now priced as off-peak all day, as the EV Overnight Charging (R-EV) rate schedule states: no on-peak hours, no overnight hours and no super off-peak hours on those dates. Before, the add-on priced them as ordinary weekdays, so a night charge could be planned for overnight hours that are billed at the off-peak rate on a holiday, and cost reports counted on-peak hours that do not exist that day.
- The holidays follow the schedule's rules, including the Friday or Monday that is observed when a holiday falls on a weekend, and Christmas Eve and New Year's Eve. The next ones are Monday, October 12 (Indigenous Peoples' Day), Wednesday, November 11 (Veterans Day) and Thursday, November 26 (Thanksgiving).

## 1.187.12

### Night charge waits longer for a slot to confirm; cell-imbalance warnings push without speaking

**Night charge**

- A battery slot now gets 15 minutes (was 6) to confirm it has started charging before the request is sent again, and 30 minutes before the night reports that slot's charge as lost. On two recent nights a slot was reported lost while it was in fact charging; its confirmation was simply slow.

**Alarms**

- A cell-imbalance **warning** still shows on the dashboard and still sends a phone notification, but is no longer announced on the speakers. It had been recurring on the same two battery packs for 40 minutes to 2 hours as the morning charge began, each time with a spoken warning and a spoken all-clear. A **critical** cell imbalance is still announced.

## 1.187.11

### A late retry names the alarm that is standing, and is spoken even when speech is slow

**Announcements**

- **A late retry names the alarm that is standing, not one that has cleared.** When Music Assistant cannot play an announcement, it is retried after 30 seconds, 90 seconds and 3 minutes. A retry repeated the words it was made with, even when the alarm those words named had cleared and another alarm kept the same level:
  - An announcement named one of two critical alarms. That one cleared while the other stayed, so nothing new was announced, and the retry named the alarm that had cleared. The other was never named.
  - A retry already waiting behind another announcement when its alarm cleared and a new one appeared played first and named the alarm that had cleared. The new alarm then waited two minutes.
- When its turn comes, a retry now checks which alarm the announcement would name:
  - **The same alarm:** the retry plays the words it was made with, even when a reading in them has changed since (for example a cell spread from 101 to 104 mV). Those words are already prepared, so the retry is spoken even while the speech service is slow. The cordless phone is not called again if it already took the first call; if that call timed out, it is called again.
  - **A different alarm:** the retry names it, with the tone a new announcement would play, and the cordless phone is called again. When the announcement of that alarm is already waiting to play behind the retry, the retry gives way to it, so the alarm is announced once. The retry is also not played when a new announcement would not name or repeat that alarm now: a warning announced in the last 30 minutes when no all-clear or critical alarm has been announced since (battery-level and runway announcements do not count), or a critical alarm announced before a restart that has not changed.
  - **The condition has moved below or above the retry's level:** the retry plays the words it was made with, as before, and the announcement of the new level follows. It is not played when the alarm it names is still raised but would not be announced now: a cell-imbalance warning that has not yet lasted long enough, a priority turned off on the Alert Settings page, an alert shown only on the card and the phone notification, or an alarm marked not to be announced (for example an expected-offline spare).
  - **An "All clear" retry** is not played while a critical alarm is active.
- 1.187.5 tried a first version of this that rebuilt the words whenever their text changed. It was withdrawn because a changed reading could turn a spoken retry into a bare tone, and the cordless phone never heard the new alarm.
- **An announcement names the alarm that raised it.** An announcement names one alarm. It could name one that does not raise the level: a backup-pool battery band, the projected runtime to the reserve, a device telemetry gap, or another alarm with its own announcement or only a phone notification. That happened when it ranked first (a Battery alarm before a Grid one, for example). It now always names an alarm that raised the level. Those alarms' titles also carry a live reading ("Backup pool low — 28%"), so a retry would have treated the next reading as a different alarm.
- **A warning announced by a retry counts as announced.** A warning that clears and returns within 30 minutes, with no all-clear or critical alarm announced in between (battery-level and runway announcements do not count), is not announced again. This now holds when a retry, or the spoken repeat after a failed render, was what announced it, as it already did for a new announcement.
- **A retry whose speech fails is spoken 90 seconds later.** When the speech for a retry could not be prepared, only the tone played and the words never followed. A retry now gets the same spoken repeat as a new announcement. The repeat's tone now matches its words when the alarms standing have changed in between. Only one spoken repeat can wait at a time. A spoken repeat already waiting is kept if it will play, unless the new one will play too and is for a more serious alarm level. A repeat for an alarm level the condition has left is dropped when it is due, so it gives way.
- **The spoken repeat of an "All clear" is not played while a critical alarm is active.** When the speech for an all-clear failed, its spoken repeat 90 seconds later did not check again for a critical alarm. A critical alarm that appears in that time without raising the level could be followed by "All clear. All stations report normal." Examples are the reserve-floor alarm, which has its own announcement, and a held "telemetry blind" alarm.
- **A warning retry refused just after a critical alarm is announced two minutes later.** A warning announced while a critical alarm is held (for example a cell-spread alarm silenced while the cells balance) could have its retry refused, because the critical alarm's own retry had just played and a less serious announcement is not made within two minutes of one. The warning then waited until the critical alarm had cleared for good. It is now announced once the two minutes have passed, if it is still current. When the held critical alarm sounds again at that moment, the warning waits for it to be silenced again instead of being dropped. It never takes the place of an alarm already waiting for those two minutes to pass.
- Battery-level, runway and other dedicated announcements are retried as before.

**Dependencies**

- Dependency updates merged before 1.187.7 shipped in its image and were not listed there. fastify 5.12.4 → 5.12.5 fixes a denial of service through an unhandled exception on HTTP/2 trailer responses (GHSA-4mh8-r7rc-xpvc). The add-on serves HTTP/1.1 only, so it was not exposed.
- Server: @fastify/static 10.1.5, @fastify/websocket 11.3.1, mqtt 5.16.0, undici 6.29.0, ws 8.22.0; tooling @types/node 22.20.4, tsx 4.23.15. Web tooling: vite 8.3.1. CI: codeql-action 4.38.2, setup-qemu-action 4.4.0.

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
