#!/usr/bin/env node
/**
 * mutate-panel-pv-basis.mjs — committed harness for v1.204.0: the night plan's solar from the PANEL'S OWN per-slot readings
 * (src{n}_pv_w) while the house Cores are dark on the vendor cloud, judged by a 7-day full-day energy balance (panelPvBasis.ts,
 * analytics/panelBasisInputs.ts, analytics.ts getPlanningForecast and the planning band, reports.ts), selected per night
 * (panelPvSelection.ts, index.ts recomputeNightChargePlan), said (nightChargeAdvisor.ts, notify.ts, the card, Home Assistant) and kept
 * apart from the readiness gate (nightLedgerScoring.ts, nightChargeGate.ts, recorder.ts).
 *
 * (R) THE RESOLVER: one source per slot-hour (G1 the Core's own meter with 3,500 s; G2, G3, the freeze detector, G11 for the field;
 * a gap is never 0 W). (K) THE CONSTANTS, per (slot, Core), on the panel's own capacity, ≥ 21 days and 20 charge hours. (U) THE UPPER
 * CHECK: field days only, the map of record, staleness, the judged-bad holds (G4, G6; M4, M5), G10, the night clip, the hysteresis,
 * the threshold 1.04 (owner). (A) ADMISSION: one predicate for the fit, bias, skill and ledger. (W) THE WORKER: the identity branch,
 * the caches per E, the runway untouched, the planning skill a realized-GHI reader. (S) THE SELECTION: (a)/(b)/(c) with M2, the
 * clauses of (b) in L1's precedence, the transient class, the latch (M1, L2), never a shadow leg. (T) THE WORDS: figures only (M3),
 * every hold's end, G4's grid input and force-charge, en and es, the push, the card. (H) HOME ASSISTANT (L6). (L) THE LEDGER (L5)
 * and (G) THE GATE. (O) THE OWNER'S DECISIONS: the haircut 1.00, every connected slot resolves, the runway at zero sun, 1.040 strict.
 *
 *   node scripts/mutate-panel-pv-basis.mjs [--only <id prefix>]
 *
 * ★ Every id starts PB- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK
 *   (one that does not is reported INVALID and fails the run); each mutant names the test files that must kill it, and only those
 *   run for it. Run on a GREEN tree, with TSX_DISABLE_CACHE=1.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PB = resolve(REPO, 'server/src/panelPvBasis.ts');
const PBI = resolve(REPO, 'server/src/analytics/panelBasisInputs.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const RPT = resolve(REPO, 'server/src/reports.ts');
const SEL = resolve(REPO, 'server/src/panelPvSelection.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const NTF = resolve(REPO, 'server/src/notify.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const GATE = resolve(REPO, 'server/src/nightChargeGate.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const MQTT = resolve(REPO, 'server/src/mqttDiscovery.ts');
const CARD = resolve(REPO, 'web/src/cards/nightChargeText.ts');

const T_UNIT = 'test/panelPvBasis.test.ts';
const T_REC = 'test/panelPvBasisRecord.test.ts';
const T_PF = 'test/planningForecast.test.ts';
const T_SEL = 'test/panelPvSelection.test.ts';
const T_REP = 'test/panelPvReplay.test.ts';
const T_CACHE = 'test/workerCacheInventory.test.ts';
const T_GHI = 'test/realizedGhiCapture.test.ts';
const T_CO = 'test/cushionOnlyPlan.test.ts';
const T_GOLD = 'test/legacyIdentity.test.ts';
const T_MQTT = 'test/mqttDiscovery.test.ts';

const MUTANTS = [
  /* ── R: the resolver ── */
  {
    id: 'PB-R-i. ★★★ the panel wins over a full Core hour',
    file: PB, tests: [T_UNIT, T_REC],
    find: "  if (h.coreCovS >= HOUR_COVER_MIN_S) return { source: 'core', w: (h.coreRawWh * 3600) / h.coreCovS };\n  if (ctx.admitted && fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: h.fieldWh as number };",
    to: "  if (ctx.admitted && fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: h.fieldWh as number }; /* MUTANT */\n  if (h.coreCovS >= HOUR_COVER_MIN_S) return { source: 'core', w: (h.coreRawWh * 3600) / h.coreCovS };",
    why: 'A Core reporting its own meter is overruled by the panel\'s reading: the Core era\'s days become field days.',
  },
  {
    id: 'PB-R-ii. ★★★ a daylight gap reads 0 W',
    file: PB, tests: [T_UNIT, T_PF],
    find: "  return { source: 'gap', w: null };",
    to: "  return { source: 'gap', w: 0 }; /* MUTANT */",
    why: 'An hour with no reading enters the planning fit as no sun: the model reads low and the walk takes the house for sunless.',
  },
  {
    id: 'PB-R-iii. ★★★ G2: an hour covers with 0 s (3,500 → 0)',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const HOUR_COVER_MIN_S = 3500;',
    to: 'export const HOUR_COVER_MIN_S = 0; /* MUTANT */',
    why: 'A scrap of a reading scaled to the hour stands for it; a Core with one row wins its slot-hour.',
  },
  {
    id: 'PB-R-iv. ★★★ G3 removed (an unverified field stands)',
    file: PB, tests: [T_UNIT, T_REC],
    find: "  if (!g3) return 'bridge';",
    to: "  /* MUTANT */",
    why: 'A slot the energy bridge never checked counts as solar.',
  },
  {
    id: 'PB-R-v. ★★★ G3 accepts a window booked for another Core',
    file: PB, tests: [T_UNIT],
    find: "    if (r.basis === 'measured' && core != null && r.sn === core) measured++;",
    to: "    if (r.basis === 'measured') measured++; /* MUTANT */",
    why: 'A swapped-in Core inherits the old Core\'s verification.',
  },
  {
    id: 'PB-R-vi. ★★ G3 at half the windows (0.80 → 0.50)',
    file: PB, tests: [T_UNIT],
    find: 'export const G3_MEASURED_MIN_FRAC = 0.8;',
    to: 'export const G3_MEASURED_MIN_FRAC = 0.5; /* MUTANT */',
    why: 'A slot-day the bridge booked "measured" for half its daylight counts as verified.',
  },
  {
    id: 'PB-R-vii. ★★★ the freeze detector removed',
    file: PB, tests: [T_UNIT],
    find: "  if (h.sun && h.frozen) return 'frozen';",
    to: '  /* MUTANT */',
    why: 'A field restating 2,400 W for three hours counts as solar.',
  },
  {
    id: 'PB-R-viii. ★★ the freeze run 2 → 50 restatements',
    file: PB, tests: [T_UNIT],
    find: 'export const FREEZE_RUN_PAIRS = 2;',
    to: 'export const FREEZE_RUN_PAIRS = 50; /* MUTANT */',
    why: 'A frozen field is caught after four hours instead of ten minutes.',
  },
  {
    id: 'PB-R-ix. ★★★ G11 removed (a daylight AC-charge hour counts as solar)',
    file: PB, tests: [T_UNIT],
    find: "  if (h.sun && h.acInS > G11_AC_IN_MIN_S && !provedUnderCharge) return 'ac-charge';",
    to: '  /* MUTANT */',
    why: 'A field that reads AC charge as PV stands in daylight before any night proof.',
  },
  {
    id: 'PB-R-x. ★★★ (A) the planning model ignores admission',
    file: PB, tests: [T_UNIT, T_PF],
    find: "  if (ctx.admitted && fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: h.fieldWh as number };",
    to: "  if (fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: h.fieldWh as number }; /* MUTANT */",
    why: 'A slot-day in a failed window reaches the fit, the bias and the skill.',
  },

  /* ── K: the constants ── */
  {
    id: 'PB-K-i. ★★★ the constants from 1 day (21 → 1)',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const CONSTANTS_MIN_DAYS = 21;',
    to: 'export const CONSTANTS_MIN_DAYS = 1; /* MUTANT */',
    why: 'A Core swapped in yesterday is judged on a fit of one day.',
  },
  {
    id: 'PB-K-ii. ★★ the constants with no charge hours (20 → 0)',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const CONSTANTS_MIN_CHARGE_HOURS = 20;',
    to: 'export const CONSTANTS_MIN_CHARGE_HOURS = 0; /* MUTANT */',
    why: 'g is fitted on no grid charge at all: the night side of the balance is unconstrained.',
  },
  {
    id: 'PB-K-iii. ★★★ the estimate on another capacity than the fit (×0.944)',
    file: PB, tests: [T_REC],
    find: '  const dE = ((h.pct1 - h.pct0) * capacityWh) / 100;',
    to: '  const dE = ((h.pct1 - h.pct0) * capacityWh * 0.944) / 100; /* MUTANT */',
    why: 'The constants telescope only on the capacity they were fitted on: the ratio moves with the pool scale.',
  },
  {
    id: 'PB-K-iv. ★★ the constants read an owner option (the runway\'s pool overhead)',
    file: PB, tests: [T_REC],
    find: '  return dE + (h.sun ? k.cd : k.cn) * h.outWh - k.g * h.inWh + (h.sun ? k.ed : k.en);',
    to: "  return dE + (h.sun ? k.cd : k.cn) * h.outWh - k.g * h.inWh + (h.sun ? k.ed : k.en) + Number(process.env.RUNWAY_POOL_OVERHEAD_FLOOR_W ?? 270); /* MUTANT */",
    why: 'The check moves with an owner\'s setting instead of the plant\'s own meters.',
  },
  {
    id: 'PB-K-v. ★★★ the field scaled before it counts (the haircut 1.00 → 0.95, owner)',
    file: PB, tests: [T_REC, T_UNIT],
    find: "  if (ctx.admitted && fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: h.fieldWh as number };",
    to: "  if (ctx.admitted && fieldHourRefusal(h, ctx.g3, ctx.provedUnderCharge) == null) return { source: 'field', w: (h.fieldWh as number) * 0.95 }; /* MUTANT */",
    why: 'The owner set the haircut at 1.00: the field reads 0.999 of the Cores\' meter on the record.',
  },

  /* ── U: the upper check ── */
  {
    id: 'PB-U-i. ★★★ the threshold 1.04 → 1.10',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const UC_THRESHOLD = 1.04;',
    to: 'export const UC_THRESHOLD = 1.10; /* MUTANT */',
    why: 'A ×1.05 over-read passes every window.',
  },
  {
    id: 'PB-U-ii. ★★ (owner) 1.040 is strict: a window at the threshold passes',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  if (worst.b.ratio > T) {',
    to: '  if (worst.b.ratio >= T) { /* MUTANT */',
    why: 'The owner\'s rule is "refused above 1.04".',
  },
  {
    id: 'PB-U-iii. ★★★ the ratio inverted',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    ratio: est > 0 ? truth / est : Infinity,',
    to: '    ratio: truth > 0 ? est / truth : Infinity, /* MUTANT */',
    why: 'A high field lowers the ratio: the check passes exactly the readings it exists to refuse.',
  },
  {
    id: 'PB-U-iv. ★★★ the window 7 → 3 field days',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const UC_WINDOW_DAYS = 7;',
    to: 'export const UC_WINDOW_DAYS = 3; /* MUTANT */',
    why: 'Three days of readings carry a verdict; 10-23 passes.',
  },
  {
    // The design's "fewer than 7 → pass" is guarded twice — the count clause (PB-U-vi) and the full-window test here — and no
    // single-site mutant of either passes it: a window can only be short below 7 field days, where the count already refuses.
    id: 'PB-U-v. ★★★ a window of fewer than 7 field days is judged',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  return w.length === UC_WINDOW_DAYS ? w.reverse() : null;',
    to: '  return w.length > 0 ? w.reverse() : null; /* MUTANT */',
    why: 'The windows ending on the first field days are judged on one to six days: the hysteresis reads noise.',
  },
  {
    id: 'PB-U-vi. ★★ the count clause skipped (no restart, no uncounted days)',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  if (fd.length < UC_WINDOW_DAYS) {',
    to: '  if ((false as boolean) && fd.length < UC_WINDOW_DAYS) { /* MUTANT */',
    why: 'A Core swap reads as "only N of the 7" with no day named, and the restart is never said.',
  },
  {
    id: 'PB-U-vii. ★★★ Core-only days counted as field days',
    file: PB, tests: [T_UNIT, T_REC, T_REP],
    find: '    && x.fieldDaylightHours >= FIELD_DAYLIGHT_MIN_FRAC * x.daylightHours\n    && x.estDayWh != null && x.estNightWh != null',
    to: '    /* MUTANT */\n    && x.estDayWh != null && x.estNightWh != null',
    why: 'The Core era\'s days fill the window: 10-16 passes on days the field never stood for.',
  },
  {
    id: 'PB-U-viii. ★★★ days under another slot→Core map counted (no restart)',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  if (!d || d.map == null || !sameMap(d.map, M) || d.vendorOk !== true || F.length === 0) return false;',
    to: '  if (!d || d.vendorOk !== true || F.length === 0) return false; /* MUTANT */',
    why: 'A swapped-in Core is judged on the old Core\'s days.',
  },
  {
    id: 'PB-U-ix. ★★★ staleness removed (a week-old window passes)',
    file: PB, tests: [T_UNIT, T_REC],
    find: "  if (newest < minNewest) return verdict('refused', { code: 'stale', newest, minNewest }, sources);",
    to: '  /* MUTANT */',
    why: 'A vendor outage leaves the last good week standing for days.',
  },
  {
    id: 'PB-U-x. ★★ staleness E−2 → E−9',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const UC_NEWEST_MAX_AGE_DAYS = 2;',
    to: 'export const UC_NEWEST_MAX_AGE_DAYS = 9; /* MUTANT */',
    why: 'The options text says "the newest no more than two days old".',
  },
  {
    id: 'PB-U-xi. ★★★ the hysteresis on the last window only',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  const ends = fd.slice(-UC_HYSTERESIS_WINDOWS);',
    to: '  const ends = fd.slice(-1); /* MUTANT */',
    why: 'One clean day after a failed week re-admits the field.',
  },
  {
    id: 'PB-U-xii. ★★★ the night clip min → max',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    est += eDay + Math.min(0, eNight);',
    to: '    est += eDay + Math.max(0, eNight); /* MUTANT */',
    why: 'The nights, whose truth is 0 by physics, can only RAISE the estimate: a high field hides behind night drift.',
  },
  {
    id: 'PB-U-xiii. ★★ the night clip removed',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    est += eDay + Math.min(0, eNight);',
    to: '    est += eDay + eNight; /* MUTANT */',
    why: 'A positive night total raises the estimate and lowers the ratio.',
  },
  {
    id: 'PB-U-xiv. ★★ the night hours dropped (a daylight-only balance)',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    est += eDay + Math.min(0, eNight);',
    to: '    est += eDay; /* MUTANT */',
    why: 'The plant\'s night draw no longer lowers the estimate: the form the owner\'s 1.003 was measured against.',
  },
  {
    id: 'PB-U-xv. ★★★ a missing vendor row is a pass',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  if (!d || d.map == null || !sameMap(d.map, M) || d.vendorOk !== true || F.length === 0) return false;',
    to: '  if (!d || d.map == null || !sameMap(d.map, M) || d.vendorOk === false || F.length === 0) return false; /* MUTANT */',
    why: 'A day with no daily total from the panel\'s own ledger counts: absence is not success.',
  },
  {
    id: 'PB-U-xvi. ★★ G6 tolerance ×10',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const G6_TOLERANCE_WH = 500;\nexport const G6_TOLERANCE_FRAC = 0.02;',
    to: 'export const G6_TOLERANCE_WH = 5000;\nexport const G6_TOLERANCE_FRAC = 0.2; /* MUTANT */',
    why: 'A field 15% over the panel\'s own daily total passes G6.',
  },
  {
    id: 'PB-U-xvii. ★★★ (M4) G6 sums only the slots that took the field',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    if (fieldAll != null) fieldAll = h.fieldWh == null ? null : fieldAll + h.fieldWh;',
    to: '    if (fieldAll != null) fieldAll = h.fieldWh == null ? null : fieldAll + (h.coreCovS >= HOUR_COVER_MIN_S ? 0 : h.fieldWh); /* MUTANT */',
    why: 'With one Core reporting, every honest day reads short of the whole-plant total and is judged bad.',
  },
  {
    id: 'PB-U-xviii. ★★★ (M5) judged-bad on the post-check day (the holds can never start)',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    if (!d || !x || !slotPreChecked(x)) continue;',
    to: '    if (!d || !x || !slotPreChecked(x) || !isFieldDay(d, [slot], d.map ?? {})) continue; /* MUTANT */',
    why: 'A G4 or G6 day is merely uncounted: the next evening passes on the other six.',
  },
  {
    id: 'PB-U-xix. ★★★ the judged-bad hold one day (14 → 1)',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  const bad = F.flatMap((s) => judgedBad(table, s, lo, last).map((b) => ({ ...b, slot: s })))',
    to: '  const bad = F.flatMap((s) => judgedBad(table, s, last, last).map((b) => ({ ...b, slot: s }))) /* MUTANT */',
    why: 'A night reading of 35 W refuses one evening and is forgotten.',
  },
  {
    id: 'PB-U-xx. ★★ G4 20 → 2,000 W',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const G4_NIGHT_FIELD_MAX_W = 20;',
    to: 'export const G4_NIGHT_FIELD_MAX_W = 2000; /* MUTANT */',
    why: 'A field reading AC charge at night is taken for solar.',
  },
  {
    id: 'PB-U-xxi. ★★ G10 1.02 → 1.2',
    file: PB, tests: [T_UNIT, T_REC],
    find: 'export const G10_MAX_RATIO = 1.02;',
    to: 'export const G10_MAX_RATIO = 1.2; /* MUTANT */',
    why: 'A returning Core shows its slot\'s field 10% high and the hold never starts.',
  },
  {
    id: 'PB-U-xxii. ★★★ (M1, L3) the check includes day E',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  const last = addDaysYmd(E, -1);',
    to: '  const last = addDaysYmd(E, 0); /* MUTANT */',
    why: 'The evening reads its own unfinished day: 21:30 and 00:30 read two verdicts.',
  },

  /* ── A: admission ── */
  {
    id: 'PB-A-i. ★★★ a day in a failed window is admitted',
    file: PB, tests: [T_UNIT, T_REC],
    find: '      if (judged.has(key(s, d)) && !failed.has(key(s, d))) set.add(d);',
    to: '      if (judged.has(key(s, d))) set.add(d); /* MUTANT */',
    why: 'A ×1.25 burst stays in the model after its refusal.',
  },
  {
    id: 'PB-A-ii. ★★★ an unjudged day is admitted',
    file: PB, tests: [T_UNIT, T_REC],
    find: '      if (judged.has(key(s, d)) && !failed.has(key(s, d))) set.add(d);',
    to: '      if (!failed.has(key(s, d))) set.add(d); /* MUTANT */',
    why: 'A day no window has judged reaches the fit.',
  },
  {
    id: 'PB-A-iii. ★★ a window\'s verdict ignores the threshold (every window passes)',
    file: PB, tests: [T_UNIT, T_REC],
    find: '    const bad = windowBalance(table, w, Fe).ratio > T;',
    to: '    const bad = (false as boolean) && windowBalance(table, w, Fe).ratio > T; /* MUTANT */',
    why: 'Admission no longer shrinks after a refusal.',
  },

  /* ── W: the worker ── */
  {
    id: 'PB-W-i. ★★★ the identity branch removed',
    file: AN, tests: [T_PF],
    find: '  const identity = inputs.fieldHoursUnadmitted === 0\n',
    to: '  const identity = (false as boolean) && inputs.fieldHoursUnadmitted === 0 /* MUTANT */\n',
    why: 'With every Core reporting, the planning band is a second fit beside the alarm one instead of the same object.',
  },
  {
    id: 'PB-W-ii. ★★★ the planning band\'s cache shared across evenings',
    file: AN, tests: [T_PF, T_CACHE],
    find: '    const hit = planningProbabilisticCache.get(planning.asOfDay);',
    to: '    const hit = planningProbabilisticCache.get([...planningProbabilisticCache.keys()][0] ?? planning.asOfDay); /* MUTANT */',
    why: 'Sunday\'s evening reads Saturday\'s band.',
  },
  {
    id: 'PB-W-iii. ★★★ (owner) the runway reads the planning hours',
    file: AN, tests: [T_SEL, 'test/runwayBasisContracts.test.ts'],
    find: '    for (const h of forecast.hours.slice(0, RUNWAY_HORIZON_HOURS)) {',
    to: '    for (const h of ((forecast as unknown as { planningHours?: ForecastHour[] }).planningHours ?? forecast.hours).slice(0, RUNWAY_HORIZON_HOURS)) { /* MUTANT */',
    why: 'The owner kept the runway at zero sun while no house Core reports.',
  },
  {
    id: 'PB-W-iv. ★★★ the planning skill calibrates on the first-write GHI',
    file: RPT, tests: [T_GHI, T_PF],
    find: "      devicesOf(ctx), ctx.recorder, fc, PV_BAND_CAL_WINDOW_DAYS, 'realized', undefined, { kind: 'planning', planning: p },",
    to: "      devicesOf(ctx), ctx.recorder, fc, PV_BAND_CAL_WINDOW_DAYS, 'first-write', undefined, { kind: 'planning', planning: p }, /* MUTANT */",
    why: 'The planning band is calibrated on a 3-4-day-lead forecast error instead of the realized weather.',
  },
  {
    id: 'PB-W-v. ★★ the planning report does not echo E',
    file: RPT, tests: [T_PF, T_SEL],
    find: '      asOfDay: p.asOfDay,\n      planningIdentity: p.identity,',
    to: "      asOfDay: 'unknown', /* MUTANT */\n      planningIdentity: p.identity,",
    why: 'The selector cannot tell an evening\'s report from another\'s.',
  },

  /* ── S: the selection ── */
  {
    id: 'PB-S-i. ★★★ the published band preferred when it does not cover every connected slot',
    file: SEL, tests: [T_SEL],
    find: '  const covers = i.published.uncoveredSlots.length === 0;',
    to: '  const covers = true; /* MUTANT */',
    why: 'One Core back: the plan credits its array and counts the other slots as zero sun, said nowhere.',
  },
  {
    id: 'PB-S-ii. ★★★ (M2) the partial band not passed as refused (the planner keeps it)',
    file: NCA, tests: [T_SEL],
    find: "  const coverageRefused = gate.basisComplete && bandCoverageRefusedBy != null && bandCoverageRefusedBy !== '';",
    to: '  const coverageRefused = false as boolean; /* MUTANT */',
    why: '(c) is a solar plan on the partial band, and every refused-night text is false.',
  },
  {
    id: 'PB-S-iii. ★★★ (M2) index.ts never passes the coverage refusal',
    file: IDX, tests: [T_SEL],
    find: '    bandCoverageRefusedBy: pvSel?.bandCoverageRefusedBy ?? null,',
    to: '    bandCoverageRefusedBy: null, /* MUTANT */',
    why: 'As PB-S-ii, through the live wiring.',
  },
  {
    id: 'PB-S-iv. ★★★ the planning keys not compared with the connected slots',
    file: SEL, tests: [T_SEL],
    find: "  if (p.keys.join(',') !== i.connectedKeys.join(',')) return { ok: false, transient: true };",
    to: '  /* MUTANT */',
    why: 'A three-slot fit sizes a two-slot plant (×1.5 its solar).',
  },
  {
    id: 'PB-S-v. ★★★ a refused verdict still selects the planning band',
    file: SEL, tests: [T_SEL, T_REP],
    find: "  if (v.state !== 'pass') {",
    to: "  if ((false as boolean) && v.state !== 'pass') { /* MUTANT */",
    why: 'Every refused night plans on the readings the check refused.',
  },
  {
    id: 'PB-S-vi. ★★ not-needed reads as the transient class',
    file: SEL, tests: [T_SEL],
    find: "  if (v.state === 'not-needed') return { ok: false, transient: false, reason: { code: 'not-needed', day: addDaysYmd(i.asOfDay, -1) } };",
    to: '  /* MUTANT */',
    why: 'Every night with all Cores back waits to 22:30 for a basis it never needs.',
  },
  {
    id: 'PB-S-vii. ★★★ (owner) G7: a connected slot neither source covers is let through',
    file: SEL, tests: [T_SEL],
    find: "  if (unresolved) return { ok: false, transient: false, reason: { code: 'slot-unresolved', slot: unresolved.slot } };",
    to: '  /* MUTANT */',
    why: 'The owner\'s rule: every connected slot resolves, or no panel basis.',
  },
  {
    id: 'PB-S-viii. ★★★ G8: no capacity ratio known still plans on the readings',
    file: SEL, tests: [T_SEL],
    find: "  if (!i.ratioKnown) return { ok: false, transient: false, reason: { code: 'no-capacity-ratio' } };",
    to: '  /* MUTANT */',
    why: 'The pool is counted on nameplate beside a solar band.',
  },
  {
    id: 'PB-S-ix. ★★★ the planning band\'s own gate ignored',
    file: SEL, tests: [T_SEL],
    find: '  if (!p.gate.basisComplete) {',
    to: '  if ((false as boolean) && !p.gate.basisComplete) { /* MUTANT */',
    why: 'A band with 2 scored days or 70% coverage sizes the plan.',
  },
  {
    id: 'PB-S-x. ★★★ advisory mode takes the panel basis',
    file: SEL, tests: [T_SEL],
    find: "  if (!i.eligible.writeMode) return { ok: false, transient: false, reason: { code: 'advisory' } };",
    to: '  /* MUTANT */',
    why: 'An advisory plan on the readings the write modes alone may use.',
  },
  {
    id: 'PB-S-xi. ★★★ a stale panel takes the panel basis',
    file: SEL, tests: [T_SEL],
    find: "  if (!i.eligible.panelFresh) return { ok: false, transient: false, reason: { code: 'stale-panel' } };",
    to: '  /* MUTANT */',
    why: 'The 22:30 last resort on a stale reading is sized on solar.',
  },
  {
    id: 'PB-S-xii. ★★ a cancelled night takes the panel basis',
    file: SEL, tests: [T_SEL],
    find: "  if (i.eligible.cancelled) return { ok: false, transient: false, reason: { code: 'cancelled' } };",
    to: '  /* MUTANT */',
    why: 'The owner\'s cancel is followed by a plan on the readings.',
  },
  {
    id: 'PB-S-xiii. ★★★ (M1) a report for another evening is used',
    file: SEL, tests: [T_SEL],
    find: '  if (p == null || p.asOfDay !== i.asOfDay || p.verdict == null || !i.planningRollupOk) return { ok: false, transient: true };',
    to: '  if (p == null || p.verdict == null) return { ok: false, transient: true }; /* MUTANT */',
    why: 'Saturday\'s verdict sizes Sunday\'s plan.',
  },
  {
    id: 'PB-S-xiv. ★★★ (L2) the evening\'s planning latch ignored mid-window',
    file: SEL, tests: [T_SEL],
    find: "  if (i.latched?.basis === 'planning') {",
    to: "  if ((false as boolean) && i.latched?.basis === 'planning') { /* MUTANT */",
    why: 'A report timing out at 00:30 flips the served plan to a fresh (c).',
  },
  {
    id: 'PB-S-xv. ★★★ (L2) a missing latched report selects afresh (no keep-previous)',
    file: SEL, tests: [T_SEL],
    find: "    if (b.transient) return out('keep-previous', b);",
    to: '    /* MUTANT */',
    why: 'Inside a latched window the plan changes basis on a timeout.',
  },
  {
    id: 'PB-S-xvi. ★★★ (L2) a v1.203.0 latch (no basis) reads as no latch',
    file: SEL, tests: [T_SEL],
    find: "  return owns ? { basis: 'published', asOfDay: o.lastNotifyDay, decided, ...armedDay } : null;",
    to: '  return null; /* MUTANT */',
    why: 'Deployed inside an armed window, v1.204.0 re-selects the basis of a night v1.203.0 decided.',
  },
  {
    id: 'PB-S-xvii. ★★ a cushion-only latch taken over by a passing reading mid-window',
    file: SEL, tests: [T_SEL],
    find: "  if (i.latched?.basis === 'published') {",
    to: "  if ((false as boolean) && i.latched?.basis === 'published') { /* MUTANT */",
    why: 'The served plan leaves the plan of record the evening armed.',
  },
  {
    id: 'PB-S-xviii. ★★★ (M1) E is the evening job\'s plan date, not its own day',
    file: SEL, tests: [T_SEL],
    find: '  if (o.arming) return o.todayYmd;',
    to: '  if (o.arming) return o.latched?.asOfDay ?? o.planDate; /* MUTANT */',
    why: 'Sunday\'s evening job judges as of Saturday\'s latch.',
  },
  {
    id: 'PB-S-xix. ★★★ (M1) E for a recompute is the site day now (the midnight flip)',
    file: IDX, tests: [T_SEL],
    find: '    planDate: window == null ? siteYmd(nowMs)\n      : planDateOwningCycle({ nowMs, firstLegStartMs: window.startMs, timezone: siteTimeZone(), notifyMinuteOfDay: nightSched.notify.fireMin }),\n  });',
    to: '    planDate: siteYmd(nowMs), /* MUTANT */\n  });',
    why: 'A recompute at 00:30 with no latch judges as of the next evening.',
  },
  {
    id: 'PB-S-xx. ★★★ a shadow leg takes the panel basis',
    file: IDX, tests: [T_SEL],
    find: '  const pvSel: PvSelection | null = shadowLeg ? null : selectPvBasis({',
    to: '  const pvSel: PvSelection | null = selectPvBasis({ /* MUTANT */',
    why: 'The mid-day, backup and morning-refresh legs size a daylight grid charge on the readings G11 cannot vouch for.',
  },
  {
    id: 'PB-S-xxi. ★★★ (L1) the transient class does not keep the 22:30 deferral',
    file: NCA, tests: [T_SEL],
    find: '    || plan.pvBasisTransient === true)',
    to: '    ) /* MUTANT */',
    why: 'A restart at 21:10 latches the cushion-only plan minutes before the panel plan.',
  },
  {
    id: 'PB-S-xxii. ★★ (L1) the transient class flag lost on the plan',
    file: SEL, tests: [T_SEL],
    find: "  if (sel.transient) return { ...base, pvBasis: null, pvBasisRefusedBy: null, pvBasisTransient: true, pvBasisText: '' };",
    to: '  /* MUTANT */',
    why: 'As PB-S-xxi, through the decoration.',
  },
  {
    id: 'PB-S-xxiii. ★★★ the published band\'s planning selection: (b) chosen though (a) holds',
    file: SEL, tests: [T_SEL, T_GOLD],
    find: '  if (pubGate && covers) return out(\'published\', null, true);\n  if (i.latched?.basis === \'published\') {',
    to: '  if ((false as boolean) && pubGate && covers) return out(\'published\', null, true); /* MUTANT */\n  if (i.latched?.basis === \'published\') {',
    why: 'Every night v1.203.0 plans on the Cores\' band is re-planned on the panel\'s.',
  },
  {
    id: 'PB-S-xxiv. ★★★ (F1) the evening job\'s own call selects on the window\'s latch (the arming null reverted)',
    file: IDX, tests: [T_SEL, T_REP],
    find: '    latched: opts.arming === true ? null : pvLatchHere,',
    to: '    latched: pvLatchHere, /* MUTANT */',
    why: 'Sunday\'s evening job under Saturday\'s planning latch stalls on keep-previous to the cutoff (no decision, Saturday\'s arm stands); under a published one a Sunday that passes is planned cushion-only.',
  },
  {
    id: 'PB-S-xxv. ★★★ (F1) the cutoff path latches no noDecision',
    file: IDX, tests: [T_SEL],
    find: '    writeNightChargeLatch({ lastNotifyDay: today, armRefused: latch.armRefused ?? null, noDecision: true });',
    to: '    writeNightChargeLatch({ lastNotifyDay: today, armRefused: latch.armRefused ?? null }); /* MUTANT */',
    why: 'An evening that never decided is called a decision of that day in the rationale, the push and Home Assistant.',
  },
  {
    id: 'PB-S-xxvi. ★★★ (F1) the latch is read without its noDecision',
    file: IDX, tests: [T_SEL],
    find: '    noDecision: readNightChargeLatch().noDecision === true,',
    to: '    noDecision: false, /* MUTANT */',
    why: 'As PB-S-xxv, through the read.',
  },
  {
    id: 'PB-S-xxvii. ★★★ (F1) a latch with no basis always reads as decided',
    file: SEL, tests: [T_SEL],
    find: '  const decided = o.noDecision ? false : o.recorded ? true : null;',
    to: '  const decided = o.recorded ? true : null; /* MUTANT */',
    why: 'As PB-S-xxv, in the selection.',
  },
  {
    id: 'PB-S-xxviii. ★★★ (G3) the marker ignored: a latch with no basis reads as decided whoever wrote it',
    file: SEL, tests: [T_SEL, T_REP],
    find: '  const decided = o.noDecision ? false : o.recorded ? true : null;',
    to: '  const decided = o.noDecision ? false : true; /* MUTANT */',
    why: 'A missed evening v1.203.0 latched is called a decision of that day after this release deploys inside its window.',
  },
  {
    id: 'PB-S-xxix. ★★★ (G3) the latch file read as marked whatever it holds',
    file: IDX, tests: [T_SEL],
    find: '      pvRecorded: raw?.pvRecorded === true,',
    to: '      pvRecorded: true, /* MUTANT */',
    why: 'As PB-S-xxviii, through the read after a restart.',
  },
  {
    id: 'PB-S-xxx. ★★★ (G3) the writer does not mark this release\'s latches',
    file: IDX, tests: [T_SEL],
    find: '    pvRecorded: l.pvRecorded !== false,',
    to: '    pvRecorded: l.pvRecorded === true, /* MUTANT */',
    why: 'An evening that decided with no plan reads, after a restart, as a latch an earlier release wrote.',
  },
  {
    id: 'PB-S-xxxi. ★★ (G3) the push stamp marks a v1.203.0 latch it carries',
    file: IDX, tests: [T_SEL],
    find: '    pvRecorded: l.pvRecorded !== false,',
    to: '    pvRecorded: true, /* MUTANT */',
    why: 'A line night\'s no-write push re-writes v1.203.0\'s latch as this release\'s: after a restart it reads as decided.',
  },
  {
    id: 'PB-S-xxxii. ★★★ (G3) the recompute reads no marker',
    file: IDX, tests: [T_SEL],
    find: '    recorded: readNightChargeLatch().pvRecorded === true,',
    to: '    recorded: true, /* MUTANT */',
    why: 'As PB-S-xxviii, at the call site.',
  },
  {
    id: 'PB-S-xxxiii. ★★★ (G2) an earlier evening\'s standing arm for the window not named',
    file: SEL, tests: [T_SEL],
    find: '  const armedDay = o.armed.standing && o.armed.day != null',
    to: '  const armedDay = (false as boolean) && o.armed.day != null /* MUTANT */',
    why: 'After a Sunday cutoff the card says the panel\'s readings are not used tonight while Saturday\'s panel-sized arm writes.',
  },
  {
    id: 'PB-S-xxxiv. ★★ (G2) a restored or cancelled arm named as standing',
    file: SEL, tests: [T_SEL],
    find: '  const armedDay = o.armed.standing && o.armed.day != null',
    to: '  const armedDay = o.armed.day != null /* MUTANT */',
    why: 'The words say an arm still applies that no longer writes.',
  },
  {
    id: 'PB-S-xxxv. ★★ (G2) index.ts says every armed record stands',
    file: IDX, tests: [T_SEL],
    find: "      standing: armStillApplies(nightActuationMem, nowMs, NIGHT_CHARGE_MODE !== 'advisory'),",
    to: '      standing: true, /* MUTANT */',
    why: 'As PB-S-xxxiv, at the call site: an arm restored mid-window (a grid-loss abort) is said to apply.',
  },

  /* ── T: the words ── */
  {
    id: 'PB-T-i. ★★★ the refusal sentence omitted from a cushion-only plan',
    file: SEL, tests: [T_SEL, T_REP],
    find: '    pvBasisText: r != null && o.plan.cushionOnly && o.plan.sized ? pvBasisRefusedText(r) : \'\',',
    to: "    pvBasisText: '', /* MUTANT */",
    why: 'A refused night does not say why the panel\'s readings were not used.',
  },
  {
    id: 'PB-T-ii. ★★★ the runway sentence claims no sun in the mixed state',
    file: SEL, tests: [T_SEL],
    find: "The runway alarm does not read these readings: it counts only the solar of Cores that report their own.`;",
    to: "The runway alarm counts no sun.`; /* MUTANT */",
    why: 'With slot 2\'s Core back the runway counts its solar: the sentence is false.',
  },
  {
    id: 'PB-T-iii. ★★★ (M3) the balance refusal asserts a cause',
    file: SEL, tests: [T_SEL],
    find: "its nights closed at ${signedKwh(r.nightResidualKwhPerNight)} kWh a night against the measured constants); the readings",
    to: "its nights closed at ${signedKwh(r.nightResidualKwhPerNight)} kWh a night against the measured constants, so the plant drew more than its constants); the readings /* MUTANT */",
    why: 'A planted ×1.10 over-read is blamed on the plant.',
  },
  {
    id: 'PB-T-iv. ★★★ (L1) a hold reason without its end day',
    file: SEL, tests: [T_SEL],
    find: "a night reading above 20 W is not a solar reading, and the readings are held through the evening of ${r.lastHeldDay}`;",
    to: "a night reading above 20 W is not a solar reading`; /* MUTANT */",
    why: 'The owner cannot tell when the readings come back.',
  },
  {
    id: 'PB-T-xi. ★★★ (F1) the \'latched\' reason names the recompute\'s E, not the latch\'s own day',
    file: SEL, tests: [T_SEL],
    find: "      ? { ok: false, transient: false, reason: { code: 'latched', asOfDay: i.latched.asOfDay, decided: i.latched.decided, ...armedDayOf(i.latched) } }",
    to: "      ? { ok: false, transient: false, reason: { code: 'latched', asOfDay: i.asOfDay, decided: i.latched.decided, ...armedDayOf(i.latched) } } /* MUTANT */",
    why: 'The reason dates the decision to a day that did not make it.',
  },
  {
    id: 'PB-T-xii. ★★★ (F1) an evening that made no decision is said to have decided',
    file: SEL, tests: [T_SEL],
    find: "    case 'latched': return (r.decided === false",
    to: "    case 'latched': return ((false as boolean) && r.decided === false /* MUTANT */",
    why: '"This window\'s evening decision was made on <day> without them" for an evening job that reached its cutoff without one.',
  },
  {
    id: 'PB-T-xiii. ★★★ (G3) a latch v1.203.0 wrote is said to record a decision',
    file: SEL, tests: [T_SEL],
    find: '      : r.decided == null',
    to: '      : (false as boolean) && r.decided == null /* MUTANT */',
    why: '"This window\'s evening decision was made on <day>" for a night that may not have decided.',
  },
  {
    id: 'PB-T-xiv. ★★★ (G2) the standing arm dropped from the words',
    file: SEL, tests: [T_SEL],
    find: "  if (armedDay == null) return '';",
    to: "  if ((true as boolean) || armedDay == null) return ''; /* MUTANT */",
    why: 'The rationale does not say an earlier evening\'s arm, not the plan shown, writes.',
  },
  {
    id: 'PB-T-xv. ★★★ (G2) "not used tonight" while an earlier evening\'s arm writes',
    file: SEL, tests: [T_SEL],
    find: "  if (r.armedDay != null) {",
    to: "  if ((false as boolean) && r.armedDay != null) { /* MUTANT */",
    why: 'The card says the panel\'s readings are not used tonight while Saturday\'s panel-sized arm writes.',
  },
  {
    id: 'PB-T-xvi. ★★ (G2) the push says panel solar not used while an earlier evening\'s arm writes',
    file: SEL, tests: [T_SEL],
    find: "    const shown = d.pvBasisRefusedBy.armedDay != null;",
    to: '    const shown = (false as boolean); /* MUTANT */',
    why: 'As PB-T-xv, in the push.',
  },
  {
    id: 'PB-T-xvii. ★★★ (G2, every clause) a refusal inside a latched window drops the standing arm',
    file: SEL, tests: [T_SEL],
    find: "  (!b.ok && !b.transient && l.armedDay != null ? { ...b, reason: { ...b.reason, armedDay: l.armedDay } } : b);",
    to: "  ((false as boolean) && !b.ok && !b.transient && l.armedDay != null ? { ...b, reason: { ...b.reason, armedDay: l.armedDay } } : b); /* MUTANT */",
    why: 'A balance refusal after Sunday\'s cutoff says the panel\'s readings are not used tonight while Saturday\'s panel-sized arm writes.',
  },
  {
    id: 'PB-T-xviii. ★★ (G2, every clause) the planning latch\'s refusal drops the standing arm',
    file: SEL, tests: [T_SEL],
    find: "    return out('published', withArmedDay(b, i.latched));",
    to: "    return out('published', b); /* MUTANT */",
    why: 'Sunday decided on the planning band and delivered no arm; its refusal at 23:30 says not used tonight while Saturday\'s arm writes.',
  },
  {
    id: 'PB-T-xix. ★★★ (G2, every clause) the published latch\'s refusal drops the standing arm',
    file: SEL, tests: [T_SEL],
    find: "      : withArmedDay(b, i.latched);",
    to: "      : b; /* MUTANT */",
    why: 'As PB-T-xvii, on the published latch (a missed Sunday cutoff, or a Sunday that decided published and delivered no arm).',
  },
  {
    id: 'PB-T-xx. ★★★ (G2, applies) an unwritten arm is said to apply in advisory mode',
    file: SEL, tests: [T_SEL],
    find: "  if (!writeMode || a.missedApplyPushedAtMs != null || a.windowStartMs == null) return false;",
    to: "  if (a.missedApplyPushedAtMs != null || a.windowStartMs == null) return false; /* MUTANT */",
    why: 'In advisory mode the card says Saturday\'s arm still applies while nothing is ever written: a night said safer than it is.',
  },
  {
    id: 'PB-T-xxi. ★★★ (G2, applies) an arm past its apply window unwritten is said to apply',
    file: SEL, tests: [T_SEL],
    find: "  return nowMs <= a.windowStartMs + APPLY_LATE_MS;",
    to: "  return true; /* MUTANT */",
    why: 'After a missed apply the card says the arm still applies while decideActuation writes nothing more.',
  },
  {
    id: 'PB-T-xxii. ★★ (G2, applies) the missed-apply push ignored',
    file: SEL, tests: [T_SEL],
    find: "  if (!writeMode || a.missedApplyPushedAtMs != null || a.windowStartMs == null) return false;",
    to: "  if (!writeMode || a.windowStartMs == null) return false; /* MUTANT */",
    why: 'The push says nothing was written while the card says the arm still applies.',
  },
  {
    id: 'PB-T-xxiii. ★★ (G2, applies) a written raise not counted as applying',
    file: SEL, tests: [T_SEL],
    find: "  if (a.appliedAtMs != null || a.reserveStandingAtMs != null) return true;",
    to: "  if (a.reserveStandingAtMs != null) return true; /* MUTANT */",
    why: 'A raise written before a switch to advisory holds to its restore, but the card says the panel\'s readings are not used tonight.',
  },
  {
    id: 'PB-T-xxiv. ★★ (G2, applies) a grid-lost or foreign-settled arm said to apply',
    file: SEL, tests: [T_SEL],
    find: "  if (a.foreignSettledAtMs != null || a.gridLostAtMs != null) return false;",
    to: "  /* MUTANT */",
    why: 'The card names an arm whose reserve someone else now holds, or that the grid loss ended.',
  },
  {
    id: 'PB-T-xxv. ★★★ (G2, own arm) the window\'s own planning-band arm not named',
    file: SEL, tests: [T_SEL],
    find: "  const mayBeOnPanel = o.armed.day !== o.lastNotifyDay || (o.pv?.basis === 'planning' && o.pv.asOfDay === o.armed.day);",
    to: "  const mayBeOnPanel = o.armed.day !== o.lastNotifyDay; /* MUTANT */",
    why: 'Sunday planned on the panel\'s readings and armed; a mid-window refusal says they are not used tonight while that arm writes.',
  },
  {
    id: 'PB-T-xxvi. ★★ (G2, own arm) the window\'s own published arm named',
    file: SEL, tests: [T_SEL],
    find: "  const mayBeOnPanel = o.armed.day !== o.lastNotifyDay || (o.pv?.basis === 'planning' && o.pv.asOfDay === o.armed.day);",
    to: "  const mayBeOnPanel = true; /* MUTANT */",
    why: 'Every ordinary night\'s refusal names its own Cores-band arm as if it might be on the panel\'s readings.',
  },
  {
    id: 'PB-S-xxxvi. ★★★ (G2, applies) index.ts says any recorded target applies',
    file: IDX, tests: [T_SEL],
    find: "      standing: armStillApplies(nightActuationMem, nowMs, NIGHT_CHARGE_MODE !== 'advisory'),",
    to: "      standing: armStillApplies(nightActuationMem, nowMs, true), /* MUTANT */",
    why: 'In advisory mode the card says an unwritten arm still applies.',
  },
  {
    id: 'PB-T-v. ★★★ (L1) G4 without the add-on\'s force-charge in that hour',
    file: IDX, tests: [T_SEL],
    find: '    ? { ...pvSel.reason, hourClock: fmtSiteClock(pvSel.reason.hourStartMs), forceCharge: forceChargeStateAt(pvSel.reason.hourStartMs) }',
    to: '    ? { ...pvSel.reason, hourClock: fmtSiteClock(pvSel.reason.hourStartMs) } /* MUTANT */',
    why: 'A 35 W night reading during the add-on\'s own force-charge reads as an unexplained fault.',
  },
  {
    id: 'PB-T-vi. ★★★ (L1) the no-plan push loses the panel reason',
    file: NCA, tests: [T_SEL],
    find: "        ? `${basisBlockedBy}; the panel's own solar readings are not used: ${panelBasisRefusal}` : basisBlockedBy,",
    to: '        ? basisBlockedBy : basisBlockedBy, /* MUTANT */',
    why: 'The 21:30 "no plan tonight" says why the Cores\' band was refused, not why the panel\'s was.',
  },
  {
    id: 'PB-T-vii. ★★ the Spanish refusal in English',
    file: SEL, tests: [T_SEL],
    find: '    ? ` Las lecturas solares propias del panel no se usan esta noche: ${pvBasisReasonText(r, \'es\')}.`',
    to: '    ? ` The panel\'s own solar readings are not used tonight: ${pvBasisReasonText(r, \'en\')}.` /* MUTANT */',
    why: 'An es reader gets the en sentence.',
  },
  {
    id: 'PB-T-viii. ★★ the push drops the panel basis',
    file: NTF, tests: [T_SEL],
    find: "  return plan.pvBasis != null ? pvBasisPushText({ pvBasis: plan.pvBasis, pvBasisChecks: plan.pvBasisChecks ?? null, pvBasisRefusedBy: null }) : '';",
    to: "  return ''; /* MUTANT */",
    why: 'A plan sized on the panel\'s readings is pushed as if on the Cores\' meter.',
  },
  {
    id: 'PB-T-ix. ★★ the card does not mirror the closing sentence',
    file: CARD, tests: [T_SEL],
    find: "    + provisionalBandText(plan.pvBandWiden) + cushionOnlyCardText(plan.cushionOnly, plan) + (plan.pvBasisText ?? '');",
    to: '    + provisionalBandText(plan.pvBandWiden) + cushionOnlyCardText(plan.cushionOnly, plan); /* MUTANT */',
    why: 'The card disagrees with the rationale and the push.',
  },
  {
    id: 'PB-T-x. ★★ (L7) each slot\'s source from today, not E−1\'s daylight',
    file: PB, tests: [T_UNIT, T_REC],
    find: '  const prev = table.days.get(last);\n  const sources',
    to: '  const prev = table.days.get(E); /* MUTANT */\n  const sources',
    why: 'The sentence and the field slots read a day the evening has not finished.',
  },

  /* ── H: Home Assistant (L6) ── */
  {
    id: 'PB-H-i. ★★★ the attributes lose pv_basis_refused_by',
    file: MQTT, tests: [T_SEL, T_MQTT],
    find: '"pv_basis": value_json.night_charge_pv_basis | default(none), "pv_basis_refused_by": value_json.night_charge_pv_basis_refused_by | default(none)}',
    to: '"pv_basis": value_json.night_charge_pv_basis | default(none)} /* MUTANT */',
    why: 'json_attributes is an allowlist: the reason never reaches Home Assistant.',
  },
  {
    id: 'PB-H-ii. ★★★ the attributes outlive a stale plan',
    file: NCA, tests: [T_SEL],
    find: '    night_charge_pv_basis: !fresh ? null',
    to: '    night_charge_pv_basis: (false as boolean) ? null /* MUTANT */',
    why: 'A 13-hour-old plan\'s basis is shown as tonight\'s.',
  },
  {
    id: 'PB-H-iii. ★★ the entity has no attributes template',
    file: MQTT, tests: [T_SEL, T_MQTT],
    find: " value_template: '{{ value_json.night_charge_target_soc_percent }}', json_attributes_template: NIGHT_CHARGE_ATTRIBUTES_TEMPLATE },",
    to: " value_template: '{{ value_json.night_charge_target_soc_percent }}' }, /* MUTANT */",
    why: 'The two attributes are published on no entity.',
  },

  /* ── L: the ledger (L5) ── */
  {
    id: 'PB-L-i. ★★★ a panel row\'s PV actual written on an unadmitted day',
    file: IDX, tests: [T_SEL],
    find: "    actualPvKwh = held || panelAdmission.state !== 'admitted' ? null : panelPv.kwh;",
    to: '    actualPvKwh = held ? null : panelPv.kwh; /* MUTANT */',
    why: 'A ×1.25 fault\'s first day is written durably beside "passed".',
  },
  {
    id: 'PB-L-ii. ★★★ the span\'s last day judged before its daily total is in',
    file: NLS, tests: [T_SEL],
    find: '  if (a == null || !(a.asOfDay > lastDay) || !(a.builtAtMs >= judgeFromMs)) return { state: \'pending\', lastDay, judgeFromMs };',
    to: "  if (a == null || !(a.asOfDay > lastDay)) return { state: 'pending', lastDay, judgeFromMs }; /* MUTANT */",
    why: 'A report built at 05:30 has no vendor row for the day: the PV actual is withheld for good.',
  },
  {
    id: 'PB-L-iii. ★★★ admission as of the plan\'s own evening (its last day unjudged)',
    file: NLS, tests: [T_SEL],
    find: '  if (a == null || !(a.asOfDay > lastDay) || !(a.builtAtMs >= judgeFromMs)) return { state: \'pending\', lastDay, judgeFromMs };',
    to: "  if (a == null || !(a.asOfDay >= lastDay) || !(a.builtAtMs >= judgeFromMs)) return { state: 'pending', lastDay, judgeFromMs }; /* MUTANT */",
    why: 'A report that cannot have judged the span\'s last day decides it.',
  },
  {
    id: 'PB-L-iv. ★★★ a P slot\'s unadmitted day passes',
    file: NLS, tests: [T_SEL],
    find: '    const day = days.find((d) => !admitted.has(d));',
    to: '    const day = undefined as string | undefined; /* MUTANT */',
    why: 'The admitted set is read and ignored.',
  },
  {
    id: 'PB-L-v. ★★★ a pending row is never re-captured',
    file: IDX, tests: [T_SEL],
    find: '  if (repairPendingPanelPv(rows, nowMs)) rows = recorder.readNightLedger(LEDGER_BACKFILL_SWEEP_DAYS);',
    to: '  /* MUTANT */',
    why: 'Every panel row keeps an empty PV actual and a note promising a re-capture.',
  },
  {
    id: 'PB-L-vi. ★★★ pvVerdictSetAside\'s panel rule ordered second',
    file: NLS, tests: [T_SEL],
    find: "  const panel = panelPvVerdictSetAside(pvBasis);\n  if (panel != null) return panel;\n  if (modelSns == null || modelSns === '') return null;\n  const actual = [...actualSns].sort().join(',');\n  if (modelSns === actual) return null;",
    to: "  if (modelSns == null || modelSns === '') return null;\n  const actual = [...actualSns].sort().join(',');\n  if (modelSns === actual) return null;\n  const panel = panelPvVerdictSetAside(pvBasis); /* MUTANT */\n  if (panel != null) return panel;",
    why: 'A panel row whose keys match counts as forecast-skill evidence.',
  },
  {
    id: 'PB-L-vii. ★★★ pv_basis dropped from the ledger allowlist',
    file: REC, tests: [T_SEL],
    find: "  'pv_basis', 'pv_basis_slots', 'pv_basis_refused_by', 'pv_upper_ratio', 'actual_pv_basis',",
    to: "  'pv_basis_slots', 'pv_basis_refused_by', 'pv_upper_ratio', 'actual_pv_basis', /* MUTANT */",
    why: 'The upsert drops the column: no panel row is ever kept apart.',
  },
  {
    id: 'PB-L-viii. ★★ (L5) the stored ratio is the worst of the last 7, not the window\'s',
    file: IDX, tests: [T_SEL],
    find: '    pvUpperRatio: v != null && !sel.published ? (v.checks.ratio ?? null) : null,',
    to: '    pvUpperRatio: v != null && !sel.published ? (v.checks.max7 ?? null) : null, /* MUTANT */',
    why: 'The row\'s note quotes a ratio the night was not planned beside.',
  },

  /* ── G: the gate ── */
  {
    id: 'PB-G-i. ★★★ panel rows in the actuated pool',
    file: GATE, tests: [T_SEL],
    find: '    .filter((r) => truthy(r.actuated) && truthy(r.scored) && !panelApart(r))',
    to: '    .filter((r) => truthy(r.actuated) && truthy(r.scored)) /* MUTANT */',
    why: 'A high reading hides an under-buy and moves every criterion toward graduating.',
  },
  {
    id: 'PB-G-ii. ★★★ panel rows in the PV statistics',
    file: GATE, tests: [T_SEL],
    find: '  const pvEvidence = (r: NightLedgerRow): boolean => r.pv_verdict_set_aside == null && !panelApart(r);',
    to: '  const pvEvidence = (r: NightLedgerRow): boolean => r.pv_verdict_set_aside == null; /* MUTANT */',
    why: 'The band coverage the gate reads is graded on a reading nothing vouches for.',
  },
  {
    id: 'PB-G-iii. ★★ a row captured on a panel actual is not apart',
    file: GATE, tests: [T_SEL],
    find: "  return r.pv_basis === 'panel' || r.pv_basis === 'mixed' || (typeof r.actual_pv_basis === 'string' && /:P\\b/.test(r.actual_pv_basis));\n}\n/** v1.204.0 — panelBasisUnderBuyNights",
    to: "  return r.pv_basis === 'panel' || r.pv_basis === 'mixed'; /* MUTANT */\n}\n/** v1.204.0 — panelBasisUnderBuyNights",
    why: 'A cores row graded on the panel\'s reading counts.',
  },
  {
    id: 'PB-G-iv. ★★★ a panel night\'s strike dropped',
    file: GATE, tests: [T_SEL],
    find: '  const strikeRows = currentAlgo.filter((r) => {',
    to: '  const strikeRows = currentAlgo.filter((r) => !panelApart(r)).filter((r) => { /* MUTANT */',
    why: 'The cushion verdict is PV-independent: a breach on a panel night is a breach.',
  },
  {
    id: 'PB-G-v. ★★★ panel nights clear a strike',
    file: GATE, tests: [T_SEL],
    find: '    strikeFreeStreak = actuated.filter((r) => String(r.plan_date) > lastStrikeDate).length;',
    to: '    strikeFreeStreak = currentAlgo.filter((r) => truthy(r.actuated) && truthy(r.scored) && String(r.plan_date) > lastStrikeDate).length; /* MUTANT */',
    why: 'Fourteen panel nights clear a strike no independent meter has graded.',
  },
  {
    id: 'PB-G-vi. ★★ the under-buy diagnostic counts every panel night',
    file: GATE, tests: [T_SEL],
    find: '    return e != null && e < -PANEL_UNDERBUY_DIAG_KWH;',
    to: '    return e != null; /* MUTANT */',
    why: 'The diagnostic says every panel night under-bought.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-panel-pv-basis', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
