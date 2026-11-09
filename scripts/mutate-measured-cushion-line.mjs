#!/usr/bin/env node
/**
 * mutate-measured-cushion-line.mjs — committed harness for v1.199.0, the outage cushion's line on the
 * packs' measured capacity.
 *
 * (L) THE LINE. On the islanded-outage basis the line the plan holds and writes counts the cushion's
 * energy on the packs' measured capacity: targetFloorKwh = reserveKwh + cushionKwh ÷ scale
 * (nightChargeAdvisor.ts cushionLineKwh), so ⌈line⌉ − floor points of the measured capacity hold the
 * whole cushion. The floor is not divided; a legacy-pct band and a disabled cushion do not move; an
 * absent or implausible scale is the nameplate line exactly. Mutants L-i..x. v1.202.0 — the sizing counts
 * its pool on the measured capacity (plannerPoolKwh) and hands cushionLineKwh a scale only where the pool
 * is the panel's figure (none, no reading, or 1), so the line is plain reserve + cushion on the pool on
 * every path; L-i..ix pin cushionLineKwh's own rules as a unit, L-x the seam.
 *
 * (A) AGREEMENT. Until v1.202.0 every reader of the line was pinned to the one targetFloorKwh against
 * the nameplate line, reserveKwh + cushionKwh (mutants A-i..ix). Under v1.202.0 targetFloorKwh IS
 * reserveKwh + cushionKwh, bit for bit, on every basis (measured, held, min-known, nameplate), with the
 * scale absent, implausible or 1, and on every cushion basis (islanded-outage, legacy-pct, disabled):
 * plannerPoolKwh passes cushionLineKwh no scale where it moved the pool, and cushionLineKwh's ÷ scale is
 * ÷ 1 where it gets one. Those nine mutants were equivalent (the re-sweep on 38254e85: 33/42), and the
 * defect they pinned, the ÷ scale missing at one reader, has no form left. The defect v1.202.0 could
 * bring back at a reader is a line counted on the panel's nameplate figure (panelFullKwh) instead of the
 * pool (fullKwh), and only a reader that converts the line between kWh and a percent can make it:
 *   A-v, A-vi, A-vii, A-viii — RE-POINTED at that conversion: the charge plan's and the hold plan's line,
 *   the setpoint's line ask and T_mid's line term, each read on the panel's figure.
 * The readers in kWh only compare the line with a walk on the pool; there the line in kWh is the line,
 * with no nameplate form, so they are RETIRED, and what guards each is the walk it compares, in
 * mutate-measured-planner-walks.mjs (the line itself: MPW-P-i the seam, MPW-L-i ÷ s twice, MPW-L-ii the
 * reserve on the panel's figure):
 *   A-i   the hold test (the no-buy pack at the close)   MPW-W-i its walk, MPW-W-iii the pack now,
 *                                                        MPW-W-ix the whole-house trough (legacy band, backup leg)
 *   A-ii  meetability (the window walk at full effort)    MPW-W-vi its clamp, MPW-W-viii its start,
 *                                                        MPW-W-vii the full-pack proxy an unmeetable line gets
 *   A-iii the requirement's bisection                     MPW-W-iii, MPW-W-viii, MPW-SB-i and MPW-SB-v (its legs)
 *   A-iv  cushionShortfall (the walk at the lift bought)  MPW-W-vi, MPW-W-viii, MPW-W-iii
 *   A-ix  the backup leg's setpoint walk                  MPW-W-v (that walk on the panel's figure)
 * The plan field and the rationale's clause appear only where a scale applied, and the inputs carry it
 * only when given. Mutants A-x..xiii.
 *
 * (D) THE DOOR (runwayBasisContracts.test.ts, SCOPE): the scale reaches the planner only from index.ts
 * measuredCushionScale, on the main thread's own tracker and file, from the planner's own snapshot
 * before its first await; no helper or module launders the measured basis to the planner, the
 * force-charge or the actuator; nothing downstream reads the plan's scale. Mutants D-i..xii. And no
 * way to the scale that does not spell `cushionPoolScale` gets past the pins: the ledger helper that
 * returns it, a ledger row's column, the tracker's own file, or a code line that opens with a block
 * comment (which the source inventory once skipped as a comment line). Mutants D-xiii..xvi.
 *
 * (R) THE LEDGER: both columns written on every plan row, kept by the allowlist and added to a
 * deployed ledger. Mutants R-i..iii.
 *
 *   node scripts/mutate-measured-cushion-line.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does
 *   not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. Run with MUTATE_CONCURRENCY=2 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');

const T_LINE = 'test/measuredCushionLine.test.ts';
const T_SCOPE = 'test/runwayBasisContracts.test.ts';
const T_LEDGER = 'test/cushionPoolScaleLedger.test.ts';

const MUTANTS = [
  /* ── L: the line ── */
  {
    id: 'L-i. ★★★ the cushion is multiplied by the scale, not divided (a LOWER line than nameplate)',
    file: NCA, tests: [T_LINE],
    find: '  return { kwh: o.reserveKwh + o.cushionKwh / scale, applied: { scale, basis: o.poolScale.basis } };',
    to: '  return { kwh: o.reserveKwh + o.cushionKwh * scale, applied: { scale, basis: o.poolScale.basis } }; /* MUTANT */',
    why: 'The line falls to 29.25% and the write to 30: the defect made worse, the fail-safe direction inverted.',
  },
  {
    id: 'L-ii. ★★★ the whole line is divided, the floor too',
    file: NCA, tests: [T_LINE],
    find: '  return { kwh: o.reserveKwh + o.cushionKwh / scale, applied: { scale, basis: o.poolScale.basis } };',
    to: '  return { kwh: (o.reserveKwh + o.cushionKwh) / scale, applied: { scale, basis: o.poolScale.basis } }; /* MUTANT */',
    why: 'The floor is the panel\'s own percent: 32.26% instead of 31.67%, and the write 33.',
  },
  {
    id: 'L-iii. ★★★ the scale is applied to the legacy-pct band',
    file: NCA, tests: [T_LINE],
    find: "  if (o.cushionBasis !== 'islanded-outage' || o.poolScale == null) return { kwh: nameplate, applied: null };",
    to: "  if (o.cushionBasis === 'disabled' || o.poolScale == null) return { kwh: nameplate, applied: null }; /* MUTANT */",
    why: 'The legacy band is already a percent of the pool: the band moves, which the owner\'s decision excludes.',
  },
  {
    id: 'L-iv. ★★★ a scale above 1 is accepted',
    file: NCA, tests: [T_LINE],
    find: '  const s = o.poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) {',
    to: '  const s = o.poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s < CUSHION_SCALE_PLAUSIBLE_MIN) { /* MUTANT */',
    why: 'Clamped to 1 it is harmless here, but recorded as a measured 1 rather than ignored as a bad reading.',
  },
  {
    id: 'L-v. ★★★ a scale under 0.5 is accepted',
    file: NCA, tests: [T_LINE],
    find: '  const s = o.poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) {',
    to: '  const s = o.poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s <= 0 || s > 1 + 1e-9) { /* MUTANT */',
    why: 'A 0.3 reading triples the cushion\'s percent: every resilience night writes 50 on a bad reading.',
  },
  {
    id: 'L-vi. ★★★ NaN is accepted',
    file: NCA, tests: [T_LINE],
    find: '  const s = o.poolScale.scale;\n  if (typeof s !== \'number\' || !Number.isFinite(s) || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) {',
    to: '  const s = o.poolScale.scale;\n  if (typeof s !== \'number\' || s < CUSHION_SCALE_PLAUSIBLE_MIN || s > 1 + 1e-9) { /* MUTANT */',
    why: 'A NaN line makes every comparison false: the v1.39.0 fail-open class (a confident max buy).',
  },
  {
    id: 'L-vii. ★★ the plausible minimum moves to 0.3',
    file: NCA, tests: [T_LINE],
    find: 'export const CUSHION_SCALE_PLAUSIBLE_MIN = 0.5;',
    to: 'export const CUSHION_SCALE_PLAUSIBLE_MIN = 0.3; /* MUTANT */',
    why: 'Under CAPACITY_SCALE_MIN\'s own clamp: a reading the tracker can never give is admitted.',
  },
  {
    id: 'L-viii. ★★ float noise above 1 is not clamped',
    file: NCA, tests: [T_LINE],
    find: '  const scale = Math.min(1, s);\n  return { kwh: o.reserveKwh + o.cushionKwh / scale',
    to: '  const scale = s; /* MUTANT */\n  return { kwh: o.reserveKwh + o.cushionKwh / scale',
    why: 'A scale of 1 + 1e-10 lowers the line by a hair and records a scale above nameplate.',
  },
  {
    id: 'L-ix. ★★ an ignored scale is not recorded as implausible',
    file: NCA, tests: [T_LINE],
    find: "    return { kwh: nameplate, applied: { scale: 1, basis: 'implausible' } };",
    to: '    return { kwh: nameplate, applied: null }; /* MUTANT */',
    why: 'A bad reading reads as "no scale passed": the ledger cannot tell a tracker fault from a fresh install.',
  },
  {
    id: 'L-x. ★★★ the planner ignores the scale (the defect)',
    file: NCA, tests: [T_LINE, T_SCOPE],
    // v1.202.0 — re-anchored at the seam: the one read of the scale, into the planning pool the line is counted on.
    find: '  const pool = plannerPoolKwh(panelFullKwh, inputs.cushionPoolScale);',
    to: '  const pool = plannerPoolKwh(panelFullKwh, null); /* MUTANT */',
    why: 'The written line holds ~0.944 of the cushion again: 18.27 of 18.85 kWh on the scenario.',
  },

  /* ── A: every reader agrees with the one line ── */
  // v1.202.0 — A-i..iv and A-ix retired, A-v..viii re-pointed at the panel's figure (the header).
  {
    id: 'A-v. ★★★ the charge plan reports its line on the panel\'s figure, not the pool',
    file: NCA, tests: [T_LINE],
    find: '  const cushionLineSocPct = round2((targetFloorKwh / fullKwh) * 100);',
    to: '  const cushionLineSocPct = round2((targetFloorKwh / panelFullKwh) * 100); /* MUTANT */',
    why: 'The 31.67% line reads 29.89% (27.55 kWh of the pool over 92.16): the push, the card, the ledger and the realized verdict grade a night written at 32 on a line 1.8 points under it.',
  },
  {
    id: 'A-vi. ★★ the hold plan reports its line on the panel\'s figure, not the pool',
    file: NCA, tests: [T_LINE],
    find: '      cushionLineSocPct: round2((targetFloorKwh / fullKwh) * 100),',
    to: '      cushionLineSocPct: round2((targetFloorKwh / panelFullKwh) * 100), /* MUTANT */',
    why: 'A hold states (and the ledger records) its 31.67% line as 29.89%: not the line its test held (the 68% night\'s trough, 32.02%).',
  },
  {
    id: 'A-vii. ★★★ the setpoint asks its line on the panel\'s figure, not the pool',
    file: NCA, tests: [T_LINE],
    // v1.200.0 (review) — anchor moved: the reserve path's ask reads askOf (the one expression).
    // v1.203.0 — anchor moved: the reserve path's ask is lineReserveAskPct (askOf and the panel's point).
    find: "    ? lineReserveAskPct(targetFloorKwh, fullKwh, cushionBasis === 'islanded-outage' ? holdUndershootPct : 0) : 0;",
    to: "    ? lineReserveAskPct(targetFloorKwh, panelFullKwh, cushionBasis === 'islanded-outage' ? holdUndershootPct : 0) : 0; /* MUTANT */",
    why: 'The ask is ⌈29.89⌉ = 30 under a 31.67% line, so the setpoint is the arrival (31.7, not 32); on the year a 32.02% line writes 32, under it (2026-10-12 resilience).',
  },
  {
    id: 'A-viii. ★★ T_mid\'s line term on the panel\'s figure, not the pool',
    file: NCA, tests: [T_LINE],
    find: '      linePct: (targetFloorKwh / fullKwh) * 100,',
    to: '      linePct: (targetFloorKwh / panelFullKwh) * 100, /* MUTANT */',
    why: 'The line term is ⌈29.89⌉ = 30 under a 31.67% line, a term that alone writes under the line: the mid-day write the line sets (32) is credited to the resilience term.',
  },
  {
    id: 'A-x. ★★★ the plan carries an undefined scale key where none applied',
    file: NCA, tests: [T_LINE],
    // v1.201.0 — re-anchored: the charge plan's spread is followed by the standby's (the Cores' standby in the cushion).
    // v1.202.0 — re-anchored: the plan's scale is the pool's or the line's (planScale), beside the plan's pool.
    find: "    ...(planScale != null ? { cushionPoolScale: planScale } : {}),\n    // v1.202.0 — the pool and the standby the walks counted, only where either differs from v1.201.0's walks.\n    ...planPoolField,\n    // v1.201.0 — the Cores' standby the cushion counted, only where a figure was passed (islanded-outage).\n    ...(standby != null ? { cushionStandby: standby } : {}),\n    cushionOutageHours:",
    to: "    cushionPoolScale: planScale ?? undefined, /* MUTANT */\n    // v1.202.0 — the pool and the standby the walks counted, only where either differs from v1.201.0's walks.\n    ...planPoolField,\n    // v1.201.0 — the Cores' standby the cushion counted, only where a figure was passed (islanded-outage).\n    ...(standby != null ? { cushionStandby: standby } : {}),\n    cushionOutageHours:",
    why: 'Every plan without a scale gains a key: no plan reproduces its digest (the persisted JSON\'s key list).',
  },
  {
    id: 'A-xi. ★★ the rationale names the measured capacity at a scale of 1',
    file: NCA, tests: [T_LINE],
    find: '  const measuredCushionNote = planScale != null && planScale.scale < 1',
    to: '  const measuredCushionNote = planScale != null && planScale.scale <= 1 /* MUTANT */',
    why: 'A plan that moved no number says it did: "×1.000 of nameplate", and the golden text moves.',
  },
  {
    id: 'A-xii. ★★ the rationale\'s share divides by the scale a second time',
    file: NCA, tests: [T_LINE],
    // v1.203.0 — anchor moved: the measured branch beside the capacity floor's.
    find: "      : `, ${round1(((targetFloorKwh - reserveKwh) / fullKwh) * 100)}% of the packs' measured capacity at ×${planScale.scale.toFixed(3)} of nameplate`",
    to: "      : `, ${round1(((targetFloorKwh - reserveKwh) / fullKwh / planScale.scale) * 100)}% of the packs' measured capacity at ×${planScale.scale.toFixed(3)} of nameplate` /* MUTANT */",
    why: '"23% of the packs\' measured capacity" for a cushion that is 21.7% of it.',
  },
  {
    id: 'A-xiii. ★★★ buildNightChargeInputs drops the scale',
    file: NCA, tests: [T_LINE],
    // v1.203.0 — anchor moved: the scale is forwarded as planPoolScale (the capacity floor on a cushion-only plan with none known).
    find: '    ...(planPoolScale !== undefined ? { cushionPoolScale: planPoolScale } : {}),',
    to: '    ...(planPoolScale === undefined ? { cushionPoolScale: planPoolScale } : {}), /* MUTANT */',
    why: 'The v1.125.0 destructure hazard: index.ts passes the scale and every plan stays on nameplate.',
  },

  /* ── D: the door ── */
  {
    id: 'D-i. ★★★ the door reads the secondary panels\' tracker',
    file: IDX, tests: [T_SCOPE],
    find: '    const b = cushionPoolBasisTracker.evaluate(devs, panel, nowMs);',
    to: '    const b = panelPoolBasisTracker.evaluate(devs, panel, nowMs); /* MUTANT */',
    why: 'The house panel enters the secondary panels\' file, and their Cores\' ratios become its lowest known.',
  },
  {
    id: 'D-ii. ★★★ the door hands over the candidate before the 24 h increase hold',
    file: IDX, tests: [T_SCOPE],
    find: '    return { scale: b.capacityScale, basis, connectedCores: b.connectedCores };',
    to: '    return { scale: b.candidateScale, basis, connectedCores: b.connectedCores }; /* MUTANT */',
    why: 'A BMS recalibration upward lowers the line at once — the unsafe direction the hold exists to delay.',
  },
  {
    id: 'D-iii. ★★★ the cushion tracker writes the secondary panels\' file',
    file: IDX, tests: [T_SCOPE],
    // v1.203.0 — anchor moved: the construction line carries the read-only seed.
    find: "const cushionPoolBasisTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-cushion'), seedPath: defaultPoolEnergyBasisPath('pool-energy-basis') });",
    to: "const cushionPoolBasisTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-panels'), seedPath: defaultPoolEnergyBasisPath('pool-energy-basis') }); /* MUTANT */",
    why: 'Two trackers write one file: each restart loads the other\'s panels and held ratios.',
  },
  {
    id: 'D-iv. ★★★ the scale is taken from a second snapshot',
    file: IDX, tests: [T_SCOPE],
    find: '  const cushionPoolScale = measuredCushionScale(devs, shp2, nowMs);',
    to: '  const cushionPoolScale = measuredCushionScale(store.get().devices, shp2, nowMs); /* MUTANT */',
    why: 'The scale and the pool it converts on come from different readings of the fleet.',
  },
  {
    id: 'D-v. ★★★ the house panel is read from a second snapshot',
    file: IDX, tests: [T_SCOPE],
    find: '  const devs = store.get().devices;\n  const shp2 = findShp2(devs);',
    to: '  const devs = store.get().devices;\n  const shp2 = findShp2(store.get().devices); /* MUTANT */',
    why: 'fullWh and the scale are no longer one snapshot.',
  },
  {
    id: 'D-vi. ★★★ the scale never reaches the planner',
    file: IDX, tests: [T_SCOPE],
    find: "    // v1.199.0 — the cushion line's measured capacity scale (null: the nameplate line). v1.202.0 — the plan's pool's too.\n    cushionPoolScale,",
    to: "    // v1.199.0 — the cushion line's measured capacity scale (null: the nameplate line). v1.202.0 — the plan's pool's too.\n    ...((false as boolean) ? { cushionPoolScale } : {}), /* MUTANT */",
    why: 'The add-on keeps writing the nameplate line: the fix ships inert.',
  },
  {
    id: 'D-vii. ★★ a shadow leg logs the scale',
    file: IDX, tests: [T_SCOPE],
    find: '  const cushionPoolScale = measuredCushionScale(devs, shp2, nowMs);\n  if (!shadowLeg) {',
    to: '  const cushionPoolScale = measuredCushionScale(devs, shp2, nowMs);\n  if ((true as boolean)) { /* MUTANT */',
    why: 'The shadow leg\'s "no calibration log" rule: its evaluations are not the live plan\'s.',
  },
  {
    id: 'D-viii. ★★★ laundering: a helper the planner calls reads the secondary panels\' measured basis',
    file: IDX, tests: [T_SCOPE],
    find: '  if (!islandedLoadKwCache) return null;',
    to: '  if (!islandedLoadKwCache || !panelPoolBasisTracker) return null; /* MUTANT */',
    why: 'The token check reads only the planner\'s own text: a helper it reaches carries the basis past it.',
  },
  {
    id: 'D-ix. ★★★ laundering: a helper the force-charge reaches touches the door',
    file: IDX, tests: [T_SCOPE],
    find: '  try { return nightScheduleNow().forceChargeMaxRunMs; } catch { return FORCE_CHARGE_MAX_RUN_MS; }',
    to: '  try { void measuredCushionScale; return nightScheduleNow().forceChargeMaxRunMs; } catch { return FORCE_CHARGE_MAX_RUN_MS; } /* MUTANT */',
    why: 'A second consumer of the measured basis, outside the one exception.',
  },
  {
    id: 'D-x. ★★★ a downstream reader of the plan\'s scale (the stated line)',
    file: NCA, tests: [T_SCOPE],
    find: '  const line = plan.cushionLineSocPct;',
    to: '  const line = plan.cushionLineSocPct ?? (plan as NightChargePlan).cushionPoolScale?.scale; /* MUTANT */',
    why: 'The scale leaves the line it was read for: the exception is no longer one figure.',
  },
  {
    id: 'D-xi. ★★★ the sizing reads the applied scale outside the one line',
    file: NCA, tests: [T_SCOPE],
    find: '  const cushionShortfall = minProjKwh < targetFloorKwh - 1e-6;',
    to: '  const cushionShortfall = minProjKwh < targetFloorKwh - 1e-6 && cushionLine.applied?.scale !== 0; /* MUTANT */',
    why: 'A second read of the scale in the sizing, which the one-line pin exists to refuse.',
  },
  {
    id: 'D-xii. ★★ the planner imports a module that reaches the runway basis',
    file: NCA, tests: [T_SCOPE],
    find: "import { taperCeilingKwh } from './chargeTaper.js';",
    to: "import { taperCeilingKwh } from './chargeTaper.js';\nimport { panelDrainRunway as _pdr } from './panelRunway.js'; void _pdr; /* MUTANT */",
    why: 'A module the planner imports can carry the measured basis in: the import set is pinned.',
  },
  {
    id: 'D-xiii. ★★★ laundering: the force-charge reads the scale through the ledger helper',
    file: IDX, tests: [T_SCOPE],
    find: '  const fullWh: number | null = sp?.backupFullCapWh ?? null;\n  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  const socCoherent =\n',
    to: '  const fcScale = cushionPoolScaleLedgerColumns(getLatestNightChargePlan() ?? {}).cushion_pool_scale ?? 1; /* MUTANT */\n'
      + '  const fullWh: number | null = sp?.backupFullCapWh != null ? sp.backupFullCapWh * fcScale : null;\n'
      + '  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  const socCoherent =\n',
    why: 'The helper returns the scale and its name is not the token `cushionPoolScale`: the JIT stop moves onto the measured basis unseen.',
  },
  {
    id: 'D-xiv. ★★★ laundering: the reserve actuator reads the scale from a ledger row',
    file: IDX, tests: [T_SCOPE],
    find: '      : null;\n  const fullWh: number | null = sp?.backupFullCapWh ?? null;\n  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  // Same I11 coherence',
    to: '      : null;\n  const acScale = recorder.readNightLedger(2)[0]?.cushion_pool_scale ?? 1; /* MUTANT */\n'
      + '  const fullWh: number | null = sp?.backupFullCapWh != null ? sp.backupFullCapWh * acScale : null;\n'
      + '  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  // Same I11 coherence',
    why: 'The ledger column is the scale under another spelling: the actuator\'s coherence test and writes move onto the measured basis.',
  },
  {
    id: 'D-xv. ★★★ laundering: the force-charge opens the cushion tracker\'s file',
    file: IDX, tests: [T_SCOPE],
    find: '  const fullWh: number | null = sp?.backupFullCapWh ?? null;\n  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  const socCoherent =\n',
    to: '  let fcScale = 1; /* MUTANT */\n'
      + '  try { fcScale = Number(JSON.parse(readFileSync(defaultPoolEnergyBasisPath(\'pool-energy-basis-cushion\') ?? \'\', \'utf8\')).appliedScale) || 1; } catch { /* none */ }\n'
      + '  const fullWh: number | null = sp?.backupFullCapWh != null ? sp.backupFullCapWh * fcScale : null;\n'
      + '  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  const socCoherent =\n',
    why: 'The persisted basis is the door\'s state read without the door: a second reader of the measured basis.',
  },
  {
    id: 'D-xvi. ★★ a downstream reader of the plan\'s scale on a line that opens with a block comment',
    file: NCA, tests: [T_SCOPE],
    find: '  const line = plan.cushionLineSocPct;',
    to: '  /* v1.199.0 */ const line = plan.cushionLineSocPct ?? (plan as NightChargePlan).cushionPoolScale?.scale; /* MUTANT */',
    why: 'The source inventory skipped every line that starts like a comment, code after the `*/` included.',
  },

  /* ── R: the ledger ── */
  {
    id: 'R-i. ★★★ recordNightPlanRow writes the columns only with a scale',
    file: IDX, tests: [T_LEDGER],
    find: '    ...cushionPoolScaleLedgerColumns(plan),',
    to: '    ...(plan.cushionPoolScale ? cushionPoolScaleLedgerColumns(plan) : {}), /* MUTANT */',
    why: 'A re-issued plan with no scale keeps the earlier plan\'s scale beside its own nameplate line.',
  },
  {
    id: 'R-ii. ★★★ the columns are not in the ledger allowlist',
    file: REC, tests: [T_LEDGER],
    find: "  'cushion_pool_scale', 'cushion_pool_scale_basis',\n",
    to: '  /* MUTANT */\n',
    why: 'The write is dropped silently: no row says which basis its line is on.',
  },
  {
    id: 'R-iii. ★★★ the columns are never added to a deployed ledger',
    file: REC, tests: [T_LEDGER],
    find: "    'cushion_pool_scale REAL', 'cushion_pool_scale_basis TEXT',",
    to: '    /* MUTANT */',
    why: 'Every plan write fails on the deployed database.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-measured-cushion-line', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
