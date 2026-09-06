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

