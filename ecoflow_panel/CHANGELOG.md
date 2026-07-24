## v1.47.2 — second-pass fixes: ALM column regression, remote-access origin gate, CSI parsing, display width

A second QA pass (adversarial re-verification of the v1.47.1 fixes, parser
fuzzing, live concurrency/soak, and an end-to-end browser-transport drive)
produced nine findings; all are addressed.

- **ALM message column, completed** — v1.47.1 adapted the wrap width but left
  the prefix hard-coded at column 65, clipping the first message segment's
  tail at 66–88 cols (a regression at the standard 80×24) and hiding it
  below 66. The prefix now compresses to end exactly at the adaptive column,
  so the first segment renders in full and aligns with its continuations.
- **Remote-access origin gate** — the `/console/ws` upgrade rejected the
  legitimate remote paths: Nabu Casa origins (`https://<id>.ui.nabu.casa`)
  and any reverse-proxied or portless LAN origin failed the strict
  `:8123`/`:8787` requirement. Private-range hosts now match on any (or no)
  port, and Nabu Casa remote is allow-listed; arbitrary internet origins
  still do not match.
- **Variable-length CSI parsing** (both transports) — Delete/Home/End and
  modified arrows leaked printable tails (`~`, `;5C`) into the session: a
  screen-hotkey digit could switch screens, and at the login prompt a leaked
  character silently corrupted the credential. Full CSI sequences are now
  consumed; arrow finals still navigate.
- **Dangling-subnegotiation wedge** — an unterminated `IAC SB` held the whole
  telnet input stream hostage (including `q`/`Ctrl-C`) while resetting the
  idle reaper. The wait is now bounded at 64 buffered bytes.
- **Wall-display keepalive** — the browser console sent no traffic while
  passively watched, so the 5-minute inbound idle timeout closed it (and,
  with a password set, dumped it at the login prompt on reconnect). The
  client now pings every 60 s; the server recognizes the ping.
- **Display-width-aware layout** — `visLen`/`truncate`/`padEnd` now count
  CJK/fullwidth/emoji as two columns and combining marks as zero, so
  user-set EcoFlow device or circuit names outside ASCII no longer smear
  aligned layouts. Double-width glyphs are kept whole or dropped, never split.
- **Liveness ticks on ALM/BUS** — the two fully-static screens gained a
  wall-clock in their banner, so a healthy quiet screen and a dead link are
  no longer byte-identical.
- **Untypeable-credential warning covers both transports** — it fired only
  when telnet was enabled, yet `/console` (always registered, and telnet
  ships disabled by default) enforces the same login.
- Documentation corrected: the console is credential-gated when
  `TUI_PASSWORD` is set (two sections still said "unauthenticated"), and the
  shipped `TELNET_ENABLED` default is `false`.

Tests: 1,699 green (new: ALM first-segment alignment, CJK width, CSI-leak
cases, origin-gate remote/portless/Nabu-Casa coverage).

## v1.47.1 — console full-pass fixes

A four-angle QA pass on the v1.46.0 console (adversarial code review,
rendering fuzz across sizes and degenerate data, a live interactive session,
and a raw-TCP auth transport probe) produced ten findings; all are addressed.

- **ALARM message column adapts below 90 cols** — the fixed 65-col offset left
  zero visible message text on 60–64-col terminals; at least ~24 message
  columns now always survive.
- **Narrow annunciator folds instead of dropping** — when the tile roster
  doesn't fit, hidden groups fold into the last visible window (lit at the
  highest folded severity), preserving the no-alarm-group-ever-unlit invariant.
- **GEN pack index resets on DPU change and clamps in the renderer** — a
  2-pack unit after a 5-pack unit rendered "Pack 5/2" with no highlighted row.
- **Segment-split CRLF no longer double-enters** — a chunk-final CR now
  swallows the LF/NUL arriving in the next TCP segment (at the login prompt
  the double enter submitted an empty password and burned an attempt).
- **NAWS IAC-escape unescaping** — a dimension byte of 255 no longer shifts
  the payload and misparses the window size.
- **Credential compare is branchless across fields** — both compares always
  run, closing a username-validity timing oracle the short-circuit re-opened.
- **Untypeable-credential guard** — the login prompt only accepts printable
  ASCII ≤ 64 chars; a configured credential outside that envelope now logs a
  loud startup warning (and the option help documents the envelope) instead of
  guaranteeing a lockout.
- Footer legend corrected (`TAB next` — the chooser it referenced is gone);
  dead `trendStrip` export removed; stale comment references to deleted
  modules updated.
- New coverage: raw-TCP telnet auth integration suite (real IAC negotiation,
  BS/DEL editing, q-at-prompt, 3-failure disconnect) plus render regressions
  for the three visual fixes.

## v1.47.0 — remove the HACS Lovelace card family

The Lit card bundle (`lovelace/` — seven cards plus shared infrastructure,
~1.9 MB committed source and dist artifacts) is removed, along with the
`/lovelace/*` static route and its Dockerfile copy. Rationale: the cards
duplicated the ingress web dashboard; the one deployment consuming them had
long since pinned a stale CDN snapshot rather than the served bundles; and the
route was an unauthenticated, CORS-open static surface. Removal shrinks the
image and the repository, and deletes an entire card build toolchain from the
maintenance surface. Historical card documentation remains available in
pre-v1.47.0 tags.

## v1.46.0 — single-console TUI: operator login, large-format graphics, chooser and Summary console removed

The terminal UI consolidates to **one interface**. The v0.9.13 mode chooser
and the legacy Summary console (`telnet/screens.ts`) are removed; every telnet
and `/console` session lands in the SCADA-style console. One theme to
maintain, and the full terminal is spent on the console itself. TAB now cycles
console screens.

**Operator login.** New `TUI_USERNAME` / `TUI_PASSWORD` options (schema
`str?` / `password?` — the password is masked in the options UI). With a
password set, every session starts at a login prompt shared by both transports
(the state machine lives in the transport-agnostic session driver): masked
password echo, backspace editing, TAB field switch, constant-time credential
comparison (SHA-256 + `timingSafeEqual`), three failed attempts disconnect,
and `q` is typeable at the prompt (`Ctrl-C` still always disconnects).
Brute-force is bounded twice: three attempts per connection, plus a
cross-session sliding-window throttle (10 failures / 10 minutes across both
transports) that refuses further submits outright while saturated. An
empty password leaves the prompt off — opt-in, matching the notification
channels — and the option help notes that classic telnet is unencrypted, so
this is LAN-level access control, not transport security.

**Large-format graphics.** Two new pure primitive modules:
`telnet/bigfont.ts` (5-row pseudo-LCD block font) and `telnet/gauges.ts`
(eighth-block `hbar`, eighth-height `vscale`, 2×4-dot `braille` sparklines,
3-row ISA-annunciator `tile`). Screen placements are width/height-adaptive and
degrade to the previous rendering on small terminals: CONSOLE gains a
big-digit headline band (fleet SoC / PV kW / LOAD kW, ≥ 96×32) and an
always-on full-width POOL gauge; TRENDS strips become full-width braille
sparklines; ALARM gains a 7-window annunciator header (lit red/yellow by
severity, dark windows stay visible); GEN pack rows gain SoC bars.

Both input parsers now emit `backspace` (BS/DEL). Tests: 1,683 green
(bigfont 6, gauges 39, login/session flows, per-screen frame invariants at
80×24 / 100×40 / 120×40).

## v1.45.0 — alarm-delivery resilience: chime-only fallback, spoken retry, pressure dwell, top-of-charge quiet

Ground truth for every change: 2026-07-23. The nightly Home Assistant backup
(docker image exports, ≈04:58–05:02) saturated host I/O at the moment quiet
hours ended; the resulting host-pressure critical triggered a red broadcast
whose spoken render failed on both passes — and the broadcast was skipped
entirely, delivering NO audio for a red condition. The same morning, the
fleet's first full grid top-up in weeks produced transient warn-band cell-spread
alerts on 14 of 15 packs.

**Chime-only render fallback.** A spoken-render failure no longer skips the
broadcast: the announcement falls back to a chime-only render (cached, no
Wyoming dependency) so the klaxon always sounds. The failed render stays in
`lastRender`/errors (outcome `partial`), and the fallback never touches the
`tts-render-degraded` failure counter — only a fresh spoken render success
resets it.

**One spoken retry.** A render-failed condition broadcast schedules a single
spoken retry 90 s later — past the stall window — re-checking that the
condition level is unchanged, broadcasts are enabled, and quiet hours permit.
The retry bypasses the storm gate (an intentionally identical message) and is
never repeated: a second consecutive failure is the `tts-render-degraded`
alert's job.

**Host-pressure crit dwell.** The host-pressure CRITICAL (and its red
broadcast) now requires crit-level pressure to sustain for 180 s
(`HOST_PRESSURE_CRIT_DWELL_S`, 0–900). Observed episodes — boot load, store
refresh, nightly backup — each lasted 1–3 minutes and are real pressure but
not red-klaxon events; they surface immediately as the warning instead.
QoS/degraded-mode keys on the raw assessment and still engages instantly.

**Top-of-charge quiet for warn-band cell spread.** Warn-band (24–49 mV) cell
imbalance on a pack at ≥ 95% SoC (`VOL_DIFF_PLATEAU_QUIET_SOC_PCT`) is now
`annunciate: false` — visible in every UI, no push. The v0.58.0 plateau
machinery already relaxed the critical; the warn band was still pushing on the
expected LFP top-of-charge signature. Below 95% the standard annunciation
re-arms; the plateau-critical ceiling (90 mV) still annunciates.

**`errorCodeNum` is a code, not a count.** `SHP2 slot 3 reports 533 errors`
misread the field: the value is the source device's error code (proven live:
slot 3 read 533, byte-identical to Core 3's own `sysErrCode`, 5xx battery/BMS
band). Now reads `reports error code 533 (battery/BMS protection band)`.

Tests: 1,671 green (dwell state machine, plateau-quiet bands, code wording).

## v1.44.0 — TTS render-failure self-alert (dead-voice detection)

The render cache creates a blind spot: a wedged TTS engine (a Home Assistant
Core update can kill the Piper add-on's Wyoming socket while the add-on still
reports `started`) renders nothing, yet previously-cached WAVs keep playing —
the alarm's voice can be dead for days while repeated announcements still sound
normal, surfacing only when a changed message forces a fresh render.

**Fresh-render health tracking.** `audioRenderer.ts` now counts consecutive
failed render requests (a request fails when every spoken pass fails), retaining
the last error and timestamp; a successful fresh render resets the counter.
Cache hits never touch the counter in either direction — a cached WAV proves the
file exists, not that the engine is alive.

**`tts-render-degraded` alert.** A warning (Connectivity/System) fires at ≥ 2
consecutive failed fresh renders — one blown render is tolerated as transient —
and self-resolves on the next successful render. The alert reports the failure
count and last error, notes that critical chimes still deliver while speech is
dropped, and names the remedy (restart the Piper add-on).

Pure-state-machine coverage for the health holder (accumulate / threshold /
reset / snapshot isolation). No behavior change to the render path itself.

## v1.43.0 — co-tenant degradation defense: self-vitals + out-of-band heartbeat

The alarm shares its host with other add-ons; this release defends against
the failure mode where a CO-TENANT (not the alarm itself) degrades the host —
leaking memory, spinning CPU, filling the shared disk — and the alarm's
performance erodes with it.

**In-band self-vitals.** Four pressure dimensions, each null-honest when its
source is unreadable: event-loop lag (500 ms drift probe, EMA + 60 s max —
the direct "this process is being starved" signal), MemAvailable, data-disk
free space, and 1-minute load. Pure per-dimension hysteresis rolls into one
assessment surfaced as four HA diagnostic sensors, a `/api/health` field, and
a single rolled `host-pressure` warning/critical alert naming every pressured
dimension with its value. Under a critical assessment, alarm-first QoS pauses
discretionary analytics ticks so remaining CPU serves the
poll → alert → broadcast path.

**Out-of-band dead-man heartbeat.** An optional HTTPS ping to an external
heartbeat receiver (`HEARTBEAT_URL` + `HEARTBEAT_INTERVAL_S` add-on options;
healthchecks.io-style) sent from boot on a jittered interval. When the pings
stop — host dead, container killed, power lost — the external service
notifies the operator from outside the failure domain: the one alarm channel
that does not share fate with the host. Inert when unconfigured; https-only;
the URL is never logged; send failures are local information only and raise
no alerts (the external grace period makes the dead-man decision).

19 added regression tests (1,663 total).

## v1.42.0 — alarm-host thermal monitor + baseline regime-shift absorption

Implements the two build items from the stack health-and-headroom review.

**Alarm-host thermal monitor.** The add-on now monitors its own host: the SoC
temperature is sampled from the kernel thermal zones every 60 s and surfaced
as an HA sensor (`ecoflow_host_soc_temp`, diagnostic; trend history via the
Home Assistant recorder) plus hysteresis-guarded alerts — warning at 78 °C and
critical at 84 °C (env-overridable), the critical sitting just below the ~85 °C
throttle point because throttling degrades the alarm pipeline exactly when
extreme ambient heat makes it matter most. Hosts with no readable thermal zone
read null and never alert.

**Self-baseline regime-shift absorption.** The rolling 14-day hour-of-day
baseline absorbs a persistent behavior change in ≈ 7 days; until then the
change re-fired "unusual for the hour" alerts on what is plainly a new normal
(observed: 215 info alerts over a two-zone AC duty swap). A trailing-days
detector now recognizes ≥ 5 consecutive same-direction days, states the
situation in the alert ("a new normal pattern the rolling baseline is
absorbing, ~N day(s) to full absorption"), and silences annunciation until
absorption completes. Direction reversals or under-floor days break the streak
and restore normal annunciation.

7 added regression tests (1,644 total).

## v1.41.0 — cell-level fault forensics in battery alerts

Battery fault alerts now carry detection → isolation → root cause with
supporting ranges, assembled from telemetry the engine already collects.

- **Cell isolation.** Cell-imbalance alerts (`vdiff-crit`/`vdiff-warn`)
  identify the exact deviant cell in the 32-cell string — index, voltage,
  signed deviation vs the pack median (negative = weak/low cell) — with the
  pack's spread and the sibling packs' spreads (typically 3–5 mV) as
  supporting ranges. The critical's detail names the isolated cell; the full
  dossier renders as alert facts, formatted for direct use in an after-sales
  ticket.
- **BMS protection-latch classification.** A three-legged signature (pack
  SoC-stranded ≥ 20 points below the sibling median, exchanging < 25 W, while
  siblings flow ≥ 100 W) classifies a pack as protection-latched. Shared
  idleness never classifies. `Packs out of balance` names the lowest pack and
  states the flow contrast when the signature holds.
- **Error-code band titling.** `dpu-err` alerts for codes 500–599 present as
  "Battery protection fault" (battery/BMS protection band) rather than the
  blanket "Inverter error code" that previously mis-pointed triage at the
  wrong subsystem; when a pack shows the latch signature the alert names the
  probable source pack. Alert ids are unchanged, so standing faults do not
  re-raise on upgrade.

All helpers are pure, unit-tested, and emit null when per-cell telemetry is
absent. 7 added regression tests (1,637 total).

## v1.40.0 — storm-alert continuity, plan-capture resilience, subsystem observability

**Storm alerts survive NWS product updates.** The active-alerts query now
requests `message_type=alert,update`. NWS delivers upgrades (Watch → Warning)
and routine continuations as `Update` messages that supersede the original
`Alert` in the `/alerts/active` feed; the previous `alert`-only filter dropped
every product from the feed at its first update, silently clearing the
pre-charge advisory while the hazard still stood. Storm alert ids now key on
the event name rather than the per-message NWS URN, so a product's lifecycle
of updates presents as one continuous alert (the message URN remains in the
alert facts). One added query-pin regression test.

**Night-charge plan capture no longer depends on a single 90-minute liveness
window.** The freshest pre-window plan (with its ledger extras) is persisted
to disk on every recompute; if the evening job's 21:30–23:00 record window is
missed (restart, update), the next run records the persisted plan with its
original `generatedAt` — converting a previously unlearnable missing night
into a recorded one. Timestamps are never backdated.

**Observability.** The night-charge subsystem now logs one info line per
nightly lifecycle event (plan recorded / no plan with reason / snapshot
recovery); per-device quota-fetch failures (e.g. EcoFlow API code 1006 on
unsupported device classes) log once per session instead of failing silently.
Comments asserting a "daily host power-cycle" are corrected — the host is
verified stable; restart-resilience remains (add-on updates restart the
process). 1,630 tests green.

## v1.39.1 — hotfix: readiness could serve null on ICU-limited hosts

The night-charge gate's date helpers derived YYYY-MM-DD via the `en-CA`
locale shortcut. On Node builds whose ICU lacks that locale, the format falls
back to a non-ISO shape; `addDaysYmd` then constructs an Invalid Date and
`toISOString()` throws inside fail-safe catches, leaving the write-readiness
state permanently null while full-ICU hosts pass all tests.

- `phoenixYmd` now builds the date from `en-US` `formatToParts`
  (locale-fallback-proof; matches the repository's other Phoenix-time helpers).
- Strict-ISO parse guards: the date helpers can no longer throw.
- The three previously silent readiness catches log at debug level.
- One added regression test pins the strict ISO output shape (1,629 total).

## v1.39.0 — night-charge engine repair: completion-gated scoring

An adversarial review of the v1.37.0–v1.38.3 night-charge stack confirmed 18
defects (4 high); a second adversarial pass over the fix itself confirmed 10
more. All 28 are corrected in this release. The central repair: nightly
outcomes were captured by the first 30-minute tick after midnight — while the
charge window was still open — and an idempotence latch froze those truncated
actuals into the never-pruned ledger, so the write-readiness gate could never
accumulate a scored night.

**Scoring correctness**
- Completion gate: a night is outcome-captured only ≥ 16 h after its REAL
  charge-window close. Each plan's resolved window is now frozen into the
  ledger (`window_start_ms`/`window_end_ms`, idempotent migration) and the
  scorer, completion gate, and boot repair all pair actuals to it — weekend
  plans resolve windows disjoint from the canonical 23:00–05:00 night (a
  Saturday plan's window is Monday 00:00–05:00 under the hour-weekday tariff
  model). Rows recorded before the window columns existed capture honestly as
  `scored=0` (unpairable), never cross-span.
- Backfill scorer sweeps 60 days of uncaptured rows on every tick (matching
  the premature-capture repair window); nights whose telemetry has aged out
  capture with null actuals rather than fabricated zeros.
- Boot repair: outcomes captured before their night completed are reset once
  and re-scored by the backfill with full-span actuals where telemetry exists.
- SoC min-scan applies a median-of-3 filter, rejecting the single-sample
  transient-zero artifact a cloud reconnect can emit (which would otherwise
  fabricate a hard under-buy verdict in the gate's evidence).

**Sizing correctness**
- Mid-window recomputes credit only the REMAINING window
  (`max(windowStart, now)`) in the charge-power cap; the pre-fix full-window
  credit could present an undeliverable buy as fully meeting the cushion.
- EV block strip/re-add is atomic per hour — embedded EV load is stripped
  only where the worst-case block is actually re-added; degenerate
  `EV_MAX_LOAD_W` (≤ 0/NaN) disables placement instead of stripping.
- Simulations include the in-progress hour (conservative direction);
  non-finite floor/cushion/efficiency inputs fail closed to a null plan.
- Weekend/far windows: the plan carries pre-window carry fields
  (`projSocAtWindowStartPct`, `preWindowMinSocPct`) and day-qualifies window
  display strings ≥ 24 h out; mid-window recomputes null these fields rather
  than emitting a false "before the window opens" statement.

**Gate correctness**
- The MNAR exclusion denominator counts EXPECTED nights over the trailing
  in-season range, so missing rows (downtime, SHP2 offline) count as
  exclusions instead of silently shrinking the denominator.

**Ops/robustness**: evening-job re-entrancy guard; boot warm path repairs +
scores + recomputes readiness; recent-outcomes mirror refreshes on every
write path; `NIGHT_CHARGE_NOTIFY_HOUR` is clamped to 22 in code (23 made the
send window empty; the config schema remains 0–23 so an existing stored 23
cannot fail add-on validation); Release pdf attachment requires a non-empty
file; README corrections (cmdId 1/2/4/21/28, entity count). 23 added
regression tests (1,628 total).

## v1.38.3 — changelog: keep the HA panel fast (recent releases only)

The add-on's CHANGELOG.md had grown to ~50 versions / ~745 KB, which the Home
Assistant add-on panel renders in full — slow to load. This keeps the **20 most
recent releases** here (what "what changed lately" needs) and moves the older
history, unabridged, to `ecoflow_panel/CHANGELOG-ARCHIVE.md`. Nothing is lost:
the archive holds every prior entry verbatim, and each version also keeps its own
notes on the GitHub Releases page. Docs-tooling only — no add-on code change.

## v1.38.2 — release docs: ship a .pdf alongside the .docx

Every GitHub Release now carries the full documentation as BOTH `.docx` and
`.pdf`. The PDF is a faithful render of the exact same document (README +
SECURITY + the full DOCS.md engine reference, same generated table of contents
and page breaks) produced by LibreOffice headless from the `.docx` — no LaTeX
toolchain. The per-PR "Build documentation" check now builds and uploads both
formats (`if-no-files-found: error`), so a DOCS.md or toolchain change that
can't produce a PDF fails the check rather than silently shipping a release
without one; the Release-time PDF stays best-effort (a transient LibreOffice/apt
hiccup can't turn a good release red). Both files are attached at
`gh release create` per the immutable-Releases rule. Docs-tooling only — no
add-on code change. (Existing releases keep just the .docx: immutable Releases
seal assets at creation, so the PDF starts from this version forward.)
## v1.38.1 — night-charge status route: no per-request DB read (CodeQL CWE-770)

Follow-up to v1.38.0. CodeQL (js/missing-rate-limiting) flagged the
`/api/night-charge/status` handler for a per-request filesystem read
(`recorder.readNightLedger(7)` — a SQLite query). The route now serves
`recentOutcomes` from an in-memory cache (`nightRecentOutcomesMem`) refreshed by
the background recompute tick / evening job (timers, not rate-limited request
handlers) — matching how the other read endpoints serve worker/holder data
rather than hitting the DB inline. Also removes the incidental latch-file read
from the same handler (in-memory mirror, from the v1.38.0 fix). No behavior
change to the advisory; 1610 tests green, tsc clean.
## v1.38.0 — night-charge advisory stack: learning, delivery, gate (advisory-only, NO writes)

The full advisory-v1 of the TOU night-charge arbitrage feature — built as one
release across five subsystems (parallel build over disjoint files, then
integrated + whole-stack adversarially reviewed). **Advisory only: the feature
issues NO device commands and never touches the floor/runway/SoC alarm spine.**
It reads the same `backupReserveSoc` the floor alarm defends and produces no
state the alarms consume.

**What it does now.** Every ~30 min (and once at ~21:30 America/Phoenix) it
computes tonight's recommended overnight buy — "buy N kWh → target SoC X%" —
sized to hold `reserveFloor + outageCushion` from the cheap-window close to the
next cheap window, and surfaces it on: a `night_charge_*` HA sensor set (7
entities, LWT + `expire_after` so a dead advisor never leaves a stale
`charge_tonight=ON`), a ~21:30 push notification (charge / hold /
insufficient-basis), `/api/night-charge/status`, a web card, and a TUI
TONIGHT'S PLAN block. Your HA automation gates on `charge_tonight` **AND**
readiness **AND** the published window — never `charge_tonight` alone.

**Learning from night one.** A durable, never-pruned SQLite ledger
(`night_charge_ledger` + `night_charge_calibration`) records each night's
prediction and, the next evening, its measured outcome + forecast-accuracy
scores. A **write-readiness gate** (`nightChargeGate.ts`) reduces that ledger to
`LEARNING | READY_TO_CONSIDER_WRITES | BLOCKED` + a "what's blocking" list — a
pure, fail-closed predicate gating ONLY on physically-measured accuracy (zero
plan-trajectory floor-breaches, under-buy rate, PV/load MAE+bias, band coverage,
forecast-basis; out-of-sample, autocorrelation-adjusted effective-N). It stays
LEARNING until genuine clean nights accrue — the intended earn-the-write posture.
No write path is built; the dormant CHARGE_TIME_TASK probe stays deferred (§6).

**Config.** Cushion %, min-buy, charge-cap kW, load-P90 factor, notify hour/minute,
notify-on-hold, and the APS **R-EV rate fields** so you can enter effective
¢/kWh — until confirmed, every dollar figure emits null (never a fabricated rate).

**Whole-stack adversarial review (18 agents) confirmed 9 findings — all fixed
+ regression-tested before ship:**
- **HIGH under-buy — EV de-dup was not atomic:** the embedded expected-value EV
  was stripped from the load unconditionally but the committed p90 block re-added
  only if the separate EV report survived — on a real charging night with a sparse
  session history the EV load vanished from the basis → under-sized buy (a safety
  miss). De-dup is now atomic: strip only when the block will actually be placed.
- **HIGH under-buy ×2 — weekend/storm horizon truncation:** `nextRecharge` was the
  first hour where CENTRAL pv≥load, so a single transient sunny hour (or a P50
  crossing the P10/P90-sized trough would still drain through) truncated a Fri→Mon
  carry and hid the Sat/Sun-night troughs. Now the horizon runs to the next
  cheap-window START (tariff-based, deterministic) — the full weekend is simulated.
- **HIGH — write-readiness gate was permanently inert:** the ledger stores
  `algo_version` as TEXT but the gate compared it numerically, so every persisted
  night was excluded and the gate never left LEARNING. Now string-compared, with
  an end-to-end round-trip test through the real recorder.
- **HIGH gate-false-safe — floor-breach only counted coverage-scored nights:** a
  would-have-breached plan on a propped/low-coverage storm night (the adverse
  night the gate exists for) didn't block. Now every forecast plan-night with a
  breach verdict blocks, coverage-excluded or not.
- **MED — outcome scoring was coupled to the notify window** (a missed 21:30 job
  dropped the prior night, an MNAR bias): scoring + readiness now also run on the
  recompute tick and the cutoff branch, idempotently.
- Plus 3 lower-severity (beyond-24h EV double-count → bounded to the band region;
  window_start truncation during a mid-window recompute → back-scan to the true
  start).

1610 server tests green (+all subsystem + regression tests), tsc clean both
packages. Nothing calls a write primitive; the ledger begins accumulating the
accuracy record immediately so the write decision can be judged on real history.
## v1.37.0 — night-charge advisor: the pure sizing brain (increment 1)

First increment of the TOU night-charge arbitrage feature (design:
`docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md`). Ships **only** the dependency-injected
sizing math — `server/src/nightChargeAdvisor.ts` `computeNightChargePlan()` —
wired to nothing, exactly as `tariff.ts` (v1.36.0) shipped its model with zero
live surface. The recommendation is provable entirely by unit tests before any
I/O, holder, endpoint, HA entity, evening job, ledger, or write path touches it
(those are later, separately-attributable releases).

**What it computes:** on a night a shortfall is anticipated, the kWh to buy in
the cheap overnight window and the target SoC%, sized so the projected pool
trajectory holds `reserveFloor + outageCushion` from window-close through the
next recharge.

**Accuracy & safety posture (binding):**
- **Under-buy is a SAFETY miss, not a cost miss** — the outage cushion is the
  owner's explicit resilience requirement. Sizing uses **worst-case inputs**:
  P10 (low) PV and P90 (high) load. The over-buy *ceiling* uses P90 (high) PV —
  the deliberate asymmetry so we never under-buy the floor yet never over-buy
  into next-morning clipping.
- **Emit null over a fabricated number** — incomplete / incoherent / thin /
  climatology-only basis, no window, or zero capacity all yield a null plan
  (`chargeTonight=false`, no buy), never a best-effort number.
- **Read-only, never touches the alarm spine** — it reads the same
  `backupReserveSoc` the floor alarm defends; it produces no state the floor /
  runway / SoC alarms depend on.
- **DC-bus recurrence identical** to `computeRunway` / the multi-day sim
  (`pack += pvP10 − loadP90/η`, clamp [0,full]) so the advisor's trough is
  consistent with the alarm's runway projection.
- Efficiency constants are **injected** (`legEff = √DISPATCH_ROUND_TRIP_EFFICIENCY
  ≈ 0.927`, `dischargeEff = RUNWAY_DISCHARGE_EFFICIENCY ≈ 0.94`), never
  hard-coded — a real-constants test pins it.
- Caps surfaced honestly via `bindingCap` (`requirement` / `chargePower` /
  `poolHeadroom` / `overBuy`) and a `cushionShortfall` flag when the charger or
  pool prevents fully meeting the cushion (residual risk disclosed in the
  rationale). On a tight day resilience wins the over-buy ceiling and accepts a
  small clip.

**Pre-merge adversarial review (13 agents) caught two CONFIRMED critical
safety-direction defects in the first cut of the sizing math — fixed before this
shipped, with regression tests pinning each:**
- **Deep-shortfall under-buy:** sizing `requiredExtra = targetFloor − baselineTrough`
  truncated at the floor because the baseline DC-bus sim clamps at 0, so a night
  draining *below* empty under-sized the buy (~28 kWh when ~61 was needed) yet
  reported "met" — an UNDER-BUY, the life-safety miss.
- **Full-clamp erasing the lift, flag stayed green:** a mid-window PV surge
  clamping the pack to full made the with-buy trough sit below floor+cushion while
  `cushionShortfall=false`/`bindingCap='requirement'` (the 72 h Fri→Mon horizon
  saturates on weekend middays).
Root cause (shared): the buy was sized by an additive-offset that the DC-bus
clamps break in both directions, and the re-simulation was computed but never fed
back. **Fix:** the buy is now SOLVED by bisection against the clamp-exact,
monotone-in-lift with-buy re-sim trough, and `cushionShortfall` is driven by that
trough — so neither a full-clamp nor a below-empty deficit can present as
"requirement met". 17 deterministic tests (+2 regressions); 1538 server tests
green, tsc clean. No config, endpoint, or behavior change — nothing calls this
module yet.

## v1.36.0 — TOU tariff model (APS R-EV), pure module

Third increment of the TOU night-charge arbitrage feature (advisory-only; no writes).

New `server/src/tariff.ts`: a declarative multi-period, seasonal, timezone-resolved
tariff model + `rateAt(model, ts)` resolver. Nothing consumes it yet — the existing
2-tier path (`onPeakAt` / the MPC feed) is rewired onto it in the next release, and the
config-form exposure after that — so this increment is provable entirely by unit tests
with zero live impact (accuracy-attribution splitting).

Models the deployed plan, APS Rate Schedule R-EV, which the flat on/off-peak pair
cannot express: ON-PEAK 4–7pm Mon–Fri (year-round), SUPER-OFF-PEAK 10am–3pm Mon–Fri
(winter only), OVERNIGHT 11pm–5am Mon–Fri (year-round), OFF-PEAK everything else incl.
all weekends + observed holidays; seasons SUMMER May–Oct / WINTER Nov–Apr; no demand
charge (inert field kept for future plans). Every local field is resolved in an explicit
IANA timezone (America/Phoenix) via `Intl.DateTimeFormat` — never the host clock.

★ Rates default to null (`ratesConfirmed=false`) → every resolved `centsPerKwh` is null
until the owner confirms effective per-period cents from a bill (null-over-fabrication).
★ DOW edge, pinned + owner-confirmable: the wrap-around overnight window is evaluated per
instant's own weekday, so Fri 11pm is overnight but Sat 12am–5am is off-peak (weekend),
and Sun 11pm is off-peak while Mon 12am–5am is overnight — consistent with "off-peak =
all weekends". 19 boundary tests (season flips, on-peak/super-off-peak/overnight edges,
DOW crossings, holidays, wrap-around, confirm gate). 1521 tests green (+23), tsc clean.

Pre-merge adversarial review (13 agents) hardened the module before it landed: DOW is now
derived from the resolved local calendar date (ICU-weekday-independent — a degraded-ICU
runtime can no longer silently collapse every weekday to Sunday/off-peak); the Intl
formatter is memoized per timezone; the rate-confirmation gate now also nulls
`fixedDailyCents` when unconfirmed (no fabricated basic-service charge); `RateSlice`
carries `ratesConfirmed` so a consumer can distinguish "rates not yet confirmed" from a
"confirmed-but-missing-season" data gap; and `isOnPeak` follows an explicit
`period.onPeak` flag instead of a magic id string. The calendar-month season
approximation (vs APS billing-cycle boundaries) is documented as a known ≤-few-days/yr edge.

## v1.35.0 — extend the weather forecast horizon 2 → 4 days

Second increment of the TOU night-charge arbitrage feature (advisory-only; no writes).

The Open-Meteo fetch requested `forecast_days=2`, so the multi-day forecast's days 3-4
fell back to an hour-of-day radiation *climatology* ("typical recent day") rather than a
real forecast. The arbitrage weekend lookahead needs genuine day-3/4 solar: because the
cheap overnight window and the 4-7pm peak are both weekday-only, a Friday plan must
reason all the way to Monday, and that back half was previously climatology-grade.

Bump to `forecast_days=4` (Open-Meteo's free tier allows up to 16). This purely APPENDS
days 3-4 — the first 48h of hourly weather are byte-identical, so the alarm-facing 24h
day-ahead forecast (runway/floor/SoC) is unchanged. Isolated in its own release so any
multi-day forecast shift on days 3-4 is cleanly attributable to this one change.

Live-verified before/after: the day-ahead forecast (minProjectedSoc, pvBiasFactor,
forecastPvWhNext24, first-hours pv/load) and the runway alarm numbers are unchanged;
only the multi-day days 3-4 move from climatology to forecast-backed. 1498 tests green,
tsc clean.

## v1.34.0 — expose the multi-day forecast's per-hour trajectory

First increment of the TOU night-charge arbitrage feature (advisory-only; no writes).

`computeMultiDayForecast` already walks an hourly DC-bus sim internally
(`socWh += pv − load/η`, analytics.ts) but discarded everything except each day's
min-SoC rollup. This exposes that per-hour series — `DayRollup.hours: {ts, pvW, loadW,
socPct}[]` — so the forthcoming night-charge advisor can read the exact shortfall
trough and the carry-to-next-window SoC trajectory it needs to size a buy, instead of
re-deriving a second (possibly contradictory) sim.

Purely additive: the rollup fields (`pvKwh`/`loadKwh`/`minProjectedSoc`) are byte-for-byte
unchanged; day-0 exposes only future hours (past hours are skipped as before). New tests
tie the hourly series out to the day rollups (summed hourly load == `loadKwh`; min over
hourly `socPct` == `minProjectedSoc`) so the two can never silently diverge.

Advisory-feature note: this changes only the `/api/forecast/multi-day` payload shape;
no alarm reads it (the runway and floor alarms use the 24h day-ahead forecast). 1498
tests green (+1), tsc clean.

## v1.33.0 — multi-day forecast horizon cache fix

`computeMultiDayForecast`'s 30-minute result cache (analytics.ts) was keyed by time
only, not by `horizonDays`. So once the dashboard's default `days=3` call warmed the
cache, a subsequent `GET /api/forecast/multi-day?days=4` within the TTL was served the
stale **3-day** result — silently truncating any longer horizon. It surfaced during
the night-charge arbitrage design work: the weekend (Fri→Mon) shortfall lookahead needs
a 4-day horizon, and would have been quietly cut back to 3.

Fix: key the cache by `horizonDays` (recompute when the requested horizon differs).
Behavior for the default `days=3` path is unchanged. Also confirmed in the same pass
(no code change needed): the SHP2 reserve floor reads a consistent **10%** across
`/api/runway`, `/api/ha-state`, and the raw device — an earlier transient 12% reading
was pre-propagation of an operator app-change, not a derivation bug.

New regression test (`forecast.test.ts`): a `days=4` call after a `days=3` call with no
cache reset returns 4 days, not the cached 3. 1497 tests green (+1), tsc clean.

## v1.32.0 — cross-model review corrections: the dispatch round-trip constant + three companions

A Fable cross-model review (21 agents, adversarially verified) re-derived the v1.24–v1.27
finding-driven engine work from first principles. The mechanics of every item verified correct;
one constant did not.

**The headline (HIGH, confirmed thrice + live data): `DISPATCH_ROUND_TRIP_EFFICIENCY` 0.945 → 0.86.**
The v1.27.0 value was a misinterpreted measurement. `/api/round-trip-efficiency` integrates
`pack_in`/`pack_out` at the **BMS pack terminals** — battery-internal round trip, excluding BOTH
conversion legs (live: 89.3% 7-day / 91.6% 14-day, not 94.5%). Its brief 0.945 reading on
2026-07-14 numerically coincided with the separately-measured pack-terminal→AC
**discharge-conversion leg** (6.22 kW → 5.88 kW = 0.945), and the two different physical
quantities were conflated — so the planner modeled a full PV→pack→AC round trip at 0.945 when
the composed truth is η_chg-conv (~0.97) × η_pack-RTE (~0.91) × η_dis-conv (0.945) ≈ **0.83–0.86**
(cross-checked: `dispatch/mpc.ts` independently books the same loop at 0.90). Round-trip losses
were under-booked ~2×; savings overstated; off-peak import under-sized; the per-leg 0.972 even
exceeded the measured single discharge leg. Advisory-only surface (verified: sole consumer
`GET /api/dispatch-plan`, no alarm coupling). The v1.27 tests were η-agnostic by construction
and structurally could not catch a wrong constant. **New invariant test**
(`rteIntegrity.test.ts`): `√DISPATCH_ROUND_TRIP_EFFICIENCY ≤ RUNWAY_DISCHARGE_EFFICIENCY` —
the v1.27 value violated it (0.972 > 0.94); the violation *is* the misinterpretation, and it
can no longer ship silently. v1.26's `RUNWAY_DISCHARGE_EFFICIENCY` 0.94 is **confirmed correct
for its use** (the one-leg value is exactly what a pool-drain countdown needs; all 7 integration
sites verified at HEAD; the 5 v1.26 tests mutation-verified to kill the wrong form) — only its
prose conflated the quantities; comments corrected at all three sites.

**Companions from the same review:**
- **`computeRunway` pool cap** (pre-existing): the hour loop floored the pool at 0 but never
  capped it at `backupFullKwh` (its sibling integrator does) — a long PV-surplus stretch banked
  phantom above-capacity energy that extended the later drain, optimistic. Now
  `min(backupFullKwh, …)`; the clamp can only SHORTEN runway. Pinned by a surplus-then-dark
  test where the unclamped sim pushed the reserve crossing out of the horizon entirely.
- **SIP retry delivery-tracking** (v1.25 gap): `skipSip` conflated *dispatched* with
  *delivered* — a failed first SIP dispatch was never retried, defeating the alternate alarm
  channel in exactly the correlated-failure scenario it exists for. Deferred MA retries now
  skip SIP only when the first dispatch genuinely reached ≥1 target (`lastSipDispatchOk`); an
  unknown outcome re-fires — for an alarm channel a rare duplicate beats silence.
- **Prose corrections**: the "ratio 0.945 == the measured 7-day RTE" identity claim removed
  from the v1.26 comment and its test header (they are different quantities that coincided
  for one morning).

Review verdicts for the record: v1.26 CORRECT-WITH-CAVEATS · v1.27 constant DEFECTIVE (fixed
here) · v1.24 fixes CORRECT-WITH-CAVEATS (all three live-verified) · v1.25 CORRECT-WITH-CAVEATS
(all six properties hold; retry gap fixed here) · the "A−" assessment methodology graded
DEFECTIVE (circular capacity tie-out, in-sample PV comparison, conservation graded without a
loss model — the 6.5% residual *was* the conversion physics; documented for future audit
method, no code impact). Deferred to its own release: the unity charge-credit refinement in
the η sims (~4–7% of stored surplus, fix direction strictly conservative, alarm-adjacent —
deserves solo review). 1496 tests green (+3), tsc clean.

## v1.31.0 — band-calibration integrity (audit follow-ups)

Implements the four deeper statistical findings the v1.30.0 calibration audit
documented. **Advisory/display path only — the band feeds no alarm** (census
invariant now stated in code at the `ProbabilisticForecast` interface).

- **Coherent error basis** (`pvBandScoredErrs`, new). The calibrator's daily
  errors are now measured against the series the band actually wraps: each
  scored day's prediction is adjusted by the forecast's `pvBiasFactor` (the
  correction `hours[].forecastPvW` carries) and the error is taken as
  `|actual − adjPred| / adjPred` — **%-of-predicted**, matching how the
  half-width is applied to P50. Previously it used the skill report's
  `errorPct` (%-of-actual) on raw-model errors — anti-conservative under
  under-prediction bias and scored against a forecast never published. Not a
  band *shift*: `pvBiasFactor` already centers publication; shifting the band
  too would double-apply (audit finding #3 resolved as "don't").
- **Coverage-unbiased quantile.** The realized half-width rank is now
  `k = ceil(0.8·(n+1))` (clamped to n): for a band built from n sorted
  |errors|, E[coverage of a new day] = k/(n+1), so expected coverage stays
  ≥80% for **every** n. The old nearest-rank `ceil(0.8·n)` was exact at n=14
  but dipped to ~0.75 for most n in (14, 30] once v1.30.0 widened the window.
  (Identical result at n=14 — the v1.23.0 F30 tests pass unchanged.)
- **Continuous coverage diagnostics.** `/api/forecast/probabilistic` now
  publishes `calScoredDays` and `bandRealizedCoveragePct` (share of scored
  days whose realized error fell inside the current band's daily half-width).
  The band's honest label — documented in DOCS.md — is "**≥80%, deliberately
  conservative**" (the 0.4 floor binds by design); the diagnostic makes that
  claim measurable release-over-release. Trending toward 80% = the signal to
  revisit the floor; below it = a regression.
- **Day-ahead forecast archive.** The recorder now persists the *issued*
  next-24h PV forecast (`recordForecastArchive`, pseudo-SN `forecast`, metric
  `pv_next24_wh`; hour-snapped, idempotent, change-detected — a few rows/day)
  from the main process's 45-min GHI-persistence tick. The calibrator's
  current hindcast basis is rewritten whenever the model re-learns and omits
  the weather-forecast component of true day-ahead error; this archive is the
  raw material for genuinely out-of-sample scoring. **Scoring switch is
  data-gated** (~14+ archived days) for a future release; this one only
  writes. The read-only worker recorder stubs the method (a worker-side write
  would be a wiring bug).

Deliberately unchanged: the ≥14-scored-day gate, the 0.4 floor (regime-shift
insurance — the hindcast-basis conservatisms above are exactly what it
covers), and the conditional-sigma rework (cloud climatology → residual-based
sigma) which stays on the roadmap. 1493 tests green (+8: denominator, bias
basis, unscorable-day drop, n=15/n=14 rank pins, payload diagnostics ×2,
archive idempotency/change-detection).

**Review round (adversarial multi-agent):** one confirmed defect fixed —
`FORECAST_SN` joined `restartGapExcludedSns` (the archive tick writes
wall-clock rows even while device feeds are wedged, so an unexcluded
`forecast` SN could anchor MAX(ts) and mask a home-telemetry stall in the
restart-spanning gap detector; the v0.80.0 anti-masking invariant now lists
all three non-home writers, pinned by an extended restart-gap test). Also: a
relative epsilon on the `bandRealizedCoveragePct` edge comparison (an
at-the-edge q80 could flip below the 80% threshold on FP rounding), and the
calibrator's four residual conservatism gaps (per-hour ceiling re-clamp
asymmetry under `pvBiasFactor > 1`, tail-day censoring, retention-fragment
days, hindcast basis) are now documented in DOCS.md as floor-covered until
archive-based scoring lands.

## v1.30.0 — activate the P10/P90 band calibration (dormant since v1.23.0)

A calibration-audit release for the probabilistic day-ahead PV band. **Advisory/display
path only — the band feeds no alarm** (verified by exhaustive consumer census: the
`/api/forecast/probabilistic` display, the recommend-only `/api/dispatch/recommend`
MPC, and the Lovelace solar-card badges; no MQTT sensor derives from it).

**The defect.** The v1.23.0 (F30) band self-calibration — built to shrink the raw
band to ~80% realized daily coverage — never ran in production. Its gate requires
≥14 weather-covered **scored** days, but the `probabilisticForecast` builder fed it
the **default 7-day** skill window (structurally below the gate at any coverage),
and even a 14-day window only reaches 14 scored days at 100% telemetry/weather
coverage (live: 9 of 14). Result: `bandSigmaCal` pinned at 1 since ship — the band
ran ±76% of daily forecast kWh against a realized q80 daily error of ~7%,
i.e. ~100% coverage with a near-vacuous P10 (≈0.19×P50). The v1.23.0 unit tests
missed it because every fixture was an ideal ≥14-scored-day report.

**The fix.** New `PV_BAND_CAL_WINDOW_DAYS = 30`: the builder now feeds a 30-day
skill window (needs only ~47% coverage to reach 14 scored days; precedent —
`/api/confidence` already hindcasts 30 days; the skill memo is keyed per window so
7-day consumers are untouched). One window serves both `skillFrac` and the
calibration, so the shrink ratio is measured on the sample the sigma was built
from. The `/api/forecast-skill` route clamp rises 14→30 to match. The ≥14-scored
gate and the 0.4 shrink floor are deliberately unchanged (the floor is the
regime-shift insurance; expect the floor to bind → band tightens ×2.5, still
conservative). Post-deploy expectation: `bandSigmaCal` = 0.40,
`realizedDailyErrHalfFrac` ≈ 0.07–0.12 on `/api/forecast/probabilistic`.

New tests (3) encode the realistic partial-coverage scenario the originals missed:
a 30-day/63%-coverage report activates the calibration; the same coverage on a
14-day window provably cannot; and the window constant is pinned ≥30 with the
coverage arithmetic documented. 1485 tests green.

Audit follow-ups noted for future work (documented, not shipped): calibrator error
basis (raw-model hindcast vs published bias-corrected forecast; %-of-actual vs
%-of-predicted denominator), archiving day-ahead predictions for true out-of-sample
scoring, and an interpolated quantile if the window ever widens further.

## v1.29.0 — rename the "Babylon 5" theme to "High Contrast"

A UI-labeling release — no engine behaviour changes.

The alternate dark dashboard theme (deep navy + cyan + amber, bracket-corner panels,
phosphor glow) is renamed from **Babylon 5** to **High Contrast** everywhere it appears —
the theme picker and its description, the `DOCS.md` theme list, and all source comments.
The visual design is unchanged; only the name and the internal slug change.

- **Slug migrated safely.** The theme's internal id / `data-theme` value / stored preference
  moved from `b5` to `high-contrast` (with the CSS selectors, the lazy-loaded Google-Fonts
  `<link>` id, and localStorage persistence). `getStoredTheme()` maps a legacy stored `b5`
  forward to `high-contrast`, so anyone who already had the theme selected keeps it across
  the upgrade.
- **Docs + comments.** `DOCS.md`'s theme entry and every in-code comment that referred to
  "Babylon 5" / "B5" (including the Babylon-5-universe flavour text in the CSS/theme comments)
  now describe a generic high-contrast dark palette.

Verified: web `tsc` + production build clean; a live browser check confirmed the picker shows
"High Contrast", selecting it applies the dark theme (attribute + CSS + fonts) and persists as
`high-contrast`, and a legacy `b5` stored value migrates forward on load.

## v1.28.0 — complete documentation rewrite + GitHub hygiene sweep

A documentation and repository-hygiene release — no engine behaviour changes.

**Documentation (`DOCS.md` fully rewritten, `README.md` replaced, `SECURITY.md` added).**
`ecoflow_panel/DOCS.md` is now the **complete reference** — 14 chapters (~460 KB) written
directly from the source and completeness-/accuracy-checked against it (an independent
critic pass found **zero** invented constants or formulas). It documents **every** feature
and engine — architecture & data flow; EcoFlow cloud + HA wiring; the solar/PV forecast
engine; the physics-based & Bayesian model tier (clear-sky ceiling, LFP-OCV SoC,
hierarchical-Bayes SoH, recursive Bayesian solar); the safety-critical runway/depletion/
SoC alarms; the battery & PV health engines (SoH/EOL/pack-risk/resistance/RTE/thermal/
soiling); energy accounting, cost & dispatch; alerts/anomaly/incidents; the online learning
loop; the audible broadcast + chimes + TTS pipeline; the web/TUI/HACS interfaces;
configuration/deployment/security/operations; the safety & operational plumbing; and the
energy-aware lighting/HVAC posture — each with its inputs, exact algorithm & math, data-flow
trace, endpoints/sensors, config knobs, and edge-case guards. `README.md` is now a polished
top-level tour that links into the reference. `SECURITY.md` adds a private
vulnerability-reporting policy (GitHub Security Advisories) and states the security posture.

**GitHub hygiene.**
- **Dependencies:** folded the 5 open Dependabot version bumps into `main` and verified them
  against current code — server `@fastify/static` 9.1→9.3, `@fastify/websocket` 11.0→11.3,
  `fastify` 5.9→5.10, `mqtt` 5.10→5.15, `@types/node`+`tsx` (dev); web `recharts` 3.9.1→3.9.2,
  `postcss`+`vite` (dev). Full suite (1482) green, tsc + web build clean. (A Dependabot PR that
  read as failing was tested against a stale base; it is clean on current code.)
- **Code scanning:** the `js/file-system-race` (TOCTOU) alerts in `alertTelemetry.ts` are
  fixed — `rotateTelemetryIfOversized` now opens the file once and stats+reads from the file
  descriptor (not the path), removing the check-then-use and re-resolve windows. The test-only
  alert was dismissed (single-threaded test on an exclusive temp file — no real concurrency).
- **Branches:** removed two stale remote branches (`copilot/code-review`, `tesseractAZ-patch-1`).

## v1.27.0 — dispatch planner: round-trip storage losses (the last raw pv−load sim)

The v1.26.0 accuracy work converted the whole forecast/runway/alarm family to the η-honest DC-bus
balance, and a focused verification flagged the one remaining lossless integrator: `computeDispatchPlan`,
the **advisory-only** TOU economic dispatch *recommendation* planner ("DO NOT auto-apply"). It stepped a
battery SoC with raw `pv − load` — modeling a **lossless** pack — so its pre-peak import sizing and
savings estimate were mildly optimistic vs the η-honest runway.

Unlike the depletion sims (which only *discharge*), this planner both charges and discharges, so a
**round-trip** loss applies. It now uses `DISPATCH_ROUND_TRIP_EFFICIENCY` (default **0.945** = the
measured 7-day RTE, env-overridable, clamped [0.80, 1.0]) split symmetrically across the two legs —
η_chg = η_dis = **√RTE ≈ 0.972**. A PV surplus now stores only `√RTE ×` the surplus (charge loss); a
deficit now draws `deficit / √RTE` from the pack (discharge loss), and the reserve-floor guards test
that *drawn* amount so a recommended discharge can never dip the pack below reserve. The off-peak
grid top-off keeps its billed draw but the pack fills at √RTE, naturally pulling more off-peak import
over the window. Net effect: the SoC trajectory, savings, and import sizing are all slightly more
conservative (round-trip losses reduce the modeled economic benefit) — never *under*-stating the grid
import a real round trip needs.

This deliberately uses a clean symmetric round-trip split rather than reusing the runway's
`RUNWAY_DISCHARGE_EFFICIENCY` (0.94) for the discharge leg — that value folds SHP2/standby overhead
into the single discharge leg the *safety countdown* cares about, and pairing it with RTE=0.945 would
imply an unphysical η_chg > 1. The planner stays **advisory-only / surfacing-only**; nothing here
touches the alarm, runway countdown, or notification path. 3 new regression tests pin the round-trip
behavior (charge stores √RTE of the surplus; discharge draws deficit/√RTE; the constant is guarded).
Suite 1482 green; tsc clean on server + web + lovelace.

## v1.26.0 — runway accuracy: the depletion sim accounts for the DC→AC discharge loss

A novel, ground-truth-backed accuracy assessment of the whole system (25 agents; every predictive
engine cross-validated against Open-Meteo GHI for Phoenix, the 42×400 W array physics, the SHP2
92.16 kWh capacity, energy conservation, and the system's own backtest) graded the system **A−**,
with **one** adversarially-confirmed defect — and it was in the safety-critical runway engine, in
the optimistic direction.

**The depletion sim now accounts for the DC→AC discharge loss.** The runway sim (`computeRunway`) and
its two sibling SoC integrators (`getDayForecast.projectedSocPct` and `computeMultiDayForecast`) tracked
the DC battery pool (`backupBatPercent × backupFullCapWh`) but subtracted the *delivered* home load,
ignoring the inverter conversion loss. On the DC bus, PV enters at ~unity (MPPT) while the AC home load
is pulled through the inverter at 1/η_dis, so the pool changes by **`pv − load/η`** each hour — not the
raw `pv − load`. The old raw form drained ~6% too slowly, so the countdown read **long (optimistic)**,
the unsafe direction for an islanding alarm. Confirmed empirically, not theoretically: on 2026-07-14
the pack drew **6.22 kW gross for 5.88 kW delivered** (ratio 0.945 — exactly the measured 7-day RTE).

The correction is applied per-flow (`pv − load/RUNWAY_DISCHARGE_EFFICIENCY`, default **0.94**,
env-overridable, clamped [0.80, 1.0]) — **not** the tempting `(pv − load)/η`, which would wrongly divide
the *PV credit* by η too and stay optimistic whenever PV > 0 (e.g. at `pv == load` the pack still drains
at `load·(1 − 1/η)`, but `(pv − load)/η` reads a flat pool and never-empties — a fully suppressed
depletion crossing; **caught and fixed during the change's own adversarial review**). The new delta is
`≤` the pre-v1.26 raw delta for all (pv, load), so the sim can only ever read *shorter-or-equal* than
before — a strict safety improvement — and `∂delta/∂pv = 1` preserves the `runwayPvBasisGuard`
monotonic-in-forecastPvW invariant. Applying the identical correction to `projectedSocPct` and the
multi-day day-0 sim keeps the v1.24 forecast-runtime card (which bounds itself by the `projectedSocPct`
crossing) consistent with the η-corrected `/api/runway` and eliminates the cross-surface SoC
contradiction. `loadShedAdvisor` now subtracts shed watts on the same pool basis (`shedKw / η`) so the
shed-benefit estimate stays consistent with the pool-drain countdown. Reported `loadHorizonKwh` /
`forecastPvUsedKwh` stay on the RAW delivered basis. Effect at the current fleet state is small
(hours-to-reserve moves ~1 min; the 25% reserve floor + grid backstop bound the exposure) — a
correctness fix that moves a systematic bias from optimistic to neutral-conservative.

5 new regression tests pin the η-correction, including the two PV > 0 cases that the physics turns on
(`pv == load` must still drain, not read flat; a daytime partial-cloud deficit uses `pv − load/η`, not
the PV-over-crediting `(pv − load)/η`); the runway backtests in dispatch.test.ts / loadShed.test.ts were
re-baselined to the corrected (shorter) crossings. Suite 1479 green; tsc clean on server + web +
lovelace. Every other engine was graded accurate within its stated conservative caveats (daily PV
matches Open-Meteo to 0–1%; capacity ties to 0.07%; soiling to ~1%; energy conservation closes to 6.5%;
alert engine 7/7 true positives).

## v1.25.0 — power alarms reach SIP/intercom endpoints (the Switchboard cordless) via a direct play_media side-channel

Music Assistant drives the ecobee alarm speakers, but it **cannot drive a SIP phone**: exposing the
Switchboard cordless (`media_player.cordless_speaker`) as an MA player registers it, yet MA's
announcement flow never plays on it (no real playback state), and the broadcast's pre-announce
`volume_set` 500s on it (a SIP endpoint has no volume feature — the exact "Server got itself in
trouble" seen live). So the cordless got noise and no audio when listed in `BROADCAST_TARGETS`.

**New option `BROADCAST_SIP_TARGETS`** — a second, comma-separated list of `media_player.*` entity
IDs that receive the SAME rendered alarm audio via `media_player.play_media(announce=true)` instead
of Music Assistant. The dispatch is:

- **independent of Music Assistant** — fired *before* the MA-target availability pre-flight, so a SIP
  target is a genuine ALTERNATE alarm channel that still speaks even when MA / the ecobees are down
  (mid-restart, `unavailable`), the exact failure it exists to cover;
- **fire-and-forget** — the ~3-5 s `play_media` → switchboard render+originate round-trip never delays
  the (already 17-34 s) MA announcement to the ecobees, and never fails the MA broadcast;
- **no volume pin** — SIP endpoints have no volume, so the `volume_set` that 500s is skipped entirely;
- **gated identically** — it runs inside `runBroadcastInner`, downstream of the storm gate and of
  the caller-level enable / min-severity / quiet-hours gates, so every fresh alarm (condition
  transitions, the dedicated SoC/runway `announce()`, `test()`) reaches the SIP targets under the
  same suppression rules as the MA speakers — and never fires when MA is correctly silenced;
- **not re-fired by MA retries** — a deferred retry (`scheduleBroadcastRetry`) exists only to reach
  MA targets that were unavailable; the SIP target already received this exact audio on the first
  dispatch, so retries pass `skipSip` and do NOT replay the identical alarm on the cordless at
  +30/+90/+180 s.

A `media_player` listed in both `BROADCAST_TARGETS` and `BROADCAST_SIP_TARGETS` is dropped from the
SIP list (MA wins) so it is never double-announced. `BROADCAST_SIP_TARGETS` shares the strict
`media_player.*` scope guard. At least one `BROADCAST_TARGETS` (Music Assistant) speaker is required
for a broadcast to run — SIP targets are an add-on channel, not a standalone one, which keeps the
whole outcome / retry / audible-health machinery keyed on the verifiable MA path. (broadcast.ts,
config.yaml, run, en.yaml)

## v1.24.0 — whole-system audit: three confirmed fixes (one alarm-delivery, two display honesty)

A detailed log + performance + math audit of the whole system (24 agents across 11 dimensions,
with an extra lens on the engines shipped over v1.17.0–v1.23.0). Every recently-shipped engine was
independently recomputed against live endpoints + the Open-Meteo GHI archive and **confirmed
correct**; the safety-critical runway math (4.2h islanded / 8.8h grid-backed) recomputed correct;
no performance regression surfaced. Six raw findings distilled to three that survived adversarial
two-skeptic verification. All three ship here.

**#1 (the only one that can degrade a real alarm) — the pre-announce volume pin is now per-target,
not one batched call.** Before a critical broadcast, `startBroadcastMonitor` pins each target to the
standing announce volume so an AirPlay receiver that has drifted toward silence (an ecobee can sit
near ~0.2) is audible when the klaxon plays. That pin was a *single* `volume_set` over the whole
`cfg.targets` list — and Home Assistant resolves a batched `entity_id` list before executing, so one
`VOLUME_SET`-incapable target in the list (the cordless speaker lacks the `supported_features` bit;
the two ecobees have it) makes the **entire** call raise `ServiceNotSupported` and *no* speaker gets
pinned — silently defeating the loudness safety net for the two working ecobees too. The pin is now a
best-effort **per-target** `Promise.all` loop: the incapable target fails in isolation and is logged,
the capable speakers are always set, and the 300 ms RAOP settle still runs whenever at least one pin
succeeded. The announcement itself was never blocked by this and still isn't. (broadcast.ts)

**#2 (display honesty, same-page contradiction) — the "projected runtime to reserve" card is bounded
by the diurnal forecast's own reserve crossing.** The card extrapolates the trailing-3h `backup_pct`
slope in a straight line — but that line runs flat across the solar boundary (afternoon peak →
evening rolloff → overnight), so it read **17h39m** while `/api/runway` on the same page read **4.2h**:
an under-warning contradiction. The displayed time is now `min(trailing extrapolation, first hour the
daily-cycle forecast's `projectedSocPct` dips to/below reserve)` — it can only ever *shorten*, never
lengthen, and the severity tier keys on the bounded value. When bounded, the detail text says so
("Capped at the daily-cycle solar/load forecast's reserve crossing…"). A legacy forecast with no
`hours[]` falls through (`forecast.hours?.find`) to the pre-v1.24 trailing value — no throw, no
behavior change on that path. (analytics.ts `computeForecastAlerts`)

**#3 (display-only, no alarm/wash-card consumer) — the soiling per-hour breakdown adopts the same
robust baseline the per-Core paths already use.** The per-hour decomposition still carried both
anti-patterns the honest per-Core paths were fixed away from: a `Math.max` baseline (a freak
clear-day peak inflates the drop) and a low 250 W/m² GHI floor (at dawn/dusk the pv/GHI ratio is
geometry-dominated, not soiling — hour 18 read an impossible 67.3% drop). It now uses a **p90**
baseline and a **400 W/m²** floor (well-lit hours only), and requires ≥2 recent samples per hour.
The per-Core medians (the honest F29 output that drives the tiles) are untouched. (analytics.ts
`computeSoilingDecomposition`)

3 new regression tests (suite 1471) pin the forecast-runtime bounding: bounded to the diurnal
crossing when it is sooner; the trailing value retained when it is sooner (the bound only shortens);
and the legacy no-`hours[]` forecast falling back without throwing.

## v1.23.0 — engine-review F29 + F30 + F31: the final low-severity queue

Three unrelated low-severity findings, all reporting/robustness rather than safety, closing out
the 30-day ground-truth engine review.

**F29 — per-Core soiling reads a real multi-week baseline, not a sliding 7-day one.**
`computeSoilingDecomposition` paired its PV history against only `getWeather()`'s 7-day live cache,
so the soiling *baseline* slid forward with the very dirt it exists to measure — structurally
blind to gradual soiling, permanently (live: the per-Core tile read 0.9–1.6% while the correct
fleet figure is ~10–12%, painting a green tile that should have tripped its own warn tier). The
fix is the three-lines-away v0.13.1 `mergeRecorderWeather` backfill, already used by the
alarm-facing solar model: seed the window from the recorder-persisted `ghi_wm2`/`cloud_pct`
series first, then let the live cache overwrite its freshest hours. The weather now spans the same
window as the PV (bounded by the recorder's ~30-day sample retention — the 60-day query is only a
ceiling), which is ample for a baseline vs the recent-7-day window. As a bonus the decomposition
now computes even when the live weather cache is cold (recorder-only), instead of bailing empty.

**F30 — the daily PV P10-P90 band self-calibrates to realized coverage.** The band's per-hour
sigma is built from raw cloud-cover *variance*, which the point forecast already absorbs, so the
daily band over-covered badly (live: 42% daily half-width against a realized ~7% daily error →
~96–100% realized coverage vs a nominal 80% — doubly conservative, which costs the recommend-only
MPC money, never safety). The band now measures the realized daily error spread from the skill
report (80th percentile of |daily error|) and shrinks toward ~80% central coverage. Guardrails
that keep this safe on a life-adjacent forecast: **shrink-only** (the raw wide band is the
default), **floored at 0.4×** (a benign window can't collapse it), **gated on ≥14 weather-covered
scored days** (so monsoon variability is in the sample before it acts — inert on the current
7-day window, self-activating later), and **env-overridable** (`PV_BAND_SIGMA_CAL`). Two new
diagnostics — `bandSigmaCal` and `realizedDailyErrHalfFrac` — make the calibration observable.
The band feeds the MPC recommendation and the probabilistic display badge only; it is not an
alarm input.

**F31 — alert telemetry recovers power-cut-torn records and rejects clock-skew negatives.** The
daily Pi power cut can leave a JSONL append torn behind a run of NUL bytes (delayed-allocation
crash artifact); `\0` isn't whitespace, so the old `trim()`+`JSON.parse` silently dropped the
valid record that followed. A new `parseTelemetryLine` strips leading NUL/C0 control bytes before
parsing, recovering the record. Separately, `recordClear` now clamps duration ≥ 0 so a
before-resync `raisedAt` minus an after-resync clear can't feed a negative duration into the
median EWMA or misclassify the clear as a short-clear.

16 new regression tests (suite 1468): NUL-torn record recovery + pure-NUL/garbage rejection; the
band calibration gate, floor, shrink-only clamp, intermediate factor, env override, and monotonic
P10≤P50≤P90; the pure `parsePvBandSigmaCal`/`pvBandRealizedHalfFrac` helpers (including p80-not-min
on a varied set); and soiling computing from recorder weather with the live cache cold plus the
no-weather empty-guard. Mutation-tested (10 mutants): 9 killed; the one survivor is the defensive
`recordClear` duration clamp — a `Math.max(0, x)` on `medianDurationMs`, which has no live
consumer and needs no behavior test.

## v1.22.0 — engine-review F27: the internal-resistance trend stops bluffing

The IR engine was publishing **−74.46 mΩ/mo** from 10 samples under a confident "tracking"
label — a self-contradictory diagnostic (a resistance *falling* by 74 mΩ every month on a
5–30 mΩ measurement is not a battery, it's noise). Fully isolated from the alarm path; three
honesty defects fixed:

**Wrong-signed dV/dI pairs are rejected, not `abs()`-coerced.** `bat_amp` is into-battery-
positive (charging positive — see `deriveWholeUnitBatAmp`), so a genuine Ohmic response has
**dV/dI > 0 regardless of charge direction** (V = OCV + I·R). A negative ratio means the bus
voltage moved *against* the current step — OCV/SoC drift or a V/A snap race — and `Math.abs()`
was silently aging that contamination into the medians and trend as plausible positive
resistance. Expect live sample counts to drop and some Cores to fall from "tracking" back to
"learning" after this ships: those samples were never resistance measurements. (One
pre-existing test had encoded the inverted sign convention — invisible under `abs()` — and was
corrected to the documented one.)

**The slope now publishes through the same gates every other trend engine has.** The raw OLS
slope published unconditionally — `linregress` computes `r²` and a slope standard error, and
this engine read neither. `trendMilliohmsPerMonth` now requires **r² ≥ 0.3** (matches the EOL
gate), a **≥ 14-day sample span** (a one-burst cluster extrapolated to a monthly rate explodes —
the same failure class as the v1.19 CE span gate), and a **±5 mΩ/mo plausibility ceiling**
(LFP bus IR ages well under 1–2 mΩ/mo even near end of life; the pack-risk factor saturates at
3, so a same-magnitude *positive* noise excursion would have pinned a pack's risk factor at
maximum). A new diagnostic `trendR2` publishes alongside — even when the trend is gated null —
so the UI and future reviews can see why. The medians (recent/baseline R) still publish at
10 samples; they're robust — the slope wasn't.

**The baseline no longer compares the data to itself.** At exactly 10 samples the
"first 30 %, floor 10" baseline slice was the *entire series* — recent window included — so
baseline-vs-recent drift was measured against itself by construction. The baseline now draws
only from samples **older than the 7-day recent window** (≥ 5 of them, else null), and both
web and Lovelace cards render the baseline conditionally instead of printing "base null mΩ".

10 new regression tests (suite 1452) pin: sign rejection (a 15-event wrong-signed series yields
0 samples), mixed-series median integrity, noise-fit trend gated null with diagnostic r²,
genuine +2.6 mΩ/mo trend still publishing, the plausibility ceiling on both a positive AND a
**negative** unphysical slope (the −74.46 mΩ/mo the ceiling exists to catch — every gate now
has a fixture that isolates it), the span gate on a 5-day burst with an otherwise-plausible
slope, the baseline min-samples floor at its 1-4-sample boundary, all-recent → null baseline,
and old-cohort/new-cohort drift measurability. Every mutant of the three new gates is killed by
the test that targets it (verified by mutation testing).

---

_Older releases (v1.21.0 and earlier) are in [`CHANGELOG-ARCHIVE.md`](CHANGELOG-ARCHIVE.md); every version also has its own notes on the [GitHub Releases](https://github.com/tesseractAZ/power/releases) page._
