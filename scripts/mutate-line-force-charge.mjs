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
 * (review) THE PANEL'S LATCH: at its ceiling the panel switches a slot OFF and leaves it OFF, so a line night whose
 * pool falls back under ⌈L⌉ + 5 is switched back on (lineReOnDue, ≤ 2 a night, under the start's gates, outside
 * the last 20 min), the expected walk drains after the ceiling, the ON stamps the ceiling it read back, and a
 * stale cost ceiling is lowered in line mode. F-xi..xxi. THE WIRING of the line-night surfaces (the ON's mode
 * stamp, the evening push's line, the morning close). W-i..v.
 *
 * (M) THE MORNING REFRESH never lowers or drops the line. M-i, M-ii.
 * (T) THE TEXTS: cause-keyed notes, one level everywhere, the line sentence only in line mode, the spoken
 * clause, the ON-failure sentence, the declined-start push. T-i..vii. (review) the ON failure's line words
 * (all slots / some), the declined start per blocker class once it persists and its latest start, the
 * morning account of an early OFF, the envelope note by its reason, a line night not expected to start.
 * T-v(b), T-viii..xviii. (P) also the min-buy hold, the 90/91 edge, the one ask, the reason. P-x..xii.
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

  {
    id: 'P-x. ★★★ a minimum-buy hold qualifies (drop chargeTonight)',
    file: NCA, tests: [T_LINE],
    find: "  const lineQualifies = cushionBasis === 'islanded-outage' && chargeTonight && !baselineHolds && lineAsk > RESERVE_WRITE_MAX_PCT;",
    to: "  const lineQualifies = cushionBasis === 'islanded-outage' && !baselineHolds && lineAsk > RESERVE_WRITE_MAX_PCT; /* MUTANT */",
    why: 'A hold arms nothing, yet carries a line (forceChargeLine) or discloses one it was never going to write.',
  },
  {
    id: 'P-xi. ★★★ the headroom edge off by one (an ask of 90 disclosed)',
    file: NCA, tests: [T_LINE],
    find: '  const lineTooHigh = lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT > 100;',
    to: '  const lineTooHigh = lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT >= 100; /* MUTANT */',
    why: 'A 89.9% line whose 100% panel ceiling fits is disclosed as unheld instead of carried.',
  },
  {
    id: 'P-v(b). ★★★ the reserve path\'s ask a second expression (round, not askOf)',
    file: NCA, tests: [T_LINE, T_GOLDEN],
    find: '  const lineAskPct = !setpointOnWalk && !baselineHolds ? askOf(targetFloorKwh, fullKwh) : 0;',
    to: '  const lineAskPct = !setpointOnWalk && !baselineHolds ? Math.min(100, Math.round((targetFloorKwh / fullKwh) * 100)) : 0; /* MUTANT */',
    why: 'The setpoint and the force-charge ask drift apart: a 54.12% line writes toward 54 while the force-charge carries 55.',
  },
  {
    id: 'P-xii. ★★ the envelope reason always "advisory" (a too-high line with a riding cost force-charge told none rides)',
    file: NCA, tests: [T_LINE],
    find: "    : backupLeg ? 'backupLeg' : lineTooHigh && lineEligible === true ? 'tooHigh' : 'advisory';",
    to: "    : 'advisory' as CushionEnvelopeReason; /* MUTANT */",
    why: 'A 92% line on a night charging to ~100% reads "no force-charge runs in advisory mode".',
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

  {
    id: 'F-xi. ★★★ no line re-ON (the panel\'s latch at its ceiling is final)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: '    return lineReOnDue(s, nowMs, o, ours) ?? verify;',
    to: '    return verify; /* MUTANT */',
    why: 'A predicted EV starts the night early, the pool latches at 80% hours out, and the real EV draws it under the line (up to 65 of 200 year nights).',
  },
  {
    id: 'F-xii. ★★★ one re-ON a night',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: 'export const FORCE_CHARGE_LINE_REON_MAX = 2;',
    to: 'export const FORCE_CHARGE_LINE_REON_MAX = 1; /* MUTANT */',
    why: 'A second latch on a long high-ask night (a 36 kWh EV predicted, 11.52 kW from 90 min) closes 19 of 140 under.',
  },
  {
    id: 'F-xiii. ★★★ the re-ON waits for the ask, not the start target',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: '  if (o.poolSocPct >= mode.startTargetPct) return null;',
    to: '  if (o.poolSocPct >= mode.askPct) return null; /* MUTANT */',
    why: 'The re-ON comes with no lead: an ON delay and a late load close under the line.',
  },
  {
    id: 'F-xiv. ★★★ a re-ON inside the last 20 min (shares the slots\' cooldown with the close\'s OFF)',
    file: NFC, tests: [T_LINE],
    find: '  if (s.windowEndMs == null || nowMs >= writeWindowEndMs(s)! - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) return null;',
    to: '  if (s.windowEndMs == null) return null; /* MUTANT */',
    why: 'The window-end OFF comes back rate-limited and the slot grid-charges past the close (v1.186.0).',
  },
  {
    id: 'F-xv. ★★★ the re-ON without the start\'s grid and vitals gates',
    file: NFC, tests: [T_LINE],
    find: '  if (o.vitalsRed || !o.socCoherent || o.gridPresent !== true || o.gridStaLost) return null;',
    to: '  if (!o.socCoherent) return null; /* MUTANT */',
    why: 'A grid charge is written with the grid unknown, or from a struggling host.',
  },
  {
    id: 'F-xvi. ★★★ the re-ON before the ON verified (over a failed ON)',
    file: NFC, tests: [T_LINE],
    find: '  if (s.forceChargeOnAtMs == null || s.forceChargeOffAtMs != null || s.forceChargeOnVerifiedAtMs == null) return null;',
    to: '  if (s.forceChargeOnAtMs == null || s.forceChargeOffAtMs != null) return null; /* MUTANT */',
    why: 'An ON the panel never took, already warned about, is re-written outside the ON verify\'s one re-issue.',
  },
  {
    id: 'F-xvii. ★★★ the expected walk holds at the ceiling (no latch)',
    file: NCA, tests: [T_LINE],
    find: '      if (pack >= capKwh - 1e-9) latched = true;',
    to: '      /* MUTANT */',
    why: 'The announced close is the 80% ceiling on 2026-10-29, which the panel does not hold.',
  },
  {
    id: 'F-xviii. ★★★ the expected walk has no re-ON',
    file: NCA, tests: [T_LINE],
    find: '        latched = false;\n        reOns += 1;',
    to: '        reOns += 1; /* MUTANT */',
    why: 'The announced close drains to the reserve where the tick would switch the slots back on.',
  },
  {
    id: 'F-xix. ★★★ the ON stamps no panel ceiling (the verify reads desired(cost))',
    file: NFC, tests: [T_LINE],
    find: '    forceChargeCeilingSyncedPct: mode != null ? mode.panelCeilingPct : s.forceChargeCeilingSyncedPct,',
    to: '    forceChargeCeilingSyncedPct: s.forceChargeCeilingSyncedPct, /* MUTANT */',
    why: 'A line night that needed no sync verifies a slot refusing the ON at 84% as "at the ceiling".',
  },
  {
    id: 'F-xx. ★★ no lowering of a stale cost ceiling in line mode',
    file: NFC, tests: [T_LINE],
    find: '    const lower = lineCeilingLoweringDue(s, o);\n    if (lower) return lower;',
    to: '    /* MUTANT */',
    why: 'The cost gate off mid-run leaves the cost 90 as the only stop: ten points past the line mode\'s own ceiling.',
  },
  {
    id: 'F-xxi. ★★ the line ceiling re-sync while ON may RAISE',
    file: NFC, tests: [T_LINE],
    find: '  if (synced == null || synced <= mode.panelCeilingPct || o.ceilingReadbackPct == null) return null;',
    to: '  if (synced == null || synced === mode.panelCeilingPct || o.ceilingReadbackPct == null) return null; /* MUTANT */',
    why: 'A ceiling write while ON that charges further than the night was armed for.',
  },
  {
    id: 'W-i. ★★ the ON stamps the mode on the cost gate only',
    file: IDX, tests: [T_LINE],
    find: '    const onStamp = forceChargeOnStamp(state, nowMs, action.slots, forceChargeGatesOn(legRoleOf(state)));',
    to: '    const onStamp = forceChargeOnStamp(state, nowMs, action.slots, { cost: forceChargeOn(legRoleOf(state)), line: false }); /* MUTANT */',
    why: 'A line night\'s ON is stamped cost (or none): the ON-failure push loses the line and the morning account falls to the cost path.',
  },
  {
    id: 'W-ii. ★★ the ON stamp drops the mode',
    file: NFC, tests: [T_LINE],
    find: '    forceChargeMode: mode?.kind ?? null,',
    to: '    forceChargeMode: null, /* MUTANT */',
    why: 'The same, at the helper.',
  },
  {
    id: 'W-iii. ★★ the evening push\'s supervised context loses the line',
    file: IDX, tests: [T_LINE],
    find: '          ...armedForceChargeAnnouncement(armedCandidate, forceChargeGatesOn()),',
    to: "          forceChargeTargetPct: armedCandidate.forceChargeRides === true ? armedCandidate.forceChargeCeilingPct : null, forceChargeLine: null, /* MUTANT */",
    why: 'A line night is pushed as reserve only, or as a cost stop it does not run.',
  },
  {
    id: 'W-iv. ★★ the announcement helper never names the line',
    file: NFC, tests: [T_LINE],
    find: "    forceChargeLine: rides && mode?.kind === 'line'",
    to: "    forceChargeLine: rides && mode?.kind === 'line' && !rides /* MUTANT */",
    why: 'The same, at the helper.',
  },
  {
    id: 'W-v. ★★ the morning account of a line night loses the close reading',
    file: IDX, tests: [T_LINE],
    find: "      closePoolPct: state.forceChargeMode === 'line' ? freshPoolSocPct(nowMs) : null,",
    to: '      closePoolPct: null, /* MUTANT */',
    why: 'The morning push says the line night ran, never where the pool closed against the line.',
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
    // v1.200.0 (review) — anchor moved: the line sentence follows the armed-not-started branch.
    find: "      : expected.mode === 'line'\n        ? ` ${envelopeHead}, so the panel's force-charge ${lineStartText}stays on",
    to: "      : forceChargeLine != null /* MUTANT */\n        ? ` ${envelopeHead}, so the panel's force-charge ${lineStartText}stays on",
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
    id: 'T-v. ★★ the ON-failure push on a line night reads as a lost buy ("no action needed")',
    file: NTF, tests: [T_LINE],
    // v1.200.0 (review) — anchor moved: the line night has its own words (all slots / some slots).
    find: '  const lost = line == null',
    to: '  const lost = true /* MUTANT */',
    why: 'A failed ON on a line night reads as a lost economic buy, not an unheld outage cushion, and asks for nothing.',
  },
  {
    id: 'T-v(b). ★★ a PARTIAL ON failure on a line night says the pool closes near 50%',
    file: NTF, tests: [T_LINE],
    find: '    : (partial\n',
    to: '    : (false /* MUTANT */\n',
    why: 'Two slots keep charging, yet the push says the pool will close near the 50% reserve.',
  },
  {
    id: 'T-vi. ★★ the declined-start push only on a refused ceiling (late or never for the rest)',
    file: NFC, tests: [T_LINE],
    // v1.200.0 (review) — anchor moved: the class lookup (forceChargeBlockerClass).
    find: '  const hit = (Object.entries(FORCE_CHARGE_BLOCKER_WHY) as Array<[keyof typeof FORCE_CHARGE_BLOCKER_WHY, string]>).find(([, w]) => why.startsWith(w));',
    to: "  const hit = (Object.entries(FORCE_CHARGE_BLOCKER_WHY) as Array<[keyof typeof FORCE_CHARGE_BLOCKER_WHY, string]>).find(([k, w]) => k === 'ceilingRefused' && why.startsWith(w)); /* MUTANT */",
    why: 'An unknown grid or an operator\'s Charge Now holds the line\'s start in silence until the close.',
  },
  {
    id: 'T-vii. ★★ the advisory push keeps the caps note on an envelope-only plan (no envelope note)',
    file: NTF, tests: [T_LINE],
    find: '  if (plan.cushionShortfallCause == null) return \'\';',
    to: '  if (plan.cushionShortfallCause == null || plan.cushionShortfallCause != null) return \'\'; /* MUTANT */',
    why: 'The advisory push says nothing of why the cushion is not held.',
  },

  {
    id: 'T-viii. ★★ the two all-night blockers are no blockers (no ceiling readback, no slot connected)',
    file: NFC, tests: [T_LINE],
    find: '  const hit = (Object.entries(FORCE_CHARGE_BLOCKER_WHY) as Array<[keyof typeof FORCE_CHARGE_BLOCKER_WHY, string]>).find(([, w]) => why.startsWith(w));',
    to: "  const hit = (Object.entries(FORCE_CHARGE_BLOCKER_WHY) as Array<[keyof typeof FORCE_CHARGE_BLOCKER_WHY, string]>).find(([k, w]) => k !== 'noSlots' && k !== 'ceilingReadback' && why.startsWith(w)); /* MUTANT */",
    why: 'Cores that report no hwConnect, or a panel ceiling never read, hold the line night\'s start all night in silence.',
  },
  {
    id: 'T-ix. ★★ one declined-start push a night, whatever the cause',
    file: NFC, tests: [T_LINE],
    find: '  if (nowMs - st.sinceMs < FORCE_CHARGE_LINE_DECLINED_PERSIST_MS || st.pushed.includes(cls)) return { state: st, push: null };',
    to: '  if (nowMs - st.sinceMs < FORCE_CHARGE_LINE_DECLINED_PERSIST_MS || st.pushed.length > 0) return { state: st, push: null }; /* MUTANT */',
    why: 'An earlier cause spends the push a later, persistent one needed.',
  },
  {
    id: 'T-x. ★★ a transient blocker pushes (no persistence)',
    file: NFC, tests: [T_LINE],
    find: '  if (nowMs - st.sinceMs < FORCE_CHARGE_LINE_DECLINED_PERSIST_MS || st.pushed.includes(cls)) return { state: st, push: null };',
    to: '  if (st.pushed.includes(cls)) return { state: st, push: null }; /* MUTANT */',
    why: 'A stale readback for one tick at 22:07 warns that the outage line cannot start.',
  },
  {
    id: 'T-xi. ★★ the push quotes the timed start, not the latest start that reaches the line',
    file: IDX, tests: [T_LINE],
    find: 'lineLatestStartMs(endMs, lineMode.askPct, ',
    to: 'lineLatestStartMs(endMs, lineMode.startTargetPct, /* MUTANT */ ',
    why: '"If it has not started by ~03:25 the pool closes under the line" — a start at 04:20 still holds it.',
  },
  {
    id: 'T-xii. ★★ the latest start past the dead zone',
    file: NFC, tests: [T_LINE],
    find: '    writeEndMs - FORCE_CHARGE_MIN_RUN_MS,\n  );',
    to: '    writeEndMs, /* MUTANT */\n  );',
    why: 'The push quotes a start the tick never makes (the last 20 min).',
  },
  {
    id: 'T-xiii. ★★ the morning summary says "ran to the window close" after any OFF',
    file: NTF, tests: [T_LINE],
    find: "    const early = line != null && line.offReason != null && line.offReason !== 'windowEnd';",
    to: '    const early = false; /* MUTANT */',
    why: 'A line night switched off at 03:30 (disabled, the run backstop, a foreign reserve) is reported as run to the close.',
  },
  {
    id: 'T-xiv. ★★ the line outcome drops the OFF',
    file: NFC, tests: [T_LINE],
    find: '    const ran: ForceChargeOutcomeLine = { ...line, offReason: s.forceChargeOffReason ?? null, offAtMs: s.forceChargeOffAtMs ?? null };',
    to: '    const ran: ForceChargeOutcomeLine = { ...line }; /* MUTANT */',
    why: 'The same, at the outcome.',
  },
  {
    id: 'T-xv. ★★ the push\'s envelope note not worded by its reason',
    file: NTF, tests: [T_LINE],
    find: "  const why = plan.cushionEnvelopeReason === 'tooHigh'\n    ? 'and it is too close",
    to: "  const why = false /* MUTANT */\n    ? 'and it is too close",
    why: 'A 92% line on a night charging to ~100% is told no force-charge carries it, in general words.',
  },
  {
    id: 'T-xvi. ★★ the card\'s envelope row not worded by its reason ("not held tonight" under "charging to ~100%")',
    file: CARD, tests: [T_LINE],
    find: "    const why = plan.cushionEnvelopeReason === 'tooHigh'\n      ? 'too close",
    to: "    const why = false /* MUTANT */\n      ? 'too close",
    why: 'The card contradicts its own title.',
  },
  {
    id: 'T-xvii. ★★ the rationale says the force-charge "stays on until the window closes" when it is not expected to start',
    file: NCA, tests: [T_LINE],
    find: "    : expected.mode === 'line' && expected.forceChargeStartMs === null",
    to: "    : false && expected.mode === 'line' && expected.forceChargeStartMs === null /* MUTANT */",
    why: 'A force-charge that never switches on is said to stay on.',
  },
  {
    id: 'T-xviii. ★★ the card says "stays on to the window close" when it is not expected to start',
    file: CARD, tests: [T_LINE],
    find: '    if (plan.expectedForceChargeStartMs === null) {',
    to: '    if (plan.expectedForceChargeStartMs === null && plan.cushionLineSocPct === -1) { /* MUTANT */',
    why: 'The same on the card.',
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
