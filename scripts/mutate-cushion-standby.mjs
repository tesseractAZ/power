#!/usr/bin/env node
/**
 * mutate-cushion-standby.mjs — committed harness for v1.201.0, the Cores' standby draw counted in the
 * islanded-outage cushion.
 *
 * (S) THE STANDBY. On the islanded-outage basis the cushion is round2(H·L·k/η + H·w/1000), w the runway's
 * pool overhead figure for the connected Cores (nightChargeAdvisor.ts plausibleStandbyW, cushionStandbyKwh):
 * additive, not × the safety factor, not ÷ the discharge efficiency, over the configured hours, rounded once
 * more; divided by the measured capacity scale with the load leg, once, inside the one line. Absent ⇒ today's
 * cushion; a figure that is no reading (not finite, negative, above 1500 W, not a number) ⇒ 0 W recorded
 * 'implausible'; legacy-pct and disabled do not move. Mutants S-i..xv.
 *
 * (A) AGREEMENT. Every reader of the cushion reads the one cushionKwh and the one line: the shortfall, the
 * rationale's clause only where a figure above 0 W applied, the plan field on both plan shapes. Mutants A-i..iii.
 *
 * (B) THE PLUMBING: buildNightChargeInputs forwards the figure. Mutant B-i.
 *
 * (D) THE SECOND DOOR (runwayBasisContracts.test.ts, SCOPE): index.ts cushionStandbyOverheadW, the runway's
 * overhead rule for the Cores the cushion tracker counted, the panel reporting a pool; called once, beside the
 * scale door, from the same snapshot, before the first await; logged on a live leg only; passed once; no
 * other consumer reaches it and nothing launders the runway's overhead to the planner. Mutants D-i..x.
 *
 * (R) THE LEDGER: the three columns written on every plan row, kept by the allowlist and added to a deployed
 * ledger. Mutants R-i..iv.
 *
 *   node scripts/mutate-cushion-standby.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does not is
 *   reported INVALID and fails the run); each mutant names the test files that must kill it, and only those
 *   run for it. Run with MUTATE_CONCURRENCY=3 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');

const T_SB = 'test/cushionStandby.test.ts';
const T_SCOPE = 'test/runwayBasisContracts.test.ts';
const T_LEDGER = 'test/cushionStandbyLedger.test.ts';
const T_LEGACY = 'test/legacyIdentity.test.ts';

/** The sizing's cushion line, as written. */
const SIZING = "  const cushionKwh = standby?.basis === 'runway-overhead' ? round2(cushion.kwh + standby.kwh) : cushion.kwh;";
const HELPER_KWH = '  return { w: o.standby.w, kwh: (o.outageHours * o.standby.w) / 1000, basis: o.standby.basis };';
const PLAUSIBLE = "  if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > CUSHION_STANDBY_PLAUSIBLE_MAX_W + 1e-9) {";
/** The force-charge tick's own pool read (runForceChargeTick), where a second consumer would sit. */
const FC_POOL = '  const fullWh: number | null = sp?.backupFullCapWh ?? null;\n  const socNowPct: number | null = sp?.backupBatPercent ?? null;\n  const remainWh: number | null = sp?.backupRemainWh ?? null;\n  const socCoherent =\n';

const MUTANTS = [
  /* ── S: the standby ── */
  {
    id: 'S-i. ★★★ the safety factor multiplies the standby (15.29 kWh on the reference)',
    file: NCA, tests: [T_SB],
    find: HELPER_KWH,
    to: '  return { w: o.standby.w, kwh: (o.outageHours * o.standby.w * 1.25) / 1000, basis: o.standby.basis }; /* MUTANT */',
    why: 'k is a factor on the measured panel load (its CT scaling, its variability); the standby is not read from it.',
  },
  {
    id: 'S-ii. ★★★ the standby is divided by the discharge efficiency (15.09 kWh)',
    file: NCA, tests: [T_SB],
    find: HELPER_KWH,
    to: '  return { w: o.standby.w, kwh: (o.outageHours * o.standby.w) / 1000 / 0.94, basis: o.standby.basis }; /* MUTANT */',
    why: 'The figure is already pack-side (the intercept of the pack drain): ÷ η counts the conversion twice.',
  },
  {
    id: 'S-iii. ★★★ the runway\'s max() instead of the sum',
    file: NCA, tests: [T_SB],
    find: SIZING,
    to: "  const cushionKwh = standby?.basis === 'runway-overhead' ? Math.max(cushion.kwh, standby.kwh) : cushion.kwh; /* MUTANT */",
    why: 'The max() is a configuration guard, not physics: the standby would vanish into the load leg.',
  },
  {
    id: 'S-iv. ★★★ the standby is applied to the legacy-pct band',
    file: NCA, tests: [T_SB],
    find: "  if (o.cushionBasis !== 'islanded-outage' || o.standby == null) return null;",
    to: "  if (o.cushionBasis === 'disabled' || o.standby == null) return null; /* MUTANT */",
    why: 'The legacy band is a percent of the pool with no hours: the band moves, which the house rule forbids.',
  },
  {
    id: 'S-v. ★★★ a negative figure is accepted (it LOWERS the cushion)',
    file: NCA, tests: [T_SB],
    find: PLAUSIBLE,
    to: "  if (typeof w !== 'number' || !Number.isFinite(w) || w > CUSHION_STANDBY_PLAUSIBLE_MAX_W + 1e-9) { /* MUTANT */",
    why: 'A −1 W figure lowers the written reserve below v1.200.0\'s: the fail-safe direction inverted.',
  },
  {
    id: 'S-vi. ★★★ a NaN figure is accepted',
    file: NCA, tests: [T_SB],
    find: PLAUSIBLE,
    to: "  if (typeof w !== 'number' || w < 0 || w > CUSHION_STANDBY_PLAUSIBLE_MAX_W + 1e-9) { /* MUTANT */",
    why: 'A NaN cushion makes every comparison false: the v1.39.0 fail-open class.',
  },
  {
    id: 'S-vii. ★★★ a figure above 1500 W is accepted',
    file: NCA, tests: [T_SB],
    find: PLAUSIBLE,
    to: "  if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) { /* MUTANT */",
    why: 'No option can produce it: a bug that would turn every resilience night into a 50% write and a force-charge.',
  },
  {
    id: 'S-viii. ★★ the plausible maximum moves to 5000 W',
    file: NCA, tests: [T_SB],
    find: 'export const CUSHION_STANDBY_PLAUSIBLE_MAX_W = 1500;',
    to: 'export const CUSHION_STANDBY_PLAUSIBLE_MAX_W = 5000; /* MUTANT */',
    why: 'Above the options\' own clamps (floor 1500 W; 3 slots × 500 W): a figure the door cannot give is admitted.',
  },
  {
    id: 'S-ix. ★★ a figure that is no reading is not recorded',
    file: NCA, tests: [T_SB],
    find: "    return { w: 0, basis: 'implausible' };",
    to: '    return null; /* MUTANT */',
    why: 'A bad figure reads as "none passed": the ledger cannot tell a fault from a fresh install.',
  },
  {
    id: 'S-x. ★★★ the planner ignores the figure (the defect)',
    file: NCA, tests: [T_SB, T_SCOPE],
    find: '  const standbyW = plausibleStandbyW(inputs.cushionStandbyW);',
    to: '  const standbyW = plausibleStandbyW(null); /* MUTANT */',
    why: 'The cushion is short by the standby again: 13.94 kWh lasts 3.71 of 4 h at the load plus 270 W.',
  },
  {
    id: 'S-xi. ★★ the rationale clause on any figure (an implausible one prints "0 kWh of it the runway\'s 0 W")',
    file: NCA, tests: [T_SB, T_LEGACY],
    find: "  const standbyNote = standby != null && standby.basis === 'runway-overhead' && standby.w > 0",
    to: '  const standbyNote = standby != null /* MUTANT */',
    why: 'A figure that moved no number changes the text, and states a standby that was not counted.',
  },
  {
    id: 'S-xii. ★★★ the standby is added after the conversion (s skipped for the standby)',
    file: NCA, tests: [T_SB, T_SCOPE],
    find: '  const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh, cushionBasis, poolScale: inputs.cushionPoolScale });\n  const targetFloorKwh = cushionLine.kwh;\n',
    to: '  const cushionLine = cushionLineKwh({ reserveKwh, cushionKwh: cushion.kwh, cushionBasis, poolScale: inputs.cushionPoolScale });\n'
      + "  const targetFloorKwh = cushionLine.kwh + (standby?.basis === 'runway-overhead' ? standby.kwh : 0); /* MUTANT */\n",
    why: 'The standby is pack energy like the load leg: on the panel\'s percent it is a share of the measured capacity too (33.20 vs 33.26%).',
  },
  {
    id: 'S-xiii. ★★★ the standby is divided by the scale before the line divides it again (s twice)',
    file: NCA, tests: [T_SB, T_SCOPE],
    find: SIZING,
    to: "  const cushionKwh = standby?.basis === 'runway-overhead' ? round2(cushion.kwh + standby.kwh / (inputs.cushionPoolScale?.scale ?? 1)) : cushion.kwh; /* MUTANT */",
    why: 'The §3.5 tripwire: line = floor + 100 · cushion ÷ (pool · s) with the standby divided once (33.34 vs 33.26%).',
  },
  {
    id: 'S-xiv. ★★★ the configured hours are ignored for the standby (4 h always)',
    file: NCA, tests: [T_SB],
    find: '  const standby = cushionStandbyKwh({ cushionBasis: cushion.basis, outageHours: inputs.outageCushionHours ?? DEFAULT_OUTAGE_CUSHION_HOURS, standby: standbyW });',
    to: '  const standby = cushionStandbyKwh({ cushionBasis: cushion.basis, outageHours: DEFAULT_OUTAGE_CUSHION_HOURS, standby: standbyW }); /* MUTANT */',
    why: 'Survives every 4 h case (the reference plant included): an 8 h cushion counts 4 h of standby. Killed by the 8 h cases — the year\'s (S6 tripwire, S8 counts and figures) and the 8 h scenario\'s (S6 cost, S7, S10).',
  },
  {
    id: 'S-xv. ★★ the round2 of the sum is dropped',
    file: NCA, tests: [T_SB],
    find: SIZING,
    to: "  const cushionKwh = standby?.basis === 'runway-overhead' ? (cushion.kwh + standby.kwh) : cushion.kwh; /* MUTANT */",
    why: 'The row\'s cushion_kwh − cushion_standby_kwh no longer recovers the cushion without it; at a figure whose energy is not a whole hundredth (333.3 W) the lines move: killed by the figures file (cushionStandby.figures.json, set m333.3).',
  },

  /* ── A: agreement ── */
  {
    id: 'A-i. ★★★ the shortfall reads a second cushion without the standby',
    file: NCA, tests: [T_SB, T_SCOPE],
    find: '  const cushionShortfall = minProjKwh < targetFloorKwh - 1e-6;',
    to: '  const cushionShortfall = minProjKwh < cushionLineKwh({ reserveKwh, cushionKwh: cushion.kwh, cushionBasis, poolScale: inputs.cushionPoolScale }).kwh - 1e-6; /* MUTANT */',
    why: 'A charge-bound night that misses the new line says nothing: the shortfall is judged on the old one.',
  },
  {
    id: 'A-ii. ★★ the rationale clause is printed at 0 W',
    file: NCA, tests: [T_SB, T_LEGACY],
    find: "  const standbyNote = standby != null && standby.basis === 'runway-overhead' && standby.w > 0",
    to: "  const standbyNote = standby != null && standby.basis === 'runway-overhead' && standby.w >= 0 /* MUTANT */",
    why: 'Both overhead options at 0 W move no number, and the text must not move either.',
  },
  {
    id: 'A-iii. ★★★ the hold plan carries no standby key',
    file: NCA, tests: [T_SB, T_LEGACY],
    find: "      // v1.201.0 — the Cores' standby the cushion counted, only where a figure was passed (islanded-outage).\n      ...(standby != null ? { cushionStandby: standby } : {}),\n",
    to: '      /* MUTANT */\n',
    why: 'A hold night\'s cushion includes the standby but its plan (and its ledger row) says none was counted.',
  },

  /* ── B: the plumbing ── */
  {
    id: 'B-i. ★★★ buildNightChargeInputs drops the figure',
    file: NCA, tests: [T_SB],
    find: '    ...(cushionStandbyW !== undefined ? { cushionStandbyW } : {}),',
    to: '    ...(cushionStandbyW === undefined ? { cushionStandbyW } : {}), /* MUTANT */',
    why: 'The v1.125.0 destructure hazard: index.ts passes the figure and every plan leaves the standby out.',
  },

  /* ── D: the second door ── */
  {
    id: 'D-i. ★★★ the door sheds the floor (poolReported → false)',
    file: IDX, tests: [T_SB, T_SCOPE],
    find: '  return runwayPoolOverheadW(poolScale?.connectedCores ?? 0, poolReported);',
    to: '  return runwayPoolOverheadW(poolScale?.connectedCores ?? 0, false); /* MUTANT */',
    why: 'A tracker that threw, or a partial frame listing no source, counts 0 W: the cushion loses the standby the Cores still draw.',
  },
  {
    id: 'D-ii. ★★★ the door hard-codes 270 W',
    file: IDX, tests: [T_SB, T_SCOPE],
    find: '  return runwayPoolOverheadW(poolScale?.connectedCores ?? 0, poolReported);',
    to: '  return poolReported ? 270 : runwayPoolOverheadW(poolScale?.connectedCores ?? 0, poolReported); /* MUTANT */',
    why: 'A second source of truth for an option: a raised per-Core figure or a fourth Core never reaches the cushion.',
  },
  {
    id: 'D-iii. ★★★ the door counts the panel\'s slots, not the Cores the tracker counted',
    file: IDX, tests: [T_SB, T_SCOPE],
    find: '  return runwayPoolOverheadW(poolScale?.connectedCores ?? 0, poolReported);',
    to: '  return runwayPoolOverheadW(poolScale ? 3 : 0, poolReported); /* MUTANT */',
    why: 'At a per-Core figure above the floor the cushion counts Cores that are not connected (200 W: 600 for 1 Core).',
  },
  {
    id: 'D-iv. ★★★ the standby is taken from a second snapshot',
    file: IDX, tests: [T_SCOPE],
    find: '  const cushionStandbyW = cushionStandbyOverheadW(cushionPoolScale, fullWh > 0);',
    to: '  const cushionStandbyW = cushionStandbyOverheadW(findShp2(store.get().devices) ? cushionPoolScale : null, fullWh > 0); /* MUTANT */',
    why: 'The figure and the pool it is counted against no longer come from one reading of the fleet.',
  },
  {
    id: 'D-v. ★★★ the force-charge tick reaches the second door',
    file: IDX, tests: [T_SCOPE],
    find: FC_POOL,
    to: `  void cushionStandbyOverheadW(null, true); /* MUTANT */\n${FC_POOL}`,
    why: 'A second consumer of the runway\'s overhead outside the planner\'s one exception.',
  },
  {
    id: 'D-vi. ★★ the advisor names the runway\'s floor option',
    file: NCA, tests: [T_SCOPE],
    find: " *  clamp (0..1500 W), which is also the panel's three source slots at the per-Core option's upper clamp (500 W).",
    to: " *  clamp (RUNWAY_POOL_OVERHEAD_FLOOR_W, 0..1500 W), which is also the panel's three source slots at the per-Core option's upper clamp (500 W). MUTANT",
    why: 'The advisor reads nothing of the runway\'s basis, comments included: the next edit turns the name into a read.',
  },
  {
    id: 'D-vii. ★★★ laundering: a helper the planner calls reads the runway\'s overhead rule',
    file: IDX, tests: [T_SCOPE],
    find: '  if (!islandedLoadKwCache) return null;',
    to: '  if (!islandedLoadKwCache || runwayPoolOverheadW(0, false) > 0) return null; /* MUTANT */',
    why: 'The token check reads only the planner\'s own text: a helper it reaches carries the overhead past it.',
  },
  {
    id: 'D-viii. ★★★ the call counts the Cores by hwConnect',
    file: IDX, tests: [T_SB, T_SCOPE],
    find: '  const cushionStandbyW = cushionStandbyOverheadW(cushionPoolScale, fullWh > 0);',
    to: '  const cushionStandbyW = cushionStandbyOverheadW({ connectedCores: (sp.sources ?? []).filter((s: { hwConnect?: boolean } | null) => s?.hwConnect === true).length }, fullWh > 0); /* MUTANT */',
    why: 'Not the runway\'s count (sources[].isConnected): at 200 W per Core the cushion\'s figure and the runway\'s part.',
  },
  {
    id: 'D-ix. ★★ a shadow leg logs the standby',
    file: IDX, tests: [T_SCOPE],
    find: '  if (!shadowLeg && cushionStandbyW !== lastLoggedCushionStandbyW) {',
    to: '  if (cushionStandbyW !== lastLoggedCushionStandbyW) { /* MUTANT */',
    why: 'The shadow leg\'s "no calibration log" rule: its evaluations are not the live plan\'s.',
  },
  {
    id: 'D-x. ★★★ the standby never reaches the planner',
    file: IDX, tests: [T_SCOPE],
    find: "    // v1.201.0 — the Cores' standby draw the islanded-outage cushion counts (W; the runway's figure).\n    cushionStandbyW,\n",
    to: "    // v1.201.0 — the Cores' standby draw the islanded-outage cushion counts (W; the runway's figure).\n    ...((false as boolean) ? { cushionStandbyW } : {}), /* MUTANT */\n",
    why: 'The add-on keeps the cushion without the standby: the fix ships inert.',
  },

  /* ── R: the ledger ── */
  {
    id: 'R-i. ★★★ recordNightPlanRow writes the columns only with a standby',
    file: IDX, tests: [T_LEDGER, T_SCOPE],
    find: '    ...cushionStandbyLedgerColumns(plan),',
    to: '    ...(plan.cushionStandby ? cushionStandbyLedgerColumns(plan) : {}), /* MUTANT */',
    why: 'A re-issued plan with none keeps the earlier plan\'s standby beside its own cushion.',
  },
  {
    id: 'R-ii. ★★★ the columns are not in the ledger allowlist',
    file: REC, tests: [T_LEDGER],
    find: "  'cushion_standby_w', 'cushion_standby_basis', 'cushion_standby_kwh',\n",
    to: '  /* MUTANT */\n',
    why: 'The write is dropped silently: no row says what standby its cushion counted.',
  },
  {
    id: 'R-iii. ★★★ the columns are never added to a deployed ledger',
    file: REC, tests: [T_LEDGER],
    find: "    'cushion_standby_w REAL', 'cushion_standby_basis TEXT', 'cushion_standby_kwh REAL',",
    to: '    /* MUTANT */',
    why: 'Every plan write fails on the deployed database.',
  },
  {
    id: 'R-iv. ★★ the ledger helper drops the energy',
    file: NCA, tests: [T_SB],
    find: '    cushion_standby_kwh: plan.cushionStandby?.kwh ?? null,',
    to: '    cushion_standby_kwh: null, /* MUTANT */',
    why: 'The row cannot explain its own line step without the hours, which no column holds (critique R4).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-cushion-standby', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
