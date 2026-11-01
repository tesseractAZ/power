## 1.198.0

### A thin forecast basis plans on a wider solar band instead of not at all

**Night charge**

- The overnight planner now plans from 4 scored calibration days, not 14. Below 14 the plan is sized on a deliberately wider solar band; from 14 on, nothing changes. Since 1.196.0 a day on which a home Core had no readings is a coverage gap and is not scored. That is correct: before, a dark Core's share was scored as a forecast miss. But it also meant that after Cores were cloud-offline for weeks, every evening read "No plan — forecast/telemetry basis incomplete (only 0 scored calibration day(s), need 14); nothing will be charged." Once the Cores reported again, the planner needed 14 covered days before it planned, so the backup pool would have sat at its reserve floor for about two more weeks of nights.
- **The widening.** Below 14 scored days, the P10 PV the plan is sized on is pushed below the published P10 by a factor k(n). k(n) is the Student-t predictive inflation of a scale estimated from n days, normalised to exactly 1 at 14 days: 1.3102 at 4 days, 1.2018 at 5, 1.1013 at 7, 1.0071 at 13, and 1 from 14. In each band hour the plan uses P10′ = min(P10, max(0, P50 − k · (P50 − P10))).
  - P10′ is never above the published P10 and never below 0.
  - An hour with no P50 gets 0. Its median figures keep the published P10 they used before, so that 0 does not reach the expected buy or the expected start.
- **The multi-day carry.** Beyond 24 hours, the carry widens by k × the band's own lower half-width × √(days ahead). The half-width is Σ(P50 − P10) / ΣP50 over the band, or 1 when the band holds under 0.5 kWh of P50. Below 14 days there is no realized half-width, and the carry was not widened at all. From 14 days the realized half-width is the widening, as before.
- **The long-gap headroom.** On a long-gap night (no full-length cheap window for more than a day after tonight's), the planner sums the pre-peak P10 solar surplus it leaves as headroom again on the widened P10. index.ts now hands it those hours, each with its P50. With no hours to widen, the headroom is set aside, and the night gets the full long-gap buy.
- **Direction.** Every reader of the sizing P10 is monotone in it, so a wider band never lowers what is written. Over a year of live-shaped nights compared with the same night unwidened:
  - the written setpoint, the reserve the actuator arms and the force-charge ceiling never fall;
  - a charge night inside the 24-hour band never turns into a hold;
  - the requirement never falls on a night both plans can meet.
- **Coverage.** At 4 days the 78% coverage gate needs every scored day inside the band (3 of 4 is 75%). At 3 days the plan is refused, and the 21:30 "no plan tonight" push says why: "only 3 scored calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)". When the coverage gate refuses a provisional day count, the push prints the day count against the minimum it passed: "PV band coverage 75% < 78% (forecast present, tier=forecast, calDays 4/4, provisional band below 14)". From 14 days it reads as before ("calDays 29/14").
- **Provisional plans say so.**
  - The plan carries `pvBandWiden` (the factor, the days scored, the next 24 hours' P10 as published and as sized on, and the carry's widening).
  - One sentence closes the rationale, follows the confidence tier in the evening push, and follows the sizing line on the night-charge card. A hold sized on the provisional band (the cushion holds, the need is under the minimum buy, or the window cannot cover the cushion) ends its evening push and the card's hold summary with it. The sentence: "PROVISIONAL SOLAR BAND: 4 of 14 calibration days scored, so the P10 PV this plan is sized on is widened ×1.31 (the next 24 h: ~21.9 → ~16.9 kWh) and the multi-day carry by ±56% per √day; the full band returns at 14 scored days."
  - The spoken notice is unchanged.
- **Timing.** Counted from the day the Cores report again (R), after an outage long enough that the covered days before it have left the 30-day window: the first plan now comes on the evening of R + 5, against R + 15 before. While covered days from before the outage are still in the window they count too, so the planner can plan on the return evening itself. Both are lower bounds: a covered day must also be weather-covered, on the roster and carry more than 0.5 kWh of PV to score, and the first evening needs the forecast refitted on the returned Cores.

**Unchanged**

- From 14 scored days, every plan is byte-identical to 1.197.1. The year of overnight plans in `legacyIdentity.golden.json` reproduces exactly with the provisional minimum passed. The only plans that move are those with 9 scored days and every other gate passing, which now plan.
- The coverage gate (≥ 78% of scored days inside the band) is judged on the published band, before any widening, so the widening never helps a plan pass. The forecast, climatology-tier, SoC-coherence and panel-freshness gates are unchanged, as is the rule that a coverage gap does not score.
- The band the forecast publishes is unchanged, and so are its display, the alarms and the night ledger's `pv_p10_kwh` / `pv_p50_kwh` / `pv_p90_kwh`. `pv_in_band` keeps its meaning, so `CURRENT_ALGO_VERSION` stays 3. `cal_scored_days` records the days scored, from which the factor follows. P50 and P90 are not widened, so the expected start (the P50 carry to the window) and the morning surplus are unchanged. The figures computed from what is written follow it (see Limits).
- The write-readiness gate is unchanged. It does not gate the write: BLOCKED or LEARNING demotes `auto` to `supervised`, which makes the same announced, cancellable write. A provisional plan that arms is therefore written, and provisional nights are ordinary ledger nights for the gate.
- Resilience nights write the cushion line (1.196.0). `ARB_OUTAGE_CUSHION_HOURS` is unchanged. No option, entity or attribute is added.

**Limits**

- The k(n) widening is a principled-in-form inflation, not a derivation. Below 14 days the band is the raw one (cloud variance, model skill, ensemble disagreement), not an order statistic of the scored errors.
- Three figures can fall, though none is a write:
  - The modelled arrival (`targetSocPct`), when less P10 sun before the window opens the islanded carry lower and the charge rate binds.
  - The modelled buy (`buyKwh`), where the widened carry raises the load in a window beyond the 24-hour band (a Saturday plan for Monday's window derates the charge rate there), or turns a meetable night unmeetable.
  - The requirement (`requiredExtraKwh`, the ledger's `required_extra_kwh`) on a night the widening turns unmeetable: the planner then states the pool-headroom placeholder, which can sit under the meetable requirement. Over every n = 4..13 of the year's 1,035 forecast nights against the same night unwidened, it fell on 25 of 10,350. Each was a meetable night turned unmeetable, and on each the armed reserve and force-charge ceiling were the same or higher.
- The figures computed from what is written follow it, so they move where a provisional plan writes more: the expected buy and the just-in-time start read the written level, the over-buy flag reads the requirement and the lift, and the held-import shadow holds at the setpoint. The expected buy moves either way. A higher force-charge stop starts the just-in-time charge earlier, so the pool drains less before it and less is bought back. Over the same comparison it rose on 209 of 10,350 and fell on 21, each with the write raised; the over-buy flag changed on 67.

**Tests**

- New: `provisionalBand.test.ts` (18 tests). It covers:
  - the factor table, recomputed from the t quantiles;
  - the widened P10, the band half-width (its 0.5 kWh rail on the P50 sum: 499 Wh with a P10 above 0 is still 1, and a near-dark band widens the carry by k) and the gate's boundaries (3 refused with "need 4", 0 still deferred, 4 and 13 provisional, 14 and 30 identical, no provisional minimum giving exactly the old gate, a minimum under the table refused);
  - coverage rounding (3 of 4 refused, 7 of 9 passes);
  - the hand-worked 2026-11-17 night (P10 21.9 → 16.91 kWh, carry ×1.5551, setpoint 32%) and the multi-day carry at 1 and 2 days ahead;
  - a band hour with no P50, and the long-gap headroom (5.00 → 3.59 kWh, ceiling 94.6 → 96.1%);
  - the year of plans with the provisional minimum passed (byte identity at 30 days);
  - a safe-direction comparison over the year's 1,035 forecast nights at n = 4..13 against the same night unwidened, which also pins that the requirement falls only on a night turned unmeetable, that the expected buy, the just-in-time start and the over-buy flag move only with the write or the requirement, and that the expected start and the morning surplus do not move;
  - the plan, card and push sentence, on a charge and on each sized hold (the hold push and the card's hold summary), and the no-plan push, including a coverage refusal on 4 days ("calDays 4/4, provisional band below 14");
  - the write path: a provisional plan arms and, in `auto` with readiness not graduated, applies;
  - source checks on the index.ts wiring and the ledger's published P10.
- Updated: `thursdayHeadroom.test.ts` pins the pre-peak hour with its P50.
- New harness `scripts/mutate-provisional-band.mjs` (41 mutants). The anchor of mutant x in `mutate-long-gap-headroom.mjs` is re-pointed.

## 1.197.2

### AppArmor confines what the add-on can read

**Security**

- AppArmor confines what the add-on can read. The blanket file rule, kept since 1.7.1, is replaced by grants for each folder the add-on uses. Its own image folders stay readable and executable as a whole, so the start and stop sequence cannot be refused.
- Under `/share` only the add-on's `ecoflow-panel` folder can be read or written. Other add-ons' files there are refused, and the Home Assistant folders the add-on does not map (`/config`, `/ssl`, `/backup`, `/media`, `/addons`, `/addon_configs`, `/homeassistant`) carry an audited deny.
- Nothing can run from `/data`, `/share` or `/tmp` (or `/var/tmp`), and a process's memory file cannot be written. Each new deny is audited, so an attempt is logged in the host's audit journal; a read the profile does not grant is refused and logged as well.
- `/run` is the one folder that stays both writable and executable: s6 copies its own service scripts into `/run/service`, `/run/s6` and `/run/s6-rc*` at boot and runs them from there. A file written there can be run until the next restart (`/run` is a tmpfs). The profile, the engineering reference and `SECURITY.md` say so, and a test keeps every other folder from becoming writable and executable.
- The transparent-huge-page settings under `/sys/kernel/mm` are readable. The Go runtime inside esbuild reads the huge-page size every time tsx starts esbuild (the server and each worker that loads TypeScript); the host's `abstractions/base` grants that file only from AppArmor 3.0.12 and 3.1.6, so the profile grants it itself.
- Execution is granted by the path the kernel checks, which is a symlink's target: bashio, npm, tsx and esbuild's service binary are named as the files their links resolve to, and s6's commands as their files under `/package`. s6's own scripts in `/run` stay executable, so a stop runs its finish scripts. The exec grants for s6's script folders under `/etc` (including `/etc/cont-finish.d`, which runs at stop) and for `/sbin`, `/usr/sbin` and `/usr/local/bin` are kept; each is now the only exec grant for its folder.
- `/data` and `/run` are granted with the folder itself; `/data/**` alone never matched `/data/`, which the atomic writer lists and SQLite fsyncs.
- A read of `/data/options.json` is never denied, and the netlink rule stays.
- The profile was boot-tested on isolated containers of the 1.197.0 image and of the 1.197.1 image (this release changes no file the image is built from), first in complain mode and then enforced, over three starts and three stops each, with the API, a WebSocket, the worker reports, the database snapshot, the maintenance endpoints, an SSH console login and both backup-hook phases exercised. Each stop finished within the Supervisor's 10 s stop timeout with the clean-shutdown marker written. No record appeared outside the deliberate probes. It then ran in complain mode in place on a running installation for 20 hours, across an evening of alarm announcements, a night and a scheduled backup (both backup-hook phases), with no record. The shipped profile's rules-only sha256 equals the tested copies': `7eb370fcc5b41bee746070d26eebfd4d50789ae10e8a1e94bbdfe349ea9325da`.

**Documentation**

- The engineering reference's AppArmor section describes the per-folder grants, the `/run` exception and the boot test a read or exec change needs before it ships: its preconditions (protection mode and the SSH add-on left as found, journal readers that do not log to the journal, outside the night-charge window and backups), stops with the Supervisor's 10 s timeout, a cleanup in a `finally` with the Supervisor health check afterwards, the rules-only hash as a command (comments and blank lines stripped, `#include` kept, the `profile` line normalized) and the shipping gate (the profile ships with the image it was tested on). Its first footgun now reads: `/init` and the s6 trees stay readable and executable, reads are granted per folder and never per file, and never without the boot test. The troubleshooting entry adds the `DENIED` records and the restart check after a deploy. `SECURITY.md` and the pull-request template are updated.
- A comment in the profile said a `w` deny does not cover chown; it does (and chmod, create, unlink, rename, mkdir and truncate). The comment is corrected; the rules are unchanged by it.

**Unchanged**

- The capability allow list (`chown`, `dac_override`), the socket families, every write-lock, and the silent denies on `/root` and `/home` (npm looks there on every start).

**Tests**

- `apparmorProfile.test.ts` (14, was 6) evaluates the profile with a small AppArmor glob matcher (a `*` or `**` starting a path element never matches an empty name; deny beats allow) over the boot test's inventory: 73 paths that must be granted and 38 that must be refused, 17 of those by an audited deny. It also pins: no blanket file rule, with `/init` readable and executable, all of `/proc` readable, and every exec grant kept for s6's script folders and the program folders; `/data/options.json` never denied for read; `/share` limited to the add-on's folder; the `npm start` chain able to exec; no exec from `/data`, `/share`, `/tmp` or `/var/tmp` and no `/proc` mem write, each by an audited deny; the paths both writable and executable bounded to s6's `/run` trees; every new deny audited; the full list of denied capabilities, and the mount and ptrace denies. The matcher reads the profile's own rules only, not the host's `abstractions/base`.
- `mutate-v1187-15.mjs` re-anchors A-i on `/init r,` (its `file,` anchor is gone) and gains 31 mutants (35, all killed): the blanket rule back, `/share` widened, the esbuild, bashio, `/run/service` and `/package` exec grants removed, `/data/{,**}` narrowed, the mem deny removed, the writable-tree deny made silent, the tripwire removed, a read deny on `options.json`; each kept exec grant removed (`/etc/cont-finish.d`, `/etc/cont-init.d`, `/etc/s6-overlay`, `/etc/services.d`, `/etc/s6`, `/usr/sbin`, `/sbin`, `/usr/local/bin`), the `/dev/pts` and `/proc` folder grants removed, the huge-page read removed, exec widened to all of `/run`, a new writable and executable folder, a capability deny, the ptrace and mount denies, and the `/lib64`, `/var`, `/sys` and `/sys/firmware` denies removed. `mutate-v1187-20d.mjs` A-i's reason is updated.

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

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
