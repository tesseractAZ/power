## 1.191.4

### Power names itself, not EcoFlow: the Home Assistant device, notification titles and console logo; a dark fleet's forecast is no longer archived as zero

**Naming**

- Power is an independent open-source add-on that works with EcoFlow hardware. Several places read as EcoFlow's own product, and now name Power instead.
- The Home Assistant device is "Power" (manufacturer "Power (open-source add-on)", model "Analytics for EcoFlow SHP2 + Delta Pro Ultra"), was "EcoFlow Panel". Friendly names follow, for example "Power Alarms — Critical (P1)". Existing entity_ids are kept by Home Assistant; a fresh install mints `sensor.power_…`, and the entity reference lists those.
- "Power Outages 24h" is "Host Power Outages 24h", so it does not read "Power Power Outages 24h". Its entity_id and unique_id are unchanged.
- Phone notifications are titled "Power · …", were "EcoFlow · …". The test notification says it comes from Power.
- The SSH and browser console's login screen shows POWER, was ECOFLOW. The home-screen web-app title and the forecast calendar's description say Power.
- The add-on's store page, README and description say it is independent and not affiliated with or endorsed by EcoFlow. The slug (`ecoflow_panel`), image and MQTT topics keep their names: renaming them would break installs.

**Analytics**

- With every home Core dark, the 45-minute weather tick archived a next-24 h solar forecast of 0 Wh, and a short one with some Cores dark. The archive is the record a future band calibrator will score; a row is now written only when the forecast covers every connected Core (its alarm-facing and display sums agree), the solar forecast is available and no Core's first reading is pending.

**Tests**

- The device-name rule reads the device's own name: no entity name may start with it or with "EcoFlow".
- The archive gate holds against the real forecast build: not archived with every Core dark or with two of three dark, archived with every Core projected, where the two sums agree.
- The SSH idle-reap test's "inbound bytes keep the connection" half runs on its own server with a 500 ms window. Against 150 ms, a heartbeat delayed by a loaded runner was reaped and failed the test; a reset that never happens still fails it.

**Documentation**

- The engineering reference is titled "Power — Complete System & Engine Reference". The performance record's §4e adds the reading measured after 1.191.3: the worker at 0.73% of a Pi core, from 1.6–1.7%.

## 1.191.3

### Self-consumption is cached while every Core is offline in the EcoFlow cloud; the tariff report rebuilds faster

**Analytics**

- With every home Core offline in the EcoFlow cloud after a restart, the self-consumption report was rebuilt on every read, and again inside every carbon report, which reads it: it was cached only while a Core had a reading in memory, although it is built on the panel's load and each connected Core's own recorded energy. With the tariff report, these rebuilds kept about 1 % of the reference Raspberry Pi 5's CPU core busy after 1.191.2.
- Self-consumption is now cached on the panel then too. It is rebuilt when a Core joins, leaves or returns to the panel's source list, when a Core reports again, when the house panel is re-pinned, and when the 15-minute cache expires. With no Core's reading in memory, nothing is cached while the panel lists no Core or, in the first 10 minutes after a restart, while a listed Core is online before its first reading; without the panel's reading nothing is cached, as before. The same changes now also rebuild it while Cores report, where the cached value used to stand until it expired; a source that keeps leaving and rejoining the list costs a rebuild per change, as the forecast already did.
- The tariff report integrates each hour from that hour's samples instead of searching the whole week for them: a rebuild with every Core dark takes 20 to 33 ms instead of 39 to 53 ms on the development computer.
- In a replay of the production request schedule on synthetic databases with every Core dark, the analytics worker's time falls from 143–274 to 49–80 ms a minute; with every Core reporting it stays at 9 ms.

**Unchanged**

- Every figure: on a fixed fixture, self-consumption, carbon and tariff are byte-identical to 1.191.2's, with every Core dark and with every Core reporting.
- Carbon and tariff are still cached, and their window figures published, only while a Core (a bench spare counts) has a reading in memory, as their basis flag says.
- Reports built on the forecast still read it before their own cache. That read is now a cache hit of under a microsecond, so reading their cache first would save nothing, and their figures stay tied to the forecast they were built on (1.186.5).

**Tests**

- With every Core dark, self-consumption is built once and then served with no recorder read, also inside carbon. Each change above rebuilds it, and what is served equals a fresh build on the same map. With no Core's reading in memory, a Core online before its first reading and a panel listing no Core are never cached, nor a Core without a panel (0.15.13).
- Carbon and tariff are rebuilt on every call with every Core dark, and after a restart while a Core has a reading and the panel does not yet; once the panel reports, both are cached (0.15.13). Until now no test failed when either cache was written without that basis.
- A child-process capture builds the three reports at two instants; they match 1.191.2's capture to the byte. The hourly slices equal whole-week integration on random series, at their boundaries and on unsorted input.
- `scripts/mutate-v1191-3.mjs`: 16 mutants, each killed by the case written for it; each half of the carbon and tariff cache conditions is reverted alone.

**Documentation**

- Source comments corrected, behaviour unchanged: 1.189.1, never released, reads 1.190.1; the mid-day preview runs on the evening before a winter weekday; costs are in the tariff currency, hours are the site's, the self-consumption cache lasts 15 minutes, and the add-on's only Supervisor call is a read-only list of add-ons. The option rows outside the frozen G3 golden cite their readers' current lines; the G3-pinned ones keep the captured tree's, as the golden test requires.
- The energy, architecture and solar-forecast references and the performance record describe the change. The record's oldest runtime section (2026-09-11) moves, unedited, to `docs/history/` to keep the record under its size limit, and the reference's list of history files names it.

## 1.191.2

### The day forecast is cached while every Core is offline in the EcoFlow cloud

**Analytics**

- After a restart while every Core was offline in the EcoFlow cloud, the day forecast was rebuilt for every report that reads it. No Core had a reading in memory, and the forecast was cached only with one, although it was complete: it is built on the panel's load and each connected Core's own recorded solar history. On the reference Raspberry Pi 5 each rebuild took about 1.6 s, so `/api/forecast`, `/api/runway`, `/api/forecast-skill` and `/api/confidence` each answered in about 1.6 s and `/api/ha-state` in 3 to 5 s, and the rebuilds requested by the alarm monitor, the MQTT publisher, the runway and load-shed checks and the 4-minute warm-up kept about a third of a CPU core busy without a break. In a replay of that schedule on a copy of the reference database, on a computer about three times as fast as the Pi, the alarm engine's forecast feeds took up to 1.5 s of their 2.5 s budget.
- The forecast is now cached on the panel, as it is when a Core reports. It is rebuilt when a dark Core joins or leaves the panel's source list or returns to it, when one is listed online before its first reading, when a Core reports again, and when the 30-minute cache expires. A forecast the panel's data leaves incomplete is still rebuilt after 150 s, and with neither the panel nor any Core reporting nothing is cached, as before. The same changes to the dark Cores also rebuild the forecast while other Cores report; until now the cached forecast stood until it expired.
- Each dark Core's 30-day solar history is read once per forecast build instead of twice, so a rebuild with three Cores dark takes about 40 % less time.

**Unchanged**

- Nothing the forecast shows changes: on a copy of the reference database, the forecast built with every Core dark and the one built with every Core reporting are byte-identical to 1.191.1's. The figures built on the forecast (the probabilistic band, the multi-day outlook, the dispatch plan) are still served only with the forecast they were built on; while it is cached they are now reused. With every Core reporting, the forecast is cached and rebuilt as before.

**Tests**

- With every Core dark and the panel reporting, the forecast is built once and then served with no further reads. A Core that reports again rebuilds it, and so do a dark Core that leaves or rejoins the panel's source list (also inside the 5-minute window in which the report caches' reset is deferred) and one listed online before its first reading; what is served then equals a fresh build on the same map. The three dark-Core cases fail when the cache entry does not record the dark Cores and the pending flag. A restart with every Core listed online before its first reading serves the incomplete forecast for its short window, and a fleet with no panel and no Core reporting still caches nothing.
- A capture in a child process builds the forecast on a fixed dark-fleet fixture: every recorder read of the build is distinct, and the forecast matches, to the byte, 1.191.1's capture on the same fixture.
- The 1.186.5 forecast-cache cases gain the transitions in which only the reporting Cores move (a reporting Core leaves the source list; a home with no panel gains one), which the new comparison of the dark Cores does not see.
- `scripts/mutate-v1191-2.mjs`: 9 mutants, each killed by the case written for it.

**Documentation**

- The solar-forecast reference states when the day forecast is cached and what its cache entry records. The performance record gains a section on the live measurement, its cause and the replay before and after the change.

## 1.191.1

### The console's two liveness clocks and the dashboard's Today and forecast times read the site clock

**Console**

- The 1 Hz clock in the ALARM LIST divider (ALARM screen) and in the MAIN BUS divider (BUS screen) is written in the site zone, the zone of the console's other stamps: the status header, the alarm banner and the alarm rows. Both read the host's clock, so with `SITE_TIMEZONE` set to another zone than the container's, or a container without `TZ` on the default zone, the two dividers disagreed with those stamps by the difference (two or three hours behind for a New York site on a Phoenix host, by the season; seven hours ahead for a Phoenix site on a UTC host). The SSH console and the browser console share the screens. The `HH:MM:SS` form is unchanged.

**Dashboard**

- The Today card's "since" time is written in the site zone: the card's day starts at the site's midnight, but the time was formatted in the browser's zone, so a browser elsewhere read "since 03:00 AM" or "since 07:00 AM" over the site's day. `/api/summary/today` now carries `siteTimeZone`, as `/api/night-charge/status` does.
- The Solar page's day-ahead forecast labels each hourly projection row, the projected-low tile and the runtime note with the site hour, the hour of the learned response table beside it and of the server's own forecast warning; it read the browser's clock. The Dashboard's 24-hour forecast card writes its projected-low time, axis and tooltip in the site zone too. `/api/forecast` now carries `siteTimeZone`.
- The text keeps the browser's own locale and form, so a browser in the site zone reads exactly what it did. Without a zone (a server older than the page) no time is shown rather than the browser's.

**Unchanged**

- Where the site zone is the container's zone, as it is with `SITE_TIMEZONE` unset and `TZ` set by the Supervisor, the two console clocks read exactly what they did, and a browser in that zone reads the same Today and forecast text. Nothing else changes: the computed figures, the alarms and the Home Assistant payloads are those of 1.191.0.

**Tests**

- Every clock the console prints (the two dividers, the alarm rows, the alarm banner and the status header) is read off the rendered ALARM, BUS and CONSOLE screens in child processes for a New York site on a Phoenix container, a Phoenix site on a UTC container and the reference install, against written-out times. A scan of the console's source fails on a call to any of these host-clock date helpers, with or without a locale and options: the `toLocale…String`, `toTimeString` and `toDateString` forms, `Intl.DateTimeFormat`, the local `get…`/`set…` fields, `getTimezoneOffset` and a `Date` built from local fields (`new Date(y, m, …)`). The scan parses each file, so a call written across lines or nested at any depth inside another call is caught.
- The Solar page's hour labels are checked against the server's site hour in five zones and the Today card's "since" time against the site's midnight in five; the Dashboard forecast card's times are compared across three zones. Source checks also pin where each card hands the zone on or shows the time: dropping the zone from the hour rows (every row "—"), the "since" text or the projected-low time each fails.
- Fixtures in eight test files were built on the host's clock or on local hours. Each now places its instants on the site clock (or, where the code buckets by the UTC hour, on the first UTC hour that starts in the site hour, the bucket the code labels with it), so it holds and keeps its meaning under any container zone:
  - The runway's PV-basis guard asserts on the site hour `computeClipping` labels its rows with; a row labelled on the host's clock fails on a UTC container and wherever host and site differ.
  - The no-weather curtailment case places its surplus hour at a site wall time and asserts that the one estimated hour is booked at site 11:00. On a Kolkata container with a Phoenix site it read 2.5 kWh instead of 7.
  - Both held-panel curtailment cases assert that no hour of the window is curtailment. On a UTC container they passed with a missing `panel_load` read as 0 W (the 1.188.1 fix reverted).
  - The daily-figure reset cases take their instants and their expected midnights from the site's dates, not from the function under test. A one-minute boundary slop and a reading of the publish clock now fail under every zone pairing; a day start on the host's clock fails wherever host and site differ.
  - The display-versus-alarm PV contract now exercises its bias-factor cause as well as the coverage gate: a display sum that drops the bias factor fails.
  - The per-Core shade report places its clear hours in the first UTC hour that starts in each site hour, as the report labels them, and holds on a site whose daylight saving ends inside the fixture (Auckland, and Lord Howe Island, whose clock moves by half an hour), where real uniform shade was no longer detected. The two-Core gap case passed the summed-fleet calculation the per-Core report replaced; it now also puts the gap on the six most recent days, and a case with one Core of three dark on those days is added: both fail the summed fleet (a phantom 50 % and 33 % shortfall on every clear hour). A case with shade on most recent days fails a median reference in place of the 90th percentile.
  - The realized-irradiance training case and the soiling charge-taper cases key their rows on the UTC hour, as the recorder and the weather feed do, and hold on half- and quarter-hour zones (Kolkata, Kathmandu, Adelaide, St John's).
- The forecast-skill cache case scores the realized and the first-write reports against one forecast. A cached report is served only for the forecast it was scored against, so a fresh forecast for each call missed the cache whatever its key, and a cache keyed by the window alone (a realized report served to the band calibrator) passed the case; it now fails.
- Test comments that said the code reads the host's clock now name the site clock (clipping, forecast, rate table, dispatch, solar-model metrics, the settings-drift quiet window, the message-rate floor, the diurnal backtest baseline, the golden capture), and the forecast's band-check failure messages print the site hour.

**Documentation**

- The user-interface reference describes the console's clocks, the Today card's "since" time and the forecast cards' hour labels; the solar-forecast reference names the field `/api/forecast` adds.

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
