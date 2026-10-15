#!/usr/bin/env node
/**
 * mutate-charge-window.mjs — R2 (v1.189.0): the charge-cycle window chooser (chargeWindows.ts) —
 * which windows a cycle uses (the overnight cost leg, or a winter super off-peak cost leg with a
 * resilience-only overnight backup ahead of it), the 30 h scan that keeps the weekend overnight,
 * the October grace, the rate veto, the next chargeable open, the plan date a cycle belongs to, the
 * per-leg objective and force-charge, APS_PERIOD — and the index.ts wiring that keeps every live
 * plan on the overnight leg until the switch.
 *
 *   Scan and calendar   W-i..W-v
 *   Rate veto           W-vi..W-vii
 *   Legs                W-viii..W-xii
 *   Next chargeable     W-xiii..W-xvii
 *   Plan date           W-xviii..W-xix
 *   Per leg             W-xx..W-xxvi
 *   Period ids          W-xxvii
 *
 *   node scripts/mutate-charge-window.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CW = resolve(REPO, 'server/src/chargeWindows.ts');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const TAR = resolve(REPO, 'server/src/tariff.ts');
const SUBSET = [
  'test/chargeWindows.test.ts',
  'test/legacyIdentity.test.ts',
  'test/middayPlan.test.ts',
  'test/onPeakGuard.test.ts',
  'test/tariffHolidays.test.ts',
  'test/nightChargeAdvisor.test.ts',
];

const MUTANTS = [
  /* ── scan and calendar ── */
  {
    id: 'W-i. ★★★ the chooser scans 40 h',
    file: CW,
    find: 'export const CHARGE_CYCLE_SCAN_HOURS = 30;',
    to: 'export const CHARGE_CYCLE_SCAN_HOURS = 40; /* MUTANT */',
    why: 'Saturday evening finds Monday 10:00 and the weekend loses its overnight cycle.',
  },
  {
    id: 'W-ii. ★★★ no season grace',
    file: CW,
    find: "  if (seasonGraceActive(model, runStartMs, cfg.seasonGraceDays ?? SEASON_GRACE_DAYS)) return 'season-grace';",
    to: '  /* MUTANT */',
    why: 'October 1–7 buys at 10:00–15:00 while the bill still prices those hours on the summer cycle.',
  },
  {
    id: 'W-iii. ★★ the grace covers the first week of every winter month',
    file: CW,
    find: "  return seasonOf(prevMonth, model.summerMonths) === 'summer' && lp.day <= graceDays;",
    to: '  return lp.day <= graceDays; /* MUTANT */',
    why: 'The first week of November through March loses its mid-day buys.',
  },
  {
    id: 'W-iv. ★★ the grace is judged on the plan instant, not the run',
    file: CW,
    find: '  const veto = middayRunVeto(model, run.startMs, cfg);',
    to: '  const veto = middayRunVeto(model, nowMs, cfg); /* MUTANT */',
    why: 'September 30 (summer) plans an October 1 mid-day buy inside the grace.',
  },
  {
    id: 'W-v. ★★ the chooser does not walk back into a run in progress',
    file: CW,
    find: '  if (periodIdAt(h0) === cheapPeriodId) {\n    let s = h0;',
    to: '  if (false as boolean) { /* MUTANT */\n    let s = h0;',
    why: 'A recompute inside the window reports the next one; the leg loses its own window.',
  },

  /* ── the rate veto ── */
  {
    id: 'W-vi. ★★ equal rates do not veto',
    file: CW,
    find: '  return overnight != null && Number.isFinite(overnight) && sop.centsPerKwh >= overnight;',
    to: '  return overnight != null && Number.isFinite(overnight) && sop.centsPerKwh > overnight; /* MUTANT */',
    why: 'A mid-day buy that saves nothing displaces the overnight cycle.',
  },
  {
    id: 'W-vii. ★★★ no rate veto',
    file: CW,
    find: "  if (superOffPeakRateVeto(model, runStartMs)) return 'rate-veto';",
    to: '  /* MUTANT */',
    why: 'Confirmed rates that make the mid-day window dearer still move the buy there.',
  },

  /* ── the legs ── */
  {
    id: 'W-viii. ★★★ the backup need not end before the cost leg',
    file: CW,
    find: '  const backup: ChargeLeg | null = overnight && overnight.endMs <= run.startMs',
    to: '  const backup: ChargeLeg | null = overnight /* MUTANT */',
    why: "A 06:00 recompute arms tonight's 23:00 window as a backup ahead of this morning's leg.",
  },
  {
    id: 'W-ix. ★★ the cost leg is listed before the backup',
    file: CW,
    find: "  return { legs: backup ? [backup, cost] : [cost], cost, backup, why: 'midday' };",
    to: "  return { legs: backup ? [cost, backup] : [cost], cost, backup, why: 'midday' }; /* MUTANT */",
    why: 'Legs apply in order; the 10:00 leg would be promoted before the 23:00 one.',
  },
  {
    id: 'W-x. ★★★ the objective is not checked',
    file: CW,
    find: "  if (cfg.objective !== 'cost') return 'not-cost-objective';",
    to: '  /* MUTANT */',
    why: 'A resilience install is moved to a mid-day buy and an overnight backup.',
  },
  {
    id: 'W-xi. ★★ a 50% ceiling admits a mid-day leg',
    file: CW,
    find: "  if (!(Number.isFinite(cfg.costMaxSocPct) && cfg.costMaxSocPct > MIDDAY_MIN_COST_MAX_SOC_PCT)) return 'ceiling-at-reserve';",
    to: "  if (!(Number.isFinite(cfg.costMaxSocPct) && cfg.costMaxSocPct >= MIDDAY_MIN_COST_MAX_SOC_PCT)) return 'ceiling-at-reserve'; /* MUTANT */",
    why: 'With force-charge switched off the mid-day leg is a second reserve write that buys nothing more.',
  },
  {
    id: 'W-xii. ★★★ the configuration gate is skipped',
    file: CW,
    find: '  const gate = middayConfigGate(cfg);\n  if (gate != null) return overnightCycle(gate);',
    to: '  /* MUTANT */',
    why: 'The overnight cycle (every live plan) chooses mid-day windows.',
  },

  /* ── the next chargeable open ── */
  {
    id: 'W-xiii. ★★★ the overnight cycle counts mid-day runs as recharges',
    file: CW,
    find: '  if (middayConfigGate(cfg) != null) return overnightMs;',
    to: '  /* MUTANT */',
    why: "Every live plan's horizon ends at the next 10:00 and the overnight carry shrinks to a morning.",
  },
  {
    id: 'W-xiv. ★★★ a vetoed run counts as a recharge',
    file: CW,
    find: '    if (middayRunVeto(model, run.startMs, cfg) == null) { middayMs = run.startMs; break; }',
    to: '    if (true as boolean) { middayMs = run.startMs; break; } /* MUTANT */',
    why: 'An October-grace run ends the horizon at a window that will not charge.',
  },
  {
    id: 'W-xv. ★★ the scan stops at the first vetoed run',
    file: CW,
    find: '    from = run.endMs;',
    to: '    break; /* MUTANT */',
    why: 'A vetoed run hides the chargeable one after it.',
  },
  {
    id: 'W-xvi. ★★★ the overnight open is ignored once a mid-day run is found',
    file: CW,
    find: '  return middayMs == null ? overnightMs : Math.min(overnightMs, middayMs);',
    to: '  return middayMs == null ? overnightMs : middayMs; /* MUTANT */',
    why: 'The span after a mid-day window runs to tomorrow 10:00 instead of tonight 23:00.',
  },
  {
    id: 'W-xvii. ★★★ the next-chargeable scan is 30 h',
    file: CW,
    find: 'export const NEXT_CHARGEABLE_SCAN_HOURS = 96;',
    to: 'export const NEXT_CHARGEABLE_SCAN_HOURS = 30; /* MUTANT */',
    why: "A Thursday plan's horizon (Friday 05:00 → Monday 00:00) has no end; the weekend carry is lost.",
  },

  /* ── the plan date ── */
  {
    id: 'W-xviii. ★★★ a cycle always belongs to today',
    file: CW,
    find: '  return o.firstLegStartMs < planTimeTodayMs ? localParts(o.nowMs - DAY_MS, o.timezone).ymd : today;',
    to: '  return today; /* MUTANT */',
    why: "The 06:00 recompute of last evening's mid-day leg is keyed to a new day.",
  },
  {
    id: "W-xix. ★★ before the plan time every cycle is yesterday's",
    file: CW,
    find: '  return o.firstLegStartMs < planTimeTodayMs ? localParts(o.nowMs - DAY_MS, o.timezone).ymd : today;',
    to: '  return localParts(o.nowMs - DAY_MS, o.timezone).ymd; /* MUTANT */',
    why: "A 16:00 recompute of tonight's cycle is filed under yesterday.",
  },

  /* ── per leg ── */
  {
    id: 'W-xx. ★★★ the backup leg may force-charge',
    file: CW,
    find: "  return role !== 'backup' && enabled;",
    to: '  return enabled; /* MUTANT */',
    why: 'The outage backup buys the cost fill overnight, ahead of the mid-day buy.',
  },
  {
    id: 'W-xxi. ★★★ the backup leg keeps the cost objective',
    file: CW,
    find: "  return role === 'backup' ? 'resilience' : configured;",
    to: '  return configured; /* MUTANT */',
    why: 'The backup sizes a cost buy, not the cushion it exists for.',
  },
  {
    id: "W-xxii. ★★ index.ts's force-charge gate ignores the leg",
    file: IDX,
    find: "const forceChargeOn = (role: ChargeLegRole = 'cost'): boolean => legForceChargeEligible(role, forceChargeEnabled({",
    to: "const forceChargeOn = (role: ChargeLegRole = 'cost'): boolean => ((_r: ChargeLegRole, e: boolean) => e)(role, forceChargeEnabled({ /* MUTANT */",
    why: 'A backup leg armed from index.ts would ride a force-charge.',
  },
  {
    id: "W-xxiii. ★★ index.ts's objective ignores the leg",
    file: IDX,
    find: "  const objectiveMode = legObjective(legRole, (process.env.ARB_OBJECTIVE ?? 'resilience').toLowerCase() === 'cost'",
    to: "  const objectiveMode = ((_r: ChargeLegRole, c: 'cost' | 'resilience') => c) /* MUTANT */(legRole, (process.env.ARB_OBJECTIVE ?? 'resilience').toLowerCase() === 'cost'",
    why: 'A backup leg planned by index.ts sizes a cost buy.',
  },
  {
    id: "W-xxiv. ★★★ index.ts's horizon ends at a mid-day window before the switch",
    file: IDX,
    find: '  const nextRechargeMs: number | null = nextChargeableOpenMs(tariffModel, windowEndMs + HOUR_MS);',
    to: "  const nextRechargeMs: number | null = nextChargeableOpenMs(tariffModel, windowEndMs + HOUR_MS, { costWindow: 'super_off_peak', objective: 'cost', costMaxSocPct: 90 }); /* MUTANT */",
    why: 'A live change in a release that must change nothing: the overnight carry ends at 10:00.',
  },
  {
    id: 'W-xxv. ★★★ buildNightChargeInputs keeps the configured objective on a backup leg',
    file: NCA,
    find: '    objectiveMode: legObjective(legRole, objectiveMode),',
    to: '    objectiveMode, /* MUTANT */',
    why: 'The engine sizes the backup as a cost buy.',
  },
  {
    id: 'W-xxvi. ★★ buildNightChargeInputs ignores the pinned window',
    file: NCA,
    find: '  const window = windowSpec?.window !== undefined\n',
    to: '  const window = windowSpec?.window !== undefined && (false as boolean) /* MUTANT */\n',
    why: 'The mid-day leg is sized on the overnight window the resolver finds.',
  },

  /* ── the period ids ── */
  {
    id: 'W-xxvii. ★ a period id drifts from the tariff\'s',
    file: TAR,
    find: "  SUPER_OFF_PEAK: 'super_off_peak',",
    to: "  SUPER_OFF_PEAK: 'super_offpeak', /* MUTANT */",
    why: 'The snapshot, the /api/tariff view and every consumer name a period the plan does not.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-charge-window', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
