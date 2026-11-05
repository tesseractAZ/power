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
 * (review 2) THE LINE AT RISK after the start (the ON-reading latch, a refused or spent re-ON, the re-ON's gates, a late
 * load): pushed once a night, write-ahead, while a person can act; the trail, the panel's own stop, the ON-reading shape
 * logged. W1-i..xxv. A line re-ON readback-checked like the ON. W2-i..viii. The morning account of a line-ask night
 * (under the line, unread close, the panel's stop, the re-ONs). W3-i..ix.
 * (review 3) The trend judged only on readings taken after the last ON of ours had its readback grace (lineTrendReference),
 * a flat pool at risk only at or under ⌈L⌉, no push at the re-ON's own cutoff instant, the ON-reading shape never on the
 * re-ON working, the cost-dominant push by its margin and its reason. W1-xxvi..xxxv. A re-ON resumes the charge in the
 * morning account only when it took effect; the panel's stop named only when on record. W3-x..xv.
 * (review 4) A re-ON checked not applied (or never written) is no ON of ours for the trend; the check keeps the latest re-ON
 * that took effect (lineReOnCheckedStamp), across the next re-ON and a restart; the spent budget names the panel's stop only
 * on record. W1-xxxvi..xli, W2-ix..xiv. The morning account counts every re-ON after the stop, and with no stop and no re-ON
 * that took never says "ran to the window close". W3-xvi..xxi.
 * (review 5) A slot of ours read ON again that no ON write of ours explains in time (a late apply, a glitch at the check,
 * Charge Now switched on in the app) is stamped and waited out by the trend; no push inside a handed-back re-ON's retry
 * spacing, and 'reOnRefused' when the cutoff refuses the retry; a not-applied slot reading ON since is not named.
 * W1-xlii..lv. The morning read-off is the last re-ON's, unless a slot read ON again after it; a slot seen ON after the
 * panel's stop resumed the charge; the outcome names only the last re-ON's check. W3-xxii..xxvii.
 * (review 6) The hand-back hold counts the ticks (FORCE_CHARGE_TICK_MS, the cadence index.ts runs the tick on): it holds only
 * while the first tick 15 min or more after the stamp falls before the cutoff; a slot seen ON again opens a new panel-stop
 * episode. W1-lvi..lxii. (review 7 counted to the earliest tick the retry can come, W1-lxiii..lxv; retired in review 8 with
 * the tolerance.) (review 8) The hold keeps a FULL TICK of margin, the push is judged on the hand-back's own tick too, and
 * its words are keyed on whether a tick can still bring the retry (reOnRetryPossible). W1-lxvi..lxxiv; W1-xli, xlviii,
 * xlix, lii, lvii and lviii re-anchored. The ceiling lowering lowers only what the panel holds. W4-i..iii. A cost-dominant
 * line night's ON failure and declined start; the declined start once a night across restarts; the reserve-apply failure
 * on a line night. W5-i..ix.
 * (M) THE MORNING REFRESH never lowers or drops the line. M-i, M-ii.
 * (T) THE TEXTS: cause-keyed notes, one level everywhere, the line sentence only in line mode, the spoken
 * clause, the ON-failure sentence, the declined-start push. T-i..vii. (review) the ON failure's line words
 * (all slots / some), the declined start per blocker class once it persists and its latest start, the
 * morning account of an early OFF, the envelope note by its reason, a line night not expected to start.
 * T-v(b), T-viii..xviii. (P) also the min-buy hold, the 90/91 edge, the one ask, the reason. P-x..xii.
 * (review 2) a walk that reaches the panel ceiling is worded by the panel's own stop and the re-ON, never "stays on
 * until the window closes" (the rationale, the push, the card, the 21:30 line). T-xix..xxvi.
 * (G) THE GATE: a carried night under its line is a strike. G-i.
 * (R) THE LEDGER: the plan columns written unconditionally. R-i, R-ii.
 * (A5) THE LINE ARMED WHATEVER THE ASK, CARRIED ONLY WHERE ITS OWN REACHABLE WALK HOLDS: no cut on arming; 'closeUnder'
 * where the sized night's walk closes under L − 0.05, at the scorer's tolerance; a line within 10 points of full runs as a
 * 90% line (start 95, ceiling 100) — on ⌈L⌉ + 10 > 100, never at 100; every surface words an armed night by
 * lineNotHeldOf (closeUnder / aboveFull / nearFull), never "no force-charge"; the H1 reach cap (the window-open pool, the
 * deliverable and the P50 PV) and the panel's stop only where reachable; the mid-day push keyed on the leg's ask (L4), the
 * shadow record and its restore; the ON log names the panel's stop (L3); the gate strikes an armed, disclosed row whose
 * force-charge never switched on and that closed under min(line, 100). A5-i..xxviii (P-viii, P-xi, P-xii, F-iii, T-xv,
 * T-xvi, T-xvii and G-i re-anchored on the A5 lines). The spoken notice of a window-bound line night: its level is the
 * window's reach, so "which ends before it gets there" only where the 50% floor lifts it above that reach. A5-xxx.
 * (A5 fix) The mid-day re-entry hold never holds a leg the line force-charge is armed on, and says so (A5-xxxi); a close
 * exactly at L − 0.05 holds, in the planner, the scorer and the card (A5-v(c), (d), A5-xxix(b)); strikesMeasurable counts an armed, actuated
 * disclosed row (A5-xxiii(c), (d)); the mid-day push keeps the backup leg's sentence beside an armed leg (A5-xxxii); no
 * not-held or caps sentence on a held armed night or leg (A5-xxxiii); the H1 reach's PV term not over-counted (A5-xxxiv).
 * (A5 final 1) The mid-day push names Charge Now on an armed leg whatever its stated level, and keeps the cost rule (A5-xxxv).
 * (A5 final 2) …in the reserve-hold shape too: armed for the line, not expected to start; no ask byte for byte (A5-xxxvi).
 * (Fix7 review 1) …naming the plan's line round1(L), never its ask ⌈L⌉; a record without the line, unnumbered (A5-xxxvi(c)-(g)).
 * (Fix7 review 2) The overnight log's line-mode whys name the record's line round1(L), never the ask, and never "stays on to
 * the close" (A5-xxxvii(a)-(e); (b) re-anchored in Fix8).
 * (Fix8) The "already at the ceiling" why words the line's actual order (F8-i); every line text names the line beside the
 * levels it orders it against so the order shows, says only what holds in every outcome, and the log lines name round1(L)
 * (F8-ii); the line-at-risk push is judged after the line ceiling lowering (F8-iii).
 * (Fix8 review 1) The push and the ON-reading shape judged together (judgeLineNight) on the re-ON's readback check and a re-ON
 * the write block refuses too (F8r1-i); the cost-dominant margin from the numbers as named (F8r1-ii); the declined start and
 * the ON failure with no floor the islanded pool drains through (F8r1-iii, F8r1-iv(a)); "has not taken effect" wherever a late
 * apply is still verified (F8r1-iv); the shape logged once a night on the record (F8r1-v; W1-xxi re-anchored there).
 * (Fix8 review 2) …and in every line push's title ("the reserve write has not taken effect", "cannot start yet": F8r2-i), in
 * the line-night ON-failure and apply-failure log lines (F8r2-ii), and the morning's re-ON count as the checks read it (F8r2-iii).
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
const CARDX = resolve(REPO, 'web/src/cards/NightChargeCard.tsx');
const CTX = resolve(REPO, 'server/src/chargeText.ts');
const MSH = resolve(REPO, 'server/src/middayShadow.ts');
const ANN = resolve(REPO, 'server/src/chargeAnnounce.ts');

const T_LINE = 'test/lineForceCharge.test.ts';
const T_CLOSE = 'test/lineForceChargeClose.test.ts';
const T_GOLDEN = 'test/legacyIdentity.test.ts';
const T_RISK = 'test/lineForceChargeAtRisk.test.ts';
const T_YEAR = 'test/lineForceChargeYear.test.ts';

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
    file: NCA, tests: [T_LINE, T_YEAR],
    // (A5) re-anchored: the near-full test now decides only whether the plan claims the line.
    find: '  const lineNearFull = lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT > 100;',
    to: '  const lineNearFull = false; /* MUTANT */',
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
    find: '  const lineNearFull = lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT > 100;',
    to: '  const lineNearFull = lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT >= 100; /* MUTANT */',
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
    id: 'P-xii. ★★ the envelope reason always "advisory" (an armed near-full or close-under night recorded as nothing armed)',
    file: NCA, tests: [T_LINE],
    find: "    : backupLeg ? 'backupLeg' : lineEligible !== true ? 'advisory' : lineNearFull ? 'nearFull' : 'closeUnder';",
    to: "    : 'advisory' as CushionEnvelopeReason; /* MUTANT */",
    why: 'An armed 92% line, its force-charge running to ~99.6%, is recorded as advisory: the margin NOTE goes, and the push and the card lose why.',
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
    // (A5) re-anchored: the start target's ordinary arm (⌈L⌉ + 10 ≤ 100).
    find: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H > 100 ? 100 - H : Math.max(t, ask! + H),",
    to: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H > 100 ? 100 - H : t, /* MUTANT */",
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
    id: 'F-xxi. ★★ the line ceiling re-sync while ON lowers a ceiling the add-on synced UNDER the mode\'s',
    file: NFC, tests: [T_LINE, T_RISK],
    // v1.200.0 (review 2) — anchor moved: the readback is checked on its own line (W4).
    find: '  if (synced == null || synced <= mode.panelCeilingPct) return null;',
    to: '  if (synced == null || synced === mode.panelCeilingPct) return null; /* MUTANT */',
    why: 'A ceiling write while ON past the add-on\'s own synced value: 88 over our 80 on a panel raised to 100 in the app.',
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
    // v1.200.0 (review 2) — anchor moved: every night whose record carries a line ask (W3).
    find: '      closePoolPct: lineNight != null ? freshPoolSocPct(nowMs) : null,',
    to: '      closePoolPct: null, /* MUTANT */',
    why: 'The morning push says the line night ran, never where the pool closed against the line.',
  },

  /* ── (review 2) W4: the line ceiling lowering lowers only what the panel holds ── */
  {
    id: 'W4-i. ★★★ the lowering writes whatever the panel reads (a RAISE over a ceiling lowered in the app)',
    file: NFC, tests: [T_RISK],
    find: '  if (!(rb > mode.panelCeilingPct)) return null;',
    to: '  /* MUTANT */',
    why: 'The panel holds 80 and the line mode writes 85 under red vitals: a new grid-charge reach the night never armed.',
  },
  {
    id: 'W4-ii. ★★ the lowering reads a ceiling outside the panel\'s 80..100',
    file: NFC, tests: [T_RISK],
    find: '  if (rb == null || !Number.isFinite(rb) || rb < FORCE_CHARGE_CEILING_MIN_PCT || rb > FORCE_CHARGE_CEILING_MAX_PCT) return null;',
    to: '  if (rb == null || !Number.isFinite(rb)) return null; /* MUTANT */',
    why: 'A stray 101 (no ceiling) triggers a ceiling write.',
  },
  {
    id: 'W4-iii. ★ the lowering held by red vitals (the safe direction refused)',
    file: NFC, tests: [T_RISK],
    find: '  if (!(rb > mode.panelCeilingPct)) return null;',
    to: '  if (!(rb > mode.panelCeilingPct) || o.vitalsRed) return null; /* MUTANT */',
    why: 'A struggling host leaves the stale cost ceiling as the only stop: ten points past the line mode\'s own.',
  },

  /* ── (review 2) W2: the line re-ON is readback-checked like the first ON ── */
  {
    id: 'W2-i. ★★★ no re-ON readback check',
    file: NFC, tests: [T_RISK],
    find: '    const reOnCheck = lineReOnCheckDue(s, nowMs, o);\n    if (reOnCheck) return reOnCheck;',
    to: '    /* MUTANT */',
    why: 'A re-ON the cloud ACKs and the panel ignores is never known: no push names it, the morning says nothing.',
  },
  {
    id: 'W2-ii. ★★ the re-ON judged inside its readback grace',
    file: NFC, tests: [T_RISK],
    find: '  if (nowMs - at < FORCE_CHARGE_ON_VERIFY_AFTER_MS || o.slotsOn == null) return null;',
    to: '  if (o.slotsOn == null) return null; /* MUTANT */',
    why: 'A re-ON that is merely slow to read back (up to 14 min on 2026-10-05/06) is recorded as not applied.',
  },
  {
    id: 'W2-iii. ★★ a checked re-ON is checked again every tick (the next re-ON never comes)',
    file: NFC, tests: [T_RISK],
    find: '  if (s.forceChargeLineReOnCheckedAtMs != null && s.forceChargeLineReOnCheckedAtMs >= at) return null;',
    to: '  /* MUTANT */',
    why: 'The check pre-empts the budget\'s second re-ON on every tick: the retry is never written.',
  },
  {
    id: 'W2-iv. ★★ the re-ON check counts a Core at the ceiling as not applied',
    file: NFC, tests: [T_RISK],
    find: '  const notOn = slots.filter((n) => !o.slotsOn!.includes(n) && !atCeiling(n));',
    to: '  const notOn = slots.filter((n) => !o.slotsOn!.includes(n)); /* MUTANT */',
    why: 'A slot the panel switched off again at its ceiling is reported as a re-ON that did not take effect.',
  },
  {
    id: 'W2-v. ★★ the re-ON check trusts an all-exempt verdict with nothing ON',
    file: NFC, tests: [T_RISK],
    find: "  return { kind: 'lineReOnChecked', slots: [...slots], notApplied: notOn.length === 0 && !anyOn ? [...slots] : notOn };",
    to: "  return { kind: 'lineReOnChecked', slots: [...slots], notApplied: notOn }; /* MUTANT */",
    why: 'A bad Core reading at the ceiling with every slot OFF records a re-ON that never applied as applied.',
  },
  {
    id: 'W2-vi. ★★ index.ts: the re-ON stamps no slots (no check ever runs)',
    file: IDX, tests: [T_RISK],
    find: '      forceChargeLineReOnSlots: [...action.slots],\n    });',
    to: '    }); /* MUTANT */',
    why: 'The same, at the wiring.',
  },
  {
    id: 'W2-vii. ★★ a re-ON that did not take effect is not counted (the check\'s stamp, review 4: lineReOnCheckedStamp)',
    file: NFC, tests: [T_RISK],
    find: '    ...(a.notApplied.length > 0 ? { forceChargeLineReOnsNotApplied: s.forceChargeLineReOnsNotApplied + 1 } : {}),',
    to: '    /* MUTANT */',
    why: 'The morning account says nothing of the re-ON that never took.',
  },
  {
    id: 'W2-viii. ★★ index.ts: a re-ON handed back (all rate-limited) keeps its slots and is judged',
    file: IDX, tests: [T_LINE, T_RISK],
    find: '      ...(allLimited ? { forceChargeLineReOns: Math.max(0, nightActuationMem.forceChargeLineReOns - 1), forceChargeLineReOnSlots: null } : {}),',
    to: '      ...(allLimited ? { forceChargeLineReOns: Math.max(0, nightActuationMem.forceChargeLineReOns - 1) } : {}), /* MUTANT */',
    why: 'A re-ON that never reached the panel is recorded as one that did not take effect.',
  },
  /* (review 4) the check keeps the latest re-ON that took effect. */
  {
    id: 'W2-ix. ★★★ the check never keeps the re-ON that took effect',
    file: NFC, tests: [T_RISK],
    find: '    ...(took && s.forceChargeLineReOnAtMs != null ? { forceChargeLineReOnAppliedAtMs: s.forceChargeLineReOnAtMs } : {}),',
    to: '    /* MUTANT */',
    why: 'Round-4 finding 2: a re-ON after the 01:00 stop resumed the charge, a later one failed, and the morning says the 1am stop ended it.',
  },
  {
    id: 'W2-x. ★★ a re-ON that took on one slot of three not kept as taking effect',
    file: NFC, tests: [T_RISK],
    find: '  const took = a.slots.some((n) => !a.notApplied.includes(n));',
    to: '  const took = a.notApplied.length === 0; /* MUTANT */',
    why: 'The stamp disagrees with lastLineReOnApplied: a charge resumed on two slots is forgotten once a later re-ON fails.',
  },
  {
    id: 'W2-xi. ★★ every checked re-ON kept as taking effect',
    file: NFC, tests: [T_RISK],
    find: '  const took = a.slots.some((n) => !a.notApplied.includes(n));',
    to: '  const took = true; /* MUTANT */',
    why: 'A re-ON whose slots all still read OFF becomes the last ON of ours: the trend waits on it again, and the morning says it resumed the charge.',
  },
  {
    id: 'W2-xii. ★★ index.ts: the check persisted without its pure stamp (the applied re-ON lost)',
    file: IDX, tests: [T_RISK],
    find: '    persistNightActuation({ ...nightActuationMem, ...lineReOnCheckedStamp(nightActuationMem, nowMs, action) });',
    to: '    persistNightActuation({ ...nightActuationMem, forceChargeLineReOnCheckedAtMs: nowMs, forceChargeLineReOnNotAppliedSlots: [...action.notApplied] }); /* MUTANT */',
    why: 'The same, at the wiring.',
  },
  {
    id: 'W2-xiii. ★★ index.ts: the next re-ON clears the re-ON that took effect',
    file: IDX, tests: [T_RISK],
    find: '      forceChargeLineReOnSlots: [...action.slots],\n    });',
    to: '      forceChargeLineReOnSlots: [...action.slots],\n      forceChargeLineReOnAppliedAtMs: null, /* MUTANT */\n    });',
    why: 'A failed second re-ON erases the first that took: the trend and the morning account read the night as never resumed.',
  },
  {
    id: 'W2-xiv. ★★ a restart drops the re-ON that took effect',
    file: ACT, tests: [T_RISK],
    find: '    forceChargeLineReOnAppliedAtMs: num(o.forceChargeLineReOnAppliedAtMs),',
    to: '    forceChargeLineReOnAppliedAtMs: null, /* MUTANT */',
    why: 'An add-on restart after the second re-ON fails reads the night as never resumed.',
  },

  /* ── (review 2) W1: the line at risk after the start ── */
  {
    id: 'W1-i. ★★★ index.ts never asks whether the line is at risk',
    file: IDX, tests: [T_RISK],
    find: '    const risk = lineAtRiskPushDue(nightActuationMem, nowMs, fcOpts);',
    to: '    const risk = (false as boolean) ? lineAtRiskPushDue(nightActuationMem, nowMs, fcOpts) : null; /* MUTANT */',
    why: 'The ON-reading latch, a spent re-ON budget or a late EV takes the pool under the line in silence until the morning.',
  },
  {
    id: 'W1-ii. ★★★ index.ts: the at-risk push not stamped before it goes',
    file: IDX, tests: [T_RISK],
    find: '      persistNightActuation({ ...nightActuationMem, forceChargeLineAtRiskPushedAtMs: nowMs });',
    to: '      /* MUTANT */',
    why: 'The push repeats every tick (and after every restart) while the line stays at risk.',
  },
  {
    id: 'W1-iii. ★★★ the at-risk push more than once a night',
    file: NFC, tests: [T_RISK],
    find: '  if (s.forceChargeLineAtRiskPushedAtMs != null) return null;',
    to: '  /* MUTANT */',
    why: 'The same, at the helper.',
  },
  {
    id: 'W1-iv. ★★★ never on a COST-DOMINANT line night',
    file: NFC, tests: [T_RISK],
    find: "  const thresholdPct = mode.kind === 'line' ? mode.startTargetPct : s.forceChargeLineAskPct! + FORCE_CHARGE_LINE_HEADROOM_PCT;",
    to: "  const thresholdPct = mode.kind === 'line' ? mode.startTargetPct : Number.NaN; /* MUTANT */",
    why: 'A Thursday line night (cost 90, line 69.4) whose cost force-charge stalls closes under its line with no word.',
  },
  {
    id: 'W1-v. ★★★ a cost-dominant night at risk under its COST target (an economic level)',
    file: NFC, tests: [T_RISK],
    find: "  const thresholdPct = mode.kind === 'line' ? mode.startTargetPct : s.forceChargeLineAskPct! + FORCE_CHARGE_LINE_HEADROOM_PCT;",
    to: "  const thresholdPct = mode.kind === 'line' ? mode.startTargetPct : mode.targetPct; /* MUTANT */",
    why: 'A cost night 15 points above its line, merely short of a 90% buy, is pushed as an outage line at risk.',
  },
  {
    id: 'W1-vi. ★★★ pushed while the add-on can still switch the slots back on itself',
    file: NFC, tests: [T_RISK],
    find: '  if (lineReOnDue(s, nowMs, o, ours) != null) return null;',
    to: '  /* MUTANT */',
    why: 'The owner is told to act on the one case the add-on handles on the next tick.',
  },
  {
    id: 'W1-vii. ★★★ a re-ON (or the ON) in its readback grace is not left alone',
    file: NFC, tests: [T_RISK],
    find: '  const ref = lineTrendReference(s, nowMs);\n  if (ref == null || o.poolSocPct > ref.pct) return null;',
    to: '  const ref = linePoolReference(s.forceChargeLinePoolSamples, nowMs); /* MUTANT */\n  if (ref == null || o.poolSocPct > ref.pct) return null;',
    why: 'A re-ON written a minute ago, not yet read back, is pushed as a line the add-on cannot hold.',
  },
  {
    id: 'W1-viii. ★★★ a RISING pool is pushed as at risk',
    file: NFC, tests: [T_RISK],
    find: '  if (ref == null || o.poolSocPct > ref.pct) return null;',
    to: '  if (ref == null) return null; /* MUTANT */',
    why: 'Every line night mid-charge under its start target pushes a false alarm.',
  },
  {
    id: 'W1-ix. ★★★ pushed inside the last 20 min (nothing can still move the close)',
    file: NFC, tests: [T_RISK],
    find: '  if (nowMs >= closeAtMs - FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) return null;',
    to: '  if (nowMs > closeAtMs) return null; /* MUTANT */',
    why: 'A push at 04:55 asks for an action that buys under a point.',
  },
  {
    id: 'W1-x. ★★★ at the start target counts as under it',
    file: NFC, tests: [T_RISK],
    find: '  if (!(o.poolSocPct < thresholdPct)) return null;',
    to: '  if (!(o.poolSocPct <= thresholdPct)) return null; /* MUTANT */',
    why: 'A pool sitting at ⌈L⌉ + 5 is pushed as at risk.',
  },
  {
    id: 'W1-xi. ★★★ the line gate not read (advisory, or the backup leg, pushes)',
    file: NFC, tests: [T_RISK],
    find: '  const gates = gatesOf(o);\n  if (!gates.line) return null;',
    to: '  const gates = gatesOf(o); /* MUTANT */',
    why: 'NIGHT_CHARGE_MODE advisory (no line force-charge) still pushes a line at risk.',
  },
  {
    id: 'W1-xii. ★★ an OFF slot whose Core sits at the ceiling is named to switch on',
    file: NFC, tests: [T_RISK],
    find: '  const offSlots = ours.filter((n) => !o.slotsOn!.includes(n) && o.connectedSlots.includes(n) && coreBelowStop(n));',
    to: '  const offSlots = ours.filter((n) => !o.slotsOn!.includes(n) && o.connectedSlots.includes(n)); /* MUTANT */',
    why: 'The owner is told to switch on a slot the panel would switch straight off again.',
  },
  {
    id: 'W1-xiii. ★★ a spent budget read as a held re-ON',
    file: NFC, tests: [T_RISK],
    find: "        ? (notApplied != null && notApplied.length > 0 ? 'reOnNotApplied' : 'reOnSpent')",
    to: "        ? ('reOnHeld' as LineAtRiskCause) /* MUTANT */",
    why: 'The push says the add-on waits on its gates when it will never switch the slots on again tonight.',
  },
  {
    id: 'W1-xiv. ★★★ the pool trail never moves',
    file: NFC, tests: [T_RISK],
    find: '  return [last, { pct, atMs: nowMs }];',
    to: '  return samples as LinePoolSample[]; /* MUTANT */',
    why: 'The reference is the ON-time reading all night: a pool falling from 80 reads as not rising only once under it.',
  },
  {
    id: 'W1-xv. ★★★ the reference is the newest sample whatever its age',
    file: NFC, tests: [T_RISK],
    find: '    if (nowMs - samples[i].atMs >= FORCE_CHARGE_LINE_TREND_MS) return { pct: samples[i].pct, atMs: samples[i].atMs };',
    to: '    return { pct: samples[i].pct, atMs: samples[i].atMs }; /* MUTANT */',
    why: 'A reading a minute old compares a whole-percent pool with itself: a charging pool reads as not rising.',
  },
  {
    id: 'W1-xvi. ★★ the trail persisted every tick',
    file: NFC, tests: [T_RISK],
    find: '  if (nowMs - last.atMs < FORCE_CHARGE_LINE_TREND_MS) return samples as LinePoolSample[];',
    to: '  if (nowMs - last.atMs < FORCE_CHARGE_LINE_TREND_MS) return [...cur]; /* MUTANT */',
    why: 'A file write a minute for nothing: index.ts persists only a changed trail.',
  },
  {
    id: 'W1-xvii. ★★★ the panel\'s own stop never stamped',
    file: NFC, tests: [T_RISK],
    find: '    if (allOff && coreAtStop && newEpisode) out.forceChargeLinePanelOffAtMs = nowMs;',
    to: '    /* MUTANT */',
    why: 'The morning says the line night ran to the window close when the panel stopped it at 03:10.',
  },
  {
    id: 'W1-xviii. ★★ the panel\'s stop re-stamped inside a re-ON\'s readback grace',
    file: NFC, tests: [T_RISK],
    find: '    const newEpisode = prev == null || (reOn != null && reOn > prev && nowMs - reOn >= FORCE_CHARGE_ON_VERIFY_AFTER_MS)\n',
    to: '    const newEpisode = prev == null || (reOn != null && reOn > prev) /* MUTANT */\n',
    why: 'A re-ON just written (its slots still read OFF) is recorded as the panel stopping the charge again.',
  },
  {
    id: 'W1-xix. ★★ an all-OFF with no Core at the ceiling read as the panel\'s stop',
    file: NFC, tests: [T_RISK],
    find: "      return typeof soc === 'number' && Number.isFinite(soc) && soc >= stop - 1;",
    to: "      return typeof soc === 'number' && Number.isFinite(soc); /* MUTANT */",
    why: 'An OFF from the app at 70% is reported as the panel\'s own stop at its ceiling.',
  },
  {
    id: 'W1-xx. ★★★ index.ts: the observations not on the record before the decision',
    file: IDX, tests: [T_RISK],
    find: '  if (obs != null) { persistNightActuation({ ...nightActuationMem, ...obs }); state = nightActuationMem; }',
    to: '  /* MUTANT */',
    why: 'No trail, no panel stop: the at-risk push never fires and the morning names no stop.',
  },
  {
    // (Fix8 review 1) Re-anchored: the once-a-night guard is the record's stamp now (lineOnReadingShape), not module memory.
    id: 'W1-xxi. ★★ the ON-reading shape logged every tick',
    file: NFC, tests: [T_RISK],
    find: '  if (s.forceChargeLineShapeLoggedAtMs != null) return null;\n  if (forceChargeLineNightPct(s) == null) return null;\n  if (s.forceChargeOnAtMs == null || s.forceChargeOnVerifiedAtMs == null',
    to: '  /* MUTANT */\n  if (forceChargeLineNightPct(s) == null) return null;\n  if (s.forceChargeOnAtMs == null || s.forceChargeOnVerifiedAtMs == null',
    why: 'A warning line a minute; the first occurrence is lost in the flood (and a restart logs it again).',
  },
  {
    id: 'W1-xxii. ★★ the ON-reading shape logged on a flat pool',
    file: NFC, tests: [T_RISK],
    find: '  if (ref == null || !(o.poolSocPct < ref.pct)) return null;',
    to: '  if (ref == null || !(o.poolSocPct <= ref.pct)) return null; /* MUTANT */',
    why: 'A pool held flat under Charge Now is logged as the unmeasured latch.',
  },
  {
    id: 'W1-xxiii. ★★★ the at-risk push asks for nothing (no slot to switch on)',
    file: NTF, tests: [T_RISK],
    find: "    ? `To hold the line, switch Charge Now on for slot(s) ${r.offSlots.join(', ')} in the EcoFlow app (the add-on switches it off at the close).`",
    to: "    ? 'No action needed tonight.' /* MUTANT */",
    why: 'The push reaches a phone and asks for nothing while the line can still be held.',
  },
  {
    id: 'W1-xxiv. ★★ the ON-reading slots not named',
    file: NTF, tests: [T_RISK],
    find: '  const on = r.onSlots.length > 0',
    to: '  const on = false /* MUTANT */',
    why: 'The ON-reading latch pushes a warning with no action in it.',
  },
  {
    id: 'W1-xxv. ★★ a flat pool said to be falling',
    file: NTF, tests: [T_RISK],
    find: '  const falling = r.poolPct < r.refPct;',
    to: '  const falling = r.poolPct <= r.refPct; /* MUTANT */',
    why: 'The push states a fall no reading shows.',
  },
  /* (review 3) the trend on readings after the last ON of ours; a flat pool only at ⌈L⌉; not at the cutoff; the
     ON-reading shape never on the re-ON working; the cost-dominant push by its margin and its reason. */
  {
    id: 'W1-xxvi. ★★★ the trend judged against a reading from before the last ON of ours took effect',
    file: NFC, tests: [T_RISK],
    find: '  if (ref == null || lastOn == null || ref.atMs < lastOn + FORCE_CHARGE_ON_VERIFY_AFTER_MS) return null;',
    to: '  if (ref == null || lastOn == null) return null; /* MUTANT */',
    why: 'Round-3 finding 5: a re-ON that took effect, the pool rising 58 → 60, is pushed as "falling" against the 62 that called for it.',
  },
  {
    id: 'W1-xxvii. ★★ a reading inside the last ON\'s readback grace counts',
    file: NFC, tests: [T_RISK],
    find: '  if (ref == null || lastOn == null || ref.atMs < lastOn + FORCE_CHARGE_ON_VERIFY_AFTER_MS) return null;',
    to: '  if (ref == null || lastOn == null || ref.atMs < lastOn) return null; /* MUTANT */',
    why: 'Round-3 finding 6: an ON 5 min late with a reading 3 min stale — the reference taken after the write, before it took effect.',
  },
  {
    id: 'W1-xxviii. ★★ the re-ON not counted as an ON of ours',
    file: NFC, tests: [T_RISK],
    // (review 5) anchor moved: the ON of ours is `ownOn`, beside the ON seen on the readback.
    find: '  const ownOn = reOn ?? s.forceChargeOnLastAttemptMs ?? s.forceChargeOnAtMs;',
    to: '  const ownOn = s.forceChargeOnLastAttemptMs ?? s.forceChargeOnAtMs; /* MUTANT */',
    why: 'Every re-ON that works is followed by a push (and a shape log) against the fall that called for it.',
  },
  {
    id: 'W1-xxix. ★★★ a FLAT pool above ⌈L⌉ pushed as at risk',
    file: NFC, tests: [T_RISK],
    find: '  if (!(o.poolSocPct < ref.pct) && o.poolSocPct > s.forceChargeLineAskPct!) return null;',
    to: '  /* MUTANT */',
    why: 'Round-3 finding 5: a pack importing ~3 kW beside an EV reads flat at 59 and the phones are told to toggle Charge Now on a night that closes 4 points over its line.',
  },
  {
    id: 'W1-xxx. ★★ a flat pool AT ⌈L⌉ not pushed',
    file: NFC, tests: [T_RISK],
    find: '  if (!(o.poolSocPct < ref.pct) && o.poolSocPct > s.forceChargeLineAskPct!) return null;',
    to: '  if (!(o.poolSocPct < ref.pct) && o.poolSocPct >= s.forceChargeLineAskPct!) return null; /* MUTANT */',
    why: 'A pool held flat one point from its line is left silent.',
  },
  {
    id: 'W1-xxxi. ★★ a FALLING pool held to ⌈L⌉ too',
    file: NFC, tests: [T_RISK],
    find: '  if (!(o.poolSocPct < ref.pct) && o.poolSocPct > s.forceChargeLineAskPct!) return null;',
    to: '  if (o.poolSocPct > s.forceChargeLineAskPct!) return null; /* MUTANT */',
    why: 'A pool falling from 62 to 60 under its 61% start target is pushed only once it is a point from the line.',
  },
  {
    id: 'W1-xxxii. ★★ pushed AT the re-ON\'s cutoff instant',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '  if (nowMs >= closeAtMs - FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) return null;',
    to: '  if (nowMs > closeAtMs - FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) return null; /* MUTANT */',
    why: 'Round-3 finding 4: a re-ON the cutoff refuses is pushed as "it needs the grid known present, healthy host vitals and a live panel reading".',
  },
  {
    id: 'W1-xxxiii. ★★★ the ON-reading shape judged against a reading from before the re-ON',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '  const ref = lineTrendReference(s, nowMs);\n  if (ref == null || !(o.poolSocPct < ref.pct)) return null;',
    to: '  const ref = linePoolReference(s.forceChargeLinePoolSamples, nowMs); /* MUTANT */\n  if (ref == null || !(o.poolSocPct < ref.pct)) return null;',
    why: 'Round-3 finding 6: the first predicted-EV night whose re-ON works logs a false first occurrence of the unmeasured latch.',
  },
  {
    id: 'W1-xxxiv. ★★ the cost-dominant push names a start target that night does not have',
    file: NTF, tests: [T_RISK],
    find: "  const costMode = r.cause === 'costMode';",
    to: '  const costMode = false; /* MUTANT */',
    why: 'Round-3 finding 3: "under the 75% start target" on a night timed to 90, and no reason the add-on cannot act.',
  },
  {
    id: 'W1-xxxv. ★★ the cost-dominant push gives no reason the add-on cannot act',
    file: NTF, tests: [T_RISK],
    find: '    ? "Tonight\'s force-charge is the cost plan\'s, with its own stop: the add-on does not switch Charge Now back on for the line. "',
    to: "    ? '' /* MUTANT */",
    why: 'The owner is not told the add-on will not switch Charge Now back on tonight.',
  },
  /* (review 4) a re-ON checked not applied, or never written, is no ON of ours for the trend; the spent budget names the
     panel's stop only on record. */
  {
    id: 'W1-xxxvi. ★★★ a re-ON checked NOT APPLIED still bars the trend (the review-4 regression)',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '  const reOn = lastLineReOnApplied(s) !== false ? s.forceChargeLineReOnAtMs : s.forceChargeLineReOnAppliedAtMs;',
    to: '  const reOn = s.forceChargeLineReOnAtMs; /* MUTANT */',
    why: 'Round-4 finding 1: both re-ONs (54 and 38 min out) never take; the earliest reference comes past the 20-min lead and the night closes 6 points under its line with no push (the close plant\'s reOnInert: 90 of the 390 year nights under reached, not 169; 1,740 of 2,615 at 70-90%, not 2,308).',
  },
  {
    id: 'W1-xxxvii. ★★ past a failed re-ON, an earlier re-ON that took effect is forgotten',
    file: NFC, tests: [T_RISK],
    find: '  const reOn = lastLineReOnApplied(s) !== false ? s.forceChargeLineReOnAtMs : s.forceChargeLineReOnAppliedAtMs;',
    to: '  const reOn = lastLineReOnApplied(s) !== false ? s.forceChargeLineReOnAtMs : null; /* MUTANT */',
    why: 'A reference taken inside the grace of the re-ON that did take effect (the pool not yet importing) reads a charging pool as falling.',
  },
  {
    id: 'W1-xxxviii. ★★ a re-ON NOT YET CHECKED read as not applied',
    file: NFC, tests: [T_RISK],
    find: '  const reOn = lastLineReOnApplied(s) !== false ? s.forceChargeLineReOnAtMs : s.forceChargeLineReOnAppliedAtMs;',
    to: '  const reOn = lastLineReOnApplied(s) === true ? s.forceChargeLineReOnAtMs : s.forceChargeLineReOnAppliedAtMs; /* MUTANT */',
    why: 'A re-ON still in its readback grace (it may yet take effect) is judged against the fall that called for it: the push fires on the re-ON working.',
  },
  {
    id: 'W1-xxxix. ★★ the spent budget says "after the panel\'s own stop" with no stop on record',
    file: NTF, tests: [T_RISK],
    find: "tonight${r.panelOffAtMs != null ? \" after the panel's own stop\" : ''}, the most",
    to: "tonight${\" after the panel's own stop\" /* MUTANT */}, the most",
    why: 'Round-4 finding 3: Charge Now switched off in the app twice, re-ONed twice, and the push names a panel stop that never happened.',
  },
  {
    id: 'W1-xl. ★ the spent budget never names the panel\'s stop',
    file: NTF, tests: [T_RISK],
    find: "tonight${r.panelOffAtMs != null ? \" after the panel's own stop\" : ''}, the most",
    to: "tonight${'' /* MUTANT */}, the most",
    why: 'The push hides that the panel stopped the charge at its ceiling.',
  },
  {
    id: 'W1-xli. ★ the at-risk record drops the panel\'s stop',
    file: NFC, tests: [T_RISK],
    find: '    panelOffAtMs: s.forceChargeLinePanelOffAtMs ?? null,\n    reOnRetryPossible:',
    to: '    panelOffAtMs: null, /* MUTANT */\n    reOnRetryPossible:',
    why: 'The same, at the push\'s record: every spent budget reads as app OFFs.',
  },
  /* (review 5) an ON seen on the readback that no ON write of ours explains is waited out; no push inside a handed-back
     re-ON's retry spacing, 'reOnRefused' past its cutoff; a not-applied slot reading ON since is not named. */
  {
    id: 'W1-xlii. ★★★ an ON seen again on the readback never stamped',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    if (prevOff.some((n) => o.slotsOn!.includes(n)) && nowMs - ownOn >= FORCE_CHARGE_ON_VERIFY_AFTER_MS) out.forceChargeLineOnSeenAtMs = nowMs;',
    to: '    /* MUTANT */',
    why: 'Round-5 finding 1: a re-ON applied a minute after its check said not is judged against the fall before it — the night\'s one push ("switching it off and on again … may restart the charge") and the shape log fire on a pool now charging (3,271 shape logs in the close plant\'s reOnLate).',
  },
  {
    id: 'W1-xliii. ★★ the seen ON stamped inside the readback grace of an ON write of ours',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    if (prevOff.some((n) => o.slotsOn!.includes(n)) && nowMs - ownOn >= FORCE_CHARGE_ON_VERIFY_AFTER_MS) out.forceChargeLineOnSeenAtMs = nowMs;',
    to: '    if (prevOff.some((n) => o.slotsOn!.includes(n))) out.forceChargeLineOnSeenAtMs = nowMs; /* MUTANT */',
    why: 'Every re-ON that works moves the trend\'s wait to the minute its slots first read ON: a push on a night that closes under comes later.',
  },
  {
    id: 'W1-xliv. ★★ the readback memory never moves',
    file: NFC, tests: [T_RISK],
    find: '    if (offNow.length !== prevOff.length || offNow.some((n) => !prevOff.includes(n))) out.forceChargeLineOffSlots = offNow;',
    to: '    /* MUTANT */',
    why: 'No slot is ever known OFF, so no ON is ever seen again: finding 1 and finding 4 come back.',
  },
  {
    id: 'W1-xlv. ★ a handed-back re-ON taken as an ON write of ours for the seen ON',
    file: NFC, tests: [T_RISK],
    find: '    const ownOn = (s.forceChargeLineReOnSlots != null && s.forceChargeLineReOnSlots.length > 0 ? s.forceChargeLineReOnAtMs : null)',
    to: '    const ownOn = (s.forceChargeLineReOnAtMs) /* MUTANT */',
    why: 'A re-ON that never reached the panel lends its grace to Charge Now switched on in the app.',
  },
  {
    id: 'W1-xlvi. ★★★ the trend ignores the ON seen on the readback',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '  const lastOn = ownOn != null && seen != null && seen > ownOn ? seen : ownOn;',
    to: '  const lastOn = ownOn; /* MUTANT */',
    why: 'Round-5 finding 4: a person switches Charge Now on as the push asks, and the next tick logs the unmeasured latch ("a slot reading ON that does not import") on their fix (2,476 of 2,483 pushed nights in the close plant).',
  },
  {
    id: 'W1-xlvii. ★ a seen ON older than the last ON of ours waited out instead of it',
    file: NFC, tests: [T_RISK],
    find: '  const lastOn = ownOn != null && seen != null && seen > ownOn ? seen : ownOn;',
    to: '  const lastOn = seen ?? ownOn; /* MUTANT */',
    why: 'An ON seen at 01:30 erases the 03:00 re-ON\'s grace: the push fires on the re-ON working.',
  },
  {
    id: 'W1-xlviii. ★★★ pushed inside a handed-back re-ON\'s retry spacing',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    if (retryAtMs + FORCE_CHARGE_TICK_MS < reOnCutoffMs) return null;',
    to: '    /* MUTANT */',
    why: 'Round-5 findings 2/5: the night\'s only push goes a minute after a rate-limited re-ON, 14 min before the add-on\'s own retry switches Charge Now back on.',
  },
  {
    id: 'W1-xlix. ★★ a handed-back re-ON whose retry the cutoff refuses is never pushed',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    if (retryAtMs + FORCE_CHARGE_TICK_MS < reOnCutoffMs) return null;',
    to: '    return null; /* MUTANT */',
    why: 'A hand-back 30 min before the close: no retry fits before the cutoff, no reference 15 min after it fits before the lead — the line is lost in silence.',
  },
  {
    id: 'W1-l. ★★ the hand-back hold outlives its spacing',
    file: NFC, tests: [T_RISK],
    find: '    && s.forceChargeLineReOns < FORCE_CHARGE_LINE_REON_MAX && nowMs - reOnAt < FORCE_CHARGE_ON_VERIFY_AFTER_MS;',
    to: '    && s.forceChargeLineReOns < FORCE_CHARGE_LINE_REON_MAX; /* MUTANT */',
    why: 'The retry\'s gates then hold it (the grid unknown) and the night is never pushed: the hold waits for a retry that is not coming.',
  },
  {
    id: 'W1-li. ★★★ a handed-back re-ON with no retry left pushed as the gates',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: "        : handedBack ? 'reOnRefused' : 'reOnHeld';",
    to: "        : 'reOnHeld' as LineAtRiskCause; /* MUTANT (typed: the cause is compared to 'reOnRefused' below) */",
    why: 'The push says "it needs the grid known present, healthy host vitals and a live panel reading" when all three hold.',
  },
  {
    id: 'W1-lii. ★★ the \'reOnRefused\' push gives the gates as its reason',
    file: NTF, tests: [T_RISK],
    find: '          ? "The add-on\'s last try to switch Charge Now back on was refused by its own write cooldown; " + (r.reOnRetryPossible',
    to: "          ? 'The add-on cannot switch Charge Now back on now (it needs the grid known present, healthy host vitals and a live panel reading). ' + ((false as boolean) /* MUTANT */",
    why: 'The same, in the words (the gates, then "its next try would come after …" on every hand-back).',
  },
  {
    id: 'W1-liii. ★ a not-applied slot that reads ON since named as not taking effect',
    file: NFC, tests: [T_RISK],
    find: '  const notApplied = s.forceChargeLineReOnNotAppliedSlots != null ? s.forceChargeLineReOnNotAppliedSlots.filter((n) => !o.slotsOn!.includes(n)) : null;',
    to: '  const notApplied = s.forceChargeLineReOnNotAppliedSlots != null ? [...s.forceChargeLineReOnNotAppliedSlots] : null; /* MUTANT */',
    why: 'The push says slot 1 "did not take effect" while it reads Charge Now ON.',
  },
  {
    id: 'W1-liv. ★ a restart drops the ON seen on the readback',
    file: ACT, tests: [T_RISK],
    find: '    forceChargeLineOnSeenAtMs: num(o.forceChargeLineOnSeenAtMs),',
    to: '    forceChargeLineOnSeenAtMs: null, /* MUTANT */',
    why: 'An add-on restart after a late apply re-opens the readings before it: finding 1 after every restart.',
  },
  {
    id: 'W1-lv. ★ a restart drops the readback memory',
    file: ACT, tests: [T_RISK],
    find: '    forceChargeLineOffSlots: slotList(o.forceChargeLineOffSlots),',
    to: '    forceChargeLineOffSlots: null, /* MUTANT */',
    why: 'A slot switched on in the app across a restart is never seen ON again.',
  },
  /* (review 6) the hand-back hold counts the ticks at their cadence; a slot seen ON again opens a new panel-stop episode. */
  {
    id: 'W1-lvi. ★★★ the hand-back hold takes the retry at the stamp + 15 min',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    const retryAtMs = nowMs + ticks * FORCE_CHARGE_TICK_MS;',
    to: '    const retryAtMs = reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS; /* MUTANT */',
    why: 'Round-6 finding 1 (eed0363a\'s rule), now under the full tick of margin: the projection a tick sooner than the tick that brings the retry spends the margin, so a hand-back stamped a few ms after its tick, the ticks drifting, waits for a tick that lands on the cutoff — neither; and a push-then-retry band held instead (the pinned counts move).',
  },
  {
    id: 'W1-lvii. ★★ the retry\'s tick counted a tick early',
    file: NFC, tests: [T_RISK],
    find: '    const ticks = Math.ceil((reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS - nowMs) / FORCE_CHARGE_TICK_MS);',
    to: '    const ticks = Math.floor((reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS - nowMs) / FORCE_CHARGE_TICK_MS); /* MUTANT */',
    why: 'The retry\'s tick counted a tick early (under a tick to go, none): the margin spent — a hand-back whose retry\'s tick is due within a tick of the cutoff is held for it, and the push is late or lost.',
  },
  {
    id: 'W1-lviii. ★★ a retry due on the cutoff instant itself is held for',
    file: NFC, tests: [T_RISK],
    find: '    if (retryAtMs + FORCE_CHARGE_TICK_MS < reOnCutoffMs) return null;',
    to: '    if (retryAtMs + FORCE_CHARGE_TICK_MS <= reOnCutoffMs) return null; /* MUTANT */',
    why: 'The margin\'s edge held for: a retry\'s tick exactly a tick before the cutoff waits, and the next tick reads at or past it when it runs late — the edge belongs to the push.',
  },
  {
    id: 'W1-lix. ★★ the hold gives up a tick early (one tick of margin past the real one)',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    const retryAtMs = nowMs + ticks * FORCE_CHARGE_TICK_MS;',
    to: '    const retryAtMs = reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS + FORCE_CHARGE_TICK_MS; /* MUTANT */',
    why: 'The hold gives up a tick early: a hand-back the full-tick margin holds for is pushed at once, then retried (more push-then-retry than the margin needs: the pinned counts move).',
  },
  {
    id: 'W1-lx. ★ index.ts: the actuation tick on a cadence the hold does not count',
    file: IDX, tests: [T_RISK],
    find: '  const nightActuationTick = setInterval(() => { void runNightActuationTick(); }, FORCE_CHARGE_TICK_MS);',
    to: '  const nightActuationTick = setInterval(() => { void runNightActuationTick(); }, 2 * FORCE_CHARGE_TICK_MS); /* MUTANT */',
    why: 'The hold counts 60-s ticks while the retry waits for 120-s ones: the 16th count is the 8th tick, and the loss of W1-lvi returns with every lag.',
  },
  {
    id: 'W1-lxi. ★★★ a slot seen ON again never opens a new panel-stop episode',
    file: NFC, tests: [T_RISK],
    find: '      || (seenOn != null && seenOn > prev);',
    to: '      || false; /* MUTANT */',
    why: 'Round-6 finding 2: a person switches Charge Now on after the push, the panel stops it at its ceiling 45 min later, and the morning says the force-charge ran to the window close.',
  },
  {
    id: 'W1-lxii. ★★ a slot seen ON before the recorded stop re-opens it',
    file: NFC, tests: [T_RISK],
    find: '      || (seenOn != null && seenOn > prev);',
    to: '      || (seenOn != null); /* MUTANT */',
    why: 'Every all-OFF reading at the ceiling after the stop moves the stop later: the morning names the last reading, not the stop.',
  },
  /* (review 8) the hold keeps a full tick of margin; the push judged on the hand-back's own tick; its words keyed on whether a
     tick can still bring the retry. (Review 7's W1-lxiii..lxv retired: the tolerance and the count's max(1) are gone.) */
  {
    id: 'W1-lxvi. ★★★ no margin: held while the retry\'s tick falls before the cutoff (36beb4b8\'s rule)',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: '    if (retryAtMs + FORCE_CHARGE_TICK_MS < reOnCutoffMs) return null;',
    to: '    if (retryAtMs < reOnCutoffMs) return null; /* MUTANT */',
    why: 'Round-7 final finding 1 again: a hand-back held for a tick due just before the cutoff, which runs or reads late onto it — neither the retry nor the push.',
  },
  {
    id: 'W1-lxvii. ★★ half a tick of margin',
    file: NFC, tests: [T_RISK],
    find: '    if (retryAtMs + FORCE_CHARGE_TICK_MS < reOnCutoffMs) return null;',
    to: '    if (retryAtMs + FORCE_CHARGE_TICK_MS / 2 < reOnCutoffMs) return null; /* MUTANT */',
    why: 'A retry\'s tick 30-60 s before the cutoff is held for: a tick read late by its band\'s width gets neither (the margin is the cadence, not a guess at lateness).',
  },
  {
    id: 'W1-lxviii. ★★★ the hedged words back to "it does not try again tonight"',
    file: NTF, tests: [T_RISK],
    find: '            ? `it may try once more before ~${o.reOnCutoffText} if the cooldown allows. `',
    to: "            ? 'it does not try again tonight. ' /* MUTANT */",
    why: 'Round-7 final finding 2: a push due within a tick of the cutoff says no retry comes, and the add-on switches Charge Now back on a minute later.',
  },
  {
    id: 'W1-lxix. ★★★ every \'reOnRefused\' push says the add-on may try once more (2b25a470\'s words)',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: "    reOnRetryPossible: cause === 'reOnRefused' && reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS < reOnCutoffMs,",
    to: "    reOnRetryPossible: cause === 'reOnRefused', /* MUTANT */",
    why: 'A hand-back 25 min before the close: lineReOnDue refuses every later tick, and the push tells a person the add-on may still switch Charge Now back on (374 of the plant\'s 429 pushes).',
  },
  {
    id: 'W1-lxx. ★★ no \'reOnRefused\' push says the add-on may try once more',
    file: NFC, tests: [T_RISK, T_CLOSE],
    find: "    reOnRetryPossible: cause === 'reOnRefused' && reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS < reOnCutoffMs,",
    to: '    reOnRetryPossible: false, /* MUTANT */',
    why: 'A push saying its next try would come after the cutoff, then the retry before it (the 25 retried in the plant).',
  },
  {
    id: 'W1-lxxi. ★★ the retry possible with its spacing ending ON the cutoff',
    file: NFC, tests: [T_RISK],
    find: "    reOnRetryPossible: cause === 'reOnRefused' && reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS < reOnCutoffMs,",
    to: "    reOnRetryPossible: cause === 'reOnRefused' && reOnAt! + FORCE_CHARGE_ON_VERIFY_AFTER_MS <= reOnCutoffMs, /* MUTANT */",
    why: 'lineReOnDue refuses AT the cutoff: a hand-back whose spacing ends exactly there is told the add-on may try once more.',
  },
  {
    id: 'W1-lxxii. ★★★ index.ts: the hand-back\'s own tick not judged for the push',
    file: IDX, tests: [T_RISK],
    find: '    if (allLimited) judgeLineNight();',
    to: '    /* MUTANT */',
    why: 'The last-tick residual returns: a hand-back on the last tick before the cutoff has no later tick before the lead — neither the retry nor the push (18 nights in the plant).',
  },
  {
    id: 'W1-lxxiii. ★★ index.ts: the push names the close, not the re-ON\'s cutoff',
    file: IDX, tests: [T_RISK],
    find: '      const reOnCutoffText = fmtSiteClock(risk.closeAtMs - FORCE_CHARGE_ON_RETRY_CUTOFF_MS);',
    to: '      const reOnCutoffText = fmtSiteClock(risk.closeAtMs); /* MUTANT */',
    why: '"It may try once more before ~5:00 AM": the add-on switches nothing back on after 4:40.',
  },
  {
    id: 'W1-lxxiv. ★ index.ts: the log line says every hand-back may try once more',
    file: IDX, tests: [T_RISK],
    find: "        ? `its last re-ON was refused by its own write cooldown and ${risk.reOnRetryPossible ? `it may try once more before ${reOnCutoffText}` : `its next try would come after ${reOnCutoffText}, the re-ON's cutoff`} (reOnRefused)`",
    to: "        ? `its last re-ON was refused by its own write cooldown and ${(true as boolean) ? `it may try once more before ${reOnCutoffText}` : `its next try would come after ${reOnCutoffText}, the re-ON's cutoff`} (reOnRefused)` /* MUTANT */",
    why: 'The log reads as a retry still to come on a night none can.',
  },

  /* ── (review 2) W5: a cost-dominant line night; the declined start across restarts; the apply failure ── */
  {
    id: 'W5-i. ★★★ index.ts: the ON-failure push keyed on the stamped mode (a cost-dominant line night reads "No action needed")',
    file: IDX, tests: [T_LINE, T_RISK],
    find: '        ...forceChargeOnFailureNight(state),',
    to: "        ...(state.forceChargeMode === 'line' ? forceChargeOnFailureNight(state) : { ceilingPct: state.forceChargeCeilingPct, lineLinePct: null }), /* MUTANT */",
    why: 'Finding 1: a Thursday line night whose ON fails is told no action is needed, though Charge Now by hand would hold the line.',
  },
  {
    id: 'W5-ii. ★★★ the record\'s line is never read (no line-ask night)',
    file: NFC, tests: [T_RISK],
    find: '  if (ask == null || !Number.isFinite(ask) || !(ask > RESERVE_WRITE_MAX_PCT)) return null;\n  const line = s.forceChargeLinePct;',
    to: '  if (ask === ask) return null; /* MUTANT */\n  const line = s.forceChargeLinePct;',
    why: 'Every line-night text falls back to the cost night\'s words.',
  },
  {
    id: 'W5-iii. ★★★ the declined-start push on line-mode nights only (finding 1)',
    file: NFC, tests: [T_RISK],
    find: '  const applies = live && gates.line && forceChargeLineNightPct(s) != null && forceChargeModeOf(s, gates) != null;',
    to: "  const applies = live && gates.line && forceChargeLineNightPct(s) != null && forceChargeModeOf(s, gates)?.kind === 'line'; /* MUTANT */",
    why: 'Red vitals hold a cost-dominant line night\'s start all night with no push.',
  },
  {
    id: 'W5-iv. ★★★ the declined-start memory not seeded from the record (finding 9)',
    file: NFC, tests: [T_RISK],
    find: '    : { ...EMPTY_LINE_DECLINED_PUSH, pushed: [...(s.forceChargeLineDeclinedPushed ?? [])] };',
    to: '    : EMPTY_LINE_DECLINED_PUSH; /* MUTANT */',
    why: 'A crash-looping add-on under red vitals pushes the same warning once per restart.',
  },
  {
    id: 'W5-v. ★★★ index.ts: the pushed class not on the record before the push goes',
    file: IDX, tests: [T_RISK],
    find: '      persistNightActuation({ ...nightActuationMem, forceChargeLineDeclinedPushed: [...dp.mem.st.pushed] });',
    to: '      /* MUTANT */',
    why: 'The same, at the wiring.',
  },
  {
    id: 'W5-vi. ★★ the record drops the pushed classes on load',
    file: ACT, tests: [T_RISK],
    find: "      ? [...new Set(o.forceChargeLineDeclinedPushed.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 64))]",
    to: '      ? [] as string[] /* MUTANT */',
    why: 'The same, at the restart.',
  },
  {
    id: 'W5-vii. ★★ the declined-start push before the reserve write verified',
    file: NFC, tests: [T_RISK],
    find: '  const live = s.appliedAtMs != null && s.applyVerifiedAtMs != null && s.revertedAtMs == null && !s.cancelled',
    to: '  const live = s.appliedAtMs != null && s.revertedAtMs == null && !s.cancelled /* MUTANT */',
    why: 'The force-charge rides only a verified reserve write; that wait is no blocker to push.',
  },
  {
    id: 'W5-viii. ★★★ the reserve-apply failure on a line night says "No action needed" (finding 6)',
    file: NTF, tests: [T_RISK],
    find: '  const tail = line == null',
    to: '  const tail = true /* MUTANT */',
    why: 'A 55.55% line night whose reserve write never took is told no action is needed, its pool on a 30% floor.',
  },
  {
    id: 'W5-ix. ★★★ index.ts: the reserve-apply failure is built without the line',
    file: IDX, tests: [T_RISK],
    find: '        linePct: forceChargeLineNightPct(state),\n      }));',
    to: '      })); /* MUTANT */',
    why: 'The same, at the wiring.',
  },

  /* ── (review 2) W3: the morning account of a line-ask night ── */
  {
    id: 'W3-i. ★★★ a close under the line not said so',
    file: NTF, tests: [T_RISK],
    find: ", under the ${round1(linePct)}% outage line` : ''}`;",
    to: "` : ''}`; /* MUTANT */",
    why: 'Finding 5: "ran to the window close for the 55.6% outage line; the pool read 51% at the close" — read as held.',
  },
  {
    id: 'W3-ii. ★★★ an unread close is silence',
    file: NTF, tests: [T_RISK],
    find: "      : closeRead == null ? '; the pool was not read at the close (no fresh panel reading)'",
    to: "      : closeRead == null ? '' /* MUTANT */",
    why: 'A stale readback at the restore and the account reads as carried.',
  },
  {
    id: 'W3-iii. ★★★ a cost-dominant line night\'s close never stated (the record\'s line ignored)',
    file: NTF, tests: [T_RISK],
    find: '    const linePct = o.linePct != null && Number.isFinite(o.linePct) ? o.linePct : line?.linePct ?? null;',
    to: '    const linePct = line?.linePct ?? null; /* MUTANT */',
    why: 'A Thursday line night closing at 62% under its 69.4% line reads "force-charge ran toward ~90%".',
  },
  {
    id: 'W3-iv. ★★★ index.ts: the close read only in line mode',
    file: IDX, tests: [T_RISK],
    find: '  const lineNight = forceChargeLineNightPct(state);',
    to: "  const lineNight = state.forceChargeMode === 'line' ? forceChargeLineNightPct(state) : null; /* MUTANT */",
    why: 'The same, at the wiring.',
  },
  {
    id: 'W3-v. ★★ the panel\'s own stop never named',
    file: NTF, tests: [T_RISK],
    find: '    const panelEnded = panelAt != null && !resumedSince(panelAt) && !(early && offAt != null && offAt <= panelAt);',
    to: '    const panelEnded = false; /* MUTANT */',
    why: 'A charge the panel ended at 03:10 is said to have run to the window close.',
  },
  {
    id: 'W3-vi. ★★ the panel\'s stop said to end a charge a later re-ON resumed',
    file: NTF, tests: [T_RISK],
    find: '!resumedSince(panelAt)',
    to: 'true /* MUTANT */',
    why: 'A night switched back on at 02:30 that charged to the close is said to have stopped at 02:00.',
  },
  {
    id: 'W3-vii. ★★ the re-ONs never named',
    file: NTF, tests: [T_RISK],
    find: '    const reOnText = reOns > 0',
    to: '    const reOnText = false /* MUTANT */',
    why: 'The account hides that the panel stopped the charge and the add-on switched it back on.',
  },
  {
    id: 'W3-viii. ★★ a re-ON that did not take effect never named',
    file: NTF, tests: [T_RISK],
    find: '${reOnsNotApplied > 0 ?',
    to: '${false /* MUTANT */ ?',
    why: 'The same, for the re-ON the panel never took.',
  },
  {
    id: 'W3-ix. ★★ the outcome drops the panel\'s stop',
    file: NFC, tests: [T_RISK],
    find: '      panelOffAtMs: s.forceChargeLinePanelOffAtMs ?? null, reOns: s.forceChargeLineReOns ?? 0,',
    to: '      panelOffAtMs: null, reOns: s.forceChargeLineReOns ?? 0, /* MUTANT */',
    why: 'The same, at the outcome.',
  },
  /* (review 3) a re-ON resumes the charge only when it took effect; the panel's stop named only when on record. */
  {
    id: 'W3-x. ★★★ a re-ON that did not take effect read as resuming the charge',
    file: NTF, tests: [T_RISK],
    find: '    const reOnResumed = line?.lastReOnApplied !== false;',
    to: '    const reOnResumed = true; /* MUTANT */',
    why: 'Round-3 finding 2: the panel stopped the charge at 01:00, both re-ONs failed, and the morning says it ran to the window close.',
  },
  {
    id: 'W3-xi. ★★ the outcome drops the last re-ON\'s verdict',
    file: NFC, tests: [T_RISK],
    find: '      lastReOnApplied: lastLineReOnApplied(s),',
    to: '      lastReOnApplied: null, /* MUTANT */',
    why: 'The same, at the outcome.',
  },
  {
    id: 'W3-xii. ★★ a re-ON that never reached the panel (every write rate-limited) read as resuming',
    file: NFC, tests: [T_RISK],
    find: '  if (slots == null || slots.length === 0) return false;',
    to: '  if (slots == null || slots.length === 0) return null; /* MUTANT */',
    why: 'A re-ON handed back unwritten still moves the last re-ON past the panel\'s stop: "ran to the window close".',
  },
  {
    id: 'W3-xiii. ★★ a re-ON that took on one slot read as not resuming',
    file: NFC, tests: [T_RISK],
    find: '  return slots.some((n) => !notApplied.includes(n));',
    to: '  return notApplied.length === 0; /* MUTANT */',
    why: 'A charge resumed on slot 1 is said to have ended at the panel\'s stop.',
  },
  {
    id: 'W3-xiv. ★ a check of the re-ON before the last judges the last',
    file: NFC, tests: [T_RISK],
    find: '  if (checked == null || checked < at || notApplied == null) return null;',
    to: '  if (checked == null || notApplied == null) return null; /* MUTANT */',
    why: 'The first re-ON\'s verdict is read as the second\'s.',
  },
  {
    id: 'W3-xv. ★★ "after the panel\'s own stop" with no stop on record',
    file: NTF, tests: [T_RISK],
    find: "${panelAt != null ? \" after the panel's own stop\" : ''}",
    to: "${\" after the panel's own stop\" /* MUTANT */}",
    why: 'Round-3 finding 2: a re-ON after a slot switched off in the app is reported after a panel stop that never happened.',
  },
  /* (review 4) every re-ON after the stop counts; no stop and no re-ON that took: never "ran to the window close". */
  {
    id: 'W3-xvi. ★★★ only the LAST re-ON can resume the charge',
    file: NTF, tests: [T_RISK],
    // (review 5) anchor moved: the seen ON follows on the next line.
    find: ' || (appliedAt != null && appliedAt >= t)\n      || (seenAt != null && seenAt >= t);',
    to: '\n      || (seenAt != null && seenAt >= t); /* MUTANT */',
    why: 'Round-4 finding 2(a): the panel stopped at 01:00, a 02:00 re-ON resumed the charge, a 04:00 one failed — "until the panel\'s own stop switched Charge Now off at 1am".',
  },
  {
    id: 'W3-xvii. ★★★ every re-ON failed with no stop on record: "ran to the window close"',
    file: NTF, tests: [T_RISK],
    // (review 5) anchor moved: the read-off is the last re-ON's.
    find: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn);',
    to: '    const readOff = false; /* MUTANT */',
    why: 'Round-4 finding 2(b): Charge Now read off from before the first re-ON, and the morning says it ran to the close.',
  },
  {
    // (review 5) INVERTED: the review-4 rule (no re-ON that ever took) is now the defect — round-5 findings 3 and 6.
    id: 'W3-xviii. ★★★ the read-off judged by any re-ON that ever took, not the last',
    file: NTF, tests: [T_RISK],
    find: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn);',
    to: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && appliedAt == null && !(seenAt != null && seenAt >= lastReOn); /* MUTANT */',
    why: 'Round-5 findings 3/6: re-ON 1 took, re-ON 2 (every slot of ours) was checked not applied with the budget spent, Charge Now read off 2 h 15 min before the close — and the morning says it "ran to the window close".',
  },
  {
    id: 'W3-xix. ★★ the read-off said beside the panel\'s stop or an early OFF',
    file: NTF, tests: [T_RISK],
    // (review 5) anchor moved.
    find: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn);',
    to: '    const readOff = lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn); /* MUTANT */',
    why: 'Two endings in one sentence: "until the panel\'s own stop … at 1am; Charge Now read off … before the window close".',
  },
  {
    id: 'W3-xx. ★ the read-off names no slot',
    file: NTF, tests: [T_RISK],
    find: "${offSlots.length > 0 ? ` on slot(s) ${offSlots.join(', ')}` : ''}",
    to: "${'' /* MUTANT */}",
    why: 'The account does not say which slots the add-on could not switch back on.',
  },
  {
    id: 'W3-xxi. ★ the outcome drops the re-ON that took effect',
    file: NFC, tests: [T_RISK],
    find: '      reOnAppliedAtMs: s.forceChargeLineReOnAppliedAtMs ?? null,',
    to: '      reOnAppliedAtMs: null, /* MUTANT */',
    why: 'The same as W3-xvi, at the outcome.',
  },
  /* (review 5) the read-off is the last re-ON's, unless a slot read ON again after it; a seen ON after the stop resumed the
     charge; the outcome names only the last re-ON's check. */
  {
    id: 'W3-xxii. ★★ the panel\'s stop said to end a charge Charge Now was seen back on after',
    file: NTF, tests: [T_RISK],
    find: '      || (seenAt != null && seenAt >= t);',
    to: '      || false; /* MUTANT */',
    why: 'Charge Now switched on in the app at 03:00 after the 01:00 stop, and the morning says the 01:00 stop ended the charge.',
  },
  {
    id: 'W3-xxiii. ★★ the read-off said after a slot of ours read ON again',
    file: NTF, tests: [T_RISK],
    find: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn);',
    to: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed; /* MUTANT */',
    why: 'A re-ON applied late (its slots read ON after the check) is reported as Charge Now reading off to the close.',
  },
  {
    id: 'W3-xxiv. ★ a slot seen ON before the last re-ON cancels its read-off',
    file: NTF, tests: [T_RISK],
    find: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null && seenAt >= lastReOn);',
    to: '    const readOff = !panelEnded && !early && lastReOn != null && !reOnResumed && !(seenAt != null); /* MUTANT */',
    why: 'A slot seen back on at 01:30, OFF again by 02:30 (the re-ON then written to it, not applied), reads as "ran to the window close".',
  },
  {
    id: 'W3-xxv. ★ the outcome names a stale check\'s slots after a hand-back',
    file: NFC, tests: [T_RISK],
    find: '      reOnNotAppliedSlots: lastLineReOnJudged(s) ? [...s.forceChargeLineReOnNotAppliedSlots!] : null,',
    to: '      reOnNotAppliedSlots: s.forceChargeLineReOnNotAppliedSlots != null ? [...s.forceChargeLineReOnNotAppliedSlots] : null, /* MUTANT */',
    why: 'The read-off after a re-ON handed back names the slot an EARLIER re-ON\'s check found off.',
  },
  {
    id: 'W3-xxvi. ★ the outcome drops the ON seen on the readback',
    file: NFC, tests: [T_RISK],
    find: '      onSeenAtMs: s.forceChargeLineOnSeenAtMs ?? null,',
    to: '      onSeenAtMs: null, /* MUTANT */',
    why: 'The same as W3-xxii and W3-xxiii, at the outcome.',
  },
  {
    id: 'W3-xxvii. ★ a check older than the last re-ON judges its slots',
    file: NFC, tests: [T_RISK],
    find: '    && checked != null && checked >= at && s.forceChargeLineReOnNotAppliedSlots != null;',
    to: '    && checked != null && s.forceChargeLineReOnNotAppliedSlots != null; /* MUTANT */',
    why: 'The first re-ON\'s not-applied slots are named as the last one\'s.',
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
    find: "        : expected.mode === 'line'\n          ? ` ${envelopeHead}, so the panel's force-charge ${lineStartText}stays on",
    to: "        : forceChargeLine != null /* MUTANT */\n          ? ` ${envelopeHead}, so the panel's force-charge ${lineStartText}stays on",
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
    // v1.200.0 (review 2) — anchor moved: the record's ⌈L⌉ (a cost-dominant night has no line mode to read it from).
    find: 'lineLatestStartMs(endMs, state.forceChargeLineAskPct!, ',
    to: 'lineLatestStartMs(endMs, state.forceChargeLineAskPct! + 5, /* MUTANT */ ',
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
    // v1.200.0 (review 2) — anchor moved: the outcome also carries the panel's stop and the re-ONs.
    find: '      ...line, offReason: s.forceChargeOffReason ?? null, offAtMs: s.forceChargeOffAtMs ?? null,',
    to: '      ...line, /* MUTANT */',
    why: 'The same, at the outcome.',
  },
  {
    id: 'T-xv. ★★ the push\'s note not worded by what the walk cannot hold (a line above a full pool told it is within 10 points)',
    file: NTF, tests: [T_LINE],
    // (A5) re-anchored on the kind branch.
    find: "    if (kind === 'aboveFull') return ` NOTE: ${line} is above a full pool, so no charge can hold it — residual risk remains.`;",
    to: "    if (kind === 'aboveFull') return ` NOTE: ${line} is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin — residual risk remains.`; /* MUTANT */",
    why: 'A 101.6% line no charge can hold is pushed as one held without its usual margin.',
  },
  {
    id: 'T-xvi. ★★ the card\'s tail not worded by what the walk cannot hold (a line above a full pool told it is within 10 points)',
    file: CARD, tests: [T_LINE],
    // (A5) re-anchored on the kind branch.
    find: "    : kind === 'aboveFull' ? ' — the line is above a full pool; residual risk remains'",
    to: "    : kind === 'aboveFull' ? ' — within 10 points of a full pool, not held with its usual margin; residual risk remains' /* MUTANT */",
    why: 'The card says a line above a full pool is held without its usual margin.',
  },
  {
    id: 'T-xvii. ★★ the rationale says the force-charge "stays on until the window closes" when it is not expected to start',
    file: NCA, tests: [T_LINE],
    // (A5) re-anchored: the line-mode sentence is its own expression (the NOTE follows it).
    find: "  const lineModeNote: string | null = expected.mode === 'line' && expected.forceChargeStartMs === null",
    to: "  const lineModeNote: string | null = false && expected.mode === 'line' && expected.forceChargeStartMs === null /* MUTANT */",
    why: 'A force-charge that never switches on is said to stay on.',
  },
  {
    id: 'T-xviii. ★★ the card says "stays on to the window close" when it is not expected to start',
    file: CARD, tests: [T_LINE],
    find: '    if (plan.expectedForceChargeStartMs === null) {',
    to: '    if (plan.expectedForceChargeStartMs === null && plan.cushionLineSocPct === -1) { /* MUTANT */',
    why: 'The same on the card.',
  },
  /* (review 2, finding 4) a walk that reaches the panel ceiling: the panel switches Charge Now off there; the texts say so. */
  {
    id: 'T-xix. ★★ the walk never reports reaching the panel ceiling',
    file: NCA, tests: [T_LINE],
    find: '  return { closeKwh: pack, startMs, startPackKwh: startMs != null ? startPackKwh : pack, gridKwh, ceilingReached: reached || latched };',
    to: '  return { closeKwh: pack, startMs, startPackKwh: startMs != null ? startPackKwh : pack, gridKwh, ceilingReached: false }; /* MUTANT */',
    why: 'Every line night is told the force-charge stays on until the window closes, and the panel\'s own stop at 80% is called a backstop.',
  },
  {
    id: 'T-xx. ★★ the plan claims the panel\'s stop on every started line walk',
    file: NCA, tests: [T_LINE],
    find: "  const lineCeilingStop = expected.mode === 'line' && expected.ceilingStop === true && expected.forceChargeStartMs != null",
    to: "  const lineCeilingStop = expected.mode === 'line' && expected.forceChargeStartMs != null /* MUTANT */",
    why: 'A night whose pool stays under the ceiling is told the panel switches it off at 80% and the add-on switches it back on.',
  },
  {
    id: 'T-xxi. ★★ the rationale\'s reserve sentence says "stays on until the window closes" on a walk that reaches the ceiling',
    file: NCA, tests: [T_LINE],
    find: "      : expected.mode === 'line' && lineCeilingStop != null",
    to: "      : expected.mode === 'line' && lineCeilingStop != null && expected.levelPct === -1 /* MUTANT */",
    why: 'The 2026-10-29 night says Charge Now stays on to 05:00; the app shows it off from ~02:00 and the pool falling.',
  },
  {
    id: 'T-xxii. ★★ the rationale\'s expected sentence says "runs to the window close" on a walk that reaches the ceiling',
    file: NCA, tests: [T_LINE],
    find: '      if (lineCeilingStop != null) {',
    to: '      if (lineCeilingStop != null && level < 0) { /* MUTANT */',
    why: 'Two sentences of one rationale disagree on whether Charge Now stays on.',
  },
  {
    id: 'T-xxiii. ★★ the push says "keeps it on until the window closes" on a walk that reaches the ceiling',
    file: NTF, tests: [T_LINE],
    find: '    if (stop != null) {\n      return `Then, ${at}, it switches',
    to: '    if (stop != null && stop.ceilingPct < 0) { /* MUTANT */\n      return `Then, ${at}, it switches',
    why: 'The evening push calls the 80% ceiling a backstop on a night expected to stop there.',
  },
  {
    id: 'T-xxiv. ★★ the card says "stays on to the window close" on a walk that reaches the ceiling',
    file: CARD, tests: [T_LINE],
    find: '    if (stop != null) {\n      return `outage line ${lineText(',
    to: '    if (stop != null && stop.ceilingPct < 0) { /* MUTANT */\n      return `outage line ${lineText(',
    why: 'The same on the card.',
  },
  {
    id: 'T-xxv. ★ the 21:30 line calls the ceiling a backstop on a walk that reaches it (index.ts never passes the stop)',
    file: IDX, tests: [T_LINE],
    find: '      ceilingStop: plan?.expectedLineCeilingStop != null,',
    to: '      ceilingStop: false, /* MUTANT */',
    why: 'The armed line in the log says Charge Now runs to the close behind an 80% backstop on a night expected to stop there.',
  },
  {
    id: 'T-xxvi. ★ the 21:30 line ignores the ceiling stop it is given',
    file: NFC, tests: [T_LINE],
    find: '  if (o.ceilingStop === true) {',
    to: '  if (o.ceilingStop === true && o.linePct < 0) { /* MUTANT */',
    why: 'The same, in the note itself.',
  },

  /* ── G: the gate ── */
  {
    id: 'G-i. ★★ the gate exempts carried rows',
    file: GATE, tests: [T_LINE],
    // (A5) re-anchored: the disclosed rows' rule is armedNeverRanUnder now.
    find: '    if (truthy(r.cushion_shortfall)) return armedNeverRanUnder(r);',
    to: '    if (asNum(r.cushion_line_force_charge_pct) != null && !truthy(r.cushion_shortfall)) return false; /* MUTANT */ if (truthy(r.cushion_shortfall)) return armedNeverRanUnder(r);',
    why: 'A line night that closed under its line is never a strike: AUTO graduates on unheld cushions.',
  },

  /* ── (A5) the line armed whatever the ask; carried only where its own reachable walk holds ── */
  {
    id: 'A5-i. ★★★ the cut restored: a line within 10 points of full is not armed',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  const lineArmed = lineQualifies && lineEligible === true;',
    to: '  const lineArmed = lineQualifies && lineEligible === true && lineAsk + 2 * FORCE_CHARGE_LINE_HEADROOM_PCT <= 100; /* MUTANT */',
    why: 'More cushion switches the force-charge off: 2026-10-29 at 15 h stores ~43 kWh less than at 14 h (ITEM 5).',
  },
  {
    id: 'A5-ii. ★★★ no closeUnder: a sized night whose own walk closes under its line is carried',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, cushionLineSocPct);',
    to: '  const lineCloseUnder = false; /* MUTANT */',
    why: 'The plan claims a 68.85% line its own walk closes at ~57.3% (ITEM 6).',
  },
  {
    id: 'A5-iii. ★★★ closeUnder also where the sizing fell short (the caps note doubled into the envelope)',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, cushionLineSocPct);',
    to: '  const lineCloseUnder = lineArmed && !lineNearFull && !lineWalkHolds(expected.levelPct, cushionLineSocPct); /* MUTANT */',
    why: 'Hundreds of carried nights already disclosed by their caps note change cause and ledger column (and move plans A5 must not).',
  },
  {
    id: 'A5-iv(a). ★★ closeUnder judged against ⌈L⌉, not the line',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, cushionLineSocPct);',
    to: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, lineAsk); /* MUTANT */',
    why: 'A walk holding the line by less than a point is disclosed as under it.',
  },
  {
    id: 'A5-iv(b). ★★ closeUnder judged against the start target, not the line',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, cushionLineSocPct);',
    to: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, expected.startTargetPct ?? cushionLineSocPct); /* MUTANT */',
    why: 'Every night drawn back under ⌈L⌉ + 5 after the panel\'s stop is disclosed as under its line.',
  },
  {
    id: 'A5-v(a). ★★ the carry tolerance\'s sign flipped',
    file: NCA, tests: [T_LINE],
    find: '  return closePct == null || closePct >= linePct - LINE_CARRY_CLOSE_TOLERANCE_PCT - LINE_CLOSE_EDGE_EPS;',
    to: '  return closePct == null || closePct >= linePct + LINE_CARRY_CLOSE_TOLERANCE_PCT - LINE_CLOSE_EDGE_EPS; /* MUTANT */',
    why: 'A walk closing on the line is called under it; the scorer would call it held.',
  },
  {
    id: 'A5-v(b). ★★ the carry tolerance dropped',
    file: NCA, tests: [T_LINE],
    find: '  return closePct == null || closePct >= linePct - LINE_CARRY_CLOSE_TOLERANCE_PCT - LINE_CLOSE_EDGE_EPS;',
    to: '  return closePct == null || closePct >= linePct - LINE_CLOSE_EDGE_EPS; /* MUTANT */',
    why: 'The plan and the scorer disagree on a close within half a reading step of the line.',
  },
  {
    id: 'A5-v(c). ★★ the carry edge\'s float slack dropped (a close exactly at L − 0.05 read as under it)',
    file: NCA, tests: [T_LINE],
    find: '  return closePct == null || closePct >= linePct - LINE_CARRY_CLOSE_TOLERANCE_PCT - LINE_CLOSE_EDGE_EPS;',
    to: '  return closePct == null || closePct >= linePct - LINE_CARRY_CLOSE_TOLERANCE_PCT; /* MUTANT */',
    why: '50.35 − 0.05 is 50.300000000000004: a carried night closing at 50.3 against a 50.35% line is disclosed under it, against the stated rule (128 of 501 edge pairs).',
  },
  {
    id: 'A5-v(d). ★★ the scorer\'s edge slack dropped',
    file: GATE, tests: [T_LINE],
    find: '  readingPct >= linePct - REALIZED_CLOSE_TOLERANCE_PCT - LINE_CLOSE_EDGE_EPS;',
    to: '  readingPct >= linePct - REALIZED_CLOSE_TOLERANCE_PCT; /* MUTANT */',
    why: 'A 50.3% close against a 50.35% line is a strike, though the rule (at or above L − 0.05) calls it held.',
  },
  {
    id: 'A5-vi. ★★★ the near-full start target max(t, ⌈L⌉ + H) (at or above the 100% ceiling)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H > 100 ? 100 - H : Math.max(t, ask! + H),",
    to: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: Math.max(t, ask! + H), /* MUTANT */",
    why: 'A 98% line starts timed to 103%: the first latch is followed at once by a re-ON, both spent within half an hour.',
  },
  {
    id: 'A5-vii. ★★ the near-full start target min(100, ⌈L⌉ + H)',
    file: NFC, tests: [T_LINE, T_CLOSE],
    find: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H > 100 ? 100 - H : Math.max(t, ask! + H),",
    to: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H > 100 ? Math.min(100, ask! + H) : Math.max(t, ask! + H), /* MUTANT */",
    why: 'The re-ON keys on 100: the EV-90 near-full cell closes under on 64 of 120 nights, not 19.',
  },
  {
    id: 'A5-viii. ★★ the near-full arm at ⌈L⌉ + 2H >= 100 (a 90% line under a 98% cost ceiling started to 95)',
    file: NFC, tests: [T_LINE],
    find: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H > 100 ? 100 - H : Math.max(t, ask! + H),",
    to: "      kind: 'line', targetPct: t, askPct: ask!, startTargetPct: ask! + 2 * H >= 100 ? 100 - H : Math.max(t, ask! + H), /* MUTANT */",
    why: 'An ask of 90 under ARB_COST_MAX_SOC_PCT 98 starts to 95, not its cost target 98: the start target falls with no near-full line.',
  },
  {
    id: 'A5-ix. ★★ an armed, disclosed night\'s rationale gets the not-armed sentence',
    file: NCA, tests: [T_LINE],
    find: '  const envelopeNote: string | null = lineDisclosed && !lineArmed',
    to: '  const envelopeNote: string | null = lineDisclosed /* MUTANT */',
    why: 'A night whose force-charge runs to ~99.6% reads "no force-charge runs in advisory mode".',
  },
  {
    id: 'A5-x. ★★ the push: an armed night falls through to "no force-charge carries it"',
    file: NTF, tests: [T_LINE],
    find: '  if (plan.forceChargeLine != null) {\n    const kind = lineNotHeldOf(plan);',
    to: '  if (plan.forceChargeLine != null && plan.cushionLineSocPct === -1) { /* MUTANT */\n    const kind = lineNotHeldOf(plan);',
    why: 'The evening push tells the owner no force-charge carries the line on a night it switches on at 23:00.',
  },
  {
    id: 'A5-xi. ★★ the card: an armed, disclosed night shows the not-armed row',
    file: CARD, tests: [T_LINE],
    find: '  if (plan.cushionShortfallCause != null && !armed) {',
    to: '  if (plan.cushionShortfallCause != null) { /* MUTANT */',
    why: 'The card says "not held tonight" under a title charging to ~99.6%.',
  },
  {
    id: 'A5-xii(a). ★ the 21:30 line: no "Line NOT held"',
    file: NFC, tests: [T_LINE],
    find: "  const tail = o.notHeld == null ? ''",
    to: "  const tail = o.notHeld == null || o.linePct > -1 ? '' /* MUTANT */",
    why: 'The ARMED log line reads as a carried night on a night the plan disclosed.',
  },
  {
    id: 'A5-xii(b). ★ index.ts never passes what the walk cannot hold to the 21:30 line',
    file: IDX, tests: [T_LINE],
    find: '      notHeld: notHeld != null ? { kind: notHeld, closePct: plan?.expectedWriteLevelPct ?? null } : null,',
    to: '      notHeld: null, /* MUTANT */',
    why: 'The same, at the call.',
  },
  {
    id: 'A5-xiii. ★★ the mid-day push\'s note unchanged ("no force-charge carries it" on an armed leg)',
    file: CTX, tests: [T_LINE],
    find: '    + (c.lineAskPct != null\n      ? armedNote(c)',
    to: '    + (c.lineAskPct === -1 /* MUTANT */\n      ? armedNote(c)',
    why: 'A mid-day leg whose force-charge runs is told no force-charge carries its line.',
  },
  {
    id: 'A5-xiv(a). ★ the mid-day shadow record drops what the walk cannot hold',
    file: MSH, tests: [T_LINE],
    find: '    ...(p != null && lineNotHeldOf(p) != null ? { lineNotHeld: lineNotHeldOf(p)! } : {}),',
    to: '    /* MUTANT */',
    why: 'The evening\'s words are chosen without the kind: an armed leg falls back to the generic sentence.',
  },
  {
    id: 'A5-xiv(b). ★ its restore drops it',
    file: MSH, tests: [T_LINE],
    find: "    ...(o.lineNotHeld === 'closeUnder' || o.lineNotHeld === 'aboveFull' || o.lineNotHeld === 'nearFull' ? { lineNotHeld: o.lineNotHeld } : {}),",
    to: '    /* MUTANT */',
    why: 'After a restart the kind is lost.',
  },
  {
    id: 'A5-xiv(c). ★ its restore keeps any value',
    file: MSH, tests: [T_LINE],
    find: "    ...(o.lineNotHeld === 'closeUnder' || o.lineNotHeld === 'aboveFull' || o.lineNotHeld === 'nearFull' ? { lineNotHeld: o.lineNotHeld } : {}),",
    to: "    ...(typeof o.lineNotHeld === 'string' ? { lineNotHeld: o.lineNotHeld as 'closeUnder' } : {}), /* MUTANT */",
    why: 'A value this build does not word is carried into the evening\'s notice.',
  },
  {
    id: 'A5-xiv(d). ★ the evening notice is not told the kind',
    file: MSH, tests: [T_LINE],
    find: '      ...(c.lineNotHeld != null ? { lineNotHeld: c.lineNotHeld } : {}),',
    to: '      /* MUTANT */',
    why: 'The record carries it, the words never see it.',
  },
  {
    id: 'A5-xv. ★ a line above a full pool worded "within 10 points" in the rationale',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: "      ? ` NOTE: tonight's ${cushionLineSocPct}% outage line is above a full pool, so no charge can hold it — residual risk remains.`",
    to: "      ? ` NOTE: tonight's ${cushionLineSocPct}% outage line is within 10 points of a full pool, so the force-charge cannot hold it with its usual margin; the cushion is not assured — residual risk remains.` /* MUTANT */",
    why: 'A 101.57% line no charge can hold is called held without its usual margin.',
  },
  {
    id: 'A5-xvi. ★★ the disclosure judged on the start target the write is timed to (armedWriteLevelPct), not the walk\'s close',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(expected.levelPct, cushionLineSocPct);',
    to: "  const lineCloseUnder = lineArmed && !lineNearFull && !cushionShortfall && !lineWalkHolds(armedWriteLevelPct({ setpointSocPct, costCeilingSocPct, forceChargeLine }, { cost: inputs.forceChargeEligible === true, line: true }), cushionLineSocPct); /* MUTANT */",
    why: 'The floor of the walk is always above the line: no night closing under is ever disclosed.',
  },
  {
    id: 'A5-xvii. ★★★ the H1 cap removed (the walk\'s close stated whatever the window can deliver)',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '    const reachKwh = o.startKwh + deliverable + expectedWindowPvKwh(o.window.hours, o.window.fromMs, o.window.windowEndMs, o.legEff);',
    to: '    const reachKwh = Infinity; /* MUTANT */',
    why: '2026-10-29 at 14 h states ~98.4% and the panel\'s 100% stop from a pool the window can lift to ~92.8% at most.',
  },
  {
    id: 'A5-xviii. ★★ the cap without the P50 PV in the window',
    file: NCA, tests: [T_LINE],
    find: '    const reachKwh = o.startKwh + deliverable + expectedWindowPvKwh(o.window.hours, o.window.fromMs, o.window.windowEndMs, o.legEff);',
    to: '    const reachKwh = o.startKwh + deliverable; /* MUTANT */',
    why: 'A sunny mid-day leg\'s close is capped under what its own sun delivers (no year plan: T21c).',
  },
  {
    id: 'A5-xix. ★★ the panel\'s stop named where the window cannot reach the ceiling',
    file: NCA, tests: [T_LINE],
    find: '    if (reachKwh < (Math.min(100, panelCeilingPct) / 100) * o.fullKwh - 1e-9) delete out.ceilingStop;',
    to: '    if (reachKwh < -1) delete out.ceilingStop; /* MUTANT */',
    why: 'The 21:30 line, the push and the card name a stop at 100% on a night that closes ~92.8%.',
  },
  {
    id: 'A5-xxi. ★★★ the not-held kind keyed on the reason, not the walk\'s close',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: "  if (!lineWalkHolds(p.expectedWriteLevelPct ?? null, l)) return 'closeUnder';",
    to: "  if (p.cushionEnvelopeReason === 'closeUnder') return 'closeUnder'; /* MUTANT */",
    why: 'A near-full night whose walk closes at ~92.8% under its 93.63% line is told it is held without its usual margin.',
  },
  {
    id: 'A5-xxii. ★★ no NOTE on a carried night whose sizing fell short and whose walk closes under',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: "  if (!lineWalkHolds(p.expectedWriteLevelPct ?? null, l)) return 'closeUnder';",
    to: "  if (!lineWalkHolds(p.expectedWriteLevelPct ?? null, l) && p.cushionEnvelopeReason != null) return 'closeUnder'; /* MUTANT */",
    why: 'Its caps note says charge limits; nothing says its own walk closes at ~63.9% under a 65.95% line.',
  },
  {
    id: 'A5-xxiii. ★★★ the gate exempts an armed, disclosed row whose force-charge never switched on',
    file: GATE, tests: [T_LINE],
    find: '    if (truthy(r.cushion_shortfall)) return armedNeverRanUnder(r);',
    to: '    if (truthy(r.cushion_shortfall)) return false; /* MUTANT */',
    why: 'A refused ceiling or Charge Now already on leaves an armed near-full night at 50% and no strike: AUTO graduates on it.',
  },
  {
    id: 'A5-xxiii(b). ★★ …and strikes it though the reserve write never landed (not actuated)',
    file: GATE, tests: [T_LINE],
    find: '    if (asNum(r.cushion_line_force_charge_pct) == null || !truthy(r.actuated) || r.force_charge_on_at_ms != null) return false;',
    to: '    if (asNum(r.cushion_line_force_charge_pct) == null || r.force_charge_on_at_ms != null) return false; /* MUTANT */',
    why: 'A night cancelled before the apply is a strike.',
  },
  {
    id: 'A5-xxiv. ★★ the gate strikes every armed, disclosed under-close (the never-ON condition dropped)',
    file: GATE, tests: [T_LINE],
    find: '    if (asNum(r.cushion_line_force_charge_pct) == null || !truthy(r.actuated) || r.force_charge_on_at_ms != null) return false;',
    to: '    if (asNum(r.cushion_line_force_charge_pct) == null || !truthy(r.actuated)) return false; /* MUTANT */',
    why: 'The physics the plan disclosed (a near-full line closing under) holds the gate shut.',
  },
  {
    id: 'A5-xxv. ★ the gate compares against a line above a full pool, uncapped',
    file: GATE, tests: [T_LINE],
    find: '    if (line != null && close != null) return !holdsLineAtClose(close, Math.min(line, 100));',
    to: '    if (line != null && close != null) return !holdsLineAtClose(close, line); /* MUTANT */',
    why: 'A 101.57% line held at 100 is a strike.',
  },
  {
    id: 'A5-xxv(b). ★ no close reading: never a strike (the stored flag ignored)',
    file: GATE, tests: [T_LINE],
    find: '    return realizedBreached(r);\n  };\n  const strikeRows',
    to: '    return false; /* MUTANT */\n  };\n  const strikeRows',
    why: 'A row whose close was not read is never a strike: not fail-closed.',
  },
  {
    id: 'A5-xxvi. ★ the line-mode ON log keeps "as the backstop"',
    file: IDX, tests: [T_LINE],
    find: 'and ON until the close (no software stop) unless the panel switches it off at its ${onLineMode.panelCeilingPct}% ceiling (switched back on under ${onLineMode.startTargetPct}% before the close, at most ${lineReOnTimesWords(FORCE_CHARGE_LINE_REON_MAX)}).',
    to: "and ON until the close (no software stop), with the panel's ${onLineMode.panelCeilingPct}% ceiling as the backstop. /* MUTANT */",
    why: 'The ON log contradicts the 21:30 line on a night whose walk latches at the ceiling.',
  },
  {
    id: 'A5-xxvii. ★★ the mid-day push falls back on the reason, not the leg\'s ask (L4)',
    file: CTX, tests: [T_LINE],
    find: "          : l.cushionShortfallCause != null\n            ? ` NOTE: this leg's outage line is above the ${RESERVE_WRITE_MAX_PCT}% the panel accepts as a reserve; its force-charge runs, but the plan does not claim the line — residual risk remains.`",
    to: "          : l.cushionShortfallCause != null /* MUTANT */\n            ? notCarried('this leg')",
    why: 'A restored leg whose kind was lost reads "no force-charge carries it" while its force-charge runs.',
  },
  {
    id: 'A5-xxviii. ★ the card\'s line row warns on the cause alone',
    file: CARDX, tests: [T_LINE],
    find: "plan.cushionShortfallCause != null || lineNotHeldOfCard(plan) != null ? 'text-warn' : 'text-muted'",
    to: "plan.cushionShortfallCause != null ? 'text-warn' : 'text-muted' /* MUTANT */",
    why: 'A carried night\'s "under the line; residual risk remains" is shown muted.',
  },
  {
    id: 'A5-xxix. ★★ the card\'s mirror keys on the reason, not the walk\'s close',
    file: CARD, tests: [T_LINE, T_YEAR],
    find: "  if (e != null && e < l - 0.05 - 1e-9) return 'closeUnder';",
    to: "  if (plan.cushionEnvelopeReason === 'closeUnder') return 'closeUnder'; /* MUTANT */",
    why: 'The card says "within 10 points" where the server says "under the line".',
  },
  {
    id: 'A5-xxix(b). ★ the card\'s mirror drops the edge slack',
    file: CARD, tests: [T_LINE],
    find: "  if (e != null && e < l - 0.05 - 1e-9) return 'closeUnder';",
    to: "  if (e != null && e < l - 0.05) return 'closeUnder'; /* MUTANT */",
    why: 'A carried night closing exactly at L − 0.05 (50.3% against 50.35%) shows "under the line; residual risk remains" on the card while the push words it held.',
  },

  /* ── A5 (docs stage): the spoken notice of a window-bound line night (T22) ── */
  {
    id: 'A5-xxx(a). ★★ a bound line walk spoken as ending short of its capped close',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: "  if (plan.expectedForceChargeMode !== 'line') return true;\n  const e = plan.expectedWriteLevelPct;",
    to: "  if (plan.expectedForceChargeMode !== 'line' || plan.expectedDeliverableBound === true) return true; /* MUTANT */\n  const e = plan.expectedWriteLevelPct;",
    why: 'The spoken notice says "toward 93 percent, which ends before it gets there" of the ~92.8% the window reaches as it closes.',
  },
  {
    id: 'A5-xxx(b). ★★ the 50% floor above the reach spoken as reached',
    file: NCA, tests: [T_LINE, T_YEAR],
    find: '  return e == null || !Number.isFinite(e) || e <= RESERVE_WRITE_MAX_PCT;',
    to: '  return e == null || !Number.isFinite(e); /* MUTANT */',
    why: 'A window that cannot finish the reserve leg is spoken as charging "to about 50 percent".',
  },
  {
    id: 'A5-xxx(c). ★★ the announce route keeps the bound flag alone',
    file: ANN, tests: [T_LINE],
    find: '      toward: chargeEndsShortOfLevel(plan),\n      deadlineText: supervised.cancelDeadlineText,',
    to: '      toward: chargeEndsShortOfLevel(plan) || plan.expectedDeliverableBound === true, /* MUTANT */\n      deadlineText: supervised.cancelDeadlineText,',
    why: 'The evening\'s spoken notice (the route) says the window ends short of the close it reaches.',
  },
  /* (A5 fix) — the review of b1fd7613 */
  {
    id: 'A5-xxxi(a). ★★★ the mid-day re-entry hold holds a leg the line force-charge is armed on',
    file: NCA, tests: [T_LINE],
    find: '  if (midday && !backupLeg && chargeTonight && !lineArmed) {',
    to: '  if (midday && !backupLeg && chargeTonight) { /* MUTANT */',
    why: 'More cushion turns an armed, charging mid-day leg into a hold: nothing written, no force-charge, the pool left at 30% against a 61% line, the hold plan silent on it.',
  },
  {
    id: 'A5-xxxi(b). ★★ the exemption on line mode only (an armed cost-dominant leg held)',
    file: NCA, tests: [T_LINE],
    find: '  if (midday && !backupLeg && chargeTonight && !lineArmed) {',
    to: "  if (midday && !backupLeg && chargeTonight && expected.mode !== 'line') { /* MUTANT */",
    why: 'A 46% floor: the cost-dominant force-charge armed for a 53.56% line is held at ~70% under the 71% re-entry line.',
  },
  {
    id: 'A5-xxxi(c). ★ the exempt leg\'s rationale silent on the re-entry line',
    file: NCA, tests: [T_LINE],
    find: '  const reentryNote = reentryExemptLinePct != null && expected.levelPct != null',
    to: '  const reentryNote = (false as boolean) && reentryExemptLinePct != null && expected.levelPct != null /* MUTANT */',
    why: 'The leg charges under the re-entry line and the rationale does not say the grid may carry the house into on-peak.',
  },
  {
    id: 'A5-xxiii(c). ★★ strikesMeasurable reads every disclosed row as unable to strike',
    file: GATE, tests: [T_LINE],
    find: '      || (asNum(r.cushion_line_force_charge_pct) != null && truthy(r.actuated))) ? 1 : 0,',
    to: '      || (false as boolean)) ? 1 : 0, /* MUTANT */',
    why: 'An armed, never-ON row under its line is a strike beside strikesMeasurable 0 ("cannot count"); a real 0 reads as unmeasured.',
  },
  {
    id: 'A5-xxiii(d). ★ strikesMeasurable counts an armed row that never actuated',
    file: GATE, tests: [T_LINE],
    find: '      || (asNum(r.cushion_line_force_charge_pct) != null && truthy(r.actuated))) ? 1 : 0,',
    to: '      || asNum(r.cushion_line_force_charge_pct) != null) ? 1 : 0, /* MUTANT */',
    why: 'A ledger of armed nights whose reserve write never landed (the strike rule cannot grade them) reads as measured.',
  },
  {
    id: 'A5-xxxii. ★★ the mid-day push drops the backup leg\'s disclosure beside an armed cost leg',
    file: CTX, tests: [T_LINE],
    find: "      ? armedNote(c) + (i.backup?.cushionShortfallCause != null ? notCarried('the backup leg') : '')",
    to: '      ? armedNote(c) /* MUTANT */',
    why: 'The backup leg\'s outage line, which its reserve-only write cannot hold, goes unsaid whenever the cost leg is armed.',
  },
  {
    id: 'A5-xxxiii(a). ★★ the evening push says "not held" on every carried night whose walk holds',
    file: NTF, tests: [T_LINE],
    find: "the plan does not claim the line — residual risk remains.`;\n    }\n    return '';\n  }",
    to: "the plan does not claim the line — residual risk remains.`;\n    }\n    return ' NOTE: the outage line is not held — residual risk remains.'; /* MUTANT */\n  }",
    why: 'A night the force-charge carries to ~77% is pushed as not held: the push contradicts the rationale and the card.',
  },
  {
    id: 'A5-xxxiii(b). ★★ the mid-day push gives a held armed leg the caps sentence',
    file: CTX, tests: [T_LINE],
    find: "the plan does not claim the line — residual risk remains.`\n            : '';",
    to: "the plan does not claim the line — residual risk remains.`\n            : ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'; /* MUTANT */",
    why: 'A leg whose sizing and walk both hold its line is told the cushion is not met.',
  },
  {
    id: 'A5-xxxiv. ★★ the H1 reach over-counts the window\'s P50 PV',
    file: NCA, tests: [T_LINE],
    find: '    kwh += chargeLegStep((p50PvW(h) / 1000) * dtH, legEff);',
    to: '    kwh += 2 * chargeLegStep((p50PvW(h) / 1000) * dtH, legEff); /* MUTANT */',
    why: 'On a sunny bound leg the cap never binds: the walk\'s close and the panel\'s stop are stated where the window cannot reach them.',
  },
  {
    id: 'A5-xxxv(a). ★★ the mid-day push leaves out Charge Now on an armed leg stated at the reserve (the line term dropped)',
    file: MSH, tests: [T_LINE],
    find: '  const forceCharge = c.lineAskPct != null || (c.levelPct != null && c.reservePct != null && c.levelPct > c.reservePct + 0.05);',
    to: '  const forceCharge = c.levelPct != null && c.reservePct != null && c.levelPct > c.reservePct + 0.05; /* MUTANT */',
    why: 'A line leg H1 floors at the 50% reserve is armed and Charge Now switched on at the open, and the push says only that the reserve is held.',
  },
  {
    id: 'A5-xxxv(b). ★ the mid-day push names Charge Now by the line ask alone (the cost rule dropped)',
    file: MSH, tests: [T_LINE],
    find: '  const forceCharge = c.lineAskPct != null || (c.levelPct != null && c.reservePct != null && c.levelPct > c.reservePct + 0.05);',
    to: '  const forceCharge = c.lineAskPct != null; /* MUTANT */',
    why: 'A cost leg charging to ~90% with Charge Now just in time is pushed as a reserve hold alone.',
  },
  /* (A5 final 2) the reserve-hold shape names the line force-charge armed on the leg. */
  {
    id: 'A5-xxxvi(a). ★★★ the mid-day hold shape leaves out Charge Now on an armed leg',
    file: CTX, tests: [T_LINE],
    find: '    const armedLine = c.lineAskPct != null',
    to: '    const armedLine = (false as boolean) && c.lineAskPct != null /* MUTANT */',
    why: 'A line leg the sun carries is pushed "no charge is expected … it is restored at 3:00 PM", while the line force-charge is armed and the actuator switches Charge Now on if the sun falls short (115 / 105 legs on the 90-95% grid).',
  },
  {
    id: 'A5-xxxvi(b). ★ the mid-day hold shape names Charge Now on a leg with no ask',
    file: CTX, tests: [T_LINE],
    find: '      : `; it is restored at ${restore}`;',
    to: '      : `, and Charge Now is armed for the outage line (not expected to start); both are restored at ${restore}`; /* MUTANT */',
    why: 'A reserve hold with nothing armed tells a person Charge Now is armed.',
  },
  /* (Fix7 review 1) …naming the plan's line round1(L), as the overnight clause does — never its ask ⌈L⌉. */
  {
    id: 'A5-xxxvi(c). ★★★ the mid-day hold shape names the ask ⌈L⌉ as the outage line',
    file: CTX, tests: [T_LINE],
    find: '      ? `, and Charge Now is armed for the ${c.linePct != null ? `${Math.round(c.linePct * 10) / 10}% ` : \'\'}outage line (not expected to start); both are restored at ${restore}`',
    to: '      ? `, and Charge Now is armed for the ${Math.round(c.lineAskPct * 10) / 10}% outage line (not expected to start); both are restored at ${restore}` /* MUTANT */',
    why: 'A leg the sun carries on a 60.03% line is pushed "armed for the 61% outage line" while its rationale, the overnight clause and the morning give 60% (every one of the 115 / 105 held legs names a line other than its own; 141349c7).',
  },
  {
    id: 'A5-xxxvi(d). ★ the mid-day hold shape, its line lost, names the ask as the line',
    file: CTX, tests: [T_LINE],
    find: '      ? `, and Charge Now is armed for the ${c.linePct != null ? `${Math.round(c.linePct * 10) / 10}% ` : \'\'}outage line (not expected to start); both are restored at ${restore}`',
    to: '      ? `, and Charge Now is armed for the ${c.linePct != null ? `${Math.round(c.linePct * 10) / 10}% ` : `${c.lineAskPct}% `}outage line (not expected to start); both are restored at ${restore}` /* MUTANT */',
    why: 'A record without the line names ⌈L⌉ as the line, up to a point above it.',
  },
  {
    id: 'A5-xxxvi(e). ★★ the mid-day hold shape names the line to the whole percent',
    file: CTX, tests: [T_LINE],
    find: '      ? `, and Charge Now is armed for the ${c.linePct != null ? `${Math.round(c.linePct * 10) / 10}% ` : \'\'}outage line (not expected to start); both are restored at ${restore}`',
    to: '      ? `, and Charge Now is armed for the ${c.linePct != null ? `${Math.round(c.linePct)}% ` : \'\'}outage line (not expected to start); both are restored at ${restore}` /* MUTANT */',
    why: 'A 56.24% line is pushed as "56%", while the overnight clause gives round1 (56.2%).',
  },
  {
    id: 'A5-xxxvi(f). ★★ the evening input drops the line beside its ask',
    file: MSH, tests: [T_LINE],
    find: '      ...(c.lineAskPct != null && c.cushionLineSocPct != null ? { linePct: c.cushionLineSocPct } : {}),',
    to: '      ...({}), /* MUTANT */',
    why: 'Every held armed leg is pushed "armed for the outage line" with no number, though the record carries it.',
  },
  {
    id: 'A5-xxxvi(g). ★★★ the evening input carries the ask as the line',
    file: MSH, tests: [T_LINE],
    find: '      ...(c.lineAskPct != null && c.cushionLineSocPct != null ? { linePct: c.cushionLineSocPct } : {}),',
    to: '      ...(c.lineAskPct != null ? { linePct: c.lineAskPct } : {}), /* MUTANT */',
    why: 'The 141349c7 defect by the wiring: the push names ⌈L⌉ as the line.',
  },
  /* (Fix7 review 2) The overnight log's line-mode whys ("NOT starting", once a night) name the record's line round1(L) too,
   * never the ask ⌈L⌉, and the hold-off never says the force-charge "stays on to the close". */
  {
    id: 'A5-xxxvii(a). ★★ the overnight hold-off log names the ask ⌈L⌉ as the outage line',
    file: NFC, tests: [T_LINE],
    find: '      return { kind: \'none\', why: `just in time — holding off so the pool reaches ~${mode.startTargetPct}% ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min before the window closes, for the ${linePct}% outage line at the close` };',
    to: '      return { kind: \'none\', why: `just in time — holding off so the pool reaches ~${mode.startTargetPct}% ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min before the window closes, for the ${mode.askPct}% outage line at the close` }; /* MUTANT */',
    why: 'The a07ebb42 defect: a 60.03% line night logs "for the 61% outage line" while the rationale, the pushes and the morning give 60%.',
  },
  {
    id: 'A5-xxxvii(b). ★★ the overnight "already at the ceiling" log names the ask ⌈L⌉ as the outage line (Fix8: re-anchored on the line it names)',
    file: NFC, tests: [T_LINE],
    find: '      const n = lineBesidePct(l, c);',
    to: '      const n = mode.askPct; /* MUTANT */',
    why: 'The same misstatement on the other line-mode why: "tonight\'s 100% outage line is above a full pool" on a 101.57% line asked at 100.',
  },
  {
    id: 'A5-xxxvii(c). ★★ the overnight log names the line to the whole percent',
    file: NFC, tests: [T_LINE],
    find: '    const linePct = round1(forceChargeLineNightPct(s) ?? mode.askPct);',
    to: '    const linePct = Math.round(forceChargeLineNightPct(s) ?? mode.askPct); /* MUTANT */',
    why: 'A 55.55% line is logged as "56%", while every other surface gives round1 (55.6%).',
  },
  {
    id: 'A5-xxxvii(d). ★ the overnight log reads the line alone (a record without it names 0%)',
    file: NFC, tests: [T_LINE],
    find: '    const linePct = round1(forceChargeLineNightPct(s) ?? mode.askPct);',
    to: '    const linePct = round1(s.forceChargeLinePct!); /* MUTANT */',
    why: 'A record whose line is unknown logs "the 0% outage line"; forceChargeLineNightPct names its ask.',
  },
  {
    id: 'A5-xxxvii(e). ★★ the overnight hold-off log says the force-charge "stays on to the close"',
    file: NFC, tests: [T_LINE],
    find: '      return { kind: \'none\', why: `just in time — holding off so the pool reaches ~${mode.startTargetPct}% ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min before the window closes, for the ${linePct}% outage line at the close` };',
    to: '      return { kind: \'none\', why: `just in time — holding off so the pool reaches ~${mode.startTargetPct}% ${Math.round(FORCE_CHARGE_MIN_RUN_MS / 60_000)} min before the window closes, then stays on to the close for the ${linePct}% outage line` }; /* MUTANT */',
    why: 'The log promises the force-charge stays on to the close; the panel switches each slot off at its ceiling (the measured shape).',
  },

  /* (Fix8) ITEM 1 — the "already at the ceiling" why words the line's actual order: above it, at it, or the line above a full
   * pool, the line named so that the order shows (lineBesidePct). */
  {
    id: 'F8-i(a). ★★★ the "already at the ceiling" why says "above" whatever the order (the defect)',
    file: NFC, tests: [T_LINE],
    find: "        : l === c ? `at tonight's ${n}% outage line` : `tonight's ${n}% outage line is above a full pool`}` };",
    to: "        : `above tonight's ${n}% outage line`}` }; /* MUTANT */",
    why: 'The 89d8dece defect: a 101.57% line asked at 100 logs "the 100% panel ceiling — above tonight\'s 101.6% outage line", contradicting its own rationale ("above a full pool, so no charge can hold it").',
  },
  {
    id: 'F8-i(b). ★★ a line AT the ceiling read as under it',
    file: NFC, tests: [T_LINE],
    find: "      return { kind: 'none', why: `the pool already reads the ${c}% panel ceiling — ${l < c ? `above tonight's ${n}% outage line`",
    to: "      return { kind: 'none', why: `the pool already reads the ${c}% panel ceiling — ${l <= c ? `above tonight's ${n}% outage line` /* MUTANT */",
    why: 'A 100% line under a 100% ceiling logs "above tonight\'s 100% outage line" (equal, not above).',
  },
  {
    id: 'F8-i(c). ★★ a line above a full pool read as at the ceiling',
    file: NFC, tests: [T_LINE],
    find: "        : l === c ? `at tonight's ${n}% outage line` : `tonight's ${n}% outage line is above a full pool`}` };",
    to: "        : l >= c ? `at tonight's ${n}% outage line` : `tonight's ${n}% outage line is above a full pool`}` }; /* MUTANT */",
    why: 'A 101.57% line logs "at tonight\'s 101.6% outage line" under a 100% ceiling.',
  },
  {
    id: 'F8-i(d). ★★ the why orders the ask, not the line, against the ceiling',
    file: NFC, tests: [T_LINE],
    find: '      const l = forceChargeLineNightPct(s) ?? mode.askPct;',
    to: '      const l = mode.askPct; /* MUTANT */',
    why: 'A 101.57% line asked at 100 logs "at tonight\'s 100% outage line": the line is above a full pool.',
  },
  {
    id: 'F8-i(e). ★★ the why names the line to one decimal beside the ceiling it equals',
    file: NFC, tests: [T_LINE],
    find: '      const n = lineBesidePct(l, c);',
    to: '      const n = Math.round(l * 10) / 10; /* MUTANT */',
    why: 'A 99.96% line logs "the 100% panel ceiling — above tonight\'s 100% outage line" (equal, as named).',
  },
  /* (Fix8) ITEM 3 — the line beside the levels it is ordered against, named so the order shows. */
  {
    id: 'F8-ii(a). ★★★ lineBesidePct never names two decimals',
    file: NFC, tests: [T_LINE],
    find: '  return levelsPct.includes(r) ? Math.round(linePct * 100) / 100 : r;',
    to: '  return r; /* MUTANT */',
    why: 'A 50.03% line is pushed "for tonight\'s 50% outage line (above the 50% the panel holds as a reserve)"; a 99.96% one logged above as 100%.',
  },
  {
    id: 'F8-ii(b). ★★★ a line stated at the reserve numbered beside it',
    file: NFC, tests: [T_LINE],
    find: "  return n > RESERVE_WRITE_MAX_PCT ? `${lead}${n}%${tail}` : [lead.trim(), tail.trim()].filter((w) => w !== '').join(' ');",
    to: "  return `${lead}${n}%${tail}`; /* MUTANT */",
    why: 'A line stated at 50.00 (asked at 51) is pushed and logged "the 50% outage line is above the 50% reserve" (2026-11-25, nameplate, 11 h).',
  },
  {
    id: 'F8-ii(c). ★★ the line beside the reserve forgets a full pool',
    file: NFC, tests: [T_LINE],
    find: '  const n = lineBesidePct(linePct, RESERVE_WRITE_MAX_PCT, 100);',
    to: '  const n = lineBesidePct(linePct, RESERVE_WRITE_MAX_PCT); /* MUTANT */',
    why: 'A 99.96% line is pushed "for tonight\'s 100% outage line" beside a note on a full pool and a 100% ceiling.',
  },
  {
    id: 'F8-ii(d). ★★ the line beside the reserve forgets the reserve',
    file: NFC, tests: [T_LINE],
    find: '  const n = lineBesidePct(linePct, RESERVE_WRITE_MAX_PCT, 100);',
    to: '  const n = lineBesidePct(linePct, 100); /* MUTANT */',
    why: 'A 50.03% line reads as at the reserve and goes unnumbered, though two decimals show it above.',
  },
  {
    id: 'F8-ii(e). ★★ the log lines name the record\'s raw two decimals',
    file: NFC, tests: [T_LINE],
    find: '  return l != null ? round1(l) : null;',
    to: '  return l; /* MUTANT */',
    why: 'The ON, re-ON, lowering, at-risk and declined-start lines log "55.55%" while every other surface names 55.6%.',
  },
  {
    id: 'F8-ii(f). ★ the log lines read the line alone (a record without it names nothing)',
    file: NFC, tests: [T_LINE],
    find: '  const l = forceChargeLineNightPct(s);\n  return l != null ? round1(l) : null;',
    to: '  const l = s.forceChargeLinePct; /* MUTANT */\n  return l != null ? round1(l) : null;',
    why: 'A record whose line is unknown logs "?%" or the mode\'s ask, where forceChargeLineNightPct names the record\'s ask.',
  },
  {
    id: 'F8-ii(g). ★★ the ON log names the raw record value',
    file: IDX, tests: [T_LINE],
    find: "for the ${lineLogPct(state) ?? onLineMode.askPct}% outage line: timed to reach",
    to: "for the ${state.forceChargeLinePct ?? onLineMode.askPct}% outage line: timed to reach /* MUTANT */",
    why: 'The ON line logs "for the 55.55% outage line" (the defect on 89d8dece).',
  },
  {
    id: 'F8-ii(h). ★★ the re-ON log names the raw record value',
    file: IDX, tests: [T_LINE],
    find: "back under the start target for the ${lineLogPct(state) ?? '?'}% outage line; switching them back ON",
    to: "back under the start target for the ${state.forceChargeLinePct ?? state.forceChargeLineAskPct ?? '?'}% outage line; switching them back ON /* MUTANT */",
    why: 'The re-ON line logs the raw 55.55%.',
  },
  {
    id: 'F8-ii(i). ★★ the lowering log names the raw record value',
    file: IDX, tests: [T_LINE],
    find: "so tonight runs for the ${lineLogPct(state) ?? '?'}% outage line under its own ceiling.",
    to: "so tonight runs for the ${state.forceChargeLinePct ?? state.forceChargeLineAskPct ?? '?'}% outage line under its own ceiling. /* MUTANT */",
    why: 'The lowering line logs the raw 55.55%.',
  },
  {
    id: 'F8-ii(j). ★★ the at-risk log names the raw record value',
    file: IDX, tests: [T_LINE],
    find: "outage line (${lineLogPct(state)}%) is AT RISK",
    to: "outage line (${risk.linePct}%) is AT RISK /* MUTANT */",
    why: 'The at-risk line logs "(55.55%)" while its push names 55.6%.',
  },
  {
    id: 'F8-ii(k). ★★ the declined-start log names the raw record value',
    file: IDX, tests: [T_LINE],
    find: "'s ${lineLogPct(state)}% outage line cannot start yet",
    to: "'s ${declinedLinePct}% outage line cannot start yet /* MUTANT */",
    why: 'The declined-start line logs the raw 55.55% while its push names 55.6%.',
  },
  {
    id: 'F8-ii(l). ★★★ the evening push\'s clause names the line to one decimal beside the reserve',
    file: NTF, tests: [T_LINE],
    find: "    const why = `${lineAboveReserveWords(l.linePct, \"for tonight's \", ' outage line')} (above the ${RESERVE_WRITE_MAX_PCT}% the panel holds as a reserve)`;",
    to: "    const why = `for tonight's ${round1(l.linePct)}% outage line (above the ${RESERVE_WRITE_MAX_PCT}% the panel holds as a reserve)`; /* MUTANT */",
    why: 'The 89d8dece words: "for tonight\'s 50% outage line (above the 50% the panel holds as a reserve)" on the year\'s 50.00-50.03% lines.',
  },
  {
    id: 'F8-ii(m). ★★ the push\'s notes name the line to one decimal beside the reserve and a full pool',
    file: NTF, tests: [T_LINE],
    find: "    ? lineAboveReserveWords(plan.cushionLineSocPct, \"tonight's \", ' outage line') : \"tonight's outage line\";",
    to: "    ? `tonight's ${round1(plan.cushionLineSocPct)}% outage line` : \"tonight's outage line\"; /* MUTANT */",
    why: 'The advisory disclosure says "tonight\'s 50% outage line is above the 50% the panel accepts as a reserve" on a 50.03% line.',
  },
  {
    id: 'F8-ii(n). ★★ the ON failure names the line to one decimal beside the reserve',
    file: NTF, tests: [T_LINE],
    find: '  const line = o.lineLinePct != null && Number.isFinite(o.lineLinePct) ? lineBesidePct(o.lineLinePct, RESERVE_WRITE_MAX_PCT) : null;',
    to: '  const line = o.lineLinePct != null && Number.isFinite(o.lineLinePct) ? round1(o.lineLinePct) : null; /* MUTANT */',
    why: 'A 50.03% line\'s ON failure names "the 50% outage line" beside "only the 50% reserve holds the pool".',
  },
  {
    id: 'F8-ii(o). ★★★ the ON failure says the pool WILL close near the reserve, under the line (the defect)',
    file: NTF, tests: [T_LINE, T_RISK],
    find: "      : `Tonight's force-charge for the ${line}% outage line has not taken effect: unless it applies late, the add-on adds nothing `\n        + `above the ${RESERVE_WRITE_MAX_PCT}% reserve${underReach ? ', and the pool may close the window under the line' : ''}. `)",
    to: "      : `Tonight's force-charge for the ${line}% outage line will not happen: without it the pool will close the window near `\n        + `the ${RESERVE_WRITE_MAX_PCT}% reserve, under the line. `) /* MUTANT */",
    why: 'The 89d8dece words: false wherever the pool reads above the line at the failure (an ON timed from a pool between the line and the start target).',
  },
  {
    id: 'F8-ii(p). ★★ the ON failure says a line the reserve holds may close under it',
    file: NTF, tests: [T_LINE],
    find: '  const underReach = line != null && line > RESERVE_WRITE_MAX_PCT;',
    to: '  const underReach = line != null; /* MUTANT */',
    why: 'A line stated at 50.00 (the reserve holds it) is told the pool may close under it, or short of it.',
  },
  {
    id: 'F8-ii(q). ★★★ the declined start says the pool is expected to close under the line, near the reserve (the defect)',
    file: NTF, tests: [T_LINE],
    find: "        ? `If it has not started by ~${o.latestStartText}, the pool may close under the line; if it never starts, the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve.`",
    to: "        ? `If it has not started by ~${o.latestStartText}, the pool is expected to close under the line; if it never starts, near the ${RESERVE_WRITE_MAX_PCT}% reserve.` /* MUTANT */",
    why: 'The 89d8dece words: false with the pool above the line, or a person\'s Charge Now lifting it (a declined cause).',
  },
  {
    id: 'F8-ii(r). ★★ the declined start says a line the reserve holds may close under it',
    file: NTF, tests: [T_LINE],
    find: '      + (line > RESERVE_WRITE_MAX_PCT',
    to: '      + (line > 0 /* MUTANT */',
    why: 'A line stated at 50.00 is told the pool may close under it.',
  },
  {
    id: 'F8-ii(s). ★★ the declined start names the line to one decimal beside the reserve',
    file: NTF, tests: [T_LINE],
    find: '  const line = lineBesidePct(o.linePct, RESERVE_WRITE_MAX_PCT);',
    to: '  const line = round1(o.linePct); /* MUTANT */',
    why: 'A 50.03% line is pushed "the force-charge for tonight\'s 50% outage line … only the 50% reserve holds it".',
  },
  {
    id: 'F8-ii(t). ★★ the at-risk push says "falling toward" a line its numbers show the pool under',
    file: NTF, tests: [T_LINE],
    find: '  const where = r.poolPct < r.linePct - 0.05 || round1(r.poolPct) < line',
    to: '  const where = r.poolPct < r.linePct - 0.05 /* MUTANT */',
    why: 'A 50.05% line, the pool at 50: "the pool reads 50%, … falling toward tonight\'s 50.1% outage line".',
  },
  {
    id: 'F8-ii(u). ★★ the card names the line to one decimal beside the reserve and a full pool',
    file: CARD, tests: [T_LINE],
    find: '    const n = r === max || r === 100 ? Math.round(l * 100) / 100 : r;',
    to: '    const n = r; /* MUTANT */',
    why: 'The card reads "outage line 50% is above the 50% reserve" on a 50.03% line.',
  },
  {
    id: 'F8-ii(v). ★★ the card forgets a full pool',
    file: CARD, tests: [T_LINE],
    find: '    const n = r === max || r === 100 ? Math.round(l * 100) / 100 : r;',
    to: '    const n = r === max ? Math.round(l * 100) / 100 : r; /* MUTANT */',
    why: 'A 99.96% line reads "outage line 100%" on the card beside its 100% ceiling.',
  },
  {
    id: 'F8-ii(w). ★★ the card numbers a line stated at the reserve',
    file: CARD, tests: [T_LINE],
    find: "    return n > max ? `${n}% ` : '';",
    to: "    return `${n}% `; /* MUTANT */",
    why: 'A line stated at 50.00 reads "outage line 50% is above the 50% reserve".',
  },
  /* (Fix8) ITEM 2 — the push judged after the line ceiling lowering while ON, and on its refusal. */
  {
    id: 'F8-iii(a). ★★ the push not judged after the line ceiling lowering',
    file: IDX, tests: [T_RISK],
    find: "Force-charge waits for it to read back.'}`);\n    if (whileOn) judgeLineNight();\n",
    to: "Force-charge waits for it to read back.'}`); /* MUTANT */\n",
    why: 'A hold followed by the lowering skips the judgement like a lost tick (round 6\'s residual): 2 of 86,400 hand-backs pushed a tick later or not before the retry.',
  },
  {
    id: 'F8-iii(b). ★ the push not judged when the write block refuses the lowering',
    file: IDX, tests: [T_RISK],
    find: "if (blocked) { app.log.warn(`night-charge: force-charge ceiling sync refused — ${blocked}`); if (whileOn) judgeLineNight(); return; }",
    to: "if (blocked) { app.log.warn(`night-charge: force-charge ceiling sync refused — ${blocked}`); return; } /* MUTANT */",
    why: 'A refused lowering skips the judgement like a lost tick.',
  },

  /* (Fix8 review 1) The push and the shape judged together (judgeLineNight) on every tick kind that can make either first due,
     the re-ON's check among them; the shape once a night on the record; the margin from the named numbers; the line-night
     failure words true in every outcome (a late apply is verified; the reserve is no floor islanded). */
  {
    id: 'F8r1-i(a). ★★★ index.ts: the re-ON\'s readback check not judged (the defect)',
    file: IDX, tests: [T_RISK],
    find: "    // last tick before the push's lead it has no later tick (the round-7 reviewer's night: the check 20m30s before the close).\n    judgeLineNight();\n",
    to: "    // last tick before the push's lead it has no later tick (the round-7 reviewer's night: the check 20m30s before the close). /* MUTANT */\n",
    why: 'A second re-ON not applied whose check lands on the last tick before the lead is never pushed (32 emulated nights under).',
  },
  {
    id: 'F8r1-i(b). ★ index.ts: the re-ON the write block refuses not judged (the shape log waits out the block)',
    file: IDX, tests: [T_RISK],
    find: "if (blocked) { app.log.warn(`night-charge: line force-charge re-ON refused — ${blocked}`); judgeLineNight(); return; }",
    to: "if (blocked) { app.log.warn(`night-charge: line force-charge re-ON refused — ${blocked}`); return; } /* MUTANT */",
    why: 'While two panels block the writes, the ON-reading shape seen beside a re-ON due is never logged.',
  },
  {
    id: 'F8r1-i(c). ★★ index.ts: a tick that decides nothing judges the push only, not the shape',
    file: IDX, tests: [T_RISK],
    find: "pushed once tonight for this cause.`);\n    }\n    judgeLineNight();\n    return;",
    to: "pushed once tonight for this cause.`);\n    }\n    pushLineAtRiskIfDue(); /* MUTANT */\n    return;",
    why: 'The ON-reading shape is logged only on the busy ticks: its first real occurrence goes unrecorded.',
  },
  {
    id: 'F8r1-ii. ★★ the cost-dominant margin from the raw line (the defect)',
    file: NTF, tests: [T_RISK, T_LINE],
    find: '  const margin = `under ${round1(r.thresholdPct)}%, ${round1(round1(r.thresholdPct) - line)} points above tonight\'s ${line}% outage line,`;',
    to: '  const margin = `under ${round1(r.thresholdPct)}%, ${round1(r.thresholdPct - r.linePct)} points above tonight\'s ${line}% outage line,`; /* MUTANT */',
    why: '"under 61%, 5.5 points above tonight\'s 55.6% outage line": 61 − 55.6 is 5.4 by the push\'s own numbers.',
  },
  {
    id: 'F8r1-iii(a). ★★★ the declined start says only the 50% reserve holds the pool (the defect)',
    file: NTF, tests: [T_LINE],
    find: "        ? `If it has not started by ~${o.latestStartText}, the pool may close under the line; if it never starts, the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve.`",
    to: "        ? `If it has not started by ~${o.latestStartText}, the pool may close under the line; if it never starts, only the ${RESERVE_WRITE_MAX_PCT}% reserve holds it.` /* MUTANT */",
    why: 'With the grid absent (a declined cause) the pool drains through the reserve: it holds nothing islanded.',
  },
  {
    id: 'F8r1-iii(b). ★★ the declined start of a line stated at the reserve says only the reserve holds the pool',
    file: NTF, tests: [T_LINE],
    find: "        : `If it never starts, the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve.`),",
    to: "        : `If it never starts, only the ${RESERVE_WRITE_MAX_PCT}% reserve holds the pool.`), /* MUTANT */",
    why: 'A 50.00% line\'s declined start names a floor the islanded pool drains through.',
  },
  {
    id: 'F8r1-iv(a). ★★★ the ON failure says the force-charge will not happen and only the reserve holds the pool (the defect)',
    file: NTF, tests: [T_LINE, T_RISK],
    find: "      : `Tonight's force-charge for the ${line}% outage line has not taken effect: unless it applies late, the add-on adds nothing `\n        + `above the ${RESERVE_WRITE_MAX_PCT}% reserve${underReach ? ', and the pool may close the window under the line' : ''}. `)",
    to: "      : `Tonight's force-charge for the ${line}% outage line will not happen: without it only the ${RESERVE_WRITE_MAX_PCT}% reserve `\n        + `holds the pool${underReach ? ', and it may close the window under the line' : ''}. `) /* MUTANT */",
    why: 'The 4ace3a1e words: a late apply is still verified (and the morning says it ran), and the reserve holds nothing islanded.',
  },
  {
    id: 'F8r1-iv(b). ★★ the partial ON failure says it will not happen there, and the other slots still charge',
    file: NTF, tests: [T_LINE],
    find: "      ? `Tonight's force-charge for the ${line}% outage line has not taken effect on those slot(s)`\n        + `${underReach ? ', so the pool may close the window short of the line' : ''}. `",
    to: "      ? `Tonight's force-charge for the ${line}% outage line will not happen on those slot(s); the other slot(s) still charge`\n        + `${underReach ? ', so the pool may close the window short of the line' : ''}. ` /* MUTANT */",
    why: 'A late apply contradicts "will not happen"; a slot at the panel\'s ceiling, switched off by it, does not charge.',
  },
  {
    id: 'F8r1-iv(c). ★ the line ON failure\'s title says it did not take effect',
    file: NTF, tests: [T_LINE],
    find: "'Night-charge: the outage-line force-charge has not taken effect',",
    to: "'Night-charge: the outage-line force-charge did not take effect', /* MUTANT */",
    why: 'The title of a warning a late apply contradicts.',
  },
  {
    id: 'F8r1-iv(d). ★★ the line apply failure says the charge will not happen (a late apply is verified)',
    file: NTF, tests: [T_RISK, T_LINE],
    find: "    : `Tonight's planned ${planned} has not taken effect: until the panel reads ${o.targetPct ?? RESERVE_WRITE_MAX_PCT}%, `\n      + `it keeps its normal reserve, under tonight's ${line}% outage line, and the force-charge for the line waits on this write. `",
    to: "    : `Tonight's planned ${planned} will not happen: the pool stays on its normal floor, under tonight's ${line}% outage line, `\n      + 'and the force-charge for the line waits on this write. ' /* MUTANT */",
    why: 'The 4ace3a1e words: the apply ladder still verifies a late reading of the target, and the force-charge then starts.',
  },
  {
    id: 'F8r1-iv(e). ★★ the at-risk push says a re-ON its check found not applied did not take effect',
    file: NTF, tests: [T_RISK, T_LINE],
    find: "        + 'and it has not taken effect; it does not try again tonight. '",
    to: "        + 'and it did not take effect; it does not try again tonight. ' /* MUTANT */",
    why: 'A re-ON applied a minute after its check (the push now goes on the check\'s own tick) is told it did not take effect.',
  },
  {
    id: 'F8r1-v(a). ★★ index.ts: the shape logged without its stamp on the record',
    file: IDX, tests: [T_RISK],
    find: '    persistNightActuation({ ...nightActuationMem, forceChargeLineShapeLoggedAtMs: nowMs });',
    to: '    /* MUTANT */',
    why: '"Logged once a night." logged on every tick the shape is seen.',
  },
  {
    id: 'F8r1-v(b). ★★ the shape\'s stamp not kept across a restart',
    file: ACT, tests: [T_RISK],
    find: '    forceChargeLineShapeLoggedAtMs: num(o.forceChargeLineShapeLoggedAtMs),',
    to: '    forceChargeLineShapeLoggedAtMs: null, /* MUTANT */',
    why: 'A restart logs "Logged once a night." a second time (the round-7 reviewer\'s P1).',
  },
  {
    id: 'F8r2-i(a). ★★ the line apply failure\'s title says the write did not take effect (the defect)',
    file: NTF, tests: [T_RISK, T_LINE],
    find: "    title: line == null ? 'Night-charge: write did not take effect' : 'Night-charge: the reserve write has not taken effect',",
    to: "    title: 'Night-charge: write did not take effect', /* MUTANT */",
    why: 'The ladder still verifies a late reading of the target (or the reserve set by hand, as the body asks): the title states an end it contradicts.',
  },
  {
    id: 'F8r2-i(b). ★★ every night\'s apply failure takes the line title',
    file: NTF, tests: [T_RISK],
    find: "    title: line == null ? 'Night-charge: write did not take effect' : 'Night-charge: the reserve write has not taken effect',",
    to: "    title: 'Night-charge: the reserve write has not taken effect', /* MUTANT */",
    why: 'A night with no line ask loses v1.199.1\'s title, pinned word for word.',
  },
  {
    id: 'F8r2-i(c). ★ the declined start\'s title says the force-charge cannot start, no "yet"',
    file: NTF, tests: [T_LINE],
    find: "    title: 'Night-charge: the force-charge for the outage line cannot start yet',",
    to: "    title: 'Night-charge: the force-charge for the outage line cannot start', /* MUTANT */",
    why: 'decideForceCharge decides every tick, so a held start may still come: the title reads as an end.',
  },
  {
    id: 'F8r2-ii(a). ★★ index.ts: the line ON failure logged in the cost words (the defect)',
    file: IDX, tests: [T_LINE],
    find: "    if (lineLogPct(state) != null) app.log.warn(`night-charge: force-charge ON for ${state.day}'s ${lineLogPct(state)}% outage line has NOT taken effect",
    // (no `if (false)`: the branch would narrow `action` to never and not typecheck)
    to: "    if (lineLogPct({ forceChargeLineAskPct: null, forceChargeLinePct: null }) != null /* MUTANT */) app.log.warn(`night-charge: force-charge ON for ${state.day}'s ${lineLogPct(state)}% outage line has NOT taken effect",
    why: '"NEVER TOOK EFFECT … is forfeited" on a line night, ten minutes before the slots read ON and the ON verifies "after the warning — it applied late".',
  },
  {
    id: 'F8r2-ii(b). ★★ index.ts: the line ON failure\'s log says the buy is forfeited',
    file: IDX, tests: [T_LINE],
    find: "Unless it applies late (a late apply is still verified), the add-on adds nothing above the ${RESERVE_WRITE_MAX_PCT}% reserve${all ? '' : ' on those slot(s)'}; the reserve charge",
    to: "Tonight's buy above the ${RESERVE_WRITE_MAX_PCT}% reserve is forfeited${all ? '' : ' on those slot(s)'}; the reserve charge /* MUTANT */",
    why: 'A final outcome a late apply contradicts.',
  },
  {
    id: 'F8r2-ii(c). ★★ index.ts: the line apply failure logged in the cost words (the defect)',
    file: IDX, tests: [T_LINE],
    find: "    if (lineLogPct(state) != null) app.log.error(`night-charge: write has NOT taken effect",
    to: "    if (false /* MUTANT */) app.log.error(`night-charge: write has NOT taken effect",
    why: '"Tonight\'s charge is forfeited" on a line night whose reserve, set by hand as the push asks, is then verified and the force-charge starts.',
  },
  {
    id: 'F8r2-ii(d). ★★ index.ts: the line apply failure\'s log says the charge is forfeited',
    file: IDX, tests: [T_LINE],
    find: ") has not taken effect: until the panel reads ${state.targetPct}% (a late apply, or the reserve set in the EcoFlow app, is still verified) the force-charge",
    to: ") is forfeited: until the panel reads ${state.targetPct}% (a late apply, or the reserve set in the EcoFlow app, is still verified) the force-charge /* MUTANT */",
    why: 'The same, in the line branch\'s own words.',
  },
  {
    id: 'F8r2-iii(a). ★★ the morning account says the re-ONs its checks found not applied did not take effect (the defect)',
    file: NTF, tests: [T_RISK, T_LINE],
    find: "` (slot(s) still off at the readback check after ${reOnsNotApplied} of them)`",
    to: "` (${reOnsNotApplied} of them did not take effect)` /* MUTANT */",
    why: 'A re-ON applied a minute after its check (seen ON: the account says it ran to the close) is told it did not take effect.',
  },
  {
    id: 'F8r2-iii(b). ★ the morning account counts every re-ON as checked off',
    file: NTF, tests: [T_RISK],
    find: "` (slot(s) still off at the readback check after ${reOnsNotApplied} of them)`",
    to: "` (slot(s) still off at the readback check after ${reOns} of them)` /* MUTANT */",
    why: 'Two re-ONs, one that took: "after 2 of them".',
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
