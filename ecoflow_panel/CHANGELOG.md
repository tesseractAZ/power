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

