#!/usr/bin/env node
/**
 * mutate-v1187-22c.mjs — v1.187.22: the night-charge plan states the purchase it EXPECTS (what the
 * armed write would draw from the expected window-open SoC) beside the worst case it is SIZED on,
 * on the plan, the push, the spoken line, the card and a new MQTT sensor, and records it in the
 * ledger with the measured window-open SoC. The 2026-10-12 plan said "Buy ~64.2 kWh" for a night
 * whose write would have drawn ≈34 kWh.
 *
 *   C-i…C-v        the expected carry (median load and PV, from now, floored at the reserve,
 *                  null without a P50 basis)
 *   C-vi…C-xv      the level the write drives to, the expected buy's arithmetic, the holds
 *   C-xvi…C-xx     the headline and the rationale
 *   C-xxi…C-xxvi   the P50 plumbing (band → planner hour → inputs) and its wiring in index.ts
 *   C-xxvii…C-xxxiii the surfaces: MQTT, push, spoken line, card
 *   C-xxxiv…C-xl   the ledger: columns, migration, the measured open, the score clause (C-xl-b)
 *   C-xli          the force-charge ceiling armFromPlan and the expected level share
 *
 *   node scripts/mutate-v1187-22c.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NCA = resolve(REPO, 'server/src/nightChargeAdvisor.ts');
const FC = resolve(REPO, 'server/src/nightForceCharge.ts');
const ACT = resolve(REPO, 'server/src/nightChargeActuator.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const NOTIFY = resolve(REPO, 'server/src/notify.ts');
const MQTT = resolve(REPO, 'server/src/mqttDiscovery.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const WEB = resolve(REPO, 'web/src/cards/nightChargeText.ts');
const SUBSET = [
  'test/nightChargeExpectedBuy.test.ts',
  'test/ledgerExpectedBuy.test.ts',
  'test/buyDebiasCalibration.test.ts',
  'test/nightChargeMqtt.test.ts',
  'test/nightForceCharge.test.ts',
];

const MUTANTS = [
  // ── the expected carry ──
  {
    id: 'C-i. ★★★ the expected carry drains the P90 load',
    file: NCA,
    find: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, load) / o.dischargeEff)) / 1000));',
    to: '    pack = Math.max(floor, Math.min(o.fullKwh, pack + (w * (pv - Math.max(0, h.loadP90W) / o.dischargeEff)) / 1000)); /* MUTANT */',
    why: 'The "expected" start collapses onto the worst case again and the 10-12 plan says ~62 kWh expected.',
  },
  {
    id: 'C-ii. ★★ the expected carry is not floored at the reserve',
    file: NCA,
    find: '  const floor = Math.min(Math.max(0, o.reserveKwh), pack);',
    to: '  const floor = 0; /* MUTANT */',
    why: 'A grid-present carry drains through the reserve the SHP2 holds, overstating the expected buy on a heavy evening.',
  },
  {
    id: 'C-iii. ★★ the expected carry counts the whole current hour',
    file: NCA,
    find: '    : expectedCarryKwh({ startKwh: socNowKwh, fullKwh, reserveKwh, dischargeEff, hours: horizon, fromMs: nowMs, toMs: windowStart });',
    to: '    : expectedCarryKwh({ startKwh: socNowKwh, fullKwh, reserveKwh, dischargeEff, hours: horizon, fromMs: simFromMs, toMs: windowStart }); /* MUTANT */',
    why: 'The 21:00-21:30 drain the SoC reading already reflects is charged a second time (the sizing\'s conservative choice, wrong for an expectation).',
  },
  {
    id: 'C-iv. ★ the expected carry reads P10 PV',
    file: NCA,
    find: '    const pv = h.pvP50W != null && Number.isFinite(h.pvP50W) ? h.pvP50W : h.pvP10W;',
    to: '    const pv = h.pvP10W; /* MUTANT */',
    why: 'An afternoon plan understates the sun the pool expects before the window and overstates the buy.',
  },
  {
    id: 'C-v. ★★ an hour without a P50 load is skipped instead of voiding the figure',
    file: NCA,
    find: '    if (load == null || !Number.isFinite(load)) return null;\n    const pv = h.pvP50W',
    to: '    if (load == null || !Number.isFinite(load)) continue; /* MUTANT */\n    const pv = h.pvP50W',
    why: 'A plan with no median basis states an "expected" buy built on a carry with no drain at all.',
  },
  // ── the level and the arithmetic ──
  {
    id: 'C-vi. ★★★ the expected level ignores force-charge',
    file: NCA,
    find: '      setpointSocPct, costCeilingSocPct, forceChargeEligible: inputs.forceChargeEligible === true,',
    to: '      setpointSocPct, costCeilingSocPct, forceChargeEligible: false, /* MUTANT */',
    why: 'A force-charge night (10-12: to 80%) states only the reserve leg, ~5 kWh, for a ~34 kWh draw.',
  },
  {
    id: 'C-vii. ★★ the expected level assumes force-charge on every night',
    file: NCA,
    find: '      setpointSocPct, costCeilingSocPct, forceChargeEligible: inputs.forceChargeEligible === true,',
    to: '      setpointSocPct, costCeilingSocPct, forceChargeEligible: true, /* MUTANT */',
    why: 'An advisory or resilience night, where only the reserve is written, states a force-charge draw that never happens.',
  },
  {
    id: 'C-viii. ★★ the level is the raw ceiling, not where the force-charge stops',
    file: FC,
    find: '  return Math.max(reservePct, forceChargeStopPct(ceiling));',
    to: '  return Math.max(reservePct, ceiling); /* MUTANT */',
    why: 'The level is re-derived instead of read from the force-charge\'s own stop (80.4 vs the 80 it stops at).',
  },
  {
    id: 'C-ix. ★ a ceiling at or below the reserve maximum counts as a force-charge',
    file: FC,
    find: '  if (ceiling == null || ceiling <= RESERVE_WRITE_MAX_PCT) return reservePct;',
    to: '  if (ceiling == null) return reservePct; /* MUTANT */',
    why: 'decideForceCharge starts nothing at or below 50%, but the expected level would rise to the ceiling.',
  },
  {
    id: 'C-x. ★★ the reserve leg uses the unclamped setpoint',
    file: FC,
    find: '  const reservePct = clampReserveTarget(plan.setpointSocPct);',
    to: '  const reservePct = plan.setpointSocPct; /* MUTANT */',
    why: 'An 80% setpoint is written as 50% (the panel maximum), yet the expected buy would be sized to 80%.',
  },
  {
    id: 'C-xi. ★★ the expected buy is not bounded by what the window can deliver',
    file: NCA,
    find: '  const liftKwh = Math.min(Math.max(0, (levelPct / 100) * o.fullKwh - o.startKwh), Math.max(0, o.deliverableKwh));',
    to: '  const liftKwh = Math.max(0, (levelPct / 100) * o.fullKwh - o.startKwh); /* MUTANT */',
    why: 'Friday\'s one-hour window states a draw it cannot pass.',
  },
  {
    id: 'C-xii. ★★ the expected buy can be negative',
    file: NCA,
    find: '  const liftKwh = Math.min(Math.max(0, (levelPct / 100) * o.fullKwh - o.startKwh), Math.max(0, o.deliverableKwh));',
    to: '  const liftKwh = Math.min((levelPct / 100) * o.fullKwh - o.startKwh, Math.max(0, o.deliverableKwh)); /* MUTANT */',
    why: 'A pool opening above the write level states a negative purchase.',
  },
  {
    id: 'C-xiii. ★★ the expected buy is pack-side (no charge leg)',
    file: NCA,
    find: '  return { buyKwh: round2(liftKwh / o.legEff), levelPct };',
    to: '  return { buyKwh: round2(liftKwh), levelPct }; /* MUTANT */',
    why: 'The meter-side figure loses the ~7% charge-leg loss and no longer compares with buy_kwh or delivered_kwh.',
  },
  {
    id: 'C-xiv. ★★ a night that does not arm states a positive expected buy',
    file: NCA,
    find: '    : { buyKwh: 0, levelPct: null };',
    to: '    : expectedBuyFromPlan({ setpointSocPct, costCeilingSocPct, forceChargeEligible: inputs.forceChargeEligible === true, startKwh: expectedStartKwh, deliverableKwh: expectedDeliverableKwh, fullKwh, legEff }); /* MUTANT */',
    why: 'A buy under the minimum arms nothing, yet the ledger and the sensor would say ~35 kWh is expected.',
  },
  {
    id: 'C-xv. ★ the cost or resilience HOLD states no expected figure',
    file: NCA,
    find: '      expectedBuyKwh: 0,\n      expectedStartSocPct,\n      expectedWriteLevelPct: null,',
    to: '      expectedBuyKwh: null, /* MUTANT */\n      expectedStartSocPct,\n      expectedWriteLevelPct: null,',
    why: 'A hold reads "unknown" on the expected-buy sensor though nothing is written — 0 is known.',
  },
  // ── the headline and the rationale ──
  {
    id: 'C-xvi. ★★★ the headline leads with the worst case again',
    file: NCA,
    find: '  const buyHeadline = expected.buyKwh == null',
    to: '  const buyHeadline = expected.buyKwh != null /* MUTANT */',
    why: 'The 10-12 headline "Buy ~64.2 kWh overnight" returns.',
  },
  {
    id: 'C-xvii. ★★ the worst case named is the raw figure, not the announced (de-biased) one',
    file: NCA,
    find: '    : `Buy ${buyFigureText(expected.buyKwh, buyKwhDebiased, buyDebiasFactor > 1.005',
    to: '    : `Buy ${buyFigureText(expected.buyKwh, buyKwh, buyDebiasFactor > 1.005 /* MUTANT */',
    why: 'With a learned calibration the "worst case" in the headline disagrees with the calibration note beside it.',
  },
  {
    id: 'C-xviii. ★★ "up to" is said of a worst case below the expected figure',
    file: NCA,
    find: '  return within\n    ?',
    to: '  return !within /* MUTANT */\n    ?',
    why: 'The phrase is chosen backwards: "up to" a figure the expected buy exceeds.',
  },
  {
    id: 'C-xix. ★ the rationale says the write charges a pool that opens above it',
    file: NCA,
    find: '      : `the pool should open the window near ~${expectedStartSocPct}% with the grid present (median load and PV, never below the ${round1(reserveFloorPct)}% reserve)`}${expectedStartSocPct < expected.levelPct',
    to: '      : `the pool should open the window near ~${expectedStartSocPct}% with the grid present (median load and PV, never below the ${round1(reserveFloorPct)}% reserve)`}${expectedStartSocPct >= expected.levelPct /* MUTANT */',
    why: '"tonight\'s write charges it to 50%" of a pool at 66% — the zero expected buy loses its reason.',
  },
  {
    id: 'C-xx. ★ the rationale stops naming the force-charge leg',
    file: NCA,
    find: '      ? `, and tonight\'s write charges it to ${expected.levelPct}%${expected.levelPct > writtenPct ?',
    to: '      ? `, and tonight\'s write charges it to ${expected.levelPct}%${expected.levelPct < writtenPct ? /* MUTANT */',
    why: 'An 80% level with a 50% reserve reads as one write; the reader cannot tell the force-charge carries most of it.',
  },
  // ── the P50 plumbing ──
  {
    id: 'C-xxi. ★★★ buildNightChargeInputs drops the band\'s P50 load',
    file: NCA,
    find: '      loadP50W: finiteOrNull(h.loadP50W),\n',
    to: '      /* MUTANT */\n',
    why: 'The field index.ts supplies never reaches the planner: no expected figure on any night, silently.',
  },
  {
    id: 'C-xxii. ★★ the P90 EV block overwrites the P50 load too',
    file: NCA,
    find: '      h.evP90W = addW;\n      remainingKwh -= addW / 1000;',
    to: '      h.evP90W = addW;\n      h.loadP50W = h.loadP90W; /* MUTANT */\n      remainingKwh -= addW / 1000;',
    why: 'The 19.3 kWh worst-case session that never happened is back in the expected carry.',
  },
  {
    id: 'C-xxiii. ★ rollup hours carry no P50 load',
    file: NCA,
    find: '        loadP50W: finiteOrNull(hh.loadW),\n',
    to: '        /* MUTANT */\n',
    why: 'A weekend carry past the 24 h band has no median basis, so a Saturday plan states no expected figure.',
  },
  {
    id: 'C-xxiv. ★★ buildNightChargeInputs drops the force-charge gate',
    file: NCA,
    find: '    // v1.187.22 — forwarded verbatim; see the destructure note above.\n    forceChargeEligible,\n',
    to: '    /* MUTANT */\n',
    why: 'The flag index.ts passes arrives undefined and every force-charge night states the reserve leg only.',
  },
  {
    id: 'C-xxv. ★★ index.ts builds the band\'s P50 load with the P90 factor',
    file: IDX,
    find: '      loadP50W: fh.forecastLoadW,\n',
    to: '      loadP50W: fh.forecastLoadW * loadP90Factor, /* MUTANT */\n',
    why: 'The "median" carries the ×1.35 band, the 10-12 overstatement in a quieter form.',
  },
  {
    id: 'C-xxvi. ★★ index.ts tells the planner force-charge always rides',
    file: IDX,
    find: '    forceChargeEligible: forceChargeOn(),\n',
    to: '    forceChargeEligible: true, /* MUTANT */\n',
    why: 'Advisory mode (nothing written) states a force-charge draw.',
  },
  // ── the surfaces ──
  {
    id: 'C-xxvii. ★★★ the MQTT expected-buy field publishes the worst case',
    file: NCA,
    find: '    night_charge_expected_buy_kwh: fresh ? (plan!.expectedBuyKwh ?? null) : null,',
    to: '    night_charge_expected_buy_kwh: fresh ? plan!.buyKwh : null, /* MUTANT */',
    why: 'The new sensor repeats Night-Charge Buy.',
  },
  {
    id: 'C-xxviii. ★★ the MQTT expected-buy field outlives a stale plan',
    file: NCA,
    find: '    night_charge_expected_buy_kwh: fresh ? (plan!.expectedBuyKwh ?? null) : null,',
    to: '    night_charge_expected_buy_kwh: plan?.expectedBuyKwh ?? null, /* MUTANT */',
    why: 'A dead advisor leaves a figure standing that the 12 h guard exists to clear.',
  },
  {
    id: 'C-xxix. ★★ the expected-buy sensor is not discovered',
    file: MQTT,
    find: "  { unique_id: 'ecoflow_night_charge_expected_buy_kwh', name: 'Night-Charge Expected Buy', state_class: 'measurement', unit_of_measurement: 'kWh', icon: 'mdi:transmission-tower-import', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_expected_buy_kwh }}' },\n",
    to: '  /* MUTANT */\n',
    why: 'The figure is published into the state payload but no Home Assistant entity reads it.',
  },
  {
    id: 'C-xxx. ★★★ the push title says the worst case',
    file: NOTIFY,
    find: '    title: `Night-charge: buy ~${kwh(headlineBuyKwh(plan))} tonight`,',
    to: '    title: `Night-charge: buy ~${kwh(plan.buyKwh)} tonight`, /* MUTANT */',
    why: 'The phone shows "buy ~64.2 kWh tonight" — the line the owner cancelled on.',
  },
  {
    id: 'C-xxxi. ★★ the push body drops the expected figure',
    file: NOTIFY,
    find: '      `Buy ${buyFigureText(plan.expectedBuyKwh, plan.buyKwh)} of grid energy overnight',
    to: '      `Buy ${buyFigureText(null /* MUTANT */, plan.buyKwh)} of grid energy overnight',
    why: 'The push body states the worst case alone.',
  },
  {
    id: 'C-xxxii. ★★★ the spoken line says the worst case',
    file: IDX,
    find: '      const buyRounded = Math.round(headlineBuyKwh(plan) ?? 0);',
    to: '      const buyRounded = plan.buyKwh != null ? Math.round(plan.buyKwh) : 0; /* MUTANT */',
    why: 'The speakers say "Buying about 64 kilowatt hours" for a ~34 kWh draw.',
  },
  {
    id: 'C-xxxiii. ★★ the card\'s headline number is the worst case',
    file: WEB,
    find: '    main: expectedKwh.toFixed(1),',
    to: '    main: worst, /* MUTANT */',
    why: 'The dashboard shows the worst case as the buy while the push says the expected figure.',
  },
  // ── the ledger ──
  {
    id: 'C-xxxiv. ★★★ the ledger allowlist lacks the new columns',
    file: REC,
    find: "  'expected_buy_kwh', 'expected_start_soc_pct', 'window_open_soc_pct',\n",
    to: '  /* MUTANT */\n',
    why: 'Every write of the expected figures and the measured open is dropped SILENTLY by the upsert.',
  },
  {
    id: 'C-xxxv. ★★★ the migration does not add the columns',
    file: REC,
    find: "    'expected_buy_kwh REAL', 'expected_start_soc_pct REAL', 'window_open_soc_pct REAL',\n",
    to: '    /* MUTANT */\n',
    why: 'An existing database (every install) has no such columns and the plan row write fails.',
  },
  {
    id: 'C-xxxvi. ★★ the plan row does not record the expected columns',
    file: IDX,
    find: '    ...expectedBuyLedgerColumns(plan),\n',
    to: '    /* MUTANT */\n',
    why: 'The expected figure is announced but never scored against what was delivered.',
  },
  {
    id: 'C-xxxvii. ★★ the measured open takes the minimum (the reconnect 0)',
    file: NLS,
    find: '  const median = vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;',
    to: '  const median = vals[0]; /* MUTANT */',
    why: 'A single-sample reconnect 0 is recorded as the pool at the window open.',
  },
  {
    id: 'C-xxxviii. ★ the measured open reads past the open, into the charge',
    file: NLS,
    find: '    .filter((p) => p.ts >= windowStartMs - WINDOW_OPEN_SOC_LEAD_MS && p.ts <= windowStartMs && Number.isFinite(p.value))',
    to: '    .filter((p) => p.ts >= windowStartMs - WINDOW_OPEN_SOC_LEAD_MS && p.ts <= windowStartMs + 60_000 && Number.isFinite(p.value)) /* MUTANT */',
    why: 'The reserve write lands at the open, so later readings already carry the charge.',
  },
  {
    id: 'C-xxxix. ★★ the scorer does not record the measured open',
    file: IDX,
    find: '    window_open_soc_pct: windowOpenSocPct,\n',
    to: '    /* MUTANT */\n',
    why: 'The ledger again cannot say where the pool opened the window (16.9% planned, 46% real).',
  },
  {
    id: 'C-xl-b. ★★ the score clause is computed but never reaches score_notes',
    file: IDX,
    find: '  scoreNotes += expectedBuyScoreNote({',
    to: '  void expectedBuyScoreNote({ /* MUTANT */',
    why: 'Delivered-vs-expected is never written, so the expected figure is announced and never graded.',
  },
  {
    id: 'C-xl. ★ the score clause inverts delivered/expected',
    file: NLS,
    find: '        : `, delivered ${i.deliveredKwh} kWh${i.expectedBuyKwh > 0 ? ` (${round2(i.deliveredKwh / i.expectedBuyKwh)}× expected)` : \'\'}`}`;',
    to: '        : `, delivered ${i.deliveredKwh} kWh${i.expectedBuyKwh > 0 ? ` (${round2(i.expectedBuyKwh / i.deliveredKwh)}× expected)` : \'\'}`}`; /* MUTANT */',
    why: 'An over-delivered night reads as under-delivered in the notes the expected figure is judged by.',
  },
  {
    id: 'C-xli. ★★ arming no longer reads the shared ceiling helper\'s value',
    file: ACT,
    find: '    ? plan.costCeilingSocPct : null;',
    to: '    ? null : null; /* MUTANT */',
    why: 'armFromPlan and the expected level both lose the force-charge ceiling — the shared definition is what keeps them one.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22c', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
