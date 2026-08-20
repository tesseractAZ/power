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
