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

