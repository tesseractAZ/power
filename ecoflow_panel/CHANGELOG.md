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
- A child-process capture builds the three reports at two instants; they match 1.191.2's capture to the byte. The hourly slices equal whole-week integration on random series, at their boundaries and on unsorted input.
- `scripts/mutate-v1191-3.mjs`: 11 mutants, each killed by the case written for it.

**Documentation**

- Source comments corrected, behaviour unchanged: 1.189.1, never released, reads 1.190.1; the mid-day preview runs on the evening before a winter weekday; costs are in the tariff currency, hours are the site's, and option rows cite their readers' current lines.
- The energy, architecture and solar-forecast references and the performance record describe the change. The record's oldest runtime section (2026-09-11) moves, unedited, to `docs/history/` to keep the record under its size limit.

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

## 1.191.0

### The site clock, the tariff, the PV array, the devices and the plant limits are options; unset keeps today's behaviour

**Configuration**

- `server/src/config.ts` now carries the table of every add-on option, every environment knob the add-on reads and the deployment constants, each with the parse rule its reader applies today (the four truthiness conventions, the blank and `null` rules, the clamps). Nothing changes for a stored configuration: a parity test compares each option's value when the variable is absent, blank or cleared with the shipped default, and every difference is declared with its reason. New keys from here on are optional, have no default and are exported only when set, so an unset key leaves the behaviour as it is.
- Eight golden captures pin what the code computes on the reference install's settings: the site clock, the tariff, every option's parse, the night-charge schedule, the PV physics, the panel and spare topology, the MQTT discovery payloads and the plant limits. They are frozen by checksum; a change needs a visible manifest change in the same diff. With every new option unset, all eight match what 1.190.2 computes.
- 38 new options, all optional with no default, listed under **Show unused optional configuration options**. While a key is unset it is not passed to the server, and the code takes the path it took before.
- A new install ships with `BROADCAST_BILINGUAL` off: the Spanish second pass plays once it is turned on and a Spanish voice is named. An install that has saved its configuration keeps the value it stored. The other defaults that came from the reference plant stay as they are: `FORECAST_LAT` / `FORECAST_LON` remain the placeholder the 50 km notices are measured from, `BROADCAST_AUDIO_BASE` is Home Assistant's own host name and this add-on's port, and `ARB_GRID_INPUT_CAP_KW` keeps 17 because no value is neutral: 0 turns the contention model off and times the force-charge at a fixed rate about twice what one Core takes, so a one-Core plant would start late. The setup checklist asks every home to enter its grid-input breaker capacity.
- `GET /api/site` serves the site time zone and its source, the coordinates and their source, the currency, the PV string layout and each Core's own strings, the PV array the physics uses, the solar assumptions the web draws with and the mains voltages; per Core, whether it is a bench spare, only while `BENCH_SPARE_SNS` is set.

**Site clock**

- `SITE_TIMEZONE` names the IANA time zone every local date, hour and clock time is computed in: the tariff periods, the night-charge window and its evening notice, quiet hours, the morning digest, the daily totals, the statistics import and the console's stamps. Unset, the zone is the container's `TZ`, which the Supervisor sets to Home Assistant's zone, and `America/Phoenix` when neither is set. The zone is resolved once at start and never switched while the add-on runs; the start-up log names it and its source.
- A configured zone the runtime cannot resolve raises a repair issue and the next source applies; it never becomes UTC silently. A zone that differs from Home Assistant's raises a warning and a repair issue. Links of the legacy zone, such as `US/Arizona`, read as `America/Phoenix`.
- The fixed UTC−7 arithmetic and the reads of the host's own clock are replaced by the site zone: day starts, the statistics noon, day loops that cross a daylight-saving change, and the hour index of the MPC tariff vector.
- The on-peak hours the cost figures, the dispatch planner and the MPC vector fall back to while rates are unconfirmed are judged on the site's hour and weekday, and the times in the telemetry-gap and outage alerts are written in the site zone. Both read the host's clock: with `SITE_TIMEZONE` set to another zone than the host's, a New York plan on a Phoenix host was priced on-peak three hours late and an outage at 14:00 read 11:00 AM. Identical where the site zone is the host's.
- The web writes the night-charge window, the cancel deadline and the mid-day shadow in the site zone the server reports, and "today" on the circuit card and the Solar page starts at the site's midnight. A browser in another zone showed shifted hours and asked the server for a different day.
- In `America/Phoenix` the site clock equals the fixed-offset arithmetic at every instant (goldens G1 and G4, every hour of 2025–2027).

**Tariff**

- The tariff is no longer APS-only. `TARIFF_PLAN` picks `aps_r_ev` (the built-in R-EV table, which stays the default while the option is unset), `flat` (`TARIFF_FLAT_CENTS_PER_KWH` every hour), `two_tier` (one on-peak window, `TARIFF_ON_PEAK_HOURS` on `TARIFF_ON_PEAK_DAYS`, at `TARIFF_ON_PEAK_CENTS` and `TARIFF_OFF_PEAK_CENTS`) or `custom`, a period table written in `TARIFF_PERIODS` and `TARIFF_RATES` (for example `on_peak 16-19 mon-fri all onpeak; overnight 23-05 mon-fri all cheap` with `on_peak=31.2/22.5; off_peak=16.9/15.1; overnight=12.6`). The R-EV table written in that grammar parses to the built-in model exactly, labels apart; a custom plan's labels come from its hours.
- For every plan: `TARIFF_SUMMER_MONTHS` (`4-9` when unset; a range may wrap the year, `10-3`), `TARIFF_HOLIDAYS` (`aps`, `none` or a list of dates), `TARIFF_FIXED_DAILY_CENTS`, `TARIFF_RATES_CONFIRMED` (unset takes `TARIFF_APS_RATES_CONFIRMED`) and `NIGHT_CHARGE_CHEAP_PERIOD`, the period the night charge plans in (a custom plan's period flagged `cheap`; `overnight` on the R-EV table). The `TARIFF_APS_*` options keep their names and remain the R-EV table's rates.
- The tariff settings the code read only from the environment until now are options: `TARIFF_FLAT_CENTS_PER_KWH`, `TARIFF_ON_PEAK_CENTS`, `TARIFF_OFF_PEAK_CENTS`, `TARIFF_EXPORT_CENTS_PER_KWH`, `TARIFF_ON_PEAK_HOURS` and `TARIFF_ON_PEAK_DAYS`, each read as before while unset. One reader serves the cost figures, the dispatch optimiser and the MPC vector; the flat 17 ¢ fallback is one constant instead of three copies.
- With `TARIFF_PLAN` set, the MPC vector prices an hour no confirmed rate covers with the cost figures' own pair: an unconfirmed `two_tier` plan's two rates. It read the environment-only `…_CENTS_PER_KWH` pair, which no option sets, so it priced every hour at the 17 ¢ flat default while the cost figures used the plan's rates. While `TARIFF_PLAN` is unset the MPC keeps its own pair (golden G2).
- A tariff setting that cannot be read fails closed: every price reads unknown, the cost figures use the flat fallback, no night-charge window is planned, and a repair issue names the option. It never falls back to the R-EV table.
- `TARIFF_CURRENCY` (USD when unset; EUR, GBP, CAD or AUD) sets the unit of the Home Assistant cost and rate sensors and the symbol in the alert and dispatch text; `/api/site` reports it. An unknown code keeps USD and raises a repair issue.
- With every new option unset nothing changes on an existing install: the tariff model, the cost figures, the discovery payloads and the text are byte-identical (goldens G2 and G7). Declared: the R-EV holidays after 2045 are computed instead of missing; the cost figures keep their above-zero rule for a rate (a 0 ¢ period is priced at 0 by the rate table only); while `TARIFF_PLAN` is unset the cost figures and the MPC vector keep reading their own two-tier option names, which only the `two_tier` plan treats as aliases.
- The two round-trip efficiencies, 0.86 for the night-charge sizing and 0.9 for the MPC, are named side by side; the values are unchanged.

**Night charge**

- The planner plans in the tariff's own cheap period at every step: tonight's window, the end of its horizon, the cycle chooser, the long-gap rule and the on-peak hours a scored night is credited with. Each named the R-EV period `overnight`, so a custom plan whose cheap period has another name got no window ("hold (no charge window)" every night), a plan with a dearer period called `overnight` was planned in that one, and `NIGHT_CHARGE_CHEAP_PERIOD` changed nothing. A `two_tier` plan still has no cheap window unless `NIGHT_CHARGE_CHEAP_PERIOD` is `off_peak`, which makes the off-peak hours the window.
- With any plan other than the R-EV preset, a charge window is one night of the cheap period: a run of it inside the plan's nightly window, ending where the next night's opens. With `off_peak` as the cheap period and an on-peak period on weekdays only, the weekend is one off-peak run (Friday 19:00 to Monday 14:00 with on-peak 14-19). Friday's window ended Saturday evening, and Saturday's and Sunday's plans resolved a window that had opened a day or more earlier, which a write mode refuses, so nothing charged before Monday's on-peak. Each evening now plans its own night (Friday 19:00 to Saturday 14:00, then Saturday's, then Sunday 19:00 to Monday 14:00), and the next window opens the next evening. The R-EV preset's windows are unchanged (golden G4).
- With a plan other than the R-EV preset, the nightly job's schedule follows the plan's cheap window: the job runs until the window opens (at most midnight), its hour is clamped to the hour before the open (at most 22) with a start-up warning and a repair issue, a stale panel reading defers the plan until the earlier of an hour after the notify time and 30 minutes before the open, a row with no stored window is scored on the plan's own night, a window shorter than 3 hours still counts as a full night, and a force-charge may run for the window's length plus an hour (never less than 7 hours). A cheap window that opened at or before 21:00 was planned at 21:30 inside it, and a write mode refused every night.
- With the R-EV preset the schedule keeps its values whatever the notify time: until 23:00, the hour at most 22, the deferral until 22:30, 3 hours and 7 hours (golden G4).

**PV array and site location**

- `PV_ARRAY_KWP`, `PV_TILT_DEG` and `PV_AZIMUTH_DEG` describe the array the clear-sky physics model uses. Once any `PV_*` key is set the model uses that array at `FORECAST_LAT` / `FORECAST_LON`, the weather's hourly temperature in place of a fixed 30 °C, and, for the curtailment estimate, the site's own clear-sky noon irradiance, never above the 900 W/m² used before. While no `PV_*` key is set the model is the reference array, unchanged (golden G5).
- `PV_STRINGS` gives each Core's high- and low-voltage strings, with an override per panel slot or Core name (`hv=10x400,lv=4x400; slot2=hv=8x450`), and the Solar page draws them. A value that does not parse keeps the default layout and raises a repair issue; a total that disagrees with `PV_ARRAY_KWP` is a start-up warning.
- `SITE_LOCATION_FROM_HA` takes the coordinates from Home Assistant's home location. It is read in the background after a start, saved, and applied from the next start, so the coordinates never change while the add-on runs. Off, a start-up notice and a repair issue appear when Home Assistant's home is more than 50 km from `FORECAST_LAT` / `FORECAST_LON`.
- One notice and repair issue, "the reference home's defaults are in effect", appears when the site zone is not `America/Phoenix` while `TARIFF_PLAN` is unset, or when the site is more than 50 km from the placeholder coordinates while no `PV_*` key is set.
- The web's solar assumptions follow the site: the forecast's orientation text takes the hemisphere from the latitude, and the daylight band and solar noon come from the coordinates and the zone. On the reference array both keep the bands they had.

**Devices**

- `BENCH_SPARE_SNS` lists the bench-spare Cores by serial, or `none`. When set it replaces the built-in spare list, never adds to it, everywhere that list is read: the offline-alarm mute and the three home-pool fallbacks used while no panel roster is known. The roster override still applies on top. A serial that matches no device raises a repair issue. Unset, the built-in list applies as before, and the built-in list itself is unchanged.
- `DEVICE_ALIASES` (JSON, serial to display name) is merged over `/data/device-aliases.json`, which is merged over the image's own file. A layer that cannot be read is skipped and raises a repair issue.
- A Core with no name of its own is numbered by its panel slot, and two such Cores get distinct names (the slot, else the serial's last four characters). The repair cards and the insight rows no longer print "Core null".
- The warranty export's default chassis is chosen from the devices present, and the defective-pack alerts link the export with their own chassis's serial.
- The session self-heal quorum is the smaller of `SELF_HEAL_MIN_DEVICES` and the number of devices on the account, so an account with fewer devices than the quorum can still trigger it.

**Plant limits**

- EV: `EV_MAX_LOAD_W`, `EV_CHARGER_COUNT` (0: no charger; 1: overlapping predicted sessions are alternatives, as before; 2–4: they add up, capped at the count × `EV_MAX_LOAD_W`), `EV_PLATEAU_MIN_W` and `EV_CIRCUITS`, the circuits the EV detection scans. `EV_MAX_LOAD_W` now has one reader; the night-charge planner parsed it a second time, unclamped.
- `FORCE_CHARGE_KW_PER_CORE` (5.5 kW when unset) times the just-in-time force-charge start and sizes the planner's automatic charge cap; `ARB_CHARGE_CAP_KW` above 0 still sets the cap.
- `RUNWAY_POOL_OVERHEAD_FLOOR_W`, `RUNWAY_CORE_OVERHEAD_W`, `BMS_RESEED_MIN_GAP_WH`, `CAPACITY_SCALE_MIN`, `FORECAST_NIGHT_START_HOUR`, `FORECAST_NIGHT_END_HOUR`, `GRID_CO2_INTENSITY_LB_PER_MWH` and `CYCLING_BASE_WEAR_USD_PER_KWH`, read until now from the environment only, are options; each schema range equals the clamp the code applies.
- `OPPORTUNISTIC_LOADS` (`id:watts:category[:label]` entries, or `none`) replaces the built-in list of loads the surplus advisor suggests, and `BATTERY_SOC_LADDER` (`pct:tier` entries) the levels the SoC alarm speaks at. Unset, the built-in list and the 50/40/30/20/15/10/8/4/2 ladder apply (golden G8).

**Wording that described one home**

- The forecast-dip rationale compares with "typical clear sky", not one city's.
- The host under-voltage alert names the host that runs the monitor, not a Raspberry Pi; `HOST_POWER_ENTITY` can name any under-voltage `binary_sensor`.
- The forecast-ensemble note on the Advanced Insights card says "monsoon-season clouds".
- The night-charge card is titled "Night-charge plan": the plan is for the tariff's next cheap window, which is not overnight on every tariff.
- The spoken priority previews name Core 1, which every plant has, in place of Cores 2 and 3.
- The console's station label reads GRID-TIED PLANT while the grid resolver sees a grid and OFF-GRID PLANT while islanded; it read OFF-GRID PLANT on every plant.

**Documentation**

- A setup checklist, `docs/guide/your-home.md`, lists what differs from the reference deployment and what to measure for each: the time zone (normally Home Assistant's), the forecast coordinates (a placeholder by default), the tariff plan with its periods, rates, seasons, holidays, fixed charge and currency, the PV array and its strings per panel slot, EV charging, bench spares, device names, the grid-input breaker capacity, the per-Core force-charge rate, the runway overhead for fewer than three Cores, and the carbon and wear factors. It also says to set the panel's own time zone in the EcoFlow app to match Home Assistant, which Power cannot check, and that a time zone whose UTC offset is not a whole hour is not supported. The operator guide links it from Getting started, and the printable manual includes it.
- The operator guide's scope names `TARIFF_PLAN` (APS R-EV built in and the default) and the site time zone, `SITE_TIMEZONE` (empty means Home Assistant's zone), and states the remaining limits: English and Spanish only, and a second panel with only its own charge levels and runway. The night-charge notice is described for the tariff's cheap window in site time.
- The option reference has a row for every new optional key, each stating what Power does while it is unset; the APS rate fields are labelled as the APS R-EV preset on the Configuration page and in the reference.
- The Configuration-page help no longer quotes one plant's measured kW per Core, cites a past incident or gives one installation's handset as the SIP example; the envelope option asks for the grid-input breaker capacity, and the retention help states the 7–3650-day range the schema enforces.
- In the engineering reference, figures measured on the reference deployment are labelled "reference plant", knobs are marked add-on or environment-only, and passages that called the clock, the tariff, the PV site or the opportunistic loads fixed name the options that now set them. The reference deployment's own Core roster and circuit-1 note move to `docs/history/reference-plant-notes.md`. The night-charge design record and the performance record are labelled as the reference plant's.
- `server/.env.example` lists every add-on option, generated from `config.yaml` and the option table; it no longer carries the notification channels removed earlier.

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
