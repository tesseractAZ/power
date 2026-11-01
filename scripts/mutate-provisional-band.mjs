#!/usr/bin/env node
/**
 * mutate-provisional-band.mjs — committed harness for v1.198.0's provisional solar band
 * (server/src/nightChargeAdvisor.ts PROVISIONAL_BAND_WIDEN / buildNightChargeInputs, its production
 * bridge in index.ts, and the sentence the plan, the card and the evening push state).
 *
 * WHY COMMITTED: the night-charge planner refused every plan until the PV band had 14 scored
 * calibration days. After a stretch of cloud-offline Cores (every dark day a coverage gap, v1.196.0)
 * that meant about two weeks of nights at the reserve floor once they reported again. From 4 scored
 * days the planner now sizes on a WIDER band: the P10 PV is pushed below the published P10 by a
 * Student-t factor k(n), and the beyond-24 h carry widens by k × the band's own lower half-width.
 * Each rail below is what keeps that in the safe direction, and exactly 1 from 14 days on; each
 * mutant reverts ONE of them, and the suite must kill it by a named assertion.
 *
 *   MUTATE_CONCURRENCY=2 node scripts/mutate-provisional-band.mjs
 *
 * ★ Anchor-asserted (a moved anchor aborts, never a green run against an unmutated tree); a red
 *   subset baseline aborts; each mutant runs in its own copy of the tree (scripts/lib/mutateParallel.mjs).
 * ★ A harness run is evidence only on a GREEN baseline: run the suite first.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const NCA = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const NOTIFY = resolve(SERVER, 'src/notify.ts');
const CARD = resolve(REPO, 'web/src/cards/nightChargeText.ts');

const SUBSET = ['test/provisionalBand.test.ts', 'test/legacyIdentity.test.ts', 'test/thursdayHeadroom.test.ts', 'test/noPlanReason.test.ts'];

const MUTANTS = [
  /* ── the widening itself ── */
  {
    id: 'i. ★★★ k forced to 1: a provisional plan sized on the band as published',
    file: NCA,
    find: '  const provisionalK = provisionalDays ? provisionalBandWiden(calScoredDays) : null;',
    to: '  const provisionalK = provisionalDays ? 1 : null; /* MUTANT */',
    why: 'Four days of evidence trusted as fourteen: the plan the review approved as conservative is not.',
  },
  {
    id: 'ii. ★★★ the provisional range includes the 14th day',
    file: NCA,
    find: '  const provisionalDays = basisGatePasses && calScoredDays < minCalScoredDays;',
    to: '  const provisionalDays = basisGatePasses && calScoredDays <= minCalScoredDays; /* MUTANT */',
    why: 'At 14 days the plan still moves: the multi-day carry widens by the band half-width instead of the realized one.',
  },
  {
    id: 'iii. ★★★ the transforms run with k = 1 on the full basis',
    file: NCA,
    find: '  const bandWidenK: number | null = basisComplete ? provisionalK : null;',
    to: '  const bandWidenK: number | null = basisComplete ? (provisionalK ?? 1) : null; /* MUTANT */',
    why: 'Every full-basis plan changes (an hour with no P50 goes to 0, the carry widens by H): byte identity is lost.',
  },
  {
    id: 'iv. ★★★ the direction flipped: P50 − (P50 − P10)/k',
    file: NCA,
    find: '  return Math.min(p10, Math.max(0, p50W - k * (p50W - p10)));',
    to: '  return Math.min(p10, Math.max(0, p50W - (p50W - p10) / k)); /* MUTANT */',
    why: 'The widening narrows instead, and the min() hides it as no widening at all.',
  },
  {
    id: 'v. ★★★ min() removed: the widened P10 can rise above the published one',
    file: NCA,
    find: '  return Math.min(p10, Math.max(0, p50W - k * (p50W - p10)));',
    to: '  return Math.max(0, p50W - k * (p50W - p10)); /* MUTANT */',
    why: 'A band the ceiling clamp inverted (P10 above P50) is widened UPWARD — more sun than the band states.',
  },
  {
    id: 'vi. ★★★ no P50: the published P10 is kept',
    file: NCA,
    find: '  if (p50W == null || !Number.isFinite(p50W)) return 0;',
    to: '  if (p50W == null || !Number.isFinite(p50W)) return p10; /* MUTANT */',
    why: 'An hour the band gives no median for is credited its unwidened P10.',
  },
  {
    id: 'vii. ★★ the P50 walks lose the stand-in they read',
    file: NCA,
    find: '      if (h.pvP50W == null) h.pvP50W = h.pvP10W;',
    to: '      if ((false as boolean) && h.pvP50W == null) h.pvP50W = h.pvP10W; /* MUTANT */',
    why: 'The expected start and buy fall with the sizing P10 on an hour with no P50: the disclosure moves with the guard.',
  },
  {
    id: 'viii. ★★★ the median widened too',
    file: NCA,
    find: '      if (h.pvP50W == null) h.pvP50W = h.pvP10W;',
    to: '      h.pvP50W = h.pvP50W == null ? h.pvP10W : widened; /* MUTANT */',
    why: 'The expected buy, the expected start and the shadow figures move: the P50 is the published one.',
  },
  {
    id: 'ix. ★★ the table shifted by a day',
    file: NCA,
    find: '  4: 1.3102, 5: 1.2018, 6: 1.1407, 7: 1.1013, 8: 1.0738,',
    to: '  4: 1.2018, 5: 1.1407, 6: 1.1013, 7: 1.0738, 8: 1.0535, /* MUTANT */',
    why: 'Each provisional night is widened as if it had one more scored day than it has.',
  },
  {
    id: 'x. ★★ a band that states no sun reads as a narrow one',
    file: NCA,
    find: '  return p50Wh < 500 ? 1 : halfWh / p50Wh;',
    to: '  return p50Wh < 500 ? 0 : halfWh / p50Wh; /* MUTANT */',
    why: 'No P50 to measure the width by leaves the multi-day carry unwidened — the latent `?? 0` again.',
  },
  /* ── the gate ── */
  {
    id: 'xi. ★★★ the provisional minimum lowered by a day (3)',
    file: NCA,
    find: '    calScoredDays >= provisionalMinDays &&',
    to: '    calScoredDays >= provisionalMinDays - 1 && /* MUTANT */',
    why: 'Three days admit the basis: no 3-day sample supports the band\'s nominal 80%.',
  },
  {
    id: 'xii. ★★★ the provisional minimum raised by a day (5)',
    file: NCA,
    find: '    calScoredDays >= provisionalMinDays &&',
    to: '    calScoredDays >= provisionalMinDays + 1 && /* MUTANT */',
    why: 'One more night at the reserve floor after every return.',
  },
  {
    id: 'xiii. ★★★ the coverage gate skipped on a provisional basis',
    file: NCA,
    find: '    bandCoverageFrac >= BASIS_MIN_BAND_COVERAGE;',
    to: '    (bandCoverageFrac >= BASIS_MIN_BAND_COVERAGE || calScoredDays < minCalScoredDays); /* MUTANT */',
    why: 'Three of four days outside the band still plan — an overconfident band admitted because it is young.',
  },
  {
    id: 'xiv. ★★★ a day count with no widening is planned unwidened',
    file: NCA,
    find: '  const basisComplete = basisGatePasses && (!provisionalDays || provisionalK != null);',
    to: '  const basisComplete = basisGatePasses; /* MUTANT */',
    why: 'A provisional minimum under the table plans on the band as published.',
  },
  {
    id: 'xv. ★★ a non-finite provisional minimum is taken as given',
    file: NCA,
    find: '  const provisionalMinDays = provisionalMinCalScoredDays != null && Number.isFinite(provisionalMinCalScoredDays)',
    to: '  const provisionalMinDays = provisionalMinCalScoredDays != null /* MUTANT */',
    why: 'A NaN configuration names no gate the owner can read ("need NaN"), not the full minimum.',
  },
  {
    id: 'xvi. ★★ a provisional minimum above the full one stands',
    file: NCA,
    find: '    ? Math.min(provisionalMinCalScoredDays, minCalScoredDays) : minCalScoredDays;',
    to: '    ? provisionalMinCalScoredDays : minCalScoredDays; /* MUTANT */',
    why: 'A full basis is refused for want of more days than the full band needs.',
  },
  {
    id: 'xvii. ★★ the refusal still says "need 14"',
    file: NCA,
    find: '          ? `only ${calScoredDays} scored calibration day(s), need ${provisionalMinDays}`',
    to: '          ? `only ${calScoredDays} scored calibration day(s), need ${minCalScoredDays}` /* MUTANT */',
    why: 'The 21:30 push tells the owner ten more days than the planner waits for.',
  },
  {
    id: 'xviii. ★ a non-number coverage is not named as a coverage miss',
    file: NCA,
    find: '          : !(bandCoverageFrac >= BASIS_MIN_BAND_COVERAGE)',
    to: '          : bandCoverageFrac < BASIS_MIN_BAND_COVERAGE /* MUTANT */',
    why: 'A NaN coverage is reported as a missing widening instead of the coverage it is.',
  },
  /* ── the multi-day carry and the long-gap headroom ── */
  {
    id: 'xix. ★★★ the provisional carry left at `?? 0`',
    file: NCA,
    find: '    const widen = Math.max(0, provisionalRollupHalfFrac ?? realizedDailyErrHalfFrac) * Math.sqrt(da);',
    to: '    const widen = Math.max(0, realizedDailyErrHalfFrac) * Math.sqrt(da); /* MUTANT */',
    why: 'Beyond 24 h a provisional plan sizes on the central forecast — the latent default the review found.',
  },
  {
    id: 'xx. ★★★ the band half-width used on the full basis too',
    file: NCA,
    find: '    const widen = Math.max(0, provisionalRollupHalfFrac ?? realizedDailyErrHalfFrac) * Math.sqrt(da);',
    to: '    const widen = Math.max(0, provisionalRollupHalfFrac ?? bandLowerHalfFrac(bandHours)) * Math.sqrt(da); /* MUTANT */',
    why: 'Every full-basis plan carries a wider week than its 14 days measured: byte identity is lost.',
  },
  {
    id: 'xxi. ★★ the carry widens by H without k',
    file: NCA,
    find: '    provisionalRollupHalfFrac = bandWidenK * bandLowerHalfFrac(bandHours);',
    to: '    provisionalRollupHalfFrac = bandLowerHalfFrac(bandHours); /* MUTANT */',
    why: 'The multi-day carry is widened less than the day ahead.',
  },
  {
    id: 'xxii. ★★★ the long-gap headroom keeps the unwidened P10',
    file: NCA,
    find: '        hours: prePeakSurplusBasis.hours.map((h) => ({ ts: h.ts, p10W: provisionalP10W(h.p10W, h.p50W, bandWidenK), loadW: h.loadW })),',
    to: '        hours: prePeakSurplusBasis.hours.map((h) => ({ ts: h.ts, p10W: h.p10W, loadW: h.loadW })), /* MUTANT */',
    why: 'A provisional long-gap night leaves the published P10 surplus as headroom and buys less.',
  },
  {
    id: 'xxiii. ★★★ no pre-peak hours: the published surplus stands',
    file: NCA,
    find: '    : prePeakSurplusBasis != null',
    to: '    : prePeakSurplusBasis == null ? publishedPrePeakP10Kwh : prePeakSurplusBasis != null /* MUTANT */',
    why: 'A surplus the provisional plan could not widen is used as it is, instead of set aside.',
  },
  /* ── what the plan says ── */
  {
    id: 'xxiv. ★★ the published 24 h P10 reported as the widened one',
    file: NCA,
    find: '      publishedWh += h.pvP10W;',
    to: '      publishedWh += widened; /* MUTANT */',
    why: 'The plan says "21.9 → 21.9 kWh": the widening it was sized on is invisible.',
  },
  {
    id: 'xxv. ★★★ the provisional field emitted on every sized plan',
    file: NCA,
    find: '  return w != null && plan.basisComplete && plan.requiredExtraKwh != null',
    to: '  return plan.basisComplete && plan.requiredExtraKwh != null /* MUTANT */',
    why: 'Full-basis plans gain a key (and an empty sentence): byte identity is lost.',
  },
  {
    id: 'xxvi. ★★ a provisional hold says nothing',
    file: NCA,
    find: '  return w != null && plan.basisComplete && plan.requiredExtraKwh != null',
    to: '  return w != null && plan.basisComplete && plan.chargeTonight /* MUTANT */',
    why: 'A hold sized on the widened band reads as a full-basis hold.',
  },
  {
    id: 'xxvii. ★★ the rationale drops the sentence',
    file: NCA,
    find: '    ? { ...plan, rationale: `${plan.rationale}${provisionalBandText(w)}`, pvBandWiden: { ...w } }',
    to: '    ? { ...plan, pvBandWiden: { ...w } } /* MUTANT */',
    why: 'The 21:30 log and the ledger rationale say nothing of the provisional band.',
  },
  {
    id: 'xxviii. ★★ the inputs carry the field on the full basis',
    file: NCA,
    find: '    ...(pvBandWiden != null ? { pvBandWiden } : {}),',
    to: '    pvBandWiden: pvBandWiden ?? undefined, /* MUTANT */',
    why: 'A full-basis input gains a key: what the planner was handed is no longer what it was.',
  },
  {
    id: 'xxix. ★★ the evening push drops the sentence',
    file: NOTIFY,
    find: "  const provisionalNote = plan.pvBandWiden != null ? `${provisionalBandText(plan.pvBandWiden).trim()} ` : '';",
    to: "  const provisionalNote = (false as boolean) ? `${provisionalBandText(plan.pvBandWiden).trim()} ` : ''; /* MUTANT */",
    why: 'The push states a provisional plan as a full-basis one.',
  },
  {
    id: 'xxx. ★★ the card drops the sentence',
    file: CARD,
    find: '    + provisionalBandText(plan.pvBandWiden);',
    to: "    + ''; /* MUTANT */",
    why: 'The card states a provisional plan as a full-basis one.',
  },
  {
    id: 'xxxi. ★ the card\'s sentence drifts from the server\'s',
    file: CARD,
    find: '    + ` is widened ×${w.factor.toFixed(2)} (the next 24 h: ~${r1(w.bandP10Kwh)} → ~${r1(w.widenedP10Kwh)} kWh)`',
    to: '    + ` is widened ×${w.factor.toFixed(1)} (the next 24 h: ~${r1(w.bandP10Kwh)} → ~${r1(w.widenedP10Kwh)} kWh)` /* MUTANT */',
    why: 'The card and the push disagree on the factor.',
  },
  /* ── the production bridge ── */
  {
    id: 'xxxii. ★★★ index.ts never passes the provisional minimum',
    file: IDX,
    find: '    confidenceTier, forecastPresent, calScoredDays, minCalScoredDays: NIGHT_MIN_CAL_DAYS, provisionalMinCalScoredDays: NIGHT_PROVISIONAL_MIN_CAL_DAYS, bandCoverageFrac,',
    to: '    confidenceTier, forecastPresent, calScoredDays, minCalScoredDays: NIGHT_MIN_CAL_DAYS, bandCoverageFrac, /* MUTANT */',
    why: 'Every unit test passes and the live planner still waits two weeks.',
  },
  {
    id: 'xxxiii. ★★★ index.ts sets the provisional minimum to 3',
    file: IDX,
    find: 'const NIGHT_PROVISIONAL_MIN_CAL_DAYS = 4;',
    to: 'const NIGHT_PROVISIONAL_MIN_CAL_DAYS = 3; /* MUTANT */',
    why: 'The live gate would refuse 3 days only by the table\'s fail-closed refusal, under the wrong name.',
  },
  {
    id: 'xxxiv. ★★★ index.ts drops the pre-peak hours',
    file: IDX,
    find: '    costSurplusLoad,\n    // v1.198.0 — the hours that surplus was summed over: a provisional basis sums it again, widened.\n    prePeakSurplusBasis,\n',
    to: '    costSurplusLoad, /* MUTANT */\n',
    why: 'Live provisional long-gap nights set the headroom aside while the unit test widens it.',
  },
  {
    id: 'xxxv. ★★★ index.ts hands the P10 in as the P50',
    file: IDX,
    find: '    if (fh) prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p10W, p50W: pb.p50W, loadW: fh.forecastLoadW });',
    to: '    if (fh) prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p10W, p50W: pb.p10W, loadW: fh.forecastLoadW }); /* MUTANT */',
    why: 'P50 − k·(P50 − P10) with P50 = P10 is the P10: the live pre-peak headroom is never widened.',
  },
  {
    id: 'xxxvi. ★★★ the ledger records another P10 than the published one',
    file: IDX,
    find: '    pvP10 += pb.p10W / 1000;',
    to: '    pvP10 += Math.min(pb.p10W, pb.p50W) / 1000; /* MUTANT */',
    why: 'pv_in_band is graded on a band the forecast never published (a scored column changes meaning).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-provisional-band', mutants: MUTANTS, subset: SUBSET, root: REPO });
