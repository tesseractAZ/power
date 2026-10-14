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

## 1.187.10

### October priced at winter rates, a cloud "offline" blip held while the data still flows, a frozen panel reading published as unknown, and pack end-of-life dated again

**Alerts and announcements**

- **A cloud "offline" flag on a Core is held while the Core's own data is still arriving.** A Core that EcoFlow Cloud lists offline while its own MQTT data still arrives is shown on screen at once, but it is spoken and pushed only if the flag persists for 3 minutes, or as soon as the data stops for 90 seconds. The Smart Home Panel 2 is not held: its readings come from the cloud while it is listed online, so a panel listed offline has frozen readings and alarms at once, as before.
  - On 2026-10-03, right after an internet drop, one device-list poll flagged the panel and every Core offline. It was announced on every speaker for 92 seconds and pushed three times, and every flag cleared within about two minutes.
  - The hold is fail-loud: it never lasts past 3 minutes, ends as soon as the data has been silent for 90 seconds, and never applies at start-up, to a device with no data this session, to a peripheral or to a bench spare. When it ends, the push goes out at once.
- **Spoken announcements no longer read API paths, split plurals or glued ages.** "/device/list" is read as "device list", "message(s)" as "messages" (not "message s"), and "31s" as "31 seconds". The on-screen text is unchanged.
- **The offline alert for a device says how long the add-on has had it on record as offline**, when that started before the last restart: "listed it offline since at least 104 d ago (first seen offline before the add-on's last restart, and not seen online since)". Before, after every restart it said only that the device had been offline since the add-on's first device list, a few hours earlier. The record is cleared when the device is listed online.
- **A timed-out cordless call is logged as delivery unknown.** Before, the log said the call did not ring. The Switchboard announce entity never reports playback, so the 8-second check cannot confirm a call on it. An unknown call is never counted as heard, and a deferred retry still re-fires the cordless. A restart all-clear decision now waits for a condition retry that could still deliver the alarm.
- **NWS storm alerts are logged, and a stale feed is unknown.** No fetch, failure or recovery of the storm-alert feed ever reached the log; the client now logs its transitions (first answer, changed event set, first failure of an outage, recovery). After a first success, a failed fetch served the last good feed with no age limit, so an outage that began after a start-up read as a fresh answer indefinitely. Past 60 minutes the alarm path now reads the feed as unknown, the storm-prep feed holds its last alerts and its stuck-feed warning engages, and a warning is logged once. The dashboard keeps showing the last good feed.
- **Phone pushes no longer carry full device serials.** A serial in the title or message shows its last six characters, and the push tag uses a short digest. The notification drawer card, the logs and the API keep full serials.
- **The "device barely reporting" card keeps the rate it collapsed to** and says "recovering" once the rate is back above the floor. A collapse on a bench spare or off-panel Core is logged at info, with the reason.
- **The cleared-alert history keeps its newest information rows at its cap** (up to 1 in 15) and never evicts a row whose push reached the phone ahead of older rows; such a row still leaves before any warning kept as warranty evidence. The start-up line says what a full history holds and what each new clear evicts.
- At start-up, a held yellow that falls to green now names each held warning that is still active but no longer counts, with the reason, instead of logging it as "cleared".
- The end of a held telemetry-blind episode states the time since the MQTT rebuild and no longer claims the rebuild restored telemetry. The stale-shadow condition (grid presence unknown) is logged as a warning.
- Every broadcast outcome log line names its kind (condition, dedicated, test) and its announcement number, so a retry can be matched to its announcement.

**Money**

- **October is priced at winter rates.** APS seasons follow billing cycles: the May–October bills are summer and the November–April bills winter, and each bill covers the usage since the early-month meter read. The add-on read the calendar month as if it were the bill, so October usage was priced as summer (summer on-peak, and no 10:00–15:00 winter super-off-peak tier) and April as winter.
  - Seasons now go by usage month — April–September summer, October–March winter — from one season source shared by the rate table, the cost report, `/api/tariff` and the nightly plan's tariff record.
  - The boundary is the 1st of the month; the real meter-read day is a few days later, so the first days of April and October can be seasoned one cycle off.
  - Configured rates are unchanged. Ledger rows captured before this release keep the cost they were priced with, except the rows the one-time forecast-span repair (below) re-captures: those are re-priced on the new season map, so a re-captured October span is priced at winter rates, or records no realized cost where a winter rate is blank.
- **The greedy dispatch plan no longer buys grid power with no peak ahead.** `/api/dispatch-plan` imported in every off-peak hour while the pack sat below 80% — on 2026-10-03, 12 hours of weekend import at 16.91¢ that Sunday's solar made unnecessary. It now tops off only ahead of an on-peak hour in its horizon, and only at the cheapest rate before it. The documented default round-trip efficiency is corrected to 0.86.

**Night charge**

- **The nightly ledger grades the PV/load forecast over its full 24 hours.** A Friday plan's row was captured on Saturday afternoon, about 5.4 h before its 24 h forecast span ended, so its load looked 52% over-forecast and its buy error +51 kWh, skewing the readiness gate's bias figures. A row is now captured only once both its night and its forecast span have ended. Once per start-up, rows that were captured at least an hour short are reset and re-captured while their telemetry is still kept; older ones are marked as under-counting. A short row that today's devices cannot re-score faithfully is also only marked: one planned before the add-on recorded which Cores its solar model covered (its PV would be summed over today's Cores, which differ from before 2026-08-20), or one whose delivered energy was recorded before v1.187.3 (that figure is never rewritten).
- **The runway no longer measures against the night-charge reserve after it is reverted.** For about a minute after the 50% reserve was put back, the owner floor read the device's not-yet-updated 50%, and the runway showed "reserve in 5.6 h" (6 of 10 revert nights in two weeks). The floor now holds its prior value until the panel reads back, or for at most 5 minutes — the same rule the alert posture already used.
- **The readiness blocker names the right metric.** "delivery bias" is now "sizing bias": the mean buy error is the planner's forecast miss, and delivered energy is not part of it.
- **Settings-drift no longer claims the panel's own force-charge stop as the add-on's write.** A force-charge slot that the panel's ceiling turns off before the add-on's own OFF is logged as a panel-side change. It is still not announced.

**Home Assistant**

- **A frozen Smart Home Panel 2 reading is published as unknown, not as live values.** While the panel is cloud-offline, has sent no reading for five minutes, or the cloud is replaying a stale copy of its last reading, Panel Load, Grid Power, the grid status, Backup Pool, Backup Remaining, the backup timers and every per-circuit power sensor now read unknown in Home Assistant. Before, they kept showing the frozen numbers: on 2026-10-02 Panel Load stayed at 1611 W for about ten minutes while the batteries' discharge rose by about 2 kW. The dashboard already showed the panel as stale. Lifetime energy counters are unchanged.
- **Projected Low SoC and the runway sensors read unknown while a Core's first reading is still pending after a restart**, instead of a 0 % projected low and a finite runway to reserve and to empty computed without that Core's solar. Forecast Basis Incomplete reads on during that window. A Core the cloud lists as offline is not waited for. The wait ends after ten minutes at most. Alarms are unchanged.
- **Entities no longer flash their pre-restart values at a restart.** After a restart the add-on now sends fresh values before marking its entities available, so a state-change automation no longer fires on the old value and again on the new one. A broker reconnect still marks entities available first. A version upgrade still makes each entity unavailable for about 5 seconds while Home Assistant re-reads its configuration.
- **PV Curtailed Today and PV Clipped Today are recorded as daily totals that can be revised.** Both are estimates that change during the day, so they can go down as well as up. Home Assistant treated them as meters that only increase, so a downward revision of 10 % or more was counted as a reset and the day's energy was counted again. They now reset only at local midnight. Long-term statistics recorded before this release are unchanged.
- **The Audible Alarm Channel sensor reads unknown, not disabled, for the first 30 seconds after a restart**, until the first speaker check. A channel that is turned off reads disabled from the first check on.

**Battery health**

- **Dated pack end-of-life can project again.** The degradation report regressed SoH over a fixed 30 days. Over 30 days no linear fade could pass both the 1.5-point observed-drop floor (it needs about 24 %/yr) and the 10 %/yr plausibility ceiling, so the "Soonest Pack EOL" sensor was unknown for every pack whatever its fade, while the SoH forecast alert (120 days) reported two packs declining about 9–10 %/yr. The window is now the configured samples retention clamped to 120–365 days (the 120-day floor matches the forecast alert), reported as `windowDays` on `/api/degradation`.
- **The MPPT drift card is reworded.** It presented a W ÷ V·A register-consistency ratio as lost conversion efficiency and sent the reader to MC4 connectors and a warranty inquiry. It is now "MPPT reading drift", with a meter check of the string's voltage and current at the MPPT input.

**Logging and diagnostics**

- **Poll failures are logged as a delta, with causes.** The warn line names only devices newly failing outside the standing product-class 1006 set, with their error code, and marks the alarm-path panel (never treated as standing); recoveries, the standing set at start-up and devices no longer asked are info. Each device's quota-failure cause is logged once per failure episode and code, with a recovery line; only 1006 says "presence only", and an alarm-path panel's cause is logged at warn.
- **Unchanged fleet-status ticks emit a compact line.** Demoting the unchanged 10-minute dump to debug saved nothing at the standing debug log level (44.7 % of the reviewed log's bytes); an unchanged tick now lists only the devices on MQTT with a count for the static entries. Changes and the hourly anchor keep the full line.
- The 45-minute GHI tick no longer logs a byte-identical "periodic GHI persistence" line every tick; it logs "nothing new" at most every 6 h and when no forecast is available.
- `/api/health` `pollErrorKind` is null while healthy (it read "other").
- The device-list first-sight line uses the resolved display name; the terminator pre-warm summaries name their language.
- Request logging is turned off through Fastify's log controller, which removes the FSTDEP023 deprecation warning at every start-up.

**Documentation**

- The night-charge entity table describes `night_charge_target_soc` as the reserve setpoint written (not a predicted SoC), and lists `night_charge_expected_soc`, the predicted SoC at window close.
- The alert-count sensors are documented as counting every alert on screen, including silenced ones, the same set the dashboard's badges count.

**Upgrade notes**

- From this release October usage is priced from the winter rate options. If APS On-Peak / Off-Peak ¢/kWh (Winter) are blank, the cost figures fall back to the flat default rate, but Grid Rate Now (the price Home Assistant Energy accrues cost from) reads unknown outside the overnight hours and every October ledger row, weekends included, records no realized cost; if APS Super Off-Peak ¢/kWh (Winter) is blank, a ledger row whose span holds a winter weekday 10:00–15:00 records no realized cost. Fill them in from an APS bill or rate sheet. After the update, `/api/tariff` reads `tariffBasis: aps_r_ev-winter`.
- PV Curtailed Today and PV Clipped Today change state class (a total with a daily reset), so Home Assistant may show a one-off statistics notice for them, and its long-term statistics may count the update day's value up to the update a second time, once.
- A push sent before the update keeps its old tag, so its resolve arrives once as a separate notification.
- After a restart, the panel's live figures read unknown until its first reading arrives.

## 1.187.8

### Alert Settings shows each category's colour

**Dashboard**

- **Each category card on Alerts → Alert Settings is framed in its category's colour:** red for Critical (P1), orange for High (P2), amber for Medium (P3), blue for Low (P4) and green for All-clear / Recovery. The colours were specified when the page was organised by category in 1.60.0 but never appeared: the card's own grey border took precedence, so all five cards had the same grey frame in both themes.
- **The "Critical (P1) annunciation is silenced" banner is framed and tinted red**, and the dialog that confirms silencing Critical is framed red. Both had the same grey frame and panel face as every other card, so the banner did not stand out as a warning.
- Every other card is unchanged. Checked in the Default and High Contrast themes.

## 1.187.7

### The web dashboard is built with Tailwind CSS 4

**Web dashboard**

- **The dashboard's styles are now built with Tailwind CSS 4 instead of Tailwind CSS 3.** Every page renders as before in both themes. The data, alarms and announcements are unchanged.
  - Tailwind CSS 3 pulled in the `braces` package (GHSA-vfj7-8cjw-p6xm, high: a deeply nested pattern exhausts the stack) through its file watcher and file matching. No fixed `braces` exists, and Tailwind CSS 4 does not use it. `npm audit` in `web/` now reports no advisories.
  - The advisory was reachable only while the bundle is built, from the repository's own file patterns, and none of that code runs in the add-on.
  - Where Tailwind CSS 4 changed what a class does, the Tailwind CSS 3 result is kept: the line height of each text size, the order in which the dashboard's own classes (cards, badges, bars) override other classes, hover effects on touch screens, the default border colour, the pointer cursor on buttons, the padding of table cells, the gap under the overview digest's heading, and the amber used for borderline values.
  - Each tab, the circuit details and every Alerts view were compared before and after in both themes and at desktop and phone widths, element by element.
- **Browser requirement.** Tailwind CSS 4 needs Safari 16.4, Chrome 111, Firefox 128 or later. Older browsers lose the semi-transparent colours (badge fills, tinted borders and rows), and browsers before Safari 15.4 or Chrome 99 lose the styling entirely.
- The build no longer uses PostCSS or Autoprefixer directly; Tailwind CSS 4 runs as a Vite plugin.

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
