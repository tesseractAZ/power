## 1.199.1

### The web UI's static file server runs on glob 14

**Dependencies**

- `glob` 13.0.6 → 14.0.3 and `minimatch` 10.2.5 → 11.0.4, forced through an npm override in `server/package.json` (`"overrides": {"glob": "^14.0.3"}`). Both come in only through `@fastify/static`, whose newest release (10.1.8) still asks for glob 13. This closes two GitHub advisories: GHSA-3g3m-2fjr-6pw4 (glob: a cancelled walk can keep reading the filesystem) and GHSA-g3hv-75wg-m249 (minimatch: a denial of service through pattern amplification).
- Neither was reachable in the add-on. `@fastify/static` globs the built web UI folder once at start (`wildcard: false`) with the fixed pattern `**/**` and no abort signal. glob 14 keeps that call's function and options; its changes are internal (minimatch 11 matchers, ignore patterns that start with `/`, the removed `debug` option), and none of them reaches this call. glob 14 needs Node 18, 20 or 22 and later; the image runs Node 22.
- Remove the override once `@fastify/static` itself depends on glob 14.

**Unchanged**

- No behaviour, option, API or Home Assistant entity changes. The web UI's files, routes and the 404 handling for missing assets are served as before (`spaAsset404.test.ts`).

## 1.199.0

### The outage cushion's reserve line holds the whole cushion on the batteries' measured capacity

**Night charge**

- Since 1.196.0 a resilience night writes the backup reserve at the outage-cushion line: the reserve floor plus the cushion, asked to the whole percent above it. The planner converted the cushion's energy to a percent on the panel's nameplate pool. The panel's reserve percent is a share of the packs' measured (BMS full-charge) capacity, about 0.944 of nameplate on the reference fleet, so the written line held only about that share of the cushion above the floor. On a 92.16 kWh pool with a 10% floor and an 18.85 kWh cushion, the 30.45% line was written as 31% and held 21% × 86.999 = 18.27 kWh, 96.9% of the cushion. Over a year of live-shaped nights, 114 of the 175 islanded charge nights written under 50% held less than their cushion.
- **The fix.** On the islanded-outage basis the line now counts the cushion on the measured capacity: line % = floor + 100 × cushion ÷ (nameplate pool × measured scale). The same night's line is 31.67%, written 32%, which holds 22% × 86.999 = 19.14 kWh. Whenever the write is under the panel's 50% maximum, (written − floor)% of the capacity the scale states holds at least the whole cushion (Limits says when that figure can be high). On the live-shaped night (a 16% floor, 4 h × 2.62 kW × 1.25 ÷ 0.94 = 13.94 kWh) the line moves from 31.13% to 32.02% and the write from 32% to 33%, about 0.87 kWh more held above the reserve. The line rises by a shift of the cushion's share of the pool × (1 ÷ scale − 1). Where the nameplate line sits at least the shift below the next whole percent, the write does not change. On the live-shaped night the shift is about 0.9 points, so this is about one night in ten. Over the year's varied cushions it is 38 of the 154 resilience writes under 50% that the line sets.
- **Only the cushion is converted.** The floor is the panel's own percent and is not divided. A legacy-pct band (no islanded-load measurement) is already a percent of the pool, and a disabled cushion is 0, so neither moves. The cushion itself, `cushionKwh` and the ledger's `cushion_kwh` stay the energy.
- **One line, every reader.** The hold test, the requirement, `cushionShortfall`, the line and trough the plan reports, the written setpoint, the mid-day leg's T_mid and the backup leg's walk all read the one converted line, so they agree with the written reserve. A charge-rate-bound night that reached the nameplate line but not the measured one now discloses the shortfall; a pack that sat between the two lines at the window close now sizes the gap. The expected buy, the "Night-Charge Target SoC", "Night-Charge Expected Buy" and "Night-Charge Buy (Worst Case)" entities, the 21:30 notice, the hold notice and the card follow the plan.
- **Where the scale comes from.** The planner reads the device map once and evaluates the house pool's measured capacity scale from it, beside the pool capacity and before its first `await`, so both come from one reading: a capacity tracker on the main thread for the house panel, with its own file (`pool-energy-basis-cushion.json` beside the database), using the runway's rules. A lower figure applies at once; a higher one waits 24 h at the lowest figure seen. A Core that is not reporting takes its last measured ratio (up to 30 days), else the lowest known ratio. The first complete measurement after the update applies at once. The log states the basis on change: "night-charge: the outage-cushion line counts the cushion on the packs' measured capacity, ×0.944 of nameplate (measured, 3 connected Core(s))".
- **Fail-safe.** A lower scale is a higher line, so nothing falls back below the nameplate line. With no scale (a tracker error, or no ratio ever measured) the line is the nameplate line exactly. A scale that is not a number in 0.5 to 1 is ignored and recorded as `implausible`. `CAPACITY_SCALE_MIN` set to 1 keeps the line on nameplate. The rationale states the measured share only where the scale is under 1: "8 h of islanded backup load (18.9 kWh, 21.7% of the packs' measured capacity at ×0.944 of nameplate)".
- **The year at 0.944.** Against the same year on the nameplate line: all 702 islanded-outage lines move, by up to 2.01 points; 452 requirements, 166 worst-case buys (by up to 1.71 kWh), 143 setpoints, 120 written reserves, 67 expected buys (by up to 1.99 kWh) and 5 cost ceilings rise, and none falls. No charge night becomes a hold. On 4 nights the charge rate or a predicted EV session holds the pack under the measured line, and they now disclose a shortfall. From a scale of 1 down to 0.5, no figure falls below the plan without a scale.
- **Ledger.** Two plan columns, `cushion_pool_scale` and `cushion_pool_scale_basis`, record the scale the line was converted on and its basis (NULL where none applied, and on earlier rows). A row's line is then `reserve_floor_pct` + 100 × `cushion_kwh` ÷ (`pool_full_kwh` × `cushion_pool_scale`).
- **The measured-basis contract.** The planner, the just-in-time force-charge and the dispatch recommendations still never read the runway's measured basis, with this one exception. The contract test now pins the one entry point exactly. It also checks every helper the planner, the force-charge and the reserve actuator reach, the modules that import the runway's basis, the planner's own imports and every line where the scale appears. Every spelling of the scale counts: the plan's field, the ledger helper that returns it, the ledger's two columns and the tracker's file. The helper is called once, by the ledger writer, which none of the force-charge, the actuator and the dispatch recommendations may reach; the file is named once, where its tracker is built; and a code line that opens with a block comment is checked like any other. A second entry point fails the test.

**Unchanged**

- `ARB_OUTAGE_CUSHION_HOURS`, `ARB_OUTAGE_CUSHION_PCT`, `ARB_ISLANDED_LOAD_SAFETY`, the reserve floor, the cost path's formulas, the 10–50% reserve write range and the legacy band. A cost night whose cost target is above the line writes what it wrote.
- Every planner walk still counts a percent on the nameplate pool, and so does the expected buy's kWh per percent. The runway, the forecasts, the alarms, the force-charge and the dispatch recommendations are unchanged.
- `CURRENT_ALGO_VERSION` stays 3. Every scored column keeps its formula and grades the plan on its own line, which is now in the panel's basis. Nights before and after the update count on the same readiness clock; their lines differ by up to about 2 points, which the new column explains.
- The year of overnight plans in `legacyIdentity.golden.json` is the planner on the nameplate line, and reproduces byte for byte without a scale or with a scale of 1. No option, entity or attribute is added.

**Limits**

- The panel accepts a reserve of at most 50%. A line above 50% is written as 50%, as before, and the rationale says the panel only accepts up to 50%. On such a night, with no force-charge stop at or above the line, the pool closes the window under the line with no shortfall disclosed, so the realized cushion verdict can record an engine-fault strike, as it could before. The measured line is up to 2 points higher, so this is somewhat more frequent: over the year it applies to 24 charge plans (13 on the nameplate line), 6 of the 209 islanded evening charges (4 before).
- The Cores' standby draw (about 270 W) is still not in the cushion, so an island's real hours stay below `ARB_OUTAGE_CUSHION_HOURS` by that drain.
- The guarantee is exact on a `measured` basis at or above `CAPACITY_SCALE_MIN` (0.8 while unset). Below it the tracker counts the packs at `CAPACITY_SCALE_MIN`: packs at 0.75 of nameplate are counted at 0.8, and on a 10% floor with an 18.85 kWh cushion the 35.57% line, written 36%, holds 26% × 69.12 = 17.97 kWh.
- A held or lowest-known basis relies on that ratio, which can be high. A Core that is cloud-dark while the panel still lists it keeps its last ratio for up to 30 days, whatever its packs do meanwhile: with 0.944 held while one of three Cores falls to 0.85, the 32% write holds 22% × 84.11 = 18.50 kWh of the 18.85 kWh cushion.
- The arrival, the trough and the shortfall flag are still computed in nameplate kWh per percent, so they can differ from the panel's own percent by a few tenths of a point. The written reserve, which the panel holds in its own percent, carries the guarantee.
- The mid-day shadow's rows record the line on the measured capacity from this release, without the scale beside it.

**Dependencies**

- `@fastify/static` 10.1.7 → 10.1.8 and its `@fastify/send` 4.1.0 → 4.2.0 (the web UI's static file server).

**Tests**

- New: `measuredCushionLine.test.ts` (24 tests). It covers:
  - the defect fixed on the scenario above, worked by hand (line, write, the armed reserve, energy held, requirement, buys, the rationale), and that the floor is not divided;
  - the guarantee as a property over pools, floors, cushions and scales, and on every islanded charge night of the year;
  - the guarantee's limit: a held ratio after an unseen drop, and packs under `CAPACITY_SCALE_MIN`, with the figures chapter 15 part 1 states;
  - the fail-safe: no scale gives the same plan byte for byte, and NaN, ±∞, −1, 0, 0.3, under 0.5, 1.2 and 1 + 1e-8 give the nameplate plan recorded as `implausible`. Scale 1 moves nothing, and 0.5 is accepted. Down to 0.5 nothing falls below the nameplate plan, and the line, setpoint, write, requirement, buy and cost ceiling are monotone in the scale;
  - the scope: the legacy band, a disabled cushion, the cost formula, and the line against the planner run with the islanded load ÷ the scale;
  - agreement: a charge-bound night's shortfall, holds between and above the two lines, and the write against ⌈line⌉ over the year;
  - the backup leg and the mid-day T_mid line term, and the inputs' plumbing;
  - the year at 0.944 against the golden: direction, the counts above, the rule for an unchanged write on each of the 154 line-set writes, and the 50% envelope counts. The year with an explicit nameplate scale gives the golden digests. The year at 0.944 is checked case by case against `measuredCushionLine.figures.json`, a new fixture with its capture script `measuredCushionLineFigures.ts`;
  - the ledger columns, the log line, the tracker's scale reaching the planner end to end, and the tracker's file.
- New: `cushionPoolScaleLedger.test.ts`: the columns round-trip, read null on an older row, are replaced by a re-issued plan, and are written by `recordNightPlanRow`.
- Rewritten: the SCOPE tests in `runwayBasisContracts.test.ts`. Plans that are actually sized must be byte-identical on the legacy and the measured reports, with and without the scale, and the scale must change the line. The source pins cover the one entry point, the helpers and modules that could carry the measured basis to the planner, and every line where any spelling of the scale appears (the plan's field, the ledger helper, the ledger's columns), with the helper's one call and the tracker file's one mention pinned.
- Updated: the `legacyIdentity.test.ts` header (the digests are the nameplate-line planner).
- New harness `scripts/mutate-measured-cushion-line.mjs` (42 mutants).

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

## Older releases

Earlier releases are in [CHANGELOG-ARCHIVE.md](https://github.com/tesseractAZ/power/blob/main/ecoflow_panel/CHANGELOG-ARCHIVE.md). Every version also has its own notes on the [GitHub Releases page](https://github.com/tesseractAZ/power/releases).
