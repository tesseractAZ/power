#!/usr/bin/env node
/**
 * mutate-line-force-charge.mjs — committed harness for v1.200.0, an outage-cushion line above the panel's
 * 50% reserve carried by the night force-charge to the window close, or disclosed.
 *
 * (P) THE PLAN (nightChargeAdvisor.ts): which charge plans qualify (islanded-outage, not economic-only,
 * ⌈L⌉ above the reserve maximum, askOf the one expression); carried where the line force-charge is
 * eligible and ⌈L⌉ + 10 ≤ 100, disclosed otherwise (never on the backup leg); absent eligibility is
 * today's plan byte for byte; the envelope OR-ed in after the cost block; the envelope sentence whenever
 * it applies. Mutants P-i..ix.
 *
 * (A) THE RECORD (nightChargeActuator.ts, chargeCycle.ts): the line's ask in its own field, on its own
 * gate; rides = cost or line; the backup leg never carries it. Mutants A-i..iv.
 *
 * (F) THE TICK (nightForceCharge.ts, index.ts): the mode composed from the LIVE gates; the start timed to
 * ⌈L⌉ + 5 at the close less 20 min; no software stop; "already there" at the panel ceiling; the panel
 * ceiling ⌈L⌉ + 10; cost-dominant only at ⌈L⌉ + 10; the synced ceiling in the own-write list. F-i..x.
 *
 * (M) THE MORNING REFRESH never lowers or drops the line. M-i, M-ii.
 * (T) THE TEXTS: cause-keyed notes, one level everywhere, the line sentence only in line mode, the spoken
 * clause, the ON-failure sentence, the declined-start push. T-i..vii.
 * (G) THE GATE: a carried night under its line is a strike. G-i.
 * (R) THE LEDGER: the plan columns written unconditionally. R-i, R-ii.
 *
 *   node scripts/mutate-line-force-charge.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does not is
 *   reported INVALID and fails the run); each mutant names the test files that must kill it, and only
 *   those run for it. Run with MUTATE_CONCURRENCY=2 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const NFC = resolve(REPO, 'server/src/nightForceCharge.ts');
const ACT = resolve(REPO, 'server/src/nightChargeActuator.ts');
const CYC = resolve(REPO, 'server/src/chargeCycle.ts');
const MRF = resolve(REPO, 'server/src/morningRefresh.ts');
const NTF = resolve(REPO, 'server/src/notify.ts');
const GATE = resolve(REPO, 'server/src/nightChargeGate.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const CARD = resolve(REPO, 'web/src/cards/nightChargeText.ts');

const T_LINE = 'test/lineForceCharge.test.ts';
const T_CLOSE = 'test/lineForceChargeClose.test.ts';
const T_GOLDEN = 'test/legacyIdentity.test.ts';

const MUTANTS = [
  /* ── P: the plan ── */
  {
    id: 'P-i. ★★★ qualify on >= the reserve maximum (a line asked at 50 is "carried")',
    file: NCA, tests: [T_LINE],
    find: "  const lineQualifies = cushionBasis === 'islanded-outage' && chargeTonight && !baselineHolds && lineAsk > RESERVE_WRITE_MAX_PCT;",
    to: "  const lineQualifies = cushionBasis === 'islanded-outage' && chargeTonight && !baselineHolds && lineAsk >= RESERVE_WRITE_MAX_PCT; /* MUTANT */",
    why: 'A 49.97% line asks 50, which the reserve holds: a force-charge (and Charge Now in an outage) for nothing.',
  },
  {
    id: 'P-ii. ★★★ an economic-only night qualifies (drop !baselineHolds)',
    file: NCA, tests: [T_LINE],
    find: "  const lineQualifies = cushionBasis === 'islanded-outage' && chargeTonight && !baselineHolds && lineAsk > RESERVE_WRITE_MAX_PCT;",
    to: "  const lineQualifies = cushionBasis === 'islanded-outage' && chargeTonight && lineAsk > RESERVE_WRITE_MAX_PCT; /* MUTANT */",
    why: 'The pack already holds the line with no buy: the line force-charge has no resilience job there.',
  },
  {
    id: 'P-iii. ★★★ not eligible ⇒ no disclosure (the defect: a 50% write claims the cushion)',
    file: NCA, tests: [T_LINE],
    find: '  const lineDisclosed = lineQualifies && lineEligible !== undefined && !lineCarried;',
    to: '  const lineDisclosed = lineQualifies && lineEligible === true && !lineCarried; /* MUTANT */',
    why: 'Advisory mode and the backup leg claim hold with a 50% write: a realized strike, an unheld cushion.',
  },
  {
    id: 'P-iv. ★★★ the envelope OR-ed in before the cost block (the de-bias bound reads it)',
    file: NCA, tests: [T_LINE],
    find: '    debiasedKwh: cushionShortfall ? null',
    to: "    debiasedKwh: (cushionShortfall || (cushionBasis === 'islanded-outage' && !baselineHolds && askOf(targetFloorKwh, fullKwh) > RESERVE_WRITE_MAX_PCT && inputs.lineForceChargeEligible === false)) ? null /* MUTANT */",
    why: 'A disclosure moves the cost ceiling: a sizing figure moves (I-A1).',
  },
  {
    id: 'P-v. ★★★ the ask is round(L), a second expression',
    file: NCA, tests: [T_LINE],
    find: '  const lineAsk = askOf(targetFloorKwh, fullKwh);',
    to: '  const lineAsk = Math.round((targetFloorKwh / fullKwh) * 100); /* MUTANT */',
    why: 'A 54.12% line asks 54, under the line; a 50.45% line asks 50 and is neither carried nor disclosed.',
  },
  {
    id: 'P-vi. ★★★ absent eligibility treated as false (every caller before v1.200.0 discloses)',
    file: NCA, tests: [T_LINE, T_GOLDEN],
    find: '  const lineEligible = backupLeg && inputs.lineForceChargeEligible !== undefined ? false : inputs.lineForceChargeEligible;',
    to: '  const lineEligible = backupLeg && inputs.lineForceChargeEligible !== undefined ? false : (inputs.lineForceChargeEligible ?? false); /* MUTANT */',
    why: 'The fail-safe direction inverted: absent input must be today\'s plan byte for byte (the golden).',
  },
  {
    id: 'P-vii. ★★★ the backup leg gets the field',
    file: NCA, tests: [T_LINE],
    find: '  const lineEligible = backupLeg && inputs.lineForceChargeEligible !== undefined ? false : inputs.lineForceChargeEligible;',
    to: '  const lineEligible = inputs.lineForceChargeEligible; /* MUTANT */',
    why: 'The backup leg writes the reserve only; claiming a force-charge there hides an unheld cushion.',
  },
  {
    id: 'P-viii. ★★★ a line within 10 points of full is carried (not disclosed)',
    file: NCA, tests: [T_LINE],
    find: '  const lineTooHigh = lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT > 100;',
    to: '  const lineTooHigh = false; /* MUTANT */',
    why: 'No headroom for the panel ceiling over the line: the claim cannot be met, and is not disclosed.',
  },
  {
    id: 'P-ix. ★★★ the envelope sentence gated on setpoint > target (2026-10-29 silent again)',
    file: NCA, tests: [T_LINE],
    find: '  const envelopeNote: string | null = lineDisclosed',
    to: '  const envelopeNote: string | null = !(setpointSocPct > targetSocPct + 0.05) ? null : lineDisclosed /* MUTANT */',
    why: 'On a night whose setpoint equals its arrival the rationale says nothing of the 50% write.',
  },

  /* ── A: the record ── */
  {
    id: 'A-i. ★★★ one stored target max(cost, ask) in forceChargeCeilingPct',
    file: ACT, tests: [T_LINE],
    find: '    windowEndMs: plan.window.endMs,\n    forceChargeCeilingPct: ceiling,',
    to: '    windowEndMs: plan.window.endMs,\n    forceChargeCeilingPct: lineAsk != null && (ceiling == null || lineAsk > ceiling) ? lineAsk : ceiling, /* MUTANT */',
    why: 'The cost ceiling outlives its kill switch, and a restart can drive a line night to the cost ceiling (R4).',
  },
  {
    id: 'A-ii. ★★★ the line is recorded whatever its gate',
    file: ACT, tests: [T_LINE],
    find: '  const lineAsk = lineForceChargeEnabled === true && plan.forceChargeLine != null ? coerceLineAskPct(plan.forceChargeLine.askPct) : null;',
    to: '  const lineAsk = plan.forceChargeLine != null ? coerceLineAskPct(plan.forceChargeLine.askPct) : null; /* MUTANT */',
    why: 'Advisory mode records a line: rides is stamped true on a night nothing will force-charge.',
  },
  {
    id: 'A-iii. ★★★ the backup leg keeps the line and its gate (both guards removed)',
    file: CYC, tests: [T_LINE],
    find: '    const plan: ArmablePlan = backup ? { ...c.plan, costCeilingSocPct: null, forceChargeLine: null } : c.plan;\n    const fc = backup ? false : c.forceChargeEnabled;\n    const lineFc = backup ? false : c.lineForceChargeEnabled;',
    to: '    const plan: ArmablePlan = backup ? { ...c.plan, costCeilingSocPct: null } : c.plan;\n    const fc = backup ? false : c.forceChargeEnabled;\n    const lineFc = c.lineForceChargeEnabled; /* MUTANT */',
    why: 'A reserve-only backup leg force-charges (each guard alone is covered by the other: defence in depth).',
  },
  {
    id: 'A-iv. ★★★ forceChargeRides ignores the line',
    file: ACT, tests: [T_LINE],
    find: '    forceChargeRides: forceChargeEnabled === undefined ? (lineRides ? true : null) : costRides || lineRides,',
    to: '    forceChargeRides: forceChargeEnabled === undefined ? null : costRides, /* MUTANT */',
    why: 'A line night reads "reserve only" in the morning push and its never-started outcome is lost.',
  },

  /* ── F: the tick ── */
  {
    id: 'F-i. ★★★ a software stop at ⌈L⌉ in line mode (the hold without its drain allowance)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: "  ) return 'target';\n  return null;\n}",
    to: "  ) return 'target';\n  { const m = forceChargeModeOf(s, gates); if (m?.kind === 'line' && o.poolSocPct != null && o.poolSocPct >= m.askPct) return 'target'; } /* MUTANT */\n  return null;\n}",
    why: 'A 7 kW EV plugging in 30 min before the close takes the pool back under the line on 200 of 200 nights.',
  },
  {
    id: 'F-ii. ★★★ the line start counted from the close (no FORCE_CHARGE_MIN_RUN_MS lead)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: '  return forceChargeStartAtMs(writeEndMs - FORCE_CHARGE_MIN_RUN_MS, startTargetPct, poolSocPct, tickPoolKwh, rateKw, evDisplacedKwh, slotCount);',
    to: '  return forceChargeStartAtMs(writeEndMs, startTargetPct, poolSocPct, tickPoolKwh, rateKw, evDisplacedKwh, slotCount); /* MUTANT */',
    why: 'A small lift is timed into the dead zone (the last 20 min) and never starts.',
  },
  {
    id: 'F-iii. ★★★ the start timed to the target alone (no + H)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: Math.max(t, ask! + H),",
    to: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: t, /* MUTANT */",
    why: 'An EV 60-90 min out, or a slow pack, arrives short of the line (17/200, 5/200, 5/50 nights).',
  },
  {
    id: 'F-iv. ★★★ "already there" against the target, not the panel ceiling',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: '    if (o.poolSocPct >= mode.panelCeilingPct) {',
    to: '    if (o.poolSocPct >= forceChargeStopPct(mode.targetPct)) { /* MUTANT */',
    why: 'A pool above the line at the open never gets its final segment ON: a late load takes it under.',
  },
  {
    id: 'F-v. ★★★ the panel ceiling at ⌈L⌉ + H',
    file: NFC, tests: [T_LINE],
    find: '      panelCeilingPct: desiredForceChargeCeilingPct(Math.max(t, ask! + 2 * H)),',
    to: '      panelCeilingPct: desiredForceChargeCeilingPct(Math.max(t, ask! + H)), /* MUTANT */',
    why: 'A high ask meets the panel ceiling at its own start target: the panel stops importing short of it.',
  },
  {
    id: 'F-vi. ★★★ cost-dominant at >= ⌈L⌉ (not ⌈L⌉ + 10)',
    file: NFC, tests: [T_LINE],
    find: '  if (lineOk && !(costOk && forceChargeStopPct(c!) >= ask! + 2 * H)) {',
    to: '  if (lineOk && !(costOk && forceChargeStopPct(c!) >= ask!)) { /* MUTANT */',
    why: 'A cost stop just above the line stops early and the house draws the pool under it before the close.',
  },
  {
    id: 'F-vii(a). ★★★ the tick reads the cost gate only (gatesOf drops the line)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: "  return { cost: o.enabled, line: o.lineEnabled === true };",
    to: "  return { cost: o.enabled, line: false }; /* MUTANT */",
    why: 'A resilience night never force-charges its line: the defect.',
  },
  {
    id: 'F-vii(b). ★★★ index.ts does not pass the line gate to the tick',
    file: IDX, tests: [T_LINE],
    find: '    lineEnabled: !opts.forceDisabled && lineForceChargeOn(legRoleOf(state)),',
    to: '    lineEnabled: false, /* MUTANT */',
    why: 'The same defect at the wiring.',
  },
  {
    id: 'F-viii(a). ★★★ the OFF reads the arm stamp, not the live gates',
    file: NFC, tests: [T_LINE],
    find: "  const gates = gatesOf(o);\n  if (!anyForceChargeGate(s, gates)) return 'disabled';",
    to: "  const gates = { cost: o.enabled || s.forceChargeRides === true, line: o.lineEnabled === true || s.forceChargeRides === true }; /* MUTANT */\n  if (!anyForceChargeGate(s, gates)) return 'disabled';",
    why: 'Advisory mode set mid-night does not stop a running force-charge.',
  },
  {
    id: 'F-viii(b). ★★★ the ON reads the arm stamp, not the live gates',
    file: NFC, tests: [T_LINE],
    find: "  const gates = gatesOf(o);\n  if (!anyForceChargeGate(s, gates)) {",
    to: "  const gates = { cost: o.enabled || s.forceChargeRides === true, line: o.lineEnabled === true }; /* MUTANT */\n  if (!anyForceChargeGate(s, gates)) {",
    why: 'With ARB_COST_MAX_SOC_PCT set to 50 and a restart, a line night still drives to the cost ceiling.',
  },
  {
    id: 'F-ix. ★★★ the own-write list names desired(cost), not the ceiling the sync wrote',
    file: NFC, tests: [T_LINE],
    find: '  const synced = syncedCeilingPct(s);\n  if (s.forceChargeCeilingAttemptedAtMs != null && synced != null) ceilingPcts.push(synced);',
    to: '  const synced = s.forceChargeCeilingPct != null && Number.isFinite(s.forceChargeCeilingPct) ? desiredForceChargeCeilingPct(s.forceChargeCeilingPct) : null; /* MUTANT */\n  if (s.forceChargeCeilingAttemptedAtMs != null && synced != null) ceilingPcts.push(synced);',
    why: 'Settings drift reports our own 88% line-night ceiling as a foreign change.',
  },
  {
    id: 'F-x. ★★★ a "target" OFF in line mode',
    file: NFC, tests: [T_LINE],
    find: "    forceChargeModeOf(s, gates)?.kind !== 'line'\n    && o.poolSocPct != null && s.forceChargeCeilingPct != null",
    to: "    o.poolSocPct != null && s.forceChargeCeilingPct != null /* MUTANT */",
    why: 'A cost ceiling under ⌈L⌉ + 10 stops the line night at the cost stop, before the close.',
  },

  /* ── M: the morning refresh ── */
  {
    id: 'M-i. ★★ the refresh nulls the line ask',
    file: MRF, tests: [T_LINE],
    find: '    forceChargeLineAskPct: leg.forceChargeLineAskPct,\n  };',
    to: '    forceChargeLineAskPct: null, /* MUTANT */\n  };',
    why: 'A lowered cost ceiling drops the line force-charge while the plan claims the cushion (R1).',
  },
  {
    id: 'M-ii. ★★ the refresh lowers the line ask to the re-plan\'s',
    file: MRF, tests: [T_LINE],
    find: '    forceChargeLineAskPct: leg.forceChargeLineAskPct,\n  };',
    to: '    forceChargeLineAskPct: o.neededLineAskPct != null && leg.forceChargeLineAskPct != null ? Math.min(leg.forceChargeLineAskPct, o.neededLineAskPct) : leg.forceChargeLineAskPct, /* MUTANT */\n  };',
    why: 'The armed line is lowered by a morning re-plan the evening never announced.',
  },

  /* ── T: the texts ── */
  {
    id: 'T-i. ★★ the caps note on an envelope-only plan',
    file: NTF, tests: [T_LINE],
    find: "function sizingShortfall(plan: Pick<NightChargePlan, 'cushionShortfall' | 'cushionShortfallCause'>): boolean {\n  return plan.cushionShortfall === true && plan.cushionShortfallCause !== 'envelope';",
    to: "function sizingShortfall(plan: Pick<NightChargePlan, 'cushionShortfall' | 'cushionShortfallCause'>): boolean {\n  return plan.cushionShortfall === true; /* MUTANT */",
    why: 'An advisory night is told charge/pool caps are the reason — a false cause.',
  },
  {
    id: 'T-ii. ★★ level parity broken (the clause names the line, not the expected close)',
    file: NTF, tests: [T_LINE],
    find: '      + `taking the pool ${to} ${levelText}; the panel\'s ${l.panelCeilingPct}% force-charge ceiling is the backstop. `',
    to: '      + `taking the pool ${to} ~${round1(l.linePct)}%; the panel\'s ${l.panelCeilingPct}% force-charge ceiling is the backstop. ` /* MUTANT */',
    why: 'The title says ~78% and the clause ~55.6%: two outcomes in one push.',
  },
  {
    id: 'T-iii(a). ★★ the card\'s line sentence on a cost-dominant night',
    file: CARD, tests: [T_LINE],
    find: "  if (plan.expectedForceChargeMode === 'line' && plan.forceChargeLine != null) {",
    to: '  if (plan.forceChargeLine != null) { /* MUTANT */',
    why: 'A 95% cost charge is explained by a line it does not run for (R6d).',
  },
  {
    id: 'T-iii(b). ★★ the rationale\'s line sentence on a cost-dominant night',
    file: NCA, tests: [T_LINE],
    find: "    : expected.mode === 'line'",
    to: '    : forceChargeLine != null /* MUTANT */',
    why: 'The same in the rationale.',
  },
  {
    id: 'T-iv(a). ★★ the spoken reserve clause missing',
    file: ACT, tests: [T_LINE],
    find: '  const r = o.reserveOnlyPct;',
    to: '  const r = null as number | null; /* MUTANT */',
    why: 'The speakers say "charging to about 78 percent" with nothing of the panel\'s 50% reserve.',
  },
  {
    id: 'T-iv(b). ★★ the spoken clause beside the shortfall or "toward"',
    file: ACT, tests: [T_LINE],
    find: '  if (r != null && Number.isFinite(r) && !o.cushionShortfall && !toward) {',
    to: '  if (r != null && Number.isFinite(r)) { /* MUTANT */',
    why: 'Three clauses on the long shapes: the notice nears the 560-character bound and says less.',
  },
  {
    id: 'T-v. ★★ the ON-failure line sentence missing',
    file: NTF, tests: [T_LINE],
    find: "        ? ` Without it the pool will close the window near the ${RESERVE_WRITE_MAX_PCT}% reserve, under tonight's ${round1(o.lineLinePct)}% outage line.` : ''),",
    to: "        ? '' : ''), /* MUTANT */",
    why: 'A failed ON on a line night reads as a lost economic buy, not an unheld outage cushion.',
  },
  {
    id: 'T-vi. ★★ the declined-start push only on a refused ceiling (late or never for the rest)',
    file: NFC, tests: [T_LINE],
    find: '  return Object.values(FORCE_CHARGE_BLOCKER_WHY).some((w) => why.startsWith(w));',
    to: '  return why.startsWith(FORCE_CHARGE_BLOCKER_WHY.ceilingRefused); /* MUTANT */',
    why: 'An unknown grid or an operator\'s Charge Now holds the line\'s start in silence until the close.',
  },
  {
    id: 'T-vii. ★★ the advisory push keeps the caps note on an envelope-only plan (no envelope note)',
    file: NTF, tests: [T_LINE],
    find: '  if (plan.cushionShortfallCause == null) return \'\';',
    to: '  if (plan.cushionShortfallCause == null || plan.cushionShortfallCause != null) return \'\'; /* MUTANT */',
    why: 'The advisory push says nothing of why the cushion is not held.',
  },

  /* ── G: the gate ── */
  {
    id: 'G-i. ★★ the gate exempts carried rows',
    file: GATE, tests: [T_LINE],
    find: '    if (truthy(r.cushion_shortfall)) return false; // disclosed — physics, not fault',
    to: '    if (truthy(r.cushion_shortfall) || asNum(r.cushion_line_force_charge_pct) != null) return false; /* MUTANT */',
    why: 'A line night that closed under its line is never a strike: AUTO graduates on unheld cushions.',
  },

  /* ── R: the ledger ── */
  {
    id: 'R-i. ★★ the plan columns written only when the plan carries a line',
    file: IDX, tests: [T_LINE],
    find: '    ...lineForceChargeLedgerColumns(plan),',
    to: '    ...(plan.forceChargeLine != null ? lineForceChargeLedgerColumns(plan) : {}), /* MUTANT */',
    why: 'A re-issued plan leaves an earlier plan\'s ask beside its own.',
  },
  {
    id: 'R-ii. ★★ the envelope column NULL (not 0) on a plan that did not disclose',
    file: NCA, tests: [T_LINE],
    find: '    cushion_envelope_shortfall: plan.cushionShortfallCause != null ? 1 : 0,',
    to: '    cushion_envelope_shortfall: plan.cushionShortfallCause != null ? 1 : null, /* MUTANT */',
    why: '"not disclosed" and "unknown" read alike in the ledger.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-line-force-charge', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
