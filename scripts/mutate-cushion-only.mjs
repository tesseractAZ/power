#!/usr/bin/env node
/**
 * mutate-cushion-only.mjs — committed harness for v1.203.0: the cushion-only night plan while the solar basis is refused, the
 * planner pool's seed while the Cores are dark, the point the panel holds under a reserve it charged up to, and Friday's
 * long-gap fill (nightChargeAdvisor.ts buildNightChargeInputs / sizeNightChargePlan / computeNightChargePlan, lineReserveAskPct,
 * lineNeedsForceCharge, eveningBasisDefers; poolEnergyBasis.ts seedPath; index.ts; nightLedgerScoring.ts cushionOnlyNote;
 * notify.ts; the card).
 *
 * (Q) THE QUALIFICATION: the flag, forecast and load hours, a window, the overnight cost leg only; the climatology tier is no
 * bar (critique). (Z) NO SOLAR: every PV figure zeroed, every surplus null. (O) THE OBJECTIVE: resilience, but for the long-gap
 * fill (owner). (R) THE REFUSALS by name, each keeping the solar refusal's transience. (F) THE POOL: a known ratio as passed, the
 * capacity floor with none known (critique). (E) THE EVENING: a transient refusal still waits to the deferral end (critique).
 * (G) THE LONG GAP keyed on the gap after this window (critique, owner). (T) THE TEXTS. (S) THE SEED. (L) THE LEDGER and
 * (C) THE SCORER. (I) index.ts's wiring. (H) THE HOLD POINT (owner): the write ⌈line⌉ + 1, a line in (49, 50] the line
 * force-charge's, and its words.
 *
 *   node scripts/mutate-cushion-only.mjs [--only <id prefix>]
 *
 * ★ Every id starts CO- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. Run with MUTATE_CONCURRENCY=2 beside other lanes, on a GREEN tree.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const PEB = resolve(REPO, 'server/src/poolEnergyBasis.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const NTF = resolve(REPO, 'server/src/notify.ts');
const NFC = resolve(REPO, 'server/src/nightForceCharge.ts');
const HW = resolve(REPO, 'server/src/hwSpec.ts');
const CARD = resolve(REPO, 'web/src/cards/nightChargeText.ts');
const CARDX = resolve(REPO, 'web/src/cards/NightChargeCard.tsx');

const T_CO = 'test/cushionOnlyPlan.test.ts';
const T_HOLD = 'test/reserveHoldPoint.test.ts';
const T_GOLDEN = 'test/legacyIdentity.test.ts';
const T_SET = 'test/setpointOneTest.test.ts';
const T_LFC = 'test/lineForceCharge.test.ts';
const T_UNHELD = 'test/lineNightUnheld.test.ts';
const T_SCOPE = 'test/runwayBasisContracts.test.ts';
const T_HW = 'test/hwSpec.test.ts';

const QUAL = "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && cushionOnlyEligible === true && forecastPresent && window != null\n    && (windowSpec == null || (windowSpec.kind === 'overnight' && windowSpec.role !== 'backup'))";

const MUTANTS = [
  /* ── Q: the qualification ── */
  {
    id: 'CO-Q-i. ★★★ the branch ignores the flag (every refused night falls back, advisory and shadow legs too)',
    file: NCA, tests: [T_CO, T_GOLDEN],
    find: QUAL,
    to: "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && forecastPresent && window != null /* MUTANT */\n    && (windowSpec == null || (windowSpec.kind === 'overnight' && windowSpec.role !== 'backup'))",
    why: 'Advisory mode, a stale panel and every shadow leg get a cushion-only plan: the golden\'s refused nights move.',
  },
  {
    id: 'CO-Q-viii. ★★ (design) the solar refusal left on a sized cushion-only plan\'s inputs',
    file: NCA, tests: [T_CO],
    find: "    basisBlockedBy: cushionOnly != null ? null : basisBlockedBy,\n",
    to: "    basisBlockedBy, /* MUTANT */\n",
    why: 'A sized plan carries a refusal: the gate, the push and the ledger read a refusal beside a plan.',
  },
  {
    id: 'CO-Q-ii. ★★★ no forecast or load hours still falls back',
    file: NCA, tests: [T_CO],
    find: QUAL,
    to: "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && cushionOnlyEligible === true && window != null /* MUTANT */\n    && (windowSpec == null || (windowSpec.kind === 'overnight' && windowSpec.role !== 'backup'))",
    why: 'With no load figure the cushion walks nothing: a plan made on an empty horizon.',
  },
  {
    id: 'CO-Q-iii. ★★★ no window still falls back',
    file: NCA, tests: [T_CO],
    find: QUAL,
    to: "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && cushionOnlyEligible === true && forecastPresent /* MUTANT */\n    && (windowSpec == null || (windowSpec.kind === 'overnight' && windowSpec.role !== 'backup'))",
    why: 'A Saturday reads as a complete basis with no window: the refusal it was is gone.',
  },
  {
    id: 'CO-Q-iv. ★★★ the backup leg falls back',
    file: NCA, tests: [T_CO],
    find: QUAL,
    to: "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && cushionOnlyEligible === true && forecastPresent && window != null\n    && (windowSpec == null || windowSpec.kind === 'overnight') /* MUTANT */",
    why: 'The outage backup leg ahead of a mid-day buy is sized cushion-only on its walk.',
  },
  {
    id: 'CO-Q-v. ★★★ a mid-day leg falls back',
    file: NCA, tests: [T_CO],
    find: QUAL,
    to: "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && cushionOnlyEligible === true && forecastPresent && window != null\n    && (windowSpec == null || windowSpec.role !== 'backup') /* MUTANT */",
    why: 'A super off-peak leg, sized for the sun, is made with no sun at all.',
  },
  {
    id: 'CO-Q-vi. ★★ (critique) the climatology tier refuses the fallback',
    file: NCA, tests: [T_CO],
    find: QUAL,
    to: "  const cushionOnly: CushionOnlyBasis | null = !basisComplete && cushionOnlyEligible === true && forecastPresent && confidenceTier !== 'climatology' && window != null /* MUTANT */\n    && (windowSpec == null || (windowSpec.kind === 'overnight' && windowSpec.role !== 'backup'))",
    why: 'A failed weather fetch refuses a plan that reads no weather: nothing charges, the harm this release fixes.',
  },
  {
    id: 'CO-Q-vii. ★★ (critique) the sizer still refuses a cushion-only climatology plan',
    file: NCA, tests: [T_CO],
    find: "  if (inputs.confidenceTier === 'climatology' && inputs.cushionOnly == null) return refuse(",
    to: "  if (inputs.confidenceTier === 'climatology') return refuse( /* MUTANT */",
    why: 'The qualification admits it and the sizer throws it away.',
  },

  /* ── Z: no solar ── */
  {
    id: 'CO-Z-i. ★★★ the band\'s P10 PV kept',
    file: NCA, tests: [T_CO],
    find: '      pvP10W: cushionOnly != null ? 0 : Math.max(0, h.pvP10W),',
    to: '      pvP10W: Math.max(0, h.pvP10W), /* MUTANT */',
    why: 'A plan with no solar basis credits the P10 sun of a band no calibration stands behind.',
  },
  {
    id: 'CO-Z-ii. ★★★ the band\'s P50 PV kept',
    file: NCA, tests: [T_CO],
    find: '      pvP50W: cushionOnly != null && finiteOrNull(h.pvP50W) != null ? 0 : finiteOrNull(h.pvP50W),\n    });\n  }',
    to: '      pvP50W: finiteOrNull(h.pvP50W), /* MUTANT */\n    });\n  }',
    why: 'The expected buy and its start credit median sun.',
  },
  {
    id: 'CO-Z-iii. ★★★ the rollups\' P10 PV kept',
    file: NCA, tests: [T_CO],
    find: '        pvP10W: cushionOnly != null ? 0 : Math.max(0, hh.pvW * p10Frac),',
    to: '        pvP10W: Math.max(0, hh.pvW * p10Frac), /* MUTANT */',
    why: 'A weekend carry credits days of sun.',
  },
  {
    id: 'CO-Z-iv. ★★ the rollups\' P50 PV kept',
    file: NCA, tests: [T_CO],
    find: '        pvP50W: cushionOnly != null && finiteOrNull(hh.pvW) != null ? 0 : finiteOrNull(hh.pvW),',
    to: '        pvP50W: finiteOrNull(hh.pvW), /* MUTANT */',
    why: 'The expected carry credits median sun beyond 24 h.',
  },
  {
    id: 'CO-Z-v. ★★★ the morning P90 surplus kept (an over-buy flag and a ceiling on solar)',
    file: NCA, tests: [T_CO],
    find: '    morningPvSurplusP90Kwh: cushionOnly != null ? null : morningPvSurplusP90Kwh,',
    to: '    morningPvSurplusP90Kwh, /* MUTANT */',
    why: 'The plan names an over-buy against a forecast it has not got.',
  },
  {
    id: 'CO-Z-vi. ★★ the morning P50 surplus kept',
    file: NCA, tests: [T_CO],
    find: '    morningPvSurplusP50Kwh: cushionOnly != null ? null : morningPvSurplusP50Kwh,',
    to: '    morningPvSurplusP50Kwh, /* MUTANT */',
    why: 'A cost ceiling (on the long-gap night) leaves room for sun no calibration stands behind.',
  },
  {
    id: 'CO-Z-vii. ★★★ (owner) the long-gap fill keeps the solar headroom',
    file: NCA, tests: [T_CO],
    find: '    prePeakPvSurplusP10Kwh: cushionOnly != null ? null : prePeakPvSurplusP10Kwh,',
    to: '    prePeakPvSurplusP10Kwh, /* MUTANT */',
    why: 'Friday\'s fill stops short of the ceiling for a P10 sun the plan cannot see.',
  },
  {
    id: 'CO-Z-viii. ★★ the de-biased cost surplus kept',
    file: NCA, tests: [T_CO],
    find: '    costSurplusLoad: cushionOnly != null ? null : costSurplusLoad,',
    to: '    costSurplusLoad, /* MUTANT */',
    why: 'A solar factor learned on the Cores rides a plan that credits none.',
  },

  /* ── O: the objective ── */
  {
    id: 'CO-O-i. ★★★ the configured objective kept on every cushion-only night (cost targets, cost force-charges)',
    file: NCA, tests: [T_CO],
    find: "  const objective = cushionOnly == null ? legObj : cushionOnly.longGapAfter ? legObj : 'resilience';",
    to: '  const objective = legObj; /* MUTANT */',
    why: 'Every cost-mode dark night buys toward a ceiling it sized with no sun.',
  },
  {
    id: 'CO-O-ii. ★★★ (owner) no long-gap fill: Friday forced to resilience',
    file: NCA, tests: [T_CO],
    find: "  const objective = cushionOnly == null ? legObj : cushionOnly.longGapAfter ? legObj : 'resilience';",
    to: "  const objective = cushionOnly == null ? legObj : 'resilience'; /* MUTANT */",
    why: 'Friday\'s 1 h window before Monday holds the line only: the dark weekends keep their low hours.',
  },

  /* ── G: the long gap ── */
  {
    id: 'CO-G-i. ★★★ (critique) the gap keyed on longGapAhead (Thursday\'s), not the gap after this window',
    file: NCA, tests: [T_CO],
    find: '    ? { refusedBy: basisBlockedBy!, transient: solarBasisTransient, gapAfterMs, longGapAfter: gapAfterMs == null || gapAfterMs > LONG_GAP_MS }',
    to: '    ? { refusedBy: basisBlockedBy!, transient: solarBasisTransient, gapAfterMs, longGapAfter: longGapAhead === true } /* MUTANT */',
    why: 'Thursday says nothing is charged before Monday and Friday then writes; Friday, before the 48 h gap, says nothing.',
  },
  {
    id: 'CO-G-ii. ★★ the gap measured from the window open',
    file: NCA, tests: [T_CO],
    find: '  const gapAfterMs = window != null && nextRechargeMs != null ? nextRechargeMs - window.endMs : null;',
    to: '  const gapAfterMs = window != null && nextRechargeMs != null ? nextRechargeMs - window.startMs : null; /* MUTANT */',
    why: 'Every gap reads the window\'s length too long: a 6 h weekday window plus its 18 h gap is "more than a day".',
  },
  {
    id: 'CO-G-iii. ★★ no next window found is not a long gap',
    file: NCA, tests: [T_CO],
    find: '    ? { refusedBy: basisBlockedBy!, transient: solarBasisTransient, gapAfterMs, longGapAfter: gapAfterMs == null || gapAfterMs > LONG_GAP_MS }',
    to: '    ? { refusedBy: basisBlockedBy!, transient: solarBasisTransient, gapAfterMs, longGapAfter: gapAfterMs != null && gapAfterMs > LONG_GAP_MS } /* MUTANT */',
    why: 'With no charge window in the scan the plan neither fills nor says so.',
  },

  /* ── R: the refusals ── */
  {
    id: 'CO-R-i. ★★★ the legacy band falls back (a whole-house trough sized with no sun)',
    file: NCA, tests: [T_CO],
    find: "    const coWhy = cushion.basis === 'legacy-pct' ? 'no islanded-load measurement'",
    to: "    const coWhy = (false as boolean) ? 'no islanded-load measurement' /* MUTANT */",
    why: 'The legacy band\'s test is the whole-house walk over the next day: no sun asks the 50% maximum every night.',
  },
  {
    id: 'CO-R-ii. ★★ a disabled cushion falls back',
    file: NCA, tests: [T_CO],
    find: "      : cushion.basis === 'disabled' ? 'the outage cushion is disabled'",
    to: "      : (false as boolean) ? 'the outage cushion is disabled' /* MUTANT */",
    why: 'A plan that holds nothing is announced as one that holds the cushion.',
  },
  {
    id: 'CO-R-iii. ★★★ a refusal of the fallback is persistent (the evening deferral lost)',
    file: NCA, tests: [T_CO],
    find: '      return nullPlan(inputs, false, `No plan — forecast/telemetry basis incomplete (${why}); nothing will be charged.`, co.transient, why);',
    to: '      return nullPlan(inputs, false, `No plan — forecast/telemetry basis incomplete (${why}); nothing will be charged.`, false, why); /* MUTANT */',
    why: 'A start-up\'s 0 scored days latch "no plan" at 21:30 and cancel a prior arm (v1.186.5, undone).',
  },
  {
    id: 'CO-R-iv. ★★ the refusal names the solar gate only',
    file: NCA, tests: [T_CO],
    find: '      const why = `${co.refusedBy}; no cushion-only plan: ${coWhy}`;',
    to: '      const why = co.refusedBy; /* MUTANT */',
    why: 'The 21:30 push cannot say why the fallback did not run.',
  },

  /* ── F: the pool ── */
  {
    id: 'CO-F-i. ★★★ the tracker\'s nameplate answer is a ratio (the pool on nameplate, the line under the cushion)',
    file: NCA, tests: [T_CO],
    find: "  const ratioKnown = (sc: CushionPoolScale | null | undefined): boolean => sc != null && sc.basis !== 'nameplate'",
    to: "  const ratioKnown = (sc: CushionPoolScale | null | undefined): boolean => sc != null /* MUTANT */",
    why: 'L 1.63-1.70 kW writes 27%, holding 9.57 kWh at the true ×0.944 against a 9.75-10.12 kWh cushion.',
  },
  {
    id: 'CO-F-ii. ★★ (critique) no ratio known refuses instead of planning on the floor',
    file: NCA, tests: [T_CO],
    find: '  const coPoolFloor = cushionOnly != null && !ratioKnown(cushionPoolScale) && floorOk ? cushionOnlyFloorScale! : null;',
    to: '  const coPoolFloor = null as number | null; /* MUTANT */',
    why: 'An unreadable worker file at boot refuses every dark night: nothing charges.',
  },
  {
    id: 'CO-F-iii. ★★ the floor named as the packs\' measured capacity',
    file: NCA, tests: [T_CO],
    find: "    ? planScale.basis === 'floor'",
    to: "    ? (false as boolean) /* MUTANT */",
    why: '"% of the packs\' measured capacity at ×0.800" for a figure nothing measured.',
  },

  /* ── E: the evening ── */
  {
    id: 'CO-E-i. ★★★ (critique) a transient refusal\'s fallback arms at 21:30 and latches',
    file: NCA, tests: [T_CO],
    find: '  return (plan == null || (!plan.basisComplete && plan.basisTransient === true) || plan.cushionOnly?.transient === true)',
    to: '  return (plan == null || (!plan.basisComplete && plan.basisTransient === true)) /* MUTANT */',
    why: 'A restart at 21:10 latches a smaller resilience arm in place of the cost plan minutes away (161 of 365 21:30 plans, ~19 kWh each).',
  },
  {
    id: 'CO-E-ii. ★★ the fallback\'s transience lost on the plan',
    file: NCA, tests: [T_CO],
    find: '  const basisTransient = cushionOnly == null && solarBasisTransient;',
    to: '  const basisTransient = solarBasisTransient; /* MUTANT */',
    why: 'A sized plan reads as a transient refusal: the inputs say refused while the plan charges.',
  },

  /* ── T: the texts ── */
  {
    id: 'CO-T-i. ★★★ the disclosure dropped',
    file: NCA, tests: [T_CO],
    find: '    return { ...plan, rationale: `${plan.rationale}${cushionOnlyText(field, plan)}`, cushionOnly: field };',
    to: '    return { ...plan, cushionOnly: field }; /* MUTANT */',
    why: 'A plan with no solar basis reads as a full one.',
  },
  {
    id: 'CO-T-ii. ★★★ the plan\'s field dropped',
    file: NCA, tests: [T_CO],
    find: '    return { ...plan, rationale: `${plan.rationale}${cushionOnlyText(field, plan)}`, cushionOnly: field };',
    to: '    return { ...plan, rationale: `${plan.rationale}${cushionOnlyText(field, plan)}` }; /* MUTANT */',
    why: 'The push, the card and the ledger cannot tell a cushion-only plan from a full one.',
  },
  {
    id: 'CO-T-iii. ★★ (critique) the tail claims the cushion is held',
    file: NCA, tests: [T_CO],
    find: "    + 'so this plan is sized only to hold the outage cushion at the window close — no solar is credited, no solar calibration is used, '",
    to: "    + 'so this plan holds the outage cushion at the window close — no solar is credited, no solar calibration is used, ' /* MUTANT */",
    why: '69 armed plans fall short (the charge rate, an EV) and still say the cushion is held.',
  },
  {
    id: 'CO-T-iv. ★★★ the sizing basis says "P10 PV"',
    file: NCA, tests: [T_CO],
    find: '  const head = noPv ? NO_PV_WORST_CASE_BASIS : WORST_CASE_BASIS;',
    to: '  const head = WORST_CASE_BASIS; /* MUTANT */',
    why: 'A plan that credits no solar is labelled with the solar quantile it does not use.',
  },
  {
    id: 'CO-T-v. ★★ the expected clause credits PV',
    file: NCA, tests: [T_CO],
    find: "        ? `${walkStandbyW > 0 ? \"median load and the Cores' standby\" : 'median load'}, no solar credited`",
    to: "        ? `${walkStandbyW > 0 ? \"median load, PV and the Cores' standby\" : 'median load and PV'}` /* MUTANT */",
    why: '"median load, PV and the Cores\' standby" on a plan with every PV figure zeroed.',
  },
  {
    id: 'CO-T-vi. ★★★ the push keeps the projection and its confidence tier',
    file: NTF, tests: [T_CO],
    find: '  const projection = plan.cushionOnly != null\n',
    to: '  const projection = (false as boolean) /* MUTANT */\n',
    why: '"Confidence: forecast" on a plan that reads no forecast PV, and no word that the solar basis is refused.',
  },
  {
    id: 'CO-T-vii. ★★ the push title drops "outage cushion only"',
    file: NTF, tests: [T_CO],
    find: "  const cushionOnlyTitle = plan.cushionOnly == null ? '' : cushionOnlyFills(plan.cushionOnly, plan) ? ' — no solar basis, long-gap fill' : ' — outage cushion only';",
    to: "  const cushionOnlyTitle = ''; /* MUTANT */",
    why: 'The phone shows a full plan\'s title.',
  },
  {
    id: 'CO-T-xiv. ★★ the Friday fill\'s push title says "outage cushion only"',
    file: NTF, tests: [T_CO],
    find: "  const cushionOnlyTitle = plan.cushionOnly == null ? '' : cushionOnlyFills(plan.cushionOnly, plan) ? ' — no solar basis, long-gap fill' : ' — outage cushion only';",
    to: "  const cushionOnlyTitle = plan.cushionOnly == null ? '' : ' — outage cushion only'; /* MUTANT */",
    why: '"charging toward ~90% tonight — outage cushion only": the title denies the fill the night arms.',
  },
  {
    id: 'CO-T-xv. ★★ the Friday fill\'s rationale says "sized only to hold the outage cushion"',
    file: NCA, tests: [T_CO],
    find: '  const head = costFill\n    ? ` NO SOLAR BASIS; THE OUTAGE CUSHION AND THE LONG-GAP FILL: the solar basis is refused (${co.refusedBy}), `\n',
    to: '  const head = (false as boolean) /* MUTANT */\n    ? ` NO SOLAR BASIS; THE OUTAGE CUSHION AND THE LONG-GAP FILL: the solar basis is refused (${co.refusedBy}), `\n',
    why: 'An "only" claim false on the fill path: the plan is sized to the 90% ceiling and says it holds the cushion only.',
  },
  {
    id: 'CO-T-xvi. ★★ the Friday fill\'s push basis says "Outage cushion only"',
    file: NTF, tests: [T_CO],
    find: "  const basis = costFill ? 'No solar basis' : 'Outage cushion only; no solar basis';",
    to: "  const basis = 'Outage cushion only; no solar basis'; /* MUTANT */",
    why: 'The push body calls the fill night cushion-only beside the fill it states.',
  },
  {
    id: 'CO-T-xvii. ★★ the card\'s Friday fill reads "cushion only"',
    file: CARD, tests: [T_CO],
    find: "  return cushionOnlyFillsCard(co, plan) ? 'cushion + long-gap fill' : 'cushion only';",
    to: "  return 'cushion only'; /* MUTANT */",
    why: 'The card\'s Basis stat contradicts its own disclosure on a fill night.',
  },
  {
    id: 'CO-T-xviii. ★★ the card\'s disclosure drifts from the server\'s on the fill',
    file: CARD, tests: [T_CO],
    find: '    ? ` NO SOLAR BASIS; THE OUTAGE CUSHION AND THE LONG-GAP FILL: the solar basis is refused (${co.refusedBy}), so this plan is sized only on the outage cushion at the window close and, before the gap, the long-gap fill',
    to: '    ? ` OUTAGE CUSHION ONLY; NO SOLAR BASIS: the solar basis is refused (${co.refusedBy}), so this plan is sized only on the outage cushion at the window close and, before the gap, the long-gap fill /* MUTANT */',
    why: 'The card and the rationale disagree word for word on a fill night.',
  },
  {
    id: 'CO-T-xix. ★★ the log line says the fill night is the cushion alone',
    file: IDX, tests: [T_CO],
    find: '    const coFills = plan.cushionOnly != null && cushionOnlyFills(plan.cushionOnly, plan);\n',
    to: '    const coFills = false; /* MUTANT */\n',
    why: 'The log reads "sized on the outage cushion at the window close alone" on the night it fills toward 90%.',
  },
  {
    id: 'CO-T-viii. ★★ (owner) the push says "no cost target" on Friday\'s fill',
    file: NTF, tests: [T_CO],
    find: "    + `${costFill ? 'no cost target but the long-gap fill' : 'no cost target'}.${gap}`;",
    to: "    + `no cost target.${gap}`; /* MUTANT */",
    why: 'Friday\'s push denies the fill it arms.',
  },
  {
    id: 'CO-T-ix. ★★ a sized hold\'s push drops the basis',
    file: NTF, tests: [T_CO],
    find: "    const provisionalHold = provisionalBandText(plan.pvBandWiden) + cushionOnlyPushText(plan, 'short');",
    to: '    const provisionalHold = provisionalBandText(plan.pvBandWiden); /* MUTANT */',
    why: 'A cushion-only hold reads as a full-basis hold.',
  },
  {
    id: 'CO-T-x. ★★★ the card\'s disclosure drops',
    file: CARD, tests: [T_CO],
    find: '    + provisionalBandText(plan.pvBandWiden) + cushionOnlyCardText(plan.cushionOnly, plan);',
    to: '    + provisionalBandText(plan.pvBandWiden); /* MUTANT */',
    why: 'The card disagrees with the rationale and the push.',
  },
  {
    id: 'CO-T-xi. ★★ the card\'s sizing line says "P10 PV"',
    file: CARD, tests: [T_CO],
    find: "  const pv = plan.cushionOnly != null ? 'no PV' : 'P10 PV';",
    to: "  const pv = 'P10 PV'; /* MUTANT */",
    why: 'The card names a solar quantile the plan does not use.',
  },
  {
    id: 'CO-T-xii. ★★ the card\'s Basis stat kept as the confidence tier',
    file: CARDX, tests: [T_CO],
    find: '        {plan.cushionOnly != null\n',
    to: '        {(false as boolean) /* MUTANT */\n',
    why: 'The card shows "Confidence: forecast" for a plan that reads no forecast PV.',
  },
  {
    id: 'CO-T-xiii. ★★ the stale-panel NOTE says "sized on" beside a refused plan',
    file: IDX, tests: [T_CO],
    find: '    plan.rationale += plan.basisComplete\n',
    to: '    plan.rationale += (true as boolean) /* MUTANT */\n',
    why: 'A refused plan claims to be sized on a reading nothing was sized on.',
  },

  /* ── S: the seed ── */
  {
    id: 'CO-S-i. ★★★ the seed applied over the tracker\'s own ratios',
    file: PEB, tests: [T_CO],
    find: '    if (this.cores.size === 0) this.loadSeed();',
    to: '    this.loadSeed(); /* MUTANT */',
    why: 'A tracker that has measured is overwritten by the worker\'s older figures.',
  },
  {
    id: 'CO-S-ii. ★★★ the seed\'s timestamps replaced by now (never ages out)',
    file: PEB, tests: [T_CO],
    find: '        if (h && Number.isFinite(h.ratio) && h.ratio > 0 && Number.isFinite(h.atMs)) this.cores.set(sn, { ratio: h.ratio, atMs: h.atMs });',
    to: '        if (h && Number.isFinite(h.ratio) && h.ratio > 0 && Number.isFinite(h.atMs)) this.cores.set(sn, { ratio: h.ratio, atMs: Date.now() }); /* MUTANT */',
    why: 'The planner counts the held ×0.944 past the runway\'s age-out, at a scale the runway no longer uses.',
  },
  {
    id: 'CO-S-iii. ★★ the worker\'s panel figures seeded too',
    file: PEB, tests: [T_CO],
    find: '  private loadSeed(): void {\n    if (!this.seedPath) return;',
    to: "  private loadSeed(): void {\n    if (!this.seedPath) return;\n    try { const r = JSON.parse(readFileSync(this.seedPath, 'utf8')) as Partial<PersistShape>; for (const [sn, p] of Object.entries(r?.panels ?? {})) if (p && Number.isFinite(p.scale)) this.panels.set(sn, { scale: clampScale(p.scale), pendingScale: null, pendingSinceMs: null }); } catch { /* MUTANT */ }",
    why: 'An applied figure of the worker\'s holds this tracker\'s first measurement under it for a day.',
  },
  {
    id: 'CO-S-iv. ★★★ index.ts builds the cushion tracker unseeded',
    file: IDX, tests: [T_SCOPE],
    find: ", seedPath: defaultPoolEnergyBasisPath('pool-energy-basis') });",
    to: ' }); /* MUTANT */',
    why: 'The planner counts the pool on nameplate while the runway counts it held: the line 2-5% short of the cushion.',
  },

  /* ── I: index.ts's wiring ── */
  {
    id: 'CO-I-i. ★★★ the flag on a shadow leg',
    file: IDX, tests: [T_CO],
    find: '    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole) && panel.fresh,\n',
    to: '    cushionOnlyEligible: lineForceChargeOn(legRole) && panel.fresh, /* MUTANT */\n',
    why: 'The mid-day shadow and the morning refresh size cushion-only legs.',
  },
  {
    id: 'CO-I-ii. ★★★ the flag on a stale panel (the 22:30 last resort)',
    file: IDX, tests: [T_CO],
    find: '    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole) && panel.fresh,\n',
    to: '    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole), /* MUTANT */\n',
    why: 'A hold decided on a stale SoC claims a cushion the pool may not have.',
  },
  {
    id: 'CO-I-iii. ★★★ the flag in advisory mode',
    file: IDX, tests: [T_CO],
    find: '    cushionOnlyEligible: shadowLeg == null && lineForceChargeOn(legRole) && panel.fresh,\n',
    to: '    cushionOnlyEligible: shadowLeg == null && panel.fresh, /* MUTANT */\n',
    why: 'Advisory mode hands HA a charge_tonight it never gated.',
  },
  {
    id: 'CO-I-iv. ★★ the capacity floor not passed',
    file: IDX, tests: [T_SCOPE],
    find: '    cushionOnlyFloorScale: CAPACITY_SCALE_MIN,\n',
    to: '    /* MUTANT */\n',
    why: 'With no ratio known every dark night is refused by name.',
  },

  /* ── L / C: the ledger and the scorer ── */
  {
    id: 'CO-L-i. ★★★ the ledger column written only when set (a re-issued full plan keeps the refusal)',
    file: IDX, tests: [T_CO],
    find: '    cushion_only_refused_by: plan.cushionOnly?.refusedBy ?? null,\n',
    to: '    ...(plan.cushionOnly != null ? { cushion_only_refused_by: plan.cushionOnly.refusedBy } : {}), /* MUTANT */\n',
    why: 'A cushion-only row re-issued as a full plan is left unscored for good.',
  },
  {
    id: 'CO-C-i. ★★★ the scorer branch removed (a cushion-only row scored against a solar forecast it never used)',
    file: IDX, tests: [T_CO],
    find: '  } else if (y.cushion_only_refused_by != null) {',
    to: '  } else if ((false as boolean) && y.cushion_only_refused_by != null) { /* MUTANT */',
    why: 'planBuy + (0 − actualPv)/0.927 reads as a large over-buy and lowers the under-buy rate.',
  },
  {
    id: 'CO-C-iii. ★★ (design) the scorer branch after the held branch (a held cushion-only row gets the held note, no cushion-only word)',
    file: IDX, tests: [T_CO],
    find: "  } else if (y.cushion_only_refused_by != null) {\n    // ★★★ v1.203.0 — a CUSHION-ONLY row is never scored, in any outcome (the Cores' actuals covered included): its buy was sized on\n    // the outage cushion with no solar credited, so the planner-sizing metric has no solar forecast to grade, and a buy_err against\n    // a forecast the buy never used would read as an over-buy. Before the held branch, with the held verdict (and its marker) when\n    // there is one, as basisIncompleteNote does. The realized cushion verdict below still grades the one claim the plan made.\n    scoreNotes = cushionOnlyNote(heldVerdict, deviceNameOf, y.cushion_only_refused_by);\n  } else if (heldVerdict != null) {\n    scoreNotes = heldLedgerNote(heldVerdict, deviceNameOf);\n",
    to: "  } else if (heldVerdict != null) {\n    scoreNotes = heldLedgerNote(heldVerdict, deviceNameOf);\n  } else if (y.cushion_only_refused_by != null) { /* MUTANT */\n    scoreNotes = cushionOnlyNote(heldVerdict, deviceNameOf, y.cushion_only_refused_by);\n",
    why: 'A held cushion-only row reads as an ordinary held row: the ledger no longer says it was sized with no solar credited.',
  },
  {
    id: 'CO-L-ii. ★★★ the column dropped from the ledger allowlist (the scorer\'s key never stored)',
    file: REC, tests: [T_CO],
    find: "  // v1.203.0 — a cushion-only plan's solar refusal.\n  'cushion_only_refused_by',\n",
    to: "  // v1.203.0 — a cushion-only plan's solar refusal. /* MUTANT */\n",
    why: 'The upsert drops the column: every cushion-only row is scored against a solar forecast it never used.',
  },
  {
    id: 'CO-C-ii. ★★ the note loses the held marker',
    file: NLS, tests: [T_CO],
    find: '  const head = `not scored — a cushion-only plan (no solar basis: ${refusedBy}): its buy was sized on the outage cushion at the window close with no solar credited, so the planner-sizing metric has no solar forecast to grade.`;\n  if (v == null) return head;',
    to: '  const head = `not scored — a cushion-only plan (no solar basis: ${refusedBy}): its buy was sized on the outage cushion at the window close with no solar credited, so the planner-sizing metric has no solar forecast to grade.`;\n  if (v == null || (true as boolean)) return head; /* MUTANT */',
    why: 'The held repair resets the row every sweep (no marker to see it repaired).',
  },

  /* ── H: the hold point (owner) ── */
  {
    id: 'CO-H-i. ★★★ (critique, high) the write is ⌈line⌉ (the panel holds a point under it)',
    file: NCA, tests: [T_HOLD, T_SET],
    find: '  return ask + undershootPct <= RESERVE_WRITE_MAX_PCT ? ask + undershootPct : ask;',
    to: '  return ask; /* MUTANT */',
    why: 'All 11 reserve-only charge-ups to 50 closed at 49: 239 of 260 dark-year charge-ups close under their line, each a strike.',
  },
  {
    id: 'CO-H-ii. ★★★ the hold point is 0',
    file: HW, tests: [T_HW, T_HOLD],
    find: 'export const PANEL_RESERVE_HOLD_UNDERSHOOT_PCT = 1;',
    to: 'export const PANEL_RESERVE_HOLD_UNDERSHOOT_PCT = 0; /* MUTANT */',
    why: 'The constant no longer states the measurement the trace pins.',
  },
  {
    id: 'CO-H-iii. ★★★ a line in (49, 50] is the reserve\'s (its 50% write holds 49)',
    file: NCA, tests: [T_HOLD, T_LFC],
    find: '  return lineAskPct + undershootPct > RESERVE_WRITE_MAX_PCT;',
    to: '  return lineAskPct > RESERVE_WRITE_MAX_PCT; /* MUTANT */',
    why: 'A 49.97% line is written 50 and held at 49 with nothing carrying it or saying so.',
  },
  {
    id: 'CO-H-iv. ★★★ the force-charge asked at 50 for a line in (49, 50] (it rides only above the reserve)',
    file: NCA, tests: [T_HOLD, T_LFC],
    find: '  const lineForceAsk = Math.max(lineAsk, RESERVE_WRITE_MAX_PCT + holdUndershootPct);',
    to: '  const lineForceAsk = lineAsk; /* MUTANT */',
    why: 'The record\'s ask is 50: forceChargeModeOf reads it as none, and the night armed for its line runs nothing.',
  },
  {
    id: 'CO-H-v. ★★ the point on a disabled cushion (a raise above the owner\'s own floor)',
    file: NCA, tests: [T_SET],
    find: "    ? lineReserveAskPct(targetFloorKwh, fullKwh, cushionBasis === 'islanded-outage' ? holdUndershootPct : 0) : 0;",
    to: '    ? lineReserveAskPct(targetFloorKwh, fullKwh, holdUndershootPct) : 0; /* MUTANT */',
    why: 'A disabled cushion writes its floor + 1: a raise of a reserve no outage line asks for.',
  },
  {
    id: 'CO-H-vi. ★★★ a line in (49, 50] said to be above the 50% reserve',
    file: NFC, tests: [T_HOLD, T_LFC],
    find: "  if (linePct > max) return form === 'reserve' ? `the ${max}% reserve` : form === 'accepts' ? `the ${max}% the panel accepts as a reserve` : `the ${max}% the panel holds as a reserve`;",
    to: "  if ((true as boolean)) return form === 'reserve' ? `the ${max}% reserve` : form === 'accepts' ? `the ${max}% the panel accepts as a reserve` : `the ${max}% the panel holds as a reserve`; /* MUTANT */",
    why: '"tonight\'s 49.6% outage line is above the 50% reserve": false.',
  },
  {
    id: 'CO-H-vii. ★★ the rationale\'s envelope sentence says a line in (49, 50] is above the reserve',
    file: NCA, tests: [T_HOLD, T_LFC],
    find: '  const lineText = lineAsk <= RESERVE_WRITE_MAX_PCT\n',
    to: '  const lineText = (false as boolean) /* MUTANT */\n',
    why: '"The reserve is set to 50%, …; tonight\'s 49.97% outage line is above it": false.',
  },
  {
    id: 'CO-H-viii. ★★ the foreign push leaves out that a line in (49, 50] may close under',
    file: NTF, tests: [T_UNHELD],
    find: "${l.linePct > RESERVE_WRITE_MAX_PCT - PANEL_RESERVE_HOLD_UNDERSHOOT_PCT ? ' The pool may close under the line.' : ''}",
    to: "${l.linePct > RESERVE_WRITE_MAX_PCT ? ' The pool may close under the line.' : ''} /* MUTANT */",
    why: 'A 50% reserve holds 49, under a 50% line: the push says nothing of the risk.',
  },
  {
    id: 'CO-H-ix. ★★ the reserve sentence does not name the point',
    file: NCA, tests: [T_SET, T_GOLDEN],
    find: '  const askWords = holdPointAdded\n',
    to: '  const askWords = (false as boolean) /* MUTANT */\n',
    why: 'A 33% write for a 31.13% line is called the resilience requirement with nothing saying why a point more.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-cushion-only', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
