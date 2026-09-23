## 1.181.0

### A Core replaying old data proves nothing; the runtime alert sees the grid as it is now

- A Core whose data the EcoFlow cloud keeps serving unchanged — its own connection lost while the
  panel's still works — kept its last grid draw counting as grid power flowing, which overrides
  even the checks made at the reserve floor. Readings arriving is no longer enough: a Core's grid
  draw counts only while its data is actually changing, and not at all while the panel itself
  freshly reports no grid (the Cores draw grid only through the panel).
- The "Projected runtime to reserve" alert decided whether the grid was backstopping the home in
  the add-on's analytics worker, which never sees the grid toggle or the saved "no grid" reading,
  and kept that verdict for up to 10 minutes. It is now applied on every alarm evaluation with the
  same grid verdict the other alarms use.

New harness `scripts/mutate-core-replay-runtime-grid.mjs` (7 anchor-asserted mutants).

## 1.180.0

### An announced outage survives an add-on restart

- 1.178.0 made the panel's "no grid" reading override a grid declared present and hold until
  the panel reports Grid OK again, but the reading lived only in the running add-on. If the
  add-on restarted during an outage while the panel was off the cloud (an outage that also takes
  the internet down), the new process never saw a reading: a panel listed offline is never
  polled. The declaration then stood again. The runway alarm's spoken warning was held back,
  `off_grid` read OFF and battery-level announcements said the house was drawing from grid
  power, for as long as the panel stayed dark. The last "no grid" reading is now saved to a small
  file next to the database and read back as the add-on starts. It applies whether or not the
  add-on can reach the EcoFlow cloud after the restart: the resolver finds the panel before it
  has sent anything, or, while the add-on has no device list at all, uses the saved reading
  directly. The file is written only when the reading changes and is cleared the moment the panel
  reports Grid OK, so a "Grid OK" is never saved; replacing the panel drops the old one's
  reading. The trade-off: if the grid returned while the
  panel was dark, "no grid" persists until the panel reports. That is an early alarm, not a missed
  one; deleting `/data/grid-reading.json` and restarting the add-on clears it by hand.

New harness `scripts/mutate-grid-reading-persist.mjs` (15 anchor-asserted mutants).

## 1.179.0

### Old readings from the panel and the Cores no longer count as the grid being there

- The panel's own grid flag counted as grid presence whenever the panel was online, however old
  the reading. Two ways left an old "Grid OK" standing through an outage: the panel dropping off
  the cloud and coming back before its next reading (the reconnect notice arrives first and
  carries no data), and the panel's readings failing to download while it stayed listed online
  — indefinitely. Either way the add-on believed the grid was there when it was not: the runway
  alarm's spoken warning was held back, battery-level announcements said the house was drawing
  from grid power, `off_grid` read OFF and `shp2_grid_connected` read ON. The same was true,
  and worse, of the measured grid power: a panel reading frozen mid-charge (7–8 kW at the
  reserve floor) counted as grid flowing, which overrides even the checks made at the floor,
  and a Core whose data had stopped kept its last grid draw. All three now count only while
  fresh — downloaded in the last five minutes, from a device that is online and not replaying
  old data — the same test the overnight charging controls already use. Readings arrive about
  once a minute, so normal operation, including the gaps between the panel's charging bursts,
  is unchanged, and a reconnect of a few seconds does not discard a reading that is still fresh.
  A reading from before an outage can still count until the next successful download, at most
  five minutes after the last good one. `shp2_grid_connected` reads unknown while stale. The
  other direction is accepted deliberately: if the cloud is unreachable for more than five
  minutes while the batteries sit at the reserve floor and the grid is charging them, the floor
  alarm speaks, because nothing can vouch for the grid.
- When nothing can be heard at all, the overnight charging no longer treats that as the grid
  being lost: it holds rather than ending the night's buy or switching force-charge off.
- Reads from the EcoFlow cloud now give up after 30 seconds. They had no limit short of five
  minutes — as long as the freshness window — so a single stuck read could have stalled every
  device's update past it. Commands keep the longer limit: a slow reply can still mean the
  command arrived, and treating it as failed would send it again.
- The Energy flow card shows the house load as not reporting while the panel's readings have
  stopped, instead of drawing its last load next to a grid reading the add-on no longer trusts.
- The v1.178.0 rule that a "no grid" reading overrides a grid declared present is unaffected.

New harness `scripts/mutate-presence-fresh-readback.mjs` (13 anchor-asserted mutants).

## 1.178.1

### Battery net and panel load no longer publish 0 at a restart

- 1.178.0 stopped model-less zeros reaching Home Assistant after a restart, and at its own
  deploy fifteen of the governed sensors did go to unknown and back. Two did not: `Battery Net`
  and `Panel Load` still went X → 0 → X. Both publishers added up the fleet flows before waiting
  on the analytics reports, and judged whether those sums were ready after waiting. The first
  device poll lands during that wait, so readiness saw real devices and passed sums that had been
  taken before any device had reported. The sums are now taken after the wait, from the same
  device state readiness judges, so the two cannot disagree. They are also a few seconds fresher.

Harness `scripts/mutate-grid-veto-boot-zero.mjs`: three mutants added (32).

## 1.178.0

### A measured "no grid" outranks a declared grid; boot placeholders are published as unknown

- **The panel's "grid not detected" now overrides a grid declared present.** With
  `input_boolean.grid_available` (or `GRID_AVAILABLE`) ON, the grid resolver trusted that
  declaration over the panel's own reading everywhere except at the reserve floor. In an outage
  with the toggle left ON the grid kept "backstopping": the runway alarm's spoken warning stayed
  gated silent, `runway_projection_islanded_only` read ON, `off_grid` read OFF and the Runway card
  said "not a live countdown" — until the pool neared the floor, by which time the hours in which
  to shed load or start a generator had passed. An online panel reporting `gridSta` 0 ("grid not
  detected") or 2 (out of spec, islanded onto the batteries) now vetoes the declaration at any
  state of charge, and the resolver's reason names the code the panel reported. The veto holds
  on the panel's last reading until a newer one says Grid OK (grid power measured flowing still
  counts as the grid while it flows): a panel that goes quiet — cloud-offline, replaying stale
  data, not refreshing, briefly reconnecting, or sending a reply without its grid status — does
  not turn an announced outage back into "grid present". Each of those,
  if allowed to lift the veto, dropped `off_grid` and `load_shed_recommended` mid-outage and
  gated the runway warning again. If the grid returns while the panel is dark, "no grid"
  persists until the panel reports: an early alarm, not a missed one. A panel that has never
  reported `gridSta` vetoes nothing, and the reading is kept in memory only: after an add-on
  restart with the panel dark, the declaration stands again until the panel reports. In three
  weeks of recorded history (2026-09-01 to 09-22) the panel never reported 0 or 2 while the
  grid was up, and a false reading would sound an alarm early rather than silence one.
- **No more model-less zeros in Home Assistant after a restart.** The first state publish runs
  on broker connect, about a second before the first device poll, and the next one about 75 s
  later. Everything computed in between came out 0 and was published as a reading: across the
  day's four restarts, 16 sensors went X → 0 → X each time — fleet PV and battery net, panel
  load, five alarm counts, the usable-speaker count, CO2 avoided (7 d), tariff today and
  7 d, curtailment (7 d), array peak and the next-24 h PV forecast. Measurement sensors took a
  false minimum of 0 into every restart hour, and the Energy dashboard's solar and battery rates
  dropped to 0. `pv_curtailment_kwh_today` is `total_increasing`, so its dip (5.44 → 0 →
  5.44 kWh) read as a meter reset and the day's curtailment was counted again — 8 times since
  09-01. Each group of fields now publishes null (`unknown`) until its own input exists: fleet
  flows until an online Core is projected, panel load until the panel reports a channel, alarm
  counts once the monitor has run, the speaker count after the first probe, the forecast when
  there is PV history to project from, and the clipping, curtailment, carbon and tariff figures
  when their report ran on a real basis — for curtailment that includes weather, which is
  missing after a restart until the first forecast fetch succeeds and would otherwise have
  produced the same 0 by another path. Both the MQTT publisher and `/api/ha-state` apply the
  same rule, and the "PV Curtailment Active" binary sensor reads unknown rather than off while
  withheld. A DPU-only install (no panel) keeps publishing its grid cost. Genuine zeros — no PV at night, no active alarms — publish as before. Lifetime
  counters, which come from persisted totals, are unaffected.
- The console's plant PV view shows "—" for the next-24 h forecast while it has no basis.

New harness `scripts/mutate-grid-veto-boot-zero.mjs` (29 anchor-asserted mutants).

## 1.177.0

### The Runway card says what its projection shows

- **"No dip in 24 h — forecast PV keeps up with load" is gone.** It was printed whenever the
  islanded pool did not cross the reserve floor inside 24 hours — the only condition the
  projection tested. On 2026-09-22 it sat above a projection that fell from 78 to 26 kWh, with
  solar covering 57% of the modelled load. The projection now reports its lowest point and when
  it happens, and the headline reads "reserve holds 24 h" labelled with that lowest point and its
  margin over the floor ("lowest ≈ 26.0 kWh around Wed 6:00 AM, 11.3 kWh above the reserve
  floor"). "Forecast PV keeps up with the load" appears only when the pool never falls below where
  it is now. A lowest point within 15% of full above the floor is shown neutral rather than green
  (never more alarming than a reserve crossing 12–24 hours out, which is also neutral).
- **"Grid is carrying the load" only when it is.** The note read "grid is carrying the load"
  whenever the grid was backstopping, including with 0 W imported while solar carried the house,
  beside an Energy flow card reading GRID STANDBY. It now says so only when grid power is flowing
  and reads "grid available as a backstop" otherwise. The note — "these are islanded projections,
  not a live countdown" — is still shown only while the grid resolver says the grid is
  backstopping: a grid that is merely reported present at the reserve floor (a declared grid with
  no measured flow, or a panel reporting "Grid OK" while the pool keeps discharging) is exactly the
  state in which the projection is the live countdown and the alarms speak critical, and the card
  says nothing to the contrary.
- **The header names the load model in use.** "Last-hour load + next-24h forecast PV" described
  only the degraded fallback. The projection normally runs the day-of-week load curve (without
  predicted EV charging) with the last hour's load blended into the first four hours — live, 2.2×
  the last hour alone. The header reads "typical load" normally and "last-hour load" in the
  fallback.
- **"Recent load" is captioned by what it is.** Every fallback — a live reading after a restart,
  a single recorded sample, a value carried forward from the previous compute — was labelled
  "1-hour average". The caption now follows the projection's `recentLoadBasis`.
- **The two forecast-load figures say why they differ.** The Dashboard's runway load leaves out
  the predicted-EV layer (the alarm path is evidence-based; past EV charging is still averaged
  into the typical load curve, and a car charging now shows in the recent load); the Solar tab's
  forecast load adds it (live: 93–94 vs 96.3 kWh). Each now says which, and the Solar tab's
  projected low SoC notes when EV load predicted before that low is included.
- **Home Assistant and the Dashboard agree on the next-24 h solar forecast.** With every Core
  reporting the two are meant to be one number, and had drifted apart twice: the value published
  to Home Assistant skipped the learned bias correction (51.4 vs 52.9 kWh live, exactly the
  factor), and its solar model was refit on hours the Dashboard's model excludes after any
  partial-fleet day (79.4 vs 76.7 kWh reproduced). With no Core missing the published figure now
  uses the Dashboard's model and correction. The runway and its alarms are unaffected: they never
  read the display figure.
- The projection's lowest point is timestamped at the empty crossing when the pool empties,
  matching `emptyAtMs` instead of the end of that hour.
- "of 92 full" keeps the tile's own decimal ("of 92.2 full").

New harness `scripts/mutate-runway-card.mjs` (15 anchor-asserted mutants).

## 1.176.0

### The dashboard says how old its data is — and stops saying "live" over stale data

- **The LIVE pill needs fresh readings, not just an open link.** It was the WebSocket's state
  alone, and a socket stays open while the server has nothing new to send: it read LIVE, green,
  through the 2026-09-22 03:17–03:28 EcoFlow cloud outage. It now reads **live** only when every
  home reading — the panel and each online Core wired to it — is under three minutes old (the
  alarm engine's own "Telemetry stale" threshold), and **stale** otherwise.
- **"updated N ago" is the age of the oldest reading, and keeps counting.** It printed the
  snapshot's `generatedAt`, which the server bumps on every poll FAILURE — the harder the cloud
  failed, the fresher the header looked — and it only re-rendered when a new snapshot arrived.
  It now reads a new server clock, `lastTelemetryAtMs`, moved only when telemetry content lands
  (not by a `/status` online flip, a failed poll or an empty payload), and ticks every 5 s.
- **A panel replaying a stale cloud copy is stale.** The EcoFlow cloud can answer the panel's
  poll with 200 OK and a replayed body; the server flags it and raises "Panel data is stale"
  (21 episodes 2026-09-13..21), but every replay refreshed the panel's clock. Its reading time
  is now capped at when the replay began. A panel that has not reported since a restart counts
  as never reported, found by identity even before its first projection arrives.
- **Ages are measured on the server's clock.** Every reading time is server-stamped, so
  comparing them with the browser's clock made the pill wrong by any skew between the viewing
  device and the host (this host has no RTC and boots on a baked-in date until NTP). Each
  WebSocket frame now carries the server's time at send, and the browser measures ages against
  it, taking the least-delayed frame so a backlog shows as age rather than skew.
- **Runway, Today and Curtailment say when their figures are old.** Each kept its last payload
  indefinitely when refreshes failed — Runway set an error flag nothing read after its first
  success, Today returned silently — with nothing on screen to say so. They now show "stale · as
  of <time>" (naming the day when it is not today) once they have missed their polls. The Today
  card and the Solar tab's Today tile drop a payload whose day is over instead of showing
  yesterday's totals under "since 12:00 AM"; `/api/summary/today` now returns `dayEndMs`, exact
  across daylight-saving changes.
- **Two pages no longer take the dashboard down on a server error.** The Solar tab and the
  circuit popup stored an HTTP 500 body as data, and the render then threw — the whole dashboard
  fell to its error screen, e.g. when the Solar tab polled during an add-on restart. A failed
  Solar history request now keeps the last good chart instead of blanking the day. The Insights
  sections no longer render an error body as their payload.

Pure logic in `web/src/freshness.ts`, run by the server suite; new harness
`scripts/mutate-dashboard-freshness.mjs` (23 anchor-asserted mutants).

## 1.175.0

### The Energy flow card draws the grid where it goes, and a silent panel is no longer a 0 W house

- **Grid power is drawn to its real destination.** The SHP2's grid reading is the total at the
  main, and the card drew all of it as one edge into the Batteries; the only edge into Loads came
  out of the Batteries. A grid carrying the house was therefore drawn as the house running on
  battery. At 03:30 on 2026-09-22 the grid supplied 1901 W of a 1904 W house while the home Cores
  output 0 W and their packs moved 16 W — the card showed 1.9 kW flowing into batteries nothing was
  charging and back out of inverters producing nothing. The card now draws grid → Batteries for
  the Cores' own AC input only (grid charging them) and a separate grid → Loads edge, routed below
  the battery node, for the rest, capped at the house load. During a force charge both appear
  (04:05: 15,969 W into the Cores, 1,996 W to the house); the grid node keeps the metered total.
- **The arrows into Loads sum to the Loads box, attributed from the fresher meter.** The
  Batteries → Loads edge was `Math.max(load, acOut)`: the Cores' inverter meter against the
  panel's own total, two meters that differ by tens of watts (the reported view showed 1925 W
  into a "1.89 kW" box; live 14,427 W into "14.36 kW"; about 30% of overnight 5-minute buckets
  disagreed). The panel reports in one frame every ~60 s and the Cores every ~10 s, so every
  transition — a charge ramp, a charge ending, the Cores handing the house to the grid — has up
  to a minute in which they disagree. The Cores now count as delivering only when their
  inverters report output. When they are the house's only source, their edge is the house total;
  when they are idle, the grid carries the whole house (including in the minute after they stop,
  before the panel's next frame shows the main rising); with both, the Cores' share comes from
  their own meter and the grid takes the rest, so the two edges always sum to the box. The Grid
  node shows the main meter unless the faster meters show it is a frame behind (it read 3.41 kW
  beside a 16.3 kW charge at a ramp, and 18.4 kW beside a 2.1 kW flow as a charge ended).
  Replayed over 190.5 h of recorded meter history (150,466 instants), the card now draws no
  flow out of Cores whose inverters report nothing, never loses the Cores' delivery, never shows
  the house with nothing feeding it, and never shows a Grid node its edges contradict; the first
  cut of this change had drawn phantom battery output for 593 minutes of that history.
- **A panel that is offline or replaying a cloud shadow is not read as live.** The server already
  zeroes such a panel's grid reading; its channels still held the frozen house load, which would
  have drawn a grid-fed house flowing out of idle batteries. The Loads node reads "—" with "panel
  data stale", and the Cores' grid draw is counted over the same Cores the Batteries node shows
  (the server's import figure also counts a source slot whose Core is not connected). With no
  connection table yet (cold boot) the server's fail-safe import figure is used, so a bench
  spare's wall charge is not drawn as live grid.
- **A panel that reports no channel watts reads "—", and records nothing.** The SHP2 projection
  always carries twelve channel entries, with `watts: null` for any the payload omitted. The card
  summed them to 0 W, and the recorder started its `panel_load` sum at 0 and stored that as a
  measured "house drew 0 W" — a row the Today tiles integrate and the night-charge load model and
  band calibration learn from. The card now shows "—" with "panel not reporting", and the
  recorder writes no row, so the gap is a coverage gap every consumer already handles. The
  runway's last-resort fallback re-used its own previous recent load, which each compute wrote
  back, so with no rows it would carry a pre-silence load (an EV charging) forward indefinitely;
  the carry now lasts only while a real reading is under two hours old.

The card's numbers now come from a pure module, `web/src/cards/energyFlowModel.ts`, which the
server test suite imports and runs against recorded scenes from 2026-09-22 (the 03:30 backstop, the
03:43 charge ramp, the 04:05 and 04:35 steady charge, midday solar). New harness
`scripts/mutate-energy-flow.mjs` (15 anchor-asserted mutants). The Solar and Batteries nodes are
not balanced against the house: PV is metered on the DC side and the house on the AC side, and the
MPPT, charger and inverter losses between them are not drawn.

## 1.174.0

### Two transient conditions no longer speak: a sunrise solar code, and a brief cell-spread excursion

- **The MPPT string error code must now stand for three minutes.** Error code 457 is the benign
  standby status a Delta Pro Ultra reports on a shedding string; the existing guard rejected it by
  requiring the string to be producing, a rule derived entirely from sunset, where a shedding
  string makes no watts. At sunrise the same code rides a string that IS producing: on 2026-09-22
  one home Core reported HV code 457 at 407 W / 301 V / 1.38 A for about 60 seconds at 06:58 and
  again at 07:33, and both were announced over the house before clearing on the next tick (an
  identical 60-second blip on 2026-08-30 at 06:43). `dpu-pvh-err` / `dpu-pvl-err` now also require
  the SAME code to stand for `MPPT_ERR_DEBOUNCE_MS` (three minutes, the window the inverter error
  code and the SHP2 source error already use). A string genuinely faulting while producing still
  alarms — three minutes later.

  The clock behind that window (`SnapshotStore.trackMpptErrOnsets`, keyed `<sn>:hv` / `<sn>:lv`)
  advances only while the code is non-zero AND the string is producing, which is the exact
  condition the alarm fires on. A code standing overnight on a dark string therefore banks no
  time, and the sunrise ramp that carries it into real watts starts the window from zero. The
  producing test itself moves to `server/src/mppt.ts` so the alarm engine and the clock read one
  definition.

- **A cell-imbalance warning waits ten minutes before it is spoken.** The cell-spread warning fires
  at 24 mV and holds at 20 mV, close enough to normal working spread that packs cross it and settle
  back within minutes: a six-minute excursion at 21:14 on 2026-09-21 was announced, as were
  episodes through the night. Nothing in the first minutes is actionable. `vdiff-warn-*` and the
  `peer-voldiff-*` report of the same event now stay off the audible path until the spread has
  stood for `IMBALANCE_SPEAK_HOLD_MS`; the card, the push and the digest are unchanged, and the
  CRITICAL imbalance still speaks immediately. Age is read from the restart-persistent onset
  sidecar, so the hold is not reset by the roughly daily host restart.

New harness `scripts/mutate-alarm-transients.mjs` (12 anchor-asserted mutants) covers both guards,
including the two ways each could ship inert: a debounce clock that counts a dark string, and a
speak hold that is exported, tested and never wired into the tick.

## 1.173.3

### Source comments, test descriptions and design docs in the spec register

Source comments, test descriptions, mutation-harness notes and the design documents under
`docs/` carried quoted request text and personal attributions for decisions. Each is restated as
a plain policy or requirement — for example, the stale-data alarm's rule now reads "Policy: the
stale-data alarm sounds only after the immediate remediation has failed." One runtime string
changes with it: the write-readiness gate's blocking text now says re-scoping the cushion is "a
policy decision" (PERFORMANCE.md quotes it and is updated to match). No behaviour, identifier,
threshold or mutation anchor changes; "owner" is kept where it names the user-configured reserve
floor (`ownerReserveFloorPct`) and the manual-cancel control.

## 1.173.2

### Release notes in the spec register; one log line per held boot yellow

- **Release notes no longer quote or attribute requests.** CHANGELOG.md, CHANGELOG-ARCHIVE.md
  and the release paragraphs in DOCS.md carried quoted request text and "Owner (date):" style
  labels. Each is rewritten as a plain statement of the problem, the measurement and the change;
  every version, number, identifier and requirement is kept. Quotations of log lines, UI text and
  announcement text are unchanged.
- **The boot-yellow hold logs once per episode.** v1.173.1 wrote "yellow held for boot
  confirmation" on every 10-second tick while a startup yellow waited out its confirmation window
  (eight identical lines on the first restart). It now writes one line per held episode.

## 1.173.1

### The band calibrator uses the more accurate solar data, and a restart no longer speaks a yellow

The probabilistic band calibrator
(skillFrac, bandSigmaCal, the night-charge basis gate, and `realizedDailyErrHalfFrac` — the
multi-day widening that sizes the buy) now scores on the **realized** irradiance series, like every
other consumer since v1.173.0. Its errors stop carrying a ~3-4-day-lead weather-forecast component
that is not the day-ahead band's own error. Expect the multi-day widening to narrow (~40% on the
2026-09 window), so weekend and Thursday carries buy somewhat less. Hours with no realized capture
fall back to the first-write value.

Reported 2026-09-21: every restart spoke a yellow ~20-60 s
after boot — five that day. Startup transients do it: an off-panel Core's standing warnings are
muted only once its off-panel streak rebuilds (it restarts at zero), and learned alerts re-warm.
The restart-continuation gate only suppressed a yellow at or below the pre-restart level. Inside
the 10-minute warm-up window a fresh yellow must now persist **2 minutes** before it is spoken; a
genuine standing warning is delayed by at most that. Red is untouched.

`mutate-blind-remediation.mjs` 18/18 (two added); `mutate-realized-ghi.mjs` 25/25 (xv REPLACED —
the decision it guarded has now been taken; it now catches a silent revert); 2 new tests.

## 1.173.0

### The open list of 2026-09-21: cost mode is asked on high-pack nights, per-pack state follows the battery, the charge cap follows the connected Cores, and stale-data warnings stop speaking

Scope: items 1–8 of the open list, plus item 12 — the charge cap varies with home load, so it
needed either a fixed interim value (16 kW) or a better model (the AUTO cap below).

- **Cost mode is asked on a high-pack night.** When the pack at window close already cleared
  floor + cushion, the planner returned HOLD before cost mode ran — so the Thursday rule (and every
  cost ceiling) could never raise a night that started high. Cost mode now continues with a
  resilience lift of zero and holds only when the cost target is not worth a buy. A replayed
  Thursday at 70% buys ~27 kWh toward 90% instead of holding.
- **Per-pack alert state follows the BATTERY, not the slot.** Alert ids stay (chassis, slot) —
  they are persisted and user-visible — but when a different pack occupies a slot (Core 4,
  2026-09-20: pack 1 pulled, the rest renumbered 1–4) the retired episode's notify record is
  forgotten (its first push was being swallowed), its onset restarts (its cleared record spanned
  two batteries), the vdiff warn-hold no longer carries over, and the learned families
  (baseline, forecast-SoH, forecast-imbalance) now carry the serial so the check can see them.
  Pushes and the digest name the battery by a 6-character serial tail. The confirmed-defective
  latch was already keyed by serial. A real serial tail in a public test fixture was replaced.
- **The planner no longer plans on a stale panel.** It reads the panel through the same freshness
  gate as the actuator; a stale reading at 21:30 DEFERS the evening job (retrying inside the
  catch-up window) instead of latching an "incomplete basis" night.
- **A deadline page silenced by quiet hours is re-spoken** every 30 min until heard (Friday's
  deadline lands at Sat 01:00); the push is not repeated.
- **Blind (no-readback) Charge Now OFF re-sends stop 12 h after the first OFF.**
- **The panel ceiling RESTORE is an own-write** — no false "Setting changed" push after a night
  whose force-charge never started.
- **The solar record is the TRUE realized series for training, soiling and skill reporting**
  (GHI stage 2). The probabilistic band calibrator stays on the first-write series — switching it
  would cut weekend-carry widening ~40%, a policy decision left open here.
- **Smaller:** the poll-slow line names failures outside the standing 1006 accessory set; the
  escalation text matches the re-send behaviour; the ledger records which surplus basis and
  whether the long-gap rule set the cost ceiling; with a Core out, a predicted EV only displaces
  what the per-Core bound's slack cannot absorb.
- **12 — the charge cap is AUTO.** `ARB_CHARGE_CAP_KW` = 0 (the new default) derives the planner's
  grid-side cap from the connected Cores × 5.5 kW into the pack (≈ 5.9 kW each at the grid,
  ≈ 17.8 kW for three); the home load comes off separately through the grid-input envelope
  (17 kW). The fixed 7.2 kW under-stated the ~15 kW the pack actually takes, so every plan
  announced a lower target than the night reached. A Core out lowers it on its own; > 0 is a
  manual override. The planner and the force-charge start now use one model.
- **The "Telemetry stale" warning no longer speaks** — it spoke a yellow ~20 s after every
  restart (a device reads stale until its first fresh reading) and at stale episodes. Push and
  card kept; the telemetry-blind CRITICAL stays the audible, remediation-first path (v1.172.1
  did the same for the message-rate collapse warning).

Harnesses: new `mutate-pack-identity.mjs` (5/5); `mutate-realized-ghi.mjs` extended (25/25);
`mutate-blind-remediation.mjs` 16/16; `mutate-force-charge.mjs` 66/66.

## 1.172.1

### The message-rate collapse warning no longer speaks

Reported 2026-09-21 18:13: an audible alarm fired with no matching HA card. A cloud stale-shadow
episode (the Smart Home Panel 2's message rate fell to 0) raised the
`msg-rate-floor` warning at its ONSET, and the broadcast spoke it as a yellow — about four minutes
before the telemetry-blind alarm starts the MQTT rebuild that has repaired every such episode in
~2 minutes. There was no HA card because warning pushes settle for five minutes, and the condition
was usually gone by then.

That broke the standing policy (2026-09-17): a stale-data alarm sounds only after the
immediate remediation has failed. The rate-collapse warning is now excluded from the spoken
condition, exactly like the audible-unreachable self-alert. It keeps its push and its card. The
telemetry-blind CRITICAL remains the audible path for a panel that stops reporting, and it still
remediates first and sounds only if that fails.

`mutate-blind-remediation.mjs` 15/15 (one mutant added); 1 new test.

## 1.172.0

### A removed pack no longer lingers as a ghost

Reported 2026-09-21: with one battery physically removed, all 25 packs still showed as active and
reporting. The defective Core 4 pack 1 was pulled for warranty on
2026-09-20 around 12:10. The Core renumbered the four remaining packs as slots 1–4 and reported
**4 packs** — but the Fleet pack matrix kept showing 25, with Core 4 "pack 5" at a frozen 55% /
84 °F. Slot 5 still held the last readings of the pack that now reports as slot 4 (**the same pack
serial in both slots**): its voltage last moved at 12:10, its SoC at 13:01, its temperature not
once in 36 hours. The recorder kept writing it, a predicted-SoH alert and the Core's imbalance
warning kept reading it.

**Why:** a Core's pack list is built from every slot 1–5 that has any value in the cached raw
quota, and that cache only ever gains or overwrites values — nothing removes a slot whose pack is
gone.

**Now** a slot whose readings have **stopped changing** is hidden when either the Core's own pack
count says there are fewer packs than slots, or it repeats another slot's pack serial (a renumbered
pack's old address). Every live pack's voltage or temperature moves within minutes, even at rest.

- Nothing is hidden without evidence: the count rule needs a positive count from the Core (a
  missing or transient 0 hides nothing), and a slot must be frozen at least 10 minutes behind
  every pack kept — so after a restart nothing hides until the live packs move.
- A hidden pack that starts reporting again is shown again. One log line per hide and per return.

New `server/src/packPresence.ts`; harness `scripts/mutate-pack-presence.mjs` (6/6); 10 new tests.

## 1.171.2

### Fix: v1.171.1 reported every panel WRITE as failed

v1.171.1 made the EcoFlow client reject a code-0 ("success") reply that carries no data — right
for reads, where an empty payload had wiped every Core's cached quota. But it applied the check to
**every** call, and a **write** (PUT) legitimately answers success with no data. So every panel
write after that release was reported as failed although it took effect.

2026-09-21: the 05:05 reserve revert reached the panel — it read 16% — yet was counted as 15
failures, escalated, and **spoke a false CRITICAL** ("reserve stuck at 50 percent") with a critical
push. Left alone, the unresolved revert would also have refused tonight's arming.

The check now applies to reads only. The revert keeps retrying every few minutes, so the first
retry after this deploy is acknowledged and the night closes normally.

The force-charge that night was otherwise correct: ON at 00:05 (timed from the live rate), OFF at
**the 84.5% target** at 04:39, readback-verified at 04:40, the panel's ceiling restored at 04:42.

`mutate-audit-fixes-0920.mjs` 7/7 (one mutant repointed, one added); 1 new test.

## 1.171.1

### The other four findings of the 2026-09-20 log audit

**A prior night's ARM could fire against tonight's own decision.** Saturday has no cheap window
of its own, so its evening job arms for the Monday 00:00–05:00 window. The supersede lived inside
the "tonight produced an armable plan" branch, so if Sunday then decided to HOLD — or had an
incomplete basis — Saturday's arm still applied at Sunday 23:55: a reserve write, and a
force-charge riding it, against the engine's fresh decision not to charge. Every non-charge
decision now **cancels** a prior night's arm (ledger-stamped), and only one that is safe to
cancel: never applied, never attempted, window not yet open, no unverified force-charge, no
unrestored panel ceiling. A night that reaches NO decision (the 23:00 cutoff) still cancels
nothing — it now names the pending arm and when it will write.

**An EcoFlow "success with no data" wiped every Core's quota and pushed a false all-clear.** On
2026-09-20 at 09:06 the vendor answered code 0 with no payload for all five Cores at once. The
empty answer was cached as their raw quota, so within one 20 s alert tick every pack alert
evaluated against `packs: []` and RESOLVED — including the warranty pack's "Pack confirmed
defective", which is exempt from every mute. The operator was pushed a false resolve and re-paged
100 s later. Now: the REST client rejects a code-0 reply with no payload as its own named error
(it used to surface as a TypeError naming a BMS field, reading like five device faults), and the
snapshot store refuses to replace a good quota with an empty one.

**A failed push was lost outright.** The dispatcher retries on the next tick only while the alert
is still active, so a short-lived alert whose one attempt failed reached the operator on no channel
at all — 2026-09-19 15:00, "[High] Telemetry stale", lost to an HA timeout. A failed push is now
also held for the morning digest; a later successful dispatch clears the hold, so it is never
reported twice.

New harness `scripts/mutate-audit-fixes-0920.mjs` (6/6); 5 new tests.

## 1.171.0

### The hourly pack scan no longer stalls the analytics worker

Log audit (2026-09-20): `computeChargeCurveFingerprint` read **every raw sample** of three
metrics, per pack, per Core, over a 200-day window, and pinned the single analytics worker for
**16-20 s every hour**. An alert-monitor tick that landed inside the stall waited it out, and the
next tick was dropped by the re-entrancy guard — so alarm latency for the conditions that worker
serves (forecast, runway, baseline, curtailment) doubled to ~40 s.

The scan now asks the recorder to bucket at **60 s**. That costs the report nothing: SoC is
matched to checkpoints at ±1.5%, the voltages behind each checkpoint are reduced to a median, and
the "is it charging" gate is a coarse >100 W. The bucketing happens in SQLite on shared boundaries
for all three metrics, so the snap-to-nearest join now lines up exactly instead of approximately.
The 200-day window is unchanged.

New harness `scripts/mutate-charge-curve-bucket.mjs` (2/2) — dropping the bucket, or widening it
past the checkpoint tolerance, is otherwise invisible in every report the scan produces.

## 1.170.0

### The 80%+ coast is retired — force-charge stops at the target, whatever the target

Both recommendations from the first 90% night (2026-09-18) are adopted.

- **Stop at the target, at every target.** v1.168.0 left Charge Now on past an 80%+ target on the
  premise that the panel would then hold the pack there with the house on grid. Measured on
  2026-09-18 it did not: at the 90% ceiling grid import fell to 0 W and the house drew the pack
  90% → 86% by 05:00. So the coast only added Charge Now time. The software stop now applies at
  every target again. It stops at the panel's whole-number ceiling when that is lower than the
  target (an 85.3% target syncs an 85 ceiling, and a whole-number SoC reading never reaches 85.3),
  so the old rounding miss stays fixed. The announcement, the 21:30 line and the option help say
  so.
- **A Core out no longer over-states the charge rate.** The live rate is now also bounded by
  connected Cores × 5.5 kW — the least each Core has been seen to take into its pack (2026-09-18:
  ~17.8 kW at the grid over three, with the grid cap the binding limit). With all three connected
  it never binds; with one out for a pack swap, the start comes earlier instead of the night
  ending short.

Four coast mutants are **replaced**, not repointed — the property they protected was
retired; three repointed; three new (`mutate-force-charge.mjs`, 66/66).

Known, safe-side: with a Core out *and* an EV predicted, the EV allowance is counted in full
although the per-Core bound already absorbs part of it, so the start comes early. Not yet
measured: that the pool reading reaches the synced ceiling at a ceiling other than 90 — if a pack
parks one below, the window-end OFF ends it.

## 1.169.0

### Force-charge times its start from the live charge rate — what the house leaves under the grid cap

The maximum charge rate is higher than the fixed planning figure, and it varies with home usage
during the charge period. Confirmed from the panel's own readings:

| 2026-09-18 | grid | house | grid − house | into the pack |
|---|---|---|---|---|
| 01:10 | 19.1 kW | 1.3 kW | 17.8 kW | 17.0 kW |
| 01:40 | 19.1 kW | 4.0 kW | 15.1 kW | 13.8 kW |
| 02:10 | 19.1 kW | 1.8 kW | 17.3 kW | 16.3 kW |

Grid import sat **pinned at 19.0-19.1 kW** on both measured nights while the house moved; the pack
took what the house left, through the ~0.93 charge leg. On 2026-08-02, with the EV drawing (panel
load 14.0 kW), the pack took ~2.8 kW.

1.167.0 timed the switch-on at a fixed 10 kW. On 2026-09-18 the pack actually took ~14.6 kW, so
it reached 90% at **03:30** — 1.5 h early. The start now uses
**(`ARB_GRID_INPUT_CAP_KW` − live house load) × charge-leg efficiency**, recomputed every minute
until it switches on, so it follows the house's actual usage. The house load is the sum of the
panel's circuits (the same `panel_load` the recorder keeps; it includes the EV charger). With the
configured 17 kW that night times at ~13.4 kW — a little under the real rate, so the pack arrives
slightly early rather than short; the EV night times at 2.8 kW, matching what was measured. A
house drawing past the cap is floored at 1 kW (start now, never "never"); no live reading falls
back to the fixed 10 kW. Planner and force-charge now read the cap from one place.

**Usage DURING the charge, not just before it.** A reading taken before the switch-on cannot see
a car that plugs in afterwards, and an EV cuts the pack's rate about five-fold (~15 → ~2.8 kW). So
the start also budgets the planner's predicted (P90) EV energy for the rest of tonight's window:
every grid kWh the car will take is ~0.93 kWh the pack will not get, and the start moves earlier by
that much. Only a plan for the same window counts. A car already charging is counted twice (live
load and forecast), which errs toward starting early — the safe side.

**Planner fix found on the way:** a mid-window recompute gave the partial hour's remainder to the
LAST window hour instead of the current one, so at 02:55 an EV predicted for 04:00-05:00 counted
~1/12 of its energy (and the deliverable-lift estimate carried the same skew). Each window hour now
counts its own remaining fraction (`windowHourAvailH`). Plans made before the window — the 21:30
arming plan — are unchanged.

Not modelled: a DPU's own input limit. On 2026-09-18 the grid cap bound (~5.9 kW per DPU across
three), so no single DPU's limit has been measured; with a Core offline the rate could be
over-stated and the night end short.

**Measured, and corrected in the words:** at the 90% ceiling on 2026-09-18 grid import fell to
**0 W** and the house ran from the pack, 90% → 86% by 05:00, with Charge Now still on. The panel
stops importing at its limit; it does **not** keep the house on grid. The announcement, the 21:30
line, the option help and the module notes no longer say it does. Behaviour is unchanged — whether
to switch off at the target for 80%+ again is left as a policy decision.

11 new mutants (`mutate-force-charge.mjs`, 63/63; xv repointed); 9 new tests.

## 1.168.0

### Thursdays fill to 90%, every night plans for the median sun, and a coast on grid at 80%+

Question (2026-09-17, a Thursday): with the next night's charge window so short, should Thursdays
charge to 100% and coast on grid power until the super off-peak overnight window ends? After the
measurement below, the change went live the same night.

An 8-week replay (house ~114 kWh/day against ~55 kWh/day of solar) answered it:

- **The Thursday rule.** On a night that is itself a full-length cheap window and whose next
  full-length window is **more than a day away**, cost mode sets the morning-solar headroom aside
  and fills to `ARB_COST_MAX_SOC_PCT` (90). Thursday qualifies: Friday's overnight rate is only
  23:00-24:00, Saturday and Sunday are all off-peak, and the next full window opens Monday 00:00.
  ~90% beat the solar-headroom ceiling by ~$1/week; 100% beat 90% in only 2 of 8 weeks, both by
  ≤ $0.20, both on cloudy Fridays. The rule reads the **tariff calendar**, not the weekday name —
  windows shorter than 3 h are stepped over, and Friday's own 1-hour window never qualifies.
- **The median, not the P90.** Every night's economic ceiling left room for the P90 (best-case)
  morning solar surplus. That was too cautious every night: 2026-09-17 planned for 32.6 kWh
  against measured Friday surpluses of 7.7-24.2 kWh (median ~16), and the pack never passed 80%
  in 27 days. The cost ceiling now leaves room for the **P50** surplus (the P90 stands in when the
  median is unknown). The P90 still drives the resilience over-buy flag.
- **Coast on grid at 80%+.** A target of 80% or more is one the panel's own force-charge ceiling
  can **hold**: with Charge Now still on at that ceiling, the pack sits there and the house runs on
  grid. So for those targets force-charge no longer switches off at the target; it stays on until
  the window closes, and the pack gives none of it back before the cheap rate ends. The evidence:
  07-23 and 07-28, the only nights the pack held above 50% on grid, were both manual Charge Now
  sessions. Below 80% the software stop still ends it at the target. This also
  retires a rounding miss (an 85.3% target synced an 85 ceiling that a whole-number SoC reading
  never reached).
- **A wall-clock deadline on the switch-off.** Every earlier escalation needed a live readback or
  an accepted OFF — a panel whose readback stayed stale, or a cloud that kept refusing the OFF,
  left the verify loop waiting in silence. Now a force-charge of ours not verified off by
  **the later of first-OFF + 30 min and window-end + 60 min** escalates audibly and by push, once;
  with no readback the words say it **could not be confirmed** off rather than that it "still
  reads ON". It runs even when the panel has dropped out of the device list. It pages on its
  **own record**: an earlier retry-budget escalation that landed in quiet hours (push only) no
  longer disarms it, and a silenced announcement is now logged. Once escalated, the OFF is
  re-sent every 15 minutes even with no readback (it is idempotent) — before, a stale readback
  plus one rejected 05:00 OFF sent a single OFF all day.

**Exposure, stated plainly.** Coasting lengthens how long Charge Now is on for 80%+ targets —
on a Thursday about 4-6 h instead of ~1 h. Outage behaviour with Charge Now on is still **not
established** (no vendor text; never happened here). The attended daylight breaker test settles it.

Deferred to a following release: a separate cap for 100% on cloudy Fridays (needs a new option),
the planning horizon past Friday's 1-hour window, and the APS holiday list (currently empty).

Known, next release: when the pack is already high at 21:30, the planner's early "hold" answer
returns before cost mode is asked, so the Thursday rule cannot raise it (the pre-existing
"cost mode may never be asked" gap); a ceiling restore after a night whose force-charge never
started still reads as an external settings change.

23 new mutants (`mutate-force-charge.mjs`, 52/52; xxv repointed at the reshaped stop); 27 new tests.

## 1.167.0

### Force-charge runs to the night's target — just in time — then stops

Design (2026-09-17): the panel offers no setting between the 50% reserve and its 80% force-charge
minimum, so the add-on runs force-charge until the pack reaches the night's target, then disengages
and reverts to the prior settings. A night that needs 64% gets exactly enough force-charge time to
reach 64%.

1.165.0 refused every night whose target sat under the panel's 80% force-charge minimum —
which is every sunny night. 2026-09-17's target was 64.3%, so it stayed reserve-only.

**Now any target above the 50% reserve is reachable.** Force-charge switches on, and switches off
the moment the pool **reaches the target** (a software stop). The panel's own force-charge ceiling
becomes a **backstop**: synced to `clamp(target, 80, 100)` as soon as the night is live — hours
before the start, so its readback never delays it — and restored afterwards.

**It starts late, on purpose.** Once force-charge is off, only the 50% reserve holds the pack up,
so a pack that reaches 64% at 02:00 is drawn back toward 50% by the house over the three hours
left (≈57% at 05:00). But the reserve already charges the pack to ~50% and then **holds the house
on grid** — 2026-09-16 sat flat at 49% from 01:00 to 05:00. So force-charge only has to add the
last stretch, and it starts just late enough to arrive at the target as the window closes:

| | force-charge on | reaches 64% | at 05:00 |
|---|---|---|---|
| start at the window open | 23:01 | ~01:55 | ≈57% (drained) |
| **just in time** | ~03:26 | ~05:00 | **≈64%** |

The start is recomputed every tick from the live pool: the kWh still needed ÷ a **planned 10 kW**
+ a 15-minute buffer. 10 kW is deliberately below the ~15 kW measured on 2026-09-16, because an EV
charging at the same time shares the grid input: faster than planned arrives a little early and
drains a few minutes; slower arrives a little short. It never ends below the reserve.

- A stale or incoherent SoC never starts it and never stops it early — the window end, the
  panel's backstop ceiling and every v1.165.0 OFF rail still apply.
- A target at or below the reserve does not force-charge: the reserve alone reaches it.
- The "why not starting" reason stays stable while it waits (a reason carrying the moving start
  time would log every tick); the 21:30 ARMED line and the announcement name the target.
- The `ARB_COST_MAX_SOC_PCT` description is rewritten for the new behaviour.

**Still not established — outage behaviour with force-charge ON.** No vendor text covers it and it
has never happened on this plant. Just-in-time shrinks the nightly exposure from ~6 h to ~1 h; it
does not answer the question. One attended daylight test settles it: Charge Now ON for one slot,
open the main breaker, confirm backed-up loads stay up and the pack discharges.

Two v1.165.0 mutants that pinned the retired "under 80% ⇒ reserve-only" rule are **replaced**, not
repointed — the property they protected was withdrawn. Five new mutants
(`mutate-force-charge.mjs`, 29/29); 6 new tests.

## 1.166.0

### The stale-data alarm remediates first, and sounds only if that fails

Policy (2026-09-17): the stale-data alarm still sounds, but only after the retry has been initiated
and the immediate remediation has failed.
This settles the question left open in 1.154.0 about the telemetry-blind alarm speaking at 4–5 min.

**The incident that decided it** — 2026-09-17, during the on-peak window:

| time | event |
|---|---|
| 16:27:48 | the EcoFlow cloud replays a stale SHP2 shadow; message rate 34 → 0/min |
| 16:31:48 | telemetry-blind **CRITICAL**, spoken aloud at 16:32 |
| 16:47:48 | self-heal rebuilds the MQTT session — after its **20-minute** dwell |
| 16:49:48 | data moving again; the alarm resolves |

The order was backwards: the alarm spoke at ~4 minutes, and the remedy that fixed it in two
minutes did not start until 20. Weather and NWS fetches succeeded in the same second the panel
froze — the Pi was fine; the cloud session was wedged.

**Now:** when the telemetry-blind alert first goes active, the MQTT session rebuild fires
**immediately**, and the alert is held non-annunciating — no voice, no push; still on-screen and
in `/api/health` — for at most **5 minutes**. Telemetry back inside that window: it clears having
never sounded. Still blind at the deadline: the remediation **failed**, and the alarm fires exactly
as before.

- The hold has a **hard deadline** from the remediation; it cannot be extended or re-armed within
  an episode, and a remedy that never reports back cannot hold it.
- **No remediation available ⇒ alarm immediately.** The rebuild shares self-heal's rolling-24h
  budget (six), and needs 15 min since the last heal — a heal under 15 min ago means the last
  remedy did not hold, which is a failure. A remedy that cannot even start also sounds at once.
- It fails toward **sounding**: with no remedy registered, nothing is ever held.
- Only the telemetry-blind alert is gated. Every other alarm is untouched.
- **The cost, stated plainly:** the hold does not look at the cause. A genuine blind condition a
  rebuild cannot fix (internet down, clock-skew auth failure, panel offline) now alarms **up to 5
  minutes later** than before — about 10 min after the last good poll instead of about 5. That is
  inside the policy above, and it also debounces a blip that clears within the window.
- **"All clear" is never spoken while blind.** The pre-merge review found the hold's
  `annunciate=false` made the v1.17.0 all-clear speech gate stop seeing the blind alert, so a
  warning clearing during the hold could have announced *"All clear. All stations report normal."*
  while the system was blind. The gate (`allClearSpeechBlocked`) now counts the held alert.
- Every phase is logged: *remediating first*, *restored — the alarm never sounded*, *did not
  restore — releasing the alarm*, *no remediation available — alarming now*.

The rate-floor healer and this remediation now share **one** `rebuildMqttSession()`.

### "Chose not to" is never silent

- **Night force-charge** now says why it declined to start, once per reason per night, while a
  night is live — e.g. *"tonight's ceiling 64.3% is under the panel's 80% force-charge minimum
  (morning solar needs the room) — reserve-only night, by design."* The reasons come from the
  decision function itself, so they cannot drift from the logic. The 21:30 ARMED line states
  tonight's force-charge decision up front.
- **A critical held silent by policy** (a bench spare, an off-panel Core) now logs once per
  episode that it is on-screen only — until now that silence left no trace.

14 + 3 new tests, a new committed harness (`scripts/mutate-blind-remediation.mjs`, 14 mutants),
and 2 new mutants in `mutate-force-charge.mjs`. Seven existing anchors were repointed to the
reshaped lines (none deleted).

## 1.165.0

### Overnight charging continues past the 50% reserve, to the night's ceiling

**Why.** The panel caps the backup reserve at 50% (proven in 1.164.0). On 2026-09-16 it
charged 16% → 49% by 01:00 at ~15 kW into the pack — then sat **flat at 49% from 01:00 to
05:00**. Four hours of the cheapest window unused, because the reserve had reached its ceiling.

**What.** On a night whose reserve write is applied **and readback-verified**, the add-on now
switches the panel's per-channel **force-charge** (`ch{n}ForceCharge`, the app's *Charge Now*)
ON for the rest of the window and OFF when it closes. The panel's own force-charge limit
(`foceChargeHight`) is synced to the night's ceiling first, and the **device** stops the charge.

**The ceiling** is the announced plan's economic ceiling: `ARB_COST_MAX_SOC_PCT` (90) or the
room tomorrow morning's P90 solar needs, **whichever is lower** — a pack too full to take the
morning sun curtails it, and that wasted kWh costs the full price of the grid kWh in its place.
The panel cannot force-charge below 80, so a night whose ceiling is under 80 stays reserve-only.
It is captured at arming, like the reserve target: a fresher recompute never substitutes.
The planner and the force-charge now share **one** definition of that ceiling (`costCeilingKwh`).

**Why not stop at the ceiling in software.** With the reserve at 50%, switching force-charge
OFF at 90% lets the panel serve the house from the pack, draining it back toward 50% for the rest
of the window — forfeiting exactly the hours this recovers. Force-charge ON holds the house on
grid; the device ceiling ends the charge; and switching OFF never waits on a fresh SoC reading.

**No new option.** It runs when `NIGHT_CHARGE_MODE` is supervised/auto, `ARB_OBJECTIVE` is
`cost`, and `ARB_COST_MAX_SOC_PCT` is above 50. **Kill switch: set `ARB_COST_MAX_SOC_PCT` to 50.**
Its description is rewritten — it used to say, correctly at the time, that values above 50 were
advisory-only, and that charge power capped a night near 60% (2026-09-16 ran at ~15 kW).

### Rails — force-charge is the control behind the 2026-08-04 on-peak buy

- **OFF is unconditional**: window end, a cancelled night, the reserve revert, grid loss (the
  resolver **or** the panel's own `gridSta=0`), the feature being disabled mid-night, or a 7-hour
  hard backstop. It is mode- and enable-independent, and time-based — a stale readback still
  switches it off.
- **Write-ahead**: the slots are persisted before the ON writes, so a lost confirmation can never
  orphan a force-charge. A record whose slot list is unreadable switches off — and verifies — all three.
- **Readback-verified OFF**, re-issued, then a critical push. The verify grace (6 min) outlasts the
  per-slot write cooldown (5 min) — shorter, and every retry comes back rate-limited.
  Verification **keeps running after the escalation**, so the record resolves the moment the slots
  read OFF.
- **Arming refuses to bury** a night whose force-charge never verified OFF (arming returns a fresh
  record, which would erase the only one that knows to switch it off) — and says so in the log.
- **ON is narrow**: grid known present, a live slot readback, never before the overnight rate
  starts, never within 20 min of the window end, and **never when a slot is already on** — an
  operator's Charge Now is theirs.
- **Settings-drift** treats our own `ch{n}ForceCharge` / `foceChargeHight` moves as own-writes
  (else two false *"changed externally"* pushes a night); an operator's Charge Now is still reported.
- The 21:30 announcement says so, and drops the *"only expected to reach"* clause on those nights.
- The v1.84.0 Charge Now responder **pushes** on an on-peak grid draw with force-charge ON. It
  only switches it off in `CHARGE_NOW_RESPONSE=supervised`; live it is advisory — a signal, not a
  backstop.

### Four defects fixed before this ever ran, from a 28-agent adversarial review

- **The OFF stopped trying.** The first cut gave up writing after two re-issues (~18 min). A
  command path failing 05:00–05:18 would have left force-charge ON through the weekday into the
  16:00 on-peak — 2026-08-04 rebuilt. Now the OFF is re-issued **every 15 minutes for as long as
  it reads ON**; the escalation is **spoken** (like a stuck reserve), and only an OFF the cloud
  *accepted* counts against the readback budget.
- **The master switch removed the only timer.** The actuation tick exists only while
  `NIGHT_CHARGE_ADVISOR_ENABLED` is on, and any option change restarts the add-on — so the most
  obvious "turn this off" mid-night left force-charge ON with nothing to stop it. A separate
  safety tick now outlives that switch; it is inert unless a force-charge of ours is in flight,
  and it can only switch OFF.
- **ON could fire on an unverified ceiling**, filling to the panel's live 100% — past the configured
  90 and the solar headroom. ON now waits until the panel **reads** the night's ceiling (one
  retry, else reserve-only), and the panel's own ceiling is **restored** afterwards — otherwise a
  later storm-prep Charge Now would silently stop at 90. An unrestored original is carried into
  the next night, so the restore always returns the operator's own setting.
- **Islanded was read as connected.** Grid-connected is `gridSta === 1` **only**; the first cut
  switched off on `=== 0` and would have missed `2` — the outage case itself.

**Not established — the outage question.** No vendor text says how a slot with force-charge ON
behaves when the grid fails, and it has never happened on this plant. The evidence against harm
is inference (islanding is a panel-level transfer; a grid charge has no source without a grid;
this button has been used by hand with the same exposure). One attended test settles it: Charge
Now ON for one slot, open the main breaker, confirm backed-up loads stay up and the pack discharges.

32 tests and a new committed harness (`scripts/mutate-force-charge.mjs`, 24 mutants).

## 1.164.0

### The write ceiling is 50 again — and this time the device said so

v1.161.0 raised `RESERVE_WRITE_MAX_PCT` from 50 to 90 so the configured 90% target could be
written. The old bound
called itself *the device's documented `[10, 50]` range* in four places and **cited no document**,
so the honest thing was to ask the hardware. The night of **2026-09-16** answered:

```
21:31:40  ARMED — reserve -> 90% ... announced via HA notify + audible
22:55:45  SUPERVISED WRITE APPLIED — backupReserveSoc 16% -> 90%
22:57:45  settings-drift: EXTERNAL change — backupReserveSoc 16 -> 50
23:01:45  applyVerified, targetPct 50, requestedPct 90, applyRetries 0
```

The cloud accepted the 90 without error; the SHP2 moved 16 → **50** and stopped. The bound was
right all along — it simply had no evidence behind it. It has evidence now, recorded at the
constant, and should not be raised again without new evidence from the device.

**`deviceCeilingPct` is why that night cost two log lines instead of a page.** Introduced in
v1.161.0 for exactly this uncertainty, it recognised 16 < 50 < 90 as a real partial actuation,
adopted 50 as the target, kept 90 as `requestedPct`, and stamped the apply verified with **0
retries**. Without it the night would have burned both retries, ended on `applyFailed`, pushed
*"write NEVER TOOK EFFECT — tonight's buy is forfeited"* and corrected the ledger to
`actuated:0` — while the panel held 50 and charged. It stays: it still guards the general case
of an operator moving the reserve while a write is in flight.

Asking for more than the panel accepts also cost two false notifications, both fixed by this
release because the ask never exceeds 50 again:

- the 21:30 announcement promised a reserve the panel will not hold — the v1.133.1 over-promise,
  reintroduced by v1.161.0;
- `settingsDrift` matched only the exact requested value, so it read **our own clamped write** as
  an external change and pushed *"Reserve floor changed externally: 16% → 50%"*.

**Charging above 50% is a different mechanism.** `backupReserveSoc` is a floor and this is its
ceiling. The vendor's path to a fuller battery is force-charge (`ch{n}ForceCharge` +
`foceChargeHight`, documented range 80-100) — a separate command with its own on-peak hazard,
not reachable by widening this constant.

The harness mutants that pin the guards were re-aimed: with the constant back at 50, mutating a
guard to the literal `50` is a no-op that cannot be killed. They now mutate to a value inside the
envelope, which is what proves each guard tracks the **constant** rather than a number.

## 1.163.0

### Correction to 1.153.0 and 1.154.0

The 1.153.0 entry says `PRAGMA analysis_limit=400` bounded the boot `ANALYZE`, citing
"ANALYZE took 3,415 ms on the next boot", and the 1.154.0 correction says that bound
"stands". It does not. The 3,415 ms boot was a restart 13 minutes after another. The
next two boots, each after an image pull, spent **10,785 ms** (1.154.0) and
**12,374 ms** (1.155.0) in the bounded ANALYZE — 99.7% and 99.8% of their
`createRecorder` calls (10,817 and 12,403 ms) — against 9,725 ms for the unbounded one
on 1.152.0. Both entries are left as written; the source comment, the test and
`DOCS.md`, which repeated the claim, are corrected in place.

### What the bound did, measured

**Was the pragma applied?** Yes. The add-on image installs Alpine's `nodejs 22.22.2`,
which links the system `libsqlite3` (`sqlite-libs 3.48.0`) rather than a bundled copy;
`analysis_limit` has existed since SQLite 3.32. The live database's own `sqlite_stat1`,
read from a `/api/db-export` snapshot taken after the 1.155.0 boot, holds
`17548271 401 401 1` for the composite index and `17548271 7` for `idx_samples_ts`:
statistics only a sampling bound writes. SQLite ignores an unknown pragma without an
error, so the old `try/catch` could never have told "applied" from "unsupported".

**What does it bound?** The entry scan, and nothing else. ANALYZE opens each index with
an exact entry count (`OP_Count` with P3 = 0; P3 is nonzero only when the STAT4
optimization is disabled), and an exact count visits every page of the b-tree. On a copy
of the live database on the Pi (1.72 GB, 15.8 M rows), counted by SQLite's pager:

| `ANALYZE samples` | page reads | VM steps | cold | warm |
|---|---|---|---|---|
| unbounded | 469,666 | 296.5 M | 5,497 ms | 4,931 ms |
| `analysis_limit=400` | 234,851 | 13.6 k | 1,265 ms | 777 ms |

234,851 is every page of both indexes. The bound removed the CPU and halved the reads.
It also wrote wrong statistics — `15788340 401 401 1` for the composite index, against
`15788340 1973543 27651 1` unbounded: about 400 rows per SN where there are 2 million.

**Why 1.3 s on the copy and 11–12 s live?** Page order. The copy is freshly vacuumed: 97%
of its index pages follow one another on disk in b-tree order. Reading exactly that page
set, cold, on the same Pi:

| order | cold read | per page |
|---|---|---|
| b-tree order (the copy's layout) | 1,245 ms | 5.3 µs |
| the same 234,835 pages, shuffled | 11,920 ms | 50.8 µs |

The live boots sit at the shuffled figure. The live file's layout cannot be measured from
outside (`/data` is private to the add-on, and the export vacuums), but the composite index
takes its inserts at 568 series' right edges at once, so its leaf pages are allocated
interleaved across the file, and walking it in key order is random I/O. The 3,415 ms boot
followed, by 13 minutes, a boot whose ANALYZE had just read the same pages into the page
cache.

So the bound was applied, and the cost it was meant to bound was never the scan: it is a
read of every index page, and the page cache and the file's layout decide whether that
takes one second or twelve.

### Statistics are refreshed only where there are none

The boot now runs `PRAGMA optimize=0x03`. Mask `0x02` without `0x10000` selects only a
table with an index that has no `sqlite_stat1` row — a fresh install, or an index a
migration has just created. Debug bit `0x01` makes SQLite return those `ANALYZE`
statements instead of running them. The recorder runs exactly those, with no sampling
bound, and logs one line:

```
recorder: planner stats — SQLite 3.48.0, PRAGMA optimize planned no ANALYZE
recorder: planner stats — SQLite 3.48.0, ran 2/2: ANALYZE "main"."night_charge_ledger"; ANALYZE "main"."lifetime_totals"
recorder: planner stats — SQLite 3.48.0, refresh FAILED while running (database is locked), ran 0/1
```

- **Stale statistics are left alone, because they change no plan.** Every statement that
  reads `samples` has equality on `(sn, metric)`, a range on `ts` alone, or an
  `INDEXED BY`. Each plans identically with no statistics, full statistics, the truncated
  ones and the live database's own row counts — in the tests, and on the copy of the live
  database. A new test counts the `FROM samples` statements in the source, so a new query
  fails until its plan has been checked.
- **Why not SQLite's usual `0x10002`.** `0x10000` adds a 10× size check. `samples` grows
  about 360 k rows a day, so near 160 M rows that check would fire as a full ANALYZE of
  ten times today's indexes, on the boot path, for plans the statistics do not change.
  With statistics present, `PRAGMA optimize` read 2–7 pages on the copy, cold.
- **A failure is reported as one.** Listing can itself need the write lock: SQLite opens a
  write transaction once two tables qualify. The first draft caught that error with nothing
  listed and logged "planned no ANALYZE". The line now names the step that failed and never
  names an ANALYZE that did not complete, and a failed refresh never fails the boot.
- **Not moved to a worker.** ANALYZE is one statement that holds a write transaction for
  its whole run; a concurrent insert gets `database is locked`.

On the live Pi the first 1.156.0 boot should analyze `lifetime_totals` and
`night_charge_ledger` — the only indexed tables that never had statistics, because only
`samples` was ever analyzed — and every later boot should plan no ANALYZE. The truncated
`samples` statistics written since 1.153.0 are kept.

### Verification

- `test/bootPlannerStats.test.ts` boots real recorders against a real database: missing
  statistics are analyzed in full (2,500 rows per SN, not 401); 100×-stale statistics are
  left exactly as found; an ANALYZE that meets a held write lock, and a listing that does,
  are each reported as failures while the boot completes; the line names the linked
  SQLite; every `FROM samples` statement is listed and plans identically across five
  statistics states; a position pin keeps the refresh inside the `analyze` phase.
- `test/darkCoreCoverage.test.ts`: the 1.153.0 test, corrected, now forbids the sampling
  bound and an unconditional ANALYZE on the boot path.
- `scripts/mutate-boot-analyze.mjs`: 11 anchor-asserted mutants, each typechecked, all 11
  killed on a green tree. The three that restore the old cost are also killed with the
  source pins skipped. `mutate-dark-core.mjs` xiii and xiv (the bound, and its order
  before ANALYZE) are retired: the property they pinned was the wrong one.

## 1.162.0

### The reserve write envelope really does have one definition now

1.161.0 raised `RESERVE_WRITE_MAX_PCT` to 90 and updated `clampReserveTarget` and
`setBackupReserveSoc`'s range check — the two sites the v1.133.1 note named. **Four more copies
of the bare `[10, 50]` pair survived it**, found by an adversarial review of the release:

| site | what it gates |
|---|---|
| `nightChargeActuator.ts` apply guard | the live reserve the nightly write is allowed to raise FROM |
| `nightChargeActuator.ts` `restorable` | the baseline the revert is allowed to restore TO |
| `nightChargeActuator.ts` adoption | the baseline a lost-confirmation write may be adopted from |
| `ecoflow/commands.ts` refresh-cloud | the current reserve the cloud-presence refresh re-sends |

**The apply guard and `restorable` are load-bearing as a pair.** While both read 50 the system
was still sound: the apply refused a current reserve above 50, so a baseline above 50 could
never be captured, so `restorable` never had to judge one. Raising **one** of the two opens the
end state this module exists to prevent — apply at 60, capture `priorReservePct` 60, and
`restorable` is false *forever*: the panel holds a raised reserve indefinitely, the house runs
on grid every day, and the ledger records a clean completed night. All four now read the
shared constants, and the suite pins the **pairing** rather than the literals: a range walk
asserts that every reserve the apply will act on is one the revert will restore.

Also fixed: `/api/reserve-floor` rejected an out-of-range `pct` with a message that still named
`[10,50]`, and the stale `[10, 50]` prose in the actuator's safety-posture header.

5 tests and 3 new mutants (7 in `scripts/mutate-device-ceiling.mjs`).

## 1.161.0

### The night-charge write ceiling is 90%, raised from 50%

`ARB_COST_MAX_SOC_PCT` has been set to **90** in the live
options all along, and `ARB_OBJECTIVE` is `cost` — but the actuator's write envelope was capped at
50, which made every value the option's own `int(50,100)` schema allows above 50 **inert**. The
engine asked for `setpointSocPct: 100` on the evening of 2026-09-16 and wrote 50, exactly as it had
been doing. The ceiling is now 90, so the configured target is deliverable.

`clampReserveTarget` and `setBackupReserveSoc`'s range check now share **one** definition of the
envelope (`ecoflow/commands.ts` imports it), closing the two-literal drift the v1.133.1 note called
out.

### A panel that grants less than it was asked is no longer a "forfeited buy"

Raising the ceiling makes a new outcome reachable: the SHP2 accepts the write, raises its reserve,
and settles **below** the target. That matters because the old bound called itself *the device's
documented [10, 50] range* in four places **without citing a document**, and no vendor source on
disk mentions `backupReserveSoc` at all — whether the panel enforces a ceiling of its own is
genuinely **unverified**.

Before this release a short readback was indistinguishable from the 2026-08-16 phantom (a write the
cloud acknowledged and the device ignored): both retries burn, the night ends on `applyFailed`, and
the operator is paged that **"tonight's buy is forfeited"** with the ledger corrected to
`actuated:0` — while the reserve is genuinely raised and the charge is genuinely running. A false
forfeiture is the worst of both worlds.

- A reading strictly between the attempt baseline and the target, still standing after the verify
  dwell, is now adopted as the actuation the device was willing to grant: `targetPct` becomes the
  achieved value (so the arbitrage posture, the revert-settling predicate and the revert readback
  all keep comparing against what the panel actually holds) and `requestedPct` preserves the ask.
- A reserve that did **not** move still takes the phantom path, unchanged. That distinction is one
  comparison wide, so the harness mutates both bounds and requires each to die.
- The log line names the achieved value and says that a repeat at the same number identifies the
  panel's real limit.

The revert is untouched: the prior floor is restored at window close either way.

4 tests and a new committed harness (`scripts/mutate-device-ceiling.mjs`, 4 mutants).

## 1.160.0

### A deferred retry absorbed by a storm gate no longer strands the retry slot

Follow-up to 1.159.0, from a review of the log ring since that release. 1.159.0 made the
deferred-retry budget count by keeping the slot across the timer firing, and released it with
`releaseRetrySlotIfIdle()` when a broadcast ended with no retry armed — but that release sat
only at the **completion tail**, and the broadcast routine returns early in six places before
it can arm anything: not supervised, no Music Assistant targets, the two storm gates, and the
two render failures.

**The leak.** A retry replays the same rung about 30 s later, which is exactly the window
`SAME_LEVEL_GAP_MS` suppresses — so a fired retry meeting the same-level storm gate returned
early and left the slot **held with no timer armed**. A phantom slot is worse than the defect
it came from:

- every later milder deferral logs `keeping the pending <level> retry` against a retry that
  does not exist, so nothing is ever retried again;
- the next same-level failure can reach `giving up after 3` having made **zero** attempts.

**The fix.** `runBroadcastInner` is now a thin wrapper that calls the gated routine inside
`try { … } finally { releaseRetrySlotIfIdle(); }`. Every exit releases an idle slot, including
a throw and any exit added later. The call is idempotent — a no-op whenever a timer is armed —
and `scheduleBroadcastRetry` runs *inside* the routine, so a retry armed by this broadcast is
always already armed by the time either release runs. The tail call is kept: it releases before
the status is persisted, so a persisted snapshot never shows a phantom slot.

Releasing on the way **in** would strip a fired retry of its own budget — the 1.159.0 defect
restored — so the harness mutates the wrapper into that shape too and requires it to die.

2 tests (7 in the file) and 2 new mutants (7 in `scripts/mutate-broadcast-retry.mjs`).

## 1.159.0

### A failing announcement no longer retries forever

On 2026-09-15 the panel's cloud payload froze at 20:40, the critical went audible at 20:44,
and `music_assistant.play_announcement` then returned HTTP 500 ("Server got itself in
trouble") on every attempt for ten minutes. The log shows the same line three times —
`deferred retry 1/3` at 20:47:12, 20:50:16 and 20:53:20 — for a single condition.

**The budget could not count.** The deferred-retry timer cleared `retryLevel` before
re-running the broadcast, and `scheduleBroadcastRetry` only sees a pending slot while that is
set. Every failure therefore started from attempt 0, re-armed at 1, and could never reach the
give-up rung: the announcement was re-attempted roughly every 30 s plus call time for as long
as the service kept failing.

- The slot now survives the timer firing, so the ladder is **1 → 2 → 3 → give up**.
- `releaseRetrySlotIfIdle()` clears it whenever a broadcast ends with no retry armed, so a
  stale level cannot make later milder deferrals "keep-pending" against a retry that no
  longer exists.
- Precedence is unchanged: a milder deferral never supersedes a pending severe retry, and a
  more severe condition still gets a fresh budget.

**Why it is more than noise.** This file's own single-flight comment records that overlapping
`play_announcement` calls are what wedge Music Assistant into exactly these HTTP 500s, so an
uncountable retry can sustain the failure it is retrying.

**Not a duplicate-suppression change.** The SIP re-announce seen at 20:53:26 was a genuine
red → yellow transition, not a replay; `skipSip` behaviour is untouched.

5 tests and a new committed harness (`scripts/mutate-broadcast-retry.mjs`, 5 mutants).

## 1.158.0

### Three notification fixes from the 09-13..15 log audit

A six-lens audit of the log ring (15 agents, every finding adversarially verified) confirmed
four issues. Three are fixed here; the fourth is recorded.

**1. A held collapse on an idle pack no longer pages.** v1.157.0 stopped such a collapse from
spending the self-heal budget and deliberately left the notification. The consequence, measured:
on 2026-09-13 the 21:35 session rebuild worked — the panel was back at 31 msg/min by 21:41 —
and three `[Medium] Device barely reporting` cards pushed anyway at 21:51, each telling the
operator to check the cloud session and power on a pack whose session was healthy. They stood
9 h 13 m to 9 h 38 m, clearing only when the packs woke at 07:04-07:29.

- The rate-floor tick publishes the quorum's own `idleExcluded` set (`setRateFloorIdleHeld`):
  surfaced, electrically idle this tick, and not the alarm-path panel.
- `pushDwellStart` re-bases the 20-minute dwell while an alert's device is in that set, so the
  dwell is re-earned once the device is **active and still starved**. Gating the rising edge on
  idleness alone would only have moved the push to the first active tick, because the dwell is
  measured from when the alert was first seen.
- The card, the latch, the resolve path and the alarm-path panel are unchanged. A collapse that
  never idles still pages at exactly 20 minutes.

**2. The cell-imbalance WARNING tier gets the settle dwell it already had on the way out.**
`vdiff-warn-` was on the resolve-side dwell list and not the push-side one, so three of twenty
pushes in the window were ~3-minute settling excursions. Real home-pool episodes ran 12-37
minutes, so the 5-minute hold costs under 5 minutes of notice. `ems-volt-` is deliberately NOT
added: its single occurrence in the window is unattributed, and a dwell would hide it.

**3. The runtime projection hands off at the floor instead of pushing a false all-clear.**
`forecast-runtime-<SN>` stops being produced the moment the pool touches the reserve floor
(analytics gates it on `cur > reserve`), while `shp2-below-reserve` raises on `<= reserve` —
complements on the same field. The falling edge read that vanish as a recovery: on 2026-09-13
the pool reached the floor at 21:42 and stayed there until 07:55, yet the phone read
*"Resolved: Projected runtime ~0h 12m to reserve"* at 21:47. It now joins `backup-soc-`'s
ownership handoff: the entry retires with no resolve push while the successor is active.

### Recorded, not changed

**The learned-baseline alert family stays suppressed for the life of a held collapse.**
`analytics.ts`'s `starvedSnsForBaseline` reads the raw collapse set, so the 09-13 hold also
blocked that family on three packs for 9 h 30 m. Filtering it to the quorum's active set would
resume raises on a pack whose feed genuinely is low-cadence; that is a policy decision to be backed by
evidence, not a same-day change to an alert path. The consumer is now named in DOCS §2.16.

## 1.157.0

### An idle Core's held rate collapse no longer spends the self-heal budget

On the night of 2026-09-13 the cloud-session self-heal rebuilt a healthy MQTT session
four times, then stood down, and the alarm-path panel's genuine wedges the next evening
each ran on the last heal in the budget.

- **21:31** — the rate collapses of three Cores surfaced while the packs were discharging.
  Surfacing requires the device to be moving power and starved right now.
- **21:35** — a heal restored the session.
- **~21:37** — the packs reached the reserve and went electrically idle, inside the
  five-minute recovery dwell. An idle Core reports about 4.7 msg/min, under the tracker's
  absolute 10 msg/min recovery bar, and `decideCollapseSurfacing` holds a surfaced
  collapse through idleness (the v1.111.0 anti-flap rule). The three collapses stayed
  surfaced until the Cores' rates recovered (logged 07:04–07:29).
- **22:35, 23:35, 00:35, 01:35** — the rate-floor tick handed `evaluateSelfHeal`
  `collapses.length`, so the held, idle Cores kept a three-device quorum. Each heal rebuilt
  a healthy session and changed nothing.
- **02:35** — the rolling cap stood the healer down.
- **09-14 19:59 and 21:42** — the panel's own starvations (both announced as "[Critical]
  Panel data is stale — grid presence unknown", at 19:43 and 21:26) were each healed as
  heal 6 of 6. A wedge with no slot left would have had no rebuild at all.

**The fix: `selfHealQuorum` decides who votes.** A surfaced collapse counts toward the heal
quorum when its device is the alarm-path panel, by identity, or when it is not electrically
idle on this tick. Idleness is the same `isElectricallyIdle` reading the entry gate already
uses, collected per tick in the rate-floor loop. The tick passes the quorum count to
`evaluateSelfHeal` instead of `collapses.length`.

- **Unchanged:** the alert set and its 20-minute push dwell, the latch,
  `decideCollapseSurfacing`, the dwell, cooldown and rolling budget, and the panel
  exception.
- **Visible:** the heal warn line names its members (`[counted: …]`), and its "N devices
  starved" counts those members, not every surfaced collapse. A device leaving the quorum as
  idle logs one info line per edge (`idleExclusionEdges`).
- **Replayed minute by minute** through the real decision functions, the 09-13 night now
  heals once (21:35, four devices) and never stands down. A panel-only wedge with idle
  Cores and a wedge on two Cores that are moving power both still heal on schedule.
- **Accepted trade-off, pinned by a test:** a Core that reads idle for a single tick during
  an active wedge restarts the dwell when that tick drops the count below the quorum. If
  that is ever observed, debounce the idle reading.

**Proof.** 11 tests in `selfHealIdleQuorum.test.ts`, including:

- a replay of the pre-fix wiring that, from device timelines scripted from the log,
  reproduces the logged heal times to the minute (21:35, 22:35, 23:35, 00:35 and 01:35;
  stand-down at 02:35);
- the once-per-edge exclusion log;
- a source pin on the production wiring, including the panel-exception argument.

`scripts/mutate-heal-idle-quorum.mjs` holds 17 mutants.

### Corrections

- **DOCS §2.16** said the v1.108.0 idleness gate meant "the nightly all-idle vendor window
  no longer consumes self-heal budget". That held only for collapses that never surfaced;
  since v1.111.0 a collapse that surfaced while its device was active is held through
  idleness.
- **`alertMonitor.ts`** said the 20-minute push dwell pages only after "the repair has been
  attempted and failed". A collapse held on a Core that went idle after a heal that worked
  still pages; whether it should is left for a separate decision, so the push is unchanged.

## 1.156.0

### The provider's past-hour irradiance is now recorded — and nothing reads it yet

The recorder's irradiance history, `weather/ghi_wm2`, is not realized irradiance.
`recordWeatherGhi` keeps the **first** value ever written for an hour, and the first
weather fetch that contains an hour sees it roughly three to four days ahead
(`forecast_days=4`). The later `past_days` value is Open-Meteo's own estimate once
the hour is over, and it never replaces the first value.

For 2026-09-11, the stored hours 8–15 sum to 3,180 W/m² against 5,296 in the
past-hour values. That ratio is consistent with the forecast-skill hindcast's −40%
"miss" having been the weather forecast's, not the solar model's.

Recorder-backed readers of `ghi_wm2` therefore see forecast irradiance:

- the forecast-skill hindcast, and through it the PV band calibration and the
  night-charge basis gate;
- for days older than the live weather cache:
  - solar-model training;
  - the PV bias correction (the hours of its oldest local day before the cache's first
    UTC midnight, which is the local evening here);
  - soiling (its p90 baseline, and its recent pool of clear days whenever a cloudy week
    pushes that pool back past the cache);
- the backtest.

**This release changes none of them.** Correcting `ghi_wm2` in place would
re-score the 30-day band calibration within the hour. That would move the basis
gate and the P10 band that sizes a supervised reserve write, with no review point.
Instead:

- **Past-hour GHI is captured as a separate series, `weather/ghi_wm2_realized`.**
  - "Realized" means the provider's estimate after the hour, not a measurement.
  - It holds only hours whose whole interval had ended at the fetch's
    `fetchedAt`, which is correct whichever way the provider labels its hourly
    means.
  - Every hour is stored explicitly, with no same-as-previous collapse, and a
    later fetch revises an hour in place.
- **A value the provider did not send is never captured.** `weather.ts` turned a
  missing radiation value into 0 before the recorder saw it, so one gappy response
  would have overwritten a week of captured hours with zeros.
  - The parser, now a pure `openMeteoHours()`, flags the hour as
    `radiationMissing`. The extraction is otherwise exact: a null body still fails the
    fetch and keeps the stale cache, and consumers receive the same values.
  - The capture skips flagged hours.
  - Existing consumers still receive the stand-in 0, exactly as before.
- **Nothing reads it.** A test using the TypeScript parser fails if any file
  outside the recorder references the series, or if anything in the recorder
  other than the capture itself does. The switch has to ship as its own reviewed
  change.
  - The first version of this test stripped comments with a regex, which a `/*`
    inside a `//` comment turned into a blind spot of about 118 lines of
    `index.ts`.
- **The mutation harness restores the tree on Ctrl+C, SIGTERM and SIGHUP**, and refuses to
  start over a leftover mutant. Node's default is to die at once and skip `finally`, which
  could leave the basis-switch mutant in place.
- **It lives under the existing synthetic SN `weather`.** A new SN would be
  seeded into the per-device gap clocks at boot and raise a false "Device
  telemetry gap" six hours later.
- **`past_days=7` sets the capture deadline.** No timezone is requested, so days
  are UTC days, and an hour not captured within about seven of them cannot be
  recovered from this endpoint.
- **Unchanged:** `ghi_wm2` keeps its first-write behaviour, now pinned by value.
  The forecast archive, which shares the existence statements, keeps its
  insert-once semantics.

### Corrections

- **The band calibrator's error basis.** Its documentation said the hindcast
  scored against realized GHI, and so omitted the weather-forecast part of
  day-ahead error. In fact its errors *include* a multi-day forecast component.
  - The effect is not one-directional: it raises the per-day errors and also
    widens the band through `skillFrac`.
  - The source comment (`pvBandScoredErrs`) and DOCS are corrected in place.
- **The weather fetch horizon.** DOCS showed `forecast_days=2`; it has been `4`
  since 1.35.0.
- **Timestamps.** DOCS said Open-Meteo returns local-zone times; with no timezone
  requested it returns GMT.

### What the switch will have to reckon with (not done here)

- **The gate is closed for a different reason.** It stands at 72%, mostly because
  of the seven 08-13..08-19 days, when Core 2 was dark and actuals were about a
  third of prediction.
  - Estimated from an offline reproduction of the calibration, not measured:
    re-scoring on past-hour irradiance alone gives about 76%, still below 78%.
  - By the same arithmetic, those days leaving the 30-day window reopen the gate
    around the 09-14 plan, whether or not this change ships.
- **Opening the gate is the real consequence.** Crossing 78% turns "nothing will
  be charged" into a sized buy, and in supervised mode that means a reserve write.
- **The direction of any single effect depends on the calibrator's regime.**
  While coverage is below 80% the band calibration is saturated, and lower errors
  also lower the coverage threshold.
- **The captured history starts now.** Days before this release was deployed stay
  first-write until they age out of the window.

## 1.155.0

### A dark Core was announced as a broker stall

Since 1.150.0 the recorder's gap ledger has held two kinds of record: a **fleet** gap
(no home device wrote — an MQTT/broker stall, or a restart the alarm was dark across)
and a **per-device** gap (one SN silent past the per-device threshold while the rest of
the fleet kept writing). The alert layer never looked at the difference. A per-device
record carries no `restartSpanning`, so `outageAlerts` rendered it through the
in-process fleet branch — "Telemetry gap — no data for N min … No home-device samples
reached the recorder … an MQTT/broker stall; writes have since resumed". Every clause
was false for it: other devices were writing, nothing was wrong with the broker, and
the record is written at detection, while the device is still dark. The recorder's own
log line (`DEVICE TELEMETRY GAP — <sn> … while other home devices kept reporting`) had
it right; only the push was wrong.

A per-device gap now renders as its own alert:

- **Title** `Device telemetry gap — no data for N min`; **device** the store's display
  name, or the serial when the device map has none. As on every device-scoped alert, the
  push appends the device to the title (`… — Core 2`) and the alerts panel shows it
  beside the title.
- **Detail** names the device and serial, says the other home devices kept reporting,
  and says the gap is measured to detection, so the device may still be silent. Fleet
  sums over that window under-count.
- **Id** `system-outage-device-<SN>-<startMs>[-<tier>]`. Every SN written in one batch
  shares that batch's timestamp as its last sample, and so does the fleet clock, so the
  fleet id `system-outage-<startMs>` could not tell them apart. The `system-outage-`
  prefix is kept on purpose: the lifecycle is still the outage event's (no "Resolved:"
  push, not boot-seeded, never audible), and `familyOf` rolls these up as
  `system-outage-device`, apart from fleet outages.
- The falling-edge evidence gate exempts the id. It names the dark SN, so the gate would
  otherwise judge the alert by the very silence it reports.
- Outage alerts sort by the gap's start. Sorted by id, every `system-outage-device-` id
  came before every fleet id.

Fleet-gap titles, detail and ids are unchanged. Because the id changed, a per-device gap
detected in the 24 h before the update, already pushed under the fleet wording, is
dispatched once more under its new id (outage events are not boot-seeded), through the
normal push gates.

### …and counted as a fleet outage

`outageTracking` counted every record in the ledger, so a per-device gap — hours long by
construction — added its whole silence to `system_outage_total_minutes_24h`, counted in
`system_outage_count_24h` and `system_telemetry_gap_count_24h`, set
`system_outage_last_ended` / `_last_duration_minutes`, and turned
`system_outage_active_24h` on. Those fields now count fleet records only.

Per-device gaps get a count of their own: `system_device_gap_count_24h` on
`/api/ha-state` and the MQTT state topic, with a diagnostic sensor **Device Telemetry
Gaps 24h**. It counts blackouts detected in the last 24 h, not devices dark right now: a
per-device record ends at detection.

`/api/telemetry-gaps` had the same blind spot in its two rollups: `longest_gap_min` was
taken over every record, so one multi-day single-Core record read as a multi-day fleet
blackout. `longest_gap_min` now covers fleet records only, and the endpoint adds
`fleet_gap_count`, `device_gap_count` and `longest_device_gap_min`. `count` is still
every record, matching the `gaps` array it sits beside, and each record's `sn` still
tells the two kinds apart.

### Verification

- `test/deviceGapAlerts.test.ts` drives `outageAlerts`, `outageTracking` and
  `systemOutageFields` with per-device records in the recorder's own shape, and pins the
  rendered title, push title, detail, facts, ids, ordering, event lifecycle, evidence
  gate, counters, `/api/telemetry-gaps` rollups and the discovery sensor.
- `scripts/mutate-device-gap-alerts.mjs`: 20 anchor-asserted mutants, all 20
  killed on a green tree.

## 1.154.0

### Correction to 1.153.0

The 1.153.0 entry below says the boot freeze "was 99.99% one SQL statement". It
was not. The per-phase line it quoted was emitted straight after `ANALYZE`, and the
1.152.0 per-device seed ran after it: another **5,807 ms** on that boot, found from
log timestamps because the instrumentation never covered it. ANALYZE was 9,725 of
~15,533 ms — **62.6%**. It was still the largest phase, and the bound 1.153.0 shipped
(`PRAGMA analysis_limit=400`; ANALYZE took 3,415 ms on the next boot) stands. The blocked window on
1.153.0 was therefore about 9.25 s, not the 3.4 s its line reported. That entry is
left as written; the source comment and the test that repeated the figure are
corrected in place.

### The per-device gap seed, rewritten

1.152.0 seeded the per-device gap clocks from `samples` so that a blackout spanning a
restart would be seen. Its own boot output showed three defects.

- **5.8 s per boot, unmeasured.** `SELECT sn, MAX(ts) … GROUP BY sn` visits every
  entry of the composite index (5,807 and 5,834 ms on the live Pi) and ran after the
  boot-phases line. The seed is now an exact index skip-scan: step through distinct
  SNs, then each SN's distinct metrics, taking `MAX(ts)` per series. Every statement
  is a single index SEARCH, so the cost follows the number of series, not rows.
- **Core 5 was skipped.** The seed excluded `benchSpareSns()`, evaluated before
  `index.ts` had published the roster, so the stale `SPARE_DPU_SNS` literal decided —
  and it still names Core 5, a wired home Core. Only synthetic SNs are skipped now;
  bench spares are seeded and filtered at sweep time by `isBenchSpareSn`, which by
  then reads the live roster. The roster publish in `index.ts` also moved above
  `createRecorder`, so the restart probe's fleet anchor no longer drops Core 5.
- **Every device would read as dark after an outage over 6 h.** A seeded clock is the
  device's last sample, so the first sweep after a long add-on outage would have
  measured the outage itself. A device still on its seeded clock is now charged only
  with dark time the add-on could observe (`seededDeviceDarkMs`): how far its last
  sample trails the fleet's newest before the outage, plus monotonic time since this
  process's first home write. A Core already dark for nine days still carries its
  nine days; the outage belongs to the restart-spanning fleet gap. An NTP step cannot
  manufacture dark time, and a boot clock still behind the seed cannot write a gap
  that ends before it starts.

### Boot timing covers the whole call

The boot-phases line is emitted at the **end** of `createRecorder`, on the monotonic
clock, with `setup`, `seed`, `restart-probe` and `rest` as phases of their own. Tests pin that it is the only boot-phases line, that it follows the seed, and that it is the last statement before `createRecorder` returns.
`index.ts` also logs `createRecorder returned after N ms`, timed from outside; if the
two disagree, part of the call is outside the instrumentation again.

### The SHP2 shadow latch holds until the panel is really moving

On 2026-09-12 the cloud-shadow detector latched and released four times in 87
minutes (04:10–04:20, 04:24–04:30, 05:17–05:28, 05:32–05:37). The latch side is
deliberately slow — five identical payloads and four minutes — but the release side
let go on the first payload that differed. Each gap between windows is exactly the
four-minute re-arm: one refreshed body, which the cloud then replayed. For those minutes the
alarm path read the panel's grid value as live.

Once latched, the panel must now show two distinct new witnesses
(`SHP2_SHADOW_CLEAR_DISTINCT`) before it reads live again. A live panel produces a new
twelve-channel vector on essentially every poll, so a genuine recovery costs about
one extra poll. One refreshed body that the cloud then replays, or a cloud alternating
between two cached bodies, stays one latch with its original onset. The latch side is
unchanged and an unmeasurable poll still releases. The state lives in the store
beside the freshness map, not on the device object `setDeviceList` rebuilds every
60 s.

### "Alarm system is blind" is no longer said while the Cores are reporting

A replayed panel payload has routed into the telemetry-blind CRITICAL since 1.148.0,
as a failed or never-asked panel fetch already did. All three rendered the text
written for the 2026-08-04 outage — the add-on "has received no telemetry" and
"cannot see battery state, grid presence or any device fault" — while the Cores were
still reporting. The title is spoken aloud, and the Cause fact read "unknown".

- `notePollFailed` now carries the panel verdict (`{cause, sns}`), bound to that
  failure: a thrown poll clears it, so a total outage is never described as one stale
  panel.
- When the failure is a panel verdict and at least one other device is still current,
  the alert names the condition — *Panel data is stale — grid presence unknown*,
  *Panel is not answering — grid presence unconfirmed*, or *Panel is offline to the
  cloud — grid presence unconfirmed* — states how many other devices are reporting,
  and says no alarm that depends on the panel can be trusted. "Current" means online,
  a DPU or SHP2 projection, and a quota write within the five-minute stale bound; a bare online flip does not count, and neither does a replaying device or a Core outside the home pool.
- With nothing else current, the original text is used, because it is then true.
- The Cause fact names the verdict either way.
- Id, severity and priority are identical, so escalation and audibility are
  unchanged. Only the words differ.

### Found by this release's adversarial reviews

- **An intervening short boot defeated the outage guard.** The fleet anchor is the
  newest home sample from any device, so a boot of a few minutes in which the others
  wrote — and a failing panel did not — moved it past the earlier outage, and the
  next boot charged that whole outage to the silent device. Every fleet-dark window in
  the gap ledger between a device's last sample and the anchor (restart-spanning and
  in-process; never the device's own per-device records) is now subtracted, as a
  union (`fleetDarkOverlapMs`).
- **The boot-phases test could not see work after the line.** The phases are chained
  from one clock, so they always sum to the total the line reports, and checking that
  proved nothing. The tests now pin the line's position instead, with mutants for a
  duplicate line and for work after it.
- **The seed's cost had no test.** Its text pin was satisfied by a constant. The
  statements are exported as `SEED_SQL`, and each one's `EXPLAIN QUERY PLAN` must be an
  index SEARCH; a `SELECT DISTINCT` mutant dies on it.
- **"Other devices reporting" counted things that are not sight.** A second, shadowed
  SHP2 stamps its quota clock on every replayed poll, and a Core outside the home pool (on the bench or off-panel) reports normally while powering nothing in the house. Neither counts now, and pool membership is roster-aware — the `SPARE_DPU_SNS` literal names a wired Core and not the bench unit.
- **The panel wording made a promise it could not keep.** It called the condition "not
  a total loss of telemetry", and a push cannot be withdrawn if the episode then
  becomes one. The clause is gone; the count of devices still reporting stays.
- **The frozen body reappearing between refreshes now starts the count over.** Refresh
  B, frozen A again, refresh C no longer releases the latch while the cloud is still
  replaying A. A live panel never reproduces its frozen twelve-channel vector.
- **The CI anchor checker read single-quoted anchors only.** 110 of 359 — every anchor not written as a single-quoted literal — were never checked, and one (`mutate-ledger-legibility`
  vi) had been dead since 1.148.0 while CI reported every anchor resolving. All three
  quote styles are checked now, the dead anchor is repointed, and the README states the
  full count.

- **Post-boot silence was never ledgered.** A boot that waited hours for its first
  home write (DNS or cloud down after a power cut) recorded nothing, because the fleet
  detector ignores a zero anchor — and the next boot charged that window to any device
  still on its seeded clock. It is now a fleet gap on both boot paths — including a clock-behind boot, whose deferred restart gap ends exactly where this window begins — measured on the monotonic clock.
- **A panel payload with no readable circuit is no witness.** The projection always
  emits twelve circuit slots, so the "no circuits, fail open" rule could never fire,
  and a body without the per-circuit array latched on three low-entropy scalars. With
  the new reset such a latch could hold a spoken critical indefinitely. It now fails
  open as documented.

A forecast irradiance defect found in the same log review ships separately and
staged, because re-scoring history can reopen the night-charge basis gate.

### Verification

- **2,614 tests** (1.153.0 had 2,579). Both tsconfigs are clean; the doc-claims, secrets
  and add-on config gates pass. 375 mutant anchors resolve across 33 harnesses, now
  counted across every quote style.
- Mutation harnesses, every one run against code identical to what ships:
  - `mutate-dark-core.mjs` — **32/32** (was 14/14)
  - `mutate-blind-shadow.mjs` — **25/25** (new)
  - `mutate-cloud-shadow.mjs` — **13/13**
  - `mutate-telemetry-blind.mjs` — **9/9**
  - `mutate-poll-health-attribution.mjs` — **8/8**
  - `mutate-audit-round2.mjs` — **13/13**
  - `mutate-push-dwell.mjs` — **12/12**
  - `mutate-ledger-legibility.mjs` — **8/8** — including the anchor dead since 1.148.0, repointed
  - `mutate-roster-fallback.mjs` — **4/4**
- Three adversarial review rounds (15, 12 and 6 agents) confirmed ten distinct defects in
  this release's own changes. Nine are fixed here. The tenth — per-device gap records
  rendered as fleet "Telemetry gap" warnings and counted in fleet outage totals, a
  1.150.0 leftover — ships separately with a dedicated per-device alert, because simply
  filtering them would silence the only push a dark Core currently produces.

## 1.153.0

### The boot freeze was 99.99% one SQL statement

v1.152.0 instrumented the boot window rather than guessing at it. The live Pi
answered on the first boot:

```
recorder: boot phases — open 0ms, schema+migrations 1ms, analyze 9725ms (total 9726ms)
```

**9,725 ms of 9,726 ms.** `open` was 0 ms and the entire schema + nine migration
probes took 1 ms. Every add-on boot spent ten seconds inside one `ANALYZE samples`
— and `createRecorder` is a non-async function with no `await`, so for that whole
window there is no HTTP listener, no MQTT ingest, no poll and no alarm evaluation.

The statement's own justifying comment claimed it was *"cheap on a single index —
single-digit ms even at millions of rows"*. It was wrong on both counts it rested
on: `samples` carries **two** indexes now, and the database is ~1.72 GB under an
1825-day retention. A full ANALYZE reads every index entry, so the cost scales with
the table — it was always going to get worse.

- **`PRAGMA analysis_limit=400`**, SQLite's own mechanism, now caps how many rows
  ANALYZE samples per index. Stats stay good enough for plan selection — which is
  all they were ever for — and the scan stops being proportional to table size, so
  this cannot quietly return as the database grows.
- The per-phase instrumentation **stays**. It is how this was found, and it is how
  a regression would be.

Deliberately not done: **deleting** ANALYZE (the planner genuinely needs statistics
on a table this skewed), or **deferring** it off the boot path (it would still block
for ~10 s, just during live operation instead — strictly worse on an alarm path).

`scripts/mutate-dark-core.mjs` — **14/14**. One mutant survived the first run and
the fault was the MUTANT, not the test: it claimed to move the bound after ANALYZE
but its replacement left the pragma textually before it, so it never tested the
ordering it was named for. Corrected to mutate the ANALYZE site, and the test now
also rejects a trailing `analysis_limit` — which would be inert while making the
code read as if the ordering were satisfied.

## 1.152.0

### Two of the three defects in this release are mine, from this morning

A log audit over the 48 h ring — six independent lenses, every finding put to an
adversarial verifier, 24 of 38 refuted — found that two features shipped hours
earlier did not do what their own log lines claimed.

**The v1.151.0 boot pre-warm was inert and logged success anyway.** It fired
`analytics.report('equipmentHealth')` immediately after `listen`, and completed in
**578 ms and 694 ms** on the two boots — against its own comment claiming a
**9,007 ms** cold scan. The request is posted before the store's first `change`
event, so the worker still held its initial `devices: {}`; `allDpus({})` returned
`[]`, both loops were skipped, and `if (dpus.length > 0)` declined to cache. It
warmed nothing, cached nothing, and emitted *"equipment-health pre-warmed"*.

A false-success line in the audit log — the exact defect class this codebase keeps
finding — shipped by the release that was fixing one.

It is **deleted rather than repaired**, because the machinery already existed and
was not checked for: `equipmentHealth` is in `WARM_REPORTS` and the worker's own
`firstWarm` polls every 500 ms and warms as soon as `hasDevices()` is true —
correctly gated on a non-empty snapshot, which is precisely what the pre-warm got
wrong. There was never a first-visitor stall to fix. A second warmer would only
duplicate it and reintroduce the race.

**The v1.150.0 per-device gap sweep was blind to the case it was built for.**
`lastInsertBySn` was created empty at every boot and written only by an in-process
insert from that SN, so a device **already dark when the process starts** never
entered the Map the sweep iterates.

That is not a corner case. The nine-day Core 2 blackout that motivated the sweep
spans restarts by definition, and this add-on booted **eleven times** in the 48 h
window the audit examined. Unseeded, the detector covered only a blackout that
both begins mid-run *and* persists 6 h inside that same process — the narrower,
less dangerous case. It also could never EXTEND a recorded gap across a restart,
so a nine-day blackout would have been ledgered as a ~6 h one.

- The clocks are now **seeded from `SELECT sn, MAX(ts) FROM samples GROUP BY sn`**
  at boot — the per-SN form of the fleet probe already in the same file, and the
  same repair v1.131.0 applied to the sibling msg-rate-floor detector. Synthetic
  SNs and bench spares are excluded (off-cadence, or dark by design), and a failed
  seed **says so**: an unseeded sweep is indistinguishable from a working one.

### Every boot blocks the whole add-on for 9.3–30.2 seconds

Measured on all **eleven** boots in the ring (max 30.151 s). `createRecorder` is a
non-async function with no `await`, so the event loop cannot yield: for that whole
window there is **no HTTP listener, no MQTT ingest, no poll and no alarm
evaluation**. It is 92.5–97.8% of the time from *"serving built UI"* to *"API
listening"*, and nothing is logged inside it.

The leading suspect is the boot-path `ANALYZE samples`, whose justifying comment is
stale on both counts it rests on — *"a single index"* (`samples` now carries two)
and *"single-digit ms even at millions of rows"* (the database is ~1.72 GB under
1825-day retention).

**That is a hypothesis, so this release measures instead of deleting.** Per-phase
timings (`open`, `schema+migrations`, `analyze`) now emit one line per boot. If
`analyze` dominates, the stale comment is the defect and ANALYZE becomes
conditional — it is a planner-stats refresh, not a correctness requirement. If
`open` dominates it is WAL recovery or cache warm-up and ANALYZE is innocent.
Deleting a query that keeps the planner honest on a table this size, on a
life-safety system, on a guess, is not a trade worth making.

*What the audit also established, and is NOT a defect: a threshold crossed inside
the blind window is announced LATE, not lost — `batterySocAlarm` persists its
armed state and tests crossings by LEVEL, verified across the ring's longest
outage.*

`scripts/mutate-dark-core.mjs` — **12/12**. Two survived the first run, both
because an assertion matched text the mutant left in place: one kept the "seeding
FAILED" string while never emitting it, the other dropped the exclusion from the
SQL while leaving `.all(...restartGapExcludedSns)` on the next line. Both are now
pinned to the live call and the live WHERE clause.

## 1.151.0

### One report was re-deriving two months of history every ten minutes

Measured on the live deployment, not inferred: `/api/equipment-health` cost
**9,007 ms cold** against **14 ms warm**. Every other analytics endpoint measured
**10–25 ms**. It was the only expensive report in the set.

`computeEquipmentHealth` pulled a **sixty-day** window of three metrics per MPPT
string per DPU, plus two more per DPU for inverter standby — **40 metric-series
of 60 days each** — and `MPPT_EFF_TTL_MS` is **10 minutes**. So it re-scanned two
months of samples every ten minutes, forever. The query was already indexed
(`idx_samples_sn_metric_ts`) and already bucketed at 5 minutes; it was simply
enormous. A 60-day *baseline* is by definition slow-moving, and re-deriving it at
a 10-minute cadence was the defect.

Because the analytics worker is single-threaded, that cost is a **head-of-line
block**: six concurrent requests were observed completing together at ~20.2 s,
and the affected endpoints are exactly the ones the dashboard fetches on load.

**This is not a threading problem, and the measurement says so.** The host is a
4-core Pi at **load average 0.22** with **98.8% idle**. Threads address
contention; there was none. The five other requests in that burst were not
computing for 20 seconds — they were *waiting* on one slow one. Adding worker
threads would have bought a second SQLite connection per thread against a 1.72 GB
database, duplicated heap on a host already at 3.7 GB used, and cross-thread cache
coherence — new failure surface on a life-safety system, to route around a single
bad query instead of fixing it.

- **The 60-day series is now cached and topped up incrementally.** Only the new
  tail is queried per recompute — measured in test at a **>100× reduction** in
  queried span.
- **Boot pre-warm.** The cold cost used to land on whoever opened the UI first
  after a restart, which is every deploy and the host's daily maintenance bounce.
  Fire-and-forget after `listen`, so it never delays the port or takes the process
  down.

### Why incremental is safe here

`queryMulti` buckets on `CAST((ts / bucketMs) AS INTEGER) * bucketMs` — aligned
to **absolute epoch boundaries**. A given bucket therefore carries the same
`bucket_ts` whenever it is computed, and only the **trailing** bucket can still
gain samples. Re-fetching from one bucket before the last fetch and splicing is
byte-identical to a full re-query, which is what makes this a pure performance
change rather than a behaviour change.

The baseline is deliberately **not** re-expressed as a time slice: callers take
the earliest 30% of *samples* (`Math.floor(series.length * 0.3)`), which is not a
time range once the series has gaps. Caching the whole series and letting the
existing arithmetic run over it unchanged preserves that exactly.

`scripts/mutate-eq-health-cache.mjs` — **7/7 killed**. Three survived the first
run and each exposed a real gap: a mutant that never refreshes the cache (invisible
until a *third* call), one that drops the metric list from the cache key (invisible
until two different metric sets hit one device), and one that makes
`computeEquipmentHealth` bypass the helper entirely (invisible while the tests only
called the helper directly — a helper being correct proves nothing if the
production call site does not use it).

A caching bug here would not crash. It would produce a slightly wrong efficiency
baseline feeding an MPPT **drift** figure whose whole purpose is detecting slow
degradation — reading as exactly the thing the report exists to find.

## 1.150.0

### A third of the fleet went dark for nine days and nothing said so

Core 2 (`Y711XXX00XXX0002`) recorded **zero samples of every metric from
2026-08-11 to 2026-08-19**. No log line, no alert, no telemetry-gap record.

The gap detector sets `sawHomeInsert` on **any** non-bench home SN, so Cores 1
and 3 writing normally reset the fleet clock on every batch. A single-core
blackout is invisible to it *by construction* — and a dark core writes nothing,
so a check driven by its own inserts could never fire either.

It surfaced six weeks later, from a forecast table, only as a second-order
effect: fleet PV sums taken across that window returned **32%** of true
production (measured against the SHP2's own daily register), the phantom
"forecast misses" saturated the PV band calibrator, and the **night-charge basis
gate closed**. The system's own answer to "is telemetry healthy?" was yes
throughout.

- **A per-device staleness sweep**, driven by *any* home write rather than the
  silent device's own. 6 h threshold — far above a routine cloud-session drop,
  far below nine days. One record per blackout, not one per batch. Bench spares
  exempt (they are dark by design). The gap record carries the `sn` and a
  distinct log stem: the fleet wording would be a lie, since home samples were
  arriving the whole time.

### The durable ledger could write a deflated PV total, permanently

`index.ts`'s night-charge ledger summed `pv_total` over the roster with **no
coverage gate at all**. Its output is written into the never-pruned ledger as
`actual_pv_kwh`, feeding `pv_err_frac` / `pv_in_band` (readiness band coverage)
and, through `buy_err_kwh`, the **HARD under-buy safety criterion**.

A skill-report error ages out of a 30-day window. A bad ledger row is durable
safety evidence and does not.

- Gated on `PV_LEDGER_MIN_CORE_COVERAGE = 0.9`, mirroring the existing
  `GRID_HOME_MIN_COVERAGE` precedent rather than inventing a second convention.
- Reduced with **MIN across cores, never a mean** — one dark core in three
  averages to a healthy-looking 0.67 while the total is a third short.
- Below the floor the column records **null**, and says so in the log.

### A day nobody measured was reported as covered

`coreCoverageByDay` initialises `covered = true` and the only write to `false`
lives inside the loop body that `skipBeforeJoin`'s `continue` bypasses. When
every core was skipped, the loop never ran, nothing set it false, and a day with
full daylight and **not one evaluated core** was published as covered — with
`worstSn`/`worstFrac` null, so the row carried no hint either.

Absence read as success, inside the gate that exists to catch exactly that.

### The recorder heartbeat was half the incident window

`recorder: N samples in last 60s` fired **59.34 times/hour**: 3,084 of 5,965
lines in the live ring (51.8%) and 426 KB of 938 KB (45.7%). With v1.148.0's
poll-summary fix live it became **67.0% of everything that remained** — the
single largest log source on the deployment.

v1.143.0 demoted it to the debug channel. **That bought nothing, measured:**
`LOG_LEVEL=debug` is standing and pino writes every level to stdout, which the
ring captures — 1,274 of those lines sit in the ring at `"level":20` right now.
The default 100-line log view spanned a median of **46.3 minutes** with this
line and **81.0 minutes** without it.

Level is not emission. Now one distribution per 30 windows (~2/h instead of
~59.4/h), reporting mean, peak burst, and how many windows had activity — so a
total of zero stays distinguishable from the summary not having fired.

### Held back deliberately, and why

- **The retroactive membership filter is NOT fixed here.** `computeForecastSkill`
  resolves the roster once at report time and applies it to 30 days of history,
  so Core 3 — a home-pool core through 08-19 with 18.2–22.8 kWh/day **sitting in
  the recorder** — is excluded from those days purely because it is on the bench
  today. Correcting it nulls the eight bad days, which reopens the basis gate
  *and* narrows the published band **3.5×** in one step. The artifact ages out of
  the 30-day window on its own; the fix belongs after that, measured against a
  clean baseline rather than layered on top of a live distortion.
- **Robustifying the band quantile was tested and rejected.** Against the live 29
  errors: median → 66%, 20% trimmed mean → 66%, median+MAD → 69%, P80-of-clean
  → 66% — every one *worse* than the current 72%. Coverage counts errors under
  `producedHalfFrac × bandCal`; the quantile only sets `bandCal`, and a smaller
  quantile floor-pins it at 0.4 and collapses the threshold. The intuitive fix is
  a regression in a life-safety gate.
- **`chronicNoiseSilenced` (Rule 3) is left inert on purpose.** Its numerator
  counts long **clears**, not long **active** time, so a genuinely standing
  chronic alert scores 0.0 and the longer it stands the further it is from
  firing. Repairing it makes an alarm-**suppression** rule fire more, which is
  the unsafe direction — a policy decision, not a maintenance one.

`scripts/mutate-dark-core.mjs` — **9/9 mutants killed**, including one that
deletes the sweep, one that averages per-core coverage instead of minimising it,
and one that restores the per-minute heartbeat by changing the comparison while
leaving the constant intact (which survived the first run and forced the test to
pin the live branch rather than the constant). `mutate-push-dwell.mjs`'s
heartbeat anchor was **repointed, not deleted** — the property it protects
outlived the line it was written against.

## 1.149.0

### Six documented claims had quietly stopped being true

A documentation freshness pass, which turned up two correctness defects in the
normative reference and one in an engine.

**`DOCS.md` stated the night-charge basis gate as `bandCoverageFrac ≥ 0.9`. It is
`0.78`.** Wrong by twelve points, in the file that is the reference for the value.
The way it survived is the finding: `docs/PERFORMANCE.md` **identified and corrected
this exact error on 2026-09-06** — in its own text, about its own prior snapshot —
and nobody touched `DOCS.md`, which the correction had been measured against. A
correction applied to one document is not applied to the codebase. Both places now
read the named constant (`BASIS_MIN_BAND_COVERAGE`, `nightChargeAdvisor.ts:74`).

`DOCS.md` also listed two of `poll_health`'s three verdict reasons; v1.148.0's
`shp2-content-frozen` was missing. `basisBlockedBy` was undocumented.

### `bandSigmaCal = 1` meant five different things

The band calibrator is **shrink-only** — `Math.min(1, Math.max(PV_BAND_CAL_FLOOR,
realized / produced))`. It can narrow a band that proves too wide; it has no
authority to widen one that proves too narrow. So a published `1` is emitted when
the calibration is **active and saturated** (band too narrow, nothing more it can
do), when it **never engaged** for want of scored days — the real v1.23.0 defect,
which sat pinned at exactly 1 in production — when the ratio lands on 1, when an
operator override happens to be 1, and, in the durable ledger column, when there
was **no probabilistic forecast at all** and the code wrote `?? 1`.

States one and two are opposites. They published the same number.

This was not found by reading code. It was found by refreshing a table: the live
value had moved from 0.50 to 1 while realized error went 0.256 → 0.657 and band
coverage fell 84% → 72%, closing the advisor's basis gate. **The engine is
currently producing no night-charge plan at all** for that reason. Five days
earlier `PERFORMANCE.md` had inspected this same field and pronounced it healthy —
it checked whether the value was pinned at the *floor*, and never considered the
ceiling.

- **`bandSigmaCalBasis`** now publishes which of the five states produced the
  number (`operator-override` / `shrunk` / `floor-pinned` / `saturated` /
  `uncalibrated`) — the same companion-field shape as `strikesMeasurable` and
  `underBuyMeasurable`.
- **The ledger writes `null`, not `1`,** when there is no forecast to calibrate
  against. Filing "no forecast" as "calibration neutral" in a durable column is
  unrecoverable after the fact.
- `scripts/mutate-band-cal-basis.mjs` — **7/7 mutants killed**, including one that
  collapses `saturated` back into `uncalibrated` and one that restores the `?? 1`.

### A mechanism for the README, because a number in prose holds nothing

Every counted claim in `README.md` had drifted: **~2,380 tests** against 2,562,
**18 harnesses** against 30, **100+ anchors** against 203, **~9,100** DOCS.md lines
against 9,960, and *"CodeQL runs as GitHub default setup, no workflow file"* beside
a committed `codeql.yml`. None of them failed anything.

The worst was a whole paragraph explaining that `scripts/check-npm-audit.mjs`
exists because GitHub's alerting returns empty on a private personal repository.
That was **true when written**. The repository is public now, both endpoints return
real data, and nothing re-checked the claim when the world changed under it. The
script's real justification survives the correction and is now stated instead:
**GitHub alerts notify, they do not block a merge.**

`scripts/check-doc-claims.mjs` runs in CI and fails on any of these drifting. It
has **no skip path** — a claim it cannot evaluate is a failure, because a doc
checker that quietly waives what it cannot compute is one more instance of the
defect it exists to catch. The test count is passed in from the job that actually
ran the suite; without it the script runs the suite rather than waive the claim.

### `docs/PERFORMANCE.md` refreshed against the live v1.148.0 deployment

Data-as-of **2026-09-11 08:56 MST**. Beyond the band-calibration inversion above:

- **The load over-forecast signature resolved on its own.** The prior snapshot
  recorded 19–39 kWh of one-directional over-forecast on five consecutive nights
  and **declined to fit a correction to it**. The current sample alternates sign at
  a fraction of the magnitude (`loadMae` 0.178 → 0.149). Had the transient been
  corrected blindly, the correction would now push an unbiased forecast in the
  **unsafe** direction.
- **`strikesMeasurable` went 0 → 1**, so `activeStrikes: 0` is now a real zero
  rather than an inability to count — the first item in that family to resolve,
  and it resolved by the measurement becoming possible.
- **Two band-coverage numbers now disagree and both are correct** (72% on the
  probabilistic route, 83.3% on the readiness gate) because they reduce different
  populations. The operational result inverts the prior snapshot: the readiness
  gate's band criterion came *inside* its target in the same window the advisor's
  basis gate *closed*.
- **The readiness gate now has two independent blockers.** The under-buy criterion
  is still structurally unreachable, and no further nights can accrue because the
  advisor is not planning.
- Delivery exceeds the sized buy by **48–55% on every actuated night** (~+10 kWh)
  against a criterion requiring bias in [0, 5] kWh — formally unmeasured, because
  those nights are exempted by a *different* criterion's exemption.
- The Core 3 voltage cluster has left the head of the 7-day subject list; the head
  is now the `msg-rate-floor` telemetry family across three DPUs.

`docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md` amended for v1.148.0–v1.149.0, including a
design-level consequence not in the original: **I13's evidence supply runs through
I6**, so a basis-gate closure is not "no buy tonight", it is a pause on the
mechanism that would ever earn `auto`.

## 1.148.0

### The night-charge engine declined to plan, and said nothing about why

On 2026-09-10 the plan came back null and the backup pool sat at its **16% reserve
floor from 22:36 to 07:50** — 9 h 13 m one grid failure from empty, carrying about
14.7 kWh of a 92.16 kWh pool, recovering on morning solar. Eight hourly
*"AT RESERVE FLOOR"* runway lines went by.

The reason appeared **nowhere**: not in the log, not on the plan object, not in
the evening advisory, not on the dashboard. `basisComplete` is a four-way AND and
reports one boolean. Three of its gates passed; PV band coverage missed by six
points, 72% against a 78% floor. Reconstructing that took an hour of live probing
against a system that already knew the answer.

`basisBlockedBy` now names the failing gate, and it reaches the 21:30 notification
and the spoken advisory — which is where an operator actually meets the decision,
not an API field. The floor is a named constant, unchanged at 0.78: naming a
threshold must not move it, and the write gate in `nightChargeGate` accepts
realized coverage in [0.78, 0.92], so hand-widening here would silently move that
too. A mutant pins the value.

★ **This gate can latch.** `bandCal` is shrink-only, so once realized error
exceeds the published band it pins at 1.0, the threshold collapses to the raw
band, and coverage is mathematically forced under 80%. It recovers only if the raw
sigma inputs grow or the weather eases. That is a deliberate fail-safe, not a bug
— but it makes a miss a **state**, not a blip, and the code now says so. Whether a
six-point coverage miss is worth a night at the reserve floor is a policy question
and remains yours.

### Two holes in v1.142.0's own cloud-shadow fix

**A shadow moved no gate.** v1.142.0 taught the *consumers* to distrust a replayed
payload — `computeHomeGridWatts` and `computeShp2GridConnected` both treat one as
offline — and left every *gate* untouched. Measured across both live firings:
`poll_health` stayed `ok`, `/api/health` returned `blind:false`, and `notePollOk`
ran on every shadowed poll so the blind clock never aged. The diagnostic sensor
moved to 240 and no verdict moved at all. `pollHealthVerdict` now has a third
reason, `shp2-content-frozen`, ordered **last** so that a fetch which actually
failed or never happened names itself rather than being described as frozen.

**The latch was in-memory, so every restart disarmed the fail-safe.** Re-arming
costs five consecutive identical payloads *and* four minutes. Measured: a freshly
booted process published `grid_power_home = 7618 W` beside
`shp2_payload_frozen = 0` — 7,618 being the exact value the previous process had
already declared a stale shadow two minutes earlier. Roughly 60–90 seconds of a
7.6 kW ghost on the alarm path, and in `resolveGridBackstop` `importLive` is the
one backstop term exempt from both `poolDischargingAtFloor` and `floorWithoutFlow`,
so a frozen positive reading disables the guards that would catch it. This is the
v1.140.0 restart door, one file over.

The witness is now persisted — and **`firstSeenMs` is re-stamped at rehydrate**.
Carrying it would let the duration half of the test be satisfied by history, so a
single matching poll after any gap would latch stale immediately. That fails safe,
but it is a nuisance-alarm path: at the reserve floor it removes backstopping and
can escalate a benign grid-up low-SoC to critical. Only the witness string is
written; the clock and count restart by design, and a mutant pins each.

### Correction: the log-hygiene campaign cost reach rather than buying it

v1.143.0 and v1.145.0 claimed forensic reach. **Measured, they cost it:** volume
+52% (12,961 → 19,699 bytes/h), reach ×0.65, and the default `ha apps logs`
100-line buffer now spans 44 minutes instead of 68.

The level demotions bought **zero bytes**. `LOG_LEVEL=debug` is the standing
option on this install, pino writes every level to stdout, and the ring captures
stdout — emission rate and per-line size were unchanged to three significant
figures. **Level is not emission.** I recorded that `LOG_LEVEL=debug` was standing
in the v1.144.0 notes and then shipped two releases whose byte claim required it
to be false. The INFO-channel win was real and is unaffected: fleet-status still
collapses 98 ticks to 16 hourly anchors with zero false changes.

The actual regression was v1.144.0's own poll-duration ungating — correct in
itself, then emitted 60 times an hour: **1,058 lines in 16.4 h, 32.5% of all log
bytes and 88.3% of INFO lines.** It is now a periodic distribution
(`p50/p95/max` per 30 polls, ~one line per 30 min) instead of a line per poll.
`(recovered)` and `poll slow:` are untouched — they are per-event signals an
operator greps for, and both obvious shortcuts are traps: a blanket demote
silences `poll slow:`, and `startsWith('poll ok in')` also matches `(recovered)`.

The remaining large stream is the recorder heartbeat at 59.4/h. Not touched here:
the same lesson applies, so it needs an emission-count change rather than another
demotion, and that deserves its own release.

### Also

- The `UNMEASURED` calibration line told the operator to look at a route that
  returns **404**. It now names the real path and field.
- `/api/health` resolved the panel with a raw `find()` rather than `findShp2()`,
  which v1.129.0 pinned to the lowest SN precisely so every singleton path is
  consistently wrong in the same way. The equivalent in `mqttDiscovery` is
  annotated rather than half-fixed — that whole block wants one pass.
- The HA broker reconnect was **30 s** against the broker's own ~10 s recovery.
  When Mosquitto auto-updated 7.1.0 → 7.1.1, all 115 entities were unavailable for
  30.03 s while a non-ecoflow client on the same broker recovered in 10.14 s —
  19.9 s of that was this knob. Now 5 s, matching the sibling client.

`scripts/mutate-audit-round2.mjs` — 13 mutants, 13 killed. One survived the first
run: my tests asserted the persistence methods *existed* without checking anything
called them. Replaced with a test that drives two `SnapshotStore` instances across
a simulated restart and asserts the re-stamp.

## 1.147.0

### The last three vanish-on-empty sections

v1.131.1 rejected this pattern in `AdvancedInsightsCard` and said exactly why:
*"a blank row reads as a healthy one. This detector published nothing for its
entire life and looked fine doing it."* Three sections still took the vanish path
— charge-curve fingerprint drift, internal-resistance trend, and the
ambient-coupled thermal forecast. A detector that **cannot** produce a value
looked identical to one that was never enabled, on the screen a human reads.

**The reason is not invented.** Two of the three reports already publish a
per-item `status` computed server-side, and `insufficient-cadence` carries an
explicit comment saying it exists *"so the UI stops showing a perpetual spinner
for a measurement that can't complete"*. The UI was discarding the exact field
that had been added for it — and hiding the section outright is worse than the
spinner it was meant to replace: the measurement cannot complete **and** nothing
says so.

Each section now renders whenever its report exists, and states which empty it is:

| section | now says |
|---|---|
| charge-curve | building the baseline vs no matching SoC checkpoints yet |
| internal resistance | **will not converge at the current poll cadence** vs still accumulating |
| ambient thermal | no temperature pairs recorded vs no fit converged |

The ambient report publishes no `status`, so its reason is derived from what it
does carry — samples and fit quality. The empty states are `text-muted`: an
absence renders neutral, never the healthy colour.

`scripts/mutate-insights-empty.mjs` — 6 mutants, 6 killed. Two survived the first
run, both the same weakness this project keeps hitting: assertions that matched
text the mutant left in place while killing the branch that used it. One now pins
the live ternary rather than the literal; the other checks the empty-state div
itself rather than "text-muted appears somewhere in the section".

## 1.146.0

### A lock-step comment that had failed three times is now a test

`web/src/shp2Membership.ts` is a hand-maintained literal copy of the server
module — a deliberate choice, since the React UI and the Lit HACS cards have
different module graphs. Its own header has said *"if the contract changes,
update both files in lock-step"* since v0.9.75.

It was **three server revisions behind**. The server has unioned across every
panel since v1.129.0 — one line that release called *"the largest lever on the
second-SHP2 problem"* — while the mirror still took the first panel via a single
`find`. With a second SHP2 present, every DPU wired to it fell out of the
connected set, so `isShp2Connected` excluded it and **half the plant silently
vanished from `EnergyFlow`'s fleet totals and `ThermalPanel`** — on the screens a
human actually reads.

The mirror now unions. More usefully, a comment demanding lock-step has been
replaced by something that enforces it: both files export pure functions, and the
web module's only import is `import type`, which is erased at runtime — so a
server test imports **both real implementations** and runs them side by side over
shared fixtures, including the two-panel case that exposed the drift. The suite
also pins the resulting VALUE, because a parity test alone would pass if both
sides were broken in the same way.

### A ratio needs the same population on both sides

Two fleet roll-ups filtered numerator and denominator independently:

- `ThermalPanel.tsx` accumulated `fullMah` and `designMah` under separate
  `!= null` guards.
- `DegradationCard.tsx` called `sumDefined` over the unfiltered pack list twice.

Either way a pack reporting its design capacity but not its current one landed in
the denominator alone, and the UI rendered degradation that did not exist. Both
are pair-gated now. The server's per-pack degradation already gated this way; only
the roll-ups did not.

### Also

An absent degradation report was handed to the TUI as
`{ generatedAt: Date.now(), … }` — stamping a report that does not exist with the
current time, making it indistinguishable from one computed that instant. Now `0`.
Inert today, because no Plant screen reads `data.degradation`, which is precisely
why it would have been believed the first time one did.

`scripts/mutate-web-parity.mjs` — 7 mutants, 7 killed, including one that drifts
the mirror straight back to the single `find`.

### The anchor checker could not see outside `server/`

Found while adding that harness. `check-mutant-anchors.mjs` — the CI gate that
catches mutants whose source anchor has moved — resolved only
`resolve(SERVER, '…')`. Any harness targeting a file elsewhere was **silently
uncounted**: it reported 5 of the new harness's 6 anchors unresolvable while the
harness itself ran all 7 cleanly.

That is this project's own recurring defect applied to its meta-tooling. A guard
that cannot see part of the domain it claims to cover reads exactly like a guard
finding nothing wrong — and this one is the guard for every other guard.

It now resolves both bases, and an unreadable TARGET PATH is reported as such
rather than presenting as "every anchor in this harness is dead", which would send
the reader after the anchors instead of the path. Coverage went from 183 anchors
across 26 harnesses to **189 across 27** — the difference is what it had been
skipping.

## 1.145.0

### The log ring is the incident window, and a fifth of it said nothing

The add-on log reaches roughly **53 hours**. Bytes spent restating unchanged state
are hours of history not available during an incident — and that is not a
hypothetical here: an SHP2 question in this project could not be settled because
the window had already rolled past it.

Measured over 53.1 h: the 10-minute `fleet-status` dump emitted **314 lines
carrying exactly one distinct body** once the per-device message counters and the
device-list age are normalised away. Over a fifth of the whole log. Its charter —
*"which device stopped reporting and when, one grep away"* — is better served now
by `msg-rate-floor`, which named 25 collapses with their rates and learned
baselines in the same window; and the dump cannot answer "when" across a restart
anyway, because its counters reset with the process.

It now emits at INFO when the fleet state **changes**, plus one hourly anchor so
an operator can still see polling is happening at all. The cadence stays, at
debug. Roughly 6 INFO lines instead of 314.

The signature deliberately **excludes** the message counters and the list age.
Those move every tick, so including them would make every dump a "change" and
silently restore the old behaviour while still looking correct. There is a mutant
for exactly that.

Also: `solar-model` emitted 109 lines with **54 exact consecutive repeats** and now
emits on change; the standing-failure heartbeat went hourly → daily, since it
reports a permanent, settled product-class limit.

**Not done, deliberately:** Node's `ExperimentalWarning` for `node:sqlite` is 42
non-JSON lines and could be silenced with `--no-warnings=ExperimentalWarning`.
That would hide every *future* experimental-API warning to save under 1% of the
log. The `startswith('{')` guard that log aggregation needs is documented instead.

### A device that disappears from the device list

It kept its last `online` value forever with nothing logged, so "says online but
has been gone for hours" was indistinguishable from a healthy device. There is now
one breadcrumb per disappearance naming it.

Deliberately **only** a breadcrumb. Marking an absent device offline would invert
a cloud-side list glitch into a device alarm, which is the wrong direction on a
life-safety system. Its state stays frozen and the log says so.

### Absence on the render surface

The same doctrine as the evidence gates of v1.138.0–v1.144.0, one layer out. A
screen that paints an unknown **green** is making a claim the data does not
support, on the layer a human actually reads.

- **A pack that reported nothing rendered `NORMAL`.** Every fault term in the TUI
  generator screen is `x != null && <test>`, so an all-null pack scored false on
  all three and came out green. It now renders `NO DATA`.
- **An absent MPPT error code rendered green `OK`.** `(code ?? 0) === 0` collapsed
  *no error* and *no reading* into the same cell.
- **The BUS screen showed no staleness at all** — `deviceQuality` was computed and
  never rendered. It was the only Plant screen without one, while its liveness tick
  reads `snap.generatedAt`, which advances whether or not the SHP2 answered.
- **A silent DPU was averaged in as a 0% pack.** Four Cores at 80% with one silent
  read as 64% — a number no pack holds.
- A `—` tile painted `text-ok`, and an empty-state that claimed "every pack" from a
  list computed over online DPUs only.

### Also

The MQTT `resubscribe: true` dependency is now pinned explicitly. This app's own
re-subscribe loop is dead code on a reconnect — the `subscribed` set is never
cleared on close — so correctness rests entirely on mqtt.js re-issuing the
subscriptions by **default**. A default is not a contract, and the symptom of a
flip would be a silently one-way connection on the alarm path with the connect log
still reading healthy.

`scripts/mutate-log-reach.mjs` — 12 mutants, 12 killed.

## 1.144.0

### F7–F12: making inferred state observable, and two deliberate non-changes

The last six items of the 2026-09-09 log audit. Most are small; what they share
is that each makes something **observable that was previously inferred**, and the
failure mode of an observability fix is silent by construction — nothing breaks,
the line simply stops appearing, and the next auditor is back to guessing.

**Self-heal's alarm-critical exception now resolves the panel by IDENTITY.** It
used `findShp2`, which requires a hydrated `projection` — and a projection exists
only after a *successful* quota fetch. So on a restart while the panel is
cloud-dark it returned undefined and the exception was disarmed, which is exactly
when a human would be restarting the add-on. That matters more here than almost
anywhere: replaying the quorum gate against the observed 52.5-hour window
*without* this exception yields **zero of the six heals that actually fired**. It
is the only route self-heal has to the SHP2. Same rule v1.140.0 established for
`pollHealthVerdict`, and it also stops `findShp2` pinning the lowest-serial panel
when a second one is present.

**Poll recovery and duration are properties of the poll.** Both were still gated
on an empty failure set — and four accessory devices fail `/quota/all` on every
poll by design, so `grep -c 'poll ok in'` returned **0** across a 52.5-hour log
that was running at debug level. Two costs: no poll-duration distribution below
the slow threshold is obtainable at all, and after the single total poll failure
in that window there was no line anywhere saying polling had recovered. v1.120.0
ungated the slow-poll line for precisely this reason and left these two behind.

**`/api/health` now carries the poll verdict** and the cloud-shadow duration.
`telemetryBlind`'s own docstring frames the whole feature around this endpoint
having reported healthy while the add-on held zero telemetry, and says guard 1
"makes /api/health honest" — but v1.140.0 published the verdict only to MQTT.
During a panel-dark window shorter than the five-minute staleness threshold,
which is the shape of every such window in the record, a watchdog polling this
endpoint still got a clean bill of health.

**The buy de-bias now reports its basis.** A factor of `1.000` read as "measured,
and there is no bias" when it actually means "could not measure": the learner's
eligibility filter requires `!(cushion_shortfall === 1)` and that flag is 1 on
every ledger row, so it selects zero rows and returns the floor. The "calibrated
×N" line only ever fires on a measured result, so a learner that can never
measure said nothing at all — while delivered/planned ran **1.44–1.55×** on every
actuated-and-scored night. This does not unpin the flag (that is set from a
grid-blind whole-house island trough and v1.125.0's re-scope did not clear it);
it ends the silence.

**Housekeeping.** The cleared-alert ledger rehydrated at exactly 1500 on all ten
boots — which is the cap, recognisable as saturation only if you happen to know
it — so it now states the oldest retained record's age and says plainly when it
is dropping rows. The published DB snapshot is named once at boot with its size
and age: 1.72 GB sat in `/share` for four days riding along in every nightly
backup with nothing outside the web UI ever mentioning it. The broker username is
truncated in the connect log; the password was correctly never logged, and this
is the other half of the same credential in a file that gets pasted into vendor
tickets. And `shp2-below-reserve` now says **why** it is lit when the night-charge
plan itself raised the floor — measured median 7.4 h, longest 11.3 h across 45
rises, reading like a fault throughout a fill the add-on commanded.

### Two items were investigated and deliberately NOT changed

Both are pinned in source and by test, so they are not quietly reversed from the
same evidence that prompted them.

**F7 — the self-heal quorum of 2 stays.** A lone non-alarm-path device cannot
trigger a session rebuild; Core 2 ran 133 minutes at ~3 msg/min with budget free.
Three reasons to leave it. REST refreshed Core 2 every 60 s throughout, so real
resolution loss was ~1 s → ~20 s and the operator was notified at both edges.
Every ~60 s heal restoration in the record cured a *multi*-device wedge — a wedge
confined to one device while three others stream normally is evidence the session
is healthy. And the budget is **shared** with the alarm-critical exception, which
reached 5 of 6 on 2026-09-09: solo-Core heals could have starved the SHP2 heal
that fired at 04:31:23.

**F12.4 — `vdiff-crit` was reported as having a 0 ms debounce. It does not.**
`pushDebounceMsFor` gives the family `SETTLE_PUSH_DEBOUNCE_MS`, and the 0 ms
branch applies only to *escalations* — `isAlertEscalation` requires a prior
notified severity of lower rank, and `vdiff-warn` is a different id, so there is
no escalation path within the family at all. Live telemetry: rise 77, short
clears **1**, median == longest == 9.0 min. The two 8-minute transients that
reached the phone had legitimately cleared a five-minute gate, on a pack with a
confirmed defect. Raising it further would delay a genuine critical.

### Also

`scripts/mutate-audit-f7-f12.mjs` — 13 mutants, 13 killed. Three survived the
first run, all for the same reason: the assertions were source scans matching
text the mutant left in place while killing the branch that used it. The reserve
alert is now driven through `computeAlerts` instead of grepped, and the other two
pin the condition rather than the message. **The run before that reported 13/13
against a red tree** — the trap recorded one release ago, hit again.

## 1.143.0

### 84% of every phone push was one family that repairs itself

Over 52.5 hours the operator received 50 pushes. **42 of them were
`msg-rate-floor`** — 25 rise/resolve episodes, of which **23 lasted under 30
minutes, median 9.0 minutes, shortest 15 seconds**. Every one self-cleared with
no operator action available. Live telemetry agrees: riseCount 183, median
duration 11.4 min, 51 short clears.

This is the shape v0.38.0 already fixed once, for the per-circuit load-anomaly
family, whose comment reads *"this one family fired/resolved 116× — 72% of all
immediate notifications — burying genuinely-actionable alerts."* Same remedy, and
the same table: the alert still appears **on screen immediately**; only the PUSH
now waits.

20 minutes is not arbitrary — it is `sessionSelfHeal`'s own starvation trigger.
Below it the add-on is still trying to repair itself and there is nothing for a
human to do; above it the repair has been attempted and failed, which is exactly
when someone should hear about it. Against the observed window this suppresses 15
of 21 rise pushes and their matching resolves — **30 of 42** — while still paging
for every episode that outlived the heal, including a 133-minute one. It also
absorbs most of the same-tick duplication: four devices starving in one tick
produced four cards on four separate occasions, and none of those bursts would
page unless they persisted.

The resolve needs no dwell of its own: a resolve only pushes when the rise was
notified, so a suppressed rise is silently followed by a suppressed resolve.

### A guard whose correct operation looked exactly like its absence

v1.140.0's boot orphan sweep produced **zero log lines across ten boots** —
because its summary was guarded on there being something to retire. A clean
sweep and a sweep that never ran were byte-identical, so there was no way to show
the evidence gate was reaching production at all. The outcome is now logged once
per boot unconditionally, and states how many records it examined: zero
retirements over zero records is healthy, zero over forty is a detector that has
stopped working.

### The recorder heartbeat was debug-gated but info-emitted

`RECORDER_DEBUG` decided *whether* to emit; `log()` is the INFO logger. So all
3,103 heartbeats in the window carried `level: 30` — the same level as
`battery-soc-alarm: crossed 20% (low)` — and pino's own filter could never
separate them. The demotion v0.76.0 documents never actually happened on this
install, where `LOG_LEVEL=debug` is the standing configured value. `ha apps logs`
returns 100 lines and **76 of them were heartbeats**, cutting the operator's
default incident window from roughly five hours to seventy-five minutes, with a
real SoC alarm sitting in the noise. It now goes out on a real debug channel.

### Why one home Core paged and its twin did not

On 2026-09-09 at 14:40:23 a single `/device/list` poll reported Core 1 and Core 5
both offline. Core 5 pushed; Core 1 produced nothing. That looked like a silent
miss on a load-bearing Core.

It was not. Core 5's MQTT `/status` had seen OFFLINE at **14:39:59**, 24 seconds
earlier, so its dispatch dwell clock started 24 seconds sooner. Core 1's ran from
14:40:23 to 14:41:22 — **59 seconds against a 60-second debounce**. The dwell
worked exactly as designed, on a one-second margin.

What was missing is that nothing recorded *which* of the two inputs started the
clock, so neither an operator nor an auditor could tell why. The offline alert now
carries an **Observed offline via** fact naming the path and the age.

### The 60-second rebuild was dropping sticky clocks

Found while wiring the above. `setDeviceList` rebuilds each device object from an
explicit literal on **every poll**, and silently drops any field not named in it.
`lastErrorAt` has been lost that way since v0.97.0 introduced it — the field whose
entire purpose was to stop a REST error resetting the staleness clock — and
v1.142.0's `lastQuotaAtMs` and `contentStaleSinceMs` would have gone the same way.

Usually masked, because `setDeviceQuota` re-derives the quota clocks microseconds
later in the same poll. **Not** masked when the quota fetch then fails — which is
precisely the state in which a frozen projection matters most. All five sticky
fields are now carried forward, and a mutant for each is in the harness.

### Also

`scripts/mutate-push-dwell.mjs` — 12 mutants, 12 killed. One survived the first
run: widening the family prefix from `msg-rate-floor-` to `msg-rate` leaked a
20-minute hold-down onto neighbouring ids with nothing to catch it, which would be
a worse defect than the one being fixed. Closed with an explicit boundary test.

## 1.142.0

### The cloud can serve a stale shadow, and every gate we had keys on the fetch

On two consecutive nights the SHP2's `gridWatt` — the grid-presence alarm input —
held **one value for 16.0 minutes and 14.5 minutes** while the 60-second REST poll
returned 200 OK sixteen times in a row. Both windows sat inside an armed
night-charge window with 4–7 kW flowing through the panel. Every gating surface
read green: zero fetch failures, `poll_health: ok`, `/api/health blind: false`.

Nothing in this add-on was wrong. `setDeviceQuota` replaces the raw map wholesale
and re-projects unconditionally; there is no cache, no ETag and no short-circuit
anywhere in the REST client. EcoFlow's cloud served a replayed body for a device
whose own session had stalled, and we had no way to notice.

This is the **third variant of one family**. v1.86.0 closed *asked and failed*.
v1.138.0 closed *never asked*. This is *asked, answered 200 OK, and handed a stale
body* — which neither gate can see, because both key on the fetch, and
`lastUpdated` is bumped whether or not the payload moved.

**Why the witness is a vector.** The obvious rule — "this value has not changed in
N polls" — was measured against this plant and fails: `grid_power_home`
legitimately holds 0 W for 12.5+ hours on a sunny day, because solar covers the
house. A detector built on it could only ever fire falsely, which is exactly what
the v1.139.0 doorbell deletion exists to prevent. The panel's twelve per-circuit
watt readings are a different instrument: over **1,558 sampled minutes of live
history the full twelve-channel vector never held identical for even one minute**.
Twelve independent analog measurements holding byte-identical is not something a
live panel does.

`computeHomeGridWatts` and `computeShp2GridConnected` now treat a shadowed panel
exactly as v0.88.0 already treats an offline one — contribute no measured flow,
assert no presence. That comment named the consequence in as many words: a
frozen-high `gridWatt` keeps `importLive` true, which keeps `backstopping` true,
which **silently mutes a real at-floor outage** that begins inside the window. It
guarded the offline door; this is the same freeze arriving through the online one.

Staleness requires **both** a repeat count and an elapsed duration, so neither a
retry storm nor a single long gap can assert a shadow. An unmeasurable poll — a
partial payload, a device with no circuit vector yet — **resets** the state rather
than accumulating toward stale: absence of a witness is not evidence of a freeze.

`sensor.ecoflow_panel_shp2_payload_frozen` publishes the held duration, so the next
episode leaves evidence in HA's own history instead of an inference.

### A bare online-flip no longer vouches for the projection

`setDeviceOnline` bumps `lastUpdated` on a `/status` OFFLINE→ONLINE transition that
carries no telemetry and never touches the projection. v0.97.0 made exactly this
separation for `setDeviceError` and documented why, directly below it; v1.3.0 made
it again for `setMqttMessage`. `setDeviceOnline` was the third path and was never
given the same treatment, so v1.140.0's `shp2ReadbackFresh` — which keyed on
`lastUpdated` — could be satisfied by a flip against a sample nobody had refreshed.

The exposure is not one poll: the freeze case is precisely one where no REST poll is
coming, because `refreshAll` only fetches devices the cloud list reports online. The
gate would have stayed true for the full 300 s and been renewed by every further
flip. Control readbacks now key on `lastQuotaAtMs`, which only a real quota write
advances. The `lastUpdated` bump stays — the 3-minute *Telemetry stale* alarm keys
on it, and a 6-second flip must not raise a self-clearing stale alert.

### Also

`scripts/mutate-cloud-shadow.mjs` — 13 mutants, 13 killed. The first run reported
13/13 against a **red** tree, where every mutant dies for free; the two failures
were mine (sixteen store writes inside one millisecond, which the duration guard
correctly refused) and the number meant nothing until they were fixed. Recorded
because a harness run is only evidence if the baseline was green.

## 1.141.1

### Correction: the `object_id` in v1.141.0 was inert, and its rationale was wrong

v1.141.0 published `object_id: ecoflow_circuit_<ch>_power` on each per-circuit
power sensor and said it pinned the entity_id rename-proof. Live, HA minted
`sensor.ecoflow_panel_east_wing_l1_power` — device slug plus the slugified
**name** — so the key did nothing and the claim was false. Removed: config that
looks load-bearing and is not is worse than no config at all.

The goal is met regardless, by HA itself. An entity_id is minted **once** at
first discovery and persisted against the `unique_id`, so a later rename moves
only the friendly name — which matters because energy prefs wire `stat_rate` by
string. This fleet demonstrates it directly: the energy entity_ids still read
`…_circuit_3_energy`, frozen from before v1.65.0's pair-aware naming, while the
power entity minted today for that same channel reads `…_east_wing_l2_power`.

### Verified live

All twelve power sensors are publishing, and their **sum is 5,127 W against
`panel_load` 5,126 W** — one watt of rounding across twelve channels. The twelve
`device_consumption` entries now carry `stat_rate`, mapped by channel through
`unique_id` rather than by name, so the Now-tab Power Sankey has a complete set
to draw from. East Wing L1 (ch1) reads **0 W**, as predicted for the unreconciled
CT — a physical check at the panel is still the only thing that can settle it.

## 1.141.0

### The Now-tab Power Sankey has sensors to draw from

HA's Energy dashboard renders a live Power Sankey from `stat_rate` on each
`device_consumption` entry. All three `energy_sources` already carried one; all
twelve per-circuit devices carried none, so the Sankey had nothing to draw and
did not appear. `planCircuitDiscovery` now publishes a power sensor alongside
each existing lifetime-energy sensor.

**Twelve, not six.** The plan called for the six PRIMARY channels only, on the
reasoning that a split-phase pair is named from its primary. That premise does
not survive contact with `stat_rate`, which is a field **on** a
`device_consumption` entry — and there are twelve of those. Six sensors would
fill six entries and silently drop half the panel from the Sankey (the L2 legs
were 4,308 W of 8,346 W at a sampled tick), and putting a pair total on the
primary would make one entity mean two things: the pair's watts against its own
L1-only energy statistic.

The watts already existed end to end, so no projection or recorder change was
needed.

- Entity ids are pinned with `object_id`. The existing energy entity_ids were
  minted from the SHP2's user-editable circuit name and are already incoherent as
  a result — `…_east_wing_energy` beside `…_circuit_3_energy`. HA's energy prefs
  wire by string, so a rename must not be able to move them.
- A missing reading publishes `null`, never 0. On a `measurement` sensor a zero
  is compiled into HA's mean statistic as a positive claim that the circuit drew
  nothing, which is indistinguishable from a genuinely idle circuit. A genuine
  measured zero passes through unchanged.
- The discovery signature now covers the power name too. v1.128.0 changed a
  template around an unchanged display name, the signature did not move, and
  twelve entities kept stale names while eighty-four others were renamed — a
  second entity per channel widens that obligation.
- A departed channel clears **both** config topics. Missing one would strand a
  retained config on the broker with nothing left to remove it.

**The dynamic configs are now audited.** `auditDiscoveryTables` had only ever
been called with the static `SENSORS`/`BINARY_SENSORS` tables, so the twelve
per-circuit configs built at runtime were never checked against it — the same
filtered-subset shape as the defect family in v1.140.0, applied to the audit
itself. The generated configs are now routed through it in the suite.

**One operator step remains, HA-side:** add
`"stat_rate": "sensor.ecoflow_circuit_<ch>_power"` to each of the twelve
`device_consumption` entries. `stat_consumption` is untouched and the Energy tab
is unaffected.

Circuit 1 will publish a permanent **0 W**. That is the unresolved ch1 CT
question — 0.147 kWh lifetime against ch3's 66.6 kWh on a pairing that should be
comparable — which telemetry cannot settle and a physical check at the panel can.
Publishing pair sums instead would have hidden it.

`scripts/mutate-discovery-invariants.mjs` — 23 mutants, 23 killed.

## 1.140.0

### Four detectors that read silence as good news

Every one of these is the same shape as the v1.138.0/v1.139.0 doorbell: a
collection built from a filtered subset, then absence from it given meaning for
the whole set. All four fail silently — the add-on reports itself healthy, the
push says the fault cleared, the ledger says the write was verified, the warranty
record is simply gone. Three had to be found by reading code, because nothing
throws and nothing is logged.

The codebase already names the correct rule, as `fallingEdgeFrozenByEvidence`:
*an alert vanishing because its source went absent is UNEVALUABLE, not recovered.*
It was applied on one path and nowhere else.

**The telemetry-blind fix from v1.138.0 was itself half-closed.** The SHP2 roster
was built by filtering on `projection.kind === 'shp2'` — but a projection only
exists after a **successful** quota fetch, and the store is in-memory. So after
any restart while the panel was cloud-dark the roster was `[]`, not merely at
bootstrap but for as long as the darkness lasted; `pollHealthVerdict` took its
fail-open branch and the CRITICAL stayed disarmed. Exactly the outcome v1.138.0
was written to prevent, re-entered through the restart door — and a restart is
not rare: nine were measured in one 50-hour window. The roster is now resolved by
device IDENTITY (`productName`), which `setDeviceList` keeps for offline devices.

**A restart while a Core was dark falsely resolved its standing faults.**
`computeAlerts` skips offline DPUs wholesale, so a cloud-dark Core contributes
zero alerts — and the boot sweep read that as "everything on this device
cleared", pushed *"Resolved: …"* to the phone and dismissed the HA card. Two
CRITICALs and six warnings on Core 4 were exposed to this. Orphans whose source
device is absent or stale are now **held**. The hold has a deadline, because
several devices are permanently unevaluable (an RMA'd Core, a bench spare, the
1006 accessories), and expiry **drops silently** — there is still no evidence to
resolve on. A never-pushed record is dropped before the gate is consulted, so the
sweep keeps collecting for the noisy families it exists to clean up.

**The night-charge actuator compared a frozen projection to its target.**
`setDeviceList` preserves `projection` verbatim across an offline transition, by
design, and the actuator tests `backupReserveSoc` by strict equality. Over one
cloud-dark night a frozen pre-write value never equals the target: `retryApply`,
then `applyFailed` — a critical push saying the write NEVER TOOK EFFECT. The
revert then finds `current === prior` and stamps `revertVerified` for a revert no
device confirmed. Frozen at the raised target instead, it escalates to
`revertFailed`, which **speaks a bilingual critical broadcast**, from a sample
that may be hours old. A control readback now requires a live reading;
`decideActuation` already treats null as "do nothing", which is the pause the
actuator's own comment promised.

**A defective-pack record could be deleted because its Core was dark.** Presence
was harvested inside a loop gated on `online && projection`, while retirement ran
unconditionally — one side of the decision gated on evidence, the other not. The
perverse case is the likely one: a Core powered down and boxed **for RMA** is
exactly the Core that stays dark for days, so the warranty diagnosis it was
pulled for is what gets deleted. Retirement now requires the pack's **last seen**
chassis to be online and reporting — last-seen, not the `deviceSn` frozen at
confirmation, because this plant's own history is a pack that moved chassis
(2026-08-20, where the fault followed the pack). A 90-day backstop bounds the
opposite failure, since the realistic RMA ships the chassis with the pack and its
SN may never return. Retirement is also now **logged with its full evidence
snapshot before the delete** — previously a warranty diagnosis was destroyed with
no breadcrumb at all, which is why this had to be settled by reading code.

The live record at the time of writing — Core 4 pack 1, confirmed 2026-08-24,
1% SoC against a sibling median of 86% — was intact and never at imminent risk,
but was exposed in exactly the scenario the latch exists to serve.

### The poll verdict is now recorded

`sensor.ecoflow_panel_poll_health` publishes `ok`, `shp2-fetch-failed` or
`shp2-not-polled`. The SHP2 case above had to be argued from code reading rather
than observation: the verdict was computed every 60 seconds and stored nowhere,
and the detector shipped five weeks after the last confirmed dark window. Six
such windows are visible in HA's own long-term statistics between 2026-06-21 and
07-05 — one of 41 hours, another frozen at exactly 53% across a full solar day —
with zero critical alerts in any hour of any of them. That is a real, dated
precondition; whether the detector would have said `blind:false` in them is a
counterfactual, and this release is what makes the next one answerable.

### Also

- `scripts/mutate-absence-evidence.mjs` — 18 mutants, 18 killed. Seven survived
  the first run: four were genuine wiring gaps where every pure function stayed
  correct while a live call site was reverted, and three were errors in my own
  test construction (one cleared the state under test through a different code
  path than the branch being exercised). All were closed rather than accepted.
- A source-scan test that bounded its window at a fixed 1,200 characters stopped
  reaching the code it checked as soon as that block grew a comment. It now
  bounds on the block.

## 1.139.0

### The EcoFlow enablement doorbell is deleted

v1.88.0 added a detector to announce the moment the four 1006-blocked accessories
(EVSE, PowerInsight, BACC Delta 3 Plus, SEC River 3 Plus) started answering
`/quota/all` — the signal that an API-access request to EcoFlow had been granted.
v1.138.0 fixed it firing falsely. This removes it, because the premise it rested on is
false.

**API error 1006 is a product-class limit, not a grantable account permission.**
Settled on 2026-09-08: EcoFlow is not expected to extend API coverage to
these device classes. The vendor's own wording scopes the denial to the device — *"current
**device** is not allowed to get device info"* — and the same credentials read every
Delta Pro Ultra and the SHP2 without trouble.

So the condition the doorbell watched for cannot occur, and every firing it could produce
was necessarily false. It did fire: on 2026-09-08 it pushed *"EcoFlow data restored"* to
the operator's phone 302 ms after the device went **offline**. A detector that can only
fire falsely is worse than no detector on a life-safety system — it teaches the operator
to discount the push.

The repo previously asserted **both** readings of 1006 in different releases — `DOCS.md`
said these devices reject "by design" while a v1.40.0 source comment called it "an
account-permission limitation". That unreconciled contradiction is what allowed the
feature to be built at all. It now reads one way everywhere, and a source pin in
`pollHealthAttribution.test.ts` fails the build if the detector's machinery returns.

If EcoFlow ever does extend coverage, the honest signal needs no detector: the device
stops erroring and `lastUpdated` advances.

### What survives, and why it is unrelated

- **`refreshAll()` still returns `{ attemptedSns, failedSns }`.** The attempt set is what
  makes "never asked" distinguishable from "asked and failed".
- **`pollHealthVerdict()` stays.** It closed the same faulty inference where it actually
  mattered: a cloud-offline SHP2 counted as a healthy poll, leaving the telemetry-blind
  CRITICAL disarmed for the entire dark window. That has nothing to do with EcoFlow's
  entitlement policy.

`scripts/mutate-poll-recovery-attribution.mjs` is retargeted and renamed to
`scripts/mutate-poll-health-attribution.mjs` — 8 mutants, 8 killed, including one that
reinstates the deleted doorbell's machinery.

## 1.138.0

### A device going offline announced itself as restored

On 2026-09-08 at 15:52:31 MST, EcoFlow's cloud reported `BACC - Delta 3 Plus` offline.
**302 milliseconds later — same poll tick, same `/device/list` payload — the panel
pushed "EcoFlow data restored — quota data is flowing again" to the operator's phone.**
Sixty seconds later the device was online again and immediately failing again. Nothing
had been restored: that serial's `lastUpdated` was 0 then and is 0 now, and
`/api/debug/raw` returns `raw: null`, `mqttMsgCount: 0`. No quota fetch has ever
succeeded for it.

`refreshAll()` fetches only `list.filter((d) => d.online === 1)`, so `failedSns` can
only ever contain devices the poll actually **asked**. Two detectors read absence from
that array as evidence of success. It is not: a device that went offline is absent for
the same reason a healthy one is.

`refreshAll()` now returns `{ attemptedSns, failedSns }`, and both detectors are pure
exported functions that take the attempt set explicitly. A device that was never asked
is neither recovered nor failing — it is **unevaluable**. That is the doctrine the
codebase already states for the alert falling edge under the name
`fallingEdgeFrozenByEvidence`; these two call sites never got it.

- **`longFailureRecoveries()`** — a recovery requires `attempted && !failed`. An
  unattempted SN is **held**: its clock is not read, not reset, not deleted. Holding
  matters in both directions. The old code deleted the entry on every absence, outside
  the tenure test, so it re-armed after each flap **and** would have silenced a genuine
  enablement that landed during an offline window — the device would have returned
  succeeding and never re-accrued thirty minutes of failure. It cried wolf and would
  have stayed silent for the wolf.
- **A second, unguarded doorbell is gone.** The `failedSns.length === 0` branch fired
  for *every* long-tenured SN at once and then cleared the map, with no per-device check.
  `/device/list` has no length validation, so an empty or short vendor response would
  have named all four 1006-blocked accessories as restored in one push — a telemetry
  blackout rendered as good news. Both sites are now one call.

### The same inference had disarmed the telemetry-blind CRITICAL

Fifteen lines below the doorbell, in the same function: `failedSns.some(isShp2)`. An
SHP2 that goes cloud-offline is never fetched, so it never appears in `failedSns`, so
the poll counted as OK and `notePollOk()` ran. `assessBlind`'s other input counts
devices carrying a projection regardless of `online`, and `setDeviceList` deliberately
**preserves** `projection` across the offline transition — so the detector saw
`hasDevices=true, pollFresh=true` and returned `{blind: false}` for the entire
SHP2-dark window. The alarm system stopped watching the alarm path and reported itself
healthy.

`pollHealthVerdict()` distinguishes asked-and-failed from never-asked. It fails open
only at bootstrap, before any SHP2 is known; thereafter **every** known SHP2 must have
been asked and answered, because a partially-dark two-panel fleet is partial blindness.

This is the suspected mechanism behind the recorded "SHP2 cloud-offline → floor gap with
no compensating alarm". That remains a code-reading inference — confirm it by sampling
`/api/health` during the next cloud-offline episode and checking whether `blind` stays
`false`.

### The notification no longer asserts what it cannot know

The old body claimed EcoFlow's enablement had landed and that the panel would begin
projecting the device automatically. The first is an inference from one poll. The second
is true only for classes with a tailored projection — `projectByProduct` has branches
for Delta Pro Ultra and Smart Home Panel 2 and nothing else, and **zero** server-side
consumers read a `generic` projection, so an accessory contributes no alarms, energy
totals or HA entities even when its data does flow.

The recovery set is also filtered by device class now. A DPU Core or the SHP2 recovering
from a DNS `EAI_AGAIN` or a cloud 5xx would have pushed a false vendor-entitlement claim
about a core alarm-path device; the prose hedge "if these are the accessory devices" was
doing work the code never did. Core recoveries log and do not push.

The log line always said enablement *"may have landed"*. The push dropped both hedges.
The cautious sentence went to the log and the confident one went to the phone; that is
now the other way round.

### Also

- `EcoFlow API error … (trace )` — `eagleEyeTraceId ?? 'n/a'` never fired because the
  vendor returns an empty string, which is not nullish. Now `||`.
- The source comment naming these accessories called them Delta 2 Plus / River 2 Plus.
  They are 3 Plus. It is the comment an investigator greps for.

`scripts/mutate-poll-recovery-attribution.mjs` — 15 mutants, 15 killed. Three of them
leave both pure functions correct while making the real `tick()` inert; they survived
the first run and were closed with source pins rather than accepted.

## 1.137.0

### The discovery table can no longer lie about what HA will do with it

Two failure modes in `mqttDiscovery.ts` are silent by construction — the publish
succeeds, the topic retains, and the damage only shows up inside Home Assistant.

**Table invariants (`auditDiscoveryTables`).** HA does not loudly reject an
incoherent `(device_class, state_class, unit_of_measurement)` triple. It either
drops the entity with one log line, or accepts it and compiles the wrong
statistic. Both have bitten this add-on: five `pv_curtailment_*` sensors sat
permanently `unknown` (v0.15.3), and the three `USD` sensors carry
`state_class: measurement`, so HA compiles a **mean** and they can never be an
Energy-Dashboard cost source — correct for a dashboard readout, fatal for a cost
source, and nothing in the table said which was intended. A pure audit now runs
over the whole table in CI and returns violations the suite asserts are empty.
Deliberate departures need a waiver **with a reason**; the reason text is the
only place the intent is recorded, so adding a fourth `USD` sensor forces the
author to say which behaviour they want. A waiver for a violation that no longer
exists fails the build rather than quietly outliving it.

`USD/kWh` is deliberately not swept in: that is a *price*, not an amount of
money.

**Discovery re-asserts on every broker connect.** Discovery configs are
retained, so the case that breaks is the **broker** losing its retained store — a
Mosquitto restart without persistence, a re-created container. The configs
vanish, and the one-time `published` latch meant the add-on never republished
them: HA kept only what was already in its registry, and a fresh HA would never
have learned the entities at all. The connect sequence is now extracted into
`runBrokerConnect`, which re-asserts discovery and invalidates the per-circuit
signature every time, while keeping the retired-unique_id cleanup latched to the
first connect.

The per-circuit **orphan ledger** is deliberately never reset. It is not a latch;
it is the memory of which circuits have been published, used to clear the config
topic of one that disappears. Resetting it on connect would strand a removed
circuit's retained config on the broker with nothing left to remove it.

`scripts/mutate-discovery-invariants.mjs` — 17 mutants, 17 killed — includes one
that leaves `runBrokerConnect` correct while making the real `client.on('connect')`
handler inert, and one that resets the orphan ledger.

### Documentation corrections

- **The `charge == discharge` RTE clamp does not exist.** Two places described
  `/api/lifetime-energy` as holding lifetime charge and discharge exactly equal
  via a steady-state clamp. That clamp was removed in v0.45.0. Measured
  2026-09-07: 2,154.541 kWh charged against 2,169.44 kWh discharged — a 14.9 kWh
  *excess* on the discharge side, an RTE above 100%. These are coulomb counters
  re-zeroed at one instant and mediated by delta-SoC; their ratio breathes with
  pack SoC and sits either side of unity. Near-equality is coulombic efficiency,
  not an invariant.
- **"Untracked consumption" is not the conversion-loss residual.** The docs
  claimed the SHP2 circuit CTs sum to approximately whole-home load, so HA's
  untracked figure would read as PV→battery conversion loss. The SHP2 meters the
  *backup-circuit subset*, not the service, so non-backup load lands in the same
  bucket; and channel 1 remains unreconciled (0.147 kWh lifetime against channel
  3's 66.6 kWh), which telemetry cannot settle. Treat it as an upper bound, never
  a measurement.
- **§4.2b now records what v1.136.0 superseded.** `resolveTariffCents` returns
  two tiers; the KPI tally and dispatch planner now price hours through
  `hourlyRateCents` / `isOnPeakHour` against the four-period rate table.

### Test hygiene

The v1.14.1 availability test asserted on **source text** — that `'online'` was
published before the `if (!published)` gate. Removing that gate strengthens the
property the test protects, and the test failed anyway. Its ordering claim is now
made behaviourally against `runBrokerConnect`; only the parts that genuinely
cannot be reached from a test (the `mqtt.connect()` LWT options, the un-exported
closure) remain source inspection.

## v1.136.0 — one rate table, four periods

`resolveTariffCents` returns `{onPeak, offPeak}` — **two** tiers. APS R-EV has
four priced periods, and both the KPI tally and the dispatch planner priced every
hour with `onPeakAt(t) ? onPeak : offPeak`. So **every overnight kWh was billed at
the off-peak rate**: 16.91 c instead of 12.59 c.

Against the **1,109 overnight kWh** on the September bill that is **$47.91 a month**
of pure over-statement in `Grid Cost Today` and everything downstream of it —
about $575/yr of a number that was never real. The winter 10:00–15:00
super-off-peak tier (8.2 c) had no representation at all. Nothing failed, because
a pricing error produces a plausible number rather than an exception.

There were **three** copies of the on-peak window. The third, in the MPC feed, was
a hardcoded `h >= 15 && h < 20` with **no day-of-week gate at all**, so it priced
weekend afternoons as on-peak on a plan whose on-peak is Mon–Fri only. All three
now resolve through `hourlyRateCents`, which reads the full table.

**The planner was also discharging into hours it was not paid for.** Its gate was
`onPeakAt`, default window `15-20` — five hours against an R-EV on-peak of
16:00–19:00. Two of those five earn the off-peak rate, so the plan spent cycle
life for no arbitrage. `isOnPeakHour` now derives the gate from the same table
that prices the hour, so the two can no longer disagree.

Two deliberate details. The fallback is explicit: `rateAt(...).centsPerKwh` is
`number | null` and `null / 100 === 0` in JavaScript, so a bare conversion would
have silently priced every kWh at **$0** on an unconfirmed install; it falls back
to the legacy ladder instead. And local midnight in the MPC feed is computed
arithmetically rather than through `Intl` — Phoenix is a fixed UTC−7 with no DST,
and this codebase has already been bitten once by a locale behaving differently on
the Pi than on a laptop.

2,393 tests, verified under **both** `TZ=UTC` and `TZ=America/Phoenix`. The first
draft of one test asserted the legacy gate's behaviour at a fixed Phoenix hour; it
passed here and **failed in CI**, because `onPeakAt` reads `new Date(ts).getHours()`
— the host clock — and the runner is UTC. That failure is evidence for the very
defect described above, so the assertion was changed to the property that is
actually true (on an unconfirmed tariff the gate *delegates* to `onPeakAt`, whatever
it says) rather than to a timestamp that happened to work. A companion test pins
the complement: with rates confirmed, the gate comes from the Phoenix-pinned table
and gives the same answer on any host.

`scripts/mutate-rate-table.mjs`: **5 of 6 mutants killed, and the
sixth is declared in the harness rather than deleted.** The KPI tally's call site
is not pinned — its integration window means a fixture hour old enough to have a
known tariff period contributes no energy, and with zero energy both pricing paths
return 0. The dispatch call site and both pure helpers are pinned. The harness now
fails on an *undeclared* survivor and passes on a declared one, so the gap is
visible in the output rather than hidden by a better-looking score.

## v1.135.0 — the database snapshot says how old it is

`/share/ecoflow-panel/ecoflow-snapshot.db` is a **copy, not a mirror**. The live
database is add-on-private at `/data/ecoflow.db`, so nothing outside the container
can read it; `POST /api/db-export` publishes a copy on request, and that copy
changes only when someone asks.

Which is how it went stale. The export ran once on **2026-08-23** and was then
browsed in SQLite Web two weeks later as though it were live — missing all
eleven actuated nights, the v1.132.0 disposition columns, and every ledger row
after 08-23. Identical created and modified timestamps were the only tell, and
nothing in the UI said otherwise.

The new **Maintenance** section on the Strategy panel shows the snapshot's size
and, more importantly, **its age** — amber past twelve hours, and "never
exported" when there is none. The refresh button is the easy half; the age is the
part that would have prevented reading a fortnight-old ledger as current.

The confirmation states the real cost before you commit (~1.7 GB, 20–30 s) and
says plainly that the copy is read-only with respect to the live database. The
result reports what actually landed — bytes written and elapsed time from the
response body, not an assumption drawn from the HTTP status.

No scheduling. A periodic export would write ~1.7 GB on a cadence nobody asked
for, and the honest fix for a stale read is to make the staleness
visible, not to hide it behind a timer.

## v1.134.0 — the Energy page can finally show money

The HA Energy Dashboard showed **no cost at all**. `stat_cost`,
`entity_energy_price` and `number_energy_price` were all null on the grid source,
so every money column was blank despite a confirmed five-rate tariff. The three
USD sensors that exist could not be used: they are published `state_class:
measurement` with no `device_class`, which compiles mean/min/max and no sum, and
the Energy cost column reads the sum. Computed, then published in a shape nothing
can consume — the same pattern as v1.130–v1.133.

**`entity_energy_price` is the only one of HA's three options that is correct on a
time-of-use plan.** HA's own cost sensor accrues `(energy − previous) × price` on
every state change of the *energy* entity, sampling the price fresh each time, so
each delta is multiplied by the rate in force **while it flowed**. A single
`number_energy_price` against an 8.2–44.2 c/kWh spread is wrong by construction: a
10 kWh overnight + 10 kWh on-peak day truly costs $5.72, and one scalar gives
20p — right only at p = $0.286 and only for that exact mix. `stat_cost` would
need a monotonic monetary accumulator that does not exist, and the add-on's own
cost integrates a *superset* of the mapped grid statistic, so money and kWh would
never reconcile to any rate.

New sensor `ecoflow_grid_price_now` — **`USD/kWh`, not `USD`**, and deliberately
no `device_class`: `monetary` describes an amount of money, not a price, and HA
mints its own monetary/total cost sensor from this one. It emits **null** rather
than a fallback rate when the tariff is unconfirmed; a silent off-peak default
would reintroduce exactly the mispricing the entity exists to remove.

**The tariff rates were also wrong, and the September bill says how wrong.** APS
prints a per-tier base rate that is not what you pay: a uniform Adjustors line
($56.87 / 2,012 kWh = 2.827 c/kWh, **20.5% of the energy cost**) and then Taxes
and Fees at 11.457% on top. All-in marginal rates, reconciled against the bill to
within one cent:

| tier | all-in | was configured | |
|---|---|---|---|
| on-peak (summer) | **44.20 c** | 41.6 c | −5.9% |
| off-peak (summer) | **16.91 c** | 17.0 c | +0.5% |
| overnight | **12.59 c** | 13.1 c | +4.1% |

Applied to the live add-on. **Winter tiers are untouched** — this is an
August–September bill and carries no winter evidence; a winter bill would settle
them. The derivation is now in the option's own description in both languages, so
the next bill is a mechanical update rather than a re-investigation.

Consequence for the arbitrage arithmetic: stored overnight energy delivers at
**14.44 c**, so the true spreads are **+2.47 c/kWh** against off-peak and
**+29.76 c/kWh** against on-peak — both slightly better than previously stated.

Also in this release: the HA device page reported `sw_version: '0.8.0'` against a
shipping 1.133.x — about 125 releases stale — because it was a hardcoded literal.
It now reads `BUILD_VERSION`, the same env `/api/version` already uses.

2,382 tests.

## v1.133.3 — a vulnerability signal that does not depend on GitHub

v1.133.2 shipped a fastify security release that reached this system only because
Dependabot happened to raise a routine version bump carrying it. That is the whole
security pipeline today, and it has a hole: **GitHub is not alerting on this
repository.** `/dependabot/alerts` and `/code-scanning/alerts` both return empty —
consistent with GHAS being unavailable on a private personal repo, the same
limitation that made CodeQL a self-contained CI job here rather than an alerting
integration. A vulnerable dependency that never receives a routine bump would not
surface at all.

`scripts/check-npm-audit.mjs` closes that, gated in CI as *Dependency advisories*.
The policy is deliberately asymmetric: **high or critical in the PRODUCTION tree
fails the build**; production moderate/low and anything dev-only is reported and
does not. Fastify serves the alarm API, so a high there is not a backlog item — but
dev-tree noise blocking an unrelated PR trains people to bypass the gate, which is
worse than the finding.

**Waivers expire.** `scripts/npm-audit-allowlist.json` can suppress a specific
advisory, but every entry must carry a reason *and* an `expires` date, and an
**expired waiver fails the build**. An undated allowlist is how a temporary
exception becomes permanent silence — the exact failure this codebase keeps
finding elsewhere. Waivers for advisories that are no longer present are reported
as stale so the file cannot accumulate cruft.

**It fails closed.** No lockfile, an unreachable registry, or unparseable output
exits non-zero naming itself an infrastructure failure. A check that passes when it
could not run is not a check.

**And it proves it can fire.** The policy is a pure `classify()` exercised by an
11-case self-test that runs *before* every audit — because a clean `npm audit` is
indistinguishable from a broken gate unless the gate has been shown to fail.
Verified by mutation: dropping `high` from the blocking set, ignoring the waiver
expiry, and letting dev findings block were each introduced and each killed by the
self-test (3/3).

Current state: **0 advisories** across server and web, production and dev.

## v1.133.2 — fastify security release, actually deployed

Four Dependabot updates merged, one of which matters: **fastify 5.12.1 → 5.12.3
is a security release** carrying fixes for `GHSA-9q9j-q6p8-xq58`,
`GHSA-hwr6-493r-vm6h`, `GHSA-p68q-wchp-6fh7` and `GHSA-667r-xxjv-c9mm`. Fastify is
the HTTP server behind the alarm API, the ingress panel and every status route, so
it is not a background dependency on this system.

The others are routine and non-production: `tsx` 4.23.12 → 4.23.13 (server dev),
`postcss` 8.5.26 → 8.5.28 (web dev), `docker/setup-qemu-action` 4.2.0 → 4.3.0 (CI).

**This release exists because merging is not deploying.** The add-on runs a
prebuilt GHCR image; a dependency bump on `main` changes nothing on the Pi until a
version bump triggers `tag-release.yml` and a new image is built. Left unreleased,
the security fix would have sat on `main` looking done while the alarm API kept
serving on the vulnerable version — the same shape as the v1.130.0 release that
silently never happened.

Verified against the installed tree rather than the lockfile: `fastify` resolves
to 5.12.3 in `node_modules`, 2,378 tests pass, typecheck clean.

Worth recording separately: **GitHub is not alerting on these.** Dependabot
*version* PRs arrive, but the vulnerability **alerts** endpoint returns empty and
code scanning returns empty, consistent with GHAS being unavailable on a private
personal repository (the same limitation that made CodeQL a self-contained CI job
rather than an alerting integration). A vulnerable dependency that does not happen
to receive a routine version bump would therefore not surface at all. The advisory
IDs above also 404 against the global advisory API, so their severities could not
be retrieved and are deliberately not stated here.

## v1.133.1 — the reserve it announced was not the reserve it wrote

The plan rationale said *"The reserve is set to 100%"*. The panel was being told
**50**. That sentence goes into the 21:30 notification **and the spoken
broadcast**, so the number an operator heard was an internal quantity, not an
instruction — caught by reading a live plan on 2026-09-06 (`setpointSocPct 100`
against an actuation `targetPct 50`).

`setpointSocPct` is the resilience requirement expressed as a pack level, and it
is deliberately un-capped — deriving it from the deliverable would let contention
cap a charge the window could otherwise supply, which is the under-buy v1.60.0
exists to prevent. The error was reporting it as though it were the setting. The
sentence now names three quantities for what they are: what the device is **told**
(the clamped value), what the requirement **asked for** when the envelope
truncated it, and what the window is expected to **reach**.

The write envelope also gets a name. `[10, 50]` was a bare pair of literals inside
`clampReserveTarget` and a second pair inside `setBackupReserveSoc`'s range check,
so nothing in the codebase said out loud that 50 is the ceiling on everything this
engine can achieve — which is how `ARB_COST_MAX_SOC_PCT`, schema `int(50,100)`,
came to ship with a minimum equal to that maximum. It is now
`RESERVE_WRITE_MIN_PCT` / `RESERVE_WRITE_MAX_PCT`, and anything reporting a
reserve figure reconciles against them.

A v1.60.0 test pinned the old wording. Its subject — that the setpoint tracks the
requirement rather than the contention-derated arrival — is unchanged and still
asserted; only the sentence moved, so the assertion was updated rather than the
disclosure dropped.

2,378 tests. 9/9 mutants (`scripts/mutate-zero-cushion.mjs`), including one that
restores the un-clamped announcement verbatim and one that keeps the number right
while dropping the disclosure — a true figure that hides the shortfall.

## v1.133.0 — zero cushion now means zero

Setting `ARB_OUTAGE_CUSHION_HOURS` to `0` did not disable the outage cushion. The
guard folded `outageHours <= 0` into the same branch as *"no islanded-load
measurement available"*, so an operator asking for no cushion silently received the
**legacy flat band instead** — 15% of pool, 13.8 kWh on this plant. The option was
accepted, `validate-addon-config` passed, and the decision did not take effect.

It was worse than inert. The legacy basis also switches the cushion test from the
islanded-outage trough (the pack at window close) to the whole-house forward
trough, which is **harsher** — so asking for *no* cushion made the requirement
*larger*. Both halves of the setting inverted.

An exact `0` is now a decision and is honoured as one, on a third basis value:
`disabled`, alongside `islanded-outage` and `legacy-pct`. It is checked **first** —
a disabled cushion does not depend on a load measurement, so a missing reading
cannot resurrect the legacy band underneath a deliberate zero. Anything else
nonsensical — negative, `NaN`, `Infinity` — still falls back, because a malformed
value is not a decision: fail toward more cushion, never less.

**A disabled cushion announces itself.** The rationale now reads "the N% reserve
floor alone — the outage cushion is DISABLED, so nothing is held back for an
outage". Without that branch, a night carrying no outage margin at all would read
as one whose floor-plus-cushion was comfortably covered — a standard that was
lowered, reported as one that was met. That distinction is the entire point of the
change, and it is the same hazard v1.131.1 and v1.132.0 exist to remove.

One consequence worth stating plainly: under `disabled`, `cushionShortfall` changes
meaning. It no longer flags "could not fully meet the outage margin"; it fires only
when the pack cannot hold the **reserve floor itself** — a stronger, rarer signal.
Anything reading that flag as a proxy for outage readiness needs to know the
standard moved underneath it.

A v1.125.x test had pinned the old behaviour deliberately (`assert.equal(at(0),
LEGACY, 'zero hours falls back rather than yielding a zero cushion by accident')`).
That reasoning was defensible when nobody had asked for a zero cushion; it is now
superseded by an explicit configuration decision, so the assertion was updated rather than
the fix weakened — and the guard it was really protecting, that a *malformed* value
stays conservative, is now pinned separately against negative and non-finite hours.

2,375 tests. 6/6 mutants killed (`scripts/mutate-zero-cushion.mjs`), including an
exemplar reproducing the shipped fold-back verbatim and one that would silently
apply the harsher whole-house trough to a disabled cushion.

## v1.132.1 — the option that could not reach the device

`ARB_OBJECTIVE` and `ARB_COST_MAX_SOC_PCT` shipped in v1.127.0 with **no DOCS.md
section at all** — `grep -c` returned 0. A whole engine mode arrived undocumented,
and that omission is why a value could be chosen that does nothing.

**`ARB_COST_MAX_SOC_PCT` is not deliverable above 50.** The actuator writes exactly
one field — the panel's backup-reserve setpoint — and it is capped at 50 in two
independent places: `clampReserveTarget` in the actuator, and `setBackupReserveSoc`'s
own range check, which refuses out-of-range before any network call. The option's
schema is `int(50,100)`: **its minimum equals the write's maximum**, so every legal
value produces the identical instruction. Charge power binds first in any case — a
six-hour weeknight tops out near 60% SoC even with the clamp removed — so the
documented 90% ceiling is unreachable by two independent limits. Live corroboration:
an armed plan carrying `setpointSocPct = 100` produced an actuation `targetPct = 50`.

The option's own description promised "the hard ceiling cost mode charges to" and said
nothing about the envelope. It now discloses it, in both languages. `ARB_GRID_INPUT_CAP_KW`
already documented this kind of coupling; this option should have from the start.

**Cost mode is also rate-blind**, which the name does not suggest: `costModeTargetKwh`
reads no tariff. "Cost" means *fill further*, on the premise that overnight energy is the
cheapest the day offers — not that the planner optimises against the rate table.

**And the config block header was false.** It read *"Night-charge TOU-arbitrage advisor
(ADVISORY — never writes to any device)"* above a block containing `NIGHT_CHARGE_MODE`,
whose live value on this deployment is `supervised`. It now states when the engine writes
and what it writes.

**The cost-check reorder was investigated and not shipped.** Moving the objective check
above the no-shortfall hold would let cost mode fire on nights that currently return early.
Measured over the trailing seven ledger rows: exactly **one** held, and it held because a
one-hour Friday window could not serve the requirement — not because the night was
comfortable. The addressable population is close to empty, `actual_onpeak_import_kwh` is 0
on every scored night, and the per-night ceiling is 8.09 kWh of pack (the gap between the
41.2% hold bar and the 50% write clamp). Documented rather than built.

Documentation and option text only — no code, no behaviour change. 2,364 tests.

## v1.132.0 — five true records that read as false ones

Nothing here computes a wrong number. Every value was already correct; each was
recorded with a label that meant something else — which is strictly harder to
notice than a wrong value, because there is nothing to disagree with.

**The motivating row is 2026-09-04.** Friday's overnight window is ONE hour on
this tariff, so the planner sized the full requirement — the whole pool — and the
window could pass roughly none of it. The ledger recorded:

> Hold — the projected shortfall (0.0 kWh) is below the 1 kWh minimum-buy
> threshold; no meaningful charge.

`buyKwh` is not the shortfall. It is the **deliverable** — the meter-side energy
the window can pass after the charge-rate and contention caps. So a night whose
window physically could not serve a 92 kWh requirement was filed as a quiet night
with nothing worth buying, and read that way for a day. The hold now says which
of three things happened: no shortfall at all, a genuinely small need, or a
window that cannot serve the need — naming the requirement it could not meet.

The discriminator is deliberately **not** `bindingCap`. `poolHeadroom` is the
label on both a starved window and a nearly-full pack, which are opposite
situations; keying the wording off it got this wrong in a first draft, and the
mutation harness caught it. `holdIsStarved` compares the requirement against the
deliverable, both converted to the meter side, with `!meetable` short-circuiting
to starved because that case carries a placeholder requirement that would
otherwise compare as comfortably covered.

**A night with no cheap window was reporting an incomplete basis.** Saturday has
no overnight window on this tariff. `nullPlan` stamped `basisComplete: false`, so
Home Assistant said "basis incomplete" about a perfectly healthy forecast and
telemetry basis, and a routine windowless Saturday was indistinguishable from a
data outage. It now reports `basisComplete: true` — the decision is unchanged, only
the explanation. Genuine basis failures still read as failures. The same night's
ledger row was also score-noted as a "pre-v1.39.0 row", sending anyone reading it
hunting a migration bug that was not there; those two cases are now distinct.

**`actuated` was answering five questions with one NULL.** Superseded by a later
plan, held below the minimum buy, no window resolved, advisory mode, apply guards
refused — all NULL. The 2026-08-29 row sat at `actuated=NULL` with `buy_kwh=36`
and read like a failed 36 kWh buy; it was a routine Sat/Sun shared-window
supersede, recorded in a log line and nowhere in the ledger. New column
`arm_disposition` stamps it.

**Cost mode was unauditable from the ledger.** `objective` records the configured
mode plus buy/no-buy, and `costModeTargetKwh` floors at the resilience answer and
raises only under a strict inequality — so a row labelled `cost_arbitrage` can
carry zero cost-mode contribution. The one field that discriminates,
`costCeilingBasis`, was computed and thrown away. New column `cost_ceiling_basis`
persists it.

**And a comment that was simply wrong.** The supersede path called Friday and
Saturday "both target the Monday window". Friday has its own window (23:00–00:00,
one hour, because the weekday rule is evaluated per-instant); the pair that
genuinely shares one is Saturday and Sunday.

Documentation: the §8b scoring step described `actuatedRealizedNeedBuyKwh`, which
has not been on the scoring path since v1.105.0 and is now exercised only by
tests; `ARB_LOAD_P90_CAP` was missing from the env-only knobs list, with a note
that schema-izing it without an `options:` default would pin the load band to
zero (`Number('') === 0`).

2,364 tests. 8/8 mutants killed (`scripts/mutate-ledger-legibility.mjs`),
including an exemplar reproducing the 2026-09-04 wording verbatim. A ninth
survived — a call-site substitution needing a cost-mode state this suite cannot
construct — so the discriminator was extracted to a pure predicate and the
mutants retargeted at it rather than leaving a permanent false survivor.

## v1.131.2 — the new field corrected the release note that introduced it

v1.131.1 shipped `InverterStandby.blockedReason` so a blank standby row would say
which empty it is, and asserted in the same breath that `ac_out` is *structurally*
zero on this installation — the output stage never energised, the register dead.

The field disagreed on four of five Cores.

Live, one deploy later: **Core 4** reports `ac-output-stage-idle` (its entire
60-day series is zero). **Core 1, 2, 5 and xxCore 3** report
`insufficient-idle-samples`, which by construction means at least one non-zero
sample exists — the output stage HAS been energised, presumably while islanding —
but fewer than ten samples fall inside the (0, 200 W) standby window with PV dark.

The register is effectively **bimodal**: exactly 0 when grid-tied, kilowatts when
islanded, and nothing in between, because an inverter that is off reads 0 rather
than reporting its own self-consumption. That is a better-supported reason for the
same conclusion, and it is the one now in the docs.

Documentation only — no behaviour change. Recorded because DOCS.md is the
permanent register and a wrong causal claim in it outlives the release that
carried it. Also worth keeping for what it demonstrates: the honest empty state
earned its keep within one deploy of existing, by contradicting the person who
wrote it.

## v1.131.1 — the standby detector was blind twice

v1.131.0 removed the whole-house gate that made the inverter-standby detector
unsatisfiable. Live-verifying it found every DPU **still** reporting
`idleWatts: null` — and the reason is a second blocker the code review could not
have found, because it is not in the code.

`ac_out` reads **0 on all five Cores, with `acOutVol` also 0**. The Delta Pro
Ultras feed the house through the SHP2 link, not their own AC output port, so
that inverter stage is never energised and the register the detector trends is
structurally zero. `ac_out > 0` cannot hold on this installation. The v1.131.0
fix was necessary and is not sufficient; the detector's data source is simply the
wrong one for this topology.

Standby self-consumption is real and is not exposed on that register. Inferring
it from pack drain (`bat_amp × bat_vol` while PV is dark and output is zero) is a
different measurement and separate work, not something to improvise into a
life-safety release the same afternoon.

What ships now is the honest empty state. `InverterStandby.blockedReason` is
`null` when a figure is published and otherwise says which empty it is —
`no-ac-out-history`, `ac-output-stage-idle` (the live case), or
`insufficient-idle-samples` — and the Advanced-Insights card prints that reason
in place of the value instead of dropping the row. That is the entire point of
this batch: a blank row reads exactly like a healthy one, which is how this
detector hid for its whole life, and how it would have gone on hiding after a fix
that looked correct in review and changed nothing on the device.

18/18 mutants killed, including two new ones on the empty state itself.

## v1.131.0 — five signals that were never earned, and a release that never happened

Every defect in this batch is the same shape: a detector or a status field that
**cannot report the thing it claims to report**, whose silence is indistinguishable
from health. Three had been shipping that way since the feature was written.

**The inverter-standby detector could not fire.** Its idle-sample gate was
`pv < 20 W && panel_load < 20 W && 0 < ac_out < 200 W`, where `panel_load` is the
SHP2's whole-panel draw. That panel carries the backup circuits of an occupied
house and never drops below roughly 1.4 kW — live 7-day mean **1,445 W** — so the
conjunct was false at every sample, for every DPU, for the entire life of the
feature. The sample set stayed empty, `idleWatts` was permanently `null`, and the
Advanced-Insights card rendered as *nothing to report*. Both surviving conditions
are about the DPU itself: its own PV dark, its own AC output in the standby window.
The SHP2 query that fed the dead conjunct is gone with it.

Removing the house gate changes what the window contains, so the statistic changed
with it. The (0, 200 W) window still admits small real loads, so the headline is now
the **p10 floor** rather than the median: on a night with three samples at the true
~45 W floor and seven on real load, a median publishes ~140 W of household draw as
inverter overhead. The trend is fitted to one floor per day rather than to raw
samples, so it tracks the inverter instead of how many small loads happened to land
inside the window that night. Day buckets are UTC on purpose — the plant runs on MST
(UTC−7, no DST), so a local 19:00→06:00 night falls inside one UTC date, while a
local-midnight bucket would split every night in two.

**The night-charge revert closed on a cloud ACK.** v1.79.0 established on the apply
side that an ACK is not an actuation, after a write the SHP2 never took scored a
phantom actuation and forfeited ~13 kWh. The mirror path kept the original bug: the
revert stamped `revertedAtMs` on the ACK, and because the revert branch is gated on
that stamp being null, the actuator then stopped looking at the panel entirely. A
restore the panel accepted-and-ignored left the reserve pinned at the raised target
with the ledger recording a clean, completed night — and that is the expensive end
state, because the panel holds the raised value as its floor and buys grid at on-peak
instead of discharging the pack the plan had just paid overnight rates to fill.
A reverted night now verifies against the device, retries twice, then escalates once
with a critical announce and a critical push naming the manual fix. A reading that is
*neither* the restore target nor the raised target is treated as the operator moving
their own floor: the actuator falls through rather than overwriting it.

**The message-rate collapse detector never sampled a silent device.** It iterated the
MQTT ingest counter map, which gains an entry only when a message arrives — so a
device that has produced zero messages since process start is absent from it and was
never sampled. The detector was armed for a 0.2 msg/min collapse and blind to a
0.0 msg/min one, and a restart is exactly what converts the first into the second.
Its own documentation calls the SHP2 "the single-point-critical alarm data source, so
a silent rate-collapse is a real blind spot"; a totally silent SHP2 was the one case
it could not see. Sampling is now driven from the device roster, so silence enters the
existing dwell logic as the rate-0 reading it is.

**The alert-telemetry exemplar described two different alerts.** A rollup's
`alertId`/`title`/`severity`/`category` are one tuple, always written together from a
single alert on the live path. The restart sidecar persisted three of the four, so a
replay restored the most recent member's title while taking the id from whichever
event came first in the JSONL window — routinely a different device.
`/api/alert-telemetry` published Core 3's title beside Core 1's id. The tuple is now
assembled in one function and persisted whole.

**A dead push channel reported no failures.** `lastPushFailures` was assigned *after*
the all-targets-failed throw. In the live single-target configuration that made the
assignment unreachable on the only path that can fail — with one target, 100% down is
the sole way to fail — so the field read `[]` both when the push channel was healthy
and when it was completely dead, beside `reachesAPhone: true`. It is the only
machine-readable push-health signal the add-on exposes.

**`/api/broadcast/status` named two of three speakers.** `sipTargets` arrived in
v1.25.0 and was threaded through dispatch and the log lines ("2 MA + 1 SIP") but not
through `status()`. The omitted target is specifically the redundant channel designed
to work when Music Assistant is down — which is exactly when an operator reads this
route.

**And v1.130.0 never actually shipped.** Its merge landed the code and the CHANGELOG
section but not the `config.yaml` version bump. `tag-release.yml` is paths-filtered on
that one file, so it was never evaluated: no tag, no image, no GitHub Release, and
Home Assistant kept offering 1.129.2 — while every workflow on `main` reported green,
because everything that ran did pass. The release did not fail; it silently did not
happen. A `Release v…` PR must now declare the version it names in `config.yaml` and
carry a CHANGELOG section for it, or CI fails (`scripts/check-release-pr.py`). The
check was verified against the tree that actually failed.

Sixteen mutants, 16/16 killed (`scripts/mutate-detector-honesty.mjs`), including an
exemplar reproducing each of the five shipped defects verbatim. A seventeenth was
written, run, and removed as provably equivalent rather than left standing as a
permanent survivor.

## v1.130.0 — what fifteen restarts did to the alarm telemetry

The 2026-09-04 release run shipped thirteen versions. Each restart was individually
cheap — ~7.5 s of downtime, no log-silence gap over 20 s, every boot polling inside a
second. Collectively they corrupted the counters the auto-silencer reasons over and
could void a night's held alarms. Four defects, all pre-existing, all amplified by
cadence.

**A restart was counted as a rising edge.** `recordRise` sits in the `if (!existing)`
new-alert branch, which on `firstRun` is reached for every currently-active alert. The
replay counter went 3862 → 4031 across the fifteen restarts: **+169 rises in 3.5 h
against +32 in the preceding 18 h**, a ~28× rate increase caused purely by restarting.
Rule 4 latches on rise volume against a low long-active fraction, so a restart pushes a
family toward auto-silence from both directions at once — it adds a rise and can never
add a longActive clear. Families on the two faulted Cores are already latched, and
`pack-defective-*`, the alert carrying the RMA evidence, is in the same population. The
durable onset sidecar already knew the answer: an id with a persisted onset from before
this process started is a re-track, not a rise.

**Episode durations were stamped from the in-memory `firstSeen`,** which every boot
re-stamps. A `backup-soc-40` episode continuously true from 17:55:07 is on record as
`raisedAt 19:45:14, durationMs 127883` — **128 seconds for a 1 h 52 m condition, a 52×
truncation** — because a restart landed 12 s before the clear. That understates the RMA
evidence trail, and worse, `neverClearedCount` is the only numerator holding a family
below Rule 4's threshold, so truncation turns a multi-hour episode into a "shortClear"
and accelerates auto-silencing. `alertOnset.ts` exists precisely to persist true onset;
`retireTrackedAlert` simply predates it.

**A quiet-hours hold spanning a restart was silently dropped.** With
`CRITICAL_BREAKS_QUIET_HOURS` off — the accepted live posture — the 06:00 digest is
the *only* delivery for anything firing between 23:00 and 05:00, criticals included.
v1.86.0 persists the queue and its comment asserts rehydration is sufficient; v0.97.0's
`pending` filter keys on an in-memory `queued` flag that rehydration does not restore,
and `bootSeedNotified` then marks the re-tracked entry notified. The alert came back in
the queue and could never re-enter `pending`. A restart inside the quiet window voided
the night. An entry still queued and still active is still held, whichever process
queued it.

**The digest sidecar never emptied on disk.** Every exit branch persisted and *then*
cleared `overnightResolved`, so all seventeen boots logged the identical "16
resolved-overnight record(s)" — including the five after a digest had been sent. A stale
id queued again on a later night while still active would appear in the digest twice,
stamped with clock times from a previous night. Clear now precedes persist in all three
branches.

**And the add-on now names its own build at boot.** After thirteen releases and fifteen
restarts, no line in its log could say which build produced any given behaviour; the
audit had to date the v1.124.x cutover by inferring it from an HA Core schema-validation
error. A log that cannot identify its own build cannot answer "did that fix take?" —
which is the only question that matters after a deploy.

Mutation-verified 6/6. Suite 2313/2313.

## v1.129.2 — a second smart panel now fails loudly, and three dead mutation harnesses

A second SHP2 is planned; it will carry the EV charger and the garage AC. The app
resolves ONE panel via `find(kind === 'shp2')`, so on the day panel #2 is energised its
Cores are absent from panel #1's `sources[]`, read as off-panel hardware, and — three
20-second ticks later, and again after every restart — every alert carrying their SNs is
stamped `annunciate: false`. No chime, no speech, no push, for every fault class except
overheating. That includes `dpu-err-<sn>`: the error-533 family that has already failed
on this plant.

An audit of all 20+ files found **75 singleton assumptions, 40 of them silent-safety**.
The full refactor is not in this release, because nothing is broken today and rewriting a
live alarm system for hardware that does not exist yet is its own risk. What ships is the
part that removes the SILENCE:

- **A critical `shp2-multi-panel` alert**, raised on STATE so it fires whenever the panel
  appears rather than needing anyone to be watching, and keyed on product identity as
  well as projection so it is already standing during the pre-hydration window in which
  the demotion streaks are accumulating. It is registered in `isNeverMutedAlert` and
  carries no SN in its id, so nothing can mute it.
- **The muting is disarmed while it stands.** Both mute lists derive from the membership
  model, and with two panels that model is known unsound — a Core is absent for a WIRING
  reason, not because it is bench hardware.
- **Supervised writes are blocked** — none of them pins the SN it writes to, so a
  wrong-panel write is a real hazard. The REVERT direction is deliberately still allowed:
  blocking an apply is fail-safe, blocking a revert would strand the pool at a raised
  reserve with a third of house capacity withheld during an outage.
- **The membership roster is now the UNION across every panel** (Phase 1), so "off-panel"
  means "on no known panel". Provably identical on a one-panel plant — a union over a
  one-element list is that element — which is why it is safe to ship ahead of the
  hardware. `findShp2` now pins the lowest SN instead of first-in-map, so which panel the
  singleton paths describe cannot change between restarts.

### Three mutation harnesses were dead, and nothing said so

`mutate-pool-membership` aborted on its first mutant from v1.117.0 until now: that
release split a one-line ternary into three lines, orphaning four of its six anchors.
`mutate-session-self-heal` and `mutate-telemetry-blind` were dead too — one anchor moved
into a new binding, one became ambiguous when its guard was duplicated. All three are
repointed and killing again (6/6, 8/8, 7/7).

The reason nobody noticed is that **CI never ran the harnesses**, and an aborted harness
reads exactly like a clean one. Running them in CI is too slow — each replays the full
2283-test suite once per mutant — but checking that their anchors still RESOLVE is nearly
free. `scripts/check-mutant-anchors.mjs` does that for all 85 anchors across 15
harnesses, and now runs on every push. A refactor that moves code out from under a mutant
fails CI instead of silently disarming it.
## v1.129.1 — the boot seed retried, and no longer silent

v1.129.0's islanded-load boot seed made one immediate attempt wrapped in an empty
`catch {}`. On the 2026-09-04 20:23 boot it emitted no log line at all and the plan
stayed on the legacy cushion band — and the swallowed error made it impossible to
tell whether the call had failed or never run. The analytics worker is cold at
boot, so a single immediate attempt was the wrong shape; and a diagnostic path
that hides its own failure is precisely the pattern this release series has spent
its time removing everywhere else.

The seed now retries at 0 s / 15 s / 60 s / 180 s, stops at the first success, logs
each failed attempt at debug, and says so plainly if it exhausts them — at which
point the 30-minute recompute tick carries it and the cushion falls back to its
legacy band, which is fail-closed, just less precise.

Suite 2295/2295.

## v1.129.0 — the four items that were actually still open

A 15-item sweep of the tracked open queue (2026-08-05 → 08-17) against v1.128.1,
each verdict given an adversarial second opinion. **Eleven were already fixed** by
releases in between — including both HIGH items, which is worth recording:
phantom actuation closed in v1.79.0 (the readback path; the live record shows
applied 22:55:14 → verified 22:56:14), and the false all-clear during drawdown
closed in v1.78.0 by `resolveHandoffOwner`. Four remained, all four fixed here.

**The second SHP2 (HIGH).** `shp2ConnectedDpuSns` resolved through a single
`find(kind === 'shp2')`, so a second panel simply would not exist: its DPUs would
be absent from the roster, `advanceOffPanelStreaks` would read them as off-panel,
and after three ticks their alerts would be demoted to `annunciate: false` — a
whole battery bank silently unmonitored, with no warning, no alert and no log
line. `find` also picks by device-list arrival order, so on a two-panel plant it
is not even stable which panel wins across a restart. The oracle now UNIONs
`sources[]` across every panel (`allShp2s`), which in one place repairs
`isShp2Connected`, `isExpectedOfflineSpare`, `isHomePoolDpu`, `homeCoreCoverage`,
`homeFleetMeanSoc`, `aggregateFleetFlow` and the off-panel annunciation demotion.
Single-panel behaviour is byte-identical, asserted by test.

**Runway coherence (MED).** The alarm could print "time to empty 1 h" beside
"time to reserve 20.5 h" — the pool drains *through* the floor on its way to
empty, so above the floor that pair is impossible. Usual cause is the empty
hysteresis latch holding a stale finite while reserve comes from the current sim.
`coherentRunwayPair` clamps reserve back to empty above the floor and leaves the
pair alone below it, where it is legitimate (the reserve detector only arms above
the floor, so under it the figure is the next crossing after a modelled recharge).
The repair is one-directional — it may only SHORTEN the runway, never lengthen it,
and never turns a finite projection into null — with a sweep asserting that.
`runwayPairClamped` surfaces on `/api/runway` so the repair is auditable.

**Quiet-hours inversion, residual (LOW).** v1.78.0 held owed resolves inside the
notify quiet window on the falling-edge path, but the once-per-boot orphan sweep
called `sendNotification` directly with no quiet check at all. That mattered more
after v1.124.0 made a resolve reach the phone for real: a restart inside the
window whose condition cleared while the process was down pushed
"Resolved: …" to the handset ten minutes after boot — the exact "good news wakes
you" inversion v1.78.0 closed everywhere else. The sweep now honours the same rule
and DEFERS rather than drops (it does not latch `orphanSweepDone` while holding).
The rule itself is extracted as `holdResolveForQuietHours` and finally has a test;
it had none, so a refactor could have reopened it with a green suite.

**Islanded-load durability (MED).** v1.125.1 populated the outage-cushion input as
a side effect of the `/api/ha-state` handler, so every restart dropped the cushion
back to its legacy flat band until something happened to request that route —
observed still `legacy-pct` more than an hour after the v1.128.1 deploy, and
unchanged across a three-minute probe after priming it, because the plan only
recomputes every 30 minutes. Safety-relevant sizing must not rest on an unrelated
route being hit. It is now persisted to a sidecar and seeded at boot, refreshed on
the same 30-minute tick that recomputes the plan consuming it, and seeded once at
startup. Staleness still fails closed at 6 h.

Mutation-verified 5/5. Suite 2293/2293.

## v1.128.1 — the twelve circuit sensors the rename did not reach

v1.128.0 renamed 84 entities and missed 12. Live-confirmed: 96 doubled names became
12, and the survivors were exactly the per-circuit energy sensors.

The circuit sensors are republished only when a latch signature changes, and that
signature was built from the *derived display name* — an intermediate. v1.128.0
changed the template **around** that name, not the name itself, so the signature was
byte-identical and the caller correctly concluded there was nothing to republish. The
rename never reached Home Assistant for those twelve.

The signature is now built from the string that is actually published. Any change to
what goes out — the template, a suffix, or the display name — necessarily changes the
signature. The regression test asserts that structural property directly: every
published `name` must appear in the signature. Mutation-verified 4/4, including a
revert to the derived name (this bug) and a revert to the raw channel name (the older
bug the code comment already warned about).

Entity IDs are unchanged, as in v1.128.0.

## v1.128.0 — entity names no longer repeat the device name

Home Assistant composes a friendly name as `${device.name} ${entity.name}`. The device
is "EcoFlow Panel" and every entity was *also* named "EcoFlow …", so the fleet rendered
as **"EcoFlow Panel EcoFlow Home Consumption"**. Forty of the entities exposed to the
house voice assistant read that way, and a spoken query had to say the whole thing:
*"what is the ecoflow panel ecoflow home consumption"*.

The alarm switches already had it right (`Alarms — Critical (P1)` renders as "EcoFlow
Panel Alarms — Critical (P1)"), which is what established the rule rather than guessing
at Home Assistant's behaviour. Eighty-four static entity names and the templated
circuit-energy name now follow the same convention.

**Entity IDs are unchanged.** Discovery entities are keyed on `unique_id`; all 84 are
byte-identical and the dedup version is untouched, so dashboards, automations, recorder
history and the Assist exposure list keep working. Only the displayed name changes. An
entity renamed by hand in the UI keeps that name, as before.

The regression test asserts the rule over the whole entity set rather than per entity,
because the defect is one entry disagreeing with its peers — which no single-entity
assertion can express. Mutation-verified 4/4, including a lowercase variant.

## v1.127.0 — a cost objective for the overnight buy

The night-charge advisor has only ever had one objective: hold the reserve floor plus
the outage cushion. It knew nothing about rates — no `cents`, `rate` or `tariff`
reference appeared anywhere in its sizing. `index.ts` already resolved the tariff to
pass the advisor a period *identity*, and discarded the price.

`ARB_OBJECTIVE: resilience | cost` (default `resilience`, unchanged) adds the missing
one.

**The measured economics.** Rates are configured and confirmed on this plant:
overnight 13.1 ¢/kWh, off-peak 17.0 ¢, on-peak summer 41.6 ¢, round-trip 0.86. A kWh
bought overnight delivers from the pack at 15.23 ¢, so it beats off-peak by **+1.77 ¢**
and on-peak by **+26.37 ¢**. Seven-day import is 453.89 kWh at $81.36 = **17.9 ¢/kWh
average** against a 13.1 ¢ window rate.

**The binding constraint is not money, it is sunlight.** Every rate beats 15.23 ¢, so
the naive answer is "always fill" — and it is wrong. A pack too full to accept the
morning's solar curtails it, and a curtailed kWh costs the full 15.23 ¢ paid for the
grid kWh occupying its place: **8.6× the weekend-carry gain.** So cost mode fills to a
ceiling, most-preferred first:

1. `fullKwh − morningPvSurplusP90Kwh` — room for tomorrow's P90 surplus.
2. `ARB_COST_MAX_SOC_PCT` (default 90) — a hard cap for when the forecast band does not
   reach window-end +14 h, which is exactly when that surplus reads null. The plan never
   fills to the brim merely because it could not check.

The two combine with `min`, so a present forecast can only ever lower the ceiling.

**Cost mode is bounded below by the resilience answer**, so switching objective can
never buy less or shrink the safety margin — the only direction it moves the purchase is
up. There is a test sweeping resilience targets and forecast states asserting exactly
that, and it is the mutant that dies first if the bound is removed.

Why this matters for the weekend: on-peak import is 0 on most days but was **22.89 kWh
on Fri 08-28** — the day whose charge window is truncated to one hour by the weekend
day-of-week boundary. At 41.6 ¢ against 13.1 ¢ that is roughly **$6 of avoidable on-peak
in a single Friday**, and it recurs weekly. Filling toward the ceiling on Thursday and
Friday is what carries the pack across a weekend that has no overnight window at all.

Mutation-verified 3/3. Suite 2274/2274.

## v1.126.1 — every GitHub Release has been shipping empty notes

The release-notes extractor in `images.yml` matched `^## <version>` against a
CHANGELOG whose headers are all written `## v<version>`. The `v` prefix meant it
never matched **any** release, so every GitHub Release ever cut by this pipeline
carried the `_(see CHANGELOG.md)_` placeholder instead of its notes. Nothing failed,
which is exactly why it went unnoticed.

- The pattern now accepts an optional `v`.
- A missing section **fails the job loudly** instead of falling back to a placeholder.
  A silent default is how this hid; shipping a Release with no notes should not be the
  quiet outcome of an authoring mistake.

Also backfilled: v1.120.0 through v1.125.1 were released during a single long session
and never got CHANGELOG sections at all — they were documented in DOCS.md and in their
pull requests, but not where the release pipeline looks. Nine sections written, and the
nine GitHub Releases re-published from them.

The repository description now mentions companion-app push, since v1.124.0 made that a
real delivery channel rather than a drawer card.

## v1.126.0 — dead code removed, documentation caught up

Housekeeping after the v1.120–v1.125 run.

**Dead code.** A fresh unused-export sweep over `server/src` found 8 exports of
1,212 referenced nowhere — including in tests and `scripts/`. Seven were removed;
`saveModel` was kept because `scripts/train-pack-risk.ts` uses it, which the first
pass missed by scanning only `src` and `test`. Re-scan: **0 unreferenced of 1,205.**

- `ALARM_RUNG_ORDER` (alertPriority) — derived constant nothing read.
- `offsetAdoptedAtMs` (clockOffset) — observability accessor with no consumer.
- `__resetHaStateCache`, `resetPollState` — test seams no test used.
- `getLastKnownRoster` (index) — superseded by the v1.121.0 membership publisher.
- `getLastKnownHomeRoster` (shp2Membership) — added in v1.121.0 and never called;
  dead on arrival. Its `set`/`reset` siblings are used and stay.
- `nightChargePlan` (telnet/dataProvider) — a thin wrapper over
  `nightChargePlanIfFresh`, which is the one actually used.

**Documentation.** DOCS.md still described the ntfy / Pushover / webhook channels
that v1.124.0 deleted — including a config table listing five options that no longer
exist and a severity→priority map for transports that are gone. Rewritten to describe
what actually ships: the HA drawer card, the `notify.mobile_app_*` push, and the
critical-only Do-Not-Disturb payload. The v1.123.0 section that told the reader `ha`
cannot reach a phone now carries a superseded-by marker rather than standing as a
contradiction. README gained the notification model and the re-scoped outage cushion.
Stale comments in `alertMonitor.ts` and `alertPriority.ts` referring to the deleted
priority maps were corrected.

Not touched: `dead-code-inventory-2026-07-27.md` and
`night-charge-write-path-proposal-2026-07-31.md` at the repo root are matched by
`.gitignore` (`/*-inventory-*.md`, `/*-proposal-*.md`) and are deliberately local
working documents, not repository content.

No behaviour change. Suite 2263/2263.

## v1.125.1 — size the cushion on the representative load, not a spot reading

Live verification of v1.125.0 caught its own calibration error. The shipped plan
reported `cushionKwh: 50.7`, which back-solves to an islanded load of 3.97 kW — while
the release had been calibrated against 1.445 kW.

Both readings were real. Panel load swings ~3x across a day (1,445 W at 00:50 MST;
3,971–4,038 W the same evening), so reading it instantaneously made the cushion, and
therefore the nightly purchase, depend on *when* the plan happened to run — and the
sample used was a quiet-hour trough.

The basis is now the 7-day mean: `selfCons.loadKwh` is already the SHP2 `panel_load`
energy over seven days and is fetched on the HA-state path anyway, so it costs nothing.
**751.36 kWh / (7 × 24) = 4.47 kW.** The cache goes stale after 6 h, falling back to the
legacy cushion rather than sizing against a figure nobody refreshed.

Defaults recalibrated against what the plant can reach. The charger delivers at most
7.2 kW × 6 h = 43.2 kWh, so from a 25% evening SoC a clean night reaches ~72%. Eight
hours at 1.5x needed **78%** — a different permanently-true flag, which is the bug the
re-scope exists to remove. **Four hours at 1.25x needs ~42%**: reachable on a clean
night, missed when the EV contends for the grid input. A test pins the default inside
the reachable band in both directions.

The honest headline: this plant carries its protected panel for about **four hours** at
a typical post-charge state, not a day.

## v1.125.0 — the outage cushion, re-scoped to something reachable

`ARB_OUTAGE_CUSHION_PCT` was a flat 15% of pool tested against a grid-blind forward
simulation that runs the **whole house** off the battery for the entire remaining 25–49 h
forecast. On this plant that is P90 load 156–185 kWh/day against a 92.16 kWh pool, so the
trough hit zero 1–8 h after window close on **7 of 7 nights** and `cushionShortfall` was
pinned true by arithmetic. Being a constant, it silently exempted every night from three
mechanisms at once — the under-buy pool, the buy de-bias learner, and the engine-fault
strike detector.

The model described something the hardware does not do. When the grid drops the SHP2
carries its **backup circuits**; the rest of the house is dead. Measured live:
`panel_load_watts` 1,445 W against `runway_recent_load_watts` 4,863 W.

The cushion is now `outageHours × islandedLoadKw × safetyFactor / dischargeEff`, tested
against the pack at window close. New options `ARB_OUTAGE_CUSHION_HOURS` and
`ARB_ISLANDED_LOAD_SAFETY` (monotone the **strict** way — raising it buys more). No PV is
credited: an outage can begin at dusk.

**Fail-closed**: with no islanded measurement the legacy band *and* the legacy
whole-house trough both stand; the pair is never mixed. The whole-house trough is still
disclosed as `minProjSocPct`.

Mutation-verified 3/3, including the bridge bug this change hit:
`buildNightChargeInputs` destructures field-by-field, so inputs added to both interfaces
still arrived `undefined` and took the legacy path. Only the end-to-end test caught it.

## v1.124.2 — wire the notify options to the process, and guard the bridge

v1.124.0 shipped `NOTIFY_HA_PUSH_TARGETS` and `NOTIFY_CRITICAL_BYPASS_DND` into the
schema, the config UI and the code — but not into `rootfs/etc/services.d/ecoflow-panel/run`,
which is what turns an add-on option into an environment variable. The option was stored
correctly and the server saw nothing: `/api/notify/status` reported `pushTargets: []` with
the target sitting in the add-on config.

Nothing in the build could catch it — TypeScript cannot see a shell script, and every unit
test passes because it sets `process.env` directly. The suite was green. It surfaced only
from checking the *feature* on the live system.

Second occurrence of this shape (v0.33 shipped a keybinding wired everywhere except the
literal that reaches production), so the fix includes guards for the class: every schema
option must be exported or explicitly exempted; the run script must not export keys the
schema no longer declares; and `NOTIFY_CRITICAL_BYPASS_DND` must use the `1/0` convention,
because this file uses two and `notify.ts` reads `!== '0'` — exporting `"false"` would read
as **true** and silently keep the DND bypass on.

## v1.124.1 — the Spanish config UI, and a local guard for it

v1.124.0 updated `en.yaml` but not `es.yaml`, so the Spanish config UI would have shown
five descriptions for options that no longer exist and the raw KEY as the label for the two
new ones. The repo's own `validate-addon-config` caught it in CI.

The real mistake was merging past a red CI: the merge step ran unconditionally after the
polling loop instead of gating on the conclusion, so a check doing its job exactly right was
bypassed.

New test `EVERY language file tracks the schema — not just English` walks schema keys
against every `translations/*.yaml` in both directions. The local suite passed 2244/2244
while `es.yaml` was broken; it now fails, verified by deleting a key and watching it go red.

