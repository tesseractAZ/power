## 1.190.2

### The Today card counts the energy measured at the panel while the Cores are dark

**Dashboard**

- While a home Core reports nothing of its own, the Today card's Solar produced, AC output and Batteries (net) now count the energy the panel's meter on that Core's battery slot measured for it — the figures Home Assistant's Energy counters already add — in place of the Core's own readings, which are not recorded while it is dark. On 19 October, with every Core offline since 14 October and the house on the batteries, the card read 0 Wh for all three and "25% measured" while those counters read 41.3 kWh of solar, 34.5 kWh into the batteries and 9.4 kWh out of them since midnight. For each stretch a Core is measured at the panel after the update, the card reads what the counters counted for it over the same stretch.
- A figure with a part measured at the panel says "via panel" under it. Solar the panel could only work out from the Core's output and the rise in its charge level — before the panel's own solar reading has passed its check — is a lower bound and says "via panel · lower bound" ("partly a lower bound" when only some of the day's is). No solar is counted for a dark Core at night, so an outage that is over by sunrise leaves Solar produced unmarked. Batteries (net) reads, for example, "charged · via panel".
- "% measured" counts the time the panel's meter covered each dark Core, so an all-dark day measured at the panel reads close to 100 % instead of 25 %.
- A Core that reports for part of the day counts its own readings for that part and the panel's for the rest, handing over at the same instants as the energy counters, so no stretch is counted twice — also when a Core's own readings come back while the panel is still measuring it (its data arriving before the cloud lists it online again).
- The Solar tab's Today tile shows the same solar figure with the same note.
- A day with every Core reporting reads exactly as before.
- From the update onward: the panel-measured energy of a dark Core is recorded for the card at each 5-minute count, so on the day of the update the card counts it only from the update on, and its figures and "% measured" stay below the counters' for that day. The record is kept as long as the recorded readings.

**Documentation**

- The energy reference describes the record the card reads and how it meets the Cores' own readings; the user-interface reference describes the card's notes.

## 1.190.1

### The panel card names the per-battery charge limit; the Cleared list opens on 7 days; the live solar reading stays trusted; the Midday-Charge window sensors are timestamps again

**Dashboard**

- The Smart Home Panel card's "Charge power 7.20 kW" is now "Charge limit (per battery) 7.20 kW × 3 connected = 21.60 kW". The figure is the panel's configured charge-rate limit for each connected battery (the Delta Pro Ultra's AC input ceiling, the same figure as each battery slot's rating), not the rate the pool charges at and not a live power: on the night of 13–14 October each Core took up to 7.2 kW of its own, the three together 18.1 kW, and the grid main read 19.25 kW. The envelope beside it multiplies the limit by the batteries connected to the panel; it is left out while the panel reports no limit or no connected battery. The card shows no measured peak, since no per-charge summary exists yet to read one from.
- The card's "Charge time" and "Remain (disch, vendor)" are shown only while the server says that timer applies, by the same rule that decides whether Home Assistant's backup charge and discharge minutes are published, so the card and the sensors agree; with no verdict from the server they read "—". The panel reports both timers whatever the direction, and the card had shown the charge time whenever the charge limit was above 50 W (always), so it read "38 min" to full while the batteries drained 3.4 kW through the panel on 16 October.

**Alerts**

- The Cleared list fetched the whole stored history when the page opened and again every 30 seconds — 1,500 cleared alerts, 1.2 MB, each with its full alert record — and drew every row in one table, so it took a moment to appear and ran very long. It now opens on the last 7 days, with 30 days, 90 days or All a tap away; the refresh fetches only the window shown; the caption says how many rows are listed of how many are kept; 200 rows are drawn before a "Show more" button; and each row carries only what the table shows. On the live history the 7-day window is 145 rows and 84 KB in place of 1,500 rows and 1.2 MB, and All is 730 KB. The Critical + High filter is unchanged. The stored history, how much of it is kept, and the warranty export are unchanged.

**Energy dashboard**

- While a Core reports nothing of its own, Fleet PV and Battery Net read the panel's per-slot solar reading as soon as it is present, and the check of that reading against the solar the Core demonstrably took in (its output plus the rise in its charge level) runs alongside. On 18 October that check had passed each slot's reading in the morning and withdrawn it again between late morning and dusk, each time by about a third of a kilowatt-hour — one step of the panel's whole-percent charge level — although the reading stayed within 4–10 % of the check's figure all day; from 11:15 until dusk the Now view then showed no solar, battery or consumption while the house ran on the batteries. The check's own figure is uncertain by one step at each end and by the batteries' measured capacity, so a reading now passes when it is within two steps or 15 % of it, whichever is larger, and a verdict takes effect only once it has held for an hour, or at once when the gap is 2 kWh or more. The same rule decides when a reading is trusted and when trust is withdrawn. Replayed on the 18 October readings, all three slots stay trusted through the day. A reading that is genuinely short — one that misses the solar passing straight through to the house, for example — is still refused, and once refused both sensors read unknown for the rest of the day, as they do while the panel reports no solar reading for the slot. The two sensors sum to what the panel's meter measures on the slot whatever the solar reading says, so the consumption the dashboard derives is right either way.
- The energy counters: until the slot's solar reading has passed its check, solar is counted from the Core's output and charge-level rise, as before. A reading already trusted that then falls short goes on being counted until the withdrawal takes effect — its shortfall has first to exceed the tolerance, and the verdict then holds for an hour unless the shortfall reaches 2 kWh — so a trusted reading that freezes low leaves up to about the larger of the tolerance and 2 kWh of that slot's solar uncounted for the day (replayed: 2.5 kWh after 80 minutes mid-morning, 4.2 kWh after 135 minutes in the afternoon; about one step, 0.3 kWh, under the one-step rule), with the slot's battery in and out off by the same amount the other way, and Fleet PV and Battery Net publishing the frozen reading meanwhile. The shortfall is not counted back once the reading is withdrawn: nothing already counted changes and no total steps down.
- The energy flow card and the backup time to full and time to empty follow the sensors: the slot's solar reading is used wherever the sensors publish it.
- The log line for each verdict states the tolerance and when the verdict first appeared; the battery-lifetime debug block lists a verdict that is still waiting its hour.

**Night charge**

- The Midday-Charge Window Start and End sensors are timestamp sensors again (`device_class: timestamp`), so Home Assistant shows them as times; 1.189.0 published them as text, and they showed raw ISO 8601 strings. They read unknown when there is nothing to show, as before, with no warning in the Home Assistant log: Home Assistant's MQTT sensor maps the empty value to unknown for every sensor type, which 1.189.0 had taken to produce a warning on a timestamp sensor. Midday-Charge Refresh and Night-Charge Role are unchanged.
- After a restart across the restore of the night's reserve, the morning summary waits for the panel's first reading since the restart, up to 10 minutes, before saying the restore was sent and is not yet confirmed; a restore that first reading confirms is summarised as restored, in one card, instead of a "sent" card followed by a "restored" one. The log line for a deadline page held after a restart says the restore was sent before the restart when it was, instead of "only just sent".

**Documentation**

- The configuration reference stated that the overnight charger delivers at most 7.2 kW × 6 h = 43.2 kWh. That read the per-battery limit as the pool's; it now states the measured envelope (about 17 kW into three Cores at a 19.1 kW main) and refers to the night-charge reference, which records the per-Core peaks of 13–14 October.
- The night-charge reference and the entity table describe the Midday-Charge window sensors as timestamps, and state how Home Assistant's MQTT sensor reads an empty value.

## 1.190.0

### The LAN console is served over SSH; telnet is no longer served

**Console**

- The control-room console on port 2323 is served over SSH: `ssh -p 2323 <console user>@<host>`, where the console user is `TUI_USERNAME` (`operator` when empty). Logins are password only, with `TUI_PASSWORD`; every login is refused until a password is set, and the add-on log says so once per connection. Telnet sent the login and everything on screen in clear text; a telnet client no longer connects.
- Three failed attempts end the connection, and ten failures within ten minutes from one address refuse that address's logins, the right password included, until the ten minutes are up; a login that succeeds clears its address, and other addresses are not affected. The browser console's login card counts the same way, under the address its connection comes from, so one host's failures over either transport spend one budget; browser sessions that arrive through Home Assistant Ingress all reach the add-on from the Supervisor's address and share one window among themselves. Until this release the ten-failure window was one for every connection, so ten failures from any one host on the LAN refused the operator's correct password from every other host for the rest of the ten minutes. A connection that has not logged in within two minutes is ended. Usernames and passwords are never logged.
- The host key (ed25519) is generated on the first start in `/data` and kept; its fingerprint is on the startup log line at every start, to compare with what `ssh` shows on the first connection. A host key file that does not parse is replaced, and the log says so.
- One terminal per connection. The window size comes from the SSH client and follows resizes, held to 60–200 columns by 16–80 rows whatever the client asks for; exec, sftp and port forwarding are refused. 16 connections, 4 per address; a connection that receives nothing for 5 minutes is closed; TCP keep-alive on every connection. Accept and teardown are logged, teardown with the session duration.
- The browser console at `/console` is unchanged and keeps its login card.

**Configuration**

- `SSH_ENABLED` (off by default) and `SSH_PORT` (2323) are added. `TELNET_ENABLED` and `TELNET_PORT` stay as deprecated aliases: an install with `TELNET_ENABLED` on comes up over SSH on the same port with no option change, and the log names the option that applied. Either enabled option serves SSH; `SSH_PORT` at its default defers to a changed `TELNET_PORT`. To close the port, turn both enabled options off.

**Updating**

- Use an SSH client in place of telnet: `ssh -p <port> <console user>@<host>`. The first connection shows the host key fingerprint, which is printed in the add-on log. Updating restarts the add-on.

**Dependencies**

- ssh2 1.17.0 (and @types/ssh2 for the type check).

## 1.189.0

### The winter mid-day charge, in preview; the night-charge write bounded against on-peak; Cancel always on the card

**Night charge: the winter mid-day charge, in preview**

- On winter weekdays the APS super off-peak period, 10am–3pm, is cheaper than the overnight window. With the cost objective (`ARB_OBJECTIVE` `cost` and `ARB_COST_MAX_SOC_PCT` above 50), Power now works out, on the evening before each winter weekday (8 October to 31 March, holidays excepted), the charge it would make in that window instead of overnight: an outage backup on the overnight window before it when the worst case needs one, the daytime charge, and a re-check on the morning solar forecast that can lower or cancel the daytime charge but never raise it.
- A daytime charge that would leave the pool under the reserve plus 25 points is held: after the 3pm restore the panel holds a pool that low instead of using it, and the grid would carry the house into on-peak. On a day the overnight charge already ran, the morning re-check is recorded as not comparable and the evening figures stand, since the pool it would see is not the one a daytime charge would start from.
- This is a preview only. Nothing is armed, written to the panel, pushed or spoken for it, and the overnight charge runs as before. A later release turns the mid-day charge on, after at least five winter weekdays of preview have been checked against what those days did.
- The preview is published on new Midday-Charge entities (the level, the reserve it would hold, the expected and worst-case buy, the window, and the morning re-check's outcome) and in a read-only section of the night-charge card, with the title of the notice it would have sent. Each Midday-Charge figure carries a `basis` attribute, `shadow` while the mid-day charge is a preview. Midday-Charge Recommended stays off while the mid-day charge is a preview. The log shows each preview in full, tagged `night-charge[midday-shadow]:`, and each evening's ledger row records it, to be scored against the day.
- New sensor Night-Charge Role: what tonight's overnight window is for, `cost` (it carries the charge, as on every night in this release) or `backup` (an outage backup ahead of a mid-day charge).
- The Midday-Charge Window Start and End sensors carry the time as text (ISO 8601, UTC). They, Midday-Charge Refresh and Night-Charge Role read unknown when there is nothing to show, with no warning in the Home Assistant log.
- A preview day's measured solar is not kept as forecast evidence when that night's solar verdict is set aside because its forecast was built on a different set of Cores.

**Night charge: the write never stands into on-peak**

- No reserve raise or force-charge ON is sent from an hour before on-peak, and the reserve restore and the force-charge OFF fall due by then at the latest. The overnight window closes at 5am, eleven hours before on-peak, so a night that goes to plan is unchanged.
- A restore the panel has not confirmed is paged as critical 30 minutes after the window closes (or 30 minutes before on-peak, if that comes first), and again when on-peak starts, when the panel then still reads the raised reserve or cannot be read (a reading that is not a valid reserve, such as the 0 a reconnecting panel reports, counts as unread). Each page is decided once, when it falls due, and none goes out after that on-peak period has ended; a write the panel never took (it still read its earlier reserve once the apply window, or the write's re-sends, had passed) is not paged. After a restart across that time, a restore the add-on can send (including that of a write whose confirmation was lost, when the panel reads it raised) is sent first and the page waits up to 10 minutes for it to read back. A page heard on another day than the on-peak it warns of names that day ("on-peak pricing starts on Monday at 4:00 PM"). The push always goes; the spoken page follows the broadcast quiet hours, as every critical announcement does. The push says the restore keeps being retried only while it still is; when the panel cannot be read, it says the restore is sent once the panel reports again (if it still reads the raised reserve). After a restart just after the restore was sent, the page also waits up to 10 minutes for the panel's first reading.
- The morning summary says the reserve was restored only once the panel reports the restored reserve. If the panel has not reported it 5 minutes after the restore was accepted, the summary says the restore was sent and is not yet confirmed. It used to say "restored" as soon as the EcoFlow cloud accepted the restore.
- While a restore has not read back and the panel still reads the raised reserve, or cannot be read, the next evening's charge is not armed, and its notice says why: the record that pages and measures for the stuck restore stays in place, so a Friday night's stuck restore is still paged when Monday's on-peak starts.
- A backup reserve of 10–50 % set outside the add-on while the night's raise stands (the same value on two readings at least five minutes apart, so one set in the last minutes before the restore is restored over) is left as set: the night counts as finished, its force charge switches off, a notification says so, and the card no longer offers Cancel for it. On a night the panel granted only part of the raise, a later reading within what the night asked for is the night's own write: it is restored at the window close as usual, and a restore that leaves the panel reading it is paged and held as the raised reserve.
- While a restore has not taken and the panel still reads the raised reserve, the on-peak "battery idle while the grid is used" and grid-charging notices measure against the reserve as it was before the raise, from five minutes after the restore was sent; a restore that reads back within that time, as one that goes to plan does, changes nothing. The runway and below-reserve alarms are unchanged.
- A reserve-floor request refused while a night-charge write holds the reserve up now says when the reserve is restored.

**Night-charge card**

- The card offers Cancel in every shape it takes: beside a hold, beside an incomplete or out-of-date plan, and when its status cannot be read. Beside a hold or a missing plan, when a write is armed, it says the write still stands, instead of that nothing will be charged. A status that has not loaded after 15 seconds shows the unavailable card, with its Cancel, instead of "Loading…".
- A restore not yet confirmed after a cancel is shown as a warning.

**API**

- `POST /api/night-charge/cancel` takes an optional body `{ "leg": "cost" | "backup" }`; with none it cancels the charge, as before. `GET /api/night-charge/status` lists the charge cycle's legs (`legs`); every cycle armed in this release has the one overnight leg.

**Updating**

- No options change. The night-charge ledger gains columns for the charge cycle and the preview, added on the first start. A night already armed when the update installs keeps the timing it was armed with. Updating restarts the add-on.

## 1.188.1

### Only fresh readings are saved; while a battery reports nothing of its own, the Energy dashboard and the energy flow read the panel's meters

**History**

- After an internet outage left the batteries offline in the EcoFlow cloud, Power kept saving each battery's last reading as if it were new, every five minutes, for as long as the cloud listed it offline. After the outage of 14–15 October that was about 1,300 rows per battery per hour in which nothing changed, with solar at 0 W through a sunny day. Power now saves a device's readings only while they are fresh: a Core's only while its readings keep changing, since the cloud can answer with an old reading as if it were new. A device that is offline in the cloud, or whose last payload the cloud keeps replaying, leaves a gap in the history, and recording resumes with its first fresh reading. The panel's first new reading after a replay is saved at once, while Power is still confirming that the replay has ended. After a restart a Core is saved from its first changed reading, seconds later over the live stream. The two 24-hour charts on the Dashboard page break the line across such a gap instead of drawing the last reading flat.
- The readings saved that way are moved to a separate table in the same database, so the solar forecast, the typical-day curves, the soiling, health and energy figures, the history charts and the night-charge scoring no longer read them. The 7-day energy and carbon figures and the equipment-health trends are recalculated once the rows have moved. Nothing was deleted: the rows are kept unchanged and can be moved back; rows moved back stay in the history, also when they are moved back while a check is running, and so does the rest of the same frozen stretch while the device goes on repeating those readings, until a reading changes or the device comes back from a silence of more than an hour with one reading and falls silent again. The lifetime energy totals are not rewritten, because Home Assistant would read a decrease as a meter reset; the log states how much they took in from the frozen readings.
- A battery that holds the same readings for a while after a gap is not mistaken for a frozen one: only an hour of unchanged readings that were actually saved counts. If moving the rows fails partway, the next hourly check finishes the job.
- A frozen stretch ends at its last frozen reading, so a silence of more than an hour after it is not counted as frozen, and a battery that comes back from such a silence with the same readings it last had keeps those readings, unless it goes on repeating them for an hour. A shorter break inside a frozen stretch, such as an add-on restart, does not end it, and the frozen time on both sides of the break adds up. Which readings are moved does not depend on how often the check runs, after a restart or after a failed move, with one exception: a stretch whose readings are repeated more than ten minutes apart takes longer to reach an hour of frozen readings, and if that takes more than three hours, the hourly check leaves its first readings in the history, or all of them when the readings stay that far apart throughout (the first check, which reads the whole history, moves them). The log's figure for what the lifetime totals took in counts only the hours the frozen readings cover, and each later check that moves more of a stretch states its share.
- The check reads each device's history from its first saved reading and looks up each device's frozen stretches once, in short steps between the alarm checks.

**Energy dashboard**

- While a Core wired to the panel reports nothing of its own, its battery and solar energy are now counted from the panel's own meter on its slot. Battery Energy In, Battery Energy Out and PV Production keep rising, and Grid to Battery Charge counts the Core's AC input at the slot. That covers a Core offline in the EcoFlow cloud, and one the cloud lists online whose readings have stopped changing (the cloud answers with an old reading, or not at all) or have not arrived yet after a reconnect. Through the outage that began on 14 October these counters had stayed flat: battery in and out 0 kWh and solar 0.0 kWh for 15 and 16 October, while the house ran about 48 kWh a day on the batteries. A Core the cloud lists offline whose own data still arrives keeps counting from its own figures. A Core is taken over after three minutes without a reading of its own; a shorter offline flag is not an outage. Nothing is counted while the panel itself is offline, beyond a pause of up to 30 minutes (below).
- The panel measures what crosses between the Core and the panel, after the Core's own conversion, so battery out reads lower than the Cores' own counters would (5–8 kWh a day lower, replayed on days the Cores reported). Solar is 0 at night (judged at `FORECAST_LAT` / `FORECAST_LON`). In daylight it is the panel's per-slot solar reading once that reading has been checked against the solar the Core demonstrably took in (its output plus the rise in its charge level); until then it is that estimate, which reads 10–17% low. The log states each check with both figures.
- Fleet PV and Battery Net, the two power sensors the dashboard's Now view rates solar and battery on, count each Core the same way and never publish an old reading as live. They had read unknown for the whole outage, so the Now view showed 0 W of power usage while the house drew about 3.4 kW. They now read unknown, never a partial sum, in three cases. One is daylight until the panel's solar reading has passed its check (all day, if it reads short). Another is a Core's first three minutes without a reading of its own. The last is while the panel's own reading is not fresh.
- When a Core reports again, the jump in its own counters is absorbed instead of landing in one hour: it covers the whole time without a reading, and the panel already counted that energy. The panel keeps counting a Core that is listed online again but has not reported yet. The log states, for each Core, what its own counters measured against what the panel counted. No published total steps down when a Core goes offline or comes back, or when the add-on restarts during an outage, apart from one crash case the entity reference describes.
- Energy from before this update is not added afterwards. If the Cores are offline when it is installed, counting starts when the add-on starts again. The hours of the outage before that stay as Home Assistant recorded them; the "(EcoFlow ledger)" series cover those days.
- Since only fresh readings are saved, a pause in the panel's readings (the cloud replaying its last reading, a poll failing, or the panel briefly listed offline) leaves a gap. Panel Load, Grid Import (Home), the circuit energy, and the battery and solar of a Core the panel counts for still count a pause of up to 30 minutes, while Power keeps reading the panel, with the reading held through it, as they did when that reading was saved again every five minutes: across the panel's recorded history, 702 of 703 such pauses lasted 16 minutes or less. The counters wait for the next reading, and each panel's pause is judged on its own, so a second panel's readings do not cut one short. A longer pause, such as the 142 minutes of the internet outage on 15 October, is no longer counted at a reading from before it, and neither is a pause across an add-on restart.
- A Core the panel counts for whose own data comes back while the cloud still lists it offline now counts its battery energy from its own pack meters while the panel's reading is not fresh; only its solar did before. After a crash, a Core's battery and solar from the last update to the crash are counted however long the add-on was down. A Core listed by two panels is counted once.
- One update with a battery's slot reading disconnected (a Core switched off and on while it is reconnected) no longer resets Battery Energy In and Out: the change must hold for three updates. They had dropped by a third, which Home Assistant books as a meter reset, and jumped back at the next update. A replaced or moved battery pack no longer leaves its Core counted at the panel at once on any later offline flag.
- A restart while the panel has not reported yet (the internet down at boot, or the panel's readings failing across the restart) no longer adds old pack counters to Battery Energy In and Out. Such a restart counted the packs a Core had held before they were moved to a bench spare: about 939 kWh in and 966 kWh out on the first update, and a step back down once the panel reported again, which Home Assistant books as a meter reset (also in 1.188.0). Until the panel reports, the Cores it last counted are the ones counted.
- AC Import counts each Core as Battery Net does: a Core listed online whose readings have stopped no longer publishes its last AC input (15 kW from Cores frozen during a grid charge, against a main at 400 W), and a Core the panel counts for adds the power its slot takes in.

**Dashboard**

- With every Core offline in the cloud and the panel reporting, the energy flow drew the house as grid import. On 16 October at 20:04 the grid main read 0 W and the Cores delivered about 3.4 kW through the panel, but the card showed 3.39 kW from the grid with the batteries idle. A Core with no reading of its own is now drawn from the panel's meter on its slot while the panel's reading is live. The Batteries box counts it ("3 via panel") and reads "out" or "in" rather than "discharging" or "charging", since the slot also carries the Core's solar. The Solar box reads "—" (Cores not reporting) when no Core reports its own solar.
- A Core listed online whose readings have not changed for 5 minutes is treated the same way, and a second panel whose reading is stale freezes the card's figures as a stale house panel does. While a Core's delivery is unmeasured, the grid is never drawn larger than the main measures.
- The backup time to full and time to empty (`/api/ha-state` and the console's RUN line) no longer show a time to full while the batteries drain through the panel: the console read "CHG 38m" during that 3.4 kW drain. With a Core offline its slot meter decides which applies, allowing for the Core's own standby draw, which the slot does not see. So at the reserve, with the slots near 0 W, no time to full is shown. With nothing to decide on, only the time to empty is shown. By day, once the panel's per-slot solar reading has passed its check, that solar is taken out first, so a charge shows its time to full, as Battery Net reads it.
- The energy flow counts each Core as the Home Assistant sensors do. A Core the cloud lists offline whose own data still arrives is drawn from its own readings. A Core listed by two panels is drawn once, from the panel slot the sensors count it at: it had been counted from both ("2 via panel", twice its output). Once the panel's per-slot solar reading has passed its check, the Solar box shows that solar and the Batteries box the charge itself: it had read Solar "—" and "1.50 kW out" beside a Fleet PV of 6 kW and a Battery Net charging 4.5 kW.
- The console's solar and battery figures (PV.ARRAY.P, BATT.P.NET and the flow diagram) are the ones the Home Assistant sensors publish. During that drain the console read 0 W, idle.

**Night charge**

- A night whose solar or house-load figures include an hour or more with no fresh readings is not scored, and its note says so. Nights already recorded on frozen readings (14 October, and 15 October if it was recorded before this update) are recorded again from what was measured, once.
- The note of a night recorded again names only the figures that had been calculated from frozen readings; a figure calculated across hours with no readings at all is described as such. A night too old to record again is kept as recorded, and its note says how long its readings were frozen or missing.
- Solar and house load are checked separately: a night whose solar readings are found frozen only after it was recorded, with only the panel's frozen hours noted, is recorded again. A night left unscored for frozen readings that are later moved back to the history is recorded again from them, once no other battery's readings over the night are still frozen.

**Alerts**

- A device that stays offline in the EcoFlow cloud for more than six hours while the other devices keep reporting now raises the "Device telemetry gap" warning; the repeated readings had kept it from firing. The warning gives the time of the device's last reading before its frozen ones. For a battery whose last readings the cloud keeps replaying while Power is running, the six hours are counted from that reading too, also while the replay goes on and across a restart, and the warning is raised once; a fresh reading ends the count, also one made shortly before a restart. A restart while the device is still offline does not raise a second warning while the first is still listed; once it has been listed for 24 hours, a later restart raises it again, at most once a day. Moving frozen readings back to the history keeps the warning's original time and does not add a second one, also when the replay went on after the warning was raised, and a battery whose readings were moved back is not reported dark while it goes on sending them, also when they were moved back with the add-on running; once it stops, its darkness is counted from the last reading moved back, also when the readings had been moved before a restart. Two warnings for one battery's darkness, raised before its frozen readings were found, become one. With several devices offline at once, each warning says how many were dark at the same moment, not that one device went dark. Time in which every device was silent, such as the internet outage itself, counts as a system outage and not toward any one device, so an outage of the whole system raises no warning for each device as it comes back. Batteries whose last readings the cloud keeps replaying count as silent once Power stops saving them, five minutes after their readings stopped changing; replayed readings saved before this update count once the hourly check has found them frozen. If the batteries are still offline when this update is installed, the warning is raised for each of them when the first check of the stored history has finished (see Updating), also for a battery that comes back while the check runs; its warning then ends when it came back. It is pushed, never spoken.
- A restart made while every device was offline in the cloud, or while the internet was down, is reported as an add-on restart, not as a power outage.
- A restart during a pause in the panel's readings, with every Core offline, is no longer reported as an outage that began at the panel's last reading: a crash of about a minute, 19 minutes into such a pause, had raised "System outage — alarm was dark 20 min" and counted as a power outage. The outage now starts at the last check Power made of the paused devices before it stopped.
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

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
