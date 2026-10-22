#!/usr/bin/env node
/**
 * mutate-v1191-s5.mjs — v1.191.0 S5: the tariff plan read from the options (lane B).
 *
 *   S5-i     tariffModelFromEnv returns the APS model whatever the plan
 *   S5-ii    the TARIFF_APS_* inputs of the aps_r_ev preset are dropped
 *   S5-iii   TARIFF_RATES_CONFIRMED unset no longer takes TARIFF_APS_RATES_CONFIRMED
 *   S5-iv    a season range that wraps the year (10-3) parses empty
 *   S5-v     the APS holidays stop at 2045 again
 *   S5-vi    an invalid spec silently becomes the APS table
 *   S5-vii   the MQTT units ignore the currency
 *   S5-viii  the cost-figure pair loses its above-zero rule (DECISION 8 kept on that path)
 *   S5-ix    the two_tier plan stops accepting the MPC names as aliases
 *   S5-x     a 0 ¢ period on the model path becomes unusable
 *   S5-xi    a cheap period the plan does not have is accepted
 *   S5-xii   the one flat-cents constant drifts (17 → 18)
 *   S5-xiii  the money formatter ignores the currency
 *   S5-xiv   an unknown currency is used as the unit instead of keeping USD
 *   S5-xv    the legacy fallback window ignores a non-APS plan's own on-peak period
 *   S5-xvi   the fail-closed model keeps a cheap window (the night charge would plan on it)
 *   S5-xvii  TARIFF_PERIODS without TARIFF_PLAN custom is silently ignored (APS runs)
 *   S5-xviii the score note always names TARIFF_APS_RATES_CONFIRMED
 *   S5-xix   rateAt stops consulting the holiday rule past the table (isModelHoliday bypassed)
 *   S5-xx    GET /api/repair-issues drops the tariff issues (index.ts)
 *   S5-xxi   the MPC vector's fallback pair reads the cost figures' names while TARIFF_PLAN is unset
 *            (analytics.ts mpcFallbackPair, which index.ts reads since v1.191.0 review 3)
 *
 *   cd server && TSX_DISABLE_CACHE=1 MUTATE_CONCURRENCY=4 node ../scripts/mutate-v1191-s5.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARIFF = resolve(REPO, 'server/src/tariff.ts');
const MONEY = resolve(REPO, 'server/src/money.ts');
const CONFIG = resolve(REPO, 'server/src/config.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const DISC = resolve(REPO, 'server/src/mqttDiscovery.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/tariffPlan.test.ts',
  'test/tariffGrammar.test.ts',
  'test/golden.test.ts',
  'test/tariffHolidays.test.ts',
  'test/tariffBasis.test.ts',
  'test/rateTableUnify.test.ts',
];

const MUTANTS = [
  {
    id: 'S5-i. ★★★ tariffModelFromEnv returns the APS model whatever the plan',
    file: TARIFF,
    find: '  return resolveTariffFromEnv().model;',
    to: '  return buildApsREvModel(apsREvRatesFromEnv()); /* MUTANT */',
    why: 'A flat, two-tier or custom plan is priced on the APS R-EV windows, and an invalid spec is APS too.',
  },
  {
    id: 'S5-ii. ★★★ the TARIFF_APS_* inputs of the aps_r_ev preset are dropped',
    file: TARIFF,
    find: '    const rates: ApsREvRates = apsREvRatesFromEnv();',
    to: '    const rates: ApsREvRates = { confirmed: tariffRatesConfirmation().confirmed }; /* MUTANT */',
    why: 'The reference install\'s confirmed rates stop pricing anything: Grid Rate Now unknown, the night plan unpriced.',
  },
  {
    id: 'S5-iii. ★★★ TARIFF_RATES_CONFIRMED unset no longer takes TARIFF_APS_RATES_CONFIRMED',
    file: TARIFF,
    find: "  return { confirmed: option<boolean>('TARIFF_APS_RATES_CONFIRMED'), key: 'TARIFF_APS_RATES_CONFIRMED' };",
    to: "  return { confirmed: false, key: 'TARIFF_APS_RATES_CONFIRMED' }; /* MUTANT */",
    why: 'An install that confirmed its APS rates (the reference install) reads as unconfirmed: every price null.',
  },
  {
    id: 'S5-iv. ★★★ a season range that wraps the year parses empty',
    file: TARIFF,
    find: '    for (;;) { set.add(m); if (m === end) break; m = (m % 12) + 1; }',
    to: '    for (let k = m; k <= end; k++) set.add(k); /* MUTANT */',
    why: 'A southern-hemisphere home writing 10-3 gets no summer at all: every month priced at winter rates.',
  },
  {
    id: 'S5-v. ★★★ the APS holidays stop at 2045 again',
    file: TARIFF,
    find: '  if (lp.year <= APS_HOLIDAY_TABLE_LAST_YEAR || !APS_RULE_LISTS.has(model.holidays)) return false;',
    to: '  if (lp.year <= APS_HOLIDAY_TABLE_LAST_YEAR + 1000 || !APS_RULE_LISTS.has(model.holidays)) return false; /* MUTANT */',
    why: 'From 2046 the R-EV holidays are priced with on-peak and overnight hours they do not have (R3).',
  },
  {
    id: 'S5-vi. ★★★ an invalid spec silently becomes the APS table',
    file: TARIFF,
    find: '    return { plan, planSet: planRaw != null, model: failClosedTariffModel(), error: e.message, confirmationKey };',
    to: '    return { plan, planSet: planRaw != null, model: buildApsREvModel(apsREvRatesFromEnv()), error: e.message, confirmationKey }; /* MUTANT */',
    why: 'A mistyped custom plan is priced and night-charged on the reference home\'s APS windows (P5: null over fabrication).',
  },
  {
    id: 'S5-vii. ★★★ the MQTT units ignore the currency',
    file: DISC,
    find: "  if (currency !== 'USD' && (s.unit_of_measurement === 'USD' || s.unit_of_measurement === 'USD/kWh')) {",
    to: '  if (false) { /* MUTANT */',
    why: 'A EUR install publishes its cost and rate sensors in USD: Home Assistant books euros as dollars.',
  },
  {
    id: 'S5-viii. ★★ the cost-figure pair loses its above-zero rule',
    file: AN,
    find: '    const on = positiveCents(pair.onPeak);',
    to: '    const on = pair.onPeak; /* MUTANT */',
    why: 'The KPI path changes for a 0 ¢ or negative rate, which DECISION 8 keeps declared (golden G3 pins the rule).',
  },
  {
    id: 'S5-ix. ★★ the two_tier plan stops accepting the MPC names as aliases',
    file: TARIFF,
    find: "      const on = requiredCent(['TARIFF_ON_PEAK_CENTS', 'TARIFF_ON_PEAK_CENTS_PER_KWH'], plan);",
    to: "      const on = requiredCent(['TARIFF_ON_PEAK_CENTS'], plan); /* MUTANT */",
    why: 'An install that set the MPC names gets a failed two-tier plan instead of its rates (F4).',
  },
  {
    id: 'S5-x. ★★ a 0 ¢ period on the model path becomes unusable',
    file: TARIFF,
    find: "  return t !== '' && Number.isFinite(n) ? n : specError(",
    to: "  return t !== '' && Number.isFinite(n) && n > 0 ? n : specError( /* MUTANT */",
    why: 'A free overnight period fails the whole spec: prices unknown and the night charge held (DECISION 8: any finite value).',
  },
  {
    id: 'S5-xi. ★★ a cheap period the plan does not have is accepted',
    file: TARIFF,
    find: '    if (!ids.includes(cheapOverride)) specError(',
    to: '    if (false) specError( /* MUTANT */',
    why: 'NIGHT_CHARGE_CHEAP_PERIOD names a period that never occurs: the plan never charges, and nothing says why.',
  },
  {
    id: 'S5-xii. ★★ the one flat-cents constant drifts',
    file: CONFIG,
    find: 'export const TARIFF_FLAT_DEFAULT_CENTS = 17;',
    to: 'export const TARIFF_FLAT_DEFAULT_CENTS = 18; /* MUTANT */',
    why: 'Every unconfirmed install\'s cost figures and MPC vector move by 1 ¢/kWh (golden G2).',
  },
  {
    id: 'S5-xiii. ★★ the money formatter ignores the currency',
    file: MONEY,
    find: '  return SYMBOLS[tariffCurrency().code].major;',
    to: '  return "$"; /* MUTANT */', // double quotes: `$'` in a replacement string is a String#replace pattern
    why: 'A EUR install reads dollar signs in its alerts and dispatch rationale (CA14).',
  },
  {
    id: 'S5-xiv. ★★ an unknown currency is used as the unit',
    file: MONEY,
    find: "  return { code: 'USD', set: true, error:",
    to: "  return { code: up as Currency, set: true, error: /* MUTANT */",
    why: 'A typo in TARIFF_CURRENCY renames the Home Assistant statistics\' unit to a code that is not money.',
  },
  {
    id: 'S5-xv. ★★ the legacy fallback window ignores a non-APS plan\'s own on-peak period',
    file: TARIFF,
    find: "  if (!explicit && model.planId !== 'aps_r_ev') {",
    to: "  if (!explicit && model.planId === 'never') { /* MUTANT */",
    why: 'An unconfirmed custom plan is judged on-peak at 15:00-20:00 instead of its own window (F2).',
  },
  {
    id: 'S5-xvi. ★★★ the fail-closed model keeps a cheap window',
    file: TARIFF,
    find: '    cheapPeriodId: null,\n  };',
    to: '  }; /* MUTANT */',
    why: 'The invalid-spec model reads the default overnight period: a hook that later plans on it would charge on a spec that failed.',
  },
  {
    id: 'S5-xvii. ★★★ TARIFF_PERIODS without TARIFF_PLAN custom is silently ignored',
    file: TARIFF,
    find: "  if (plan !== 'custom' && (periodsSpec != null || ratesSpec != null)) {",
    to: '  if (false) { /* MUTANT */',
    why: 'An operator who wrote a period table but left TARIFF_PLAN unset runs on APS with no word (never silently APS).',
  },
  {
    id: 'S5-xviii. ★ the score note always names TARIFF_APS_RATES_CONFIRMED',
    file: NLS,
    find: 'Cost: not priced (tariff rates unconfirmed — ${tariffRatesConfirmation().key})',
    to: 'Cost: not priced (tariff rates unconfirmed — TARIFF_APS_RATES_CONFIRMED) /* MUTANT */',
    why: 'An install confirming through TARIFF_RATES_CONFIRMED is told to set the APS key (CA14).',
  },
  {
    id: 'S5-xix. ★★ rateAt stops consulting the holiday rule',
    file: TARIFF,
    find: '  if (isModelHoliday(model, lp)) {',
    to: '  if (model.holidays.includes(lp.ymd)) { /* MUTANT */',
    why: 'The computed holidays past 2045 are never consulted by the pricing itself.',
  },
  {
    id: 'S5-xx. ★★★ GET /api/repair-issues drops the tariff issues',
    file: IDX,
    find: '  report.issues.push(...tariffRepairIssues(report.generatedAt));',
    to: '  /* MUTANT */',
    why: 'An unusable tariff spec fails closed with no repair issue: prices go unknown and the night charge holds, silently.',
  },
  {
    id: 'S5-xxi. ★★ the MPC vector\'s fallback pair reads the cost figures\' names',
    file: AN, // v1.191.0 (review 3) — the pair moved from index.ts to analytics.ts mpcFallbackPair
    find: '    const { onPeak, offPeak } = legacyTariffFromEnv().mpc;',
    to: '    const l = legacyTariffFromEnv(); const onPeak = l.kpi.onPeak ?? l.flatCents; const offPeak = l.mpc.offPeak; /* MUTANT */',
    why: 'The MPC starts honouring TARIFF_ON_PEAK_CENTS while TARIFF_PLAN is unset: golden G2\'s twoTierAnalyticsNames variant pins that it does not.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants (the goldens included).
await runMutantsParallel({ name: 'mutate-v1191-s5', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
