> [!NOTE]
> Historical, and frozen: the note on the removed HACS cards (chapter 11, section 3) and sections 12i–12o of
> chapter 12 in the single-file manual, moved here unedited. A later release may have superseded what they
> say (section 12o's pointers to the ntfy, Pushover and webhook channels, for example, name channels that no
> longer exist). Current behaviour is in the [engineering reference](../reference/README.md). This file is
> not part of the printable manual.

### 3. HACS Lovelace cards — removed (v1.47.0)

The HACS Lit card family (`ecoflow-fleet/alerts/battery/solar/strategy/insights/circuit`)
and its `/lovelace/*` static route were removed in v1.47.0: the cards
duplicated the ingress web dashboard, the deployment consuming them had pinned
a stale CDN snapshot, and retiring them deletes an unauthenticated CORS-open
static surface plus committed build artifacts. Historical documentation lives
in the pre-v1.47.0 tags.

### 12i. Announcement delivery: what a timeout means (v1.118.0–v1.119.0)

`music_assistant.play_announcement` **does not return until playback finishes**.
Two consequences the pipeline had to learn the hard way, both on 2026-08-30 when
a Severe Thunderstorm Warning announced itself **15 times** (Music Assistant's
own log is the ground truth; the panel log undercounts 2.5x because it records
only condition transitions, not the retries that also sounded).

**The budget must follow the clip (v1.119.0).** The HTTP budget was a constant,
sized when clips were ~24 s. The red clip is 3,020,422 bytes = **68.5 s**
against a **75 s** ceiling, so every red timed out — and each timeout was
retried and played again. `announceTimeoutMs(sizeBytes)` derives it: WAV is
16-bit mono @22050 Hz = 44100 B/s, so bytes give the duration; plus a 45 s setup
margin for MA queueing and AirPlay/RAOP, floored at the retired 75 s so nothing
gets tighter, capped at 10 min so a genuinely wedged call still surfaces.
`callHaService` takes the caller's budget because only the caller knows the clip.
★ The constant rotted three times (5 s → 30 s → 75 s), always because clips
grew; a regression test asserts any future clip length still gets playback +
margin. Do not replace it with a fourth constant.

**A timeout is terminal-unknown (v1.118.1).** A timeout means the response was
lost, not that the service failed — MA received and PLAYED every timed-out call.
So a timeout-classed dispatch stops: no in-call retry, no deferred retry. The
asymmetry that settles it is that the HA push notification is dispatched
separately and succeeds independently, so the operator is informed either way —
audio is the REDUNDANT channel, and one possibly missed announcement beats six
duplicates. A hard-down MA REFUSES the connection, which is a non-timeout error
and still retries. One shared classifier serves both the MA and SIP paths
(`TIMEOUT_LIKE`), and covers `ETIMEDOUT`, which has no word break and the
original `/timeout|abort/` silently missed.

★ v1.118.0 first tried to settle this by probing player state, copying the
v1.48.3 SIP fix. **That probe cannot work here**: the service call blocks for its
full timeout, so the probe runs ~88 s after dispatch — a few-second announcement
has finished and every player reads `idle` — and it uses the same HA API that
just timed out, so under the causing load it returns null and also reads as "not
playing". Both roads led back to "retry". A verification probe that shares the
failing dependency, and runs after the failing call's own timeout, verifies
nothing.

### 12j. Roster durability, and the audible cost of guessing (v1.117.0)

The SHP2 connected-source roster is derived from the live projection every tick,
so it reads EMPTY for the first tick after a boot and through any SHP2
cloud-blind window. Membership then fell through to the static `SPARE_DPU_SNS`
literal — stale since the 08-20 swap moved Core 3 off-panel without adding it —
which admitted that off-panel Core 3 at 75 % into the pool mean while the real
pool sat at 21 %. The phantom re-armed the SoC ladder's 50/40/30 rungs and
rewrote its slew baseline; the true 21 % was then rejected as implausible for
exactly the 10-minute baseline lifetime, and on expiry three rungs crossed at
once and ANNOUNCED. Reproduced identically on both 08-29 deploys, firing
10 m 01 s after each.

The roster is durable STATE, so it is remembered: seeded at boot from the
persisted membership fingerprint (already a sorted, comma-joined SN list) and
refreshed whenever the live roster is non-empty. `isHomePoolDpu` and
`homeFleetMeanSoc` take it as an optional last-known set; the literal survives
only as a first-ever-boot last resort. An unhydrated tick now yields NO pool
SoC — a safe no-op — instead of a bench spare's.

★ Deliberately NOT fixed with a restart gate: `isRestartContinuation` DID fire on
the yellow-advisory path both boots; the ladder calls `broadcast.announce`
directly and goes around it. Gating there would mask the phantom re-arm, which
can equally misfire in any mid-run SHP2-blind window. Harness:
`scripts/mutate-roster-fallback.mjs` (4 mutants), covering both the stale
literal returning AND the fallback over-tightening until the v1.8.0 SHP2-blind
failover goes dark.

**Also v1.117.0:** `backup_reserve` is recorded alongside `backup_pct`. The
reserve setpoint — owner-set and rewritten twice nightly — had no time series at
all, so a bad revert was invisible to every historical query.

### 12k. Detectors that could not fire (v1.120.0)

A 2026-09-03 audit of 49 h of logs found five mechanisms each gated on a condition
that is a *constant* in this deployment. Each reported "nothing to see" for a reason
unrelated to whether there was anything to see. A detector that cannot fire and a
detector that found nothing emit identical telemetry.

- **Poll latency.** The `SLOW_POLL_MS` branch required an empty device-fetch-failure
  set, but four accessory devices reject `/quota/all` on every poll by design, so the
  failure set is never empty. Poll duration is now reported independently of the
  failure set (`pollLogLines`). The one 10,488 ms excursion in the window — 21x the
  ~490 ms baseline, and above the 8 s ceiling that decides whether a clock sample may
  teach the offset learner — had surfaced only because its failure *set* happened to
  change on that tick.
- **Clock-sample rejections.** `setClockRejectLogger` was registered inside the
  `setClockOffsetLogger` callback body, so it only installed after a first offset
  *adoption*. Adoptions are rare by design, so the reject logger was never installed
  and every RTT-gate rejection was invisible — the exact ambiguity v1.86.0 shipped to
  remove. Now registered at module scope.
- **Rate-collapse pushes.** `msg-rate-floor` was missing from `ENERGY_STATE_FAMILIES`,
  so the high-volume churn rule demoted it: all 16 rate-collapse pushes in the window
  arrived as "[Low] … No immediate action expected", for a family whose 30-day record
  includes an episode lasting 12.2 h. It is the only detector that sees a device
  "barely reporting while still appearing fresh" — the crawl that defeats both the
  180 s staleness alarm and the gap detector. The omission was self-reinforcing:
  self-heal shortens episodes, which drives the churn ratio down, which keeps the rule
  latched harder.
- **The reserve-revert readback race.** The revert stamps `revertedAtMs` on the cloud
  ACK, but the SHP2 keeps reporting the raised reserve for another ~20-60 s. With the
  arbitrage posture already false, the engine read a 49 % pool against a still-raised
  50 % reserve and pushed a false "[Medium] Backup at reserve", resolving itself ~40 s
  later — at 05:06, against an owner floor of 16 %. `isRevertSettling` now holds the
  posture for exactly as long as the device still echoes the target we wrote, bounded
  by `REVERT_READBACK_GRACE_MS` so a genuine owner change is never masked.
- **Notification timeouts.** Every `request()` in `notify.ts` was uncapped, so undici's
  300 s defaults applied. `sendNotification` is awaited inline inside the alarm
  evaluator, which is serialised behind a re-entrancy latch on a 20 s tick, so one
  wedged Supervisor→Core request could stall *all* alarm evaluation for minutes.
  `haService.ts` was capped across v0.9.57 / v0.23.0 / v0.73.0; this module has its own
  `request` import and was missed. Now capped at 5 s headers / 10 s body.

Also fixed: `dbExport.test.ts` was flaky on ~40 % of runs (2/5 on clean main). The
fixture meant to hold the source DB handle open — the state a live recorder is always
in — but the handle was a local that V8 could finalize mid-test, closing it and letting
the export's own close checkpoint the WAL, which writes the source. Handles are now
pinned for the file's lifetime.

### 12l. The spare-DPU list has been inverted since 2026-08-20 (v1.121.0)

The 08-20 swap put **Core 5 into SHP2 slot 3** and moved **Core 3 to the bench**,
inverting the hardcoded `SPARE_DPU_SNS` literal: it still calls Core 5 a spare (it
was measured on 2026-09-03 delivering ~1.87 kW as a connected source) and does not
name the actual bench unit at all.

`isExpectedOfflineSpare`'s positive connected-source check hid this while the SHP2
was reporting — Core 5 *is* a connected source, so it was not muted. The hole opens
exactly when the SHP2 goes cloud-dark, a documented recurring state: `connected`
empties, the literal is consulted alone, and Core 5's genuine offline alarm is muted
as an "expected" bench state — during the window when the alarm chain is already
degraded. `homeCoreCoverage`'s SHP2-blind fallback had the mirror-image problem: it
built the roster {Core 1, Core 2, **Core 3**}, counting bench hardware as a reporting
home Core while dropping a live pool member, so coverage could read `complete` with a
real member unobserved — and `gridState` uses exactly that flag to decide whether to
withhold the at-floor grid backstop.

v1.117.0 had already built the right answer for `isHomePoolDpu` (live roster →
persisted last-known roster → literal); the other consumers never received it. They
now share one roster-aware predicate, `isBenchSpareSn`, fed by a publisher that
index.ts keeps current. **The roster can only ever remove spare status** — it adds a
conjunct, never relaxes one — so the change is monotone toward fail-loud: the worst
case is an unnecessary offline alarm for genuine bench hardware, never a silenced one
for a live pool member. Consumers updated: the offline-spare mute (alerts,
alertMonitor), `homeCoreCoverage` (gridState, telnet console), `repairIssues`, and the
recorder's restart-gap accounting.

### 12m. The SHP2 alone could not trigger self-heal (v1.121.0)

`minStarvedDevices: 2` is an anti-thrash guard sized against "one flaky device". But
the SHP2 is the single-point-critical input for the floor / SoC / runway alarm chain,
and `messageRateFloor`'s own header cites the case of it crawling at 0.24 msg/min for
~13 h **alone**. A wedge confined to it could never reach a two-device quorum, so
`starvedSinceMs` was reset every tick and no rebuild was ever attempted: the one
device whose silence blinds the alarms was also the one device that could not trigger
the remedy.

The SHP2 now satisfies the quorum on its own. Everything else is untouched — the
20-minute dwell, the 60-minute cooldown and the 6-per-rolling-24 h budget all still
apply, so this cannot thrash; it only lets the clock start. In the four fleet-wide
episodes observed in the audit window the SHP2 fired ~16 minutes before the Cores
reached quorum, and that head start was discarded.

v1.157.0 keeps this exception exactly: when idle Cores are excluded from the quorum
(`selfHealQuorum`), the panel still counts by identity, so a panel-only wedge heals on
the same schedule.

### 12n. The announce path (v1.122.0)

Four audit findings in the one channel that reaches the household without a phone.

- **One retry slot for every alarm source.** `retryTimer` and `retryAttempt` were
  single, but `runBroadcastInner` serves both the condition-transition path and the
  dedicated `announce()` path used by the SoC ladder, the runway alarm and the
  night-charge notice. The retry exists for an HA/MA restart window in which every
  speaker is briefly unavailable — precisely a window in which several alarms defer
  in a row. A critical deferred at T+0 was erased at T+25 s by a routine yellow
  deferral, with nothing logged, and the household heard only the yellow. The shared
  counter compounded it: three yellow deferrals exhausted the budget, so the next red
  got "giving up after 3 deferred retries" without a single attempt. The precedence
  rule is now a pure, tested function (`retrySlotDecision`): a less severe deferral
  never supersedes a more severe pending retry, a more severe condition gets a fresh
  budget, and superseding is logged.
- **A timed-out announcement was filed as verifiably heard.** v1.118.1 correctly
  stopped *retrying* on a timeout by returning `ok: true`, but `ok` was also the sole
  input to two "this was heard" decisions. The timeout branch logs "delivery UNKNOWN"
  while the code granted it verification credit, which can suppress a standing
  critical's klaxon replay — and on this plant standing faults keep the same
  fingerprint for weeks. `playAnnounce` now returns a third state: `ok: true,
  verified: false` — do not retry, but do not claim it was delivered.
- **The supervised consent notice was eaten by the storm gate.** The evening arm job
  is pinned at 21:30 and the SoC ladder routinely chimes in the same minute band. A
  `medium` arm notice after a `medium` SoC chime is not an escalation, so on
  2026-09-01 it was dropped 107 s later: "supervised announce suppressed … arm
  delivered via HA notify". The whole safety story of the supervised posture is that
  the owner is told before a device write and can cancel until the write moment; that
  checkpoint silently degraded to phone-only. It now bypasses the same-level gate,
  and it fires at most twice a night so it cannot storm.
- **The nightly advisory held both alarm speakers for a full minute.** The prose
  written for the text push was reused verbatim as TTS and doubled by the bilingual
  pass: the 2026-09-02 clip was 2,643,918 bytes = 59.95 s, 3.3x every other clip in
  the corpus. Broadcasts are serialised through one promise chain, so a red arising
  in that window could not be spoken until it finished — an announcement-latency
  floor of a minute on a life-safety channel, imposed by the least urgent message the
  system produces. The spoken variant is now built by `nightChargeSpokenNotice` and
  bounded by `MAX_SPOKEN_ADVISORY_CHARS` (asserted by test): ~46 % shorter, roughly
  32 s. The text channel keeps the full prose, and the shortfall disclosure stays on
  the audible path as a clause — audible must never be quieter about residual risk
  than text.

### 12o. Reports that claimed more than they knew (v1.123.0)

- **The cleared-alert ledger recorded the closing body against the opening
  timestamp.** `TrackedAlert.alert` is refreshed every tick so the live view shows
  current values, and the retirement path reused that same mutable reference for the
  permanent record. A live row reads `raisedAt 09-02 22:56:56` with detail "Backup
  pool 49% is at or under the 50% reserve floor" — but the pool was ~28 % at
  22:56:56; 49 % is where it ended up six hours later. It looks like a physically
  impossible 19-point jump in one poll, and it cost this audit a wrong intermediate
  conclusion. This ledger is what `/api/warranty-export` draws on for the EcoFlow
  RMA, so the opening state is now frozen at first sighting and the closing state is
  preserved separately in `closedAs`. v1.14.0 had recognised exactly this hazard for
  `severity` and repaired that one field.
- **Per-family precision was 1.0 by construction.** The aggregate correctly declines
  to measure a one-class stream, but that guard was never pushed down into the family
  rollup — so Model Health published `overallPrecision: null` beside ten families all
  reading `precision: 1, dismiss: 0`. A real collapse in one family would have had to
  compete with nine neighbours reporting perfection. `familyPrecision` now applies the
  same evidence floor; the raw counts are still published, only the derived claim is
  withheld.
- **A missing EVSE prediction was recorded as "0 sessions, 0 kWh"** — indistinguishable
  from a confident "the car will not charge". The ledger shows the artifact: 08-27
  records 0 sessions, 08-28 records 6 sessions / 45.1 kWh, and a 30-day rolling window
  cannot gain six historical sessions overnight. The advisor's own contract already
  forbids this read; the plan-time surface honoured it, the recorded row did not. It
  is now `null`.
- **The poll period absorbed the poll duration** — measured 3,626-3,638 s against a
  3,600 s nominal hour. Small, but the coupling is the point: cadence degraded in
  lockstep with the vendor's own slowness, so telemetry was least fresh exactly during
  the nightly starvation window. `nextPollDelayMs` compensates against a fixed
  deadline while keeping the no-overlap property.

**Readiness is now honest about what it cannot measure.** `cushion_shortfall` is the
exemption key for three mechanisms — the under-buy pool, the buy de-bias learner and
the engine-fault strike detector — and on this plant it is pinned true by arithmetic:
the pool holds 92.16 kWh while the worst-case day drains 128-152 kWh, so the cushion
cannot be met from any starting SoC. `underBuyRate: null` and `activeStrikes: 0` are
therefore not a clean bill of health; they are **unmeasured**. The gate now publishes
`underBuyMeasurable` / `strikesMeasurable` beside them and says so in the blocking
line. **No criterion was loosened** — re-scoping the cushion is an open policy
decision, and until it is made, fail-closed with an honest label is the correct
posture.

Also corrected: the Notify Channel description implied `ha` delivers a phone push. It
did not — `persistent_notification.create` creates a card in the HA drawer with no OS
alert and no sound.

> **Superseded by §12p (v1.124.0).** That release made the `ha` channel deliver a real
> push via `notify.mobile_app_*`, so the claim this section corrected is true again —
> but only when `NOTIFY_HA_PUSH_TARGETS` names at least one service. The ntfy /
> Pushover / webhook channels this section pointed at no longer exist.

