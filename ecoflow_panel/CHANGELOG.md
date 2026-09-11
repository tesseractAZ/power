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
reports a permanent, owner-settled product-class limit.

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

**API error 1006 is a product-class limit, not a grantable account permission.** The
owner settled this on 2026-09-08: EcoFlow is not expected to extend API coverage to
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
for, and the honest fix for "I was reading stale data" is to make the staleness
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
measurement available"*, so an owner asking for no cushion silently received the
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
superseded by an explicit owner decision, so the assertion was updated rather than
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
*neither* the restore target nor the raised target is treated as the owner moving
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
`CRITICAL_BREAKS_QUIET_HOURS` off — the owner's accepted posture — the 06:00 digest is
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

