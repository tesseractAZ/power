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

## v1.124.0 — notifications are Home-Assistant-native

The live `ha` channel's entire transport was `persistent_notification.create`: a card in the
HA drawer, which the companion app shows only when opened. No OS push, no lock-screen alert,
no sound, and no `mobile_app` reference anywhere in the repo. With in-house-only speakers and
quiet hours, an away or sleeping owner received **nothing** for a critical battery,
reserve-floor or grid event — and the config text implied the opposite.

The ntfy / Pushover / webhook channels existed to fill that gap and were never configured.
**Removed rather than fixed**: Home Assistant already owns a notification system with a
first-party app, per-device targeting and a documented Do-Not-Disturb bypass.

The `ha` channel now does both halves — `persistent_notification` for the durable drawer
record, and `notify.mobile_app_*` for the actual push. Critical alerts (and only critical)
carry the companion app's documented payload: iOS `data.push.sound {critical: 1, volume: 1.0}`,
Android `ttl: 0` / `priority: high` / `channel: alarm_stream`. One payload serves both
platforms. A warning that behaves like an emergency teaches the owner to silence the channel
that carries the emergencies, so warnings stay ordinary.

`reachesAPhone()` is now a separate question from `isConfigured()`, because "configured" was
true with a supervisor token alone while delivering nothing.

Options removed: `NOTIFY_NTFY_SERVER`/`_TOPIC`, `NOTIFY_PUSHOVER_TOKEN`/`_USER`,
`NOTIFY_WEBHOOK_URL`. Added: `NOTIFY_HA_PUSH_TARGETS`, `NOTIFY_CRITICAL_BYPASS_DND`.
`NOTIFY_CHANNEL` narrowed to `list(none|ha)`; a stale stored value fails **safe to `none`**.

Verified safe before shipping: posting the option set *without* those five keys and
re-reading returned all five, proving `info.options` is the effective set with `config.yaml`
defaults merged in — they were defaults, never stored user data.

## v1.123.0 — reports that claimed more than they knew

- **The cleared-alert ledger paired the last tick's body with the first tick's timestamp.**
  A live row reads `raisedAt 09-02 22:56:56` with detail "Backup pool 49%" — but the pool was
  ~28% then; 49% is six hours later. This ledger feeds `/api/warranty-export` for the EcoFlow
  RMA. The opening body is now frozen at first sighting; the closing body is preserved in
  `closedAs`.
- **Per-family precision was 1.0 by construction.** The aggregate declines to measure a
  one-class stream; that guard was never pushed into the family rollup, so Model Health showed
  `overallPrecision: null` beside ten families all at `precision: 1, dismiss: 0`.
- **A missing EVSE prediction was recorded as "0 sessions, 0 kWh"** — indistinguishable from a
  confident "the car will not charge". 08-27 records 0 sessions and 08-28 records 6; a 30-day
  window cannot gain six sessions overnight. Now `null`.
- **The poll period absorbed the poll duration** (3,626–3,638 s against 3,600 s), so cadence
  degraded in lockstep with vendor slowness — least fresh exactly during the nightly starvation
  window. Now deadline-compensated.
- **Readiness publishes `underBuyMeasurable` / `strikesMeasurable`** and says "UNREACHABLE, not
  merely thin". `cushion_shortfall` is pinned true by arithmetic, so `activeStrikes: 0` meant
  *cannot count*, not *no faults*. **No criterion was loosened** — that was an owner decision,
  taken later in v1.125.0.

## v1.122.0 — the announce path

Four findings in the channel that reaches the household without a phone.

- **One retry slot for every alarm source.** `runBroadcastInner` serves both the condition path
  and the dedicated `announce()` path (SoC ladder, runway alarm, night-charge notice), but
  `retryTimer`/`retryAttempt` were single. A critical deferred at T+0 was erased at T+25 s by a
  routine yellow deferral, silently, and three yellow deferrals exhausted the budget so the next
  red got "giving up after 3 deferred retries" with no attempt. Precedence is now a pure tested
  function.
- **A timed-out announcement was filed as verifiably heard.** `ok: true` carried two meanings —
  "do not retry" and "the household heard it" — and the timeout path is exactly where the second
  is unknown; its own log line says "delivery UNKNOWN". `playAnnounce` now returns
  `ok: true, verified: false`.
- **The supervised consent notice was eaten by the storm gate.** The arm job is pinned at 21:30
  and the SoC ladder chimes in the same minute band; a medium arm after a medium chime is not an
  escalation, so on 09-01 it was dropped 107 s later. The consent checkpoint silently degraded to
  phone-only.
- **The nightly advisory held both alarm speakers for 60 s** (2,643,918 B = 59.95 s, 3.3x every
  other clip) while broadcasts are serialised through one chain, so a red could not be spoken
  until it finished. The spoken variant is now bounded by a tested constant: ~46% shorter, ~32 s.

## v1.121.0 — roster-aware spares, and the SHP2 can heal itself

`SPARE_DPU_SNS` has been inverted since the 2026-08-20 swap: it calls Core 5 a spare (measured
delivering ~1.87 kW on SHP2 slot 3) and does not name the actual bench unit, Core 3. The positive
connected-source check hid this while the SHP2 was reporting; the hole opens when the SHP2 goes
cloud-dark, muting a live pool member's offline alarm exactly when the alarm chain is degraded.
`homeCoreCoverage`'s blind fallback had the mirror problem — it counted bench Core 3 as a
reporting home Core and dropped live Core 5, so coverage could read `complete` with a real member
unobserved, which is the flag `gridState` uses to decide whether to withhold the at-floor grid
backstop.

v1.117.0 built the right answer for `isHomePoolDpu`; four other consumers never got it. They now
share one roster-aware predicate, `isBenchSpareSn`. **The roster can only remove spare status**, so
the change is monotone toward fail-loud.

Separately: `minStarvedDevices: 2` meant a wedge confined to the SHP2 could never reach quorum, so
the one device whose silence blinds the alarms was the one device that could not trigger the
remedy. It now satisfies the quorum alone; dwell, cooldown and the rolling budget are unchanged.

## v1.120.0 — detectors that could not fire

A 49 h log audit found five mechanisms each gated on a condition that is a **constant** in this
deployment, so each reported "nothing to see" for a reason unrelated to whether there was anything
to see.

- **Poll latency**: the `SLOW_POLL_MS` branch required an empty fetch-failure set, but four
  accessory devices fail every poll by design. Duration is now reported independently.
- **Clock-sample rejections**: `setClockRejectLogger` sat *inside* the `setClockOffsetLogger`
  callback body, so it installed only after a first offset adoption — which never happens. Every
  RTT-gate rejection was invisible, which is why "the v1.109.0 fast path has had no live trigger"
  was unfalsifiable rather than reassuring.
- **Rate-collapse pushes**: `msg-rate-floor` was missing from `ENERGY_STATE_FAMILIES`, so churn
  Rule 4 demoted all 16 pushes in the window to "[Low] no immediate action expected" — for a family
  whose 30-day record includes a 12.2 h episode.
- **The reserve-revert readback race**: the posture flag dropped on the cloud ACK while the SHP2
  still echoed the raised reserve, so a 49% pool read as a floor breach and pushed a false
  `[Medium]` at 05:06 against a 16% owner floor.
- **Notify timeouts**: every `request()` in `notify.ts` was uncapped (undici defaults to 300 s) and
  is awaited inline inside the alarm evaluator's re-entrancy latch, so one wedged request could
  stall *all* alarm evaluation for minutes.

Also fixed a flaky test: `dbExport.test.ts` failed ~40% of runs (2/5 on clean main, verified in a
separate worktree). The fixture's source-DB handle was a local V8 could finalize mid-test, letting
the export's close checkpoint the WAL and write the source.

## v1.119.3 — seven advisories, one of them shipping in the image

GitHub raised 7 Dependabot advisories on main (6 high, 1 low). One class is
RUNTIME and therefore ships in the add-on image:

- **fast-uri 4.1.2 → 4.1.4** (high, runtime, `server/`) — SSRF via repeated
  hostname percent-decoding (GHSA-fph4-wmhf-6fwf) and host confusion via
  percent-encoded scheme normalisation (GHSA-jqff-g426-hqxp). Transitive under
  fastify. The 3.x copy also moved 3.1.5 → 3.1.7.
- **browserslist 4.28.6 → 4.28.8** (high, dev, `web/`).
- **postcss-selector-parser 6.1.2 → 6.1.4** (low, dev, `web/`).

Lockfile-only updates — no `package.json` churn. Server suite 2180/2180 and the
web production build both verified against the new tree; `npm audit` reports
zero vulnerabilities in both workspaces.

## v1.119.2 — the first poll after every boot was failing

v1.119.0 registered a `store.on('change')` handler near the top of index.ts that
read `nightActuationMem` — a `let` declared ~2300 lines below it. The first
store change arriving during module evaluation hit the temporal dead zone:

    poll failed: Cannot access 'nightActuationMem' before initialization

The whole poll failed. One lost snapshot on every boot of a life-safety system,
at exactly the moment it is coming up. Observed once per boot since v1.119.0
(2026-09-01 19:47:18); the next poll recovered each time, which is why it read
as a single benign warn rather than a regression.

The owner-floor publish is now registered AFTER the declaration it depends on.
TypeScript cannot catch this — the closure is legal and only the runtime order
is wrong — and no behavioural test can, because it needs a store event mid
module-evaluation. So the invariant is asserted where it lives, in source order:
`moduleInitOrder.test.ts` fails if any guarded module-scope binding is read
above its declaration, and carries a companion test proving the check is
load-bearing rather than vacuously true.

## v1.119.1 — the docs register catches up

Seven releases (v1.113.0 → v1.119.0) had landed in CHANGELOG.md without a
corresponding DOCS.md section, against the standing rule that a new engine gets
its full section in the same release. Three sections close the gap:

- **§12h — the owner reserve floor, and who is allowed to define it.**
  `backupReserveSoc` has three possible authors (owner, our actuator, EcoFlow
  Storm Guard), and four separate defects came from consumers reading the device
  field when they meant the owner's floor. Documents `ownerReserveFloorPct`, the
  four consumers, `POST /api/reserve-floor`, and the drift-attribution rules.
- **§12i — announcement delivery: what a timeout means.** `play_announcement`
  does not return until playback finishes; the clip-derived budget, the
  terminal-unknown rule, and why the v1.118.0 entity probe could not work.
- **§12j — roster durability.** The last-known SHP2 roster, the audible
  phantom re-arm it prevents, and why a restart gate was the wrong fix.

README: DOCS.md size ~8,300 → ~9,100 lines, and the HA entity count 80+ → 120+
(the live surface now exposes 121).

Also carries this week's dependency bumps (actions group incl. codeql-action
v4.37.9, and @vitejs/plugin-react 6.1.1 in the web dev group).

## v1.119.0 — the announce budget follows the clip; the owner floor crosses the worker

### The storm's root cause: a constant the clips outgrew

`music_assistant.play_announcement` does not return until playback FINISHES, and
the HTTP budget was a constant sized when clips were ~24 s. By 2026-08-30 the
red clip was 3,020,422 bytes = **68.5 s** against a **75 s** ceiling, so a red
needed 68.5 s of playback plus MA queueing and AirPlay setup inside 75 s. Every
red timed out — the single observed "success" returned at 75.4 s, AT the limit —
and each timeout was retried and PLAYED AGAIN. Music Assistant's own log is the
ground truth: **15 announcements** of one storm warning, ~17 minutes of audio in
a 32-minute span. (The panel log undercounts 2.5x because it records only
condition transitions, not the retries that also sounded.)

The constant has rotted three times now (5 s → 30 s → 75 s), always because
clips grew. `announceTimeoutMs` derives it instead: WAV bytes ÷ 44100 gives the
duration, plus a 45 s setup margin, floored at the old 75 s so nothing gets
tighter, capped at 10 min so a genuinely wedged call still surfaces.

This also re-arms v1.118.1. That release made a timeout terminal (no retry),
which was right — but sitting on a timeout that fired for EVERY red, it made a
genuine red delivery failure indistinguishable from the routine false one.
With the budget honest, a timeout means something again.

### The runway alarm's owner floor never reached the worker

v1.115.0 published the owner reserve floor through a module-level variable and
read it in analytics.ts — which runs in the ANALYTICS WORKER THREAD, where
main-thread module state does not exist. It read null and fell back to the
device's reserve, i.e. the actuator's own raised 50. Measured live on 08-30/31:
the pool sat at 41-49% against an owner floor of 40 while the runway alarm
logged "AT RESERVE FLOOR" five times overnight — the exact artifact the fix was
meant to remove.

The floor is now pushed across the boundary explicitly (a worker message,
replayed on respawn) and republished on every snapshot, not only on an
actuation write — because the floor has three possible authors: the owner, our
own actuator, and EcoFlow Storm Guard.

### An external reserve-floor change now says so, and the push is auditable

Storm Guard raised the floor 20 → 40 during the thunderstorm warning. The drift
push path logged NOTHING on success or failure, so whether the operator was ever
told is unanswerable from any artifact. It now logs its outcome, and a
`backupReserveSoc` change gets its own dedupId and a title naming the
consequence, so it can never be coalesced away behind unrelated settings drift.

## v1.118.1 — a timeout is terminal-unknown: stop, do not retry

v1.118.0 tried to settle a timed-out announcement by probing the players'
state, copying the v1.48.3 SIP fix. That probe cannot work on this path, and
made the incident worse. Measured live 20:59-21:01 on 2026-08-30:

- The service call blocks for its full ~80 s timeout, so the probe runs ~88 s
  after dispatch — by which point a few-seconds-long announcement has finished
  and every player reads `idle`.
- The probe uses the same HA API that just timed out, so under the very load
  that caused the timeout it returns null and reads as "not playing".

Both failure modes resolve to "real miss" and retry — the exact duplication
being fixed. The Music Assistant log settles what actually happens: it received
and PLAYED every timed-out call ("Playback announcement to player … Streaming
via AirPlay 2"). A Headers Timeout means the request was accepted and the
RESPONSE was slow. A hard-down MA refuses the connection instead — a
non-timeout error, which still retries, unchanged.

So a timeout-classed dispatch now stops: no in-call retry, no deferred retry.
The asymmetry that settles it — the HA push notification is dispatched
separately and succeeded throughout the incident, so the operator is informed
either way. Audio is the redundant channel, and one possibly missed
announcement beats six duplicates of a storm warning.

## v1.118.0 — a lost HTTP response is not a failed announcement

### Six announcements of one storm warning, during the storm

2026-08-30 20:39 MST: a Severe Thunderstorm Warning raised a red. Every
`music_assistant.play_announcement` call returned "Headers Timeout Error" —
while the audio played each time. The Music Assistant path treated each
timeout as a miss, so it retried: 2 in-call attempts x 3 deferred rounds =
~6 announcements of the same alert into the house, during the storm the
alert was warning about. The log read "failed" throughout; the operator
reported "lots of announcements playing".

v1.48.3 had already learned this on the SIP path — a duplicate arriving
mid-call made the cordless RING instead of auto-answering — and fixed it by
verifying against entity state before re-firing. The MA path never got that
treatment.

Now it does: a timeout-classed dispatch error means delivery is UNKNOWN, not
missed. The players' real state is probed (~8 s in, mid-announce for any real
playback) and confirmed playback counts as success. A non-timeout failure
(4xx/5xx/refused) is still a definite miss and still retries — unchanged.

Both paths now share ONE classifier so they cannot drift apart, and it covers
`ETIMEDOUT`, which has no word break and the original `/timeout|abort/` missed.
Widening is safe in both callers: a positive verdict only means "unknown", and
is always followed by the entity-state probe.

## v1.117.0 — a deploy stopped waking the speakers

### One 30% crossing, three audible announcements

Both 08-29 deploys replayed an already-announced SoC rung to two Music
Assistant speakers and the cordless handset. The mechanism, reproduced
identically on both boots and firing 10m01s after each:

On the first tick after a boot the SHP2 projection is not yet hydrated, so the
connected-source roster reads EMPTY. Membership then fell through to the static
`SPARE_DPU_SNS` literal — stale since the 08-20 swap moved Core 3 off-panel
without adding it — which admitted that off-panel Core 3 at **75%** into the
pool mean while the real pool sat at **21%**. The phantom re-armed the 50/40/30
rungs and rewrote the slew baseline; the true 21% was then rejected as
implausible (75−21 = 54 > the 25-point cap) for exactly the 10-minute baseline
lifetime, and on expiry three rungs crossed in one tick and announced.

The roster is durable STATE, so it is now remembered: seeded at boot from the
persisted membership fingerprint (already a sorted, comma-joined SN list) and
refreshed whenever the live roster is non-empty. The static literal survives
only as the last resort on a first-ever boot. An unhydrated tick now yields
NO pool SoC — a safe no-op — instead of a bench spare's.

Deliberately NOT fixed by a restart gate: `isRestartContinuation` did fire on
the yellow-advisory path both boots; the ladder calls `announce` directly and
goes around it. Gating there would mask the phantom re-arm, which can equally
misfire in any mid-run SHP2-blind window. The v1.8.0 failover itself is intact
and tested — it is what the fallback exists for.

Harness `scripts/mutate-roster-fallback.mjs` (4/4) covers both directions:
the stale literal returning, and the fallback over-tightening until the
SHP2-blind failover goes dark.

### The reserve setpoint now has a time series

`backup_reserve` is recorded alongside `backup_pct`. It was the one value the
owner sets (10 → 20 on 08-28) and the engine rewrites twice nightly, and it had
no history at all — the 08-30 audit could confirm it read 20 *now* but could not
verify from data that it held overnight. A bad revert was invisible to any
historical query.

## v1.116.0 — the planner was the third sibling, and the 0% now says what it is

### A mid-window recompute sized against our own instruction

The night-charge plan is recomputed roughly every 30 minutes, INCLUDING while
the actuator's own write holds the reserve at 50%. The planner read
`backupReserveSoc` directly, so those recomputes sized against
floor + cushion = 50 + 15 = **65%** — the add-on treating its own instruction
as the owner's requirement. This is the third consumer with the same defect:
v1.113.0 fixed the below-reserve alert, v1.115.0 the runway alarm, and all
three now derive the floor from one helper (`ownerReserveFloorPct`) so they
cannot drift apart again.

### The pre-window "0%" is a worst case, and now says so

An analysis proposed clamping the pre-window carry at the reserve floor, since
a grid-connected pool physically cannot fall below it. **Rejected for the
sizing path**, on measurement: `simulate()` is deliberately grid-blind because
the advisor sizes for the ISLANDING case, and over 2240 historical nights the
clamp buys strictly less — worst −12.49 kWh, with 12 nights losing their
reserve write outright. Assuming the grid holds until the window is exactly
the assumption that fails during the outage the cushion exists for.

What was actually wrong was the narrative: "projected to dip to ~0%" with
nothing saying that is the islanded counterfactual, while the grid-present
pool will hold the reserve. The note now labels the figure as the islanded
worst case and names what the SHP2 will actually defend. No value reaching
the sizing anchor changed — pinned by test.

### Also

The msg-rate-floor recovery line is now gated on the episode having surfaced.
The 08-28/29 night logged six "message rate recovered" lines with zero
matching "collapsed" lines (the entry gate correctly suppressed idle and
rebounding collapses; the exit line was ungated), so the journal read as
recoveries from nowhere.

## v1.115.0 — three consumers that read the device instead of the owner

The 2026-08-29 analysis found the same mistake in three places: a consumer
reading what the DEVICE currently reports, when it needed what the OWNER
actually set (or what the actuator actually did).

### The add-on reported its own write back as tampering

`POST /api/reserve-floor` (v1.114.0) echoes through the settings surface a
poll or two later, and own-write attribution covered only the night-charge
path — so the owner's own floor change came back ~3 minutes later as an
**EXTERNAL change at warn level**. `classifyChange` now recognises the owner's
pending write before the night-active gate; the grace window is applied by the
caller so the classifier stays clock-free.

### The runway alarm measured against our own instruction

While the actuator holds the reserve at 50%, `backupReserveSoc` is the
add-on's instruction, not the floor — and the runway alarm read it directly,
manufacturing an "AT RESERVE FLOOR" posture for the whole charge window, every
night (a documented ~6 h nightly artifact). v1.113.0 fixed exactly this in the
below-reserve alert; `ownerReserveFloorPct` now shares the fact so the sibling
consumers cannot drift apart from it again. Out-of-envelope or missing restore
values fall back to the live reading rather than inventing a floor.

### delivered_kwh dropped energy bought outside the nominal window

The scorer integrated the plan's nominal window while the write is actually
held from the apply (up to 5 min early) to the revert (5 min late). On the
08-28 night — hold 22:55:55-00:05:55 against a nominal 23:00-00:00 — that
dropped ~16% of the purchased energy. **This column feeds the v1.112.0 buy
de-bias calibrator**, so a biased delivered figure trains a biased correction.
It now integrates the real hold span.

### Also

The plan row logged the charge window's START only, so a 1 h Friday window
(the Mon-Fri overnight period ends at Sat 00:00) was indistinguishable in the
journal from the usual 6 h one — and the short window is exactly what explains
an unusually small buy. It now prints start→end and duration.

Harness `mutate-reserve-posture.mjs` extended to 8/8.

## v1.114.0 — the owner can set his own reserve floor

The panel could raise `backupReserveSoc` for night-charge arbitrage, but the
owner had no way to set his OWN floor through it — a buffer change meant the
vendor app and a settings-drift line after the fact.

`POST /api/reserve-floor?pct=N` (write-auth, rate-limited) uses the same
audited helper the nightly actuator uses, with the same [10,50] envelope.

★ It REFUSES (409) while a night-charge write is in flight. The actuator
captured `priorReservePct` at apply time and restores exactly that at window
close, so changing the floor underneath a live write would silently revert to
the OLD floor hours later. Retry after the revert, or cancel the night first.

## v1.113.0 — the reserve floor is what the owner set, not what a number implies

### Raising the floor would have made the alarm quieter

The owner raised the SHP2 reserve floor from 10% to 20% for more outage
buffer. The below-reserve alert decided "genuine floor breach" (warning +
one [Medium] push per episode) versus "night-charge is filling the pool"
(silent info) with `reserve <= 15` — a proxy that holds only while the
owner's floor sits below 15. At a floor of 20 it inverts: a real breach of
the new, more conservative floor classifies as arbitrage filling and stops
pushing. Asking for more protection would have bought less.

The actuator already knows the answer as a fact — it applied the raise, it
recorded the value it will restore, and that state is persisted across
restarts. `isReserveArbitrageRaised` keys on it, published to the alert
engine on every actuation-state write and seeded at boot. The F14
"floor-riding must not page" contract is preserved exactly; it is now
established by posture rather than inferred from magnitude. New harness
`scripts/mutate-reserve-posture.mjs` (6/6) covers both silent inversions.

The pre-existing v1.81.0 test asserted the arbitrage case through the
magnitude proxy; its intent is unchanged and it now states the posture.

### Also

`BUILD_DATE` was `github.event.repository.updated_at`, repository metadata
that does not advance per build — every image reported a `builtAt` that never
moved, leaving the commit SHA as the only way to tell two images apart. The
workflow now stamps the actual build instant.

## v1.112.1 — a collapse that has already rebounded needs no operator

v1.111.0's first live night passed its pairing test (every push had a warn, no
duplicates) — and exposed the next layer: every late surface fired during the
RECOVERY dwell. The device woke at the night-charge write edge, its message
rate rebounded instantly, and the warn read "collapsed to 34 msg/min (baseline
~15)" — self-contradicting — while the push stood for the ~4 minutes the
tracker needed to confirm recovery. One episode (Core 4) idled open for 7 h on
the same mechanism. All 8 of the night's warn+push pairs were episodes that
were already ending.

Surfacing ENTRY now additionally requires the device to be starved right now
(current rate under the collapse floor; nulls fail toward starved). A rebound
closes silently via the recovery dwell; a still-starved active device — the
SHP2-crawl case this detector exists for — surfaces exactly as before; holding
is untouched (only recovery or offline end a surfaced episode). Harness
`mutate-rate-floor.mjs` 17/17.

## v1.112.0 — the announced buy learns from realized nights

### "Buy ~21.6 kWh" bought 35.8

The night-charge advisory's buy figure under-predicted by 1.66× on 08-26/27.
The actuation was correctly bounded by the reserve setpoint — the miss is in
the announcement, and an announcement the operator learns to distrust stops
informing anything.

`calibratedBuyDebiasFactor`: median of delivered/planned over eligible ledger
nights (actuated, scored, no disclosed shortfall, plan ≥ 3 kWh), floored at
1.0 (only ever raises the announcement), capped at 1.75, silent below 7
samples. It corrects the ANNOUNCED figure only — the ledger keeps recording
the raw estimate (the learner must never feed on its own output) and
`chargeTonight` still thresholds on the raw figure, so learned data can never
flip a decision, only make the disclosure honest. The evening ARM line and the
plan rationale name the calibration when it is active.

Also: the Core 4 charge-cap advisory from the 08-27 audit (healthy siblings
riding ~99% because the cap is a device MEAN that the frozen warranty pack
drags down) needs the EcoFlow app — the DPU write payload is undocumented and
this add-on does not guess writes against live batteries.

## v1.111.0 — a surfaced collapse survives an idle spell

### Six pushes, zero warns

The v1.108.0 idle gate decided surfacing per tick, statelessly. A device in a
live rate collapse that went briefly idle — a charge burst ending, the
night-charge write flipping the fleet's power state — dropped out of the
published collapse set, silently resolving its standing alert; when power moved
again the alert re-fired as a brand-new push. The 08-26 night showed the full
signature: six "barely reporting" pushes with zero level-40 collapse warns
(the tracker's fired-edge had been consumed while suppressed), aligned to the
22:55 apply and 05:05 revert edges, plus the prior night's duplicate pushes
69 minutes apart.

Idleness explains a QUIET device, so it gates entry into the surfaced set —
it must never evict an episode that already proved itself on an active device.
`decideCollapseSurfacing` (pure, tested) now owns the call: offline evicts,
recovery evicts, idleness only blocks entry, and the collapse warn logs exactly
once per surfaced episode even when the edge passed during an idle spell.
`mutate-rate-floor.mjs` extended with the three silent failure modes (16/16).

## v1.110.1 — the db-export status route joins the rate-limit sweep

`GET /api/db-export` (the snapshot-status read, v1.107.0) was the one flagged
route that genuinely lacked a limiter — it stats the published snapshot on
every call. It now shares the 60/min read bucket. The other two open CodeQL
findings were false positives (routes that DO carry `preHandler` limiters the
query cannot model) and are dismissed with the documented precedent.

## v1.110.0 — CodeQL rate-limit sweep + dependency bumps

Three open `js/missing-rate-limiting` findings closed:

- `POST /api/energy-history/export-ha` (v1.89.0) had shipped **un-gated** —
  it writes the whole vendor ledger into HA's statistics store and pre-dated
  the every-write-gated convention. Now `requireWriteAuth` + 6/hour (the
  dashboard reaches it through ingress, which passes the gate).
- `GET /api/defective-packs` → 60/min; `POST /api/defective-packs/clear` →
  write-auth + 10/hour.

Rides with the week's Dependabot bumps: fastify 5.12.1 (server, production),
web dev group, pinned-SHA actions group (CodeQL action v4.37.8).

## v1.109.0 — a rejection outranks the deadband

### Six minutes of failed polls, with the fix arriving in every failure

At 02:46 on 08-25 the signing-clock estimator adopted a marginal −2.1 s offset
(the host clock steps a little every two hours — HAOS restarts timesyncd on
each DHCP renewal). The vendor's timestamp tolerance turned out to be tighter
than that: every poll for the next six minutes failed `8524 timestamp's value
is invalid`. Each rejection carried a Date header measuring the true offset —
and each measurement was discarded, because it differed from the bad offset by
~2.0 s, just inside the 2 s deadband that exists to keep latency jitter from
rewriting a working offset.

A rejection voids the deadband's premise: the offset is proven non-working.
`noteTimestampRejection` now feeds the 8521/8524 response's own header back
with the deadband bypassed (RTT-gated only by the absolute cold ceiling, since
the degraded vendor window is uniformly slow). Recovery: one poll.

### Corrections

- The HA statistics export now sends `mean_type: 0` — the actual HA 2026.11
  deprecation. v1.108.0's `unit_class` addition fixed a different field,
  misread from a truncated log line; both are now present and the 06:35
  export warning is expected to stop.
- The latched defective-pack detail dates the confirmation in Phoenix local
  time (fixed UTC−7): the 08-24 23:01 MST confirmation had rendered as
  "2026-08-25".

## v1.108.0 — the diagnosis latch, and four audit fixes

### A confirmed-defective pack un-confirmed itself three times in one day

The first day the TOU window let the bench bank charge (08-24), the
`pack-defective-*` alert — the one alert exempt from every mute path — fired
and resolved three times: leg 3 of its live signature (siblings ≥ 100 W)
tracks the charger's burst duty cycle, so the "diagnosis" cleared every time a
burst ended. One [High] push plus one Resolved push per burst is a cry-wolf
cadence on exactly the alert an operator must never learn to ignore.

**The latch** (`defectivePackLatch.ts`): the first full-signature observation
is recorded per PHYSICAL pack serial and survives restarts. From then on the
standing alert holds whenever that pack is present in the fleet — legs or no
legs — and clears only when the pack leaves (RMA; the record retires 48 h
later) or on an explicit `POST /api/defective-packs/clear`. `GET
/api/defective-packs` lists latched records. No packSn ⇒ legs-only v1.101.0
behavior: nothing may latch on a slot alone. Harness extended to 8/8 with the
two silent failure modes (quiescent emission dropped ⇒ flap returns;
confirmation never recorded ⇒ latch inert).

### Rate-floor: idleness is not a wedge

The detector repeatedly flagged an off-panel spare parked at its charge cap —
2–4 msg/min against a baseline learned while it was panel-wired — and the
nightly all-idle vendor window burned the self-heal budget (6/6) every night
on a condition a session rebuild has never fixed. EcoFlow devices message in
proportion to electrical activity, so the tick now suppresses SURFACING for a
device moving < 30 W total (`isElectricallyIdle`) while still sampling it.
Nulls fail toward monitored; the SHP2 is never idle-suppressed; a discharging
Core is not idle. A wedge on hardware moving real power still pages.

### Smaller fixes from the 08-24 log audit

- **Retention ceiling 730 → 3650 days** (code clamp + option schema): the
  operator runs 5-year retention for long-horizon SoH/energy analytics.
- **`recorder/import_statistics` now sends `unit_class: "energy"`** — HA
  2026.x warns when it is omitted.
- **Log hygiene**: the night-charge load-band calibration line logs on CHANGE
  only (was 48 identical lines/day); the battery-SoC implausible-drop
  suppression logs once per minute per episode (was 11 lines in 3 s across the
  08-23 host reboots).

## v1.107.0 — the recorder database, readable from outside the add-on

### /data is a locked room

`/data/ecoflow.db` holds every recorded sample, but `/data` is private per
add-on: the panel maps only `data:rw`, so sqlite-web — or any other viewer —
has no path it can open. Inspecting the recorder meant going through the
panel's own endpoints or not at all.

### A snapshot, not a share

`POST /api/db-export` publishes a point-in-time copy to
`/share/ecoflow-panel/ecoflow-snapshot.db`, a path every add-on can read.
`GET /api/db-export` reports where that copy is and how fresh it is without
producing a new one. The live database is never exposed; only a copy is.

Three things this deliberately is not:

- **Not `cp`.** The database is WAL, so a copy of the main file silently omits
  every row still sitting in `-wal` — the newest samples, exactly the ones an
  investigation wants. `VACUUM INTO` takes a transactionally consistent copy and
  writes it as a single defragmented, WAL-free file.
- **Not on an existing thread.** `DatabaseSync` is synchronous, so the vacuum
  pins whichever event loop runs it. The alarm engine is on the main thread and
  every dashboard panel is behind the analytics worker, so the export runs on
  its own short-lived third thread and exits. It opens its own handle too: the
  read connection sets `query_only = ON`, and SQLite refuses `VACUUM INTO` there
  by statement class even though the source is never written.
- **Not written in place.** The copy goes to a temp path and is renamed in, so
  the published path always holds a complete database and a failed export leaves
  the previous good snapshot alone.

Write-auth gated, rate-limited to 6/hour, single-flighted, and the one
caller-controlled path component is a validated bare filename. `share:rw` added
to the add-on map, used only to write the snapshot. Harness:
`scripts/mutate-db-export.mjs`, 8/8.

## v1.106.0 — the forecast bands: graded per marginal, and the load band is finally a quantile

### Band coverage was graded on an AND, against a marginal target

`pv_in_band` and `load_in_band` are each measured against a P10-P90 band, which
by construction contains the actual ~80% of the time when calibrated. The gate
took the **AND** of the two and graded that against **[78%, 92%]** — a marginal
target applied to a joint statistic.

For two independent 80%-calibrated marginals the joint is 0.64, and the Fréchet
bounds put it in **[0.60, 0.80]**: the entire upper half of the target was
**unreachable by construction**, and a perfectly calibrated pair could never
pass. Conflating them also hid WHICH input was broken — the live joint read 9.5%
while the marginals were PV 57% and load 14%.

Each marginal is now graded separately, both are reported by name in the
blocking line, and the joint is kept as an informational figure only.

### The load "P10/P90" was never a quantile

```
loadP10Kwh = loadP50 / 1.15      loadP90Kwh = loadP50 * 1.15
```

A hand-set ±15% sizing multiplier that nothing estimated from data — yet named
P10/P90 and graded as a calibrated 80% interval. Measured on the live ledger it
contained the actual **14%** of the time, and realized load errors of −28% sat
far outside it.

`calibratedLoadBandFactor` now derives the half-width from realized
`load_err_frac` history (nearest-rank 80th percentile of absolute error), with
two guards:

- **FLOOR at the historical 1.15**, so this can only ever WIDEN the band. On the
  sizing side only `loadP90W` matters — it drives the projected drain — and a
  wider P90 buys more. Under-buy is the asymmetric safety miss, so the monotone
  direction of this change is the safe one.
- **CAP** (default 2.0), so a handful of pathological nights cannot run the band
  away.

Below 10 samples it returns the floor and reports `basis: 'default'` rather than
calibrating on noise. When it does widen, one log line records the new
half-width, the sample count, and that it only widens.

**This is a real behavioural change**: a wider P90 means larger projected drain
and therefore larger buys. It is bounded, monotone toward safety, and auditable.

### Not changed, deliberately

The actuator clamp and the setpoint/target split. They look like the cause of
the over-delivery, but the setpoint is derived from the REQUIREMENT rather than
the derated deliverable by design — that is the resilience posture, and the
defect was in the measurement (fixed in v1.105.0), not the write.

Tests 2085 pass.

## v1.105.0 — buy_err_kwh answers ONE question: did the planner size right?

`buy_err_kwh` was `planBuy − (delivered + troughDeficit)` — the DIFFERENCE of the
two questions available, answering neither:

- it added the **actuator's own delivered energy** back into "realized need", so
  over-delivery was arithmetically indistinguishable from planner under-sizing.
  The actuator over-delivers BY DESIGN: the device is handed a setpoint derived
  from the requirement, deliberately not from the derated deliverable, so it
  charged 29-41 kWh against plans of 21-22 kWh.
- it anchored its counterfactual on a trough read 16 h past window close, by
  which time the pack rests on the **reverted reserve setpoint** — a control
  variable, not a free energy variable. At a 10% trough that contributed a fixed
  −14.9 kWh regardless of anything the planner did.

Measured across four live nights: −62.13 kWh of residual, 52% actuator
over-delivery and 48% trough deficit. The resulting 56% "under-buy rate"
hard-blocked promotion and no forecast improvement could have moved it — an
honest load correction LOWERS the planned buy and makes the residual MORE
negative.

### The planner-sizing basis

A planner sizes the buy from its forecast, so its sizing error IS its forecast
error in kWh:

```
netMissKwh   = (forecastPv − actualPv) + (actualLoad − forecastLoad)
realizedNeed = planBuy + netMissKwh / legEff
buy_err      = planBuy − realizedNeed = −netMissKwh / legEff
```

Less PV than forecast, or more load, means the true requirement exceeded the
plan — negative, preserving the convention that `buy_err < 0` is the asymmetric
safety miss. No delivered term, no trough, no reverted setpoint: it measures the
planner and nothing else. A test asserts the signature contains no such
parameter, so the contamination cannot return by accident.

Actuated and advisory nights now use the SAME basis, deliberately: one column
must mean one thing. **Delivery quality is a separate question and this metric
is not for it.**

### Also

- **Under-buy deadband.** `e < 0` was untoleranced, so a −0.01 kWh rounding
  residual scored as a life-safety miss identical to a −31 kWh one. Negative
  residuals within `UNDERBUY_DEADBAND_KWH` (0.5) are noise, not misses.
- **`CURRENT_ALGO_VERSION` 2 → 3.** Every v2 row's `buy_err_kwh` was produced by
  the superseded definition and is not comparable, so all 16 are excluded and
  the evidence clock resets to zero. That is the deliberate cost: 16 nights of
  an unusable metric are worth less than a clean start on a sound one. Expect
  LEARNING for ~3 weeks while `MIN_ACTUATED_NIGHTS = 21` refills.

Not touched, on purpose: the actuator clamp and the setpoint/target split are the
resilience design, not the defect. The defect was in the measurement.

Tests 2075 pass.

## v1.104.0 — a disclosed cushion shortfall is not under-buy evidence

The write-readiness gate has been hard-BLOCKED on "under-buy rate 56% exceeds the
10% cap". Investigation showed the forecast is the wrong lever entirely: an
honest load correction LOWERS the planned buy and makes the residual MORE
negative, and roughly half the negative mass is a fixed trough-deficit term that
no forecast change can touch.

The immediate defect is narrower and internal. Two rules fifteen lines apart in
`nightChargeGate.ts` judged the same night two different ways:

- the strike rule exempts it explicitly — `if (truthy(r.cushion_shortfall))
  return false; // disclosed — physics, not fault`
- the under-buy rule had no such exemption

So a night whose plan had ALREADY declared it could not meet the cushion (charge
and pool caps prevent it — the rationale says so in as many words) was then
scored as a life-safety miss for failing to deliver exactly that. On the live
ledger **all four** actuated+scored nights carry `cushion_shortfall = 1`.

The under-buy pool now applies the same exemption, and `underBuyExcluded` is
surfaced so a suddenly-uncomputable rate is explainable rather than mysterious.

**This does not open the gate.** With the pool empty the rate becomes null, which
the graduation criteria already treat as blocking — so the state falls from a
FALSE hard BLOCKED to LEARNING. Fail-closed, and honest about having no evidence
rather than asserting bad evidence. No write behaviour changes.

### Not fixed here, deliberately

`buy_err_kwh` itself is a hybrid residual: it adds the actuator's own delivered
energy back into "realized need", so actuator over-delivery is arithmetically
indistinguishable from planner under-sizing, and it anchors its counterfactual on
a trough that is really the reverted reserve setpoint. Redefining it means
choosing which question it answers ("did the planner size right?" vs "did the
night end safe?") and bumping `CURRENT_ALGO_VERSION`, which invalidates every
existing row and resets the evidence clock to zero. That is an owner decision,
not a bug fix.

Tests 2065 pass.

## v1.103.0 — record WHEN pool membership changed, and stop poisoning the pack RTE

Two engines resolved SHP2 pool membership ONCE from the live snapshot and then
applied it across a historical window. Neither could be fixed by reasoning
harder about the current roster: the missing information was **when** membership
changed, and nothing was recording it.

### The pack-DC RTE was accumulating impossible samples

`computeLocalPackRte` sums per-day charge and discharge from those totals. After
the 2026-08-20 swap it reached **77,218 Wh in against 92,676 Wh out** — a
round-trip ratio of **1.20**, physically impossible, because the two legs of the
same day were measured over different sets of batteries. Nothing wrong was ever
published (`packDcRte` stays null below `MIN_RTE_SAMPLE_DAYS`), but every
accumulating sample was poison and the series would have gone live wrong.

Days whose membership was not stable are now excluded, and the count is reported
as `excludedDays` so a low `sampleDays` is explainable rather than mysterious.

### New: `membershipHistory.ts`

A small timestamped record of which DPUs were in the pool. Recorded on **every**
rollup rather than only on a detected change — `recordMembership` is idempotent,
and recording the STATE rather than the EVENT is what makes the first entry
appear on a stable plant at all. That is the same trap that made v1.96.0 and
v1.97.0's floor repair unreachable, so it is worth naming.

`membershipVerdict(from, to)` returns `stable`, `changed`, or **`unknown`** —
and `unknown` is load-bearing. A window predating the record is refused, not
assumed clean. An empty fingerprint (the panel itself unreadable) is never
recorded, because absence of evidence is not a membership change.

### `computeTotals` now declares its basis

`FleetEnergyTotals.membershipBasis` names the roster the rollup was computed
against. The roster for a past window cannot be reconstructed — nothing recorded
it before this release — so rather than pretend, the result says what it used and
consumers that need a trustworthy per-window figure check the verdict.

**Honest limit:** this records changes from the moment it ships. It cannot
reconstruct history that was never observed, so windows before today report
`unknown`. Same discipline as the warranty export, which will not invent pack
provenance for records whose hardware identity was never captured.

Tests 2061 pass.

## v1.102.0 — pack identity follows the hardware

The last item from the 2026-08-20 defect cluster, and the root cause behind
several symptoms patched individually since.

Alert ids are keyed `(chassis, slot)`. That is stable and cheap right up until
the thing in that slot is replaced — and then it is silently wrong. When packs
were physically moved between chassis, `vdiff-crit-<sn>-1` carried straight
through the swap with NO resolve and NO re-raise: its detail changed from
"Deviant cell #31 (-105 mV)" to "cell #32 (-84 mV)" mid-episode, so ONE
cleared-alert record described two different batteries. That record is the RMA
evidence trail.

The BMS reports `packSn` on every read. Three changes make identity follow it:

- **`Alert.sourcePackSn`** — every pack-scoped alert now carries the physical
  serial it is about, alongside the slot number it is keyed by.
- **Pack-residency check** (`alertMonitor`) — when the serial under a live alert
  id changes, that episode is retired through the SAME path a natural clear
  uses, so it closes with an honest duration and lands in the cleared log, and
  the rising-edge pass opens a fresh episode for the new hardware. The retire
  logic was extracted into one helper precisely so the two paths cannot drift.
- **Warranty export follows the pack** — history was admitted by chassis serial
  alone, so a moved pack had its record split at the swap: the receiving chassis
  showed three rows from that day while a month of evidence stayed filed under
  the old one. Records now also match the pack serials a device currently holds,
  and `GET /api/warranty-export?packSn=<SN>` narrows the bundle to ONE pack's
  history wherever it has lived. Records predating this field still fall back to
  the chassis match, so nothing is lost.

Alert ids are deliberately UNCHANGED. Re-keying them would have forced a
one-time resolve/re-raise across the whole fleet and broken the persisted
notified-state dedup — a large blast radius to fix a narrow correctness problem.
Carrying the serial gets the same guarantee with none of the churn.

Tests 2051 pass; harnesses mutate-never-muted 6/6, mutate-resolve-evidence 10/10.

## v1.101.0 — the quiet half of the severity inversion

v1.95.0 fixed the loud half: off-panel hardware stopped chiming. The quiet half
remained, and it was the worse one. When the defective warranty pack moved onto a
bench chassis, every alert it raised was demoted to `annunciate:false` — so the
one battery in the fleet that is actually broken became the only one the operator
was never paged about, while its healthy 29-cycle replacement, on a panel-wired
chassis, pushed [High] cell-imbalance to his phone. Alarm loudness had become
inversely correlated with physical severity.

A new standing alert, `pack-defective-<sn>-<pack>`, fires on an unambiguous
TWO-LEG signature and is exempt from both demotion paths:

- **Leg 1 — BMS protection latch** (`packLatchSignature`): SoC ≥ 20 points below
  the sibling median, exchanging < 25 W, while siblings move ≥ 100 W. All three
  conditions must hold, so an idle pack alongside idle siblings is not latched.
- **Leg 2 — an identified deviant cell** at least `DEFECTIVE_PACK_MIN_DEVIANT_MV`
  (50 mV, matching the cell-imbalance critical bar) from the pack median.
  `packCellForensics` names its most-deviant cell even on a perfectly matched
  pack, so this leg had to be a THRESHOLD rather than a null check — otherwise it
  was vacuous and the detail would have read "0 mV from the pack median".

It is deliberately NOT the per-tick vdiff family: one standing alert per
(device, pack), deduped by the notify layer to a single push, resolving when the
pack is replaced.

Both demotion paths — the bench-spare stamp in `alerts.ts` and the v1.95.0
off-panel demotion in `alertMonitor.ts` — now consult one shared predicate,
`isNeverMutedAlert`, so they can never drift apart about what must always be
heard: a critical Thermal alert, and a confirmed-defective pack.

Harnesses: `mutate-never-muted.mjs` (6/6, new) and `mutate-off-panel-annunciation.mjs`
(6/6). The new harness earned its keep immediately — three mutants survived a
suite that tested only the pure helpers, which is exactly the emission path the
tests were missing. Tests 2045 pass.

## v1.100.0 — the digest ledger line, which had never once rendered

v1.90.0 added a one-line vendor-ledger summary to the morning digest. It has
never appeared. The digest fires at `NOTIFY_DIGEST_HOUR` (06:00 local) and the
vendor ledger job is gated to 06:35-09:00 Phoenix — deliberately AFTER the
digest, so yesterday's record does not exist yet when the digest is assembled.
Keyed strictly to `prevYmd(today)`, the lookup missed every single morning and
`vendorDigestLine` silently returned null. Confirmed on two consecutive days.

The line now falls back to the most recent stored day and NAMES it: "Yesterday
per the EcoFlow ledger: …" when the record genuinely is yesterday, and "Per the
EcoFlow ledger (2026-08-20): …" otherwise. It therefore always carries real
numbers and can never mislabel an older day as yesterday.

This was the honest fix rather than moving the ledger job earlier: the 06:35
window exists so the ~19 sequential vendor requests do not compete with the
morning poll budget, and the vendor's own daily record is not reliably complete
before then.

Tests 2034 pass. The two pre-existing assertions asserted the bare "Yesterday"
prefix and now exercise that path explicitly.

## v1.99.0 — EV recurrence probability was 7.5x too high

The recurrence denominator counted days on which ANY EV session occurred, not
calendar days in the window. With 4-5 charging days in a 30-day window that
inflated every pattern's confidence weight by ~30/4, and the inflated block was
added to the day-ahead load forecast every night.

Measured live before the fix: `sessionsObserved: 5`, one pattern with
`recurrences: 3`, reporting `probability: 0.6` — i.e. 3/5, where the honest
figure is 3/30 = 0.10. On a 10.19 kW plateau the audit measured
`predictedEvLoadW: 7643` across four consecutive day-ahead hours. This single
defect accounted for essentially the whole load-forecast bias (`loadBias`
-0.241, load OVER-forecast by ~24%).

v0.56.0's own comment always described the intended behaviour — *"A 3-of-28-days
charger projects at ~0.11, not 1.0"* — and the code did something else. The
weekday-keyed branch carried the identical defect (`observedDaysByDow` counted
observed EV days of that weekday rather than calendar occurrences of it) and is
fixed the same way.

**Bounded by REAL history.** A recorder holding only 10 days divides by 10, not
30 — otherwise a young install would under-predict a genuinely frequent charger
just as badly as the old bug over-predicted a sparse one.

**Expected effect on night-charge sizing:** predicted load falls, so the planner
buys LESS. That is the correct direction — the phantom EV block was inflating
the requirement — but it is a real behavioural change, not a pure accuracy win.
The supervised write clamp ([10,50]) bounds it either way.

The pre-existing test that asserted `3/12 = 0.25` encoded the defect and has been
corrected to `3/28`; three new tests pin the sparse-charger case, the
expected-value lift, and the young-install bound.

## v1.98.0 — the lifetime freeze, actually repaired

v1.96.0 keyed the lifetime-floor re-seed solely on a CHANGE of the SHP2
source-set fingerprint, and recorded that fingerprint on its first observation
without repairing. Once written, `membershipFp === bmsMembershipFp` on every
subsequent boot — so the entire branch, **including v1.97.0's first-run repair
bolted inside it**, became unreachable. The ~902 MWh freeze survived both
releases; live verification caught it both times.

The property that matters is not *"did membership change"* but *"does the emitted
floor still describe the batteries we are measuring"*. That is now checked
directly and independently of the fingerprint: when the floor sits more than
`BMS_RESEED_MIN_GAP_WH` (50 kWh) above the live sum for
`BMS_RESEED_SUSTAINED_ROLLUPS` (2, ≈10 min) consecutive rollups, the floor is
re-seeded — at most once per process.

Requiring the gap to PERSIST is what makes this safe. A single rollup's timing
can never trigger it, and a genuinely-offline device cannot either: the
held-carry machinery keeps its last-known Wh in the live sum precisely so that
gap never opens. A sustained gap of that size means the packs are gone for good.

The fingerprint path is retained for explicit membership changes, where it
repairs immediately rather than waiting out the dwell.

Tests 2027 pass, including a faithful reproduction of the live condition: a floor
built by a larger pool, the fingerprint then poisoned to match the smaller one,
and the repair driven purely by the gap.

## v1.97.0 — repair the lifetime freeze that v1.96.0 only prevented

v1.96.0 re-seeds the lifetime battery floors whenever the SHP2 source set
changes, but it recorded the fingerprint on its FIRST observation without
re-seeding — reasoning that a fresh install must not clobber a legitimate floor.
That protected future rollovers and left the EXISTING freeze in place, which was
the entire motivation for the release. Live verification after deploy: the
emitted floor still sat **~902 MWh above the live sum**, unchanged.

On the first observation the floors are now re-seeded too, but only when the gap
is unambiguous — greater than `BMS_RESEED_MIN_GAP_WH` (50 kWh, about 1.6x a
single pack). A gap that size cannot be the transient offline dip the held-carry
machinery exists to smooth; it means the floor was seeded against a different set
of batteries. Below the threshold, a fresh install adopts the fingerprint
silently and the floor is left alone.

## v1.96.0 — lifetime counters survive a fleet reconfiguration

Two data-integrity defects the 2026-08-20 pack/DPU swap exposed. Neither is on
an alarm path — SoC, reserve and runway read the SHP2 pool, and round-trip
efficiency is computed separately — but both silently corrupt the energy record.

### The counters froze for an estimated ~35 days, silently

The emitted lifetime battery totals are a monotone high-water floor, which is
correct while the pool is stable and wrong the moment its membership changes.
When Core 3 left the SHP2 source list its five packs dropped out of the live sum,
leaving the live value **~904 kWh below the pinned floor**. `fleet_battery_charge_wh`
and `_discharge_wh` — and the HA Energy Dashboard tiles they feed — therefore read
FLAT while the new pool slowly climbed back over the old mark, closing at only
~26 kWh/day. There was no log line and no alert.

The floors now re-seed from the live sum whenever the SHP2 source set changes,
keyed on a fingerprint of that set persisted to `/data/bms-membership.json`.
v0.9.74 established this fix shape for the one-time SHP2-filter rollover; a
fingerprint generalises it, because membership can change again. HA's
`state_class: total_increasing` reads the step down as a meter reset, which is
the honest interpretation: the series is now measuring a different set of
batteries. A STABLE roster still ratchets monotonically — a device that goes
transiently offline does not re-seed anything.

### Orphaned held rows were armed to inject ~937 kWh

Held per-pack rows are keyed `(chassisSn, packSn)` but the carry gate only ever
checked the CHASSIS. After the swap, five rows worth ~937 kWh sat under Core 3
for packs that now live in Core 4, dormant only because Core 3 is off-panel.
Re-wiring it would have re-added all five in ONE 5-minute rollup — roughly 520x
the fleet's physical charge ceiling — and ratcheted the emitted
`total_increasing` floor with no rate guard.

A packSn observed in a DIFFERENT chassis this snapshot proves the row is stale,
so it is never carried. The skip is logged once per change rather than per
rollup.

Tests 2026 pass.

## v1.95.0 — alarm coverage: the SHP2 blind spot, and silence for bench hardware

### The single-point-critical data source could go dark for 17 minutes unnoticed

On 2026-08-21 the SHP2 — the source every reserve, runway and SoC alarm reads —
delivered **2 messages in 600 s** (0.20 msg/min against a 30.2 norm, a 150x
collapse) and **nothing fired**. It fell between both detectors: far shorter than
the 20-minute collapse dwell, and never silent long enough for the 180 s
staleness alarm. Four more instances appear in the preceding four days, one with
the last message 319 s old.

The 20-minute dwell exists for exactly one reason: separating legitimate Core
idle (4.4 msg/min) from a real collapse (2.1-2.9) — a 1.5x discrimination
problem created by the Cores' 13x diurnal swing. **A device with no diurnal
component has no such problem.** The dwell is now chosen from each device's OWN
measured hour-of-day profile: a flat profile (coefficient of variation ≤ 0.15
across ≥ 18 mature buckets) fires on `MSG_RATE_FLOOR_FLAT_COLLAPSE_MIN` (4 min);
everything else keeps the 20-minute dwell. No SN lists, no device-kind plumbing,
and flatness must be EARNED — thin evidence always gets the conservative dwell.

### Rate collapse no longer reports devices that are simply offline

The detector's stated purpose is catching a device "barely reporting while still
appearing FRESH". It had no offline gate, so when a Core was physically
unplugged it told the operator to "check the EcoFlow cloud session / power" for
hardware he had just disconnected himself. It still samples offline devices (so
baselines stay honest) but no longer surfaces a collapse for them — the
offline/stale alert owns that case.

### Off-panel hardware stops annunciating

Annunciation was gated solely by the static `SPARE_DPU_SNS` literal, which the
2026-08-20 reconfiguration inverted: a benched Core absent from the literal
chimed at full volume while a live home Core sat inside it. In one 3h34m window
**19 of 19 pushes and 48 of 67 seconds of audio** concerned hardware that cannot
deliver a watt to the house.

A DPU absent from a **non-empty** SHP2 roster is now demoted — with guards:

- **Hysteresis**: `OFF_PANEL_DEMOTE_TICKS` (3) consecutive absences to demote,
  but **one** sighting re-arms instantly. The asymmetry always favours noise, so
  a flickering `isConnect` can never silence a live home Core.
- **Empty roster demotes nobody.** If the panel itself is unreadable, trust
  nothing.
- **Thermal-critical carve-out.** A critical `Thermal` alert is never demoted: a
  bench pack that is overheating must page regardless of where it is wired.

Harness `scripts/mutate-off-panel-annunciation.mjs` (6/6) proves each guard
load-bearing. Tests 2023 pass.

## v1.94.0 — coverage gate, corrected: fleet membership is per-DAY

v1.93.0's coverage fix was under-implemented and **did not work**. It skipped
only cores with ZERO samples anywhere in the window; but the moment the
newly-added core logged a single day it stopped being "never reporting", and all
of its earlier absent days became coverage gaps again. Verified live: after
v1.93.0 deployed, `basisComplete` was still false and the planner still emitted
`No plan — forecast/telemetry basis incomplete`.

The gate is now per-DAY against each core's first in-window sample: a core is
excluded from a day's coverage requirement until it has actually **joined** the
fleet. A core that had not joined yet cannot make that day's actual wrong — it
contributed nothing to it. Once joined, it is held to the requirement normally,
so a real blackout on a later day still gaps that day.

Unchanged: the pv-bias path keeps the strict all-cores gate (`skipBeforeJoin`
defaults to false), because a wholly-dark core genuinely does make the fleet
actual unmeasurable and the neutral 1.0 no-op is the right posture there.

Tests 2012 pass, including a case that pins the exact v1.93.0 failure (a core
joining mid-window must not retro-gap the days before it joined) and one that
pins the guard (a post-join blackout is still a real gap).

## v1.93.0 — the night-charge basis un-sticks, and the heal budget survives a restart

### The coverage gate cost 14 nights of night-charge

`coreCoverageByDay` is consumed by two engines that want different things from a
core which produced NOTHING anywhere in the window. For the **pv-bias factor** a
wholly-dark core SHOULD fail every day — the fleet actual is unmeasurable, so the
bias degrades to its neutral 1.0 no-op, and the function's docstring reasons
exactly that way. But `computeForecastSkill` reuses the same map to null each
day's `errorPct`, and a core that has never reported cannot make a PAST day's
actual wrong; it simply was not part of that day's fleet. The second consumer was
never in view when the fail-closed posture was chosen.

On 2026-08-20 a physical reconfiguration put two cores into the PV-hindcast core
set for the first time with zero history behind them. Every one of the 30
hindcast days was marked a coverage gap, `calScoredDays` went **26 → 0** against a
hard floor of 14, `basisComplete` went false, and the planner emitted a strict
null plan — `chargeTonight=false`, `insufficient_basis` — for what would have
been **14 consecutive nights**. Measured cost of the first miss: outage
ride-through fell from ~19 h to ~2.4 h (the dollar cost was ~$0.38; this is a
resilience defect, not a billing one).

`coreCoverageByDay` now takes `skipNeverReporting`, default **false** so the
pv-bias gate is untouched, and `computeForecastSkill` passes **true**. A core with
no sample anywhere inside the window is excluded from the requirement — the same
escape hatch its sibling `fullCoverageFleetPv` has always had. A core that DID
report and then went dark for a day still fails that day, as it must.

### The rolling-24h heal budget was never persisted

`healTimesMs` lived only in process memory, so v1.90.0's "6 rebuilds per rolling
24 h" anti-thrash guarantee was really "6 per PROCESS LIFETIME". This add-on
restarts several times a day. On 2026-08-20/21 that produced **10 rebuilds in
22 h 14 m**: heals at 02:02/03:02/04:02/05:02 MST, a restart at 09:53, then a
fresh budget that reported "heal 1/6 in the rolling 24h" while 02:02 was still
inside the window.

The budget now persists to `/data/self-heal-budget.json` (atomic write) and is
hydrated on boot, pruned to the window on load. `lastHealMs` persists too, so the
cooldown also survives. `starvedSinceMs` deliberately does NOT — the dwell must
be re-earned against live telemetry rather than inherited from a dead process.

Tests: 2011 pass. Harness `scripts/mutate-session-self-heal.mjs` 8/8 unchanged.

## v1.92.0 — pool membership follows the panel, not a hardcoded list

The SoC ladder's SHP2-blind fallback (`homeFleetMeanSoc`) and the v1.90.0
reconnect auto-audit both decided "is this DPU part of the home pool?" from the
static `SPARE_DPU_SNS` literal. That literal only ever described the bench at
the moment it was written, and a physical reconfiguration inverted it: an
allowlisted bench unit took a panel slot while a home Core moved to the bench.

**Consequence, measured on the live plant.** The fallback averaged the BENCH
unit and dropped a live pool member. A bench unit charges independently, so the
reported mean acquired a hard floor of `benchSoc / 3` — with the bench unit at
63 % the ladder could not read below 21 %, making the 15/10/8/4/2 % rungs (the
entire critical half, all four `critical`-priority) unreachable during exactly
the SHP2-blind window this fallback exists to cover. The plant sat at its 10 %
reserve floor for six hours that same night; had the panel gone blind then, the
ladder would have read ~37 % against a true 23.7 % and stayed silent.

- New `isHomePoolDpu(sn, connectedOrDevices)` resolves membership from the
  SHP2's own connected-source roster, falling back to the literal ONLY when the
  roster is empty (panel cloud-dark) — a direction that errs toward including a
  device rather than silently emptying the pool.
- `homeFleetMeanSoc` and the reconnect auto-audit's device set both use it. The
  audit previously exempted a live home Core from watching while watching a
  bench unit, so powering that bench unit down for service would have fired a
  pointless 30-minute audit and a misleading [Medium] push.
- Verified against live telemetry: the fallback now reports 23.67 % (the true
  pool mean) where it had been reporting 36.7 %.
- Harness `scripts/mutate-pool-membership.mjs` (6/6 killed), including a mutant
  that reproduces the shipped defect verbatim, plus one pinning the
  empty-roster fallback and one pinning the online filter. Five new tests carry
  a non-empty `sources[]` that CONTRADICTS the literal — a case the previous
  suite could not reach, since every existing fixture used `sources: []`.

No behaviour change while the roster matches the literal.

## v1.91.0 — latent-coupling fix: four engines escape the night-charge conditional

`vendorEnergyTick` (v1.82 vendor energy ledger), `settingsDriftTick` (v1.83
settings-drift watch), `chargeNowTick` (v1.84 charge-now responder), and
`reconnectWatchTick` (v1.90 reconnect auto-audit) were registered inside
`if (nightChargeEnabled)` — none of them are night-charge features. Each had
accreted there (v1.82 → v1.90) because the block was the convenient place to
add a minute tick. With night charge enabled — the deployed reality — behavior
was correct, but the coupling was latent: the day the operator flipped night
charge off, all four engines would have silently died. No log line, no alert;
the vendor ledger, the drift watch, the charge-now responder, and the
reconnect audit just go dark. The four registrations now live at top level;
the genuinely night-charge ticks (`nightRecomputeTick`, `nightWarm`,
`nightEveningTick`, `nightActuationTick`) stay inside the conditional.

**No behavior change while night charge stays enabled** — same eight timers,
same cadences; only the registration site moved.

## v1.90.0 — five register items: the fleet audits itself

### B5 — Core 2 reconnect auto-audit (`reconnectAudit.ts`, new engine)

Core 2 returns ~Sept 1, and every review of a long outage has asked for the
same transition audit by hand. Now the add-on runs it: any non-spare DPU back
after ≥ 24 h continuously offline gets a 30-minute automated audit — online
flip time, first-telemetry latency, `offline-<sn>` alert resolution latency
(measured against the alert monitor's real tracked set), a pack SoC/spread
table at +10 min, and fleet pvCoverage at flip vs. report (the dark-core
blind-spot restoration signal). Exactly ONE [Medium] push per reconnect; a
presence flap never audits; offline tenure persists in
`/data/reconnect-watch.json` so a deploy cannot reset the 24 h clock.

### B3 — warranty evidence export (`warrantyExport.ts`)

`GET /api/warranty-export?sn=&format=md|csv|json` renders a paste-ready RMA
bundle: device error code, EMS voltage window, per-pack table (SoC/SoH/pack
voltage/spread/cycles/capacity/temp), the full per-cell voltage grid, and up
to 200 persisted alert-history rows for the serial (admitted by
id-contains-SN OR `sourceSn` — the v1.78.0 SN-less-id lesson). Spread comes
from the real cell grid when present, falling back to `maxVolDiffMv`.

### B6 — self-heal budget on a rolling 24 h window

The 6-heal cap was UTC-day-keyed: it reset to zero at exactly 17:00 MST,
granting a fresh burst mid-evening right before the nightly starvation
window. Now a rolling 24 h window — capacity frees only as heals age out.
Harness extended to 8/8 (`mutate-session-self-heal.mjs`): the prune filter
and the heal-time push are both proven load-bearing.

### B7 — the morning digest carries the ledger

One line (`vendorDigestLine`, pure, tested): yesterday's home kWh with
signed drift, solar, grid, battery out / grid-charge, and the dark-core PV
estimate. Null when the record is empty — never a hollow line.

### B10 — `-Month`/`-Year` history-code probe

`GET /api/debug/vendor-history-probe?month=YYYY-MM` asks the historical-data
endpoint whether month/year variants of the five documented `-Week` chart
codes exist (400 ms spacing, raw outcomes returned). Read-only, on-demand —
if any answer, per-circuit monthly energy becomes a one-call feature.

Also: `monitor.activeAlertIds()` — a read-only accessor for the live alert
set (the reconnect audit measures against the real alarms, not a parallel
reimplementation).

## v1.89.0 — roadmap B1 + B2: the ledger gives back

### B1 — gap-free history for the HA Energy dashboard

The local sensors' HA statistics carry every hole the add-on's accumulators
do — the 89.4 h July blackout, every deploy, the host reboots. The vendor
ledger has none of them. A new exporter (`haStatistics.ts`) publishes the
ledger as EXTERNAL statistics via `recorder/import_statistics` — five series
under the `ecoflow_panel:` source (home, solar, grid, battery grid-charge,
battery discharge), back to late June and growing daily.

- Healing is by SUBSTITUTION: pick the "(EcoFlow ledger)" series in the
  Energy dashboard; HA's own `sensor.*` statistics are never touched.
- Idempotent full re-import after every morning job (upsert keyed on
  statistic_id+start; a backfilled older day shifts the sums and the next
  export corrects every later row). Null days are SKIPPED, never
  zero-filled. One hourly row per day at noon Phoenix — daily/monthly
  dashboard totals exact, intra-day curve deliberately not faked.
- Manual full re-export: `POST /api/energy-history/export-ha`.

### B2 — the true-RTE ladder's first honest rung

The daily job now stores each day's gross pack-side charge/discharge
(`fleet.batteryChargeWh`/`batteryDischargeWh`, new on `computeTotals`) and
reports the **pack-DC round-trip ratio** (discharge/charge over qualifying
days, ≥ 2 kWh charge each, ≥ 5 days) on `/api/energy-history` and in the
morning log. Basis declared everywhere: this is the DC-side chemistry+BMS
ratio, an UPPER BOUND on the AC dispatch RTE — conversion losses are
excluded on both legs. **`DISPATCH_RTE` stays 0.86**; this series bounds it
and watches for degradation trends until an AC-side basis exists.

## v1.88.0 — package A: the register's code queue closes

- **A1 — the red retry paths are single-flighted.** On 2026-08-19 a degraded
  boot (Piper DNS down, HA 502) armed both the deferred-target retry (30 s)
  and the spoken-render retry (90 s); the first delivered the announcement
  and the second replayed the identical red — ~130 s of klaxon. A VERIFIED
  spoken delivery now cancels a matching pending spoken retry (condition-type
  pendings match on level; dedicated-message pendings on text).
- **A2 — BMS-settle noise leaves the push channel.** The settle families
  (`vdiff-crit`, `peer-voldiff`, `peer-soc`, `soc-low`, `dpu-imbalance`) hold
  their PUSH until the condition has stood 5 minutes (on-screen, audible and
  critical-escalation paths untouched), and a fire the operator saw as
  auto-tuned "[Low]" owes no "Resolved:" push (the delivered tier is now
  remembered separately from the escalation-contract severity).
- **A3** — the SHP2 card labels "Remain (disch, vendor)" — the raw vendor
  estimate is now visibly a different basis from the learned forecast.
- **A4** — pv-bias exclusion logs once per (day, core) instead of per
  evaluation (was 96× per fact, 7% of log bytes).
- **A5** — ladder boot double-fire: verified fixed by the v0.54.4 persisted
  arming + lazy first-reading baseline; zero double-fires across this week's
  eleven boots. Closed, no change.
- **A6 — the EcoFlow-enablement doorbell.** A device whose quota fetch had
  been failing ≥ 30 minutes (the persistent 1006 accessories named in the
  submitted API ticket) starting to answer triggers an info push ("EcoFlow
  data restored") — the signal that their internal processing landed.
- **A7** — verified already covered: the quiet-hours suppression log line is
  level-parameterized (yellow logs like red). Closed, no change.

## v1.87.0 — coverage honesty: a dark Core is unmeasured capacity, not a non-member

The reconciliation engine's first discovery (drift +47% on the solar pair,
two mornings running, home pair at ±1%) proved Core 2 — cloud-dark since
early August — physically produces ≈20 kWh/day that no local metric sees.
Worse, the Solar "% measured" tile read **100%** the whole time: the
`!projection` guard skipped the connected-but-dark Core before the coverage
accumulators, so a third of plant PV was invisible *and unflagged*.

- `computeTotals` now zero-fills every SHP2-connected DPU that never entered
  the PV accumulation: with one of three home Cores dark, the tile honestly
  reads ~67%.
- The vendor reconciliation stores `local.pvCoverage` and, when the basis is
  partial (< 0.95), records `impliedDarkPvWh` (vendor solar − local PV) —
  the dark Core's implied production, its only production observability —
  and annotates the morning log line ("PARTIAL basis pvCoverage 0.67 —
  dark-core production ≈ 20.2 kWh") so structural drift can never again
  masquerade as meter disagreement.

Self-validating: when Core 2 returns (~Sept), local PV jumps ~20 kWh/day,
the drift collapses, coverage returns to ~100%, and impliedDarkPvWh ends.

## v1.86.0 — resilience batch: the 08-17 audit findings close

- **The digest's material survives restarts.** `quietQueue` and the
  resolved-overnight map now persist to `/data/digest-queue.json` on every
  mutation and rehydrate at boot — the 08-17 deploys destroyed three held
  overnight fires with zero trace. The silent empty-queue digest return now
  logs its disposition ("queue empty, nothing held overnight").
- **Poll-failure warns fire on SET CHANGE only.** The four accessory devices
  that reject `/quota/all` fail every poll; the per-poll warn ran 2,336 lines
  in 40 h and buried the one real SHP2 failure. A stable set logs once (plus
  an hourly info heartbeat); any membership change warns immediately;
  recovery logs. And the telemetry-blind detector no longer counts an
  SHP2-inclusive failure as a healthy poll (`notePollOk` gating).
- **RTT-gate rejections are visible** (one debug line each — rare by
  construction), closing "gate never needed" vs "gate silently rejecting".
- **Backfill retries incomplete days**: a stored day with a null flagship
  total (2026-08-06's homeWh) is re-fetched instead of frozen forever.

## v1.85.1 — the vendor's battery-in is grid-only: name it, don't misreport it

The first 25-day backfill answered the semantics question within minutes of
v1.85.0 deploying: out/in computed to 2.41 — impossible as an efficiency —
and the day shape proves why (battery-in ≈ 0 on grid-free days, tracks the
buy nights): the vendor counts only GRID-SOURCED charging as "battery in";
solar charge is excluded. `EmpiricalRte` now carries an `interpretation`
field (`rte` / `vendor-in-is-grid-only` / `insufficient-data`), the log line
states the finding instead of printing a nonsense "RTE 2.411", and the
grid-only series is kept for what it genuinely is: bought energy into the
pool — the arbitrage volume. A true RTE needs the solar charge component;
that remains future work on a different basis.

## v1.85.0 — ledger backfill + empirical round-trip efficiency (advisory)

- **Backfill.** The vendor energy ledger now converges on a 60-day history:
  each morning's job fetches up to 10 older missing days after the daily
  record (progress saved per day), and `POST /api/energy-history/backfill?days=N`
  (N ≤ 30) triggers a bounded manual run for immediate seeding.
- **Empirical RTE (advisory only).** From stored days where the vendor
  recorded a meaningful charge (≥ 1 kWh in), the engine reports measured
  round-trip efficiency (out/in) — logged after the morning job and exposed
  as `empiricalRte` on `/api/energy-history`. It needs ≥ 5 qualifying days
  before it reports at all, zero-in days are excluded (the 08-16 record read
  batteryIn=0 on a sunny day, so the vendor's "in" semantics are unproven —
  possibly grid-only charging), and **DISPATCH_RTE stays 0.86**: nothing is
  wired into buy sizing until this baseline is understood and trusted.

## v1.84.0 — Charge Now auto-off: the July ask, finally implementable safely

New responder (`chargeNowResponder.ts`) closing the loop the vendor docs
opened: when the peak-grid-draw alert fires WITH the SHP2 reporting force
charge ("Charge Now") ON, the panel can now respond instead of only naming
the culprit. New option **Charge Now Response** (`CHARGE_NOW_RESPONSE`):

- **advisory** (default): one [Medium] push per episode naming the channel
  and unit, with both fixes (the app, or flipping this option).
- **supervised**: announces, writes `ch{n}ForceCharge = FORCE_CHARGE_OFF`
  through the audited command path (`setChannelForceCharge`, 5-min
  cooldown), then VERIFIES against the device — one retry, then an honest
  failure push. A cloud ACK is not an actuation (v1.79.0's lesson applies
  from day one).
- **off**: inert.

Safety rails, each pinned by the committed harness (5/5):
- Fires only on an active peak-grid-draw verdict, which already encodes grid
  present, genuinely on-peak, pool comfortably above reserve, and a 10-min
  dwell. The responder never re-derives the economics.
- STORM HOLD: any active storm-prep advisory stands the responder down —
  an operator pre-charging ahead of weather outranks the bill.
- One response per continuous episode; hard cap 2 supervised actions/day
  (past it, it names the condition but writes nothing — the responder can
  never fight a determined operator).
- Turning force charge OFF is the only write it can ever issue.

## v1.83.0 — the settings-drift watchdog

The 08-04 on-peak grid buy was a SETTING ("Charge Now") flipped in the app;
the 08-16 phantom write was a SETTING the cloud claimed to change and did
not. Both were invisible until the power flow betrayed them. A new read-only
engine (`settingsDrift.ts`) now watches the fleet's whole documented
configuration surface — SHP2: force-charge x3, smartBackupMode, reserve,
charge power, force-charge ceiling, storm switch, EPS, masterCur, generator
watts; each DPU: task mode, unit reserve, AC/port charge powers, SOC
ceiling/floor, AC-always-on, energy management — and announces any change
with old → new and the device name.

Discipline (each pinned by the committed harness, 5/5):
- Two consecutive identical observations before a change confirms — a
  single-poll transient never announces.
- A key present on only one side is availability, not drift: Core 2 going
  offline (or returning) announces nothing, while a value that CHANGED across
  the offline gap is still caught on return.
- The night-charge actuator's own reserve writes (10 ↔ 50 during a night in
  flight) are classified own-write and logged, never pushed. The same reserve
  moving with NO night active is external — the phantom-write mystery's
  other side is now instrumented.
- First boot adopts the surface silently as a baseline; the sidecar
  (`/data/settings-surface.json`) survives restarts so nothing re-announces.
- One batched [Medium] push per confirmed change set, held through the
  notify quiet window like resolves are.

## v1.82.0 — the vendor's own energy ledger, fetched and reconciled

New engine (`energyHistory.ts`): once per day, in the 06:35-09:00 window, the
add-on fetches YESTERDAY's energy record from the SHP2's historical-data
endpoint (`POST /iot-open/sign/device/quota/data`, documented 2026-08-17) —
home, grid, solar, generator, battery in/out, plus the per-circuit split by
SOURCE (grid / generator / battery) that cannot be computed locally at all.

Each day's record is reconciled against the local accumulators on the two
LIKE-BASIS pairs only — vendor home ↔ local panel-load Wh, vendor solar ↔
local PV Wh — with a signed drift percentage (noise-floored at 100 Wh).
Vendor grid/generator/battery values are recorded, not scored: the two-grid-
quantities trap (DPU ac_in vs SHP2 gridWatt) is exactly the kind of basis
mismatch that turns a reconciliation into a false alarm. Drift goes to the
log and the API — deliberately NO alert until a baseline of agreement exists.

Why it matters: local counters integrate live samples, so every deploy, host
reboot, and the 89.4h recorder blackout of 07-29 left holes nothing could
audit. The vendor ledger is the independent second opinion.

- Storage: `/data/vendor-energy-daily.json` sidecar (atomic, 120-day cap).
- API: `GET /api/energy-history` (all stored days), `?day=YYYY-MM-DD` (one),
  `GET /api/debug/vendor-history?day=` (live fetch, not stored).
- ~19 sequential vendor requests, 400 ms spacing, once daily; individual
  failures leave nulls and continue (a partial record beats none).
- Parsers are pinned to the doc's verbatim fixtures (double-nested envelope,
  string-numeral circuit rows).

## v1.81.0 — defect batch: the 08-05 queue closes out

- **The true reserve floor pushes (08-05 #3).** The on-grid 10% floor touch was
  info-tier, so the deepest pool crossing on record (2026-08-16 21:16:54)
  produced no push while the shallower 20% band pushed [Medium]. At the
  genuine floor (reserve <= 15) `shp2-below-reserve` is now a warning with a
  once-per-episode [Medium] push and normal quiet-hours queueing — still no
  siren while the grid backstops. An arbitrage-raised reserve (night-charge
  writes 50) keeps the quiet info advisory: a charge window filling the pool
  must not page nightly (the F14 contract, preserved and now tested both ways).
- **Clock samples are RTT-gated (08-05 #6).** A Date-header sample from a
  request slower than max(2x median RTT, 3s) is rejected as latency, not
  clock (the ±3s adopt-then-revise sawtooth rode 4.7s/3.8s polls; a 15.6s
  post-reboot poll inflated one adoption by ~half its RTT). When RTT is
  known, the return leg (rtt/2) is compensated out of the measurement. Cold
  start keeps an 8s absolute ceiling only, so the v1.69.0 8521-recovery path
  — the whole point of the offset — is never blocked.
- **Event-loop lag monitor (08-05 #8).** 500ms cadence, one warn line per
  minute with the observed maximum when lag exceeds 1.5s. The 08-05 review
  measured 3.5-9.7s stalls; recent audits show none — this makes that claim
  measurable instead of inferred from absence.
- The replay-gate suppression line no longer says "spoken <30 min ago"
  (stale since the v1.78.0 identity default); forecast-runtime alerts carry
  an "As of" fact (they are served from a cache up to 10 minutes old).

## v1.80.0 — Charge Now, read instead of inferred

The vendor's PD303 (Smart Home Panel 2) documentation names `ch{n}ForceCharge`
as the per-channel "charge strength" switch — which is the EcoFlow app's
**Charge Now**, the setting behind the 2026-08-04 on-peak grid buy. The alert
that watches for that event carried the sentence "Nothing in the telemetry
reports that setting directly." The platform does report it; we just did not
know the key. All keys below were verified live in `quota/all` before mapping.

- **`peak-grid-draw` names its cause.** Each SHP2 slot's force-charge state is
  projected (`Shp2EnergySource.forceCharge`) and threaded into the verdict:
  the alert now says "Charge Now (force charge) is ON for: Core 3 — turn it
  off in the EcoFlow app", or redirects to task-mode/charge-power settings
  when all three channels read OFF, or falls back to the old inference wording
  when the state is not reported. New fact row either way.
- **New SHP2 projection fields:** `forceChargeCeilingSoc` (`foceChargeHight`),
  `stormWatchEnabled` (`stormIsEnable`), `epsMode` (`epsModeInfo`).
- **New DPU projection fields:** `sysWordMode` (task mode: 0 default,
  1 self-powered, 2 scheduled, 3 TOU), `sysBackupSoc` (the unit's own reserve),
  `chgC20SetWatts` / `chg5p8SetWatts` (configured AC charging power — the
  unit-side fingerprint of a Charge Now event).

Also recorded in DOCS §12: the vendor's historical-data endpoint
(`POST /iot-open/sign/device/quota/data`, per-circuit energy split by
grid/generator/battery source) and the documented control command codes —
queued capabilities, not yet used.

## v1.79.0 — a cloud ACK is not an actuation

### Night-charge apply readback (the 08-16 phantom write)

On 2026-08-16 23:55 MST the supervised reserve write (10% -> 50%) was accepted
by the EcoFlow cloud and never took effect on the SHP2: the device-side
strategy quota read 10% all night, the pool ran its drawdown on the true
floor, ~13 kWh of planned 13.1c arbitrage silently never happened — and the
ledger scored `actuated: 1`, because the only success criterion was the API
response. Nothing in the process ever compared the device's reading to the
target.

`decideActuation` now runs READBACK VERIFICATION on every applied,
unreverted, unverified night: the device reading matching the target stamps
`applyVerifiedAtMs` (one log line); a mismatch 5 minutes after the latest
attempt re-issues the write (2 retries, each earning a fresh window, never
into a closing window); exhaustion warns the operator once ("write did not
take effect", with the forfeited kWh), corrects the ledger to `actuated: 0`,
and lets the night close through the normal no-op revert. Readback pauses on
a null reading — never retries or escalates blind. Harness:
`scripts/mutate-actuation-readback.mjs`, 5/5 killed, mutant i is the 08-16
incident verbatim.

### Grid-loss abort

A raised reserve during a grid outage cannot buy anything and manufactures a
false AT-RESERVE-FLOOR posture on top of a real emergency (the runway alarm
reads the same live field the engine raised). Grid absence during an applied
window now reverts immediately, flagged in the log as the abort path.
`gridPresent: null` (unknown) never aborts — the normal schedule holds.

### Honesty batch

- Poll lines stop laundering timeouts: a poll with per-device fetch failures
  logs at warn with the failing serials named, instead of "poll ok in
  10486ms (slow)".
- Learned baseline anomalies ("unusual for the hour") no longer raise from a
  device in msg-rate collapse — the 08-16 07:01 batch fired minutes-old spot
  values against a healthy-cadence baseline. Detection state untouched;
  raises resume on recovery.
- A prior evening's never-applied ARM being superseded (the normal weekend
  pattern — Friday and Saturday both target the Monday window) now logs its
  disposition; "3 ARMED vs 2 APPLIED" was untraceable.
- `vitalsRed` documentation corrected to what the code has always done: it
  gates writes on HOST vitals (a struggling process), not on the alert
  condition — which would have disabled the engine for the month err533 has
  stood.
- Web SHP2 card: "Charge time" renders only while actually charging
  (>50 W), closing the last consumer the v0.15.12 flow-direction fix missed.

## v1.78.0 — alarm integrity: the operator's phone tells the truth

Four defects from the 08-14/08-17 audits, all on the notification path of a
life-safety system, all fixed at their mechanism.

### The evidence gate now covers SN-less alerts (the hole v1.77.0 missed)

`Alert.sourceSn` declares the device whose telemetry proves a condition.
`fallingEdgeFrozenByEvidence` reads the declaration first and only falls back
to searching the id for a serial — the fallback that silently skipped
`shp2-src-err-<slot>`, the very alert the v1.75/v1.77 gate work was written
for. All five SHP2-derived constructors declare their source. Harness: 10/10,
including a mutant that drops the declaration ("the v1.77.0 harness passed 8/8
while missing exactly this").

### No more "Resolved: Backup pool low" while the pool is draining

The v0.44.0 band↔pair dedup removes `backup-soc-<pct>` on a WORSENING
transition (the shp2 near/below-reserve pair takes over), and the falling edge
read that vanish as a recovery — 2026-08-16 19:22:06 pushed "Resolved: Backup
pool low — 20%" three minutes before the pool sank to 15% and then to the 10%
floor, the operator's last pool push of the night. `resolveHandoffOwner` now
recognises an active coverage successor: the entry retires with no resolve
push and one honest log line. A genuine recovery (successor absent) resolves
exactly as before.

### The siren replay gate keys on identity, not a stopwatch

`RED_REPLAY_MIN_GAP_MS` defaults to Infinity: an UNCHANGED, verifiably
announced fault does not replay at boot, however long ago it was announced.
The 30-minute timer was measured to be luck — restart 2 on 08-13 escaped a
full 56.7 s klaxon by 27.5 seconds, and the 08-15 reboot replayed a fault
standing since 07-20. Every change still announces immediately: a new error
code, a new sibling critical, an escalation, or a green in between. Set
BROADCAST_RED_REPLAY_MIN_GAP_MS to restore the timed reminder.

### Resolves respect quiet hours

The falling-edge dispatch consulted no quiet window (raises did), so
"Resolved:" pushes landed at 00:02/00:53 inside the accepted 22-05 window.
A resolve owed during quiet hours now holds — the entry retries each tick —
and delivers when the window opens. Good news does not wake the operator.

### Log honesty (three audits' worth of invisible dispositions)

- SoC-ladder, grid-drop and runway audible suppressions now log their
  disposition (a silent 21:11 suppression cost two audits a false timezone
  theory).
- night-charge's config-mandated quiet-hours suppression logs at info as
  "suppressed", no longer at warn as "failed".
- The self-heal daily-cap stand-down logs once per capped day (on 08-14 the
  cap emptied 27 minutes before recovery with no trace).
- The morning-digest line carries the resolved-overnight count — "(0 alerts)"
  for a digest of two resolved items read as a lost queue in three audits.

## v1.77.0 — the 04:17 blip closed + the self-heal listener leak plugged

### A /status-offline device is not positive evidence

On 2026-08-12 04:17 the SHP2 dropped off the MQTT /status topic for 7 seconds
while REST polling kept its `lastUpdated` fresh. The v1.75.0 evidence gate checks
freshness only, so the falling edge sailed through and a false **"Resolved:
Energy source error"** pushed at 4 AM — for the standing Core 3 err533 fault that
never cleared, with the correcting re-raise only queued for the digest.

`deviceEvidencePositive` now requires fresh telemetry **and** not-currently-
offline. A device flagged offline is unevaluable regardless of data freshness;
`online === undefined` stays neutral. Harness extended to 8 mutants, 8/8 killed —
the new one ("the online flag is ignored") reproduces the 04:17 blip exactly.

### SnapshotStore listener leak (v1.76.0 regression)

Every MQTT session build registered a `store.on('change')` listener that
`stop()` never detached. Harmless when sessions were built once per boot; with
the self-heal rebuilding up to 7×/day, listeners accumulated without bound
(MaxListenersExceededWarning at the 8th build, 2026-08-13 01:06) and each leaked
closure pinned its dead client. The handler is now named and detached in
`stop()`. Found by the daily adversarial log review — the healer's first side
effect, caught within 32 hours of shipping it.

## v1.76.1 — documentation register catch-up (docs only, no code changes)

The spec register (DOCS.md) owed sections for four releases; all are now present
and accurate against the shipped source:

- **§2.14** Request-signing clock correction (v1.69.0) — the Date-header offset,
  deadband/sanity bounds, signing-only scope.
- **§2.15** Telemetry-blind self-alert (v1.69.0) — blind detection, honest
  /api/health 503, auth/network classification.
- **§2.16** Cloud-session self-heal (v1.76.0) — trigger/guards, and the measured
  maiden-night verdict recorded plainly: mechanism exact-to-spec, ineffective for
  the nightly starvation, which is upstream of the client session (recovery
  anchored ~05:11 MST). Retained as a bounded probe, not a fix.
- **§5 (grid backstop)** — GRID_FLOOR_SLACK_PCT (v1.74.0) documented at the
  floor-hardening resolver where the slack actually acts.
- **§8.9** Resolve integrity (v1.75.0) — the falling-edge evidence gate, the
  starvation-orphan boot drop, and the digest resolved-overnight section,
  including the known cosmetic log-line undercount.

README: added the committed mutation-harness inventory (six harnesses) to the
Quality section. No behavior changes.

## v1.76.0 — cloud-session self-heal + dependency sweep

### Session self-heal (`sessionSelfHeal.ts`)

The 90.5h starvation record: episodes of 43m, 69m, 5h15m, 11h47m and ~9h, with
recovery timing a lottery. The 11h47m night proved the transport CAN recover
without a restart — but nothing forces it to. Now something does.

When **>=2 devices** sit in a fired rate-collapse for **20 minutes**, the add-on
rebuilds its own MQTT session: stop, certificate re-fetch, fresh connect. Guards,
each mutation-proven load-bearing: multi-device threshold (one flaky device can
never trigger it), the 20-min dwell (transients never heal), a **60-min cooldown**
and a **6/day cap** (the 08-08 flap storm can never be reproduced by the healer
itself), and post-heal onset reset (a rebuild gets time to prove itself).

Read-path only: REST polling — the alarm data path — is untouched, and a failed
rebuild falls back to the existing startMqttWithRetry backoff. Worst case equals
the status quo; best case turns a 9-hour starvation into a ~20-minute one.
Tuning via env: SELF_HEAL_MIN_DEVICES / SELF_HEAL_AFTER_MS / SELF_HEAL_COOLDOWN_MS
/ SELF_HEAL_MAX_PER_DAY.

Proof: `scripts/mutate-session-self-heal.mjs` — 7/7 mutants killed.

### Dependency sweep (closes #304, #305, #306, #307)

fastify 5.11.2, @fastify/static 10.1.3, ws 8.21.2, tsx 4.23.11, vite 8.2.1,
postcss 8.5.26, codeql-action v4.37.6 (SHA-pinned). No security advisories this
round; npm audit clean in both workspaces; full suite (1916) run once against
the combined tree.

## v1.75.0 — an alert may only resolve on POSITIVE evidence

Three delivery-integrity fixes from the 90-hour review, all in the alert monitor.

### 1. The falling-edge evidence gate (the 08-08 flap storm)

On 2026-08-08 13:11-13:22 an EcoFlow cloud presence flap made device projections
unevaluable, and the monitor read "alert no longer computed" as "condition
recovered" — emitting false **"Resolved:"** pushes for the STANDING Core 3 err533
battery-protection critical, then re-raising it. 12 pushes of churn, and an
operator taught that a resolve can be a lie.

Now: an alert whose id names a source device resolves only when that device is
present with fresh telemetry (`ALERT_EVIDENCE_STALE_MS`, default 5 min — the
telemetry-blind bound). A device going absent/stale FREEZES its alerts' falling
edges and resets any accrued resolve-dwell: unevaluable is not recovered.
Families whose subject IS absence (`offline-*`, `msg-rate-floor-*`, `zombie-*`)
are exempt — their clear is computed from the very signal that gates here — and
system alerts with no source device are untouched.

### 2. Starvation alerts never get a boot-time "Resolved:"

The orphan sweep retired persisted notify-records at boot with a "Resolved:" push
when owed. For msg-rate-floor that fired while the Cores were still starved (twice
on 08-05) — rates are unknowable in the boot window, so there is no positive
evidence to resolve on. Starvation orphans are now silently dropped; a persisting
collapse re-fires within its dwell and replaces the stale card.

### 3. The digest reports what self-resolved overnight

The 08-06 5h15m tri-Core starvation queued at 23:56, self-resolved at 05:11, and
the 06:00 digest said "nothing to send" — a five-hour event the operator never
saw. Digest-held alerts that self-resolve are now reported in an informational
section with fire time, clear time, and duration ("fired 23:56, self-resolved
05:11 (5h15m)"), while stamping NO notified-record — preserving the v0.97.0
re-fire-suppression fix this section coexists with.

### Proof

`scripts/mutate-resolve-evidence.mjs` — 7/7 mutants killed, including the three
review-invisible ones: the gate silently becoming a no-op, the exempt list being
"safely" emptied (which would freeze starvation resolves on their own gating
signal), and boot resolve-pushes returning for starvation orphans. 1910 tests.

## v1.74.0 — the austerity pre-arm point is now yours to set

On 2026-08-05 at 19:24 the lighting posture went RED at **11% SoC with the grid up**,
dimmed the house for 19 minutes, and restored. Working as designed — but the arm point
was hard-coded. The chain: the floor-hardening slack (+1.5% above the 10% reserve)
declared the pool "at the floor" at 11.5%; the pool was still discharging with no
measured grid flow (the SHP2 had not yet transferred), so the resolver refused to
trust the declared grid — deliberately, because a wedged "Grid OK" reading must not
mute a real at-floor outage — and the depletion-red fired.

### New option: `GRID_FLOOR_SLACK_PCT` (default 1.5)

Percentage points above the reserve at which floor-hardening (and therefore austerity
pre-arm) engages. At the observed evening drain (~7%/h) each 1 point is ~9 minutes of
earlier warning. `0.5` trims most grid-up dim events; `0` arms only at the reserve
itself; clamped 0-10; blank keeps 1.5. Read per tick, so a config change applies on
restart without a rebuild. The CRITICAL floor alarm's own +1.5% coherence check is
untouched — this tunes the lighting/backstop pre-arm only.

Suite 1900 tests (blank-option, garbage, and clamp edges pinned — `Number("")===0`
would otherwise have silently turned a blank option into slack 0).

## v1.73.1 — proof and polish for v1.73.0

The recovery-latch code itself shipped inside v1.73.0 (two work threads shared one
working tree and the latch rode along in that commit) — but unproven, undocumented,
and with the attribution-label defect still present. This release adds the proof and
the fix:

### The latch: losing the ability to judge is not recovery

The disarm trapdoor had a twin on the CLEAR side, observed live on 2026-08-04:

```
18:44  Core 1 collapsed to 2.00 msg/min (baseline ~42)   <- correct detection
19:35  Core 1 message rate recovered (2.0 msg/min)       <- FALSE all-clear, 95% starved
20:28  Core 1 message rate recovered (21.0 msg/min)      <- the real recovery, 53 min later
```

A fired collapse used to clear whenever `isCollapsed` went false — but that can happen
for reasons unrelated to the device improving: an immature hour bucket learns the
starved rate itself, matures low, and the comparison threshold collapses underneath
the alarm. Clearing now demands genuinely healthy traffic: the rate must beat BOTH the
relative test and `minBaselineRate` absolute — if the device could not QUALIFY for
monitoring at this rate, it has not RECOVERED at it — dwelled as before, with both
dwell edges (the 05:06 burst lesson and the 5-msgs-per-19-min evasion) preserved.

### Also

- Per-Core attribution in the peak-grid-draw alert read `d.name`, which does not exist
  on the snapshot (`deviceName` does) — the alert would have named Cores by raw serial.
  Now "Core 1 (7.2 kW)".

### Proof

1899 tests. `scripts/mutate-rate-floor.mjs` extended **8 -> 13 anchor-asserted
mutants**: the resurrected 19:35 false all-clear, the latch clearing on any
non-collapsed sample, eligibility read off the comparison baseline again, a
never-decaying mark, and the one-way guard form — plus a guard-below-the-floor killer
test (baseline 8, proven 40: the guard must hold AND the collapse must still fire).


## v1.73.0 — a collapse can no longer disarm the collapse detector

`msg-rate-floor` is the only detector that catches a device REPORTING but STARVED —
the failure that defeats both the staleness alarm and the recorder-gap detector,
because the device keeps `lastUpdated` fresh while sending almost nothing.

It had a trapdoor, and on 2026-08-05 it swallowed the whole fleet. Cores 1/2/3 were
measured at **1.6 msg/min against ~43/51/46 baselines — 3-4 % of normal — for 8.5+
hours**, and nothing fired. The detector had logged `NO LONGER MONITORED` for each of
them at 01:02, 01:04 and 01:06, then gone silent.

**The mechanism was one line.** Eligibility was read off the comparison baseline, and
the guard protecting the global baseline was itself gated on it:

    const globalCollapsed = prev.baseline >= minBaselineRate && rate < floorFraction * prev.baseline;
    if (!globalCollapsed) { baseline = alpha*rate + (1-alpha)*prev.baseline; }

Once `prev.baseline` fell under the floor, `globalCollapsed` could never be true again.
The guard switched off, the estimator learned unguarded from the collapse samples, and
the baseline free-fell — the SHP2 reached ~0.9 msg/min from a healthy ~30. The
protection was gated on the value the collapse was destroying: observing the fault is
what disabled the alarm for the next one.

**The fix separates "has this device PROVEN it is chatty?" from "is it chatty right
now?"** — the second question is the one a collapse can answer with a lie. Eligibility
now comes from a high-water mark that only rises to meet a live rate and otherwise
decays on a 7-day half-life, so an 8-hour blackout costs it ~3 % and cannot push it
under the floor. The same mark gates the baseline guard, which closes the free-fall.

It is deliberately NOT a latch: a device genuinely reconfigured to be quiet still ages
out of monitoring in about eleven days, so the detector cannot nag forever about a
change that was intentional.

Two things that would have made this cheaper to find, both fixed:

- `eligibilityPeak` is surfaced on every sample and printed with each collapse. There
  was previously NO way to ask "is this device still being watched?" — only the
  `eligibilityLost` edge was logged, so silence was identical for "armed and healthy"
  and "disarmed six hours ago". Answering it required diffing raw MQTT counters by hand.
- `hydrate` seeds the mark from already-learned state. Defaulting it to zero would have
  left every device ineligible until it re-proved itself — a fleet-wide blind spot
  caused by shipping the fix for a fleet-wide blind spot.

Telemetry was restored operationally by restarting the add-on: Cores went 1.6 ->
62.7 / 64.0 / 60.7 msg/min (38-40x) while the healthy SHP2 held at 29.6 -> 30.7. That
control is what proves the fault was the add-on's cloud session, not the devices.

1895 tests. The Core scenario is pinned as a test: 8.5 h at 1.6 msg/min must keep the
device eligible AND fire the collapse.

## v1.72.0 — dependency sweep: every open security alert closed

Six open Dependabot PRs, all 11-13 commits behind main, four of them security. Merging
them one at a time would have meant six CI cycles with each merge staling the next, and
six separate partial test runs. Applied as ONE change instead, so the full suite runs
once against all the updates **together** — which is the thing that actually proves the
alarm engine still works.

### Security (all HIGH unless noted)

| Package | To | Advisory |
|---|---|---|
| `ip-address` | 10.4.0 | leading-zero octets decoded as decimal vs octal (SSRF / trust-boundary bypass); CIDR suffix suppresses special-use classification (medium); IPv4-mapped/NAT64 misclassification (medium) |
| `fast-uri` | 3.1.5 **and** 4.1.2 | host confusion via backslash authority — both vulnerable ranges were present in the tree |
| `brace-expansion` | 5.0.9 | DoS via unbounded intermediate arrays |

`npm audit` on `server/`: **3 high → 0 vulnerabilities.** `web/` was already clean.

### Non-security

- `fastify` 5.10.0 → 5.11.0 (the HTTP server the whole alarm API runs on)
- web dev tooling: `vite` 8.2.0, `postcss` 8.5.25, `@vitejs/plugin-react` 6.0.5
- GitHub Actions (SHA-pinned): `codeql-action/{init,autobuild,analyze}` v4.37.4, `docker/login-action` v4.6.0

### Verification

- `npm audit` clean in both workspaces
- `tsc` clean: server src, server test config, web
- **1891 / 1891 tests pass** on fastify 5.11 and the new transitive tree
- web production build succeeds on Vite 8.2

Closes #279, #280, #281, #284, #285, #286.

## v1.71.0 — correcting v1.70.0: the cause was per-unit "Charge Now", not the panel

v1.70.0 attributed the on-peak grid draw to `smartBackupMode: 2` on the Smart Home
Panel. **That was wrong.** The operator identified the real cause: **"Charge Now",
a PER-DPU setting** in the EcoFlow app, enabled on individual Delta Pro Ultra units.

The evidence is unambiguous. When Charge Now was switched off:

```
grid import      16.6 kW  ->  0 W
smartBackupMode        2  ->  2      (unchanged)
backupReserveSoc      10  ->  10     (unchanged)
timeTask.isEnabled false  ->  false  (unchanged)
```

Every field in the SHP2 strategy blob was byte-identical across the transition. The
setting was never on the panel at all — which also explains the ~16 kW magnitude:
several Cores each pulling their own AC charge simultaneously, not one panel-level
decision.

### What this changes

**Attribution corrected** throughout the module docs, the DOCS.md spec section, and —
most importantly — the operator-facing alert text, which previously sent the reader to
a Smart Home Panel setting that had nothing to do with it.

**The alert now names WHICH Cores are drawing.** Because Charge Now is per-unit, "which
Core" is the actionable part of the report. Attribution comes from each DPU's own
`acInWatts` — the same field `aggregateFleetFlow` sums into `acIn`, so the parts always
reconcile with the total. Cores below 500 W are treated as standby and not named.

```
Drawing   Core 1 (7.2 kW), Core 3 (4.4 kW)
```

### The design point this vindicates

Nothing in the SHP2 strategy, and no DPU field this add-on projects, exposes Charge Now
directly. It is **invisible in telemetry**. That is precisely why the detector infers
from power flow rather than reading a mode flag: the only observable is the energy
actually moving. A flag-reading implementation would have been unbuildable.

### Proof

`scripts/mutate-peak-grid-draw.mjs` extended to **15 mutants, 15/15 killed**, including
two new ones on attribution: reversing the sort (pointing the operator at the least
guilty Core first) and naming idle Cores as culprits.

## v1.70.0 — buying on-peak energy to fill a battery the night engine refills cheap

At 17:22 MST on 2026-08-04 — inside the APS R-EV on-peak window — the plant was
importing 11.6 kW against a 6.5 kW house load with 1.3 kW of PV. Eleven minutes later
the house load had fallen to 2.6 kW and the import had *risen* to 16.6 kW:

```
17:22  import 11.6 kW | load 6.5 kW | pv 1.3 kW | soc 41%  -> 6.5 kW into the pack
17:33  import 16.6 kW | load 2.6 kW | pv 2.2 kW | soc 45%  -> 16.2 kW into the pack
```

At the confirmed on-peak rate of 44.4 c/kWh that is **$7.19/hour**, for energy the
overnight window buys at 17c or less. Nothing in the system noticed. The operator did,
by reading the numbers.

**Cause.** `smartBackupMode: 2` on the SHP2 — outage-readiness top-up — after the panel
reset. Neither knob this add-on can write was involved: `backupReserveSoc` was already
at its floor of 10, and the scheduled charge task was `isEnabled: false` (its windows,
10:40-14:40 and 15:40-16:00, are already designed to end exactly when on-peak begins).
That setting is changed in the EcoFlow app; the add-on does not own it, so this release
makes the condition **visible and quantified** rather than pretending to fix it.

### On-peak grid-to-battery detection (`peakGridDraw.ts`)

Raises a **warning** when meaningful grid import is going into the pack during on-peak.
Deliberately a warning and never critical: every critical in this system means something
may hurt you or the plant, and putting money in that tier teaches the operator to discount
the tier that must never be discounted.

**The guard matters more than the detection.** At or within 10 points of the reserve the
detector stays silent, because buying on-peak *is correct* there — the plant is restoring
its own outage protection, and in a Phoenix summer that outranks the bill. An alert in
that state would be advising a genuinely unsafe trade.

Also: a 10-minute dwell (an EV plugging in is not a buying pattern), an 800 W floor
(the residual mixes a DPU-measured import with an SHP2-measured load, so it is a
"several kW of deliberate charging" detector, not an energy-balance instrument), silence
during an outage, and `null` rather than a fabricated cost when tariff rates are
unconfirmed.

### One tariff, every consumer

`apsREvRatesFromEnv` moved from `index.ts` (where it was private) into `tariff.ts`, with
a new `apsREvModelFromEnv()`. The detector reads the *same* model `index.ts` does, so the
two engines cannot drift apart on when on-peak starts.

### Proof

`scripts/mutate-peak-grid-draw.mjs` — **13/13 mutants killed**. The three starred ones are
the regressions that would be invisible in review: removing the below-reserve safety guard,
fabricating a cost when rates are unconfirmed, and `evaluatePeakDraw` failing to thread the
onset (which leaves every unit test green while the alert can never fire in production).

## v1.69.0 — the alarm system went blind for 22 minutes and reported healthy

Eric powered the house down to reset the SHP2. The Pi has no battery-backed RTC, so it
booted with a stale clock, and DNS was still coming up (`EAI_AGAIN` at 16:20) so
systemd-timesyncd could not sync. The clock sat **170 seconds behind**.

EcoFlow signs every request with a timestamp. At −170 s every signature was rejected:

```
16:26:19 poll failed: EcoFlow API error 8521: signature is wrong
...continuously until 16:43:22 poll ok (recovered)
```

For 22 minutes the add-on held **zero telemetry** — `/api/snapshot` had `generatedAt: 0`
and an empty devices map — and could not have seen a fire, a grid loss or an empty
battery. Meanwhile:

```
/api/health  →  { "ok": true, "vitalsLevel": "ok" }
```

Nothing alerted. It resolved only when NTP eventually caught up, and surfaced only
because the operator asked for a log review.

### Signing no longer trusts the local clock

Restarting the client does **not** fix this — signatures are computed fresh per request
from the same wrong clock, so a rebuild re-signs identically and fails identically. That
was the obvious "self-heal" and it is useless here.

Every HTTP response carries a `Date` header, **including the 8521 rejection itself**. So
the first rejected request tells us exactly how far off we are, and the next one signs
against corrected time. Recovery in one poll cycle instead of waiting on NTP.

The offset is bounded (an absurd delta is a broken header, not a skewed Pi), has a
deadband (sub-2 s deltas are latency, not skew), and is used **only** for request
signing — it never touches recorder timestamps, alert onsets or night-charge windows,
which must stay on the system clock or history would shift under them. An adopted
correction logs at WARN naming the host clock, because a silent correction would hide
the very fault it compensates for.

### The blindness itself is now an alarm

`telemetryBlind.ts` raises a **CRITICAL** when there is no usable telemetry past a grace
window. It requires BOTH live devices and a recent successful poll — a stale device map
left over from before an outage is not sight, and treating it as such is exactly how this
hid. When the failure is auth-shaped the alert names the clock, not the credentials.

`/api/health` no longer returns a hardcoded `ok: true`. It reports `ok: false` **and HTTP
503** when blind, so the HA watchdog and any uptime probe can see it. A health endpoint
that cannot say "unhealthy" is decoration.

- `scripts/mutate-telemetry-blind.mjs`, committed: **9/9 mutants killed**, anchor-asserted.
  Mutant `ix` is the one worth keeping: signing ignores the learned offset while still
  measuring and logging it, so everything *looks* wired and the fix is a silent no-op.
- 15 new tests (1872 total).

**Still needs the host:** signing now self-heals, but the Pi's clock is still wrong after
a power cut until NTP syncs, and everything else on the host inherits that. See the NTP
hardening note in DOCS.

## v1.68.0 — every Configuration field re-verified, and a Spanish translation

Two things: the add-on's Configuration page now explains itself accurately, and it does so in
Spanish as well as English.

### The English was audited against the code, not polished

All 80 option descriptions were re-derived by reading the code that actually consumes each
option — the env var, `config.ts`, and the point of use — rather than by editing the previous
text. 79 of 80 changed. The rewrite rule was: lead with the EFFECT on the system, name the real
default and unit, and say plainly when an option is dangerous or only meaningful alongside
another. Several descriptions were not merely vague but wrong:

- **`BROADCAST_QUIET_HOURS`** claimed alerts held overnight arrive "in the morning digest".
  They do not — the digest is driven by `NOTIFY_QUIET_HOURS` / `NOTIFY_DIGEST_HOUR` in
  alertMonitor, a different subsystem. This gate holds only the SPOKEN announcement; the
  on-screen alert appears immediately. On a life-safety option, a false reassurance about where
  a suppressed critical resurfaces is the worst kind of documentation bug.
- **`ARB_CHARGE_CAP_KW`** described 7.2 kW as the "real SHP2 grid-charge power ceiling". It is
  the observed `chChargeWatt` on this install, not a published hardware spec.
- **`BROADCAST_ANNOUNCE_RETRIES`** did not say that the retry fires only when the Music
  Assistant service call itself errors — so it cannot recover an announcement you simply did
  not hear, which is what an operator raising the number would be hoping for.

### Spanish (Latin American)

`translations/es.yaml`, 80 keys, in the same order as `config.yaml`. Neutral Latin American
Spanish, formal *usted* for instructions. Product and proper nouns stay in English (EcoFlow,
Home Assistant, Smart Home Panel 2, Music Assistant, Wyoming, Piper, Core), as do entity ids
and literal config values. Home Assistant picks the file matching the user's profile language
and falls back to English, so nothing changes for an English user.

### The validator now guards every language, not just English

`scripts/validate-addon-config.py` hardcoded `en.yaml`. A second translation file that nothing
checks is a second file that silently drifts — rename a key in `config.yaml` and English keeps
rendering correctly while Spanish speakers see the raw KEY, with CI green throughout. It now
iterates every `translations/*.yaml`, requires `en.yaml` to exist as HA's fallback, and also
rejects an embedded newline in either field (which breaks HA's single-line helper rendering).
Verified by deliberately corrupting a key in `es.yaml` and confirming a non-zero exit.

## v1.67.0 — the night-charge announcement said everything twice in English

The bilingual broadcast plays English, then Spanish. Last night's night-charge notice played
English, then English again.

Not a TTS fault and not a missing voice: **the Spanish pass was never requested.**
`announce()` took Spanish as an OPTIONAL third argument —

```ts
announce: (priority, message, messageEs?: string) => ...
```

— and two call sites simply omitted it. With `messageEs` undefined the bilingual gate fails:

```ts
const bilingual = cfg.bilingual && secondVoice.length > 0
  && message != null && message.trim().length > 0
  && messageEs != null && messageEs.trim().length > 0;   // <- false
```

`messages` is then undefined, the render falls back to the legacy monolingual path, and on that
path `announceRepeat` applies — which is set to 2. Hence the English twice. The comment on that
line reads "ignored when bilingual", and that is exactly the trap: it stops being ignored the
moment the Spanish text is missing.

### The second site was worse

The same bare two-argument call carried the CRITICAL reserve-revert failure — *"the night charge
system could not restore the backup reserve… the reserve is stuck at N percent."* A Spanish-speaking
member of the household would have heard that emergency in English only, twice.

The three call sites that already passed Spanish (the SoC ladder and the runway alarm) were
unaffected, which is why this only ever showed up on night-charge messages.

### Fixed so it cannot recur

Both night-charge messages now carry Spanish, including a Spanish spoken-deadline formatter
(`fmtDeadlineSpokenEs`, weekday names translated, same clock string).

More importantly `messageEs` is now **required** — `string | null`, with `null` written
explicitly where a message is genuinely monolingual. Omitting it is a compile error rather than
a silently wrong broadcast. And when the add-on is configured bilingual but a caller supplies no
Spanish, the render now logs that it is degrading to a monolingual pass and names it a caller
bug, instead of being indistinguishable from a working bilingual broadcast.

## v1.66.0 — the rate-floor detector was unreliable in BOTH directions

`messageRateFloor.ts` is the only detector covering "a device still reports, but is
starved" — the mode that defeats both the staleness alarm and the recorder-gap detector.
Its v0.92.0 header asserted a property the code did not have:

> The baseline is a slow EWMA updated ONLY from healthy samples, so a collapse cannot
> drag the baseline down to meet itself.

That was false. "Healthy" meant `rate >= 0.2 x baseline`, so every sample in the band
`[0.2B, B)` still dragged the baseline down at alpha 0.2. Two failures follow from it, and
the 2026-08-02→04 logs contain a worked example of each.

**False negative.** Core baselines eroded 47 → 32 over two days. By 08-04 they had fallen
far enough that an 11.7 h fleet-wide collapse — all three Cores pinned at 2.7-2.9 msg/min,
~96 % of telemetry gone — fired nothing at all. The SHP2 fired only because it is flat-rate.

**False positive.** 08-03 19:24 Core 2 fired at 4.0 msg/min against a baseline of ~40. But
19:00-22:59 is the Cores' real idle window, measured at 4.4-6.2 msg/min every single day.
Its baseline simply had not eroded yet.

### One scalar cannot describe a 13x diurnal swing

Measured hour-of-day medians, msg/min:

| | 19:00-22:59 | 23:00-01:00 | 08:00-18:00 |
|---|---|---|---|
| Cores | 4.6-6.2 (idle) | 32-34 | 47-60 |
| SHP2 | 30.0-30.7 | 30.0-30.7 | 30.0-30.7 |

Legitimate Core idle (4.4) and a real collapse (2.1-2.9) are only ~1.5x apart, so no single
global threshold separates them — but the hour-of-day does, cleanly. The comparison baseline
is now a per-hour-of-day EWMA, matching the convention `analytics.ts` already uses for
exactly this reason ("hour-of-day … so daily cycles don't false-alarm").

The hour bucket is **asymmetric** — it rises at alpha but decays 10x slower — so a ramp-down
cannot walk it down to meet the collapse. It is not frozen: a genuine permanent slowdown
still converges, over days instead of minutes. That matters, because the diurnal swing is
real and a frozen baseline would re-create the 19:24 false positive.

### Both edges are dwelled now

v0.92.0 took 20 minutes to fire but **one** 60-second sample to clear — a 20:1 asymmetry in
the wrong direction for a safety detector. It cost 27 minutes of silence inside the 08-04
episode (the 05:06 burst), and it meant a device emitting 5 messages once every <=19 minutes
— about 1 % of baseline — reset the timer forever and never fired at all. A recovery must
now persist too.

### The transition that hid all of this

When a baseline falls under `minBaselineRate` the device stops being eligible and the
detector goes quiet for it. v0.92.0 logged **nothing** on that transition, so "no alert" and
"no longer watching" were indistinguishable in the log. It now emits a WARN naming the device.

### Learned baselines persist

An hour bucket needs ~30 healthy samples of that hour before it outranks the global
fallback. This add-on restarted 18 times in one 50 h window, so in-memory buckets would
never mature and the fix would be inert in production. Only what was *learned* is persisted —
never in-flight collapse timers, so a restart cannot resurrect a stale collapse. Every path
fails open: a missing or corrupt file just cold-starts on the global baseline.

### Notify failures are now visible to level-based triage

`startAlertMonitor` took a single level-less sink, so all six of its genuine failure sites —
including the top-level catch around the entire alert-evaluation cycle — logged at info.
Scanning the add-on log for `level >= 40`, which is the triage this project actually runs,
returned a clean bill of health while the alarm's only non-audible escape path was failing.
Same defect, same fix, same shape as `startMqtt` (v1.3.1). The five per-tick analytics
catches are deliberately NOT promoted — they fire on transient upstream hiccups while the
fleet is healthy, and would drown the signal.

- `scripts/mutate-rate-floor.mjs`, committed: **8/8 mutants killed**, every mutation
  anchor-asserted so a mutation that fails to apply aborts the run instead of reporting green.
  Mutant `iii` is a bug this rewrite actually introduced and the suite actually caught —
  gating the hour bucket on the *global* view deadlocks the bootstrap, because an idle hour
  looks like a collapse against a busy-hours global and so can never learn.
- 9 new tests (1857 total).

## v1.65.0 — half the Energy Dashboard was named "Circuit N"

The SHP2 wires all twelve breaker channels as six split-phase pairs, and it stores
the operator's name on the **primary** (lower) channel only. The secondary keeps its
factory `chName`. Per-circuit MQTT discovery named each leg from its own channel, so
six of the twelve Energy sensors published as **"EcoFlow Circuit 3 Energy"**,
"Circuit 4", "Circuit 7", "Circuit 8", "Circuit 11", "Circuit 12" — entities with no
recoverable meaning in the Energy Dashboard, sitting next to the named half of the
very same circuit.

Both legs are separately metered conductors and both carry real energy, so the fix
labels them from the pair rather than merging them: **"East Wing L1" / "East Wing L2"**.
Merging into one entity per pair would have orphaned six sensors' worth of recorded
long-term statistics.

### Renaming is safe, and that was checked before it was written

HA mints `entity_id` once, at first discovery, and persists it against `unique_id`.
Here `unique_id` is `ecoflow_circuit_<ch>_lifetime_kwh` — keyed to the **channel
number**, never to the name. Editing the discovery `name` therefore moves the friendly
label only: `entity_id`, existing Energy Dashboard configuration and all long-term
statistics survive untouched. Verified against the live entity registry before the
change, not assumed.

### The trap this could have shipped as a no-op

`planCircuitDiscovery` is latched on a signature so a steady-state tick republishes
nothing. That signature was built from the **raw** per-channel name — and a secondary
leg's raw name is "Circuit 3" both before and after this change. A signature over raw
names would have been byte-identical across the rename, the caller would have skipped
publishing, and nothing would ever have reached HA. The signature is now built from the
**derived** label, with a regression test that pairs two channels and asserts the key
moves.

Unrelated, same release: the Strategy page is reordered to lead with tonight's
night-charge plan, then forecast & storm-prep, with circuit shed-order moved to the
foot of the page.

- 7 new tests (1850 total): pair naming, channel-order-not-array-order, unpaired
  passthrough, unnamed primary, latch-key movement, primary rename propagating to both
  legs, and `unique_id`/`value_template` immutability.

## v1.64.0 — a standing critical klaxoned on every restart; the gate now knows WHICH fault

`critical_alerts` has been **≥ 1 for 98.8 % of live coverage**. Core 3 Pack 1 carries
a standing "Battery protection fault", and a RED is never restart-suppressed, so
every add-on restart re-announced it aloud. On 2026-08-03 five deploys produced
**five klaxons in four hours** — 5 of 5 restarts, 61–237 s after each. On 2026-08-02,
10 of 11 restarts did the same.

Each announcement was correct in isolation and worthless in aggregate. The loudest
tone the system has was being spent, several times a day, on a fault the household
already knew about — which is how an alarm becomes background noise.

### Why the obvious fix was the wrong one

`isRestartContinuation` suppresses a re-spoken yellow/green after a restart and
returns `false` for red on purpose. Its comment gives two reasons, and the second
is load-bearing: **that function sees only levels**. A rate limit keyed on level
alone would match `red ≤ red` and swallow a **new, distinct critical** that fires
during the warm-up window while a pre-restart red is still active — muting a fresh
emergency behind a stale one. Extending it to red would have traded a nuisance for
that.

### ★ Why a gate keyed on the bare alert ID was ALSO unsafe

An alert **`id` names the source, not the fault.** `dpu-err-<sn>` is emitted for
**every value of `sysErrCode`** — alerts.ts holds that id constant on purpose (a
standing fault must not re-raise as a new alert on upgrade) and flips only the
*title* between "Battery protection fault" (5xx band) and "Inverter error code".
`shp2-src-err-<slot>` is worse: its title never varies at all, so one id covers
every code on that slot.

So the standing Core-3 fault clearing and a **different, real** fault appearing on
the same device are the *same id*. `DPU_ERR_DEBOUNCE_MS` is 3 min and re-baselines
on a code change, so *drop → 3 min → re-raise with a new code* fits comfortably
inside the 10-minute boot window. **A bare-id gate would have muted that new
fault.** Read that sentence again before touching this file.

### The identity that shipped: a fingerprint, not an id

`conditionFromAlerts` already holds the full alert objects, so identity exists at
that seam and is only lost downstream. It now returns `criticalFingerprints` —
`alertFingerprint(a)` = **`id` + `title` + `fault`** for each critical actually
counted into the level. `Alert.fault` is a new, optional, *discrete* sub-identity:
the device-reported error code, threaded out explicitly at the two sites whose ids
span multiple faults (`dpu-err`, `shp2-src-err`).

Three fields, and each is there for a reason:

| field | why it discriminates | why it is stable |
|---|---|---|
| `id` | the source: device / slot / pack | never varies for a given source |
| `title` | flips when the meaning changes ("Battery protection fault" ↔ "Inverter error code") | a fixed vocabulary string; carries no measurement |
| `fault` | the error CODE — the only discriminator when the title is constant | already debounced 3 min; a discrete device register, not a reading |

**`detail` and `facts` are deliberately NOT folded in.** `vdiff-crit` prints a live
`cell spread <n> mV` and `soh-crit` a percentage; hashing those would make every
tick a new fault and turn this gate into a silent no-op — the failure mode that
looks like it works and never suppresses anything. Both directions are tested: a
code change on one id must announce, and a genuinely unchanged fault must stay
suppressed while the telemetry around it moves.

`criticalIds` still exists, for the **log line only**. Never hand it to the gate;
the gate rejects anything that is not a well-formed fingerprint and degrades to
*always announce*, so a miswiring here can only ever get louder.

### ★ It records only what was actually SPOKEN

`ttsService.buildAlertMessage` voices exactly **one** alert — `pickPrimaryAlert`'s
choice. With two criticals active, the second is counted, displayed and pushed,
but never named aloud. Recording "every critical that was active" would therefore
file a never-spoken critical as *already announced*, and a post-restart red
consisting solely of that critical would be muted. It measurably was.

So the gate records the fingerprint of `pickPrimaryAlert`'s choice, and suppresses
only when the critical that **would be voiced now** is that same fingerprint. The
active-fingerprint set is still persisted, but only ever to *force* an announce
when something unrecognised has appeared alongside it — never to justify one less.

### Suppression conditions, in full

A red still replays at reboot. It is suppressed **only when all of these hold**:

1. inside the post-boot warm-up window (`BROADCAST_BOOT_WARMUP_MS`, 10 min);
2. this red is **not an escalation** — the last verified-successful broadcast of
   any level was itself a red (same `LEVEL_RANK` ladder the storm gate uses, now a
   single shared definition rather than two copies);
3. the critical that **would be spoken now** has the same fingerprint as the one
   that **was spoken** at the last successful red announcement;
4. no unrecognised critical is active alongside it; and
5. that announcement was less than `BROADCAST_RED_REPLAY_MIN_GAP_MS` (**30 min**) ago.

**A changed fault, a new fault, or an escalation announces immediately, at any
age.** Thirty minutes elapsed announces. Outside the warm-up window the gate is
inert. The live five-deploy sequence becomes three announcements instead of five,
and a standing fault still gets a periodic spoken reminder rather than silence.

### ★ Green resets it

Reaching **green** destroys the evidence outright, in memory and on disk. An
all-clear means the next red is a *new event*: a critical that clears and re-raises
inside the 30-minute gap must klaxon, all-clear or not. Every path that commits a
condition level goes through one `adoptLevel` helper so no future branch can adopt
green and leave stale evidence behind. The one deliberate exception is `firstTick`
— the first observation after a restart usually sees an empty alert store (green)
purely because telemetry has not populated, which is not an all-clear.

A verified **yellow** does not clear the record but demotes its `lastPlayedLevel`,
which makes the next red an escalation by rule (2).

### Fail open, always

`{lastRedAnnouncedAtMs, voicedFingerprint, activeFingerprints, lastPlayedLevel}`
persists to `broadcast-red-replay.json` via the shared atomic write (temp + rename,
same directory) — including the clear, which writes a tombstone rather than
unlinking, so a power cut mid-clear cannot leave the old state readable. Missing,
unreadable, corrupt, type-invalid, **future-dated** (a pre-NTP backward clock step
is routine on this host), or written by any earlier state shape all resolve to
*announce* — today's behaviour. So does a red with no identifiable criticals, and a
red where nothing would be named aloud. Every unknown resolves toward noise, never
toward silence.

Only a **verified-successful** dispatch is recorded, mirroring the storm gates and
the restart baseline: a broadcast nobody heard must not buy thirty minutes of
quiet. The deferred retry, the spoken retry, and the dedicated SoC/runway
announcers deliberately do not record — not recording costs at most one extra
klaxon.

The gate runs **after** the boot phantom-red hold, so only a red that survived the
one-tick confirmation can reach it; `holdBootRed`, quiet hours,
`criticalBreakThrough`, the yellow/green continuation, the storm gates and every
cooldown are untouched.

### Verification

Mutation-verified via the committed harness `scripts/mutate-red-replay.mjs` —
**24 planted defects, 24 killed**, including every unsafe simplification this
design exists to forbid: the fingerprint reduced back to a bare id; the fault
code dropped at either emitting site; a drifting field (`detail`) folded in so the
gate silently no-ops; suppression keyed on the recorded active set instead of the
one alert actually spoken; the voiced identity taken from the first critical rather
than `pickPrimaryAlert`'s; the return-to-green reset removed (in memory, on disk,
or aimed at the wrong level); the escalation carve-out removed and the shared rank
ladder mangled; plus the original nine (level-alone, inverted timer, fail-closed on
missing state, no persistence, gate applied outside the window, partial dispatch
recorded, empty set no longer failing open, clock-skew guard dropped, identity from
raw instead of counted alerts).

Tests 1,819 → 1,843.

---

## v1.63.0 — the surplus posture had no debounce, and it drives the thermostats

`sensor.ecoflow_lighting_posture` is an **actuation trigger**. The Home Assistant
automation `EcoFlow HVAC — surplus pre-cool` fires on `→ surplus` and lowers every
cool-mode setpoint; its sibling restores them on `→ normal`.

That transition had **no debounce at all**. `surplus` and `normal` share rank 0 —
correctly, since surplus is not a warning tier — but that routed every swap into
the same-rank branch, which adopted it immediately. The 15-minute
`DEESCALATE_HOLD_MS` only ever guarded CROSS-rank moves. The code said so in a
comment: *"normal↔surplus swaps freely."*

The upstream signal has no hysteresis either: `computeCurtailment` calls it
curtailed when the gap clears `CURTAIL_MIN_SURPLUS_W` (300 W), recomputed every
5 minutes. Surplus hovering near 300 W therefore flips `active` on each recompute
— and each flip wrote both thermostats and then wrote them straight back.

The one real firing on record, 2026-07-23, lasted **three seconds** end to end.

`SURPLUS_DWELL_MS` (10 min) now gates the swap in **both** directions. Symmetric on
purpose: debouncing only the entry would still let a momentary dip end a genuine
surplus event, restoring setpoints and then re-cooling — the same thrash with the
opposite sign. Staying pre-cooled a few minutes too long is cheap; oscillating a
pair of ecobees is not.

**It never delays a real escalation.** `surplus → conserve/amber/red/critical` is a
rank increase, handled by the escalate branch, still applied on the very next tick
— including straight out of a pending dwell. That is the safety property, and it
has its own test.

The dwell clock persists, so a restart mid-dwell resumes the countdown instead of
restarting it — matching how the existing de-escalation hold already behaved.

One pre-existing test asserted the old free-swap behaviour. It was **inverted, not
deleted**: the same three ticks now prove the swap is refused inside the dwell.

Mutation-verified — five planted defects, five killed: dwell disabled (3 fail),
one-sided dwell (1), flap not resetting the clock (1), escalation forced to wait
(1), dwell not persisted (1).

Tests 1,787 → 1,795.

---

## v1.62.0 — night-charge models EV contention, and stops conflating the ask with the forecast

### The charge-rate model was EV-blind

On 2026-08-02→03 the planner announced "buy ~36 kWh → 36%". At 03:00 `panel_load`
was **14.0 kW** — the EVSE drawing ~11.5 kW plus baseline — leaving the packs ~2.8 kW.
Arrival was ~31%, not 36%.

The load *forecast* was never the problem: `buildNightChargeInputs` already folds
the committed p90 EV block into `loadP90W`. The blindness was one layer down, in
`packAtWindowEndWith`:

```ts
const gainKwh = chargeCapKw * legEff * chargeFrac;   // full 7.2 kW, always
```

v1.49.0 correctly established that house load on a grid-tied SHP2 is **pass-through**
— it does not drain the pack while the charger runs — and then drew the wrong
conclusion: that the charger therefore always gets its full rate. Pass-through and
charging draw on the **same grid input**. The house held 14 kW of it.

Now the deliverable rate is per-hour `clamp(gridInputCap − houseLoad, 0, chargeCap)`,
driving both the window walk and the lift ceiling. With no envelope configured, or a
quiet window, it reduces **exactly** to the old model.

New `bindingCap: 'evContention'` (a more specific `chargePower`), an `evContention`
plan block, and rationale text for both cases. Crucially, **absent ≠ zero**: a window
with no EVSE prediction says the contention is *unmodelled* — never a reassuring "no
EV expected".

### `targetSocPct` was both the forecast and the write setpoint

That conflation turned the fix above into a regression. `nightChargeActuator` writes
`clampReserveTarget(plan.targetSocPct)`, so deriving the target from the contended
lift made the setpoint **cap** the charge: predict contention, have the car not plug
in, and the device stops below what the hardware could have delivered.

They are different quantities:

- **`setpointSocPct`** (new) — the **ask**. Solved directly on the post-window
  trough by bisection, deliberately *not* from a window walk: any lift-based
  expression plateaus at the deliverable ceiling and silently collapses back into
  the forecast. Guarded `>= targetSocPct`, so it can never sit below the old write.
- **`targetSocPct`** — the **forecast**, contention-derated. The scorer keeps grading
  against it, which is what makes under-buy detection work.

On the measured night: **ask 75%, expect 66.4%** — and the EV-blind counterfactual
also asks 75%, so this is provably not a regression in either direction.

`night_charge_target_soc_percent` now carries the **ask** (it is consumed as a write
value by the advisory automation, where the forecast would have reproduced the same
defect) and is newly clamped to [10,50] through the same `clampReserveTarget`. A new
`night_charge_expected_soc_percent` carries the forecast.

New add-on option `ARB_GRID_INPUT_CAP_KW`, default **17 kW** — calibrated from the
measurement (14.0 house + ~3.0 meter-side charge). The raw 19 kW reading is
deliberately *not* used: understating the envelope understates the deliverable buy,
which is the safe direction.

### Not done, deliberately

No EV control action. This models contention; it does not fight it. The `[10,50]`
write clamp and the announce/arm/revert machinery are untouched.

Tests 1,763 → 1,787. Both tsconfigs clean.

---

## v1.61.0 — Alert Console cleanup: no tone grid, no preview mode

Two removals, both making the page say less and mean more.

**The "Built-in tones" audition grid is gone.** It was a second place tones lived
— a flat wall of buttons duplicating what every category's tone `<optgroup>`
already offers. The built-ins are unchanged and still selectable everywhere; they
are now auditioned in place with that category's **▶ Preview tone** button.

**The global browser/speakers toggle is gone**, replaced by two buttons on each
category: **▶ In browser** and **▶ On speakers**.

That one is more than tidying — the toggle was a *mode*. You set it to speakers
to test something, moved on, and the next time you pressed Preview on a different
category you got an unintended house-wide broadcast. The destination was ambient
state living in a card far from the button that consumed it. Now each button
names where the sound comes out, and `runPreview(row, target)` takes the target as
an argument rather than reading it from the component. The speakers button is
styled apart from its neighbour because it is the loud one.

`clear` still has no spoken preview — it is a rung, not an alarm tier, and
`/api/alert-preview` takes an `AlarmPriority`. Unchanged, and still the reason the
recovery card is tone-only.

No server change: `/api/alert-preview` already took `target` in the body.

Web `tsc` and `vite build` clean; server suite unchanged at 1,763 pass / 0 fail.

---

## v1.60.0 — type-check the tests, one card per alert category, no chime-repeat knob

### `server/test/` is now type-checked, and gated in CI

Nothing type-checked the 188 test files. `tsx` strips types at runtime, so the
suite stayed green while stubs drifted arbitrarily far from the interfaces they
impersonate. v1.59.0 demonstrated the cost: widening a union produced 33 RUNTIME
failures instead of 33 compile errors, and `renderCacheKey('red', …)` kept
PASSING with a stale first argument — the tests compare keys against each other,
so a self-consistent type-lie is invisible to every assertion.

**67 reported errors was a floor, not a total.** TypeScript reports one
incompatibility per object literal, so a nested-property error suppresses the
enclosing missing-property error. Fixing to a fixed point took three waves:
67 → 27 → 4 → 0.

The dominant root cause was a single idiom: `{ …7 members } as unknown as Recorder`.
The inner `as unknown` erased contextual typing (26 arrow params silently became
`any`) AND suppressed the missing-property check — so as `Recorder` grew from 7
to 17 members, not one of ~19 hand-rolled stubs complained. All were the same 10
members behind. Replaced with `makeRecorderStub(overrides: Partial<Recorder>)`;
`Partial` restores contextual typing and kills both families at once. All 21
sites were converted, not just the 4 that happened to fail — the other 17
compiled only because the cast suppresses everything, and leaving them would
make the next `Recorder` member invisible to 17 files again.

Marking those 10 members optional was rejected: production calls all ten
unconditionally, so `?` would push `?.` guards into `src/` for a case that cannot
occur, and would permanently disarm the drift detector that just caught this.

**Two real defects surfaced that no test could see:**
- `PackRiskScore.tier` was `'attention'` in two fixtures — a string that is not
  in the tier union at all (`low|moderate|elevated|critical|no-data`). It flowed
  through `computePackRiskV2` verbatim into the report shape.
- `Alert.category` was lowercase against a capitalised union. Output is
  byte-identical because `alm.ts` lowercases for grouping, but no real alert ever
  carried those values.

Escape hatches went DOWN, not up: `as unknown as Recorder` 29 → 0, `as unknown as`
72 → 44, `as any` 241 → 239. No `@ts-expect-error`, no loosened `strict`.

### The Alert Console is organised by alert category

It was organised by FUNCTION — the enable switch, the tone, and the preview for
one severity lived in three different cards. Now there is one card per rung, in
`LEVELS` order, carrying everything about that rung: badge, ISA tier, response,
description, enable switch, tone selector, tone preview, spoken preview, and the
"Will announce…" text. Global controls (broadcast master, preview target, the
tone library) stay separate, because they are not per-rung.

**The asymmetry is stated, not papered over.** Tone assignment is per RUNG (5,
including `clear`); the enable switch and spoken preview are per PRIORITY (4).
A recovery has no enable field on the backend and no preview endpoint, so the
recovery card renders tone-only and says why. The UI is double-guarded and the
server independently rejects a non-priority preview.

Errors belonging to one category now render inside that category's card instead
of in the page header, far from the control that raised them.

### The chime-repeat knob is gone

Removed the `AlertSettings` field, the clamp, the getter, the PUT/GET plumbing,
the UI stepper, both render loops and the cache-key component. The chime plays
exactly once; both loops became straight-line pushes rather than one-iteration
`for`s.

**This is audible.** The live setting was 2, so critical and high alarms
currently chime TWICE. They will now chime once.

Removing the mandatory `x<N>` cache-key component changes the key of every render
for every user. That is safe and cannot collide — the pre-image is positional and
the token after the level separator was always `x`, now always `r`, so no
post-change string can reproduce any string this `RENDER_VERSION` ever hashed.
`RENDER_VERSION` deliberately stays at 6: its purpose is to invalidate when audio
changes WITHOUT the key changing, and here the flush is already total. Expect one
full render-cache miss on deploy.

Migration-free: `sanitize()` builds from `defaults()` and copies only recognised
keys, so a persisted settings file carrying the retired key loads cleanly and
sheds it on the next write.

### A guard against re-leaking personal data

`scripts/check-no-secrets.py` + a CI job. This was the SECOND leak into the public
repo — an earlier scrub filter-repo'd an address out, then v0.15.0 reintroduced
one in a brand-new file where it sat for 258 of the next 422 commits. The scan
covers the real home subnets, personal addresses, the DID and VoIP.ms references,
and deliberately does NOT flag the HA Supervisor range `172.30.32.0/23` (public,
and load-bearing in the ingress-source pin) or the placeholder subnets — a checker
that cries wolf gets disabled, which is how it would happen a third time.

Tests: 1,763 pass / 0 fail. Both `tsconfig.json` and `tsconfig.test.json` clean.

---

## v1.59.0 — one severity ladder: a distinct tone per alarm rung

Closes the "four alert types listed but only three can be selected" complaint,
and the deeper problem underneath it.

**The problem.** The alarm engine has always classified on four ISA priorities
(P1 critical / P2 high / P3 medium / P4 low), but the *audible* path collapsed
them to three levels — `klaxonLevelForPriority()` mapped critical+high → `red`
and medium+low → `yellow`. So P1 and P2 sounded identical, as did P3 and P4. The
Alert Console listed four types because the engine has four; it offered three
tone slots because the audio path had three. Both were telling the truth about
different things.

That collapse matters most on the path where it is least visible. When TTS is
unavailable the system falls back to **chime-only** — the tone is the entire
message. Two priorities sharing a tone means an operator woken at 3am cannot
tell "protective limit crossed" from "immediate action to protect the plant" by
ear, at exactly the moment there is no spoken text to disambiguate.

**The change.** `type AlarmRung = AlarmPriority | 'clear'` — the four priorities
each carry their own tone, plus a fifth rung for recovery. Threaded through the
whole audible path: `conditionFromAlerts` now returns the worst raised rung
alongside the legacy level, and `runBroadcast` / `scheduleBroadcastRetry` /
`noteSpokenRenderFailure` / the chime-only fallback / preview / test all take it.
Every `resolveChime()` and `renderAnnouncement()` call site resolves off the rung.

`clear` is deliberately NOT a member of `AlarmPriority`. `ALARM_PRIORITY_ORDER`
drives **retained** MQTT discovery, so a fifth member would mint
`switch.ecoflow_alarms_clear_p5` permanently with no reaper; `ALARM_PRIORITY_META`
requires an ISA string a recovery does not have; and `priorityOf()` structurally
cannot return it, because clearing is the *absence* of raised alerts, not a
classification of one.

`klaxonLevelForPriority()` survives for legacy bookkeeping (`lastLevel`, cooldown
and status reporting) but no longer selects a tone.

**Migration.** A legacy 3-key `chime-config.json` fans out across the five rungs
— `red` → critical + high, `yellow` → medium + low, `green` → clear — the inverse
of the old collapse, so whatever played for a given alarm still plays for it. Per
rung the order is: own key, else legacy level, else shipped default. It runs on
the read path, is idempotent, and needs no one-shot rewrite, which matters because
/data loss and partial restores are demonstrated events on this host.

This is the failure mode the migration exists to prevent: get it wrong and the
config still parses, the console still renders, and the operator's hand-picked
tones are quietly swapped for defaults with nothing logged — discovered only when
an alarm next sounds wrong. `test/chimeConfigMigration.test.ts` pins it, and was
mutation-verified: deleting the migration, inverting the fan-out direction, and
inverting own-key precedence each produce a failing test.

**Shipped defaults are now one DISTINCT tone per rung** (`warble-fast`,
`klaxon-honk`, `pulse-slow`, `doorbell`, `triad-up`) rather than all-doorbell —
identical defaults would recreate the very ambiguity this release removes.

`KLAXON_FOR_LEVEL` widened from three entries to five. No `AUDIO_ASSETS_VERSION`
bump: all five WAVs were already on disk (the `powerplant-*` pair was promoted to
named tones in v1.55.0), so this remaps existing assets rather than synthesizing.

**No UI change was needed** — the Alert Console renders one row per entry in the
server's `levels` payload, so widening `CHIME_LEVELS` widened the console. That is
what v1.58.1's groundwork bought.

Tests: 1,764 pass / 0 fail (1,759 + 5 migration). Both packages typecheck clean.

---

## v1.58.1 — pin the console's level vocabulary to the server's

The last piece of groundwork before the severity ladder. **No behaviour change.**

`web` and `server` share no types — the console casts `r.json()` responses to
local interfaces — so nothing coupled the console's level vocabulary to
`CHIME_LEVELS`. Worse, the three declarations that carry it lived inside
`AlertConsolePanel.tsx` as module-private consts, which made them unreachable to
any test: the server runner globs `test/**/*.test.ts` and cannot import a `.tsx`.

The consequence in the change this precedes: widen the server's level union
without widening the console's and it is invisible. Both packages typecheck (the
cast hides it), every CI check passes, and the operator gets a console that
silently cannot address the new rung — the "four listed, three selectable"
complaint, reproduced with no signal.

Moved to `web/src/alarmLevels.ts`, and pinned by a test that asserts the console's
`LEVELS` equals the server's `CHIME_LEVELS`, and that each klaxon preview basename
equals the server's `KLAXON_FOR_LEVEL` entry. That second one guards a subtler
failure: a preview that plays a different sound than the alarm will teaches the
operator the wrong association at the moment they are choosing tones. Verified by
deliberately pointing `red` at `all-clear` — the test fails with
`preview for 'red' points at all-clear.wav but the alarm plays red-alert.wav`.

The move also caught the same defect the previous release fixed on the server
side: the console's `LEVELS` was `readonly Level[]`, an annotation that accepts a
SHORT array, so dropping a level would typecheck and simply never render. Now
`as const satisfies`.

## v1.58.0 — make the alarm-severity widening impossible to ship quietly

Groundwork for one unified severity ladder. **No behaviour changes**: the same
three levels resolve to the same three tones, and the rendered audio is
unchanged. What changes is that the *next* release cannot get it wrong silently.

The alarm surface carries two axes today — four ISA priorities
(`critical|high|medium|low`) for routing, three audio levels
(`red|yellow|green`) for tone — joined by a lossy collapse, so four things are
listed and three are assignable. Merging them means widening a string union that
several sites consume as a *runtime string*, and three of those sites are
invisible to `tsc` in exactly the commit that widens it:

- two `as AnnouncementLevel` casts. `ConditionLevel` and `AnnouncementLevel`
  coincide today, so the casts are vestigial — and they are precisely what would
  let a widened union pass at the site that decides which tone plays. Removed.
- `CHIME_LEVELS` was `AnnouncementLevel[] = [...]`. An array *annotation* accepts
  a SHORT array, so a 3-element list would still satisfy a 5-member union and the
  missing rung would simply never be iterated. Now `as const satisfies`, plus an
  exhaustiveness type that fails if the union gains an unlisted member.
- the console's level labels were `{...} as Record<AnnouncementLevel, string>`.
  An assertion admits a missing key and renders `undefined`; the hoisted
  `LEVEL_LABELS` is a real annotation, so a missing rung is a compile error.

Also: the per-level allowlist in the chime PUT handler was a literal
`['red','yellow','green']` independent of `CHIME_LEVELS`. Unwidened, it would
have returned HTTP 200 with `rejected: []` and silently discarded the write —
the operator sets a tone, the UI reports success, nothing changes. It now derives
from the single source.

**The suite gates pull requests.** `npm test` previously ran in exactly one
place: the release workflow, *after* the tag. A behavioural regression reached
`main` green and surfaced only after the release was cut — and did, twice today.
1,757 tests take about ten seconds; on a life-safety alarm path they belong on
the PR.

Not done here, and required before the ladder lands: the web console's `Level`
type and its token/filename maps are module-private in the `.tsx`, which the
server test runner cannot import, so no test pins them against the server
contract. They must move to a plain module first.

## v1.57.0 — broadcast volume has exactly one source

**The Alert Console's volume slider is removed, along with its `/data` override.**
`BROADCAST_VOLUME` in the add-on options is now the only place the level is set.

The two disagreed, silently and permanently. `broadcast.ts` resolved
`ov.volume != null ? ov.volume : envVolume`, so the first touch of the slider
persisted an override that outranked the option for good: the Home Assistant
Configuration page read 0.7 while the speakers played at 0.95, with nothing on
either surface saying which was in force. Two controls for one number is not a
feature when neither discloses the other.

`broadcastRuntimeConfig` keeps its live enable/disable override — that one is a
kill switch worth having without a restart, and unlike volume it is disclosed in
the console. Only `volume` is gone from the store, its persisted field, the PUT
body, and the GET response.

**Nothing else about loudness changed.** `BROADCAST_ANNOUNCE_VOLUME` remains what
it always was — an escape hatch, not a second slider: empty (the shipped default)
derives the announce level from `BROADCAST_VOLUME`, a number pins it, and
`off`/`none`/`standing` omits the parameter entirely for speakers that ignore it.
The pre-announce `volume_set` is still derived from that same resolved value, not
a competing source.

**Test.** The old pin — "volume override flows into announceVolume, not just
cfg.volume" — protected a real property: `cfg.volume` is never sent to a speaker,
`announceVolume` is, and a break in that link makes the configured volume
silently inert (the v0.15.7 defect). The override is gone but the property is
not, so it is re-pinned against the option instead, plus a regression test that
no runtime override can shadow `BROADCAST_VOLUME` again. 1,757 tests pass.

## v1.56.0 — the chime-pack option is removed; doorbell is the shipped default

**`BROADCAST_CHIME_PACK` is gone** — option, schema entry, translation block,
s6 env export, and every line of pack machinery. What it selected is not lost:
v1.55.0 promoted all six pack klaxons into the named tone catalog, so each is
individually assignable per level in the Alert Console. One setting, one place.

`CHIME_PACKS` collapses to a flat `KLAXON_BUILDERS` table backing the four fixed
assets. The surviving waveforms are the melodic struck-bell set, chosen because
that is what live installs already hold on disk — the one forced regeneration
rewrites the klaxons byte-identically, so the fallback tone does not change on a
running system. `selectedChimePack()` and the `ChimePack` type are deleted;
`process.env.BROADCAST_CHIME_PACK` had exactly one reader.

**The shipped default assignment is now `named:doorbell`** for all three levels,
replacing `{kind:'builtin'}`. `builtin` remains fully reachable — it is the
operator-selectable level klaxon *and* the last-resort tone `resolveChime()`
falls back to when an assigned tone's file is missing, so the anti-silent-alarm
chain is unchanged. Only what a fresh install starts with moved; an existing
`/data/chime-config.json` is never rewritten.

**The `.assets-version` marker is version-only again** (`v6`, was `6:<pack>`).
No marker any prior release wrote can equal it, so every install regenerates
exactly once on the first boot after this update and none can carry stale
klaxons. `AUDIO_ASSETS_VERSION` itself is unchanged.

**Two claims in the v1.55.0 entry were wrong, and are corrected here.** That
entry argued for retaining the key on two grounds; both were tested and both
fail:

- *"HA has no options migration, so removing the key reverts a saved value."*
  The merge described there is real, but its output is then **filtered**.
  Supervisor drops a persisted key the new schema does not declare — it logs
  `Option '…' does not exist in the schema for …` and continues. Verified against
  the running Supervisor (2026.07.5), and by repo precedent: an earlier release
  deleted six option keys, three without the optional suffix, and shipped
  continuously since.
- *"The s6 run script exports it under `set -e`, so a surviving export aborts
  startup."* It cannot. `bashio::config` returns success unconditionally — a
  missing key yields the literal string `null` — and `export VAR="$(…)"` masks
  the substitution's exit status under `set -e` regardless. The export is removed
  for hygiene, not for survival.

The persisted value remains in Supervisor's store, inert, until the Configuration
form is next saved. **Do not reuse the identifier `BROADCAST_CHIME_PACK` for a
different setting** — a re-added key would inherit the stale persisted value
rather than its new default.

`chimePack` is removed from the chime console response, and the level dropdown's
klaxon option is relabelled: after this change `builtin` is no longer the
default, so a label calling it one would state the opposite of the truth on the
alarm administration surface.

**Tests.** `chimePack.test.ts` is replaced by `klaxonAssets.test.ts`, which pins
what that file was really protecting: every level klaxon synthesizes to a valid
non-empty 22050 Hz WAV, a stale marker regenerates a corrupted klaxon, and every
pre-v1.56.0 marker format reads as stale. The default-assignment test now asserts
doorbell, and a new test pins that `builtin` stays reachable — making that state
unreachable would take the fallback floor with it. 1,757 tests pass.

## v1.55.1 — restore the Configuration page's option descriptions

**Every option description on the Home Assistant Configuration page has been
blank since v1.48.0 (2026-07-27).** `translations/en.yaml` did not parse, and
Home Assistant's response to an unparseable translation file is to render the
page with no labels or help text at all — no error banner, no log line an
operator would notice. The options themselves kept working; only their
documentation vanished.

Two independent YAML quoting faults, either sufficient on its own:

- `BROADCAST_WYOMING_VOICE_ES` (v1.48.0) — an unquoted plain scalar containing
  `works: switching`. A colon followed by a space is the mapping indicator, so
  YAML ended the value there and then failed on the remainder.
- `NIGHT_CHARGE_ADVISOR_ENABLED` (v1.54.0) — a single-quoted scalar into which
  `'advisory'` and `'auto'` were inserted without doubling the apostrophes, which
  is how a literal quote is escaped inside a single-quoted YAML scalar.

Both are fixed. All 80 options now parse, and each has a non-empty name and
description.

**The reason this survived a week is that nothing checked.** `tsc` does not parse
this file; the 1,756-test suite does not; the Dockerfile smoke build only copies
it. `scripts/validate-addon-config.py` now does, wired into CI as a job that runs
on every pull request. It parses both `config.yaml` and `translations/en.yaml`,
asserts key parity in both directions — an option with no translation renders its
raw key as the label; a translation for a deleted option is dead text — and
asserts every entry carries a non-empty name and description. Verified against
the pre-fix file: it fails with the exact line and column.

CI job placement is deliberate. The server test suite runs on the release
workflow, after merge, so it cannot gate a pull request; this check is a CI job
precisely so it can.

## v1.55.0 — one tone list: the pack klaxons become selectable tones

**The problem.** Two surfaces answered "what sound plays for a critical alert",
and only one of them won. `resolveChime()` consults the per-level assignment
stored by the web Alert Console; it reaches the `BROADCAST_CHIME_PACK` klaxon
only when a level is still set to `Default`. An operator who assigned a named
tone to every level — the common case — had a pack selection in the Home
Assistant options form that produced no audible difference, with nothing on
either surface saying so.

The pack was also the only way to hear those six waveforms, and it offered them
three at a time: pick `airport` and the `powerplant` sounds are unreachable, and
vice versa. They could not be mixed.

**The change.** The six pack klaxons are now first-class entries in the named
tone catalog — `airport-red-alert`, `airport-yellow-alert`, `airport-all-clear`
and their `powerplant-` counterparts — bringing it from 16 tones to 22. Each is
individually assignable to any level, alongside the existing tones and any
uploads. They reference the same builders `CHIME_PACKS` uses, so a promoted tone
is byte-identical to the pack klaxon of the same name; a test asserts that
equality rather than trusting it.

These six are the only tones in the catalog designed AS A SET: cadence encodes
severity per ISA-18.2 and all-clear resolves upward. That property is why they
are listed first, and why the promotion preserves them rather than retiring them
in favour of the generic chimes.

**`BROADCAST_CHIME_PACK` is retained, and its description now matches what it
does** — it selects the fallback set: the klaxon for any level still on
`Default`, and the last-resort tone when an assigned tone's file is missing. The
key, its `list(powerplant|airport)?` schema and its `powerplant` default are
untouched. Home Assistant has no add-on options migration — Supervisor
shallow-merges new defaults *under* persisted options — so renaming or removing
the key would silently revert a saved selection; and the s6 run script exports it
via `bashio::config` under `set -e`, where a missing key aborts startup outright.
Retention here is a safety property, not inertia.

`chimeConsoleResponse()` now publishes `chimePack` (the id, never a path — both
chime GETs are unauthenticated by design), and the console's level dropdown names
the active pack in its `Default` option instead of leaving the interaction to be
discovered.

`AUDIO_ASSETS_VERSION` 5 to 6 so existing installs re-synthesize `/data/audio`
and materialise the six new WAVs on first boot.

**No assignment is rewritten and no configuration is reset.** Existing per-level
assignments, uploads and the pack selection all carry forward untouched. The
change is additive: six new options appear in a dropdown that already existed.

**Also.** `server/test/chimeStore.test.ts` carried a literal NUL byte inside a
path-traversal test vector, which made the entire file binary to `grep`,
`ripgrep` and every text-based audit — silently excluding its security tests from
any repository-wide search. The vector is now written as a unicode escape:
identical at runtime, and the file is text again.

## v1.54.0 — repo hygiene: remove a published personal address, correct what the docs claim

**Public-manifest privacy.** `repository.yaml` published a personal email address in
its `maintainer:` field — the single exposure of it anywhere in the repository; all
382 commits use the GitHub noreply author. It now uses the same address-free form the
sibling repository already ships. The same file's `url:` still pointed at the
pre-rename `ecoflow-panel` slug and worked only via GitHub's redirect.

**Example addresses.** The Wyoming-host option's help text used a real private-range
address as its example; it now uses the RFC 5737 documentation range, which is
unambiguously an example. No real host address remains anywhere at HEAD.

**Three false statements on the HA Configuration page.** The Night-Charge Advisor
option claimed it "NEVER charges or writes to any device" — true of the default
posture, but the write mode is a separate option and `supervised`/`auto` do write.
It claimed "Default off" while shipping `true`, and carried a copy-pasted clause
about listening on the telnet port that belongs to a different option. The Telnet TUI
option claimed "Default on" while shipping `false`. Corrected, and write-eligibility
is now scoped to `auto`, which is what the readiness gate actually governs.

**README.** "serves the results four ways" lost its fourth surface when the card
family was removed and kept the numeral. The dashboard tab list named seven tabs, of
which three are wrong — one deleted, two that never existed. The quick-start told the
operator to reach a telnet TUI that ships disabled. The test count was fifteen
releases stale. The workflow table credited the tagging workflow with building and
publishing the image, which a different workflow does, and named two of four
workflows. `docs/` — which holds the measured-accuracy record and the binding design
of record for the device-write path — was absent from the directory table entirely.

**Container labels.** The published image carried `title` and `description` labels
both reading "EcoFlow Panel" — a name where a description belongs — and the local
build fallback carried the old slug.

**Vulnerability reporting.** `SECURITY.md` gave no direct link and declared a
directory deleted in v1.47.0 as in scope.

**DOCS corrections.** Seventeen, of which two matter beyond tidiness:

- Appendix A listed `computeMultiDayForecast` as a removal candidate with "no UI,
  TUI, HA, or engine consumer". It is requested at `days: 4` inside the night-charge
  plan recompute and mapped into `dayRollups`. ★★★ Because analytics reports dispatch
  by **string**, acting on that line would have compiled clean, thrown at runtime,
  and been swallowed by the caller's `.catch(() => null)` — silently degrading
  `dayRollups` to `[]` inside the engine that actuates a device write. The entry is
  now a labelled do-not-remove with that hazard stated.
- The security-posture section justified unauthenticated reads with a rationale
  deleted in v1.47.0 (cards fetching cross-origin) and omitted the real one: the
  alarm audio routes are unauthenticated static paths that HA media players, Music
  Assistant, and the SIP intercom fetch at alarm time. Now stated, with the
  consequence spelled out — **a 401 to a speaker is a silent alarm**.

Also: a documented TUI surface removed in v1.46.0; a cited test file that has never
existed, replaced with the test that does pin those semantics; a dead table-of-
contents anchor and two front-end counts left behind by the card removal; five
consumer-ledger rows still crediting the removed cards; a first-person register
violation; and a missing serial conjunction.

**DOCS coverage added.** §4.2b documents `resolveTariffCents` — the v1.52.0 resolver
both the cost engine and the dispatch planner now share — including its three tiers,
the month-based seasonality, and the per-side fallback edge where a half-set legacy
override is honoured while the reported basis still reads `flat-default`. §12 gains
`TUI_TRUSTED_ORIGINS`, the only shipped option in neither the table nor a delegation,
documented as accepting entries verbatim without validation. The endpoint table gains
the subscribable iCal feed. The `/console/ws` origin description still described the
blanket wildcard match removed in v1.47.3 as a CSWSH hole.

**Removed.** `scripts/setup-ha-dashboard.mjs`, an installer for the v1.47.0-removed
cards whose CDN fallback pinned a tag that was never pushed, and the `.gitignore`
carve-out for the deleted directory.

Documentation, manifest, and label changes only; no runtime behaviour changes beyond
the request user-agent, which stops advertising a frozen version and the old slug.

## v1.53.0 — document the Energy Dashboard **power** wiring (`stat_rate`)

**The gap this closes.** DOCS §2.6 documented the six `total_increasing` kWh
counters that feed HA's Energy Dashboard, and stopped there. The dashboard's
"Now" tab is a separate data path: `hui-power-sources-graph-card` plots the
per-source *power* statistic named by `stat_rate`, and derives its "Consumption"
trace as `max(0, Σ plotted series)` rather than reading any measured total. A
source with no `stat_rate` is therefore absent from both that graph and the
"Power usage" badge — silently, because `energy/validate` does not flag it.

With only solar and grid rated, the identity `Consumption ≡ Solar + Grid` holds
at every bucket, the stacked grid band's upper edge *is* the consumption trace
(they cannot diverge, which reads as a rendering bug and is not one), and the
plotted figure is wrong by the entire battery flow — overstating house load
while the pack charges, understating it while it discharges. Neither error is
detectable from the card itself; ground truth for house load is `panel_load`
(Σ the SHP2 circuit CTs), never the derived consumption trace.

New DOCS §2.7 gives the complete three-source mapping, the battery sign
convention ("Standard": positive = discharging, matching
`fleet_battery_net_watts`), the reason grid must be rated to `grid_home_watts`
rather than the `ac_import_watts` sub-metric, the `power_config.stat_rate` vs
top-level `stat_rate` mirroring caveat for programmatic `energy/save_prefs`
callers, and the irreducible DC/AC basis residual that must not be chased —
solar is metered at the MPPT DC input and battery at the DC pack terminals while
grid is the AC main, so PV→battery conversion loss lands in HA's node model as
phantom load. It also records that the per-circuit counters are eligible for
`device_consumption`, where "untracked consumption" then reads as that residual.

**Stale comment retired.** The `ecoflow_grid_home_watts` block in
`mqttDiscovery.ts` still described, in the present tense, a rewire that has since
happened — that the grid `power_config.stat_rate` "currently points at DPU ac_in
… so the operator can rewire the flow preview to it". It now records the wiring
as done and points at §2.7. Documentation only; no runtime behaviour changes.

## v1.52.0 — runway card tells the truth below the floor; cost engine uses the confirmed tariff

**Runway, below the reserve floor.** The crossing detector only arms while the
pool is ABOVE the floor, so on a pool that is already under it, `hoursToReserve`
is the *next* crossing — after a modelled solar recharge. The math was right and
independently reproducible; the card was not: it printed "11.2 h until the
backup pool reaches the reserve floor" while the pool sat 0.31 kWh *below* that
floor. The server already knew (`belowReserveFloor()` is true and a
`shp2-below-reserve` alert was live) but `/api/runway` never carried the fact.
The endpoint now publishes `belowReserveFloor` (null when undeterminable, never
a fabricated false) plus live `grid` context, and the card leads with "at
reserve floor", re-labels the projection as the post-recharge re-crossing it
is, and — whenever the grid is backstopping — states plainly that every time on
the card is an ISLANDED grid-loss projection rather than a live countdown. The
alarm path was already correct and is untouched.

**Cost basis.** `TARIFF_ON_PEAK_CENTS`/`TARIFF_OFF_PEAK_CENTS` were env-only,
never surfaced in the add-on options, and defaulted to a flat 17¢ encoding a
v0.9.58 assumption ("the operator's APS plan is flat — no TOU split") that the
night-charge work has since disproven. The result was two engines disagreeing
about the price of the same kilowatt-hour: the planner on confirmed APS R-EV
(44.4¢ on-peak) and every cost/savings KPI on 17¢ flat. `resolveTariffCents`
now resolves per call — explicit overrides, else the CONFIRMED APS R-EV table
for the current season, else the flat default — and both the cost report and
the dispatch planner read it. Unconfirmed or partial APS tables are never used
(null-over-fabrication), unconfigured installs are unchanged, and the report
publishes `tariffBasis` so the provenance is visible instead of silent.

6 new tests (seasonal resolution, unconfirmed refusal, partial-table fallback,
override precedence); 1,755 total.

## v1.51.2 — supervised announcement: day-qualified deadline + shortfall disclosure

The supervised evening announcement named its cancel deadline with a bare
clock time. Weekend tariff semantics routinely resolve a Saturday-evening
plan's charge window to Monday 00:00 — the write moment is then ~28 hours
out, and "the write happens automatically at 11:55 PM," heard at 21:30 on
Saturday, reads as tonight. The cancel deadline is the owner's control point,
so an ambiguous night is a control defect, not a wording nit; it is also the
same failure v1.39.0 corrected for the published window entities
(`fmtPhoenixDayHm`), which the v1.50.0 announcement did not inherit. The
deadline is now day-qualified beyond 24 hours ("on Sunday at 11:55 PM") in
both the notification and the spoken broadcast.

The spoken announcement also omitted `cushionShortfall` while the HA
notification disclosed it — the audible channel, the one that reaches the
owner without a phone, must not be quieter about residual risk than the text
channel. It now speaks the same disclosure.

4 new tests pin the day-qualified pass-through, the same-night phrasing, the
unchanged advisory tail, and the shortfall disclosure; 1,750 total.

## v1.51.1 — documentation freshness pass

A four-way audit of the long-form documentation against the v1.49.0–v1.51.0
releases found the pre-supervised-write posture asserted throughout; this
release corrects every instance. README, DOCS §15 (§1 posture, §10 config
table, §11 failure modes), the §12 option reference (night-charge group,
`NIGHT_CHARGE_MODE`, `RECORDER_RETENTION_DAYS`, heartbeat pointers), the §2
write-framework enumeration, the §12 security posture (both non-debug writes
and the cancel endpoint), the persistence inventory (night-charge state
files), retention phrasings, the table of contents, and the A.10 appendix
heading now describe the shipped mode-gated write posture and configurable
retention. SECURITY.md no longer cites a nonexistent `write_actions_enabled`
option and names the real posture. PERFORMANCE.md §3 records the gate-v2
transition and the 2026-08-01 start of the actuated-evidence record.
`docs/NIGHT_CHARGE_ARBITRAGE_DESIGN.md` gains the Amendment of 2026-07-31
(why the original I1/§5/§6 posture was revised, the amended write contract,
and gate v2), with supersession markers on the retired sections. The add-on
store description and repository metadata reflect the alarm spine and the
night-charge engine. No code changes.

## v1.51.0 — configurable telemetry retention

`RECORDER_RETENTION_DAYS` (default 30, range 7–730) replaces the hard-coded
30-day samples prune. The historical default is unchanged — a fresh or
upgraded install behaves identically until the option is raised. Longer
retention enables seasonal model comparison, deeper backtests, and
year-over-year degradation analysis on hosts with the disk for it (~25–30 MB
per day at a full fleet's metric volume). The resolution is fail-safe: a
malformed value falls back to the default, and the floor is 7 days so a typo
can never become a delete-everything retention. The durable night-charge
ledger, calibration, and lifetime-energy tables were never subject to this
prune and remain so. Effective retention is logged at startup.

## v1.50.0 — night-charge supervised write mode + write-readiness gate v2

The night-charge engine gains an owner-selectable write posture,
`NIGHT_CHARGE_MODE: advisory | supervised | auto` (default `advisory`,
unchanged behavior). In `supervised` mode, each charge night runs one bounded,
announced, cancellable, auto-reverting device write:

- **~21:30** — the evening plan is announced with the intended buy, the
  clamped reserve target, and the cancel deadline, on both the HA
  notification channel and the audible broadcast (no phone-push dependency).
  The write is armed **from the announced plan**; a fresher recompute never
  silently substitutes different numbers.
- **Window open − 5 min** — one audited write raises `backupReserveSoc` to
  `min(round(target), 50)`, validated into the device's documented [10, 50]
  range, via the same documented `PD303_APP_SET` shape the cloud-presence
  refresh has round-tripped since v0.9.10. Every apply guard fails closed:
  advisory mode, a cancelled night, a red alert condition, an incoherent SoC
  read, an unknown/out-of-range current reserve, or a missed window ⇒ no
  write.
- **Window close + 5 min** — the prior reserve value auto-restores; the
  revert runs regardless of mode (a mid-night option flip cannot orphan a
  raised reserve), retries on failure, and escalates to a critical
  annunciation after 3 consecutive failures while retries continue. A
  morning summary reports plan vs applied vs restored.
- **Cancel** — `POST /api/night-charge/cancel` (write-auth), surfaced as a
  button on the night-charge card; before the apply it disarms, after the
  apply it triggers an immediate revert.

Actuated nights are scored without the clean-baseline requirement: the
delivered buy is measured as window grid import minus the concurrent house
pass-through, and the realized-need counterfactual is derived by subtracting
the delivered charge from the measured trough — a measured counterfactual,
recorded in new ledger columns (`cushion_shortfall`, `actuated`,
`actuation_applied_at_ms`, `delivered_kwh`; additive migration).

**Write-readiness gate v2.** The v1 gate could never open on a grid-tied
home: its clean-islanded-baseline scoring froze `scoredDays` at 0, and §5.1
floor-breach strikes never aged. v2 (a) bases graduation on actuated nights —
≥ 21 scored actuated nights, under-buy ≤ 10 %, delivery bias in [0, 5] kWh,
band coverage in [78 %, 92 %] over ≥ 14 verdict nights, zero engine-fault
strikes; (b) redefines a strike as *plan claimed hold AND breached* — a plan
that honestly disclosed `cushionShortfall` is physics, not fault, and exempt;
(c) holds strikes in a rolling 45-day window cleared by 14 consecutive
strike-free actuated nights; (d) bumps `CURRENT_ALGO_VERSION` to 2 — the
v1.49.0 sizing-physics correction invalidates every v1 row per §0.2, which
also retires the v1-era strikes recorded against the broken model.
`writeReady` gates AUTO only; supervised is an explicit owner action.

**Adversarial-review hardening (pre-release).** An independent review of the
write path confirmed three defects, all corrected before release:

1. **Auto-mode readiness enforcement point.** `effectiveActuationMode`
   structurally DEMOTES `auto` to `supervised` while the readiness gate has
   not graduated (`writeReady` false) — any future auto-only relaxation must
   branch on the demoted mode, so it can never ship ungated. In this release
   the two modes are operationally identical either way.
2. **Lost-confirmation write adoption.** The apply is now a write-ahead
   intent: the attempt (with its pre-write baseline) persists BEFORE the
   device call, and a write whose confirmation was lost (device applied it,
   response dropped) is detected when the live reserve reads back the
   attempted target — the actuator ADOPTS it (stamping the applied state
   from the attempt baseline) so the normal auto-revert takes over. Without
   this, the "nothing to raise" guard would no-op forever and the raised
   reserve would never revert. Re-arming a new night is refused while an
   unconfirmed attempt is unresolved, unless the live reading proves the
   write never landed.
3. **Announcement-delivery-gated arming.** The armed state persists only
   after at least one announcement channel confirms delivery — a
   `NOTIFY_CHANNEL: none` no-op plus a failed audible broadcast leaves the
   night advisory (logged at error level). A write the owner never heard
   about cannot fire.

26 new tests (gate v2 semantics, every actuator guard incl. adoption/demotion
/attempt-refusal, delivery-measurement helpers, reserve-write validation);
1,745 total. Eight targeted mutations (dropped red-vitals guard, dropped
cancel-revert, dropped shortfall exemption, altered clean-streak threshold,
widened reserve clamp, disabled adoption, removed auto demotion, removed
attempt-refusal) each fail the suite. Public-repo hygiene: doc/test example
IPs generalized.

## v1.49.0 — night-charge sizing corrected: the charge cap is charge-only

The buy sizer modeled `chChargeWatt` (7.2 kW) as a total grid-input budget
shared with concurrent house load, and simultaneously drained that same window
load from the pack trajectory — a double-count that collapsed a 6-hour window's
deliverable lift from ~40 kWh to ~7–8 kWh and produced charge targets below the
reserve floor. The model was empirically falsified by the engine's own outcome
ledger: measured grid import during charge windows sustained 13.5–14 kW,
nearly twice the supposed ceiling. `chChargeWatt` is the SHP2 charge task's
grid-to-battery power limit; house load is service-feed pass-through on a
grid-tied system and never competes with the charger.

The corrected window model: the charge cap credits the full remaining window
(`chargeCapKw × hours × legEff`), charging occupies the leading hours of the
window, and while the charger runs the home rides grid bypass (no pack drain
in charging hours); non-charging window hours drain normally, with per-hour
clamps preserving saturation/empty honesty and bisection exactness. Charge
targets now land where physics puts them (~43% instead of ~8% on a
deep-shortfall night at the 7.2 kW cap).

An adversarial review of the corrected model (findings verified by executing
the code) surfaced and fixed one high-severity residual before release: the
requirement bisection still searched the OLD model's pool-headroom bound, but
under the bypass model the deliverable trajectory keeps improving past that
bound (more lift buys more bypass hours), so realistic near-full/heavy-load
nights were under-bought and mis-reported as unmeetable — the search domain is
now the achievable-model plateau, with a dedicated regression fixture. Also
fixed from review: the charge credit is bounded by simulable window buckets
(horizon gaps can no longer bill unabsorbable energy), the window slice is
self-trimmed against untrimmed caller horizons, a zero charge-cap no longer
produces phantom bypass lift, and the stale shared-budget formula block in the
documentation is corrected.

Fixtures were re-derived from the stated physics, not copied from outputs
(canonical clean-shortfall lift 19 → 18.79 kWh via the bypass credit;
deep-shortfall 55 → 61.63 kWh because front-loaded charging lifts the pack off
the empty-clamp and late-window drain becomes real). Two new discriminator
tests fail decisively under the old shared-budget model. The design document's
§2.2 cap prescription — the origin of the defect — is corrected in the same
change. 1,719 tests.

## v1.48.4 — Music Assistant detection self-heals after HA restarts

The Music Assistant service probe ran once at add-on boot and again only on
operator-initiated test broadcasts. When an HA Core/OS update restarts
everything, Music Assistant regularly comes up minutes after this add-on — the
boot probe then records a CONFIRMED absent, and with no periodic re-check the
status surface reported the announce service missing for hours after it had
re-registered (live incident following the HA OS 18.1 update). Real alarm
dispatch never gated on the flag, so delivery was unaffected — the status was
simply wrong, and a wrong "MA missing" reading undermines exactly the health
surface an operator checks after an update.

The periodic audible-health tick now re-probes the service registry whenever
the flag is down, so detection converges within one probe cycle of Music
Assistant returning.

## v1.48.3 — SIP dispatch timeout no longer causes a phantom ringing call

Live incident: during an HA overload window, the SIP announce dispatch to the
cordless handset failed client-side with an HTTP header timeout — but the
service call had executed server-side, and the announce call was placed and
played. The deferred retry, believing 0/1 targets were reached, re-fired SIP;
the duplicate call arrived while the handset was still in the ~50-second
announce call and could not auto-answer, so the phone RANG after the
announcement — a confusing phantom call during an alarm.

A timeout-classed dispatch failure now means delivery UNKNOWN, not failed:
the monitor probes the target entity's real state ~8 seconds after the
timeout, and if the announce call is live (entity playing) the SIP leg is
counted as delivered and the deferred retry will not re-fire it. Non-timeout
failures (4xx/5xx/refused) remain definite misses and retry exactly as
before — the duplicate-beats-silence policy is unchanged for genuine
failures.

Tests: 1,715 (timeout classification: header/body timeouts and aborts route
to the verify path; refusals and mixed failures stay definite).

## v1.48.2 — dependency security sweep (zero open alerts)

All four open Dependabot PRs are merged (undici 6.28.0, recharts 3.10.1, the
web development group, docker/login-action 4.5.1), and the four open
Dependabot alerts — find-my-way (HTTP/2 DDoS, GHSA-c96f-x56v-gq3h) and three
fast-uri host-confusion advisories (GHSA-v2hh-gcrm-f6hx, GHSA-4c8g-83qw-93j6)
— are resolved by lockfile updates, along with a brace-expansion DoS fix the
audit surfaced in passing.

`@fastify/static` is upgraded 9.3.0 → 10.1.2, closing two high advisories the
alert feed had not yet raised: authorization bypass via non-canonical URL
paths (GHSA-8pvw-jcv7-9cmj) and route-guard bypass via path traversal
(GHSA-83w8-p2f5-377r). Both matter here — the add-on serves its dashboard and
rendered alarm audio through this plugin behind origin/auth gates. The major
bump is peer-compatible (Fastify 5 on both sides).

`npm audit`: zero vulnerabilities in both packages. Code-scanning and
secret-scanning alert lists are also empty. 1,714 tests green.

## v1.48.1 — dead-code removal (13 verified-unused exports)

An unused-export audit (mechanical scan, cross-referenced against the test
suite and scripts, then adversarially verified per candidate) confirmed 13
exports with zero references of any kind — runtime, test, type-only, dynamic,
or cross-package. All are removed:

Server: `alertCounts`, `PTC_TEMP` (its promised TUI colouring was never
implemented), `getCachedStates`, `cacheSize`, `__resetShedRegistry`,
`telnet/plant/scada.ts stateText`.

Web: the entire unreferenced `src/alerts.ts` module, the `ClippingEstimate` /
`ClippingHour` / `AlertActionStats` client type mirrors (the web never fetches
those endpoints), `sevRank` / `alertRank` / `SEV_META` (superseded by the
4-tier ISA priority rendering in v0.11.0; the "kept for back-compat" comment
had no surviving caller), the unpulled priority re-exports in AlertParts, and
`SubHeader` with its orphaned `.subhead` CSS rule.

Three DOCS.md rows documenting the removed exports are corrected in the same
change. The 55 `*ForTest` reset seams the scan also flags are intentional
test API and are kept; `__resetHaStateCache` is kept as a documented test
hook. No behavior changes.

## v1.48.0 — terminators pre-warmed at boot; one voice switch per fresh alarm, any voice tier

This release also fixes two defects found by live-incident review:

**Night-charge advisory was permanently starved by a wrong coverage constant.**
The plan-basis gate required realized P10–P90 band coverage ≥ 90%, but the
band's NOMINAL coverage is 80% and the engine's own write-readiness gate
accepts [78%, 92%] as calibrated. A correctly calibrated forecast (live: 85%
coverage, 20 scored calibration days) therefore failed the basis gate every
night — every evening advisory said "insufficient basis", no buy/hold guidance
was ever produced, no night was ever scored, and readiness could never
accumulate. The floor is now 0.78, matching the write gate. Coverage BELOW
0.78 (an overconfident band) still blocks; an over-wide band is conservative
for the P10-PV sizing and needs no upper bound at the advisory tier.

**The 90-second spoken retry never covered dedicated-path alarms.** The v1.45.0
retry was wired only into the condition-transition path. Alarms delivered via
the dedicated announce() path (battery SoC ladder, runway) that lost their
speech to a starved TTS server fell back to chime-only and NO spoken retry
ever followed — exactly the two chime-only alarms heard live on Saturday
(renders timed out during afternoon host contention; the chime fired as
designed, the speech never returned). Both paths now share one scheduling
seam, and a dedicated-path retry replays its ORIGINAL message verbatim
(re-deriving from the condition spine would speak the wrong alarm, since
ladder alerts are excluded from the condition).

Follow-through on the v1.47.6 measurement: a Piper voice-model switch costs
~4.2 s regardless of quality tier. The remaining cold-render exposure was the
FIRST alarm after a voice change, a render-version bump, or a cache wipe,
which still paid cold terminator renders — and with them extra voice switches.

The terminator phrases and voices are fully known at startup, so the monitor
now pre-warms the terminator cache in the background ~20 s after boot
(Spanish first, primary English last, leaving Piper holding the English
model). On a warmed install this is two file checks and no TTS traffic. A
pre-warm failure is non-fatal: the alarm path renders on demand exactly as
before.

The on-disk cache key no longer includes the PCM format. Read-time WAV-header
validation is unchanged, and exactly one format is ever viable per install
(a chime that mismatches Piper's output breaks the spoken path outright), so
the format term only prevented the pre-warm from writing usable entries. The
in-memory memo keeps the format in its key because memo hits skip that
read-time validation.

Priority under a wedged TTS server is unchanged: message passes always take
render-budget precedence over terminators — the Spanish message outranks the
English closing phrase.

With terminators always cached and passes rendered resident-voice-first, a
fresh bilingual alarm performs at most ONE voice switch. That removes the
reason for the temporary Spanish medium-voice recommendation, so the default
guidance returns to any tier (the deployment returns to es_MX-claude-high);
the configuration help text has been corrected accordingly.

An adversarial review of this change confirmed and fixed four defects before
release: (1) the pre-warm now runs THROUGH the broadcast single-flight — one
queue slot per entry, yielding instantly when a real broadcast is pending — so
it can never interleave TTS requests with an in-flight alarm (unserialized
aborted sockets are the known Piper-crash vector) and an alarm waits behind at
most one 8-second render; (2) resident-voice tracking updates only on actual
renders — stamping it on cache hits inverted the tracking and made every
steady-state bilingual alarm pay a second voice switch; (3) the age-based
cache prune now exempts `term-*` files, which it was silently deleting weekly
(un-doing the "permanent" cache for long-uptime installs); (4) an unpinned
(empty) voice no longer persists to disk — the audio depends on the TTS
server's default voice, which can change without this add-on knowing, so only
the restart-scoped memo applies. A pre-warm failure also halts the remaining
entries instead of firing more requests at a struggling server.

Tests: 1,714, including an end-to-end case proving the pre-warm writes under
the exact key the alarm path reads (memo cleared, disk must serve), that a
warmed boot performs zero renders, that cached terminators leave resident-voice
tracking truthful across three consecutive alarms, that the prune never removes
terminator files, and that a failed pre-warm entry stops the run.

## v1.47.6 — terminator audio cached permanently (halves the voice switches per alarm)

Measured on the deployed Piper: a voice switch costs ~4.2 s and the cost is
the MODEL LOAD, not the phrase — `en_US-lessac-medium` takes 0.71 s when it is
the resident model and 4.20 s when it must reload, exactly like the Spanish
voice. A bilingual alarm renders two message passes plus two per-language
terminators, so it could pay four loads.

The terminator phrases ("End of message" / "Fin del mensaje") never change,
yet they were re-rendered for every fresh announcement. They are now cached as
PCM on disk, keyed by render version + language + voice + phrase + PCM format:
the first announcement per key pays one render, every later one is free. A
fresh bilingual alarm therefore costs one voice switch instead of two, and the
TTS server sees half the requests.

Tests: 1,710 green, including a case that renders two announcements with
different message text and asserts the terminators are rendered exactly once
and then served from disk (with the in-memory memo cleared in between, so the
disk path is what is proven).

## v1.47.5 — bounded alarm latency; stop retrying a wedged TTS server

A red alarm sounded its chime with NO speech in either language, 151 seconds
after the condition transitioned. Root cause was a starved host, not the voice
config: with the fleet under an extreme-heat evening load the Pi sat at load
~5 on 4 cores with the CPU capped at 1.9 of 2.4 GHz, and Piper rendered 6-10x
slower than spec (warm English 4.9 s vs 0.53 s that morning). Every pass
exceeded its timeout, v1.47.4's blanket retry doubled each wait, and the
aborted sockets crashed Piper (55 `BrokenPipeError`, 3 "Server stopped" in one
afternoon), after which its watchdog restarted it.

- **Total spoken-render budget** (`BROADCAST_TTS_TOTAL_BUDGET_MS`, default
  25 s) covering all passes AND terminators. Once spent, no further render is
  attempted and the chime-only fallback fires. Alarm latency is now bounded
  regardless of how sick the TTS server is — the chime is the alarm; speech is
  the bonus.
- **Retry only fast failures.** A socket/stream error is transient and cheap to
  retry; a TIMEOUT means the server is wedged or starved, so retrying only
  doubles the delay and aborts another socket — and aborted sockets are what
  crash Piper. Timeouts are detected both by wall clock and by the reported
  error, since neither signal alone is reliable.
- **Per-pass timeout lowered 20 s → 12 s** (still env-tunable), with each
  attempt additionally clamped to the remaining budget.

Tests: 1,709 green, including a wedged-server case asserting exactly one
attempt per pass and a budget case asserting the spoken phase stays bounded.

## v1.47.4 — bilingual alarm reliability: Spanish pass no longer silently dropped

Diagnosed from a live alarm that played English only: the Spanish second pass
had rendered-failed with a Piper socket stall and been dropped (served as a
`.partial.wav`, outcome still "success"). Measured on the deployed Piper: the
English voice cold-loads in ~0.8 s but the heavy `es_MX-claude-high` model
takes ~4 s, and because Piper keeps one voice resident while a bilingual alarm
alternates languages, each announcement forced up to FOUR model reloads — so
under any contention the slow Spanish pass timed out or dropped its socket.

- **Per-pass render retry.** A transient spoken-pass failure (timeout/socket)
  is retried once; the retry lands on the now-warm model. Format mismatches
  (deterministic) are never retried.
- **Resident-voice-first render order.** Passes and per-language terminators
  render the voice Piper currently holds first, cutting model reloads per
  bilingual alarm from ~4 to ~2. Playback order is unchanged (English still
  first).
- **Per-pass timeout is env-tunable** (`BROADCAST_TTS_PASS_TIMEOUT_MS`,
  default raised 15 s → 20 s) for headroom on a cold model under load.
- **Recommend a medium Spanish voice.** The option help now recommends a
  `*-medium` voice (e.g. `es_MX-ald-medium`) over `*-high` for faster
  cold-load; medium and high are both 22050/16/mono so the change is
  format-safe.

Tests: 1,707 green, including an injected-renderer bilingual suite proving the
retry recovers a dropped Spanish pass and the render order is resident-first
across broadcasts.

## v1.47.3 — third-pass fixes: complete the display-width migration + close the origin-gate CSWSH surface

A third QA pass (regression-proving the v1.47.2 display-width rewrite,
origin-gate security, a live keepalive soak, and a whole-surface review) found
that the v1.47.2 change made `visLen` width-aware but left several CALLERS on
raw `.length`, so they disagreed once a name/detail carried CJK. All are now
consistent.

- **Alarm wrapping is display-width correct** — `wrapPlain` delegated to a new
  `wrapDisplay`; a CJK/emoji alarm detail wraps at the right visual column
  instead of overrunning the row and having its tail clipped (a v1.47.2
  regression that silently lost the operative half of an alarm).
- **Header fills use `visLen`** — `divider`, `busBarSegment`, and
  `statusHeader` computed their fill from `.length`, so a CJK device/circuit
  name over-filled the GEN/BUS headers past the width.
- **Combining marks are zero-width** — the combining-diacritical branch in
  `charWidth` was dead (shadowed by the Latin fast-return); NFD names now
  measure correctly.
- **`padEnd`/`padStart`/`center` re-pad after a wide-glyph straddle** — they
  delegated to `truncate` (which may stop one column short of a double-width
  glyph) and returned width−1, breaking their exact-width contract.
- **Emoji width scoped honestly** — the wide range covers the pictograph
  planes (🔋, flags) but deliberately NOT the Misc-Symbols block (☀ ⚡ ⌁),
  which this renderer uses as single-column decorations and whose presentation
  is terminal-dependent.

**Security — origin gate.** v1.47.2's blanket `*.ui.nabu.casa` allowance let
ANY Home Assistant Cloud tenant's origin (including an attacker's own) pass the
`/console` websocket gate (a WebSocket upgrade is not SOP-protected, so the
Origin check is the only CSWSH defense). Removed. Remote access is via HA
ingress (HA-auth-gated); a specific remote origin can be allow-listed
explicitly with the new **`TUI_TRUSTED_ORIGINS`** option (exact match, never a
wildcard, empty by default). IPv6 loopback added to the same-origin set.

- **Idle reaper vs keepalive** — a bare keepalive ping refreshes the idle
  deadline only once the session is past the login gate, so a silent
  login-parked tab still reaps and can't hold a session slot indefinitely.
- Dead exports removed (`renderTagRowNoData`, `equipmentBlock`, `ageQuality`,
  `recentSeries`, `fmtHz`); stale docs corrected (residual Lovelace mentions in
  the intro/overview/deploy sections; the `TELNET_ENABLED` "default on" wording
  now reflects the shipped default-off).

Tests: 1,705 green (CJK wrap/tail retention, combining zero-width, padEnd
straddle re-pad, divider CJK fill, trusted-origins exact-match, IPv6
same-origin, nabu-casa blanket rejection).

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
